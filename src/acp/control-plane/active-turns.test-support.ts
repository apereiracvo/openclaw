/** Test-only access to the process-global ACP active-turn registry. */
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

type AcpActiveTurnState = {
  activeTurnKeys: Set<string>;
  admissionsBySession: Map<string, unknown>;
};

const ACP_ACTIVE_TURN_STATE_KEY = Symbol.for("openclaw.acp.activeTurns");

export function resetAcpActiveTurnsForTests(): void {
  const state = resolveGlobalSingleton<AcpActiveTurnState>(ACP_ACTIVE_TURN_STATE_KEY, () => ({
    activeTurnKeys: new Set<string>(),
    admissionsBySession: new Map(),
  }));
  state.activeTurnKeys.clear();
  state.admissionsBySession.clear();
}
