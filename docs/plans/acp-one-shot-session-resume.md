# ACP One-Shot Session Resume Plan

## Goal

Allow the parent of a completed ACP child created by
`sessions_spawn({ runtime: "acp", mode: "run" })` to continue that exact child
with `sessions_send`, including after runtime-handle cache loss or Gateway
restart.

A resumed follow-up must keep the same:

- OpenClaw child session key and ownership;
- ACP protocol session ID and native harness conversation ID, when exposed;
- ACP backend and effective working directory;
- access scope, attribution, audit, task-completion delivery, and continuation
  behavior.

If OpenClaw cannot prove that exact continuation is safe, the send must fail.
It must not create a fresh harness conversation, retry without the resume ID, or
fail over to another backend.

PR [#107366](https://github.com/openclaw/openclaw/pull/107366) at
`c3f8914dec8` is design and test reference only. Rebase the idea onto the
current owners below; do not cherry-pick the PR or copy unrelated translator,
event-ledger, or superseded lease changes.

## Verified baseline (2026-08-30)

Reviewed against this checkout at `f0c04b7984d`, installed and pinned `acpx`
`0.13.1`, locally fetched `upstream/main` at `6e6319440e7`, and live upstream
`main` at `7515f08a5318`. The affected live-upstream files still match the
behavior described here.

### Already present and to be reused

- `sessions_spawn` already accepts an explicit `resumeSessionId`; the ACPX
  client resumes with `session/resume` or falls back to `session/load` only
  when the agent advertises it.
- ACP metadata already persists backend, runtime options, effective `cwd`, and
  the identity tuple (`acpxRecordId`, `acpxSessionId`, `agentSessionId`).
- Runtime reconstruction already refuses to reuse identity owned by a different
  backend.
- `isAcpTurnActive(sessionKey)` already provides live in-process concurrency
  state.
- Parent-owned ACP work already completes through the task notifier, and
  `sessions_send` already skips peer A2A ping-pong for the owning parent while
  preserving normal A2A behavior for unrelated authorized senders.
- Scoped session access, ownership checks, input provenance, participant
  recording, committed-action audit, expected-session fencing, and delivery
  routing already surround `sessions_send` dispatch.
- ACPX process-lease recreation and one-shot post-turn process/handle cleanup
  already exist. Resume must extend them, not replace them.

### Gap and stale assumptions

- `src/acp/control-plane/manager.runtime-handle-ensure.ts` supplies persisted
  resume identity only for `mode === "persistent"`; the focused runtime-handle
  test currently asserts that a one-shot omits `resumeSessionId`.
- `resolveRuntimeResumeSessionId()` currently prefers `agentSessionId` over
  `acpxSessionId`. ACPX 0.13.1 resumes the ACP protocol session ID stored as
  `acpSessionId`, so `acpxSessionId` must win; `agentSessionId` is only a legacy
  fallback.
- ACP metadata has no durable capability/readiness fence. A resolved ID or
  persisted `meta.state: "idle"` alone does not prove a completed one-shot can
  be resumed.
- Terminal identity reconciliation currently happens in `finally`, after task
  success can already be recorded. Readiness therefore is not durably ordered
  before completion/delivery.
- Every terminal or orphaned parent-owned one-shot is currently closed and its
  resume metadata removed by task maintenance.
- `sessions_send` does not distinguish a completed resumable one-shot from an
  active, unsupported, unresolved, or legacy one-shot.
- ACPX 0.13.1 uses `same-session-only` only for `persistent` mode; `oneshot`
  uses `allow-new` and a generated record ID. An explicit one-shot reconnect
  therefore needs a narrow adapter shim that uses ACPX's persistent
  same-session-only ensure semantics while OpenClaw metadata and ownership stay
  `oneshot`.
- `src/agents/tools/sessions-send-route.ts`,
  `src/tasks/task-registry.acp-session-lifecycle.ts`, and
  `extensions/acpx/src/runtime-session-ensure.ts` do not exist in the current
  checkout. Add small helpers only if they make the predicates testable; do not
  treat PR file layout as required architecture.
- Current docs accurately describe explicit spawn resume and existing
  parent-owned delivery, but still say maintenance closes all parent-owned
  one-shots. Update them only after behavior is proven.

## Safety contract

Use one shared resumability predicate everywhere:

```text
mode === "oneshot"
identity.state === "resolved"
identity.sessionResumeSupported === true
identity.sessionResumeReady === true
stable resume id exists
persisted identity belongs to meta.backend
```

Additional invariants:

1. `acpxSessionId` is the resume target when present; `agentSessionId` is a
   compatibility fallback only.
2. `sessionResumeReady` is written only after a completed, non-cancelled turn,
   bounded final status reconciliation, and confirmed resume support.
3. Readiness persistence is a terminal commit fence: it completes before task
   success, delivery, idle state, or active-turn release is exposed. If that
   write fails, the turn is failed and is not replayed.
4. An explicit one-shot resume is pinned to `meta.backend`. Any ensure or turn
   failure propagates without fresh retry or backend failover, even if no
   prompt/output was observed.
5. Live turn state decides concurrency. Persisted `meta.state` is diagnostic
   and may be stale across restart.
6. Unsupported, unresolved, cancelled, failed, pre-prompt, legacy, and
   not-ready one-shots are never retained or resumed by guesswork.
7. Keep normal one-shot process/handle cleanup after every turn. Retain only
   the durable metadata and backend conversation needed for a verified future
   resume.
8. Do not move resume routing outside existing scoped-access and ownership
   checks, and do not bypass existing provenance, audit, participant,
   expected-session, task, or delivery owners.

## Smallest implementation sequence

### 1. Add the durable contract and strict ACPX reconnect

Touch only the existing identity/runtime contracts and ACPX adapter, extracting
one focused helper if useful:

- `packages/acp-core/src/runtime/session-identity.ts`
- `packages/acp-core/src/runtime/types.ts`
- `packages/acp-core/src/types.ts`
- `extensions/acpx/src/runtime.ts`
- `extensions/acpx/src/runtime.test.ts`

Implement:

- Add `sessionResumeSupported?: boolean` to the runtime handle and persisted
  identity, plus `sessionResumeReady?: boolean` to persisted identity.
- Preserve both fields through normalization, equality, merge, ensure/event
  observations, and capability-only pending identity. A record ID alone remains
  provisional, not resumable.
- Change resume-ID precedence to `acpxSessionId`, then `agentSessionId`.
- After ACPX `ensureSession`, best-effort read that exact session record and set
  support when `agentCapabilities.sessionCapabilities.resume` is present or
  `agentCapabilities.loadSession === true`. A record-read failure may omit the
  capability but must not fail an otherwise valid initial session.
- For `mode: "oneshot"` plus explicit `resumeSessionId`, force a fresh ACPX
  record/lease and invoke the delegate with persistent same-session-only
  semantics. Return to the manager with OpenClaw's original one-shot ownership
  and cleanup semantics.
- Propagate every explicit resume error. Positively identified missing-target
  errors may clear/disable the stale resume identity, but must never call
  `newSession` or retry without the ID. Keep any error normalization narrow and
  covered by real ACPX 0.13.1 shapes.

Focused evidence:

- identity normalization/merge/equality and `acpxSessionId` precedence;
- resume support from `sessionCapabilities.resume` and `loadSession`, absent
  support, and record-read failure;
- resumed one-shot keeps the requested ACP ID and `cwd`, creates a fresh
  process lease after the first process exits, and fails on a missing target
  without creating a session.

### 2. Commit terminal readiness before completion and reconstruct exactly

Update the current control-plane owners:

- `src/acp/control-plane/manager.identity-reconcile.ts`
- `src/acp/control-plane/manager.turn-runner.ts`
- `src/acp/control-plane/manager.runtime-handle-ensure.ts`
- `src/acp/control-plane/manager.backend-failover.ts`
- associated manager tests, especially
  `manager.runtime-handles.test.ts`, `manager.test.ts`, and failover tests

Implement:

- After a terminal `completed` result, perform one bounded final identity/status
  reconciliation. If the shared pre-readiness predicate is satisfied, persist
  `sessionResumeReady: true` with write failures enabled.
- Order the success path as: terminal result -> bounded identity reconciliation
  -> readiness commit -> clear live turn state -> task success/delivery -> idle
  metadata -> existing one-shot runtime close. Avoid a duplicate reconciliation
  in `finally`.
- Treat any failure after the terminal result as non-retryable for this turn so
  readiness-write/status failures cannot replay completed work or fail over.
- On cache miss or a new manager instance, pass the persisted resume ID only
  when the full predicate is true, use persisted `cwd`, and pin the sole backend
  candidate to `meta.backend`.
- For that explicit resume path, bypass both the existing retry-without-ID path
  and backend fallback. Preserve current fresh recovery/failover behavior for
  non-resumed sessions.
- After each successful resumed follow-up, repeat the terminal readiness commit
  so a second follow-up remains possible.

Focused evidence:

- completed supported one-shot is ready before task terminal delivery;
- cancelled, failed, pre-prompt, unsupported, unresolved, and status-timeout
  cases are not ready;
- readiness persistence failure fails once with no replay/failover;
- cache loss and a new manager instance pass the same ID, backend, and `cwd`;
- explicit resume failure makes exactly one ensure attempt and no fallback
  backend attempt;
- resumed follow-up becomes ready again.

### 3. Retain verified metadata and route the owning parent's send

Update the existing lifecycle and send owners, with small predicate/route
helpers only if they reduce duplication:

- `src/tasks/task-registry.maintenance.ts`
- `src/tasks/task-registry.test.ts`
- `src/agents/tools/sessions-send-tool.ts`
- `src/agents/openclaw-tools.sessions.test.ts`

Implement:

- Apply the shared predicate to both terminal-task cleanup and orphaned
  parent-owned ACP cleanup. Preserve verified resumable metadata; continue
  closing all other one-shots. Do not retain based on `idle`, an arbitrary ID,
  or a task record alone.
- Inside the existing `runWithScopedSessionAccess` boundary, after target
  ownership/access resolution but before transcript baselines or Gateway
  dispatch, classify parent-owned one-shots:
  - reject when `isAcpTurnActive(sessionKey)` is true;
  - accept only the full durable predicate when the requester is the owning
    parent;
  - reject unsupported, unresolved, not-ready, and recognized legacy terminal
    one-shots with an actionable error;
  - do not guess that a missing ACP row is resumable.
- Keep unrelated authorized senders on the existing A2A path. Keep the owning
  parent on `skipAcpA2AFlow`, and let ACP task completion own waited follow-up
  delivery instead of also waiting on history/agent reply paths.
- Preserve committed-action audit timing, input provenance, participant
  recording, expected-session fencing, source-channel delivery, and exact child
  key attribution.

Focused evidence:

- terminal and orphan maintenance retain only verified resumable one-shots and
  still close unsupported/not-ready rows; fresh active work still blocks cleanup;
- active one-shot is rejected before dispatch; stale persisted `running` is
  accepted when live state is clear;
- owning-parent resume dispatches to the same child key and defers delivery to
  task completion without duplicate parent output;
- unrelated authorized sender A2A, scoped denial, ownership denial, expected
  session fencing, audit, attribution, and participant recording remain intact.

### 4. Prove restart durability in isolation, then document

Run the smallest focused automated set covering the files above, extension
and core type checks, and lint only where the changed surface requires it.
Then run a redacted OpenCode proof using automated tests or a fully isolated process with a separate
state directory and port. Do not edit, build in, reconfigure, or restart the operational Gateway
checkout:

1. Spawn `mode: "run"` in a known `cwd` with a unique marker; record child key,
   backend, ACP ID, and native OpenCode ID when exposed.
2. Let the turn and ACPX process finish; run task maintenance; send a follow-up
   from the owning parent and prove marker/context continuity with unchanged
   IDs, key, backend, and `cwd`.
3. Clear only the ACP manager/runtime-handle cache and repeat.
4. Restart only the isolated fixture/process and repeat from persisted state.
5. Send a second follow-up and prove it remains resumable.
6. Remove or corrupt the backend resume target in an isolated fixture and prove
   one failed resume, no fresh conversation, and no fallback backend.

Capture inspectable, redacted IDs and outputs; PR #107366's narrated proof is
not sufficient evidence by itself. After the proof, update
`docs/tools/acp-agents.md` and `docs/automation/tasks.md` to describe conditional
one-shot retention/resume, fail-closed legacy behavior, and task-owned delivery.
Add a changelog entry only if the eventual implementation is proposed upstream.

A real production Gateway restart remains a separate operator-controlled promotion gate. Prepare
its exact procedure and expected evidence, but do not perform it during feature implementation.

## Acceptance checklist

- [ ] Same OpenClaw child key, ACP protocol ID, native OpenCode ID (when
      exposed), backend, and `cwd` across two follow-ups.
- [ ] Cache loss and isolated restart evidence resume from persisted state; production restart proof
      is recorded as a deferred promotion gate.
- [ ] Explicit resume failure performs no fresh retry and no backend failover.
- [ ] Active, unsupported, unresolved, cancelled, failed, pre-prompt, legacy,
      and not-ready one-shots fail closed and are cleaned up.
- [ ] Normal process/lease cleanup still occurs after each one-shot turn.
- [ ] Ownership, scoped access, expected-session fencing, audit, attribution,
      participant recording, continuation admission, and delivery are unchanged.
- [ ] Exactly one parent-visible completion is produced per follow-up.
- [ ] Automated tests and redacted automated/isolated evidence demonstrate the behavior; no
      dependency/config change is required for acpx 0.13.1.

## Remaining uncertainties to resolve with tests, not design expansion

- OpenCode may expose only the ACP protocol ID on some versions. Require native
  ID equality only when that ID is actually reported; never substitute an
  unrelated ID for the ACP resume target.
- ACPX 0.13.1 does not expose a typed public capability on its runtime handle,
  so the adapter must read the persisted record. Keep this best-effort for
  initial sessions but require persisted `true` before retention/resume.
- Backend missing-target errors are not fully normalized across harnesses.
  Fail every explicit resume closed regardless; clear stale readiness only for
  narrowly recognized, tested shapes.
- Pre-upgrade terminal one-shots lack the new readiness evidence and may already
  have had metadata removed. Report that limitation; do not infer resumability
  from session-key shape or old `idle` state.
