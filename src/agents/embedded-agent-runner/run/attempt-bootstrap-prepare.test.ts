import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import type { AgentBootstrapHookContext } from "../../../hooks/internal-hooks.js";
import { registerInternalHook, unregisterInternalHook } from "../../../hooks/internal-hooks.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE } from "../../bootstrap-files.js";
import { SessionManager } from "../../sessions/session-manager.js";
import * as workspaceBootstrapRead from "../../workspace-bootstrap-read.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../../workspace-bootstrap-read.js";
import { loadWorkspaceBootstrapFiles, DEFAULT_AGENTS_FILENAME } from "../../workspace.js";
import { prepareEmbeddedAttemptBootstrap } from "./attempt-bootstrap-prepare.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

afterEach(() => vi.restoreAllMocks());

const addedTempDirs = useAutoCleanupTempDirTracker(afterEach);
const contextFile = (filePath: string, content: unknown) =>
  expect.objectContaining({ path: filePath, content });

async function makeWorkspace(label: string, files: Record<string, string> = {}): Promise<string> {
  const workspace = await fs.realpath(addedTempDirs.make(`openclaw-${label}-`));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(workspace, name), content);
  }
  return workspace;
}

describe("prepareEmbeddedAttemptBootstrap", () => {
  async function prepare(
    agentWorkspace: string,
    sessionWorkspace = agentWorkspace,
    options: {
      contextInjection?: "always" | "continuation-skip" | "never";
      effectiveWorkspace?: string;
      isRawModelRun?: boolean;
      attempt?: Partial<EmbeddedRunAttemptParams>;
    } = {},
  ) {
    const defaults = {
      workspace: agentWorkspace,
      ...(options.contextInjection ? { contextInjection: options.contextInjection } : {}),
    };
    return await prepareEmbeddedAttemptBootstrap({
      attempt: {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        trigger: "user",
        bootstrapWorkspaceDir: agentWorkspace,
        isCanonicalWorkspace: agentWorkspace === sessionWorkspace,
        config: { agents: { defaults } },
        ...options.attempt,
      } as EmbeddedRunAttemptParams,
      setup: createAttemptSetupFixture({
        effectiveWorkspace: options.effectiveWorkspace ?? sessionWorkspace,
        resolvedWorkspace: sessionWorkspace,
      }),
      hasReadTool: true,
      isRawModelRun: options.isRawModelRun ?? false,
    });
  }

  it.each([
    ["always", false, true, "default", "full", "none", false, true],
    ["always", true, true, "default", "full", "full", true, true],
    ["continuation-skip", false, true, "default", "full", "none", true, true],
    ["continuation-skip", false, true, "cron", "full", "none", false, true],
    ["continuation-skip", false, true, "default", "lightweight", "none", false, false],
    ["continuation-skip", true, false, "default", "full", "limited", false, true],
    ["never", true, true, "default", "full", "full", false, false],
  ] as const)(
    "completion follows delivered context: %s / pending=%s / canonical=%s / %s / %s",
    async (mode, pending, canonical, runKind, contextMode, bootstrapMode, completion, injected) => {
      const workspace = await makeWorkspace("completion-workspace", {
        "AGENTS.md": "Workspace instructions",
        ...(pending ? { "BOOTSTRAP.md": "Finish the workspace setup." } : {}),
      });
      const result = await prepare(workspace, workspace, {
        contextInjection: mode,
        attempt: {
          isCanonicalWorkspace: canonical,
          bootstrapContextRunKind: runKind,
          bootstrapContextMode: contextMode,
        },
      });

      expect(result).toMatchObject({
        bootstrapMode,
        shouldRecordCompletedBootstrapTurn: completion,
      });
      expect(result.contextFiles.some((file) => file.content === "Workspace instructions")).toBe(
        injected,
      );
      if (!injected) {
        expect(result.contextFiles).toEqual([]);
        expect(result.bootstrapInjectionStats).toEqual([]);
      }
    },
  );

  it("skips injection for a completed limited-bootstrap continuation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const workspace = state.workspaceDir;
      await fs.writeFile(path.join(workspace, "AGENTS.md"), "Already delivered instructions");
      await fs.writeFile(path.join(workspace, "BOOTSTRAP.md"), "Finish the workspace setup.");
      const sessionTarget = {
        agentId: "main",
        sessionId: "completed-bootstrap-session",
        sessionKey: "agent:main:completed-bootstrap-session",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      await upsertSessionEntryCore(sessionTarget, {
        sessionId: sessionTarget.sessionId,
        updatedAt: Date.now(),
      });
      const sessionManager = await SessionManager.openAsync(sessionTarget, workspace);
      await sessionManager.appendCustomEntryAsync(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, {
        timestamp: 1,
      });

      const result = await prepare(workspace, workspace, {
        contextInjection: "continuation-skip",
        attempt: {
          sessionId: sessionTarget.sessionId,
          sessionKey: sessionTarget.sessionKey,
          sessionTarget,
          isCanonicalWorkspace: false,
        },
      });

      expect(result).toMatchObject({
        bootstrapMode: "limited",
        contextFiles: [],
        bootstrapInjectionStats: [],
        shouldRecordCompletedBootstrapTurn: false,
      });
    });
  });

  it.each(["raw", "settled"] as const)(
    "withholds ambient context for %s model work",
    async (kind) => {
      const workspace = await makeWorkspace("isolated-workspace", {
        "AGENTS.md": "Ambient instructions must stay out",
      });
      const result = await prepare(workspace, workspace, {
        isRawModelRun: kind === "raw",
        attempt: kind === "settled" ? { operation: "settled-tool-finalization" } : {},
      });

      expect(result).toMatchObject({
        contextFiles: [],
        bootstrapInjectionStats: [],
        shouldRecordCompletedBootstrapTurn: false,
      });
    },
  );

  it("layers execution project instructions after agent bootstrap files", async () => {
    const agentWorkspace = await makeWorkspace("agent-workspace", {
      "AGENTS.md": "Canonical agent instructions",
      "SOUL.md": "Canonical agent soul",
    });
    const sessionWorkspace = await makeWorkspace("session-workspace", {
      "AGENTS.md": "Execution project context",
      "SOUL.md": "Execution soul must stay private",
    });

    const result = await prepare(agentWorkspace, sessionWorkspace, {
      attempt: { executionAgentsRootDir: sessionWorkspace },
    });
    const executionAgentsIndex = result.contextFiles.findIndex(
      (file) => file.path === path.join(sessionWorkspace, "AGENTS.md"),
    );
    const lastAgentFileIndex = result.contextFiles.findLastIndex((file) =>
      file.path.startsWith(`${agentWorkspace}${path.sep}`),
    );

    expect(executionAgentsIndex).toBeGreaterThan(lastAgentFileIndex);
    expect(
      result.bootstrapInjectionStats.filter((file) => file.name === "AGENTS.md"),
    ).toMatchObject([
      {
        path: path.join(agentWorkspace, "AGENTS.md"),
        origin: { kind: "agent-workspace", rootPath: agentWorkspace },
      },
      {
        path: path.join(sessionWorkspace, "AGENTS.md"),
        origin: { kind: "execution-project", rootPath: sessionWorkspace },
      },
    ]);
    expect(result.contextFiles[executionAgentsIndex]).toMatchObject({
      path: path.join(sessionWorkspace, "AGENTS.md"),
      content: "Execution project context",
    });
    expect(result.contextFiles).toContainEqual(
      contextFile(path.join(agentWorkspace, "SOUL.md"), "Canonical agent soul"),
    );
    expect(result.contextFiles).not.toContainEqual(
      expect.objectContaining({ path: path.join(sessionWorkspace, "SOUL.md") }),
    );
  });

  it("layers a selected project root after agent bootstrap for a spawned project child", async () => {
    // A visible sessions_spawn(projectId) child runs from its creation-validated
    // project root as the run workspace (#162308). Canonical agent bootstrap still
    // resolves from the target agent workspace, so the project root AGENTS.md has
    // to layer on top rather than disappear into the run workspace.
    const agentWorkspace = await makeWorkspace("agent-workspace");
    const projectRoot = await makeWorkspace("project-root");
    await fs.writeFile(path.join(agentWorkspace, "AGENTS.md"), "Canonical agent instructions");
    await fs.writeFile(path.join(agentWorkspace, "SOUL.md"), "Canonical agent soul");
    await fs.writeFile(path.join(projectRoot, "AGENTS.md"), "Selected project instructions");
    for (const name of ["SOUL.md", "MEMORY.md", "BOOTSTRAP.md", "USER.md"]) {
      await fs.writeFile(path.join(projectRoot, name), `Project ${name} must stay private`);
    }

    const result = await prepare(agentWorkspace, projectRoot, {
      attempt: { cwd: projectRoot, executionAgentsRootDir: projectRoot },
    });
    const projectAgentsIndex = result.contextFiles.findIndex(
      (file) => file.path === path.join(projectRoot, "AGENTS.md"),
    );
    const lastAgentFileIndex = result.contextFiles.findLastIndex((file) =>
      file.path.startsWith(`${agentWorkspace}${path.sep}`),
    );

    expect(projectAgentsIndex).toBeGreaterThan(lastAgentFileIndex);
    expect(result.contextFiles[projectAgentsIndex]).toEqual(
      expect.objectContaining({
        path: path.join(projectRoot, "AGENTS.md"),
        content: "Selected project instructions",
      }),
    );
    // Target-agent identity survives, and only the project root AGENTS.md crosses over.
    expect(result.contextFiles).toContainEqual(
      expect.objectContaining({
        path: path.join(agentWorkspace, "SOUL.md"),
        content: "Canonical agent soul",
      }),
    );
    for (const name of ["SOUL.md", "MEMORY.md", "BOOTSTRAP.md", "USER.md"]) {
      expect(result.contextFiles).not.toContainEqual(
        expect.objectContaining({ path: path.join(projectRoot, name) }),
      );
    }
    expect(result.bootstrapInjectionStats).toContainEqual(
      expect.objectContaining({
        path: path.join(projectRoot, "AGENTS.md"),
        rawChars: "Selected project instructions".length,
        injectedChars: "Selected project instructions".length,
        truncated: false,
      }),
    );
  });

  it("reads only the project AGENTS.md and never runs hooks for the project root", async () => {
    // The project layer is provenance-derived, not run-policy-derived. Resolving it
    // through the run resolver would read the project's SOUL/MEMORY/BOOTSTRAP/USER,
    // classify memory, open writable setup state, and hand every project byte to
    // registered `agent:bootstrap` handlers before discarding all of it.
    const agentWorkspace = await makeWorkspace("agent-workspace");
    const projectRoot = await makeWorkspace("project-root");
    await fs.writeFile(path.join(agentWorkspace, "AGENTS.md"), "Canonical agent instructions");
    await fs.writeFile(path.join(projectRoot, "AGENTS.md"), "Selected project instructions");
    for (const name of ["SOUL.md", "MEMORY.md", "BOOTSTRAP.md", "USER.md"]) {
      await fs.writeFile(path.join(projectRoot, name), `Project ${name} leaked to hooks`);
    }
    const hookEvents: { workspaceDir: string; contents: string }[] = [];
    const handler = (event: { context: unknown }) => {
      const context = event.context as AgentBootstrapHookContext;
      hookEvents.push({
        workspaceDir: context.workspaceDir,
        contents: context.bootstrapFiles.map((file) => file.content ?? "").join("\n"),
      });
    };
    registerInternalHook("agent:bootstrap", handler);
    try {
      const result = await prepare(agentWorkspace, agentWorkspace, {
        attempt: { cwd: projectRoot, executionAgentsRootDir: projectRoot },
      });
      expect(result.contextFiles).toContainEqual(
        expect.objectContaining({
          path: path.join(projectRoot, "AGENTS.md"),
          content: "Selected project instructions",
        }),
      );
    } finally {
      unregisterInternalHook("agent:bootstrap", handler);
    }

    // Exactly the agent-workspace pass: no second event scoped to the project root.
    expect(hookEvents.map((entry) => entry.workspaceDir)).toEqual([agentWorkspace]);
    for (const name of ["SOUL.md", "MEMORY.md", "BOOTSTRAP.md", "USER.md"]) {
      expect(hookEvents[0]!.contents).not.toContain(`Project ${name} leaked to hooks`);
    }
  });

  it("reuses unchanged canonical agent files while layering a project root", async () => {
    const agentWorkspace = await makeWorkspace("agent-workspace", {
      "AGENTS.md": "Canonical agent instructions",
    });
    const projectRoot = await makeWorkspace("project-root", {
      "AGENTS.md": "Selected project instructions",
    });
    const readFile = vi.spyOn(workspaceBootstrapRead, "readWorkspaceBootstrapFile");
    await loadWorkspaceBootstrapFiles(agentWorkspace, [DEFAULT_AGENTS_FILENAME]);
    expect(readFile).toHaveBeenCalledTimes(1);

    const result = await prepare(agentWorkspace, agentWorkspace, {
      attempt: { cwd: projectRoot, executionAgentsRootDir: projectRoot },
    });

    expect(readFile).toHaveBeenCalledTimes(2);
    expect(result.contextFiles).toContainEqual(
      contextFile(path.join(agentWorkspace, "AGENTS.md"), "Canonical agent instructions"),
    );
    expect(
      result.bootstrapInjectionStats.filter((file) => file.name === "AGENTS.md"),
    ).toMatchObject([
      {
        path: path.join(agentWorkspace, "AGENTS.md"),
        origin: { kind: "agent-workspace", rootPath: agentWorkspace },
      },
      {
        path: path.join(projectRoot, "AGENTS.md"),
        origin: { kind: "execution-project", rootPath: projectRoot },
      },
    ]);
    await loadWorkspaceBootstrapFiles(agentWorkspace, [DEFAULT_AGENTS_FILENAME]);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("does not layer a project root that is the agent workspace under another spelling", async () => {
    // sessions.create canonicalizes `spawnedCwd`, while the agent workspace keeps its
    // resolved spelling, so a symlinked parent must not produce a second AGENTS.md.
    const agentWorkspace = await makeWorkspace("agent-workspace");
    const aliasParent = await makeWorkspace("workspace-alias");
    const alias = path.join(aliasParent, "ws");
    await fs.symlink(agentWorkspace, alias, "dir");
    await fs.writeFile(path.join(agentWorkspace, "AGENTS.md"), "Canonical agent instructions");

    const result = await prepare(alias, alias, {
      attempt: { executionAgentsRootDir: agentWorkspace },
    });

    expect(
      result.contextFiles.filter((file) => file.path.endsWith(`${path.sep}AGENTS.md`)),
    ).toHaveLength(1);
  });

  it("keeps an execution cwd out of the bootstrap layer when the run workspace stays canonical", async () => {
    // Layering is skipped only when the execution root resolves to the bootstrap
    // workspace. Here the run workspace stays the canonical agent workspace, so an
    // explicit spawn cwd is not the execution root and output stays byte-identical
    // to the same-workspace route.
    const agentWorkspace = await makeWorkspace("agent-workspace");
    const unregisteredCwd = await makeWorkspace("unregistered-cwd");
    await fs.writeFile(path.join(agentWorkspace, "AGENTS.md"), "Canonical agent instructions");
    await fs.writeFile(path.join(unregisteredCwd, "AGENTS.md"), "Unregistered instructions");

    const withUnregisteredCwd = await prepare(agentWorkspace, agentWorkspace, {
      attempt: { cwd: unregisteredCwd },
    });
    const sameWorkspace = await prepare(agentWorkspace, agentWorkspace);

    expect(withUnregisteredCwd.contextFiles).not.toContainEqual(
      expect.objectContaining({ path: path.join(unregisteredCwd, "AGENTS.md") }),
    );
    expect(withUnregisteredCwd).toEqual(sameWorkspace);
  });

  it("does not layer an unregistered spawned cwd that became the run workspace", async () => {
    // A run workspace/cwd alone is not selected-project provenance.
    const agentWorkspace = await makeWorkspace("agent-workspace");
    const spawnedCwd = await makeWorkspace("spawned-cwd");
    await fs.writeFile(path.join(agentWorkspace, "AGENTS.md"), "Canonical agent instructions");
    await fs.writeFile(path.join(agentWorkspace, "SOUL.md"), "Canonical agent soul");
    await fs.writeFile(path.join(agentWorkspace, "MEMORY.md"), "Canonical agent memory");
    await fs.writeFile(path.join(spawnedCwd, "AGENTS.md"), "Spawned cwd instructions");
    for (const name of ["SOUL.md", "MEMORY.md", "BOOTSTRAP.md", "USER.md"]) {
      await fs.writeFile(path.join(spawnedCwd, name), `Spawned cwd ${name} must stay private`);
    }

    const result = await prepare(agentWorkspace, spawnedCwd, {
      attempt: { cwd: spawnedCwd },
    });
    const spawnedAgentsIndex = result.contextFiles.findIndex(
      (file) => file.path === path.join(spawnedCwd, "AGENTS.md"),
    );
    expect(spawnedAgentsIndex).toBe(-1);
    for (const name of ["SOUL.md", "MEMORY.md"]) {
      expect(result.contextFiles).toContainEqual(
        expect.objectContaining({
          path: path.join(agentWorkspace, name),
        }),
      );
    }
    for (const name of ["SOUL.md", "MEMORY.md", "BOOTSTRAP.md", "USER.md"]) {
      expect(result.contextFiles).not.toContainEqual(
        expect.objectContaining({ path: path.join(spawnedCwd, name) }),
      );
    }
  });

  it("keeps a project root outside the agent workspace on its real path", async () => {
    // Registered projects need not live inside the agent workspace, so the
    // sandbox projection must not remap the project file into it.
    const agentWorkspace = await makeWorkspace("agent-workspace");
    const projectRoot = await makeWorkspace("external-project");
    const promptWorkspace = await makeWorkspace("prompt-workspace");
    await fs.writeFile(path.join(agentWorkspace, "AGENTS.md"), "Canonical agent instructions");
    await fs.writeFile(path.join(projectRoot, "AGENTS.md"), "Selected project instructions");

    const result = await prepare(agentWorkspace, agentWorkspace, {
      effectiveWorkspace: promptWorkspace,
      attempt: { cwd: projectRoot, executionAgentsRootDir: projectRoot },
    });

    expect(result.contextFiles).toContainEqual(
      expect.objectContaining({ path: path.join(promptWorkspace, "AGENTS.md") }),
    );
    expect(result.contextFiles).toContainEqual(
      expect.objectContaining({
        path: path.join(projectRoot, "AGENTS.md"),
        content: "Selected project instructions",
      }),
    );
    expect(result.bootstrapInjectionStats).toContainEqual(
      expect.objectContaining({ path: path.join(projectRoot, "AGENTS.md") }),
    );
  });

  it.each(["none", "full"])("withholds completion for unreadable AGENTS.md (%s)", async (mode) => {
    const unreadable = "x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES + 1);
    const agentWorkspace = await makeWorkspace("agent-workspace", {
      "AGENTS.md": mode === "full" ? unreadable : "Canonical agent instructions",
      ...(mode === "full" ? { "BOOTSTRAP.md": "Finish the workspace setup." } : {}),
    });
    const sessionWorkspace =
      mode === "full"
        ? agentWorkspace
        : await makeWorkspace("session-workspace", { "AGENTS.md": unreadable });

    const result = await prepare(agentWorkspace, sessionWorkspace, {
      contextInjection: "continuation-skip",
      attempt: { executionAgentsRootDir: sessionWorkspace },
    });

    expect(result).toMatchObject({
      bootstrapMode: mode,
      shouldRecordCompletedBootstrapTurn: false,
    });
    if (mode === "full") {
      return;
    }
    expect(result.contextFiles).toContainEqual(
      contextFile(
        path.join(sessionWorkspace, "AGENTS.md"),
        expect.stringMatching(/^\[UNREADABLE: File exceeds/),
      ),
    );

    await fs.writeFile(path.join(sessionWorkspace, "AGENTS.md"), "Recovered instructions");
    const recovered = await prepare(agentWorkspace, sessionWorkspace, {
      contextInjection: "continuation-skip",
      attempt: { executionAgentsRootDir: sessionWorkspace },
    });
    expect(recovered.shouldRecordCompletedBootstrapTurn).toBe(true);
    expect(recovered.contextFiles).toContainEqual(
      expect.objectContaining({ content: "Recovered instructions" }),
    );
  });

  it("remaps injected paths into the prompt workspace while accounting keeps source paths", async () => {
    const agents = "Sandboxed agent instructions";
    const workspace = await makeWorkspace("remap-workspace", { "AGENTS.md": agents });
    const promptWorkspace = await makeWorkspace("remap-prompt");

    const result = await prepare(workspace, workspace, {
      effectiveWorkspace: promptWorkspace,
    });

    expect(result.contextFiles).toContainEqual(
      contextFile(path.join(promptWorkspace, "AGENTS.md"), agents),
    );
    expect(result.bootstrapInjectionStats).toContainEqual(
      expect.objectContaining({
        path: path.join(workspace, "AGENTS.md"),
        rawChars: agents.length,
        injectedChars: agents.length,
        truncated: false,
      }),
    );
  });

  it("keeps same-workspace bootstrap output byte-identical", async () => {
    const workspace = await makeWorkspace("same-workspace", {
      "AGENTS.md": "Same workspace instructions",
      "SOUL.md": "Same workspace soul",
    });

    const explicit = await prepare(workspace);
    const sameProjectRoot = await prepare(workspace, workspace, {
      attempt: { executionAgentsRootDir: workspace },
    });
    const omitted = await prepare(workspace, workspace, {
      attempt: { bootstrapWorkspaceDir: undefined },
    });

    expect(explicit).toEqual(omitted);
    expect(sameProjectRoot).toEqual(omitted);
  });
});
