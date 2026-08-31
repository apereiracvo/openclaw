/** Process-local active-turn registry for ACP maintenance and recovery decisions. */
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { AcpSessionTarget } from "./manager.types.js";
import { acpSessionActorKey, resolveAcpAgentFromSessionKey } from "./manager.utils.js";

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
  state.admissionsBySession ??= new Map();
  return state;
}

function resolveAcpTurnKey(target: AcpSessionTarget | string): string {
  if (typeof target === "string") {
    if (!target) {
      return "";
    }
    return acpSessionActorKey({
      sessionKey: target,
      agentId: resolveAcpAgentFromSessionKey(target),
    });
  }
  return target.sessionKey ? acpSessionActorKey(target) : "";
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
  const actorKey = resolveAcpTurnKey(params.sessionKey);
  const now = params.now ?? Date.now();
  const existing = state.admissionsBySession.get(actorKey);
  if (existing && existing.expiresAt <= now) {
    state.admissionsBySession.delete(actorKey);
  }
  if (state.activeTurnKeys.has(actorKey) || state.admissionsBySession.has(actorKey)) {
    return false;
  }
  state.admissionsBySession.set(actorKey, {
    ownerKey: params.ownerKey,
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
  const actorKey = resolveAcpTurnKey(params.sessionKey);
  const existing = state.admissionsBySession.get(actorKey);
  if (existing?.ownerKey === params.ownerKey && existing.admissionId === params.admissionId) {
    state.admissionsBySession.delete(actorKey);
  }
}

/** Marks a session as currently running an ACP turn. */
export function markAcpTurnActive(target: AcpSessionTarget, admissionId?: string): void;
export function markAcpTurnActive(sessionKey: string, admissionId?: string): void;
export function markAcpTurnActive(target: AcpSessionTarget | string, admissionId?: string): void {
  const actorKey = resolveAcpTurnKey(target);
  if (!actorKey) {
    return;
  }
  const state = getAcpActiveTurnState();
  if (admissionId && state.admissionsBySession.get(actorKey)?.admissionId === admissionId) {
    state.admissionsBySession.delete(actorKey);
  }
  state.activeTurnKeys.add(actorKey);
}

/** Clears the active-turn marker for a session. */
export function clearAcpTurnActive(target: AcpSessionTarget): void;
export function clearAcpTurnActive(sessionKey: string): void;
export function clearAcpTurnActive(target: AcpSessionTarget | string): void {
  const actorKey = resolveAcpTurnKey(target);
  if (actorKey) {
    getAcpActiveTurnState().activeTurnKeys.delete(actorKey);
  }
}

/** Returns whether the process currently owns an in-flight ACP turn for a session. */
export function isAcpTurnActive(target: AcpSessionTarget): boolean;
export function isAcpTurnActive(sessionKey: string): boolean;
export function isAcpTurnActive(target: AcpSessionTarget | string): boolean {
  const actorKey = resolveAcpTurnKey(target);
  return Boolean(actorKey) && getAcpActiveTurnState().activeTurnKeys.has(actorKey);
}
