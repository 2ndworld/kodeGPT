# KodeGPT Trusted Development Parity & Ergonomics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make KodeGPT `trusted` verification reliable by restoring host-compatible DNS inside Bubblewrap and persisting a KodeGPT-owned Cargo home, while preserving all existing sandbox/trust boundaries.

**Architecture:** Keep the current process/verification architecture. Add one narrow read-only systemd-resolved runtime mount for unrestricted trusted networking when the host `/etc/resolv.conf` requires it, and one KodeGPT-owned writable Cargo-home mount under the existing state root for Rust-capable `trusted` processes. Do not add public MCP tools or a generic dependency-state framework.

**Tech Stack:** Rust, Bubblewrap, existing KodeGPT runtime/process/spool/audit infrastructure, pnpm/Vitest, Cargo.

## Global Constraints

- Canonical repo: `/home/sauron/dev/kodegpt`
- Canonical pre-phase baseline: `4cf2e481743aa3be0d13186eaeaa3c6aded8e987`
- Runtime version remains `0.1`.
- MCP protocol remains `2026-07-28`.
- MCP surface remains `0.10` with exactly 62 public tools unless a separately justified public-contract change is approved.
- Do not inherit host PATH.
- Do not inherit arbitrary host environment.
- Keep `HOME=/home/kodegpt`.
- Do not mount host HOME or host `~/.cargo`.
- Do not mount all of `/run`.
- Keep Bubblewrap, retained-root workspace, executable trust/revalidation, audit, spool/artifacts, cancellation, and process-group kill.
- `observe` and `develop` must remain unchanged.
- Use TDD; no production fix before the corresponding RED test.
- Do not implement generic provider, skill execution, generic mount/dependency-state, indexing, orchestration, Docker/root/admin, or desktop automation work.

---

## File Structure

Primary files expected to change:

- `docs/superpowers/specs/2026-08-17-kodegpt-trusted-development-parity-ergonomics-design.md`
  - approved design freeze.
- `docs/superpowers/plans/2026-08-18-kodegpt-trusted-development-parity-ergonomics.md`
  - this implementation plan.
- `crates/sandbox/src/bubblewrap.rs`
  - resolver runtime mount and single managed Cargo-home bind.
- `crates/runtime/src/process.rs`
  - state-root plumbing into process launch and trusted-only Cargo-home preparation.
- `crates/runtime/src/dispatcher.rs`
  - supply the internal KodeGPT state root to process execution.
- `.ai-bridge/current-plan.md`
  - reconcile current execution state after implementation/merge.
- `docs/implementation/v0.1-execution-tracker.md`
  - append closure without rewriting historical chronology.
- optional `docs/verification/trusted-development-parity-audit-2026-08-18.md`
  - P1 evidence-only workflow parity record after P0 passes.

Do not create a new public TypeScript/MCP capability for this work.

---

### Task 1: Restore Approved Spec and Plan on the Design Branch

**Files:**
- Create: `docs/superpowers/specs/2026-08-17-kodegpt-trusted-development-parity-ergonomics-design.md`
- Create: `docs/superpowers/plans/2026-08-18-kodegpt-trusted-development-parity-ergonomics.md`

**Interfaces:**
- Consumes: canonical `main` at `4cf2e481...` and remote branch `design/trusted-dev-parity-ergonomics`.
- Produces: a committed design/plan baseline from which the implementation worktree is created.

- [ ] **Step 1: Load required Superpowers skills**

Read/use:

`using-superpowers` -> `brainstorming` continuity -> `writing-plans`.

The design is already approved. Do not reopen broad design exploration unless fresh repository evidence contradicts the spec.

- [ ] **Step 2: Verify canonical state**

Run:

```bash
cd /home/sauron/dev/kodegpt
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
```

Expected:

- clean working tree;
- `HEAD == origin/main`;
- baseline initially `4cf2e481743aa3be0d13186eaeaa3c6aded8e987`, unless a newer intentional canonical merge is discovered. If newer, reconcile before proceeding rather than resetting history.

- [ ] **Step 3: Refresh the existing design branch**

Run host-side through CodexPro if KodeGPT DNS is still broken:

```bash
git fetch origin design/trusted-dev-parity-ergonomics
git switch -C design/trusted-dev-parity-ergonomics origin/design/trusted-dev-parity-ergonomics
```

Expected: branch exists and initially contains no completed spec commit beyond the old baseline.

- [ ] **Step 4: Write the exact approved spec and plan**

Copy the attached/generated spec and plan content into the exact paths above.

- [ ] **Step 5: Self-review the documents**

Check:

```bash
grep -RInE '\b(TBD|TODO|implement later|fill in)\b' \
  docs/superpowers/specs/2026-08-17-kodegpt-trusted-development-parity-ergonomics-design.md \
  docs/superpowers/plans/2026-08-18-kodegpt-trusted-development-parity-ergonomics.md || true
git diff --check
```

Expected: no placeholders, no whitespace errors.

- [ ] **Step 6: Commit the design baseline**

```bash
git add \
  docs/superpowers/specs/2026-08-17-kodegpt-trusted-development-parity-ergonomics-design.md \
  docs/superpowers/plans/2026-08-18-kodegpt-trusted-development-parity-ergonomics.md
git commit -m "docs: specify trusted development parity ergonomics"
```

---

### Task 2: Create an Isolated Implementation Worktree

**Files:**
- No source changes yet.
- Worktree target: `/home/sauron/dev/kodegpt/.worktrees/trusted-development-parity-ergonomics`
- Branch: `fix/trusted-development-parity-ergonomics`

**Interfaces:**
- Consumes: committed design branch from Task 1.
- Produces: isolated source branch for TDD.

- [ ] **Step 1: Load `using-git-worktrees`**

Use the Superpowers worktree skill. Do not manually improvise a conflicting directory.

- [ ] **Step 2: Create the implementation worktree from the design commit**

Equivalent desired Git state:

```bash
git worktree add \
  /home/sauron/dev/kodegpt/.worktrees/trusted-development-parity-ergonomics \
  -b fix/trusted-development-parity-ergonomics \
  design/trusted-dev-parity-ergonomics
```

- [ ] **Step 3: Prove the worktree is clean**

```bash
cd /home/sauron/dev/kodegpt/.worktrees/trusted-development-parity-ergonomics
git status --short --branch
git log -1 --oneline
```

Expected: clean branch containing the approved design/plan commit.

- [ ] **Step 4: Load `systematic-debugging` and `test-driven-development`**

Preserve the reproduced root-cause evidence. Do not patch before the RED tests below.

---

### Task 3: RED Test the Resolver Runtime Mount

**Files:**
- Modify/Test: `crates/sandbox/src/bubblewrap.rs`

**Interfaces:**
- Consumes: existing `SandboxLaunchSpec`, `SandboxNetworkMode`, `BubblewrapProvider::spawn/build_command`.
- Produces: a narrow helper that recognizes when `/etc/resolv.conf` requires `/run/systemd/resolve`, plus command construction evidence for a read-only bind.

- [ ] **Step 1: Add a pure resolver-target classification test**

Add a small helper contract in the test module first. The production helper should ultimately behave like:

```rust
fn resolver_runtime_directory(resolved_resolv_conf: &Path) -> Option<&'static Path> {
    if resolved_resolv_conf.starts_with("/run/systemd/resolve") {
        Some(Path::new("/run/systemd/resolve"))
    } else {
        None
    }
}
```

Add RED assertions equivalent to:

```rust
#[test]
fn systemd_resolved_target_requires_only_the_systemd_resolver_runtime_directory() {
    assert_eq!(
        resolver_runtime_directory(Path::new("/run/systemd/resolve/stub-resolv.conf")),
        Some(Path::new("/run/systemd/resolve"))
    );
    assert_eq!(
        resolver_runtime_directory(Path::new("/etc/static-resolv.conf")),
        None
    );
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cargo test -p kodegpt-sandbox systemd_resolved_target_requires_only_the_systemd_resolver_runtime_directory -- --exact
```

Expected: FAIL because the helper/behavior does not exist yet.

- [ ] **Step 3: Add a command-construction RED test**

Construct an unrestricted `SandboxLaunchSpec` and assert that when a resolver runtime fd is supplied, command debug/args contain:

- `--dir /run`
- `--dir /run/systemd`
- `--ro-bind-fd <fd> /run/systemd/resolve`

and do **not** contain a broad bind of `/run` to `/run`.

Keep the test at the lowest level already used by `build_command` tests.

- [ ] **Step 4: Run the sandbox test module**

```bash
cargo test -p kodegpt-sandbox bubblewrap::tests -- --nocapture
```

Expected: new resolver test(s) fail; historical sandbox tests continue to reveal no unrelated regression.

- [ ] **Step 5: Commit RED tests only**

```bash
git add crates/sandbox/src/bubblewrap.rs
git commit -m "test(sandbox): cover trusted resolver runtime mount"
```

---

### Task 4: Implement the Narrow Resolver Mount

**Files:**
- Modify: `crates/sandbox/src/bubblewrap.rs`

**Interfaces:**
- Consumes: `SandboxNetworkMode::Unrestricted`, actual host `/etc/resolv.conf`, existing fd-based bind construction.
- Produces: optional read-only fd mount for `/run/systemd/resolve`.

- [ ] **Step 1: Implement resolver target discovery**

Use:

```rust
let resolved = fs::canonicalize("/etc/resolv.conf")?;
```

Classify only the known systemd-resolved runtime target. If `/etc/resolv.conf` does not resolve beneath `/run/systemd/resolve`, return `None` and preserve current `/etc` behavior.

Do not mount all of `/run`.

- [ ] **Step 2: Open the resolver directory only for unrestricted networking**

Inside `BubblewrapProvider::spawn`, only when:

```rust
spec.network == SandboxNetworkMode::Unrestricted
```

open `/run/systemd/resolve` read-only as an inherited directory fd when required, clear `FD_CLOEXEC` using the same pattern as other fd mounts, and pass the fd to `build_command`.

Do not change `Deny`, `Localhost`, or `Allowlist`.

- [ ] **Step 3: Bind the resolver directory read-only**

In `build_command`, when the resolver fd is present, add exactly the parent dirs and narrow read-only fd bind:

```text
--dir /run
--dir /run/systemd
--ro-bind-fd <fd> /run/systemd/resolve
```

Do not use `--bind`, `--ro-bind /run /run`, or host env inheritance.

- [ ] **Step 4: Run the focused sandbox tests**

```bash
cargo test -p kodegpt-sandbox bubblewrap::tests -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Run sandbox crate tests and formatting**

```bash
cargo fmt --all -- --check
cargo test -p kodegpt-sandbox
```

Expected: PASS.

- [ ] **Step 6: Commit the resolver fix**

```bash
git add crates/sandbox/src/bubblewrap.rs
git commit -m "fix(sandbox): preserve resolver runtime for unrestricted network"
```

---

### Task 5: RED Test KodeGPT-Owned Cargo State Persistence

**Files:**
- Modify/Test: `crates/runtime/src/process.rs`
- Potential test support in: `crates/sandbox/src/bubblewrap.rs`

**Interfaces:**
- Consumes: `ProfileName::Trusted`, KodeGPT state root, `SandboxLaunchSpec`.
- Produces: trusted-only managed Cargo-home path plumbing.

- [ ] **Step 1: Define the intended managed path contract in tests**

The intended host-side path is exactly:

```text
<state-root>/tool-state/cargo-home
```

The intended child path is:

```text
/home/kodegpt/.cargo
```

Add a helper expectation equivalent to:

```rust
fn managed_cargo_home(state_root: &Path) -> PathBuf {
    state_root.join("tool-state").join("cargo-home")
}
```

- [ ] **Step 2: Add a trusted persistence RED test**

Use temporary state/workspace fixtures and a trusted Rust-capable policy.

First sandbox invocation writes a marker through:

```text
$HOME/.cargo/kodegpt-persistence-marker
```

Second independent sandbox invocation reads the same marker.

The test must fail before the managed bind exists.

Prefer a fake trusted executable/shell fixture; do not require crates.io.

- [ ] **Step 3: Add non-trusted RED assertions**

Add tests proving:

- `develop` does not receive the managed Cargo-home bind;
- `observe` process behavior remains denied/unchanged;
- `HOME`, `PATH`, `TMPDIR`, `PWD` cannot be overridden through request env.

- [ ] **Step 4: Run focused process tests**

```bash
cargo test -p kodegpt-runtime process::tests -- --nocapture
```

Expected: new managed-state persistence test fails; existing trusted multi-toolchain tests remain green.

- [ ] **Step 5: Commit RED tests**

```bash
git add crates/runtime/src/process.rs crates/sandbox/src/bubblewrap.rs
git commit -m "test(runtime): require persistent trusted cargo state"
```

---

### Task 6: Implement Managed Cargo Home Without Host HOME Reuse

**Files:**
- Modify: `crates/runtime/src/dispatcher.rs`
- Modify: `crates/runtime/src/process.rs`
- Modify: `crates/sandbox/src/bubblewrap.rs`

**Interfaces:**
- Consumes:
  - internal KodeGPT state root from `AuditSink::state_root()`;
  - trusted runtime policy;
  - `SandboxLaunchSpec`.
- Produces:
  - host path `<state-root>/tool-state/cargo-home`;
  - writable bind at `/home/kodegpt/.cargo` for Rust-capable `trusted` processes only.

- [ ] **Step 1: Pass the internal state root to process launch**

Extend the internal `run_process(...)` plumbing to receive a `PathBuf`/borrowed path derived only from:

```rust
audit.state_root()
```

Update all call sites and process tests explicitly.

Do not derive this path from request payload, workspace source, host HOME, or arbitrary env.

- [ ] **Step 2: Prepare the managed Cargo directory in `process.rs`**

For:

```rust
policy.name == ProfileName::Trusted
```

and when policy allows `cargo` or `rustc`, create:

```rust
state_root.join("tool-state").join("cargo-home")
```

Use `fs::create_dir_all`.

Set restrictive directory permissions (`0700`) where the current Unix implementation supports it.

Attach this path to the sandbox launch spec.

For `Develop` and `Observe`, leave the new spec field unset.

- [ ] **Step 3: Add one targeted field to `SandboxLaunchSpec`**

Use a targeted field such as:

```rust
pub cargo_home: Option<PathBuf>,
```

defaulting to `None`.

Do not introduce generic `managed_mounts`, plugin mount registries, or dependency-state frameworks.

- [ ] **Step 4: Open and bind the Cargo-home directory in Bubblewrap**

In `BubblewrapProvider::spawn`:

- open the supplied KodeGPT-owned Cargo-home directory;
- pass its fd to `build_command`;
- keep it alive until after `Command::spawn`;
- use an fd bind to child path `/home/kodegpt/.cargo`.

The base `/home/kodegpt` remains the current private HOME. Only `.cargo` becomes persistent.

- [ ] **Step 5: Preserve default Cargo semantics**

Do not set host `CARGO_HOME`.

Do not add a request-controlled `CARGO_HOME`.

Because `HOME=/home/kodegpt`, Cargo will naturally use:

`/home/kodegpt/.cargo`.

- [ ] **Step 6: Run focused runtime/sandbox tests**

```bash
cargo fmt --all -- --check
cargo test -p kodegpt-sandbox
cargo test -p kodegpt-runtime process::tests -- --nocapture
```

Expected: PASS, including persistence and existing multi-toolchain tests.

- [ ] **Step 7: Commit managed Cargo state**

```bash
git add \
  crates/runtime/src/dispatcher.rs \
  crates/runtime/src/process.rs \
  crates/sandbox/src/bubblewrap.rs
git commit -m "fix(runtime): persist trusted cargo state"
```

---

### Task 7: Security and Regression Verification Before Dogfood

**Files:**
- Modify tests only if a missing invariant is discovered.
- Do not change public MCP schemas unless explicitly justified.

**Interfaces:**
- Consumes: Tasks 3-6.
- Produces: local proof that the fix did not widen authority.

- [ ] **Step 1: Run Rust formatting/check/tests**

```bash
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
```

Expected: PASS.

- [ ] **Step 2: Run TypeScript deterministic gates**

```bash
pnpm run typecheck
pnpm run build
pnpm run test
pnpm run verify:forbidden
pnpm run verify:package
```

Expected: PASS. Baseline expectation for `pnpm run test` is at least the prior healthy 118 files / 812 tests, adjusted only for intentionally added tests.

- [ ] **Step 3: Review the exact diff for forbidden widening**

Run:

```bash
git diff design/trusted-dev-parity-ergonomics...HEAD -- \
  crates/runtime/src/dispatcher.rs \
  crates/runtime/src/process.rs \
  crates/sandbox/src/bubblewrap.rs
git diff --check
```

Verify absence of:

- host HOME mount;
- host `~/.cargo`;
- host PATH inheritance;
- arbitrary env inheritance;
- broad `/run` mount;
- Docker/root/admin changes;
- public MCP tool additions.

- [ ] **Step 4: Inspect public surface fixtures/contracts**

Use existing tests and source search to confirm the expected public tool count remains 62 and surface remains `0.10`.

- [ ] **Step 5: Run `verification-before-completion`**

Do not claim P0 fixed yet; this only establishes candidate correctness before live dogfood.

---

### Task 8: Build Candidate Runtime and Live-Dogfood P0

**Files:**
- Production files already modified.
- No new public surface.

**Interfaces:**
- Consumes: locally passing candidate branch.
- Produces: direct KodeGPT evidence using the candidate runtime.

- [ ] **Step 1: Rebuild/stage using the repository's existing package/service flow**

Use the existing service lifecycle. Do not invent a second deployment mechanism.

Before changing the active service, inspect:

```bash
kodegpt service status
kodegpt service --help
```

Use the existing install/stage command documented by the repo, then perform an explicit restart/cutover only after candidate staging succeeds.

- [ ] **Step 2: Confirm candidate service health**

Through KodeGPT:

- `system.health`
- `system.capabilities`
- current workspace/profile

Expected:

- health OK;
- runtime/protocol/surface `0.1 / 2026-07-28 / 0.10`;
- exactly 62 public tools;
- trusted profile still has `inheritEnv=false`.

- [ ] **Step 3: Prove trusted DNS**

Run a trusted process equivalent to:

```bash
getent hosts github.com
```

or a bounded Git/Cargo network call.

Expected: hostname resolves successfully.

- [ ] **Step 4: Prove Cargo executable composition**

Run:

```text
process.run(cargo --version)
```

Expected: exit 0 and Cargo version output.

Also run a Node child that resolves Cargo as previously reproduced.

Expected: exit 0.

- [ ] **Step 5: Run cold/warming `cargo:test`**

Run:

```text
verify.run(cargo:test)
```

Capture:

- operation state;
- exit code;
- stdout/stderr preview;
- artifact/spool;
- audit evidence.

Expected on the known healthy baseline: PASS.

- [ ] **Step 6: Prove the Cargo state is warm and persistent**

Immediately run trusted:

```bash
cargo check --workspace --offline
```

Expected: PASS.

This is the key proof that registry/source state survived from the previous sandbox invocation without using host `~/.cargo`.

- [ ] **Step 7: Run `package:test`**

Run:

```text
verify.run(package:test)
```

Expected on the known healthy baseline: PASS.

If it still ends in an opaque synthetic `128`, stop feature expansion and execute the contingency in Task 9.

- [ ] **Step 8: Prove cancellation/audit/spool**

Start a benign long-running background process through the existing process tool, cancel it through `process.cancel`, and inspect status/artifact/audit.

Expected: cancellation still transitions correctly and no unrelated process is killed.

- [ ] **Step 9: Confirm repository mutation boundary**

Run `git.status`.

Expected: no unexpected source mutation from verification.

---

### Task 9: Contingency Only — Preserve Real Signal Diagnostics if Opaque `128` Remains

**Files:**
- Modify/Test: `crates/runtime/src/process.rs`
- Potential internal protocol/adapter changes only if required by existing result shape.

**Interfaces:**
- Consumes: a freshly reproduced signalled process after Tasks 3-8.
- Produces: actionable evidence through the existing process operation/spool infrastructure.

**Gate:** Do not execute this task if `verify.run(package:test)` passes after resolver/cache fixes.

- [ ] **Step 1: Reproduce the remaining signalled child independently**

Record the exact command, `ExitStatus`, stdout/stderr, and operation artifact.

- [ ] **Step 2: Add a RED unit test for signalled-child reporting**

Use a child that self-terminates with a known signal. Assert that the operation no longer silently collapses the signal into an unexplained `128`.

- [ ] **Step 3: Implement the minimum diagnostic change**

Prefer one of:

- preserve a signal field in the existing internal operation result if compatible; or
- add an actionable stderr diagnostic such as `process terminated by signal SIGTERM (15)` while retaining compatibility for `exitCode`.

Do not create a new verification diagnostics service/tool.

- [ ] **Step 4: Run focused and full tests**

```bash
cargo fmt --all -- --check
cargo test -p kodegpt-runtime process::tests -- --nocapture
cargo test --workspace
pnpm run test
```

Expected: PASS.

- [ ] **Step 5: Commit only the proven diagnostic fix**

```bash
git add crates/runtime/src/process.rs
git commit -m "fix(runtime): preserve signalled process diagnostics"
```

---

### Task 10: P1 Practical Parity Audit — Evidence Before Any New Feature

**Files:**
- Create: `docs/verification/trusted-development-parity-audit-2026-08-18.md`
- Modify production code only if a small gap is proven and fits the approved primitive-first direction.

**Interfaces:**
- Consumes: fully passing P0 candidate and CodexPro workspace.
- Produces: a practical workflow comparison and a bounded decision on whether any P1 code change is justified.

- [ ] **Step 1: Run equivalent workflows in CodexPro and KodeGPT**

Exercise:

1. inspect repo;
2. search/read;
3. edit/patch a disposable worktree file and revert it;
4. shell/process;
5. build/test/typecheck;
6. git status/diff/changes;
7. intentionally trigger one benign failure and diagnose it;
8. run/cancel a background operation;
9. continue the iterative loop after failure.

- [ ] **Step 2: Record actual friction**

For each workflow record:

- number of user-visible/tool steps;
- missing evidence;
- need for unnecessary narrow tools;
- whether trusted shell already solves the use case;
- whether failure recovery is blocked.

- [ ] **Step 3: Classify findings**

Use only:

- `NO_GAP`
- `DOC/ERGONOMIC_GAP`
- `EXISTING_PRIMITIVE_GAP`
- `NEW_BEHAVIOR_REQUIRES_SEPARATE_SPEC`

- [ ] **Step 4: Implement only an approved small primitive gap**

A P1 implementation in this branch is allowed only if it:

- improves an existing primitive;
- does not add a cosmetic public tool;
- does not create a new subsystem;
- has a focused RED test;
- does not weaken sandbox/trust boundaries.

If the best fix requires a new public behavior or architecture, stop and create a separate follow-up spec instead.

- [ ] **Step 5: Commit the audit**

```bash
git add docs/verification/trusted-development-parity-audit-2026-08-18.md
git commit -m "docs: audit trusted development parity ergonomics"
```

---

### Task 11: Final Verification, Review, PR, Merge, and Cutover

**Files:**
- Reconcile: `.ai-bridge/current-plan.md`
- Reconcile: `docs/implementation/v0.1-execution-tracker.md`
- Production files from prior tasks.

**Interfaces:**
- Consumes: complete candidate branch.
- Produces: reviewed/merged canonical main and live immutable merged-main release.

- [ ] **Step 1: Run the full deterministic gate set fresh**

```bash
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
pnpm run typecheck
pnpm run build
pnpm run test
pnpm run verify:forbidden
pnpm run verify:package
git diff --check
```

Expected: all PASS.

- [ ] **Step 2: Run `requesting-code-review`**

Review for:

- resolver mount scope;
- managed-state authority;
- symlink/path risk;
- profile isolation;
- no host HOME/PATH/env widening;
- cancellation/audit/spool regressions;
- unnecessary abstraction.

Address only technically valid findings and use `receiving-code-review` before implementing review feedback.

- [ ] **Step 3: Reconcile closure docs without rewriting history**

Update `.ai-bridge/current-plan.md` and append the tracker with:

- exact root cause;
- exact commits;
- test evidence;
- live dogfood evidence;
- public surface unchanged;
- P1 audit outcome.

- [ ] **Step 4: Re-run the relevant gates after docs reconciliation**

At minimum:

```bash
pnpm run test
cargo test --workspace
git diff --check
```

plus any repo-specific docs/forbidden gate affected by the reconciliation.

- [ ] **Step 5: Push feature branch and open PR**

Use host-side CodexPro/GitHub if the old live KodeGPT service still has DNS trouble. Once candidate KodeGPT DNS is fixed, dogfood its Git remote path where safe.

PR title recommendation:

`fix(runtime): persist trusted cargo state and resolver access`

- [ ] **Step 6: Require exact-head CI success**

Do not merge on stale CI evidence.

- [ ] **Step 7: Merge and fast-forward canonical local main**

After merge:

```bash
cd /home/sauron/dev/kodegpt
git switch main
git fetch origin
git merge --ff-only origin/main
git status --short --branch
```

Expected: clean canonical main at the exact merge commit.

- [ ] **Step 8: Build/stage immutable merged-main release**

Use the existing KodeGPT service lifecycle and immutable release mechanism already established by PR #7. Do not run the live service from a worktree.

- [ ] **Step 9: Explicit restart/cutover**

Use existing CLI:

```bash
kodegpt service restart
kodegpt service status
```

Expected: running, listener ready, managed exposure healthy, new immutable release active.

- [ ] **Step 10: Post-cutover live smoke**

Re-run through live KodeGPT:

- `system.health`;
- capabilities/surface;
- trusted DNS;
- `cargo --version`;
- `cargo check --workspace --offline`;
- `verify.run(package:test)` or a bounded equivalent if full test was already freshly proven immediately pre-cutover;
- audit/cancellation smoke.

- [ ] **Step 11: Use `finishing-a-development-branch`**

Clean up merged worktree/branch only after final verification and canonical reconciliation are complete.
