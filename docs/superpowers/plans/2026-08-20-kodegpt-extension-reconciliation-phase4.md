# KodeGPT Extension Reconciliation Phase 4 Plan

**Goal:** Remove the dead metadata-only extension registry/public tool after source and live evidence proved it has no production writer or policy consumer, while preserving the useful Agent Skills extensibility path.

## Evidence / compatibility decision

- Live service remains `0.16 / 75 tools` and `extension.list` returns `[]`.
- `ExtensionRegistry.enable/disable` have no production callers; only tests call them.
- `profileRestrictions` are parsed but never consumed by runtime/profile enforcement.
- Production startup only opens the registry so MCP can expose `extension.list`.
- `packages/extensions` has no dependencies and is referenced only by CLI startup and MCP context typing.
- The approved continuity design explicitly permits deprecation/removal as a separate compatibility decision when live consumer evidence supports it.
- Surface `0.17` is still an unreleased candidate, so Phase 4 reconciles inside the same semantic bump rather than inventing `0.18`.

## Final candidate contract

- runtime `0.1`
- MCP protocol `2026-07-28`
- semantic surface `0.17`
- exactly `75` public tools
- add `workspace.checkpoint`
- remove `extension.list`
- no `extension.run`, plugin VM, dynamic handler loader, arbitrary runtime registration, or replacement extension subsystem
- Agent Skills remain the extensibility mechanism.

## Task 1 — Lock the reconciled surface in tests (RED)

- Update `packages/mcp-server/src/server.test.ts` to remove `extension.list` and expect 75 tools.
- Update `tests/fixtures/mcp-surface.ts`, `tests/security/security-invariants.test.ts`, and `tests/integration/provider-gateway.test.ts` to the same final inventory/count.
- Update `tests/integration/full-stack.test.ts` so full-stack no longer calls `extension.list`; keep skill/workspace capability coverage.
- Run focused surface/security tests and confirm RED against the still-present extension implementation.

## Task 2 — Remove production extension wiring

- Remove `extension.list` from `packages/mcp-server/src/tools.ts` and delete `ExtensionToolContext` / `ExtensionRegistryToolAdapter` / `extension` from `KodegptToolContext`.
- Remove `ExtensionRegistry` import, `prepareExtensionRegistry`, startup open, stack exposure, and related test fixtures from `apps/cli/src/commands/start.ts` and startup tests.
- Remove `@kodegpt/extensions` from `apps/cli/package.json`.
- Delete `packages/extensions` entirely.
- Reconcile `pnpm-lock.yaml` with a lockfile-only workspace update; inspect the diff and reject unrelated dependency churn.

## Task 3 — Documentation reconciliation

- Append the Phase 4 evidence-based decision to `docs/superpowers/specs/2026-08-20-kodegpt-developer-environment-continuity-design.md`: final candidate stays `0.17` but returns to 75 tools because checkpoint replaces the dead extension tool one-for-one.
- Update current architecture/compatibility documentation only where it describes the candidate/current public surface; do not rewrite historical readiness/spec records.

## Task 4 — Regression / closure

Run:

```text
pnpm --filter @kodegpt/mcp-server test
pnpm --filter kodegpt test
pnpm exec vitest run tests/security/security-invariants.test.ts tests/integration/provider-gateway.test.ts
pnpm -r typecheck
pnpm run verify:forbidden
pnpm run build
cargo check --workspace
cargo fmt --all -- --check
git diff --check
```

Verify source/generated inventory exactly `0.17 / 75 unique tools`, no `extension.list`, no `@kodegpt/extensions`, no `packages/extensions`, and no legacy Developer Environment resolver env hints.

Host/CI-only merge gates remain `cargo test --workspace`, root `pnpm test`, and `pnpm run verify:package` outside nested Bubblewrap.
