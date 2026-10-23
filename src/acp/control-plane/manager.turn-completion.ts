import type {
  AcpRuntime,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
} from "@openclaw/acp-core/runtime/types";
import { recordSubagentTerminalState } from "../../sessions/subagent-terminal-state.js";
import { AcpRuntimeError, toAcpRuntimeError } from "../runtime/errors.js";
import { commitManagerOneShotResumeReadiness } from "./manager.one-shot-readiness.js";
import {
  consumeAcpTurnStream,
  readAcpTurnStreamFailure,
  throwAcpTurnStreamFailure,
} from "./manager.turn-stream.js";
import type {
  AcpRunTurnInput,
  ActiveTurnState,
  ReconcileManagerRuntimeSessionIdentifiers,
  SessionAcpMeta,
  SetManagerSessionState,
  WriteManagerSessionMeta,
} from "./manager.types.js";

type TurnRuntime = { runtime: AcpRuntime; handle: AcpRuntimeHandle; meta: SessionAcpMeta };
type TurnOutcome = Awaited<ReturnType<typeof consumeAcpTurnStream>>;

/** Attempt-local terminal evidence and deferred publication; the manager retains turn custody. */
export function createManagerTurnCompletion(params: {
  input: AcpRunTurnInput;
  sessionKey: string;
  agentId: string;
  reconcileRuntimeSessionIdentifiers: ReconcileManagerRuntimeSessionIdentifiers;
  writeSessionMeta: WriteManagerSessionMeta;
  isCurrentActor: () => boolean;
  assertSignalCurrent: () => void;
  assertActorCurrent: () => void;
  assertModelCurrent: () => void;
  assertModelSignal: () => void;
  freezeAbort: () => void;
  updateRuntimeState: (state: Pick<TurnRuntime, "handle" | "meta">) => void;
  cancellationCleanupFailed: (error: unknown) => never;
}) {
  const { input, sessionKey, agentId } = params;
  let turnTerminal = false;
  const markTerminal = () => {
    turnTerminal = true;
    params.freezeAbort();
  };
  let terminalStatus: TurnOutcome["terminalStatus"];
  let pendingCompletedEvent: Extract<AcpRuntimeEvent, { type: "done" }> | undefined;
  let finalReconciliationAttempted = false;
  const reconcileCompleted = async (state: TurnRuntime) => {
    const { runtime } = state;
    let { handle, meta } = state;
    finalReconciliationAttempted = true;
    ({ handle, meta } = await params.reconcileRuntimeSessionIdentifiers({
      cfg: input.cfg,
      sessionKey,
      agentId,
      runtime,
      handle,
      meta,
      failOnStatusError: true,
      isCurrentActor: params.isCurrentActor,
      assertCurrent: params.assertSignalCurrent,
    }));
    params.updateRuntimeState({ handle, meta });
    meta = await commitManagerOneShotResumeReadiness({
      cfg: input.cfg,
      sessionKey,
      agentId,
      backend: handle.backend || meta.backend,
      meta,
      writeSessionMeta: (write) =>
        params.writeSessionMeta({
          ...write,
          isCurrentActor: params.isCurrentActor,
          assertCommitAllowed: params.assertSignalCurrent,
        }),
    });
    params.updateRuntimeState({ handle, meta });
    return { handle, meta };
  };
  return {
    markTerminal,
    get turnTerminal() {
      return turnTerminal;
    },
    get finalReconciliationAttempted() {
      return finalReconciliationAttempted;
    },
    get terminalStatus() {
      return terminalStatus;
    },
    onEvent: async (event: AcpRuntimeEvent) => {
      if (event.type === "done") {
        markTerminal();
      }
      params.assertModelSignal();
      if (params.isCurrentActor()) {
        // Keep completion private until final status and durable readiness settle.
        // Cancellation and nonterminal events retain their existing streaming boundary.
        if (event.type === "done" && event.status === "completed") {
          terminalStatus = "completed";
          pendingCompletedEvent = event;
          return;
        }
        try {
          await input.onEvent?.(event);
        } catch (error) {
          params.cancellationCleanupFailed(error);
        }
      }
    },
    finish: async (state: TurnRuntime, turnOutcome: TurnOutcome) => {
      const { runtime } = state;
      let { handle, meta } = state;
      terminalStatus = turnOutcome.terminalStatus;
      params.assertActorCurrent();
      params.assertModelCurrent();
      if (!turnOutcome.terminalStatus) {
        throw new AcpRuntimeError(
          "ACP_TURN_FAILED",
          "ACP turn ended without a terminal done event.",
        );
      }
      const completedTerminalResult = terminalStatus === "completed";
      if (completedTerminalResult && meta.mode === "oneshot") {
        // A completed one-shot is already externally effective. Commit the continuation fence
        // before exposing liveness release, success, or idle state.
        ({ handle, meta } = await reconcileCompleted({ runtime, handle, meta }));
      }
      // Clear before the single awaited publication; observer failure must not replay it.
      if (completedTerminalResult && pendingCompletedEvent) {
        const event = pendingCompletedEvent;
        pendingCompletedEvent = undefined;
        try {
          params.assertSignalCurrent();
          params.assertModelCurrent();
          await input.onEvent?.(event);
        } catch (error) {
          try {
            params.cancellationCleanupFailed(error);
          } catch (failure) {
            throwAcpTurnStreamFailure(failure, turnOutcome);
          }
        }
      }
      return { handle, meta };
    },
    reconcileFailure: async (
      error: unknown,
      state: Partial<TurnRuntime>,
      activeTurnStarted: boolean,
    ) => {
      const streamFailure = readAcpTurnStreamFailure(error);
      let terminalFailure = streamFailure?.error ?? error;
      if (streamFailure) {
        terminalStatus = streamFailure.outcome.terminalStatus;
      }
      const { runtime, handle, meta } = state;
      if (
        terminalStatus === "completed" &&
        !finalReconciliationAttempted &&
        runtime &&
        handle &&
        meta?.mode === "oneshot"
      ) {
        // Preserve the completed generation after observer/drain failure without publishing
        // success, releasing failure liveness early, or permitting replay.
        try {
          await reconcileCompleted({ runtime, handle, meta });
        } catch (reconciliationError) {
          terminalFailure = reconciliationError;
        }
      }
      return {
        error: toAcpRuntimeError({
          error: terminalFailure,
          fallbackCode: activeTurnStarted ? "ACP_TURN_FAILED" : "ACP_SESSION_INIT_FAILED",
          fallbackMessage: activeTurnStarted
            ? "ACP turn failed before completion."
            : "Could not initialize ACP session runtime.",
        }),
        sawOutput: streamFailure?.outcome.sawOutput ?? false,
      };
    },
  };
}

export function createManagerTurnSettlement(params: {
  input: AcpRunTurnInput;
  sessionKey: string;
  agentId: string;
  getRequester: () => string | undefined;
  revalidateCancellation: () => Promise<unknown>;
  assertCancellationCurrent: () => void;
  assertActorCurrent: () => void;
  getCancellationControl: () => Parameters<SetManagerSessionState>[0]["acpControl"];
  setSessionState: SetManagerSessionState;
  isCurrentActor: () => boolean;
  cancellationCleanupFailed: (error: unknown) => never;
}) {
  const { input, sessionKey, agentId } = params;
  const recordTerminalState = async (
    outcomeStatus: Parameters<typeof recordSubagentTerminalState>[0]["outcomeStatus"],
    cancelling: boolean,
  ) => {
    if (cancelling) {
      await params.revalidateCancellation();
    }
    const spawnedByWatcher = params.getRequester();
    if (spawnedByWatcher) {
      await recordSubagentTerminalState(
        {
          childSessionKey: sessionKey,
          agentId,
          runId: input.requestId,
          requesterSessionKey: spawnedByWatcher,
          outcomeStatus,
        },
        cancelling ? params.assertCancellationCurrent : params.assertActorCurrent,
        cancelling ? params.getCancellationControl() : undefined,
      ).catch(params.cancellationCleanupFailed);
    }
  };
  return {
    recordTerminalState,
    settle: async (turn: {
      completed: boolean;
      cancelled: boolean;
      signal: AbortSignal;
      activeTurn: ActiveTurnState | undefined;
      activeTurnBySession: Map<string, ActiveTurnState>;
      actorKey: string;
      releaseActiveTurn: (() => void) | undefined;
      recordTurnCompletion: () => void;
      markTerminal: () => void;
    }) => {
      const { activeTurn, activeTurnBySession, actorKey, cancelled } = turn;
      const { assertCancellationCurrent } = params;
      const spawnedByWatcher = params.getRequester();
      if (turn.completed) {
        if (activeTurn && activeTurnBySession.get(actorKey) === activeTurn) {
          activeTurnBySession.delete(actorKey);
        }
        turn.releaseActiveTurn?.();
      }
      turn.recordTurnCompletion();
      turn.markTerminal();
      const cancelling = cancelled || turn.signal.aborted;
      if (cancelling || spawnedByWatcher) {
        await recordTerminalState(cancelled ? "cancelled" : "ok", cancelling);
      }
      if (spawnedByWatcher) {
        params.assertActorCurrent();
      }
      await params
        .setSessionState({
          cfg: input.cfg,
          sessionKey,
          agentId,
          isCurrentActor: params.isCurrentActor,
          state: "idle",
          clearLastError: true,
          ...(cancelling
            ? {
                assertCurrent: assertCancellationCurrent,
                acpControl: params.getCancellationControl(),
              }
            : {}),
        })
        .catch(params.cancellationCleanupFailed);
    },
  };
}
