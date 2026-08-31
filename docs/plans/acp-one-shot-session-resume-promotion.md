# ACP One-Shot Resume Promotion and Rollback Packet

## Scope and immutable points

- S6 start feature HEAD: `83643440b0ed2ddae04d2bee07d1f0589523cd78`.
- Rollback/base target: `676f7d509f7d8f5b9b71c57c41fcaf3c59d2edfb`.
- Branch: `fix/acp-one-shot-resume`.
- ACPX remains pinned to `0.13.1`; no dependency, lockfile, or configuration change is included.
- S6 consists of documentation and this packet and is pending its final review/commit. Replace `<accepted-s6-head>` below with the reviewed S6 commit before promotion.
- The operational checkout and running Gateway were not edited, built, tested, reconfigured, restarted, or used for this proof.

## Ordered commits

The base-to-feature range also contains the pre-slice planning ancestor `4815a3596b9cd92424c31000003fd284ac70b8c7` (`docs(acp): add implementation delegation and isolation plans`). The accepted implementation sequence is:

1. `c16252fe5859df5057e8bc07e852b43fbe6fe5e0` - planning isolation.
2. `b7846de3a4a6b4fe175d8c3c6ede33a843f83be5` - S1 durable identity and strict ACPX reconnect.
3. `487203f57ed23071dffa5ac93b8637fcaddbce77` - S2 readiness and reconstruction.
4. `d9a2f340d308710fce5772448b51e002bf033d76` - S3 retention.
5. `d55a4886650991339c3691153f205315606b4ecf` - S4 `sessions_send` admission.
6. `83643440b0ed2ddae04d2bee07d1f0589523cd78` - S5 integration proof.
7. `<accepted-s6-head>` - pending S6 proof documentation and promotion packet.

## Isolated proof

All commands ran in the feature worktree. No production Gateway restart is claimed.

```bash
node scripts/run-vitest.mjs src/acp/control-plane/manager.one-shot-resume.integration.test.ts
```

Result: 1 file, 3 tests passed; 7.18 seconds including the repository wrapper. The persisted-state integration used a real temporary state database plus manager, task maintenance, and `sessions_send`. Redacted representative continuity was:

- child key `<child-A>` on owning parent `<parent-A>`;
- ACP protocol id `<acp-session-A>`;
- backend `<backend-A>` despite configured backend drift and a forbidden fallback;
- cwd `<isolated-state>/workspace`;
- initial turn, maintenance, owning-parent follow-up, new manager/cache-loss reconstruction, maintenance, and second follow-up all used those same values;
- readiness committed after all three successful turns;
- each successful run recorded exactly one completion;
- each turn performed normal one-shot close cleanup;
- missing target `<missing-A>` made one additional exact ensure attempt, no turn, no close for a nonexistent handle, and no fallback.

```bash
node scripts/run-vitest.mjs \
  extensions/acpx/src/runtime.test.ts \
  packages/acp-core/src/runtime/session-identity.test.ts \
  src/acp/control-plane/manager.one-shot-resume.test.ts \
  src/acp/control-plane/manager.persistence-race.test.ts \
  src/acp/control-plane/manager.turn-stream-terminal-evidence.test.ts \
  src/acp/runtime/session-meta.concurrency.test.ts \
  src/acp/session-resume.test.ts \
  src/tasks/task-registry.test.ts \
  src/tasks/task-owner-access.test.ts \
  src/agents/openclaw-tools.sessions.test.ts
```

Result: 10 files selected across 6 Vitest shards, 356 tests passed; 32.28 seconds. This proved:

- the real fake ACP wire sends one `session/resume` and one prompt for `<acp-session-A>`, sends no `session/new`, and closes the normal one-shot process lease (`open -> closing -> closed`);
- a missing wire target sends exactly one `session/resume`, no `session/new`, and persists no replacement record;
- verified terminal/orphan one-shots are retained while legacy, unsupported, unresolved, not-ready, and missing-id/backend cases fail closed and are cleaned up;
- live active turns fail closed before transcript read or dispatch, while stale persisted diagnostic state does not replace live admission state;
- readiness-write, terminal-status, identity-generation, and explicit resumed-turn failures do not replay or fail over;
- parent-owned follow-up delivery remains task-owned and the integration records one completion per run;
- the persisted task registry's exact ACP runtime, child key, and owner binding identifies a parent-owned ACP child after embedded and durable ACP metadata removal, so the owner fails closed before history or agent dispatch while native children and unrelated authorized senders retain their existing paths.

Together the two commands passed 359 tests. Automated temporary-state/new-manager reconstruction is the isolated restart-persistence proof. A production restart and live harness proof remain deferred to the operator-controlled promotion window.

## Expected changed files

Production runtime (23 files):

- `extensions/acpx/src/runtime.ts`
- `packages/acp-core/src/runtime/session-identity.ts`, `runtime/types.ts`, `types.ts`
- `src/acp/control-plane/active-turns.ts`
- `src/acp/control-plane/manager.backend-failover.ts`, `manager.cancel-session.ts`, `manager.close-session.ts`, `manager.core.ts`, `manager.identity-reconcile.ts`, `manager.runtime-handle-ensure.ts`, `manager.runtime-options-commands.ts`, `manager.startup-identity-reconcile.ts`, `manager.status.ts`, `manager.turn-runner.ts`, `manager.turn-stream.ts`, `manager.types.ts`
- `src/acp/runtime/session-meta-write-lock.ts`, `session-meta.ts`
- `src/acp/session-resume.ts`
- `src/agents/tools/sessions-send-tool.ts`
- `src/tasks/task-owner-access.ts`, `task-registry.maintenance.ts`

Test/test-support (15 files): ACPX runtime, ACP-core identity, manager one-shot/integration/failover/backend-failover/persistence/runtime-handle/terminal-stream, ACP metadata concurrency/predicate, sessions tool, task owner access, task registry, and active-turn test support files in the corresponding source directories.

Documentation/plans: `docs/tools/acp-agents.md`, `docs/automation/tasks.md`, the five existing ACP/topology planning artifacts, and this packet. No changelog is included.

## LOC summary

Against `676f7d509f7d8f5b9b71c57c41fcaf3c59d2edfb`, excluding documentation:

- production runtime: `+1249 / -310` across 23 files (net `+939`);
- tests and test support: `+3968 / -11` across 15 files (net `+3957`).

Documentation is tracked separately because the base range includes the implementation planning package; final documentation counts should be regenerated after the pending S6 commit.

## Deferred operator-controlled promotion

Only after explicit approval:

1. Substitute the reviewed S6 commit for `<accepted-s6-head>` and verify the feature worktree is clean at that exact commit.
2. In the operational checkout, verify `git status --short --branch` is clean on `main-custom` and that its HEAD is the recorded base. Stop if either check differs.
3. Fast-forward only: `git merge --ff-only <accepted-s6-head>`.
4. Build with the repository-pinned package manager: `corepack pnpm build`.
5. Confirm the built source identity is `<accepted-s6-head>`.
6. Restart only through OpenClaw system control, after a separate explicit restart approval. Do not use shell service control.
7. Verify Gateway reachability/health, required plugin initialization, and ACP doctor readiness.
8. Run the production live proof below. Stop and roll back on identity drift, duplicate completion, fallback, health failure, or build failure.
9. Push `main-custom` only under separate explicit approval.

### Deferred production live-proof evidence

Capture a redacted record containing:

1. initial one-shot result and one completion: child `<child-P>`, ACP id `<acp-P>`, native harness id `<native-P>` when exposed, backend `<backend-P>`, cwd `<cwd-P>`;
2. task maintenance followed by an owning-parent `sessions_send` result with the same values and one completion;
3. operator-controlled Gateway restart, health/ACP readiness, then a persisted-state follow-up with the same child/ACP/native/backend/cwd values and one completion;
4. a second successful follow-up proving readiness was recommitted;
5. an isolated invalid target showing one failed resume, no fresh conversation/session, no backend fallback, and no duplicate completion;
6. normal one-shot wrapper/process lease cleanup after every successful turn.

Do not treat omission of a native harness id as failure when the harness does not expose one; never substitute another id for it.

## Operator-controlled rollback

Rollback target: `676f7d509f7d8f5b9b71c57c41fcaf3c59d2edfb`.

Only after explicit rollback approval:

1. Preserve the failed feature commit and sanitized build/runtime logs.
2. Confirm the operational checkout is on `main-custom`, no unrelated edits exist, and no agent is writing it.
3. Restore the operational branch and tree exactly with `git reset --hard 676f7d509f7d8f5b9b71c57c41fcaf3c59d2edfb`.
4. Rebuild with `corepack pnpm build`.
5. Restart only through OpenClaw system control.
6. Verify Gateway health, source identity at the rollback target, required plugin initialization, and unchanged configuration.
7. Report the exact failed promotion gate. Do not force-push or delete the feature or safety refs.
