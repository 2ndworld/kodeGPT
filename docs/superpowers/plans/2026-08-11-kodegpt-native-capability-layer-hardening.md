# KodeGPT Native Capability Layer Tasks 4–6 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden Tasks 4–6 so `code.search` is honestly bounded, `git.changes` fingerprints actual observable Git state independent of request presentation options, and verification recipes are deterministically discoverable, runnable only when statically launchable, semantically audited, and MCP-safe.

**Architecture:** Preserve one Rust security authority, one `WorkspaceManager`, one `NativeCapabilityService`, one Git execution path, and one process execution path. Add only narrow internal runtime primitives: richer search completeness metadata, retained-root path identity, structured Git checkpoint/patch operations, trusted-executable availability inspection, and an audited verification wrapper around the existing process-run dispatcher. TypeScript remains composition/orchestration only and never gains host filesystem, shell, or executable-path authority.

**Tech Stack:** TypeScript 5.9, Zod 4, Vitest 3, Node `crypto` for pure capability fingerprint serialization, Rust 2024, `rustix`, `serde`, `sha2` for retained-root SHA-256, Tokio, existing Bubblewrap sandbox/runtime audit/spool infrastructure, MCP SDK.

## Global Constraints

- Base implementation is commit `be5da38`; design spec is commit `b33ff10` at `docs/superpowers/specs/2026-08-11-kodegpt-native-capability-layer-hardening-design.md`.
- Work only on branch `feat/native-capability-layer-hardening` in `/home/sauron/dev/kodegpt/.worktrees/native-capability-layer-hardening`.
- Rust remains the final OS/security authority; MCP never grants workspace trust.
- Preserve retained-root/openat2 boundaries, Bubblewrap/AppArmor policy, durable audit before OS action, and fail-closed audit poisoning.
- Do not expose host absolute paths, trusted executable paths, FDs, PIDs, credentials, raw environment values, or raw host error strings through MCP.
- Do not add a shell parser, arbitrary shell execution, second workspace manager, second capability service, second Git executor, or second process executor.
- Task 7 `file.patch` and Task 8 `context.build` remain unimplemented.
- `MCP_SURFACE_VERSION` remains `"0.2"` unless an actually incompatible MCP contract break is proven.
- Public additions in this hardening are additive except the intentional `VerificationRecipe` launch-field relaxation required to represent unknown/conflicting package managers without inventing a launcher.
- Search limits: per-file text search 1 MiB, aggregate scanned bytes 64 MiB, search tree 10,000 entries, public max matches 500, aggregate returned snippets 256 KiB.
- Git checkpoint limits: 10,000 changed records, 64 MiB aggregate hashed current-path bytes, 64 MiB single-path hash maximum; truncated checkpoints are deterministic bounded observations but never proof of complete equality.
- Verification package scripts remain limited to `test`, `lint`, `typecheck`, and `build`; script bodies are metadata only and never parsed into commands.
- Every semantic defect starts with a failing regression test. Do not implement multiple unrelated fixes before observing RED for each task.
- Historical Task 4/5/6 commits remain unchanged; hardening is delivered as new commits.

---

### Task 1: Stable capability errors and typed feature dependency construction

**Files:**
- Create: `packages/capabilities/src/errors.ts`
- Create: `packages/capabilities/src/test-support.ts`
- Modify: `packages/capabilities/src/adapters.ts`
- Modify: `packages/capabilities/src/native-capability-service.ts`
- Modify: `packages/capabilities/src/index.ts`
- Modify: `packages/capabilities/src/code-search.test.ts`
- Modify: `packages/capabilities/src/git-changes.test.ts`
- Modify: `packages/capabilities/src/verification.test.ts`
- Modify: `packages/capabilities/src/workspace-inspect.test.ts`
- Modify: `packages/capabilities/src/contracts.test.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/structured-results.test.ts`
- Modify: `apps/cli/src/commands/start.ts`
- Modify: `apps/cli/src/commands/start.test.ts`

**Interfaces:**
- Produces:
  - `CapabilityErrorCode`
  - `CapabilityError`
  - `toPublicCapabilityError(error: unknown): { code: CapabilityErrorCode; message: string }`
  - grouped `NativeCapabilityDependencies`
  - typed `createTestCapabilityDependencies()` helper with inert throwing adapters rather than `{} as never`
  - MCP helper that converts native-capability errors to stable safe messages and maps unknown internal errors to `CAPABILITY_INTERNAL` without exposing the original error text.
- Consumes: existing Task 3–6 adapters and one existing `NativeCapabilityService` production construction.

- [ ] **Step 1: Add RED tests for stable public error mapping**

Add tests in `packages/capabilities/src/contracts.test.ts` covering known and unknown causes:

```ts
expect(toPublicCapabilityError(new CapabilityError("CAPABILITY_LIMIT_EXCEEDED", "Search limit exceeded")))
  .toEqual({ code: "CAPABILITY_LIMIT_EXCEEDED", message: "Search limit exceeded" });

expect(toPublicCapabilityError(new Error("ENOENT /home/sauron/private-secret")))
  .toEqual({ code: "CAPABILITY_INTERNAL", message: "Native capability failed" });
```

Add MCP regression coverage that a native capability throwing a host-looking error does not expose `/home/`, `ENOENT`, or the raw message.

- [ ] **Step 2: Run the RED tests**

Run:

```bash
pnpm --filter @kodegpt/capabilities test -- contracts
pnpm --filter @kodegpt/mcp-server test -- structured-results
```

Expected: FAIL because `CapabilityError`/safe native-tool mapping do not exist.

- [ ] **Step 3: Implement the stable capability error contract**

Create `packages/capabilities/src/errors.ts` with the closed initial code union:

```ts
export type CapabilityErrorCode =
  | "CAPABILITY_INPUT_INVALID"
  | "CAPABILITY_LIMIT_EXCEEDED"
  | "CAPABILITY_SOURCE_INCOMPLETE"
  | "CAPABILITY_SOURCE_INVALID"
  | "GIT_INSPECTION_FAILED"
  | "GIT_STATUS_INVALID"
  | "VERIFICATION_NOT_FOUND"
  | "VERIFICATION_NOT_ALLOWED"
  | "VERIFICATION_DISCOVERY_INVALID"
  | "VERIFICATION_AUDIT_UNAVAILABLE"
  | "CAPABILITY_NOT_IMPLEMENTED"
  | "CAPABILITY_INTERNAL";

export class CapabilityError extends Error {
  constructor(
    readonly code: CapabilityErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CapabilityError";
  }
}

export function toPublicCapabilityError(error: unknown): {
  code: CapabilityErrorCode;
  message: string;
} {
  if (error instanceof CapabilityError) {
    return { code: error.code, message: error.message };
  }
  return { code: "CAPABILITY_INTERNAL", message: "Native capability failed" };
}
```

Make `CapabilityNotImplementedError` extend `CapabilityError` with `CAPABILITY_NOT_IMPLEMENTED`.

Do not serialize `cause` or raw nested errors through MCP.

- [ ] **Step 4: Group `NativeCapabilityService` dependencies without adding a second service**

Replace the flat constructor with a feature-grouped type:

```ts
export interface NativeCapabilityDependencies {
  workspace: {
    inspection: WorkspaceInspectionAdapter;
    search: CodeSearchAdapter;
  };
  git: GitInspectionAdapter;
  verification: {
    workspace: VerificationWorkspaceAdapter;
    execution: CapabilityExecutionAdapter;
  };
}
```

The exact adapter names will evolve in Tasks 4–5, but the production object remains one `NativeCapabilityService`.

Create `packages/capabilities/src/test-support.ts` with typed inert adapters that throw if accidentally invoked and an override-based factory. Update all capability tests to use it. Remove every `{} as never` occurrence from `packages/capabilities/src/*.test.ts`.

- [ ] **Step 5: Add the MCP native-capability safe error boundary**

In `packages/mcp-server/src/tools.ts`, wrap native capability handlers (`workspace.inspect`, `code.search`, `git.changes`, `verify.list`, `verify.run`, and future native capability sentinels if registered later) with one helper conceptually equivalent to:

```ts
async function nativeCapabilityResult<T>(operation: () => Promise<T>): Promise<ToolResult> {
  try {
    return structuredToolResult(await operation());
  } catch (error) {
    const safe = toPublicCapabilityError(error);
    throw new Error(`${safe.code}: ${safe.message}`);
  }
}
```

Do not wrap legacy low-level tools in this pass unless they call the native capability service.

- [ ] **Step 6: Production-wire the grouped dependency object**

Update `apps/cli/src/commands/start.ts` so there is still exactly one:

```ts
const nativeCapabilities = new NativeCapabilityService({
  workspace: { inspection: ..., search: ... },
  git: ...,
  verification: { workspace: ..., execution: ... }
});
```

Update `start.test.ts` to assert the same existing `WorkspaceManager` backs all groups.

- [ ] **Step 7: Run GREEN, typecheck, and forbidden scan**

Run:

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/mcp-server test
pnpm --filter kodegpt test
pnpm typecheck
pnpm verify:forbidden
```

Expected: all PASS and repository search for `{} as never` under `packages/capabilities/src/*.test.ts` returns no matches.

- [ ] **Step 8: Commit Task 1**

```bash
git add packages/capabilities packages/mcp-server apps/cli
git commit -m "refactor(capabilities): stabilize errors and feature wiring"
```

---

### Task 2: Make `code.search` completeness explicit and cap aggregate scan I/O

**Files:**
- Modify: `crates/workspace-io/src/read.rs`
- Modify: `crates/runtime/src/dispatcher.rs`
- Modify: `packages/core/src/workspace-manager.ts`
- Modify: `packages/capabilities/src/adapters.ts`
- Modify: `packages/capabilities/src/contracts.ts`
- Modify: `packages/capabilities/src/schemas.ts`
- Modify: `packages/capabilities/src/code-search.ts`
- Modify: `packages/capabilities/src/code-search.test.ts`
- Modify: `packages/capabilities/src/contracts.test.ts`
- Modify: `packages/mcp-server/src/structured-results.test.ts`
- Modify: `tests/capabilities/contracts.test.ts`
- Modify: `tests/integration/full-stack.test.ts`

**Interfaces:**
- Produces internal Rust `SearchTruncationReason` and `SearchResult.truncation_reasons`.
- Produces TypeScript `WorkspaceSearchTruncationReason` and `CodeSearchResult.truncationReasons`.
- Preserves existing `truncated` boolean with invariant `truncated === truncationReasons.length > 0`.
- Does not change `file.search` request parameters or public `code.search` input.

- [ ] **Step 1: Add RED Rust tests for oversized-file and aggregate-byte incompleteness**

Add fixtures in `crates/workspace-io/src/read.rs`:

```rust
#[test]
fn lexical_search_marks_oversized_candidate_as_incomplete() {
    // one >1 MiB regular file containing the unique query
    // expect zero visible matches, truncated=true,
    // reasons == [SearchTruncationReason::FileSizeLimit]
}

#[test]
fn lexical_search_stops_at_aggregate_scan_budget() {
    // deterministic files whose total eligible sizes exceed 64 MiB
    // expect ScanByteLimit and deterministic prefix only
}
```

Also update existing exact-match/tree/snippet tests to assert exact reason sets.

- [ ] **Step 2: Run the Rust RED tests**

```bash
cargo test -p kodegpt-workspace-io lexical_search -- --nocapture
```

Expected: FAIL because current search only returns `truncated` and silently skips >1 MiB files.

- [ ] **Step 3: Implement bounded reason-aware Rust search**

In `read.rs` add:

```rust
pub const SEARCH_TREE_MAX_ENTRIES: usize = TREE_MAX_ENTRIES;
pub const SEARCH_MAX_SCANNED_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SearchTruncationReason {
    TreeLimit,
    FileSizeLimit,
    ScanByteLimit,
    MatchLimit,
    SnippetByteLimit,
}
```

Use `tree_beneath(..., SEARCH_TREE_MAX_ENTRIES)` for lexical search. Track eligible regular-file sizes before reading. Rules:

```rust
if stat.st_size as u64 > SEARCH_FILE_MAX_BYTES {
    reasons.insert(SearchTruncationReason::FileSizeLimit);
    continue;
}
if scanned_bytes.saturating_add(stat.st_size as u64) > SEARCH_MAX_SCANNED_BYTES {
    reasons.insert(SearchTruncationReason::ScanByteLimit);
    break 'files;
}
```

Only add `MatchLimit` when another actual matching line exists beyond `max_matches`; do not infer it from `matches.len() == max_matches`. Add `SnippetByteLimit` only when an actual next match cannot fit the snippet budget. Binary and invalid-UTF8 files remain skipped without an independent reason.

Return deterministic reason ordering from the ordered set and derive `truncated` from non-empty reasons.

- [ ] **Step 4: Propagate reasons through runtime/core adapters**

Extend WorkspaceManager validation to accept only the five closed reason strings:

```ts
export type WorkspaceSearchTruncationReason =
  | "TREE_LIMIT"
  | "FILE_SIZE_LIMIT"
  | "SCAN_BYTE_LIMIT"
  | "MATCH_LIMIT"
  | "SNIPPET_BYTE_LIMIT";
```

Reject a runtime payload where `truncated` disagrees with `truncationReasons.length > 0` as `RUNTIME_PROTOCOL_INVALID`.

- [ ] **Step 5: Add public capability schema and classification-level reasons**

Extend `CodeSearchResult` and `CodeSearchResultSchema` with `truncationReasons`.

For `path` mode:

```text
tree.truncated -> TREE_LIMIT
matchingPaths.length > maxResults -> MATCH_LIMIT
```

For symbol/definition/reference modes, merge low-level reasons with classification-level `MATCH_LIMIT` and return reasons in the fixed public order:

```text
TREE_LIMIT
FILE_SIZE_LIMIT
SCAN_BYTE_LIMIT
MATCH_LIMIT
SNIPPET_BYTE_LIMIT
```

- [ ] **Step 6: Replace `code.search` ad-hoc validation errors with the stable capability contract**

Map invalid workspace/query/path input to `CAPABILITY_INPUT_INVALID` and public/result ceilings to `CAPABILITY_LIMIT_EXCEEDED`. Do not retain raw `TypeError` as the native capability boundary.

- [ ] **Step 7: Add RED→GREEN capability/MCP/full-stack assertions**

Update `code-search.test.ts` to prove:

- `text` propagates each low-level reason;
- `path` distinguishes tree truncation from result overflow;
- heuristic modes preserve low-level incompleteness and add `MATCH_LIMIT` only when classification overflows;
- exact complete result has `truncated:false, truncationReasons:[]`.

Update MCP/public contract tests and full-stack structured/text parity.

- [ ] **Step 8: Run focused and security gates**

```bash
cargo test -p kodegpt-workspace-io
cargo test -p kodegpt-runtime
pnpm --filter @kodegpt/core test
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/mcp-server test
pnpm exec vitest run tests/integration/full-stack.test.ts --no-file-parallelism
pnpm typecheck
pnpm verify:forbidden
```

- [ ] **Step 9: Commit Task 2**

```bash
git add crates/workspace-io crates/runtime packages/core packages/capabilities packages/mcp-server tests
git commit -m "fix(capabilities): make code search completeness explicit"
```

---

### Task 3: Add one retained-root exact path identity primitive for Git and verification

**Files:**
- Create: `crates/workspace-io/src/path_identity.rs`
- Modify: `crates/workspace-io/src/lib.rs`
- Modify: `crates/workspace-io/Cargo.toml`
- Modify: `Cargo.lock`
- Modify: `crates/protocol/src/types.rs`
- Modify: `crates/protocol/src/lib.rs`
- Modify: `packages/protocol/src/runtime-types.ts`
- Modify: `tests/protocol/runtime-schema.test.ts`
- Modify: `crates/runtime/src/audit.rs`
- Modify: `crates/runtime/src/dispatcher.rs`
- Modify: `packages/core/src/workspace-manager.ts`
- Modify: `packages/core/src/workspace-manager.test.ts`
- Modify: `packages/capabilities/src/adapters.ts`

**Interfaces:**
- New internal runtime method: `file.identity`.
- Request:

```ts
{ capabilityId: string; path: string; includeSha256: boolean }
```

- Result:

```ts
interface WorkspacePathIdentityResult {
  schemaVersion: 1;
  exists: boolean;
  kind?: "file" | "directory" | "symlink" | "other";
  sizeBytes?: number;
  sha256?: string;
  hashTruncated: boolean;
}

interface CapabilityPathIdentityResult {
  exists: boolean;
  kind?: "file" | "directory" | "symlink" | "other";
  sizeBytes?: number;
  sha256?: string;
  hashTruncated: boolean;
}
```

`WorkspaceManager` owns the schema-versioned runtime result; `packages/capabilities/src/adapters.ts` owns the narrow structural `CapabilityPathIdentityResult` so the capability package does not import `@kodegpt/core`.

- Rust helper is callable directly by Git checkpoint code without performing an internal RPC round-trip.
- `file.identity` is internal runtime/core authority only; it is not registered as an MCP tool.

- [ ] **Step 1: Add RED workspace-io tests for exact path identity**

Test regular file, missing path, directory, symlink without following, outside symlink target, traversal, and >64 MiB hash refusal.

Required assertions:

```text
includeSha256=false -> exact kind/size, no content read/hash
regular file + includeSha256=true -> lowercase 64-hex SHA-256
symlink + includeSha256=true -> hash link-target bytes, never target file contents
>64 MiB path -> no partial hash, hashTruncated=true
../ or absolute -> boundary error
missing -> exists=false, hashTruncated=false
```

- [ ] **Step 2: Run RED**

```bash
cargo test -p kodegpt-workspace-io path_identity -- --nocapture
```

Expected: FAIL because the module/API does not exist.

- [ ] **Step 3: Add `sha2` and implement FD-relative identity**

Add `sha2 = "0.10"` to `crates/workspace-io/Cargo.toml`.

Implement a hard per-path hash ceiling:

```rust
pub const PATH_IDENTITY_MAX_HASH_BYTES: u64 = 64 * 1024 * 1024;
```

For regular files, open beneath the retained root with existing `open_existing_beneath`, validate the opened FD is still a regular file, then stream SHA-256 without returning bytes.

For symlinks, use FD-relative `readlinkat` semantics against the retained parent; hash the link-target bytes themselves and never follow the symlink. Do not use host absolute path canonicalization.

For `include_sha256 = false`, use no-follow metadata only.

- [ ] **Step 4: Add closed TS/Rust runtime request types**

Add `FileIdentityParams` to Rust protocol and `file.identity` to `RUNTIME_METHODS`/Zod request schemas. Keep `deny_unknown_fields` / `.strict()` parity.

- [ ] **Step 5: Add durable audit before identity OS access**

Add `AuditAction::FileIdentity -> "file_identity"`.

Dispatcher order:

```text
parse/validate params
→ durable FileIdentity decision audit
→ duplicate READY retained root FD
→ inspect/hash beneath root
→ durable success/failure outcome
```

Map boundary/limit errors to stable runtime codes without serializing the host path.

- [ ] **Step 6: Add `WorkspaceManager.pathIdentity()` and validation**

Add:

```ts
async pathIdentity(
  workspaceId: string,
  path: string,
  options: { includeSha256: boolean }
): Promise<WorkspacePathIdentityResult>
```

Validate closed result shape, lowercase SHA-256, safe integer sizes, and invariant that missing entries have no kind/size/hash.

- [ ] **Step 7: Run protocol/core/Rust GREEN**

```bash
pnpm test:protocol
pnpm --filter @kodegpt/core test
cargo test -p kodegpt-protocol
cargo test -p kodegpt-workspace-io
cargo test -p kodegpt-runtime
pnpm typecheck
pnpm verify:forbidden
```

- [ ] **Step 8: Commit Task 3**

```bash
git add Cargo.lock crates/workspace-io crates/protocol crates/runtime packages/protocol packages/core packages/capabilities/src/adapters.ts tests/protocol
git commit -m "feat(runtime): add retained-root path identity"
```

---

### Task 4: Replace preview-derived `git.changes` with a structured content-sensitive checkpoint

**Files:**
- Modify: `crates/protocol/src/types.rs`
- Modify: `crates/protocol/src/lib.rs`
- Modify: `packages/protocol/src/runtime-types.ts`
- Modify: `crates/runtime/src/audit.rs`
- Modify: `crates/runtime/src/git.rs`
- Modify: `crates/runtime/src/dispatcher.rs`
- Modify: `packages/core/src/workspace-manager.ts`
- Modify: `packages/core/src/workspace-manager.test.ts`
- Modify: `packages/capabilities/src/adapters.ts`
- Modify: `packages/capabilities/src/contracts.ts`
- Modify: `packages/capabilities/src/schemas.ts`
- Modify: `packages/capabilities/src/git-changes.ts`
- Modify: `packages/capabilities/src/git-changes.test.ts`
- Modify: `packages/capabilities/src/native-capability-service.ts`
- Modify: `apps/cli/src/commands/start.ts`
- Modify: `apps/cli/src/commands/start.test.ts`
- Modify: `packages/mcp-server/src/structured-results.test.ts`
- Modify: `tests/capabilities/contracts.test.ts`
- Modify: `tests/integration/full-stack.test.ts`

**Interfaces:**
- Preserve public legacy `git.status` and `git.diff` behavior.
- Add internal runtime methods:
  - `git.checkpoint`
  - `git.checkpoint_patch`
- Add `GitCheckpointAdapter` used only by native `git.changes`.
- `git.checkpoint` returns normalized porcelain-v2 records plus current-path identities needed for fingerprinting and an explicit `truncated` bit.
- `git.checkpoint_patch` returns one bounded combined staged+worktree patch preview/artifact.
- Use this narrow capability-layer shape rather than importing core types:

```ts
export interface CapabilityGitCheckpointRecord {
  recordType: "ordinary" | "rename" | "unmerged" | "untracked";
  path: string;
  originalPath?: string;
  indexStatus?: string;
  worktreeStatus?: string;
  headMode?: string;
  indexMode?: string;
  worktreeMode?: string;
  headOid?: string;
  indexOid?: string;
  stage1Oid?: string;
  stage2Oid?: string;
  stage3Oid?: string;
  currentIdentity?: CapabilityPathIdentityResult;
}

export interface CapabilityGitCheckpointResult {
  schemaVersion: 1;
  records: CapabilityGitCheckpointRecord[];
  truncated: boolean;
}

export interface GitCheckpointAdapter {
  checkpoint(workspaceId: string): Promise<CapabilityGitCheckpointResult>;
  checkpointPatch(workspaceId: string): Promise<GitInspectionAdapterResult>;
}
```

`CapabilityPathIdentityResult` is the structural adapter type introduced in Task 3/used by Task 5; it must remain in `adapters.ts` and must not import `@kodegpt/core`.
- Public `GitChangesResult` adds:

```ts
patchCoverage?: { staged: true; worktree: true; untracked: false };
```

- Public `fingerprint` never includes patch preview, artifact IDs, request IDs, operation IDs, or `includePatch`.

- [ ] **Step 1: Add RED capability tests for fingerprint semantics**

Extend `git-changes.test.ts` with adapter fixtures that represent normalized checkpoint records and assert:

```text
same status/path + different worktree SHA-256 -> different fingerprint
same index status/path + different index object ID -> different fingerprint
same untracked path + different content SHA-256 -> different fingerprint
same checkpoint includePatch=false/true -> identical fingerprint
same records in different order -> identical fingerprint
truncated checkpoint -> public truncated=true
```

Remove tests that make fingerprint authority depend on `stdoutPreview`.

- [ ] **Step 2: Run capability RED**

```bash
pnpm --filter @kodegpt/capabilities test -- git-changes
```

Expected: FAIL because current `GitInspectionAdapter` still parses porcelain-v1 preview and fingerprint includes optional patch preview.

- [ ] **Step 3: Add RED Rust tests for porcelain-v2 `-z` parsing**

In `crates/runtime/src/git.rs`, add fixtures for record types `1`, `2`, `u`, and `?` covering:

```text
space in path
literal " -> " in path
quotes
TAB
UTF-8
rename destination + source NUL record
staged-only
worktree-only
both-side modification
unmerged stages
untracked
```

Assert parser never relies on newline or C-quote decoding.

- [ ] **Step 4: Implement `git.checkpoint` on the existing hardened Git runner**

Use:

```text
git status --porcelain=v2 -z --untracked-files=all --ignore-submodules=all
```

Retain all existing hardening options (`GIT_OPTIONAL_LOCKS=0`, global/system config suppression, hooks disabled, credential helper disabled, external diff/textconv disabled, network denied, workspace read-only, filter-driver neutralization).

Bound structured status independently:

```rust
const GIT_CHECKPOINT_MAX_RECORDS: usize = 10_000;
const GIT_CHECKPOINT_STATUS_MAX_BYTES: usize = 4 * 1024 * 1024;
const GIT_CHECKPOINT_MAX_HASHED_BYTES: u64 = 64 * 1024 * 1024;
```

Parse into closed Rust records. For records whose worktree side has current content and for untracked paths, call the Task 3 retained-root path-identity helper directly. Accumulate file sizes before hashing; once the aggregate 64 MiB budget would be exceeded, mark checkpoint truncated and do not partially hash that path.

The runtime result must not include the retained root path.

- [ ] **Step 5: Add `WorkspaceManager.gitCheckpoint()` validation**

Create a closed `WorkspaceGitCheckpointResult` type. Validate:

- schemaVersion literal 1;
- normalized status chars;
- safe modes/object IDs/path strings;
- optional original path for rename/copy;
- optional current identity lowercase SHA-256;
- no duplicate canonical path record unless the porcelain record type explicitly requires distinct conflict stages;
- `truncated` boolean.

- [ ] **Step 6: Implement request-option-invariant fingerprint composition**

Replace preview hashing in `git-changes.ts` with canonical serialization of normalized checkpoint records. Use bytewise path ordering and explicit field names/version marker:

```ts
const canonical = {
  schemaVersion: 1,
  records: [...checkpoint.records].sort(compareCheckpointRecord)
};
const fingerprint = createHash("sha256")
  .update(JSON.stringify(canonical), "utf8")
  .digest("hex");
```

Derive public `changedPaths` from the checkpoint records. A truncated status/hash checkpoint must never claim `clean:true`.

- [ ] **Step 7: Add RED Rust test and implement combined tracked patch generation**

Add `git.checkpoint_patch` using two hardened Git commands, in fixed order:

```text
STAGED:   git diff --cached --no-ext-diff --no-textconv --ignore-submodules=all
WORKTREE: git diff          --no-ext-diff --no-textconv --ignore-submodules=all
```

Create one raw spool artifact and one preview with fixed KodeGPT framing:

```text
=== KODEGPT STAGED DIFF ===
<staged bytes>
=== KODEGPT WORKTREE DIFF ===
<worktree bytes>
```

Refactor the existing Git runner only enough to let both commands reuse the same hardened spawn/capture machinery and shared spool writer. Do not introduce a shell or an alternate Git resolver.

Return a `GitInspectionResult`-compatible combined presentation object. If either section exceeds preview/spool source limits, set source/preview truncation honestly.

- [ ] **Step 8: Public patch coverage and production wiring**

When `includePatch:true`, call `gitCheckpointPatch()` and return:

```ts
patchCoverage: { staged: true, worktree: true, untracked: false }
```

Keep `patchPreview` and singular `patchArtifact` for compatibility. Untracked content participates in fingerprint identity but is not represented as a unified patch.

Update `NativeCapabilityService` grouped Git dependency from legacy inspection to `GitCheckpointAdapter`. Keep low-level `context.git.status/diff` wired to existing `WorkspaceManager.gitStatus/gitDiff` unchanged.

Map native Git checkpoint failures through the Task 1 stable contract: malformed structured status => `GIT_STATUS_INVALID`; non-zero/failed hardened Git execution => `GIT_INSPECTION_FAILED`; bounded incomplete source remains a successful `truncated:true` result rather than a raw exception. Never forward stderr/host paths as the MCP error message.

- [ ] **Step 9: Add MCP/full-stack regressions**

Full-stack must create:

- staged-only change;
- additional worktree change;
- untracked file.

Assert:

```text
changedPaths includes all three classes
fingerprint stable across includePatch false/true for same state
fingerprint changes after modifying untracked or worktree content
patch preview contains staged and worktree section headers
patchCoverage == {staged:true, worktree:true, untracked:false}
no host absolute workspace path appears in output
```

- [ ] **Step 10: Run focused gates**

```bash
cargo test -p kodegpt-runtime git:: -- --nocapture
pnpm --filter @kodegpt/core test
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/mcp-server test
pnpm --filter kodegpt test
pnpm exec vitest run tests/integration/full-stack.test.ts --no-file-parallelism
pnpm typecheck
pnpm verify:forbidden
```

- [ ] **Step 11: Commit Task 4**

```bash
git add crates/protocol crates/runtime packages/protocol packages/core packages/capabilities packages/mcp-server apps/cli tests
git commit -m "fix(capabilities): harden git change checkpoints"
```

---

### Task 5: Make safe verification recipes deterministic, statically runnable, and semantically audited

**Files:**
- Modify: `crates/protocol/src/types.rs`
- Modify: `crates/protocol/src/lib.rs`
- Modify: `packages/protocol/src/runtime-types.ts`
- Modify: `crates/runtime/src/audit.rs`
- Modify: `crates/runtime/src/dispatcher.rs`
- Modify: `packages/core/src/workspace-manager.ts`
- Modify: `packages/core/src/workspace-manager.test.ts`
- Modify: `packages/capabilities/src/contracts.ts`
- Modify: `packages/capabilities/src/schemas.ts`
- Modify: `packages/capabilities/src/adapters.ts`
- Modify: `packages/capabilities/src/verification.ts`
- Modify: `packages/capabilities/src/verification.test.ts`
- Modify: `packages/capabilities/src/native-capability-service.ts`
- Modify: `packages/capabilities/src/test-support.ts`
- Modify: `apps/cli/src/commands/start.ts`
- Modify: `apps/cli/src/commands/start.test.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/structured-results.test.ts`
- Modify: `tests/integration/full-stack.test.ts`
- Modify: `tests/security/audit-foundation.test.ts`
- Modify: `tests/security/audit-redaction.test.ts`

**Interfaces:**
- `VerificationRecipe` launch tuple becomes optional and is required exactly when `allowed:true`.
- New blocked reasons:

```text
PROCESS_NOT_ALLOWED
EXECUTABLE_NOT_ALLOWED
EXECUTABLE_UNAVAILABLE
SANDBOX_UNAVAILABLE
PACKAGE_MANAGER_UNKNOWN
PACKAGE_MANAGER_CONFLICT
```

- New internal runtime method: `process.inspect_executable`.
- New internal runtime method: `verify.run`, a semantic-audit wrapper that delegates to the same existing process-run dispatcher/launch path.
- Verification root discovery uses `WorkspaceManager.pathIdentity(..., {includeSha256:false})` from Task 3 instead of recursive tree enumeration.
- Evolve the TypeScript adapters to these exact responsibilities:

```ts
export interface CapabilityPathIdentityResult {
  exists: boolean;
  kind?: "file" | "directory" | "symlink" | "other";
  sizeBytes?: number;
  sha256?: string;
  hashTruncated: boolean;
}

export interface VerificationWorkspaceAdapter {
  readFile(
    workspaceId: string,
    path: string,
    options?: { offset?: number; maxBytes?: number }
  ): Promise<{ contents: string; bytesRead: number; eof: boolean }>;
  pathIdentity(
    workspaceId: string,
    path: string
  ): Promise<CapabilityPathIdentityResult>;
  effectivePolicy(workspaceId: string): {
    allowProcess: boolean;
    allowedExecutableNames: string[];
  };
}

export interface VerificationAvailabilityAdapter {
  inspectExecutable(
    workspaceId: string,
    logicalExecutable: string
  ): Promise<{ schemaVersion: 1; executableAvailable: boolean; sandboxAvailable: boolean }>;
}

export interface VerificationExecutionAdapter {
  run(input: {
    workspaceId: string;
    recipeId: string;
    logicalExecutable: string;
    argv: string[];
    cwd: string;
    background?: boolean;
  }): Promise<VerificationOperationResult>;
}
```

Remove `tree()` from `VerificationWorkspaceAdapter`; do not keep it as an unused compatibility escape hatch. Replace the Task 1 verification dependency group with `{ workspace, availability, execution }`.

- [ ] **Step 1: Add RED package-manager discovery tests**

In `verification.test.ts`, parameterize evidence for:

```text
packageManager pnpm@x + pnpm-lock.yaml        -> pnpm
packageManager npm@x + package-lock.json      -> npm
packageManager yarn@x + yarn.lock             -> yarn
packageManager bun@x + bun.lock               -> bun
matching lockfile only                         -> manager selected
explicit manager conflicting with lockfile     -> PACKAGE_MANAGER_CONFLICT
multiple lockfile families, no explicit manager-> PACKAGE_MANAGER_CONFLICT
scripts with no manager evidence               -> PACKAGE_MANAGER_UNKNOWN
```

For unknown/conflict recipes assert `logicalExecutable`, `argv`, and `cwd` are absent.

Keep the malicious script-body fixture and assert it never becomes argv.

- [ ] **Step 2: Add RED tests proving discovery does not call recursive tree**

Make the verification workspace test adapter throw if `tree()` is invoked. Expect `verify.list` to succeed using exact path probes/read only.

- [ ] **Step 3: Add RED availability-policy tests**

Introduce a fake availability adapter and assert precedence:

```text
allowProcess=false                           -> PROCESS_NOT_ALLOWED
allowProcess=true, executable not allowlisted-> EXECUTABLE_NOT_ALLOWED
allowlisted, trusted executable missing      -> EXECUTABLE_UNAVAILABLE
allowlisted + executable, sandbox missing    -> SANDBOX_UNAVAILABLE
all four static prerequisites satisfied      -> allowed:true
```

- [ ] **Step 4: Run capability RED**

```bash
pnpm --filter @kodegpt/capabilities test -- verification
```

Expected: FAIL because discovery is still pnpm-only/tree-based and has no availability adapter.

- [ ] **Step 5: Implement exact root evidence discovery and recipe contract**

Probe exactly these root paths with Task 3 `file.identity` / `WorkspaceManager.pathIdentity(includeSha256:false)`:

```text
package.json
Cargo.toml
pnpm-lock.yaml
package-lock.json
npm-shrinkwrap.json
yarn.lock
bun.lock
bun.lockb
```

Read `package.json` only when the exact identity says regular file, retaining the 64 KiB/eof requirement.

Parse only a supported package-manager name from `packageManager` before optional `@version`; do not execute package-manager discovery commands or PATH probes.

Update Zod so `allowed:true` requires a complete launch tuple and unknown/conflict blocked recipes omit it.

Map verification-native errors through Task 1: invalid workspace/recipe input => `CAPABILITY_INPUT_INVALID`; oversized/invalid package manifest or contradictory discovery state => `VERIFICATION_DISCOVERY_INVALID`; missing recipe => `VERIFICATION_NOT_FOUND`; blocked/incomplete recipe => `VERIFICATION_NOT_ALLOWED`. Never expose parser/runtime host error text through MCP.

- [ ] **Step 6: Add RED Rust tests for executable/sandbox availability inspection**

Add `process.inspect_executable` request tests that prove:

- no host path is returned;
- an unavailable logical executable returns `executableAvailable:false` rather than its attempted locations;
- Bubblewrap discovery failure maps to `sandboxAvailable:false` with a stable result;
- malformed/unknown fields are rejected;
- durable audit decision happens before trusted-executable/sandbox inspection.

- [ ] **Step 7: Implement `process.inspect_executable` without launching the requested executable**

Protocol request:

```ts
{ capabilityId: string; logicalExecutable: string }
```

Closed response:

```ts
{
  schemaVersion: 1;
  executableAvailable: boolean;
  sandboxAvailable: boolean;
}
```

Runtime behavior:

```text
validate READY capability
→ durable ProcessInspectExecutable decision audit
→ resolve_trusted_executable(logicalExecutable) without returning path
→ BubblewrapProvider::discover() without spawning requested executable
→ durable outcome audit
```

Add `AuditAction::ProcessInspectExecutable`.

Expose only through `WorkspaceManager.inspectExecutable()` and verification dependencies; do not register an MCP tool.

- [ ] **Step 8: Re-resolve current policy + availability immediately before run**

`runVerification()` must call `listVerifications()` again, find the current recipe, require `allowed:true`, require all launch fields present, then invoke the verification execution adapter using only stored fields. Client input remains only:

```ts
{ workspaceId: string; recipeId: string; background?: boolean }
```

Map missing recipe to `CapabilityError("VERIFICATION_NOT_FOUND", ...)` and blocked/incomplete launch tuple to `VERIFICATION_NOT_ALLOWED`.

- [ ] **Step 9: Add RED Rust audit-order tests for internal `verify.run`**

Required scenarios:

1. semantic VerifyRun decision audit fails -> process dispatch is never called;
2. semantic decision succeeds -> existing ProcessRun decision appears after it;
3. process launch/result returns -> semantic VerifyRun outcome follows;
4. semantic outcome audit failure returns `AUDIT_UNAVAILABLE` and poisons later decisions;
5. audit records contain no recipe script body, host executable path, stdout/stderr, or credentials.

- [ ] **Step 10: Refactor one shared process-dispatch path and implement internal `verify.run`**

Add closed Rust protocol `VerifyRunParams`:

```rust
pub struct VerifyRunParams {
    pub capability_id: String,
    pub recipe_id: String,
    pub logical_executable: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub background: bool,
}
```

Do not add env or network fields.

Refactor dispatcher so generic `process.run` and semantic `verify.run` both call one internal process dispatch function with the same `run_process`/Bubblewrap authority. Generate one opaque process operation ID and correlate both VerifyRun and ProcessRun audit contexts to it.

Required order:

```text
VerifyRun decision
→ ProcessRun decision
→ existing process launch/operation registration
→ ProcessRun outcome
→ VerifyRun outcome
```

A background start records semantic Success when the existing process path successfully returns a running operation. Later status/cancel/completion stays in existing process audit only.

- [ ] **Step 11: Wire `WorkspaceManager.runVerificationProcess()` and production capability execution**

Add a dedicated manager method that calls internal runtime `verify.run`, while generic `runProcess()` remains unchanged.

Update verification execution adapter to require `recipeId` and call `runVerificationProcess`. This is a semantic wrapper, not a second execution manager.

- [ ] **Step 12: Record verification operation in existing Dev Console state**

At MCP/tool-context boundary, after `verify.run` succeeds, call the same `consoleState.recordProcessOperation(operation)` used for `process.run`. Do not add a new operation store or new public operation shape.

Add a focused test proving both generic and verification-launched operations appear through the existing console model.

- [ ] **Step 13: Add MCP/full-stack verification regressions**

Full-stack must assert:

- `verify.list` no longer needs recursive tree discovery;
- package-manager evidence is reflected accurately;
- current dev host can report `EXECUTABLE_UNAVAILABLE` rather than `allowed:true` when the manager resolves only through an untrusted NVM/user path;
- no trusted executable path is exposed;
- an available trusted Cargo recipe can be marked allowed when policy and host permit it;
- structured/text parity holds;
- `verify.run` input schema still contains no executable/argv/cwd/env/network override;
- semantic audit includes `verify_run` decision/outcome plus existing `process_run` audit when a runnable fixture is available.

Use deterministic fake production-stack fixtures for successful launch mapping when the host lacks a trusted package-manager executable; do not weaken trusted executable rules to make the host pass.

- [ ] **Step 14: Run focused gates**

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/core test
pnpm --filter @kodegpt/mcp-server test
pnpm --filter kodegpt test
cargo test -p kodegpt-protocol
cargo test -p kodegpt-sandbox
cargo test -p kodegpt-runtime
pnpm exec vitest run tests/integration/full-stack.test.ts --no-file-parallelism
pnpm typecheck
pnpm verify:forbidden
```

- [ ] **Step 15: Commit Task 5**

```bash
git add crates/protocol crates/runtime packages/protocol packages/core packages/capabilities packages/mcp-server packages/dev-console apps/cli tests
git commit -m "fix(capabilities): harden safe verification recipes"
```

---

### Task 6: Reconcile public docs, verify transport contracts, and run all final gates

**Files:**
- Modify: `docs/superpowers/plans/2026-08-11-kodegpt-native-capability-layer.md`
- Modify: `docs/superpowers/specs/2026-08-11-kodegpt-capability-hub-skill-interoperability-design.md`
- Modify: `tests/integration/mcp-http.test.ts`
- Modify: `tests/integration/mcp-stdio.test.ts`
- Modify: `tests/integration/cli-bridge.test.ts`

**Interfaces:**
- No new public MCP tool names in this task.
- MCP Task 4–6 tools remain:

```text
code.search
git.changes
verify.list
verify.run
```

- `verify.run` remains `PROCESS_RUN_TOOL_ANNOTATIONS`; others remain read-only.

- [ ] **Step 1: Reconcile Task 4–6 historical checklist state**

In the original execution plan, mark completed Task 4–6 steps accurately and append a hardening note referencing:

```text
spec: docs/superpowers/specs/2026-08-11-kodegpt-native-capability-layer-hardening-design.md
plan: docs/superpowers/plans/2026-08-11-kodegpt-native-capability-layer-hardening.md
```

Do not rewrite history or imply original commits already contained the fixes.

- [ ] **Step 2: Update master public semantics**

Document exactly:

- `code.search.truncationReasons` and honest completeness semantics;
- `git.changes` content-sensitive/request-option-invariant fingerprint;
- staged/worktree/untracked patch coverage semantics;
- `VerificationRecipe.allowed:true` static-launch prerequisites;
- optional launch tuple for manager unknown/conflict;
- stable verification blocked reasons;
- untracked content participates in Git fingerprint but not v1 unified patch coverage.

- [ ] **Step 3: Run the three MCP transport regression suites**

```bash
pnpm exec vitest run tests/integration/mcp-http.test.ts tests/integration/mcp-stdio.test.ts tests/integration/cli-bridge.test.ts --no-file-parallelism
```

Expected: all PASS, locked tool list unchanged except additive schema fields, `verify.run` still has process-run annotations, JSON Schema conversion succeeds for every new schema.

- [ ] **Step 4: Run fresh complete TypeScript test suite**

```bash
pnpm test
```

Expected: 0 failures. Record final file/test counts in the completion report; do not hardcode old 56/231 counts in docs because hardening adds tests.

- [ ] **Step 5: Run typecheck and build**

```bash
pnpm typecheck
pnpm build
```

Expected: PASS.

- [ ] **Step 6: Run security/package gates**

```bash
pnpm verify:forbidden
pnpm verify:package
```

Expected: PASS and no new host-path/shell/runtime-coupling violations.

- [ ] **Step 7: Run fresh entire Rust workspace**

```bash
pnpm test:rust
```

Expected: PASS. If the pre-existing timing-sensitive runtime tests recur, use `superpowers:systematic-debugging`, reproduce in isolation/full runtime suite, and establish a root cause before changing timeout or process-cleanup assertions. Never raise timeouts or weaken child-cleanup/security assertions speculatively.

- [ ] **Step 8: Review final diff against the hardening spec**

Use one final change review and verify:

```text
no Task 7 implementation
no MCP trust exposure
no new shell execution
no second NativeCapabilityService
no second WorkspaceManager
no second Git/process authority
no host absolute path in new public contracts/errors
no `{} as never` in capability tests
MCP_SURFACE_VERSION remains 0.2
```

- [ ] **Step 9: Commit documentation/final reconciliation**

```bash
git add docs tests
git commit -m "docs(capabilities): reconcile task 4-6 hardening"
```

If tests required source-only fixes after Task 5, commit those fixes separately before this docs commit rather than hiding implementation changes in documentation reconciliation.

- [ ] **Step 10: Verify clean branch and prepare integration choice**

```bash
git status --short
git log --oneline --decorate -8
```

Expected: clean worktree on `feat/native-capability-layer-hardening`, with reviewable hardening commits after `b33ff10`.

Use `superpowers:verification-before-completion` before any completion claim and `superpowers:finishing-a-development-branch` before merge/push/keep decisions.
