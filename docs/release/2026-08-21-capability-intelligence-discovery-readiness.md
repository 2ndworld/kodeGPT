# KodeGPT Capability Intelligence Discovery Readiness

Date: 2026-08-21
Status: **MERGED / CI VERIFIED / DEPLOYED / ACTIVE-RELEASE DOGFOOD PASS — ChatGPT action-inventory rescan pending**
Baseline: `b3d502c598ec6595bec4e5427dc9f3305ff264a4`
Accepted feature head: `4f349c9efc54746f6c480a3e573244be63ef34c6`
Merge: PR #58 → `b228101f2b44d8ef797642ada7e7ef4e2b3e0e7f`
Exact-head push CI: `32436939565` — SUCCESS
Exact-head PR CI: `32455801204` — SUCCESS
Merged-main CI: `32456224911` — SUCCESS
Live contract: `runtime 0.1 / protocol 2026-07-28 / surface 0.18 / 76 tools`
Installed production: active `rel_fda9290d7ee09062dd6a656b56292683`; rollback `rel_c1322f951732540765edefb4f86c95db`

## Scope

This candidate closes the capability-discoverability gap without adding an agent runtime, workflow engine, vector database, model dependency, generic provider authority, or Codex execution dependency.

The implementation adds one authoritative Public Action Catalog for the complete public MCP action inventory and keeps `NATIVE_CAPABILITY_IDS` as the smaller native semantic subset. Existing native semantic purpose/alias metadata is projected from that public catalog rather than authored a second time.

The public feature set is intentionally additive and bounded:

- `system.discover({ query, workspaceId?, limit? })` is the single new public tool. It deterministically returns relevant public actions, Agent Skills, and explicit skill-stage flows without executing them.
- `skill.list` gains optional `query` for deterministic intent-aware ranking while preserving the no-query catalog path and raw source identities.
- `skill.inspect` gains additive `requirementGraph`, separating core requirements from conditional stages while retaining the existing advisory `capabilityPlan`.
- `system.capabilities` gains a compact discovery feature summary instead of dumping the full action catalog.
- The built-in `kodegpt-application-development-workflow` publishes bounded machine-readable stages for continuity, repository understanding, implementation, verification, preview, browser, visual evidence, Git delivery, PR, and CI.

`system.discover` has no process, filesystem mutation, Git mutation, GitHub mutation, CI mutation, browser interaction, or provider dependency. Its production composition receives only action search, skill list/rank/inspect, and workspace-info reads. Stage-derived flows come only from explicit `requirementGraph.stages`; they are descriptive routing evidence, not executable workflow plans.

## Public contract

Mechanical source/tests lock:

- runtime version remains `0.1`;
- external MCP protocol remains `2026-07-28`;
- semantic surface is `0.18`;
- the Public Action Catalog and registered MCP surface contain exactly `76` actions;
- `system.discover` requires only `query`; `workspaceId` and `limit` are optional;
- no public `provider.*`, `workflow.run`, `skill.run`, `agent.*`, generic HTTP, arbitrary browser navigation, or executable plugin runtime is introduced.

The service runtime-readiness parser remains backward-compatible with historical surfaces `0.3` through `0.17` and now also accepts `0.18`; staged rollback/readiness state is not invalidated by the new surface.

## Discovery quality

The deterministic action-routing benchmark contains 51 realistic development intents spanning repository understanding, editing, verification, process execution, preview/browser/visual evidence, Git/worktrees, GitHub PRs, CI, continuity/workspace state, skills, and system introspection. Eleven scenarios are critical Indonesian intents.

Fresh production-scorer metrics on reviewed source:

- top-1: `51 / 51` = **100%**;
- top-3: `51 / 51` = **100%**;
- critical Indonesian top-3: `11 / 11` = **100%**.

The package benchmark additionally verifies the built-in application workflow wins realistic multi-stage development intents over narrower helper skills. Skill ranking filters a small fixed English/Indonesian stopword set and scores unique query coverage; it does not hardcode a workflow name.

A review-found surface-cardinality defect was also fixed before readiness: action search had retained a historical maximum of 75. A RED regression test proved a 76-action catalog query returned only 75; the maximum is now derived from `listPublicActionDescriptors().length`, preventing future catalog-count drift. Capabilities tests increased to `416 / 416` PASS after this fix.

## Requirement graph and provenance

`metadata.kodegpt` now supports bounded core `requires.actions` and up to 16 conditional stages while retaining existing capabilities/providers/unsupported and legacy provider metadata behavior. The requirement graph statically recognizes exact public-action references in skill instructions, keeps explicitly staged actions out of inferred core requirements, reports unknown declared action IDs as structured missing requirements, and never lets an unsupported optional stage downgrade otherwise-satisfied core compatibility.

Raw `skill.list` preserves distinct source identities. High-level discovery groups only exact `(name, fingerprint)` duplicates so identical copies cannot crowd the result window; same-name/different-fingerprint entries remain distinct. Representative selection prefers a matching workspace-local copy, then pinned/live+pinned provenance, then deterministic identity order.

For multilingual or otherwise non-textual skill routing, `system.discover` may surface a skill through **explicit stage-action affinity**: if ranked public actions overlap a declared requirement-graph stage, the skill may be returned with `STAGE_ACTION_MATCH`. This remains bounded by at most five skill inspections and never synthesizes or executes a stage.

## Bounds and side-effect evidence

The implementation verifies:

- discovery query: `1..512` UTF-8 bytes;
- result limit: default 8, maximum 20;
- at most 5 skill inspections;
- at most 5 stage flows;
- bounded match reasons and alternate-source provenance;
- source/list/action/skill/flow truncation reasons are explicit;
- exactly 512 ASCII bytes are accepted;
- a multibyte string with at most 512 characters but more than 512 UTF-8 bytes is rejected;
- workspace-scoped actions without a workspace ID are `CONTEXT_REQUIRED` with `WORKSPACE_REQUIRED`;
- an unavailable supplied workspace produces bounded `UNAVAILABLE` evidence without leaking host paths;
- global/repository action availability never probes GitHub, CI, or provider networks.

Unit and full-stack side-effect guards fail if discovery reaches undeclared mutation/process/browser/GitHub/CI/provider dependencies. Local full-stack dogfood also verifies a tracked workspace file is unchanged after discovery calls.

## Local dogfood evidence

Public stdio transport dogfood successfully exercises:

- `system.discover({ query: "cek tampilan mobile", workspaceId })`, with `visual.captureMatrix` in the top three actions;
- `system.discover({ query: "lanjutkan pekerjaan sebelumnya" })`, with `workspace.info` relevant and `CONTEXT_REQUIRED` when no workspace context is supplied;
- the 512-byte query boundary and multibyte over-limit rejection.

Production-composition full-stack dogfood exposes a real workspace Agent Skill copied from the built-in application workflow. The same Indonesian mobile-UI query returns that workflow through its explicit `visual` stage with `STAGE_ACTION_MATCH`, and the fixture's tracked file remains unchanged after discovery.

Intent-aware `skill.list(query)` is covered through adapter/MCP tests and deterministic ranking tests; no new `skill.search` tool exists. `skill.inspect.requirementGraph` is covered through live catalog inspection and public deep-clone tests.

The immutable installed service is now active on `rel_fda9290d7ee09062dd6a656b56292683` with previous `rel_c1322f951732540765edefb4f86c95db` retained as rollback. Candidate `service install` staged the new release while the old `0.17 / 75` release remained running/listener-ready; explicit `service restart` then promoted the candidate. Post-cutover `service status --json` reports running, enabled, listener-ready, managed-exposure ready, and exactly `0.1 / 2026-07-28 / 0.18`. Live MCP `system.capabilities` through the existing ChatGPT connection reports `publicTools.count=76` plus `discovery.systemDiscover=true`, and live `system.health` reports `ok=true`, `auditHealthy=true`, and `filesystemBoundaryAvailable=true`.

Exact-active-release stdio dogfood against the immutable release itself independently listed 76 MCP tools with `system.discover` requiring only `query`. `system.discover({query:"cek tampilan mobile", workspaceId})` ranked `visual.captureMatrix` first and returned the built-in application workflow with explicit `visual`, `ci`, and `continuity` stage flows. `skill.list({query:"application development workflow", workspaceId})` accepted the new query input and returned `kodegpt-application-development-workflow`; `skill.inspect` on that exact skill returned `requirementGraph.schemaVersion=1`, core classification `NATIVE`, and the declared browser/CI/continuity/Git/implementation/preview/PR/repository/verification/visual stages.

The **ChatGPT action snapshot for this already-open conversation remains stale at 75 actions** even though the connected backend now reports surface `0.18 / 76`. Re-listing connector resources still omits `system.discover` and exposes the pre-`query` `skill.list` schema. This is therefore recorded as a host action-inventory rescan requirement, not a KodeGPT server/runtime failure. No claim of refreshed-host `system.discover` invocation is made until ChatGPT refreshes that action snapshot.

## Verification evidence before remote delivery

Fresh feature verification before documentation reconciliation passed:

- `@kodegpt/capabilities`: `416 / 416` PASS after the final review fix;
- `@kodegpt/skills`: `127 / 127` PASS;
- `@kodegpt/mcp-server`: `55 / 55` PASS;
- `@kodegpt/core`: `130` PASS plus one intentional Playwright spike skip;
- focused mechanical public-contract suite: `25 / 25` PASS;
- focused service runtime/status tests: `29 / 29` PASS;
- forbidden-pattern regression suite: `30 / 30` PASS;
- `pnpm typecheck` — PASS;
- `pnpm build` — PASS;
- full host-side `pnpm test` at pre-final-review head `6033213` — `1044` PASS plus one intentional skip;
- `pnpm test:rust` — PASS;
- `pnpm test:protocol` — `16 / 16` PASS;
- `pnpm test:integration` — `53 / 53` PASS;
- `pnpm test:security` — `64 / 64` PASS;
- `pnpm test:isolation` — `3 / 3` PASS;
- `pnpm verify:forbidden` — PASS;
- `pnpm verify:package` — PASS;
- `git diff --check` — PASS at each source checkpoint.

The final review fix `6033213 -> 9c1a484` changes only the public-action-search maximum and its regression test; its fresh post-fix evidence is `416 / 416` capabilities PASS plus capabilities typecheck PASS.

A subsequent attempt to rerun the entire root Vitest suite **inside the already-running KodeGPT sandbox** is not accepted as a host release gate. It reproduced known nested-runtime limitations: packaged CLI builders cannot resolve the linked-worktree private Git metadata path, and nested KodeGPT/Bubblewrap process probes report `SANDBOX_UNAVAILABLE`/process-unavailable evidence. In that nested run, ordinary discovery/capabilities/MCP/skill/security tests—including the new 76-action regression and discovery quality tests—continued to pass. Exact-head remote CI or a recovered non-nested host execution remains authoritative for the final full-suite gate.

## Forbidden-surface reconciliation

The authoritative Public Action Catalog legitimately contains the existing typed `ci.rerun`, `ci.cancel`, and `ci.dispatch` IDs. The repository forbidden-pattern scanner originally admitted those IDs only in older reviewed wiring files. The scanner allowlist is extended by exactly `packages/capabilities/src/public-actions.ts`; a regression proves the same typed IDs remain forbidden in an arbitrary unreviewed capabilities file. Generic Remote-CI/provider strings remain forbidden.

## Review summary

The complete branch was reviewed against the approved design and implementation plan, including:

- catalog vs MCP registration equality;
- public/native concept separation;
- deterministic ranking and tie-breaks;
- no duplicate authored native semantic registry;
- bounded skill metadata parsing and legacy behavior;
- core vs conditional-stage classification;
- duplicate grouping only at high-level discovery;
- explicit stage-only flows;
- production dependency injection for zero mutation/network execution;
- exact `0.18 / 76` release contract;
- current service-readiness compatibility;
- forbidden authority boundaries.

The review found one concrete source defect—the stale 75-action search maximum—and fixed it by TDD before this readiness record.

## Final closure state

The implementation/release gates that KodeGPT controls are closed:

1. code review was requested; the independent reviewer backend was unavailable during the feature review, so no independent-review claim is fabricated. Structured full-diff review found and TDD-fixed the stale 75-action search limit before delivery;
2. exact feature head `4f349c9efc54746f6c480a3e573244be63ef34c6` was pushed and PR #58 created;
3. exact-head push CI `32436939565` and exact-head PR CI `32455801204` both completed SUCCESS;
4. guarded merge accepted only that exact head and produced `b228101f2b44d8ef797642ada7e7ef4e2b3e0e7f`;
5. merged-main CI `32456224911` completed SUCCESS;
6. canonical local `main` fast-forwarded to the same merge and `origin/main` was already identical;
7. merged-main provenance-bound Rust runtime + CLI were rebuilt, package smoke passed, `service install` staged `rel_fda9290d7ee09062dd6a656b56292683` without cutover, and explicit restart promoted it with `rel_c1322f951732540765edefb4f86c95db` as rollback;
8. post-cutover service health and capability evidence is green at `0.1 / 2026-07-28 / 0.18 / 76`, and exact-active-release stdio dogfood verifies the three new discovery-facing contracts;
9. the clean implementation worktree `.worktrees/capability-intelligence-discovery` was removed through typed worktree authority and local branch `feat/capability-intelligence-discovery` was deleted normally without force.

One **host/UI-owned acceptance item** remains: this already-open ChatGPT conversation retains the previously approved 75-action snapshot. The backend itself is upgraded and advertises 76 tools, but ChatGPT must refresh/rescan the connector action inventory before this conversation (or a new refreshed connection) can invoke the new `system.discover` action or send `query` through the host-generated `skill.list` schema. Until that happens, `CHATGPT_HOST_OBSERVED` for those new host-visible actions is pending; this does not require another KodeGPT source or runtime change.

Therefore **Capability Intelligence P0 code, merge, CI, deployment, active-release dogfood, and implementation cleanup are complete**. The narrower ChatGPT-host refresh evidence remains explicitly unclaimed. No P1 Continuity v2, Skill Ecosystem v2, MCP Plugin Gateway, native multi-agent runtime, or browser-v2 work is started by this closure.
