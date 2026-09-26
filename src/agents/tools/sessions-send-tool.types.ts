import type {
  isAcpTurnActive,
  releaseAcpTurnAdmission,
  reserveAcpTurnAdmission,
} from "../../acp/control-plane/active-turns.js";
import type { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { isAcpChildSessionOwnedBy } from "../../tasks/task-owner-access.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";

export type SessionsSendToolOptions = {
  agentId?: string;
  agentSessionKey?: string;
  agentSessionId?: string;
  agentChannel?: string;
  requesterOrigin?: DeliveryContext;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: AgentToolGatewayRequestCaller;
  /** Backend-derived target incarnation; never sourced from model arguments. */
  expectedTargetSessionId?: string;
  /** Backend-owned downstream operation id; never sourced from model arguments. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Test seams for process-local ACP one-shot follow-up admission. */
  isAcpTurnActive?: typeof isAcpTurnActive;
  reserveAcpTurnAdmission?: typeof reserveAcpTurnAdmission;
  releaseAcpTurnAdmission?: typeof releaseAcpTurnAdmission;
  readAcpSessionMeta?: typeof readAcpSessionMeta;
  /** Test seam for authoritative task-registry ACP child ownership. */
  isAcpChildSessionOwnedBy?: typeof isAcpChildSessionOwnedBy;
};
