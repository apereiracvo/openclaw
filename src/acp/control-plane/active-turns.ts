/** Process-local active-turn registry for ACP maintenance and recovery decisions. */
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { normalizeActorKey } from "./manager.utils.js";

// Process-local liveness signal for in-flight ACP prompt turns, kept off the
// SDK-exported AcpSessionManager so plugins cannot read this maintenance-only
// state. Mirrors cron's active-jobs registry: task maintenance asks "is a turn
// still running for this session?" to avoid reclaiming a live run whose persisted
// session entry survived a crash. The AcpSessionManager marks/clears it in lockstep
// with its in-memory turn map.

type AcpActiveTurnState = {
  activeTurnKeys: Set<string>;
  admissionsBySession: Map<string, { ownerKey: string; admissionId: string; expiresAt: number }>;
};

const ACP_TURN_ADMISSION_LEASE_MS = 60_000;

const ACP_ACTIVE_TURN_STATE_KEY = Symbol.for("openclaw.acp.activeTurns");

function getAcpActiveTurnState(): AcpActiveTurnState {
  const state = resolveGlobalSingleton<AcpActiveTurnState>(ACP_ACTIVE_TURN_STATE_KEY, () => ({
    activeTurnKeys: new Set<string>(),
    admissionsBySession: new Map(),
  }));
  // Preserve hot-reload compatibility with a registry created before admissions existed.
  state.admissionsBySession ??= new Map();
  return state;
}

/** Atomically reserves one owner-bound ACP turn admission before Gateway dispatch. */
export function reserveAcpTurnAdmission(params: {
  sessionKey: string;
  ownerKey: string;
  admissionId: string;
  now?: number;
}): boolean {
  if (!params.sessionKey || !params.ownerKey || !params.admissionId) {
    return false;
  }
  const state = getAcpActiveTurnState();
  const sessionKey = normalizeActorKey(params.sessionKey);
  const now = params.now ?? Date.now();
  const existing = state.admissionsBySession.get(sessionKey);
  if (existing && existing.expiresAt <= now) {
    state.admissionsBySession.delete(sessionKey);
  }
  if (state.activeTurnKeys.has(sessionKey) || state.admissionsBySession.has(sessionKey)) {
    return false;
  }
  state.admissionsBySession.set(sessionKey, {
    ownerKey: normalizeActorKey(params.ownerKey),
    admissionId: params.admissionId,
    expiresAt: now + ACP_TURN_ADMISSION_LEASE_MS,
  });
  return true;
}

/** Releases an exact owner-bound admission after dispatch fails or is abandoned. */
export function releaseAcpTurnAdmission(params: {
  sessionKey: string;
  ownerKey: string;
  admissionId: string;
}): void {
  if (!params.sessionKey || !params.ownerKey || !params.admissionId) {
    return;
  }
  const state = getAcpActiveTurnState();
  const sessionKey = normalizeActorKey(params.sessionKey);
  const existing = state.admissionsBySession.get(sessionKey);
  if (
    existing?.ownerKey === normalizeActorKey(params.ownerKey) &&
    existing.admissionId === params.admissionId
  ) {
    state.admissionsBySession.delete(sessionKey);
  }
}

/** Marks a session as currently running an ACP turn. */
export function markAcpTurnActive(sessionKey: string, admissionId?: string) {
  if (!sessionKey) {
    return;
  }
  const state = getAcpActiveTurnState();
  const actorKey = normalizeActorKey(sessionKey);
  if (admissionId && state.admissionsBySession.get(actorKey)?.admissionId === admissionId) {
    state.admissionsBySession.delete(actorKey);
  }
  state.activeTurnKeys.add(actorKey);
}

/** Clears the active-turn marker for a session. */
export function clearAcpTurnActive(sessionKey: string) {
  if (!sessionKey) {
    return;
  }
  getAcpActiveTurnState().activeTurnKeys.delete(normalizeActorKey(sessionKey));
}

/** Returns whether the process currently owns an in-flight ACP turn for a session. */
export function isAcpTurnActive(sessionKey: string): boolean {
  if (!sessionKey) {
    return false;
  }
  return getAcpActiveTurnState().activeTurnKeys.has(normalizeActorKey(sessionKey));
}
