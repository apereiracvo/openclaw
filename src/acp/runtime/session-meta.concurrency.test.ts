/** Concurrency tests for authoritative ACP metadata persistence. */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  patchSessionEntryWithKey,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withAcpSessionMetaWriteLock } from "./session-meta-write-lock.js";
import { readAcpSessionMeta, upsertAcpSessionMeta } from "./session-meta.js";

const ACP_AGENT_ID = "codex";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function holdSessionEntryWriter(params: { storePath: string; sessionKey: string }) {
  const entered = deferred<void>();
  const release = deferred<void>();
  const held = patchSessionEntryWithKey(
    {
      agentId: ACP_AGENT_ID,
      storePath: params.storePath,
      sessionKey: params.sessionKey,
    },
    async () => {
      entered.resolve();
      await release.promise;
      return null;
    },
    { replaceEntry: true, skipMaintenance: true },
  );
  await entered.promise;
  return {
    release: () => release.resolve(),
    settled: held,
  };
}

async function seedAcpSessionEntry(params: {
  storePath: string;
  sessionKey: string;
  entry: SessionEntry;
}): Promise<void> {
  await replaceSessionEntry(
    {
      agentId: ACP_AGENT_ID,
      storePath: params.storePath,
      sessionKey: params.sessionKey,
    },
    params.entry,
  );
}

describe("ACP session metadata write serialization", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("serializes same-session mutations across the full asynchronous persistence interval", async () => {
    await withTestDir({ prefix: "openclaw-acp-meta-serialization-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:serialized";
      await seedAcpSessionEntry({
        storePath,
        sessionKey,
        entry: { sessionId: "sess-serialized", updatedAt: 1 },
      });
      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        mutate: () => ({
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "serialized",
          mode: "oneshot",
          state: "running",
          lastActivityAt: 1,
        }),
      });

      const writer = await holdSessionEntryWriter({ storePath, sessionKey });
      const mutationOrder: string[] = [];
      const firstEvaluated = deferred<void>();
      const first = upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        mutate: (current) => {
          mutationOrder.push("first");
          firstEvaluated.resolve();
          return { ...current!, lastActivityAt: current!.lastActivityAt + 1 };
        },
      });
      await firstEvaluated.promise;
      const second = upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        mutate: (current) => {
          mutationOrder.push("second");
          expect(current?.lastActivityAt).toBe(2);
          return { ...current!, lastActivityAt: current!.lastActivityAt + 1 };
        },
      });
      await Promise.resolve();
      expect(mutationOrder).toEqual(["first"]);

      writer.release();
      await Promise.all([writer.settled, first, second]);

      expect(mutationOrder).toEqual(["first", "second"]);
      expect(readAcpSessionMeta({ cfg, databasePath, sessionKey })?.lastActivityAt).toBe(3);
    });
  });

  it("orders a replacement generation after an in-flight stale readiness mutation", async () => {
    await withTestDir({ prefix: "openclaw-acp-meta-generation-race-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:generation-race";
      await seedAcpSessionEntry({
        storePath,
        sessionKey,
        entry: { sessionId: "sess-generation-race", updatedAt: 1 },
      });
      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        mutate: () => ({
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "generation-a",
          identity: {
            state: "resolved",
            source: "status",
            acpxRecordId: "record-a",
            acpxSessionId: "session-a",
            sessionResumeSupported: true,
            sessionResumeReady: false,
            lastUpdatedAt: 1,
          },
          mode: "oneshot",
          state: "running",
          lastActivityAt: 1,
        }),
      });

      const writer = await holdSessionEntryWriter({ storePath, sessionKey });
      const readinessEvaluated = deferred<void>();
      const replacementEvaluated = deferred<void>();
      const staleReadiness = upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        mutate: (current) => {
          expect(current?.identity?.acpxRecordId).toBe("record-a");
          readinessEvaluated.resolve();
          return {
            ...current!,
            identity: {
              ...current!.identity!,
              sessionResumeReady: true,
              lastUpdatedAt: 2,
            },
            lastActivityAt: 2,
          };
        },
      });
      await readinessEvaluated.promise;
      const replacement = upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        mutate: () => {
          replacementEvaluated.resolve();
          return {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "generation-b",
            identity: {
              state: "resolved",
              source: "event",
              acpxRecordId: "record-b",
              acpxSessionId: "session-b",
              sessionResumeSupported: true,
              sessionResumeReady: false,
              lastUpdatedAt: 3,
            },
            mode: "oneshot",
            state: "running",
            lastActivityAt: 3,
          };
        },
      });
      await Promise.resolve();
      let replacementStarted = false;
      void replacementEvaluated.promise.then(() => {
        replacementStarted = true;
      });
      await Promise.resolve();
      expect(replacementStarted).toBe(false);

      writer.release();
      await Promise.all([writer.settled, staleReadiness, replacement]);

      expect(readAcpSessionMeta({ cfg, databasePath, sessionKey })).toMatchObject({
        runtimeSessionName: "generation-b",
        identity: {
          acpxRecordId: "record-b",
          acpxSessionId: "session-b",
          sessionResumeReady: false,
        },
      });
    });
  });

  it("does not serialize a different session key behind the blocked mutation", async () => {
    await withTestDir({ prefix: "openclaw-acp-meta-parallel-" }, async (dir) => {
      const cfg = { session: { store: path.join(dir, "sessions.json") } } as OpenClawConfig;
      const firstEntered = deferred<void>();
      const releaseFirst = deferred<void>();
      const first = withAcpSessionMetaWriteLock(
        {
          cfg,
          sessionKey: "agent:codex:acp:blocked",
          mutate: () => undefined,
        },
        async () => {
          firstEntered.resolve();
          await releaseFirst.promise;
          return "first";
        },
      );
      await firstEntered.promise;

      const secondEntered = deferred<void>();
      const second = withAcpSessionMetaWriteLock(
        {
          cfg,
          sessionKey: "agent:codex:acp:independent",
          mutate: () => undefined,
        },
        async () => {
          secondEntered.resolve();
          return "second";
        },
      );
      await secondEntered.promise;
      await expect(second).resolves.toBe("second");

      releaseFirst.resolve();
      await expect(first).resolves.toBe("first");
    });
  });

  it("lets a real write for a different session owner finish while the first is blocked", async () => {
    await withTestDir({ prefix: "openclaw-acp-meta-owner-parallel-" }, async (dir) => {
      const firstStorePath = path.join(dir, "codex", "sessions.json");
      const secondStorePath = path.join(dir, "research", "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const firstCfg = { session: { store: firstStorePath } } as OpenClawConfig;
      const secondCfg = { session: { store: secondStorePath } } as OpenClawConfig;
      const firstSessionKey = "agent:codex:acp:blocked-owner";
      const secondSessionKey = "agent:research:acp:independent-owner";
      await seedAcpSessionEntry({
        storePath: firstStorePath,
        sessionKey: firstSessionKey,
        entry: { sessionId: "sess-blocked-owner", updatedAt: 1 },
      });
      await replaceSessionEntry(
        {
          agentId: "research",
          storePath: secondStorePath,
          sessionKey: secondSessionKey,
        },
        { sessionId: "sess-independent-owner", updatedAt: 1 },
      );

      const writer = await holdSessionEntryWriter({
        storePath: firstStorePath,
        sessionKey: firstSessionKey,
      });
      const firstEvaluated = deferred<void>();
      const first = upsertAcpSessionMeta({
        cfg: firstCfg,
        databasePath,
        sessionKey: firstSessionKey,
        mutate: () => {
          firstEvaluated.resolve();
          return {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "blocked-owner",
            mode: "oneshot",
            state: "running",
            lastActivityAt: 1,
          };
        },
      });
      await firstEvaluated.promise;

      const second = await upsertAcpSessionMeta({
        cfg: secondCfg,
        databasePath,
        sessionKey: secondSessionKey,
        mutate: () => ({
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "independent-owner",
          mode: "oneshot",
          state: "running",
          lastActivityAt: 2,
        }),
      });
      expect(second?.acp?.runtimeSessionName).toBe("independent-owner");

      writer.release();
      await Promise.all([writer.settled, first]);
    });
  });
});
