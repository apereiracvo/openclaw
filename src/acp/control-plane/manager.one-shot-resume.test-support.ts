import { hoisted, readySessionMeta, type SessionAcpMeta } from "./manager.test-helpers.js";

type PersistObservation = {
  failOnError?: boolean;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
  next: SessionAcpMeta;
};

export function resumableOneShotMeta(overrides: Partial<SessionAcpMeta> = {}): SessionAcpMeta {
  return readySessionMeta({
    backend: "persisted-backend",
    runtimeSessionName: "persisted-runtime",
    mode: "oneshot",
    runtimeOptions: { cwd: "/workspace/persisted" },
    cwd: "/workspace/legacy",
    identity: {
      state: "resolved",
      source: "status",
      acpxRecordId: "persisted-record",
      acpxSessionId: "persisted-acp-id",
      agentSessionId: "legacy-agent-id",
      sessionResumeSupported: true,
      sessionResumeReady: true,
      lastUpdatedAt: 1,
    },
    ...overrides,
  });
}

export function installStatefulSession(params: {
  sessionKey: string;
  initialMeta: SessionAcpMeta;
  parentSessionKey?: string;
  onPersist?: (observation: PersistObservation) => void;
  beforeMutate?: (options: {
    failOnError?: boolean;
    skipMaintenance?: boolean;
    takeCacheOwnership?: boolean;
    current: SessionAcpMeta;
  }) => SessionAcpMeta | undefined;
}) {
  let currentMeta = params.initialMeta;
  const childEntry = {
    sessionId: "child-session",
    updatedAt: 1,
    ...(params.parentSessionKey ? { spawnedBy: params.parentSessionKey } : {}),
  };
  hoisted.readAcpSessionEntryMock.mockImplementation((inputUnknown: unknown) => {
    const sessionKey = (inputUnknown as { sessionKey?: string }).sessionKey;
    if (sessionKey === params.sessionKey) {
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        entry: childEntry,
        acp: currentMeta,
      };
    }
    if (sessionKey === params.parentSessionKey) {
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        entry: { sessionId: "parent-session", updatedAt: 1 },
      };
    }
    return null;
  });
  hoisted.upsertAcpSessionMetaMock.mockImplementation(async (inputUnknown: unknown) => {
    const input = inputUnknown as {
      failOnError?: boolean;
      skipMaintenance?: boolean;
      takeCacheOwnership?: boolean;
      mutate: (
        current: SessionAcpMeta | undefined,
        entry: { acp?: SessionAcpMeta } | undefined,
      ) => SessionAcpMeta | null | undefined;
    };
    currentMeta =
      params.beforeMutate?.({
        failOnError: input.failOnError,
        skipMaintenance: input.skipMaintenance,
        takeCacheOwnership: input.takeCacheOwnership,
        current: currentMeta,
      }) ?? currentMeta;
    const next = input.mutate(currentMeta, { ...childEntry, acp: currentMeta });
    if (next && next !== currentMeta) {
      params.onPersist?.({
        failOnError: input.failOnError,
        skipMaintenance: input.skipMaintenance,
        takeCacheOwnership: input.takeCacheOwnership,
        next,
      });
      currentMeta = next;
    }
    return { ...childEntry, acp: currentMeta };
  });
  return {
    get currentMeta() {
      return currentMeta;
    },
  };
}
