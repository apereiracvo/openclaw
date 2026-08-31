/** Per-session serialization for authoritative ACP metadata mutations. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { resolveSessionStorePathForAcp } from "./session-meta-store.js";

const acpSessionMetaWriteQueue = new KeyedAsyncQueue();

export type UpsertAcpSessionMetaParams = {
  sessionKey: string;
  agentId?: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  now?: () => number;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
  mutate: (
    current: SessionAcpMeta | undefined,
    entry: SessionEntry | undefined,
  ) => SessionAcpMeta | null | undefined;
};

export function resolveAcpSessionStoreUpdateOptions(params: UpsertAcpSessionMetaParams) {
  return {
    activeSessionKey: normalizeLowercaseStringOrEmpty(params.sessionKey),
    ...(params.skipMaintenance === true ? { skipMaintenance: true } : {}),
    ...(params.takeCacheOwnership === true ? { takeCacheOwnership: true } : {}),
  };
}

/**
 * Holds one session's read, caller mutation/CAS decision, async session-entry work,
 * SQLite commit, and returned value on the same edge. Lock order is manager/lifecycle owner →
 * this queue → session-entry writer → short state transaction. Mutation callbacks are
 * synchronous and persistence helpers do not re-enter ACP writes, so the order is acyclic.
 */
export async function withAcpSessionMetaWriteLock<T>(
  params: UpsertAcpSessionMetaParams,
  run: (lockedParams: UpsertAcpSessionMetaParams) => Promise<T>,
): Promise<T | null> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const owner = resolveSessionStorePathForAcp({
    sessionKey,
    agentId: params.agentId,
    cfg: params.cfg,
    env: params.env,
  });
  if (!owner.storePath) {
    return null;
  }
  const normalizedSessionKey = normalizeLowercaseStringOrEmpty(sessionKey);
  const queueKey = `${owner.agentId ?? ""}\u0000${normalizedSessionKey}`;
  return await acpSessionMetaWriteQueue.enqueue(
    queueKey,
    async () =>
      await run({
        ...params,
        sessionKey,
        ...(owner.agentId ? { agentId: owner.agentId } : {}),
        cfg: owner.cfg,
      }),
  );
}
