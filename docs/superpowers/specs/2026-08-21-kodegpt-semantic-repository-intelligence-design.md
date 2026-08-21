# KodeGPT Semantic Repository Intelligence + Context Slicing Design

Date: 2026-08-21
Status: design candidate derived from the approved ChatGPT-native development intelligence roadmap
Parent roadmap: `docs/superpowers/specs/2026-08-21-kodegpt-chatgpt-native-development-intelligence-roadmap.md`
Baseline: semantic surface `0.18`, 76 public MCP tools

## 1. Problem

KodeGPT's execution, verification, Git, browser, visual, and CI control planes are already comparatively mature, but repository intelligence remains intentionally lightweight.

Current source inspection shows:

- `code.search(mode:"definition"|"reference"|"symbol")` begins from bounded lexical search and classifies matches with identifier-boundary and line-shape heuristics;
- TypeScript/JavaScript definition detection recognizes common top-level forms such as function/class/interface/type/enum/variable declarations but is not parser-backed;
- Rust definition detection recognizes common top-level `fn`/`struct`/`enum`/`trait`/`mod` forms heuristically;
- `repository-analysis.ts` scans a bounded subset of TypeScript/JavaScript/Rust source, recognizes a small set of symbols/import/module/test relations, and then feeds `workspace.inspect`, `code.impact`, and `context.build`;
- `context.build` ranks relevant files and generally reads file content, so a useful symbol-level task can still consume large whole-file payloads.

The consequence is an asymmetry: KodeGPT can execute and verify changes with high determinism, but ChatGPT can still receive incomplete or over-broad repository evidence before editing.

## 2. Goal

Improve KodeGPT's repository understanding enough that ChatGPT receives smaller, higher-confidence, structurally relevant context without introducing an LSP daemon, vector database, new model runtime, or a new public MCP tool family.

The v1 target is:

```text
bounded source inventory
        |
        v
parser-backed structural analysis where supported
        |
        +--> symbols / definitions
        +--> imports/modules
        +--> direct structural relationships
        |
        v
existing public tools
  workspace.inspect
  code.search
  code.impact
  context.build
        |
        v
small source-region context slices
```

## 3. Architectural principles

### 3.1 Preserve the existing public tool surface

P0-A should not add a new public MCP tool merely for parser access.

Improve the semantics behind:

- `workspace.inspect`;
- `code.search`;
- `code.impact`;
- `context.build`.

A semantic surface version bump is justified only if output contracts change additively in a host-visible way.

### 3.2 Structural analysis is evidence, not authority

Parser output does not grant write/process/Git/network authority. It only produces repository evidence.

### 3.3 Exact lexical fallback remains first-class

`code.search(mode:"text")` remains exact lexical search.

If structural parsing is unsupported or a file cannot be parsed within bounds, KodeGPT must fall back conservatively rather than silently claiming structural precision.

### 3.4 No language-server lifecycle in v1

Do not introduce:

- language-server installation;
- persistent LSP subprocesses;
- initialization/project synchronization state;
- daemon supervision;
- editor-style incremental document synchronization.

P0-A is bounded, request-driven repository analysis.

### 3.5 Add languages from measured value

V1 must prioritize the languages already most important to KodeGPT itself and its likely application-development workload.

Required first-class initial support:

1. TypeScript / JavaScript;
2. Rust.

Python and Go are follow-up candidates only after the architecture is proven and benchmark evidence justifies them. Do not create empty language adapters merely for nominal extensibility.

## 4. Structural analysis model

Introduce a private/internal structural analysis abstraction in `@kodegpt/capabilities`.

Representative contracts:

```ts
export type StructuralPrecision = "structural" | "heuristic";

export interface StructuralRegion {
  startLine: number;
  endLine: number;
}

export interface StructuralSymbol {
  name: string;
  kind: WorkspaceInspectSymbolKind;
  path: string;
  line: number;
  exported: boolean;
  region?: StructuralRegion;
}

export interface StructuralReference {
  name: string;
  path: string;
  line: number;
  column: number;
  kind: "definition" | "reference";
  region?: StructuralRegion;
}

export interface StructuralRelationship {
  from: string;
  to: string;
  kind: "imports" | "module" | "tests";
  precision: StructuralPrecision;
}

export interface StructuralFileAnalysis {
  path: string;
  language: "typescript" | "javascript" | "rust";
  symbols: StructuralSymbol[];
  references: StructuralReference[];
  relationships: StructuralRelationship[];
  warnings: string[];
}
```

Exact type names may differ, but the implementation must explicitly distinguish structural evidence from heuristic fallback.

## 5. Parser strategy

### 5.1 TypeScript / JavaScript

Use the TypeScript compiler parser/API. Dependency audit confirms the repository already pins `typescript` `5.9.2` at the workspace root. Because `@kodegpt/capabilities` will import the parser in production capability code, add `typescript: "5.9.2"` as a direct dependency of `packages/capabilities/package.json` rather than relying on root-devDependency/hoisting behavior.

This keeps one parser stack for TypeScript/JavaScript and provides AST node locations without running a language server.

Do not require full type-checker/project-program construction in v1. AST parsing is enough to improve:

- declarations;
- import/export declarations;
- local identifier references;
- declaration source regions;
- direct relative module relationships.

If later evidence shows that cross-file alias resolution or type-driven references are materially missing, that becomes a separate design decision rather than silently escalating v1 into a compiler service.

### 5.2 Rust

Use a bounded Rust parser only if a small dependency can be isolated cleanly. If the repository does not already contain an appropriate parser dependency and adding one would significantly expand build/runtime complexity, retain the current Rust heuristic path in the first implementation slice and design the parser adapter boundary so Rust structural parsing can be added as the next independently reviewable task.

Do not shell out to `rust-analyzer` in v1.

## 6. Analysis bounds

Structural analysis must remain bounded and deterministic.

Keep or tighten explicit ceilings for:

- maximum analyzed files;
- bytes per file;
- aggregate analyzed bytes;
- maximum symbols;
- maximum references;
- maximum relationships;
- maximum regions returned;
- parser failure/warning counts.

The current repository-analysis limits are a useful baseline rather than a promise that all limits must stay numerically identical.

Every incomplete result must surface explicit warnings/truncation evidence. Parsing a subset must never be reported as complete repository understanding.

## 7. `workspace.inspect` integration

Keep the existing result shape compatible where practical.

Additive improvements may include:

- more accurate symbols;
- more accurate import/module relationships;
- source regions for symbols if the public contract benefits enough to justify it;
- a compact analysis precision summary, for example counts of structural versus heuristic files.

Do not dump ASTs or per-node parser details into MCP output.

## 8. `code.search` integration

### 8.1 `text`

Unchanged exact lexical behavior.

### 8.2 `path`

Unchanged lexical path behavior.

### 8.3 `symbol`, `definition`, `reference`

Prefer structural analysis when the queried language/file set is structurally supported.

The result must communicate precision truthfully. Extend the current precision vocabulary if necessary, for example:

```text
exact
structural
heuristic
lexical
```

A structural query that only partially covers the candidate source set must surface truncation/warnings rather than silently presenting heuristic completeness.

### 8.4 Source snippets

Add an optional bounded source-context input to `code.search`, preferably something simple such as:

```ts
contextLines?: number // 0..20, default 0
```

When positive, each result can include a bounded source neighborhood around the match. This reduces the common `search -> file.read` round trip without adding a second search tool.

The snippet must obey a total response-byte bound and report truncation when clipped.

## 9. `code.impact` integration

Use the stronger structural graph before heuristic references.

For a symbol target:

1. resolve structural definitions;
2. gather structural references where available;
3. derive direct dependents;
4. associate structurally or conventionally related tests;
5. fall back conservatively for unsupported files/languages.

The result must not imply transitive whole-program impact unless it actually computes it. P0-A remains a bounded direct-impact tool.

## 10. Context slicing

This is the main user-facing leverage of the structural work.

### 10.1 Explicit symbol focus

Audit against the implemented `context.build` contract found that `target` is a workspace-relative **path**, not a symbol identifier. Region slicing must not guess which declaration inside a target file the user means.

Add one optional bounded input to the existing tool/capability:

```ts
focus?: string
```

Rules:

- `focus` is optional and requires `target`;
- without `focus`, existing path-targeted whole-file behavior remains compatible;
- with `focus`, KodeGPT performs structural symbol search scoped to the target area and prefers the exact target symbol region plus enclosing regions for actual structural references;
- if no trustworthy region is available, fall back to the existing bounded file behavior rather than guessing;
- no new public tool is introduced.

Representative call:

```text
context.build({
  workspaceId,
  intent: "implement",
  target: "packages/billing/src/invoice.ts",
  focus: "calculateInvoice"
})
```

### 10.2 Current limitation

`context.build` selects relevant file candidates and reads bounded content, but a selected file is still usually represented as file content rather than a structural source region.

### 10.3 New selection unit

Allow selected context evidence to represent either:

- a whole bounded file read when necessary; or
- a bounded source region when structural evidence identifies the relevant symbol/declaration/test block.

Representative additive shape:

```ts
export interface ContextSelectedFile {
  path: string;
  reason: string;
  content?: string;
  region?: {
    startLine: number;
    endLine: number;
  };
  truncated: boolean;
}
```

A region indicates that `content` is the source slice for that line range, not the complete file.

### 10.4 Region selection

For target-scoped work, prefer in order:

1. exact target region/symbol;
2. directly related test region;
3. direct dependency/dependent region;
4. exact changed hunk neighborhood when relevant;
5. governing configuration/manifests;
6. whole file only when no reliable region exists or the file is already small enough that slicing gives little value.

Region boundaries should include a small deterministic amount of surrounding source context when necessary to keep declarations understandable.

### 10.5 Budget accounting

`maxBytes` continues to bound the complete context payload. Region slicing must reduce bytes; it must not become a reason to return more total evidence than the caller requested.

## 11. File-read ergonomics

Consider an additive optional line-oriented read mode on the existing `file.read` contract only if implementation pressure proves it materially simplifies region retrieval.

Do not create a new public `file.readLines` tool.

If region slicing can be implemented privately with the existing retained workspace read authority, keep the public `file.read` contract unchanged in this phase.

## 12. Caching

V1 should prefer a small request/process-lifetime cache keyed by trustworthy file identity/content evidence only if benchmarks show repeated parser work is meaningful.

Do not introduce:

- a persistent indexing daemon;
- a database;
- watcher infrastructure;
- invalidation complexity before measurement.

Correctness without cache is preferred to sophisticated stale indexing.

## 13. Errors and warnings

Prefer bounded warnings and existing capability errors.

Potential warning vocabulary may include:

```text
STRUCTURAL_PARSE_FAILED
STRUCTURAL_LANGUAGE_UNSUPPORTED
STRUCTURAL_FILE_LIMIT_REACHED
STRUCTURAL_REFERENCE_LIMIT_REACHED
STRUCTURAL_BYTE_LIMIT_REACHED
STRUCTURAL_FALLBACK_HEURISTIC
```

Do not create a new stable error code unless the caller has a distinct recovery action.

A single malformed file must not break all repository discovery.

## 14. Quality benchmark

P0-A is not complete merely because parser code exists.

Create a deterministic repository-intelligence benchmark containing representative TypeScript/JavaScript and Rust fixtures with expected:

- definitions;
- references;
- imports/modules;
- direct dependents;
- related tests;
- context regions.

Include adversarial/current-heuristic failure cases such as:

- multiline declarations;
- exported declarations with modifiers;
- nested functions;
- aliased imports;
- import/export syntax variations;
- same identifier used in comments/strings;
- same identifier used as an object property versus variable reference;
- Rust visibility variants;
- Rust multiline declarations;
- files larger than analysis limits;
- parser-invalid files mixed with valid files.

Required benchmark targets for structurally supported fixtures:

- 100% correct definitions for benchmark symbols;
- >= 95% direct-reference precision;
- >= 95% direct-reference recall;
- 100% expected direct import/module relations;
- no comment/string false positives as code references;
- deterministic identical results across repeated runs.

Context benchmark targets:

- required target/test/dependency evidence appears in top selected context;
- context bytes are materially lower than whole-file baseline for large fixture files;
- no regression in target-file inclusion for unsupported/fallback cases.

## 15. Testing strategy

Implementation is TDD and decomposed by independently reviewable behavior.

At minimum test:

1. parser-backed TypeScript/JavaScript declarations;
2. parser-backed TypeScript/JavaScript references and relative imports;
3. fallback behavior and warnings for parse failures/unsupported sources;
4. `workspace.inspect` aggregation/truncation;
5. `code.search` structural precision and bounded snippets;
6. `code.impact` structural dependent/test evidence;
7. `context.build` source-region slicing and byte budgeting;
8. compatibility of existing lexical text/path search;
9. deterministic quality benchmark;
10. full capability/MCP/integration regression.

## 16. Public surface strategy

Preferred v1:

- no new public MCP tool;
- additive optional `code.search.contextLines` only if it survives focused design/testing;
- additive precision value(s) if required for truthful output;
- additive context selected-file `region` only if host-visible slicing is implemented;
- semantic surface bump only once when the final additive contract is shipped.

Do not increase tool count merely because implementation gains internal components.

## 17. Delivery slices

### Slice 1 — Structural core

- internal structural-analysis contracts;
- TypeScript/JavaScript parser-backed analyzer;
- benchmark fixtures;
- heuristic fallback preserved.

### Slice 2 — Existing intelligence tools

- `workspace.inspect` structural aggregation;
- `code.search` structural definition/reference/symbol routing;
- `code.impact` direct structural impact.

### Slice 3 — Context slicing

- region-aware context candidates;
- bounded region reads;
- context byte-budget tests;
- benchmark against whole-file baseline.

### Slice 4 — Round-trip reduction and release

- optional `code.search.contextLines` if benchmarked useful;
- public schema/result updates;
- docs and compatibility notes;
- complete regression, exact surface inventory, dogfood, PR/CI/release evidence.

Rust parser-backed structural analysis is inserted into Slice 1 or a separate follow-up slice based on dependency audit; v1 must not pretend heuristic Rust is structural.

## 18. Acceptance criteria

P0-A is complete when:

1. TypeScript/JavaScript structural definitions/references are parser-backed and benchmarked;
2. comment/string identifier occurrences do not appear as structural code references;
3. direct relative import relationships are parser-derived for supported files;
4. unsupported/failed parsing falls back with explicit incomplete/heuristic evidence;
5. `code.search` truthfully distinguishes structural from heuristic/lexical precision;
6. `code.impact` uses structural evidence where available without overclaiming transitive impact;
7. `context.build` can return bounded source-region slices for structurally identified target/test/dependency evidence;
8. context slicing materially lowers benchmark bytes for large-source tasks without losing required evidence;
9. exact text/path search behavior remains compatible;
10. analysis remains bounded with explicit truncation/warnings;
11. no LSP daemon, vector DB, model dependency, plugin runtime, workflow engine, or new public tool family is introduced;
12. focused tests, full repository gates, MCP conformance, and dogfood pass on the final candidate.

## 19. Relationship to later roadmap work

P0-A should make later phases stronger:

- P0-B evidence freshness can bind verification to better-defined affected source state;
- P0-C resume synthesis can use structural/current-change summaries without reading broad repository context;
- P1 capability intelligence can route semantic repository intents more accurately;
- Dev Console v2 can display compact affected-area evidence without becoming an analyzer itself.

P0-A must not implement those later phases implicitly.
