/** Tests owner-neutral exact ACP one-shot continuation predicates. */
import { describe, expect, it } from "vitest";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import {
  isSameAcpSessionIdentityGeneration,
  resolveAcpOneShotReadinessTarget,
  resolveDurableAcpOneShotResume,
  type AcpCompletedTurnFact,
} from "./session-resume.js";

function resumableMeta(overrides: Partial<SessionAcpMeta> = {}): SessionAcpMeta {
  return {
    backend: "persisted",
    agent: "codex",
    runtimeSessionName: "runtime",
    mode: "oneshot",
    state: "idle",
    lastActivityAt: 1,
    identity: {
      state: "resolved",
      source: "status",
      acpxRecordId: "record-1",
      acpxSessionId: "acp-protocol-id",
      agentSessionId: "legacy-agent-id",
      sessionResumeSupported: true,
      sessionResumeReady: true,
      lastUpdatedAt: 1,
    },
    ...overrides,
  };
}

const completedTurn: AcpCompletedTurnFact = { status: "completed", cancelled: false };

describe("ACP one-shot resume predicates", () => {
  it("resolves the full durable target independently of diagnostic state", () => {
    expect(resolveDurableAcpOneShotResume({ meta: resumableMeta(), backend: "persisted" })).toEqual(
      {
        backend: "persisted",
        resumeSessionId: "acp-protocol-id",
      },
    );
    expect(
      resolveDurableAcpOneShotResume({
        meta: resumableMeta({ state: "running" }),
        backend: "persisted",
      }),
    ).toEqual({ backend: "persisted", resumeSessionId: "acp-protocol-id" });
  });

  it("requires explicit completed, non-cancelled evidence at the pre-readiness fence", () => {
    const meta = resumableMeta({
      identity: {
        ...resumableMeta().identity!,
        sessionResumeReady: false,
      },
    });
    expect(
      resolveAcpOneShotReadinessTarget({ meta, backend: "persisted", terminal: completedTurn }),
    ).toEqual({ backend: "persisted", resumeSessionId: "acp-protocol-id" });
    expect(
      resolveAcpOneShotReadinessTarget({
        meta,
        backend: "persisted",
        terminal: { status: "cancelled", cancelled: true } as unknown as AcpCompletedTurnFact,
      }),
    ).toBeUndefined();
  });

  it.each([
    ["persistent", resumableMeta({ mode: "persistent" }), "persisted"],
    [
      "unresolved",
      resumableMeta({ identity: { ...resumableMeta().identity!, state: "pending" } }),
      "persisted",
    ],
    [
      "unsupported",
      resumableMeta({
        identity: { ...resumableMeta().identity!, sessionResumeSupported: false },
      }),
      "persisted",
    ],
    [
      "not ready",
      resumableMeta({ identity: { ...resumableMeta().identity!, sessionResumeReady: false } }),
      "persisted",
    ],
    [
      "missing stable id",
      resumableMeta({
        identity: {
          state: "resolved",
          source: "status",
          sessionResumeSupported: true,
          sessionResumeReady: true,
          lastUpdatedAt: 1,
        },
      }),
      "persisted",
    ],
    [
      "legacy metadata without canonical identity",
      resumableMeta({ identity: undefined }),
      "persisted",
    ],
    ["wrong backend", resumableMeta(), "other"],
  ] as const)("rejects %s metadata from the full predicate", (_label, meta, backend) => {
    expect(resolveDurableAcpOneShotResume({ meta, backend })).toBeUndefined();
  });

  it("compares backend, ACPX record, and stable resume generation while allowing enrichment", () => {
    const expected = resumableMeta();
    expect(
      isSameAcpSessionIdentityGeneration({
        expected,
        current: resumableMeta({
          identity: {
            ...expected.identity!,
            source: "event",
            sessionResumeReady: false,
            lastUpdatedAt: 2,
          },
        }),
      }),
    ).toBe(true);
    expect(
      isSameAcpSessionIdentityGeneration({
        expected: resumableMeta({
          identity: {
            ...expected.identity!,
            acpxSessionId: undefined,
            agentSessionId: undefined,
          },
        }),
        current: expected,
      }),
    ).toBe(true);

    for (const current of [
      resumableMeta({ backend: "replacement-backend" }),
      resumableMeta({ identity: { ...expected.identity!, acpxRecordId: "record-2" } }),
      resumableMeta({ identity: { ...expected.identity!, acpxSessionId: "acp-replacement" } }),
    ]) {
      expect(isSameAcpSessionIdentityGeneration({ expected, current })).toBe(false);
    }
  });
});
