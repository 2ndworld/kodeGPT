# KodeGPT Public Surface Reduction Implementation Plan

**Goal:** Remove public `file.search` and typed Netlify preview deployment while retaining private lexical search and the GitHub provider gateway.

**Spec:** `docs/superpowers/specs/2026-08-20-kodegpt-public-surface-reduction-design.md`

## Task 1 — Lock the intended public surface

1. Update MCP surface tests/fixtures first to expect surface `0.16`, 75 tools, and absence of the three removed tools.
2. Update provider registry tests first to expect only GitHub read/write manifests.
3. Run focused tests and verify RED against current source.

## Task 2 — Remove public `file.search` only

1. Remove MCP `file.search` registration/snapshot entry.
2. Keep runtime protocol, Rust dispatcher/audit, core `searchBounded`, and code-search adapters unchanged.
3. Add/retain integration coverage proving `code.search(mode:"text")` still traverses the private runtime search path.

## Task 3 — Remove Netlify deployment stack

1. Remove deploy schemas/types/context from MCP server.
2. Remove deploy startup composition from CLI.
3. Remove Netlify manifest/tool adapter source and their exports/tests.
4. Remove Netlify from `PRODUCTION_PROVIDER_MANIFESTS`.
5. Reconcile affected provider/startup/security/stdio tests without weakening GitHub provider assertions.

## Task 4 — Reconcile current docs/version fixtures

1. Set MCP surface version to `0.16` and service runtime compatibility to accept it.
2. Update current architecture/ChatGPT compatibility docs with the public/private search boundary and provider-specific deployment removal.
3. Do not rewrite historical specs/plans/readiness records.

## Task 5 — Verify

Run focused MCP/provider/startup/integration tests, full Vitest shards, typecheck, build, forbidden scan, package smoke, `cargo fmt --check`, `cargo check --workspace`, `cargo test --workspace`, and `git diff --check`.

Dogfood through MCP must prove:
- public surface has 75 tools;
- removed tool calls are unavailable;
- `code.search(mode:"text")` remains functional;
- GitHub provider runtime still starts with its two production manifests.
