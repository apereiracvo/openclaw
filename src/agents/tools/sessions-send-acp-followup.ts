import { isRequesterParentOfBackgroundAcpSession } from "@openclaw/acp-core/session-interaction-mode";
import {
  isAcpTurnActive,
  releaseAcpTurnAdmission,
  reserveAcpTurnAdmission,
} from "../../acp/control-plane/active-turns.js";
import { readAcpSessionMetaForEntryAsync } from "../../acp/runtime/session-meta-readonly.js";
import { resolveDurableAcpOneShotResume } from "../../acp/session-resume.js";
import type { SessionEntry, SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewaySessionStoreTargetWithStore } from "../../gateway/session-utils-store.types.js";
import { isAcpSessionKey } from "../../sessions/session-key-utils.js";
import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import { RESTART_RECOVERY_INTERRUPTION_NOTE } from "../restart-recovery-prompt.js";
import { isSubagentSessionFromEntry } from "../subagents/spawn/subagent-depth-policy.js";
import type { SessionsSendToolOptions } from "./sessions-send-tool.types.js";
import { jsonResult } from "./tool-results.js";

type AcpFollowupSeams = Pick<
  SessionsSendToolOptions,
  "isAcpTurnActive" | "reserveAcpTurnAdmission" | "releaseAcpTurnAdmission"
>;

export function readSessionsSendTargetAcpMeta(
  cfg: OpenClawConfig,
  target: Pick<GatewaySessionStoreTargetWithStore, "canonicalKey" | "agentId">,
  entry: SessionEntry | undefined,
  readAcpSessionMetaAsync?: SessionsSendToolOptions["readAcpSessionMetaAsync"],
) {
  const sessionKey = target.canonicalKey;
  const agentId = target.agentId;
  return readAcpSessionMetaAsync
    ? readAcpSessionMetaAsync({ sessionKey, agentId, cfg })
    : readAcpSessionMetaForEntryAsync({ sessionKey, agentId, cfg, entry });
}

/** The existing process-local reservation is deduplication, never continuation authority. */
export function prepareSessionsSendAcpFollowup(params: {
  targetSessionKey: string;
  targetSessionEntry: SessionEntry | undefined;
  targetAcpMeta: SessionAcpMeta | undefined;
  requesterSessionKey: string;
  resolvedKey: string;
  displayKey: string;
  runId: string;
  seams?: AcpFollowupSeams;
}) {
  const {
    targetSessionKey,
    targetSessionEntry,
    targetAcpMeta,
    requesterSessionKey,
    resolvedKey,
    displayKey,
    runId,
    seams,
  } = params;
  const parentOwnsAcpChild =
    isAcpSessionKey(targetSessionKey) &&
    (targetSessionEntry?.spawnedBy === requesterSessionKey ||
      targetSessionEntry?.parentSessionKey === requesterSessionKey);
  if (parentOwnsAcpChild && !targetAcpMeta) {
    return {
      ok: false as const,
      result: jsonResult({
        runId,
        status: "error",
        error:
          "Cannot continue this parent-owned ACP session because its authoritative durable ACP metadata is missing. This unverified or legacy session must be replaced with a new ACP run.",
        sessionKey: displayKey,
      }),
    };
  }
  const parentOwnsOneShot =
    isRequesterParentOfBackgroundAcpSession(
      targetSessionEntry ? { ...targetSessionEntry, acp: targetAcpMeta } : undefined,
      requesterSessionKey,
    ) &&
    (targetAcpMeta?.mode === "oneshot" || targetSessionEntry?.acp?.mode === "oneshot");
  const acpFollowupAdmission = {
    sessionKey: resolvedKey,
    ownerKey: requesterSessionKey,
    admissionId: runId,
  };
  let acpFollowupAdmissionHeld = false;
  if (parentOwnsOneShot) {
    if ((seams?.isAcpTurnActive ?? isAcpTurnActive)(resolvedKey)) {
      return {
        ok: false as const,
        result: jsonResult({
          runId,
          status: "error",
          error:
            "Cannot continue this ACP one-shot while its current turn is active. Wait for task completion, then retry sessions_send.",
          sessionKey: displayKey,
        }),
      };
    }
    if (
      !targetAcpMeta ||
      (targetSessionEntry?.acp?.backend &&
        targetSessionEntry.acp.backend !== targetAcpMeta.backend) ||
      !resolveDurableAcpOneShotResume({
        meta: targetAcpMeta,
        backend: targetAcpMeta.backend,
      })
    ) {
      return {
        ok: false as const,
        result: jsonResult({
          runId,
          status: "error",
          error:
            "Cannot continue this ACP one-shot because it is not a verified completed resumable session. Legacy, unsupported, unresolved, and not-ready sessions must be replaced with a new ACP run.",
          sessionKey: displayKey,
        }),
      };
    }
    acpFollowupAdmissionHeld = (seams?.reserveAcpTurnAdmission ?? reserveAcpTurnAdmission)(
      acpFollowupAdmission,
    );
    if (!acpFollowupAdmissionHeld) {
      return {
        ok: false as const,
        result: jsonResult({
          runId,
          status: "error",
          error:
            "Cannot continue this ACP one-shot while its current turn is active or another follow-up is being admitted. Wait for task completion, then retry sessions_send.",
          sessionKey: displayKey,
        }),
      };
    }
  }

  return {
    ok: true as const,
    parentOwnsOneShot,
    markAccepted: () => {
      // The ACP manager consumes the matching lease when admitting the turn.
      acpFollowupAdmissionHeld = false;
    },
    release: () => {
      if (acpFollowupAdmissionHeld) {
        (seams?.releaseAcpTurnAdmission ?? releaseAcpTurnAdmission)(acpFollowupAdmission);
      }
    },
  };
}

export async function readSessionsSendRequesterIsSubagent(
  cfg: OpenClawConfig,
  requester: Pick<GatewaySessionStoreTargetWithStore, "canonicalKey" | "agentId">,
  entry: SessionEntry | undefined,
) {
  return isSubagentSessionFromEntry(
    requester.canonicalKey,
    entry,
    await readAcpSessionMetaForEntryAsync({
      cfg,
      sessionKey: requester.canonicalKey,
      agentId: requester.agentId,
      entry,
    }),
  );
}

export function prepareSessionsSendRecoveryMessage(
  sessionKey: string,
  entry: SessionEntry | undefined,
  acp: SessionAcpMeta | undefined,
  message: string,
) {
  return !acp &&
    entry?.status === "interrupted" &&
    isSubagentSessionFromEntry(sessionKey, entry, acp)
    ? `${formatSystemTurnPrompt(RESTART_RECOVERY_INTERRUPTION_NOTE)}\n\n${message}`
    : message;
}
