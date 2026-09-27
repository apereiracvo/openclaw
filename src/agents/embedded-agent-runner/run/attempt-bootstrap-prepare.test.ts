import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getOrLoadBootstrapFiles } from "../../../agents/bootstrap-cache.js";
import type { AgentBootstrapHookContext } from "../../../hooks/internal-hooks.js";
import { registerInternalHook, unregisterInternalHook } from "../../../hooks/internal-hooks.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareEmbeddedAttemptBootstrap } from "./attempt-bootstrap-prepare.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("prepareEmbeddedAttemptBootstrap", () => {
  async function prepare(params: {
    agentWorkspace: string;
    sessionWorkspace: string;
    cwd?: string;
    executionAgentsRootDir?: string;
    promptWorkspace?: string;
  }) {
    return await prepareEmbeddedAttemptBootstrap({
      attempt: {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        trigger: "user",
        bootstrapWorkspaceDir: params.agentWorkspace,
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.executionAgentsRootDir
          ? { executionAgentsRootDir: params.executionAgentsRootDir }
          : {}),
        isCanonicalWorkspace: params.agentWorkspace === params.sessionWorkspace,
        config: { agents: { defaults: { workspace: params.agentWorkspace } } },
      } as EmbeddedRunAttemptParams,
      setup: createAttemptSetupFixture({
        effectiveWorkspace: params.promptWorkspace ?? params.sessionWorkspace,
        resolvedWorkspace: params.sessionWorkspace,
      }),
      hasReadTool: true,
      isRawModelRun: false,
    });
  }

  it("layers execution project instructions after agent bootstrap files", async () => {
    const agentWorkspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-workspace-")),
    );
    const sessionWorkspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-workspace-")),
    );
    tempDirs.push(agentWorkspace, sessionWorkspace);
    await fs.writeFile(path.join(agentWorkspace, "AGENTS.md"), "Canonical agent instructions");
    await fs.writeFile(path.join(agentWorkspace, "SOUL.md"), "Canonical agent soul");
    await fs.writeFile(path.join(sessionWorkspace, "AGENTS.md"), "Execution project context");
    await fs.writeFile(path.join(sessionWorkspace, "SOUL.md"), "Execution soul must stay private");

    const result = await prepare({ agentWorkspace, sessionWorkspace });
    const executionAgentsIndex = result.contextFiles.findIndex(
      (file) => file.path === path.join(sessionWorkspace, "AGENTS.md"),
    );
    const lastAgentFileIndex = result.contextFiles.findLastIndex((file) =>
      file.path.startsWith(`${agentWorkspace}${path.sep}`),
    );

    expect(executionAgentsIndex).toBeGreaterThan(lastAgentFileIndex);
    expect(result.contextFiles[executionAgentsIndex]).toEqual(
      expect.objectContaining({
        path: path.join(sessionWorkspace, "AGENTS.md"),
        content: "Execution project context",
      }),
    );
    expect(result.contextFiles).toContainEqual(
      expect.objectContaining({
        path: path.join(agentWorkspace, "SOUL.md"),
        content: "Canonical agent soul",
      }),
    );
    expect(result.contextFiles).not.toContainEqual(
      expect.objectContaining({ path: path.join(sessionWorkspace, "SOUL.md") }),
    );
  });

  it("layers a selected project root after agent bootstrap for a spawned project child", async () => {
    // A visible sessions_spawn(projectId) child resolves its run workspace to the
    // target agent's workspace and expresses the project root only as execution
    // cwd, so workspace identity alone cannot locate the project's instructions.
    const agentWorkspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-workspace-")),
    );
    const projectRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-root-")),
    );
    tempDirs.push(agentWorkspace, projectRoot);
    await fs.writeFile(path.join(agentWorkspace, "AGENTS.md"), "Canonical agent instructions");
    await fs.writeFile(path.join(agentWorkspace, "SOUL.md"), "Canonical agent soul");
    await fs.writeFile(path.join(projectRoot, "AGENTS.md"), "Selected project instructions");
    for (const name of ["SOUL.md", "MEMORY.md", "BOOTSTRAP.md", "USER.md"]) {
      await fs.writeFile(path.join(projectRoot, name), `Project ${name} must stay private`);
    }

    const result = await prepare({
      agentWorkspace,
      sessionWorkspace: agentWorkspace,
      cwd: projectRoot,
      executionAgentsRootDir: projectRoot,
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
    const agentWorkspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-workspace-")),
    );
    const projectRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-root-")),
    );
    tempDirs.push(agentWorkspace, projectRoot);
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
      const result = await prepare({
        agentWorkspace,
        sessionWorkspace: agentWorkspace,
        cwd: projectRoot,
        executionAgentsRootDir: projectRoot,
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

  it("keeps the agent workspace bootstrap snapshot cached while layering a project root", async () => {
    // bootstrap-cache keys snapshots by sessionKey alone, so any project-root pass
    // through that cache would evict the agent workspace's stable array every turn.
    const agentWorkspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-workspace-")),
    );
    const projectRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-root-")),
    );
    tempDirs.push(agentWorkspace, projectRoot);
    await fs.writeFile(path.join(agentWorkspace, "AGENTS.md"), "Canonical agent instructions");
    await fs.writeFile(path.join(projectRoot, "AGENTS.md"), "Selected project instructions");
    // Same sessionKey the attempt resolves under, so a project-root pass through
    // that cache would evict this entry.
    const cached = { workspaceDir: agentWorkspace, sessionKey: "agent:main:session-1" };
    const before = await getOrLoadBootstrapFiles(cached);

    await prepare({
      agentWorkspace,
      sessionWorkspace: agentWorkspace,
      cwd: projectRoot,
      executionAgentsRootDir: projectRoot,
    });

    expect(await getOrLoadBootstrapFiles(cached)).toBe(before);
  });

  it("does not layer a project root that is the agent workspace under another spelling", async () => {
    // sessions.create canonicalizes `spawnedCwd`, while the agent workspace keeps its
    // resolved spelling, so a symlinked parent must not produce a second AGENTS.md.
    const agentWorkspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-workspace-")),
    );
    const aliasParent = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-alias-"));
    tempDirs.push(agentWorkspace, aliasParent);
    const alias = path.join(aliasParent, "ws");
    await fs.symlink(agentWorkspace, alias, "dir");
    await fs.writeFile(path.join(agentWorkspace, "AGENTS.md"), "Canonical agent instructions");

    const result = await prepare({
      agentWorkspace: alias,
      sessionWorkspace: alias,
      executionAgentsRootDir: agentWorkspace,
    });

    expect(
      result.contextFiles.filter((file) => file.path.endsWith(`${path.sep}AGENTS.md`)),
    ).toHaveLength(1);
  });

  it("keeps an unregistered execution cwd out of the bootstrap layer", async () => {
    // An explicit spawn `cwd` carries no registered-project provenance, so its
    // AGENTS.md must not become the project layer and output stays byte-identical
    // to the same-workspace route.
    const agentWorkspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-workspace-")),
    );
    const unregisteredCwd = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-unregistered-cwd-")),
    );
    tempDirs.push(agentWorkspace, unregisteredCwd);
    await fs.writeFile(path.join(agentWorkspace, "AGENTS.md"), "Canonical agent instructions");
    await fs.writeFile(path.join(unregisteredCwd, "AGENTS.md"), "Unregistered instructions");

    const withUnregisteredCwd = await prepare({
      agentWorkspace,
      sessionWorkspace: agentWorkspace,
      cwd: unregisteredCwd,
    });
    const sameWorkspace = await prepare({
      agentWorkspace,
      sessionWorkspace: agentWorkspace,
    });

    expect(withUnregisteredCwd.contextFiles).not.toContainEqual(
      expect.objectContaining({ path: path.join(unregisteredCwd, "AGENTS.md") }),
    );
    expect(withUnregisteredCwd).toEqual(sameWorkspace);
  });

  it("keeps a project root outside the agent workspace on its real path", async () => {
    // Registered projects need not live inside the agent workspace, so the
    // sandbox projection must not remap the project file into it.
    const agentWorkspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-workspace-")),
    );
    const projectRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-external-project-")),
    );
    const promptWorkspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-prompt-workspace-")),
    );
    tempDirs.push(agentWorkspace, projectRoot, promptWorkspace);
    await fs.writeFile(path.join(agentWorkspace, "AGENTS.md"), "Canonical agent instructions");
    await fs.writeFile(path.join(projectRoot, "AGENTS.md"), "Selected project instructions");

    const result = await prepare({
      agentWorkspace,
      sessionWorkspace: agentWorkspace,
      cwd: projectRoot,
      executionAgentsRootDir: projectRoot,
      promptWorkspace,
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

  it("remaps injected paths into the prompt workspace while accounting keeps source paths", async () => {
    // Sandbox runs show the model the copy path; injection accounting still has
    // to recognize the host file it loaded, or its bytes read as never injected.
    const workspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-remap-workspace-")),
    );
    const promptWorkspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-remap-prompt-")),
    );
    tempDirs.push(workspace, promptWorkspace);
    const agents = "Sandboxed agent instructions";
    await fs.writeFile(path.join(workspace, "AGENTS.md"), agents);

    const result = await prepareEmbeddedAttemptBootstrap({
      attempt: {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        trigger: "user",
        bootstrapWorkspaceDir: workspace,
        isCanonicalWorkspace: true,
        config: { agents: { defaults: { workspace } } },
      } as EmbeddedRunAttemptParams,
      setup: createAttemptSetupFixture({
        effectiveWorkspace: promptWorkspace,
        resolvedWorkspace: workspace,
      }),
      hasReadTool: true,
      isRawModelRun: false,
    });

    expect(result.contextFiles).toContainEqual(
      expect.objectContaining({
        path: path.join(promptWorkspace, "AGENTS.md"),
        content: agents,
      }),
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

  it("selects the current person's agent-workspace overlay across attempt switches", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const workspace = state.statePath("workspace");
      const alice = ensureProfileForEmail("alice@example.test");
      const bob = ensureProfileForEmail("bob@example.test");
      for (const profile of [alice, bob]) {
        const dir = path.join(workspace, "users", profile.id);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
          path.join(dir, "USER.md"),
          profile.id === alice.id ? "Alice guidance" : "Bob guidance",
        );
      }
      await fs.writeFile(path.join(workspace, "USER.md"), "Shared guidance");
      for (const profile of [alice, bob, undefined]) {
        const result = await prepareEmbeddedAttemptBootstrap({
          attempt: {
            sessionId: "same-session",
            sessionKey: "agent:main:same-session",
            trigger: "user",
            bootstrapUserProfileId: profile?.id,
            bootstrapWorkspaceDir: workspace,
            isCanonicalWorkspace: true,
            config: { agents: { defaults: { workspace } } },
          } as EmbeddedRunAttemptParams,
          setup: createAttemptSetupFixture({
            effectiveWorkspace: workspace,
            resolvedWorkspace: workspace,
          }),
          hasReadTool: true,
          isRawModelRun: false,
        });
        const context = result.contextFiles.map((file) => file.content).join("\n");
        expect(context).toContain("Shared guidance");
        expect(context.includes("Alice guidance")).toBe(profile === alice);
        expect(context.includes("Bob guidance")).toBe(profile === bob);
      }
    });
  });

  it("keeps same-workspace bootstrap output byte-identical", async () => {
    const workspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-same-workspace-")),
    );
    tempDirs.push(workspace);
    await fs.writeFile(path.join(workspace, "AGENTS.md"), "Same workspace instructions");
    await fs.writeFile(path.join(workspace, "SOUL.md"), "Same workspace soul");

    const explicit = await prepare({ agentWorkspace: workspace, sessionWorkspace: workspace });
    // A project root that resolves to the agent workspace must not layer twice.
    const sameProjectRoot = await prepare({
      agentWorkspace: workspace,
      sessionWorkspace: workspace,
      executionAgentsRootDir: workspace,
    });
    const omitted = await prepareEmbeddedAttemptBootstrap({
      attempt: {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        trigger: "user",
        isCanonicalWorkspace: true,
        config: { agents: { defaults: { workspace } } },
      } as EmbeddedRunAttemptParams,
      setup: createAttemptSetupFixture({
        effectiveWorkspace: workspace,
        resolvedWorkspace: workspace,
      }),
      hasReadTool: true,
      isRawModelRun: false,
    });

    expect(explicit).toEqual(omitted);
    expect(sameProjectRoot).toEqual(omitted);
  });
});
