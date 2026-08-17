# KodeGPT Four-Priority Followthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close trusted Node+Rust toolchain composition, reconcile current planning authority, add bounded repository impact intelligence, and add bounded typed GitHub Actions mutations through release/live acceptance.

**Architecture:** Preserve the existing retained-root/Bubblewrap runtime and extend only trusted-mode sandbox materialization with additional already-validated toolchain roots. Add `code.impact` as a small read-only composition over repository analysis/search, and extend the existing Remote-CI service/adapter/HTTP path with fixed single-attempt typed mutations. Public additions bump MCP semantic surface once from `0.9` to `0.10`.

**Tech Stack:** Rust runtime/sandbox, TypeScript, Zod, Vitest, MCP server, GitHub Actions REST through existing `fetch` transport and existing `gh` credential helper.

## Global Constraints

- Canonical baseline is exact main `39b4a4ea04d206fac50bbb3c7cbda0c922cec0aa` (PR #26 merge), remote main independently confirmed at the same OID with passing run `32016870316`.
- Never inherit host PATH or arbitrary host environment into sandbox children.
- Bubblewrap, retained-root `/workspace`, private `HOME=/home/kodegpt`, executable trust/revalidation, audit, cancellation, output spool, and filesystem boundaries remain authoritative.
- Auxiliary Node/Rust toolchain composition applies only to effective `trusted`; `observe` and `develop` behavior does not widen.
- Repository impact stays deterministic, bounded, read-only, dependency-free, and network-free; no compiler/Tree-sitter/background index/watch/plugin framework.
- CI mutations reuse the existing Remote-CI repository resolver, `gh` credential provider, redaction, and audit. No generic REST/GraphQL, `gh api`, provider.invoke, arbitrary method/URL/header input, or new credential path.
- CI mutation requests are single-attempt. Ambiguous post-dispatch network outcome is surfaced distinctly and must not be automatically retried.
- Use TDD: every production behavior change begins with a focused failing test and observed RED output.
- Make small logical commits after focused GREEN verification and exact diff review.

---

### Task 1: Reconcile active planning authority and lock P0 reproduction

**Files:**
- Modify outside tracked feature chronology: `.ai-bridge/current-plan.md`
- Existing evidence: `docs/superpowers/specs/2026-08-17-kodegpt-trusted-toolchain-impact-ci-mutation-design.md`

**Interfaces:**
- Consumes: canonical PR #25/#26 history and exact baseline/CI evidence.
- Produces: current execution authority naming this branch and Tasks 2-5 without overwriting historical closure documents.

- [ ] **Step 1: Rewrite only the active current-plan** to identify PR #25/#26 as completed history, retain the prior PR #23 closure as historical evidence, record the reproduced `verify.run(package:test)` `spawnSync cargo ENOENT`, and list trusted-toolchain → impact → CI mutation → release phases.
- [ ] **Step 2: Read back the active plan** and verify it does not claim Post-PR23 is canonical current state.
- [ ] **Step 3: Keep chronology intact** by not editing old closure/spec documents merely to modernize dates/state.

### Task 2: Trusted multi-toolchain sandbox composition

**Files:**
- Modify: `crates/sandbox/src/executable.rs`
- Modify: `crates/sandbox/src/bubblewrap.rs`
- Modify: `crates/runtime/src/process.rs`
- Tests: `crates/sandbox/src/bubblewrap.rs` module tests
- Tests: `crates/runtime/src/process.rs` module tests and existing `tests/security/process-policy.test.ts` only if contract assertions are needed

**Interfaces:**
- Consumes: `resolve_trusted_executable(name) -> TrustedExecutable`, existing explicit Node/Rust roots, current `SandboxLaunchSpec`.
- Produces: `SandboxLaunchSpec` auxiliary trusted executables and deterministic read-only multi-root materialization for trusted mode.

- [ ] **Step 1: Write RED sandbox test** with fake explicit Node and Rust roots. Launch a primary Node/pnpm-like executable and require a nested `cargo` lookup/execution to succeed while a host-only PATH sentinel directory is absent from child PATH. Run the exact Rust test and observe failure because only the primary explicit root is mounted.
- [ ] **Step 2: Write RED policy-selection test** around a small helper in runtime that expresses: trusted collects resolvable allowed Node/Rust toolchain executables; develop/observe collect none. Observe failure before helper exists.
- [ ] **Step 3: Add minimal explicit-root identity surface** in `executable.rs` sufficient for Bubblewrap to deduplicate validated explicit roots deterministically; do not expose host search paths publicly.
- [ ] **Step 4: Extend `SandboxLaunchSpec`** with auxiliary `TrustedExecutable` values. In `run_process`, populate them only for `ProfileName::Trusted` from the fixed Node/Rust logical-name set when each name is already allowed by policy and resolves successfully. Auxiliary resolution failure means “not available” and does not grant fallback authority.
- [ ] **Step 5: Materialize unique explicit roots** read-only under deterministic child mount points. Construct PATH solely from mounted `<child-root>/bin` entries followed by `FIXED_PATH`; resolve the primary child program through its corresponding mount. Enable validated Corepack support when a mounted Node toolchain requires it. Revalidate every mounted trusted executable/root before spawning.
- [ ] **Step 6: Run focused Rust tests** for sandbox and runtime; confirm nested Node→Rust and trusted-shell→Node/Rust composition pass, reserved env/PATH tests remain green, and develop/observe tests remain unchanged.
- [ ] **Step 7: Run focused TypeScript security/profile tests** that pin trusted versus develop/observe executable policy.
- [ ] **Step 8: Exact diff review and commit** as a P0-only logical commit, e.g. `fix(sandbox): compose trusted toolchains`.

### Task 3: Bounded `code.impact`

**Files:**
- Modify: `packages/capabilities/src/contracts.ts`
- Modify: `packages/capabilities/src/schemas.ts`
- Create: `packages/capabilities/src/code-impact.ts`
- Create: `packages/capabilities/src/code-impact.test.ts`
- Modify: `packages/capabilities/src/native-capability-service.ts`
- Modify: `packages/capabilities/src/index.ts`
- Modify: `packages/mcp-server/src/tool-context.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Tests: `packages/mcp-server/src/structured-results.test.ts`, capability contracts/tests, integration/security surface tests as required

**Interfaces:**
- Produces:
  - `CodeImpactInput { workspaceId, target, kind?: "file"|"symbol"|"auto", path?, maxResults? }`
  - `CodeImpactResult { schemaVersion:1, target, dependents, relatedTests, affectedAreas, truncated, truncationReasons }`
  - `NativeCapabilityService.impactCode(input)` and MCP `code.impact`.
- Consumes: `inspectWorkspace(...)`, `searchCode(...)`, existing repository `relationships` and code-search result modes.

- [ ] **Step 1: Write RED contract/schema tests** for valid file/symbol inputs, strict unknown-field rejection, safe path/symbol bounds, `maxResults` bounds, output ordering/truncation invariants.
- [ ] **Step 2: Write RED behavior tests** using in-memory workspace adapters for: reverse TS import dependent, reverse Rust module dependent, direct related test, symbol definition/reference, stable affected area derivation, deterministic deduplication, and each result bound/truncation reason.
- [ ] **Step 3: Implement minimal `code-impact.ts`** by composing `inspectWorkspace` and `searchCode`. File targets reverse existing relationships; symbol targets resolve bounded definitions/references. Derive affected areas only from normalized impacted paths. No new parser/index/storage/network.
- [ ] **Step 4: Wire `NativeCapabilityService`** and exports without changing unrelated capability behavior.
- [ ] **Step 5: Add MCP tool** `code.impact` with read-only annotations and typed input/output schema; wire unavailable adapter fallback and tool context.
- [ ] **Step 6: Run focused capability + MCP tests** and exact diff review.
- [ ] **Step 7: Commit** as one logical repository-impact commit, e.g. `feat(capabilities): add bounded code impact`.

### Task 4: Bounded GitHub Actions mutations

**Files:**
- Modify: `packages/capabilities/src/errors.ts`
- Modify: `packages/capabilities/src/adapters.ts`
- Modify: `packages/capabilities/src/remote-ci/contracts.ts`
- Modify: `packages/capabilities/src/remote-ci/schemas.ts`
- Modify: `packages/capabilities/src/remote-ci/github-http.ts`
- Modify: `packages/capabilities/src/remote-ci/github-adapter.ts`
- Modify: `packages/capabilities/src/remote-ci/service.ts`
- Modify: `packages/capabilities/src/remote-ci/production.ts`
- Modify: `packages/capabilities/src/remote-ci/index.ts`
- Tests: corresponding `contracts.test.ts`, `github-http.test.ts`, `github-adapter.test.ts`, `service.test.ts`, production/integration/redaction tests
- Modify: `packages/mcp-server/src/annotations.ts`
- Modify: `packages/mcp-server/src/tool-context.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Tests: MCP structured result/surface/security/integration tests

**Interfaces:**
- Produces:
  - `ci.rerun({workspaceId?, runId, failedOnly?})`
  - `ci.cancel({workspaceId?, runId})`
  - `ci.dispatch({workspaceId?, workflow, ref, inputs?})`
  - small typed acknowledgement result and dedicated `CI_MUTATION_OUTCOME_UNKNOWN` error.
- Consumes: existing resolved repository identity, workspace root, `GitHubGhCredentialProvider`, `GitHubRemoteCiAdapter`, `GitHubHttp`, durable Remote-CI audit.

- [ ] **Step 1: Write RED schema/contract tests** enforcing decimal run IDs, safe workflow/ref strings, bounded dispatch input key count/key length/value length, strict unknown-field rejection, and no generic endpoint/method/header fields.
- [ ] **Step 2: Write RED HTTP tests** for one fixed authenticated POST helper: exact API origin/path, GitHub headers, optional bounded JSON body, redirect rejection, operation-specific definitive acceptance status (`201` rerun, `202` cancel, `200` workflow dispatch on the pinned GitHub API version), definite 4xx/5xx mapping, and network exception mapping to `CI_MUTATION_OUTCOME_UNKNOWN`. Assert fetch is called exactly once for mutation failure/ambiguity.
- [ ] **Step 3: Write RED adapter tests** proving exact fixed paths only:
  - `/repos/{owner}/{repo}/actions/runs/{id}/rerun`
  - `/repos/{owner}/{repo}/actions/runs/{id}/rerun-failed-jobs`
  - `/repos/{owner}/{repo}/actions/runs/{id}/cancel`
  - `/repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches`
  with typed provider request count exactly 1.
- [ ] **Step 4: Write RED service tests** proving decision audit precedes mutation, success/failed follows it, existing `gh` credential source is reused, dispatch input values never appear in audit, and ambiguous outcomes are not retried.
- [ ] **Step 5: Implement minimal mutation contracts/schemas** and add `CI_MUTATION_OUTCOME_UNKNOWN`.
- [ ] **Step 6: Implement single-attempt `GitHubHttp` mutation request** separate from read behavior; never add automatic mutation retry.
- [ ] **Step 7: Implement adapter/service/production methods** for rerun, cancel, dispatch with fixed endpoints and bounded acknowledgement only.
- [ ] **Step 8: Add MCP mutation annotations and tools**; do not expose generic provider or HTTP controls.
- [ ] **Step 9: Run focused Remote-CI/MCP/security tests** and exact diff review.
- [ ] **Step 10: Commit** as one logical CI mutation commit, e.g. `feat(ci): add bounded actions mutations`.

### Task 5: Surface/version/current-plan reconciliation

**Files:**
- Modify: `packages/mcp-server/src/surface-version.ts`
- Modify: `packages/mcp-server/src/server.test.ts`
- Modify: `tests/security/security-invariants.test.ts`
- Modify: `tests/integration/provider-gateway.test.ts`
- Modify: any exact surface/structured-result fixture whose locked public tool list changes
- Modify: `.ai-bridge/current-plan.md`
- Modify only necessary tracked design/implementation docs/tracker lines that describe current public surface

**Interfaces:**
- Produces: `MCP_SURFACE_VERSION = "0.10"`, exactly four new public tools versus 0.9, no generic authority.

- [ ] **Step 1: Write/update RED surface tests first** expecting `0.10` and exact presence of `code.impact`, `ci.rerun`, `ci.cancel`, `ci.dispatch`, with no generic `provider.*`, raw HTTP, REST, GraphQL, or shell additions.
- [ ] **Step 2: Bump surface constant once** to `0.10`; leave MCP protocol `2026-07-28` unchanged.
- [ ] **Step 3: Reconcile exact public tool count/fixtures** and native skill capability registry only if it explicitly enumerates public native capability names.
- [ ] **Step 4: Update active current-plan** to reflect completed local phases and remaining verification/PR/release gates without rewriting historical chronology.
- [ ] **Step 5: Exact diff review and commit** docs/version reconciliation separately if it makes review clearer.

### Task 6: Verification, PR/CI, merge, release, and live acceptance

**Files:**
- No feature behavior additions. Closure docs only after evidence exists.

**Interfaces:**
- Consumes: exact candidate feature HEAD.
- Produces: merged canonical main, passing merged-main CI, immutable release cutover, live acceptance evidence.

- [ ] **Step 1: Load `verification-before-completion`** and run focused tests for every changed subsystem from a clean candidate.
- [ ] **Step 2: Run full TypeScript gates:** `pnpm run typecheck`, `pnpm run build`, `pnpm run test`.
- [ ] **Step 3: Run full Rust gates:** `cargo fmt --all -- --check`, `cargo test --workspace` (and `cargo check --workspace` if repository gate requires it).
- [ ] **Step 4: Run repository security/integration/package gates** including forbidden-patterns and existing deterministic package smoke/release checks.
- [ ] **Step 5: Review exact complete diff**; use `requesting-code-review`/review workflow and resolve actionable findings with TDD.
- [ ] **Step 6: Ensure branch clean, push without force, create PR through existing bounded GitHub write surface when possible, and require exact feature-head CI success.
- [ ] **Step 7: Merge only the exact reviewed head** through guarded `github.pr.merge`; verify canonical remote merge OID and merged-main CI success.
- [ ] **Step 8: Fast-forward canonical local `main` to the exact merge commit**; preserve branch/worktree until post-merge acceptance finishes.
- [ ] **Step 9: Build/stage immutable release through existing service lifecycle, record rollback release, explicitly cut over/restart, and verify service health/runtime/protocol/surface `0.1 / 2026-07-28 / 0.10`.
- [ ] **Step 10: Live acceptance:**
  - run `verify.run(package:test)` and prove nested `cargo ENOENT` is gone;
  - run `code.impact` on a real KodeGPT file/symbol and inspect bounded deterministic evidence;
  - dogfood safe CI mutation(s): rerun a known workflow run and cancel only if an active run exists; dispatch only if the repository has a dispatch-enabled workflow. Use official stdio bridge from the active immutable release if this ChatGPT conversation caches the old MCP surface.
- [ ] **Step 11: Inspect durable audit/redaction evidence** for CI mutations and ensure no credentials/dispatch values leaked.
- [ ] **Step 12: Reconcile closure/current-plan/tracker docs from actual evidence**, commit/push closure if tracked, require final main CI success.
- [ ] **Step 13: Use `finishing-a-development-branch`** to remove the merged worktree/branch safely only after release/live gates pass.

## Self-review

- Spec coverage: every requested priority maps to Tasks 1-5; full PR/CI/merge/release/live acceptance maps to Task 6.
- No dependency/index/framework expansion is introduced.
- Multi-toolchain scope is trusted-only and does not import host PATH/environment.
- CI mutation semantics are explicitly single-attempt with ambiguous outcome distinct from definite failure.
- Public versioning is a single semantic surface bump to `0.10`; runtime protocol remains unchanged.
- Plan contains no deferred implementation placeholders; optional dogfood is conditional only on real repository workflow/run state, not on implementation completeness.
