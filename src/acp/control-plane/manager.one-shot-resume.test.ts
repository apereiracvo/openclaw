/** Tests exact one-shot resume reconstruction and terminal readiness fencing. */
import { describe, expect, it, vi } from "vitest";
import {
  requireTaskByRunId,
  withAcpManagerTaskStateDir,
} from "../../../test/helpers/acp-manager-task-state.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import { isAcpTurnActive } from "./active-turns.js";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
  type OpenClawConfig,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

type PersistObservation = {
  failOnError?: boolean;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
  next: SessionAcpMeta;
};

function resumableOneShotMeta(overrides: Partial<SessionAcpMeta> = {}): SessionAcpMeta {
  return readySessionMeta({
    backend: "persisted-backend",
    runtimeSessionName: "persisted-runtime",
    mode: "oneshot",
    runtimeOptions: { cwd: "/workspace/persisted" },
    cwd: "/workspace/legacy",
    identity: {
      state: "resolved",
      source: "status",
      acpxRecordId: "persisted-record",
      acpxSessionId: "persisted-acp-id",
      agentSessionId: "legacy-agent-id",
      sessionResumeSupported: true,
      sessionResumeReady: true,
      lastUpdatedAt: 1,
    },
    ...overrides,
  });
}

function installStatefulSession(params: {
  sessionKey: string;
  initialMeta: SessionAcpMeta;
  parentSessionKey?: string;
  onPersist?: (observation: PersistObservation) => void;
  beforeMutate?: (options: {
    failOnError?: boolean;
    skipMaintenance?: boolean;
    takeCacheOwnership?: boolean;
    current: SessionAcpMeta;
  }) => SessionAcpMeta | undefined;
}) {
  let currentMeta = params.initialMeta;
  const childEntry = {
    sessionId: "child-session",
    updatedAt: 1,
    ...(params.parentSessionKey ? { spawnedBy: params.parentSessionKey } : {}),
  };
  hoisted.readAcpSessionEntryMock.mockImplementation((inputUnknown: unknown) => {
    const sessionKey = (inputUnknown as { sessionKey?: string }).sessionKey;
    if (sessionKey === params.sessionKey) {
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        entry: childEntry,
        acp: currentMeta,
      };
    }
    if (sessionKey === params.parentSessionKey) {
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        entry: { sessionId: "parent-session", updatedAt: 1 },
      };
    }
    return null;
  });
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
    currentMeta =
      params.beforeMutate?.({
        failOnError: input.failOnError,
        skipMaintenance: input.skipMaintenance,
        takeCacheOwnership: input.takeCacheOwnership,
        current: currentMeta,
      }) ?? currentMeta;
    const next = input.mutate(currentMeta, { ...childEntry, acp: currentMeta });
    if (next && next !== currentMeta) {
      params.onPersist?.({
        failOnError: input.failOnError,
        skipMaintenance: input.skipMaintenance,
        takeCacheOwnership: input.takeCacheOwnership,
        next,
      });
      currentMeta = next;
    }
    return { ...childEntry, acp: currentMeta };
  });
  return {
    get currentMeta() {
      return currentMeta;
    },
  };
}

describe("AcpSessionManager one-shot resume", () => {
  installAcpSessionManagerTestLifecycle();

  it("commits readiness before liveness release, task success, idle, and close", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const sessionKey = "agent:codex:acp:terminal-readiness";
      const parentSessionKey = "agent:main:main";
      const runtimeState = createRuntime();
      const order: string[] = [];
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
      runtimeState.getStatus.mockImplementation(async () => {
        order.push("final-status");
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
              expect(requireTaskByRunId("terminal-readiness-run").status).not.toBe("succeeded");
            } else if (managerWriteIndex === 2) {
              order.push("idle");
              expect(observation.next.state).toBe("idle");
              expect(isAcpTurnActive(sessionKey)).toBe(false);
              expect(manager.getObservabilitySnapshot().turns.active).toBe(0);
              expect(requireTaskByRunId("terminal-readiness-run").status).toBe("succeeded");
            }
            managerWriteIndex += 1;
          }
        },
      });

      await manager.runTurn({
        provenance: "system",
        cfg: { acp: { ...baseCfg.acp, backend: "persisted-backend" } },
        sessionKey,
        text: "complete once",
        mode: "prompt",
        requestId: "terminal-readiness-run",
      });

      expect(order).toEqual(["terminal-result", "final-status", "readiness", "idle", "close"]);
      expect(persisted.currentMeta.identity?.sessionResumeReady).toBe(true);
      expect(runtimeState.getStatus).toHaveBeenCalledOnce();
      expect(requireTaskByRunId("terminal-readiness-run").status).toBe("succeeded");
      expect(managerWriteIndex).toBe(3);
      expect(
        listSessionStateEventsSince(sessionKey, "codex", 0, 20).events.filter(
          (event) => event.runId === "terminal-readiness-run" && event.kind === "run_completed",
        ),
      ).toHaveLength(1);
    });
  }, 300_000);

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
    await withAcpManagerTaskStateDir(async () => {
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
    });
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

  it("retains manager and global liveness through cancelled task writes and cleanup", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const sessionKey = "agent:codex:acp:cancelled-liveness-order";
      const runtimeState = createRuntime();
      const order: string[] = [];
      const manager = new AcpSessionManager();
      installStatefulSession({
        sessionKey,
        parentSessionKey: "agent:main:main",
        initialMeta: readySessionMeta({ mode: "oneshot" }),
        onPersist: (observation) => {
          if (observation.next.state === "idle") {
            order.push("idle");
            expect(requireTaskByRunId("cancelled-liveness-order").status).toBe("cancelled");
            expect(isAcpTurnActive(sessionKey)).toBe(true);
            expect(manager.getObservabilitySnapshot().turns.active).toBe(1);
          }
        },
      });
      runtimeState.runTurn.mockImplementation(async function* () {
        yield { type: "done" as const, status: "cancelled" as const };
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

      await manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey,
        text: "cancel cleanly",
        mode: "prompt",
        requestId: "cancelled-liveness-order",
      });

      expect(order).toEqual(["idle", "idle", "close"]);
      expect(isAcpTurnActive(sessionKey)).toBe(false);
      expect(manager.getObservabilitySnapshot().turns.active).toBe(0);
    });
  }, 300_000);

  it("retains manager and global liveness through failed task writes and cleanup", async () => {
    await withAcpManagerTaskStateDir(async () => {
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
            expect(requireTaskByRunId("failed-liveness-order").status).toBe("failed");
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
    });
  }, 300_000);

  it("fails a readiness write once without replay or backend fallback", async () => {
    await withAcpManagerTaskStateDir(async () => {
      const sessionKey = "agent:codex:acp:readiness-write-failure";
      const runtimeState = createRuntime();
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

      expect(readinessAttempts).toBe(1);
      expect(runtimeState.runTurn).toHaveBeenCalledOnce();
      expect(runtimeState.ensureSession).toHaveBeenCalledOnce();
      expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledOnce();
      expect(persisted.currentMeta.identity?.sessionResumeReady).not.toBe(true);
      expect(requireTaskByRunId("readiness-write-failure").status).toBe("failed");
      expect(manager.getObservabilitySnapshot().turns).toMatchObject({ completed: 0, failed: 1 });
      expect(managerWriteCount).toBe(3);
      expect(
        listSessionStateEventsSince(sessionKey, "codex", 0, 20).events.filter(
          (event) => event.runId === "readiness-write-failure" && event.kind === "run_failed",
        ),
      ).toHaveLength(1);
    });
  }, 300_000);

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
