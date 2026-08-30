# OpenClaw Fork, Branch, and Worktree Migration Plan

## Goal

Separate the running OpenClaw Gateway checkout from ACP feature development, while adopting a conventional fork topology:

- Alejandro's GitHub fork is `origin`;
- `openclaw/openclaw` remains `upstream`;
- fork `main` mirrors official `upstream/main`;
- `main-custom` is the operational branch used by the MinisForum Gateway;
- `fix/acp-one-shot-resume` branches from `main-custom` and runs in an isolated sibling worktree;
- feature agents may build, test, and edit only the feature worktree;
- the operational checkout is touched only during a reviewed, operator-approved promotion.

## Current verified state

- Repository: `/home/alejandro-pereira/personal/openclaw/openclaw`
- Running Gateway source directory: the same path above.
- Current branch: `custom/minisforum-x1-pro`
- Current branch state: 3 commits ahead of its merge base and currently behind official main.
- Net committed custom delta: `docs/plans/acp-one-shot-session-resume.md`; the ACPX 0.13.2 bump and its revert cancel each other but remain in history.
- Uncommitted planning work:
  - modified `docs/plans/acp-one-shot-session-resume.md`
  - untracked `docs/plans/acp-one-shot-session-resume-delegation.md`
  - untracked `docs/plans/acp-one-shot-session-resume-implementer-prompt.md`
  - this migration plan
- Existing reference worktree: `/home/alejandro-pereira/personal/openclaw/openclaw-pr-107366` on `pr-107366`; preserve it.
- Current remote `upstream` points to `https://github.com/openclaw/openclaw.git`.
- Local `main` is stale and must not be used as a base until reset to the fork/official main.
- Gateway source policy is development; the configured source commit metadata is stale and is not currently enforcing a pin.

## Target topology

```text
GitHub
  openclaw/openclaw
    └── upstream/main                 official source of truth

  apereiracvo/openclaw                Alejandro's fork
    ├── origin/main                   exact mirror of upstream/main
    ├── origin/main-custom            operational custom branch
    └── origin/fix/acp-one-shot-resume

Local repository
  remotes:
    upstream -> openclaw/openclaw
    origin   -> apereiracvo/openclaw

  branches/worktrees:
    main -> origin/main
    main-custom -> origin/main-custom
      /home/alejandro-pereira/personal/openclaw/openclaw
      Gateway operational source checkout

    fix/acp-one-shot-resume -> origin/fix/acp-one-shot-resume
      /home/alejandro-pereira/personal/openclaw/openclaw-acp-one-shot-resume
      isolated development/build/test checkout

    pr-107366
      /home/alejandro-pereira/personal/openclaw/openclaw-pr-107366
      read-only reference worktree
```

Branches are not nested objects: `fix/acp-one-shot-resume` simply records `main-custom`'s commit as its starting parent. This keeps history understandable without coupling either worktree's files.

## Prerequisite blocker

GitHub access for Larry is currently not connected/verified, and `gh` is not installed in the execution shell. Before creating or pushing the fork, connect GitHub under **Settings → Agents → Tools** or provide another approved GitHub-capable operator path. Never collect credentials in chat.

Fork creation and pushes are external writes and require Alejandro's explicit approval at execution time.

## Phase 0: Freeze and safeguard

1. Stop or pause any implementation session that could write to this repository.
2. Record:
   - `git status --short --branch`
   - current HEAD and `upstream/main`
   - `git worktree list --porcelain`
   - all remotes and branch tracking configuration.
3. Confirm the only intended uncommitted files are the four planning files listed above.
4. Create a local safety ref at the current committed HEAD, for example:
   - `backup/pre-fork-topology-2026-08-30`
5. Do not stash or discard the planning files.
6. Confirm the running Gateway remains bound to `/home/alejandro-pereira/personal/openclaw/openclaw`.

**Gate:** exact recovery ref and working-tree inventory are recorded; no background writer remains.

## Phase 1: Create the GitHub fork and normalize remotes

1. Create `apereiracvo/openclaw` as a fork of `openclaw/openclaw` with default branch `main`.
2. Preserve official remote naming:
   - keep `upstream = https://github.com/openclaw/openclaw.git`
   - add `origin = <Alejandro fork URL>`
3. Fetch both remotes and prune stale remote-tracking refs.
4. Verify repository identity and fork relationship through the GitHub API/tool.
5. Verify `origin/main` equals the latest fetched `upstream/main`.
   - If equal, continue.
   - If the fork is behind, use GitHub's supported fork-sync operation or fast-forward fork `main` from `upstream/main`.
   - Never rewrite official upstream.
6. Reset the unused stale local `main` branch to `origin/main` only after confirming it has no unique work.
7. Configure local `main` to track `origin/main`.

**Gate:** `origin/main == upstream/main`; `main` tracks `origin/main`; `upstream` remains official.

## Phase 2: Rename the operational branch

1. In the operational checkout, rename:
   - `custom/minisforum-x1-pro` → `main-custom`
2. Do not alter its commits or working tree during the rename.
3. Publish `main-custom` to `origin` and set tracking to `origin/main-custom`.
4. Remove the old local branch name if Git leaves any alias; do not delete the safety ref.
5. Verify the Gateway source directory is unchanged and the running process remains healthy.

**Gate:** operational checkout is on `main-custom`, tracking `origin/main-custom`, with all planning files still present and unchanged.

## Phase 3: Move ACP planning work onto the feature branch

The committed ACP plan already exists in `main-custom`; preserve that current history for this migration rather than rewriting operational history. Move the current _uncommitted_ plan revisions and new delegation artifacts onto the feature branch:

1. From the operational checkout, create `fix/acp-one-shot-resume` from `main-custom`; uncommitted planning files follow the checkout.
2. Review and commit only the four ACP/migration planning files on the feature branch with a focused planning commit.
3. Switch the operational checkout back to `main-custom`.
   - It must now be clean.
   - The feature-only planning commit must not appear on `main-custom`.
4. Create the sibling worktree:
   - path: `/home/alejandro-pereira/personal/openclaw/openclaw-acp-one-shot-resume`
   - branch: `fix/acp-one-shot-resume`
5. Publish the feature branch to `origin` and set its tracking branch.
6. Verify the three plan files and this topology plan exist in the feature worktree.

**Gate:** operational worktree is clean on `main-custom`; feature worktree contains the planning commit and tracks `origin/fix/acp-one-shot-resume`.

## Phase 4: Isolate development execution

Apply these rules to the ACP implementer and all delegates:

- Working directory must be `/home/alejandro-pereira/personal/openclaw/openclaw-acp-one-shot-resume`.
- Never edit, build, install dependencies, or run repository-mutating commands in the operational checkout.
- Never restart or reconfigure the Gateway during S1-S5.
- Build/test only inside the feature worktree.
- Use worktree-local `node_modules`; run the repository's supported package-manager/install flow there if needed.
- Keep write scopes non-overlapping among delegates.
- Commit and review every serial slice on `fix/acp-one-shot-resume`.
- Push only when Alejandro explicitly requests it.
- The existing PR #107366 worktree is reference-only.

Before implementation starts, amend the implementer prompt's repository path and branch to the feature worktree/branch.

**Gate:** a harmless file/path and build-output check proves commands run in the feature worktree and do not change operational `git status` or operational `dist` timestamps.

## Phase 5: Pre-promotion verification

Before touching `main-custom`:

1. Ensure feature worktree is clean and every accepted slice is committed.
2. Run required focused tests, type checks, changed-file checks, and full build in the feature worktree.
3. Run all live tests that do not require the production Gateway.
4. Complete the independent final review.
5. Fetch `upstream/main` and `origin`.
6. If `main-custom` advanced, rebase the feature branch onto the current `main-custom`, resolve and rerun all gates.
7. Produce a promotion packet:
   - exact feature head SHA;
   - exact `main-custom` base SHA;
   - commit list;
   - tests/build evidence;
   - reviewer sign-off;
   - expected operational files changed;
   - rollback ref/commit.

**Gate:** feature is accepted, green, clean, and based on current `main-custom`.

## Phase 6: Controlled promotion to `main-custom`

This phase requires Alejandro's explicit approval because it affects the running source checkout and culminates in a Gateway restart.

1. Confirm no agent is writing either branch/worktree.
2. Confirm operational checkout is clean on `main-custom`.
3. Fast-forward `main-custom` to the accepted feature head (`--ff-only`). Do not merge with an unreviewed merge commit.
4. Build in the operational checkout using the exact supported Corepack command.
5. Verify build success and source commit identity.
6. Restart the Gateway through the OpenClaw system-control path, not shell/systemctl.
7. Verify:
   - Gateway reachable and healthy;
   - runtime reports the promoted `main-custom` commit;
   - dictation/transcription and required plugins still initialize;
   - focused ACP live continuity proof passes;
   - no config was changed unintentionally.
8. Push updated `main-custom` only if separately approved.

Because the running Gateway points at this checkout, steps 3-6 are the only intentional period when operational files change. Keep that window short and perform it only after the feature worktree has already produced a successful build.

## Phase 7: Rollback

If build or runtime verification fails:

1. Keep the failed feature branch and logs intact.
2. Restore `main-custom` to the recorded pre-promotion commit using a safe fast rollback approved by Alejandro.
3. Rebuild the operational checkout at that commit.
4. Restart through OpenClaw system control.
5. Verify health and report the exact failed gate.
6. Never force-push or delete the feature/safety branches during incident recovery.

## Ongoing synchronization workflow

### Sync the fork's clean main

1. Fetch `upstream main`.
2. Fast-forward fork `origin/main` to `upstream/main` using the supported GitHub fork-sync/push path.
3. Fast-forward local `main` to `origin/main`.
4. Never add custom commits to `main`.

### Update operational custom branch

1. Work in a temporary update branch/worktree based on `main-custom`, not the running checkout.
2. Rebase that update branch onto current `main`/`upstream/main`.
3. Build and test in isolation.
4. Review and promote by fast-forward into the operational `main-custom` checkout.
5. Rebuild and restart only during the approved promotion window.

### Start future features

- Branch from current `main-custom`.
- Give each feature its own sibling or managed worktree.
- Never let feature agents write in the operational checkout.
- Promote only accepted, clean commits by fast-forward.

## Acceptance checklist

- [ ] GitHub fork exists under Alejandro's account.
- [ ] `origin` points to the fork; `upstream` points to official OpenClaw.
- [ ] Fork `main`, local `main`, and `upstream/main` are equal after sync.
- [ ] Operational checkout is clean on `main-custom` and tracks `origin/main-custom`.
- [ ] Gateway source directory remains the operational checkout.
- [ ] ACP feature branch starts from `main-custom` and has its own worktree.
- [ ] Existing planning work and PR reference worktree are preserved.
- [ ] Feature build/test activity leaves operational checkout and `dist` untouched.
- [ ] Implementer prompt targets the feature worktree.
- [ ] Promotion and rollback packets identify exact commits.
- [ ] Gateway restart occurs only during approved promotion.
