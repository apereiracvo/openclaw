import "./openclaw-tools.sessions.mocks.test-support.js";
import "./test-helpers/fast-openclaw-tools-sessions.js";
import type { Static } from "typebox";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentParamsSchema } from "../../packages/gateway-protocol/src/schema/agent.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { clearAcpTurnActive, markAcpTurnActive } from "../acp/control-plane/active-turns.js";
import { resetAcpActiveTurnsForTests } from "../acp/control-plane/active-turns.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { resetAdjustedParamsByToolCallIdForTests } from "./agent-tools.before-tool-call.state.js";
import { testing as embeddedRunsTesting } from "./embedded-agent-runner/runs.test-support.js";
import { createSessionsSendTestCaller } from "./openclaw-tools.sessions-steering.test-support.js";
import { observeSessionSendContinuations } from "./openclaw-tools.sessions-timeout.test-support.js";
import {
  getSessionTool as getUpstreamSessionTool,
  createSessionsSendGatewayScope,
  mockAcceptedChildFollowup,
  installMessagingTestRegistry,
  TEST_CONFIG,
} from "./openclaw-tools.sessions.test-support.js";
import {
  readFollowupRequest,
  SessionFollowupCompletion,
} from "./subagents/completion/session-followup-completion.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import type { SessionsSendToolOptions } from "./tools/sessions-send-tool.types.js";

const { callGatewayMock } = await import("./openclaw-tools.sessions.mocks.test-support.js");
useSessionStoreTempDirs(afterAll, "openclaw-parent-session-send-");
const continuations = observeSessionSendContinuations();
const mainKey = "agent:main:main";

/** Only the send owner accepts ACP seams; list/history keep U's shared fixture. */
function getSessionTool(
  name: Parameters<typeof getUpstreamSessionTool>[0],
  options?: Parameters<typeof getUpstreamSessionTool>[1] &
    Pick<SessionsSendToolOptions, "isAcpTurnActive" | "readAcpSessionMetaAsync">,
) {
  return name === "sessions_send"
    ? createSessionsSendTool({
        ...options,
        config: options?.config ?? TEST_CONFIG,
        callGateway: callGatewayMock,
      })
    : getUpstreamSessionTool(name, options);
}

async function seedSession(
  sessionKey: string,
  sessionId = sessionKey,
  fields: Parameters<typeof upsertSessionEntryCore>[1] = {},
  storePath?: string,
) {
  await upsertSessionEntryCore(
    { agentId: parseAgentSessionKey(sessionKey)!.agentId, sessionKey, storePath },
    { sessionId, updatedAt: 1, ...fields },
  );
}

const mainStorePath = () => resolveSessionStorePathCore(undefined, { agentId: "main" });

/**
 * Registers the parent-owned ACP child row that sessions_send actually reads. The tool resolves
 * the target through the gateway session store, so ownership must be seeded there rather than
 * through the announce-delivery entry reader.
 */
async function registerParentOwnedAcpChild(params: {
  targetKey: string;
  sessionId: string;
  parentKey: string;
  acp?: SessionAcpMeta;
}) {
  const parentSessionId = `${params.parentKey}:session`;
  await seedSession(params.parentKey, parentSessionId);
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: params.targetKey, storePath: mainStorePath() },
    {
      sessionId: params.sessionId,
      updatedAt: 1,
      spawnedBy: params.parentKey,
      parentSessionKey: params.parentKey,
      parentSessionId,
      ...(params.acp ? { acp: params.acp } : {}),
    },
  );
}

type SessionsSendDetails = {
  status?: string;
  runId?: string;
  reply?: string;
  error?: string;
  sentBeforeError?: boolean;
  sessionKey?: string;
  targetDisposition?: string;
  delivery?: {
    status?: string;
    mode?: string;
  };
};

function agentParams(call: { params?: unknown }) {
  return (call.params ?? {}) as Partial<Static<typeof AgentParamsSchema>>;
}

function sessionsSendDetails(details: unknown): SessionsSendDetails {
  return details as SessionsSendDetails;
}

function durableOneShotAcpMeta(
  overrides: Partial<SessionAcpMeta> = {},
  identityOverrides: Partial<NonNullable<SessionAcpMeta["identity"]>> = {},
): SessionAcpMeta {
  return {
    backend: "acpx",
    agent: "opencode",
    runtimeSessionName: "agent:main:subagent:acp-child:runtime",
    mode: "oneshot",
    state: "idle",
    lastActivityAt: 1,
    identity: {
      state: "resolved",
      source: "status",
      acpxRecordId: "record-1",
      acpxSessionId: "acp-session-1",
      sessionResumeSupported: true,
      sessionResumeReady: true,
      lastUpdatedAt: 1,
      ...identityOverrides,
    },
    ...overrides,
  };
}

describe("sessions tools parent completion and ACP follow-up", () => {
  beforeEach(async () => {
    resetGatewayWorkAdmission();
    resetAcpActiveTurnsForTests();
    callGatewayMock.mockClear();
    embeddedRunsTesting.resetActiveEmbeddedRuns();
    installMessagingTestRegistry();
    setRuntimeConfigSnapshot(TEST_CONFIG);
    await seedSession(mainKey);
  });
  afterEach(() =>
    runQaGatewayFixture(
      () => continuations.settle(),
      resetGatewayWorkAdmission,
      resetAcpActiveTurnsForTests,
      resetSystemEventsForTest,
      resetAdjustedParamsByToolCallIdForTests,
      clearRuntimeConfigSnapshot,
    ),
  );
  afterAll(() =>
    runQaGatewayFixture(
      () => continuations.settle(),
      () => continuations.restore(),
    ),
  );

  it("sessions_send skips duplicate A2A delivery for waited parent-owned native subagents", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const requesterKey = "agent:main:discord:direct:parent";
    const targetKey = "agent:main:subagent:child";
    const parentSessionId = "native-parent-session";
    await seedSession(requesterKey, parentSessionId);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: targetKey },
      {
        sessionId: "child-session",
        updatedAt: 1,
        spawnedBy: requesterKey,
        parentSessionId,
      },
    );
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        const params = agentParams(request);
        const runId = params.idempotencyKey;
        if (!runId || !params.sessionKey) {
          throw new Error("Native child fixture requires its dispatched run and session.");
        }
        const followup = readFollowupRequest(runId, params.sessionKey);
        if (!followup) {
          throw new Error("Native child fixture requires current requester custody.");
        }
        const completion = SessionFollowupCompletion.bind(followup);
        followup.completion = completion;
        try {
          completion.markAccepted(runId);
          await completion.settle(runId, {
            status: "ok",
            replyText: "child reply",
            terminalReply: { disposition: "visible", text: "child reply" },
          });
          completion.finishExecution(runId);
          return { runId, status: "accepted", acceptedAt: 2000 };
        } catch (error) {
          completion.close(error);
          throw error;
        }
      }
      if (request.method === "agent.wait") {
        throw new Error("Native child reply must come from retained completion custody.");
      }
      return {};
    });

    const tool = getSessionTool("sessions_send", {
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    });

    const waited = await withPluginRuntimeGatewayRequestScope(
      createSessionsSendGatewayScope(),
      () =>
        withGatewayToolCallerIdentity(createSessionsSendTestCaller(requesterKey), () =>
          tool.execute("call-parent-owned-native-subagent", {
            sessionKey: targetKey,
            message: "ping",
            timeoutSeconds: 1,
          }),
        ),
    );

    const waitedDetails = sessionsSendDetails(waited.details);
    expect(waitedDetails.status).toBe("ok");
    expect(waitedDetails.reply).toBe("child reply");
    expect(waitedDetails.delivery?.status).toBe("skipped");
    expect(calls.filter((call) => call.method === "agent")).toHaveLength(1);
    expect(calls.some((call) => call.method === "agent.wait")).toBe(false);
    const replyPromptAgentCalls = calls.filter(
      (call) =>
        call.method === "agent" &&
        typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
        (call.params as { extraSystemPrompt?: string }).extraSystemPrompt?.includes(
          "Agent-to-agent reply step",
        ),
    );
    expect(replyPromptAgentCalls).toStrictEqual([]);
    expect(calls.some((call) => call.method === "send")).toBe(false);
  });

  it("sessions_send annotates an interrupted native child when async ACP metadata is absent", async () => {
    const requesterKey = "agent:main:discord:direct:interrupted-parent";
    const targetKey = "agent:main:subagent:interrupted-child";
    const parentSessionId = "interrupted-parent-session";
    await seedSession(requesterKey, parentSessionId);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: targetKey },
      {
        sessionId: "interrupted-child-session",
        updatedAt: 1,
        spawnedBy: requesterKey,
        parentSessionId,
        status: "interrupted",
      },
    );
    const readAcpSessionMetaAsync = vi.fn(async () => undefined);
    mockAcceptedChildFollowup();

    const tool = getSessionTool("sessions_send", {
      agentSessionKey: requesterKey,
      agentChannel: "discord",
      readAcpSessionMetaAsync,
    });
    const result = await withPluginRuntimeGatewayRequestScope(
      createSessionsSendGatewayScope(),
      () =>
        withGatewayToolCallerIdentity(createSessionsSendTestCaller(requesterKey), () =>
          tool.execute("interrupted-followup", {
            sessionKey: targetKey,
            message: "continue safely",
            timeoutSeconds: 0,
          }),
        ),
    );

    expect(sessionsSendDetails(result.details).status).toBe("accepted");
    expect(readAcpSessionMetaAsync).toHaveBeenCalledOnce();
    const dispatch = callGatewayMock.mock.calls.find(([request]) => request.method === "agent");
    expect(agentParams(dispatch?.[0] ?? {}).message).toContain(
      "Your previous turn was interrupted by a gateway restart",
    );
    expect(agentParams(dispatch?.[0] ?? {}).message).toContain("continue safely");
  });

  it("sessions_send dispatches a verified completed parent-owned ACP one-shot and defers delivery to task completion", async () => {
    resetAcpActiveTurnsForTests();
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const requesterKey = "agent:main:discord:direct:parent";
    const targetKey = "agent:main:subagent:acp-followup-child";
    const acp = durableOneShotAcpMeta({ state: "running" });
    await registerParentOwnedAcpChild({
      targetKey,
      sessionId: "child-session",
      parentKey: requesterKey,
      acp,
    });
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        const admissionId = (request.params as { idempotencyKey?: string } | undefined)
          ?.idempotencyKey;
        markAcpTurnActive(targetKey, admissionId);
        return { runId: "run-acp-followup", status: "accepted", acceptedAt: 2_000 };
      }
      return {};
    });

    const tool = getSessionTool("sessions_send", {
      agentSessionKey: requesterKey,
      agentChannel: "discord",
      isAcpTurnActive: () => false,
      readAcpSessionMetaAsync: async () => acp,
    });
    const result = await tool.execute("call-acp-followup", {
      sessionKey: targetKey,
      message: "continue the same conversation",
      timeoutSeconds: 15,
    });

    const details = sessionsSendDetails(result.details);
    expect(details).toMatchObject({
      runId: "run-acp-followup",
      status: "accepted",
      sessionKey: targetKey,
      delivery: { status: "skipped" },
    });
    const dispatches = calls.filter((call) => call.method === "agent");
    expect(dispatches).toHaveLength(1);
    expect(agentParams(dispatches[0]!)).toMatchObject({
      sessionKey: targetKey,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: requesterKey,
        sourceChannel: "discord",
        sourceTool: "sessions_send",
      },
    });
    expect(calls.some((call) => call.method === "chat.history")).toBe(false);
    expect(calls.some((call) => call.method === "agent.wait")).toBe(false);
    expect(calls.some((call) => call.method === "send")).toBe(false);
    clearAcpTurnActive(targetKey);
    resetAcpActiveTurnsForTests();
  });

  it("sessions_send atomically rejects a concurrent owner follow-up before the first ACP dispatch becomes active", async () => {
    resetAcpActiveTurnsForTests();
    const requesterKey = "agent:main:discord:direct:atomic-parent";
    const targetKey = "agent:main:subagent:atomic-acp-child";
    const acp = durableOneShotAcpMeta();
    await registerParentOwnedAcpChild({
      targetKey,
      sessionId: "atomic-child-session",
      parentKey: requesterKey,
      acp,
    });
    let releaseFirstDispatch!: () => void;
    const firstDispatchHeld = new Promise<void>((resolve) => {
      releaseFirstDispatch = resolve;
    });
    let notifyFirstDispatch!: () => void;
    const firstDispatchEntered = new Promise<void>((resolve) => {
      notifyFirstDispatch = resolve;
    });
    let agentDispatches = 0;
    let firstAdmissionId = "";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: { idempotencyKey?: string } };
      if (request.method !== "agent") {
        return {};
      }
      agentDispatches += 1;
      firstAdmissionId = request.params?.idempotencyKey ?? "";
      notifyFirstDispatch();
      await firstDispatchHeld;
      markAcpTurnActive(targetKey, firstAdmissionId);
      return { runId: firstAdmissionId, status: "accepted", acceptedAt: 2_000 };
    });
    const tool = getSessionTool("sessions_send", {
      agentSessionKey: requesterKey,
      agentChannel: "discord",
      readAcpSessionMetaAsync: async () => acp,
    });

    const firstResultPromise = tool.execute("call-atomic-first", {
      sessionKey: targetKey,
      message: "first follow-up",
      timeoutSeconds: 15,
    });
    await firstDispatchEntered;
    const secondResult = await tool.execute("call-atomic-second", {
      sessionKey: targetKey,
      message: "second follow-up",
      timeoutSeconds: 15,
    });

    expect(sessionsSendDetails(secondResult.details)).toMatchObject({ status: "error" });
    expect(sessionsSendDetails(secondResult.details).error).toContain(
      "another follow-up is being admitted",
    );
    expect(agentDispatches).toBe(1);
    releaseFirstDispatch();
    expect(sessionsSendDetails((await firstResultPromise).details)).toMatchObject({
      status: "accepted",
    });
    clearAcpTurnActive(targetKey);
    resetAcpActiveTurnsForTests();
  });

  it("sessions_send releases a failed ACP follow-up admission so its owner can retry", async () => {
    resetAcpActiveTurnsForTests();
    const requesterKey = "agent:main:discord:direct:retry-parent";
    const targetKey = "agent:main:subagent:retry-acp-child";
    const acp = durableOneShotAcpMeta();
    await registerParentOwnedAcpChild({
      targetKey,
      sessionId: "retry-child-session",
      parentKey: requesterKey,
      acp,
    });
    let agentDispatches = 0;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: { idempotencyKey?: string } };
      if (request.method !== "agent") {
        return {};
      }
      agentDispatches += 1;
      if (agentDispatches === 1) {
        throw new Error("dispatch rejected");
      }
      const admissionId = request.params?.idempotencyKey ?? "";
      markAcpTurnActive(targetKey, admissionId);
      return { runId: admissionId, status: "accepted", acceptedAt: 2_000 };
    });
    const tool = getSessionTool("sessions_send", {
      agentSessionKey: requesterKey,
      agentChannel: "discord",
      readAcpSessionMetaAsync: async () => acp,
    });

    const failed = await tool.execute("call-retry-first", {
      sessionKey: targetKey,
      message: "first attempt",
      timeoutSeconds: 15,
    });
    expect(sessionsSendDetails(failed.details)).toMatchObject({
      status: "error",
      error: "dispatch rejected",
    });

    const retried = await tool.execute("call-retry-second", {
      sessionKey: targetKey,
      message: "retry",
      timeoutSeconds: 15,
    });
    expect(sessionsSendDetails(retried.details)).toMatchObject({ status: "accepted" });
    expect(agentDispatches).toBe(2);
    clearAcpTurnActive(targetKey);
    resetAcpActiveTurnsForTests();
  });

  it("sessions_send rejects a live parent-owned ACP one-shot before transcript reads or dispatch", async () => {
    const requesterKey = "agent:main:discord:direct:parent";
    const targetKey = "agent:main:subagent:acp-live-turn-child";
    const acp = durableOneShotAcpMeta();
    await registerParentOwnedAcpChild({
      targetKey,
      sessionId: "child-session",
      parentKey: requesterKey,
      acp,
    });
    const tool = getSessionTool("sessions_send", {
      agentSessionKey: requesterKey,
      agentChannel: "discord",
      isAcpTurnActive: (sessionKey) => sessionKey === targetKey,
      readAcpSessionMetaAsync: async () => acp,
    });

    const result = await tool.execute("call-active-acp", {
      sessionKey: targetKey,
      message: "too soon",
      timeoutSeconds: 15,
    });

    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("error");
    expect(details.error).toContain("current turn is active");
    expect(callGatewayMock.mock.calls.some(([call]) => call.method === "chat.history")).toBe(false);
    expect(callGatewayMock.mock.calls.some(([call]) => call.method === "agent")).toBe(false);
  });

  it("sessions_send fails closed for its parent-owned ACP child when durable metadata is missing", async () => {
    const requesterKey = "agent:main:discord:direct:task-owner";
    const targetKey = "agent:main:acp:task-owned-acp-child";
    await registerParentOwnedAcpChild({
      targetKey,
      sessionId: "task-owned-child-session",
      parentKey: requesterKey,
    });
    const tool = getSessionTool("sessions_send", {
      agentSessionKey: requesterKey,
      agentChannel: "discord",
      readAcpSessionMetaAsync: async () => undefined,
    });

    const result = await tool.execute("call-task-owned-missing-meta", {
      sessionKey: targetKey,
      message: "continue",
      timeoutSeconds: 15,
    });

    expect(sessionsSendDetails(result.details)).toMatchObject({
      status: "error",
      sessionKey: targetKey,
    });
    expect(sessionsSendDetails(result.details).error).toContain(
      "authoritative durable ACP metadata is missing",
    );
    expect(callGatewayMock.mock.calls.some(([call]) => call.method === "chat.history")).toBe(false);
    expect(callGatewayMock.mock.calls.some(([call]) => call.method === "agent")).toBe(false);
  });

  it.each([
    {
      name: "unsupported metadata",
      meta: durableOneShotAcpMeta({}, { sessionResumeSupported: false }),
    },
    {
      name: "unresolved metadata",
      meta: durableOneShotAcpMeta({}, { state: "pending" }),
    },
    {
      name: "not-ready metadata",
      meta: durableOneShotAcpMeta({}, { sessionResumeReady: false }),
    },
    { name: "legacy metadata", meta: durableOneShotAcpMeta({ identity: undefined }) },
    {
      name: "metadata without a stable resume ID",
      meta: durableOneShotAcpMeta({}, { acpxSessionId: undefined, agentSessionId: undefined }),
    },
    { name: "metadata without a backend", meta: durableOneShotAcpMeta({ backend: "" }) },
  ])(
    "sessions_send rejects parent-owned ACP one-shots with $name before dispatch",
    async ({ meta }) => {
      const requesterKey = "agent:main:discord:direct:parent";
      const targetKey = "agent:main:subagent:acp-unverified-child";
      // Upstream persistence no longer embeds ACP metadata on the store entry, so the
      // authoritative meta is whatever readAcpSessionMetaAsync resolves for this case.
      await registerParentOwnedAcpChild({
        targetKey,
        sessionId: "child-session",
        parentKey: requesterKey,
      });
      const tool = getSessionTool("sessions_send", {
        agentSessionKey: requesterKey,
        agentChannel: "discord",
        isAcpTurnActive: () => false,
        readAcpSessionMetaAsync: async () => meta,
      });

      const result = await tool.execute("call-unverified-acp", {
        sessionKey: targetKey,
        message: "continue",
        timeoutSeconds: 15,
      });

      const details = sessionsSendDetails(result.details);
      expect(details.status).toBe("error");
      expect(details.error).toContain("not a verified completed resumable session");
      expect(callGatewayMock.mock.calls.some(([call]) => call.method === "chat.history")).toBe(
        false,
      );
      expect(callGatewayMock.mock.calls.some(([call]) => call.method === "agent")).toBe(false);
    },
  );

  it("sessions_send rejects mismatched parent-owned ACP backend metadata before dispatch", async () => {
    const requesterKey = "agent:main:discord:direct:parent";
    const targetKey = "agent:main:subagent:acp-backend-mismatch-child";
    const routeAcp = durableOneShotAcpMeta({ backend: "other-backend" });
    const durableAcp = durableOneShotAcpMeta();
    await registerParentOwnedAcpChild({
      targetKey,
      sessionId: "child-session",
      parentKey: requesterKey,
      acp: routeAcp,
    });
    const tool = getSessionTool("sessions_send", {
      agentSessionKey: requesterKey,
      agentChannel: "discord",
      isAcpTurnActive: () => false,
      readAcpSessionMetaAsync: async () => durableAcp,
    });

    const result = await tool.execute("call-wrong-backend-acp", {
      sessionKey: targetKey,
      message: "continue",
      timeoutSeconds: 15,
    });

    expect(sessionsSendDetails(result.details).status).toBe("error");
    expect(callGatewayMock.mock.calls.some(([call]) => call.method === "agent")).toBe(false);
  });

  it("sessions_send leaves an unrelated authorized sender on A2A when an ACP task belongs to another owner and metadata is absent", async () => {
    const ownerKey = "agent:main:discord:direct:owner";
    const requesterKey = "agent:main:discord:direct:peer";
    const targetKey = "agent:main:acp:acp-unrelated-child";
    await seedSession(requesterKey);
    await registerParentOwnedAcpChild({
      targetKey,
      sessionId: "child-session",
      parentKey: ownerKey,
    });
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-unrelated-acp", status: "accepted", acceptedAt: 2_000 };
      }
      return {};
    });
    const tool = getSessionTool("sessions_send", {
      agentSessionKey: requesterKey,
      agentChannel: "discord",
      isAcpTurnActive: () => true,
      readAcpSessionMetaAsync: async () => undefined,
    });

    const result = await tool.execute("call-unrelated-acp", {
      sessionKey: targetKey,
      message: "peer message",
      timeoutSeconds: 0,
    });

    expect(sessionsSendDetails(result.details)).toMatchObject({
      status: "accepted",
      delivery: { status: "pending" },
    });
    expect(callGatewayMock.mock.calls.filter(([call]) => call.method === "agent")).toHaveLength(1);
  });
});
