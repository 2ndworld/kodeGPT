# Preview-Scoped Browser Evidence Implementation Plan

Date: 2026-08-18
Design: `docs/superpowers/specs/2026-08-18-kodegpt-preview-scoped-browser-evidence-design.md`

## Task 1 — Private binary artifact ingestion

Files: `crates/runtime/src/dispatcher.rs`, runtime integration tests, `packages/artifacts/src/artifact-store.ts`, artifact tests. Canonical runtime protocol/schema files remain unchanged.

1. RED: add artifact-store test that writes bytes and expects opaque metadata; add dispatcher integration tests proving canonical base64, 5 MiB hard cap, media type validation, readback and audit without content; assert canonical runtime protocol parity remains unchanged.
2. Run focused tests and confirm expected failures.
3. GREEN: add a private dispatcher-only kernel extension and `ArtifactStore.write`; reuse the existing spool writer and artifact metadata without adding a canonical protocol method.
4. Run focused TS + Rust tests and typecheck.

## Task 2 — BrowserManager behavior with injected browser driver

Files: new `packages/core/src/browser-manager.ts`, new `browser-manager.test.ts`, `packages/core/src/index.ts`.

1. RED: tests for live preview binding, exact loopback origin, session cap/idempotent open, missing session, CSS/role targets, click/type, evidence bounds, screenshot artifact write, screenshot cap, lifecycle release, popup/navigation enforcement, disconnect cleanup.
2. GREEN: implement browser-domain interfaces plus `BrowserManager` using an injectable driver abstraction. Keep Playwright-specific code out of behavioral tests.
3. Refactor only after focused tests are green.

## Task 3 — Playwright production adapter and dependency spike

Files: `packages/core/package.json`, lockfile, new `packages/core/src/playwright-browser-driver.ts`, focused adapter tests/spike helper if needed.

1. Add exact `playwright-core` dependency only (no bundled browser download).
2. Implement production driver using `chromium.launch({channel:"chrome", headless:true, chromiumSandbox:true})`, explicit context, downloads disabled, fixed default timeout, console/requestfailed listeners, document-navigation route guard, popup closure, `page.ariaSnapshot()`, locators and screenshot buffer.
3. Run a host compatibility spike against a real KodeGPT preview. If system Chrome cannot satisfy sandbox/Playwright compatibility, stop rather than weakening with `--no-sandbox` or arbitrary executable paths.

## Task 4 — Production wiring and lifecycle composition

Files: production stack in core/CLI startup plus `packages/mcp-server/src/tool-context.ts` and tests.

1. RED: production wiring test plus context tests that browser release occurs before successful preview stop and on successful workspace close, while failed close/stop does not silently corrupt ownership.
2. GREEN: construct BrowserManager with PreviewManager + ArtifactStore + Playwright driver; inject browser tool context; compose release hooks deterministically.

## Task 5 — MCP surface 0.12

Files: `packages/mcp-server/src/tools.ts`, `surface-version.ts`, server/structured-results tests, any capability snapshot fixtures.

1. RED: exact seven browser tool names/required fields and total count 72; surface version 0.12; schema rejects URL/host/evaluate and malformed target/oversized text; dispatch tests for all methods and stable error mapping.
2. GREEN: register seven tools with bounded Zod schemas and appropriate read/process-like annotations; add context adapter.
3. Run MCP focused suite.

## Task 6 — Phase verification and review

1. `pnpm --filter @kodegpt/artifacts test`, `pnpm --filter @kodegpt/core test`, `pnpm --filter @kodegpt/mcp-server test`.
2. `cargo test -p kodegpt-protocol -p kodegpt-runtime`.
3. `pnpm typecheck`.
4. `pnpm test` full non-baseline suite.
5. Review exact diff for authority widening, host paths, arbitrary URLs/JS, no-sandbox flags, hidden persistence, artifact leakage, unbounded evidence.
6. Commit, push, PR/CI/merge only after all gates green and real browser-preview dogfood passes.

Phase 3 must not begin until Phase 2 is merged/reconciled and live evidence has demonstrated the local browser feedback loop.
