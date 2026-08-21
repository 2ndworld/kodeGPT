# Semantic Repository Intelligence Readiness and Final Closure

Date: 2026-08-21

Feature branch (merged and deleted): `feat/semantic-repository-intelligence`

Released semantic contract: `runtime 0.1 / protocol 2026-07-28 / surface 0.19 / 76 public tools`

Pre-release live baseline: `surface 0.18 / 76 public tools` on `rel_fda9290d7ee09062dd6a656b56292683`.

Final code merge: `8211584b1a4d2c4622aa4afd69afa974da265fe5` after feature PR #60 plus focused-context hotfix PR #61. Both exact-head and merged-main gates passed; final merged-main CI is `32473346644`.

Final installed service: active immutable release `rel_f8ed46a490b83951f30a3bc6a01f4c0c` at `0.19 / 76`, with known-good `0.18` release `rel_fda9290d7ee09062dd6a656b56292683` retained as rollback. The defective initial `0.19` release was pruned after the hotfix cutover.

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

- pre-hotfix candidate dogfood found the exact `buildContext` definition structurally; final exact-active-release dogfood on the merged hotfix returned `precision:"structural"` at line 87 in `packages/capabilities/src/context-build.ts`;
- structural reference search returned 23 actual references in the bounded capability scope;
- final exact-active-release `code.search(query:"calculateInvoice",mode:"reference",path:"packages/capabilities/src")`, where that identifier appears only as non-reference fixture/comment/string evidence in that supported TS scope, returned `precision:"structural"` with 0 matches;
- `code.impact(target:"buildContext",kind:"symbol")` resolved the target to `packages/capabilities/src/context-build.ts`, identified related tests, affected area `packages/capabilities`, and truthfully reported truncation when the configured dependent/search bound was reached;
- the full workspace carried `INSPECT_ANALYSIS_FILE_LIMIT_REACHED`, `INSPECT_ANALYSIS_FILE_SKIPPED`, and `INSPECT_SYMBOL_LIMIT_REACHED`, so aggregate symbol metadata alone could not reliably supply the focused target region despite structural search succeeding;
- the first regression attempt (`a480ea5`) used an exact-file `workspace.inspect` call and passed adapter-level dogfood, but exact-active-release dogfood after the initial `0.19` cutover exposed that native tree inspection does not accept a file as its root and returned `CAPABILITY_INTERNAL`;
- the hotfix removes that invalid inspection and derives the focused target region from the existing bounded target source read using the same structural parser, with conservative whole-file fallback when the source is unsupported, incomplete, or ambiguous;
- production-path hotfix dogfood returned structural `buildContext` definition at line 87 plus complete focused region `87-244`, `truncated:false`, with 6,160 target bytes versus a 23,126-byte whole-file baseline: 26.64%;
- aggregate `maxBytes=32768` remained exact. Full-workspace limit warnings remained visible rather than being hidden or reclassified.

## Focused and package verification

Passing feature/hotfix verification evidence includes:

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

Confirmed through final closure:

- no public tool was added or removed; count remains exactly 76;
- required MCP inputs remain unchanged;
- only additive `context.build.focus`, selected-file `region`, and `structural` precision/result semantics are host-visible;
- `code.search(mode:"text"|"path")` semantics remain unchanged;
- structural precision is used only for supported parser-backed evidence;
- unsupported/Rust analysis does not claim parser-backed precision;
- context slicing never expands `maxBytes`;
- whole-file fallback remains available when no trustworthy region exists;
- no LSP/vector/model/background-index/plugin/workflow/agent runtime was introduced;
- live service is now `0.19 / 76` on `rel_f8ed46a490b83951f30a3bc6a01f4c0c`, with known-good `0.18` rollback `rel_fda9290d7ee09062dd6a656b56292683`.

## Final merge and deployment closure

Release closure completed as follows:

1. feature PR #60 exact-head CI passed and guarded merge produced `53bb657f4e93da8e66ce0eb638a3856eb509a473`; merged-main CI `32471256244` passed;
2. the initial `0.19` cutover exposed one real exact-active-release defect: focused context attempted file-root `workspace.inspect` and returned `CAPABILITY_INTERNAL`;
3. hotfix PR #61 at exact head `30c81393da067e1145a041a8cdf3ee93532ce52b` passed CI `32472827974`, was guarded-merged as `8211584b1a4d2c4622aa4afd69afa974da265fe5`, and merged-main CI `32473346644` passed;
4. final build provenance recorded `sourceRevision:8211584b1a4d2c4622aa4afd69afa974da265fe5` with `sourceDirty:false`;
5. lifecycle promotion intentionally restored known-good `0.18` first, then promoted the hotfix, leaving active `rel_f8ed46a490b83951f30a3bc6a01f4c0c` and rollback `rel_fda9290d7ee09062dd6a656b56292683`; the defective initial `0.19` release was pruned;
6. live `system.capabilities` observed `0.19 / 76`; live `system.health` reported healthy audit and filesystem boundary; exact-active-release MCP dogfood passed structural definition, structural false-positive suppression, and focused region `87-244` at 6,160 of 23,126 bytes while preserving the 32 KiB aggregate budget;
7. canonical `main == origin/main`, the feature/hotfix linked worktree was removed, and local plus remote feature/hotfix branches were deleted;
8. development continuity checkpoint revision 4 records this release complete with no repository/runtime next actions.

The current conversation's approved ChatGPT action definition for `context.build` still reflects the older cached schema and does not expose optional `focus`, even though the live server and exact-active MCP surface do. A fresh/rescanned ChatGPT action snapshot is therefore still required before claiming **host-schema** acceptance for `context.build.focus`; this is a host snapshot freshness condition, not a remaining repository/runtime release blocker.
