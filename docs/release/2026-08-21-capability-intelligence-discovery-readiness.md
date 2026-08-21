# KodeGPT Capability Intelligence Discovery Readiness

Date: 2026-08-21
Status: **READY FOR PR / EXACT-HEAD CI — merge, deployment, refreshed host inventory, and live closure still pending**
Baseline: `b3d502c598ec6595bec4e5427dc9f3305ff264a4`
Reviewed implementation head: `9c1a484` (`fix: derive action search limit from catalog`)
Target public contract: `runtime 0.1 / protocol 2026-07-28 / surface 0.18 / 76 tools`

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

Live installed-service / refreshed-ChatGPT-host evidence is intentionally **not** claimed yet. The currently connected installed KodeGPT service predates this candidate and still exposes the older action inventory. Deployment and host action refresh are closure gates after merge.

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

## Remaining closure gates

This document is pre-merge readiness, not final closure. P0 may be declared COMPLETE only after:

1. independent code review is requested and actionable findings are resolved;
2. the exact reviewed feature head is pushed and a PR is created;
3. exact-head CI passes on the reviewed PR head;
4. the exact passing head is guarded-merged;
5. merged-main CI passes;
6. the new immutable KodeGPT service release is installed/activated and reports `0.1 / 2026-07-28 / 0.18 / 76`;
7. the ChatGPT connector/action inventory is refreshed and live `system.discover`, `skill.list(query)`, and `skill.inspect.requirementGraph` are observed;
8. canonical `main == origin/main` and repository/worktree cleanup are verified.

No P1 Continuity v2, Skill Ecosystem v2, MCP Plugin Gateway, native multi-agent runtime, or browser-v2 work begins in this branch.
