# KodeGPT Bounded Linked-Worktree Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exactly `git.worktreeCreate` and `git.worktreeRemove` so KodeGPT can create and remove clean linked worktrees under `.worktrees/<name>` without persisting sandbox-only `/workspace/...` metadata or requiring host-side `git worktree repair`.

**Architecture:** Keep generic process authority unchanged. Add one private sandbox capability that can bind the already-retained workspace FD at its canonical display path only for the fixed typed worktree lifecycle operation, then add a separate closed private `git.worktree_mutation` RPC with structured results and postcondition validation. The public MCP layer exposes only two bounded tools and advances the semantic surface from `0.14 / 76` to `0.15 / 78`.

**Tech Stack:** Rust 2024 workspace (`crates/workspace-io`, `crates/sandbox`, `crates/protocol`, `crates/runtime`), TypeScript 5.9, Zod, Vitest, MCP server, Bubblewrap, Git 2.43 acceptance host.

**Spec:** `docs/superpowers/specs/2026-08-19-kodegpt-bounded-linked-worktree-lifecycle-design.md`

## Global Constraints

- Baseline is `ed5113f553b5d8beb24800165a07c01935165aa9` from merged PR #47.
- Current production stays `runtime 0.1 / protocol 2026-07-28 / surface 0.14 / 76 tools` until this feature is implemented, reviewed, merged, and cut over.
- Candidate public target is exactly `runtime 0.1 / protocol 2026-07-28 / surface 0.15 / 78 tools`.
- Public additions are exactly `git.worktreeCreate` and `git.worktreeRemove`.
- Destination is always `.worktrees/<name>`; callers never supply an arbitrary path.
- `git.worktreeCreate` consumes an already-existing local branch; it never creates, resets, or force-updates a branch.
- `git.worktreeRemove` never passes `--force` and never deletes the branch.
- No `git.worktreeList`, `git.worktreeInspect`, `git.worktreeMove`, `git.worktreeRepair`, `git.worktreePrune`, `git.worktreeLock`, or `git.worktreeUnlock` in v1.
- No generic canonical-path alias for `process.run`, `verify.run`, preview, browser, or caller-defined sandbox specs.
- No hidden repair after arbitrary shell commands.
- No worktree scheduler, task queue, autonomous agent runtime, worktree-per-agent orchestration, host HOME mount, generic external mount, or model/provider change.
- Existing linked-worktree `.git` metadata admission remains fail-closed and is reused for postcondition validation.
- All production edits are TDD: observe focused RED before the minimal implementation that makes the test GREEN.

---

### Task 1: Add a private canonical workspace alias to the sandbox boundary

**Files:**
- Modify: `crates/workspace-io/src/registry.rs`
- Modify: `crates/sandbox/src/bubblewrap.rs`
- Test: inline unit tests in `crates/workspace-io/src/registry.rs`
- Test: inline unit tests in `crates/sandbox/src/bubblewrap.rs`

**Interfaces:**
- Produces in `crates/workspace-io`:

```rust
pub struct ReadyWorkspaceRoot {
    pub root_fd: OwnedFd,
    pub canonical_display_root: PathBuf,
}

impl<P> WorkspaceRegistry<P> {
    pub fn duplicate_ready_root(
        &self,
        capability_id: &str,
    ) -> Result<ReadyWorkspaceRoot, WorkspaceRegistryError>;
}
```

- Produces in `crates/sandbox`:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceAlias {
    None,
    Canonical(PathBuf),
}

pub struct SandboxLaunchSpec {
    // existing fields unchanged
    pub workspace_alias: WorkspaceAlias,
}
```

- `WorkspaceAlias::Canonical` is runtime-owned internal authority. No TypeScript/public schema gets a corresponding field.

- [ ] **Step 1: Write failing workspace-registry tests for retained canonical identity**

Add tests next to `duplicate_ready_root_fd` coverage proving `duplicate_ready_root` returns a cloned FD plus the exact canonical display root and still rejects non-READY capabilities.

```rust
let ready = registry.duplicate_ready_root(&capability_id).unwrap();
assert_eq!(ready.canonical_display_root, canonical_root);
assert!(ready.root_fd.as_raw_fd() >= 0);
```

Run:

```bash
cargo test -p kodegpt-workspace-io duplicate_ready_root -- --nocapture
```

Expected: RED because `ReadyWorkspaceRoot` / `duplicate_ready_root` do not exist.

- [ ] **Step 2: Implement `ReadyWorkspaceRoot` without widening workspace registration**

Keep `canonical_display_root` private in stored `WorkspaceSecurityContext`; clone it only through `duplicate_ready_root` after `ready_context` succeeds. Preserve `duplicate_ready_root_fd` for existing callers during this task; do not force unrelated refactoring.

Run the focused workspace-io test again. Expected: PASS.

- [ ] **Step 3: Write failing sandbox tests for canonical alias construction**

Add tests that construct a normal trusted spec with `WorkspaceAlias::Canonical(PathBuf::from("/home/example/repo"))` and assert Bubblewrap argv contains two binds from the same retained workspace FD:

```text
--bind-fd <workspace-fd> /workspace
--dir /home
--dir /home/example
--dir /home/example/repo-parent-or-needed-prefix>
--bind-fd <same-workspace-fd> /home/example/repo
```

The test must also prove the parent host directories are represented only by sandbox-created empty `--dir` nodes; there must be no host `--bind`, `--ro-bind`, `--bind-fd`, or `--ro-bind-fd` for parent paths.

Add rejection tests for aliases that are:

```text
relative/path
/workspace
/proc/x
/dev/x
/tmp/x
/run/kodegpt/x
/home/kodegpt/x
```

Run:

```bash
cargo test -p kodegpt-sandbox workspace_alias -- --nocapture
```

Expected: RED because `WorkspaceAlias` and alias validation do not exist.

- [ ] **Step 4: Implement exact-FD canonical alias mounting**

In `SandboxLaunchSpec::new`, default to:

```rust
workspace_alias: WorkspaceAlias::None,
```

Add a validator that requires a clean absolute path, rejects `.` / `..`, and rejects collisions with sandbox-owned roots. Reuse the existing parent-directory emission pattern but do not bind host parents. After the normal `/workspace` bind, bind the same `workspace_fd` at the validated canonical alias using the same read-only/read-write mode as `workspace_access`.

Do not expose a setter through process input; callers can only populate the Rust field from compiled runtime code.

Run:

```bash
cargo test -p kodegpt-sandbox workspace_alias -- --nocapture
cargo test -p kodegpt-sandbox linked_worktree -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Commit the sandbox boundary**

```bash
git add crates/workspace-io/src/registry.rs crates/sandbox/src/bubblewrap.rs
git commit -m "feat(sandbox): add bounded canonical workspace alias"
```

---

### Task 2: Add closed Rust worktree lifecycle protocol and runtime authority

**Files:**
- Modify: `crates/protocol/src/types.rs`
- Modify: `crates/protocol/tests/protocol_contract.rs`
- Modify: `crates/runtime/src/audit.rs`
- Modify: `crates/runtime/src/dispatcher.rs`
- Modify: `crates/runtime/src/git.rs`
- Modify: `crates/sandbox/src/git_metadata.rs`
- Test: inline unit tests in `crates/runtime/src/git.rs`
- Test: inline unit tests in `crates/sandbox/src/git_metadata.rs`
- Test: runtime integration coverage under `crates/runtime/tests/` if a new standalone file keeps the scenario clearer

**Interfaces:**
- Produces private protocol input:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum GitWorktreeMutationParams {
    Create {
        capability_id: String,
        name: String,
        branch: String,
    },
    Remove {
        capability_id: String,
        name: String,
    },
}
```

- Produces runtime types:

```rust
pub enum GitWorktreeMutation {
    Create { name: String, branch: String },
    Remove { name: String },
}

#[derive(Debug, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum GitWorktreeMutationResult {
    Create {
        schema_version: u32,
        name: String,
        relative_path: String,
        branch: String,
        head_oid: String,
    },
    Remove {
        schema_version: u32,
        name: String,
        relative_path: String,
        removed: bool,
    },
}
```

- Adds private RPC method `git.worktree_mutation`.
- Extends `LinkedWorktreeGitMetadata` internally with enough validated admin identity for locked-state and reciprocal-postcondition checks, without exposing host paths publicly.

- [ ] **Step 1: Write failing protocol contract tests**

Add closed-deserialization fixtures:

```json
{"operation":"create","capabilityId":"cap_1","name":"phase7","branch":"feat/phase7"}
{"operation":"remove","capabilityId":"cap_1","name":"phase7"}
```

Prove unknown fields, missing fields, and cross-operation fields are rejected.

Run:

```bash
cargo test -p kodegpt-protocol git_worktree -- --nocapture
```

Expected: RED because `GitWorktreeMutationParams` does not exist.

- [ ] **Step 2: Add protocol enum and runtime audit actions**

Add exactly:

```rust
AuditAction::GitWorktreeCreate
AuditAction::GitWorktreeRemove
```

Do not add a generic `GitWorktree` action or caller-defined operation string.

Run the protocol tests. Expected: PASS for the protocol portion.

- [ ] **Step 3: Write failing runtime validation tests for names and branch semantics**

Create tests for the worktree name grammar:

```text
PASS: phase7
PASS: review-47
PASS: x.y_z
FAIL: .
FAIL: ..
FAIL: -phase7
FAIL: feature/phase7
FAIL: feature phase7
FAIL: ../escape
FAIL: a%2Fb
FAIL: 65-character-name
```

Use existing `valid_branch_name` semantics for `branch`, and verify create rejects invalid branch grammar before Git execution.

Run:

```bash
cargo test -p kodegpt-runtime worktree_input -- --nocapture
```

Expected: RED.

- [ ] **Step 4: Implement bounded destination and `.worktrees` parent handling**

Add constants:

```rust
const WORKTREE_CONTAINER: &str = ".worktrees";
const WORKTREE_NAME_MAX_BYTES: usize = 64;
```

Derive only:

```rust
let relative_path = format!(".worktrees/{name}");
let canonical_target = canonical_root.join(WORKTREE_CONTAINER).join(name);
```

Create `.worktrees` only through a fixed Rust `mkdirat`/openat-safe helper rooted at the retained workspace FD. Existing `.worktrees` must be a real directory, not a symlink. The helper must not accept caller-provided parent paths.

- [ ] **Step 5: Write failing create-lifecycle test that reproduces the Git 2.43 bug**

Build a disposable repository and run the new create authority. Assert all of the following after the command:

```rust
assert_eq!(result.relative_path(), ".worktrees/phase7");
assert_eq!(result.branch(), "feat/phase7");
assert_eq!(result.head_oid().len(), 40);
assert!(!child_dot_git_contents.contains("/workspace/"));
assert!(!admin_backlink_contents.contains("/workspace/"));
```

Then open the created child directory as a retained FD and call the existing linked-worktree metadata validator. Expected: it succeeds without `git worktree repair`.

Run:

```bash
cargo test -p kodegpt-runtime worktree_create -- --nocapture
```

Expected: RED before the canonical alias is wired into Git execution.

- [ ] **Step 6: Implement create with fixed Git argv and postcondition validation**

Use a fixed command equivalent to:

```text
git worktree add <canonical-root>/.worktrees/<name> refs/heads/<branch>
```

The runtime owns every argv element except validated `name` and `branch`. Do not pass `-B`, `--force`, `--detach`, arbitrary config, or a caller-defined revision.

Run the command with:

```rust
WorkspaceAccess::ReadWrite
GitMetadataAccess::ReadWrite
SandboxNetworkMode::Deny
WorkspaceAlias::Canonical(canonical_root.clone())
```

After exit code 0, re-open `.worktrees/<name>` beneath the retained root with strict no-symlink semantics and reuse `open_linked_worktree_git_metadata` to prove the child pointer/admin directory/`commondir`/backlink are reciprocal and canonical. Run fixed Git `symbolic-ref --quiet HEAD` and `rev-parse --verify HEAD` through the child identity or equivalent validated internal metadata reads; require the requested branch and a full OID.

If Git exits 0 but validation fails, return `GIT_WORKTREE_INCONSISTENT`. Do not rewrite metadata and do not auto-remove with force.

Run the focused create tests. Expected: PASS.

- [ ] **Step 7: Write failing clean-remove / dirty / locked tests**

Cover:

```text
clean created worktree -> remove succeeds
tracked modification -> GIT_WORKTREE_DIRTY and child remains
untracked file -> GIT_WORKTREE_DIRTY and child remains
locked admin entry -> GIT_WORKTREE_LOCKED and child remains
foreign or mismatched .git backlink -> GIT_WORKTREE_METADATA_INVALID
missing target -> deterministic not-found/invalid-state contract
```

Run:

```bash
cargo test -p kodegpt-runtime worktree_remove -- --nocapture
```

Expected: RED.

- [ ] **Step 8: Implement non-force remove**

Before mutation, validate the child linked-worktree metadata and check its admin directory for `locked`. Run a fixed bounded `git -C <canonical-target> status --porcelain=v1 --untracked-files=all`; any output means dirty. Then run the fixed owner-repository command equivalent to:

```text
git worktree remove <canonical-root>/.worktrees/<name>
```

Never add `--force`. On exit 0, prove both the child path and corresponding admin entry are gone before returning `removed: true`. Do not delete the local branch.

Run the focused remove tests. Expected: PASS.

- [ ] **Step 9: Wire dispatcher policy, audit, and stable runtime error mapping**

Add a `git.worktree_mutation` dispatcher branch that:

1. decodes only `GitWorktreeMutationParams`;
2. requires READY workspace;
3. requires `ProfileName::Trusted && allow_write`;
4. emits `GitWorktreeCreate` / `GitWorktreeRemove` decision before mutation;
5. obtains `duplicate_ready_root()` so both retained FD and canonical display path come from the same registered workspace identity;
6. runs blocking Git lifecycle code;
7. maps runtime errors to stable messages without returning canonical paths.

Reserve explicit runtime messages for:

```text
GIT_WORKTREE_INPUT_INVALID
GIT_WORKTREE_TARGET_EXISTS
GIT_WORKTREE_BRANCH_MISSING
GIT_WORKTREE_BRANCH_IN_USE
GIT_WORKTREE_METADATA_INVALID
GIT_WORKTREE_DIRTY
GIT_WORKTREE_LOCKED
GIT_WORKTREE_UNAVAILABLE
GIT_WORKTREE_FAILED
GIT_WORKTREE_INCONSISTENT
```

Re-use `WORKSPACE_NOT_READY` and `GIT_POLICY_DENIED` where applicable.

- [ ] **Step 10: Run complete Rust gates and commit**

```bash
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
```

Expected: PASS.

Commit:

```bash
git add crates/protocol crates/runtime crates/sandbox crates/workspace-io
git commit -m "feat(git): add bounded worktree lifecycle authority"
```

---

### Task 3: Thread typed worktree lifecycle through core and capabilities

**Files:**
- Modify: `packages/core/src/workspace-manager.ts`
- Modify: `packages/core/src/workspace-manager.test.ts`
- Modify: `packages/capabilities/src/contracts.ts`
- Modify: `packages/capabilities/src/schemas.ts`
- Modify: `packages/capabilities/src/adapters.ts`
- Modify: `packages/capabilities/src/git-local.ts`
- Modify: `packages/capabilities/src/git-local.test.ts`
- Modify: `packages/capabilities/src/native-capability-service.ts`
- Modify: `packages/capabilities/src/test-support.ts`
- Modify: `packages/capabilities/src/errors.ts`
- Modify: `packages/capabilities/src/index.ts`
- Modify: `packages/capabilities/src/skill-metadata.ts`

**Interfaces:**
- Add contracts:

```ts
export interface GitWorktreeCreateInput {
  workspaceId: string;
  name: string;
  branch: string;
}

export interface GitWorktreeRemoveInput {
  workspaceId: string;
  name: string;
}

export interface GitWorktreeCreateResult {
  schemaVersion: 1;
  operation: "create";
  name: string;
  relativePath: `.worktrees/${string}`;
  branch: string;
  headOid: string;
}

export interface GitWorktreeRemoveResult {
  schemaVersion: 1;
  operation: "remove";
  name: string;
  relativePath: `.worktrees/${string}`;
  removed: true;
}
```

- Extend `GitLocalMutationAdapter` or add a narrowly named sibling `GitWorktreeMutationAdapter` with:

```ts
worktreeCreate(workspaceId: string, name: string, branch: string): Promise<GitWorktreeCreateResult>;
worktreeRemove(workspaceId: string, name: string): Promise<GitWorktreeRemoveResult>;
```

Prefer a sibling adapter if it keeps the existing generic local-mutation result contract unchanged.

- [ ] **Step 1: Write failing Zod contract tests**

Add `GitWorktreeNameSchema` with exact constraints:

```ts
z.string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine((value) => value !== "." && value !== "..")
```

`GitWorktreeCreateInputSchema` must be `.strict()` and reuse existing `gitBranchNameSchema` for `branch`. `GitWorktreeRemoveInputSchema` is also strict.

Results must reject canonical host paths, extra fields, malformed OIDs, and `removed: false`.

Run:

```bash
pnpm exec vitest run packages/capabilities/src/git-local.test.ts --no-file-parallelism
```

Expected: RED.

- [ ] **Step 2: Implement contracts/schemas/errors**

Add the two capability IDs to `NATIVE_CAPABILITY_IDS` only when the service methods are wired. Add the ten worktree-specific error codes listed in Task 2 to `CapabilityErrorCode`; do not mark any of them as automatically retryable.

Run the focused capability tests. Expected: schema tests PASS while service-call tests remain RED.

- [ ] **Step 3: Write failing core manager tests for private RPC payload/result validation**

Add tests proving:

```ts
await manager.gitWorktreeCreate("ws_1", "phase7", "feat/phase7")
```

sends exactly:

```json
{
  "method": "git.worktree_mutation",
  "params": {
    "capabilityId": "cap_...",
    "operation": "create",
    "name": "phase7",
    "branch": "feat/phase7"
  }
}
```

and remove sends no branch. Invalid result fields or raw host paths must become `RUNTIME_PROTOCOL_INVALID`.

Run:

```bash
pnpm exec vitest run packages/core/src/workspace-manager.test.ts --no-file-parallelism
```

Expected: RED.

- [ ] **Step 4: Implement `WorkspaceManager.gitWorktreeCreate/Remove`**

Add one private helper:

```ts
async #gitWorktreeMutation(
  workspaceId: string,
  operation: "create" | "remove",
  params: Record<string, unknown>
): Promise<WorkspaceGitWorktreeMutationResult>
```

It must call only `git.worktree_mutation`, validate the exact structured result, map only known runtime worktree errors, and never surface raw runtime payload fields.

Run the core test. Expected: PASS.

- [ ] **Step 5: Implement capability functions and adapter wiring**

Add:

```ts
export async function gitWorktreeCreate(
  authority: GitLocalAuthorityAdapter,
  mutation: GitWorktreeMutationAdapter,
  input: GitWorktreeCreateInput
): Promise<GitWorktreeCreateResult>

export async function gitWorktreeRemove(
  authority: GitLocalAuthorityAdapter,
  mutation: GitWorktreeMutationAdapter,
  input: GitWorktreeRemoveInput
): Promise<GitWorktreeRemoveResult>
```

Use the same `trusted && allowWrite` gate as existing local Git mutation before calling the adapter. Normalize only known worktree codes; unknown errors become `GIT_WORKTREE_FAILED`.

Add concise skill metadata descriptions that describe fixed `.worktrees/<name>` lifecycle, not generic worktree management.

Run:

```bash
pnpm exec vitest run packages/capabilities/src/git-local.test.ts packages/core/src/workspace-manager.test.ts --no-file-parallelism
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the typed core/capability layer**

```bash
git add packages/core packages/capabilities
git commit -m "feat(capabilities): expose typed worktree lifecycle"
```

---

### Task 4: Expose exactly two MCP tools and bump the semantic surface to 0.15 / 78

**Files:**
- Modify: `packages/mcp-server/src/tool-context.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/server.test.ts`
- Modify: `packages/mcp-server/src/structured-results.test.ts`
- Modify: `packages/mcp-server/src/surface-version.ts`
- Modify: `packages/mcp-server/src/skills.test.ts` if skill metadata equality requires it
- Modify: `tests/fixtures/mcp-surface.ts`
- Modify: `tests/integration/mcp-stdio.test.ts`
- Modify: `tests/security/git-helper-isolation.test.ts`
- Modify: `tests/security/security-invariants.test.ts`
- Modify: canonical JSON schema file(s) under `schemas/` that enumerate public capability inputs/results
- Modify: CLI/start test fixtures that construct exhaustive native adapters if TypeScript compilation identifies them

**Interfaces:**
- Public tool names and required keys are exactly:

```ts
{ name: "git.worktreeCreate", required: ["workspaceId", "name", "branch"] }
{ name: "git.worktreeRemove", required: ["workspaceId", "name"] }
```

- Surface constant becomes:

```ts
export const MCP_SURFACE_VERSION = "0.15" as const;
```

- [ ] **Step 1: Make the surface equality tests RED first**

Update expected fixture names/count to include exactly the two new tools and expected semantic version `0.15`, before production tool registration.

Run:

```bash
pnpm exec vitest run packages/mcp-server/src/server.test.ts tests/integration/mcp-stdio.test.ts --no-file-parallelism
```

Expected: RED because production still reports `0.14 / 76` and lacks the tools.

- [ ] **Step 2: Add tool context methods and registrations**

Wire tool context to `NativeCapabilityService` and register with the corresponding strict Zod schemas. Handlers return only `GitWorktreeCreateResult` or `GitWorktreeRemoveResult`; do not wrap raw Git output or artifact metadata.

- [ ] **Step 3: Add structured-result tests**

Prove successful create/remove payloads are exposed exactly, and prove an adapter result containing an extra field such as:

```json
{"canonicalPath":"/home/sauron/dev/kodegpt/.worktrees/phase7"}
```

is rejected rather than forwarded.

Run:

```bash
pnpm exec vitest run packages/mcp-server/src/structured-results.test.ts --no-file-parallelism
```

Expected: PASS.

- [ ] **Step 4: Update security invariants and forbidden public authority assertions**

Keep assertions that there is no:

```text
git.worktreeList
git.worktreeRepair
git.worktreeMove
git.worktreePrune
git.worktreeLock
git.worktreeUnlock
workflow.run
skill.run
provider.invoke
```

Add audit-action assertions for `GitWorktreeCreate` and `GitWorktreeRemove`, and assert the public result schema has no canonical host-path field.

- [ ] **Step 5: Update surface version and canonical schema parity**

Set `MCP_SURFACE_VERSION = "0.15"`, update exact 78-tool fixtures, and update JSON schema parity for the two inputs/results/private runtime request as required by the repository's existing protocol parity tests.

Run:

```bash
pnpm exec vitest run packages/mcp-server tests/protocol tests/integration tests/security --no-file-parallelism
pnpm run typecheck
pnpm run build
```

Expected: PASS.

- [ ] **Step 6: Commit the MCP surface**

```bash
git add packages/mcp-server tests schemas apps/cli
git commit -m "feat(mcp): add bounded worktree lifecycle tools"
```

---

### Task 5: Prove end-to-end lifecycle behavior and canonical-path isolation

**Files:**
- Modify/Create: focused runtime/integration tests under `crates/runtime/tests/` as needed
- Modify: `tests/integration/full-stack.test.ts`
- Modify: `tests/isolation/` or `tests/security/security-invariants.test.ts` for canonical-alias non-exposure
- Modify: `docs/verification/trusted-worktree-git-metadata-audit-2026-08-18.md` only by appending a superseding Phase 7 note; do not rewrite historical evidence

**Interfaces:**
- Acceptance sequence is exactly:

```text
git.branchCreate
-> git.worktreeCreate
-> child workspace open/trust smoke
-> ordinary child git.status / file mutation / git.diff smoke
-> child close
-> parent reopen
-> git.worktreeRemove
-> git.branchDelete
```

- [ ] **Step 1: Add a RED isolation test proving generic trusted process has no canonical alias**

Use the current linked-worktree/canonical-source isolation fixture. A trusted `process.run` probe for the owner repository canonical path must still report the path as absent, while the same repository remains available only at `/workspace`.

Run the focused isolation test. Expected: it should PASS even before worktree lifecycle implementation if Task 1 did not accidentally widen generic process authority; if it fails, stop and fix Task 1 before proceeding.

- [ ] **Step 2: Add end-to-end create/use/remove test**

Create a temporary repository fixture, create branch `feat/worktree-e2e`, invoke the public service path for worktree creation, then register/open the child root through the existing workspace lifecycle. Assert child typed Git status works without any repair command. Make and revert a bounded child file edit to prove the worktree is genuinely usable. Close child, remove from parent, and delete the branch.

The test must inspect the administrative pointer relationship and assert neither side contains `/workspace/`.

Run:

```bash
pnpm exec vitest run tests/integration/full-stack.test.ts --no-file-parallelism
```

Expected: PASS.

- [ ] **Step 3: Add adversarial end-to-end cases**

At minimum exercise:

```text
invalid worktree name
branch missing
branch already checked out
existing target path
symlinked .worktrees parent
foreign/mismatched child .git pointer
dirty child removal
locked child removal
workspace policy not trusted
```

No case may trigger a force retry or return a canonical path.

- [ ] **Step 4: Run deterministic repository gates**

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

- [ ] **Step 5: Commit acceptance coverage**

```bash
git add crates/runtime/tests tests docs/verification
git commit -m "test: verify bounded worktree lifecycle"
```

---

### Task 6: Review, release evidence, and publish Phase 7

**Files:**
- Create: `docs/release/2026-08-19-bounded-linked-worktree-lifecycle-readiness.md`
- Modify: `docs/implementation/v0.1-execution-tracker.md`
- Modify: `docs/architecture/README.md`
- Modify: `skills/kodegpt-application-development-workflow/SKILL.md` only if the workflow needs explicit guidance to prefer the new typed lifecycle over host-side worktree creation; do not add orchestration semantics

**Interfaces:**
- Readiness must state source target `0.15 / 78` and separately distinguish source readiness from installed-release cutover.
- Workflow guidance, if changed, remains host-owned sequencing and never auto-creates a worktree.

- [ ] **Step 1: Perform exact final diff review**

Use `git.changes` / `git.diff` or CodexPro `show_changes` to verify:

```text
exactly 2 public tools added
no generic workspace alias field in MCP/TS process schemas
no force worktree command
no arbitrary worktree path
no scheduler/agent runtime
no canonical path in public result shapes
```

If review causes source edits, rerun the invalidated focused and aggregate gates before continuing.

- [ ] **Step 2: Write readiness evidence**

Record focused RED/GREEN history, full local gate results, exact feature HEAD, current surface equality, adversarial cases, and the live acceptance command sequence. Explicitly state that host-side `git worktree repair` was not used.

- [ ] **Step 3: Commit docs after verification**

```bash
git add docs skills
git commit -m "docs: record worktree lifecycle readiness"
```

- [ ] **Step 4: Push without force and create PR**

Use typed KodeGPT Git/GitHub authority from the canonical trusted workspace after the isolated worktree branch is published or otherwise made available to the canonical service workspace. Do not use force push.

Create PR title:

```text
feat: add bounded linked-worktree lifecycle
```

- [ ] **Step 5: Require exact-head CI before merge**

Use `ci.status` on the exact PR head. If queued/running, report the run and stop polling. If failed, gather `ci.failure` evidence before changing code. Merge only with `github.pr.merge(expectedHeadOid=<exact feature head>)` after terminal SUCCESS.

- [ ] **Step 6: Reconcile merged main and verify merged-main CI**

Fast-forward canonical local `main` from `origin/main`; verify merged PR state and observe merged-main CI once. Do not busy-poll.

- [ ] **Step 7: Stage/cut over immutable service release only after merged-main verification**

Use the existing service lifecycle. Verify after cutover:

```text
system.health.ok == true
auditHealthy == true
filesystemBoundaryAvailable == true
runtimeVersion == 0.1
protocolVersion == 2026-07-28
surfaceVersion == 0.15
public tool count == 78
```

Retain the prior healthy release as rollback.

- [ ] **Step 8: Live dogfood the new typed lifecycle on a disposable branch**

Execute the exact production sequence:

```text
git.branchCreate(name=<disposable branch>)
git.worktreeCreate(name=<disposable name>, branch=<same branch>)
open/trust child workspace
child git.status
close child workspace
parent git.worktreeRemove(name=<disposable name>)
git.branchDelete(name=<disposable branch>)
```

Inspect audit/public results for canonical-path leakage and verify no `git worktree repair` was invoked.

- [ ] **Step 9: Final cleanup**

Remove the implementation worktree only after the branch is merged, clean, and no unique work remains. Keep the immutable active/rollback service releases according to existing service cleanup policy.

---

## Plan self-review

- **Spec coverage:** Every authority/security/non-goal in the Phase 7 spec maps to Tasks 1–6. Canonical alias is Task 1; typed Rust lifecycle and postconditions Task 2; TS contracts Task 3; exactly two public tools/surface bump Task 4; no-repair dogfood/isolation Task 5; review/CI/release/live acceptance Task 6.
- **Placeholder scan:** Complete. Every mutation step names the intended interface, concrete behavior, and focused verification command.
- **Type consistency:** Public operations are `git.worktreeCreate` / `git.worktreeRemove`; private RPC is `git.worktree_mutation`; Rust operations are `Create` / `Remove`; TypeScript results use operation literals `"create"` / `"remove"`; relative result path is always `.worktrees/<name>`.
- **Scope check:** The plan adds no agent scheduler, background worker, arbitrary path, force semantics, provider work, CI monitoring feature, or generic sandbox mount API.
