# KodeGPT Semantic Repository Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded parser-backed TypeScript/JavaScript repository intelligence and source-region context slicing behind existing KodeGPT tools, preserving exact lexical search and heuristic fallback.

**Architecture:** Introduce a private structural-analysis layer in `@kodegpt/capabilities`, initially backed by the TypeScript compiler parser for TS/JS. Route `workspace.inspect`, `code.search`, `code.impact`, and `context.build` through structural evidence where available while retaining current heuristic paths as explicit fallback. Keep one public tool surface; only additive result/input schema changes are allowed.

**Tech Stack:** TypeScript, existing `@kodegpt/capabilities` adapters/contracts, TypeScript compiler AST, Vitest, existing MCP structured-result/conformance tests.

**Spec:** `docs/superpowers/specs/2026-08-21-kodegpt-semantic-repository-intelligence-design.md`

## Global Constraints

- No new public MCP tool.
- No LSP daemon, vector database, model dependency, workflow engine, plugin VM, or background index.
- `code.search(mode:"text")` and `code.search(mode:"path")` retain current exact/lexical semantics.
- Structural parsing is bounded; incomplete coverage is surfaced explicitly.
- Unsupported or failed structural parsing falls back conservatively and never claims structural precision.
- Initial parser-backed support is TypeScript/JavaScript; Rust remains truthful heuristic fallback unless a later audited task adds a small parser cleanly.
- Context payload remains bounded by existing `maxBytes`; slicing reduces payload rather than expanding the budget.
- Implementation is TDD with focused verification before broader gates.

---

## File Structure

### New files

- `packages/capabilities/src/structural-analysis.ts`
  - Structural-analysis contracts and language dispatch.
  - Bounded per-file analysis result.
- `packages/capabilities/src/typescript-structural-analysis.ts`
  - TypeScript/JavaScript AST parsing and extraction only.
- `packages/capabilities/src/structural-analysis.test.ts`
  - Cross-language dispatcher, bounds, fallback, deterministic ordering.
- `packages/capabilities/src/typescript-structural-analysis.test.ts`
  - TS/JS declarations, references, imports, comments/strings, regions.
- `packages/capabilities/src/repository-intelligence-benchmark.test.ts`
  - Deterministic quality fixture and accuracy gates.

### Modified files

- `packages/capabilities/package.json`
  - Add direct runtime dependency `"typescript": "5.9.2"`; the root already pins the same version as a devDependency, but capabilities must not rely on workspace hoisting for a production import.
- `packages/capabilities/src/adapters.ts`
  - Add no new authority; only internal structural-read adapter types if required.
- `packages/capabilities/src/contracts.ts`
  - Add structural precision/region-compatible result fields.
- `packages/capabilities/src/schemas.ts`
  - Additive schema validation for new precision/region/snippet fields.
- `packages/capabilities/src/repository-analysis.ts`
  - Delegate supported files to structural analyzer; preserve current Rust heuristic fallback.
- `packages/capabilities/src/workspace-inspect.ts`
  - Surface structural evidence through existing workspace result.
- `packages/capabilities/src/code-search.ts`
  - Route symbol/definition/reference queries to structural evidence; retain lexical text/path paths.
- `packages/capabilities/src/code-impact.ts`
  - Prefer structural definitions/references for direct impact.
- `packages/capabilities/src/context-build.ts`
  - Prefer source-region slices for structural target/test/dependency evidence.
- `packages/capabilities/src/*.test.ts`
  - Existing targeted regression tests updated additively.
- `packages/mcp-server/src/tools.ts`
  - Add optional `code.search.contextLines` and additive output schema fields if retained by Task 8.
- `packages/mcp-server/src/structured-results.test.ts`
  - MCP schema/structured output coverage.
- `tests/fixtures/mcp-surface.ts`
  - Required-field inventory remains unchanged; optional input behavior is tested separately.
- `tests/integration/mcp-stdio.test.ts`
  - Real transport regression for structural precision/context region output.
- `docs/architecture/README.md`
  - Current-state architecture note after implementation is complete.
- `docs/compatibility/chatgpt.md`
  - Host-facing additive semantic notes after final surface decision.

---

### Task 1: Lock structural contracts with failing tests

**Files:**
- Create: `packages/capabilities/src/structural-analysis.test.ts`
- Modify: `packages/capabilities/src/contracts.ts`
- Modify: `packages/capabilities/src/schemas.ts`
- Modify: `packages/capabilities/src/index.ts`

**Interfaces:**
- Produces:
  - `StructuralPrecision = "structural" | "heuristic"`
  - `SourceRegion { startLine: number; endLine: number }`
  - `StructuralSymbolEvidence`
  - `StructuralReferenceEvidence`
  - `StructuralFileAnalysis`
- These are internal capability-layer types; no MCP tool is added.

- [ ] **Step 1: Write failing contract tests**

Add tests that require strict parsing of representative values:

```ts
const region = { startLine: 4, endLine: 12 };
expect(SourceRegionSchema.parse(region)).toEqual(region);
expect(() => SourceRegionSchema.parse({ startLine: 12, endLine: 4 })).toThrow();
expect(() => SourceRegionSchema.parse({ startLine: 0, endLine: 4 })).toThrow();
```

Require structural evidence to carry path/name/line/column/region and a precision value that cannot claim `structural` for a heuristic-only record.

- [ ] **Step 2: Run focused test and verify RED**

Run:

```bash
pnpm --filter @kodegpt/capabilities test -- structural-analysis.test.ts
```

Expected: FAIL because the structural contracts/schemas do not exist.

- [ ] **Step 3: Implement minimal contracts and schemas**

Add exact types/schemas with safe-integer positive line/column values and `endLine >= startLine` refinement.

Representative shape:

```ts
export type StructuralPrecision = "structural" | "heuristic";

export interface SourceRegion {
  startLine: number;
  endLine: number;
}
```

Keep these separate from authority/process contracts.

- [ ] **Step 4: Run focused tests and existing contract tests**

```bash
pnpm --filter @kodegpt/capabilities test -- structural-analysis.test.ts contracts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/contracts.ts packages/capabilities/src/schemas.ts packages/capabilities/src/index.ts packages/capabilities/src/structural-analysis.test.ts
git commit -m "feat: define structural repository evidence contracts"
```

---

### Task 2: Implement TypeScript/JavaScript AST declarations and regions

**Files:**
- Create: `packages/capabilities/src/typescript-structural-analysis.ts`
- Create: `packages/capabilities/src/typescript-structural-analysis.test.ts`
- Modify: `packages/capabilities/package.json` — add `"typescript": "5.9.2"` to `dependencies`

**Interfaces:**
- Produces:

```ts
analyzeTypeScriptSource(input: {
  path: string;
  contents: string;
}): StructuralFileAnalysis
```

- [ ] **Step 1: Write declaration/region tests**

Use fixtures covering:

```ts
export async function calculateInvoice(
  input: InvoiceInput
): Promise<Invoice> {
  return buildInvoice(input);
}

export class InvoiceService {
  create() {}
}

export interface InvoiceInput {
  subtotal: number;
}
```

Assert:

- `calculateInvoice` is a function definition;
- declaration line is correct;
- region spans the complete multiline function declaration/body;
- class/interface definitions are captured;
- nested function declarations are captured rather than skipped merely because they are indented.

- [ ] **Step 2: Run focused test and verify RED**

```bash
pnpm --filter @kodegpt/capabilities test -- typescript-structural-analysis.test.ts
```

Expected: FAIL because analyzer does not exist.

- [ ] **Step 3: Implement parser-backed declaration extraction**

First add the exact direct dependency in `packages/capabilities/package.json`:

```json
"dependencies": {
  "typescript": "5.9.2",
  "zod": "4.3.6"
}
```

Then use the TypeScript compiler parser:

```ts
const source = ts.createSourceFile(
  input.path,
  input.contents,
  ts.ScriptTarget.Latest,
  true,
  scriptKindForPath(input.path)
);
```

Walk AST nodes recursively. For supported declaration nodes, derive source line/region from `source.getLineAndCharacterOfPosition(...)`.

Do not construct a `Program` or language service in this task.

- [ ] **Step 4: Run focused tests**

```bash
pnpm --filter @kodegpt/capabilities test -- typescript-structural-analysis.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/package.json packages/capabilities/src/typescript-structural-analysis.ts packages/capabilities/src/typescript-structural-analysis.test.ts
git commit -m "feat: parse TypeScript structural declarations"
```

---

### Task 3: Add structural identifier references and relative imports

**Files:**
- Modify: `packages/capabilities/src/typescript-structural-analysis.ts`
- Modify: `packages/capabilities/src/typescript-structural-analysis.test.ts`

**Interfaces:**
- Extends `analyzeTypeScriptSource` to return:
  - definition/reference records;
  - relative import/export module specifiers;
  - no comment/string false positives.

- [ ] **Step 1: Write failing reference tests**

Use a fixture like:

```ts
import { money as formatMoney } from "./money.js";
export { taxRate } from "./tax.js";

const note = "calculateInvoice should not count here";
// calculateInvoice should not count here either

export function checkout() {
  return calculateInvoice(formatMoney(total));
}
```

Assert:

- executable identifier use of `calculateInvoice` is a reference;
- comment/string text is absent;
- imported local binding `formatMoney` is represented structurally;
- `./money.js` and `./tax.js` are emitted as module-specifier evidence;
- object property keys and property-access names are not blindly treated as variable references when the AST role says otherwise.

- [ ] **Step 2: Run focused test and verify RED**

```bash
pnpm --filter @kodegpt/capabilities test -- typescript-structural-analysis.test.ts
```

- [ ] **Step 3: Implement AST-role-aware reference extraction**

Walk `Identifier` nodes and classify declaration-name positions separately from references. Add a helper such as:

```ts
function isDeclarationName(node: ts.Identifier): boolean
```

and explicit exclusions for property-name-only positions that are not value references.

Extract `ImportDeclaration` and re-export module specifiers as relationships for later path resolution.

- [ ] **Step 4: Run focused tests**

Expected: PASS with no comment/string false positives.

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/typescript-structural-analysis.ts packages/capabilities/src/typescript-structural-analysis.test.ts
git commit -m "feat: add structural TypeScript references and imports"
```

---

### Task 4: Add bounded structural dispatcher and fallback semantics

**Files:**
- Create: `packages/capabilities/src/structural-analysis.ts`
- Modify: `packages/capabilities/src/structural-analysis.test.ts`
- Modify: `packages/capabilities/src/index.ts`

**Interfaces:**
- Produces:

```ts
analyzeStructuralFile(input: {
  path: string;
  contents: string;
}): StructuralFileAnalysis
```

- `.ts/.tsx/.js/.jsx/.mjs/.cjs` => parser-backed structural result.
- `.rs` and unsupported languages => explicit heuristic/unsupported result, not fake structural evidence.

- [ ] **Step 1: Write failing dispatch/fallback/bounds tests**

Assert:

- TS/JS routes structurally;
- unsupported extension returns an explicit warning and no structural claim;
- malformed TS still returns bounded warnings rather than throwing across repository analysis;
- all arrays have explicit hard limits and deterministic ordering.

- [ ] **Step 2: Run focused test and verify RED**

```bash
pnpm --filter @kodegpt/capabilities test -- structural-analysis.test.ts
```

- [ ] **Step 3: Implement dispatcher and constants**

Keep limits colocated, for example:

```ts
const MAX_STRUCTURAL_SYMBOLS_PER_FILE = 256;
const MAX_STRUCTURAL_REFERENCES_PER_FILE = 2_000;
const MAX_STRUCTURAL_RELATIONSHIPS_PER_FILE = 256;
```

Choose final values based on existing repository-analysis bounds and tests; do not silently return more evidence than existing aggregate limits can hold.

- [ ] **Step 4: Run focused tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/structural-analysis.ts packages/capabilities/src/structural-analysis.test.ts packages/capabilities/src/index.ts
git commit -m "feat: add bounded structural analysis dispatch"
```

---

### Task 5: Integrate structural evidence into repository analysis

**Files:**
- Modify: `packages/capabilities/src/repository-analysis.ts`
- Modify: `packages/capabilities/src/workspace-inspect.test.ts`
- Modify: `packages/capabilities/src/workspace-inspect.ts`

**Interfaces:**
- `analyzeRepository(...)` remains the aggregator.
- TS/JS files use structural analyzer.
- Rust retains current heuristic analyzer and is marked truthfully.

- [ ] **Step 1: Write failing workspace inspection tests**

Create fixture relationships that current line heuristics miss, including multiline/nested declarations and alias imports. Assert `workspace.inspect` returns the structural symbol/import evidence.

Also assert malformed source adds a bounded structural warning while valid files continue to analyze.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm --filter @kodegpt/capabilities test -- workspace-inspect.test.ts
```

- [ ] **Step 3: Replace TS/JS line parser path with structural analyzer**

Preserve existing aggregate bounds:

- selected file limit;
- per-file read bytes;
- total bytes;
- symbol/relationship ceilings.

Resolve relative module specifiers against `knownFiles` using the existing source-extension normalization logic, but feed it parser-derived specifiers instead of line regexes.

- [ ] **Step 4: Run repository/workspace tests**

```bash
pnpm --filter @kodegpt/capabilities test -- workspace-inspect.test.ts repository-analysis
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/repository-analysis.ts packages/capabilities/src/workspace-inspect.ts packages/capabilities/src/workspace-inspect.test.ts
git commit -m "feat: use structural repository analysis for TypeScript"
```

---

### Task 6: Route symbol/definition/reference search through structural evidence

**Files:**
- Modify: `packages/capabilities/src/code-search.ts`
- Modify: `packages/capabilities/src/code-search.test.ts`
- Modify: `packages/capabilities/src/contracts.ts`
- Modify: `packages/capabilities/src/schemas.ts`

**Interfaces:**
- Preserve `searchCode(...)` public capability entrypoint.
- Extend `CodeSearchResult.precision` to truthfully represent `structural`.
- Text/path remain unchanged.

- [ ] **Step 1: Write failing structural search tests**

Required assertions:

```ts
expect(result.mode).toBe("definition");
expect(result.precision).toBe("structural");
expect(result.matches).toContainEqual(
  expect.objectContaining({ path: "src/invoice.ts", line: 7, kind: "definition" })
);
```

Also prove a comment-only identifier hit is absent in structural reference mode.

- [ ] **Step 2: Run focused test and verify RED**

```bash
pnpm --filter @kodegpt/capabilities test -- code-search.test.ts
```

- [ ] **Step 3: Implement structural routing**

Do not delete lexical `CodeSearchAdapter`. Use it for exact text and as conservative candidate discovery/fallback where needed.

For structurally supported source candidates, classify from AST evidence rather than `isDefinitionLine`.

If only heuristic fallback evidence is available, return `precision:"heuristic"` and explicit truncation/warning evidence rather than `structural`.

- [ ] **Step 4: Run focused and contract tests**

```bash
pnpm --filter @kodegpt/capabilities test -- code-search.test.ts contracts.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/code-search.ts packages/capabilities/src/code-search.test.ts packages/capabilities/src/contracts.ts packages/capabilities/src/schemas.ts
git commit -m "feat: add structural code search precision"
```

---

### Task 7: Upgrade direct impact analysis

**Files:**
- Modify: `packages/capabilities/src/code-impact.ts`
- Modify: `packages/capabilities/src/code-impact.test.ts`

**Interfaces:**
- Existing `impactCode(...)` remains public capability entrypoint.
- Structural definitions/references feed direct dependents and related tests.
- No transitive-impact claim is added.

- [ ] **Step 1: Write failing impact tests**

Create a fixture where a target symbol is referenced in a multiline/nested context missed by current line heuristics. Assert:

- target definition path resolves;
- direct reference path/line appears as dependent;
- related test path appears;
- unrelated comment/string occurrence does not appear.

- [ ] **Step 2: Run focused test and verify RED**

```bash
pnpm --filter @kodegpt/capabilities test -- code-impact.test.ts
```

- [ ] **Step 3: Implement structural-first impact**

Reuse `searchCode(... mode:"definition"|"reference")` or the common structural service rather than implementing a third symbol parser in `code-impact.ts`.

- [ ] **Step 4: Run focused tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/code-impact.ts packages/capabilities/src/code-impact.test.ts
git commit -m "feat: improve structural code impact evidence"
```

---

### Task 8: Add source-region context slicing

**Files:**
- Modify: `packages/capabilities/src/context-build.ts`
- Modify: `packages/capabilities/src/context-build.test.ts`
- Modify: `packages/capabilities/src/contracts.ts`
- Modify: `packages/capabilities/src/schemas.ts`

**Interfaces:**
- Add optional `region?: SourceRegion` to `ContextSelectedFile`.
- `content` contains only that region when `region` is present.
- `maxBytes` remains the total bound.

- [ ] **Step 1: Write failing large-file slicing test**

Create a large fixture with target function around lines 180-220 and related test around lines 90-130. Build context for the target and assert:

```ts
expect(result.selectedFiles[0]).toMatchObject({
  path: "src/large.ts",
  reason: "exact-target",
  region: { startLine: 180, endLine: 220 }
});
expect(result.totalBytes).toBeLessThan(wholeFileBaselineBytes);
```

Also assert the returned source contains the complete target declaration but excludes unrelated distant sections.

- [ ] **Step 2: Run focused test and verify RED**

```bash
pnpm --filter @kodegpt/capabilities test -- context-build.test.ts
```

- [ ] **Step 3: Implement private bounded line-region reading**

Do not add a public file tool. Reuse the existing retained `readFile` adapter. A simple bounded helper may read the admitted file once within existing per-file limits, split lines, and return the selected region while preserving total byte accounting.

Prefer region candidates in this order:

1. target symbol;
2. related test symbol/region;
3. direct dependency/dependent region;
4. existing changed/config/search candidates.

Fallback to current whole-file behavior when no reliable region exists.

- [ ] **Step 4: Run focused tests**

```bash
pnpm --filter @kodegpt/capabilities test -- context-build.test.ts
```

Expected: PASS, including current fallback tests.

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/context-build.ts packages/capabilities/src/context-build.test.ts packages/capabilities/src/contracts.ts packages/capabilities/src/schemas.ts
git commit -m "feat: slice structural repository context"
```

---

### Task 9: Add bounded search snippets only if they reduce round trips

**Files:**
- Modify: `packages/capabilities/src/contracts.ts`
- Modify: `packages/capabilities/src/code-search.ts`
- Modify: `packages/capabilities/src/code-search.test.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/structured-results.test.ts`

**Interfaces:**
- Candidate additive input:

```ts
contextLines?: number // integer 0..20, default 0
```

- Candidate additive result field:

```ts
snippet?: {
  startLine: number;
  endLine: number;
  content: string;
}
```

- [ ] **Step 1: Establish a round-trip benchmark test before adding the API**

Use representative search tasks and prove that a bounded context snippet eliminates a subsequent read for at least the benchmark cases. If it does not materially reduce tool calls or produces excessive response bytes, delete Task 9 from the implementation branch and record the decision in the release note.

- [ ] **Step 2: If justified, write RED schema/behavior tests**

Assert `0` and `20` accepted, `-1`/`21` rejected, and total snippet output is bounded.

- [ ] **Step 3: Implement minimal optional input/result**

Do not change required fields, tool count, or default output behavior.

- [ ] **Step 4: Run capability + MCP tests**

```bash
pnpm --filter @kodegpt/capabilities test -- code-search.test.ts
pnpm --filter @kodegpt/mcp-server test -- structured-results.test.ts
```

- [ ] **Step 5: Commit only if benchmark justified the feature**

```bash
git add packages/capabilities/src/contracts.ts packages/capabilities/src/code-search.ts packages/capabilities/src/code-search.test.ts packages/mcp-server/src/tools.ts packages/mcp-server/src/structured-results.test.ts
git commit -m "feat: add bounded code search snippets"
```

---

### Task 10: Add deterministic repository-intelligence quality benchmark

**Files:**
- Create: `packages/capabilities/src/repository-intelligence-benchmark.test.ts`
- Add fixture files under the existing capability test-fixture convention; do not create a new fixture framework if inline virtual adapters already suffice.

**Interfaces:**
- No production API.
- Produces measurable release gates for structural correctness and context efficiency.

- [ ] **Step 1: Add benchmark fixtures for heuristic failure cases**

Cover at minimum:

- multiline declarations;
- nested declarations;
- aliased imports;
- re-exports;
- comments/strings with target identifiers;
- property names versus value references;
- parser-invalid file beside valid files;
- large context file with small relevant region.

- [ ] **Step 2: Encode exact quality gates**

For supported fixtures assert:

- definition correctness = 100%;
- direct-reference precision >= 95%;
- direct-reference recall >= 95%;
- expected direct module relationships = 100%;
- comment/string false positives = 0;
- repeated output ordering identical;
- sliced context bytes materially below whole-file baseline while retaining required evidence.

- [ ] **Step 3: Run benchmark repeatedly**

```bash
pnpm --filter @kodegpt/capabilities test -- repository-intelligence-benchmark.test.ts
pnpm --filter @kodegpt/capabilities test -- repository-intelligence-benchmark.test.ts
```

Expected: identical PASS results/order.

- [ ] **Step 4: Fix metadata/analysis defects rather than weakening thresholds**

Any threshold change requires explicit evidence in the commit message/release note; do not reduce gates merely to make the suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/repository-intelligence-benchmark.test.ts
git commit -m "test: benchmark semantic repository intelligence"
```

---

### Task 11: MCP contract, integration, and semantic-surface reconciliation

**Files:**
- Modify: `packages/mcp-server/src/tools.ts` if additive fields/options exist
- Modify: `packages/mcp-server/src/server.test.ts`
- Modify: `packages/mcp-server/src/structured-results.test.ts`
- Modify: `tests/fixtures/mcp-surface.ts`
- Modify: `tests/integration/mcp-stdio.test.ts`
- Modify: version/compatibility constants only if the additive contract requires a semantic surface bump

**Interfaces:**
- Tool count remains exactly 76.
- Required-input inventory remains unchanged.
- Optional structural/snippet/region fields are transport-safe.

- [ ] **Step 1: Write/adjust transport tests before changing surface version**

Prove a real MCP request can return structural precision and region-aware context output.

If Task 9 shipped, prove `code.search.contextLines` is accepted over stdio and omitted input preserves old behavior.

- [ ] **Step 2: Run MCP focused tests and verify expected RED/compatibility state**

```bash
pnpm --filter @kodegpt/mcp-server test
pnpm exec vitest run tests/integration/mcp-stdio.test.ts --no-file-parallelism
```

- [ ] **Step 3: Reconcile semantic surface exactly once**

If host-visible result/input schema changed, bump the semantic MCP surface once according to project conventions. Runtime `0.1` and protocol `2026-07-28` remain unchanged unless an independently justified protocol/runtime change exists.

Do not change public tool count.

- [ ] **Step 4: Run exact surface/conformance tests**

Expected: exactly 76 public tools and unchanged required-field list.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server tests packages/capabilities
git commit -m "feat: publish semantic repository intelligence"
```

---

### Task 12: Documentation, dogfood, and final verification

**Files:**
- Modify: `docs/architecture/README.md`
- Modify: `docs/compatibility/chatgpt.md`
- Create: `docs/release/2026-08-21-semantic-repository-intelligence-readiness.md`

**Interfaces:**
- No new production interface.
- Release note records structural coverage truthfully, including any remaining Rust heuristic path.

- [ ] **Step 1: Dogfood on the KodeGPT repository**

Run representative existing public calls for:

- definition search on a multiline/nested TypeScript symbol;
- reference search where comment/string false positives previously existed;
- `code.impact` on an internal capability function;
- `context.build` against a large target and record selected bytes/regions.

Record exact evidence in the readiness doc.

- [ ] **Step 2: Run focused package gates**

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/mcp-server test
pnpm --filter @kodegpt/core test
```

Expected: PASS.

- [ ] **Step 3: Run repository final gates**

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm verify:forbidden
pnpm verify:package
pnpm test:rust
```

Expected: all PASS.

- [ ] **Step 4: Review final diff and benchmark evidence**

Confirm:

- no LSP/vector/model/workflow/plugin runtime introduced;
- tool count still 76;
- lexical text/path search unchanged;
- structural precision never overclaimed;
- context bytes improved on benchmark/dogfood;
- unsupported Rust structural behavior is documented honestly if still heuristic.

- [ ] **Step 5: Commit readiness documentation**

```bash
git add docs/architecture/README.md docs/compatibility/chatgpt.md docs/release/2026-08-21-semantic-repository-intelligence-readiness.md
git commit -m "docs: record semantic repository intelligence readiness"
```

---

## Plan Self-Review

### Spec coverage

- Structural contracts and bounded parser path: Tasks 1-4.
- TypeScript/JavaScript declarations/references/imports: Tasks 2-3.
- Workspace aggregation: Task 5.
- `code.search`: Task 6.
- `code.impact`: Task 7.
- Context source-region slicing: Task 8.
- Optional round-trip snippet improvement: Task 9, explicitly benchmark-gated.
- Deterministic quality gates: Task 10.
- MCP/public compatibility: Task 11.
- Dogfood/release evidence: Task 12.
- Rust does not falsely claim parser-backed support; expansion remains separate if dependency audit justifies it.

### Placeholder scan

No `TBD`, `TODO`, generic “add tests”, or undefined implementation placeholders are intentionally left in the plan. The only conditional branch is Task 9, whose go/no-go criterion is an explicit benchmark rather than an unspecified future decision.

### Type consistency

The plan consistently uses `StructuralPrecision`, `SourceRegion`, `StructuralFileAnalysis`, `analyzeTypeScriptSource`, and `analyzeStructuralFile`. Public context adds optional `region: SourceRegion`; public search adds `structural` precision and only optionally `contextLines`/`snippet` if Task 9 passes its benchmark gate.
