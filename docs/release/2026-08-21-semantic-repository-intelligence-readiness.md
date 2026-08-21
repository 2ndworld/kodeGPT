# Semantic Repository Intelligence Readiness

Date: 2026-08-21

Candidate branch: `feat/semantic-repository-intelligence`

Candidate semantic contract: `runtime 0.1 / protocol 2026-07-28 / surface 0.19 / 76 public tools`

Live installed baseline before release closure: `surface 0.18 / 76 public tools` on `rel_fda9290d7ee09062dd6a656b56292683`.

## Scope

This candidate upgrades existing repository-intelligence capabilities without adding a public MCP tool. TypeScript/JavaScript source can now use bounded compiler-AST evidence for declarations, identifier references, relative import/export relationships, and source regions. `code.search` may truthfully return `precision:"structural"` for supported parser-backed symbol/definition/reference queries; exact text/path behavior remains unchanged. Unsupported languages, including Rust in this phase, remain truthful heuristic fallback.

`context.build` adds optional `focus?: string`, which requires an explicit workspace-relative `target` path. When structural evidence is trustworthy, selected target/test/dependency evidence may include `region:{startLine,endLine}` and `content` contains only that complete region. Existing `maxBytes` remains the aggregate returned-content bound. For the explicitly focused target, the existing bounded source read is analyzed directly with the structural parser, so large-repository aggregate symbol/file limits do not erase the requested target region and `workspace.inspect` is not asked to treat a file as a tree root.

No LSP daemon, vector database, model dependency, background index, workflow engine, plugin VM, autonomous agent runtime, generic provider authority, or new public file primitive was introduced.

## Surface reconciliation

The host-visible result/input schema is additive, so the semantic surface advances once from `0.18` to `0.19`. Runtime `0.1`, MCP protocol `2026-07-28`, public tool count 76, and required-input inventory remain unchanged. Runtime-readiness parsing remains backward-compatible with `0.18` and earlier accepted surfaces.

The packaged CLI needed one compatibility fix because `typescript@5.9.2` is now a direct runtime dependency of `@kodegpt/capabilities`: esbuild's single-file ESM bundle needs Node CommonJS compatibility globals for the TypeScript compiler package. The build banner now supplies `createRequire(import.meta.url)`, `__filename`, and `__dirname`; this does not add runtime authority or an execution abstraction. The complete packaged-CLI suite passed after the fix.

## Task 9 decision: no bounded `code.search` snippets

The optional `code.search.contextLines` / `snippet` API was audited and deliberately not shipped. A fixed context-line window can remove one follow-up read in some simple cases, but it duplicates `context.build.focus`, cannot guarantee a complete declaration/body for symbols larger than the configured window, and expands search/MCP schemas and response bytes for limited additional leverage. Exact structural context remains the responsibility of `context.build({target,focus})`. Default `code.search` stays lean.

## Deterministic benchmark gates

`packages/capabilities/src/repository-intelligence-benchmark.test.ts` exercises multiline and nested declarations, aliased imports, re-exports, comment/string/property false positives, parser-invalid isolation, deterministic ordering, module relationships, and large-file context slicing through the real capability composition.

Observed candidate gates:

- definition correctness: 100% for supported fixture expectations;
- direct-reference precision: >=95% gate passed;
- direct-reference recall: >=95% gate passed;
- expected direct module relationships: 100%;
- comment/string/property false positives: 0;
- repeated structural output ordering: identical;
- parser-invalid file does not erase valid-file structural results;
- target source-region context remains materially below whole-file baseline while retaining the complete declaration.

The benchmark was repeated and remained deterministic.

## Actual-repository dogfood

A temporary, uncommitted filesystem-backed dogfood harness exercised the candidate against the real KodeGPT worktree and was deleted immediately after evidence capture.

Representative `buildContext` evidence:

- `code.search(query:"buildContext",mode:"definition",path:"packages/capabilities/src")` returned `precision:"structural"` with the exact definition in `packages/capabilities/src/context-build.ts` at line 86;
- structural reference search returned 23 actual references in the bounded capability scope;
- `code.search(query:"calculateInvoice",mode:"reference")`, where that identifier appears only inside test fixture strings/comments in the real source scope, returned 0 structural references;
- `code.impact(target:"buildContext",kind:"symbol")` resolved the target to `packages/capabilities/src/context-build.ts`, identified related tests, affected area `packages/capabilities`, and truthfully reported truncation when the configured dependent/search bound was reached;
- the full workspace carried `INSPECT_ANALYSIS_FILE_LIMIT_REACHED`, `INSPECT_ANALYSIS_FILE_SKIPPED`, and `INSPECT_SYMBOL_LIMIT_REACHED`, so aggregate symbol metadata alone could not reliably supply the focused target region despite structural search succeeding;
- the first regression attempt (`a480ea5`) used an exact-file `workspace.inspect` call and passed adapter-level dogfood, but exact-active-release dogfood after the initial `0.19` cutover exposed that native tree inspection does not accept a file as its root and returned `CAPABILITY_INTERNAL`;
- the hotfix removes that invalid inspection and derives the focused target region from the existing bounded target source read using the same structural parser, with conservative whole-file fallback when the source is unsupported, incomplete, or ambiguous;
- production-path hotfix dogfood returned structural `buildContext` definition at line 87 plus complete focused region `87-244`, `truncated:false`, with 6,160 target bytes versus a 23,126-byte whole-file baseline: 26.64%;
- aggregate `maxBytes=32768` remained exact. Full-workspace limit warnings remained visible rather than being hidden or reclassified.

## Focused and package verification

Fresh passing evidence on the candidate includes:

- `pnpm --filter @kodegpt/capabilities test` -> 46 files, 434 tests passed;
- `pnpm --filter @kodegpt/capabilities typecheck` -> PASS;
- `pnpm --filter @kodegpt/mcp-server test` -> 6 files, 55 tests passed;
- `pnpm --filter @kodegpt/mcp-server typecheck` -> PASS;
- `pnpm --filter @kodegpt/core test` -> 130 passed, 1 intentional spike test skipped;
- `pnpm --filter kodegpt test` after packaged-CLI compatibility repair -> 19 files, 122 tests passed;
- MCP stdio/provider/security focused integration -> 23 tests passed;
- host-run `tests/integration/full-stack.test.ts` -> 3/3 passed;
- host-run `tests/integration/cli-bridge.test.ts` -> 1/1 passed;
- `pnpm typecheck` -> PASS;
- `pnpm build` -> PASS;
- `pnpm verify:forbidden` -> PASS;
- `pnpm verify:package` -> PASS, including package smoke;
- host-run `pnpm test:rust` / `cargo test --workspace` -> PASS; expected subprocess-helper tests remain intentionally ignored by their parent tests.

## Full-suite runner note

A literal `pnpm test` run from inside KodeGPT's retained process sandbox completed 1,065 tests with 1,060 passing, 1 intentional skip, and four failures confined to `tests/integration/full-stack.test.ts` (3) plus `tests/integration/cli-bridge.test.ts` (1). All four require creating or exercising another Bubblewrap/runtime process and fail in the nested runner with `SANDBOX_UNAVAILABLE` or non-JSON safe error text. The exact current source for those same four tests passes when run from the normal host verification runner (3/3 + 1/1).

Likewise, invoking `pnpm test:rust` from inside the retained sandbox causes expected nested-Bubblewrap failures, while the exact host-run Rust command passes fully. These are execution-harness limitations, not accepted source failures. The PR exact-head CI run in a normal GitHub Actions runner is therefore mandatory authority for the literal one-process `pnpm test`/Rust gates before merge; merge must remain guarded on that exact passing head.

## Release boundary review

Confirmed before PR creation:

- no public tool was added or removed; count remains exactly 76;
- required MCP inputs remain unchanged;
- only additive `context.build.focus`, selected-file `region`, and `structural` precision/result semantics are host-visible;
- `code.search(mode:"text"|"path")` semantics remain unchanged;
- structural precision is used only for supported parser-backed evidence;
- unsupported/Rust analysis does not claim parser-backed precision;
- context slicing never expands `maxBytes`;
- whole-file fallback remains available when no trustworthy region exists;
- no LSP/vector/model/background-index/plugin/workflow/agent runtime was introduced;
- current live service remains `0.18 / 76` until merged-main artifacts are built and explicitly cut over.

## Merge and deployment gate

This document is pre-merge readiness evidence, not a live-release claim. Release closure requires:

1. clean candidate worktree and committed readiness docs;
2. push branch and create/update the PR;
3. exact-head GitHub CI SUCCESS;
4. guarded merge of that exact passing head;
5. merged-main CI SUCCESS;
6. build/package provenance from merged main;
7. stage immutable service release while preserving the current active `0.18` release as rollback;
8. explicit restart/cutover;
9. post-cutover status/health plus exact-active-release MCP dogfood showing `0.19 / 76`, structural search, and focused region output;
10. refreshed ChatGPT action snapshot before any `0.19` host-compatibility claim;
11. worktree/branch cleanup only after closure evidence is complete.
