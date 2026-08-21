# KodeGPT Continuity v2 + Resume Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded native Continuity v2 so `context.build(intent="resume")` can reconcile a durable checkpoint with current source state and explicitly referenced runtime/PR/CI evidence without adding session, task, scheduler, workflow, or agent subsystems.

**Architecture:** Keep the public surface at 76 tools. Core owns private continuity persistence and current-checkpoint history; `@kodegpt/capabilities` adds only the repository-level `resume` intent; `packages/mcp-server` owns a read-only resume composer because it already has access to workspace, Git, process, preview, GitHub, CI, and artifact adapters. Public checkpoint schema stays v1 while private persistence advances to a schema-v2 envelope; semantic MCP surface advances from `0.20` to `0.21` only after behavior is implemented and verified.

**Tech Stack:** TypeScript 5.9, Node.js 24, pnpm 10.15, Zod 4, Vitest 3, existing Rust runtime/Bubblewrap authority, existing Git/GitHub/CI adapters.

**Spec:** `docs/superpowers/specs/2026-08-21-kodegpt-continuity-v2-resume-intelligence-design.md`

## Global Constraints

- Runtime remains `0.1`.
- MCP protocol remains `2026-07-28`.
- Final semantic surface is `0.21` with exactly **76** public tools.
- Public `WorkspaceCheckpoint.schemaVersion` remains exactly `1`; private continuity persistence uses a distinct schema version `2`.
- Current checkpoint serialized bound remains 16 KiB; private continuity envelope bound is 32 KiB.
- Retain at most 8 milestones, oldest-to-newest on public read.
- Milestone objective is UTF-8-safe compacted to at most 512 bytes.
- `workspace.checkpoint` remains the only continuity mutation tool and retains full replacement + compare-and-swap semantics.
- `context.build(intent="resume")` is read-only. It never retries, polls, restarts, cancels, dispatches, reruns, or mutates referenced evidence.
- Reconcile at most the checkpoint's existing 16 evidence refs. Each evidence ref causes at most one primary read; checkpoint ancestry uses at most two `git.range` reads.
- Do not add `workspace.resume`, `session.*`, `resume.*`, `workflow.run`, `skill.run`, `task.*`, `agent.*`, process/preview list APIs, a task database, a vector database, or a Codex runtime dependency.
- Keep ChatGPT as planner/orchestrator. KodeGPT returns evidence and deterministic relation codes only.
- Use TDD for every behavior task and commit after each independently reviewable deliverable.

---

### Task 1: Private Continuity Envelope v2 and Bounded Milestone History

**Files:**
- Modify: `packages/core/src/workspace-checkpoint-store.ts`
- Modify: `packages/core/src/workspace-checkpoint-store.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: existing `WorkspaceCheckpoint`, `WorkspaceCheckpointBody`, checkpoint CAS semantics, private state root.
- Produces:

```ts
export const WORKSPACE_CONTINUITY_PERSISTENCE_SCHEMA_VERSION = 2 as const;
export const WORKSPACE_CONTINUITY_MAX_BYTES = 32 * 1024;
export const WORKSPACE_MILESTONE_MAX_COUNT = 8;

export interface WorkspaceCheckpointSourceStateRef {
  headOid: string;
  changesFingerprint: string;
}

export interface WorkspaceMilestone {
  revision: number;
  status: WorkspaceCheckpointStatus;
  objective?: string;
  sourceState?: WorkspaceCheckpointSourceStateRef;
  updatedAt: string;
}

export interface WorkspaceContinuityInfo {
  schemaVersion: 1;
  capturedSourceState?: WorkspaceCheckpointSourceStateRef;
  milestones: WorkspaceMilestone[];
}

export interface WorkspaceContinuityRecord {
  checkpoint: WorkspaceCheckpoint;
  continuity: WorkspaceContinuityInfo;
}
```

`WorkspaceCheckpointStore.read(trustId)` and `upsert(...)` keep their current public return shape (`WorkspaceCheckpoint`) for compatibility. `upsert` gains only the server-owned source-state input; add a separate richer read for continuity metadata:

```ts
readContinuity(trustId: string): Promise<WorkspaceContinuityRecord | undefined>;

upsert(input: {
  trustId: string;
  body: WorkspaceCheckpointBody;
  capturedSourceState: WorkspaceCheckpointSourceStateRef;
  expectedRevision?: number;
}): Promise<WorkspaceCheckpoint>;
```

- [ ] **Step 1: Write failing tests for legacy-v1 normalization and strict v2 parsing**

Add tests proving a legacy persisted checkpoint is returned from `readContinuity()` as the same public checkpoint plus `{ schemaVersion: 1, milestones: [] }`, with no fabricated `capturedSourceState`. Add strict failures for unknown v2 fields, future persistence versions, malformed source state, more than 8 milestones, and a serialized envelope over 32 KiB.

- [ ] **Step 2: Run the focused store test and verify RED**

```bash
pnpm exec vitest run packages/core/src/workspace-checkpoint-store.test.ts --no-file-parallelism
```

Expected: FAIL because `readContinuity`, persistence schema v2, and milestone/source-state parsing do not exist.

- [ ] **Step 3: Implement private v1/v2 parsing without changing the public checkpoint schema**

Use an internal union:

```ts
type PersistedContinuity =
  | { kind: "legacy"; current: WorkspaceCheckpoint }
  | {
      kind: "v2";
      current: WorkspaceCheckpoint;
      capturedSourceState?: WorkspaceCheckpointSourceStateRef;
      milestones: WorkspaceMilestone[];
    };
```

Keep `WORKSPACE_CHECKPOINT_SCHEMA_VERSION = 1`. Parse persisted top-level `schemaVersion` as either legacy checkpoint `1` or private envelope `2`; do not reinterpret the public checkpoint version constant.

- [ ] **Step 4: Write failing tests for source-state persistence, milestone append, eviction, compaction, clear, and lazy migration**

Create revision 1 with source state A, update with expected revision 1 and source state B, and assert revision 1 becomes the first milestone carrying source state A. Perform enough updates to prove only the newest 8 displaced revisions remain. Use `"界".repeat(300)` and assert compacted UTF-8 byte length `<= 512`. Assert `clear()` removes current + history. Assert updating a legacy-v1 file writes v2 but does not invent source state for the displaced legacy milestone.

- [ ] **Step 5: Run focused tests and verify RED for milestone behavior**

Run the same focused Vitest command. Expected: milestone/source-state tests still FAIL until the write path exists.

- [ ] **Step 6: Implement v2 write path and deterministic UTF-8-safe milestone compaction**

Use a helper equivalent to:

```ts
function compactUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let output = "";
  for (const char of value) {
    if (Buffer.byteLength(output + char, "utf8") > maxBytes) break;
    output += char;
  }
  return output;
}
```

Compact only displaced milestones; preserve current checkpoint content exactly within existing bounds. Retain newest 8 milestones with `slice(-WORKSPACE_MILESTONE_MAX_COUNT)`.

- [ ] **Step 7: Run focused tests and core typecheck**

```bash
pnpm exec vitest run packages/core/src/workspace-checkpoint-store.test.ts --no-file-parallelism
pnpm --filter @kodegpt/core run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/workspace-checkpoint-store.ts packages/core/src/workspace-checkpoint-store.test.ts packages/core/src/index.ts
git commit -m "feat: persist continuity milestone history"
```

---

### Task 2: Workspace Continuity Info and Server-Owned Source-State Capture

**Files:**
- Modify: `packages/core/src/workspace-manager.ts`
- Modify: `packages/core/src/workspace-manager.test.ts`
- Modify: `packages/mcp-server/src/tool-context.ts`
- Create: `packages/mcp-server/src/tool-context.continuity.test.ts`

**Interfaces:**
- Consumes: Task 1 `WorkspaceContinuityRecord`, existing `NativeCapabilityToolAdapter.gitChanges()`.
- Produces internal manager mutation:

```ts
export type WorkspaceCheckpointMutationInput =
  | {
      workspaceId: string;
      operation: "upsert";
      expectedRevision?: number;
      checkpoint: WorkspaceCheckpointBody;
      capturedSourceState: WorkspaceCheckpointSourceStateRef;
    }
  | {
      workspaceId: string;
      operation: "clear";
      expectedRevision: number;
    };
```

and public read:

```ts
export interface WorkspaceInfo extends OpenWorkspace {
  checkpoint?: WorkspaceCheckpoint;
  continuity?: WorkspaceContinuityInfo;
}
```

The MCP-facing checkpoint input remains source-state-free.

- [ ] **Step 1: Write failing WorkspaceManager tests**

Assert `workspaceInfo()` returns both checkpoint and continuity metadata from one `readContinuity()` result. Assert `checkpointWorkspace(upsert)` passes exact `capturedSourceState` to the store while preserving existing audit ordering and expected-revision behavior.

- [ ] **Step 2: Run manager tests and verify RED**

```bash
pnpm exec vitest run packages/core/src/workspace-manager.test.ts --no-file-parallelism
```

Expected: FAIL because manager/storage interfaces do not expose continuity/source-state yet.

- [ ] **Step 3: Implement manager contract changes**

Change only continuity-related storage calls. `workspaceInfo()` returns neither field when absent, otherwise:

```ts
return {
  ...workspace,
  checkpoint: record.checkpoint,
  continuity: record.continuity
};
```

- [ ] **Step 4: Write failing composition test proving the caller cannot provide source state**

Construct `createKodegptToolContext()` with a native adapter whose `gitChanges()` returns source state A and a manager spy. Call normal public checkpoint upsert and assert the manager receives `capturedSourceState: sourceStateA`. Make `gitChanges()` reject and assert manager mutation is never called.

- [ ] **Step 5: Run composition test and verify RED**

```bash
pnpm exec vitest run packages/mcp-server/src/tool-context.continuity.test.ts --no-file-parallelism
```

Expected: FAIL because current tool context forwards checkpoint input directly.

- [ ] **Step 6: Implement one-shot source-state capture in MCP composition**

```ts
checkpoint: async (input) => {
  if (input.operation === "clear") {
    return options.workspaceManager.checkpointWorkspace(input);
  }
  const capturedSourceState = (await native.gitChanges({ workspaceId: input.workspaceId })).sourceState;
  return options.workspaceManager.checkpointWorkspace({ ...input, capturedSourceState });
}
```

Exactly one `gitChanges()` per upsert, zero on clear.

- [ ] **Step 7: Run focused tests and typecheck**

```bash
pnpm exec vitest run packages/core/src/workspace-manager.test.ts packages/mcp-server/src/tool-context.continuity.test.ts --no-file-parallelism
pnpm --filter @kodegpt/core run typecheck
pnpm --filter @kodegpt/mcp-server run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/workspace-manager.ts packages/core/src/workspace-manager.test.ts packages/mcp-server/src/tool-context.ts packages/mcp-server/src/tool-context.continuity.test.ts
git commit -m "feat: bind checkpoints to captured source state"
```

---

### Task 3: Add Repository-Level `context.build(intent="resume")`

**Files:**
- Modify: `packages/capabilities/src/contracts.ts`
- Modify: `packages/capabilities/src/schemas.ts`
- Modify: `packages/capabilities/src/context-build.ts`
- Modify: `packages/capabilities/src/context-build.test.ts`
- Modify: `packages/capabilities/src/public-actions.ts`
- Modify: `packages/capabilities/src/public-actions.test.ts`

**Interfaces:**
- Produces:

```ts
export type ContextIntent =
  | "understand"
  | "implement"
  | "debug"
  | "review"
  | "verify"
  | "resume";
```

with:

```ts
resume: { target: 80, changed: 100, tests: 50, config: 40, search: 50 }
```

- [ ] **Step 1: Write failing contract/weighting tests**

Assert `ContextBuildInputSchema` accepts `resume`, and `buildContext()` ranks changed files ahead of generic search/config candidates under resume weighting. Existing intent weights remain exact.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm exec vitest run packages/capabilities/src/context-build.test.ts packages/capabilities/src/public-actions.test.ts --no-file-parallelism
```

Expected: FAIL because `resume` is not valid yet.

- [ ] **Step 3: Implement additive intent only**

Update `ContextIntent`, both strict Zod intent enums, `INTENT_WEIGHTS`, validation, and `context.build` aliases/tags with `resume development`, `continue workspace`, and `resume context`. Do not add process/preview/PR/CI dependencies to capabilities.

- [ ] **Step 4: Run focused tests and capabilities typecheck**

```bash
pnpm exec vitest run packages/capabilities/src/context-build.test.ts packages/capabilities/src/public-actions.test.ts --no-file-parallelism
pnpm --filter @kodegpt/capabilities run typecheck
```

Expected: PASS; action count remains 76.

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/contracts.ts packages/capabilities/src/schemas.ts packages/capabilities/src/context-build.ts packages/capabilities/src/context-build.test.ts packages/capabilities/src/public-actions.ts packages/capabilities/src/public-actions.test.ts
git commit -m "feat: add resume repository context intent"
```

---

### Task 4: Pure Resume Relation and Evidence Composer

**Files:**
- Create: `packages/mcp-server/src/resume-context.ts`
- Create: `packages/mcp-server/src/resume-context.test.ts`
- Modify: `packages/mcp-server/src/tool-context.ts`
- Modify: `packages/mcp-server/src/index.ts` only if export convention requires it.

**Interfaces:**
- Produces:

```ts
export type ResumeRelation = "fresh" | "stale" | "superseded" | "unverifiable";

export type ResumeReason =
  | "SOURCE_STATE_MATCH"
  | "WORKTREE_CHANGED"
  | "HEAD_ADVANCED"
  | "HEAD_REWOUND"
  | "HEAD_DIVERGED"
  | "LEGACY_SOURCE_STATE_UNKNOWN"
  | "GIT_ANCESTRY_UNAVAILABLE";
```

and a discriminated `ResumeSynthesis` with `checkpointPresent: false | true`, plus ordered evidence observations.

Use a narrow adapter:

```ts
export interface ResumeContextAdapter {
  workspaceInfo(workspaceId: string): Promise<WorkspaceInfo>;
  gitRange(input: GitRangeInput): Promise<GitRangeResult>;
  processStatus(workspaceId: string, operationId: string): Promise<WorkspaceProcessOperationResult>;
  previewInspect(input: PreviewLookupInput): Promise<PreviewStatusResult>;
  repository(workspaceId: string): Promise<CiRepositoryResult>;
  prInspect(input: GitHubPrInspectInput): Promise<GitHubPrInspectResult>;
  ciRun(input: CiRunInput): Promise<CiRunResult>;
  artifactProbe(uri: string): Promise<void>;
}
```

The current source state comes from the already-built base context (`base.git?.sourceState`), so the composer must not perform a second `git.changes` scan.

- [ ] **Step 1: Write relation tests first**

Prove:

```text
same head + same fingerprint      -> fresh / SOURCE_STATE_MATCH
same head + different fingerprint -> stale / WORKTREE_CHANGED
captured ancestor of current      -> stale / HEAD_ADVANCED
current ancestor of captured      -> superseded / HEAD_REWOUND
neither ancestor                  -> superseded / HEAD_DIVERGED
no captured source state          -> unverifiable / LEGACY_SOURCE_STATE_UNKNOWN
range failure                     -> unverifiable / GIT_ANCESTRY_UNAVAILABLE
```

Assert one range read for `HEAD_ADVANCED`, at most two for rewind/divergence.

- [ ] **Step 2: Run composer test and verify RED**

```bash
pnpm exec vitest run packages/mcp-server/src/resume-context.test.ts --no-file-parallelism
```

Expected: FAIL because composer does not exist.

- [ ] **Step 3: Implement pure checkpoint relation**

```ts
export async function reconcileCheckpointSourceState(
  adapter: Pick<ResumeContextAdapter, "gitRange">,
  workspaceId: string,
  captured: SourceStateRef | undefined,
  current: SourceStateRef
): Promise<ResumeCheckpointSynthesis>
```

Use OID revisions only; never use timestamps, branch names, or messages as freshness authority.

- [ ] **Step 4: Write failing evidence-ref tests**

Cover process `op_*`, preview `pv_*`, PR decimal number, CI decimal run ID, full Git OID, `artifact://...`, and note. Assert one primary read per valid ref, no mutation, invalid/missing/unavailable refs degrade individually, and output order matches checkpoint order.

- [ ] **Step 5: Implement bounded evidence reconciliation**

Validate formats before calls. Resolve repository lazily once and reuse for PR refs. Process status is one zero-wait read; preview inspect one read; CI run one read. Treat a valid full-OID `git` ref as bounded informational evidence unless a concrete relation requires a history read; do not fetch patches automatically. Probe an `artifact://` ref with the existing artifact read path at zero/minimal content budget so resume never injects artifact contents. `note` is informational with no call. Prefer simple sequential reconciliation across the bounded maximum of 16 refs; if implementation parallelizes independent reads, use per-ref settled results rather than a fail-fast aggregate. In either case, catch expected missing/provider/validation failures at the individual ref boundary and preserve original checkpoint evidence ordering. A single ref failure must never reject the whole resume synthesis.

- [ ] **Step 6: Add top-level composer**

```ts
export async function composeResumeSynthesis(
  adapter: ResumeContextAdapter,
  workspaceId: string,
  base: ContextBuildResult
): Promise<ResumeSynthesis>
```

No checkpoint -> `checkpointPresent:false`, no referenced evidence reads. Missing base Git source state -> `unverifiable` + warning, no hidden retry.

- [ ] **Step 7: Run focused test and typecheck**

```bash
pnpm exec vitest run packages/mcp-server/src/resume-context.test.ts --no-file-parallelism
pnpm --filter @kodegpt/mcp-server run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/mcp-server/src/resume-context.ts packages/mcp-server/src/resume-context.test.ts packages/mcp-server/src/tool-context.ts packages/mcp-server/src/index.ts
git commit -m "feat: synthesize bounded resume evidence"
```

---

### Task 5: MCP Structured Contracts and Resume Composition

**Files:**
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/tool-context.ts`
- Modify: `packages/mcp-server/src/structured-results.test.ts`
- Modify: `packages/mcp-server/src/server.test.ts` only where required.

**Interfaces:**
- Additive `workspace.info.continuity` schema.
- Additive public context-result schema with optional `resume`, populated only for `intent="resume"`.

- [ ] **Step 1: Write failing structured-output tests**

Add `workspace.info` continuity fixture with captured source state + milestones. Add `context.build(intent:"resume")` coverage for both `checkpointPresent:false` and `true`. Assert old intents return normal base context without `resume`.

- [ ] **Step 2: Run structured test and verify RED**

```bash
pnpm exec vitest run packages/mcp-server/src/structured-results.test.ts --no-file-parallelism
```

Expected: FAIL until schemas/wiring exist.

- [ ] **Step 3: Add strict source-state, milestone, continuity, and resume schemas**

Near existing checkpoint schemas add:

```ts
const WORKSPACE_SOURCE_STATE_SCHEMA = z.object({
  headOid: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  changesFingerprint: z.string().regex(/^[0-9a-f]{64}$/)
}).strict();
```

Extend `WorkspaceInfoResultSchema` with optional `continuity`. Build the MCP public context result by extending imported `ContextBuildResultSchema`; do not push core checkpoint types into `@kodegpt/capabilities` just for schema composition.

- [ ] **Step 4: Wire read-only `context.build` composition**

```ts
const base = await native.buildContext(input);
if (input.intent !== "resume") return base;
return {
  ...base,
  resume: await composeResumeSynthesis(resumeAdapter, input.workspaceId, base)
};
```

Resume adapter exposes reads only. No cancel/rerun/dispatch/preview-stop/checkpoint mutation is passed to it.

- [ ] **Step 5: Run MCP focused tests and typecheck**

```bash
pnpm exec vitest run packages/mcp-server/src/structured-results.test.ts packages/mcp-server/src/tool-context.continuity.test.ts packages/mcp-server/src/resume-context.test.ts packages/mcp-server/src/server.test.ts --no-file-parallelism
pnpm --filter @kodegpt/mcp-server run typecheck
```

Expected: PASS; tool list unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server/src/tools.ts packages/mcp-server/src/tool-context.ts packages/mcp-server/src/structured-results.test.ts packages/mcp-server/src/server.test.ts
git commit -m "feat: expose structured resume context"
```

---

### Task 6: Host Workflow Guidance and Resume Discoverability

**Files:**
- Modify: `skills/kodegpt-application-development-workflow/SKILL.md`
- Modify: `packages/skills/src/catalog.test.ts`
- Modify: `packages/capabilities/src/public-actions.ts`
- Modify: `packages/capabilities/src/public-actions.test.ts`
- Modify: `packages/mcp-server/src/discovery.test.ts`

- [ ] **Step 1: Write failing workflow/discovery tests**

Require guidance containing `context.build(intent="resume")`, `fresh`, `stale`, `superseded`, `unverifiable`, and `.ai-bridge/current-plan.md`. Query `continue previous development work` and `resume after chat restart`; assert `context.build` and application-development workflow rank relevantly.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm exec vitest run packages/skills/src/catalog.test.ts packages/capabilities/src/public-actions.test.ts packages/mcp-server/src/discovery.test.ts --no-file-parallelism
```

Expected: FAIL until guidance/metadata changes.

- [ ] **Step 3: Update workflow continuation policy**

Use `context.build(intent="resume")` first for explicit continue/resume/lanjutkan. Treat `fresh` as current evidence, `stale` as requiring reconciliation, `superseded` as historical hints only, and `unverifiable` as current-repo-first with missing evidence stated. Keep `.ai-bridge` only for explicit external-agent/cross-chat handoff. Never auto-write checkpoint.

- [ ] **Step 4: Update aliases/tags without changing IDs/count**

Make `context.build` purpose/aliases cover resume/continue intent. In the application-development skill frontmatter, add existing `context.build` to the `continuity` stage actions as well as keeping it in repository understanding, so `system.discover` can truthfully expose the native resume flow. Do not add a second resume action.

- [ ] **Step 5: Run focused tests/typecheck**

```bash
pnpm exec vitest run packages/skills/src/catalog.test.ts packages/capabilities/src/public-actions.test.ts packages/mcp-server/src/discovery.test.ts --no-file-parallelism
pnpm --filter @kodegpt/skills run typecheck
pnpm --filter @kodegpt/capabilities run typecheck
```

Expected: PASS; exactly 76 public actions.

- [ ] **Step 6: Commit**

```bash
git add skills/kodegpt-application-development-workflow/SKILL.md packages/skills/src/catalog.test.ts packages/capabilities/src/public-actions.ts packages/capabilities/src/public-actions.test.ts packages/mcp-server/src/discovery.test.ts
git commit -m "feat: teach host deterministic resume workflow"
```

---

### Task 7: Surface 0.21, Service Compatibility, and Release Documentation

**Files:**
- Modify: `packages/mcp-server/src/surface-version.ts`
- Modify: `packages/mcp-server/src/server.test.ts`
- Modify: `apps/cli/src/service/runtime-status.ts`
- Modify: `apps/cli/src/service/runtime-status.test.ts`
- Modify: `apps/cli/src/commands/service.test.ts`
- Modify: `tests/security/security-invariants.test.ts`
- Modify: `tests/integration/provider-gateway.test.ts`
- Modify as needed: `tests/integration/full-stack.test.ts`
- Modify: `docs/architecture/README.md`
- Modify: `docs/compatibility/chatgpt.md`
- Create: `docs/release/2026-08-21-continuity-v2-resume-intelligence-readiness.md`

- [ ] **Step 1: Write failing version/service assertions**

Update current-version assertions to `0.21`, add runtime-status parser coverage for 0.21, retain all historical versions, and keep exact 76-tool fixtures unchanged.

- [ ] **Step 2: Run version-focused tests and verify RED**

```bash
pnpm exec vitest run packages/mcp-server/src/server.test.ts apps/cli/src/service/runtime-status.test.ts apps/cli/src/commands/service.test.ts tests/security/security-invariants.test.ts tests/integration/provider-gateway.test.ts --no-file-parallelism
```

Expected: FAIL until source version/parser changes.

- [ ] **Step 3: Implement semantic surface bump only**

```ts
export const MCP_SURFACE_VERSION = "0.21" as const;
```

Append `"0.21"` to service runtime union/validation. Runtime/protocol/tool count remain unchanged.

- [ ] **Step 4: Document architecture/compatibility/readiness**

Record private v2/public checkpoint v1, resume relation semantics, one-shot evidence reconciliation, rejected session/task/scheduler/agent scope, 0.21/76 target, and exact local/CI/live evidence slots.

- [ ] **Step 5: Run version/full-stack-adjacent tests and typecheck**

```bash
pnpm exec vitest run packages/mcp-server/src/server.test.ts apps/cli/src/service/runtime-status.test.ts apps/cli/src/commands/service.test.ts tests/security/security-invariants.test.ts tests/integration/provider-gateway.test.ts tests/integration/full-stack.test.ts --no-file-parallelism
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server/src/surface-version.ts packages/mcp-server/src/server.test.ts apps/cli/src/service/runtime-status.ts apps/cli/src/service/runtime-status.test.ts apps/cli/src/commands/service.test.ts tests/security/security-invariants.test.ts tests/integration/provider-gateway.test.ts tests/integration/full-stack.test.ts docs/architecture/README.md docs/compatibility/chatgpt.md docs/release/2026-08-21-continuity-v2-resume-intelligence-readiness.md
git commit -m "feat: release continuity resume surface 0.21"
```

---

### Task 8: Full Local Verification and Resume Dogfood Before PR

**Files:**
- Modify only for genuine defects found by evidence.
- Update: `docs/release/2026-08-21-continuity-v2-resume-intelligence-readiness.md`

- [ ] **Step 1: Run focused continuity/MCP suites**

```bash
pnpm exec vitest run packages/core/src/workspace-checkpoint-store.test.ts packages/core/src/workspace-manager.test.ts packages/capabilities/src/context-build.test.ts packages/mcp-server/src/resume-context.test.ts packages/mcp-server/src/tool-context.continuity.test.ts packages/mcp-server/src/structured-results.test.ts packages/mcp-server/src/discovery.test.ts packages/skills/src/catalog.test.ts --no-file-parallelism
```

Expected: PASS.

- [ ] **Step 2: Run full TypeScript inventory, sharded only if needed**

Use deterministic non-overlapping shards when a one-shot suite exceeds the tool window. Record total passed/skipped/failed counts; do not omit files.

- [ ] **Step 3: Run Rust/typecheck/build/forbidden/package gates**

```bash
cargo test --workspace
pnpm run typecheck
pnpm run build
pnpm run verify:forbidden
pnpm run verify:package
```

Expected: all PASS.

- [ ] **Step 4: Dogfood resume states in disposable trusted Git evidence**

Prove:

```text
checkpoint at A                    -> fresh/SOURCE_STATE_MATCH
change worktree, same HEAD         -> stale/WORKTREE_CHANGED
commit descendant                  -> stale/HEAD_ADVANCED
divergent history                  -> superseded/HEAD_DIVERGED
```

Also reconcile explicit process/preview refs one-shot. Reconcile PR/CI one-shot when available; provider unavailability must degrade per evidence, not fail the whole resume.

- [ ] **Step 5: Verify persistence across close/reopen or isolated candidate restart**

Create a v2 checkpoint with at least one milestone and prove current revision/source state/history survive. Do not production-cutover yet.

- [ ] **Step 6: Review exact diff and update readiness evidence**

Confirm no new public tool, no workflow/session/task/agent subsystem, no Codex dependency, and target `0.21 / 76`.

- [ ] **Step 7: Commit readiness changes only if file content changed**

```bash
git add docs/release/2026-08-21-continuity-v2-resume-intelligence-readiness.md
git commit -m "docs: record continuity v2 readiness evidence"
```

---

### Task 9: Exact-Head PR, Guarded Merge, Production Cutover, Host Dogfood, and Cleanup

**Files:**
- No source edits expected.

- [ ] **Step 1: Verify clean candidate head and push without force**

Record full OID. Keep one implementation branch lineage; do not create a divergent duplicate branch.

- [ ] **Step 2: Create PR with exact scope/evidence**

State private persistence v2/public checkpoint v1, `context.build(intent="resume")`, relation/evidence semantics, 0.21/76, no new authority/tool family, and exact local verification.

- [ ] **Step 3: Require exact-head push + PR-event CI SUCCESS**

Inspect the full candidate OID. Never rerun/cancel merely because CI is slow. A genuine failure requires evidence-driven repair, fresh local proof, new head, and new exact-head CI.

- [ ] **Step 4: Guarded merge exact passing head**

Merge with `expectedHeadOid=<exact passing feature OID>` and record merge SHA.

- [ ] **Step 5: Require merged-main CI SUCCESS on exact merge SHA**

Reconcile canonical/isolated workspace first if needed; do not interpret stale child revision failures as provider failure.

- [ ] **Step 6: Build immutable production candidate from exact clean merge SHA**

Require provenance merge SHA + dirty=false. Do not reuse a feature-worktree build as production provenance.

- [ ] **Step 7: Cut over and verify live health**

Require:

```text
runtimeVersion = 0.1
mcpProtocolVersion = 2026-07-28
mcpSurfaceVersion = 0.21
publicTools.count = 76
system.health.ok = true
```

- [ ] **Step 8: Perform refreshed ChatGPT-host dogfood**

Prove live `system.capabilities`, resume-oriented `system.discover`, server-captured checkpoint source state, `workspace.info.continuity`, and `context.build(intent="resume")` across fresh/stale/advanced/diverged scenarios. Verify one-shot process/preview evidence and restart persistence.

- [ ] **Step 9: Cleanup only this phase's lifecycle state**

Close child workspace registration, remove clean worktree, safely delete merged local branch and remote branch, remove only P0-C child trust, preserve unrelated trust/worktrees, fast-forward canonical without reset/stash/clean of unrelated work, and remove only generated cache noise proven to belong to this phase.

- [ ] **Step 10: Final closure evidence**

Require:

```text
HEAD == origin/main == <merge SHA>
canonical clean
P0-C local/remote branch absent
P0-C worktree/trust absent
merged-main CI PASS
live 0.21 / 76 healthy
```

Only then declare **P0-C CLOSED**. Do not start P0-E before closure.
