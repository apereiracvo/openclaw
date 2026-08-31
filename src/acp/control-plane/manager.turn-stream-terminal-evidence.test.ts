/** Adversarial production-path tests for terminal evidence surviving later stream failures. */
import { describe, expect, it, vi } from "vitest";
import {
  requireTaskByRunId,
  withAcpManagerTaskStateDir,
} from "../../../test/helpers/acp-manager-task-state.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

function installFreshOneShot(sessionKey: string, runtimeState: ReturnType<typeof createRuntime>) {
  let currentMeta: SessionAcpMeta = readySessionMeta({
    backend: "primary-backend",
    runtimeSessionName: "runtime",
    mode: "oneshot",
  });
  hoisted.readAcpSessionEntryMock.mockImplementation((inputUnknown: unknown) => {
    const key = (inputUnknown as { sessionKey?: string }).sessionKey;
    if (key === sessionKey) {
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        entry: { sessionId: "child", updatedAt: 1, spawnedBy: "agent:main:main" },
        acp: currentMeta,
      };
    }
    if (key === "agent:main:main") {
      return {
        sessionKey: key,
        storeSessionKey: key,
        entry: { sessionId: "parent", updatedAt: 1 },
      };
    }
    return null;
  });
  hoisted.upsertAcpSessionMetaMock.mockImplementation(async (inputUnknown: unknown) => {
    const input = inputUnknown as {
      mutate: (
        current: SessionAcpMeta | undefined,
        entry: { acp?: SessionAcpMeta } | undefined,
      ) => SessionAcpMeta | null | undefined;
    };
    const next = input.mutate(currentMeta, { acp: currentMeta });
    if (next) {
      currentMeta = next;
    }
    return { sessionId: "child", updatedAt: Date.now(), acp: currentMeta };
  });
  runtimeState.ensureSession.mockImplementation(async (input) => ({
    sessionKey: input.sessionKey,
    backend: "primary-backend",
    runtimeSessionName: "runtime",
    acpxRecordId: "record",
    backendSessionId: "acp-id",
    sessionResumeSupported: true,
  }));
  hoisted.requireAcpRuntimeBackendMock.mockImplementation((backendId?: string) => {
    if (backendId !== "primary-backend") {
      throw new Error(`fallback attempted: ${backendId ?? "<auto>"}`);
    }
    return { id: backendId, runtime: runtimeState.runtime };
  });
  return {
    get currentMeta() {
      return currentMeta;
    },
  };
}

const cfg = {
  acp: {
    ...baseCfg.acp,
    backend: "primary-backend",
    fallbacks: ["fallback-backend"],
  },
};

describe("ACP manager post-terminal stream failures", () => {
  installAcpSessionManagerTestLifecycle();

  it("does not replay a production startTurn result when event draining fails after completion", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const sessionKey = "agent:codex:acp:start-turn-post-completed-error";
      const runtimeState = createRuntime();
      const persisted = installFreshOneShot(sessionKey, runtimeState);
      const completedResult = Promise.resolve({
        status: "completed" as const,
        stopReason: "end_turn",
      });
      const startTurn = vi.fn((input) => ({
        requestId: input.requestId,
        events: (async function* () {
          await completedResult;
          if (Date.now() < 0) {
            yield { type: "done" as const };
          }
          throw new Error("event drain failed after completed result");
        })(),
        result: completedResult,
        cancel: vi.fn(async () => {}),
        closeStream: vi.fn(async () => {}),
      }));
      runtimeState.runtime.startTurn = startTurn;

      await expect(
        new AcpSessionManager().runTurn({
          provenance: "system",
          cfg,
          sessionKey,
          text: "complete once through startTurn",
          mode: "prompt",
          requestId: "start-turn-post-completed-error",
        }),
      ).rejects.toThrow("event drain failed after completed result");

      expect(runtimeState.ensureSession).toHaveBeenCalledOnce();
      expect(startTurn).toHaveBeenCalledOnce();
      expect(runtimeState.runTurn).not.toHaveBeenCalled();
      expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledOnce();
      expect(requireTaskByRunId("start-turn-post-completed-error").status).toBe("failed");
      expect(persisted.currentMeta.identity?.sessionResumeReady).toBe(true);
    });
  }, 300_000);

  it("does not replay a legacy runTurn stream that throws after a completed done event", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const sessionKey = "agent:codex:acp:legacy-post-completed-error";
      const runtimeState = createRuntime();
      const persisted = installFreshOneShot(sessionKey, runtimeState);
      runtimeState.runTurn.mockImplementation(async function* () {
        yield { type: "done" as const, status: "completed" as const };
        throw new Error("legacy event observer failed after done");
      });

      await expect(
        new AcpSessionManager().runTurn({
          provenance: "system",
          cfg,
          sessionKey,
          text: "complete once through runTurn",
          mode: "prompt",
          requestId: "legacy-post-completed-error",
        }),
      ).rejects.toThrow("legacy event observer failed after done");

      expect(runtimeState.ensureSession).toHaveBeenCalledOnce();
      expect(runtimeState.runTurn).toHaveBeenCalledOnce();
      expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledOnce();
      expect(requireTaskByRunId("legacy-post-completed-error").status).toBe("failed");
      expect(persisted.currentMeta.identity?.sessionResumeReady).toBe(true);
    });
  }, 300_000);
});
