# KodeGPT Evidence Freshness + Source-State Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind verification, preview, browser, and visual evidence to one deterministic repository source-state reference derived from the existing hardened Git checkpoint.

**Architecture:** Extend private `git.checkpoint` with the current full HEAD OID, keep the existing `git.changes` fingerprint algorithm as the only worktree fingerprint, and expose `{headOid, changesFingerprint}` as `SourceStateRef`. `verify.run` captures the current state before launch; preview stores it once at creation and browser/visual results inherit it. No new public tool, scheduler, registry, or polling subsystem is added.

**Tech Stack:** Rust stable, TypeScript 5.9, Zod 4, Vitest 3, existing KodeGPT runtime/core/capabilities/MCP packages.

**Spec:** `docs/superpowers/specs/2026-08-21-kodegpt-evidence-freshness-source-state-design.md`

## Global Constraints

- Baseline is `221538a2e45debed7a6d844c5f8af044303d3ac3`.
- Runtime remains `0.1`.
- External MCP protocol remains `2026-07-28`.
- Public tool count remains exactly `76`.
- Expected semantic surface target is `0.20` because public output schemas gain evidence fields.
- No new Git mutation, filesystem authority, network authority, provider invocation, shell tool, workflow engine, evidence database, or automatic rerun.
- `SourceStateRef.headOid` is full lowercase 40- or 64-hex.
- `SourceStateRef.changesFingerprint` is lowercase SHA-256.
- Existing `git.changes.fingerprint` remains and must equal `sourceState.changesFingerprint`.
- TDD RED -> minimal GREEN -> adjacent regression for every behavior change.

---

### Task 1: Make `git.checkpoint` the single source-state snapshot

**Files:**
- Modify: `crates/runtime/src/git.rs`
- Modify: `packages/core/src/workspace-manager.ts`
- Modify: `packages/core/src/workspace-manager.test.ts`
- Modify: `packages/capabilities/src/adapters.ts`
- Modify: `packages/capabilities/src/contracts.ts`
- Modify: `packages/capabilities/src/schemas.ts`
- Modify: `packages/capabilities/src/git-changes.ts`
- Modify: `packages/capabilities/src/git-changes.test.ts`
- Modify: `packages/capabilities/src/contracts.test.ts`
- Modify: `apps/cli/src/commands/start.ts`

**Interfaces:**
- Private checkpoint result becomes `{schemaVersion:1, headOid:string, records, truncated}`.
- Public `SourceStateRef` is `{headOid:string, changesFingerprint:string}`.
- Public `GitChangesResult` adds `sourceState: SourceStateRef` and retains `fingerprint`.

- [ ] **Step 1: Write RED Rust parsing tests** proving checkpoint status accepts exactly one `# branch.oid <full oid>` header, rejects `(initial)`, missing/duplicate/invalid OIDs, and preserves existing record parsing.
- [ ] **Step 2: Run the focused Rust parser test** and confirm failure because `headOid` is not produced yet.
- [ ] **Step 3: Implement minimal hardened checkpoint change** by adding `--branch` to the existing fixed status command, parsing the branch header, and returning `head_oid` without changing helper/network/sandbox policy.
- [ ] **Step 4: Run focused Rust tests** for checkpoint parsing and existing checkpoint identity behavior.
- [ ] **Step 5: Write RED TypeScript tests** in core/capabilities asserting the additive internal `headOid` contract and public `sourceState`, including equality with top-level `fingerprint` and malformed OID/fingerprint rejection.
- [ ] **Step 6: Run focused TypeScript tests** and confirm expected contract failures.
- [ ] **Step 7: Implement minimal core/capability wiring**: validate `headOid`, carry it through `GitCheckpointAdapter`, construct `sourceState` in `gitChanges`, and update Zod/types/startup adapter mapping.
- [ ] **Step 8: Run focused GREEN tests** for `workspace-manager`, `git-changes`, and capability contracts.
- [ ] **Step 9: Commit** with `feat: bind git changes to source state`.

### Task 2: Bind `verify.run` before process launch

**Files:**
- Modify: `packages/capabilities/src/verification.ts`
- Modify: `packages/capabilities/src/verification.test.ts`
- Modify: `packages/capabilities/src/native-capability-service.ts`
- Modify: `packages/capabilities/src/contracts.ts`
- Modify: `packages/capabilities/src/schemas.ts`
- Modify: `packages/capabilities/src/contracts.test.ts`
- Modify: `packages/mcp-server/src/structured-results.test.ts`

**Interfaces:**
- `VerifyRunResult` adds `sourceState: SourceStateRef`.
- `runVerification` receives a bounded source-state resolver callback `(workspaceId) => Promise<SourceStateRef>`.
- `NativeCapabilityService.runVerification` supplies that resolver by calling the existing `gitChanges({workspaceId})` and returning its `sourceState`.

- [ ] **Step 1: Write RED verification tests** asserting source state is resolved before `execution.run`, is returned unchanged, and a source-state failure prevents process launch.
- [ ] **Step 2: Run focused verification tests** and confirm failure from the missing resolver/result field.
- [ ] **Step 3: Implement minimal verification binding** with one pre-launch source-state resolution and no post-run scan, registry, or retry.
- [ ] **Step 4: Update closed public schema/tests** for the additive `VerifyRunResult.sourceState`.
- [ ] **Step 5: Run focused GREEN tests** for capabilities and MCP structured results.
- [ ] **Step 6: Commit** with `feat: bind verification evidence to source state`.

### Task 3: Capture immutable source state on preview creation

**Files:**
- Modify: `packages/core/src/preview-manager.ts`
- Modify: `packages/core/src/preview-manager.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `apps/cli/src/commands/start.ts`
- Modify: `apps/cli/src/commands/start.test.ts`

**Interfaces:**
- Core defines structural `EvidenceSourceStateRef` with the same two bounded string fields but does not compute fingerprints.
- `PreviewManager` constructor receives `sourceState: { resolve(workspaceId): Promise<EvidenceSourceStateRef> }`.
- `PreviewStatusResult` adds `sourceState`.
- `PreviewRecord` stores the immutable value captured before `process.run`.

- [ ] **Step 1: Write RED preview tests** proving source state resolves exactly once before process launch, source-state failure prevents launch, and inspect/stop preserve the same stored value.
- [ ] **Step 2: Run focused preview tests** and confirm expected failures.
- [ ] **Step 3: Implement minimal preview dependency/storage/result propagation** without rescanning Git during inspect/readiness polling.
- [ ] **Step 4: Wire production startup** so preview source state resolves through `nativeCapabilities.gitChanges({workspaceId}).sourceState`; construct `NativeCapabilityService` before `PreviewManager` if necessary without creating duplicate managers.
- [ ] **Step 5: Run preview/start focused GREEN tests**.
- [ ] **Step 6: Commit** with `feat: bind preview lifecycle to source state`.

### Task 4: Propagate preview source state through browser and visual evidence

**Files:**
- Modify: `packages/core/src/browser-manager.ts`
- Modify: `packages/core/src/browser-manager.test.ts`
- Modify: `packages/core/src/visual-verification.ts`
- Modify: `packages/core/src/visual-verification.test.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/structured-results.test.ts`
- Modify: `packages/mcp-server/src/server.test.ts`

**Interfaces:**
- Browser result types associated with a preview carry `sourceState` copied from `PreviewStatusResult`/preview lookup evidence.
- Visual capture/compare results carry the same inherited state.
- No browser/visual method performs a Git scan.

- [ ] **Step 1: Write RED browser tests** asserting inherited source state on open/inspect/screenshot/diagnostic evidence and zero independent resolver calls.
- [ ] **Step 2: Run focused browser tests** and confirm missing fields.
- [ ] **Step 3: Implement minimal browser propagation** from the existing preview adapter result/record.
- [ ] **Step 4: Write RED visual tests** asserting matrix/compare results inherit the same preview state.
- [ ] **Step 5: Run visual RED, implement minimal propagation, then rerun GREEN**.
- [ ] **Step 6: Update MCP output schemas/structured-result fixtures** for preview/browser/visual additive fields while keeping tool inventory unchanged.
- [ ] **Step 7: Run focused MCP/core GREEN tests**.
- [ ] **Step 8: Commit** with `feat: propagate preview source state evidence`.

### Task 5: Release reconciliation and verification

**Files:**
- Modify: `packages/mcp-server/src/surface-version.ts`
- Modify: `tests/fixtures/mcp-surface.ts` only if semantic-surface assertions require it; tool names remain unchanged.
- Modify: `docs/implementation/v0.1-execution-tracker.md` only for current-state release evidence, not historical rewrites.
- Create: `docs/release/2026-08-21-evidence-freshness-source-state-readiness.md`

**Interfaces:**
- Semantic surface becomes `0.20` with exactly 76 tools.

- [ ] **Step 1: Write/adjust RED surface-version assertions** for `0.20` and unchanged tool inventory.
- [ ] **Step 2: Implement the one-line surface version bump** and update current-state fixtures/docs.
- [ ] **Step 3: Run focused TypeScript verification**: capability/core/MCP tests touched by this feature plus `pnpm run typecheck`.
- [ ] **Step 4: Run protocol/integration/security tests that do not require nested Bubblewrap** inside the current harness.
- [ ] **Step 5: Run host-capable Rust/Bubblewrap verification outside nested KodeGPT process sandbox**; nested `process.run` failures with `Bubblewrap did not publish a host child PID` are environment evidence, not accepted as feature proof.
- [ ] **Step 6: Review exact diff** for duplicate fingerprint logic, accidental tool additions, authority widening, Git command drift, and evidence fields that can disagree.
- [ ] **Step 7: Run final focused regression and typecheck again after review fixes**.
- [ ] **Step 8: Commit release evidence** with `docs: record evidence freshness readiness`.

## Plan self-review

- Spec coverage: source-state contract, single checkpoint source, verification binding, preview storage, browser/visual inheritance, failure behavior, compatibility, and no-autonomy constraints are each assigned to a task.
- No second fingerprint algorithm is introduced.
- Background verification intentionally retains launch-state evidence from `verify.run`; `process.status` remains generic and P0-D parallel verification can compare all retained launch states against one final `git.changes.sourceState`.
- No new public tool or persistent evidence subsystem is required.
