# KodeGPT Sequential Task Audit — 2026-08-15

Audit baseline: `7ea156e76abf46bc078d183f8748206c1ce15052` (`main == origin/main` at audit start). Historical tag: `v0.1^{}` = `b8eae12cea3be002a9a61d06cecfd34f86283eb4`.

This ledger is evidence-driven. Historical tracker status is treated as supporting evidence only; current source/tests/runtime and fresh host evidence govern verdicts.

## Fresh audit evidence

- canonical `main` clean and equal to `origin/main` at `7ea156e76abf46bc078d183f8748206c1ce15052` after `git fetch origin --prune`.
- `v0.1^{}` unchanged at `b8eae12cea3be002a9a61d06cecfd34f86283eb4`.
- Draft PR #11 head remains `b10aa03e336a46004588fbb9a140ba806c28a0c0` and base remains `7ea156e76abf46bc078d183f8748206c1ce15052`.
- exact PR #11 candidate fresh verification: typecheck PASS; Vitest 86/459 PASS; Rust workspace PASS; protocol 12/12 PASS; integration 33/33 PASS; security 43/43 PASS; isolation 3/3 PASS; acceptance 5/5 PASS; forbidden scan PASS; package smoke PASS; rustfmt PASS.
- live host after exact-candidate cutover: `health.ok=true`, `auditHealthy=true`, `filesystemBoundaryAvailable=true`, runtime `0.1`, protocol `2026-07-28`, surface `0.4`; `git.changes`, `git.log`, `git.show`, `git.status`, `git.diff` PASS.

## Original v0.1 Tasks 1–25

## Task 1 — Independent monorepo / state / isolation guard

Authority:
- plan/spec: `docs/superpowers/plans/2026-08-09-kodegpt-v0.1-detailed-execution-plan.md`
- tracker: `docs/implementation/v0.1-execution-tracker.md`
- source: workspace manifests, `packages/core/src/state-version.ts`, isolation guard
- tests: state-version + external-state-guard + full suite
- historical PR/commit: foundation `184b925a295cfcbacfb3d002cb7978d863bea3a2`

Current verdict: PASS

Audit findings:
- repository/state namespace remains independent; no later capability/service/history code introduces a second external runtime authority.
- schema-version and external-state guard regressions remain executable.

Focused verification:
- command: fresh full Vitest + isolation suite
- result: PASS (459/459; isolation 3/3)

Security/invariant review:
- state-root remains `~/.kodegpt`; forbidden scan PASS; no provider interoperability introduced.

Residual risks / deferred items:
- none found for Task 1.

## Task 2 — Runtime schemas + exact framing

Authority:
- plan/spec: v0.1 detailed plan
- tracker: execution tracker Task 2 evidence
- source: `packages/protocol/src/frame.ts`, `crates/protocol/src/frame.rs`, runtime schemas
- tests: protocol framing/runtime-schema tests and Rust protocol tests
- historical PR/commit: `fdd7e88`

Current verdict: PASS

Audit findings:
- closed schemas, exact framing, malformed/truncated/oversized rejection remain current after additive Git-history RPCs.

Focused verification:
- command: `pnpm test:protocol`; `cargo test --workspace`
- result: PASS (12/12 protocol; Rust protocol contract 11/11)

Security/invariant review:
- Git-history additions are structured typed requests, not argv/raw revision surfaces.

Residual risks / deferred items:
- none found.

## Task 3 — Persistent concurrent runtime

Authority:
- plan/spec: v0.1 detailed plan
- tracker: Task 3 evidence
- source: `packages/core/src/kernel-client.ts`, runtime dispatcher/RPC
- tests: KernelClient + runtime dispatcher tests
- historical PR/commit: `ae74aca`

Current verdict: PASS

Audit findings:
- persistent child, correlation, child-death behavior and production test-method exclusion remain covered; later Git-history dispatch is additive.

Focused verification:
- command: fresh full Vitest + Rust workspace
- result: PASS

Security/invariant review:
- no alternate TS filesystem/process fallback observed in current architecture.

Residual risks / deferred items:
- none found.

## Task 4 — Serialized fail-closed audit

Authority:
- plan/spec: v0.1 detailed plan
- tracker: Task 4 evidence
- source: `crates/runtime/src/audit.rs`, dispatcher audit call sites
- tests: audit foundation/redaction + Rust audit/dispatcher tests
- historical PR/commit: `3db6714`

Current verdict: PASS

Audit findings:
- decision-before-effect remains enforced for filesystem, process, Git and Git-history paths; audit poison/redaction tests remain executable.

Focused verification:
- command: `pnpm test:security`; `cargo test --workspace`
- result: PASS (43/43 security; Rust audit/dispatcher green)

Security/invariant review:
- host smoke reports `auditHealthy=true` after candidate cutover.

Residual risks / deferred items:
- release build emits pre-existing dead-code/unused warnings in test-fault-related audit code; no behavioral failure observed.

## Task 5 — Trusted workspace admission

Authority:
- plan/spec: v0.1 detailed plan
- tracker: Task 5 evidence
- source: trust store, workspace manager, root identity
- tests: workspace trust + identity/registry tests
- historical PR/commit: `42a6278fa98b1df5756a4f9a49dbbb688d6d5334`

Current verdict: PASS

Audit findings:
- device/inode identity and local-only trust mutation remain intact; current MCP inventory still lacks trust mutation.

Focused verification:
- command: security + Rust workspace + live `workspace.open`
- result: PASS

Security/invariant review:
- live host opened only an already locally trusted canonical repository.

Residual risks / deferred items:
- none found.

## Task 6 — Mount topology + retained root FD + overlap rejection

Authority:
- plan/spec: v0.1 detailed plan
- tracker: Task 6 evidence
- source: `crates/workspace-io/src/mountinfo.rs`, `registry.rs`
- tests: mountinfo/registry + sandbox boundary
- historical PR/commit: `0f3359c8bbf8c83f6cfa76a0120ce8c3d6f648ff`

Current verdict: PASS

Audit findings:
- retained-root and overlap checks remain shared by later capability/skill/history layers rather than duplicated.

Focused verification:
- command: Rust workspace; security suite
- result: PASS

Security/invariant review:
- `filesystemBoundaryAvailable=true` on live candidate host.

Residual risks / deferred items:
- none found.

## Task 7 — Two-phase lifecycle + monotonic profile restriction

Authority:
- tracker + v0.1 plan
- source: workspace registry, profiles/policy, WorkspaceManager
- tests: policy/registry/profile/full-stack
- historical PR/commit: `5538c5087adfa280a3e16820ed7f66fdd7d67571`

Current verdict: PASS

Audit findings:
- OPENING/READY/CLOSING and monotonic narrowing remain current and later features consume READY workspaces only.

Focused verification:
- command: full integration + Rust workspace
- result: PASS

Security/invariant review:
- policy tests still reject widening.

Residual risks / deferred items:
- none found.

## Task 8 — `openat2` + NO_XDEV boundary

Authority:
- tracker + v0.1 plan
- source: `crates/workspace-io/src/openat.rs`
- tests: openat/security boundary tests
- historical PR/commit: `d6254ab`

Current verdict: PASS

Audit findings:
- parent/absolute/symlink/magic-link/nested-mount/race regressions remain executable.

Focused verification:
- command: Rust workspace + security suite
- result: PASS

Security/invariant review:
- later semantic/file/skill operations continue to use retained-root primitives.

Residual risks / deferred items:
- none found.

## Task 9 — FD-relative read/tree/search

Authority:
- tracker + v0.1 plan
- source: `crates/workspace-io/src/read.rs`
- tests: read/tree/search + semantic scope tests
- historical PR/commit: `ec78253`

Current verdict: PASS

Audit findings:
- hard caps, symlink non-descent and truthful truncation remain covered; semantic traversal adds filtering without replacing literal primitives.

Focused verification:
- command: Rust workspace; capability tests in full Vitest
- result: PASS

Security/invariant review:
- audit-before-I/O retained.

Residual risks / deferred items:
- none found.

## Task 10 — Connector auth + HTTP trust

Authority:
- tracker + v0.1 plan
- source: `packages/auth`, MCP HTTP
- tests: bearer/credential/http trust + integration HTTP
- historical PR/commit: `02d7a7c`

Current verdict: PASS

Audit findings:
- verifier-only credentials, rotation, Host/Origin/body bounds remain current.

Focused verification:
- command: full Vitest + integration suite
- result: PASS

Security/invariant review:
- no credentials appeared in service status/provenance/host smoke outputs.

Residual risks / deferred items:
- none found.

## Task 11 — MCP `2026-07-28` surface

Authority:
- tracker + v0.1 plan
- source: MCP server, schemas, surface version
- tests: server/structured-results/conformance/protocol
- historical PR/commit: `51ee91d`

Current verdict: PASS

Audit findings:
- protocol remains exactly `2026-07-28`; additive semantic surface is now `0.4` as designed.

Focused verification:
- command: protocol/integration/full tests + live `system.capabilities`
- result: PASS; live `0.1 / 2026-07-28 / 0.4`

Security/invariant review:
- forbidden scan confirms no generic shell/provider/service/trust mutation surface.

Residual risks / deferred items:
- none found.

## Task 12 — Hardened Bubblewrap provider

Authority:
- tracker + v0.1 plan
- source: `crates/sandbox`
- tests: sandbox Rust + security suite
- historical PR/commit: `2f7f8b3`

Current verdict: PASS

Audit findings:
- trusted executable identity/revalidation, root-FD binding, network deny and no-shell execution remain the shared process/Git boundary.

Focused verification:
- command: Rust workspace; security suite
- result: PASS (sandbox 7/7)

Security/invariant review:
- Git-history tests verify additive `GIT_NO_LAZY_FETCH=1` without weakening current Git spec.

Residual risks / deferred items:
- none found.

## Task 13 — Kernel raw output spool

Authority:
- tracker + v0.1 plan
- source: `crates/runtime/src/spool.rs`
- tests: spool/artifact tests
- historical PR/commit: `700350c`

Current verdict: PASS

Audit findings:
- opaque IDs, protected storage, bounded source and no host path serialization remain covered.

Focused verification:
- command: Rust workspace + full Vitest
- result: PASS

Security/invariant review:
- Git status/diff host smoke returned only `artifact://` URIs.

Residual risks / deferred items:
- none found.

## Task 14 — Race-safe file mutation

Authority:
- tracker + v0.1 plan
- source: `crates/workspace-io/src/write.rs`, file capability layer
- tests: write/patch/self-protection
- historical PR/commit: `31ee853` + `30727e9`

Current verdict: PASS

Audit findings:
- atomic/conditional mutation and retained-root race protection remain green; no later feature widens authority.

Focused verification:
- command: Rust workspace + security/full Vitest
- result: PASS

Security/invariant review:
- state/workspace self-protection tests green.

Residual risks / deferred items:
- none found.

## Task 15 — Hardened read-only Git

Authority:
- tracker + v0.1 plan
- source: `crates/runtime/src/git.rs`
- tests: `tests/security/git-helper-isolation.test.ts` + Rust Git tests
- historical PR/commit: v0.1 final line

Current verdict: PASS

Audit findings:
- current-state `git.status`, `git.diff`, `git.changes` remain semantically intact after shared history-runner refactor.
- history-specific lazy-fetch hardening is additive; current Git command environment equivalence has a dedicated Rust regression.

Focused verification:
- command: security suite; Rust workspace; live `git.status`/`git.diff`/`git.changes`
- result: PASS

Security/invariant review:
- no mutation/network Git authority introduced; forbidden scan PASS.

Residual risks / deferred items:
- none found.

## Task 16 — Sandboxed process/cancel

Authority:
- tracker + v0.1 plan
- source: runtime process/execution registry
- tests: process-policy, Rust process tests
- historical PR/commit: `17b6cf5`

Current verdict: PASS

Audit findings:
- structured no-shell process, allowlists, opaque operation IDs and process-group cleanup remain green.

Focused verification:
- command: Rust workspace + security/full-stack
- result: PASS

Security/invariant review:
- Git history continues to use dedicated Git authority, not generic process execution.

Residual risks / deferred items:
- none found.

## Task 17 — Artifact facade/quota/TTL

Authority:
- tracker + v0.1 plan
- source: artifacts + runtime spool
- tests: artifact-store + spool tests
- historical PR/commit: `17b6cf5`

Current verdict: PASS

Audit findings:
- opaque facade, bounded read, quota/TTL and active-writer protection remain covered.

Focused verification:
- command: full Vitest + Rust workspace
- result: PASS

Security/invariant review:
- no private spool path leaked in live Git outputs.

Residual risks / deferred items:
- none found.

## Task 18 — Audit diagnostics/correlation

Authority:
- tracker + v0.1 plan
- source: audit reader/runtime audit
- tests: audit diagnostics/redaction
- historical PR/commit: `17b6cf5`

Current verdict: PASS

Audit findings:
- public request/operation correlation and bounded redacted diagnostics remain intact.

Focused verification:
- command: security suite + live `system.health`
- result: PASS

Security/invariant review:
- live diagnostics expose typed audit events, not authority-bearing host paths.

Residual risks / deferred items:
- none found.

## Task 19 — MCP Apps Dev Console

Authority:
- tracker + v0.1 plan
- source: dev-console + MCP Apps registration
- tests: mcp-apps/dev-console/conformance
- historical PR/commit: `17b6cf5`

Current verdict: PASS

Audit findings:
- data-only self-contained resource and text fallback remain executable; no claim is made here that fresh host UI rendering itself was observed.

Focused verification:
- command: full Vitest/integration
- result: PASS

Security/invariant review:
- host-rendering observation remains a claim-evidence category, not inferred from source.

Residual risks / deferred items:
- fresh Apps visual rendering remains unobserved in this audit and is not upgraded by inference.

## Task 20 — Declarative extensions / manual HTTPS

Authority:
- tracker + v0.1 plan
- source: extensions + exposure code/docs
- tests: extensions/manual exposure/security
- historical PR/commit: `17b6cf5`

Current verdict: PASS

Audit findings:
- manifests remain data-only; executable fields rejected; zrok managed lifecycle is an explicit later service feature rather than hidden provider abstraction.

Focused verification:
- command: full Vitest/security/integration
- result: PASS

Security/invariant review:
- no provider abstraction or service MCP mutation introduced.

Residual risks / deferred items:
- none found.

## Task 21 — Linux packaging / clean install

Authority:
- tracker + v0.1 plan; PR #11 provenance hardening
- source: runtime resolver, build scripts, service release/provenance
- tests: packaged runtime/CLI/service/package smoke
- historical PR/commit: `17b6cf5`; PR #11 candidate `b10aa03e...`

Current verdict: PASS

Audit findings:
- package-owned runtime resolver and clean package smoke remain green.
- PR #11 now makes the normal CLI build authoritative for Rust build + staging + CLI pair provenance.
- independently measured candidate bytes match manifests and immutable installed release bytes.

Focused verification:
- command: `pnpm verify:package`; `pnpm --filter kodegpt build`; independent `sha256sum`
- result: PASS; pair `pair_e23d802764179e6f7698beb2f0734ab9`, CLI SHA `21194afc...`, runtime SHA `b3ca2e0f...`, sourceDirty=false.

Security/invariant review:
- service install staged `rel_f00862...` without changing active `rel_d313...`; explicit restart then cut over.

Residual risks / deferred items:
- system-wide older `kodegpt` CLI on PATH rejected current `0.4` readiness with `invalid service runtime surfaceVersion`; exact candidate CLI works. This is recorded as an operator-version mismatch observation, not yet classified as a product defect because the established deployment procedure explicitly uses the exact candidate CLI for candidate status/install/cutover.

## Task 22 — Full security acceptance

Authority:
- tracker + v0.1 plan
- source: cross-cutting security boundaries + PR #11 provenance validation
- tests: security suite + Rust workspace
- historical PR/commit: `17b6cf5`; PR #11

Current verdict: PASS

Audit findings:
- fresh security suite and Rust workspace are green after provenance changes.

Focused verification:
- command: `pnpm test:security`; `cargo test --workspace`; `pnpm verify:forbidden`
- result: PASS (43/43 security; Rust all green; forbidden scan PASS)

Security/invariant review:
- no shell, host-path leakage, provider authority or network Git expansion found by current executable gates.

Residual risks / deferred items:
- none merge-blocking found.

## Task 23 — MCP/Apps conformance

Authority:
- tracker + v0.1 plan
- source: MCP server + surface fixtures
- tests: integration/conformance/acceptance
- historical PR/commit: `17b6cf5` plus later surface generations

Current verdict: PASS

Audit findings:
- multi-workspace, protocol, Apps capability and extension/non-UI contracts remain green at surface `0.4`.

Focused verification:
- command: `pnpm test:integration`; `pnpm test:acceptance`; live `system.capabilities`
- result: PASS

Security/invariant review:
- semantic surface additions remain read-only/advisory where specified.

Residual risks / deferred items:
- none found.

## Task 24 — ChatGPT host + Pranikah isolation

Authority:
- tracker + v0.1 plan + host acceptance docs
- source: host-facing surface
- tests/evidence: prior host records plus fresh candidate host smoke
- historical PR/commit: v0.1 host closure and later readiness docs

Current verdict: PASS

Audit findings:
- claims remain granular: fresh host observation proves health/capabilities, trusted workspace open, current Git and history tools after PR #11 candidate cutover.
- no claim is made that MCP Apps visual rendering was freshly observed.

Focused verification:
- command: live KodeGPT connector `system.health`, `system.capabilities`, `workspace.open`, `git.changes`, `git.log`, `git.show`, `git.status`, `git.diff`, `workspace.close`
- result: PASS; no `CAPABILITY_INTERNAL`; live triplet `0.1 / 2026-07-28 / 0.4`.

Security/invariant review:
- canonical repo remained clean; this audit did not mutate Pranikah.

Residual risks / deferred items:
- Apps UI rendering remains separately unobserved and must remain described as such.

## Task 25 — CI/performance/final RC

Authority:
- tracker + v0.1 plan + CI workflow
- source: `.github/workflows/ci.yml`, package/forbidden/performance scripts
- tests: deterministic gates
- historical PR/commit: v0.1 final RC plus later exact-head CI

Current verdict: PASS

Audit findings:
- Node 24/rustfmt/package/security/forbidden deterministic gate family remains current; provenance regression is now in package-smoke family.

Focused verification:
- command: complete fresh candidate gate set listed at top of this ledger
- result: PASS

Security/invariant review:
- exact PR #11 head remains unchanged during these local gates.

Residual risks / deferred items:
- final Ready/merge remains blocked on completion of this sequential audit/review record and final code review, not on test failure.

# Post-v0.1 phases

## Phase A1 — Native Capability Layer (10 tasks)

Authority: `docs/superpowers/plans/2026-08-11-kodegpt-native-capability-layer.md`.

### A1 Task 1 — Typed capability contracts and service boundary
Current verdict: PASS
- `@kodegpt/capabilities` remains typed and separate from WorkspaceManager/runtime authority; full capability tests/typecheck pass.

### A1 Task 2 — Structured MCP outputs and typed tool context
Current verdict: PASS
- structured result tests remain green; no raw authority fields introduced.

### A1 Task 3 — `workspace.inspect`
Current verdict: PASS
- retained-root bounded workspace inspection tests are green.

### A1 Task 4 — Progressive `code.search`
Current verdict: PASS
- code-search tests green; later semantic filtering is layered rather than authority-bearing.

### A1 Task 5 — `git.changes`
Current verdict: PASS
- live and test evidence green; current-state Git semantics remain unchanged by history additions.

### A1 Task 6 — Safe verification recipes
Current verdict: PASS
- verification discovery/run tests green; process execution stays policy/sandbox governed.

### A1 Task 7 — Conditional per-file patch commit in Rust
Current verdict: PASS
- Rust conditional patch tests green and audit/policy preconditions remain enforced.

### A1 Task 8 — Unified `file.patch`
Current verdict: PASS
- patch tests green; no separate write authority introduced.

### A1 Task 9 — Deterministic `context.build`
Current verdict: PASS
- context-build tests green and bounded deterministic construction retained.

### A1 Task 10 — Surface/docs/full regression gate
Current verdict: PASS
- later surface bumps are intentional generations; runtime/protocol stay `0.1`/`2026-07-28`.

## Phase A2 — Native Capability Layer Hardening (6 tasks)

Authority: `docs/superpowers/plans/2026-08-11-kodegpt-native-capability-layer-hardening.md`.

### A2 Task 1 — Stable capability errors and typed dependencies
Current verdict: PASS
- error/dependency contracts remain typed and tests pass.

### A2 Task 2 — Explicit code-search completeness and scan cap
Current verdict: PASS
- current code-search tests preserve completeness/truncation semantics.

### A2 Task 3 — Retained-root exact path identity
Current verdict: PASS
- Rust path identity tests pass and high-level features reuse the primitive.

### A2 Task 4 — Structured content-sensitive `git.changes`
Current verdict: PASS
- checkpoint tests and live `git.changes` pass; no preview-derived authority regression.

### A2 Task 5 — Deterministic static verification recipes
Current verdict: PASS
- verification tests and semantic audit path remain green.

### A2 Task 6 — Docs/transport/final gates
Current verdict: PASS
- current protocol/integration/security/full gates green.

## Phase A3 — Hybrid Skill Interoperability (10 tasks)

Authority: `docs/superpowers/plans/2026-08-12-kodegpt-hybrid-skill-interoperability-reconciled.md` and associated design.

### A3 Task 1 — Rust retained read-only skill source authority
Current verdict: PASS
- skill-source Rust tests green; separate retained source capability remains read-only and non-interchangeable with workspace capability.

### A3 Task 2 — Skill contracts/errors/local source store
Current verdict: PASS
- source store and contracts tests green.

### A3 Task 3 — Typed source runtime adapter/manager
Current verdict: PASS
- source-manager/runtime tests green; no second WorkspaceManager authority.

### A3 Task 4 — Strict parser/discovery/fingerprints
Current verdict: PASS
- parser/fingerprint tests green and data remains non-executed.

### A3 Task 5 — Immutable content-addressed pin store
Current verdict: PASS
- pin-store mutation/deletion snapshot regressions green.

### A3 Task 6 — Conservative compatibility resolver
Current verdict: PASS
- compatibility tests green; provider-required remains classification only.

### A3 Task 7 — Local CLI source/pin administration
Current verdict: PASS
- packaged CLI skill tests green; mutation stays CLI-local, not MCP.

### A3 Task 8 — Production wiring/pre-advertisement E2E
Current verdict: PASS
- integration skill interoperability tests green.

### A3 Task 9 — Advertise only `skill.list`/`skill.inspect`/`skill.load`
Current verdict: PASS
- MCP skill tests green; no `skill.run` introduced.

### A3 Task 10 — Security/docs/release gate
Current verdict: PASS
- full security/forbidden/package gates green; no provider execution.

## Phase B — Capability Quality & Contract Reconciliation (9 tasks)

Authority: `docs/superpowers/plans/2026-08-12-kodegpt-capability-quality-reconciliation.md`.

### B Task 1 — Retained-root semantic traversal scope
Current verdict: PASS
- semantic scope Rust tests green; fixed exclusion set remains an internal traversal concern.

### B Task 2 — Semantic `workspace.inspect`/`code.search`
Current verdict: PASS
- semantic filtering tests green while literal file primitives remain literal.

### B Task 3 — `context.build` noise hardening
Current verdict: PASS
- context-build tests green; dependency/worktree noise handling remains bounded.

### B Task 4 — Nested first-party verification recipes
Current verdict: PASS
- verification discovery tests green and deterministic.

### B Task 5 — `skill.list` filtering and semantic surface
Current verdict: PASS
- compatibility filtering exists as optional schema; skill surface remains read-only.

### B Task 6 — Architecture/skill/historical-plan reconciliation
Current verdict: PASS
- current architecture docs align with one runtime/workspace authority; old unchecked boxes are not treated as truth.

### B Task 7 — Host acceptance/positive skill procedure
Current verdict: PASS
- source/tests/docs preserve observation-vs-inference distinction; no fresh positive skill round-trip was required by current PR #11 scope.

### B Task 8 — Real-repository regression/full verification
Current verdict: PASS
- fresh full candidate gates and live canonical-repo smoke green.

### B Task 9 — Genuine deferred work without starting it
Current verdict: PASS
- provider interoperability remains explicitly NOT STARTED.

## Phase C — Native Skill Execution Orchestration (6 tasks)

Authority: `docs/superpowers/plans/2026-08-12-kodegpt-native-skill-execution-orchestration.md`.

### C Task 1 — Native capability semantic metadata registry
Current verdict: PASS
- skill metadata tests green; registry is static metadata, not authority.

### C Task 2 — Pure bounded skill capability planner
Current verdict: PASS
- capability-plan tests green; planner remains pure/advisory.

### C Task 3 — Attach advisory plan to `skill.inspect`
Current verdict: PASS
- skill catalog/MCP tests green; plan is data only.

### C Task 4 — MCP schema/descriptions without authority
Current verdict: PASS
- optional compatibility and capabilityPlan remain schemas/data; no execution action added.

### C Task 5 — Production integration/non-execution proof
Current verdict: PASS
- skill load remains text/data loading; no provider/process dispatch route introduced.

### C Task 6 — Docs/host rescan/release verification
Current verdict: PASS
- current full gates green and forbidden scan excludes `skill.run`/provider authority.

## Phase D — Stable Local Service & Managed Exposure Lifecycle (11 tasks)

Authority: `docs/superpowers/plans/2026-08-14-kodegpt-stable-local-service-lifecycle.md` and design/readiness docs.

### D Task 1 — CLI service contract/parser
Current verdict: PASS
- service command tests green; exact candidate CLI parses current surface/status.

### D Task 2 — Installed release identity/metadata
Current verdict: PASS
- release/metadata tests green; PR #11 strengthens pair provenance without changing release-ID semantics.

### D Task 3 — install/uninstall + systemd user unit
Current verdict: PASS
- service integration/systemd tests green; exact candidate real install succeeded.

### D Task 4 — start/stop/restart/status/readiness
Current verdict: PASS
- candidate status and explicit restart succeeded with sanitized readiness.

### D Task 5 — managed zrok service-run integration
Current verdict: PASS
- live zrok PID is a child of installed-release Node process, cwd is release root, executable is trusted `/usr/bin/zrok2`; managed exposure is true.

### D Task 6 — crash/runtime/stale-process/rollback semantics
Current verdict: PASS
- tests green; post-cutover rollback points to previously good `rel_d31389...`.

### D Task 7 — upgrade/cutover/release cleanup
Current verdict: PASS
- real install staged `rel_f00862...` while old active stayed running; only explicit restart changed active release.

### D Task 8 — security/redaction/forbidden invariants
Current verdict: PASS
- security/forbidden gates green; service outputs contain no secrets.

### D Task 9 — integration/clean-prefix package smoke
Current verdict: PASS
- integration service tests and fresh package smoke pass.

### D Task 10 — real local service acceptance/ChatGPT smoke
Current verdict: PASS
- exact PR #11 candidate cutover and KodeGPT connector smoke green.

### D Task 11 — docs/verification/final review/CI readiness
Current verdict: DOC DRIFT
- behavioral evidence is green, but this sequential audit and PR #11 final host evidence are newer than canonical readiness docs. Final documentation reconciliation must occur after PR #11 integration; no behavior fix is required here.

## Phase E — Bounded Read-Only Git History Intelligence (11 tasks)

Authority: stash-preserved design/spec and implementation plan restored on this audit branch; current implementation/readiness docs/PR #9 history.

Stash classification:
- design file: UNIQUE AUTHORITY / HISTORICALLY USEFUL — exact canonical path was absent from `main`; preserved on this branch without applying/dropping stash.
- implementation plan: UNIQUE AUTHORITY / HISTORICALLY USEFUL — exact canonical path was absent from `main`; preserved likewise.
- stash remains untouched pending durability of this branch/ledger.

### E Task 1 — typed revision/path grammar + protocol shapes
Current verdict: PASS
- Rust grammar/protocol tests green; full OIDs/strict refs/paths remain closed.

### E Task 2 — bounded shared Git runner
Current verdict: PASS
- timeout/process-group cleanup and additive lazy-fetch env tests green; current Git semantics preserved.

### E Task 3 — repository preflight/resolution/parser/`git.log`
Current verdict: PASS
- Rust history tests and live `git.log` green.

### E Task 4 — bounded `git.show`
Current verdict: PASS
- bounded message/path/patch parser tests and live `git.show` green.

### E Task 5 — bounded ancestry/range
Current verdict: PASS
- 10,000 cap parser/builder and range graph tests green.

### E Task 6 — historical diff
Current verdict: PASS
- two-revision, bounded, binary-safe tests green.

### E Task 7 — WorkspaceManager strict history validation
Current verdict: PASS
- WorkspaceManager test suite green; no private fields accepted publicly.

### E Task 8 — public contracts/errors/response budget/service methods
Current verdict: PASS
- git-history capability tests green; 512 KiB budget/error normalization remains code-owned.

### E Task 9 — production/MCP wiring + surface `0.4`
Current verdict: PASS
- live capabilities surface `0.4`; four tools present through connector; protocol remains unchanged.

### E Task 10 — security/integration regressions
Current verdict: PASS
- git-history-isolation, helper isolation, security/integration/acceptance gates green; no CAPABILITY_INTERNAL on host smoke.

### E Task 11 — exact-head/host/docs/merge baseline
Current verdict: PASS
- implementation/host/merge baseline had already closed via PR #9/#10; stash preservation itself was incomplete documentation hygiene and is being durably reconciled on this audit branch.

## Phase F — Package Provenance Hardening / Draft PR #11

Authority: PR #11 candidate and current source/tests; host handoff.

### F1 — Reproduction quality
Current verdict: PASS
- historical RED run `31805064453` isolated the mixed CLI/stale-runtime regression while pre-existing suite remained green; current regression remains in package/service tests.

### F2 — Authoritative pair build
Current verdict: PASS
- fresh `pnpm --filter kodegpt build` rebuilt/staged Rust and produced candidate pair with sourceRevision `b10aa03e...`, sourceDirty=false.

### F3 — Closed provenance contract
Current verdict: PASS
- both generated manifests are byte-identical; independent SHA-256 of CLI/runtime matches manifest; pairId is `pair_e23d802764179e6f7698beb2f0734ab9`.

### F4 — Fail-closed service materialization
Current verdict: PASS
- unit/integration/package smoke tamper/missing/mismatch coverage green; real valid install staged without premature cutover.

### F5 — Immutable release verification
Current verdict: PASS
- installed release `rel_f00862ed93f8e2919402fc60048ba2a7` CLI SHA is `21194afc18716aaa84885268dd3ed8676c6dbcddec50590d49171c4147d19747`; runtime SHA is `b3ca2e0fdf790d30178828df712232887cb2287e66c8958af75d1a783fabb790`, exactly matching source manifests. Node/Rust cwd/executable provenance points at that immutable release root.

### F6 — Package-smoke independence
Current verdict: PASS
- fresh package smoke independently computes tarball/runtime digest truth and tamper rejection; production verifier is not the sole oracle according to current test/script structure and prior exact-head CI design.

### F7 — Host-local acceptance
Current verdict: PASS
- staged release `rel_f008...` while `rel_d313...` remained active; explicit restart cut over; status running/enabled/listenerReady/managedExposure true, reserved name `public:kodegpt-dev`, port 43121, triplet `0.1 / 2026-07-28 / 0.4`.
- live KodeGPT host smoke for health/capabilities/current Git/history passed.
- process provenance: Node argv/cwd uses immutable release; Rust exe/cwd is inside release; zrok is `/usr/bin/zrok2` managed as Node child with release cwd.

# Cross-task review

## Chain A — filesystem authority
Current verdict: PASS
- trust → topology → retained root → openat2 → read/tree/search → mutation → semantic traversal remains one Rust-rooted authority chain; full Rust/security suites green.

## Chain B — process authority
Current verdict: PASS
- policy → trusted executable → Bubblewrap → registry → spool/artifacts → cancel → verification remains no-shell and bounded; security/Rust suites green.

## Chain C — Git authority
Current verdict: PASS
- current-state Git and bounded history share hardened fixed-command execution; history adds closed grammar/time/output/network-lazy-fetch bounds; no raw Git/shell/network mutation authority appears.

## Chain D — skill authority
Current verdict: PASS
- source admission → immutable pin → compatibility → advisory plan → list/inspect/load remains data/advisory only; no `skill.run` or provider invocation.

## Chain E — packaging/service provenance
Current verdict: PASS
- exact candidate source revision → authoritative Rust build/stage → CLI build → matching pair provenance → package smoke → immutable service release → explicit restart → Node/Rust/zrok managed provenance → live ChatGPT/KodeGPT behavior all verified green.

## Chain F — external isolation
Current verdict: PASS
- no product runtime dependency on CodexPro introduced; CodexPro is operator tooling only. Provider interoperability remains NOT STARTED.

# Open observations and final blockers

1. **DOC DRIFT only:** canonical service/readiness docs do not yet contain this PR #11 host evidence or this sequential audit; update only after integration/post-merge freeze.
2. **Operator-version observation:** the older globally installed `kodegpt` CLI rejected a `0.4` readiness file, while the exact candidate CLI succeeded. This does not block PR #11 because exact-candidate deployment intentionally uses the candidate CLI, but it should be mentioned in the final runbook/baseline so operators do not accidentally use a stale global CLI during staged upgrades.
3. **No unresolved behavioral/security defect found by fresh deterministic gates, host smoke, or cross-task review.**
4. **Remaining merge gates:** independent code review of exact PR #11 diff, exact-head CI reconfirmation, durable audit/stash-preservation commit/push, then PR readiness/merge flow and merged-main service/doc freeze.
