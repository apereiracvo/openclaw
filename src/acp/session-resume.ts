/** Owner-neutral predicates for exact ACP one-shot continuation. */
import {
  resolveRuntimeResumeSessionId,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionAcpMeta } from "../config/sessions/types.js";

export type AcpOneShotResumeTarget = {
  backend: string;
  resumeSessionId: string;
};

export type AcpCompletedTurnFact = {
  status: "completed";
  cancelled: false;
};

function resolveAcpOneShotResumeTarget(params: {
  meta: SessionAcpMeta;
  backend: string | undefined;
  requireReady: boolean;
}): AcpOneShotResumeTarget | undefined {
  const persistedBackend = normalizeOptionalString(params.meta.backend);
  const selectedBackend = normalizeOptionalString(params.backend);
  const identity = resolveSessionIdentityFromMeta(params.meta);
  const resumeSessionId = resolveRuntimeResumeSessionId(identity);
  if (
    params.meta.mode !== "oneshot" ||
    identity?.state !== "resolved" ||
    identity.sessionResumeSupported !== true ||
    (params.requireReady && identity.sessionResumeReady !== true) ||
    !resumeSessionId ||
    !persistedBackend ||
    selectedBackend !== persistedBackend
  ) {
    return undefined;
  }
  return {
    backend: persistedBackend,
    resumeSessionId,
  };
}

/** Resolves an exact persisted one-shot continuation only when the complete predicate holds. */
export function resolveDurableAcpOneShotResume(params: {
  meta: SessionAcpMeta;
  backend: string | undefined;
}): AcpOneShotResumeTarget | undefined {
  return resolveAcpOneShotResumeTarget({
    ...params,
    requireReady: true,
  });
}

/** Resolves the generation eligible for readiness only from completed, non-cancelled evidence. */
export function resolveAcpOneShotReadinessTarget(params: {
  meta: SessionAcpMeta;
  backend: string | undefined;
  terminal: AcpCompletedTurnFact;
}): AcpOneShotResumeTarget | undefined {
  if (params.terminal.status !== "completed" || params.terminal.cancelled) {
    return undefined;
  }
  return resolveAcpOneShotResumeTarget({
    meta: params.meta,
    backend: params.backend,
    requireReady: false,
  });
}

/** Checks whether current metadata still represents the turn's observed identity generation. */
export function isSameAcpSessionIdentityGeneration(params: {
  expected: SessionAcpMeta;
  current: SessionAcpMeta;
}): boolean {
  const expectedBackend = normalizeOptionalString(params.expected.backend);
  const currentBackend = normalizeOptionalString(params.current.backend);
  const expectedIdentity = resolveSessionIdentityFromMeta(params.expected);
  const currentIdentity = resolveSessionIdentityFromMeta(params.current);
  if (
    !expectedBackend ||
    expectedBackend !== currentBackend ||
    !expectedIdentity ||
    !currentIdentity
  ) {
    return false;
  }

  const expectedRecordId = normalizeOptionalString(expectedIdentity.acpxRecordId);
  const currentRecordId = normalizeOptionalString(currentIdentity.acpxRecordId);
  if ((expectedRecordId || currentRecordId) && expectedRecordId !== currentRecordId) {
    return false;
  }

  const expectedResumeId = resolveRuntimeResumeSessionId(expectedIdentity);
  const currentResumeId = resolveRuntimeResumeSessionId(currentIdentity);
  if (expectedResumeId && expectedResumeId !== currentResumeId) {
    return false;
  }
  return Boolean(expectedRecordId || expectedResumeId);
}
