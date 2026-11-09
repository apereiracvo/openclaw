import path from "node:path";
import { expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { runReplyAgent } from "./agent-runner-run.js";
import type { runPreparedReply } from "./get-reply-run.js";
import { finalizeInboundContextForSdk } from "./inbound-context.js";
import { createModelSelectionStateFixture } from "./model-selection.test-support.js";
import { prepareReplyConversation } from "./prompt-session-context.js";

const replyRunTempDirs = createTempDirTracker();

export function resetPreparedReplySessionStore() {
  vi.mocked(resolveSessionStorePathCore).mockReturnValue(
    path.join(replyRunTempDirs.make("openclaw-reply-run-"), "session-store"),
  );
}

const activePreparedFixtures: ReturnType<typeof createReplyOperation>[] = [];

export function activatePreparedRun(sessionKey = "session-key") {
  const operation = createReplyOperation({
    sessionKey,
    sessionId: "active-session",
    resetTriggered: false,
  });
  operation.setPhase("running");
  activePreparedFixtures.push(operation);
  return operation;
}

export async function cleanupPreparedReplyFixtures() {
  for (const operation of activePreparedFixtures.splice(0)) {
    operation.complete();
    await operation.ownerSettlement;
  }
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  replyRunTempDirs.cleanup();
}

export function jsonContext(label: string, value: unknown) {
  return [label, "```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

export function createInboundBody<T extends string>(body: T) {
  return { Body: body, RawBody: body, CommandBody: body };
}

export function createSessionBody<T extends string>(body: T) {
  return { Body: body, BodyStripped: body };
}

export function createProviderSurface<T extends string>(provider: T) {
  return { Provider: provider, Surface: provider };
}

export function createPreparedReplyTurn(
  body: string,
  common: Parameters<typeof runPreparedReply>[0]["ctx"],
  session: Partial<Parameters<typeof runPreparedReply>[0]["sessionCtx"]> = {},
  inbound: Partial<Parameters<typeof runPreparedReply>[0]["ctx"]> = {},
) {
  return {
    ctx: { ...createInboundBody(body), ...common, ...inbound },
    sessionCtx: { ...createSessionBody(body), ...common, ...session },
  };
}

export function createTelegramGroupSession(): SessionEntry {
  return {
    sessionId: "session-telegram-group",
    updatedAt: 1,
    systemSent: true,
    chatType: "group",
    delivery: normalizeSessionDeliveryState({
      context: { channel: "telegram", to: "-100123" },
      origin: { provider: "telegram", surface: "telegram", chatType: "group", to: "-100123" },
    }),
  };
}

export function createInboundTurn<
  TBody extends string,
  TProvider extends string,
  TChatType extends string,
>(body: TBody, provider: TProvider, chatType: TChatType) {
  return { ...createInboundBody(body), ...createProviderSurface(provider), ChatType: chatType };
}

export function createSessionTurn<
  TBody extends string,
  TProvider extends string,
  TChatType extends string,
>(body: TBody, provider: TProvider, chatType: TChatType) {
  return { ...createSessionBody(body), ...createProviderSurface(provider), ChatType: chatType };
}

export function baseParams(
  overrides: Partial<Parameters<typeof runPreparedReply>[0]> = {},
): Parameters<typeof runPreparedReply>[0] {
  const route = {
    ThreadHistoryBody: "Earlier message in this thread",
    OriginatingChannel: "slack",
    OriginatingTo: "C123",
    ChatType: "group",
  };
  const defaults = {
    ctx: { ...createInboundBody(""), ...route },
    sessionCtx: {
      ...createSessionBody(""),
      ...route,
      media: [{ path: "/tmp/input.png" }],
      Provider: "slack",
    },
    cfg: { session: {}, channels: {}, agents: { defaults: {} } },
    agentId: "default",
    agentDir: "/tmp/agent",
    agentCfg: {},
    sessionCfg: {},
    commandAuthorized: true,
    command: {
      surface: "slack",
      channel: "slack",
      isAuthorizedSender: true,
      abortKey: "session-key",
      ownerList: [],
      senderIsOwner: false,
      rawBodyNormalized: "",
      commandBodyNormalized: "",
    } as never,
    commandSource: "",
    allowTextCommands: true,
    directives: { hasThinkDirective: false, thinkLevel: undefined } as never,
    defaultActivation: "always",
    resolvedThinkLevel: "high",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    elevatedEnabled: false,
    elevatedAllowed: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    modelState: {
      resolveDefaultThinkingLevel: async () => "medium",
      resolveThinkingCatalog: async () => [],
    } as never,
    provider: "anthropic",
    model: "claude-opus-4-1",
    typing: {
      onReplyStart: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn(),
    } as never,
    defaultModel: "claude-opus-4-1",
    timeoutMs: 30_000,
    isNewSession: true,
    resetTriggered: false,
    systemSent: true,
    sessionKey: "session-key",
    workspaceDir: "/tmp/workspace",
    abortedLastRun: false,
  };
  const ctx: Parameters<typeof runPreparedReply>[0]["ctx"] = overrides.ctx ?? defaults.ctx;
  const sessionCtx = overrides.sessionCtx ?? defaults.sessionCtx;
  const sessionKey = overrides.sessionKey ?? ctx.SessionKey ?? defaults.sessionKey;
  const agentId =
    overrides.agentId ?? parseAgentSessionKey(sessionKey)?.agentId ?? defaults.agentId;
  const resolveTestCanonicalText = (value: Record<string, unknown>) => {
    const { commandText, agentText, rawText } = finalizeInboundContextForSdk({ ...value });
    return { commandText, agentText, rawText };
  };
  const sessionText = resolveTestCanonicalText(sessionCtx);
  return {
    ...defaults,
    ...overrides,
    sessionKey,
    agentId,
    conversation:
      overrides.conversation ??
      prepareReplyConversation({
        ctx: sessionCtx,
        sessionEntry: overrides.sessionStore?.[sessionKey] ?? overrides.sessionEntry,
      }),
    ctx: { ...ctx, ...resolveTestCanonicalText(ctx) },
    sessionCtx: {
      ...sessionCtx,
      ...sessionText,
      agentText:
        typeof sessionCtx.BodyStripped === "string"
          ? sessionCtx.BodyStripped
          : sessionText.agentText,
    },
  } as Parameters<typeof runPreparedReply>[0];
}

export function ownerParams(): Parameters<typeof runPreparedReply>[0] {
  const params = baseParams();
  params.command.senderIsOwner = true;
  return params;
}

export function nonReasoningModelState(): Parameters<typeof runPreparedReply>[0]["modelState"] {
  return {
    ...createModelSelectionStateFixture({ agentCfg: {}, provider: "openai", model: "chat-latest" }),
    resolveDefaultThinkingLevel: async () => "high",
    resolveThinkingCatalog: async () => [
      { provider: "openai", id: "chat-latest", name: "Chat Latest", reasoning: false },
    ],
    allowedModelCatalog: [{ provider: "openai", id: "chat-latest", name: "Chat Latest" }],
  };
}

export function preparedTarget(sessionId: string) {
  return captureSessionTarget({
    storeScope: resolveSessionStorePathCore(undefined, { agentId: "default" }),
    sessionKey: "session-key",
    incarnation: sessionId,
    agentId: "default",
  });
}

export function registerPreparedReplyWorkspaceCases({
  runPrepared,
  requireRunReplyAgentCall,
}: {
  runPrepared: (
    overrides?: Partial<Parameters<typeof runPreparedReply>[0]>,
  ) => ReturnType<typeof runPreparedReply>;
  requireRunReplyAgentCall: () => Parameters<typeof runReplyAgent>[0];
}) {
  it.each([
    { name: "initial", storedCwd: undefined, expected: "/tmp/session-repo" },
    { name: "replaced", storedCwd: "/tmp/current-repo", expected: "/tmp/current-repo" },
    { name: "cleared", storedCwd: null, expected: "/tmp/agent-repo" },
  ])("uses the $name admitted session cwd for execution", async ({ storedCwd, expected }) => {
    const sessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      spawnedCwd: "/tmp/session-repo",
      spawnedBy: "agent:default:main",
    };
    await runPrepared({
      cfg: {
        agents: {
          defaults: { cwd: "/tmp/default-repo" },
          entries: { default: { cwd: "/tmp/agent-repo" } },
        },
      },
      sessionEntry,
      sessionStore:
        storedCwd !== undefined
          ? { "session-key": { ...sessionEntry, spawnedCwd: storedCwd ?? undefined } }
          : undefined,
    });

    expect(requireRunReplyAgentCall().followupRun.run.cwd).toBe(expected);
  });

  // A project root may only layer project instructions when sessions.create
  // durably proved lineage plus a canonicalized selected project. Every other
  // combination either lacks a project, lacks that provenance, or names a managed
  // worktree checkout rather than a registered project root.
  //
  // A spawned child executes from its creation-validated `spawnedCwd` as the run
  // workspace (#162308), so `run.workspaceDir` follows that cwd. The agent's
  // canonical bootstrap identity still resolves from the target agent workspace
  // (the embedded runner passes it as `bootstrapWorkspaceDir`), so the provenance
  // gate below decides the project-AGENTS layer independently of the run workspace.
  it.each([
    {
      name: "spawned project child",
      spawnedBy: "agent:default:main",
      projectId: "project-1",
      spawnedCwd: "/tmp/project-repo",
      worktree: undefined,
      // The child runs from the selected project root; the layer is the same root.
      expectedWorkspaceDir: "/tmp/project-repo",
      expected: "/tmp/project-repo",
    },
    {
      name: "spawned cwd without a registered project",
      spawnedBy: "agent:default:main",
      projectId: undefined,
      spawnedCwd: "/tmp/session-repo",
      worktree: undefined,
      // An explicit cwd runs the child in place but carries no project provenance.
      expectedWorkspaceDir: "/tmp/session-repo",
      expected: undefined,
    },
    {
      name: "unmarked dashboard project session",
      spawnedBy: undefined,
      projectId: "project-1",
      spawnedCwd: "/tmp/project-repo",
      worktree: undefined,
      // A dashboard project session already runs from the project root, so its
      // AGENTS.md is canonical bootstrap and must not layer a second time.
      expectedWorkspaceDir: "/tmp/project-repo",
      expected: undefined,
    },
    {
      // A worktree child carries the same lineage, project, and spawnedCwd triple,
      // but its cwd is a checkout that may sit at or below the repo root, so it is
      // never the registered project root this layer claims to be.
      name: "project worktree child at its checkout root",
      spawnedBy: "agent:default:main",
      projectId: "project-1",
      spawnedCwd: "/tmp/worktrees/repo",
      worktree: { id: "wt-1", branch: "feature", repoRoot: "/tmp/repos/project-repo" },
      expectedWorkspaceDir: "/tmp/worktrees/repo",
      expected: undefined,
    },
    {
      // session-worktree-preparation resolves a nested source workspace against
      // the checkout, so a naive gate would layer packages/AGENTS.md as a project
      // root instruction file.
      name: "project worktree child with a nested spawned cwd",
      spawnedBy: "agent:default:main",
      projectId: "project-1",
      spawnedCwd: "/tmp/worktrees/repo/packages/app",
      worktree: { id: "wt-1", branch: "feature", repoRoot: "/tmp/repos/project-repo" },
      expectedWorkspaceDir: "/tmp/worktrees/repo/packages/app",
      expected: undefined,
    },
  ])("resolves the project instruction root for a $name", async (row) => {
    await runPrepared({
      cfg: { agents: { defaults: { cwd: "/tmp/default-repo" } } },
      workspaceDir: "/tmp/agent-workspace",
      sessionEntry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        spawnedBy: row.spawnedBy,
        projectId: row.projectId,
        spawnedCwd: row.spawnedCwd,
        worktree: row.worktree,
      },
    });
    const run = requireRunReplyAgentCall().followupRun.run;
    expect(run.workspaceDir).toBe(row.expectedWorkspaceDir);
    expect(run.executionAgentsRootDir).toBe(row.expected);
  });
}

export function expectTurnText(call: Parameters<typeof runReplyAgent>[0], text: string) {
  expect(call).toMatchObject({
    commandBody: text,
    transcriptCommandBody: text,
    followupRun: { prompt: text, transcriptPrompt: text },
  });
}
