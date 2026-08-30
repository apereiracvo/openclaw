import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type { BoundedSerialQueue } from "../../../../src/shared/bounded-serial-queue.js";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import {
  normalizeVoiceTranscriptText,
  VOICE_TRANSCRIPT_QUEUE_POLICY,
} from "../../../../src/talk/voice-transcript.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  RealtimeTalkTranscript,
  RealtimeTalkTranscriptItem,
  RealtimeTalkTransport,
} from "./realtime-talk-shared.ts";

type ReservedTranscript = {
  order: number;
  role: "user" | "assistant";
  complete?: (text: string | undefined) => void;
};

// Keep exact identities for the connection: eviction could admit a late duplicate
// final. This matches the WebRTC response/tool identity budget.
const MAX_TRANSCRIPT_ITEM_IDENTITIES = 1_024;
const MAX_TRANSCRIPT_ITEM_ID_CHARS = 1_024;

export class ClientVoiceTranscriptQueue {
  private sequence = 0;
  private lastItemId: string | undefined;
  private readonly items = new Map<string, ReservedTranscript | null>();

  constructor(
    readonly queue: BoundedSerialQueue,
    private readonly write: (
      entryId: string,
      role: "user" | "assistant",
      text: string,
    ) => Promise<void>,
    private readonly onFailure: (error: unknown) => void,
  ) {}

  observe(item: RealtimeTalkTranscriptItem): void {
    if (item.type === "settled") {
      const reservation = this.requireItem(item.itemId);
      this.settle(reservation);
      return;
    }
    if (this.items.has(item.itemId)) {
      return;
    }
    if (
      this.items.size >= MAX_TRANSCRIPT_ITEM_IDENTITIES ||
      item.itemId.length > MAX_TRANSCRIPT_ITEM_ID_CHARS
    ) {
      throw new Error("Realtime transcript item identity limit exceeded");
    }
    // This client appends provider items; it never requests historical insertion.
    // Reject an unknown/rewritten predecessor before committing a false order.
    if (item.previousItemId != null && item.previousItemId !== this.lastItemId) {
      throw new Error("Realtime transcript item has an unexpected predecessor");
    }
    this.lastItemId = item.itemId;
    if (item.role === null) {
      this.items.set(item.itemId, null);
      return;
    }
    const result = createDeferredCore<string | undefined>();
    const reservation: ReservedTranscript = {
      order: ++this.sequence,
      role: item.role,
      complete: result.resolve,
    };
    this.items.set(item.itemId, reservation);
    // Reserve the existing FIFO position before asynchronous ASR can be overtaken
    // by assistant finals. Charge the maximum retained text while it is pending.
    this.enqueue(async () => {
      const text = await result.promise;
      if (text) {
        await this.write(String(reservation.order), reservation.role, text);
      }
    }, VOICE_TRANSCRIPT_QUEUE_POLICY.maxEntryChars);
  }

  publish(entry: RealtimeTalkTranscript): RealtimeTalkTranscript | undefined {
    if (entry.itemId !== undefined) {
      const reservation = this.requireItem(entry.itemId);
      if (reservation.role !== entry.role) {
        throw new Error("Realtime transcript item changed roles");
      }
      if (!reservation.complete) {
        return undefined;
      }
      if (entry.final) {
        this.settle(reservation, normalizeVoiceTranscriptText(entry.text) || undefined);
      }
      return { ...entry, order: reservation.order };
    }
    // Google Live and frameless transcripts have no GA item-creation contract.
    // Their provider completion order continues to own unkeyed admission.
    if (entry.final) {
      const text = normalizeVoiceTranscriptText(entry.text);
      if (text) {
        const entryId = String(++this.sequence);
        this.enqueue(() => this.write(entryId, entry.role, text), text.length);
      }
    }
    return entry;
  }

  close(): string[] {
    const missing: string[] = [];
    for (const [itemId, reservation] of this.items) {
      if (reservation?.complete) {
        missing.push(itemId);
        this.settle(reservation);
      }
    }
    this.items.clear();
    return missing;
  }

  private settle(reservation: ReservedTranscript, text?: string): void {
    const complete = reservation.complete;
    reservation.complete = undefined;
    complete?.(text);
  }

  private requireItem(itemId: string): ReservedTranscript {
    const reservation = this.items.get(itemId);
    if (!reservation) {
      throw new Error("Realtime transcript refers to an unknown speech item");
    }
    return reservation;
  }

  private enqueue(run: () => Promise<void>, weight: number): void {
    const admission = this.queue.enqueue(run, { weight });
    if (!admission.accepted) {
      throw new Error(VOICE_TRANSCRIPT_QUEUE_POLICY.overflowMessage);
    }
    void admission.completion.catch(this.onFailure);
  }
}

export type ClientVoiceSessionOwner = {
  signal: AbortSignal;
  closeSignal: AbortSignal;
  beginDrain: () => void;
  release: () => void;
};

export type DetachedVoiceSession = {
  voiceSessionId: string;
  serverOwned: boolean;
  generation?: number;
  transcriptQueue: BoundedSerialQueue;
  owner?: ClientVoiceSessionOwner;
};

const MAX_CLIENT_VOICE_SESSION_OWNERS_PER_SESSION = 2;
const MAX_CLIENT_VOICE_SESSION_OWNERS_PER_CLIENT = 16;
const CLIENT_VOICE_TRANSCRIPT_DRAIN_TIMEOUT_MS = DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS;
const CLIENT_VOICE_SESSION_CLOSE_TIMEOUT_MS =
  CLIENT_VOICE_TRANSCRIPT_DRAIN_TIMEOUT_MS + DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS;

// One client may own multiple split-pane calls, but route churn must not create
// unbounded detached drains. Transcript and close each get one request deadline.
const clientVoiceSessionOwnerCounts = new WeakMap<GatewayBrowserClient, Map<string, number>>();

export function reserveClientVoiceSessionOwner(
  client: GatewayBrowserClient,
  sessionKey: string,
): ClientVoiceSessionOwner {
  let counts = clientVoiceSessionOwnerCounts.get(client);
  if (!counts) {
    counts = new Map();
    clientVoiceSessionOwnerCounts.set(client, counts);
  }
  const sessionCount = counts.get(sessionKey) ?? 0;
  const clientCount = [...counts.values()].reduce((total, count) => total + count, 0);
  if (
    sessionCount >= MAX_CLIENT_VOICE_SESSION_OWNERS_PER_SESSION ||
    clientCount >= MAX_CLIENT_VOICE_SESSION_OWNERS_PER_CLIENT
  ) {
    throw new Error("Too many active or closing realtime Talk voice sessions");
  }
  counts.set(sessionKey, sessionCount + 1);
  const ownerCounts = counts;
  const transcriptController = new AbortController();
  const closeController = new AbortController();
  let released = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    if (drainTimer !== undefined) {
      clearTimeout(drainTimer);
      drainTimer = undefined;
    }
    if (closeTimer !== undefined) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
    const nextSessionCount = (ownerCounts.get(sessionKey) ?? 1) - 1;
    if (nextSessionCount > 0) {
      ownerCounts.set(sessionKey, nextSessionCount);
    } else {
      ownerCounts.delete(sessionKey);
    }
  };
  return {
    signal: transcriptController.signal,
    closeSignal: closeController.signal,
    beginDrain: () => {
      if (released || drainTimer !== undefined || closeTimer !== undefined) {
        return;
      }
      drainTimer = setTimeout(() => {
        transcriptController.abort();
      }, CLIENT_VOICE_TRANSCRIPT_DRAIN_TIMEOUT_MS);
      closeTimer = setTimeout(() => {
        transcriptController.abort();
        closeController.abort();
        release();
      }, CLIENT_VOICE_SESSION_CLOSE_TIMEOUT_MS);
    },
    release,
  };
}

export function retireUncommittedRealtimeTalkTransport(params: {
  nextTransport: RealtimeTalkTransport | null;
  transport: string;
  owner: ClientVoiceSessionOwner;
  closeVoiceSession: () => void;
}): void {
  params.nextTransport?.stop({ emitClosed: false });
  if (params.transport === "gateway-relay" && params.nextTransport) {
    // The relay transport owns server close once constructed; release browser ownership.
    params.owner.release();
    return;
  }
  params.closeVoiceSession();
}

function transcriptPersistenceAbortError(): Error {
  const error = new Error("voice transcript persistence aborted");
  error.name = "AbortError";
  return error;
}

async function waitForTranscriptRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw transcriptPersistenceAbortError();
  }
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(transcriptPersistenceAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function retryVoiceTranscriptPersistence(
  signal: AbortSignal,
  operation: () => Promise<unknown>,
  failureMessage: string,
): Promise<void> {
  let lastError: unknown;
  // Transcript writes and logical close share retry timing, but retain their
  // separate owner deadlines so accepted writes drain before close is attempted.
  for (const delayMs of [0, 500, 2_000]) {
    if (delayMs > 0) {
      await waitForTranscriptRetry(delayMs, signal);
    } else if (signal.aborted) {
      throw transcriptPersistenceAbortError();
    }
    try {
      await operation();
      return;
    } catch (error) {
      if (signal.aborted) {
        throw transcriptPersistenceAbortError();
      }
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(failureMessage, { cause: lastError });
}
