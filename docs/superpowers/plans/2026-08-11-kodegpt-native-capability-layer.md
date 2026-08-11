# KodeGPT Native Capability Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic, typed, agent-grade native capabilities that let GPT Web understand, search, patch, verify, and build context for a trusted workspace with fewer primitive MCP round trips.

**Architecture:** Introduce `@kodegpt/capabilities` between MCP and the existing `WorkspaceManager` / `ExecutionManager` layer. Keep MCP as a thin schema/transport adapter, keep all OS-sensitive mutation in the existing Rust authority, and add only one new low-level conditional patch-commit RPC where stale-content protection requires it.

**Tech Stack:** Node.js >=24, TypeScript 5.9, pnpm 10, Vitest 3, Zod 4, Rust workspace crates, existing framed runtime protocol and workspace-io retained-root authority.

## Global Constraints

- KodeGPT MUST NOT spawn `codex`, invoke `codex exec`, attach to Codex sessions, or require a Codex process.
- GPT Web remains the reasoning/planning actor; new capabilities are deterministic and MUST NOT call an LLM.
- Rust remains final OS/security authority for security-sensitive filesystem/process actions.
- MCP MUST NOT establish workspace trust.
- Profiles remain monotonic restrictions; no capability may widen write/process/network/executable/environment authority.
- Do not add arbitrary shell execution. Verification compiles to logical executable + argv.
- New MCP-facing outputs MUST be bounded, deterministic, typed, and include structured content with text fallback.
- `file.patch` MUST NOT claim global multi-file atomicity. Its guarantee is full preflight before first write plus per-file conditional atomic commit.
- New persistent/runtime schemas use explicit schema versions and reject unsupported future versions.
- Existing audit, sandbox, trust, AppArmor/Bubblewrap, packaging, bridge/start/exposure, and security gates must remain green.

---

## File Structure

Create:

```text
packages/capabilities/
  package.json
  tsconfig.json
  vitest.config.ts
  src/index.ts
  src/contracts.ts
  src/adapters.ts
  src/workspace-inspect.ts
  src/code-search.ts
  src/git-changes.ts
  src/verification.ts
  src/patch.ts
  src/context-build.ts
  src/native-capability-service.ts
  src/*.test.ts
```

Modify:

```text
packages/mcp-server/package.json
packages/mcp-server/src/tool-context.ts
packages/mcp-server/src/tools.ts
packages/mcp-server/src/index.ts
packages/mcp-server/src/*.test.ts
packages/core/src/workspace-manager.ts
packages/core/src/workspace-manager.test.ts
packages/protocol/src/types.ts
packages/protocol/src/index.ts
crates/protocol/src/types.rs
crates/runtime/src/dispatcher.rs
crates/workspace-io/src/write.rs
crates/workspace-io/src/lib.rs
apps/cli/package.json
apps/cli/src/commands/start.ts
apps/cli/src/commands/start.test.ts
docs/compatibility/chatgpt.md
tests/security/security-invariants.test.ts
```

The existing `WorkspaceManager` remains the low-level trusted-workspace adapter. Do not move repository-understanding logic into it.

---

### Task 1: Create Typed Capability Contracts and Service Boundary

**Files:**
- Create: `packages/capabilities/package.json`
- Create: `packages/capabilities/tsconfig.json`
- Create: `packages/capabilities/vitest.config.ts`
- Create: `packages/capabilities/src/contracts.ts`
- Create: `packages/capabilities/src/adapters.ts`
- Create: `packages/capabilities/src/native-capability-service.ts`
- Create: `packages/capabilities/src/index.ts`
- Create: `packages/capabilities/src/contracts.test.ts`

**Interfaces:**
- Consumes: typed low-level workspace/process/artifact adapters.
- Produces: `NativeCapabilityService`, public input/result types, shared bounded defaults used by all later tasks.

- [x] **Step 1: Add the package skeleton and failing contract test**

`packages/capabilities/package.json`:

```json
{
  "name": "@kodegpt/capabilities",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json --noEmit",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@kodegpt/core": "workspace:*"
  }
}
```

`packages/capabilities/src/contracts.test.ts` starts with:

```ts
import { describe, expect, it } from "vitest";
import { CAPABILITY_SCHEMA_VERSION, DEFAULT_CONTEXT_MAX_BYTES } from "./contracts.js";

describe("capability contracts", () => {
  it("pins public schema and context bounds", () => {
    expect(CAPABILITY_SCHEMA_VERSION).toBe(1);
    expect(DEFAULT_CONTEXT_MAX_BYTES).toBe(256 * 1024);
  });
});
```

- [x] **Step 2: Run the package test and verify RED**

Run:

```bash
pnpm --filter @kodegpt/capabilities test
```

Expected: FAIL because `contracts.ts` exports do not exist.

- [x] **Step 3: Define the public contracts and bounds**

`contracts.ts` must export exactly these core discriminants/constants and the interfaces approved by the design:

```ts
export const CAPABILITY_SCHEMA_VERSION = 1 as const;
export const DEFAULT_CONTEXT_MAX_BYTES = 256 * 1024;
export const MAX_CONTEXT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_INSPECT_MAX_ENTRIES = 2_000;
export const MAX_INSPECT_MAX_ENTRIES = 10_000;
export const DEFAULT_SEARCH_MAX_RESULTS = 100;
export const MAX_SEARCH_MAX_RESULTS = 500;
export const MAX_PATCH_BYTES = 1024 * 1024;
export const MAX_PATCH_FILES = 64;
export const MAX_PATCH_HUNKS = 256;

export type CodeSearchMode = "text" | "path" | "symbol" | "definition" | "reference";
export type CodeSearchPrecision = "exact" | "lexical" | "heuristic";
export type ContextIntent = "understand" | "implement" | "debug" | "review" | "verify";
export type VerificationCategory = "test" | "lint" | "typecheck" | "build" | "format-check" | "custom";
```

Define the complete `WorkspaceInspect*`, `CodeSearch*`, `GitChanges*`, `VerificationRecipe`, `VerifyRun*`, `FilePatch*`, and `ContextBuild*` interfaces from the approved design. Every result begins with `schemaVersion: 1`.

- [x] **Step 4: Define narrow authority-specific adapters rather than depending on concrete managers**

`adapters.ts` must separate read inspection, search, Git inspection, patch mutation, and execution authority. The Task 3 read-only adapter is intentionally minimal:

```ts
export interface WorkspaceInspectionAdapter {
  readFile(
    workspaceId: string,
    path: string,
    options?: { offset?: number; maxBytes?: number }
  ): Promise<{ contents: string; bytesRead: number; eof: boolean }>;
  tree(
    workspaceId: string,
    path: string | undefined,
    maxEntries: number
  ): Promise<{
    entries: Array<{ path: string; kind: "file" | "directory" | "symlink" | "other" }>;
    truncated: boolean;
  }>;
}

export interface CodeSearchAdapter {
  search(workspaceId: string, query: string, path?: string): Promise<Array<{ path: string; line: number; lineText: string }>>;
}

export interface GitInspectionAdapter {
  gitStatus(workspaceId: string): Promise<GitInspectionAdapterResult>;
  gitDiff(workspaceId: string): Promise<GitInspectionAdapterResult>;
}

export interface PatchCommitAdapter {
  commitPatchFile(input: PatchCommitAdapterInput): Promise<PatchCommitAdapterResult>;
}

export interface CapabilityExecutionAdapter {
  run(input: {
    workspaceId: string;
    logicalExecutable: string;
    argv: string[];
    cwd?: string;
    background?: boolean;
  }): Promise<unknown>;
}
```

A capability receives only the adapter authority it actually uses. Do not expose capability IDs or host FDs through these interfaces.

- [x] **Step 5: Add the service skeleton**

`NativeCapabilityService` grows adapter dependencies only as capabilities are implemented. After Task 3 the constructor accepts `{ workspaceInspection }`; later tasks extend the options with search/Git/execution/patch adapters only when those authorities become necessary. Add methods with final signatures but throw `CAPABILITY_NOT_IMPLEMENTED` until their tasks land:

```ts
inspectWorkspace(input: WorkspaceInspectInput): Promise<WorkspaceInspectResult>
searchCode(input: CodeSearchInput): Promise<CodeSearchResult>
gitChanges(input: GitChangesInput): Promise<GitChangesResult>
listVerifications(input: VerifyListInput): Promise<VerifyListResult>
runVerification(input: VerifyRunInput): Promise<VerifyRunResult>
patchFile(input: FilePatchInput): Promise<FilePatchResult>
buildContext(input: ContextBuildInput): Promise<ContextBuildResult>
```

- [x] **Step 6: Run package typecheck/test GREEN**

```bash
pnpm --filter @kodegpt/capabilities typecheck
pnpm --filter @kodegpt/capabilities test
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add packages/capabilities

git commit -m "feat(capabilities): define native capability contracts"
```

---

### Task 2: Make MCP Outputs Structured and Tool Context Typed

**Files:**
- Modify: `packages/mcp-server/package.json`
- Modify: `packages/mcp-server/src/tool-context.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/index.ts`
- Test: existing `packages/mcp-server/src/*.test.ts`; add `packages/mcp-server/src/structured-results.test.ts`

**Interfaces:**
- Consumes: `@kodegpt/capabilities` public contracts.
- Produces: `structuredToolResult<T>()`, typed `KodegptToolContext`, placeholders for new capability namespaces.

- [x] **Step 1: Add a failing structured-result parity test**

Test one existing deterministic tool such as `workspace.list` and assert both channels contain equivalent data:

```ts
expect(result.structuredContent).toEqual([{ id: "ws_1" }]);
expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
```

Also add a compile-time fixture assigning a real typed workspace result to `WorkspaceToolContext.list` without `unknown` casts.

- [x] **Step 2: Run MCP tests RED**

```bash
pnpm --filter @kodegpt/mcp-server test
```

Expected: structured result test fails because generic tools currently return only `content`.

- [x] **Step 3: Add the capability dependency and common result helper**

Add:

```json
"@kodegpt/capabilities": "workspace:*"
```

Replace `toolResult(value: unknown)` with:

```ts
function structuredToolResult<T>(value: T) {
  const structuredContent = value ?? null;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent
  };
}
```

Use it for every deterministic existing tool except where the console tool already constructs an equivalent result.

- [x] **Step 4: Replace `Promise<unknown>` context signatures with explicit result types**

Use existing public types from `@kodegpt/core`, `@kodegpt/artifacts`, `@kodegpt/extensions`, and the new capabilities package. Preserve manager boundaries; do not weaken validation in `WorkspaceManager`.

Add new namespaces to `KodegptToolContext`:

```ts
workspace.inspect(input: WorkspaceInspectInput): Promise<WorkspaceInspectResult>;
code.search(input: CodeSearchInput): Promise<CodeSearchResult>;
git.changes(input: GitChangesInput): Promise<GitChangesResult>;
file.patch(input: FilePatchInput): Promise<FilePatchResult>;
verify.list(input: VerifyListInput): Promise<VerifyListResult>;
verify.run(input: VerifyRunInput): Promise<VerifyRunResult>;
context.build(input: ContextBuildInput): Promise<ContextBuildResult>;
```

The method namespaces may remain backed by explicit `CAPABILITY_NOT_IMPLEMENTED` fallbacks until their implementation task lands. Once a capability is implemented, its production service wiring and integration test must land before that capability is advertised on the public MCP surface. The lifecycle is `implement → production-wire → integration-test → expose`; `workspace.inspect` establishes this rule in Task 3.

- [x] **Step 5: Run MCP tests/typecheck GREEN**

```bash
pnpm --filter @kodegpt/mcp-server test
pnpm --filter @kodegpt/mcp-server typecheck
```

- [x] **Step 6: Commit**

```bash
git add packages/mcp-server packages/capabilities/package.json pnpm-lock.yaml

git commit -m "refactor(mcp): add typed structured tool results"
```

---

### Task 3: Implement `workspace.inspect`

**Files:**
- Create: `packages/capabilities/src/workspace-inspect.ts`
- Create: `packages/capabilities/src/workspace-inspect.test.ts`
- Create: `packages/capabilities/src/schemas.ts`
- Modify: `packages/capabilities/src/native-capability-service.ts`
- Modify: `packages/capabilities/src/adapters.ts`
- Modify: `packages/protocol/src/runtime-types.ts`
- Modify: `schemas/runtime/request.schema.json`
- Modify: `crates/protocol/src/types.rs`
- Modify: `crates/workspace-io/src/read.rs`, `lib.rs`, `registry.rs`
- Modify: `crates/runtime/src/dispatcher.rs`
- Modify: `packages/core/src/workspace-manager.ts`
- Modify: `packages/mcp-server/package.json`, `tool-context.ts`, `tools.ts`
- Modify: `apps/cli/package.json`, `apps/cli/src/commands/start.ts`
- Modify: focused MCP/protocol/core/Rust tests and production full-stack integration test

**Interfaces:**
- Consumes: `WorkspaceInspectionAdapter.readFile/tree` only.
- Internal bounded tree request: `{ capabilityId, path, maxEntries }`.
- Internal bounded tree result: `{ entries, truncated }`.
- Produces: schema-validated `WorkspaceInspectResult` and production-usable MCP tool `workspace.inspect`.

- [x] **Step 1: Add RED tests for evidence semantics and production usability**

Create tests for:

```text
Node root: package.json + pnpm-workspace.yaml + apps/ + packages/
Rust root: Cargo.toml + crates/
Mixed root: package.json + Cargo.toml
Unknown root: arbitrary src/ files without known manifests
Nested Cargo under Node root: nested manifest remains evidence but does not change root projectTypes
Nested package.json under Cargo root: nested manifest remains evidence but does not change root projectTypes
Scoped nested inspection: the scoped manifest becomes root project evidence
Production service stack: trusted/open workspace → MCP workspace.inspect → structured result
```

Required assertions include:

```ts
expect(result.schemaVersion).toBe(1);
expect(result.projectTypes).toEqual(["node-pnpm", "rust-cargo"]);
expect(result.languages).toContainEqual({ name: "TypeScript", fileCount: 2 });
expect(result.areas).toContainEqual({ path: "packages/core", kind: "package" });
expect(result.entrypoints).toContainEqual({ path: "package.json", kind: "node-manifest" });
```

Ordering must be lexical and repeatable. Root `projectTypes` use only manifests at the inspection root; nested manifests may still appear in `manifests[]`.

- [x] **Step 2: Add RED tests for bounded tree truncation**

Cover the internal tree primitive before changing production code:

```text
exactly N entries with limit N       → truncated=false
N+1 entries with limit N             → truncated=true
requested limit above 2,000          → may return more than 2,000
requested limit above 10,000         → rejected by Rust authority
repeated traversal                   → deterministic lexical ordering
```

Rust owns the hard maximum of `10_000`. Existing ordinary `WorkspaceManager.tree()` keeps a default `2_000` view for callers that do not need a larger bound.

- [x] **Step 3: Implement explicit bounded tree result through Rust → protocol → core**

Do not infer truncation from returned array length. Preserve:

- retained root FD authority;
- `openat2` beneath/no-magiclink/no-cross-boundary behavior;
- symlink non-descent semantics;
- deterministic lexical ordering;
- durable audit decision before OS action;
- no unbounded enumeration.

Expose an internal `WorkspaceManager.treeBounded(workspaceId, path, maxEntries)` returning `{ entries, truncated }`; keep existing `tree()` backward-compatible at the default bound.

- [x] **Step 4: Implement bounded evidence-based inspection**

Recognize only explicit evidence:

- root `package.json` => Node project;
- root `pnpm-workspace.yaml` => pnpm workspace;
- root `Cargo.toml` => Rust/Cargo;
- `apps/*`, `packages/*`, `crates/*`, `tests/*`, `docs/*` => conventional areas;
- known configs (`tsconfig.json`, `vitest.config.*`, `.github/workflows/*`) => config/entrypoint metadata.

Do not recursively read source files. Use bounded reads only for known root manifests when the contents provide deterministic metadata that cannot be obtained from tree evidence alone. Optional malformed/truncated manifest metadata produces bounded warnings rather than guessed architecture.

- [x] **Step 5: Add shared runtime schemas**

`packages/capabilities/src/schemas.ts` owns:

```ts
WorkspaceInspectInputSchema
WorkspaceInspectResultSchema
```

Keep these schemas aligned with the public TypeScript contracts. `workspace.inspect` output must be validated before it becomes MCP `structuredContent`.

- [x] **Step 6: Production-wire before advertising**

Instantiate `NativeCapabilityService` inside the existing `createProductionServiceStack` using the already-created `WorkspaceManager`. Do not create another kernel, workspace manager, execution manager, root FD, or trust authority.

The lifecycle is mandatory:

```text
implemented
→ production-wired
→ E2E-tested
→ advertised
```

The production integration test must prove `workspace.inspect` succeeds and does not return `CAPABILITY_NOT_IMPLEMENTED`.

- [x] **Step 7: Register MCP `workspace.inspect` with shared schemas**

Use:

```ts
inputSchema: WorkspaceInspectInputSchema
outputSchema: WorkspaceInspectResultSchema
annotations: READ_ONLY_TOOL_ANNOTATIONS
```

Retain both JSON text fallback and equivalent `structuredContent`.

- [x] **Step 8: Preserve honest package boundaries and surface tests**

`@kodegpt/mcp-server` must declare `@kodegpt/capabilities: workspace:*` and import capability contracts/schemas from the package entrypoint, not another package's `src/` path. Keep one independent literal MCP surface/version contract test; transport tests may share a fixture to prove parity without duplicating the full surface array.

Keep `MCP_SURFACE_VERSION = "0.2"` only because `workspace.inspect` is production-usable after this task. Do not bump the surface version again merely for each later Phase 1 capability.

- [x] **Step 9: Run focused tests GREEN and commit**

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/mcp-server test
pnpm --filter kodegpt test
pnpm exec vitest run tests/integration/full-stack.test.ts --no-file-parallelism
cargo test -p kodegpt-workspace-io
cargo test -p kodegpt-runtime

git add packages/capabilities packages/mcp-server packages/protocol packages/core apps/cli crates schemas tests pnpm-lock.yaml

git commit -m "fix(capabilities): stabilize workspace inspection contracts"
```

---

### Task 4: Implement Progressive `code.search`

**Files:**
- Create: `packages/capabilities/src/code-search.ts`
- Create: `packages/capabilities/src/code-search.test.ts`
- Modify: `packages/capabilities/src/adapters.ts`, `native-capability-service.ts`, `schemas.ts`, `index.ts`
- Modify: `packages/protocol/src/runtime-types.ts`, `schemas/runtime/request.schema.json`, runtime search fixture
- Modify: `crates/protocol/src/types.rs`
- Modify: `crates/workspace-io/src/read.rs`, `lib.rs`, `registry.rs`
- Modify: `crates/runtime/src/dispatcher.rs`
- Modify: `packages/core/src/workspace-manager.ts` and focused tests
- Modify: `packages/mcp-server/src/tools.ts` and MCP surface/result tests
- Modify: `apps/cli/src/commands/start.ts` and production-stack fixtures
- Modify: `tests/integration/full-stack.test.ts`

**Interfaces:**
- Consumes only `WorkspaceInspectionAdapter.tree` and `CodeSearchAdapter.search`.
- Internal lexical search request: `{ capabilityId, path, query, maxMatches }`.
- Internal lexical search result: `{ matches, truncated }`.
- Produces schema-validated `CodeSearchResult` and production-usable MCP tool `code.search`.

- [x] **Step 1: Write failing tests for all five modes**

Required examples:

```ts
text       => precision "exact"
path       => precision "lexical"
symbol     => precision "heuristic"
definition => precision "heuristic"
reference  => precision "heuristic"
```

Definition heuristics must test at least TypeScript and Rust patterns:

```text
function foo(
class Foo
const foo =
export function foo
fn foo(
struct Foo
trait Foo
```

Symbol/reference classification uses whole-identifier boundaries. References exclude recognized definition lines.

- [x] **Step 2: Add RED tests for honest low-level truncation**

The internal retained-root lexical search must carry an explicit requested match limit and explicit `truncated` bit. Cover:

```text
exactly N lexical matches with limit N       → truncated=false
an additional lexical match beyond limit N   → truncated=true
aggregate snippet ceiling reached             → truncated=true
underlying bounded tree truncated              → truncated=true
requested maxMatches above 500                 → rejected by Rust authority
```

`SEARCH_MAX_MATCHES` is the hard internal maximum `500`, aligned with public `MAX_SEARCH_MAX_RESULTS`. Preserve compatibility by keeping ordinary `WorkspaceManager.search()` at its historical default of `200`; add `searchBounded()` for capability callers.

- [x] **Step 3: Implement bounded search modes**

Use `searchBounded()` for `text`. For `path`, filter the retained-root bounded tree with case-sensitive substring matching. For `symbol`, `definition`, and `reference`, obtain bounded lexical candidate lines first and classify them using deterministic whole-identifier and declaration-prefix checks. Do not recursively reread source files and do not add filesystem/process/Git authority.

Never label heuristic output as exact. `truncated` is true when the low-level result is incomplete or when more classified/path matches exist than the configured `maxResults`; do not infer low-level truncation from array length.

- [x] **Step 4: Add shared runtime schemas**

`packages/capabilities/src/schemas.ts` owns `CodeSearchInputSchema` and `CodeSearchResultSchema`. The input is closed and enforces query length `1..512` and `maxResults <= 500`; the output is closed and validates mode, precision, bounded match metadata, and `truncated`.

- [x] **Step 5: Production-wire before advertising**

Extend the Task 3 `NativeCapabilityService` construction in `createProductionServiceStack` with only a `CodeSearchAdapter` backed by the existing `WorkspaceManager.searchBounded`. Do not create a second service, kernel, workspace manager, or filesystem authority.

Add a full-stack production test proving a trusted/open workspace can call `code.search` through MCP and receive a structured definition result. The lifecycle remains:

```text
implemented
→ production-wired
→ E2E-tested
→ advertised
```

- [x] **Step 6: Register MCP `code.search`**

Use:

```ts
inputSchema: CodeSearchInputSchema
outputSchema: CodeSearchResultSchema
annotations: READ_ONLY_TOOL_ANNOTATIONS
```

Required public fields remain `workspaceId` and `query`; `mode`, `path`, and `maxResults` are optional. Retain equivalent JSON text fallback and `structuredContent`.

Add `code.search` to the locked semantic surface and shared transport fixture. Keep `MCP_SURFACE_VERSION = "0.2"`; Phase 1 capability additions do not independently bump the already-established Phase 1 surface version.

- [x] **Step 7: Run GREEN and commit**

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/mcp-server test
pnpm test:protocol
pnpm exec vitest run tests/integration/full-stack.test.ts --no-file-parallelism
cargo test -p kodegpt-workspace-io
cargo test -p kodegpt-runtime

pnpm test
pnpm typecheck
pnpm build
pnpm verify:forbidden
pnpm verify:package
pnpm test:rust

git add packages/capabilities packages/mcp-server packages/protocol packages/core apps/cli crates schemas tests docs

git commit -m "feat(capabilities): add structured code search"
```

---

### Task 5: Implement `git.changes`

**Files:**
- Create: `packages/capabilities/src/git-changes.ts`
- Create: `packages/capabilities/src/git-changes.test.ts`
- Modify: `packages/capabilities/src/native-capability-service.ts`, `schemas.ts`, `index.ts`
- Modify: `packages/core/src/workspace-manager.ts`
- Modify: `apps/cli/src/commands/start.ts` and focused production-stack fixtures
- Modify: `packages/mcp-server/src/tools.ts` and MCP surface/result tests
- Modify: `tests/capabilities/contracts.test.ts`, `tests/fixtures/mcp-surface.ts`, `tests/integration/full-stack.test.ts`

**Interfaces:**
- Consumes only existing hardened `GitInspectionAdapter.gitStatus` / `gitDiff` results.
- No filesystem, process, shell, network, or new Git-execution authority is added to the capability layer.
- Produces compact normalized change state + deterministic SHA-256 fingerprint.

- [x] **Step 1: Add failing parser/fingerprint tests**

Use porcelain-v1 fixtures covering modified, added, deleted, renamed, staged-only, worktree-only, both-side modification, untracked, and clean states. Cover rename/copy destination normalization from either XY position and Git C-quoted UTF-8 path decoding. Assert two semantically identical normalized states produce the same fingerprint even if input line order differs.

- [x] **Step 2: Run RED**

```bash
pnpm --filter @kodegpt/capabilities test -- git-changes
```

- [x] **Step 3: Implement deterministic normalization**

Use Node `createHash("sha256")` only as a pure computation dependency. Normalize status paths first, then sort with deterministic bytewise/string ordering rather than locale-dependent ordering:

```ts
const normalized = {
  changedPaths: [...changedPaths].sort(compareChangedPath),
  ...(includePatch ? { patchPreview: boundedPatch } : {}),
  sourceTruncated
};
```

`includePatch=false` must not invoke `gitDiff`. `includePatch=true` may return the already-bounded diff preview plus opaque artifact metadata from the hardened Git result. If status or requested patch output is truncated, propagate `truncated: true`; if status is truncated, never claim `clean: true` even when no visible changed path survived the preview.

- [x] **Step 4: Add shared runtime schemas**

`packages/capabilities/src/schemas.ts` owns closed `GitChangesInputSchema` / `GitChangesResultSchema`. Validate the optional patch artifact, one-character XY status fields, non-negative summary values, and lowercase 64-hex SHA-256 fingerprint.

- [x] **Step 5: Production-wire before advertising**

Extend the existing `NativeCapabilityService` construction with a narrow `GitInspectionAdapter` backed by the same `WorkspaceManager.gitStatus/gitDiff`. Do not create another manager or Git executor.

Add a direct production-stack test that captures `toolContext` and proves `toolContext.git.changes()` works before public registration. Keep `WorkspaceGitInspectionResult.schemaVersion` narrowed to literal `1`, matching the runtime validator and capability adapter contract.

- [x] **Step 6: Register MCP `git.changes`**

Use:

```ts
inputSchema: GitChangesInputSchema
outputSchema: GitChangesResultSchema
annotations: READ_ONLY_TOOL_ANNOTATIONS
```

Required public field remains `workspaceId`; `includePatch` is optional. Preserve equivalent JSON text fallback and `structuredContent`. Add `git.changes` to the locked semantic surface and shared transport fixture. Keep `MCP_SURFACE_VERSION = "0.2"` for this Phase 1 capability addition.

- [x] **Step 7: Add full-stack checkpoint coverage**

On a trusted/open temporary Git workspace containing staged, worktree, and untracked changes, call `git.changes(includePatch:true)` through MCP and assert normalized changed paths, SHA-256 fingerprint, bounded patch preview/artifact, structured/text parity, and absence of host absolute paths.

- [x] **Step 8: Run GREEN and commit**

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/mcp-server test
pnpm --filter kodegpt test
pnpm exec vitest run tests/integration/full-stack.test.ts --no-file-parallelism

pnpm test
pnpm typecheck
pnpm build
pnpm verify:forbidden
pnpm verify:package
pnpm test:rust

git add packages/capabilities packages/core packages/mcp-server apps/cli tests docs

git commit -m "feat(capabilities): add git change checkpoints"
```

---

### Task 6: Implement Safe Verification Recipes

**Files:**
- Create: `packages/capabilities/src/verification.ts`
- Create: `packages/capabilities/src/verification.test.ts`
- Modify: `packages/capabilities/src/adapters.ts`, `native-capability-service.ts`, `schemas.ts`, `index.ts`
- Modify: `packages/core/src/workspace-manager.ts`
- Modify: `packages/mcp-server/src/tools.ts` and MCP surface/result tests
- Modify: `apps/cli/src/commands/start.ts` and production-stack fixtures
- Modify: `tests/capabilities/contracts.test.ts`, `tests/fixtures/mcp-surface.ts`, `tests/integration/full-stack.test.ts`

**Interfaces:**
- Consumes only bounded manifest tree/read access, the current effective `allowProcess` + executable allowlist, and existing `CapabilityExecutionAdapter.run`.
- Produces schema-validated `verify.list` and `verify.run`.
- No shell parser, arbitrary executable/argv input, filesystem authority, or second execution path is introduced.

- [x] **Step 1: Write failing discovery tests**

Package discovery recognizes only fixed script names `test`, `lint`, `typecheck`, and `build`. The script body is metadata only and is never parsed as a command. Each discovered package recipe resolves to:

```text
logicalExecutable = pnpm
argv              = ["run", <script>]
cwd               = "."
source             = package-script
```

Cargo root evidence produces the fixed recipes:

```text
cargo:test       => cargo test --workspace
cargo:check      => cargo check --workspace
cargo:fmt-check  => cargo fmt --all -- --check
```

Discovery reads root `package.json` with a 64 KiB ceiling and uses a bounded root tree with a 10,000-entry ceiling. Because `VerifyListResult` v1 has no partial-result marker, a truncated manifest tree or truncated package manifest read fails closed rather than claiming the recipe set is complete.

- [x] **Step 2: Prove discovery executes nothing**

Use an execution adapter that throws if invoked. `listVerifications()` must still succeed. Manifest discovery must not run package-manager lifecycle scripts.

- [x] **Step 3: Implement policy compatibility**

A recipe is `allowed: true` only when both conditions hold:

```text
effectivePolicy.allowProcess === true
logical executable ∈ effectivePolicy.allowedExecutableNames
```

Use `blockedReason: "PROCESS_NOT_ALLOWED"` when process authority is disabled and `blockedReason: "EXECUTABLE_NOT_ALLOWED"` when the logical executable is absent from the allowlist. This distinction matters because a narrowed profile may retain executable names while disabling process authority.

- [x] **Step 4: Implement `runVerification` with recipe re-resolution**

Required flow:

```text
list current recipes
→ find recipeId
→ re-check current allowProcess + executable allowlist
→ call execution.run with the recipe's stored logicalExecutable/argv/cwd
```

`VerifyRunInput` contains only `workspaceId`, `recipeId`, and optional `background`; there is no client-provided executable, argv, cwd, environment, or network override.

- [x] **Step 5: Add shared runtime schemas**

`packages/capabilities/src/schemas.ts` owns closed `VerifyListInputSchema`, `VerifyListResultSchema`, `VerifyRunInputSchema`, and `VerifyRunResultSchema`. Validate recipe metadata and the complete verification operation/artifact shape, including literal `schemaVersion: 1`.

- [x] **Step 6: Extend the existing production capability service before advertising**

Extend the Task 3–5 `NativeCapabilityService` instance in `createProductionServiceStack` with:

```text
verificationWorkspace.readFile       -> existing WorkspaceManager.readFile
verificationWorkspace.tree           -> existing WorkspaceManager.treeBounded
verificationWorkspace.effectivePolicy-> existing WorkspaceManager.requireReady(...).effectivePolicy
execution.run                         -> existing WorkspaceManager.runProcess
```

Do not create a second service, kernel, workspace manager, or execution manager. Narrow `WorkspaceProcessOperationResult.schemaVersion` to literal `1`, matching its existing runtime validator.

Production-stack tests must prove both discovery and execution mapping. `verify.run` must pass exactly the stored recipe executable/argv/cwd to the existing process authority.

- [x] **Step 7: Register MCP tools**

Use shared schemas and structured/text parity:

```text
verify.list -> READ_ONLY_TOOL_ANNOTATIONS
verify.run  -> PROCESS_RUN_TOOL_ANNOTATIONS
```

Add both tools to the locked semantic surface and shared transport fixture. Keep `MCP_SURFACE_VERSION = "0.2"` for this Phase 1 capability addition.

- [x] **Step 8: Add full-stack discovery coverage and preserve host executable trust**

The full-stack temporary workspace must prove `verify.list` works through real MCP and reports a policy-compatible package recipe without exposing host paths.

Do not weaken Rust trusted-executable rules to make host-local package-manager installations runnable. On the current development host, `pnpm` resolves under the user's NVM directory rather than the fixed root-owned executable directories, so real-host `verify.run(package:test)` correctly fails the existing trusted-executable boundary. Production `verify.run` correctness is instead covered at the service/manager boundary; installations with a trusted package-manager executable can use the same runtime path unchanged.

- [x] **Step 9: Run GREEN and commit**

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/mcp-server test
pnpm --filter kodegpt test
pnpm exec vitest run tests/integration/full-stack.test.ts --no-file-parallelism

pnpm test
pnpm typecheck
pnpm build
pnpm verify:forbidden
pnpm verify:package
pnpm test:rust

git add packages/capabilities packages/core packages/mcp-server apps/cli tests docs

git commit -m "feat(capabilities): add safe verification recipes"
```

> **Hardening reconciliation (2026-08-12):** Tasks 4–6 above are complete, but the original implementation history did not contain every final hardening property now enforced. The authoritative follow-up design and execution record are:
> - spec: `docs/superpowers/specs/2026-08-11-kodegpt-native-capability-layer-hardening-design.md`
> - plan: `docs/superpowers/plans/2026-08-11-kodegpt-native-capability-layer-hardening.md`
>
> In particular, the follow-up hardening makes search incompleteness explicit, replaces preview-derived Git identity with a content-sensitive structured checkpoint, and makes verification discovery/launch eligibility deterministic and semantically audited. This note records the later reconciliation without rewriting what the original task commits contained.

---

### Task 7: Add Conditional Per-File Patch Commit to Rust Authority

**Files:**
- Modify: `packages/protocol/src/runtime-types.ts`
- Modify: `schemas/runtime/request.schema.json`
- Modify: `crates/protocol/src/types.rs`, `lib.rs`, and protocol contract fixtures/tests
- Modify: `crates/workspace-io/src/write.rs`, `registry.rs`, `lib.rs`
- Modify: `crates/runtime/src/dispatcher.rs`, `audit.rs`
- Modify: `packages/core/src/workspace-manager.ts`, `workspace-manager.test.ts`
- Add: `tests/fixtures/runtime/file.commit_patch_file.json`
- Add focused Rust tests beside existing write/dispatcher tests.

**Interfaces:**
- Produces internal RPC `file.commit_patch_file`; it is not an MCP tool.
- Consumed by Task 8 patch orchestration.

- [x] **Step 1: Add protocol RED tests for the new method**

Add runtime method:

```text
file.commit_patch_file
```

Request logical shape:

```ts
{
  capabilityId: string;
  path: string;
  action: "create" | "update" | "delete";
  expectedSha256: string | null;
  content: string | null;
}
```

Rules:

```text
create: expectedSha256=null, content=string, path must not exist
update: expectedSha256=<64 lowercase hex>, content=string, path must exist and match
 delete: expectedSha256=<64 lowercase hex>, content=null, path must exist and match
```

Response:

```ts
{
  schemaVersion: 1,
  action: "create" | "update" | "delete",
  bytesWritten: number,
  sha256: string | null
}
```

- [x] **Step 2: Run protocol/Rust RED**

```bash
pnpm test:protocol
cargo test -p kodegpt-protocol
cargo test -p kodegpt-workspace-io
cargo test -p kodegpt-runtime
```

- [x] **Step 3: Implement workspace-io compare-and-swap commit**

In `write.rs`, reuse retained-root/openat helpers. The final implementation performs a fresh regular-file/UTF-8 read, SHA-256 comparison, and device/inode revalidation before mutation. A stale digest returns `PATCH_PRECONDITION_FAILED` before touching the target.

For `update`, write the post-image to a temporary sibling, preserve the existing mode, fsync, revalidate the target again, and atomically rename the sibling over the target. For `delete`, revalidate and unlink the matched target without creating a temporary file. For `create`, write a temporary sibling and use kernel no-clobber rename semantics (`RENAME_NOREPLACE`) so a concurrently appearing destination becomes `PATCH_TARGET_EXISTS` rather than being overwritten.

The digest is not secret; exact equality is sufficient. None of these internal checks expose inode values or host paths through the public response.

- [x] **Step 4: Preserve audit-before-action in runtime dispatcher**

Add decision audit before commit and outcome audit after it, following existing `file.write` / `file.edit` patterns. Map stale/missing/existing conflicts to stable non-host-leaking codes.

- [x] **Step 5: Expose typed `WorkspaceManager.commitPatchFile`**

Signature:

```ts
commitPatchFile(input: {
  workspaceId: string;
  path: string;
  action: "create" | "update" | "delete";
  expectedSha256: string | null;
  content: string | null;
}): Promise<{
  schemaVersion: 1;
  action: "create" | "update" | "delete";
  bytesWritten: number;
  sha256: string | null;
}>;
```

Validate every runtime field before returning.

- [x] **Step 6: Add stale-content/security tests**

Required cases:

```text
update matching digest => succeeds
update stale digest => no write
create existing path => no overwrite
delete stale digest => no deletion
traversal/symlink escape => existing workspace boundary rejects
observe/read-only policy => mutation rejected before OS write
```

- [x] **Step 7: Run GREEN and commit**

```bash
pnpm test:protocol
cargo test -p kodegpt-workspace-io
cargo test -p kodegpt-runtime
pnpm --filter @kodegpt/core test

git add packages/protocol crates/protocol crates/workspace-io crates/runtime packages/core

git commit -m "feat(runtime): add conditional patch file commit"
```

---

### Task 8: Implement Unified `file.patch`

**Files:**
- Create: `packages/capabilities/src/patch.ts`, `patch.test.ts`
- Modify: capability adapters/contracts/schemas/service/index/test-support and public contract tests
- Modify: `packages/mcp-server/src/tools.ts`, surface/result tests, and shared surface fixture
- Modify: `apps/cli/src/commands/start.ts` plus production-stack/bridge fixtures

**Interfaces:**
- Consumes: existing bounded `readFile`, retained-root `pathIdentity`, and conditional `commitPatchFile` authority from the same `WorkspaceManager`.
- Produces: `file.patch` with `check|apply` modes.

- [x] **Step 1: Write failing parser tests**

Support standard text unified patches for:

```text
modify existing file
a/add via --- /dev/null +++ b/path
delete via --- a/path +++ /dev/null
multiple files
multiple hunks
```

Reject:

```text
absolute paths
../ traversal
binary patch markers
rename/copy metadata in v1
more than 1 MiB input
more than 64 files
more than 256 hunks
malformed hunk ranges
hunks whose context/removal text does not match current content
```

- [x] **Step 2: Run RED**

```bash
pnpm --filter @kodegpt/capabilities test -- patch
```

- [x] **Step 3: Implement full preflight**

For every file before the first commit:

```text
parse path/action
→ inspect retained-root path identity
→ for create: require the target to be absent
→ for update/delete: require a regular file and a complete bounded read
→ SHA-256 current bytes
→ apply hunks in memory
→ collect {path, action, expectedSha256, postImage}
```

A truncated/oversized existing-file read, create-existing target, missing/non-file update/delete target, or hunk mismatch fails closed as `PATCH_PRECONDITION_FAILED`. Full preflight completes for all files before the first commit call.

- [x] **Step 4: Implement `check` and `apply`**

`check` returns planned file summaries and never calls `commitPatchFile`.

`apply` commits in lexical path order. On first commit failure:

```ts
throw new CapabilityError("PATCH_COMMIT_INCOMPLETE", ..., {
  committedPaths,
  failedPath
});
```

Do not attempt to hide partial commit state or claim rollback.

- [x] **Step 5: Register MCP `file.patch`**

Schema:

```ts
{
  workspaceId: z.string().min(1),
  patch: z.string().min(1).max(1024 * 1024),
  mode: z.enum(["check", "apply"]).optional()
}
```

Use mutating-file annotations because the tool can mutate when explicitly requested. The final v1 behavior defaults omitted `mode` to `check`; mutation requires explicit `mode: "apply"`.

- [x] **Step 6: Run GREEN and commit**

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/mcp-server test
pnpm test:security

git add packages/capabilities packages/mcp-server tests/security

git commit -m "feat(capabilities): add bounded unified file patches"
```

---

### Task 9: Implement Deterministic `context.build`

**Files:**
- Create: `packages/capabilities/src/context-build.ts`, `context-build.test.ts`
- Modify: capability service/schemas/index/contracts tests
- Modify: `packages/mcp-server/src/tools.ts`, surface/result tests, and shared surface fixture
- Modify: `apps/cli/src/commands/start.test.ts` for production-stack wiring evidence

**Interfaces:**
- Consumes: already implemented inspect/search/git/verify/read capabilities through the existing `NativeCapabilityService`/workspace adapter.
- Produces: bounded deterministic context bundle without inference, prompts, filesystem authority, or model calls.

- [x] **Step 1: Write failing selection/budget tests**

For target `packages/core/src/workspace-manager.ts`, assert deterministic priority:

```text
1. exact target file
2. changed files in same area
3. manifest/config governing target area
4. exact search hits for target basename/symbol
5. nearby tests
```

Assert `totalBytes <= maxBytes` and later candidates are omitted with `truncated: true` when the budget is exhausted.

- [x] **Step 2: Run RED**

```bash
pnpm --filter @kodegpt/capabilities test -- context-build
```

- [x] **Step 3: Implement intent-specific deterministic rules**

Rules must be explicit tables, not model prompts. Example:

```ts
const INTENT_WEIGHTS = {
  understand: { target: 100, changed: 40, tests: 20, config: 50 },
  implement:  { target: 100, changed: 60, tests: 70, config: 50 },
  debug:      { target: 100, changed: 80, tests: 80, config: 40 },
  review:     { target: 80,  changed: 100, tests: 60, config: 40 },
  verify:     { target: 60,  changed: 80, tests: 100, config: 60 }
} as const;
```

The final composer keeps the Step 1 priority tiers as the primary ordering and applies intent weights as a deterministic secondary score; search evidence has its own explicit bounded secondary weight. This prevents a high review/test weight from displacing the exact target tier while still keeping intent rules explicit and inspectable. Stable tie-breaker: lexical path order.

- [x] **Step 4: Register MCP `context.build`**

Schema:

```ts
{
  workspaceId: z.string().min(1),
  intent: z.enum(["understand", "implement", "debug", "review", "verify"]),
  target: z.string().min(1).optional(),
  maxBytes: z.number().int().positive().max(1024 * 1024).optional()
}
```

Annotations: read-only.

- [x] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/mcp-server test

git add packages/capabilities packages/mcp-server

git commit -m "feat(capabilities): add deterministic context builder"
```

---

### Task 10: Surface Version, Documentation, and Full Regression Gate

**Files:**
- Verify: `packages/mcp-server/src/surface-version.ts`, `index.ts`, and locked surface tests/fixtures
- Modify: `docs/compatibility/chatgpt.md`, `docs/release/v0.1-checklist.md`, and this execution plan
- Modify: `tests/security/security-invariants.test.ts`
- Modify: `tests/integration/full-stack.test.ts`
- Normalize: canonical `cargo fmt` output across Rust files touched by the hardening series

**Interfaces:**
- Produces: stable released native capability surface.

- [x] **Step 1: Add failing surface-security assertions**

Assert the public tool inventory contains:

```text
workspace.inspect
code.search
git.changes
verify.list
verify.run
file.patch
context.build
```

Assert it still does **not** contain:

```text
workspace.trust
shell.run
codex.run
codex.exec
skill.run
```

- [x] **Step 2: Advance MCP surface version once**

Change the v0.1 public surface constant to the next explicit version (recommended `0.2`) and update tests that pin the prior value.

Do not change MCP protocol version solely for tool-surface additions.

> **Execution reconciliation (2026-08-12):** the public surface had already been advanced to `0.2` while Tasks 4–9 were incrementally advertised and all transport/surface tests pin that value. Task 10 therefore preserves `MCP_SURFACE_VERSION = "0.2"`; bumping again to `0.3` would misrepresent the intended single Phase 1 surface-version advance. The MCP protocol version remains unchanged.

- [x] **Step 3: Document capability semantics**

`docs/compatibility/chatgpt.md` must explain:

- GPT Web remains the reasoning actor;
- `workspace.inspect` and `context.build` reduce primitive round trips;
- `code.search` reports heuristic precision honestly;
- `verify.run` uses named recipes, not arbitrary shell;
- `file.patch` performs full preflight + per-file conditional commit and may report partial commit if a commit-phase host failure occurs.

- [x] **Step 4: Run the complete project verification**

Run in this order:

```bash
pnpm typecheck
pnpm test
pnpm test:protocol
pnpm test:integration
pnpm test:security
pnpm test:isolation
pnpm test:acceptance
pnpm verify:forbidden
pnpm build
cargo test --workspace
pnpm verify:package
```

Every command must exit 0. A host-only mandatory sandbox/AppArmor gate must be run in the same environment used for existing release-candidate validation when the generic CI/container environment cannot represent it.

- [x] **Step 5: Inspect the final diff for invariant violations**

Run:

```bash
git diff --check
git grep -nE 'codex exec|spawn\([^)]*codex|exec\([^)]*codex|shell:[[:space:]]*true' -- . ':!docs/**'
```

Expected: no new runtime Codex execution and no shell enablement.

- [x] **Step 6: Commit**

```bash
git add packages apps crates tests docs pnpm-lock.yaml Cargo.lock

git commit -m "feat: ship native capability hub surface"
```

---

## Self-Review Checklist

Before execution begins, verify the plan against the approved design:

- Typed result contracts: Task 1–2.
- Structured MCP content: Task 2.
- `workspace.inspect`: Task 3.
- progressive honest `code.search`: Task 4.
- `git.changes`: Task 5.
- safe named verification recipes: Task 6.
- Rust CAS authority for stale-safe patching: Task 7.
- multi-file unified `file.patch`: Task 8.
- deterministic `context.build`: Task 9.
- surface/security/docs/full regression: Task 10.
- No Codex execution, no autonomous agent, no shell shortcut: Global Constraints + Task 10.

No provider gateway or skill interoperability code belongs in this plan; those are separate phases.
