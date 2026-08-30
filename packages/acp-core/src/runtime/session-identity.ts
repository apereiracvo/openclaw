// ACP Core module implements session identity behavior.
import { normalizeOptionalString as normalizeText } from "@openclaw/normalization-core/string-coerce";
import type { SessionAcpIdentity, SessionAcpIdentitySource, SessionAcpMeta } from "../types.js";
import type { AcpRuntimeHandle, AcpRuntimeStatus } from "./types.js";

// ACP session identity merge and extraction helpers for resume-safe runtime state.

/** Normalize a stored identity state value from metadata. */
function normalizeIdentityState(value: unknown): SessionAcpIdentity["state"] | undefined {
  if (value !== "pending" && value !== "resolved") {
    return undefined;
  }
  return value;
}

/** Normalize where an ACP identity observation came from. */
function normalizeIdentitySource(value: unknown): SessionAcpIdentitySource | undefined {
  if (value !== "ensure" && value !== "status" && value !== "event") {
    return undefined;
  }
  return value;
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Normalize an identity object and infer pending/resolved state from stable ids. */
function normalizeIdentity(
  identity: SessionAcpIdentity | undefined,
): SessionAcpIdentity | undefined {
  if (!identity) {
    return undefined;
  }
  const state = normalizeIdentityState(identity.state);
  const source = normalizeIdentitySource(identity.source);
  const acpxRecordId = normalizeText(identity.acpxRecordId);
  const acpxSessionId = normalizeText(identity.acpxSessionId);
  const agentSessionId = normalizeText(identity.agentSessionId);
  const sessionResumeSupported = normalizeOptionalBoolean(identity.sessionResumeSupported);
  const sessionResumeReady = normalizeOptionalBoolean(identity.sessionResumeReady);
  const lastUpdatedAt =
    typeof identity.lastUpdatedAt === "number" && Number.isFinite(identity.lastUpdatedAt)
      ? identity.lastUpdatedAt
      : undefined;
  const hasAnyId = Boolean(acpxRecordId || acpxSessionId || agentSessionId);
  const hasResumeObservation =
    sessionResumeSupported !== undefined || sessionResumeReady !== undefined;
  if (!state && !source && !hasAnyId && !hasResumeObservation && lastUpdatedAt === undefined) {
    return undefined;
  }
  const resolved = Boolean(acpxSessionId || agentSessionId);
  const normalizedState = state ?? (resolved ? "resolved" : "pending");
  return {
    state: normalizedState,
    ...(acpxRecordId ? { acpxRecordId } : {}),
    ...(acpxSessionId ? { acpxSessionId } : {}),
    ...(agentSessionId ? { agentSessionId } : {}),
    ...(sessionResumeSupported !== undefined ? { sessionResumeSupported } : {}),
    ...(sessionResumeReady !== undefined ? { sessionResumeReady } : {}),
    source: source ?? "status",
    lastUpdatedAt: lastUpdatedAt ?? Date.now(),
  };
}

type IdentityIds = Pick<SessionAcpIdentity, "acpxRecordId" | "acpxSessionId" | "agentSessionId">;
type IdentityRuntimeCapability = Pick<SessionAcpIdentity, "sessionResumeSupported">;

/** Read identity ids from a runtime handle shape. */
function readIdentityIdsFromHandle(handle: AcpRuntimeHandle): IdentityIds {
  return {
    acpxRecordId: normalizeText((handle as { acpxRecordId?: unknown }).acpxRecordId),
    acpxSessionId: normalizeText(handle.backendSessionId),
    agentSessionId: normalizeText(handle.agentSessionId),
  };
}

function readRuntimeCapabilityFromHandle(handle: AcpRuntimeHandle): IdentityRuntimeCapability {
  const sessionResumeSupported = normalizeOptionalBoolean(handle.sessionResumeSupported);
  return sessionResumeSupported === undefined ? {} : { sessionResumeSupported };
}

/** Build an identity when a stable id or exact capability observation is known. */
function buildSessionIdentity(params: {
  ids: IdentityIds;
  state: SessionAcpIdentity["state"];
  source: SessionAcpIdentitySource;
  now: number;
  capability?: IdentityRuntimeCapability;
}): SessionAcpIdentity | undefined {
  const { acpxRecordId, acpxSessionId, agentSessionId } = params.ids;
  const sessionResumeSupported = params.capability?.sessionResumeSupported;
  if (!acpxRecordId && !acpxSessionId && !agentSessionId && sessionResumeSupported === undefined) {
    return undefined;
  }
  return {
    state: params.state,
    ...(acpxRecordId ? { acpxRecordId } : {}),
    ...(acpxSessionId ? { acpxSessionId } : {}),
    ...(agentSessionId ? { agentSessionId } : {}),
    ...(sessionResumeSupported !== undefined ? { sessionResumeSupported } : {}),
    source: params.source,
    lastUpdatedAt: params.now,
  };
}

/** Resolve normalized ACP identity from persisted session metadata. */
export function resolveSessionIdentityFromMeta(
  meta: SessionAcpMeta | undefined,
): SessionAcpIdentity | undefined {
  if (!meta) {
    return undefined;
  }
  return normalizeIdentity(meta.identity);
}

/** Return true when an identity has a backend or agent session id. */
export function identityHasStableSessionId(identity: SessionAcpIdentity | undefined): boolean {
  return Boolean(identity?.acpxSessionId || identity?.agentSessionId);
}

/** Resolve the runtime resume id, preferring the ACP protocol id over the legacy agent id. */
export function resolveRuntimeResumeSessionId(
  identity: SessionAcpIdentity | undefined,
): string | undefined {
  if (!identity) {
    return undefined;
  }
  return normalizeText(identity.acpxSessionId) ?? normalizeText(identity.agentSessionId);
}

/** Return true when identity is absent or still pending. */
export function isSessionIdentityPending(identity: SessionAcpIdentity | undefined): boolean {
  if (!identity) {
    return true;
  }
  return identity.state === "pending";
}

/** Compare identities ignoring lastUpdatedAt timestamp churn. */
export function identityEquals(
  left: SessionAcpIdentity | undefined,
  right: SessionAcpIdentity | undefined,
): boolean {
  const a = normalizeIdentity(left);
  const b = normalizeIdentity(right);
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.state === b.state &&
    a.acpxRecordId === b.acpxRecordId &&
    a.acpxSessionId === b.acpxSessionId &&
    a.agentSessionId === b.agentSessionId &&
    a.sessionResumeSupported === b.sessionResumeSupported &&
    a.sessionResumeReady === b.sessionResumeReady &&
    a.source === b.source
  );
}

/** Merge current and incoming identity observations without downgrading resolved ids. */
export function mergeSessionIdentity(params: {
  current: SessionAcpIdentity | undefined;
  incoming: SessionAcpIdentity | undefined;
  now: number;
}): SessionAcpIdentity | undefined {
  const current = normalizeIdentity(params.current);
  const incoming = normalizeIdentity(params.incoming);
  if (!current) {
    if (!incoming) {
      return undefined;
    }
    return { ...incoming, lastUpdatedAt: params.now };
  }
  if (!incoming) {
    return current;
  }

  const currentResolved = current.state === "resolved";
  const incomingResolved = incoming.state === "resolved";
  const allowIncomingValue = !currentResolved || incomingResolved;
  const currentResumeId = resolveRuntimeResumeSessionId(current);
  const incomingResumeId = resolveRuntimeResumeSessionId(incoming);
  const replacesIdentityGeneration =
    allowIncomingValue &&
    ((incomingResumeId !== undefined && incomingResumeId !== currentResumeId) ||
      (incoming.acpxRecordId !== undefined && incoming.acpxRecordId !== current.acpxRecordId));
  // Resume support is evidence from one exact ACPX record, and readiness fences one completed
  // identity generation. A replacement may carry fresh explicit observations, never old ones.
  const nextRecordId = replacesIdentityGeneration
    ? incoming.acpxRecordId
    : allowIncomingValue && incoming.acpxRecordId
      ? incoming.acpxRecordId
      : current.acpxRecordId;
  const nextAcpxSessionId = replacesIdentityGeneration
    ? incoming.acpxSessionId
    : allowIncomingValue && incoming.acpxSessionId
      ? incoming.acpxSessionId
      : current.acpxSessionId;
  const nextAgentSessionId = replacesIdentityGeneration
    ? incoming.agentSessionId
    : allowIncomingValue && incoming.agentSessionId
      ? incoming.agentSessionId
      : current.agentSessionId;
  const nextSessionResumeSupported = replacesIdentityGeneration
    ? incoming.sessionResumeSupported
    : incoming.sessionResumeSupported !== undefined
      ? incoming.sessionResumeSupported
      : current.sessionResumeSupported;
  const nextSessionResumeReady = replacesIdentityGeneration
    ? incoming.sessionResumeReady
    : incoming.sessionResumeReady !== undefined
      ? incoming.sessionResumeReady
      : current.sessionResumeReady;

  const nextResolved = Boolean(nextAcpxSessionId || nextAgentSessionId);
  const nextState: SessionAcpIdentity["state"] = nextResolved
    ? "resolved"
    : currentResolved
      ? "resolved"
      : incoming.state;
  const nextSource = allowIncomingValue ? incoming.source : current.source;
  const next: SessionAcpIdentity = {
    state: nextState,
    ...(nextRecordId ? { acpxRecordId: nextRecordId } : {}),
    ...(nextAcpxSessionId ? { acpxSessionId: nextAcpxSessionId } : {}),
    ...(nextAgentSessionId ? { agentSessionId: nextAgentSessionId } : {}),
    ...(nextSessionResumeSupported !== undefined
      ? { sessionResumeSupported: nextSessionResumeSupported }
      : {}),
    ...(nextSessionResumeReady !== undefined ? { sessionResumeReady: nextSessionResumeReady } : {}),
    source: nextSource,
    lastUpdatedAt: params.now,
  };
  return next;
}

/** Create a pending identity from an ensure-session handle. */
export function createIdentityFromEnsure(params: {
  handle: AcpRuntimeHandle;
  now: number;
}): SessionAcpIdentity | undefined {
  return buildSessionIdentity({
    ids: readIdentityIdsFromHandle(params.handle),
    capability: readRuntimeCapabilityFromHandle(params.handle),
    state: "pending",
    source: "ensure",
    now: params.now,
  });
}

/** Create an identity from a runtime event handle. */
export function createIdentityFromHandleEvent(params: {
  handle: AcpRuntimeHandle;
  now: number;
}): SessionAcpIdentity | undefined {
  const ids = readIdentityIdsFromHandle(params.handle);
  return buildSessionIdentity({
    ids,
    capability: readRuntimeCapabilityFromHandle(params.handle),
    state: ids.acpxSessionId || ids.agentSessionId ? "resolved" : "pending",
    source: "event",
    now: params.now,
  });
}

/** Create an identity from runtime status output. */
export function createIdentityFromStatus(params: {
  status: AcpRuntimeStatus | undefined;
  now: number;
}): SessionAcpIdentity | undefined {
  if (!params.status) {
    return undefined;
  }
  const details = params.status.details;
  const acpxRecordId =
    normalizeText((params.status as { acpxRecordId?: unknown }).acpxRecordId) ??
    normalizeText(details?.acpxRecordId);
  const acpxSessionId =
    normalizeText(params.status.backendSessionId) ??
    normalizeText(details?.backendSessionId) ??
    normalizeText(details?.acpxSessionId);
  const agentSessionId =
    normalizeText(params.status.agentSessionId) ?? normalizeText(details?.agentSessionId);
  const sessionResumeSupported =
    normalizeOptionalBoolean(params.status.sessionResumeSupported) ??
    normalizeOptionalBoolean(details?.sessionResumeSupported);
  if (!acpxRecordId && !acpxSessionId && !agentSessionId && sessionResumeSupported === undefined) {
    return undefined;
  }
  const resolved = Boolean(acpxSessionId || agentSessionId);
  return {
    state: resolved ? "resolved" : "pending",
    ...(acpxRecordId ? { acpxRecordId } : {}),
    ...(acpxSessionId ? { acpxSessionId } : {}),
    ...(agentSessionId ? { agentSessionId } : {}),
    ...(sessionResumeSupported !== undefined ? { sessionResumeSupported } : {}),
    source: "status",
    lastUpdatedAt: params.now,
  };
}

/** Convert ACP identity observations into runtime handle fields. */
export function resolveRuntimeHandleIdentifiersFromIdentity(
  identity: SessionAcpIdentity | undefined,
): { backendSessionId?: string; agentSessionId?: string; sessionResumeSupported?: boolean } {
  if (!identity) {
    return {};
  }
  return {
    ...(identity.acpxSessionId ? { backendSessionId: identity.acpxSessionId } : {}),
    ...(identity.agentSessionId ? { agentSessionId: identity.agentSessionId } : {}),
    ...(identity.sessionResumeSupported !== undefined
      ? { sessionResumeSupported: identity.sessionResumeSupported }
      : {}),
  };
}
