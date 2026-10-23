import { describe, expect, it, vi } from "vitest";
/** Tests exact one-shot resume reconstruction and terminal readiness fencing. */
import { createDeferred, awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { isAcpTurnActive } from "./active-turns.js";
import {
  installStatefulSession,
  resumableOneShotMeta,
} from "./manager.one-shot-resume.test-support.js";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
  runtimeTurn,
  type OpenClawConfig,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager one-shot resume", () => {
  installAcpSessionManagerTestLifecycle();

  it.each(["legacy", "preferred"] as const)(
    "commits readiness before completion, liveness release, idle, and close (%s)",
    async (api) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-acp-one-shot-resume-" },
        async () => {
          const sessionKey = "agent:codex:acp:terminal-readiness";
          const parentSessionKey = "agent:main:main";
          const runtimeState = createRuntime();
          const order: string[] = [];
          const statusEntered = createDeferred();
          const releaseStatus = createDeferred();
          const readinessEntered = createDeferred();
          const releaseReadiness = createDeferred();
          const onEvent =
            vi.fn<NonNullable<Parameters<AcpSessionManager["runTurn"]>[0]["onEvent"]>>();
          runtimeState.ensureSession.mockImplementation(async (input) => ({
            sessionKey: input.sessionKey,
            backend: "persisted-backend",
            runtimeSessionName: "fresh-runtime",
            cwd: "/workspace/persisted",
            acpxRecordId: "fresh-record",
            backendSessionId: "fresh-acp-id",
            sessionResumeSupported: true,
          }));
          runtimeState.runTurn.mockImplementation(async function* () {
            order.push("terminal-result");
            yield { type: "done" as const };
          });
          if (api === "preferred") {
            runtimeState.runtime.startTurn = vi.fn<
              NonNullable<typeof runtimeState.runtime.startTurn>
            >((input) => runtimeTurn(input.requestId, { events: runtimeState.runTurn(input) }));
          }
          runtimeState.getStatus.mockImplementation(async () => {
            order.push("final-status");
            statusEntered.resolve();
            await releaseStatus.promise;
            return {
              summary: "status=alive",
              acpxRecordId: "fresh-record",
              backendSessionId: "fresh-acp-id",
              sessionResumeSupported: true,
            };
          });
          runtimeState.close.mockImplementation(async () => {
            order.push("close");
          });
          hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
            id: "persisted-backend",
            runtime: runtimeState.runtime,
          });
          const manager = new AcpSessionManager();
          let managerWriteIndex = 0;
          const persisted = installStatefulSession({
            sessionKey,
            parentSessionKey,
            initialMeta: readySessionMeta({
              backend: "persisted-backend",
              runtimeSessionName: "fresh-runtime",
              mode: "oneshot",
              runtimeOptions: { cwd: "/workspace/persisted" },
            }),
            onPersist: (observation) => {
              if (observation.skipMaintenance && observation.takeCacheOwnership) {
                if (managerWriteIndex === 1) {
                  order.push("readiness");
                  expect(observation.next.identity?.sessionResumeReady).toBe(true);
                  expect(isAcpTurnActive(sessionKey)).toBe(true);
                  expect(manager.getObservabilitySnapshot().turns.active).toBe(1);
                } else if (managerWriteIndex === 2) {
                  order.push("idle");
                  expect(observation.next.state).toBe("idle");
                  expect(isAcpTurnActive(sessionKey)).toBe(false);
                  expect(manager.getObservabilitySnapshot().turns.active).toBe(0);
                }
                managerWriteIndex += 1;
              }
            },
          });

          onEvent.mockImplementation(() => {
            expect(persisted.currentMeta.identity?.sessionResumeReady).toBe(true);
            order.push("completed-event");
          });
          const persist = hoisted.upsertAcpSessionMetaMock.getMockImplementation();
          hoisted.upsertAcpSessionMetaMock.mockImplementation(async (input) => {
            if (input.skipMaintenance && input.takeCacheOwnership) {
              const next = input.mutate(persisted.currentMeta, { acp: persisted.currentMeta });
              if (
                next?.identity?.sessionResumeReady === true &&
                !persisted.currentMeta.identity?.sessionResumeReady
              ) {
                readinessEntered.resolve();
                await releaseReadiness.promise;
              }
            }
            if (!persist) {
              throw new Error("stateful persistence mock missing");
            }
            return await persist(input);
          });
          const run = manager.runTurn({
            onEvent,
            provenance: "system",
            cfg: { acp: { ...baseCfg.acp, backend: "persisted-backend" } },
            sessionKey,
            text: "complete once",
            mode: "prompt",
            requestId: "terminal-readiness-run",
          });

          try {
            await awaitGateBeforeSettlement(
              statusEntered.promise,
              run,
              "final status was not reached",
            );
            expect(onEvent).not.toHaveBeenCalled();
            expect(manager.getObservabilitySnapshot().turns.completed).toBe(0);
            releaseStatus.resolve();
            await awaitGateBeforeSettlement(
              readinessEntered.promise,
              run,
              "readiness was not reached",
            );
            expect(onEvent).not.toHaveBeenCalled();
            expect(persisted.currentMeta.identity?.sessionResumeReady).not.toBe(true);
            expect(manager.getObservabilitySnapshot().turns.completed).toBe(0);
            releaseReadiness.resolve();
            await run;
          } finally {
            releaseStatus.resolve();
            releaseReadiness.resolve();
            await run;
          }
          expect(onEvent).toHaveBeenCalledOnce();
          expect(onEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: "done", status: "completed" }),
          );
          expect(order).toEqual([
            "terminal-result",
            "final-status",
            "readiness",
            "completed-event",
            "idle",
            "close",
          ]);
          expect(persisted.currentMeta.identity?.sessionResumeReady).toBe(true);
          expect(runtimeState.getStatus).toHaveBeenCalledOnce();
          expect(managerWriteIndex).toBe(3);
          expect(
            (await listSessionStateEventsSince(sessionKey, "codex", 0, 20)).events.filter(
              (event) => event.runId === "terminal-readiness-run" && event.kind === "run_completed",
            ),
          ).toHaveLength(1);
        },
      );
    },
    300_000,
  );

  it("reconstructs two follow-ups from durable id, backend, cwd, and child key", async () => {
    const sessionKey = "agent:codex:acp:reconstructed-child";
    const runtimeState = createRuntime();
    const managerStateWrites: SessionAcpMeta["state"][] = [];
    const persisted = installStatefulSession({
      sessionKey,
      initialMeta: resumableOneShotMeta(),
      onPersist: (observation) => {
        if (observation.skipMaintenance && observation.takeCacheOwnership) {
          managerStateWrites.push(observation.next.state);
        }
      },
    });
    runtimeState.ensureSession.mockImplementation(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "persisted-backend",
      runtimeSessionName: `synthetic-${runtimeState.ensureSession.mock.calls.length}`,
      cwd: input.cwd,
      acpxRecordId: `synthetic-record-${runtimeState.ensureSession.mock.calls.length}`,
      backendSessionId: input.resumeSessionId,
      sessionResumeSupported: true,
    }));
    runtimeState.getStatus.mockImplementation(async ({ handle }) => ({
      summary: "status=alive",
      acpxRecordId: handle.acpxRecordId,
      backendSessionId: handle.backendSessionId,
      sessionResumeSupported: true,
    }));
    hoisted.requireAcpRuntimeBackendMock.mockImplementation((backendId?: string) => {
      if (backendId !== "persisted-backend") {
        throw new Error(`unexpected backend ${backendId ?? "<auto>"}`);
      }
      return { id: backendId, runtime: runtimeState.runtime };
    });
    const cfg = {
      acp: {
        ...baseCfg.acp,
        backend: "configured-drift",
        fallbacks: ["fallback-backend"],
      },
    } as OpenClawConfig;

    await new AcpSessionManager().runTurn({
      provenance: "system",
      cfg,
      sessionKey,
      text: "first follow-up",
      mode: "prompt",
      requestId: "reconstructed-1",
    });
    await new AcpSessionManager().runTurn({
      provenance: "system",
      cfg,
      sessionKey,
      text: "second follow-up",
      mode: "prompt",
      requestId: "reconstructed-2",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(2);
    for (const [input] of runtimeState.ensureSession.mock.calls) {
      expect(input).toMatchObject({
        sessionKey,
        mode: "oneshot",
        resumeSessionId: "persisted-acp-id",
        cwd: "/workspace/persisted",
      });
    }
    expect(hoisted.requireAcpRuntimeBackendMock.mock.calls.map(([backend]) => backend)).toEqual([
      "persisted-backend",
      "persisted-backend",
    ]);
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(2);
    expect(runtimeState.close).toHaveBeenCalledTimes(2);
    expect(managerStateWrites).toEqual([
      "running",
      "running",
      "idle",
      "running",
      "running",
      "idle",
    ]);
    expect(persisted.currentMeta.identity).toMatchObject({
      acpxSessionId: "persisted-acp-id",
      sessionResumeReady: true,
    });
  });

  it("keeps ready metadata inert across cache-loss status, control, and idle cancel", async () => {
    const sessionKey = "agent:codex:acp:inert-observational-callers";
    const persisted = installStatefulSession({
      sessionKey,
      initialMeta: resumableOneShotMeta(),
    });
    const manager = new AcpSessionManager();

    const status = await manager.getSessionStatus({ cfg: baseCfg, sessionKey });
    expect(status).toMatchObject({
      sessionKey,
      backend: "persisted-backend",
      mode: "oneshot",
      capabilities: { controls: [] },
      identity: {
        acpxSessionId: "persisted-acp-id",
        sessionResumeReady: true,
      },
    });
    await expect(
      manager.setSessionRuntimeMode({ cfg: baseCfg, sessionKey, runtimeMode: "plan" }),
    ).rejects.toThrow("only recreate a runtime for an explicit turn continuation");
    await expect(
      manager.cancelSession({ cfg: baseCfg, sessionKey, reason: "idle-cancel" }),
    ).rejects.toThrow("only recreate a runtime for an explicit turn continuation");

    expect(hoisted.requireAcpRuntimeBackendMock).not.toHaveBeenCalled();
    expect(hoisted.upsertAcpSessionMetaMock).not.toHaveBeenCalled();
    expect(manager.getObservabilitySnapshot().runtimeCache.activeSessions).toBe(0);
    expect(persisted.currentMeta.identity).toMatchObject({
      acpxRecordId: "persisted-record",
      acpxSessionId: "persisted-acp-id",
      sessionResumeReady: true,
    });
  });

  it("makes one exact ensure attempt and no fallback for explicit continuation failure", async () => {
    const sessionKey = "agent:codex:acp:resume-ensure-failure";
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockRejectedValue(
      new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "backend temporarily unavailable"),
    );
    const managerStateWrites: SessionAcpMeta["state"][] = [];
    installStatefulSession({
      sessionKey,
      initialMeta: resumableOneShotMeta(),
      onPersist: (observation) => {
        if (observation.skipMaintenance && observation.takeCacheOwnership) {
          managerStateWrites.push(observation.next.state);
        }
      },
    });
    hoisted.requireAcpRuntimeBackendMock.mockImplementation((backendId?: string) => {
      if (backendId !== "persisted-backend") {
        throw new Error(`fallback attempted: ${backendId ?? "<auto>"}`);
      }
      return { id: backendId, runtime: runtimeState.runtime };
    });
    const manager = new AcpSessionManager();

    await expect(
      manager.runTurn({
        provenance: "system",
        cfg: {
          acp: {
            ...baseCfg.acp,
            backend: "configured-drift",
            fallbacks: ["fallback-backend"],
          },
        },
        sessionKey,
        text: "resume exactly",
        mode: "prompt",
        requestId: "resume-ensure-failure",
      }),
    ).rejects.toMatchObject({ code: "ACP_SESSION_INIT_FAILED" });

    expect(runtimeState.ensureSession).toHaveBeenCalledOnce();
    expect(runtimeState.ensureSession.mock.calls[0]?.[0]).toMatchObject({
      sessionKey,
      resumeSessionId: "persisted-acp-id",
    });
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledOnce();
    expect(runtimeState.runTurn).not.toHaveBeenCalled();
    expect(managerStateWrites).toEqual(["error"]);
    expect(manager.getObservabilitySnapshot().turns).toMatchObject({ completed: 0, failed: 1 });
  });

  it("does not fresh-retry or fail over an explicit resumed turn failure", async () => {
    const sessionKey = "agent:codex:acp:resume-turn-failure";
    const runtimeState = createRuntime();
    runtimeState.ensureSession.mockImplementation(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "persisted-backend",
      runtimeSessionName: "synthetic-runtime",
      cwd: input.cwd,
      acpxRecordId: "synthetic-record",
      backendSessionId: input.resumeSessionId,
      sessionResumeSupported: true,
    }));
    runtimeState.runTurn.mockImplementation(async function* () {
      if (Date.now() < 0) {
        yield { type: "done" as const };
      }
      throw new Error("acpx exited with code 1");
    });
    installStatefulSession({ sessionKey, initialMeta: resumableOneShotMeta() });
    hoisted.requireAcpRuntimeBackendMock.mockImplementation((backendId?: string) => {
      if (backendId !== "persisted-backend") {
        throw new Error(`fallback attempted: ${backendId ?? "<auto>"}`);
      }
      return { id: backendId, runtime: runtimeState.runtime };
    });

    await expect(
      new AcpSessionManager().runTurn({
        provenance: "system",
        cfg: {
          acp: {
            ...baseCfg.acp,
            backend: "configured-drift",
            fallbacks: ["fallback-backend"],
          },
        },
        sessionKey,
        text: "fail without replay",
        mode: "prompt",
        requestId: "resume-turn-failure",
      }),
    ).rejects.toMatchObject({ code: "ACP_TURN_FAILED" });

    expect(runtimeState.ensureSession).toHaveBeenCalledOnce();
    expect(runtimeState.runTurn).toHaveBeenCalledOnce();
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledOnce();
    expect(runtimeState.close).toHaveBeenCalledOnce();
  });

  it("rejects a replaced identity generation immediately before final reconciliation", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-acp-one-shot-resume-" },
      async () => {
        const sessionKey = "agent:codex:acp:reconciliation-generation-race";
        const runtimeState = createRuntime();
        const replacement = resumableOneShotMeta({
          backend: "replacement-backend",
          runtimeSessionName: "replacement-runtime",
          identity: {
            state: "resolved",
            source: "status",
            acpxRecordId: "replacement-record",
            acpxSessionId: "replacement-acp-id",
            sessionResumeSupported: true,
            sessionResumeReady: false,
            lastUpdatedAt: 2,
          },
        });
        let injected = false;
        let unownedWrites = 0;
        let readinessWrites = 0;
        const persisted = installStatefulSession({
          sessionKey,
          parentSessionKey: "agent:main:main",
          initialMeta: readySessionMeta({
            backend: "primary-backend",
            runtimeSessionName: "runtime",
            mode: "oneshot",
          }),
          beforeMutate: (options) => {
            if (!options.skipMaintenance) {
              unownedWrites += 1;
            }
            if (!injected && unownedWrites === 2) {
              injected = true;
              return replacement;
            }
            return undefined;
          },
          onPersist: (observation) => {
            if (
              observation.skipMaintenance &&
              observation.takeCacheOwnership &&
              observation.next.identity?.sessionResumeReady === true
            ) {
              readinessWrites += 1;
            }
          },
        });
        runtimeState.ensureSession.mockImplementation(async (input) => ({
          sessionKey: input.sessionKey,
          backend: "primary-backend",
          runtimeSessionName: "runtime",
          acpxRecordId: "turn-record",
          backendSessionId: "turn-acp-id",
          sessionResumeSupported: true,
        }));
        runtimeState.getStatus.mockResolvedValue({
          summary: "status=alive",
          acpxRecordId: "turn-record",
          backendSessionId: "turn-acp-id",
          sessionResumeSupported: true,
        });
        hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
          id: "primary-backend",
          runtime: runtimeState.runtime,
        });

        await expect(
          new AcpSessionManager().runTurn({
            provenance: "system",
            cfg: { acp: { ...baseCfg.acp, backend: "primary-backend" } },
            sessionKey,
            text: "complete against the original generation",
            mode: "prompt",
            requestId: "reconciliation-generation-race",
          }),
        ).rejects.toMatchObject({
          code: "ACP_TURN_FAILED",
          message: expect.stringContaining("identity changed"),
        });

        expect(injected).toBe(true);
        expect(readinessWrites).toBe(0);
        expect(persisted.currentMeta.backend).toBe("replacement-backend");
        expect(persisted.currentMeta.identity).toMatchObject({
          acpxRecordId: "replacement-record",
          acpxSessionId: "replacement-acp-id",
          sessionResumeReady: false,
        });
        expect(runtimeState.ensureSession).toHaveBeenCalledOnce();
        expect(runtimeState.runTurn).toHaveBeenCalledOnce();
      },
    );
  }, 300_000);

  it("fences readiness generation for an unchanged completed one-shot", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-acp-one-shot-resume-" },
      async () => {
        const sessionKey = "agent:codex:acp:unchanged-observation-generation-race";
        const runtimeState = createRuntime();
        const replacement = readySessionMeta({
          backend: "replacement-backend",
          runtimeSessionName: "replacement-runtime",
          mode: "oneshot",
          identity: {
            state: "resolved",
            source: "status",
            acpxRecordId: "replacement-record",
            acpxSessionId: "replacement-acp-id",
            sessionResumeSupported: true,
            sessionResumeReady: false,
            lastUpdatedAt: 2,
          },
        });
        let injected = false;
        let unownedWrites = 0;
        let readinessWrites = 0;
        const persisted = installStatefulSession({
          sessionKey,
          parentSessionKey: "agent:main:main",
          initialMeta: readySessionMeta({
            backend: "primary-backend",
            runtimeSessionName: "runtime",
            mode: "oneshot",
            identity: {
              state: "resolved",
              source: "status",
              acpxRecordId: "turn-record",
              acpxSessionId: "turn-acp-id",
              sessionResumeSupported: true,
              sessionResumeReady: false,
              lastUpdatedAt: 1,
            },
          }),
          beforeMutate: (options) => {
            if (!options.skipMaintenance) {
              unownedWrites += 1;
            }
            if (!injected && unownedWrites === 2) {
              injected = true;
              return replacement;
            }
            return undefined;
          },
          onPersist: (observation) => {
            if (
              observation.skipMaintenance &&
              observation.takeCacheOwnership &&
              observation.next.identity?.sessionResumeReady === true
            ) {
              readinessWrites += 1;
            }
          },
        });
        runtimeState.ensureSession.mockImplementation(async (input) => ({
          sessionKey: input.sessionKey,
          backend: "primary-backend",
          runtimeSessionName: "runtime",
          acpxRecordId: "turn-record",
          backendSessionId: "turn-acp-id",
          sessionResumeSupported: true,
        }));
        runtimeState.getStatus.mockResolvedValue({
          summary: "status=alive",
          acpxRecordId: "turn-record",
          backendSessionId: "turn-acp-id",
          sessionResumeSupported: true,
        });
        hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
          id: "primary-backend",
          runtime: runtimeState.runtime,
        });

        await expect(
          new AcpSessionManager().runTurn({
            provenance: "system",
            cfg: { acp: { ...baseCfg.acp, backend: "primary-backend" } },
            sessionKey,
            text: "complete against an unchanged observation",
            mode: "prompt",
            requestId: "unchanged-observation-generation-race",
          }),
        ).rejects.toMatchObject({
          code: "ACP_TURN_FAILED",
          message: expect.stringContaining("identity changed"),
        });

        expect(injected).toBe(true);
        expect(readinessWrites).toBe(0);
        expect(persisted.currentMeta.backend).toBe("replacement-backend");
        expect(persisted.currentMeta.identity).toMatchObject({
          acpxRecordId: "replacement-record",
          acpxSessionId: "replacement-acp-id",
          sessionResumeReady: false,
        });
        expect(runtimeState.ensureSession).toHaveBeenCalledOnce();
        expect(runtimeState.runTurn).toHaveBeenCalledOnce();
      },
    );
  }, 300_000);

  it.each([
    {
      label: "cancelled",
      installFailure: false,
      terminalStatus: "cancelled" as const,
      sessionResumeSupported: true,
    },
    {
      label: "failed",
      installFailure: true,
      terminalStatus: "completed" as const,
      sessionResumeSupported: true,
    },
    {
      label: "unsupported",
      installFailure: false,
      terminalStatus: "completed" as const,
      sessionResumeSupported: false,
    },
  ])("does not commit readiness for a $label one-shot", async (testCase) => {
    const sessionKey = `agent:codex:acp:not-ready-${testCase.label}`;
    const runtimeState = createRuntime();
    const managerStateWrites: SessionAcpMeta["state"][] = [];
    installStatefulSession({
      sessionKey,
      initialMeta: readySessionMeta({
        backend: "persisted-backend",
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
      backend: "persisted-backend",
      runtimeSessionName: "runtime",
      acpxRecordId: "record",
      backendSessionId: "acp-id",
      sessionResumeSupported: testCase.sessionResumeSupported,
    }));
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      acpxRecordId: "record",
      backendSessionId: "acp-id",
      sessionResumeSupported: testCase.sessionResumeSupported,
    });
    runtimeState.runTurn.mockImplementation(async function* () {
      if (testCase.installFailure) {
        throw new AcpRuntimeError("ACP_TURN_FAILED", "turn failed");
      }
      yield { type: "done" as const, status: testCase.terminalStatus };
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "persisted-backend",
      runtime: runtimeState.runtime,
    });

    const turn = new AcpSessionManager().runTurn({
      provenance: "system",
      cfg: { acp: { ...baseCfg.acp, backend: "persisted-backend" } },
      sessionKey,
      text: "not ready",
      mode: "prompt",
      requestId: `not-ready-${testCase.label}`,
    });
    if (testCase.installFailure) {
      await expect(turn).rejects.toMatchObject({ code: "ACP_TURN_FAILED" });
    } else {
      await expect(turn).resolves.toBeUndefined();
    }

    expect(managerStateWrites.filter((state) => state === "running")).toHaveLength(1);
  });

  it("retains manager and global liveness through cancelled state writes and cleanup", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-acp-one-shot-resume-" },
      async () => {
        const sessionKey = "agent:codex:acp:cancelled-liveness-order";
        const runtimeState = createRuntime();
        const order: string[] = [];
        const manager = new AcpSessionManager();
        let committedIdle: SessionAcpMeta | undefined;
        const persisted = installStatefulSession({
          sessionKey,
          parentSessionKey: "agent:main:main",
          initialMeta: readySessionMeta({ mode: "oneshot" }),
          onPersist: (observation) => {
            if (
              observation.skipMaintenance &&
              observation.takeCacheOwnership &&
              observation.next.state === "idle"
            ) {
              expect(order).toEqual(["producer-finished"]);
              committedIdle = observation.next;
              order.push("idle");
              expect(isAcpTurnActive(sessionKey)).toBe(true);
              expect(manager.getObservabilitySnapshot().turns.active).toBe(1);
            }
          },
        });
        runtimeState.runTurn.mockImplementation(async function* () {
          try {
            yield { type: "done" as const, status: "cancelled" as const };
          } finally {
            order.push("producer-finished");
          }
        });
        runtimeState.close.mockImplementation(async ({ handle }) => {
          // The observer precedes fixture commit; read the owned store at close.
          expect(committedIdle).toBeDefined();
          expect(persisted.currentMeta).toMatchObject({
            state: "idle",
            backend: handle.backend,
            runtimeSessionName: handle.runtimeSessionName,
            lastActivityAt: committedIdle?.lastActivityAt,
          });
          expect(order).toEqual(["producer-finished", "idle"]);
          order.push("close");
          expect(isAcpTurnActive(sessionKey)).toBe(true);
          expect(manager.getObservabilitySnapshot().turns.active).toBe(1);
        });
        hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
          id: "acpx",
          runtime: runtimeState.runtime,
        });

        await manager.runTurn({
          provenance: "system",
          cfg: baseCfg,
          sessionKey,
          text: "cancel cleanly",
          mode: "prompt",
          requestId: "cancelled-liveness-order",
        });

        // Terminal projection is a separate owner, not another manager idle commit.
        expect(order).toEqual(["producer-finished", "idle", "close"]);
        expect(runtimeState.runTurn).toHaveBeenCalledOnce();
        expect(runtimeState.close).toHaveBeenCalledOnce();
        expect(persisted.currentMeta.state).toBe("idle");
        expect(isAcpTurnActive(sessionKey)).toBe(false);
        expect(manager.getObservabilitySnapshot().turns.active).toBe(0);
      },
    );
  }, 300_000);

  it("retains manager and global liveness through failed state writes and cleanup", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-acp-one-shot-resume-" },
      async () => {
        const sessionKey = "agent:codex:acp:failed-liveness-order";
        const runtimeState = createRuntime();
        const order: string[] = [];
        const manager = new AcpSessionManager();
        installStatefulSession({
          sessionKey,
          parentSessionKey: "agent:main:main",
          initialMeta: readySessionMeta({ mode: "oneshot" }),
          onPersist: (observation) => {
            if (observation.next.state === "error") {
              order.push("error");
              expect(isAcpTurnActive(sessionKey)).toBe(true);
              expect(manager.getObservabilitySnapshot().turns.active).toBe(1);
            }
          },
        });
        runtimeState.runTurn.mockImplementation(async function* () {
          if (Date.now() < 0) {
            yield { type: "done" as const };
          }
          throw new AcpRuntimeError("ACP_TURN_FAILED", "deterministic turn failure");
        });
        runtimeState.close.mockImplementation(async () => {
          order.push("close");
          expect(isAcpTurnActive(sessionKey)).toBe(true);
          expect(manager.getObservabilitySnapshot().turns.active).toBe(1);
        });
        hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
          id: "acpx",
          runtime: runtimeState.runtime,
        });

        await expect(
          manager.runTurn({
            provenance: "system",
            cfg: baseCfg,
            sessionKey,
            text: "fail cleanly",
            mode: "prompt",
            requestId: "failed-liveness-order",
          }),
        ).rejects.toThrow("deterministic turn failure");

        expect(order).toEqual(["error", "close"]);
        expect(isAcpTurnActive(sessionKey)).toBe(false);
        expect(manager.getObservabilitySnapshot().turns.active).toBe(0);
      },
    );
  }, 300_000);

  it("fails a readiness write once without replay or backend fallback", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-acp-one-shot-resume-" },
      async () => {
        const sessionKey = "agent:codex:acp:readiness-write-failure";
        const runtimeState = createRuntime();
        const onEvent = vi.fn();
        let readinessAttempts = 0;
        let managerWriteCount = 0;
        const persisted = installStatefulSession({
          sessionKey,
          parentSessionKey: "agent:main:main",
          initialMeta: readySessionMeta({
            backend: "primary-backend",
            runtimeSessionName: "runtime",
            mode: "oneshot",
          }),
        });
        runtimeState.ensureSession.mockImplementation(async (input) => ({
          sessionKey: input.sessionKey,
          backend: "primary-backend",
          runtimeSessionName: "runtime",
          acpxRecordId: "record",
          backendSessionId: "acp-id",
          sessionResumeSupported: true,
        }));
        runtimeState.getStatus.mockResolvedValue({
          summary: "status=alive",
          acpxRecordId: "record",
          backendSessionId: "acp-id",
          sessionResumeSupported: true,
        });
        hoisted.requireAcpRuntimeBackendMock.mockImplementation((backendId?: string) => {
          if (backendId !== "primary-backend") {
            throw new Error(`fallback attempted: ${backendId ?? "<auto>"}`);
          }
          return { id: backendId, runtime: runtimeState.runtime };
        });
        const persist = hoisted.upsertAcpSessionMetaMock.getMockImplementation();
        hoisted.upsertAcpSessionMetaMock.mockImplementation(async (inputUnknown: unknown) => {
          const input = inputUnknown as {
            failOnError?: boolean;
            skipMaintenance?: boolean;
            takeCacheOwnership?: boolean;
            mutate: (
              current: SessionAcpMeta | undefined,
              entry: { acp?: SessionAcpMeta } | undefined,
            ) => SessionAcpMeta | null | undefined;
          };
          const preview = input.mutate(persisted.currentMeta, {
            acp: persisted.currentMeta,
          });
          if (input.skipMaintenance === true && input.takeCacheOwnership === true) {
            managerWriteCount += 1;
            if (managerWriteCount === 2) {
              expect(preview?.identity?.sessionResumeReady).toBe(true);
              readinessAttempts += 1;
              throw new Error("resume metadata temporarily unavailable");
            }
          }
          if (!persist) {
            throw new Error("stateful persistence mock missing");
          }
          return await persist(inputUnknown);
        });
        const manager = new AcpSessionManager();

        await expect(
          manager.runTurn({
            onEvent,
            provenance: "system",
            cfg: {
              acp: {
                ...baseCfg.acp,
                backend: "primary-backend",
                fallbacks: ["fallback-backend"],
              },
            },
            sessionKey,
            text: "complete without replay",
            mode: "prompt",
            requestId: "readiness-write-failure",
          }),
        ).rejects.toMatchObject({ code: "ACP_TURN_FAILED" });

        expect(onEvent).not.toHaveBeenCalled();
        expect(readinessAttempts).toBe(1);
        expect(runtimeState.runTurn).toHaveBeenCalledOnce();
        expect(runtimeState.ensureSession).toHaveBeenCalledOnce();
        expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledOnce();
        expect(persisted.currentMeta.identity?.sessionResumeReady).not.toBe(true);
        expect(manager.getObservabilitySnapshot().turns).toMatchObject({ completed: 0, failed: 1 });
        expect(managerWriteCount).toBe(3);
        expect(
          (await listSessionStateEventsSince(sessionKey, "codex", 0, 20)).events.filter(
            (event) => event.runId === "readiness-write-failure" && event.kind === "run_failed",
          ),
        ).toHaveLength(1);
      },
    );
  }, 300_000);
});
