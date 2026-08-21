# KodeGPT Evidence Freshness + Source-State Binding Design

Date: 2026-08-21
Status: approved design, implementation candidate
Baseline: `main` `221538a2e45debed7a6d844c5f8af044303d3ac3`, runtime `0.1`, MCP protocol `2026-07-28`, semantic surface `0.19`, 76 public tools
Branch: `feat/evidence-freshness-source-state`

## 1. Objective

Bind development evidence to the exact repository source state it observed so ChatGPT can determine whether prior verification, preview, browser, or visual evidence still applies after the workspace changes.

The feature must improve correctness without creating a task database, evidence database, workflow engine, background monitor, or new public MCP tool family.

## 2. Core contract

The canonical bounded source-state reference is:

```ts
interface SourceStateRef {
  headOid: string;            // full lowercase 40- or 64-hex Git object ID
  changesFingerprint: string; // lowercase SHA-256 from git.changes canonical checkpoint
}
```

Two source states are identical only when both fields are byte-for-byte equal.

`headOid` captures committed source identity. `changesFingerprint` captures the current staged, worktree, and untracked source identity already represented by `git.changes`. Neither timestamp nor branch name participates in equality.

## 3. Single source of truth

Do not add a second source-state scanner.

Extend the existing private `git.checkpoint` result to include the exact current HEAD OID gathered by the same hardened Git status inspection used for checkpoint records. The preferred implementation is one `git status --porcelain=v2 -z --branch --untracked-files=all` operation whose branch header yields the full HEAD OID and whose records continue to feed the existing checkpoint fingerprint.

The public `git.changes` result remains backward-compatible and adds:

```ts
sourceState: {
  headOid: string;
  changesFingerprint: string;
}
```

The existing top-level `fingerprint` field remains for compatibility and must exactly equal `sourceState.changesFingerprint`.

This makes one `git.changes` call sufficient to obtain the current source state.

## 4. Verification evidence binding

`verify.run` captures `sourceState` immediately before launching the selected recipe and returns it with the existing recipe and operation evidence:

```ts
interface VerifyRunResult {
  schemaVersion: 1;
  workspaceId: string;
  recipe: VerificationRecipe;
  operation: VerificationOperationResult;
  sourceState: SourceStateRef;
}
```

For foreground verification, the source-state binding identifies the state at launch. The host may compare it with a later `git.changes.sourceState` before relying on the result.

For background verification, the initial `verify.run(background:true)` result carries the launch state while `process.status` remains a generic process-observation primitive. The host keeps the returned `sourceState`; after one or more background gates finish, one current `git.changes` call is sufficient to classify every retained verification result as fresh or stale.

Do not add `verify.status`, a verification registry, a scheduler, or an automatic rerun loop.

## 5. Preview, browser, and visual propagation

A preview is evidence-bearing runtime state. Capture the workspace `sourceState` immediately before `preview.start` launches its process and persist that bounded value in the existing in-memory preview record.

Add `sourceState` to preview start/inspect results. Browser evidence and visual evidence associated with a preview inherit the preview's stored source state; they do not rescan Git independently.

This preserves a coherent chain:

```text
workspace source state
        |
        v
preview.start
        |
        +--> preview.inspect
        +--> browser.openPreview / inspect / screenshot / console / networkFailures
        +--> visual.captureMatrix / visual.compare
```

If source changes after preview creation, every result derived from that preview still truthfully reports the state the preview represents. ChatGPT compares it with current `git.changes.sourceState` and decides whether to restart/reverify.

Interactive browser actions such as click/type remain action acknowledgements; when their result contract already carries preview identity, it may carry inherited `sourceState` consistently, but no Git scan is performed per browser action.

## 6. Architectural placement

### Rust runtime

Rust remains final Git authority. `git.checkpoint` is extended only enough to expose the full HEAD OID from hardened local Git inspection. Existing helper neutralization, network denial, retained-root authority, output bounds, audit order, and checkpoint record semantics remain unchanged.

### Core

`WorkspaceManager.gitCheckpoint` validates the additive `headOid` field. A small structural source-state type may live in core for preview records, but core must not duplicate the checkpoint fingerprint algorithm.

`PreviewManager` receives a source-state resolver callback through dependency injection and stores the resulting immutable value in each preview record. It does not know how Git state is computed.

### Capabilities

`@kodegpt/capabilities` owns the public `SourceStateRef` schema, constructs it from `git.changes`, binds it to `verify.run`, and validates equality/format constraints. The existing `gitChanges` fingerprint implementation remains the sole changes-fingerprint implementation.

### MCP server / CLI wiring

Existing public tool names are unchanged. Tool output schemas receive additive fields only. Startup wiring injects the existing native Git capability as the source-state resolver for preview creation; no new authority is introduced.

## 7. Freshness semantics

KodeGPT does not persist a mutable `fresh:true/false` flag because freshness is relative to the current workspace state and would become stale itself.

Freshness is deterministic comparison:

```ts
function sameSourceState(left: SourceStateRef, right: SourceStateRef): boolean {
  return left.headOid === right.headOid &&
    left.changesFingerprint === right.changesFingerprint;
}
```

The host may classify:

- `FRESH`: evidence `sourceState` equals current `git.changes.sourceState`;
- `STALE`: either field differs;
- `UNKNOWN`: current source state cannot be obtained.

No autonomous rerun follows a stale result.

## 8. Failure behavior

Evidence-producing operations that require a source-state binding fail before their main effect when source state cannot be established.

- `verify.run`: source-state failure prevents recipe launch.
- `preview.start`: source-state failure prevents preview launch.
- Browser/visual inspection of an existing preview uses its stored source state and does not fail because a later Git scan is unavailable.

Stable existing Git/capability error codes should be reused where possible; do not invent a broad new error taxonomy.

## 9. Bounds and compatibility

- No new public MCP tools.
- Keep exactly 76 public tools.
- Runtime version remains `0.1`.
- External MCP protocol remains `2026-07-28`.
- Semantic surface advances only if the additive public result schemas are intentionally released as a semantic contract change; expected target is `0.20`.
- `headOid` accepts only full lowercase 40- or 64-hex OIDs.
- `changesFingerprint` accepts only lowercase 64-hex SHA-256.
- No timestamps in source-state equality.
- No branch names in source-state equality.
- No new filesystem authority, Git mutation, network authority, provider invocation, or environment inheritance.

## 10. Testing strategy

Use TDD at each layer.

1. Rust Git checkpoint tests prove branch-header parsing, full HEAD OID validation, unchanged checkpoint records, and helper/sandbox hardening.
2. Core validation tests reject absent/invalid/extra source-state fields where the internal contract is closed.
3. Capability contract tests prove `git.changes.sourceState.changesFingerprint === fingerprint` and reject malformed OIDs/fingerprints.
4. Verification tests prove source state is captured before process execution and execution is not attempted when binding fails.
5. Preview tests prove source state is captured once before launch and preserved across inspect.
6. Browser/visual tests prove inherited preview state is propagated without additional source-state scans.
7. MCP structured-result tests lock the additive schemas and unchanged tool inventory.
8. Focused TypeScript tests must pass inside the KodeGPT sandbox. Full Rust/Bubblewrap integration must be verified in a host-capable environment because nested KodeGPT `process.run` cannot itself run Bubblewrap-dependent runtime tests (`PROCESS_SANDBOX_UNAVAILABLE`).

## 11. Non-goals

This phase does not add:

- an evidence database or durable evidence registry;
- automatic invalidation or automatic rerun;
- `verify.status` or `evidence.*` tools;
- a scheduler/task queue/workflow engine;
- source-state polling;
- CI freshness semantics;
- PR review state binding;
- multi-agent runtime;
- generic shell/provider/plugin authority;
- a replacement for the existing `git.changes` fingerprint.

## 12. Definition of done

The phase is done when:

- current `git.changes` returns a validated source-state reference from one hardened checkpoint inspection;
- `verify.run` binds every launch to that state;
- preview/browser/visual evidence consistently reports the preview's launch state;
- source changes deterministically produce a different current state without mutating historical evidence;
- no new public tool is added;
- focused tests, typecheck, protocol/integration/security gates appropriate to the changed layers pass;
- host-capable runtime verification covers Bubblewrap-dependent tests;
- public surface/version and documentation accurately describe the additive evidence contract.
