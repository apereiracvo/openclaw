# ACP One-Shot Resume Implementation Launch Prompt

You are the lead implementation orchestrator for the ACP one-shot resumable-execution project.

Your task is to execute the complete implementation, review, testing, documentation, and
pre-promotion verification plan—not to produce another plan.

## Work location

Work exclusively in:

- Feature worktree: `/home/alejandro-pereira/personal/openclaw/openclaw-acp-one-shot-resume`
- Feature branch: `fix/acp-one-shot-resume`

Begin by confirming the absolute cwd, branch, HEAD, merge base, remotes, worktree list, and working-tree
status.

## Absolute isolation boundary

The running OpenClaw Gateway uses a different operational checkout:

- Operational checkout: `/home/alejandro-pereira/personal/openclaw/openclaw`
- Operational branch: `main-custom`

Treat the operational checkout and running Gateway as read-only external infrastructure. Neither you
nor any delegate may edit, build, install, test, checkout, reset, rebase, merge, create artifacts, or
run repository-mutating commands there. Do not change OpenClaw config, credentials, service files,
environment files, runtime state, or Gateway processes. Do not stop, start, restart, signal, or use the
running Gateway for implementation verification.

All product work, dependency operations, builds, tests, fixtures, documentation edits, commits, and
delegated tasks must remain inside the feature worktree. Restart-oriented behavior must be proven with
automated tests, new-manager/cache-loss tests, or a fully isolated process using a separate state
directory and port. If a real production restart is still required, prepare it as a deferred promotion
gate; do not perform it.

## Read these authoritative files completely

Read these files before changing product code, in this order:

1. Repository root `AGENTS.md` and every scoped `AGENTS.md` governing files you inspect or modify.
2. `docs/plans/acp-one-shot-session-resume-implementer-prompt.md`
   - Primary execution contract; follow it completely.
3. `docs/plans/acp-one-shot-session-resume.md`
   - Technical contract, safety invariants, owner map, and acceptance matrix.
4. `docs/plans/acp-one-shot-session-resume-delegation.md`
   - A–C evidence graph, serial S1–S6 slices, and independent review cycle.
5. `docs/plans/openclaw-fork-worktree-topology.md`
   - Executed repository/runtime topology and isolation model. Treat pre-migration snapshots and
     completed migration phases as historical, not current branch instructions.

If a recorded SHA, path, or owner is stale after the rebase, trust verified current-tree evidence and
update the plans only where that drift is proven. Do not weaken the safety contract.

## Core implementation contract

A verified completed ACP `mode: "run"` child must be resumable by its owning parent through
`sessions_send` while preserving the same child key, ACP protocol session, backend, effective cwd, and
conversation continuity across runtime-handle cache loss and persisted-state reconstruction.

Use one canonical durable-resumability predicate everywhere:

```text
mode === "oneshot"
identity.state === "resolved"
identity.sessionResumeSupported === true
identity.sessionResumeReady === true
a stable resume ID exists
persisted identity belongs to meta.backend
```

Prefer `acpxSessionId`; use `agentSessionId` only as a legacy fallback. Every explicit resume must fail
closed: no fresh session, removed/replaced ID, retry without ID, or backend failover.

Keep ACPX at `0.13.1`. PR #107366 / `c3f8914dec8` is design reference only; do not cherry-pick it or
copy unrelated code.

## Required execution

1. Verify required capabilities before product changes: `sessions_spawn`, `sessions_send`,
   `sessions_history`, repository read/write tools, `exec`, and `process`.
2. Spawn A–C as three independent read-only evidence delegates in parallel.
3. Synthesize and personally verify their evidence before S1.
4. Execute S1–S6 serially.
5. For every slice use: implement → focused tests → independent review → revision → reviewer
   verification → final slice gate → focused commit.
6. Finish with an independent reviewer who did not implement S1–S6.
7. Run all relevant focused tests, type checks, changed-file checks, and the required build in the
   feature worktree.
8. Produce isolated restart-persistence evidence and a complete promotion/live-proof packet.
9. Leave the feature branch clean and report exact commits and verification results.

Do not replace independent review with self-review. If delegation capability is unavailable, stop
before product changes and report the exact missing capability.

## Mandatory delegate bootstrap package

Every delegate prompt must be self-contained. Never assume a delegate can see this transcript, prior
findings, current Git state, or unstated decisions.

Every delegate prompt must include:

- exact objective and expected deliverable;
- absolute feature-worktree path, branch, current HEAD, and working-tree state;
- exact files/plans/instructions to read;
- accepted prerequisite commits, findings, invariants, and tests;
- precise read/write scope and non-overlapping ownership;
- relevant caller/callee/sibling paths and known risks;
- exact verification commands and negative cases;
- required completion format;
- explicit prohibition on touching the operational checkout or running Gateway.

For downstream slices and reviewers, include the full accepted handoff from prerequisite work:
commit SHA, invariant established, findings and dispositions, tests passed, limitations, and exact
starting state. A prompt such as “review the current changes” is not sufficient.

## External-action boundary

Local reads, edits, tests, builds, reviews, and focused commits inside the feature worktree are
approved. Do not push, open or modify a PR, change dependencies/config/credentials, promote to
`main-custom`, or restart the Gateway unless Alejandro separately requests that action after reviewing
the completed promotion packet.

## Completion requirement

Continue until A–C, S1–S6, all review/revision gates, full feature-worktree validation, documentation,
and final acceptance review are complete, or a concrete non-routine blocker prevents progress.

The completion report must include:

- root cause and architectural owner;
- complete ordered commit list;
- files changed by owner area;
- findings and dispositions for every review gate;
- tests/checks/builds with outcomes;
- redacted automated/isolated continuity evidence;
- production versus test LOC summary;
- deferred production live-proof and exact promotion/rollback packet;
- final working-tree status;
- readiness for operator-controlled promotion/upstream preparation;
- explicit confirmation that the operational checkout and running Gateway were untouched.

Start now by inspecting the feature worktree, reading all authoritative files, verifying your actual
tool capabilities, and then spawning the three A–C evidence delegates with complete self-contained
context packages.
