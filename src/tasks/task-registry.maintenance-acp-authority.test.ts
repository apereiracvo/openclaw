import { afterEach, describe, expect, it, vi } from "vitest";
import { listAcpSessionEntries, readAcpSessionEntry } from "../acp/runtime/session-meta.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import {
  loadTaskAcpSessionCloser,
  type CloseAcpSession,
} from "./task-registry-acp-cleanup.js";
import { captureTaskDeliveryWork } from "./task-registry-delivery.test-support.js";
import {
  configureTaskRegistryMaintenance,
  runTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import { createAcpSessionStoreEntry } from "./task-registry.maintenance.test-support.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import { createTaskFixture } from "./task-registry.test-support.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

vi.mock("../acp/runtime/session-meta.js", { spy: true });
vi.mock("./task-registry-acp-cleanup.js", { spy: true });

const parentSessionKey = "agent:main:main";

function createCleanupEffects() {
  const close = vi.fn<CloseAcpSession>().mockResolvedValue(undefined);
  const unbind = vi.spyOn(getSessionBindingService(), "unbind").mockResolvedValue([]);
  vi.mocked(loadTaskAcpSessionCloser).mockReset().mockResolvedValue(close);
  vi.mocked(listAcpSessionEntries).mockReset().mockResolvedValue([]);
  vi.mocked(readAcpSessionEntry).mockReset().mockReturnValue(null);
  return { close, unbind };
}

function durableOneShotAcpOverrides(): Partial<SessionAcpMeta> {
  return {
    identity: {
      state: "resolved",
      source: "status",
      acpxRecordId: "record-1",
      acpxSessionId: "session-1",
      sessionResumeSupported: true,
      sessionResumeReady: true,
      lastUpdatedAt: Date.now(),
    },
  };
}

async function withAcpCleanupState(
  run: (effects: ReturnType<typeof createCleanupEffects>) => Promise<void>,
) {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-task-maintenance-acp-authority-" },
    async () => {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      configureTaskRegistryMaintenance({ runtimeAuthoritative: false });
      try {
        await run(createCleanupEffects());
      } finally {
        await closeOpenClawStateDatabaseAsync();
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      }
    },
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(loadTaskAcpSessionCloser).mockReset();
  vi.mocked(listAcpSessionEntries).mockReset();
  vi.mocked(readAcpSessionEntry).mockReset();
  configureTaskRegistryMaintenance({ runtimeAuthoritative: false });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  await drainGlobalSingletonLifecycleState("close");
});

describe("task maintenance ACP cleanup authority", () => {
  it.each([
    { boundary: "list", permittedCloses: 0, permittedUnbinds: 0 },
    { boundary: "close", permittedCloses: 1, permittedUnbinds: 0 },
    { boundary: "unbind", permittedCloses: 1, permittedUnbinds: 1 },
  ] as const)(
    "stops orphan cleanup when the task store retires during $boundary",
    async ({ boundary, permittedCloses, permittedUnbinds }) => {
      await withAcpCleanupState(async ({ close, unbind }) => {
        const entries = ["first", "second"].map((suffix) =>
          createAcpSessionStoreEntry({
            sessionKey: `agent:main:acp:orphan-${suffix}`,
            parentSessionKey,
            mode: "oneshot",
          }),
        );
        vi.mocked(listAcpSessionEntries).mockResolvedValue(entries);
        const retireStore = async () => {
          await Promise.resolve();
          configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
        };
        if (boundary === "list") {
          vi.mocked(listAcpSessionEntries).mockImplementationOnce(async () => {
            await retireStore();
            return entries;
          });
        } else if (boundary === "close") {
          close.mockImplementationOnce(retireStore);
        } else {
          unbind.mockImplementationOnce(async () => {
            await retireStore();
            return [];
          });
        }

        await expect(runTaskRegistryMaintenance()).rejects.toThrow(
          "Task registry read owner is no longer current.",
        );
        expect(close.mock.calls.map(([input]) => input.sessionKey)).toEqual(
          entries.slice(0, permittedCloses).map((entry) => entry.sessionKey),
        );
        expect(unbind.mock.calls.map(([input]) => input.targetSessionKey)).toEqual(
          entries.slice(0, permittedUnbinds).map((entry) => entry.sessionKey),
        );
      });
    },
  );

  it("does not unbind a terminal ACP session when closing it retires the task store", async () => {
    await withAcpCleanupState(async ({ close, unbind }) => {
      const entry = createAcpSessionStoreEntry({
        sessionKey: "agent:main:acp:terminal",
        parentSessionKey,
        mode: "oneshot",
      });
      vi.mocked(readAcpSessionEntry).mockReturnValue(entry);
      using deliveries = captureTaskDeliveryWork();
      createTaskFixture("acp", {
        ownerKey: parentSessionKey,
        requesterSessionKey: parentSessionKey,
        childSessionKey: entry.sessionKey,
        runId: "terminal-acp-cleanup-authority",
        task: "Completed parent-owned ACP task",
        status: "succeeded",
        cleanupAfter: Date.now() + 86_400_000,
        notifyPolicy: "silent",
      });
      await deliveries.settle();
      close.mockImplementationOnce(async () => {
        await Promise.resolve();
        configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
      });

      await expect(runTaskRegistryMaintenance()).rejects.toThrow(
        "Task registry read owner is no longer current.",
      );
      expect(close).toHaveBeenCalledExactlyOnceWith({
        cfg: entry.cfg,
        agentId: entry.agentId,
        sessionKey: entry.sessionKey,
        reason: "terminal-task-cleanup",
      });
      expect(unbind).not.toHaveBeenCalled();
    });
  });

  it("retains verified terminal parent-owned one-shot sessions during maintenance", async () => {
    await withAcpCleanupState(async ({ close, unbind }) => {
      const entry = createAcpSessionStoreEntry({
        sessionKey: "agent:main:acp:terminal-verified",
        parentSessionKey,
        mode: "oneshot",
        acpOverrides: { state: "running", ...durableOneShotAcpOverrides() },
      });
      vi.mocked(readAcpSessionEntry).mockReturnValue(entry);
      using deliveries = captureTaskDeliveryWork();
      createTaskFixture("acp", {
        ownerKey: parentSessionKey,
        requesterSessionKey: parentSessionKey,
        childSessionKey: entry.sessionKey,
        runId: "terminal-acp-verified-retained",
        task: "Completed parent-owned ACP task",
        status: "succeeded",
        cleanupAfter: Date.now() + 86_400_000,
        notifyPolicy: "silent",
      });
      await deliveries.settle();

      await runTaskRegistryMaintenance();

      expect(close).not.toHaveBeenCalled();
      expect(unbind).not.toHaveBeenCalled();
      expect(entry.acp?.identity?.acpxSessionId).toBe("session-1");
      expect(entry.acp?.identity?.sessionResumeReady).toBe(true);
    });
  });

  it("retains only verified orphaned parent-owned one-shot sessions", async () => {
    await withAcpCleanupState(async ({ close, unbind }) => {
      const negative = createAcpSessionStoreEntry({
        sessionKey: "agent:main:acp:orphan-negative",
        parentSessionKey,
        mode: "oneshot",
      });
      const retained = createAcpSessionStoreEntry({
        sessionKey: "agent:main:acp:orphan-verified",
        parentSessionKey,
        mode: "oneshot",
        acpOverrides: { state: "running", ...durableOneShotAcpOverrides() },
      });
      const unrelated = createAcpSessionStoreEntry({
        sessionKey: "agent:main:acp:orphan-unrelated",
        parentSessionKey: "",
        mode: "oneshot",
      });
      vi.mocked(listAcpSessionEntries).mockResolvedValue([negative, retained, unrelated]);
      vi.mocked(readAcpSessionEntry).mockReturnValue(retained);

      await runTaskRegistryMaintenance();

      expect(close.mock.calls.map(([input]) => input.sessionKey)).toEqual([negative.sessionKey]);
      expect(unbind.mock.calls.map(([input]) => input.targetSessionKey)).toEqual([
        negative.sessionKey,
      ]);
    });
  });

  it("skips unbinding a terminal one-shot whose resume metadata is verified before the serialized close", async () => {
    await withAcpCleanupState(async ({ unbind }) => {
      const unverified = createAcpSessionStoreEntry({
        sessionKey: "agent:main:acp:terminal-becomes-verified",
        parentSessionKey,
        mode: "oneshot",
      });
      const verified = createAcpSessionStoreEntry({
        sessionKey: unverified.sessionKey,
        parentSessionKey,
        mode: "oneshot",
        acpOverrides: { state: "running", ...durableOneShotAcpOverrides() },
      });
      let reads = 0;
      vi.mocked(readAcpSessionEntry).mockImplementation(() => {
        reads += 1;
        return reads === 1 ? unverified : verified;
      });
      const close = vi.fn<CloseAcpSession>().mockImplementation(async (_params, revalidate) => {
        await Promise.resolve();
        revalidate?.();
      });
      vi.mocked(loadTaskAcpSessionCloser).mockReset().mockResolvedValue(close);
      using deliveries = captureTaskDeliveryWork();
      createTaskFixture("acp", {
        ownerKey: parentSessionKey,
        requesterSessionKey: parentSessionKey,
        childSessionKey: unverified.sessionKey,
        runId: "terminal-acp-verified-before-close",
        task: "Completed parent-owned ACP task",
        status: "succeeded",
        cleanupAfter: Date.now() + 86_400_000,
        notifyPolicy: "silent",
      });
      await deliveries.settle();

      await runTaskRegistryMaintenance();

      expect(close).toHaveBeenCalledExactlyOnceWith(
        {
          cfg: unverified.cfg,
          agentId: unverified.agentId,
          sessionKey: unverified.sessionKey,
          reason: "terminal-task-cleanup",
        },
        expect.any(Function),
      );
      expect(unbind).not.toHaveBeenCalled();
    });
  });
});
