import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../src/gateway/test-helpers.e2e.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../helpers/openclaw-test-instance.js";

const PROBE_ATTEMPTS = 12;
const PROOF_TIMEOUT_MS = 180_000;
const artifactDir = process.env.OPENCLAW_WINDOWS_CRON_PROOF_DIR;
const instances: OpenClawTestInstance[] = [];

if (!artifactDir) {
  throw new Error("OPENCLAW_WINDOWS_CRON_PROOF_DIR is required");
}

afterAll(async () => {
  await Promise.all(instances.splice(0).map(async (instance) => await instance.cleanup()));
});

function readTargetSha(): string {
  return spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
}

function harnessHash(): string {
  return createHash("sha256")
    .update(fs.readFileSync(import.meta.filename))
    .digest("hex");
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
}

describe("Windows cron durable-fence proof", () => {
  it(
    "keeps cold process identities stable and completes a naturally scheduled Gateway receipt",
    { timeout: PROOF_TIMEOUT_MS },
    async () => {
      await fsPromises.mkdir(artifactDir, { recursive: true });
      const target = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (!target.pid) {
        throw new Error("failed to start the target process");
      }

      const probeRows: Array<Record<string, unknown>> = [];
      const errors: string[] = [];
      let gatewayEvidence: Record<string, unknown> = { attempted: false };
      let targetStopped = false;
      let gatewayCleaned = false;

      try {
        for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
          const script = [
            'import { getFileLockProcessStartTime } from "./src/shared/pid-alive.ts";',
            `const value = getFileLockProcessStartTime(${target.pid});`,
            `console.log("OPENCLAW_PROOF=" + JSON.stringify({ attempt: ${attempt}, targetPid: ${target.pid}, value }));`,
          ].join("\n");
          const startedAt = Date.now();
          const probe = spawnSync(
            process.execPath,
            ["--import", "./scripts/tsx.mjs", "--input-type=module", "--eval", script],
            { cwd: process.cwd(), encoding: "utf8", timeout: 20_000, windowsHide: true },
          );
          const marker = probe.stdout
            .split(/\r?\n/u)
            .find((line) => line.startsWith("OPENCLAW_PROOF="));
          const row = marker
            ? (JSON.parse(marker.slice("OPENCLAW_PROOF=".length)) as Record<string, unknown>)
            : { attempt, targetPid: target.pid, value: null };
          const recorded = {
            ...row,
            durationMs: Date.now() - startedAt,
            exitCode: probe.status,
            signal: probe.signal,
            error: probe.error?.message,
            stderr: probe.stderr.trim(),
          };
          probeRows.push(recorded);
          await fsPromises.appendFile(
            path.join(artifactDir, "cold-probes.jsonl"),
            `${JSON.stringify(recorded)}\n`,
          );
        }

        const identities = probeRows.map((row) => row.value);
        if (identities.some((value) => typeof value !== "number")) {
          errors.push("at least one cold process-identity probe returned no identity");
        }
        if (new Set(identities).size !== 1) {
          errors.push("cold process-identity probes did not return one stable identity");
        }

        const instance = await createOpenClawTestInstance({
          name: `windows-cron-fence-${process.pid}`,
          env: {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_SKIP_CRON: undefined,
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          },
        });
        instances.push(instance);
        await instance.startGateway();
        const client = await connectGatewayClient({
          url: instance.url,
          token: instance.gatewayToken,
          requestTimeoutMs: 30_000,
        });
        let jobId: string | undefined;
        try {
          const job = await client.request<{ id: string }>("cron.add", {
            name: "Windows durable-fence proof",
            enabled: true,
            deleteAfterRun: false,
            schedule: { kind: "at", at: new Date(Date.now() + 2_000).toISOString() },
            sessionTarget: "main",
            wakeMode: "next-heartbeat",
            payload: { kind: "systemEvent", text: "Windows durable-fence proof fired" },
          });
          jobId = job.id;
          let terminal: Record<string, unknown> | undefined;
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            const history = await client.request<{ entries: Array<Record<string, unknown>> }>(
              "cron.runs",
              { id: job.id, limit: 1 },
            );
            terminal = history.entries[0];
            if (terminal && terminal.status !== "running") {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }

          const database = new DatabaseSync(
            path.join(instance.stateDir, "state", "openclaw.sqlite"),
            { readOnly: true },
          );
          const receipt = database
            .prepare(
              "SELECT receipt_id, status, owner_pid, owner_start_time, started_at_ms, finished_at_ms, error_text FROM cron_run_receipts WHERE job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
            )
            .get(job.id);
          database.close();
          gatewayEvidence = {
            attempted: true,
            jobId: job.id,
            terminal,
            receipt,
            gatewayLogs: instance.logs(),
          };
          if (terminal?.status !== "ok") {
            errors.push(`scheduled Gateway cron job did not complete: ${JSON.stringify(terminal)}`);
          }
          if (
            !receipt ||
            receipt.status !== "ok" ||
            typeof receipt.owner_start_time !== "number" ||
            typeof receipt.finished_at_ms !== "number"
          ) {
            errors.push(`durable receipt was not terminal and owned: ${JSON.stringify(receipt)}`);
          }
        } catch (error) {
          gatewayEvidence = {
            attempted: true,
            error: error instanceof Error ? error.message : String(error),
            gatewayLogs: instance.logs(),
          };
          errors.push(`scheduled Gateway proof failed: ${gatewayEvidence.error}`);
        } finally {
          if (jobId) {
            await client.request("cron.remove", { id: jobId }).catch(() => undefined);
          }
          await disconnectGatewayClient(client).catch(() => undefined);
          await instance.cleanup();
          instances.splice(instances.indexOf(instance), 1);
          gatewayCleaned = true;
        }
      } finally {
        target.kill();
        targetStopped = await waitForExit(target);
        if (!targetStopped) {
          errors.push("target process survived cleanup");
        }
        const manifest = {
          targetSha: readTargetSha(),
          workflowSha: process.env.GITHUB_WORKFLOW_SHA,
          harnessSha256: harnessHash(),
          runnerName: process.env.RUNNER_NAME,
          runnerImage: process.env.ImageOS,
          platform: process.platform,
          release: process.release,
          probeAttempts: PROBE_ATTEMPTS,
          probeNullCount: probeRows.filter((row) => typeof row.value !== "number").length,
          probeRows,
          gateway: gatewayEvidence,
          cleanup: { targetStopped, gatewayCleaned },
          errors,
        };
        await fsPromises.writeFile(
          path.join(artifactDir, "proof-manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
        );
        expect(errors, JSON.stringify(manifest, null, 2)).toEqual([]);
      }
    },
  );
});
