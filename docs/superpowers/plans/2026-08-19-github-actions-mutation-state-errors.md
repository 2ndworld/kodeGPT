# GitHub Actions Mutation State Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distinguish allowlisted GitHub Actions mutation-state HTTP 403 responses from genuine permission failures, harden host workflow sequencing, and prove the existing `gh` credential has mutation authority.

**Architecture:** Keep mutation requests single-attempt. On a non-rate-limit mutation 403 only, read a small bounded response body, parse only an explicitly allowlisted GitHub Actions state-conflict message, and map it to a typed CI error with refresh-state recovery semantics; unknown 403 remains permission denied. Host workflow guidance must refresh CI state after accepted dependent mutations such as cancel before rerun.

**Tech Stack:** TypeScript, Vitest, KodeGPT Remote-CI GitHub adapter, Markdown skill catalog, pnpm, Rust verification.

**Spec:** User-approved handoff `Fix KodeGPT GitHub Actions Mutation Reliability Before Phase 6` in this conversation.

## Global Constraints

- Preserve `runtime 0.1 / protocol 2026-07-28 / surface 0.14 / 76 tools`.
- Do not change GitHub API version `2026-03-10`.
- No new MCP tool, workflow runtime, queue, scheduler, supervisor, or blind mutation retry.
- Provider error bodies remain bounded, sanitized, and never surfaced verbatim.
- Unknown/genuine 403 remains `CI_PERMISSION_DENIED`; rate-limit 403 behavior is unchanged.

---

### Task 1: Prove credential authority and root cause

**Files:** No production files.

**Interfaces:**
- Consumes: existing `ci.repository`, `ci.status`, `ci.rerun`.
- Produces: evidence that completed-run rerun is accepted or a credential-authority diagnosis.

- [x] **Step 1:** Verify canonical baseline `main == origin/main == 13e2c93b19d81b8ba3b2f4e54e33c98c540b3220`.
- [x] **Step 2:** Verify `ci.repository` and `ci.status` read access.
- [x] **Step 3:** Rerun an already COMPLETED historical run once.
- [x] **Step 4:** Record interpretation: accepted rerun proves Actions mutation authority; incident was state/timing classification.

### Task 2: TDD mutation-state conflict classification

**Files:**
- Modify: `packages/capabilities/src/remote-ci/github-http.test.ts`
- Modify: `packages/capabilities/src/remote-ci/github-http.ts`
- Modify if needed: `packages/capabilities/src/errors.ts`

**Interfaces:**
- Consumes: `GitHubHttp.postMutation(...)`, `CapabilityError`.
- Produces: typed `CI_MUTATION_STATE_CONFLICT` with `{ reason: "STALE_EXPECTED_STATE", retryable: false, suggestedAction: "refresh-state" }` for allowlisted mutation-state responses only.

- [ ] **Step 1:** Add a RED test where rerun POST returns 403 with an allowlisted GitHub Actions state-conflict JSON message; assert `CI_MUTATION_STATE_CONFLICT`, safe recovery details, and exactly one fetch call.
- [ ] **Step 2:** Add RED tests proving oversized/malformed/unknown 403 bodies never leak and remain `CI_PERMISSION_DENIED`; keep rate-limit 403 coverage green.
- [ ] **Step 3:** Run only `github-http.test.ts` and verify the new state-conflict test fails for the expected `CI_PERMISSION_DENIED` reason.
- [ ] **Step 4:** Add the narrow error code and minimal bounded allowlist parser used only by mutation 403 handling.
- [ ] **Step 5:** Re-run focused HTTP tests and keep all existing behavior green.

### Task 3: Harden host orchestration guidance

**Files:**
- Modify: `skills/kodegpt-application-development-workflow/SKILL.md`
- Modify: `packages/skills/src/catalog.test.ts` if catalog regression wording is asserted there.

**Interfaces:**
- Consumes: host-side adaptive workflow.
- Produces: explicit rule that `accepted:true` is acknowledgement only; dependent mutations refresh state and require appropriate terminal state before proceeding.

- [ ] **Step 1:** Add or tighten a catalog regression assertion first if practical.
- [ ] **Step 2:** Update CI guidance: after `ci.cancel`, refresh with `ci.run`/`ci.status`; do not call `ci.rerun` until terminal/rerunnable state is observed.
- [ ] **Step 3:** Run skill catalog tests.

### Task 4: Verification, review, publish, and closure

**Files:** Exact changed files only.

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: reviewed PR, exact-head CI, merged-main CI, and live safe mutation/read dogfood.

- [ ] **Step 1:** Run focused Remote-CI HTTP, adapter, service, actionable-error, and skill catalog tests.
- [ ] **Step 2:** Run `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm verify:forbidden`, `cargo fmt --all -- --check`, `cargo check --workspace`, `cargo test --workspace`.
- [ ] **Step 3:** Review exact diff; confirm surface/API version/tool count invariants.
- [ ] **Step 4:** Commit, push, create PR, and require exact-head CI PASS.
- [ ] **Step 5:** Merge exact reviewed head, require merged-main CI PASS, fast-forward canonical local main.
- [ ] **Step 6:** If runtime-delivered TypeScript changed, stage/cut over immutable release as appropriate; dogfood `ci.repository`, `ci.status`, and one safe completed-run `ci.rerun`; inspect durable audit/redaction.
- [ ] **Step 7:** Cleanup worktree/branch only after closure PASS.
