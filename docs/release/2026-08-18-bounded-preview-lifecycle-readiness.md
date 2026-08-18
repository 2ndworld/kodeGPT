# Bounded Preview Lifecycle — Pre-Merge Readiness

Date: 2026-08-18
Branch: `feat/bounded-preview-lifecycle`
Base: `18748701c0558d3a86d3be20e4e7630e80532572` (merged PR #38 baseline)
Target runtime / protocol / MCP surface: `0.1 / 2026-07-28 / 0.11`
Target public tool count: 65

## Scope

This phase implements exactly three new semantic MCP tools:

- `preview.start`
- `preview.inspect`
- `preview.stop`

The implementation composes the existing `ExecutionManager` background-process authority. It adds no Rust RPC, no new dependency, no persistent preview supervisor, no generic HTTP client, no arbitrary host/origin/URL input, no browser/desktop control, no provider change, and no agent/worktree orchestration.

A preview binds an opaque `pv_<32 hex>` identity to one workspace process operation and one fixed loopback endpoint of the form `http://127.0.0.1:<explicit-port><canonical-path>`.

## Audit-driven roadmap decision

The initial application-development roadmap was audited before implementation. The audited order is:

1. Bounded Preview Lifecycle — this phase.
2. Preview-Scoped Browser Evidence.
3. Visual Verification.
4. Typed Preview Deployment adapters through the existing Provider Gateway.

Agent/worktree orchestration and core Figma/design integration were removed from the KodeGPT core roadmap because they duplicate host reasoning/orchestration responsibilities and would change KodeGPT's product class.

## Review-driven hardening

Exact source review after the first green implementation found and closed four issues test-first:

1. workspace close now releases only that workspace's in-memory preview identities after existing workspace/process cleanup succeeds;
2. request paths are canonical absolute-path/reference values and reject `//host`, raw spaces, fragments, controls, or values requiring URL normalization;
3. production performs a bounded TCP preflight against `127.0.0.1:<port>` without reading payload data and rejects an already-listening endpoint as `PREVIEW_ENDPOINT_IN_USE` before process launch, preventing readiness from being attributed to a pre-existing local service;
4. the 32-session bound includes in-flight starts, preventing concurrent start races from creating a 33rd session.

Known preview lifecycle errors are normalized at the MCP boundary to stable public codes without relying on raw internal error messages:

- `PREVIEW_NOT_FOUND`
- `PREVIEW_LIMIT_REACHED`
- `PREVIEW_ENDPOINT_IN_USE`

## Verification

Fresh final evidence after review hardening:

- `@kodegpt/core` tests: 61/61 PASS, including 22 PreviewManager tests.
- `@kodegpt/mcp-server` tests: 34/34 PASS.
- Complete TypeScript/Vitest suite excluding the known nested-full-stack file: 119 files / 851 tests PASS.
- Root TypeScript typecheck: PASS across all workspace projects.
- Root build: PASS, including packaged CLI/runtime build.
- `cargo fmt --all -- --check`: PASS.
- `cargo check --workspace`: PASS; existing warning set only.
- `node scripts/forbidden-patterns.mjs`: PASS.
- `node scripts/package-smoke.mjs`: PASS.
- `git diff --check`: PASS.
- Production-scope review found no changes under `crates/`, `packages/protocol/`, `packages/capabilities/`, root `package.json`, or `pnpm-lock.yaml`.

### Environment-only gates proved by A/B baseline

Running nested full-stack/runtime sandbox tests *through the already-sandboxed live KodeGPT process* is not an authoritative host Rust/full-stack gate on this acceptance path.

`tests/integration/full-stack.test.ts` fails 2/2 on the feature worktree and fails identically 2/2 on unchanged canonical `main`: verification recipes report `SANDBOX_UNAVAILABLE`, and the Remote-CI fixture path returns the same non-JSON capability failure. This is baseline nested-sandbox behavior, not a preview regression.

Likewise, `cargo test --workspace -- --test-threads=1` from inside KodeGPT fails on both candidate and unchanged canonical `main` with the same Bubblewrap error (`Bubblewrap did not publish a host child PID`): 57 passed / 32 failed / 3 ignored in the runtime binary test set. CI/host execution remains the authoritative complete Rust/full-stack gate. The feature changes no Rust source.

## Review status

CodexPro was retried for independent high-context review but repeatedly returned upstream HTTP 502. Review therefore used exact Git diff, full new-file inspection, targeted RED/GREEN regressions, closed MCP surface/security guards, scope scans, and fresh verification. No independent CodexPro approval is claimed.

## Pre-merge decision

**READY FOR PR/CI.**

The candidate is not yet claimed live. Merge, immutable merged-main release staging, explicit service cutover, and real preview lifecycle dogfood remain required before final closure.
