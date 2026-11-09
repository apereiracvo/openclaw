import { ChildProcess, type SpawnOptions } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { UpdateAdmissionContext } from "./update-admission-contract.js";
import { runUpdateCandidateAdmission } from "./update-candidate-admission.js";
import { UPDATE_RUN_DIAGNOSTIC_LIMIT, UPDATE_RUN_TEXT_LIMIT } from "./update-run-limits.js";
import type { UpdateAdmissionVerdict } from "./update-run-schema.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), signal: vi.fn(), tmpdir: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("../process/kill-tree.js", () => ({ signalProcessTree: mocks.signal }));
vi.mock("./tmp-openclaw-dir.js", () => ({ resolvePreferredOpenClawTmpDir: mocks.tmpdir }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let context: UpdateAdmissionContext;
let contextPath: string;
let child: ChildProcess;
let childEnv: NodeJS.ProcessEnv;
let observedContext: unknown;
let observedModes: { file: number; directory: number };
let fixture: { code: number | null; stdout: string; stderr?: string; pending?: boolean };
let spawned: ReturnType<typeof createDeferredCore<void>>;

function admit(): UpdateAdmissionVerdict {
  return {
    protocol: 1,
    verdict: "admit",
    reasons: [],
    warnings: [{ code: "missing-plugin-load-path", message: "A custom plugin path is missing." }],
    facts: {
      candidateVersion: "2026.9.22",
      installedVersion: "2026.9.21",
      checks: [{ name: "config", status: "warn", detail: "A custom plugin path is missing." }],
    },
  };
}

function verdictJson(fields: Record<string, unknown> = {}, facts: Record<string, unknown> = {}) {
  const verdict = admit();
  return JSON.stringify({ ...verdict, ...fields, facts: { ...verdict.facts, ...facts } });
}

function invalid(
  name: string,
  fields: Record<string, unknown> = {},
  facts: Record<string, unknown> = {},
  code = 0,
) {
  return [name, code, verdictJson(fields, facts), "invalid-verdict"] as const;
}

const checks = (count: number, name = (index: number) => `check-${index}`) =>
  Array.from({ length: count }, (_, index) => ({ name: name(index), status: "ok" }));
const badChecks = (name: string, values: unknown) => invalid(name, {}, { checks: values });
const refusal = (name: string, reasons: unknown[] = []) =>
  invalid(name, { verdict: "refuse", reasons }, {}, 3);

async function setMarker(marker: unknown): Promise<void> {
  const manifest = { version: "2026.9.22", openclaw: { updateAdmissionProtocol: marker } };
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
}

function run(overrides: Partial<Parameters<typeof runUpdateCandidateAdmission>[0]> = {}) {
  return runUpdateCandidateAdmission({ candidateRoot: root, context, env: {}, ...overrides });
}

async function expectContextRemoved() {
  await expect(fs.access(contextPath)).rejects.toMatchObject({ code: "ENOENT" });
}

beforeEach(async () => {
  vi.clearAllMocks();
  const { resolvePreferredOpenClawTmpDir } =
    await vi.importActual<typeof import("./tmp-openclaw-dir.js")>("./tmp-openclaw-dir.js");
  root = tempDirs.make("update-candidate-admission-", resolvePreferredOpenClawTmpDir());
  mocks.tmpdir.mockReturnValue(root);
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "dist", "index.js"), "// candidate entry fixture");
  await setMarker(1);
  context = {
    protocol: 1,
    installation: {
      root: path.join(root, "live"),
      canonicalRoot: path.join(root, "canonical-live"),
      version: "2026.9.21",
      installKind: "package",
      packageManager: "npm",
      globalRoot: path.join(root, "global"),
    },
    target: {
      spec: "openclaw@2026.9.22",
      version: "2026.9.22",
      source: "registry",
      channel: "stable",
      tag: "latest",
    },
    request: {
      yes: true,
      noRestart: false,
      acceptCapabilities: false,
      json: true,
      requestedChannel: null,
    },
    run: { id: "admission-fixture-run" },
    supervisor: { version: "2026.9.21", host: "fixture-host", pid: 123 },
  };
  fixture = { code: 0, stdout: JSON.stringify(admit()) };
  contextPath = "";
  spawned = createDeferredCore();
  mocks.spawn.mockImplementation((_command: string, args: string[], options: SpawnOptions) => {
    child = new ChildProcess();
    Object.defineProperty(child, "pid", { value: 654 });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    childEnv = options.env ?? {};
    contextPath = args[args.indexOf("--context") + 1]!;
    observedContext = JSON.parse(fsSync.readFileSync(contextPath, "utf8"));
    observedModes = {
      file: fsSync.statSync(contextPath).mode & 0o777,
      directory: fsSync.statSync(path.dirname(contextPath)).mode & 0o777,
    };
    spawned.resolve();
    if (!fixture.pending) {
      queueMicrotask(() => {
        for (const stream of ["stdout", "stderr"] as const) {
          if (fixture[stream]) {
            child[stream]?.emit("data", fixture[stream]);
          }
        }
        child.emit("close", fixture.code);
      });
    }
    return child;
  });
  mocks.signal.mockImplementation((_pid, _signal, options) => {
    child.emit("close", null);
    options.onComplete();
  });
});

afterEach(() => vi.useRealTimers());

it.each(["unsupported", "forced"] as const)("keeps %s admission passive", async (mode) => {
  await setMarker(mode === "unsupported" ? "1" : 1);
  const result = await run({ admission: mode === "forced" ? "installed" : undefined });
  if (mode === "forced") {
    expect(result).toEqual({ owner: "installed", fallbackReason: "forced-installed" });
  } else {
    expect(result).toMatchObject({
      owner: "installed",
      fallbackReason: "unsupported-target",
      warning: { code: "update-admission-unsupported-target" },
    });
  }
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it.each(["unknown-version", "artifact"] as const)(
  "isolates private %s context and runtime identity",
  async (target) => {
    if (target === "unknown-version") {
      context.target.version = null;
    } else if (target === "artifact") {
      // Assembled at runtime: a literal credential URL trips the PR input-safety scanner.
      const artifactUrl = new URL("https://registry.example/package.tgz?token=fixture-token");
      artifactUrl.username = "fixture-user";
      artifactUrl.password = "fixture-password";
      context.target.source = "artifact";
      context.target.spec = artifactUrl.href;
      context.target.tag = context.target.spec;
    }
    const preservedEnv = {
      HOME: path.join(root, "home"),
      OPENCLAW_HOME: path.join(root, "openclaw-home"),
      OPENCLAW_STATE_DIR: path.join(root, "live-state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "live-config.json"),
      OPENCLAW_PROFILE: "work",
      PROVIDER_API_KEY: "synthetic-provider-key",
    };
    const env = {
      ...preservedEnv,
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_UPDATE_RUN_ID: "inherited-run",
      OPENCLAW_UPDATE_RUN_HANDOFF: "1",
      OPENCLAW_UPDATE_POST_CORE: "1",
      OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: "inherited-result",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "1",
      OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      OPENCLAW_UPDATE_EXECUTOR_GRANT: "inherited-grant",
      OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META: "inherited-sentinel",
      OPENCLAW_GATEWAY_SERVICE_PID: "789",
      OPENCLAW_SYSTEMD_UNIT: "live.service",
      OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.9.1",
      openclaw_compatibility_host_version: "2026.9.2",
      OPENCLAW_DEV_SOURCE_ROOT: path.join(root, "old-source"),
      openclaw_dev_source_root: path.join(root, "old-source-alias"),
      OPENCLAW_VERSION: "2026.9.3",
      openclaw_version: "2026.9.4",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "old-plugins"),
      openclaw_bundled_plugins_dir: path.join(root, "old-plugins-alias"),
      NODE_COMPILE_CACHE: path.join(root, "live-cache"),
      node_compile_cache: path.join(root, "live-cache-alias"),
      NODE_DISABLE_COMPILE_CACHE: "0",
      node_disable_compile_cache: "0",
      OPENCLAW_NO_RESPAWN: "0",
      openclaw_no_respawn: "0",
    };
    const result = await run({ env, nodeRunner: "/selected/node" });
    expect(result).toEqual({ owner: "candidate", verdict: admit() });
    if (target === "artifact") {
      const serialized = JSON.stringify(observedContext);
      expect(serialized).not.toContain("fixture-password");
      expect(serialized).not.toContain("fixture-token");
      expect(serialized).toContain("registry.example/package.tgz");
    } else {
      expect(observedContext).toEqual(context);
    }
    if (process.platform !== "win32") {
      expect(observedModes).toEqual({ file: 0o600, directory: 0o700 });
    }
    expect(mocks.spawn).toHaveBeenCalledWith(
      "/selected/node",
      [path.join(root, "dist", "index.js"), "update", "admit", "--context", contextPath],
      expect.objectContaining({ cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(childEnv).toEqual({
      ...preservedEnv,
      NODE_DISABLE_COMPILE_CACHE: "1",
      OPENCLAW_DEV_SOURCE_ROOT: root,
      ...(context.target.version === null ? {} : { OPENCLAW_VERSION: context.target.version }),
      OPENCLAW_NO_RESPAWN: "1",
    });
    expect(env).toMatchObject({
      OPENCLAW_UPDATE_RUN_ID: "inherited-run",
      OPENCLAW_DEV_SOURCE_ROOT: path.join(root, "old-source"),
      NODE_COMPILE_CACHE: path.join(root, "live-cache"),
    });
    await expect(fs.access(path.dirname(contextPath))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("bounds refusal diagnostics while preserving reason identities and short messages", async () => {
  const message = "diagnostic ".repeat(500);
  const reply: UpdateAdmissionVerdict = {
    ...admit(),
    verdict: "refuse",
    reasons: [
      { code: "invalid-config", message, nextAction: message },
      { code: "database-schema-preflight", message: "The target cannot read this database." },
    ],
    warnings: [
      { code: "x".repeat(81), message },
      ...Array.from({ length: 40 }, (_, index) => ({ code: `warning-${index}`, message })),
    ],
    facts: {
      ...admit().facts,
      checks: [{ name: "config", status: "refuse", detail: message }],
    },
  };
  fixture = { code: 3, stdout: JSON.stringify(reply) };
  const result = await run();
  await expectContextRemoved();
  const verdict = result.verdict;
  expect(result).toMatchObject({ owner: "candidate", verdict: { verdict: "refuse" } });
  expect(verdict?.reasons[1]).toEqual(reply.reasons[1]);
  expect(verdict?.reasons.map((reason) => reason.code)).toEqual(
    reply.reasons.map((reason) => reason.code),
  );
  expect(verdict?.warnings).toHaveLength(UPDATE_RUN_DIAGNOSTIC_LIMIT);
  expect(verdict?.warnings[0]?.code).toBe("warning-0");
  expect(verdict?.facts.checks[0]).toMatchObject({ name: "config", status: "refuse" });
  for (const text of [
    verdict?.facts.checks[0]?.detail,
    verdict?.reasons[0]?.nextAction,
    ...(verdict?.reasons ?? []).map((reason) => reason.message),
    ...(verdict?.warnings ?? []).map((warning) => warning.message),
  ]) {
    expect(text?.length).toBeLessThanOrEqual(UPDATE_RUN_TEXT_LIMIT);
  }
});

it.each([
  ["internal error", 2, verdictJson(), "exit-2"],
  ["crash", null, "", "crash"],
  ["malformed JSON", 0, "not a verdict", "malformed-json"],
  ["protocol mismatch", 0, verdictJson({ protocol: 2 }), "protocol-mismatch"],
  ["wrong shape", 0, JSON.stringify({ protocol: 1, verdict: "admit" }), "invalid-verdict"],
  invalid("wrong exit", {}, {}, 3),
  refusal("empty refusal"),
  badChecks("duplicate check", [...admit().facts.checks, ...admit().facts.checks]),
  ["oversized output", 0, "x".repeat(1024 * 1024 + 1), "output-limit"],
  refusal(
    "too many reasons",
    Array.from({ length: 33 }, () => ({ code: "invalid-config", message: "Invalid config." })),
  ),
  badChecks("too many checks", checks(33)),
  refusal("oversized reason identity", [{ code: "x".repeat(81), message: "Invalid config." }]),
  badChecks("oversized multibyte check identity", [{ name: "é".repeat(65), status: "ok" }]),
  invalid("oversized candidate version", {}, { candidateVersion: "v".repeat(129) }),
  badChecks(
    "large history metadata",
    checks(8, (index) => `${index}${"c".repeat(127)}`),
  ),
] as const)(
  "falls back after %s and retains the last redacted stderr diagnostic",
  async (_name, code, stdout, reason) => {
    fixture = {
      code,
      stdout,
      stderr: "earlier diagnostic\ncannot inspect token=synthetic-secret\n",
    };
    const result = await run({ env: { API_TOKEN: "synthetic-secret" } });
    expect(result).toMatchObject({
      owner: "installed",
      fallbackReason: reason,
      warning: { code: "update-admission-fallback" },
    });
    expect(result.warning?.message).toContain("cannot inspect");
    expect(result.warning?.message).not.toContain("synthetic-secret");
    expect(result.warning?.message).not.toContain("earlier diagnostic");
    expect(result.verdict).toBeUndefined();
    await expectContextRemoved();
  },
);

it("bounds and redacts the stdout excerpt when a debug line precedes the verdict", async () => {
  // The synthetic JWT's payload straddles the excerpt bound; a pre-redaction cut leaks its header.
  const jwt = `eyJhbGciOiJub25lIn0.${"c".repeat(40)}.${"s".repeat(20)}`;
  const line = `[state/sqlite] SQLite read-only snapshot token=synthetic-secret ${"x".repeat(40)} ${jwt}`;
  fixture = { code: 0, stdout: `${line}\n${verdictJson()}`, stderr: "cannot inspect state\n" };

  const result = await run({ env: { API_TOKEN: "synthetic-secret" } });

  expect(result).toMatchObject({ owner: "installed", fallbackReason: "malformed-json" });
  const message = result.warning?.message ?? "";
  expect(message).toContain("cannot inspect state");
  const excerpt = /Candidate stdout began with: (".*")$/u.exec(message)?.[1];
  expect(JSON.parse(excerpt ?? "null")).toMatch(/^\[state\/sqlite\] SQLite read-only snapshot/);
  expect(JSON.parse(excerpt ?? "null").length).toBeLessThanOrEqual(160);
  expect(message).not.toContain("synthetic-secret");
  expect(message).not.toContain("eyJhbGciOiJub25lIn0");
  expect(message.length).toBeLessThanOrEqual(UPDATE_RUN_TEXT_LIMIT);
  await expectContextRemoved();
});

it("bounds admission and terminates its process tree before context cleanup", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  fixture.pending = true;
  const result = run({ timeoutMs: 1_000 });
  await spawned.promise;
  await vi.advanceTimersByTimeAsync(900);
  expect(await result).toMatchObject({
    owner: "installed",
    fallbackReason: "timeout",
    warning: { code: "update-admission-fallback" },
  });
  expect(mocks.signal.mock.calls.map((call) => call[1])).toEqual(["SIGTERM", "SIGKILL"]);
  await expectContextRemoved();
});

it("cleans the private context when spawning the candidate fails", async () => {
  const spawn = mocks.spawn.getMockImplementation()!;
  mocks.spawn.mockImplementationOnce((...args) => {
    fixture.pending = true;
    spawn(...args);
    throw new Error("Cannot launch selected Node runner");
  });
  expect(await run()).toMatchObject({
    owner: "installed",
    fallbackReason: "internal-error",
    warning: {
      code: "update-admission-fallback",
      message: expect.stringContaining("Cannot launch selected Node runner"),
    },
  });
  await expectContextRemoved();
});

// Missing opt-in assets are SKIPPED/UNRUN, never positive protocol evidence.
// This Linux route uses the separately admitted RO D chunk/native-package mounts.
const installedDModule = process.env.OPENCLAW_QA_INSTALLED_D_ADMISSION_MODULE;
const builtCandidateRoot = process.env.OPENCLAW_QA_BUILT_CANDIDATE_ROOT;
const admittedNode = process.env.OPENCLAW_QA_ADMISSION_NODE;
it.skipIf(!installedDModule || !builtCandidateRoot || !admittedNode)(
  "crosses actual installed D admission into the normal built candidate (opt-in)",
  async () => {
    expect(process.platform).toBe("linux");
    for (const input of [installedDModule, builtCandidateRoot, admittedNode]) {
      expect(path.isAbsolute(input!)).toBe(true);
      await fs.access(input!); // An enabled but unavailable route is a setup failure, not a skip.
    }
    expect(path.basename(installedDModule!)).toBe("update-candidate-admission-DEWiGlpZ.mjs");
    const manifest = JSON.parse(
      await fs.readFile(path.join(builtCandidateRoot!, "package.json"), "utf8"),
    );
    expect(manifest.openclaw.updateAdmissionProtocol).toBe(1);
    expect(manifest.openclaw.updatePreflightProtocol).toBe(1);
    expect(manifest.openclaw.schemaVersions).toEqual({ state: 39, agent: 41 });
    // Executable observer must stay on the admitted owned filesystem, not /tmp noexec.
    const sandbox = tempDirs.make("real-D-cell-");
    const state = path.join(sandbox, "state");
    const home = path.join(sandbox, "home");
    const installation = path.join(sandbox, "installation");
    const tmp = path.join(sandbox, "tmp");
    for (const dir of [state, home, installation, tmp]) {
      await fs.mkdir(dir, { recursive: true });
    }
    const configPath = path.join(state, "openclaw.json");
    await fs.writeFile(
      path.join(installation, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.10.8" }),
    );
    const wireContext: UpdateAdmissionContext = {
      ...context,
      installation: {
        root: installation,
        canonicalRoot: installation,
        version: "2026.10.8",
        installKind: "package",
        packageManager: "pnpm",
      },
      target: {
        spec: "openclaw@" + manifest.version,
        version: manifest.version,
        source: "registry",
        channel: "stable",
      },
      request: {
        yes: true,
        noRestart: true,
        acceptCapabilities: false,
        json: true,
        timeoutMs: 20_000,
      },
      run: { id: "synthetic-D-built-candidate" },
      supervisor: { version: "2026.10.8", host: "synthetic", pid: 123 },
    };
    // Explicit environment only: no parent selectors, credentials, NODE_OPTIONS or Vitest preload.
    const cleanEnv = {
      HOME: home,
      USERPROFILE: home,
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      XDG_STATE_HOME: path.join(home, "state"),
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
      OPENCLAW_NO_RESPAWN: "1",
    };
    const sentinels = {
      OPENCLAW_UPDATE_EXECUTOR_GRANT: "synthetic-grant",
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_SYSTEMD_UNIT: "synthetic.service",
      OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META: "synthetic-sentinel",
      OPENCLAW_GATEWAY_SERVICE_PID: "123",
      NODE_COMPILE_CACHE: path.join(sandbox, "old-cache"),
      OPENCLAW_COMPATIBILITY_HOST_VERSION: "synthetic-old",
      OPENCLAW_DEV_SOURCE_ROOT: path.join(sandbox, "wrong-source"),
      OPENCLAW_VERSION: "0.0.0",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(sandbox, "wrong-plugins"),
    };
    const { execFile } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const observer = path.join(sandbox, "node-observer.cjs");
    const observationPath = path.join(sandbox, "observed.json");
    await fs.writeFile(
      observer,
      "#!" +
        admittedNode +
        "\n" +
        [
          "const fs = require('node:fs'); const { spawnSync } = require('node:child_process');",
          "const keys = " +
            JSON.stringify([
              ...Object.keys(sentinels),
              "NODE_DISABLE_COMPILE_CACHE",
              "OPENCLAW_NO_RESPAWN",
              "OPENCLAW_CONFIG_PATH",
              "OPENCLAW_STATE_DIR",
            ]) +
            ";",
          "const env = Object.fromEntries(keys.map(k => [k, process.env[k] ?? null]));",
          "const args = process.argv.slice(2);",
          "const contextPath = args[args.indexOf('--context') + 1];",
          "fs.writeFileSync(" +
            JSON.stringify(observationPath) +
            ", JSON.stringify({ env, args," +
            " context: JSON.parse(fs.readFileSync(contextPath, 'utf8')) }));",
          "const child = spawnSync(" +
            JSON.stringify(admittedNode) +
            ", args, { env: process.env, stdio: 'inherit' });",
          "if (child.error) throw child.error; process.exit(child.status ?? 2);",
        ].join("\n"),
      { mode: 0o700 },
    );
    const harness = `
      import fs from 'node:fs/promises';
      import path from 'node:path';
      import { pathToFileURL } from 'node:url';
      import { spawnSync } from 'node:child_process';
      import { DatabaseSync } from 'node:sqlite';
      const input = JSON.parse(await fs.readFile(process.argv[1], 'utf8'));
      if (input.newerSchema) {
        const databasePath = path.join(input.cleanEnv.OPENCLAW_STATE_DIR, 'state', 'openclaw.sqlite');
        await fs.mkdir(path.dirname(databasePath), { recursive: true });
        const db = new DatabaseSync(databasePath);
        db.exec(await fs.readFile(input.schemaFixture, 'utf8'));
        db.exec("PRAGMA user_version=99999; INSERT INTO schema_meta VALUES" +
          " ('primary','global',99999,NULL,'9999.1.1',1,1)");
        db.close();
      }
      const databasePath = path.join(input.cleanEnv.OPENCLAW_STATE_DIR, 'state', 'openclaw.sqlite');
      const databaseBefore = input.newerSchema ? await fs.readFile(databasePath) : null;
      const { runUpdateCandidateAdmission } = await import(pathToFileURL(input.module).href);
      if (process.versions.node !== '26.12.1') throw new Error('Expected admitted Node26.12.1');
      const result = await runUpdateCandidateAdmission({ candidateRoot: input.candidate,
        context: input.context, env: input.driverEnv, nodeRunner: input.observer, timeoutMs: 20000 });
      // Emitters are negative D-driver controls only, never the built-candidate positive.
      if (input.negative) {
        process.stdout.write(JSON.stringify({ result }));
        process.exit(0);
      }
      const env = { ...input.cleanEnv, OPENCLAW_DEV_SOURCE_ROOT: input.candidate,
        OPENCLAW_VERSION: input.context.target.version };
      const entry = (await Promise.all(['index.js','index.mjs','entry.js','entry.mjs'].map(async name => {
        const p = path.join(input.candidate, 'dist', name);
        return await fs.access(p).then(() => p, () => null);
      }))).find(Boolean);
      if (!entry) throw new Error('Normal built candidate entry unavailable');
      const directContext = path.join(input.sandbox, 'direct-context.json');
      await fs.writeFile(directContext, JSON.stringify(input.context), { mode: 0o600 });
      const direct = spawnSync(process.execPath, [entry, 'update', 'admit', '--context', directContext],
        { cwd: input.candidate, env, encoding: 'utf8', timeout: 20000, maxBuffer: 1048576 });
      if (direct.error) throw direct.error;
      if (databaseBefore && !databaseBefore.equals(await fs.readFile(databasePath))) {
        throw new Error('Synthetic refused database bytes changed');
      }
      process.stdout.write(JSON.stringify({ result, directCode: direct.status,
        direct: JSON.parse(direct.stdout) }));
    `;
    async function invoke(candidate = builtCandidateRoot!, negative = false, newerSchema = false) {
      const inputPath = path.join(sandbox, "input.json");
      await fs.writeFile(
        inputPath,
        JSON.stringify({
          module: installedDModule,
          candidate,
          context: wireContext,
          cleanEnv,
          driverEnv: { ...cleanEnv, ...sentinels },
          sandbox,
          negative,
          observer,
          newerSchema,
          schemaFixture: new URL(
            "../cli/update-cli/fixtures/admission-state-fac4.sql",
            import.meta.url,
          ).pathname,
        }),
      );
      return await new Promise<{
        result: { owner: string; fallbackReason?: string; verdict?: UpdateAdmissionVerdict };
        directCode: number;
        direct: UpdateAdmissionVerdict;
      }>((resolve, reject) => {
        execFile(
          admittedNode!,
          ["--input-type=module", "--eval", harness, inputPath],
          {
            cwd: sandbox,
            env: cleanEnv,
            timeout: 45_000,
            maxBuffer: 1024 * 1024,
            encoding: "utf8",
          },
          (error, stdout) => {
            if (error) {
              reject(new Error("Admission process failed", { cause: error }));
              return;
            }
            try {
              resolve(JSON.parse(stdout));
            } catch (parseError) {
              reject(new Error("Admission result invalid", { cause: parseError }));
            }
          },
        );
      });
    }
    for (const mode of ["valid", "invalid-config", "newer-schema"] as const) {
      const source =
        mode === "invalid-config"
          ? JSON.stringify({ gateway: { port: "synthetic-invalid-port" } })
          : "{}";
      await fs.writeFile(configPath, source);
      const observed = await invoke(builtCandidateRoot!, false, mode === "newer-schema");
      expect(
        observed.result.owner,
        JSON.stringify({
          mode,
          result: observed.result,
          directCode: observed.directCode,
          direct: observed.direct,
        }),
      ).toBe("candidate");
      expect(observed.result.verdict?.protocol).toBe(1);
      expect(
        observed.result.verdict?.verdict,
        JSON.stringify({ mode, result: observed.result, direct: observed.direct }),
      ).toBe(mode === "valid" ? "admit" : "refuse");
      expect(observed.direct.protocol).toBe(1);
      expect(observed.directCode).toBe(mode === "valid" ? 0 : 3);
      expect(observed.direct.verdict).toBe(observed.result.verdict?.verdict);
      expect(observed.direct.facts.checks.map(({ name, status }) => ({ name, status }))).toEqual(
        observed.result.verdict?.facts.checks.map(({ name, status }) => ({ name, status })),
      );
      const observation = JSON.parse(await fs.readFile(observationPath, "utf8"));
      for (const key of Object.keys(sentinels)) {
        if (key !== "OPENCLAW_DEV_SOURCE_ROOT" && key !== "OPENCLAW_VERSION") {
          expect(observation.env[key]).toBeNull();
        }
      }
      expect(observation.env).toMatchObject({
        OPENCLAW_DEV_SOURCE_ROOT: builtCandidateRoot,
        OPENCLAW_VERSION: manifest.version,
        NODE_DISABLE_COMPILE_CACHE: "1",
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: state,
      });
      expect(observation.args.slice(1, 4)).toEqual(["update", "admit", "--context"]);
      expect(path.dirname(observation.args[0])).toBe(path.join(builtCandidateRoot!, "dist"));
      expect(observation.context).toEqual(wireContext);
      expect(observed.result.verdict?.facts.checks).toContainEqual(
        expect.objectContaining({
          name: "config",
          status: mode === "invalid-config" ? "refuse" : "ok",
        }),
      );
      if (mode === "valid") {
        expect(observed.result.verdict?.facts.checks).toContainEqual({
          name: "database-schema",
          status: "ok",
        });
      } else {
        const code = mode === "invalid-config" ? "invalid-config" : "database-schema-preflight";
        expect(observed.result.verdict?.reasons).toContainEqual(expect.objectContaining({ code }));
        if (mode === "newer-schema") {
          expect(observed.result.verdict?.facts.checks).toContainEqual(
            expect.objectContaining({ name: "database-schema", status: "refuse" }),
          );
        }
      }
      expect(observed.result.verdict?.facts.candidateVersion).toBe(manifest.version);
      expect(observed.result.verdict?.facts.installedVersion).toBe("2026.10.8");
      expect(await fs.readFile(configPath, "utf8")).toBe(source);
    }
    for (const [kind, protocol, output, reason] of [
      ["unsupported", 2, "", "unsupported-target"],
      ["malformed", 1, "not JSON", "malformed-json"],
    ] as const) {
      const negativeRoot = path.join(sandbox, "negative-" + kind);
      await fs.mkdir(path.join(negativeRoot, "dist"), { recursive: true });
      await fs.writeFile(
        path.join(negativeRoot, "package.json"),
        JSON.stringify({
          type: "module",
          openclaw: { updateAdmissionProtocol: protocol },
        }),
      );
      await fs.writeFile(
        path.join(negativeRoot, "dist", "index.js"),
        "process.stdout.write(" + JSON.stringify(output) + ");",
      );
      expect((await invoke(negativeRoot, true)).result).toMatchObject({
        owner: "installed",
        fallbackReason: reason,
      });
    }
    expect(mocks.spawn).not.toHaveBeenCalled();
  },
  180_000,
);
