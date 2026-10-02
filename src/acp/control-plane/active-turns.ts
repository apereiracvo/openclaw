/** Process-local active-turn registry for restart draining and ACP child admission. */
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { AcpSessionTarget } from "./manager.types.js";
import { acpSessionActorKey, resolveAcpAgentFromSessionKey } from "./manager.utils.js";

type AcpActiveTurnEntry = {
  token: symbol;
  sessionKey: string;
  ownerSessionKey?: string;
};

/** Turn-registration target; a bare key resolves its agent from the key itself. */
type AcpActiveTurnTarget = (AcpSessionTarget & { ownerSessionKey?: string }) | string;

type AcpActiveTurnState = {
  activeTurnKeys: Map<string, AcpActiveTurnEntry>;
  admissionsBySession: Map<string, { ownerKey: string; admissionId: string; expiresAt: number }>;
};

const ACP_TURN_ADMISSION_LEASE_MS = 60_000;

const ACP_ACTIVE_TURN_STATE_KEY = Symbol.for("openclaw.acp.activeTurns");

function getAcpActiveTurnState(): AcpActiveTurnState {
  const state = resolveGlobalSingleton<AcpActiveTurnState>(ACP_ACTIVE_TURN_STATE_KEY, () => ({
    activeTurnKeys: new Map<string, AcpActiveTurnEntry>(),
    admissionsBySession: new Map(),
  }));
  state.admissionsBySession ??= new Map();
  return state;
}

function resolveAcpTurnKey(target: AcpActiveTurnTarget): string {
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

/** Registers the current turn and returns its ownership-checked release callback. */
export function markAcpTurnActive(
  target: AcpSessionTarget & { ownerSessionKey?: string },
  admissionId?: string,
): (() => void) | undefined;
export function markAcpTurnActive(
  sessionKey: string,
  admissionId?: string,
): (() => void) | undefined;
export function markAcpTurnActive(
  target: AcpActiveTurnTarget,
  admissionId?: string,
): (() => void) | undefined {
  const actorKey = resolveAcpTurnKey(target);
  if (!actorKey) {
    return undefined;
  }
  const state = getAcpActiveTurnState();
  if (admissionId && state.admissionsBySession.get(actorKey)?.admissionId === admissionId) {
    state.admissionsBySession.delete(actorKey);
  }
  const owner = Symbol("acp-active-turn");
  state.activeTurnKeys.set(actorKey, {
    token: owner,
    sessionKey: typeof target === "string" ? target : target.sessionKey,
    ownerSessionKey: typeof target === "string" ? undefined : target.ownerSessionKey,
  });
  return () => {
    if (state.activeTurnKeys.get(actorKey)?.token === owner) {
      state.activeTurnKeys.delete(actorKey);
    }
  };
}

/** Clears the active-turn marker for a session. */
export function clearAcpTurnActive(target: AcpSessionTarget): void;
export function clearAcpTurnActive(sessionKey: string): void;
export function clearAcpTurnActive(target: AcpActiveTurnTarget): void {
  const actorKey = resolveAcpTurnKey(target);
  if (actorKey) {
    getAcpActiveTurnState().activeTurnKeys.delete(actorKey);
  }
}

/** Returns whether the process currently owns an in-flight ACP turn for a session. */
export function isAcpTurnActive(target: AcpSessionTarget): boolean;
export function isAcpTurnActive(sessionKey: string): boolean;
export function isAcpTurnActive(target: AcpActiveTurnTarget): boolean {
  const actorKey = resolveAcpTurnKey(target);
  return Boolean(actorKey) && getAcpActiveTurnState().activeTurnKeys.has(actorKey);
}

/** Number of currently owned ACP turns that must settle before restart. */
export function getActiveAcpTurnCount(): number {
  return getAcpActiveTurnState().activeTurnKeys.size;
}

export function listActiveAcpSessionsForOwner(ownerSessionKey: string): string[] {
  return [...getAcpActiveTurnState().activeTurnKeys.values()]
    .filter((turn) => turn.ownerSessionKey === ownerSessionKey)
    .map((turn) => turn.sessionKey);
}
