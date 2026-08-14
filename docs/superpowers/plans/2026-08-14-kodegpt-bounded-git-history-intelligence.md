# KodeGPT Bounded Read-Only Git History Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four structured, bounded, local-only Git history tools (`git.log`, `git.show`, `git.range`, `git.diffHistory`) without exposing arbitrary Git arguments, shell authority, network Git, or repository mutation.

**Architecture:** Extend the existing Rust hardened Git execution path with typed history operations, strict revision/path grammar, fixed Git command templates, command-specific byte/time budgets, and structured parsers. `WorkspaceManager` validates the private runtime contract; `@kodegpt/capabilities` owns stable public schemas/errors; MCP only exposes opaque `workspaceId` plus typed read-only inputs. Existing `git.status`, `git.diff`, and `git.changes` remain semantically unchanged.

**Tech Stack:** Rust stable, serde/serde_json, existing `kodegpt-sandbox` Bubblewrap path, existing retained-root workspace registry, TypeScript 5.9, Node.js >=24, Zod, Vitest 3.2, MCP server package, pnpm 10.15.0.

## Global Constraints

- Baseline commit before feature work: `3e3e257500d8d35d887ab8a68d55439dbdae0c1a`.
- Keep historical tag `v0.1^{}` exactly `b8eae12cea3be002a9a61d06cecfd34f86283eb4`.
- Keep runtime version exactly `0.1`.
- Keep MCP protocol exactly `2026-07-28`.
- Advance semantic MCP surface exactly once for this phase: `0.3 -> 0.4`.
- Keep KodeGPT state-root invariant and Stable Local Service lifecycle unchanged except normal exact-candidate deployment/cutover at final acceptance.
- Rust remains final OS/security authority.
- Every Git history request requires an existing READY trusted workspace; MCP cannot establish or mutate trust.
- No public raw Git command, Git argv array, shell, provider execution, provider interoperability, `skill.run`, service-lifecycle MCP mutation, or workspace-trust MCP mutation.
- No Git mutation or network operation: no commit/checkout/switch/branch mutation/merge/rebase/reset/stash/tag mutation/clean/restore/apply/am/cherry-pick/revert/fetch/pull/push/ls-remote.
- History is local-only: set `GIT_NO_LAZY_FETCH=1` and retain sandbox network deny.
- Reuse trusted executable resolution, executable identity revalidation, Bubblewrap, retained root FD, helper/filter hardening, audit, execution registry, and raw spool; do not create a second Git security subsystem.
- Public OID inputs accept only full lowercase 40- or 64-hex OIDs. No abbreviated OID input.
- Public branch/tag refs are a strict safe local subset and Rust constructs `refs/heads/...` or `refs/tags/...`.
- No `HEAD~N`, `^`, `@{}`, `:/...`, raw `A..B`, raw `A...B`, `--*`, reflog, remote refs, or arbitrary revision grammar.
- Optional paths are repository-relative, reject C0/DEL controls, absolute/empty/dot/parent components and `:` magic prefix; every path-taking Git command uses fixed `--literal-pathspecs` and `--`.
- `git.log`: default 20 commits, max 100.
- `git.range`: default 50 returned commits, max 100.
- Ahead/behind traversal cap: 10,000 per side, detected with `--max-count=10001`.
- Changed-path max: 500.
- Subject max: 512 UTF-8 bytes; body max: 16 KiB; author-name max: 256 UTF-8 bytes; path max: 4 KiB.
- Patch default max: 64 KiB; caller hard max: 256 KiB.
- Public serialized history response hard budget: 512 KiB.
- Every history Git subprocess wall timeout: 5 seconds; not caller-configurable.
- Rename/copy detection off; no `--binary`; no textconv/external diff; ignore submodules.
- Every behavior change follows RED -> confirm failure -> minimal GREEN -> focused verification -> refactor only if useful.
- Do not reset, rebase, force-push, rewrite `v0.1`, or discard unrelated user changes.

## Execution precondition

At implementation time, first invoke `superpowers:using-git-worktrees` and create an isolated feature worktree/branch from the freshly audited canonical `main`. Recommended branch name:

```text
feat/bounded-git-history-intelligence
```

Re-run the handoff baseline audit before Task 1. If `main` has changed, audit ancestry/commits and reconcile without reset/rebase. Do not implement directly in canonical `main`.

## File structure locked by this plan

- `crates/runtime/src/git.rs` — keep current status/diff/checkpoint behavior; expose/refactor only the shared hardened Git spawn/capture primitives needed by history.
- `crates/runtime/src/git_history.rs` — new typed revision/path validation, repository preflight, revision resolution, commit parser, fixed history command builders/parsers, and four structured history operations.
- `crates/runtime/src/main.rs` — module declaration only.
- `crates/runtime/src/dispatcher.rs` — typed runtime dispatch for four history methods; audit-before-root-duplication semantics.
- `crates/runtime/src/audit.rs` — four specific history audit actions.
- `crates/protocol/src/types.rs` — typed `deny_unknown_fields` history request structs/enums; no argv/raw revision strings.
- `schemas/runtime/request.schema.json` — JSON-schema parity for the four internal runtime methods.
- `packages/core/src/workspace-manager.ts` — READY workspace mapping, runtime request calls, result validation, stable runtime error mapping.
- `packages/core/src/workspace-manager.test.ts` — private capability translation/result validation regressions.
- `packages/capabilities/src/contracts.ts` — public history types/constants and `NATIVE_CAPABILITY_IDS` additions.
- `packages/capabilities/src/schemas.ts` — strict Zod schemas for all four public tools/results.
- `packages/capabilities/src/adapters.ts` — `GitHistoryAdapter` interface.
- `packages/capabilities/src/git-history.ts` — public capability validation/error normalization/response-budget invariants; no Git argv construction.
- `packages/capabilities/src/git-history.test.ts` — public capability TDD fixtures.
- `packages/capabilities/src/errors.ts` — stable Git history capability errors.
- `packages/capabilities/src/native-capability-service.ts` — four history methods and dependency wiring.
- `packages/capabilities/src/index.ts` — exports.
- `apps/cli/src/commands/start.ts` — production adapter wiring only.
- `apps/cli/src/commands/start.test.ts` — wiring/capability-version regressions.
- `packages/mcp-server/src/tool-context.ts` — four `GitToolContext` methods.
- `packages/mcp-server/src/tools.ts` — four read-only tool registrations and locked surface inventory.
- `packages/mcp-server/src/surface-version.ts` — semantic surface `0.4`.
- `packages/mcp-server/src/server.test.ts`, `structured-results.test.ts` — schema/inventory/result regressions.
- `tests/fixtures/mcp-surface.ts` — expected additive MCP inventory.
- `tests/security/git-helper-isolation.test.ts` — preserve existing current-state Git invariants.
- `tests/security/git-history-isolation.test.ts` — new history-specific security regressions.
- `tests/protocol/*` / runtime fixtures — additive internal RPC contract parity.
- `tests/integration/mcp-http.test.ts`, `tests/integration/full-stack.test.ts` — end-to-end structured history behavior.
- `docs/implementation/v0.1-execution-tracker.md` and a new release/readiness note — final evidence only after implementation/host acceptance.

---

### Task 1: Lock typed revision/path grammar and protocol request shapes

**Files:**
- Create: `crates/runtime/src/git_history.rs`
- Modify: `crates/runtime/src/main.rs`
- Modify: `crates/protocol/src/types.rs`
- Modify: `schemas/runtime/request.schema.json`
- Test: `crates/runtime/src/git_history.rs` (`#[cfg(test)]`)
- Test: `crates/protocol/tests/protocol_contract.rs`
- Test: `tests/protocol/framing-parity.test.ts`

**Interfaces:**

`crates/protocol/src/types.rs` produces exactly:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum GitRevisionSpec {
    Head,
    Oid { oid: String },
    Branch { name: String },
    Tag { name: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitLogParams {
    pub capability_id: String,
    pub revision: GitRevisionSpec,
    pub path: Option<String>,
    pub limit: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitShowParams {
    pub capability_id: String,
    pub revision: GitRevisionSpec,
    pub path: Option<String>,
    pub include_patch: bool,
    pub max_patch_bytes: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitRangeMode { Direct, Symmetric }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitRangeParams {
    pub capability_id: String,
    pub base_revision: GitRevisionSpec,
    pub head_revision: GitRevisionSpec,
    pub mode: GitRangeMode,
    pub limit: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitDiffHistoryParams {
    pub capability_id: String,
    pub base_revision: GitRevisionSpec,
    pub head_revision: GitRevisionSpec,
    pub path: Option<String>,
    pub max_patch_bytes: u32,
}
```

`crates/runtime/src/git_history.rs` produces internal validated types:

```rust
pub(crate) enum ValidatedRevision {
    Head,
    Oid(String),
    LocalBranch(String),
    LocalTag(String),
}

pub(crate) struct ValidatedHistoryPath(String);

pub(crate) fn validate_revision(spec: GitRevisionSpec) -> Result<ValidatedRevision, GitHistoryError>;
pub(crate) fn validate_history_path(path: Option<String>) -> Result<Option<ValidatedHistoryPath>, GitHistoryError>;
```

- [ ] **Step 1: Write failing Rust grammar tests**

Add table-driven tests asserting acceptance of:

```rust
GitRevisionSpec::Head
GitRevisionSpec::Oid { oid: "0123456789abcdef0123456789abcdef01234567".into() }
GitRevisionSpec::Oid { oid: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into() }
GitRevisionSpec::Branch { name: "feat/history-v1".into() }
GitRevisionSpec::Tag { name: "v0.1".into() }
```

and rejection with `GitHistoryError::RevisionInvalid` for each of:

```text
--all
--glob=refs/*
HEAD~3
HEAD^
HEAD@{1}
:/fix
0123456
ABCDEF0123456789ABCDEF0123456789ABCDEF01
refs/heads/main
feat//x
feat/../x
feat/.hidden
feat/x.lock
feat/x.
foo@{bar
```

For paths, accept `src/main.rs`, `docs/a b.md`, and Unicode UTF-8 path components; reject `/etc/passwd`, `.`, `..`, `src/../secret`, `src//file`, `:!secret`, a newline-containing path, NUL, and >4096 UTF-8 bytes.

- [ ] **Step 2: Run RED grammar test**

Run:

```bash
cargo test -p kodegpt-runtime git_history::tests::revision_and_path_grammar_is_closed -- --exact
```

Expected: FAIL because `git_history` module/types do not exist.

- [ ] **Step 3: Implement minimal pure validation**

Implement branch/tag component validation without invoking Git. Use byte/character checks only; do not call `git check-ref-format` because public grammar must be KodeGPT-owned.

Core shape:

```rust
fn valid_ref_component(component: &str) -> bool {
    let bytes = component.as_bytes();
    !bytes.is_empty()
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && !component.ends_with(".lock")
        && !component.ends_with('.')
}
```

Validate total ref bytes <=128 and reject `..` / `@{` before splitting on `/`.

- [ ] **Step 4: Run GREEN grammar test**

Run the exact command from Step 2; expected PASS.

- [ ] **Step 5: Add failing protocol unknown-field and no-argv tests**

In Rust protocol tests, deserialize each new request and assert extra fields fail. In TypeScript parity/source tests, assert serialized schemas contain structured revision fields and do **not** contain `argv`, `revisionExpression`, or `gitArgs`.

Add runtime request variants:

```rust
#[serde(rename = "git.log")]
GitLog { jsonrpc: JsonRpcVersion, id: String, params: GitLogParams },
#[serde(rename = "git.show")]
GitShow { jsonrpc: JsonRpcVersion, id: String, params: GitShowParams },
#[serde(rename = "git.range")]
GitRange { jsonrpc: JsonRpcVersion, id: String, params: GitRangeParams },
#[serde(rename = "git.diff_history")]
GitDiffHistory { jsonrpc: JsonRpcVersion, id: String, params: GitDiffHistoryParams },
```

Keep internal runtime method `git.diff_history` snake-style after the dot; public MCP tool remains `git.diffHistory`.

- [ ] **Step 6: Update JSON schema minimally and run protocol GREEN**

Run:

```bash
cargo test -p kodegpt-protocol
pnpm test:protocol
```

Expected: PASS with all existing protocol behavior intact.

- [ ] **Step 7: Commit**

```bash
git add crates/runtime/src/git_history.rs crates/runtime/src/main.rs crates/protocol/src/types.rs schemas/runtime/request.schema.json crates/protocol/tests tests/protocol
git commit -m "feat(runtime): define bounded git history inputs"
```

---

### Task 2: Add shared bounded Git command deadline/source-limit support without changing current Git semantics

**Files:**
- Modify: `crates/runtime/src/git.rs` around `run_git_command_with_stdout_limit`, capture helpers, and hardened spec construction
- Test: `crates/runtime/src/git.rs` unit tests
- Test: `tests/security/git-helper-isolation.test.ts`

**Interfaces:**

Add internal command budget primitives that are reusable by `git_history.rs`:

```rust
#[derive(Debug, Clone, Copy)]
pub(crate) struct GitCommandBudget {
    pub wall_timeout: Option<Duration>,
    pub stdout_source_bytes: usize,
    pub stderr_source_bytes: usize,
    pub preview_bytes: usize,
    pub overflow_policy: GitOverflowPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GitOverflowPolicy {
    LegacySpool,
    Fail,
    Truncate,
}

pub(crate) struct GitCommandOutput {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr_preview: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub source_truncated: bool,
}

pub(crate) fn run_hardened_git_command(
    provider: &BubblewrapProvider,
    program: &TrustedExecutable,
    workspace_root: &OwnedFd,
    workspace_capability: &str,
    request_id: &str,
    operation_id: &str,
    args: Vec<OsString>,
    budget: GitCommandBudget,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
    history_no_lazy_fetch: bool,
) -> Result<GitCommandOutput, GitInspectionError>;
```

Extend `GitInspectionError` with internal `Timeout` and `OutputLimitExceeded` variants. Do not expose them publicly in this task.

- [ ] **Step 1: Write failing timeout/process-group cleanup test**

Under `#[cfg(test)]`, launch a trusted `python3` child through the same Bubblewrap/capture helper with argv equivalent to:

```text
python3 -c "import os,time; print(os.getpid()); time.sleep(30)"
```

Use an internal 50 ms budget. Assert:

- result is `GitInspectionError::Timeout`;
- execution registry contains zero entries afterward;
- process group no longer exists (`kill(-pgid, 0)` yields ESRCH after bounded reap);
- the test uses direct argv, not a shell.

- [ ] **Step 2: Run RED timeout test**

Run the single new Rust test; expected FAIL because current capture waits indefinitely.

- [ ] **Step 3: Implement process-group termination and bounded receive loop**

Use the Bubblewrap-reported process group. On deadline or hard source overflow:

```rust
unsafe { libc::kill(-process_group, libc::SIGKILL) };
unsafe { libc::kill(process_group, libc::SIGKILL) };
```

then reap the child and remove the execution record in all exit paths. Use `recv_timeout`/deadline arithmetic rather than a detached watchdog thread that could outlive the request.

- [ ] **Step 4: Preserve existing current-state config exactly**

Call the shared runner for existing status/diff/checkpoint with a `LegacySpool` budget that preserves their current preview/spool semantics and no new public timeout. The purpose is shared machinery, not a behavior change to current tools.

History callers will pass `Some(Duration::from_secs(5))` and strict source limits later.

- [ ] **Step 5: Add history-only lazy-fetch env test**

Add an internal spec test proving `history_no_lazy_fetch=true` inserts exactly:

```text
GIT_NO_LAZY_FETCH=1
```

while current status/diff spec construction remains otherwise byte-for-byte equivalent to its prior environment/config list.

- [ ] **Step 6: Run focused GREEN + existing helper isolation**

```bash
cargo test -p kodegpt-runtime git::tests
pnpm exec vitest run tests/security/git-helper-isolation.test.ts
```

Expected: PASS. The source regression must still report no production `Command::new` in `git.rs`.

- [ ] **Step 7: Commit**

```bash
git add crates/runtime/src/git.rs tests/security/git-helper-isolation.test.ts
git commit -m "refactor(runtime): bound hardened git command execution"
```

---

### Task 3: Implement repository preflight, canonical revision resolution, commit parser, and `git.log` runtime primitive

**Files:**
- Modify: `crates/runtime/src/git_history.rs`
- Modify: `crates/runtime/src/dispatcher.rs`
- Modify: `crates/runtime/src/audit.rs`
- Test: `crates/runtime/src/git_history.rs`
- Test: `crates/runtime/src/dispatcher.rs`

**Interfaces:**

Add:

```rust
pub(crate) const GIT_HISTORY_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const GIT_LOG_DEFAULT_LIMIT: u16 = 20;
pub(crate) const GIT_LOG_MAX_LIMIT: u16 = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommitSummary {
    pub oid: String,
    pub short_oid: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_time: i64,
    pub committer_time: i64,
    pub subject: String,
    pub encoding_lossy: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitLogResult {
    pub schema_version: u32,
    pub resolved_oid: String,
    pub commits: Vec<GitCommitSummary>,
    pub returned_count: usize,
    pub truncated: bool,
    pub truncation_reasons: Vec<GitHistoryTruncationReason>,
}

pub(crate) fn run_git_log(
    root_fd: &OwnedFd,
    capability_id: &str,
    request_id: &str,
    operation_id: &str,
    revision: ValidatedRevision,
    path: Option<ValidatedHistoryPath>,
    limit: u16,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
) -> Result<GitLogResult, GitHistoryError>;
```

`GitHistoryError` must distinguish `NotAGitRepository`, `RevisionInvalid`, `RevisionNotFound`, `ObjectTypeUnsupported`, `PathInvalid`, `OutputLimitExceeded`, `Timeout`, `GitUnavailable`, and `GitReadFailed` internally.

- [ ] **Step 1: Write RED repository preflight/resolver tests**

Fixtures:

1. plain temp directory -> `NotAGitRepository`;
2. normal repo HEAD -> full 40/64 lowercase OID;
3. local branch/tag -> same canonical commit OID;
4. missing full OID -> `RevisionNotFound`;
5. blob OID from `git hash-object` -> `ObjectTypeUnsupported`;
6. ref named with unsafe syntax is rejected before Git spawn by Task 1 validation.

Assert the resolver uses fixed `rev-parse --verify --end-of-options` and runs `<candidate>^{object}` before `<candidate>^{commit}`.

- [ ] **Step 2: Run RED resolver tests**

```bash
cargo test -p kodegpt-runtime git_history::tests::preflight_and_revision_resolution_are_local_and_typed -- --exact
```

Expected: FAIL because resolver is not implemented.

- [ ] **Step 3: Implement repository preflight and resolver**

Use the Task 2 runner with `history_no_lazy_fetch=true`, 5 s timeout, 8 KiB stdout cap, 16 KiB stderr cap, overflow policy `Fail`.

Preflight argv is fixed:

```rust
vec!["rev-parse", "--git-dir"]
```

Resolver argv is fixed and candidate is generated from `ValidatedRevision`:

```rust
vec!["rev-parse", "--verify", "--end-of-options", format!("{candidate}^{{object}}")]
vec!["rev-parse", "--verify", "--end-of-options", format!("{candidate}^{{commit}}")]
```

Never return preflight path output publicly.

- [ ] **Step 4: Write RED commit-object parser tests**

Feed raw commit-object bytes directly to a pure parser. Cover:

- zero/one/multiple parents;
- author and committer timestamps;
- subject first line;
- 512-byte subject truncation;
- body excluded from `GitCommitSummary`;
- invalid/missing author/committer header -> `GitReadFailed`;
- oversized header before a complete author/committer record -> `OutputLimitExceeded`;
- invalid UTF-8 in author/message -> deterministic lossy string plus `encodingLossy=true`;
- parent/OID must be exactly 40 or 64 lowercase hex.

- [ ] **Step 5: Implement parser and bounded commit read**

Read each resolved commit with fixed:

```text
git <fixed-config> cat-file commit <full-oid>
```

Use a 64 KiB command cap. Parse headers from bytes before converting text fields. Derive `shortOid` as the first 12 characters of the validated full OID; do not invoke Git abbreviation.

- [ ] **Step 6: Write RED bounded log walk test**

Create a repo with 6 deterministic commits. Call internal log with `limit=5`. Expected:

```rust
assert_eq!(result.commits.len(), 5);
assert_eq!(result.returned_count, 5);
assert!(result.truncated);
assert_eq!(result.truncation_reasons, vec![GitHistoryTruncationReason::CommitLimit]);
```

Run log with `limit=6`; expected not truncated. Add a path-filter fixture where only 2 commits touched `src/a.rs`.

- [ ] **Step 7: Implement fixed commit walk**

Use:

```text
git <fixed-config> --literal-pathspecs rev-list --topo-order --max-count=<limit+1> <resolved-full-oid> [-- <validated-path>]
```

Parse exactly one full OID per line. Never execute a second unbounded count. Drop the `limit+1` sentinel from returned commits and set `COMMIT_LIMIT`.

- [ ] **Step 8: Add runtime dispatch/audit RED test**

Add `AuditAction::GitHistoryList -> "git_history_list"` and dispatcher branch for `git.log`. The test must inject audit decision failure and prove no Git operation/root duplication occurs, then success path proves one top-level decision/outcome pair.

- [ ] **Step 9: Implement dispatch and stable runtime error contract**

Map history errors to runtime messages:

```text
NOT_A_GIT_REPOSITORY
REVISION_INVALID
REVISION_NOT_FOUND
OBJECT_TYPE_UNSUPPORTED
PATH_INVALID
OUTPUT_LIMIT_EXCEEDED
PROCESS_TIMEOUT
GIT_UNAVAILABLE
GIT_READ_FAILED
```

No raw stderr is included in `data`.

- [ ] **Step 10: Run focused GREEN**

```bash
cargo test -p kodegpt-runtime git_history
cargo test -p kodegpt-runtime dispatcher
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add crates/runtime/src/git_history.rs crates/runtime/src/dispatcher.rs crates/runtime/src/audit.rs
git commit -m "feat(runtime): add bounded git log primitive"
```

---

### Task 4: Implement bounded `git.show` runtime primitive

**Files:**
- Modify: `crates/runtime/src/git_history.rs`
- Modify: `crates/runtime/src/dispatcher.rs`
- Modify: `crates/runtime/src/audit.rs`
- Test: `crates/runtime/src/git_history.rs`
- Test: `crates/runtime/src/dispatcher.rs`

**Interfaces:**

Add:

```rust
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum GitChangedPathStatus { Added, Modified, Deleted, TypeChanged }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitHistoricalChangedPath {
    pub path: String,
    pub status: GitChangedPathStatus,
    pub insertions: Option<u64>,
    pub deletions: Option<u64>,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommitInspectResult {
    pub schema_version: u32,
    pub commit: GitCommitDetail,
    pub changed_paths: Vec<GitHistoricalChangedPath>,
    pub summary: GitHistoricalStatSummary,
    pub patch: Option<String>,
    pub truncated: bool,
    pub truncation_reasons: Vec<GitHistoryTruncationReason>,
}
```

`GitCommitDetail` extends summary metadata with body and `message_truncated`.

- [ ] **Step 1: Write RED changed-path/stat parser tests**

Create commit fixtures for add/modify/delete/type-change and a binary file. Parse `--name-status -z` and `--numstat -z` output. Assert:

- returned paths are repository-relative;
- rename detection is absent (rename fixture appears delete + add);
- binary numstat `-\t-` becomes `binary=true`, `insertions/deletions` absent;
- >500 paths returns first deterministic 500 complete path records with `PATH_LIMIT`;
- malformed/absolute/parent path from parser fixture fails `GitReadFailed` rather than escaping.

- [ ] **Step 2: Run RED parser test**

Run the exact new test; expected FAIL.

- [ ] **Step 3: Implement fixed changed-path/stat commands**

Use exactly:

```text
git <fixed-config> --literal-pathspecs diff-tree --root --no-commit-id -r --name-status -z --no-renames <oid> [-- <path>]
git <fixed-config> --literal-pathspecs diff-tree --root --no-commit-id -r --numstat -z --no-renames <oid> [-- <path>]
```

Both use 512 KiB stdout cap, 5 s timeout, `GIT_NO_LAZY_FETCH=1`.

- [ ] **Step 4: Write RED message and patch-bound tests**

Create a commit with >20 KiB body and a diff >300 KiB. For `includePatch=true,maxPatchBytes=65536`, assert body is exactly bounded to 16 KiB UTF-8 budget and patch <=64 KiB, with reasons `MESSAGE_LIMIT` and `PATCH_LIMIT`. For `includePatch=false`, no patch command result appears publicly.

- [ ] **Step 5: Implement commit detail + bounded patch**

Patch command must be fixed:

```text
git <fixed-config> --literal-pathspecs show --format= --no-ext-diff --no-textconv --no-renames --ignore-submodules=all <oid> [-- <path>]
```

Never pass `--binary`. Capture at `maxPatchBytes + 16 KiB` maximum, stop/kill after detecting overflow, and expose only a complete UTF-8 prefix <= requested max. If the cut occurs inside a UTF-8 sequence, back up to the last valid boundary.

- [ ] **Step 6: Add dispatcher/audit RED then GREEN**

Add `AuditAction::GitCommitInspect -> "git_commit_inspect"`, `git.show` dispatch, validation `1..=262144` for `maxPatchBytes`, and exact runtime error mapping from Task 3.

- [ ] **Step 7: Run focused GREEN**

```bash
cargo test -p kodegpt-runtime git_history::tests::show
cargo test -p kodegpt-runtime dispatcher
```

- [ ] **Step 8: Commit**

```bash
git add crates/runtime/src/git_history.rs crates/runtime/src/dispatcher.rs crates/runtime/src/audit.rs
git commit -m "feat(runtime): inspect bounded historical commits"
```

---

### Task 5: Implement bounded ancestry/range runtime primitive

**Files:**
- Modify: `crates/runtime/src/git_history.rs`
- Modify: `crates/runtime/src/dispatcher.rs`
- Modify: `crates/runtime/src/audit.rs`
- Test: `crates/runtime/src/git_history.rs`

**Interfaces:**

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitBoundedCount {
    pub value: u64,
    pub exact: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum GitRangeSide { Base, Head }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitRangeCommit {
    #[serde(flatten)]
    pub commit: GitCommitSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side: Option<GitRangeSide>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitRangeResult {
    pub schema_version: u32,
    pub base_oid: String,
    pub head_oid: String,
    pub is_ancestor: bool,
    pub merge_base_oid: Option<String>,
    pub ahead: GitBoundedCount,
    pub behind: GitBoundedCount,
    pub commits: Vec<GitRangeCommit>,
    pub returned_count: usize,
    pub truncated: bool,
    pub truncation_reasons: Vec<GitHistoryTruncationReason>,
}
```

- [ ] **Step 1: Write RED ancestry graph test**

Create graph:

```text
A---B---C  (base-side)
     \
      D---E (head-side)
```

Assert B is ancestor of E, E is not ancestor of B, merge base(C,E) follows the actual constructed graph, and unrelated orphan branches yield `mergeBaseOid: None` without classifying the repository as invalid.

- [ ] **Step 2: Implement fixed ancestry/merge-base commands**

Use full resolved OIDs only:

```text
git <fixed-config> merge-base --is-ancestor <base> <head>
git <fixed-config> merge-base <base> <head>
```

Exit 0/1 for `--is-ancestor` maps to true/false; any other exit is `GitReadFailed`. A normal no-common-ancestor merge-base exit maps to `None`.

- [ ] **Step 3: Write RED capped count test**

Create or synthesize a repo with >10,000 linear commits using low-level test fixture helpers. Assert:

```rust
GitBoundedCount { value: 10_000, exact: false }
```

and a 3-commit difference returns `{value:3, exact:true}`.

If creating 10,001 physical commits makes the focused test too slow, unit-test the pure parser with Git stdout `10001\n` and separately integration-test the fixed argv contains `--max-count=10001`; do not weaken the cap assertion.

- [ ] **Step 4: Implement independent ahead/behind capped walks**

Construct range strings only from validated full OIDs:

```rust
let ahead_range = format!("{base_oid}..{head_oid}");
let behind_range = format!("{head_oid}..{base_oid}");
```

Run fixed:

```text
git <fixed-config> rev-list --count --max-count=10001 <resolved-range>
```

No caller string participates in range construction.

- [ ] **Step 5: Write RED direct/symmetric list tests**

For direct mode, fixed walk:

```text
rev-list --topo-order --max-count=<limit+1> <base>..<head>
```

For symmetric mode:

```text
rev-list --left-right --topo-order --max-count=<limit+1> <base>...<head>
```

Assert symmetric parser accepts only leading `<`/`>` plus a full OID, maps to `side:"base"|"head"`, returns max `limit`, and sets `COMMIT_LIMIT` from sentinel.

- [ ] **Step 6: Implement range list and commit summaries**

Reuse the Task 3 commit parser; do not duplicate commit metadata parsing.

- [ ] **Step 7: Add audit/dispatch and run GREEN**

Add `AuditAction::GitHistoryRange -> "git_history_range"` and `git.range` dispatcher. Enforce `1..=100` limit in Rust even if TypeScript later validates it too.

Run:

```bash
cargo test -p kodegpt-runtime git_history::tests::range
cargo test -p kodegpt-runtime dispatcher
```

- [ ] **Step 8: Commit**

```bash
git add crates/runtime/src/git_history.rs crates/runtime/src/dispatcher.rs crates/runtime/src/audit.rs
git commit -m "feat(runtime): add bounded git ancestry ranges"
```

---

### Task 6: Implement bounded historical diff runtime primitive

**Files:**
- Modify: `crates/runtime/src/git_history.rs`
- Modify: `crates/runtime/src/dispatcher.rs`
- Modify: `crates/runtime/src/audit.rs`
- Test: `crates/runtime/src/git_history.rs`

**Interfaces:**

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitHistoryDiffResult {
    pub schema_version: u32,
    pub base_oid: String,
    pub head_oid: String,
    pub changed_paths: Vec<GitHistoricalChangedPath>,
    pub summary: GitHistoricalStatSummary,
    pub patch: String,
    pub truncated: bool,
    pub truncation_reasons: Vec<GitHistoryTruncationReason>,
}
```

- [ ] **Step 1: Write RED deterministic two-revision diff test**

Build known base/head commits with text add/modify/delete and binary change. Assert:

- returned OIDs equal canonical full IDs;
- changed paths/stats match fixtures;
- text patch contains expected text change;
- binary file has metadata/stat but no binary payload;
- `git status --porcelain=v1` before and after is byte-identical.

- [ ] **Step 2: Write RED option/path injection test at command-builder boundary**

Call public validation/building helpers with `--stat`, `--output=/tmp/x`, `:(attr:foo)`, `/etc/passwd`, `../x`. Assert validation fails before command spawn. For a legitimate path beginning with a hyphen in a nested component, prove fixed `--` keeps it data if the chosen grammar permits it.

- [ ] **Step 3: Implement historical diff fixed command**

Use only:

```text
git <fixed-config> --literal-pathspecs diff --no-ext-diff --no-textconv --no-renames --ignore-submodules=all <base-full-oid> <head-full-oid> [-- <path>]
```

No working-tree/index argument is permitted. No `--binary`.

- [ ] **Step 4: Add patch cap/truncation test and GREEN**

Test `maxPatchBytes=65536` and hard reject `0` / `262145`. On overflow return complete UTF-8 prefix plus `PATCH_LIMIT`, never raw spool host path.

- [ ] **Step 5: Add audit/dispatch**

Add `AuditAction::GitHistoryDiff -> "git_history_diff"` and runtime method `git.diff_history`.

- [ ] **Step 6: Run focused GREEN**

```bash
cargo test -p kodegpt-runtime git_history::tests::history_diff
cargo test -p kodegpt-runtime dispatcher
```

- [ ] **Step 7: Commit**

```bash
git add crates/runtime/src/git_history.rs crates/runtime/src/dispatcher.rs crates/runtime/src/audit.rs
git commit -m "feat(runtime): add bounded historical git diff"
```

---

### Task 7: Add WorkspaceManager history adapter with strict runtime validation and stable error translation

**Files:**
- Modify: `packages/core/src/workspace-manager.ts`
- Modify: `packages/core/src/workspace-manager.test.ts`

**Interfaces:**

Add core input aliases matching the runtime structured form but using public workspace ID:

```ts
export type WorkspaceGitRevision =
  | { kind: "head" }
  | { kind: "oid"; oid: string }
  | { kind: "branch"; name: string }
  | { kind: "tag"; name: string };

export interface WorkspaceGitLogInput {
  workspaceId: string;
  revision: WorkspaceGitRevision;
  path?: string;
  limit: number;
}
```

Add analogous `WorkspaceGitShowInput`, `WorkspaceGitRangeInput`, and `WorkspaceGitDiffHistoryInput`, plus validated result types.

Methods:

```ts
gitLog(input: WorkspaceGitLogInput): Promise<WorkspaceGitLogResult>;
gitShow(input: WorkspaceGitShowInput): Promise<WorkspaceGitShowResult>;
gitRange(input: WorkspaceGitRangeInput): Promise<WorkspaceGitRangeResult>;
gitDiffHistory(input: WorkspaceGitDiffHistoryInput): Promise<WorkspaceGitHistoryDiffResult>;
```

- [ ] **Step 1: Write RED READY/capability translation tests**

For each method:

- unknown workspace -> existing workspace-not-found error;
- non-READY workspace -> existing workspace-not-ready error;
- READY workspace sends private `capabilityId`, not public `workspaceId`, to the kernel;
- input revision/path values are copied as structured fields; no `argv` field exists.

Expected kernel methods:

```text
git.log
git.show
git.range
git.diff_history
```

- [ ] **Step 2: Run RED core test**

```bash
pnpm --filter @kodegpt/core test -- src/workspace-manager.test.ts
```

Expected: FAIL because methods do not exist.

- [ ] **Step 3: Implement methods and centralized result validators**

Add pure validators for:

- 40/64 lowercase OIDs;
- `shortOid` exactly first 12 chars of `oid`;
- parent OID arrays;
- integer timestamps;
- path/status/stat structures;
- patch/body/string byte-contract consistency where representable;
- `truncated === (truncationReasons.length > 0)`;
- max returned commit/path counts;
- absence of `capabilityId`, `artifactId`, `pid`, `processGroup`, host path implementation fields.

Do not accept “mostly valid” runtime output.

- [ ] **Step 4: Write RED malformed-runtime tests**

Inject payloads with:

- uppercase/short OID;
- `shortOid` mismatch;
- absolute changed path;
- >100 commits;
- `truncated:false` with a reason;
- private `capabilityId` field;
- unexpected object key.

All must become `RUNTIME_PROTOCOL_INVALID`.

- [ ] **Step 5: Map runtime error messages without stderr**

When `KernelRpcError.message` is one of the history stable messages, convert to `WorkspaceManagerError` with the same code. Do not include `KernelRpcError.data` unless it is a fully validated safe structured field; MVP needs no error data.

- [ ] **Step 6: Run GREEN and commit**

```bash
pnpm --filter @kodegpt/core test -- src/workspace-manager.test.ts
pnpm --filter @kodegpt/core typecheck
```

Commit:

```bash
git add packages/core/src/workspace-manager.ts packages/core/src/workspace-manager.test.ts
git commit -m "feat(core): validate structured git history results"
```

---

### Task 8: Add public capability contracts, Zod schemas, stable errors, response budget, and native service methods

**Files:**
- Modify: `packages/capabilities/src/contracts.ts`
- Modify: `packages/capabilities/src/schemas.ts`
- Modify: `packages/capabilities/src/adapters.ts`
- Create: `packages/capabilities/src/git-history.ts`
- Create: `packages/capabilities/src/git-history.test.ts`
- Modify: `packages/capabilities/src/errors.ts`
- Modify: `packages/capabilities/src/native-capability-service.ts`
- Modify: `packages/capabilities/src/index.ts`
- Test: `packages/capabilities/src/contracts.test.ts`

**Interfaces:**

Add constants:

```ts
export const DEFAULT_GIT_LOG_LIMIT = 20;
export const MAX_GIT_LOG_LIMIT = 100;
export const DEFAULT_GIT_RANGE_LIMIT = 50;
export const MAX_GIT_RANGE_LIMIT = 100;
export const DEFAULT_GIT_PATCH_BYTES = 64 * 1024;
export const MAX_GIT_PATCH_BYTES = 256 * 1024;
export const MAX_GIT_HISTORY_RESPONSE_BYTES = 512 * 1024;
export const MAX_GIT_HISTORY_PATHS = 500;
```

Public revision type:

```ts
export type GitRevision =
  | { kind: "head" }
  | { kind: "oid"; oid: string }
  | { kind: "branch"; name: string }
  | { kind: "tag"; name: string };
```

`GitHistoryAdapter`:

```ts
export interface GitHistoryAdapter {
  log(input: GitLogInput): Promise<GitLogResult>;
  show(input: GitShowInput): Promise<GitShowResult>;
  range(input: GitRangeInput): Promise<GitRangeResult>;
  diffHistory(input: GitDiffHistoryInput): Promise<GitDiffHistoryResult>;
}
```

The adapter implemented in CLI wiring is a thin mapping to `WorkspaceManager`; capability code must not construct Git commands.

Extend `CapabilityErrorCode` with exactly:

```text
WORKSPACE_NOT_READY
GIT_UNAVAILABLE
NOT_A_GIT_REPOSITORY
REVISION_INVALID
REVISION_NOT_FOUND
OBJECT_TYPE_UNSUPPORTED
PATH_INVALID
OUTPUT_LIMIT_EXCEEDED
PROCESS_TIMEOUT
GIT_READ_FAILED
```

`REVISION_AMBIGUOUS` is not emitted or added unless implementation actually introduces abbreviated OIDs, which this plan forbids.

- [ ] **Step 1: Write RED schema tests for closed revision grammar/public bounds**

Examples:

```ts
expect(GitLogInputSchema.parse({ workspaceId: "ws_x" })).toMatchObject({ workspaceId: "ws_x" });
expect(() => GitLogInputSchema.parse({ workspaceId: "ws_x", limit: 101 })).toThrow();
expect(() => GitRevisionSchema.parse({ kind: "oid", oid: "abc123" })).toThrow();
expect(() => GitRevisionSchema.parse({ kind: "head", raw: "--all" })).toThrow();
expect(() => GitShowInputSchema.parse({ workspaceId: "ws_x", maxPatchBytes: 262145 })).toThrow();
```

Schema defaults belong in capability logic, not MCP transport mutation: absent revision -> `{kind:"head"}`, absent limits -> constants above.

- [ ] **Step 2: Run RED capability tests**

```bash
pnpm --filter @kodegpt/capabilities test -- src/contracts.test.ts src/git-history.test.ts
```

- [ ] **Step 3: Implement contracts/Zod schemas and export them**

All `z.object(...)` schemas must call `.strict()`. `GitRevisionSchema` uses a discriminated union. Reuse the same safe-ref/path validation semantics through TypeScript refinements for early UX, but treat Rust as final authority.

- [ ] **Step 4: Write RED stable error-mapping tests**

A fake adapter rejects with error objects carrying each core history code. The capability method must throw `CapabilityError` with the same stable code and a generic safe message. Unknown/raw errors become `CAPABILITY_INTERNAL` through the existing public mapper.

- [ ] **Step 5: Implement `git-history.ts` normalization and public byte budget**

Functions:

```ts
export async function gitLog(adapter: GitHistoryAdapter, input: GitLogInput): Promise<GitLogResult>;
export async function gitShow(adapter: GitHistoryAdapter, input: GitShowInput): Promise<GitShowResult>;
export async function gitRange(adapter: GitHistoryAdapter, input: GitRangeInput): Promise<GitRangeResult>;
export async function gitDiffHistory(adapter: GitHistoryAdapter, input: GitDiffHistoryInput): Promise<GitDiffHistoryResult>;
```

Budget helper must measure UTF-8 bytes with `Buffer.byteLength(JSON.stringify(candidate), "utf8")`. If the runtime result is already <=512 KiB, return unchanged. If optional body/patch can be reduced safely, trim in deterministic order and append `RESPONSE_LIMIT`. If fixed metadata alone exceeds the budget, throw `OUTPUT_LIMIT_EXCEEDED` rather than silently return an oversized payload.

The trimming order is:

1. preserve schema/workspace/resolved OIDs/fixed booleans/counters;
2. preserve already-bounded commit/path records until their existing list cap;
3. trim commit body;
4. trim patch;
5. if still oversized, throw `OUTPUT_LIMIT_EXCEEDED`.

- [ ] **Step 6: Add native service methods and tests**

Extend `NativeCapabilityName` and dependency type with the four history methods. Each `NativeCapabilityService` method delegates to the corresponding pure function with `this.#dependencies.gitHistory`.

- [ ] **Step 7: Update native capability inventory**

Append public IDs:

```text
git.log
git.show
git.range
git.diffHistory
```

Do not remove or rename existing IDs.

- [ ] **Step 8: Run GREEN + typecheck and commit**

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/capabilities typecheck
```

Commit:

```bash
git add packages/capabilities/src
git commit -m "feat(capabilities): add structured git history contracts"
```

---

### Task 9: Wire production adapters and expose four MCP tools with semantic surface 0.4

**Files:**
- Modify: `apps/cli/src/commands/start.ts`
- Modify: `apps/cli/src/commands/start.test.ts`
- Modify: `packages/mcp-server/src/tool-context.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/surface-version.ts`
- Modify: `packages/mcp-server/src/server.test.ts`
- Modify: `packages/mcp-server/src/structured-results.test.ts`
- Modify: `tests/fixtures/mcp-surface.ts`

**Interfaces:**

`GitToolContext` gains:

```ts
log(input: GitLogInput): Promise<GitLogResult>;
show(input: GitShowInput): Promise<GitShowResult>;
range(input: GitRangeInput): Promise<GitRangeResult>;
diffHistory(input: GitDiffHistoryInput): Promise<GitDiffHistoryResult>;
```

MCP required fields:

```text
git.log         -> workspaceId
git.show        -> workspaceId
git.range       -> workspaceId, baseRevision, headRevision
git.diffHistory -> workspaceId, baseRevision, headRevision
```

All use `READ_ONLY_TOOL_ANNOTATIONS`.

- [ ] **Step 1: Write RED production-wiring test**

In `start.test.ts`, inject WorkspaceManager history methods and assert `NativeCapabilityService` receives only structured values. Confirm no call routes through `ExecutionManager.run` or process policy.

- [ ] **Step 2: Implement CLI adapter wiring**

Add:

```ts
gitHistory: {
  log: (input) => managers.workspaceManager.gitLog(input),
  show: (input) => managers.workspaceManager.gitShow(input),
  range: (input) => managers.workspaceManager.gitRange(input),
  diffHistory: (input) => managers.workspaceManager.gitDiffHistory(input)
}
```

No argv assembly occurs here.

- [ ] **Step 3: Write RED MCP inventory/schema test before registering tools**

Expected inventory must include exactly four new names and continue to exclude:

```text
skill.run
provider.list
provider.tools
provider.invoke
service.install
service.start
service.stop
workspace.trust
git.exec
git.run
shell
```

Assert the `git.log/show/range/diffHistory` schemas contain `revision` objects/discriminators and no `argv`, `command`, `gitArgs`, `revisionExpression`, `network`, or host path field.

- [ ] **Step 4: Register four tools with capability schemas/results**

Example pattern:

```ts
server.registerTool(
  "git.log",
  {
    description: "List a bounded structured local Git commit history for a READY workspace.",
    inputSchema: GitLogInputSchema,
    outputSchema: GitLogResultSchema,
    annotations: READ_ONLY_TOOL_ANNOTATIONS
  },
  async (input) => nativeCapabilityResult(async () =>
    GitLogResultSchema.parse(await context.git.log(input))
  )
);
```

Repeat explicitly for `git.show`, `git.range`, `git.diffHistory`; do not generate registrations dynamically from arbitrary strings.

- [ ] **Step 5: Bump semantic surface RED -> GREEN**

First update the test to expect:

```ts
expect(MCP_SURFACE_VERSION).toBe("0.4");
```

Run it and confirm RED on current `0.3`, then change only:

```ts
export const MCP_SURFACE_VERSION = "0.4" as const;
```

Protocol remains `2026-07-28`; runtime remains `0.1`.

- [ ] **Step 6: Update frozen surface fixture**

Insert names in deterministic order:

```text
git.changes
git.diff
git.diffHistory
git.log
git.range
git.show
git.status
```

with required-field arrays from this task.

- [ ] **Step 7: Run focused MCP/CLI GREEN**

```bash
pnpm --filter @kodegpt/mcp-server test
pnpm --filter kodegpt test -- src/commands/start.test.ts
pnpm test:protocol
```

- [ ] **Step 8: Commit**

```bash
git add apps/cli/src/commands/start.ts apps/cli/src/commands/start.test.ts packages/mcp-server/src tests/fixtures/mcp-surface.ts
git commit -m "feat(mcp): expose bounded git history tools"
```

---

### Task 10: Add comprehensive security and integration regressions

**Files:**
- Create: `tests/security/git-history-isolation.test.ts`
- Modify: `tests/security/git-helper-isolation.test.ts`
- Modify: `tests/integration/mcp-http.test.ts`
- Modify: `tests/integration/full-stack.test.ts`

**Interfaces:**
- Security tests operate against the real Rust runtime/MCP surface or source-level invariants already used by this repo.
- Repository fixtures compare fingerprint/status before and after every history operation.

- [ ] **Step 1: Write RED raw-option/revision injection tests**

Attempt through public schemas/runtime fixtures:

```text
--all
--glob=refs/*
--output=/tmp/x
HEAD~3
HEAD^
HEAD@{1}
:/regex
main..HEAD
main...HEAD
```

Expected: `REVISION_INVALID` or transport schema rejection before Git command execution. No file under `/tmp` is created.

- [ ] **Step 2: Write RED path boundary/pathspec tests**

Attempt:

```text
/etc/passwd
../outside
src/../../outside
:(attr:foo)
:!secret
```

Expected: `PATH_INVALID`. Add legitimate path with spaces, Unicode, quotes, and a hyphen component to prove fixed literal path handling.

- [ ] **Step 3: Add malicious repository helper fixture**

Configure repository-local:

- `core.fsmonitor` helper;
- hooks path;
- `diff.external`;
- `diff.<driver>.textconv`;
- `filter.<driver>.clean/smudge/process/required`;
- pager/editor environment attempts where applicable;
- credential helper marker.

Each helper writes `HISTORY_HELPER_EXECUTED` to a marker if run. Execute `git.log`, `git.show(includePatch=true)`, `git.range`, and `git.diffHistory`. Assert marker never exists and outputs never contain helper text.

- [ ] **Step 4: Add PATH hijack and lazy-fetch protections**

Place a fake `git` executable in the workspace and any test-controlled inherited PATH. Assert real history results still come from the root-owned trusted Git executable and fake marker is absent.

Add a partial/promisor-style fixture with a locally missing object and remote URL. Assert history returns a local missing/read error within the fixed timeout, `GIT_NO_LAZY_FETCH=1` is present in the history spec, and no workspace-supplied transport/helper marker executes. Sandbox remains network-denied.

- [ ] **Step 5: Add timeout/source/large-output regressions**

Cover:

- 5-second production timeout constant cannot be overridden by MCP input;
- test-only shortened timeout returns `PROCESS_TIMEOUT` and leaves no execution registry entry;
- >100 commits sets `COMMIT_LIMIT` without enumerating the whole history;
- >500 changed paths sets `PATH_LIMIT`;
- >16 KiB body sets `MESSAGE_LIMIT`;
- >requested patch bytes sets `PATCH_LIMIT`;
- serialized public result never exceeds 512 KiB;
- incomplete structured record at a hard source cap returns `OUTPUT_LIMIT_EXCEEDED`, not malformed partial data.

- [ ] **Step 6: Add binary diff regression**

Commit a binary fixture. Assert `binary=true`/stat metadata is returned and patch does not contain a `GIT binary patch` payload or raw binary bytes.

- [ ] **Step 7: Add mutation/fingerprint regression**

Before the four history calls record:

```text
git status --porcelain=v1 -z
git rev-parse HEAD
git show-ref --head
git hash-object <tracked fixture>
```

After the calls assert byte-identical status/ref/HEAD/content hash. Also assert no new lock files/index changes/ref changes exist.

- [ ] **Step 8: Add public leakage regression**

Serialize all four MCP results/errors. Assert they contain none of:

```text
/home/
.worktrees/
capabilityId
processGroup
pid
artifactId
GIT_DIR=
commandLine
stderrRaw
```

Repository-relative paths and opaque `workspaceId` are allowed.

- [ ] **Step 9: Add HTTP/full-stack positive acceptance fixtures**

Known repo assertions:

```text
git.log(limit=5) -> <=5 deterministic summaries
git.show(fullOid) -> correct parents/paths/stat
git.range(ancestor,descendant) -> isAncestor=true
git.range(descendant,ancestor) -> isAncestor=false
git.diffHistory(base,head) -> deterministic bounded diff
```

Also verify current `git.status`, `git.diff`, `git.changes` results still match their existing fixtures.

- [ ] **Step 10: Run security/integration GREEN**

```bash
pnpm test:security
pnpm test:integration
pnpm test:acceptance
pnpm verify:forbidden
```

- [ ] **Step 11: Commit**

```bash
git add tests/security tests/integration
git commit -m "test(security): lock bounded git history authority"
```

The existing forbidden-pattern scan is executed unchanged in this task; this phase does not broaden that script unless a separately reproduced defect proves its current authored-product invariant is insufficient.

---

### Task 11: Deterministic exact-head verification, package candidate, deployed host acceptance, documentation, PR, merge, and post-merge baseline

**Files:**
- Modify: `docs/implementation/v0.1-execution-tracker.md`
- Create: `docs/release/2026-08-14-bounded-git-history-readiness.md`
- No product source changes after exact-head verification unless a new RED test reproduces a real defect first

**Interfaces:**
- Final candidate must preserve Stable Local Service installed-release mechanics.
- Deployed ChatGPT acceptance uses the exact candidate head, not an uncommitted worktree state.

- [ ] **Step 1: Run formatting before full gates**

```bash
cargo fmt --all -- --check
```

If it fails, run `cargo fmt --all`, inspect the diff, then rerun `cargo fmt --all -- --check`.

- [ ] **Step 2: Run the same deterministic CI gate sequence**

```bash
pnpm install --frozen-lockfile
cargo fmt --all -- --check
pnpm run typecheck
pnpm test
cargo test -p kodegpt-sandbox
pnpm test:rust
pnpm test:protocol
pnpm test:integration
pnpm test:security
pnpm test:isolation
pnpm test:acceptance
pnpm verify:forbidden
pnpm verify:package
```

Every command must PASS on the exact candidate head. Do not skip a later gate because an earlier broader test already passed.

- [ ] **Step 3: Verify forbidden public inventory and version triplet explicitly**

Run targeted tests or a local action inventory and record:

```text
runtime=0.1
protocol=2026-07-28
surface=0.4
```

Required Git public tools:

```text
git.status
git.diff
git.changes
git.log
git.show
git.range
git.diffHistory
```

Required absent tools/authority:

```text
skill.run
provider.list
provider.tools
provider.invoke
service lifecycle over MCP
workspace trust mutation over MCP
generic shell
raw arbitrary git command
network Git
Git mutation
provider-agent execution
desktop/computer use
```

- [ ] **Step 4: Commit final docs/evidence only after gates pass**

Tracker/readiness doc must record:

- exact candidate SHA;
- baseline SHA `3e3e257...`;
- four-tool scope;
- revision grammar/full-OID-only decision;
- fixed limits/timeouts;
- security test evidence;
- semantic surface `0.4` decision;
- full deterministic gate results;
- `v0.1` unchanged;
- provider interoperability not started.

Commit:

```bash
git add docs/implementation/v0.1-execution-tracker.md docs/release/2026-08-14-bounded-git-history-readiness.md
git commit -m "docs: record bounded git history readiness"
```

- [ ] **Step 5: Re-run exact-head gates affected by the docs commit**

At minimum rerun:

```bash
pnpm run typecheck
pnpm test
pnpm test:protocol
pnpm test:integration
pnpm test:security
pnpm verify:forbidden
pnpm verify:package
cargo test --workspace
```

If docs are included by any snapshot/forbidden/package gate, these commands prove the exact final PR head.

- [ ] **Step 6: Push feature branch and wait for CI**

Use normal non-force push. CI must run the repository's `Deterministic v0.1 gates` job on the exact pushed head and complete SUCCESS before host cutover/merge readiness claims.

- [ ] **Step 7: Stage the exact candidate through the established package/service flow**

From the exact candidate worktree:

```bash
cargo build --release -p kodegpt-runtime
node scripts/stage-runtime.mjs
pnpm --filter kodegpt build
pnpm --filter @kodegpt/runtime-linux-x64 pack --pack-destination /tmp/kodegpt-history-candidate
pnpm --filter kodegpt pack --pack-destination /tmp/kodegpt-history-candidate
```

Use the candidate CLI/package artifacts produced by this flow to run the existing local operator command:

```bash
kodegpt service install --name public:kodegpt-dev
kodegpt service status --json
```

Before explicit cutover, status must show a staged candidate while the current active installed release remains the existing service baseline. If the global `kodegpt` command is not the candidate bundle, invoke the just-packed/clean-installed candidate CLI rather than relying on same-version global npm provenance.

- [ ] **Step 8: Perform explicit managed service cutover only after candidate CI is green**

Use the existing service lifecycle:

```bash
kodegpt service restart
kodegpt service status --json
```

Verify `running`, `listenerReady=true`, `managedExposure=true`, local port `43121`, zrok reserved name `public:kodegpt-dev`, runtime `0.1`, protocol `2026-07-28`, surface `0.4`, and Node/Rust executable provenance under the new immutable installed release root. No runtime dependency may point to the feature worktree.

- [ ] **Step 9: Perform bounded real ChatGPT host acceptance**

Only the phase-specific smoke:

1. `system.health` -> `ok=true`, audit healthy, filesystem boundary available;
2. `system.capabilities` -> runtime `0.1`, protocol `2026-07-28`, surface `0.4`;
3. inspect action inventory and schemas for four new tools;
4. `workspace.open` known already-trusted repo;
5. `git.log(limit=5)`;
6. `git.show` using one full OID returned by log;
7. `git.range` known ancestor pair and reverse pair;
8. `git.diffHistory` known base/head;
9. one limit truncation case;
10. one invalid revision case such as an abbreviated OID, expecting schema/stable rejection;
11. `git.status`, `git.diff`, `git.changes` existing behavior check;
12. confirm absent provider/mutation/raw-Git/generic-shell tools.

Do not repeat unrelated skill/provider/full host suites.

- [ ] **Step 10: Final diff review and PR merge**

Review exact feature branch diff against the post-PR #8 baseline. Required final properties:

- only intended Git history/runtime/core/capability/MCP/tests/docs changes;
- no Stable Local Service redesign;
- no provider interoperability;
- no arbitrary Git/process authority;
- no tag movement.

Open/mark ready/merge through normal PR flow only after exact-head CI + host acceptance PASS. Do not rebase/force-push to cosmetically rewrite history.

- [ ] **Step 11: Post-merge canonical reconciliation**

After merge:

```bash
git fetch origin --prune
git rev-list --left-right --count main...origin/main
git status --short --branch
git rev-parse v0.1^{}
kodegpt service status --json
```

Reconcile canonical local `main` to the merged remote using ancestry-safe normal fast-forward/update behavior. Required final state:

```text
main == origin/main
main...origin/main = 0 0
working tree clean
v0.1 unchanged
installed service running/listenerReady
surface=0.4
```

Only then remove the feature worktree/local branch and remote feature branch if merged and no longer needed.

- [ ] **Step 12: Freeze final phase baseline**

Record merge SHA, CI run, active installed release ID/provenance, bounded host acceptance evidence, and next ranked gap. **Do not start provider interoperability in the same closure task.**

---

## Plan self-review checklist

Before implementation starts, the executor must verify this plan still matches the design spec:

- [ ] Four and only four new public history tools.
- [ ] `git.diffHistory` remains distinct from current `git.diff`.
- [ ] Full OID only; no abbreviated OID path accidentally added.
- [ ] Branch/tag ref grammar remains strict local subset.
- [ ] No arbitrary relative ancestry/reflog/range expression input.
- [ ] Every path-taking command uses fixed `--literal-pathspecs` and `--`.
- [ ] Every history command uses trusted Git + Bubblewrap + read-only retained root + network deny + `GIT_NO_LAZY_FETCH=1`.
- [ ] Every top-level history request is decision/outcome audited.
- [ ] Timeout/source/output/list limits match the design constants.
- [ ] Rename detection, binary payloads, textconv, external diff, and submodule traversal remain disabled.
- [ ] Stable errors do not expose raw stderr/host paths.
- [ ] Existing `git.status`, `git.diff`, `git.changes` stay semantically unchanged.
- [ ] Runtime `0.1`, MCP protocol `2026-07-28`, semantic surface `0.4`.
- [ ] `v0.1` unchanged.
- [ ] No provider interoperability or provider-agent execution.
