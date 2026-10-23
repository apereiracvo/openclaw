/** Final-status failure/timeout contracts; shares the original stateful fixture. */
import { describe, expect, it, vi } from "vitest";
import { installStatefulSession } from "./manager.one-shot-resume.test-support.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager one-shot final status", () => {
  installAcpSessionManagerTestLifecycle();

  it("fails closed on final status error without committing readiness", async () => {
    const sessionKey = "agent:codex:acp:status-error";
    const runtimeState = createRuntime();
    const managerStateWrites: SessionAcpMeta["state"][] = [];
    installStatefulSession({
      sessionKey,
      initialMeta: readySessionMeta({
        backend: "primary-backend",
        runtimeSessionName: "runtime",
        mode: "oneshot",
      }),
      onPersist: (observation) => {
        if (observation.skipMaintenance && observation.takeCacheOwnership) {
          managerStateWrites.push(observation.next.state);
        }
      },
    });
    runtimeState.ensureSession.mockImplementation(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "primary-backend",
      runtimeSessionName: "runtime",
      backendSessionId: "acp-id",
      sessionResumeSupported: true,
    }));
    runtimeState.getStatus.mockRejectedValue(new Error("status unavailable"));
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "primary-backend",
      runtime: runtimeState.runtime,
    });
    const manager = new AcpSessionManager();

    await expect(
      manager.runTurn({
        provenance: "system",
        cfg: {
          acp: {
            ...baseCfg.acp,
            backend: "primary-backend",
            fallbacks: ["fallback-backend"],
          },
        },
        sessionKey,
        text: "status error",
        mode: "prompt",
        requestId: "status-error",
      }),
    ).rejects.toMatchObject({ code: "ACP_TURN_FAILED" });

    expect(managerStateWrites).toEqual(["running", "error"]);
    expect(runtimeState.runTurn).toHaveBeenCalledOnce();
    expect(runtimeState.getStatus).toHaveBeenCalledOnce();
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledOnce();
    expect(manager.getObservabilitySnapshot().turns).toMatchObject({ completed: 0, failed: 1 });
  });

  it("bounds a hung final status read and does not retry completed work", async () => {
    vi.useFakeTimers();
    try {
      const sessionKey = "agent:codex:acp:status-timeout";
      const runtimeState = createRuntime();
      const managerStateWrites: SessionAcpMeta["state"][] = [];
      installStatefulSession({
        sessionKey,
        initialMeta: readySessionMeta({
          backend: "primary-backend",
          runtimeSessionName: "runtime",
          mode: "oneshot",
        }),
        onPersist: (observation) => {
          if (observation.skipMaintenance && observation.takeCacheOwnership) {
            managerStateWrites.push(observation.next.state);
          }
        },
      });
      runtimeState.ensureSession.mockImplementation(async (input) => ({
        sessionKey: input.sessionKey,
        backend: "primary-backend",
        runtimeSessionName: "runtime",
        backendSessionId: "acp-id",
        sessionResumeSupported: true,
      }));
      runtimeState.getStatus.mockImplementation(
        async ({ signal }) =>
          await new Promise((_, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("status aborted")), {
              once: true,
            });
          }),
      );
      hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
        id: "primary-backend",
        runtime: runtimeState.runtime,
      });
      const manager = new AcpSessionManager();
      const observed = manager
        .runTurn({
          provenance: "system",
          cfg: {
            acp: {
              ...baseCfg.acp,
              backend: "primary-backend",
              fallbacks: ["fallback-backend"],
            },
          },
          sessionKey,
          text: "status timeout",
          mode: "prompt",
          requestId: "status-timeout",
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      await vi.advanceTimersByTimeAsync(5_100);
      await expect(observed).resolves.toMatchObject({
        code: "ACP_TURN_FAILED",
        detailCode: "FINAL_STATUS_TIMEOUT",
      });
      expect(managerStateWrites).toEqual(["running", "error"]);
      expect(runtimeState.runTurn).toHaveBeenCalledOnce();
      expect(runtimeState.getStatus).toHaveBeenCalledOnce();
      expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledOnce();
      expect(manager.getObservabilitySnapshot().turns).toMatchObject({ completed: 0, failed: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});
