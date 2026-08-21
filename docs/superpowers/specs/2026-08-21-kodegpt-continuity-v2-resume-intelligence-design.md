# KodeGPT Continuity v2 + Resume Intelligence Design

**Date:** 2026-08-21  
**Status:** Approved design, pre-implementation  
**Roadmap phase:** P0-C  
**Baseline:** `main` at `0d0885d605578fdd084ce86437cbb577be25c8a1`, runtime `0.1`, protocol `2026-07-28`, surface `0.20`, 76 public tools

## 1. Objective

Make native development continuity trustworthy across ChatGPT conversations and service restarts without turning KodeGPT into a session manager, task database, scheduler, or autonomous workflow engine.

Continuity v2 must let the host answer three questions deterministically:

1. What development objective/checkpoint was last recorded?
2. Does that checkpoint still describe the current source state?
3. What bounded referenced evidence is still observable now?

The host remains the planner. KodeGPT stores bounded development state and synthesizes read-only resume evidence; it never decides that a task is complete, reruns work automatically, polls indefinitely, or advances a workflow on its own.

## 2. Existing foundation and exact gaps

The current implementation already has a strong v1 foundation:

- one durable checkpoint per trusted workspace;
- compare-and-swap revision semantics;
- private persistence under the KodeGPT state root;
- strict status invariants and byte/item bounds;
- `workspace.info` as the read surface;
- `workspace.checkpoint` as the only mutation surface;
- purge on `workspace.untrust`;
- host-owned resume guidance in `kodegpt-application-development-workflow`;
- source-state binding from P0-B via `{ headOid, changesFingerprint }`.

The remaining gaps are narrow but cross-cutting:

- checkpoint v1 stores `branch/headOid` only, so it cannot distinguish a clean checkpoint from a changed working tree at the same HEAD;
- only the current checkpoint is retained, so meaningful recent milestone transitions are lost;
- resume reconciliation is conversational/manual rather than deterministic;
- `context.build` has no `resume` intent;
- process/preview/PR/CI evidence references are stored but not reconciled on resume;
- stale and superseded checkpoints are not explicitly classified.

## 3. Architectural decision

### 3.1 Keep the public tool surface flat

Do **not** add any of the following:

```text
workspace.resume
session.*
resume.*
workflow.run
skill.run
agent.*
task.*
```

Instead:

- extend existing `workspace.info` additively with bounded continuity metadata;
- extend existing `context.build` with `intent: "resume"` and an additive `resume` result;
- keep `workspace.checkpoint` as the only continuity mutation tool.

Public tool count remains exactly **76**.

### 3.2 Use a composition-layer resume composer

Do not inject process, preview, GitHub, and CI dependencies into `NativeCapabilityService` merely for resume.

`NativeCapabilityService.buildContext` remains responsible for repository context: workspace inspection, Git changes, search, focused context, and verification discovery. `ContextIntent` gains `"resume"` with deterministic repository weighting, but no new execution/provider dependencies.

A small pure/read-only resume composer lives at the MCP composition boundary where the existing managers/services are already available. It combines:

- base `context.build(intent="resume")` repository context;
- `workspace.info` continuity state;
- current `git.changes.sourceState`;
- existing `git.range` ancestry evidence when needed;
- referenced process/preview/PR/CI evidence only.

This preserves existing component boundaries and avoids a second manager or generic orchestration subsystem.

## 4. Persistence model: private envelope v2, public checkpoint v1

The public checkpoint contract remains schema v1. Its body, CAS revision semantics, status invariants, and current 16 KiB bound remain unchanged.

Persistence evolves privately from a bare checkpoint document into a schema-v2 envelope:

```ts
interface PersistedWorkspaceContinuityV2 {
  schemaVersion: 2;
  current: WorkspaceCheckpoint; // public checkpoint schemaVersion: 1
  capturedSourceState?: SourceStateRef;
  milestones: WorkspaceMilestone[];
}

interface SourceStateRef {
  headOid: string;
  changesFingerprint: string;
}

interface WorkspaceMilestone {
  revision: number;
  status: "active" | "blocked" | "complete";
  objective?: string; // compacted, <= 512 UTF-8 bytes
  sourceState?: SourceStateRef;
  updatedAt: string;
}
```

The separation is intentional:

- public checkpoint schema v1 remains stable;
- private persistence may evolve independently;
- source-state capture is server-owned evidence, not caller-controlled checkpoint metadata;
- milestone history is bounded revision history, not a task/event database.

Use separate constants for these two version domains (for example public `WORKSPACE_CHECKPOINT_SCHEMA_VERSION = 1` and private `WORKSPACE_CONTINUITY_PERSISTENCE_SCHEMA_VERSION = 2`). Do not reinterpret the existing public checkpoint version constant as the persistence-envelope version.

### 4.1 Bounds

Keep the state intentionally small:

- current checkpoint: existing maximum 16 KiB serialized;
- milestone count: maximum 8, newest retained;
- milestone objective: maximum 512 UTF-8 bytes after deterministic UTF-8-safe compaction;
- no milestone `nextActions`, `evidenceRefs`, `blocker`, or `notes`;
- persisted schema-v2 envelope: maximum 32 KiB serialized.

When appending the ninth milestone, discard only the oldest milestone. Never truncate the current checkpoint to make history fit.

## 5. Source-state capture semantics

On every explicit `workspace.checkpoint(operation="upsert")`:

1. validate the public request body;
2. resolve `git.changes({workspaceId}).sourceState` exactly once immediately before durable checkpoint mutation;
3. if source-state capture fails, fail the upsert and do not mutate continuity state;
4. perform the existing CAS mutation;
5. when replacing a prior checkpoint, compact that displaced revision into milestone history using the source state captured with that prior checkpoint;
6. store the new current checkpoint with the newly captured source state.

The source-state snapshot is evidence, not a Git lock. KodeGPT does not freeze the workspace between capture and persistence. If the workspace changes immediately afterward, resume correctly observes a mismatch later.

### 5.1 Wiring without a package dependency cycle

The public caller must never provide `capturedSourceState`. The MCP composition layer already has both the native Git adapter and `WorkspaceManager`; it resolves `native.gitChanges({workspaceId}).sourceState` and passes that value through a **server-only** field on the internal checkpoint mutation call. `WorkspaceManager`/the store persist the structural `{headOid, changesFingerprint}` value but do not import `@kodegpt/capabilities` types or calculate a second fingerprint.

This keeps ownership clean:

```text
MCP tool composition
  -> resolve native git.changes sourceState once
  -> WorkspaceManager checkpoint mutation (server-only sourceState)
  -> private continuity store
```

No second Git scan, duplicate fingerprint algorithm, or circular `core -> capabilities` dependency is allowed.

`clear` keeps current CAS semantics and removes the whole continuity document, including milestone history. `untrust` continues to purge all continuity state.

## 6. Backward compatibility and migration

Existing persisted schema-v1 checkpoint files must remain readable.

Read behavior:

- schema v1 is normalized in memory as the current checkpoint with `capturedSourceState` unknown and empty milestone history;
- schema v2 is parsed strictly with unknown-field rejection and all bounds enforced;
- unsupported future versions still fail with `CHECKPOINT_SCHEMA_UNSUPPORTED`;
- malformed or oversized state still fails closed.

Write behavior:

- no eager filesystem migration is required;
- the first successful upsert of a legacy v1 checkpoint writes schema v2;
- the displaced legacy current checkpoint may become a milestone, but its `sourceState` remains absent because KodeGPT must not fabricate historical freshness evidence.

No destructive migration command is added.

## 7. `workspace.info` continuity metadata

Keep the existing optional `checkpoint` field unchanged and add one optional sibling field when a checkpoint exists:

```ts
interface WorkspaceContinuityInfo {
  schemaVersion: 1;
  capturedSourceState?: SourceStateRef;
  milestones: WorkspaceMilestone[];
}

interface WorkspaceInfo extends OpenWorkspace {
  checkpoint?: WorkspaceCheckpoint;
  continuity?: WorkspaceContinuityInfo;
}
```

Invariants:

- `continuity` is absent when no checkpoint exists;
- if `checkpoint` exists, `continuity` exists;
- `capturedSourceState` may be absent only for legacy state whose source state is genuinely unknown;
- milestones are returned oldest-to-newest for deterministic reading;
- no raw persistence schema details, trust identity, logs, or filesystem paths are exposed.

## 8. `context.build(intent="resume")`

### 8.1 Base repository context

Add `"resume"` to `ContextIntent` and the strict MCP input schema.

Resume repository weighting should emphasize current change state and nearby implementation context rather than whole-repository exploration. A suitable deterministic profile is:

```ts
resume: { target: 80, changed: 100, tests: 50, config: 40, search: 50 }
```

The ordinary context builder still performs only its existing repository responsibilities. Existing intents and results must remain behaviorally unchanged.

### 8.2 Additive resume synthesis

For `intent="resume"` only, the public result adds:

```ts
type ResumeRelation = "fresh" | "stale" | "superseded" | "unverifiable";

type ResumeReason =
  | "SOURCE_STATE_MATCH"
  | "WORKTREE_CHANGED"
  | "HEAD_ADVANCED"
  | "HEAD_REWOUND"
  | "HEAD_DIVERGED"
  | "LEGACY_SOURCE_STATE_UNKNOWN"
  | "GIT_ANCESTRY_UNAVAILABLE";

interface ResumeCheckpointSynthesis {
  relation: ResumeRelation;
  reasons: ResumeReason[];
  currentSourceState?: SourceStateRef;
  capturedSourceState?: SourceStateRef;
}

interface ResumeEvidenceObservation {
  kind: "artifact" | "process" | "preview" | "pr" | "ci" | "git" | "note";
  ref: string;
  availability: "observed" | "missing" | "unavailable" | "invalid" | "informational";
  state?: string;
  relation?: "fresh" | "stale" | "unverifiable";
  reasons?: string[];
  summary?: string;
}

type ResumeSynthesis =
  | {
      schemaVersion: 1;
      checkpointPresent: false;
      milestones: [];
      evidence: [];
      warnings: string[];
    }
  | {
      schemaVersion: 1;
      checkpointPresent: true;
      checkpoint: WorkspaceCheckpoint;
      checkpointState: ResumeCheckpointSynthesis;
      milestones: WorkspaceMilestone[];
      evidence: ResumeEvidenceObservation[];
      warnings: string[];
    };
```

The exact implementation types may be split into smaller interfaces, but these semantics are authoritative. `checkpointPresent` is the discriminator and prevents "no checkpoint" from being confused with an error or an unverifiable checkpoint.

If no checkpoint exists, `context.build(intent="resume")` still returns normal repository context with `resume.checkpointPresent:false`; it performs no process/preview/PR/CI reconciliation because there are no checkpoint evidence references to follow.

## 9. Deterministic checkpoint relation

Compare the checkpoint's captured source state with current `git.changes.sourceState`.

### 9.1 Fresh

```text
captured.headOid == current.headOid
AND
captured.changesFingerprint == current.changesFingerprint
```

Result:

```text
relation = fresh
reason = SOURCE_STATE_MATCH
```

### 9.2 Stale: working tree changed

```text
captured.headOid == current.headOid
AND
captured.changesFingerprint != current.changesFingerprint
```

Result:

```text
relation = stale
reason = WORKTREE_CHANGED
```

### 9.3 Stale: HEAD advanced

When HEAD differs, ancestry resolution is bounded to at most two existing `git.range` reads:

1. call `git.range(base=captured.headOid, head=current.headOid)`;
2. if `isAncestor:true`, classify `HEAD_ADVANCED` and stop;
3. otherwise call `git.range(base=current.headOid, head=captured.headOid)` once;
4. if the reverse range has `isAncestor:true`, classify `HEAD_REWOUND`;
5. otherwise classify `HEAD_DIVERGED`.

If captured HEAD is an ancestor of current HEAD:

```text
relation = stale
reason = HEAD_ADVANCED
```

The fingerprint does not override this classification; the repository has moved beyond the checkpoint either way.

### 9.4 Superseded: rewound or diverged

If the bounded reverse range proves current HEAD is an ancestor of captured HEAD:

```text
relation = superseded
reason = HEAD_REWOUND
```

If both bounded ancestry checks return valid `isAncestor:false` evidence:

```text
relation = superseded
reason = HEAD_DIVERGED
```

`superseded` means the checkpoint's Git baseline is no longer on the current development line. It does **not** mean the objective was completed.

### 9.5 Unverifiable

Use `unverifiable` when deterministic comparison cannot be established, including:

- legacy checkpoint has no captured source state;
- Git ancestry evidence is unavailable or invalid.

Do not guess based on timestamps, branch names, commit messages, or conversation memory.

## 10. Evidence-reference reconciliation

Resume must reconcile only evidence explicitly named by the current checkpoint. It must never enumerate all processes, previews, PRs, or CI runs.

Maximum work is therefore bounded by the existing maximum of 16 evidence references. Each reference may trigger at most one primary read (plus the at-most-two Git ancestry reads for checkpoint relation); returned observations must preserve the checkpoint's original evidence-ref order even if independent reads are executed concurrently.

### 10.1 Process

For a syntactically valid `op_*` ref:

- call existing `process.status` with `waitMs: 0`;
- never poll or wait for completion;
- record terminal/running state only;
- if the process result exposes source state, compare it to current source state and report evidence relation `fresh/stale/unverifiable`.

A missing/expired operation becomes a bounded `missing` observation; it does not make the whole resume call fail.

### 10.2 Preview

For a syntactically valid `pv_*` ref:

- call existing `preview.inspect` once;
- record current preview lifecycle state;
- compare preview source state to current source state when available;
- never restart or stop a preview during resume.

### 10.3 Pull request

For `kind:"pr"`, accept only a canonical decimal PR number in the ref. Resolve the workspace repository through existing repository/CI identity, then call the existing read-only `github.pr.inspect` exactly once.

Record open/closed/merged state. Do not infer local source freshness solely from PR branch names.

### 10.4 CI

For `kind:"ci"`, accept only a canonical decimal run ID and call existing `ci.run` once.

Record queued/in-progress/completed state, conclusion, and head OID when available. No `ci.rerun`, `ci.cancel`, `ci.dispatch`, polling, or mutation is permitted from resume synthesis.

### 10.5 Git, artifact, and note

- `git`: validate a full Git OID and inspect bounded history only when useful; otherwise preserve as informational evidence.
- `artifact`: validate the existing `artifact://` form; existence may be checked read-only without materializing full content, but artifact content is never injected automatically into resume context.
- `note`: always informational; never treated as independently verifiable evidence.

Unknown/legacy ref formatting becomes `invalid` or `unavailable` evidence rather than crashing the entire synthesis.

## 11. Error and degradation model

Resume is a read-only evidence synthesis and should degrade per evidence source.

The whole operation may fail when:

- workspace is not READY;
- persisted continuity state is malformed/unsupported/oversized;
- base `context.build` encounters an existing fatal contract error.

The whole operation should **not** fail merely because:

- a referenced process expired;
- a preview was stopped and forgotten;
- GitHub read provider is unavailable;
- a PR/CI reference no longer resolves;
- one evidence ref uses an invalid legacy format;
- Git ancestry cannot be established.

Those cases become bounded observations/warnings. This keeps resume useful during partial outages without silently claiming freshness.

## 12. Milestone semantics

Milestones are revision snapshots, not tasks.

A milestone is created only when an explicit checkpoint upsert displaces a previous current checkpoint. There is no timer, event stream, automatic checkpointing, or background capture.

Milestones answer only: "what were the most recent checkpoint states before the current one?"

They do not contain:

- next-action queues;
- evidence-ref copies;
- stdout/stderr;
- diffs/source files;
- retry state;
- assignees/agents;
- scheduling metadata;
- conversation messages or reasoning.

The host may use milestones to understand progression, but KodeGPT does not derive workflow transitions from them.

## 13. Application-development skill behavior

Update the continuation section of `kodegpt-application-development-workflow`:

1. on explicit continue/resume/`lanjutkan`, prefer `context.build(intent="resume")` for native continuity synthesis;
2. treat returned checkpoint objective, next actions, blocker, milestones, and relation as bounded evidence;
3. if relation is `stale`, inspect current changes and adjust the plan rather than replaying checkpoint actions blindly;
4. if relation is `superseded`, treat checkpoint actions as historical hints only until current Git state is re-understood;
5. if `unverifiable`, say what evidence is missing and continue from current repository evidence;
6. consult `.ai-bridge/current-plan.md` only when explicit external-agent/cross-chat handoff context makes it relevant, preserving the existing responsibility split.

No automatic checkpoint mutation is introduced by the skill.

## 14. Public discovery and surface version

Update action metadata so `system.discover` can rank `context.build` and the application-development skill for intents such as:

- continue previous development work;
- resume after chat restart;
- reconcile stale checkpoint;
- what was left to do in this workspace.

Because public `context.build` accepts a new intent and returns additive resume data, and `workspace.info` returns additive continuity metadata, bump semantic MCP surface:

```text
runtime: 0.1 unchanged
protocol: 2026-07-28 unchanged
surface: 0.20 -> 0.21
public tools: 76 unchanged
```

A production immutable release/cutover and refreshed host dogfood are required before P0-C closure.

## 15. Security and authority invariants

Resume introduces no new authority.

- all repository reads stay inside existing trusted workspace boundaries;
- process/preview observations use existing opaque IDs and workspace binding;
- GitHub/CI reads use already admitted providers;
- resume never invokes mutation APIs;
- source-state capture for checkpoint upsert uses existing `git.changes` authority;
- persisted continuity remains private KodeGPT state with existing permissions and atomic-write discipline;
- unknown future schemas fail closed;
- no raw credentials, filesystem identity, conversation content, or chain-of-thought are persisted.

## 16. Testing strategy

Implementation must use TDD and prove behavior at each layer.

### 16.1 Checkpoint-store tests

Cover:

- v1 read compatibility;
- v2 strict parsing;
- v1 -> v2 lazy migration on upsert;
- source-state persistence;
- milestone append/order/8-item eviction;
- UTF-8-safe objective compaction;
- current 16 KiB and envelope 32 KiB limits;
- clear removes current + history;
- untrust purge remains idempotent;
- malformed/future versions fail closed.

### 16.2 Workspace/checkpoint tests

Cover:

- upsert captures source state before mutation;
- source-state resolution failure prevents mutation;
- existing CAS semantics remain exact;
- `workspace.info` exposes current checkpoint + continuity metadata;
- legacy info exposes unknown captured source state truthfully.

### 16.3 Resume-composer tests

At minimum prove:

1. exact source state -> `fresh/SOURCE_STATE_MATCH`;
2. same HEAD + changed fingerprint -> `stale/WORKTREE_CHANGED`;
3. captured HEAD ancestor of current -> `stale/HEAD_ADVANCED`;
4. current HEAD ancestor of captured -> `superseded/HEAD_REWOUND`;
5. divergent histories -> `superseded/HEAD_DIVERGED`;
6. legacy source state -> `unverifiable/LEGACY_SOURCE_STATE_UNKNOWN`;
7. ancestry provider failure -> `unverifiable/GIT_ANCESTRY_UNAVAILABLE`;
8. process/preview source-state comparison;
9. PR/CI one-shot read reconciliation;
10. missing/invalid individual evidence degrades rather than failing the whole resume result;
11. no mutation method is called.

### 16.4 MCP/schema/discovery tests

Cover:

- strict `intent:"resume"` input;
- old intents unchanged;
- structured `resume` output;
- additive `workspace.info.continuity`;
- exact 76 public tools;
- surface `0.21`;
- deterministic discovery ranking for resume intents.

### 16.5 Live dogfood

Use a disposable trusted Git repository or an isolated safe fixture and prove:

- checkpoint at source state A;
- exact resume -> fresh;
- modify working tree without moving HEAD -> stale WORKTREE_CHANGED;
- commit forward -> stale HEAD_ADVANCED;
- create divergent history -> superseded HEAD_DIVERGED;
- referenced background process/preview evidence reconciles without mutation;
- PR/CI referenced evidence is read once when available;
- service restart preserves v2 continuity and milestone history;
- ChatGPT-host `context.build(intent="resume")` and `system.discover` expose the live 0.21 behavior.

## 17. Delivery and closure gates

P0-C is complete only after all of the following:

1. design and implementation remain within this approved scope;
2. focused TDD and full repository tests pass;
3. Rust workspace tests pass if shared/runtime code is affected;
4. typecheck and build pass;
5. exact-head PR CI passes;
6. guarded merge uses the exact passing PR head;
7. merged-main CI passes on the exact merge SHA;
8. immutable service candidate is built from that exact merge SHA with clean provenance;
9. production cutover reports runtime `0.1`, protocol `2026-07-28`, surface `0.21`, exactly 76 tools;
10. live resume dogfood passes;
11. feature worktree/local branch/remote branch/trust are cleaned;
12. canonical `main == origin/main` and is clean.

Do not start P0-E until these gates are complete.

## 18. Explicit non-goals

P0-C does not add:

- conversation/session persistence;
- automatic chat restoration;
- task/project database;
- autonomous planning or checkpoint writing;
- scheduler, watcher, retry loop, or background monitor;
- process/preview list APIs;
- PR/CI database replication;
- vector database or semantic memory store;
- generic provider/plugin execution;
- multi-agent runtime;
- Codex runtime dependency;
- automatic CI reruns or preview restarts.

## 19. Acceptance summary

The intended end state is deliberately narrow:

```text
workspace.checkpoint
  -> bounded current development state + server-captured source state
  -> bounded recent milestone history

context.build(intent="resume")
  -> current repository context
  + checkpoint/source-state reconciliation
  + one-shot observations of explicitly referenced evidence
  -> deterministic fresh/stale/superseded/unverifiable synthesis

ChatGPT
  -> interprets evidence
  -> decides what to do next
```

Continuity v2 succeeds when a new ChatGPT conversation can resume development from durable KodeGPT evidence without trusting stale checkpoint text blindly and without KodeGPT becoming a session manager or autonomous workflow engine.
