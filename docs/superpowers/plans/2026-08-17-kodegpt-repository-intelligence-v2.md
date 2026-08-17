# KodeGPT Repository Intelligence v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the existing bounded `workspace.inspect` capability with deterministic source symbols, dependency/test relationships, and real source entrypoints without adding dependencies, authority, or a new MCP tool.

**Architecture:** Add one dependency-free `repository-analysis.ts` helper beneath `packages/capabilities/src`. `workspace-inspect.ts` remains the public orchestration point: it obtains the existing retained-root tree, asks the helper to analyze only admitted bounded source files through the existing `readFile` adapter, then returns additive `symbols` and `relationships`. Existing MCP/context schemas reuse the richer `WorkspaceInspectResult` contract.

**Tech Stack:** TypeScript 5.9, Zod, Vitest, existing KodeGPT retained-root workspace adapters. No new runtime dependency.

## Global Constraints

- Keep runtime/protocol/public MCP surface at `0.1 / 2026-07-28 / 0.7`.
- No new MCP tool and no new `code.search` input mode.
- Analyze at most 256 source files, 128 KiB per file, and 4 MiB total source bytes.
- Return at most 1,000 symbols and 1,000 relationships.
- Never execute source, consult network, or resolve paths not already represented in the retained-root tree.
- Ambiguous syntax is omitted rather than guessed.
- No TypeScript compiler API, Tree-sitter, language-server process, background index, or generic parser framework.

---

### Task 1: Add the additive repository-intelligence contract

**Files:**
- Modify: `packages/capabilities/src/contracts.ts`
- Modify: `packages/capabilities/src/schemas.ts`
- Modify: `packages/capabilities/src/contracts.test.ts`
- Modify: `packages/mcp-server/src/structured-results.test.ts`
- Modify: `packages/capabilities/src/context-build.test.ts`

**Interfaces:**
- Produces: `WorkspaceInspectSymbolKind`, `WorkspaceInspectRelationshipKind`, `WorkspaceInspectSymbol`, `WorkspaceInspectRelationship`.
- Extends: `WorkspaceInspectResult` with required `symbols` and `relationships` arrays.

- [ ] **Step 1: Write failing contract tests**

Add representative result fields to the existing valid workspace-inspect fixture:

```ts
symbols: [
  { name: "inspectWorkspace", kind: "function", path: "src/workspace-inspect.ts", line: 23, exported: true }
],
relationships: [
  { from: "src/workspace-inspect.test.ts", to: "src/workspace-inspect.ts", kind: "tests" }
]
```

Assert invalid symbol kinds, line `0`, absolute paths, and invalid relationship kinds are rejected.

Update structured-result/context fixtures to include empty `symbols: []` and `relationships: []` where source analysis is not under test.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
pnpm exec vitest run packages/capabilities/src/contracts.test.ts packages/mcp-server/src/structured-results.test.ts packages/capabilities/src/context-build.test.ts
```

Expected: FAIL because the result schema/types do not yet contain the new fields.

- [ ] **Step 3: Implement minimal contract/schema additions**

In `contracts.ts` add:

```ts
export type WorkspaceInspectSymbolKind =
  | "function" | "class" | "interface" | "type" | "enum" | "variable"
  | "struct" | "trait" | "module";

export type WorkspaceInspectRelationshipKind = "imports" | "tests" | "module";

export interface WorkspaceInspectSymbol {
  name: string;
  kind: WorkspaceInspectSymbolKind;
  path: string;
  line: number;
  exported: boolean;
}

export interface WorkspaceInspectRelationship {
  from: string;
  to: string;
  kind: WorkspaceInspectRelationshipKind;
}
```

Extend `WorkspaceInspectResult` with:

```ts
symbols: WorkspaceInspectSymbol[];
relationships: WorkspaceInspectRelationship[];
```

In `schemas.ts`, add strict schemas using non-empty relative strings, positive safe integer lines, boolean `exported`, and exact enum values. Reuse them inside `WorkspaceInspectResultSchema`.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/contracts.ts packages/capabilities/src/schemas.ts packages/capabilities/src/contracts.test.ts packages/mcp-server/src/structured-results.test.ts packages/capabilities/src/context-build.test.ts
git commit -m "feat: add repository intelligence contracts"
```

---

### Task 2: Implement the bounded dependency-free analyzer

**Files:**
- Create: `packages/capabilities/src/repository-analysis.ts`
- Create: `packages/capabilities/src/repository-analysis.test.ts`

**Interfaces:**
- Consumes: `CapabilityTreeEntry`, `WorkspaceInspectionAdapter`, and the new result contract types.
- Produces:

```ts
export interface RepositoryAnalysisResult {
  symbols: WorkspaceInspectSymbol[];
  relationships: WorkspaceInspectRelationship[];
  warnings: string[];
}

export async function analyzeRepository(
  workspace: WorkspaceInspectionAdapter,
  workspaceId: string,
  entries: CapabilityTreeEntry[]
): Promise<RepositoryAnalysisResult>;
```

- [ ] **Step 1: Write RED analyzer tests**

Use a tiny in-memory adapter/tree fixture that proves:

```ts
// src/index.ts
export function start() {}
import { helper } from "./helper.js";

// src/helper.ts
export const helper = 1;

// src/helper.test.ts
import { helper } from "./helper.js";

// src/lib.rs
pub mod worker;
pub struct Engine;

// src/worker.rs
pub fn run() {}
```

Expected symbols include `start`, `helper`, `Engine`, `worker`, and `run`. Expected relationships include `index.ts -> helper.ts` (`imports`), `helper.test.ts -> helper.ts` (`imports` and `tests`), and `lib.rs -> worker.rs` (`module`).

Add tests proving missing relative targets are omitted, duplicate relationships collapse, deterministic sort order, source-file count bound, total-byte bound, symbol bound, relationship bound, and skipped-file warning.

- [ ] **Step 2: Run analyzer tests and confirm RED**

Run:

```bash
pnpm exec vitest run packages/capabilities/src/repository-analysis.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimum analyzer**

Use constants:

```ts
const MAX_ANALYSIS_FILES = 256;
const MAX_ANALYSIS_FILE_BYTES = 128 * 1024;
const MAX_ANALYSIS_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_ANALYSIS_SYMBOLS = 1000;
const MAX_ANALYSIS_RELATIONSHIPS = 1000;
```

Implementation rules:

- only analyze `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, and `.rs` file entries;
- sort candidate paths before reading;
- call `readFile(..., { offset: 0, maxBytes: MAX_ANALYSIS_FILE_BYTES })`;
- skip non-EOF files and read failures with `INSPECT_ANALYSIS_FILE_SKIPPED`;
- stop before exceeding the total byte budget and emit `INSPECT_ANALYSIS_BYTE_LIMIT_REACHED`;
- parse line-by-line with anchored conservative regular expressions;
- resolve only relative TS/JS imports against the known tree by trying the literal target, normalized extension alternatives, and `/index.*` alternatives;
- resolve Rust `mod foo;` only against sibling `foo.rs` or `foo/mod.rs` known in the tree;
- derive `.test`/`.spec` sibling source relationships only when the source path is known;
- deduplicate by canonical string key;
- stable sort symbols by `path`, `line`, `kind`, `name`; relationships by `from`, `to`, `kind`;
- slice at result limits and emit the corresponding stable warning.

- [ ] **Step 4: Run analyzer tests and confirm GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/repository-analysis.ts packages/capabilities/src/repository-analysis.test.ts
git commit -m "feat: analyze bounded repository structure"
```

---

### Task 3: Integrate analysis into `workspace.inspect` and improve entrypoints

**Files:**
- Modify: `packages/capabilities/src/workspace-inspect.ts`
- Modify: `packages/capabilities/src/workspace-inspect.test.ts`

**Interfaces:**
- Consumes: `analyzeRepository(...)` from Task 2.
- Produces: populated `symbols` and `relationships` in every `WorkspaceInspectResult`.

- [ ] **Step 1: Add RED integration tests**

Extend the existing workspace fixture so scoped inspection of a package containing `src/index.ts`, `src/service.ts`, and `src/service.test.ts` expects:

```ts
entrypoints: expect.arrayContaining([{ path: "packages/demo/src/index.ts", kind: "source-index" }]),
symbols: expect.arrayContaining([
  expect.objectContaining({ name: "service", path: "packages/demo/src/service.ts" })
]),
relationships: expect.arrayContaining([
  { from: "packages/demo/src/service.test.ts", to: "packages/demo/src/service.ts", kind: "tests" }
])
```

Add Rust scoped-entrypoint expectations for `src/lib.rs` and `src/main.rs`.

- [ ] **Step 2: Run workspace-inspect tests and confirm RED**

```bash
pnpm exec vitest run packages/capabilities/src/workspace-inspect.test.ts
```

- [ ] **Step 3: Integrate analyzer and source-entrypoint detection**

In `inspectWorkspace`, after obtaining sorted bounded entries:

```ts
const analysis = await analyzeRepository(workspace, input.workspaceId, entries);
```

Return:

```ts
symbols: analysis.symbols,
relationships: analysis.relationships,
warnings: [...warnings, ...analysis.warnings],
```

Update `entrypointKind(path)` to return `source-index`, `source-main`, `rust-lib`, and `rust-main` only for conventional `/src/` filenames, preserving all existing manifest/config behavior.

- [ ] **Step 4: Run focused capability tests and confirm GREEN**

```bash
pnpm exec vitest run packages/capabilities/src/repository-analysis.test.ts packages/capabilities/src/workspace-inspect.test.ts packages/capabilities/src/context-build.test.ts packages/capabilities/src/contracts.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/workspace-inspect.ts packages/capabilities/src/workspace-inspect.test.ts
git commit -m "feat: enrich workspace inspection"
```

---

### Task 4: Reconcile MCP fixtures, docs, and full verification

**Files:**
- Modify only if required by failing tests: `packages/mcp-server/src/structured-results.test.ts`, `tests/fixtures/runtime/*`, `tests/fixtures/mcp-surface.ts`
- Modify: `docs/architecture/README.md`
- Modify: `docs/implementation/v0.1-execution-tracker.md`

**Interfaces:**
- No new public tool. Existing `workspace.inspect` output becomes richer.

- [ ] **Step 1: Run the MCP/integration-focused suite**

```bash
pnpm exec vitest run packages/mcp-server/src/structured-results.test.ts tests/integration/mcp-conformance.test.ts tests/integration/full-stack.test.ts
```

Fix only fixtures that require the two additive result arrays; do not alter tool count or input schemas.

- [ ] **Step 2: Run typecheck and build**

```bash
pnpm typecheck
pnpm build
```

Expected: PASS.

- [ ] **Step 3: Run full Vitest**

```bash
pnpm test
```

Expected: PASS with zero failures.

- [ ] **Step 4: Run repository deterministic gates**

```bash
pnpm run check:forbidden
pnpm run package:smoke
```

If script names differ, use the exact existing package scripts discovered in `package.json`; do not invent a new gate.

- [ ] **Step 5: Update architecture/tracker with verified facts only**

Record that Repository Intelligence v2 is locally implemented on its feature branch, keeps surface `0.7` and tool count unchanged, adds bounded source symbols/relationships/source entrypoints, and adds no authority/dependency/background index.

- [ ] **Step 6: Review exact diff**

Use CodexPro `show_changes` and verify no unrelated files, no dependency changes, no weakening of security invariants, and no changes to the two pre-existing dirty docs in canonical `main` outside this isolated branch's intentional documentation updates.

- [ ] **Step 7: Commit closure**

```bash
git add docs/architecture/README.md docs/implementation/v0.1-execution-tracker.md <any-required-fixtures>
git commit -m "docs: record repository intelligence v2"
```

- [ ] **Step 8: Operational personal-authority adjustment**

Outside the feature branch, re-establish `/home/sauron/dev/kodegpt` trust using the already implemented `trusted` preset so the user's personal workflow permits `npm`, `npx`, `pnpm`, and network while retaining audit and retained-root isolation. Verify with `profile.current` and `verify.list`; do not modify `develop` globally.
