/** Production-persistence race coverage for completed one-shot readiness fencing. */
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withAcpManagerTaskStateDir } from "../../../test/helpers/acp-manager-task-state.js";
import {
  patchSessionEntryWithKey,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
  type OpenClawConfig,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

const actualSessionMeta = await vi.importActual<typeof import("../runtime/session-meta.js")>(
  "../runtime/session-meta.js",
);

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function generationMeta(params: {
  recordId: string;
  resumeId: string;
  runtimeSessionName: string;
  updatedAt: number;
  ready?: boolean;
}): SessionAcpMeta {
  return readySessionMeta({
    backend: "persisted-backend",
    runtimeSessionName: params.runtimeSessionName,
    mode: "oneshot",
    cwd: `/workspace/${params.runtimeSessionName}`,
    identity: {
      state: "resolved",
      source: "status",
      acpxRecordId: params.recordId,
      acpxSessionId: params.resumeId,
      sessionResumeSupported: true,
      sessionResumeReady: params.ready ?? false,
      lastUpdatedAt: params.updatedAt,
    },
  });
}

describe("AcpSessionManager production persistence race", () => {
  installAcpSessionManagerTestLifecycle();

  it("rejects a resumed handle when its persisted generation changes during ensure", async () => {
    await withAcpManagerTaskStateDir(async (root) => {
      const sessionKey = "agent:codex:acp:resumed-handle-generation-race";
      const storePath = path.join(root, "agents", "codex", "sessions", "sessions.json");
      const cfg = {
        session: { store: storePath },
        acp: { ...baseCfg.acp, backend: "persisted-backend" },
      } as OpenClawConfig;
      const generationA = generationMeta({
        recordId: "record-a",
        resumeId: "session-a",
        runtimeSessionName: "generation-a",
        updatedAt: 1,
        ready: true,
      });
      const generationB = generationMeta({
        recordId: "record-b",
        resumeId: "session-b",
        runtimeSessionName: "generation-b",
        updatedAt: 2,
      });
      await replaceSessionEntry(
        { agentId: "codex", storePath, sessionKey },
        { sessionId: "session-entry", updatedAt: 1 },
      );
      await actualSessionMeta.upsertAcpSessionMeta({
        cfg,
        sessionKey,
        mutate: () => generationA,
      });

      const ensureEntered = deferred<void>();
      const releaseEnsure = deferred<void>();
      const runtimeState = createRuntime();
      runtimeState.ensureSession.mockImplementation(async (input) => {
        ensureEntered.resolve();
        await releaseEnsure.promise;
        return {
          sessionKey: input.sessionKey,
          backend: "persisted-backend",
          runtimeSessionName: "resumed-generation-a",
          cwd: input.cwd,
          acpxRecordId: "record-a",
          backendSessionId: input.resumeSessionId,
          sessionResumeSupported: true,
        };
      });
      let readinessWrites = 0;
      const observedUpsert: typeof actualSessionMeta.upsertAcpSessionMeta = async (params) =>
        await actualSessionMeta.upsertAcpSessionMeta({
          ...params,
          mutate: (current, entry) => {
            const next = params.mutate(current, entry);
            if (
              current?.identity?.sessionResumeReady === false &&
              next?.identity?.sessionResumeReady === true
            ) {
              readinessWrites += 1;
            }
            return next;
          },
        });
      const requireBackend = vi.fn((backendId?: string) => {
        if (backendId !== "persisted-backend") {
          throw new Error(`unexpected backend ${backendId ?? "<auto>"}`);
        }
        return { id: backendId, runtime: runtimeState.runtime };
      });
      const manager = new AcpSessionManager({
        listAcpSessions: actualSessionMeta.listAcpSessionEntries,
        loadSessionEntry: actualSessionMeta.readAcpSessionEntry,
        upsertSessionMeta: observedUpsert,
        getRuntimeBackend: (backendId?: string) => {
          try {
            return requireBackend(backendId);
          } catch {
            return null;
          }
        },
        requireRuntimeBackend: requireBackend,
      });

      try {
        const run = manager.runTurn({
          provenance: "system",
          cfg,
          sessionKey,
          text: "do not submit against replaced generation a",
          mode: "prompt",
          requestId: "resumed-handle-generation-race",
        });
        await ensureEntered.promise;
        await actualSessionMeta.upsertAcpSessionMeta({
          cfg,
          sessionKey,
          mutate: () => generationB,
        });
        releaseEnsure.resolve();

        await expect(run).rejects.toMatchObject({
          code: "ACP_SESSION_INIT_FAILED",
          message: expect.stringContaining("identity changed"),
        });

        expect(runtimeState.ensureSession).toHaveBeenCalledOnce();
        expect(runtimeState.ensureSession.mock.calls[0]?.[0]).toMatchObject({
          sessionKey,
          resumeSessionId: "session-a",
        });
        expect(runtimeState.runTurn).not.toHaveBeenCalled();
        expect(readinessWrites).toBe(0);
        expect(runtimeState.close).toHaveBeenCalledOnce();
        expect(runtimeState.close.mock.calls[0]?.[0]).toMatchObject({
          handle: {
            runtimeSessionName: "resumed-generation-a",
            acpxRecordId: "record-a",
            backendSessionId: "session-a",
          },
          reason: "oneshot-continuation-persistence-rejected",
        });
        expect(manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(0);
        expect(actualSessionMeta.readAcpSessionMeta({ cfg, sessionKey })).toMatchObject({
          backend: "persisted-backend",
          runtimeSessionName: "generation-b",
          identity: {
            acpxRecordId: "record-b",
            acpxSessionId: "session-b",
            sessionResumeReady: false,
          },
        });
      } finally {
        releaseEnsure.resolve();
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
      }
    });
  }, 300_000);

  it("fails readiness closed when a replacement queues behind final reconciliation", async () => {
    await withAcpManagerTaskStateDir(async (root) => {
      const sessionKey = "agent:codex:acp:real-persistence-generation-race";
      const storePath = path.join(root, "agents", "codex", "sessions", "sessions.json");
      const cfg = {
        session: { store: storePath },
        acp: { ...baseCfg.acp, backend: "persisted-backend" },
      } as OpenClawConfig;
      const generationA = generationMeta({
        recordId: "record-a",
        resumeId: "session-a",
        runtimeSessionName: "generation-a",
        updatedAt: 1,
      });
      const generationB = generationMeta({
        recordId: "record-b",
        resumeId: "session-b",
        runtimeSessionName: "generation-b",
        updatedAt: 2,
      });
      await replaceSessionEntry(
        { agentId: "codex", storePath, sessionKey },
        { sessionId: "session-entry", updatedAt: 1 },
      );
      await actualSessionMeta.upsertAcpSessionMeta({
        cfg,
        sessionKey,
        mutate: () => generationA,
      });

      const runtimeState = createRuntime();
      const writerEntered = deferred<void>();
      const releaseWriter = deferred<void>();
      let heldWriter: Promise<unknown> | undefined;
      runtimeState.ensureSession.mockImplementation(async (input) => ({
        sessionKey: input.sessionKey,
        backend: "persisted-backend",
        runtimeSessionName: "generation-a",
        cwd: input.cwd,
        acpxRecordId: "record-a",
        backendSessionId: "session-a",
        sessionResumeSupported: true,
      }));
      runtimeState.runTurn.mockImplementation(async function* () {
        heldWriter = patchSessionEntryWithKey(
          { agentId: "codex", storePath, sessionKey },
          async () => {
            writerEntered.resolve();
            await releaseWriter.promise;
            return null;
          },
          { replaceEntry: true, skipMaintenance: true },
        );
        await writerEntered.promise;
        yield { type: "done" as const };
      });
      let finalStatusObserved = false;
      runtimeState.getStatus.mockImplementation(async () => {
        finalStatusObserved = true;
        return {
          summary: "status=alive",
          acpxRecordId: "record-a",
          backendSessionId: "session-a",
          sessionResumeSupported: true,
        };
      });

      const finalReconciliationEvaluated = deferred<void>();
      let observedFinalReconciliation = false;
      let readinessApplied = 0;
      const observedUpsert: typeof actualSessionMeta.upsertAcpSessionMeta = async (params) =>
        await actualSessionMeta.upsertAcpSessionMeta({
          ...params,
          mutate: (current, entry) => {
            const next = params.mutate(current, entry);
            if (finalStatusObserved && !observedFinalReconciliation) {
              observedFinalReconciliation = true;
              finalReconciliationEvaluated.resolve();
            }
            if (next?.identity?.sessionResumeReady === true) {
              readinessApplied += 1;
            }
            return next;
          },
        });
      const requireBackend = vi.fn((backendId?: string) => {
        if (backendId !== "persisted-backend") {
          throw new Error(`unexpected backend ${backendId ?? "<auto>"}`);
        }
        return { id: backendId, runtime: runtimeState.runtime };
      });
      const manager = new AcpSessionManager({
        listAcpSessions: actualSessionMeta.listAcpSessionEntries,
        loadSessionEntry: actualSessionMeta.readAcpSessionEntry,
        upsertSessionMeta: observedUpsert,
        getRuntimeBackend: (backendId?: string) => {
          try {
            return requireBackend(backendId);
          } catch {
            return null;
          }
        },
        requireRuntimeBackend: requireBackend,
      });

      try {
        const run = manager.runTurn({
          provenance: "system",
          cfg,
          sessionKey,
          text: "complete generation a",
          mode: "prompt",
          requestId: "real-persistence-generation-race",
        });
        await finalReconciliationEvaluated.promise;
        const replacementEvaluated = deferred<void>();
        const replacement = actualSessionMeta.upsertAcpSessionMeta({
          cfg,
          sessionKey,
          mutate: () => {
            replacementEvaluated.resolve();
            return generationB;
          },
        });
        let replacementStarted = false;
        void replacementEvaluated.promise.then(() => {
          replacementStarted = true;
        });
        await Promise.resolve();
        expect(replacementStarted).toBe(false);

        releaseWriter.resolve();
        await heldWriter;
        await replacement;
        await expect(run).rejects.toMatchObject({
          code: "ACP_TURN_FAILED",
          message: expect.stringContaining("resume readiness"),
        });

        expect(readinessApplied).toBe(0);
        expect(runtimeState.ensureSession).toHaveBeenCalledOnce();
        expect(runtimeState.runTurn).toHaveBeenCalledOnce();
        expect(actualSessionMeta.readAcpSessionMeta({ cfg, sessionKey })).toMatchObject({
          runtimeSessionName: "generation-b",
          identity: {
            acpxRecordId: "record-b",
            acpxSessionId: "session-b",
            sessionResumeReady: false,
          },
        });
      } finally {
        releaseWriter.resolve();
        await heldWriter;
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
      }
    });
  }, 300_000);
});
