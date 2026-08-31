/** Reconciles ACP runtime identity observations back into persisted session metadata. */
import {
  createIdentityFromHandleEvent,
  createIdentityFromStatus,
  identityEquals,
  mergeSessionIdentity,
  resolveRuntimeHandleIdentifiersFromIdentity,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import type {
  AcpRuntime,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
} from "@openclaw/acp-core/runtime/types";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { AcpRuntimeError, withAcpRuntimeErrorBoundary } from "../runtime/errors.js";
import {
  isSameAcpSessionIdentityGeneration,
  resolveAcpOneShotReadinessTarget,
} from "../session-resume.js";
import { isAcpOwnerRepairRequired } from "./manager.runtime-owner.js";
import type { AcpSessionTarget, SessionAcpMeta, SessionEntry } from "./manager.types.js";
import { hasLegacyAcpIdentityProjection } from "./manager.utils.js";

const ACP_FINAL_STATUS_TIMEOUT_MS = 5_000;
const ACP_FINAL_STATUS_TIMEOUT_DETAIL_CODE = "FINAL_STATUS_TIMEOUT";

function applyIdentityToRuntimeHandle(
  handle: AcpRuntimeHandle,
  identity: ReturnType<typeof resolveSessionIdentityFromMeta>,
): AcpRuntimeHandle {
  const identifiers = resolveRuntimeHandleIdentifiersFromIdentity(identity);
  if (
    identifiers.backendSessionId === handle.backendSessionId &&
    identifiers.agentSessionId === handle.agentSessionId
  ) {
    return handle;
  }
  return {
    ...handle,
    ...(identifiers.backendSessionId ? { backendSessionId: identifiers.backendSessionId } : {}),
    ...(identifiers.agentSessionId ? { agentSessionId: identifiers.agentSessionId } : {}),
  };
}

async function readBoundedManagerRuntimeStatus(params: {
  sessionKey: string;
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
}): Promise<AcpRuntimeStatus> {
  const controller = new AbortController();
  const statusPromise = params.runtime.getStatus!({
    handle: params.handle,
    signal: controller.signal,
  }).then(
    (status) => ({ kind: "value" as const, status }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );
  const timeoutToken = Symbol("acp-final-status-timeout");
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<typeof timeoutToken>((resolve) => {
    timer = setTimeout(() => resolve(timeoutToken), ACP_FINAL_STATUS_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([statusPromise, timeoutPromise]);
    if (outcome === timeoutToken) {
      controller.abort();
      void statusPromise.then((lateOutcome) => {
        if (lateOutcome.kind === "error") {
          logVerbose(
            `acp-manager: detached late final status error for ${params.sessionKey}: ${String(lateOutcome.error)}`,
          );
        }
      });
      throw new AcpRuntimeError(
        "ACP_TURN_FAILED",
        "ACP final runtime status reconciliation timed out.",
        { detailCode: ACP_FINAL_STATUS_TIMEOUT_DETAIL_CODE },
      );
    }
    if (outcome.kind === "error") {
      throw outcome.error;
    }
    return outcome.status;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** Reconciles runtime-reported session identifiers into persisted ACP session metadata. */
export async function reconcileManagerRuntimeSessionIdentifiers(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  meta: SessionAcpMeta;
  runtimeStatus?: AcpRuntimeStatus;
  failOnStatusError: boolean;
  setCachedHandle: (target: AcpSessionTarget, handle: AcpRuntimeHandle) => void;
  writeSessionMeta: (params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    agentId: string;
    mutate: (
      current: SessionAcpMeta | undefined,
      entry: SessionEntry | undefined,
    ) => SessionAcpMeta | null | undefined;
    failOnError?: boolean;
  }) => Promise<SessionEntry | null>;
}): Promise<{
  handle: AcpRuntimeHandle;
  meta: SessionAcpMeta;
  runtimeStatus?: AcpRuntimeStatus;
}> {
  let runtimeStatus = params.runtimeStatus;
  if (!runtimeStatus && params.runtime.getStatus) {
    try {
      runtimeStatus = await withAcpRuntimeErrorBoundary({
        run: async () =>
          params.failOnStatusError
            ? await readBoundedManagerRuntimeStatus({
                sessionKey: params.sessionKey,
                runtime: params.runtime,
                handle: params.handle,
              })
            : await params.runtime.getStatus!({
                handle: params.handle,
              }),
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not read ACP runtime status.",
      });
    } catch (error) {
      if (params.failOnStatusError || isAcpOwnerRepairRequired(error)) {
        throw error;
      }
      logVerbose(
        `acp-manager: failed to refresh ACP runtime status for ${params.sessionKey}: ${String(error)}`,
      );
      return {
        handle: params.handle,
        meta: params.meta,
        runtimeStatus,
      };
    }
  }

  const now = Date.now();
  const expectedIdentity = resolveSessionIdentityFromMeta(params.meta);
  const eventIdentity = createIdentityFromHandleEvent({
    handle: params.handle,
    now,
  });
  const statusIdentity = createIdentityFromStatus({
    status: runtimeStatus,
    now,
  });
  const identityAfterExpectedEvent =
    mergeSessionIdentity({
      current: expectedIdentity,
      incoming: eventIdentity,
      now,
    }) ?? expectedIdentity;
  const observedIdentity =
    mergeSessionIdentity({
      current: identityAfterExpectedEvent,
      incoming: statusIdentity,
      now,
    }) ?? identityAfterExpectedEvent;
  const observationChanged =
    !identityEquals(expectedIdentity, observedIdentity) ||
    hasLegacyAcpIdentityProjection(params.meta);
  const mustFenceReadinessGeneration =
    params.failOnStatusError &&
    resolveAcpOneShotReadinessTarget({
      meta: params.meta,
      backend: params.handle.backend || params.meta.backend,
      terminal: { status: "completed", cancelled: false },
    }) !== undefined;
  if (!observationChanged && !mustFenceReadinessGeneration) {
    const nextHandle = applyIdentityToRuntimeHandle(params.handle, expectedIdentity);
    if (nextHandle !== params.handle) {
      params.setCachedHandle(params, nextHandle);
    }
    return {
      handle: nextHandle,
      meta: params.meta,
      runtimeStatus,
    };
  }
  let generationRejected = false;
  const persisted = await params.writeSessionMeta({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    mutate: (current, entry) => {
      if (!entry || !current) {
        return null;
      }
      const sameGeneration = isSameAcpSessionIdentityGeneration({
        expected: params.meta,
        current,
      });
      const currentIdentity = resolveSessionIdentityFromMeta(current);
      const generationChanged = expectedIdentity
        ? !sameGeneration
        : current.backend !== params.meta.backend || currentIdentity !== undefined;
      if (generationChanged) {
        if (params.failOnStatusError && params.meta.mode === "oneshot") {
          generationRejected = true;
          return undefined;
        }
        return current;
      }
      const identityAfterEvent =
        mergeSessionIdentity({
          current: currentIdentity,
          incoming: eventIdentity,
          now,
        }) ?? currentIdentity;
      const nextIdentity =
        mergeSessionIdentity({
          current: identityAfterEvent,
          incoming: statusIdentity,
          now,
        }) ?? identityAfterEvent;
      if (
        identityEquals(currentIdentity, nextIdentity) &&
        !hasLegacyAcpIdentityProjection(current)
      ) {
        return current;
      }
      return {
        backend: current.backend,
        agent: current.agent,
        runtimeSessionName: current.runtimeSessionName,
        ...(nextIdentity ? { identity: nextIdentity } : {}),
        mode: current.mode,
        ...(current.runtimeOptions ? { runtimeOptions: current.runtimeOptions } : {}),
        ...(current.cwd ? { cwd: current.cwd } : {}),
        state: current.state,
        lastActivityAt: now,
        ...(current.lastError ? { lastError: current.lastError } : {}),
      };
    },
    failOnError: params.failOnStatusError,
  });
  const persistedMeta = persisted?.acp;
  if (
    params.failOnStatusError &&
    params.meta.mode === "oneshot" &&
    (!persistedMeta || generationRejected)
  ) {
    throw new AcpRuntimeError(
      "ACP_TURN_FAILED",
      generationRejected
        ? "ACP session identity changed before completed-turn reconciliation could be persisted."
        : "Could not persist reconciled ACP runtime identity after the completed turn.",
    );
  }
  const actualMeta = persistedMeta ?? params.meta;
  const actualIdentity = resolveSessionIdentityFromMeta(actualMeta);
  const nextHandle = applyIdentityToRuntimeHandle(params.handle, actualIdentity);
  if (nextHandle !== params.handle) {
    params.setCachedHandle(params, nextHandle);
  }
  if (!identityEquals(expectedIdentity, actualIdentity)) {
    logVerbose(`acp-manager: session identity updated for ${params.sessionKey}`);
  }
  return {
    handle: nextHandle,
    meta: actualMeta,
    runtimeStatus,
  };
}
