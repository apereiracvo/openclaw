/** Cross-owner admission, persistence, maintenance, and exact continuation proof for one-shot resume. */
import path from "node:path";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  requireTaskByRunId,
  resetAcpManagerTaskStateForTests,
  withAcpManagerTaskStateDir,
} from "../../../test/helpers/acp-manager-task-state.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import type { AgentToolGatewayRequestCaller } from "../../agents/tools/in-process-gateway.js";
import { createSessionsSendTool } from "../../agents/tools/sessions-send-tool.js";
import type { OpenClawConfig } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  resetTaskRegistryMaintenanceRuntimeForTests,
  runTaskRegistryMaintenance,
} from "../../tasks/task-registry.maintenance.js";
import { AcpRuntimeError } from "../runtime/errors.js";
import {
  listAcpSessionEntries,
  readAcpSessionEntry,
  readAcpSessionMeta,
  upsertAcpSessionMeta,
} from "../runtime/session-meta.js";
import { resetAcpActiveTurnsForTests } from "./active-turns.test-support.js";
import { AcpSessionManager, testing as managerTesting } from "./manager.js";

const baseCfg = {
  acp: { enabled: true, backend: "acpx", dispatch: { enabled: true } },
} as const;
type GatewayRequest = Parameters<AgentToolGatewayRequestCaller>[0];

function createRuntime(): {
  runtime: AcpRuntime;
  ensureSession: ReturnType<typeof vi.fn<AcpRuntime["ensureSession"]>>;
  runTurn: ReturnType<typeof vi.fn<AcpRuntime["runTurn"]>>;
  close: ReturnType<typeof vi.fn<AcpRuntime["close"]>>;
  getStatus: ReturnType<typeof vi.fn<NonNullable<AcpRuntime["getStatus"]>>>;
} {
  const ensureSession = vi.fn<AcpRuntime["ensureSession"]>();
  const runTurn = vi.fn<AcpRuntime["runTurn"]>(async function* () {
    yield { type: "done" as const };
  });
  const close = vi.fn<AcpRuntime["close"]>(async () => {});
  const getStatus = vi.fn<NonNullable<AcpRuntime["getStatus"]>>();
  return {
    runtime: {
      ensureSession,
      runTurn,
      close,
      cancel: async () => {},
      prepareFreshSession: async () => {},
      getStatus,
    },
    ensureSession,
    runTurn,
    close,
    getStatus,
  };
}

function pendingOneShotMeta(params: {
  backend: string;
  cwd: string;
  runtimeSessionName: string;
}): SessionAcpMeta {
  return {
    backend: params.backend,
    agent: "codex",
    runtimeSessionName: params.runtimeSessionName,
    mode: "oneshot",
    state: "idle",
    lastActivityAt: 1,
    runtimeOptions: { cwd: params.cwd },
    cwd: params.cwd,
  };
}

function createManager(params: {
  backend: string;
  runtime: AcpRuntime;
  onReadinessCommit: () => void;
  requireBackend: (backendId?: string) => { id: string; runtime: AcpRuntime };
}): AcpSessionManager {
  const observedUpsert: typeof upsertAcpSessionMeta = async (input) =>
    await upsertAcpSessionMeta({
      ...input,
      mutate: (current, entry) => {
        const next = input.mutate(current, entry);
        if (
          current?.identity?.sessionResumeReady !== true &&
          next?.identity?.sessionResumeReady === true
        ) {
          params.onReadinessCommit();
        }
        return next;
      },
    });
  return new AcpSessionManager({
    listAcpSessions: listAcpSessionEntries,
    loadSessionEntry: readAcpSessionEntry,
    upsertSessionMeta: observedUpsert,
    getRuntimeBackend: (backendId?: string) =>
      backendId === params.backend ? { id: params.backend, runtime: params.runtime } : null,
    requireRuntimeBackend: params.requireBackend,
  });
}

beforeEach(() => {
  managerTesting.resetAcpSessionManagerForTests();
  resetAcpActiveTurnsForTests();
  resetTaskRegistryMaintenanceRuntimeForTests();
  vi.useRealTimers();
});

afterEach(() => {
  resetAcpActiveTurnsForTests();
  resetAcpManagerTaskStateForTests();
  resetTaskRegistryMaintenanceRuntimeForTests();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("ACP one-shot cross-owner resume integration", () => {
  it("admits two owner follow-ups through sessions_send and resumes one exact conversation", async () => {
    await withAcpManagerTaskStateDir(async (root) => {
      const sessionKey = "agent:codex:acp:integrated-resume-child";
      const parentSessionKey = "agent:codex:discord:direct:owning-parent";
      const cwd = path.join(root, "workspace");
      const backend = "wire-backend";
      const protocolSessionId = "wire-session-1";
      const openClawSessionId = "openclaw-child-session";
      const cfg = {
        session: { mainKey: "main", scope: "per-sender" },
        tools: {
          sessions: { visibility: "tree" },
          agentToAgent: { enabled: true },
        },
        acp: { ...baseCfg.acp, backend },
      } as OpenClawConfig;
      const restartedCfg = {
        ...cfg,
        acp: {
          ...baseCfg.acp,
          backend: "configured-backend-drift",
          fallbacks: ["must-not-run"],
        },
      } as OpenClawConfig;

      await replaceSessionEntry(
        { agentId: "codex", sessionKey },
        {
          sessionId: openClawSessionId,
          updatedAt: Date.now(),
          spawnedBy: parentSessionKey,
          parentSessionKey,
        },
      );
      await upsertAcpSessionMeta({
        cfg,
        sessionKey,
        mutate: () => pendingOneShotMeta({ backend, cwd, runtimeSessionName: "initial-record" }),
      });

      const runtimeState = createRuntime();
      runtimeState.ensureSession.mockImplementation(async (input) => ({
        sessionKey: input.sessionKey,
        backend,
        runtimeSessionName: `record-${runtimeState.ensureSession.mock.calls.length}`,
        cwd: input.cwd,
        acpxRecordId: `record-${runtimeState.ensureSession.mock.calls.length}`,
        backendSessionId: input.resumeSessionId ?? protocolSessionId,
        sessionResumeSupported: true,
      }));
      runtimeState.getStatus.mockImplementation(async ({ handle }) => ({
        summary: "status=alive",
        acpxRecordId: handle.acpxRecordId,
        backendSessionId: handle.backendSessionId,
        sessionResumeSupported: true,
      }));
      const requireBackend = vi.fn((backendId?: string) => {
        if (backendId !== backend) {
          throw new Error(`unexpected backend ${backendId ?? "<auto>"}`);
        }
        return { id: backend, runtime: runtimeState.runtime };
      });
      let readinessCommits = 0;
      const managerFactory = () =>
        createManager({
          backend,
          runtime: runtimeState.runtime,
          onReadinessCommit: () => {
            readinessCommits += 1;
          },
          requireBackend,
        });

      const initialRequestId = "integrated-initial";
      await managerFactory().runTurn({
        admittedRunContext: createTestAdmittedRunContext(initialRequestId),
        provenance: "system",
        cfg,
        sessionKey,
        text: "remember marker alpha",
        mode: "prompt",
        requestId: initialRequestId,
      });

      const gatewayCalls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
      const dispatchThroughGateway: AgentToolGatewayRequestCaller = async <T>(
        request: GatewayRequest,
      ) => {
        const recorded = {
          method: request.method,
          params: request.params as Record<string, unknown> | undefined,
        };
        gatewayCalls.push(recorded);
        if (request.method === "sessions.resolve") {
          const query = recorded.params ?? {};
          expect(query.key).toBe(sessionKey);
          if (query.spawnedBy !== undefined) {
            expect(query.spawnedBy).toBe(parentSessionKey);
          }
          return { agentId: "codex", key: sessionKey } as T;
        }
        if (request.method !== "agent") {
          throw new Error(`unexpected gateway method ${request.method ?? "<missing>"}`);
        }
        const params = recorded.params ?? {};
        expect(params.sessionKey).toBe(sessionKey);
        expect(params.agentId).toBe("codex");
        expect(params.deliver).toBe(false);
        expect(params.sourceReplyDeliveryMode).toBe("message_tool_only");
        expect(params.inputProvenance).toEqual({
          kind: "inter_session",
          sourceSessionKey: "agent:codex:main",
          sourceChannel: "discord",
          sourceTool: "sessions_send",
        });
        expect(params.message).toContain("[Inter-session message]");
        const requestId = String(params.idempotencyKey);
        await managerFactory().runTurn({
          admittedRunContext: createTestAdmittedRunContext(requestId),
          provenance: "agent",
          cfg: restartedCfg,
          sessionKey,
          text: String(params.message),
          mode: "prompt",
          requestId,
        });
        return { runId: requestId, status: "accepted", acceptedAt: 2_000 } as T;
      };

      const executeFollowUp = async (
        toolCallId: string,
        message: string,
        expectedStatus: "accepted" | "error" = "accepted",
      ) => {
        const tool = createSessionsSendTool({
          agentSessionKey: parentSessionKey,
          agentChannel: "discord",
          config: restartedCfg,
          callGateway: dispatchThroughGateway,
          expectedTargetSessionId: openClawSessionId,
          idempotencyKey: toolCallId,
        });
        const result = await tool.execute(toolCallId, {
          sessionKey,
          message,
          timeoutSeconds: 15,
        });
        expect(result.details).toMatchObject({
          runId: toolCallId,
          status: expectedStatus,
          sessionKey,
          ...(expectedStatus === "accepted"
            ? { delivery: { status: "skipped", mode: "announce" } }
            : {}),
        });
        return result;
      };

      for (const [requestId, message] of [
        ["integrated-followup-1", "repeat marker"],
        ["integrated-followup-2", "repeat it again"],
      ] as const) {
        await runTaskRegistryMaintenance();
        expect(readAcpSessionMeta({ cfg, sessionKey })).toMatchObject({
          backend,
          identity: { acpxSessionId: protocolSessionId, sessionResumeReady: true },
        });
        await executeFollowUp(requestId, message);
      }

      for (const requestId of [
        initialRequestId,
        "integrated-followup-1",
        "integrated-followup-2",
      ]) {
        expect(requireTaskByRunId(requestId).status).toBe("succeeded");
        expect(
          listSessionStateEventsSince(sessionKey, "codex", 0, 100).events.filter(
            (event) => event.runId === requestId && event.kind === "run_completed",
          ),
        ).toHaveLength(1);
      }
      expect(gatewayCalls.filter((call) => call.method === "agent")).toHaveLength(2);
      expect(
        gatewayCalls.filter(
          (call) =>
            call.method === "sessions.resolve" && call.params?.spawnedBy === parentSessionKey,
        ),
      ).not.toHaveLength(0);
      expect(runtimeState.ensureSession).toHaveBeenCalledTimes(3);
      expect(runtimeState.ensureSession.mock.calls.map(([input]) => input.sessionKey)).toEqual([
        sessionKey,
        sessionKey,
        sessionKey,
      ]);
      expect(runtimeState.ensureSession.mock.calls.map(([input]) => input.cwd)).toEqual([
        cwd,
        cwd,
        cwd,
      ]);
      expect(runtimeState.ensureSession.mock.calls.map(([input]) => input.resumeSessionId)).toEqual(
        [undefined, protocolSessionId, protocolSessionId],
      );
      expect(requireBackend.mock.calls.map(([backendId]) => backendId)).toEqual([
        backend,
        backend,
        backend,
      ]);
      expect(runtimeState.runTurn).toHaveBeenCalledTimes(3);
      expect(runtimeState.close).toHaveBeenCalledTimes(3);
      expect(readinessCommits).toBe(3);

      runtimeState.ensureSession.mockRejectedValueOnce(
        new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "explicit resume target is missing"),
      );
      const failed = await executeFollowUp(
        "integrated-missing-target",
        "continue the missing exact target",
        "error",
      );
      expect((failed.details as { error?: string }).error).toContain("resume target is missing");
      expect(requireTaskByRunId("integrated-missing-target").status).toBe("failed");
      expect(runtimeState.ensureSession).toHaveBeenCalledTimes(4);
      expect(runtimeState.ensureSession.mock.calls[3]?.[0]).toMatchObject({
        sessionKey,
        cwd,
        resumeSessionId: protocolSessionId,
      });
      expect(runtimeState.runTurn).toHaveBeenCalledTimes(3);
      expect(runtimeState.close).toHaveBeenCalledTimes(3);
      expect(requireBackend.mock.calls.map(([backendId]) => backendId)).toEqual([
        backend,
        backend,
        backend,
        backend,
      ]);
      expect(gatewayCalls.filter((call) => call.method === "agent")).toHaveLength(3);

      await runTaskRegistryMaintenance();
      expect(readAcpSessionMeta({ cfg, sessionKey })).toMatchObject({
        state: "error",
        identity: { acpxSessionId: protocolSessionId, sessionResumeReady: true },
      });
      await managerFactory().closeSession({
        cfg,
        sessionKey,
        reason: "integration-test-cleanup",
        discardPersistentState: true,
        clearMeta: true,
        allowBackendUnavailable: true,
      });
      expect(readAcpSessionMeta({ cfg, sessionKey })).toBeUndefined();
      expect(
        (await listAcpSessionEntries({ clone: false })).map((row) => row.sessionKey),
      ).not.toContain(sessionKey);
    });
  }, 300_000);

  it("fences a changed target incarnation before dispatch", async () => {
    await withAcpManagerTaskStateDir(async (root) => {
      const sessionKey = "agent:codex:acp:fenced-resume-child";
      const parentSessionKey = "agent:codex:main";
      const cfg = {
        session: {},
        tools: { sessions: { visibility: "tree" }, agentToAgent: { enabled: true } },
      } as OpenClawConfig;
      await replaceSessionEntry(
        { agentId: "codex", sessionKey },
        {
          sessionId: "new-incarnation",
          updatedAt: Date.now(),
          spawnedBy: parentSessionKey,
          parentSessionKey,
          acp: {
            ...pendingOneShotMeta({
              backend: "wire-backend",
              cwd: root,
              runtimeSessionName: "ready",
            }),
            identity: {
              state: "resolved",
              source: "status",
              acpxSessionId: "wire-session",
              sessionResumeSupported: true,
              sessionResumeReady: true,
              lastUpdatedAt: 1,
            },
          },
        },
      );
      const gatewayCalls: string[] = [];
      const gateway: AgentToolGatewayRequestCaller = async <T>(request: GatewayRequest) => {
        gatewayCalls.push(request.method);
        if (request.method === "sessions.resolve") {
          return { agentId: "codex", key: sessionKey } as T;
        }
        throw new Error("agent dispatch must be fenced");
      };
      const tool = createSessionsSendTool({
        agentSessionKey: parentSessionKey,
        config: cfg,
        callGateway: gateway,
        expectedTargetSessionId: "old-incarnation",
        idempotencyKey: "fenced-followup",
      });

      await expect(
        tool.execute("fenced-followup", { sessionKey, message: "continue", timeoutSeconds: 15 }),
      ).rejects.toThrow(/incarnation|changed|expected/i);
      expect(gatewayCalls).not.toContain("agent");
    });
  });

  it("maintenance retains a real verified one-shot row and removes a real negative row", async () => {
    await withAcpManagerTaskStateDir(async (root) => {
      const parentSessionKey = "agent:codex:main";
      const retainedKey = "agent:codex:acp:maintenance-retained";
      const removedKey = "agent:codex:acp:maintenance-removed";
      const cfg = { session: {}, acp: baseCfg.acp } as OpenClawConfig;
      const parentedEntry = (sessionId: string) => ({
        sessionId,
        updatedAt: Date.now(),
        spawnedBy: parentSessionKey,
        parentSessionKey,
      });
      await replaceSessionEntry(
        { agentId: "codex", sessionKey: retainedKey },
        parentedEntry("retained-session"),
      );
      await replaceSessionEntry(
        { agentId: "codex", sessionKey: removedKey },
        parentedEntry("removed-session"),
      );
      await upsertAcpSessionMeta({
        cfg,
        sessionKey: retainedKey,
        mutate: () => ({
          ...pendingOneShotMeta({
            backend: "wire-backend",
            cwd: root,
            runtimeSessionName: "retained-runtime",
          }),
          identity: {
            state: "resolved",
            source: "status",
            acpxSessionId: "retained-wire-session",
            sessionResumeSupported: true,
            sessionResumeReady: true,
            lastUpdatedAt: 1,
          },
        }),
      });
      await upsertAcpSessionMeta({
        cfg,
        sessionKey: removedKey,
        mutate: () =>
          pendingOneShotMeta({
            backend: "wire-backend",
            cwd: root,
            runtimeSessionName: "unverified-runtime",
          }),
      });
      const persistedRows = await listAcpSessionEntries({ clone: false });
      expect(persistedRows.map((row) => row.sessionKey)).toEqual(
        expect.arrayContaining([retainedKey, removedKey]),
      );
      expect(persistedRows.find((row) => row.sessionKey === removedKey)).toMatchObject({
        entry: { spawnedBy: parentSessionKey, parentSessionKey },
      });

      await runTaskRegistryMaintenance();

      expect(readAcpSessionMeta({ cfg, sessionKey: retainedKey })).toMatchObject({
        identity: {
          acpxSessionId: "retained-wire-session",
          sessionResumeReady: true,
        },
      });
      expect(readAcpSessionMeta({ cfg, sessionKey: removedKey })).toBeUndefined();
      expect(
        (await listAcpSessionEntries({ clone: false })).map((row) => row.sessionKey),
      ).toContain(retainedKey);
      expect(
        (await listAcpSessionEntries({ clone: false })).map((row) => row.sessionKey),
      ).not.toContain(removedKey);
    });
  });
});
