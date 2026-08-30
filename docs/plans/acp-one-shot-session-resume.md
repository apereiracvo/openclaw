# ACP One-Shot Session Resume Plan

## Goal

Make ACP sessions created with `sessions_spawn({ runtime: "acp", mode: "run" })` durable and safely resumable through `sessions_send`, while preserving:

- the same OpenClaw child session key;
- the same underlying ACP/OpenCode conversation ID;
- the original working directory and backend;
- existing access-control, ownership, delivery, and cleanup behavior;
- fail-closed behavior when resumption cannot be proven safe.

Reference implementation: open PR [#107366](https://github.com/openclaw/openclaw/pull/107366), branch `pr-107366`, tip `c3f8914dec8`.

This plan intentionally adapts only the required behavior to `custom/minisforum-x1-pro`; it does not cherry-pick the full PR.

## Acceptance criteria

- [ ] Spawn an OpenCode ACP child with `mode: "run"` and a unique marker.
- [ ] Let the initial turn complete and its runtime process exit.
- [ ] Send a follow-up with `sessions_send` to the same OpenClaw session key.
- [ ] Confirm the follow-up uses the same ACP/OpenCode protocol session ID.
- [ ] Confirm the marker and prior conversation context are retained.
- [ ] Confirm the original working directory and ACP backend are retained.
- [ ] Confirm no replacement OpenCode conversation is created.
- [ ] Repeat the follow-up and confirm the session remains resumable.
- [ ] Confirm an active one-shot cannot be resumed concurrently.
- [ ] Confirm unsupported, unresolved, cancelled, and failed sessions remain non-resumable and are cleaned up.
- [ ] Confirm a failed explicit resume never retries as a fresh session or through another backend.
- [ ] Confirm behavior survives ACP manager/runtime-handle cache loss and Gateway restart.

## Safety invariants

- [ ] Treat a one-shot as resumable only when identity is stable, resume support is confirmed, and terminal readiness was durably persisted.
- [ ] Prefer the ACP protocol/backend session ID (`acpxSessionId`) over a generic agent session ID.
- [ ] Pin resumed sessions to the backend that owns the persisted identity.
- [ ] Fail closed when the persisted target cannot be resumed.
- [ ] Never retry without `resumeSessionId` after an explicit resume attempt fails.
- [ ] Never fail over to another backend after an explicit resume attempt fails.
- [ ] Use live ACP turn state for concurrency decisions; do not trust stale persisted `meta.state` alone.
- [ ] Preserve all existing `sessions_send` authorization, scoped-access, ownership, audit, attribution, and continuation checks.

## Phase 0 — Baseline and focused reproduction

- [ ] Record the current branch, commit, OpenClaw version, OpenCode version, and ACPX version.
- [ ] Confirm `/acp doctor` is healthy for `opencode`.
- [ ] Add or identify a focused live reproduction that:
  - spawns a one-shot OpenCode child with a marker;
  - waits for completion;
  - calls `sessions_send` on the child key;
  - proves that current behavior creates a different OpenCode conversation.
- [ ] Capture the initial and follow-up OpenClaw session key, ACP protocol ID, cwd, backend, and OpenCode session ID.
- [ ] Keep this failing proof available as the final acceptance test.

## Phase 1 — Durable resume identity model

Target areas:

- `packages/acp-core/src/runtime/session-identity.ts`
- `packages/acp-core/src/runtime/types.ts`
- `packages/acp-core/src/types.ts`
- current session metadata normalization/merge helpers

Checklist:

- [ ] Add or preserve explicit metadata for `sessionResumeSupported`.
- [ ] Add or preserve explicit metadata for `sessionResumeReady`.
- [ ] Define a stable resumable identity predicate.
- [ ] Make `acpxSessionId` take precedence over `agentSessionId` for ACP resume.
- [ ] Preserve capability-only pending identity metadata during normalization and merge.
- [ ] Ensure record-only/provisional identities are not considered stable.
- [ ] Ensure equality and merge logic retain support/readiness fields.

Tests:

- [ ] `acpxSessionId` wins over `agentSessionId`.
- [ ] Support/readiness survive normalization, equality, persistence, and merging.
- [ ] Capability-only pending identities remain persisted.
- [ ] Record-only identities are not stable/resumable.

Gate:

- [ ] Identity tests pass before modifying lifecycle or `sessions_send` behavior.

## Phase 2 — ACPX capability detection and strict reconnect

Target areas:

- `extensions/acpx/src/runtime.ts`
- existing ACPX session-ensure helpers and tests

Checklist:

- [ ] After `delegate.ensureSession()`, best-effort read the ACPX session record.
- [ ] Detect resume support from either:
  - `agentCapabilities.sessionCapabilities.resume`; or
  - `agentCapabilities.loadSession === true`.
- [ ] Return the capability as `handle.sessionResumeSupported`.
- [ ] For a one-shot with `resumeSessionId`, use ACPX same-session-only reconnect semantics while retaining OpenClaw's one-shot metadata mode.
- [ ] Ensure a missing/invalid resume target fails rather than invoking `newSession`.
- [ ] Preserve current process-lease, model-selection, operation-snapshot, and cwd behavior.

Tests:

- [ ] `sessionCapabilities.resume` reports support.
- [ ] `loadSession:true` reports support.
- [ ] Missing capabilities report unsupported.
- [ ] ACPX record-read failure does not fail session initialization.
- [ ] Resumed one-shot uses same-session-only behavior.
- [ ] Missing OpenCode target fails without creating a new session.
- [ ] Resumed turn retains protocol ID and cwd.
- [ ] Resume acquires a fresh process lease after the initial process exits.

Gate:

- [ ] ACPX runtime tests pass with `acpx` 0.13.1.

## Phase 3 — Persist terminal readiness before completion

Target areas:

- `src/acp/control-plane/manager.identity-reconcile.ts`
- `src/acp/control-plane/manager.turn-runner.ts`
- `src/acp/control-plane/manager.types.ts`

Checklist:

- [ ] Reconcile final runtime status and identity after a terminal turn with a bounded timeout.
- [ ] Require all of the following before marking ready:
  - one-shot mode;
  - completed terminal state;
  - not cancelled;
  - resolved identity;
  - stable ACP protocol ID;
  - confirmed resume support.
- [ ] Persist `sessionResumeReady:true` with failure propagation enabled.
- [ ] Persist readiness before exposing terminal task completion.
- [ ] Remove or avoid duplicate final reconciliation paths.
- [ ] Ensure readiness persistence failure prevents a successful resumable terminal state.

Tests:

- [ ] Completed one-shot persists protocol ID, support, and readiness.
- [ ] Unsupported, unresolved, cancelled, pre-prompt, and failed turns never become ready.
- [ ] Readiness write failure prevents successful terminal exposure.
- [ ] A completed resumed follow-up becomes ready for another follow-up.

Gate:

- [ ] Manager lifecycle tests pass before changing task cleanup.

## Phase 4 — Safe runtime reconstruction and backend pinning

Target areas:

- `src/acp/control-plane/manager.runtime-handle-ensure.ts`
- `src/acp/control-plane/manager.backend-failover.ts`
- `src/acp/control-plane/manager.turn-runner.ts`

Checklist:

- [ ] Supply `resumeSessionId` for one-shots only when stable + supported + ready.
- [ ] Verify the persisted identity belongs to the selected backend.
- [ ] Pin resumed one-shots to `meta.backend`.
- [ ] Disable backend fallback for explicit one-shot resume.
- [ ] Disable retry-without-ID for explicit one-shot resume.
- [ ] Preserve current selected-backend and backend-owned identity behavior.
- [ ] Replace the current test assertion that deliberately omits one-shot `resumeSessionId`.

Tests:

- [ ] Handle-cache loss still passes the original `resumeSessionId`.
- [ ] A new ACP manager instance still resumes the original session.
- [ ] Explicit resume failure does not retry fresh.
- [ ] Explicit resume failure does not use a fallback backend.
- [ ] Resume remains pinned to the original backend.

Gate:

- [ ] Manager reconstruction tests pass under cache loss and manager recreation.

## Phase 5 — Retain only verified resumable one-shots

Target areas:

- `src/tasks/task-registry.maintenance.ts`
- optionally `src/tasks/task-registry.acp-session-lifecycle.ts`

Checklist:

- [ ] Update terminal ACP cleanup to retain one-shots only when stable + supported + ready.
- [ ] Apply the same predicate to orphaned parent-owned ACP cleanup.
- [ ] Continue closing unsupported, unresolved, cancelled, pre-prompt, and not-ready sessions.
- [ ] Do not preserve a session based only on `meta.state:"idle"` or the presence of an arbitrary ID.
- [ ] Preserve current task-list snapshot/maintenance performance behavior.

Tests:

- [ ] Ready one-shots survive terminal cleanup.
- [ ] Ready one-shots survive orphan-maintenance checks.
- [ ] Unsupported, unresolved, cancelled, and not-ready sessions are closed.
- [ ] `meta.state:"idle"` alone does not preserve a session.
- [ ] Fresh active work still prevents cleanup.

Gate:

- [ ] Task-registry tests pass without increasing duplicate scans or cleanup races.

## Phase 6 — Route `sessions_send` to completed ACP one-shots

Target areas:

- `src/agents/tools/sessions-send-tool.ts`
- preferably focused helpers in `src/agents/tools/sessions-send-route.ts`
- associated `openclaw-tools.sessions` tests

Checklist:

- [ ] Load target ACP metadata before transcript/history waiting or Gateway dispatch.
- [ ] For parent-owned one-shots, reject while `isAcpTurnActive(sessionKey)` is true.
- [ ] Reject unresolved, unsupported, or not-ready one-shots with an actionable error.
- [ ] Accept completed stable + supported + ready one-shots.
- [ ] Ignore stale persisted `meta.state:"running"` when live turn state is clear.
- [ ] Preserve parent-owned `skipAcpA2AFlow` behavior.
- [ ] Let ACP task completion own waited follow-up delivery; avoid duplicate history/agent waits.
- [ ] Preserve unrelated sender A2A behavior and all existing security checks.

Tests:

- [ ] Active one-shot is rejected before Gateway dispatch.
- [ ] Ready completed one-shot is accepted using the same target key.
- [ ] Stale persisted running state is accepted when live state is clear.
- [ ] Unsupported and not-ready sessions are rejected.
- [ ] Unrelated senders retain normal A2A behavior.
- [ ] Waited parent sends complete through ACP task completion.
- [ ] No duplicate parent delivery occurs.
- [ ] Scoped access and ownership checks remain enforced.

Gate:

- [ ] Focused `sessions_send` tests pass before live testing.

## Phase 7 — Integration and live OpenCode proof

- [ ] Run focused ACP identity tests.
- [ ] Run ACPX runtime tests.
- [ ] Run ACP manager lifecycle/reconstruction tests.
- [ ] Run task-registry ACP lifecycle tests.
- [ ] Run focused `sessions_send` tests.
- [ ] Run extension type-check.
- [ ] Run relevant core/gateway type-check and lint checks.
- [ ] Run the baseline live OpenCode reproduction.
- [ ] Verify the same OpenCode protocol/session ID before and after `sessions_send`.
- [ ] Repeat after ACP manager/runtime-handle cache loss.
- [ ] Repeat after a controlled Gateway restart.
- [ ] Send a second follow-up and verify continued resumability.
- [ ] Test an invalid resume target and confirm fail-closed behavior with no new session.

## Phase 8 — Compatibility, documentation, and cleanup

Only after the new-session path is proven:

- [ ] Decide whether pre-upgrade terminal ACP rows need a dedicated diagnostic message.
- [ ] Avoid guessing legacy resumability when required metadata is absent.
- [ ] Document `mode:"run"` resumability and its capability requirements.
- [ ] Document that `sessions_send` resumes only verified completed ACP one-shots.
- [ ] Document fail-closed behavior when the backend session is missing.
- [ ] Add a changelog entry if this branch will be proposed upstream.
- [ ] Compare the final patch against PR #107366 to ensure no required race fix was omitted.

## Explicitly out of scope initially

- [ ] Do not cherry-pick all of PR #107366.
- [ ] Do not copy its translator/event-ledger changes unless a failing test proves they are required.
- [ ] Do not copy superseded process-lease code.
- [ ] Do not restore old backend mutation logic.
- [ ] Do not replace `sessions-send-tool.ts` wholesale.
- [ ] Do not upgrade ACPX solely to implement this fix; target the currently supported `acpx` 0.13.1 first.
- [ ] Do not bypass dependency-age or Gateway startup safeguards.

## Recommended commit sequence

- [ ] Commit 1: identity fields, precedence, normalization, and tests.
- [ ] Commit 2: ACPX capability detection and strict reconnect tests.
- [ ] Commit 3: terminal readiness persistence and manager tests.
- [ ] Commit 4: one-shot runtime reconstruction and backend pinning.
- [ ] Commit 5: task-registry retention predicate and tests.
- [ ] Commit 6: `sessions_send` lifecycle routing and tests.
- [ ] Commit 7: live proof, compatibility diagnostics, docs, and changelog.

Each commit should independently type-check and pass its focused tests.

## Final sign-off checklist

- [ ] All acceptance criteria are demonstrated with evidence.
- [ ] No fresh-session fallback is possible after explicit resume failure.
- [ ] No unsupported session is retained indefinitely.
- [ ] No access-control or ownership regression is introduced.
- [ ] No duplicate completion/delivery is observed.
- [ ] Gateway restart preserves resumability.
- [ ] Diff against current branch is materially smaller than PR #107366.
- [ ] Final patch is reviewed against upstream changes since PR #107366.
