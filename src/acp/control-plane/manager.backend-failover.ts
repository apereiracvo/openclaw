/** Backend failover helpers for ACP session initialization and turn execution. */
import type { AcpRuntimeErrorCode } from "../runtime/errors.js";
import { normalizeText } from "./runtime-options.js";

/** Captured backend attempt state used to decide whether failover is safe. */
export type BackendAttempt = {
  backend: string;
  error: string;
  code: AcpRuntimeErrorCode;
  promptStarted: boolean;
  sawOutput: boolean;
};

/** Ordered backend candidates plus display helper for diagnostics. */
type BackendCandidatePlan = {
  candidateBackends: string[];
  describeBackendCandidate: (backend: string) => string;
};

/** Builds the deduped backend order, or one persisted owner for an exact continuation. */
export function resolveBackendCandidatePlan(params: {
  configuredPrimaryBackend?: string;
  resolvedPrimaryBackend?: string;
  fallbackBackends?: readonly unknown[];
  pinnedBackend?: string;
}): BackendCandidatePlan {
  const configuredPrimaryBackend = normalizeText(params.configuredPrimaryBackend);
  const resolvedPrimaryBackend = normalizeText(params.resolvedPrimaryBackend);
  const pinnedBackend = normalizeText(params.pinnedBackend);
  const fallbackBackends = Array.isArray(params.fallbackBackends)
    ? params.fallbackBackends
        .map((backend) => normalizeText(backend))
        .filter((backend): backend is string => backend != null)
    : [];
  return {
    // Exact one-shot continuation belongs to one persisted backend. Including any fallback here
    // could silently turn an unavailable conversation into a different backend conversation.
    candidateBackends: pinnedBackend
      ? [pinnedBackend]
      : Array.from(
          new Set([configuredPrimaryBackend ?? resolvedPrimaryBackend ?? "", ...fallbackBackends]),
        ),
    describeBackendCandidate: (backend) =>
      backend || pinnedBackend || resolvedPrimaryBackend || configuredPrimaryBackend || "<auto>",
  };
}

/** Returns true for early transient backend errors where trying another backend is safe. */
export function isFailoverWorthyBackendError(attempt: BackendAttempt): boolean {
  return (
    !attempt.promptStarted &&
    !attempt.sawOutput &&
    (attempt.code === "ACP_TURN_FAILED" ||
      attempt.code === "ACP_SESSION_INIT_FAILED" ||
      attempt.code === "ACP_BACKEND_UNAVAILABLE") &&
    /\b(?:unavailable|rate[-\s]?limit(?:ed|ing)?|quota|exhausted|temporar(?:y|ily)|overloaded)\b/i.test(
      attempt.error,
    )
  );
}

/** Returns whether another backend candidate remains after the current index. */
export function shouldAttemptBackendFailover(params: {
  backendIndex: number;
  candidateBackends: readonly string[];
}): boolean {
  return params.backendIndex < params.candidateBackends.length - 1;
}
