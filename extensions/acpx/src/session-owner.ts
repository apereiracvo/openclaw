import { decodeAcpxRuntimeHandleState } from "acpx/runtime";
import { AcpRuntimeError, type AcpRuntimeHandle } from "../runtime-api.js";
import { resolveAcpxSessionResource } from "./session-resource.js";
export { resolveAcpxSessionResource } from "./session-resource.js";

function requireAcpxOwnerMigration(sessionKey: string): never {
  throw new AcpRuntimeError(
    "ACP_SESSION_INIT_FAILED",
    `ACP session "${sessionKey}" has an unqualified or unverifiable backend locator. Stop the Gateway and run "openclaw doctor --fix" to migrate ownership without losing history, then restart.`,
    { detailCode: "SESSION_OWNER_MIGRATION_REQUIRED" },
  );
}

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function isExplicitOneShotResumeRecord(
  resource: string,
  persisted: AcpRuntimeHandle,
  decoded: ReturnType<typeof decodeAcpxRuntimeHandleState>,
): boolean {
  const recordId = persisted.acpxRecordId;
  const backendSessionId = persisted.backendSessionId;
  const prefix = `${resource}:oneshot-resume:`;
  return Boolean(
    recordId &&
    backendSessionId &&
    decoded?.mode === "persistent" &&
    decoded.name === recordId &&
    decoded.acpxRecordId === recordId &&
    decoded.backendSessionId === backendSessionId &&
    recordId.startsWith(prefix) &&
    UUID.test(recordId.slice(prefix.length)),
  );
}

export function assertAcpxSessionOwnerLocator(
  target: {
    sessionKey: string;
    agentId?: string;
    persistedHandle?: AcpRuntimeHandle;
  },
  legacyBareSessionKeys?: ReadonlySet<string>,
): string {
  const resource = resolveAcpxSessionResource(target);
  const qualified = resource === target.sessionKey.trim().toLowerCase();
  const persisted = target.persistedHandle;
  // A legacy raw key can spell the new resource digest. Existing resources need
  // canonical locator evidence; their filename alone cannot prove ownership.
  if (
    !qualified &&
    (legacyBareSessionKeys?.has(target.sessionKey.trim().toLowerCase()) ||
      (legacyBareSessionKeys?.has(resource) && !persisted))
  ) {
    requireAcpxOwnerMigration(target.sessionKey);
  }
  if (persisted) {
    const decoded = decodeAcpxRuntimeHandleState(persisted.runtimeSessionName);
    const explicitOneShotResume = isExplicitOneShotResumeRecord(resource, persisted, decoded);
    if (
      (!qualified && !decoded) ||
      (decoded &&
        ((decoded.name !== resource && !explicitOneShotResume) ||
          (persisted.acpxRecordId && decoded.acpxRecordId !== persisted.acpxRecordId)))
    ) {
      requireAcpxOwnerMigration(target.sessionKey);
    }
  }
  return resource;
}

/** Preserve physical oneshot record IDs and the upstream-encoded runtime handle. */
export function toAcpxResourceInput<T extends { handle: AcpRuntimeHandle }>(input: T): T {
  const sessionKey = assertAcpxSessionOwnerLocator({
    ...input.handle,
    persistedHandle: input.handle,
  });
  return { ...input, handle: { ...input.handle, sessionKey } };
}
