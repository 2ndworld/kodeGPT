# KodeGPT Trusted Linked-Worktree Git Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a trusted linked Git worktree fully usable by existing KodeGPT Git/process/verification primitives without mounting canonical checkout source or adding a public MCP tool.

**Architecture:** Resolve linked-worktree Git metadata internally from the retained root, validate the standard Git worktree indirection/backlink structure, retain the validated common Git directory by FD, and mount that metadata at its original absolute path inside Bubblewrap. Keep source authority at `/workspace`; admit no external Git metadata by default, grant read-only metadata to typed Git reads, and grant metadata write only to existing typed Git mutations or write-capable `trusted` process execution.

**Tech Stack:** Rust, Bubblewrap, retained root FDs, rustix, existing Git/process runtime, Cargo, pnpm/Vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-kodegpt-trusted-worktree-git-metadata-design.md`

## Global Constraints

- Canonical repo: `/home/sauron/dev/kodegpt`.
- Baseline: `af4958cf1ba5d144276c4ad2f921fe1b6f6970c6` (post-PR #30).
- Runtime remains `0.1`.
- Protocol remains `2026-07-28`.
- MCP surface remains `0.10`; no public tool/schema addition.
- Keep Bubblewrap, retained source root, executable trust/revalidation, `HOME=/home/kodegpt`, controlled PATH/environment, audit, cancellation, spool/artifacts, and network policy.
- Never mount canonical checkout source, host HOME, host root, or an arbitrary request-selected path.
- Do not build a generic external-mount/worktree-lifecycle/provider/orchestration framework.
- Use TDD and preserve ordinary repository behavior.

---

### Task 1: Reproduce and RED-test linked-worktree Git

**Files:**
- Modify/Test: `crates/sandbox/src/bubblewrap.rs`

**Interfaces:**
- Consumes: existing `BubblewrapProvider`, `SandboxLaunchSpec`, retained workspace FD.
- Produces: regression test proving a standard linked worktree fails before metadata admission.

- [x] **Step 1: Reproduce through live KodeGPT**

Open a trusted linked worktree as the only retained workspace and run `git.status` plus trusted `bash` Git. Expected pre-fix result: `GIT_INSPECTION_FAILED` / `fatal: not a git repository: <canonical>/.git/worktrees/<name>`.

- [x] **Step 2: Write the focused sandbox regression test**

Create a real temporary Git repository and linked worktree, pass only the worktree root FD to Bubblewrap, and execute `git status --short`.

- [x] **Step 3: Verify RED**

Run:

```bash
cargo test -p kodegpt-sandbox bubblewrap::tests::linked_worktree_git_metadata_is_available_inside_sandbox -- --exact --nocapture
```

Expected pre-fix: FAIL because external linked-worktree metadata is absent.

---

### Task 2: Add Git-specific metadata admission

**Files:**
- Create: `crates/sandbox/src/git_metadata.rs`
- Modify: `crates/sandbox/src/lib.rs`
- Modify: `crates/sandbox/src/bubblewrap.rs`

**Interfaces:**
- Produces: `open_linked_worktree_git_metadata(&OwnedFd) -> Result<Option<LinkedWorktreeGitMetadata>, GitMetadataError>`.
- `LinkedWorktreeGitMetadata` retains only the validated common Git metadata directory FD and its child mount path.

- [x] **Step 1: Validate the retained root and `.git` file**

Require a canonical retained-root path, a regular bounded `.git` file, an absolute clean `gitdir:` pointer, and no symlink/traversal admission.

- [x] **Step 2: Validate standard linked-worktree structure**

Require `<common>/.git/worktrees/<name>`, exact `commondir` value `../..`, canonical directories, and the reciprocal `gitdir` backlink equal to the retained worktree `.git` path.

- [x] **Step 3: Retain metadata by FD and mount only metadata**

Clear `FD_CLOEXEC` only for the validated common Git directory FD. Build empty parent directories in the sandbox, reject collisions with sandbox-owned paths, and bind the metadata directory at its original absolute path. Do not bind its canonical checkout parent/source.

- [x] **Step 4: Preserve existing authority without widening `develop`**

Default external Git metadata admission to `None`, independently of source `WorkspaceAccess`. Existing typed Git reads request metadata read-only; existing typed Git mutations request metadata read-write; write-capable `trusted` process execution may request metadata read-write for trusted shell/Git parity. `observe` and `develop` process execution receive no external Git metadata mount.

- [x] **Step 5: Verify GREEN**

Run the focused test and sandbox crate suite. Expected: PASS.

---

### Task 3: Prove adversarial rejection and typed Git mutation

**Files:**
- Test: `crates/sandbox/src/git_metadata.rs`
- Test: `crates/sandbox/src/bubblewrap.rs`
- Test: `crates/runtime/src/git.rs`

**Interfaces:**
- Consumes: validated metadata admission.
- Produces: security and runtime parity evidence.

- [x] **Step 1: Add adversarial metadata tests**

Cover ordinary `.git` directories, `.git` symlinks, parent traversal, mismatched repository backlink, and stale/deleted linked-worktree gitdirs.

- [x] **Step 2: Prove canonical source remains invisible**

Inside the linked-worktree sandbox, probe `<canonical>/tracked.txt`; expected: absent even while Git metadata resolves.

- [x] **Step 3: Add typed runtime Git integration**

Exercise `git.status`, `git.stage`, and `git.commit` from a linked worktree and verify the feature branch commit is written correctly.

- [x] **Step 4: Run Rust regression gates**

```bash
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
```

Expected: PASS.

---

### Task 4: P0.5 operational cleanup

**Files:**
- No production subsystem changes.

**Interfaces:**
- Consumes: host Git worktree registry + KodeGPT trust store.
- Produces: reconciled current operational state only.

- [x] **Step 1: Inspect historical worktrees for unique work**

Verify `github-read-provider-adapter` and `provider-gateway` are clean and their branches are merged into `main`.

- [x] **Step 2: Remove only clean merged historical worktrees**

Use normal `git worktree remove`; do not add GC/watcher/daemon behavior.

- [x] **Step 3: Remove stale trust records whose worktree roots no longer exist**

Remove the obsolete `bounded-github-pr-write` and `four-priority-followthrough` trust records. Preserve unrelated trust entries and the active implementation worktree trust.

---

### Task 5: Full pre-release verification

**Files:**
- No additional production changes unless a gate identifies a real defect.

- [x] **Step 1: Run JS/TS and packaging gates**

```bash
pnpm run typecheck
pnpm run build
pnpm run test
pnpm run verify:forbidden
pnpm run verify:package
git diff --check
```

Expected: PASS.

- [ ] **Step 2: Review exact diff**

Use defect-first review against `af4958cf...`, focusing on arbitrary path admission, source leakage, symlink/traversal, metadata write scope, ordinary-repo regression, and unnecessary abstraction.

---

### Task 6: Candidate immutable release and linked-worktree dogfood (P1)

**Files:**
- Create/Update: `docs/verification/trusted-worktree-git-metadata-audit-2026-08-18.md`

- [ ] **Step 1: Commit and rebuild a clean-provenance candidate**

Rebuild after commit so package provenance reports `sourceDirty=false`.

- [ ] **Step 2: Stage candidate release with the existing service lifecycle**

Use the existing CLI `service install` staging path with `public:kodegpt-dev`, port `43121`, and the existing state root; then explicitly restart/cut over. Do not run the service directly from the worktree.

- [ ] **Step 3: Dogfood existing KodeGPT primitives from the linked worktree**

Exercise source inspect/search/read, disposable edit/revert, trusted shell/process, build/typecheck or bounded verification, typed Git status/diff/changes/history, benign failure diagnosis, and background cancellation.

- [ ] **Step 4: Audit worktree lifecycle friction**

Record the observed Git 2.43 behavior when `git worktree add` runs inside `/workspace`: absolute sandbox paths can be persisted into worktree metadata and require host-side repair. Do not add `git.worktree*` tools in this phase unless the evidence supports a separately approved public-authority design.

- [ ] **Step 5: Decide P1**

Classify each workflow as `NO_GAP`, `DOC/ERGONOMIC_GAP`, `EXISTING_PRIMITIVE_GAP`, or `NEW_BEHAVIOR_REQUIRES_SEPARATE_SPEC`. Prefer no new tool if existing primitives are sufficient.

---

### Task 7: PR, exact-head CI, merge, merged-main release, and closure

**Files:**
- Reconcile: `.ai-bridge/current-plan.md`
- Append: `docs/implementation/v0.1-execution-tracker.md`
- Finalize: P1 verification audit.

- [ ] **Step 1: Re-run fresh deterministic gates after docs/review changes**
- [ ] **Step 2: Push feature branch and create one focused PR**
- [ ] **Step 3: Require exact-head CI success and address only evidence-backed failures**
- [ ] **Step 4: Guarded merge the exact reviewed head**
- [ ] **Step 5: Fast-forward canonical local `main` to exact merged `origin/main`**
- [ ] **Step 6: Build/stage immutable merged-main release and explicitly restart**
- [ ] **Step 7: Post-cutover smoke linked-worktree typed Git/process/verification**
- [ ] **Step 8: Clean merged implementation worktree and active temporary trust record only after closure is proven**
