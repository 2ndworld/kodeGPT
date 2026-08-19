# KodeGPT Target-Scoped Context Build Design

Date: 2026-08-20
Status: approved direction

## Goal

Make `context.build(target=...)` compact and target-relevant without adding a new public tool, repository index, cache daemon, or persistence layer.

The public request/result schema stays unchanged.

## Problem

`context.build` currently performs a full `workspace.inspect({ workspaceId })` and returns that entire inspection object unchanged. On KodeGPT itself, a single-file target returns repository-global entrypoints, areas, manifests, symbols, and relationships plus all verification recipes. This can dominate the response even when the selected file budget is small.

The existing candidate selection is already reasonably target-aware for Git changes and direct relationships. The waste is mainly in public evidence that remains global.

## Design

### 1. Keep full inspection internal

Do not replace the internal full inspection with a raw `workspace.inspect(path=...)` call. The full inspection is still useful to resolve:

- the nearest semantic area for the target;
- governing manifests;
- direct test/import relationships that may cross a directory boundary.

This avoids losing useful root/package evidence while keeping implementation small.

### 2. Scope search to the resolved target area

After resolving the target area from the full inspection, call `code.search` with the existing `path` field set to that area.

For a target under `packages/capabilities`, lexical search should not return same-name files from unrelated packages. Direct dependencies/dependents/tests continue to come from repository relationships, not from broad lexical search.

When no target is supplied, current repository-wide behavior remains unchanged.

### 3. Compact the public workspace evidence

For a targeted build, return a filtered `workspace` object with the same `WorkspaceInspectResult` schema:

- keep scalar/root metadata (`schemaVersion`, `workspaceId`, `root`, `projectTypes`, `languages`, `warnings`, `truncated`);
- `areas`: only areas that contain the target, ordered from broad to specific;
- `manifests`: only manifests that govern the target;
- `entrypoints`: only entrypoints in the resolved target area plus governing manifests/config entrypoints;
- `symbols`: only symbols whose path is the target or another selected/candidate evidence path in the target area;
- `relationships`: only direct relationships touching the target or a selected/candidate evidence path.

No synthetic relationships or symbols are created.

For an untargeted build, return the original workspace inspection unchanged.

### 4. Keep verification evidence relevant but simple

For a targeted build, keep verification recipes whose `cwd` is either:

- `.` (repository-level gate), or
- the target area / a parent directory that contains the target.

This intentionally does not add Cargo-package discovery or a new verification API. More precise verification discovery belongs to the separate scoped-verification phase.

### 5. Preserve existing candidate priority and byte semantics

Do not change:

- intent weights;
- direct relationship precedence;
- selected-file byte budgeting;
- evidence availability semantics;
- public schemas;
- MCP semantic surface version.

`maxBytes` continues to bound selected file contents. The response becomes compact by filtering metadata rather than redefining `maxBytes` in this phase.

## Acceptance

For `target = packages/capabilities/src/context-build.ts` on this repository:

- public `workspace` must not contain symbols/entrypoints from unrelated apps/packages;
- public relationships must be limited to evidence directly relevant to the target/candidates;
- search must be invoked with `path: "packages/capabilities"`;
- verification recipes should contain repository-level and `packages/capabilities` recipes, not recipes for every other package;
- target, governing manifests, direct related tests/dependencies/dependents, and same-area changed files remain selectable;
- untargeted `context.build` behavior stays backward-compatible;
- no tool-count, protocol, runtime-version, or MCP-surface-version change.

## Non-Goals

This phase does not add:

- repository indexing or persistent cache;
- `code.impact` invocation inside `context.build`;
- target-aware public `verify.list` input;
- per-crate Cargo recipes;
- workflow/session orchestration;
- Git/GitHub/CI/browser changes;
- a new context response schema.
