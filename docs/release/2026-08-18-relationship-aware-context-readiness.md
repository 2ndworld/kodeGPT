# Relationship-Aware Context Build v2 — Readiness

Status date: 2026-08-18  
Branch: `feat/context-build-relationship-ranking`  
Baseline: `61f8bd31b9ee75fd1b9fad45281c41250f612e85`  
Implementation commit: `747a7ddec9c228dcb022f0cdc526d03fae6f3e6e`  
Status: implementation and source verification complete; ready for PR/CI and merged-main live acceptance.

## Scope

`context.build` now consumes the direct repository relationships already produced by `workspace.inspect` instead of leaving that evidence unused. Selection remains deterministic, bounded, and one-hop only.

The ranking order is now:

1. exact target;
2. directly related test;
3. direct dependency;
4. direct dependent;
5. changed same-area file;
6. governing manifest/config;
7. lexical/path search hit;
8. filename-based nearby-test fallback.

Relationship candidates are still filtered through the existing safe-relative-path and semantic-discovery boundary, and the existing strongest-score deduplication keeps one file when multiple evidence sources select it. No graph recursion, persistent index, parser/LSP service, embedding store, new public tool, new context intent, process authority, network authority, provider authority, or filesystem authority was added.

Runtime/protocol/public MCP surface remain `0.1 / 2026-07-28 / 0.10`.

## TDD evidence

The existing focused `context.build` suite passed at 13/13 before changes. A new representative graph test was then added first and failed exactly because the old implementation ranked changed/config/lexical candidates while ignoring the direct repository graph.

The GREEN implementation added explicit internal tiers plus a single-pass direct-relationship selector. The focused suite then passed, and two boundary tests were added to prove that valid direct relationships remain usable when workspace evidence is incomplete and that A -> B -> C never causes C to be claimed as a direct dependency of A.

Final focused result: `16/16` PASS.

## Verification

Fresh verification on the implementation tree:

- capability package tests: `39` files / `356` tests PASS;
- capability package typecheck: PASS;
- complete TypeScript/Vitest suite: `118` files / `823` tests PASS;
- root `pnpm run typecheck`: PASS;
- root `pnpm run build`: PASS;
- `cargo test --workspace -- --test-threads=1`: PASS across the complete Rust workspace;
- `git diff --check`: PASS.

Build/test output contains only pre-existing Rust dead-code/unused warnings; no new compiler or test failure was introduced.

## Inspection-scope measurement gate

The focused plan allowed a target-scoped inspection optimization only if measurement showed a non-regressing improvement. Live KodeGPT evidence did not satisfy that gate.

A whole-workspace inspection at a deliberately bounded entry budget hit entry pressure. A scoped `packages/capabilities` inspection was more locally focused, but it omitted root-level governing manifests/configuration and still encountered symbol-pressure evidence. Because preserving governing root evidence is required for context correctness, production inspection scope is intentionally unchanged in this phase.

The same evidence also does not justify any new context intent. The existing `understand`, `implement`, `debug`, `review`, and `verify` intents remain unchanged.

## Review

The complete diff was reviewed through CodexPro. The production change is confined to the existing `context.build` candidate selector and its tests. Public result schemas are unchanged; new relationship reasons use the existing `ContextSelectedFile.reason` string field. The implementation reuses already-computed repository evidence rather than adding another repository-analysis subsystem.

## Remaining closure

Before final phase closure:

1. push the exact branch and create a PR;
2. require deterministic CI PASS;
3. merge using exact-head protection;
4. reconcile canonical `main` to the merge commit;
5. cut over an immutable merged-main release through the existing service lifecycle;
6. live-dogfood `context.build` on representative targets and confirm direct relationships rank before weaker lexical evidence while health/surface remain unchanged.
