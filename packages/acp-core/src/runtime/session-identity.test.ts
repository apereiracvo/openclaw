import { describe, expect, it } from "vitest";
import type { SessionAcpIdentity, SessionAcpMeta } from "../types.js";
import {
  createIdentityFromEnsure,
  createIdentityFromHandleEvent,
  createIdentityFromStatus,
  identityEquals,
  mergeSessionIdentity,
  resolveRuntimeHandleIdentifiersFromIdentity,
  resolveRuntimeResumeSessionId,
  resolveSessionIdentityFromMeta,
} from "./session-identity.js";

function identity(overrides: Partial<SessionAcpIdentity> = {}): SessionAcpIdentity {
  return {
    state: "resolved",
    source: "status",
    lastUpdatedAt: 1,
    acpxSessionId: "acp-session",
    ...overrides,
  };
}

function meta(sessionIdentity: SessionAcpIdentity): SessionAcpMeta {
  return {
    backend: "acpx",
    agent: "opencode",
    runtimeSessionName: "runtime",
    identity: sessionIdentity,
    mode: "oneshot",
    state: "idle",
    lastActivityAt: 1,
  };
}

describe("ACP session resume identity", () => {
  it("normalizes durable capability and readiness without inferring either", () => {
    expect(
      resolveSessionIdentityFromMeta(
        meta(
          identity({
            state: "pending",
            acpxSessionId: undefined,
            acpxRecordId: " record-1 ",
            sessionResumeSupported: true,
            sessionResumeReady: false,
          }),
        ),
      ),
    ).toEqual({
      state: "pending",
      acpxRecordId: "record-1",
      sessionResumeSupported: true,
      sessionResumeReady: false,
      source: "status",
      lastUpdatedAt: 1,
    });

    expect(resolveSessionIdentityFromMeta(meta(identity()))).not.toHaveProperty(
      "sessionResumeReady",
    );
  });

  it("preserves and explicitly updates resume observations within one identity generation", () => {
    const current = identity({
      acpxRecordId: "record-1",
      agentSessionId: "native-session",
      sessionResumeSupported: true,
      sessionResumeReady: true,
    });
    const sameGeneration = identity({
      acpxRecordId: "record-1",
      agentSessionId: undefined,
      lastUpdatedAt: 2,
    });
    const capabilityDowngrade = identity({
      acpxRecordId: "record-1",
      sessionResumeSupported: false,
      sessionResumeReady: false,
      lastUpdatedAt: 3,
    });

    expect(identityEquals(current, { ...current, lastUpdatedAt: 99 })).toBe(true);
    expect(identityEquals(current, capabilityDowngrade)).toBe(false);
    expect(mergeSessionIdentity({ current, incoming: sameGeneration, now: 4 })).toMatchObject({
      acpxRecordId: "record-1",
      acpxSessionId: "acp-session",
      agentSessionId: "native-session",
      sessionResumeSupported: true,
      sessionResumeReady: true,
      lastUpdatedAt: 4,
    });
    expect(mergeSessionIdentity({ current, incoming: capabilityDowngrade, now: 5 })).toMatchObject({
      sessionResumeSupported: false,
      sessionResumeReady: false,
      lastUpdatedAt: 5,
    });
  });

  it.each([
    { observation: "supported", sessionResumeSupported: true },
    { observation: "unsupported", sessionResumeSupported: false },
    { observation: "unknown", sessionResumeSupported: undefined },
  ])(
    "does not inherit exact-record evidence or readiness when replacement support is $observation",
    ({ sessionResumeSupported }) => {
      const current = identity({
        acpxRecordId: "record-old",
        acpxSessionId: "session-old",
        agentSessionId: "native-old",
        sessionResumeSupported: true,
        sessionResumeReady: true,
      });
      const incoming = identity({
        acpxRecordId: "record-new",
        acpxSessionId: "session-new",
        agentSessionId: undefined,
        sessionResumeSupported,
        sessionResumeReady: undefined,
        lastUpdatedAt: 2,
      });

      const merged = mergeSessionIdentity({ current, incoming, now: 3 });

      expect(merged).toMatchObject({
        acpxRecordId: "record-new",
        acpxSessionId: "session-new",
        lastUpdatedAt: 3,
      });
      expect(merged).not.toHaveProperty("agentSessionId");
      expect(merged).not.toHaveProperty("sessionResumeReady");
      if (sessionResumeSupported === undefined) {
        expect(merged).not.toHaveProperty("sessionResumeSupported");
      } else {
        expect(merged).toHaveProperty("sessionResumeSupported", sessionResumeSupported);
      }
    },
  );

  it("clears exact-record observations when only the accepted record generation changes", () => {
    const merged = mergeSessionIdentity({
      current: identity({
        acpxRecordId: "record-old",
        sessionResumeSupported: true,
        sessionResumeReady: true,
      }),
      incoming: identity({ acpxRecordId: "record-new" }),
      now: 3,
    });

    expect(merged).toMatchObject({
      acpxRecordId: "record-new",
      acpxSessionId: "acp-session",
    });
    expect(merged).not.toHaveProperty("sessionResumeSupported");
    expect(merged).not.toHaveProperty("sessionResumeReady");
  });

  it("keeps capability-only ensure, event, and status observations pending", () => {
    const handle = {
      sessionKey: "agent:opencode:acp:test",
      backend: "acpx",
      runtimeSessionName: "runtime",
      sessionResumeSupported: true,
    };

    expect(createIdentityFromEnsure({ handle, now: 1 })).toEqual({
      state: "pending",
      sessionResumeSupported: true,
      source: "ensure",
      lastUpdatedAt: 1,
    });
    expect(createIdentityFromHandleEvent({ handle, now: 2 })).toEqual({
      state: "pending",
      sessionResumeSupported: true,
      source: "event",
      lastUpdatedAt: 2,
    });
    expect(createIdentityFromStatus({ status: { sessionResumeSupported: false }, now: 3 })).toEqual(
      {
        state: "pending",
        sessionResumeSupported: false,
        source: "status",
        lastUpdatedAt: 3,
      },
    );
  });

  it("resolves ACP protocol ids before legacy agent ids", () => {
    expect(
      resolveRuntimeResumeSessionId(
        identity({ acpxSessionId: "acp-target", agentSessionId: "native-target" }),
      ),
    ).toBe("acp-target");
    expect(
      resolveRuntimeResumeSessionId(
        identity({ acpxSessionId: undefined, agentSessionId: "native-target" }),
      ),
    ).toBe("native-target");
  });

  it("projects exact support onto runtime handles without projecting readiness", () => {
    expect(
      resolveRuntimeHandleIdentifiersFromIdentity(
        identity({
          acpxSessionId: "acp-target",
          agentSessionId: "native-target",
          sessionResumeSupported: true,
          sessionResumeReady: true,
        }),
      ),
    ).toEqual({
      backendSessionId: "acp-target",
      agentSessionId: "native-target",
      sessionResumeSupported: true,
    });
  });
});
