# Context Quality Benchmark — Readiness

Status date: 2026-08-18  
Branch: `feat/context-quality-benchmark`  
Baseline: merged PR #35, `c744687291c05c3910d71671c6e54dd75590e9be`  
Implementation commit: `afbff66358a808d6ecf75fd359f59af5498d5a1d`  
Status: benchmark implementation and local verification complete; ready for PR/CI.

## Scope

This phase adds measurement only; it does not change production selection logic.

Two existing testing paths are extended:

1. `tests/performance/context-quality.test.ts` adds a deterministic offline quality benchmark around the public `context.build` behavior. Three representative scenarios combine direct relationships, changed files, lexical/path noise, semantic-excluded noise, and incomplete workspace evidence.
2. `tests/performance/baseline.mjs` now records `context.build` latency alongside the existing record-only runtime/MCP measurements.

No benchmark database, persistent result service, parser/indexer, new runtime tool, timing gate, or production authority is introduced.

## Quality envelope

The offline benchmark is intentionally improvement-friendly rather than an exact-order golden snapshot. Across the three scenarios it requires:

- critical evidence recall@5 = `1.0`;
- maximum critical rank <= `5`;
- mean critical rank <= `3.5`;
- zero duplicate selected paths;
- zero semantic-excluded noise selections;
- incomplete workspace evidence remains explicitly incomplete/truncated while valid direct relationships remain usable.

This locks the user-visible quality properties that motivated relationship-aware context without preventing future ranking improvements.

## Performance baseline

The existing baseline remains `record-only`: five warmups and thirty measured iterations, with median/p95/min/max reported but no pass/fail latency threshold.

A fresh end-to-end run on the current host completed successfully and recorded `contextBuild` at:

- iterations: `30`;
- median: `79.818 ms`;
- p95: `85.712 ms`;
- min: `74.456 ms`;
- max: `90.441 ms`.

The same run reported runtime `0.1`, protocol `2026-07-28`, Bubblewrap `0.11.2`, and completed with exit code 0. These numbers are evidence for comparison, not a machine-independent acceptance threshold.

## Verification

Fresh verification on the benchmark tree:

- focused performance tests: `2` files / `3` tests PASS;
- full TypeScript/Vitest suite: `119` files / `826` tests PASS;
- root `pnpm run typecheck`: PASS;
- end-to-end `node tests/performance/baseline.mjs`: PASS and emits the new `contextBuild` measurement;
- `git diff --check`: PASS.

The parent actionable-errors phase had already passed full build/Rust/security CI before this test-only branch was cut. This benchmark phase changes no production TypeScript/Rust implementation.

## Review

Complete-diff review through CodexPro found only two benchmark assets changed. The quality test uses bounded synthetic repository evidence and the same exported `buildContext` implementation used by production. The latency extension invokes the existing public MCP `context.build` tool through the established baseline harness.

Timing remains record-only to avoid host-dependent/flaky CI. Quality thresholds are deterministic structural properties and therefore suitable for regression gating.

## Remaining closure

1. commit the evidence docs separately from the benchmark implementation;
2. push the exact branch and create a focused PR against `main`;
3. require deterministic CI PASS;
4. merge with exact-head protection and fast-forward canonical `main`;
5. no service cutover is required for this test/measurement-only phase because production runtime bytes and public surface are unchanged.
