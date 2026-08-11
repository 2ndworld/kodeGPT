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

- [ ] **Step 1: Add the package skeleton and failing contract test**

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

- [ ] **Step 2: Run the package test and verify RED**

Run:

```bash
pnpm --filter @kodegpt/capabilities test
```

Expected: FAIL because `contracts.ts` exports do not exist.

- [ ] **Step 3: Define the public contracts and bounds**

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

- [ ] **Step 4: Define narrow authority-specific adapters rather than depending on concrete managers**

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

- [ ] **Step 5: Add the service skeleton**

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

- [ ] **Step 6: Run package typecheck/test GREEN**

```bash
pnpm --filter @kodegpt/capabilities typecheck
pnpm --filter @kodegpt/capabilities test
```

Expected: PASS.

- [ ] **Step 7: Commit**

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

- [ ] **Step 1: Add a failing structured-result parity test**

Test one existing deterministic tool such as `workspace.list` and assert both channels contain equivalent data:

```ts
expect(result.structuredContent).toEqual([{ id: "ws_1" }]);
expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
```

Also add a compile-time fixture assigning a real typed workspace result to `WorkspaceToolContext.list` without `unknown` casts.

- [ ] **Step 2: Run MCP tests RED**

```bash
pnpm --filter @kodegpt/mcp-server test
```

Expected: structured result test fails because generic tools currently return only `content`.

- [ ] **Step 3: Add the capability dependency and common result helper**

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

- [ ] **Step 4: Replace `Promise<unknown>` context signatures with explicit result types**

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

- [ ] **Step 5: Run MCP tests/typecheck GREEN**

```bash
pnpm --filter @kodegpt/mcp-server test
pnpm --filter @kodegpt/mcp-server typecheck
```

- [ ] **Step 6: Commit**

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

- [ ] **Step 1: Add RED tests for evidence semantics and production usability**

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

- [ ] **Step 2: Add RED tests for bounded tree truncation**

Cover the internal tree primitive before changing production code:

```text
exactly N entries with limit N       → truncated=false
N+1 entries with limit N             → truncated=true
requested limit above 2,000          → may return more than 2,000
requested limit above 10,000         → rejected by Rust authority
repeated traversal                   → deterministic lexical ordering
```

Rust owns the hard maximum of `10_000`. Existing ordinary `WorkspaceManager.tree()` keeps a default `2_000` view for callers that do not need a larger bound.

- [ ] **Step 3: Implement explicit bounded tree result through Rust → protocol → core**

Do not infer truncation from returned array length. Preserve:

- retained root FD authority;
- `openat2` beneath/no-magiclink/no-cross-boundary behavior;
- symlink non-descent semantics;
- deterministic lexical ordering;
- durable audit decision before OS action;
- no unbounded enumeration.

Expose an internal `WorkspaceManager.treeBounded(workspaceId, path, maxEntries)` returning `{ entries, truncated }`; keep existing `tree()` backward-compatible at the default bound.

- [ ] **Step 4: Implement bounded evidence-based inspection**

Recognize only explicit evidence:

- root `package.json` => Node project;
- root `pnpm-workspace.yaml` => pnpm workspace;
- root `Cargo.toml` => Rust/Cargo;
- `apps/*`, `packages/*`, `crates/*`, `tests/*`, `docs/*` => conventional areas;
- known configs (`tsconfig.json`, `vitest.config.*`, `.github/workflows/*`) => config/entrypoint metadata.

Do not recursively read source files. Use bounded reads only for known root manifests when the contents provide deterministic metadata that cannot be obtained from tree evidence alone. Optional malformed/truncated manifest metadata produces bounded warnings rather than guessed architecture.

- [ ] **Step 5: Add shared runtime schemas**

`packages/capabilities/src/schemas.ts` owns:

```ts
WorkspaceInspectInputSchema
WorkspaceInspectResultSchema
```

Keep these schemas aligned with the public TypeScript contracts. `workspace.inspect` output must be validated before it becomes MCP `structuredContent`.

- [ ] **Step 6: Production-wire before advertising**

Instantiate `NativeCapabilityService` inside the existing `createProductionServiceStack` using the already-created `WorkspaceManager`. Do not create another kernel, workspace manager, execution manager, root FD, or trust authority.

The lifecycle is mandatory:

```text
implemented
→ production-wired
→ E2E-tested
→ advertised
```

The production integration test must prove `workspace.inspect` succeeds and does not return `CAPABILITY_NOT_IMPLEMENTED`.

- [ ] **Step 7: Register MCP `workspace.inspect` with shared schemas**

Use:

```ts
inputSchema: WorkspaceInspectInputSchema
outputSchema: WorkspaceInspectResultSchema
annotations: READ_ONLY_TOOL_ANNOTATIONS
```

Retain both JSON text fallback and equivalent `structuredContent`.

- [ ] **Step 8: Preserve honest package boundaries and surface tests**

`@kodegpt/mcp-server` must declare `@kodegpt/capabilities: workspace:*` and import capability contracts/schemas from the package entrypoint, not another package's `src/` path. Keep one independent literal MCP surface/version contract test; transport tests may share a fixture to prove parity without duplicating the full surface array.

Keep `MCP_SURFACE_VERSION = "0.2"` only because `workspace.inspect` is production-usable after this task. Do not bump the surface version again merely for each later Phase 1 capability.

- [ ] **Step 9: Run focused tests GREEN and commit**

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

- [ ] **Step 1: Write failing tests for all five modes**

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

- [ ] **Step 2: Add RED tests for honest low-level truncation**

The internal retained-root lexical search must carry an explicit requested match limit and explicit `truncated` bit. Cover:

```text
exactly N lexical matches with limit N       → truncated=false
an additional lexical match beyond limit N   → truncated=true
aggregate snippet ceiling reached             → truncated=true
underlying bounded tree truncated              → truncated=true
requested maxMatches above 500                 → rejected by Rust authority
```

`SEARCH_MAX_MATCHES` is the hard internal maximum `500`, aligned with public `MAX_SEARCH_MAX_RESULTS`. Preserve compatibility by keeping ordinary `WorkspaceManager.search()` at its historical default of `200`; add `searchBounded()` for capability callers.

- [ ] **Step 3: Implement bounded search modes**

Use `searchBounded()` for `text`. For `path`, filter the retained-root bounded tree with case-sensitive substring matching. For `symbol`, `definition`, and `reference`, obtain bounded lexical candidate lines first and classify them using deterministic whole-identifier and declaration-prefix checks. Do not recursively reread source files and do not add filesystem/process/Git authority.

Never label heuristic output as exact. `truncated` is true when the low-level result is incomplete or when more classified/path matches exist than the configured `maxResults`; do not infer low-level truncation from array length.

- [ ] **Step 4: Add shared runtime schemas**

`packages/capabilities/src/schemas.ts` owns `CodeSearchInputSchema` and `CodeSearchResultSchema`. The input is closed and enforces query length `1..512` and `maxResults <= 500`; the output is closed and validates mode, precision, bounded match metadata, and `truncated`.

- [ ] **Step 5: Production-wire before advertising**

Extend the Task 3 `NativeCapabilityService` construction in `createProductionServiceStack` with only a `CodeSearchAdapter` backed by the existing `WorkspaceManager.searchBounded`. Do not create a second service, kernel, workspace manager, or filesystem authority.

Add a full-stack production test proving a trusted/open workspace can call `code.search` through MCP and receive a structured definition result. The lifecycle remains:

```text
implemented
→ production-wired
→ E2E-tested
→ advertised
```

- [ ] **Step 6: Register MCP `code.search`**

Use:

```ts
inputSchema: CodeSearchInputSchema
outputSchema: CodeSearchResultSchema
annotations: READ_ONLY_TOOL_ANNOTATIONS
```

Required public fields remain `workspaceId` and `query`; `mode`, `path`, and `maxResults` are optional. Retain equivalent JSON text fallback and `structuredContent`.

Add `code.search` to the locked semantic surface and shared transport fixture. Keep `MCP_SURFACE_VERSION = "0.2"`; Phase 1 capability additions do not independently bump the already-established Phase 1 surface version.

- [ ] **Step 7: Run GREEN and commit**

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
- Modify: `packages/capabilities/src/native-capability-service.ts`
- Modify: `packages/mcp-server/src/tools.ts`

**Interfaces:**
- Consumes: existing hardened `gitStatus` / `gitDiff` results.
- Produces: compact normalized change state + SHA-256 fingerprint.

- [ ] **Step 1: Add failing parser/fingerprint tests**

Use porcelain fixtures covering modified, added, deleted, renamed, staged-only, worktree-only, and clean states. Assert two semantically identical normalized states produce the same fingerprint even if input line order differs.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @kodegpt/capabilities test -- git-changes
```

- [ ] **Step 3: Implement normalization**

Use Node `createHash("sha256")` over stable JSON:

```ts
const normalized = {
  changedPaths: [...changedPaths].sort((a, b) => a.path.localeCompare(b.path)),
  patchPreview: includePatch ? boundedPatch : undefined,
  sourceTruncated
};
```

If existing Git output is truncated, propagate `truncated: true`; do not claim a complete changed-path set.

- [ ] **Step 4: Register MCP `git.changes`**

Input:

```ts
{
  workspaceId: z.string().min(1),
  includePatch: z.boolean().optional()
}
```

Annotations: read-only.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/mcp-server test

git add packages/capabilities packages/mcp-server

git commit -m "feat(capabilities): add git change checkpoints"
```

---

### Task 6: Implement Safe Verification Recipes

**Files:**
- Create: `packages/capabilities/src/verification.ts`
- Create: `packages/capabilities/src/verification.test.ts`
- Modify: `packages/capabilities/src/native-capability-service.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `apps/cli/src/commands/start.ts`
- Modify: `apps/cli/package.json`

**Interfaces:**
- Consumes: workspace manifest reads + effective policy + `CapabilityExecutionAdapter.run`.
- Produces: `verify.list`, `verify.run`.

- [ ] **Step 1: Write failing discovery tests**

Fixture `package.json`:

```json
{
  "scripts": {
    "test": "vitest run",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "build": "tsc -p tsconfig.json"
  }
}
```

Expected recipe IDs:

```text
package:test
package:lint
package:typecheck
package:build
```

Each package recipe resolves to `logicalExecutable: "pnpm"`, `argv: ["run", <script>]`, `cwd: "."`.

Cargo fixture produces at least:

```text
cargo:test       => cargo test --workspace
cargo:check      => cargo check --workspace
cargo:fmt-check  => cargo fmt --all -- --check
```

- [ ] **Step 2: Prove discovery executes nothing**

Use a fake execution adapter that throws if called. `listVerifications()` must pass without invoking it.

- [ ] **Step 3: Implement policy compatibility**

Read `effectivePolicy.allowedExecutableNames`. A recipe is `allowed: true` only when its logical executable is in that list. Return `blockedReason: "EXECUTABLE_NOT_ALLOWED"` otherwise.

Do not use shell parsing of script bodies. The script body is metadata only; execution is performed via package manager argv.

- [ ] **Step 4: Implement `runVerification` with recipe re-resolution**

Required flow:

```text
list current recipes
→ find recipeId
→ re-check allowed
→ call execution.run with stored logicalExecutable/argv/cwd
```

Input contains no arbitrary executable or argv override.

- [ ] **Step 5: Register MCP tools**

`verify.list`: read-only annotations.

`verify.run`: use process-run-equivalent annotations (`readOnlyHint: false`, open-world consistent with process execution).

- [ ] **Step 6: Extend the existing production capability service for verification authority**

Task 3 already establishes `NativeCapabilityService` production wiring in `createProductionServiceStack` using the existing workspace manager. Extend that same service construction with the verification-specific workspace policy/manifest and `CapabilityExecutionAdapter` dependencies required by Task 6. Do not create a second capability service, kernel, workspace manager, or execution manager, and do not defer production usability until after the MCP tools are advertised.

- [ ] **Step 7: Run GREEN and commit**

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/mcp-server test
pnpm --filter @kodegpt/cli test

git add packages/capabilities packages/mcp-server apps/cli pnpm-lock.yaml

git commit -m "feat(capabilities): add safe verification recipes"
```

---

### Task 7: Add Conditional Per-File Patch Commit to Rust Authority

**Files:**
- Modify: `packages/protocol/src/types.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `crates/protocol/src/types.rs`
- Modify: `crates/workspace-io/src/write.rs`
- Modify: `crates/workspace-io/src/lib.rs`
- Modify: `crates/runtime/src/dispatcher.rs`
- Modify: `packages/core/src/workspace-manager.ts`
- Modify: `packages/core/src/workspace-manager.test.ts`
- Add focused Rust tests beside existing write/dispatcher tests.

**Interfaces:**
- Produces internal RPC `file.commit_patch_file`; it is not an MCP tool.
- Consumed by Task 8 patch orchestration.

- [ ] **Step 1: Add protocol RED tests for the new method**

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

- [ ] **Step 2: Run protocol/Rust RED**

```bash
pnpm test:protocol
cargo test -p kodegpt-protocol
cargo test -p kodegpt-workspace-io
cargo test -p kodegpt-runtime
```

- [ ] **Step 3: Implement workspace-io compare-and-swap commit**

In `write.rs`, reuse retained-root/openat helpers. Required sequence for update/delete:

```text
open current file beneath retained root
→ reject non-regular/non-UTF8 where existing file APIs would reject
→ SHA-256 current bytes
→ constant-time equality is not required (digest is not secret), exact compare is sufficient
→ if mismatch return PATCH_PRECONDITION_FAILED before mutation
→ create temporary sibling using existing safe-write pattern
→ fsync temp when existing write contract does so
→ rename atomically for create/update, or unlink for delete after precondition
```

Create must use no-clobber semantics and fail if the destination appears.

- [ ] **Step 4: Preserve audit-before-action in runtime dispatcher**

Add decision audit before commit and outcome audit after it, following existing `file.write` / `file.edit` patterns. Map stale/missing/existing conflicts to stable non-host-leaking codes.

- [ ] **Step 5: Expose typed `WorkspaceManager.commitPatchFile`**

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

- [ ] **Step 6: Add stale-content/security tests**

Required cases:

```text
update matching digest => succeeds
update stale digest => no write
create existing path => no overwrite
delete stale digest => no deletion
traversal/symlink escape => existing workspace boundary rejects
observe/read-only policy => mutation rejected before OS write
```

- [ ] **Step 7: Run GREEN and commit**

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
- Create: `packages/capabilities/src/patch.ts`
- Create: `packages/capabilities/src/patch.test.ts`
- Modify: `packages/capabilities/src/native-capability-service.ts`
- Modify: `packages/mcp-server/src/tools.ts`

**Interfaces:**
- Consumes: `readFile` + `commitPatchFile`.
- Produces: `file.patch` with `check|apply` modes.

- [ ] **Step 1: Write failing parser tests**

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

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @kodegpt/capabilities test -- patch
```

- [ ] **Step 3: Implement full preflight**

For every file before the first commit:

```text
parse path/action
→ read current content when action != create
→ SHA-256 current bytes
→ apply hunks in memory
→ collect {path, action, expectedSha256, postImage}
```

If any precondition fails, return/throw `PATCH_PRECONDITION_FAILED` and perform zero commit calls.

- [ ] **Step 4: Implement `check` and `apply`**

`check` returns planned file summaries and never calls `commitPatchFile`.

`apply` commits in lexical path order. On first commit failure:

```ts
throw new CapabilityError("PATCH_COMMIT_INCOMPLETE", ..., {
  committedPaths,
  failedPath
});
```

Do not attempt to hide partial commit state or claim rollback.

- [ ] **Step 5: Register MCP `file.patch`**

Schema:

```ts
{
  workspaceId: z.string().min(1),
  patch: z.string().min(1).max(1024 * 1024),
  mode: z.enum(["check", "apply"]).optional()
}
```

Use mutating-file annotations because callers may omit mode and default is `apply` only if the spec/test explicitly chooses that. Prefer safer default `check`; require explicit `mode: "apply"` for mutation.

- [ ] **Step 6: Run GREEN and commit**

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
- Create: `packages/capabilities/src/context-build.ts`
- Create: `packages/capabilities/src/context-build.test.ts`
- Modify: `packages/capabilities/src/native-capability-service.ts`
- Modify: `packages/mcp-server/src/tools.ts`

**Interfaces:**
- Consumes: already implemented inspect/search/git/verify/read capabilities.
- Produces: bounded context bundle without inference.

- [ ] **Step 1: Write failing selection/budget tests**

For target `packages/core/src/workspace-manager.ts`, assert deterministic priority:

```text
1. exact target file
2. changed files in same area
3. manifest/config governing target area
4. exact search hits for target basename/symbol
5. nearby tests
```

Assert `totalBytes <= maxBytes` and later candidates are omitted with `truncated: true` when the budget is exhausted.

- [ ] **Step 2: Run RED**

```bash
pnpm --filter @kodegpt/capabilities test -- context-build
```

- [ ] **Step 3: Implement intent-specific deterministic rules**

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

Stable tie-breaker: lexical path order.

- [ ] **Step 4: Register MCP `context.build`**

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

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/mcp-server test

git add packages/capabilities packages/mcp-server

git commit -m "feat(capabilities): add deterministic context builder"
```

---

### Task 10: Surface Version, Documentation, and Full Regression Gate

**Files:**
- Modify: `packages/mcp-server/src/index.ts`
- Modify: MCP surface tests
- Modify: `docs/compatibility/chatgpt.md`
- Modify: `tests/security/security-invariants.test.ts`
- Modify/add integration tests under `tests/integration/`

**Interfaces:**
- Produces: stable released native capability surface.

- [ ] **Step 1: Add failing surface-security assertions**

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

- [ ] **Step 2: Advance MCP surface version once**

Change the v0.1 public surface constant to the next explicit version (recommended `0.2`) and update tests that pin the prior value.

Do not change MCP protocol version solely for tool-surface additions.

- [ ] **Step 3: Document capability semantics**

`docs/compatibility/chatgpt.md` must explain:

- GPT Web remains the reasoning actor;
- `workspace.inspect` and `context.build` reduce primitive round trips;
- `code.search` reports heuristic precision honestly;
- `verify.run` uses named recipes, not arbitrary shell;
- `file.patch` performs full preflight + per-file conditional commit and may report partial commit if a commit-phase host failure occurs.

- [ ] **Step 4: Run the complete project verification**

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

- [ ] **Step 5: Inspect the final diff for invariant violations**

Run:

```bash
git diff --check
git grep -nE 'codex exec|spawn\([^)]*codex|exec\([^)]*codex|shell:[[:space:]]*true' -- . ':!docs/**'
```

Expected: no new runtime Codex execution and no shell enablement.

- [ ] **Step 6: Commit**

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
