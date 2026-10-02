/** Commits the durable one-shot continuation fence after a completed turn. */
import { resolveSessionIdentityFromMeta } from "@openclaw/acp-core/runtime/session-identity";
import { AcpRuntimeError } from "../runtime/errors.js";
import {
  isSameAcpSessionIdentityGeneration,
  resolveAcpOneShotReadinessTarget,
  resolveDurableAcpOneShotResume,
} from "../session-resume.js";
import type { AcpRunTurnInput, SessionAcpMeta, WriteManagerSessionMeta } from "./manager.types.js";

/**
 * A completed one-shot is externally effective, so its resume readiness must be durable before
 * liveness, success, or idle state is exposed. The mutation re-checks the identity generation
 * and the target resume id, so a stale or replaced generation can never be marked ready.
 */
export async function commitManagerOneShotResumeReadiness(params: {
  cfg: AcpRunTurnInput["cfg"];
  sessionKey: string;
  agentId: string;
  backend: string | undefined;
  meta: SessionAcpMeta;
  writeSessionMeta: WriteManagerSessionMeta;
}): Promise<SessionAcpMeta> {
  const target = resolveAcpOneShotReadinessTarget({
    meta: params.meta,
    backend: params.backend,
    terminal: { status: "completed", cancelled: false },
  });
  if (!target) {
    return params.meta;
  }
  const readyAt = Date.now();
  let readinessApplied = false;
  const persisted = await params.writeSessionMeta({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    failOnError: true,
    skipMaintenance: true,
    takeCacheOwnership: true,
    mutate: (current, entry) => {
      const currentIdentity = resolveSessionIdentityFromMeta(current);
      const currentTarget = current
        ? resolveAcpOneShotReadinessTarget({
            meta: current,
            backend: target.backend,
            terminal: { status: "completed", cancelled: false },
          })
        : undefined;
      if (
        !entry ||
        !current ||
        !currentIdentity ||
        !isSameAcpSessionIdentityGeneration({ expected: params.meta, current }) ||
        currentTarget?.resumeSessionId !== target.resumeSessionId
      ) {
        return undefined;
      }
      readinessApplied = true;
      return {
        ...current,
        identity: {
          ...currentIdentity,
          sessionResumeReady: true,
          lastUpdatedAt: readyAt,
        },
        lastActivityAt: readyAt,
      };
    },
  });
  const persistedMeta = persisted?.acp;
  const persistedTarget = persistedMeta
    ? resolveDurableAcpOneShotResume({
        meta: persistedMeta,
        backend: target.backend,
      })
    : undefined;
  if (
    !readinessApplied ||
    persistedTarget?.resumeSessionId !== target.resumeSessionId ||
    !persistedMeta
  ) {
    throw new AcpRuntimeError(
      "ACP_TURN_FAILED",
      "Could not persist ACP one-shot resume readiness after the completed turn.",
    );
  }
  return persistedMeta;
}
