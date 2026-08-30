# ACP One-Shot Resume Delegation Plan

## Objective

Implement the safety contract in [ACP One-Shot Session Resume Plan](./acp-one-shot-session-resume.md): a parent can resume a verified completed ACP `mode: "run"` child through `sessions_send`, with the same child key, ACP session, backend, and cwd, including after cache loss or Gateway restart. Every explicit resume fails closed: no fresh session, retry without the resume ID, or backend failover.

This is an execution/delegation plan, not a replacement for the technical plan. It uses small owner-aligned implementation slices and requires an independent review-and-revision gate after every serial slice.

## Global controls

- **Branch:** `custom/minisforum-x1-pro`, rebased on `upstream/main` `8b1f6a5d782`.
- **Reference only:** PR [#107366](https://github.com/openclaw/openclaw/pull/107366) at `c3f8914dec8`; do not cherry-pick it.
- **Pinned dependency:** ACPX `0.13.1`; no dependency upgrade as part of this work.
- **Invariant owner:** one shared durable-resumability predicate. No phase may add a competing predicate.
- **Change discipline:** each implementer works only within its assigned owner surface. Reviewers may request or make focused revisions only to the slice under review.
- **Review gate:** an implementation slice is not complete until its reviewer has checked the actual code, focused tests, and the relevant invariant-sharing sibling path; the implementer then addresses findings and the reviewer signs off on the revision.
- **Commit policy:** one commit per accepted slice. Do not advance to the next serial slice with uncommitted or unresolved changes from the preceding slice.

## Shared durable-resumability predicate

All implementation and review work uses this contract:

```text
mode === "oneshot"
identity.state === "resolved"
identity.sessionResumeSupported === true
identity.sessionResumeReady === true
stable resume id exists
persisted identity belongs to meta.backend
```

`acpxSessionId` is preferred over `agentSessionId`; the latter is legacy fallback only.

## Work graph

```text
A: baseline/reproduction ──────────────┐
B: current-owner/API audit ────────────┼─> S1 → R1 → revise → S2 → R2 → revise
C: ACPX 0.13.1 contract audit ─────────┘                         ↓
                                                        S3 → R3 → revise
                                                                  ↓
                                                        S4 → R4 → revise
                                                                  ↓
                                                        S5 → R5 → revise
                                                                  ↓
                                                        S6 → R6 → revise
                                                                  ↓
                                                        final integration review → live proof → docs
```

A–C may run in parallel and produce evidence only. S1–S6 are serial because each establishes a condition required by the next phase.

## Parallel evidence phase

### A. Baseline and reproducible failure

**Delegate:** ACP integration investigator. **Scope:** read-only plus isolated test fixture/reproduction if it leaves no product changes.

- Establish exact current behavior for a completed OpenCode ACP one-shot followed by `sessions_send`.
- Capture redacted child key, backend, effective cwd, ACP ID, native ID if exposed, and whether the follow-up starts a new conversation.
- Record current branch/head, OpenClaw version, OpenCode version, ACPX version, and ACP doctor result.
- Deliver a minimal repeatable reproduction and a proposed final live-proof checklist.

### B. Owner and sibling-path audit

**Delegate:** control-plane architecture reviewer. **Scope:** read-only.

- Reconfirm current owners after the rebase: identity persistence/normalization, manager reconciliation, runtime-handle construction, failover, task maintenance, and `sessions_send` admission/delivery.
- Identify tests and sibling persistent-session behavior that the one-shot path must preserve or intentionally differ from.
- Flag stale file paths/assumptions in the technical plan.

### C. ACPX contract audit

**Delegate:** ACPX adapter/dependency reviewer. **Scope:** read-only; inspect installed ACPX 0.13.1 directly.

- Verify exact `session/resume` / `session/load` capability shapes, record schema, missing-target errors, one-shot versus persistent ensure semantics, process lease behavior, and cwd propagation.
- Confirm the smallest adapter shim needed for one-shot explicit resume with `same-session-only` semantics.

### Evidence synthesis checkpoint

Integrate A–C before code changes. Update the technical plan only for verified rebase drift; freeze the predicate, test matrix, and exact owner slices. If evidence disproves a premise, revise the sequence before S1.

## Serial implementation and review cycle

For every slice: **implement → independent review → implementer revision → reviewer verification → focused test gate → commit**. Do not advance on an unreviewed diff.

### S1. Durable identity and ACPX strict reconnect

**Depends on:** evidence synthesis.
**Scope:** `packages/acp-core/src/runtime/session-identity.ts`, `packages/acp-core/src/runtime/types.ts`, `packages/acp-core/src/types.ts`, `extensions/acpx/src/runtime.ts`, and directly related tests.

- Persist `sessionResumeSupported` and `sessionResumeReady` through normalization, equality, merging, events, and pending identities.
- Give `acpxSessionId` precedence over `agentSessionId`.
- Determine resume support from the exact ACPX record after ensure; a failed record read is not proof of resumability.
- For explicit one-shot resume, use a fresh ACPX record/lease with strict same-session-only delegate semantics.
- Propagate explicit-resume errors: no new session, stripped ID, or fallback.

**Review gate:** identity cannot become resumable from record ID, idle state, or inferred capability; the adapter change does not alter normal fresh one-shots.

### S2. Terminal readiness commit and exact reconstruction

**Depends on:** accepted S1.
**Scope:** `manager.identity-reconcile.ts`, `manager.turn-runner.ts`, `manager.runtime-handle-ensure.ts`, `manager.backend-failover.ts`, and associated manager tests.

- On completed terminal turn: bounded final reconciliation → readiness commit → active-turn release → task success/delivery → idle metadata → usual one-shot close.
- A readiness/status-write failure is non-retryable and cannot replay completed work.
- Reconstruct only full-predicate identities with persisted cwd and backend pinning.
- Explicit resume bypasses retry-without-ID and fallback; fresh-session behavior remains unchanged.
- Recommit readiness after each resumed follow-up.

**Review gate:** terminal ordering, no duplicate reconciliation, cache-loss/new-manager use same ID/backend/cwd, and no replay/failover on failure.

### S3. Maintenance retention

**Depends on:** accepted S2.
**Scope:** `src/tasks/task-registry.maintenance.ts`, task-registry tests.

- Retain only parent-owned one-shots satisfying the predicate in terminal and orphan cleanup.
- Continue closing unsupported, unresolved, cancelled, failed, pre-prompt, legacy, and not-ready one-shots.
- Never retain from `idle`, task presence, or arbitrary ID alone.

**Review gate:** no retention leak; active work stays protected; existing cleanup behavior/performance is preserved.

### S4. `sessions_send` admission and task-owned delivery

**Depends on:** accepted S3.
**Scope:** `src/agents/tools/sessions-send-tool.ts`, session tool tests, and a small helper only if it removes duplicate classification.

- Within existing scoped access, classify parent-owned one-shots after ownership resolution but before transcript baselines or Gateway dispatch.
- Reject live active turns; admit only a fully verified completed one-shot from its owning parent.
- Fail unsupported/not-ready/legacy cases with actionable errors; never guess missing metadata.
- Preserve unrelated A2A, owner `skipAcpA2AFlow`, audit/provenance/participants/fencing, and one parent-visible completion.

**Review gate:** no authorization bypass, no duplicate delivery, stale persisted running does not block an inactive live turn.

### S5. Integration and failure matrix

**Depends on:** accepted S4. **Scope:** test/support files required to make the contract executable.

Prove same child key/ACP ID/backend/cwd over two follow-ups; cache loss and new manager; restart persistence where practical; invalid target makes exactly one failed attempt with no new session/fallback; all non-ready states fail closed and clean up; a resumed turn becomes ready again.

**Review gate:** tests fail before the implementation, assert external invariants, and do not conceal errors through retries or timing hacks.

### S6. Redacted live proof, docs, final review

**Depends on:** accepted S5. **Scope:** live proof/runbook plus `docs/tools/acp-agents.md` and `docs/automation/tasks.md`.

Run a redacted OpenCode proof: initial one-shot, maintenance, follow-up, cache-loss follow-up, controlled Gateway restart follow-up, second follow-up, invalid-target failure. Document only proven conditional retention/resume, fail-closed behavior, and task-owned delivery. Add a changelog only if preparing upstream submission.

**Review gate:** real-path evidence proves continuity; docs do not promise resume for legacy or unverified sessions.

## Final acceptance review

Use an independent reviewer who did not implement S1–S6. Confirm:

- no fresh retry or backend failover after explicit resume failure;
- no unsupported/not-ready retention;
- same child key, ACP ID, backend, and cwd through restart;
- normal one-shot lease/process cleanup retained;
- scoped access, ownership, audit, attribution, participants, expected-session fencing, continuation admission, and single-delivery behavior unchanged;
- final diff is coherent and excludes unrelated code from PR #107366.
