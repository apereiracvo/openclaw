import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  RequestedModelUnsupportedError,
  decodeAcpxRuntimeHandleState,
} from "acpx/runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AcpRuntimeError,
  type AcpRuntimeEvent,
  type AcpRuntimeTurnResult,
} from "../runtime-api.js";
import { OPENCLAW_CODEX_CONFIG_ARG } from "./codex-adapter.js";
import { renderAgentCommand, type AcpxAgentCommand } from "./command-line.js";
import { OPENCLAW_ACPX_LEASE_ID_ARG, OPENCLAW_GATEWAY_INSTANCE_ID_ARG } from "./process-lease.js";
import {
  CODEX_ACP_WRAPPER_COMMAND,
  makeEmptySessionStore,
  makeLeasedRuntime,
  makeLeaseStore,
  makeRuntime,
  makeTurn,
  observeLaunch,
  runtimeCommand,
  type TestSessionStore,
} from "./runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const CODEX_ACP_COMMAND = "npx @agentclientprotocol/codex-acp@1.11.0";
const sessionKey = "agent:codex:acp:binding:test";
const testHandle = { sessionKey, backend: "acpx", runtimeSessionName: sessionKey };
const ensureInput = { sessionKey, agent: "codex", mode: "persistent" as const };
const turnInput = {
  handle: testHandle,
  text: "Do work",
  mode: "prompt" as const,
  requestId: "turn",
};

async function collectEvents(events: AsyncIterable<AcpRuntimeEvent>) {
  const collected: AcpRuntimeEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function sessionStore(initial: Record<string, unknown> | undefined): TestSessionStore {
  let record = initial;
  return {
    load: vi.fn(async () => record),
    save: vi.fn(async (next) => {
      record = next;
    }),
  };
}

function leasedRuntime(
  record: Record<string, unknown> | undefined,
  cleanup?: Parameters<typeof makeRuntime>[2],
  wrapperRoot = "/tmp/openclaw/acpx",
) {
  const baseStore = sessionStore(record);
  const leaseStore = makeLeaseStore();
  return {
    ...(cleanup || wrapperRoot !== "/tmp/openclaw/acpx"
      ? makeRuntime(
          baseStore,
          {
            openclawGatewayInstanceId: "gateway-test",
            openclawProcessLeaseStore: leaseStore.store,
            openclawWrapperRoot: wrapperRoot,
            agentRegistry: {
              resolve: () => `node "${path.join(wrapperRoot, "codex-acp-wrapper.mjs")}"`,
              list: () => ["codex"],
            },
          },
          cleanup,
        )
      : makeLeasedRuntime(baseStore, leaseStore)),
    baseStore,
    leaseStore,
  };
}

function commandForLease(leaseId: string, gateway = "gateway-test") {
  return `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} ${leaseId} ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} ${gateway}`;
}

async function diagnosticRuntime(message: string) {
  const wrapperRoot = tempDirs.make("openclaw-acpx-runtime-");
  await fs.writeFile(path.join(wrapperRoot, "codex-acp-wrapper.stderr.diagnostic.log"), message);
  return makeRuntime(
    sessionStore({
      acpxRecordId: sessionKey,
      agentCommand: CODEX_ACP_WRAPPER_COMMAND,
      openclawLeaseId: "diagnostic",
    }),
    { openclawWrapperRoot: wrapperRoot },
  );
}

function recordCommand(command: AcpxAgentCommand) {
  return {
    agentCommand: renderAgentCommand(command),
    ...(typeof command === "string" ? {} : { agentArgv: command }),
  };
}

function makeAgentRuntime(agent: string, command: AcpxAgentCommand) {
  const { runtime, delegate } = makeRuntime(makeEmptySessionStore(), {
    agentRegistry: { resolve: () => command, list: () => [agent] },
  });
  const ensure = vi.spyOn(delegate, "ensureSession").mockResolvedValue({
    sessionKey: `agent:${agent}:acp:test`,
    backend: "acpx",
    runtimeSessionName: agent,
  });
  return { runtime, ensure };
}

function seedLease(
  leases: ReturnType<typeof makeLeaseStore>,
  leaseId: string,
  rootPid: number,
  startedAt: number,
) {
  leases.leases.set(leaseId, {
    leaseId,
    gatewayInstanceId: "gateway-test",
    sessionKey,
    wrapperRoot: "/tmp/openclaw/acpx",
    wrapperPath: "/tmp/openclaw/acpx/codex-acp-wrapper.mjs",
    rootPid,
    commandHash: "hash",
    startedAt,
    state: "open",
  });
}

type FakeAcpWireRequest = {
  method: string;
  params: Record<string, unknown>;
  pid: number;
};

async function writeFakeResumeAgent(params: {
  logPath: string;
  wrapperPath: string;
}): Promise<void> {
  const sdkUrl = pathToFileURL(
    path.resolve("node_modules/@agentclientprotocol/sdk/dist/acp.js"),
  ).href;
  await fs.writeFile(
    params.wrapperPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
} from ${JSON.stringify(sdkUrl)};

const logPath = ${JSON.stringify(params.logPath)};
const log = (method, params = {}) => {
  fs.appendFileSync(logPath, JSON.stringify({ method, params, pid: process.pid }) + "\\n");
};

class FakeResumeAgent {
  initialize(params) {
    log("initialize", params);
    return {
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [],
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: { resume: {}, close: {} },
      },
    };
  }
  authenticate(params) {
    log("authenticate", params);
    return {};
  }
  newSession(params) {
    log("session/new", params);
    return { sessionId: "fresh-" + process.pid };
  }
  resumeSession(params) {
    log("session/resume", params);
    if (params.sessionId === "missing-target") {
      throw RequestError.resourceNotFound(params.sessionId);
    }
    return {};
  }
  prompt(params) {
    log("session/prompt", params);
    return { stopReason: "end_turn" };
  }
  cancel(params) {
    log("session/cancel", params);
  }
  closeSession(params) {
    log("session/close", params);
    return {};
  }
}

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);
const connection = new AgentSideConnection(() => new FakeResumeAgent(), stream);
void connection;
`,
    { mode: 0o755 },
  );
}

async function readFakeAcpWireRequests(logPath: string): Promise<FakeAcpWireRequest[]> {
  const contents = await fs.readFile(logPath, "utf8").catch(() => "");
  return contents
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeAcpWireRequest);
}

function makeRecordStore(): {
  records: Map<string, Record<string, unknown>>;
  store: TestSessionStore;
} {
  const records = new Map<string, Record<string, unknown>>();
  return {
    records,
    store: {
      load: vi.fn(async (recordId: string) => {
        const record = records.get(recordId);
        return record ? structuredClone(record) : undefined;
      }),
      save: vi.fn(async (record) => {
        records.set(String(record.acpxRecordId), structuredClone(record));
      }),
    },
  };
}

describe("AcpxRuntime fresh reset wrapper", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("rejects unsupported runtime session modes (issue #73071)", async () => {
    const { runtime, ensure } = makeAgentRuntime("codex", CODEX_ACP_COMMAND);
    await expect(
      runtime.ensureSession({ ...ensureInput, mode: "run" as never }),
    ).rejects.toMatchObject({ name: "AcpRuntimeError", code: "ACP_INVALID_RUNTIME_OPTION" });
    expect(ensure).not.toHaveBeenCalled();
  });

  it("strips the Bedrock prefix for a portable Claude wrapper command", async () => {
    const { runtime, ensure } = makeAgentRuntime(
      "claude",
      'Node.EXE "C:/openclaw/acpx/claude-agent-acp-wrapper.mjs"',
    );
    await runtime.ensureSession({
      ...ensureInput,
      agent: "claude",
      model: "Amazon-Bedrock/us.anthropic.claude-opus-4-6-v1",
    });
    expect(ensure.mock.calls[0]?.[0]).toEqual({
      ...ensureInput,
      agent: "claude",
      model: "us.anthropic.claude-opus-4-6-v1",
      sessionOptions: { model: "us.anthropic.claude-opus-4-6-v1" },
    });
  });

  it.each([
    {
      stderr:
        "noise\nUnhandled error during session/new: deployment missing token=[REDACTED] sk-testsecret1234567890\n",
      expected: "deployment missing",
      forbidden: "sk-testsecret1234567890",
    },
    {
      stderr: `🚀${"a".repeat(5_999)}`,
      expected: `Internal error: ${"a".repeat(5_999)}`,
      forbidden: "\ude80",
    },
  ])(
    "reports a redacted, UTF-16-safe initialization diagnostic ($forbidden)",
    async ({ stderr, expected, forbidden }) => {
      const wrapperRoot = tempDirs.make("openclaw-acpx-runtime-");
      const { runtime, delegate, leaseStore } = leasedRuntime(undefined, undefined, wrapperRoot);
      vi.spyOn(delegate, "ensureSession").mockImplementation(async () => {
        await observeLaunch(runtime, { sessionKey });
        const leaseId = Array.from(leaseStore.leases.keys())[0];
        await fs.writeFile(
          path.join(wrapperRoot, `codex-acp-wrapper.stderr.${leaseId}.log`),
          stderr,
        );
        throw new Error("Internal error");
      });
      const error = await runtime
        .ensureSession({ ...ensureInput, mode: "oneshot" })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AcpRuntimeError);
      expect(error).toMatchObject({
        code: "ACP_SESSION_INIT_FAILED",
        message: expect.stringContaining(expected),
      });
      expect(error).toHaveProperty("message", expect.not.stringContaining(forbidden));
    },
  );

  it("adds diagnostics to failed turns without settling prompt submission early", async () => {
    const promptStarted = createDeferred<void>();
    const { runtime, delegate } = await diagnosticRuntime("adapter disconnected after progress");
    const progress = { type: "text_delta" as const, stream: "output" as const, text: "Progress" };
    vi.spyOn(delegate, "startTurn").mockImplementation((input) =>
      makeTurn(input, {
        promptStarted: promptStarted.promise,
        events: (async function* () {
          yield progress;
        })(),
        result: Promise.resolve({
          status: "failed",
          error: { message: "Internal error", retryable: false },
        }),
      }),
    );
    const turn = runtime.startTurn(turnInput);
    let submitted = false;
    const observed = turn.promptStarted.then(() => {
      submitted = true;
    });
    expect(await collectEvents(turn.events)).toEqual([progress]);
    expect(submitted).toBe(false);
    promptStarted.resolve();
    await observed;
    expect(submitted).toBe(true);
    await expect(turn.result).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "ACP_TURN_FAILED",
        message: expect.stringContaining("adapter disconnected after progress"),
        retryable: false,
      },
    });
  });

  it.each(["creation", "events"] as const)(
    "adds diagnostics when turn %s throws",
    async (boundary) => {
      const { runtime, delegate } = await diagnosticRuntime("adapter failed before returning turn");
      vi.spyOn(delegate, "startTurn").mockImplementation((input) => {
        if (boundary === "creation") {
          throw new Error("Internal error");
        }
        return makeTurn(input, {
          events: (async function* () {
            yield { type: "status" as const, text: "Connecting" };
            throw new Error("Internal error");
          })(),
        });
      });
      const turn = runtime.startTurn(turnInput);
      const expected = {
        name: "AcpRuntimeError",
        code: "ACP_TURN_FAILED",
        message: expect.stringContaining("adapter failed before returning turn"),
      };
      await expect(
        boundary === "events" ? collectEvents(turn.events) : turn.promptStarted,
      ).rejects.toMatchObject(expected);
      if (boundary === "events") {
        await expect(turn.result).resolves.toEqual({ status: "completed" });
      } else {
        await expect(turn.result).rejects.toMatchObject(expected);
      }
    },
  );

  it.each([
    {
      result: { status: "completed", stopReason: "end_turn" },
      event: { type: "done", stopReason: "end_turn" },
    },
    {
      result: {
        status: "failed",
        error: {
          code: "ACP_TURN_FAILED",
          detailCode: "PROVIDER_ERROR",
          message: "Provider failed",
          retryable: false,
        },
      },
      event: {
        type: "error",
        code: "ACP_TURN_FAILED",
        detailCode: "PROVIDER_ERROR",
        message: "Provider failed",
        retryable: false,
      },
    },
  ] satisfies Array<{ result: AcpRuntimeTurnResult; event: AcpRuntimeEvent }>)(
    "projects $result.status into one legacy terminal event",
    async ({ result, event }) => {
      const { runtime, delegate } = makeRuntime(
        sessionStore({ name: sessionKey, agentCommand: "claude" }),
      );
      const cancel = vi.fn(async () => {});
      vi.spyOn(delegate, "startTurn").mockImplementation((input) =>
        makeTurn(input, {
          events: (async function* () {
            yield { type: "text_delta" as const, text: "Progress" };
          })(),
          result: Promise.resolve(result),
          cancel,
        }),
      );
      expect(await collectEvents(runtime.runTurn(turnInput))).toEqual([
        { type: "text_delta", text: "Progress" },
        event,
      ]);
      expect(cancel).not.toHaveBeenCalled();
    },
  );

  it("drops an inherited model when the agent lacks model support", async () => {
    const { runtime, ensure } = makeAgentRuntime("opencode", "opencode acp");
    ensure.mockRejectedValueOnce(
      new RequestedModelUnsupportedError("No model support", "missing-capability"),
    );
    await expect(
      runtime.ensureSession({ ...ensureInput, agent: "opencode", model: "openrouter/owl-alpha" }),
    ).resolves.toMatchObject({ appliedModel: { kind: "dropped" } });
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(ensure.mock.calls[0]?.[0]).toMatchObject({
      model: "openrouter/owl-alpha",
      sessionOptions: { model: "openrouter/owl-alpha" },
    });
    expect(ensure.mock.calls[1]?.[0]).toMatchObject({ model: undefined });
    expect(ensure.mock.calls[1]?.[0]).not.toHaveProperty("sessionOptions");
  });

  it("persists explicit thinking off over a Codex model suffix", async () => {
    const { runtime, delegate, wrappedStore, baseStore } = leasedRuntime(undefined);
    vi.spyOn(delegate, "ensureSession").mockImplementation(async (input) => {
      await wrappedStore.save({ name: input.sessionKey, cwd: "/tmp", pid: 777 });
      return testHandle;
    });
    await runtime.ensureSession({
      ...ensureInput,
      model: "openai/gpt-5.6-luna/high",
      thinking: "off",
    });
    const argv = (await baseStore.load(sessionKey))?.agentArgv;
    if (!Array.isArray(argv)) {
      throw new Error("Expected persisted ACP argv");
    }
    expect(argv).toContain(OPENCLAW_CODEX_CONFIG_ARG);
    const config: unknown = argv[argv.indexOf(OPENCLAW_CODEX_CONFIG_ARG) + 1];
    if (typeof config !== "string") {
      throw new Error("Expected a Codex startup config argument");
    }
    expect(JSON.parse(config)).toEqual({
      model: "gpt-5.6-luna",
    });
  });

  it("drops inherited max thinking for Codex", async () => {
    const { runtime, ensure } = makeAgentRuntime("codex", "env OPENCLAW_HIDE_BANNER=1 codex-acp");
    const handle = await runtime.ensureSession({
      ...ensureInput,
      thinking: "max",
      thinkingExplicit: false,
    });
    expect(ensure.mock.calls[0]?.[0]).toEqual(ensureInput);
    expect(handle.appliedThinking).toEqual({ kind: "dropped" });
  });

  it("drops an inherited unsupported model while retaining thinking", async () => {
    const { runtime, ensure } = makeAgentRuntime("codex", CODEX_ACP_COMMAND);
    const handle = await runtime.ensureSession({
      ...ensureInput,
      model: "google/gemini-3.1-flash-lite",
      thinking: "low",
    });
    expect(ensure.mock.calls[0]?.[0]).toEqual({ ...ensureInput, thinking: "low" });
    expect(handle.appliedModel).toEqual({ kind: "dropped" });
  });

  it("rejects explicit unsupported models before delegation", async () => {
    const { runtime, ensure } = makeAgentRuntime("codex", CODEX_ACP_COMMAND);
    await expect(
      runtime.ensureSession({
        ...ensureInput,
        model: "google/gemini-3.1-flash-lite",
        modelExplicit: true,
      }),
    ).rejects.toMatchObject({ code: "ACP_INVALID_RUNTIME_OPTION" });
    expect(ensure).not.toHaveBeenCalled();
  });

  it.each([
    { name: "bare model", key: "model", value: "gpt-5.4", calls: [["model", "gpt-5.4"]] },
    {
      name: "empty qualified model",
      key: "model",
      value: "openai//high",
      error: "ACP_INVALID_RUNTIME_OPTION",
    },
    {
      name: "reasoning suffix",
      key: "model",
      value: "openai/gpt-5.4/high",
      calls: [
        ["model", "gpt-5.4"],
        ["reasoning_effort", "high"],
      ],
    },
    {
      name: "unsupported model",
      key: "model",
      value: "google/gemini-3.1-flash-lite",
      error: "ACP_INVALID_RUNTIME_OPTION",
    },
    {
      name: "reasoning alias",
      key: "reasoning_effort",
      value: "x-high",
      calls: [["reasoning_effort", "xhigh"]],
    },
    {
      name: "clearing thinking",
      key: "thought_level",
      value: "off",
      error: "ACP_BACKEND_UNSUPPORTED_CONTROL",
    },
    { name: "Claude timeout", agent: "claude", key: "Timeout_Seconds", value: "60", calls: [] },
    {
      name: "Claude model",
      agent: "claude",
      key: "model",
      value: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/claude",
      calls: [["model", "arn:aws:bedrock:us-east-1:123456789012:inference-profile/claude"]],
    },
  ])("normalizes config control: $name", async ({ agent = "codex", key, value, calls, error }) => {
    const handle = testHandle;
    const { runtime, delegate } = makeRuntime(
      sessionStore({
        acpxRecordId: sessionKey,
        agentCommand: agent === "codex" ? CODEX_ACP_COMMAND : "claude-agent-acp.exe",
      }),
    );
    const accepted = { configOptions: [{ id: "effort", currentValue: "high" }] };
    const update = vi.spyOn(delegate, "setConfigOption").mockResolvedValue(accepted);
    const result = runtime.setConfigOption({ handle, key, value });
    if (error) {
      await expect(result).rejects.toMatchObject({ code: error });
      expect(update).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toBe(calls?.length ? accepted : undefined);
      expect(update.mock.calls).toEqual(
        calls?.map(([controlKey, controlValue]) => [
          { handle, key: controlKey, value: controlValue },
        ]),
      );
    }
  });

  it("does not reuse commands leased by another gateway instance", async () => {
    const foreign = commandForLease("foreign", "gateway-foreign");
    const { runtime, delegate, wrappedStore, baseStore, leaseStore } = leasedRuntime({
      name: sessionKey,
      acpxRecordId: "record-1",
      acpSessionId: "session-1",
      agentCommand: foreign,
      cwd: "/tmp",
      closed: false,
      pid: 777,
    });
    vi.spyOn(delegate, "ensureSession").mockImplementation(async () => {
      await observeLaunch(runtime, { sessionKey, pid: 888 });
      await wrappedStore.save({
        name: sessionKey,
        ...recordCommand(runtimeCommand(runtime)),
        cwd: "/tmp",
        pid: 888,
      });
      return testHandle;
    });
    await runtime.ensureSession(ensureInput);
    const saved = await baseStore.load(sessionKey);
    expect(saved?.agentCommand).not.toBe(foreign);
    expect(saved?.agentCommand).toContain(`${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`);
    expect(saved?.pid).toBe(888);
    expect(leaseStore.leases.size).toBe(1);
  });

  it("rejects reconnect operations for commands leased by another gateway", async () => {
    const { runtime, delegate, leaseStore } = leasedRuntime({
      name: sessionKey,
      agentCommand: commandForLease("foreign", "gateway-foreign"),
    });
    const calls = [
      vi.spyOn(delegate, "startTurn").mockImplementation(makeTurn),
      vi.spyOn(delegate, "setMode").mockResolvedValue(undefined),
      vi.spyOn(delegate, "setConfigOption").mockResolvedValue(undefined),
      vi.spyOn(delegate, "close").mockResolvedValue(undefined),
    ];
    const expected = {
      code: "ACP_TURN_FAILED",
      message: expect.stringContaining("belongs to another gateway"),
    };
    await expect(
      runtime.setConfigOption({ handle: testHandle, key: "thinking", value: "minimal" }),
    ).rejects.toMatchObject(expected);
    await expect(runtime.setMode({ handle: testHandle, mode: "plan" })).rejects.toMatchObject(
      expected,
    );
    await expect(runtime.close({ handle: testHandle, reason: "done" })).rejects.toMatchObject(
      expected,
    );
    const turn = runtime.startTurn(turnInput);
    const outcomes = await Promise.allSettled([turn.result, turn.cancel(), turn.closeStream()]);
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ status: "rejected", reason: expected });
    }
    for (const call of calls) {
      expect(call).not.toHaveBeenCalled();
    }
    expect(leaseStore.leases.size).toBe(0);
  });

  it("serializes concurrent persistent ensures for one session", async () => {
    const { runtime, delegate, wrappedStore, baseStore, leaseStore } = leasedRuntime(undefined);
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const commands: string[] = [];
    let active = 0;
    let maxActive = 0;
    const ensure = vi.spyOn(delegate, "ensureSession").mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      commands.push(renderAgentCommand(runtimeCommand(runtime)));
      if (commands.length === 1) {
        await observeLaunch(runtime, { sessionKey, pid: 777 });
        await wrappedStore.save({
          name: sessionKey,
          acpSessionId: "session-1",
          ...recordCommand(runtimeCommand(runtime)),
          cwd: "/tmp",
          pid: 777,
        });
        started.resolve();
        await release.promise;
      } else {
        await wrappedStore.save((await baseStore.load(sessionKey))!);
      }
      active -= 1;
      return testHandle;
    });
    const first = runtime.ensureSession(ensureInput);
    await started.promise;
    const second = runtime.ensureSession(ensureInput);
    await Promise.resolve();
    try {
      expect(ensure).toHaveBeenCalledOnce();
      release.resolve();
      await Promise.all([first, second]);
      expect(maxActive).toBe(1);
      expect(commands).toHaveLength(2);
      expect(commands[1]).toBe(commands[0]);
      expect(leaseStore.leases.size).toBe(1);
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it("adopts legacy persistent commands before their next reconnect", async () => {
    const record = {
      name: sessionKey,
      acpxRecordId: "record-1",
      acpSessionId: "session-1",
      agentCommand: CODEX_ACP_WRAPPER_COMMAND,
      cwd: "/tmp",
      closed: false,
      pid: 777,
    };
    const { runtime, delegate, wrappedStore, baseStore, leaseStore } = leasedRuntime(record);
    vi.spyOn(delegate, "ensureSession").mockImplementation(async () => {
      expect(renderAgentCommand(runtimeCommand(runtime))).toBe(CODEX_ACP_WRAPPER_COMMAND);
      await wrappedStore.save(record);
      return testHandle;
    });
    await runtime.ensureSession(ensureInput);
    const saved = (await baseStore.load(sessionKey))!;
    expect(saved.agentCommand).toContain(OPENCLAW_ACPX_LEASE_ID_ARG);
    expect(saved.agentCommand).toContain(OPENCLAW_GATEWAY_INSTANCE_ID_ARG);
    expect(saved.pid).toBeUndefined();
    expect(leaseStore.leases.size).toBe(0);
    await observeLaunch(runtime, { sessionKey, command: String(saved.agentCommand), pid: 888 });
    await wrappedStore.save({ ...saved, pid: 888 });
    expect(Array.from(leaseStore.leases.values())).toEqual([
      expect.objectContaining({ leaseId: saved.openclawLeaseId, rootPid: 888 }),
    ]);
  });

  it("joins abandoned runTurn cancellation and leaves uncertain process cleanup to close", async () => {
    const command = commandForLease("abandoned");
    const { runtime, delegate, leaseStore } = leasedRuntime(
      { name: sessionKey, agentCommand: command },
      { openclawProcessCleanup: { listProcesses: async () => [] } },
    );
    await observeLaunch(runtime, { sessionKey, command });
    vi.spyOn(delegate, "close").mockResolvedValue(undefined);
    const result = createDeferred<{ status: "cancelled" }>();
    const cancelling = createDeferred<void>();
    const cancel = vi.fn(async () => {
      cancelling.resolve();
    });
    vi.spyOn(delegate, "startTurn").mockImplementation((input) =>
      makeTurn(input, {
        result: result.promise,
        cancel,
        events: (async function* () {
          yield { type: "text_delta" as const, text: "Partial progress" };
        })(),
      }),
    );
    const iterator = runtime.runTurn(turnInput)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "text_delta", text: "Partial progress" },
    });
    let returned = false;
    const closing = iterator.return?.().then(() => {
      returned = true;
    });
    try {
      await cancelling.promise;
      expect(cancel).toHaveBeenCalledOnce();
      expect(returned).toBe(false);
      expect(leaseStore.leases.has("abandoned")).toBe(true);
      result.resolve({ status: "cancelled" });
      await closing;
      expect(leaseStore.leases.size).toBe(1);
      await runtime.close({ handle: testHandle, reason: "explicit-close" });
      expect(leaseStore.leases.size).toBe(0);
    } finally {
      result.resolve({ status: "cancelled" });
      await closing;
    }
  });

  it("keeps close pending leases when cleanup fails", async () => {
    const command = commandForLease("close-failure");
    const { runtime, delegate, leaseStore } = leasedRuntime({
      name: sessionKey,
      agentCommand: command,
    });
    await observeLaunch(runtime, { command, sessionKey });
    vi.spyOn(delegate, "close").mockResolvedValue(undefined);
    leaseStore.store.load
      .mockResolvedValueOnce(await leaseStore.store.load("close-failure"))
      .mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(runtime.close({ handle: testHandle, reason: "user-close" })).rejects.toThrow(
      "cleanup failed",
    );
    expect(delegate.close).toHaveBeenCalledOnce();
    expect(leaseStore.leases.get("close-failure")).toMatchObject({ rootPid: 0, state: "open" });
  });

  it.each(["unavailable", "windows"])(
    "keeps close leases retryable when process evidence is %s",
    async (evidence) => {
      const listProcesses = vi.fn(async () => {
        throw new Error("process listing unavailable");
      });
      const { runtime, delegate, leaseStore } = leasedRuntime(
        { name: sessionKey, agentCommand: commandForLease("close-list"), pid: 777 },
        {
          openclawProcessCleanup: {
            listProcesses,
            ...(evidence === "windows" ? { platform: "win32" as const } : {}),
          },
        },
      );
      seedLease(leaseStore, "close-list", 777, 1);
      vi.spyOn(delegate, "close").mockResolvedValue(undefined);
      await runtime.close({ handle: testHandle, reason: "user-close" });
      expect(leaseStore.leases.get("close-list")).toMatchObject({ rootPid: 777, state: "open" });
      if (evidence === "windows") {
        expect(listProcesses).not.toHaveBeenCalled();
      }
    },
  );

  it("closes the current process lease when the saved lease id is stale", async () => {
    const killProcess = vi.fn();
    const { runtime, delegate, leaseStore } = leasedRuntime(
      {
        acpxRecordId: sessionKey,
        agentCommand: CODEX_ACP_WRAPPER_COMMAND,
        openclawLeaseId: "old",
        pid: 940,
      },
      {
        openclawProcessCleanup: {
          listProcesses: async () => [
            { pid: 930, ppid: 1, command: commandForLease("old") },
            { pid: 940, ppid: 1, command: commandForLease("current") },
            { pid: 941, ppid: 940, command: "node child.js" },
          ],
          killProcess,
          sleep: async () => {},
        },
      },
    );
    seedLease(leaseStore, "old", 930, 1);
    seedLease(leaseStore, "current", 940, 2);
    vi.spyOn(delegate, "close").mockResolvedValue(undefined);
    await runtime.close({ handle: testHandle, reason: "user-close" });
    expect(killProcess.mock.calls.slice(0, 2)).toEqual([
      [941, "SIGTERM"],
      [940, "SIGTERM"],
    ]);
    expect(leaseStore.store.markState.mock.calls).toEqual([
      ["current", "closing"],
      ["current", "closed"],
    ]);
  });

  it.each([
    {
      name: "reused wrapper root",
      command: 'node "/tmp/other-gateway/acpx/codex-acp-wrapper.mjs"',
      metadata: {},
      killed: [],
    },
    {
      name: "legacy wrapper",
      command: CODEX_ACP_WRAPPER_COMMAND,
      metadata: {},
      killed: [
        [921, "SIGTERM"],
        [920, "SIGTERM"],
      ],
    },
    {
      name: "reused lease",
      command: commandForLease("other-lease"),
      metadata: { openclawGatewayInstanceId: "gateway-test", openclawLeaseId: "lease-record" },
      killed: [],
    },
  ])("validates fallback close ownership for $name", async ({ command, metadata, killed }) => {
    const killProcess = vi.fn();
    const { runtime, delegate } = makeRuntime(
      sessionStore({
        acpxRecordId: sessionKey,
        agentCommand: CODEX_ACP_WRAPPER_COMMAND,
        pid: 920,
        ...metadata,
      }),
      { openclawGatewayInstanceId: "gateway-test", openclawWrapperRoot: "/tmp/openclaw/acpx" },
      {
        openclawProcessCleanup: {
          listProcesses: async () => [
            { pid: 920, ppid: 1, command },
            { pid: 921, ppid: 920, command: "node child.js" },
          ],
          killProcess,
          sleep: async () => {},
        },
      },
    );
    vi.spyOn(delegate, "close").mockResolvedValue(undefined);
    await runtime.close({ handle: testHandle, reason: "user-close" });
    expect(killProcess.mock.calls.slice(0, 2)).toEqual(killed);
  });
});

describe("AcpxRuntime one-shot resume identity", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: "session/resume",
      agentCapabilities: { sessionCapabilities: { resume: true } },
    },
    {
      name: "session/load",
      agentCapabilities: { loadSession: true },
    },
  ])("observes $name support from the exact ensured record", async ({ agentCapabilities }) => {
    const load = vi.fn(async (recordId: string) => ({
      acpxRecordId: recordId,
      agentCapabilities,
    }));
    const baseStore: TestSessionStore = {
      load,
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore);
    vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:opencode:acp:support",
      backend: "acpx",
      runtimeSessionName: "opencode",
      acpxRecordId: "record-support",
      backendSessionId: "acp-support",
    });

    const handle = await runtime.ensureSession({
      sessionKey: "agent:opencode:acp:support",
      agent: "opencode",
      mode: "oneshot",
    });

    expect(handle.sessionResumeSupported).toBe(true);
    expect(load).toHaveBeenCalledWith("record-support");
  });

  it("records false only when the exact record was read", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async (recordId: string) => ({
        acpxRecordId: recordId,
        agentCapabilities: { sessionCapabilities: { resume: false }, loadSession: false },
      })),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore);
    vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:opencode:acp:unsupported",
      backend: "acpx",
      runtimeSessionName: "opencode",
      acpxRecordId: "record-unsupported",
      backendSessionId: "acp-unsupported",
    });

    const handle = await runtime.ensureSession({
      sessionKey: "agent:opencode:acp:unsupported",
      agent: "opencode",
      mode: "oneshot",
    });

    expect(handle.sessionResumeSupported).toBe(false);
  });

  it("keeps exact-record read failure best-effort for a fresh one-shot", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => {
        throw new Error("record store unavailable");
      }),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore);
    const ensure = vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:opencode:acp:fresh",
      backend: "acpx",
      runtimeSessionName: "opencode",
      acpxRecordId: "record-fresh",
      backendSessionId: "acp-fresh",
    });

    const handle = await runtime.ensureSession({
      sessionKey: "agent:opencode:acp:fresh",
      agent: "opencode",
      mode: "oneshot",
      cwd: "/tmp/fresh",
    });

    expect(handle).not.toHaveProperty("sessionResumeSupported");
    expect(ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:opencode:acp:fresh",
        mode: "oneshot",
        cwd: "/tmp/fresh",
      }),
    );
  });

  it("crosses the ACPX manager and transport for strict one-shot resume lifecycle", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-resume-wire-"));
    const wrapperRoot = path.join(root, "wrappers");
    const wrapperPath = path.join(wrapperRoot, "codex-acp-wrapper.mjs");
    const logPath = path.join(root, "wire.ndjson");
    const cwd = path.join(root, "workspace");
    await fs.mkdir(wrapperRoot, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await writeFakeResumeAgent({ logPath, wrapperPath });
    const { records, store } = makeRecordStore();
    const leaseStore = makeLeaseStore();
    const listProcesses = vi.fn(async () =>
      Array.from(records.values()).flatMap((record) => {
        const pid = Number(record.pid);
        const command = typeof record.agentCommand === "string" ? record.agentCommand : undefined;
        return pid > 0 && command ? [{ pid, ppid: 1, command }] : [];
      }),
    );
    const runtime = makeRuntime(
      store,
      {
        cwd,
        openclawGatewayInstanceId: "gateway-test",
        openclawProcessLeaseStore: leaseStore.store,
        openclawWrapperRoot: wrapperRoot,
        agentRegistry: {
          resolve: () => `${JSON.stringify(process.execPath)} ${JSON.stringify(wrapperPath)}`,
          list: () => ["fixture"],
        },
      },
      {
        openclawProcessCleanup: {
          listProcesses,
          killProcess: vi.fn(),
          sleep: vi.fn(async () => {}),
        },
      },
    ).runtime;
    const originalKey = "agent:fixture:acp:continuity";

    try {
      const handle = await runtime.ensureSession({
        sessionKey: originalKey,
        agent: "fixture",
        mode: "oneshot",
        resumeSessionId: "acp-resume-target",
        cwd,
      });
      const handleState = decodeAcpxRuntimeHandleState(handle.runtimeSessionName);
      expect(handle).toMatchObject({
        sessionKey: originalKey,
        backendSessionId: "acp-resume-target",
        cwd,
        sessionResumeSupported: true,
      });
      expect(handleState).toMatchObject({
        mode: "persistent",
        cwd,
        acpxRecordId: handle.acpxRecordId,
        backendSessionId: "acp-resume-target",
      });
      expect(handleState?.name).toBe(handle.acpxRecordId);
      expect(handle.acpxRecordId).not.toBe(originalKey);
      await expect(
        runtime.getStatus({
          handle: { ...handle, sessionKey: "agent:fixture:acp:other" },
        }),
      ).rejects.toMatchObject({ detailCode: "SESSION_OWNER_MIGRATION_REQUIRED" });

      const lease = Array.from(leaseStore.leases.values())[0];
      expect(lease).toMatchObject({
        sessionKey: handle.acpxRecordId,
        rootPid: expect.any(Number),
        state: "open",
      });

      const turn = runtime.startTurn({
        handle,
        text: "continue exactly",
        mode: "prompt",
        requestId: "request-resumed",
      });
      await turn.promptStarted;
      for await (const event of turn.events) {
        void event;
      }
      await expect(turn.result).resolves.toEqual({
        status: "completed",
        stopReason: "end_turn",
      });
      await expect(runtime.getStatus({ handle })).resolves.toMatchObject({
        acpxRecordId: handle.acpxRecordId,
        backendSessionId: "acp-resume-target",
      });

      await runtime.close({ handle, reason: "one-shot turn complete" });

      const stored = records.get(String(handle.acpxRecordId));
      expect(stored).toMatchObject({
        acpxRecordId: handle.acpxRecordId,
        acpSessionId: "acp-resume-target",
        name: handle.acpxRecordId,
        closed: true,
      });
      expect(stored?.acpx).not.toMatchObject({ reset_on_next_ensure: true });
      expect(records.has(originalKey)).toBe(false);
      expect(leaseStore.leases.size).toBe(0);
      expect(leaseStore.store.markState.mock.calls).toContainEqual([lease?.leaseId, "closing"]);
      expect(leaseStore.store.markState.mock.calls).toContainEqual([lease?.leaseId, "closed"]);

      const wire = await readFakeAcpWireRequests(logPath);
      const resumed = wire.filter((request) => request.method === "session/resume");
      const prompts = wire.filter((request) => request.method === "session/prompt");
      expect(resumed).toHaveLength(1);
      expect(resumed[0]?.params).toMatchObject({ sessionId: "acp-resume-target", cwd });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.params).toMatchObject({ sessionId: "acp-resume-target" });
      expect(prompts[0]?.pid).toBe(resumed[0]?.pid);
      expect(wire.some((request) => request.method === "session/new")).toBe(false);
      expect(wire.some((request) => request.method === "session/close")).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("fails a missing resume target once across the real ACP wire without session/new", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-missing-wire-"));
    const wrapperRoot = path.join(root, "wrappers");
    const wrapperPath = path.join(wrapperRoot, "codex-acp-wrapper.mjs");
    const logPath = path.join(root, "wire.ndjson");
    const cwd = path.join(root, "workspace");
    await fs.mkdir(wrapperRoot, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await writeFakeResumeAgent({ logPath, wrapperPath });
    const { records, store } = makeRecordStore();
    const runtime = makeRuntime(store, {
      cwd,
      agentRegistry: {
        resolve: () => `${JSON.stringify(process.execPath)} ${JSON.stringify(wrapperPath)}`,
        list: () => ["fixture"],
      },
    }).runtime;

    try {
      await expect(
        runtime.ensureSession({
          sessionKey: "agent:fixture:acp:missing",
          agent: "fixture",
          mode: "oneshot",
          resumeSessionId: "missing-target",
          cwd,
        }),
      ).rejects.toBeDefined();

      const continuationRequests = (await readFakeAcpWireRequests(logPath)).filter((request) =>
        request.method.startsWith("session/"),
      );
      expect(continuationRequests.map((request) => request.method)).toEqual(["session/resume"]);
      expect(continuationRequests[0]?.params).toMatchObject({
        sessionId: "missing-target",
        cwd,
      });
      expect(records.size).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("keeps ordinary fresh one-shot and persistent ACPX behavior unchanged at the wire", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-fresh-wire-"));
    const wrapperRoot = path.join(root, "wrappers");
    const wrapperPath = path.join(wrapperRoot, "codex-acp-wrapper.mjs");
    const logPath = path.join(root, "wire.ndjson");
    const cwd = path.join(root, "workspace");
    await fs.mkdir(wrapperRoot, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await writeFakeResumeAgent({ logPath, wrapperPath });
    const { records, store } = makeRecordStore();
    const runtime = makeRuntime(store, {
      cwd,
      agentRegistry: {
        resolve: () => `${JSON.stringify(process.execPath)} ${JSON.stringify(wrapperPath)}`,
        list: () => ["fixture"],
      },
    }).runtime;

    try {
      const oneShotKey = "agent:fixture:acp:fresh-oneshot";
      const oneShot = await runtime.ensureSession({
        sessionKey: oneShotKey,
        agent: "fixture",
        mode: "oneshot",
        cwd,
      });
      expect(oneShot.sessionKey).toBe(oneShotKey);
      expect(oneShot.acpxRecordId).not.toBe(oneShotKey);
      expect(decodeAcpxRuntimeHandleState(oneShot.runtimeSessionName)?.mode).toBe("oneshot");
      const oneShotTurn = runtime.startTurn({
        handle: oneShot,
        text: "fresh one-shot",
        mode: "prompt",
        requestId: "request-fresh-oneshot",
      });
      for await (const event of oneShotTurn.events) {
        void event;
      }
      await expect(oneShotTurn.result).resolves.toMatchObject({ status: "completed" });

      const persistentKey = "agent:fixture:acp:fresh-persistent";
      const persistent = await runtime.ensureSession({
        sessionKey: persistentKey,
        agent: "fixture",
        mode: "persistent",
        cwd,
      });
      expect(persistent).toMatchObject({
        sessionKey: persistentKey,
        acpxRecordId: persistentKey,
        sessionResumeSupported: true,
      });
      expect(decodeAcpxRuntimeHandleState(persistent.runtimeSessionName)?.mode).toBe("persistent");
      await expect(runtime.getStatus({ handle: persistent })).resolves.toMatchObject({
        acpxRecordId: persistentKey,
        backendSessionId: persistent.backendSessionId,
      });
      await runtime.close({ handle: persistent, reason: "persistent test complete" });

      const wire = await readFakeAcpWireRequests(logPath);
      const sessionMethods = wire
        .filter((request) => request.method.startsWith("session/"))
        .map((request) => request.method);
      expect(sessionMethods).toEqual(["session/new", "session/prompt", "session/new"]);
      expect(wire.filter((request) => request.method === "session/new")).toHaveLength(2);
      expect(wire.some((request) => request.method === "session/resume")).toBe(false);
      expect(wire.some((request) => request.method === "session/load")).toBe(false);
      expect(records.get(String(oneShot.acpxRecordId))).toMatchObject({
        acpxRecordId: oneShot.acpxRecordId,
        name: oneShotKey,
      });
      expect(records.get(persistentKey)).toMatchObject({ closed: true });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
