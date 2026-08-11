# KodeGPT Native Capability Layer — Tasks 4–6 Hardening Design

**Date:** 2026-08-11  
**Status:** Approved design, pending implementation plan  
**Base commit:** `be5da38` (`feat(capabilities): add safe verification recipes`)  
**Implementation branch:** `feat/native-capability-layer-hardening`

## 1. Purpose

This hardening pass corrects semantic, boundedness, audit, error-contract, and maintainability weaknesses found during the post-implementation review of:

- Task 4 — `code.search`
- Task 5 — `git.changes`
- Task 6 — `verify.list` / `verify.run`

The goal is not to start Task 7 or redesign KodeGPT. The goal is to make Tasks 4–6 honest, deterministic, operationally bounded, and strong enough that Task 7 (`file.patch`) and Task 8 (`context.build`) can safely build on them without later contract rewrites.

## 2. Non-negotiable architecture invariants

This pass preserves the existing KodeGPT security and runtime architecture:

1. Rust remains the final OS/security authority.
2. MCP never grants workspace trust.
3. Workspace access remains rooted in the retained workspace FD and existing `openat2` boundary.
4. No capability may expose host absolute paths, raw file descriptors, PIDs, credentials, or trusted executable paths.
5. No shell parser or arbitrary shell command path is added.
6. No second workspace manager, process executor, Git executor, or capability service is introduced in production.
7. Existing audit fail-closed behavior remains authoritative.
8. Existing process execution continues through the same Bubblewrap/trusted-executable path.
9. Existing Git inspection continues through the same hardened read-only Git execution machinery.
10. All newly added authority is narrow, internal, bounded, and unavailable as an arbitrary MCP escape hatch.
11. Public capability additions remain within Phase 1 and keep `MCP_SURFACE_VERSION = "0.2"` unless implementation reveals an actual incompatible protocol break.
12. Task 7 implementation is explicitly out of scope.

## 3. Review findings and required resolution

| # | Finding | Required resolution |
|---|---|---|
| 1 | `git.changes.fingerprint` can remain unchanged when file contents change and changes when `includePatch` changes | Fingerprint becomes content-sensitive and request-option invariant |
| 2 | `git.changes(includePatch:true)` does not honestly cover staged/worktree/untracked state | Include staged + worktree patch views and explicit untracked coverage metadata |
| 3 | `code.search` silently skips files above 1 MiB while returning `truncated:false` | Oversized candidate files make the result incomplete explicitly |
| 4 | Search can scan roughly 2 GiB in a worst-case 2,000-file tree | Add aggregate scan budget and deterministic stop semantics |
| 5 | `verify.list.allowed` means policy-compatible rather than runnable | Combine policy + trusted executable + sandbox availability |
| 6 | Package verification is hardcoded to `pnpm` | Deterministic package-manager discovery for pnpm/npm/yarn/bun |
| 7 | `verify.run` lacks semantic decision/outcome audit | Add dedicated durable verification audit events around the existing process execution |
| 8 | Capability errors are inconsistent/raw | Add one stable capability error contract and MCP-safe mapping |
| 9 | `NativeCapabilityService` dependency sprawl causes `{} as never` test stubs | Group feature dependencies and provide typed test defaults/factories |
| 10 | Verification recursively traverses up to 10,000 entries merely to find root manifests | Replace with exact known-path probes/reads through retained-root authority |
| 11 | Porcelain-v1 text parser relies on ` -> ` and bespoke Git C-quote decoding | Move to NUL-delimited status records and remove delimiter/quote ambiguity |
| 12 | Verification execution is not recorded in Dev Console like `process.run`; docs remain unchecked | Record verification operations and reconcile Task 4–6 documentation |

## 4. Task 4 hardening — honest and bounded `code.search`

### 4.1 Current failure mode

The Rust lexical search currently:

- recursively enumerates only the default 2,000 tree entries;
- may read up to 1 MiB per candidate file;
- silently skips any file whose size exceeds 1 MiB;
- has a 500-match and 256 KiB returned-snippet ceiling;
- exposes only one `truncated` boolean.

This allows two bad combinations:

1. a large text file can be skipped while `code.search(mode:"text")` reports `precision:"exact", truncated:false`;
2. a no-match search can read close to 2 GiB of source data before returning a tiny result.

### 4.2 New low-level search limits

Keep the existing per-file maximum:

```text
SEARCH_FILE_MAX_BYTES = 1 MiB
```

Add an aggregate source scan ceiling:

```text
SEARCH_MAX_SCANNED_BYTES = 64 MiB
```

Use the existing hard tree maximum for capability search:

```text
SEARCH_TREE_MAX_ENTRIES = 10,000
```

`WorkspaceManager.search()` keeps its historical public/default match behavior. `searchBounded()` remains the explicit capability path.

The Rust search iteration remains deterministic. Before reading a candidate file, its regular-file size contributes to the aggregate scan budget. If the next eligible file would exceed the aggregate budget, search stops and reports incompleteness. This avoids consuming unbounded I/O merely because a query is absent.

### 4.3 Explicit incompleteness reasons

Extend the internal Rust search result with bounded, stable reasons:

```text
TREE_LIMIT
FILE_SIZE_LIMIT
SCAN_BYTE_LIMIT
MATCH_LIMIT
SNIPPET_BYTE_LIMIT
```

Rules:

- a candidate regular file larger than 1 MiB is skipped and adds `FILE_SIZE_LIMIT`;
- reaching the 64 MiB aggregate source ceiling adds `SCAN_BYTE_LIMIT` and stops deterministic scanning;
- underlying tree truncation adds `TREE_LIMIT`;
- discovering another lexical match after the requested match limit adds `MATCH_LIMIT`;
- exhausting the aggregate returned-snippet budget adds `SNIPPET_BYTE_LIMIT`;
- reasons are deduplicated and returned in deterministic order.

Binary files and invalid-UTF-8 files remain outside the v1 lexical-text domain and may be skipped without pretending compiler-level coverage. They do not independently create a truncation reason. An oversized file is different because its textual/binary nature is not inspected; therefore it must conservatively mark incompleteness.

### 4.4 Public `code.search` contract

Add an additive field:

```ts
truncationReasons: Array<
  | "TREE_LIMIT"
  | "FILE_SIZE_LIMIT"
  | "SCAN_BYTE_LIMIT"
  | "MATCH_LIMIT"
  | "SNIPPET_BYTE_LIMIT"
>;
```

Contract:

```text
truncated === (truncationReasons.length > 0)
```

For path mode, applicable reasons are `TREE_LIMIT` and `MATCH_LIMIT` only. For symbol/definition/reference modes, low-level lexical reasons propagate and classification-level result overflow adds `MATCH_LIMIT` if not already present.

`precision:"exact"` for `text` continues to mean exact lexical matching within the searched text domain; completeness is represented independently by `truncated` and `truncationReasons`.

### 4.5 Required Task 4 regression tests

Rust tests must prove:

- oversized regular file containing an otherwise unique query => `FILE_SIZE_LIMIT`, `truncated:true`;
- aggregate file sizes crossing 64 MiB => deterministic stop + `SCAN_BYTE_LIMIT`;
- exact requested match count with no additional match => not truncated;
- additional match beyond requested maximum => `MATCH_LIMIT`;
- snippet budget exhaustion => `SNIPPET_BYTE_LIMIT`;
- tree > search tree limit => `TREE_LIMIT`;
- requested match count above 500 remains rejected by Rust authority.

Capability/MCP tests must prove reason propagation for text/path/heuristic modes and structured/text parity.

## 5. Task 5 hardening — state-correct `git.changes`

### 5.1 Fingerprint semantic contract

`fingerprint` is a deterministic digest of the observable Git change checkpoint. It is not a credential.

For the same workspace Git state:

```text
git.changes({includePatch:false}).fingerprint
===
git.changes({includePatch:true}).fingerprint
```

When `git.changes.truncated === false`, the fingerprint must change when any observable checkpoint component changes, including:

- normalized index/worktree status;
- staged tracked content;
- unstaged tracked content;
- untracked regular-file content.

Changing `foo.ts` from one modified content state to another must not retain the same fingerprint merely because both status records are `M`. When the checkpoint is truncated, the fingerprint remains deterministic for the bounded observable state but is explicitly not proof that omitted state is equal.

### 5.2 Checkpoint identity must not depend on previews or patch generation

Preview bytes are presentation data and must not be fingerprint authority. `includePatch:false` must not generate staged/worktree textual diffs merely to compute the fingerprint.

Use an internal machine-readable Git checkpoint status based on porcelain v2 `-z`. Porcelain v2 provides stable index/HEAD object identity and mode evidence for tracked records, while retained-root content hashing supplies the current worktree identity that Git status does not provide as a content hash.

The canonical checkpoint record contains, in deterministic path order:

```text
normalized porcelain-v2 status record
HEAD/index modes and object IDs where present
rename/copy source identity where present
current worktree content identity when the worktree side has content
untracked content identity
```

For staged-only tracked changes, the index object ID is the staged content identity. For worktree-modified tracked files, current worktree content identity is added. For untracked files, current content identity is added. Deletions are represented by status/mode absence and do not need a content digest for the missing side.

The final public fingerprint is SHA-256 over a versioned canonical serialization of these records. It must not include `includePatch`, preview bytes, artifact IDs, request IDs, operation IDs, or other request-specific metadata.

### 5.3 Retained-root path content identity

Add a narrow internal SHA-256 path-identity primitive in Rust workspace I/O:

```text
hash current path identity beneath retained root
→ regular file: hash file bytes
→ symlink: hash link-target bytes without following the link
→ no content returned
→ no host path returned
→ magic-link/xdev/retained-root boundary preserved
```

The checkpoint path-identity budget is explicitly bounded:

```text
GIT_CHECKPOINT_MAX_CHANGED_RECORDS = 10,000
GIT_CHECKPOINT_MAX_HASHED_BYTES     = 64 MiB aggregate
GIT_CHECKPOINT_MAX_SINGLE_HASH_BYTES = 64 MiB
```

A directory or unsupported special-file change that cannot be represented safely marks the checkpoint incomplete rather than being silently ignored. A path whose current content exceeds the hashing budget is not partially hashed and marks `git.changes.truncated:true`.

This primitive is internal to checkpoint construction or WorkspaceManager adapters. It is not exposed as an arbitrary MCP hashing tool in this pass.

If status records or path hashing are incomplete, `git.changes.truncated` must be true. The fingerprint remains deterministic for the observable bounded state, but callers must not treat a truncated checkpoint as proof of complete equality.

### 5.4 Internal checkpoint status parsing

Do **not** change the existing public `git.status` presentation contract merely to harden `git.changes`.

Add a narrow internal checkpoint status operation, backed by the same hardened Git runner, using NUL-delimited porcelain:

```text
git status --porcelain=v2 -z --untracked-files=all --ignore-submodules=all
```

The internal runtime/checkpoint layer parses the NUL records into closed normalized status records before they reach the capability layer. Parsing rules:

- records are split by NUL, never by newline;
- rename/copy source/destination fields follow Git's `-z` record structure rather than parsing `" -> "`;
- valid UTF-8 paths are preserved exactly;
- malformed/incomplete records fail with a stable capability error when the source is claimed complete;
- no partial trailing record may be interpreted as a complete path;
- the capability layer no longer needs the bespoke C-quoted path decoder.

The legacy `git.status` MCP tool may continue using its existing human-oriented bounded preview. `git.changes` uses the internal structured checkpoint path instead of reparsing that preview.

### 5.5 Patch semantics

`includePatch:true` must produce an honest change review view covering both tracked layers:

1. staged diff (`HEAD` ↔ index);
2. worktree diff (index ↔ worktree).

The public result keeps a compact combined preview/artifact for compatibility, but adds explicit coverage metadata:

```ts
patchCoverage: {
  staged: true;
  worktree: true;
  untracked: false;
};
```

The combined representation is deterministic: staged section first, worktree section second. It uses fixed KodeGPT section framing that is presentation metadata, not input to `file.patch`.

Untracked content is included in fingerprint identity but not falsely represented as unified patch coverage in v1. Future support may add an explicit untracked patch form, but this hardening pass reports `untracked:false`.

If either tracked patch stream cannot be represented completely within the bounded artifact/preview contract, `truncated:true` propagates. Fingerprint identity remains independent of whether the caller requested the patch presentation.

### 5.6 Summary semantics

`summary.changedFiles` remains the number of normalized changed paths visible in the bounded status result.

Do not add line insertion/deletion counts unless they can be derived from complete deterministic diff evidence without weakening boundedness. Optional fields remain optional.

### 5.7 Required Task 5 regression tests

Tests must prove:

- same XY/path but changed file contents => different fingerprint;
- staged-only content change => fingerprint changes;
- unstaged content change => fingerprint changes;
- untracked file content change => fingerprint changes;
- same state with/without `includePatch` => identical fingerprint;
- status record order differences normalize to identical fingerprint;
- filenames containing spaces, ` -> `, quotes, tabs, and valid UTF-8 survive NUL parsing correctly;
- rename/copy destination normalization follows `-z` structure;
- staged and worktree patch sections are both present when applicable;
- `patchCoverage` is `{staged:true, worktree:true, untracked:false}`;
- no host absolute path appears in structured or text MCP output;
- status/hash/patch budget incompleteness propagates `truncated:true`.

## 6. Task 6 hardening — applicable safe verification recipes

### 6.1 Meaning of `allowed`

After hardening, `VerificationRecipe.allowed === true` means all static prerequisites known to KodeGPT are satisfied at discovery time:

1. workspace effective policy has `allowProcess:true`;
2. logical executable is in `allowedExecutableNames`;
3. the logical executable resolves through the existing trusted-executable resolver;
4. the required sandbox provider is currently discoverable/usable for the existing process path.

This does not guarantee a future process exits successfully. It means KodeGPT is not knowingly advertising a recipe that the current process authority cannot even launch.

Stable blocked reasons include:

```text
PROCESS_NOT_ALLOWED
EXECUTABLE_NOT_ALLOWED
EXECUTABLE_UNAVAILABLE
SANDBOX_UNAVAILABLE
PACKAGE_MANAGER_UNKNOWN
PACKAGE_MANAGER_CONFLICT
```

Policy reasons take precedence over environment availability reasons so narrowed policy remains explicit.

### 6.2 Trusted executable/sandbox availability probe

Add an internal read-only runtime capability probe that:

- accepts only a capability identity + logical executable name;
- never accepts a host path;
- never returns the resolved executable path;
- does not launch the requested executable;
- uses the existing trusted-executable resolver and sandbox discovery path;
- returns only closed structured availability state.

The probe is available through WorkspaceManager to verification discovery only. It is not exposed as a generic MCP tool during this pass.

### 6.3 Package-manager discovery

Recognize package scripts only for fixed script names:

```text
test
lint
typecheck
build
```

The script body remains metadata only and is never parsed or executed directly.

Determine the package manager using root evidence:

1. parse a supported `packageManager` field from root `package.json`;
2. inspect exact known root lockfile names;
3. require the evidence to resolve to one manager without conflict.

Supported managers:

| Evidence | Logical executable | Recipe argv |
|---|---|---|
| `pnpm` / `pnpm-lock.yaml` | `pnpm` | `run <script>` |
| `npm` / `package-lock.json` / `npm-shrinkwrap.json` | `npm` | `run <script>` |
| `yarn` / `yarn.lock` | `yarn` | `run <script>` |
| `bun` / `bun.lock` / `bun.lockb` | `bun` | `run <script>` |

Rules:

- an explicit supported `packageManager` field and matching lockfile evidence reinforce each other;
- conflicting explicit/lockfile evidence fails closed with `PACKAGE_MANAGER_CONFLICT`;
- multiple competing lockfile families without explicit unambiguous evidence fail closed;
- package scripts with no manager evidence remain discoverable as blocked recipes using `PACKAGE_MANAGER_UNKNOWN`, so GPT can explain why verification is unavailable instead of silently omitting useful intent;
- no PATH probing in TypeScript is allowed.

To represent a blocked package recipe without inventing a launcher, evolve the recipe contract so launch fields are optional:

```ts
interface VerificationRecipe {
  id: string;
  label: string;
  category: VerificationCategory;
  source: VerificationSource;
  allowed: boolean;
  blockedReason?: string;
  logicalExecutable?: string;
  argv?: string[];
  cwd?: string;
}
```

Rules for launch fields:

- `allowed:true` requires `logicalExecutable`, `argv`, and `cwd` to all be present;
- a known manager that is blocked only by policy/environment keeps its launch fields for explainability;
- `PACKAGE_MANAGER_UNKNOWN` or `PACKAGE_MANAGER_CONFLICT` recipes omit launch fields rather than filling a guessed executable;
- `verify.run` must reject any recipe lacking a complete launch tuple even if a bug incorrectly marked it allowed.

### 6.4 Root manifest discovery without recursive tree traversal

`verify.list` must not recursively enumerate a 10,000-entry repository merely to discover root manifests.

Add/use an exact retained-root known-path probe for:

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

The probe returns only existence + entry kind for the exact relative path. It preserves the retained-root boundary and does not descend directories.

Read `package.json` only when the exact probe says it is a regular file. The existing 64 KiB package-manifest ceiling remains. Cargo discovery requires only an exact regular-file `Cargo.toml` probe.

`verify.run` re-resolves recipes using the same exact probes immediately before execution.

### 6.5 Cargo verification

Keep fixed Cargo recipes:

```text
cargo:test      => cargo test --workspace
cargo:check     => cargo check --workspace
cargo:fmt-check => cargo fmt --all -- --check
```

Their `allowed` state uses the same policy + trusted executable + sandbox availability contract as package-manager recipes.

### 6.6 Semantic audit for `verify.run`

The existing `process.run` audit remains mandatory and authoritative for the OS action. Add a semantic verification audit around it so the audit stream records what higher-level action caused the process execution.

Required ordering:

```text
re-resolve recipe
→ verify policy/environment availability
→ durable VERIFY_RUN decision audit
→ existing process.run path (with its own durable decision audit)
→ durable VERIFY_RUN request-outcome audit
```

If the semantic decision audit fails, `verify.run` must fail closed before calling process execution.

`VERIFY_RUN` outcome is defined at the **request/launch boundary**, not as a replacement for later process lifecycle auditing:

- foreground execution records the operation state returned by the existing process path;
- background execution records that the verification operation was successfully started and includes only the opaque operation ID/state already safe for public use;
- launch failure records a stable failure classification;
- later background completion/cancellation remains represented by the existing process operation/status/cancel audit path and is not duplicated as a synthetic future `verify.run` event.

The semantic audit payload may contain bounded safe identifiers such as workspace capability identity, recipe ID, logical executable name, opaque operation ID, returned operation state, and stable failure classification. It must never contain manifest script body, host executable path, raw stdout/stderr, credentials, or host absolute paths.

The implementation may use a narrow internal runtime audit RPC/action rather than introducing a second process authority.

### 6.7 Dev Console observability

When `verify.run` produces a process operation, record the operation in Dev Console using the same existing process-operation representation used by `process.run`.

Do not create a second operation store. Verification remains a semantic wrapper over the existing process operation.

### 6.8 Required Task 6 regression tests

Tests must prove:

- pnpm/npm/yarn/bun evidence resolves to the correct fixed executable/argv;
- conflicting package-manager evidence is blocked deterministically;
- missing package-manager evidence yields blocked package recipes rather than arbitrary fallback;
- malicious package script bodies are never parsed into executable/argv;
- `allowProcess:false` blocks regardless of executable availability;
- absent executable allowlist blocks before environment availability;
- policy-allowed but untrusted/unavailable executable => `EXECUTABLE_UNAVAILABLE`;
- sandbox-unavailable static probe => `SANDBOX_UNAVAILABLE`;
- discovery performs no process execution;
- discovery performs exact known-path probes rather than recursive tree enumeration;
- `verify.run` re-resolves manager/policy/availability before execution;
- client cannot inject executable/argv/cwd/env/network overrides;
- semantic audit decision occurs before process execution;
- semantic audit failure prevents process execution;
- request-outcome audit records foreground returned state, background start state, or stable launch failure without duplicating later process lifecycle audit;
- verification operation is recorded in Dev Console;
- MCP structured/text output remains equivalent and contains no host path.

## 7. Stable cross-capability error contract

### 7.1 One error type

Introduce a capability-layer error abstraction with a stable `code` and MCP-safe message. Representative required codes:

```text
CAPABILITY_INPUT_INVALID
CAPABILITY_LIMIT_EXCEEDED
CAPABILITY_SOURCE_INCOMPLETE
CAPABILITY_SOURCE_INVALID
GIT_INSPECTION_FAILED
GIT_STATUS_INVALID
VERIFICATION_NOT_FOUND
VERIFICATION_NOT_ALLOWED
VERIFICATION_DISCOVERY_INVALID
VERIFICATION_AUDIT_UNAVAILABLE
```

Names may be extended only when a genuinely distinct recovery action exists. Avoid per-function ad-hoc codes that mean the same thing.

### 7.2 Error boundary rules

- Capability functions must not leak raw Node/Rust host exception text directly to MCP.
- Host absolute paths, executable paths, FDs, PIDs, credentials, or raw environment values are forbidden in MCP-facing error text.
- Internal causes may be retained for local debugging if they are not serialized across MCP.
- MCP tool handlers map known capability errors to deterministic safe tool errors.
- Unknown internal errors map to a generic stable internal capability failure without echoing the raw host cause.
- Tests include hostile path/error fixtures and assert redaction by construction.

## 8. `NativeCapabilityService` dependency hardening

Keep one production service, but group dependencies by feature so adding Task 7/8 does not create an ever-growing flat constructor and unsafe unit-test casts.

Target shape conceptually:

```ts
interface NativeCapabilityFeatures {
  workspace: {
    inspection: WorkspaceInspectionAdapter;
    search: CodeSearchAdapter;
  };
  git: GitCheckpointAdapter;
  verification: {
    workspace: VerificationWorkspaceAdapter;
    availability: VerificationAvailabilityAdapter;
    execution: CapabilityExecutionAdapter;
    audit: VerificationAuditAdapter;
  };
}
```

Exact names may differ in implementation, but these rules are mandatory:

1. production construction must statically require every advertised Task 4–6 feature dependency;
2. production still creates one `NativeCapabilityService`;
3. unit tests use typed feature fixtures/defaults, never `{} as never`;
4. unavailable test adapters throw deterministic `CapabilityNotImplementedError`/test errors if accidentally invoked;
5. pure capability functions remain independently testable without booting production infrastructure.

Task 7 dependencies must not be pre-added beyond narrow primitives already required by this hardening.

## 9. Documentation reconciliation

After implementation is green:

- mark completed Task 4–6 execution-plan steps accurately;
- append a concise hardening note referencing this spec and the hardening implementation plan/commit;
- update the master capability design where public semantics changed (`code.search.truncationReasons`, Git patch coverage/fingerprint semantics, verification blocked reasons);
- document that `allowed:true` means all known static launch prerequisites are satisfied, not that the test command will exit successfully;
- document the current non-goal that untracked files participate in fingerprint identity but not v1 patch coverage.

Do not rewrite historical commits or pretend the original Task 4–6 commits contained the hardening.

## 10. Testing strategy

Implementation follows issue-by-issue RED → GREEN. Each semantic defect must first have the smallest regression test that fails on `be5da38`.

### 10.1 Focused gates

At minimum:

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/core test
pnpm --filter @kodegpt/mcp-server test
pnpm --filter kodegpt test
cargo test -p kodegpt-workspace-io
cargo test -p kodegpt-runtime
cargo test -p kodegpt-sandbox
pnpm exec vitest run tests/integration/full-stack.test.ts --no-file-parallelism
pnpm exec vitest run tests/integration/mcp-http.test.ts tests/integration/mcp-stdio.test.ts tests/integration/cli-bridge.test.ts --no-file-parallelism
```

### 10.2 Final gates

All must be fresh on the final hardening tree:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm verify:forbidden
pnpm verify:package
pnpm test:rust
```

No hardening completion claim is allowed while any final gate is red.

### 10.3 Baseline timing observation

While creating this design worktree from unchanged `be5da38`, the first `pnpm test:rust` run produced two timing-sensitive runtime test failures (`inspect_root` 500 ms response timeout and poisoned-registry child-cleanup marker timing). Both tests passed in isolation, the complete `kodegpt-runtime` suite then passed 29/29, and a fresh full `pnpm test:rust` passed.

This observation is not evidence for a production defect and must not be "fixed" speculatively. If the same test flake recurs during implementation, systematic debugging must establish a reproducible root cause before changing timeout/process-cleanup behavior. It is not permission to weaken the security assertions.

## 11. Acceptance criteria

The hardening pass is complete only when all of the following are true:

1. `code.search` never silently reports complete results after skipping an oversized candidate file.
2. Search has an explicit aggregate source-byte budget and deterministic truncation reasons.
3. `git.changes.fingerprint` changes with staged, unstaged, or untracked content changes and is identical for the same state regardless of `includePatch`.
4. Git status parsing no longer relies on newline + ` -> ` + bespoke C-quote decoding.
5. `includePatch:true` covers staged and worktree tracked diffs and explicitly reports that untracked patch coverage is false.
6. Verification package-manager selection is deterministic across pnpm/npm/yarn/bun and fails closed on conflict/unknown evidence.
7. Verification discovery no longer performs a recursive 10,000-entry tree solely for root manifests.
8. `VerificationRecipe.allowed:true` requires current policy compatibility plus trusted executable and sandbox availability.
9. `verify.run` emits durable semantic decision/outcome audit in addition to the existing process audit.
10. `verify.run` still cannot accept arbitrary executable/argv/cwd/env/network input.
11. Verification operations appear in existing Dev Console process observability.
12. Task 4–6 capability errors use stable MCP-safe error codes/messages with host information excluded.
13. No Task 4–6 unit test uses `{} as never` to satisfy unrelated capability dependencies.
14. Production contains exactly one native capability service, one WorkspaceManager, and one process/Git authority path.
15. Task 7 remains unimplemented.
16. Final TypeScript, package, security, integration, and Rust gates are all green.

## 12. Explicit non-goals

This hardening pass does **not**:

- add LSP/tree-sitter/compiler-precise search;
- make binary/non-UTF-8 content searchable as text;
- add arbitrary package scripts beyond the fixed safe recipe names;
- add networked package-manager installation or executable discovery;
- trust user-local/NVM executables merely to make verification runnable;
- add untracked unified-patch generation;
- implement `file.patch`;
- implement `context.build`;
- expose internal hash/executable/probe primitives as generic MCP tools;
- alter workspace trust semantics;
- weaken Bubblewrap, AppArmor, retained-root, openat2, or durable-audit boundaries.

## 13. Delivery shape

Implementation should be decomposed into reviewable commits rather than one opaque rewrite. Recommended logical sequence:

1. search completeness + scan-budget hardening;
2. Git checkpoint identity + NUL status + patch coverage;
3. verification discovery/availability/audit hardening;
4. cross-capability error/service-construction cleanup + documentation reconciliation;
5. final full verification commit if documentation/gate-only adjustments remain.

Each commit must keep the branch buildable/testable for its affected area. The implementation plan may refine file-level sequencing, but it may not weaken the acceptance criteria above.
