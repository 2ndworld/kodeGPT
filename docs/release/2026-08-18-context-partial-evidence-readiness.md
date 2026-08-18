# Context Partial Evidence — Candidate Readiness

Status date: 2026-08-18  
Branch: `feat/context-partial-evidence`  
Baseline: `bd9714c9f6d6252ff4e7b319fcfc64286d0cb0eb`  
Pre-documentation implementation commit: `6d60f65ed2e4c6716f168d4ba2c3afba612ee96b`  
Status: PASS — Phase 1 behavior is implemented, verified, reviewed, and live-dogfooded. Stop before any Phase 2 work.

## Scope

This phase changes only the existing read/analysis aggregator `context.build`. It adds explicit evidence status for workspace, Git, search, and verification sources, and allows only known optional-source failures to degrade to partial context.

The workspace inspection source remains foundational and fatal. Unknown/internal errors remain fatal. Mutation/process authority is unchanged and remains fail-closed. No autonomous agent runtime, retry/orchestration framework, public tool, provider capability, network authority, filesystem mount, or mutation authority was added.

The current canonical baseline already contains merged Trusted Linked-Worktree Git Metadata work from PR #31. That newer source authority supersedes the older roadmap ordering; this branch does not implement or extend Phase 2.

Runtime/protocol/public semantic surface remain `0.1 / 2026-07-28 / 0.10`. The public MCP registry remains exactly 62 tools.

## Behavior and contract

`ContextBuildResult` now reports closed `evidenceStatus` values (`available`, `incomplete`, `unavailable`) for workspace, Git, search, and verification evidence.

Git evidence may be omitted only when its status is `unavailable`; an unavailable Git source is never represented as `clean=true`. Valid truncated Git/search results are represented as `incomplete`. Search and verification unavailable states cannot contribute fabricated matches or recipes. Any partial source state marks the aggregate context as truncated.

Optional-source degradation is deliberately narrow:

- Git: `GIT_INSPECTION_FAILED`, `GIT_UNAVAILABLE`, `NOT_A_GIT_REPOSITORY`.
- Search: `CAPABILITY_SOURCE_INCOMPLETE`.
- Verification discovery: `VERIFICATION_DISCOVERY_INVALID`.

Other exceptions are rethrown. Existing unreadable selected-file semantics are preserved.

## TDD and automated verification

Baseline focused tests before implementation: 2 files / 13 tests PASS.

The first RED run after adding the Phase 1 tests produced 6 intended failures across 21 focused tests: the schema did not yet know `evidenceStatus`, Git was still mandatory, and optional source failures still propagated.

Final verification on the reviewed implementation state:

- Focused capability contracts/context tests: 21/21 PASS.
- Focused + MCP structured-result + public package-boundary tests: 4 files / 40 tests PASS.
- Capabilities + MCP regression: 43 files / 384 tests PASS.
- Full TypeScript/Vitest coverage, split only to avoid a process-wrapper aggregation artifact: 809/809 non-packaged-CLI tests plus 11/11 packaged-CLI provenance/lifecycle tests = 820/820 PASS.
- Root `pnpm run typecheck`: PASS.
- Root `pnpm run build`: PASS through the trusted canonical KodeGPT sandbox, including clean CLI/runtime provenance.
- `cargo test --workspace -- --test-threads=1`: PASS across the complete Rust workspace.
- `pnpm run test:protocol`: 14/14 PASS.
- `pnpm run test:security`: 65/65 PASS.
- `pnpm run test:acceptance`: 6/6 PASS.
- Explicit `@kodegpt/capabilities` and `@kodegpt/mcp-server` builds: PASS.

CodexPro cannot execute the linked-worktree CLI provenance Git lookup directly because its retained workspace cannot follow the linked `.git` indirection outside the opened root. The same exact candidate root build passes through KodeGPT's trusted canonical sandbox, which has the repository's intended linked-worktree metadata authority. This is an execution-environment distinction, not a compile/test failure.

## Review

The complete implementation diff was generated from the feature worktree through trusted Git authority and read/reviewed by CodexPro. CodexPro's direct linked-worktree `show_changes` could not obtain Git metadata for the same retained-root reason above, so no claim is made that `show_changes` itself succeeded.

Review found two contract-hardening opportunities, both resolved test-first before final verification:

1. workspace/Git evidence status must agree with the underlying truncation/result state;
2. partial evidence must imply aggregate truncation, while unavailable search/verification sources cannot contribute matches/recipes.

No unresolved Phase 1 correctness or authority issue remains from complete-diff review.

## Immutable candidate and live dogfood

The clean implementation commit rebuilt with provenance:

```text
sourceRevision = 6d60f65ed2e4c6716f168d4ba2c3afba612ee96b
sourceDirty = false
pairId = pair_d8414f61315939864e589231ff616356
```

`service install --name public:kodegpt-dev --port 43121` staged immutable release `rel_7de1b3636458c914a79ef5e9c4cbb641` while leaving the previous release active. Explicit `service restart` then promoted that candidate. Post-cutover service health is green with `system.health.ok=true`, `auditHealthy=true`, and `filesystemBoundaryAvailable=true`; `system.capabilities` reports runtime `0.1`, protocol `2026-07-28`, surface `0.10`.

Live feature-worktree dogfood produced the exact optional-Git failure condition required for Phase 1: direct `git.status` returned `GIT_INSPECTION_FAILED`, while `workspace.inspect` succeeded. On the same READY workspace, `context.build(intent=review, target=packages/capabilities/src/context-build.ts, maxBytes=16384)` succeeded with:

```text
evidenceStatus.workspace = available
evidenceStatus.git = unavailable
evidenceStatus.search = available
evidenceStatus.verification = available
git field = absent
warning includes git-evidence-unavailable
relevantMatches = present
verification recipes = present
truncated = true
```

This is the core live acceptance: before the Phase 1 implementation the same Git failure destroyed the whole context request; after the implementation, healthy non-Git evidence is preserved without fabricating Git state.

`verify.list` also succeeds on the live feature workspace. `verify.run(package:packages/capabilities:test)` currently returns `CAPABILITY_INTERNAL`, and direct `process.run(node --version)` returns `PROCESS_SANDBOX_UNAVAILABLE` on that linked-worktree record. The same source tests/build pass through the canonical trusted sandbox. This process-sandbox behavior is outside Context Partial Evidence and is intentionally not normalized or weakened here; process/mutation authority remains fail-closed.

## Stop condition

Phase 1 is complete for review. Do not start the next roadmap phase, add autonomous-agent behavior, or change process/Git authority as part of this closure. The active candidate remains rollback-capable through the existing immutable service lifecycle.
