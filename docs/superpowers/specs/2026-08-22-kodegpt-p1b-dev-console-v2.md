# P1-B Dev Console v2

Date: 2026-08-22
Status: approved roadmap subproject; implementation design derived from canonical audit

## Objective

Turn the existing MCP Apps Dev Console into a compact development cockpit without making `console.state` a synchronous Git or network crawler.

## Design constraints

- Keep one public console tool: `console.state`.
- Reuse already-observed state from existing typed operations; do not introduce a console-owned GitHub client, Git scanner, scheduler, or workflow engine.
- Keep ChatGPT as the orchestrator. Console hints are descriptive inputs for the host, never hidden execution.
- Reuse P0 source-state refs and checkpoint/resume semantics for freshness instead of inventing another evidence model.
- Preserve existing security/health status precedence and legacy console fields for compatibility.
- Tool count must remain unchanged. A semantic surface bump is justified only if the shipped public `console.state` contract changes materially.

## Observed-state model

Extend the existing process-local `ConsoleStateStore` with bounded observations captured at existing MCP tool boundaries:

1. **Workspace / source state**
   - record `context.build` and `git.changes` results, which already expose clean/dirty and exact source state;
   - retain existing `git.status` cache for compatibility;
   - record successful branch-switch/worktree observations where branch identity is explicitly known;
   - allow a fresh checkpoint baseline or observed CI revision to provide branch identity when available;
   - never infer a branch when evidence is ambiguous.

2. **Continuity**
   - record `workspace.info`, successful `workspace.checkpoint`, and resume synthesis from `context.build(intent="resume")`;
   - expose current revision/objective/status and checkpoint-provided next actions.

3. **Verification**
   - record successful `verify.run` results by workspace and recipe, bounded to recent entries;
   - compare each verification `sourceState` with the latest fresh observed workspace source state;
   - report `fresh`, `stale`, or `unknown` rather than rerunning anything automatically.

4. **Processes / previews**
   - associate process observations with the workspace known by the wrapping tool call;
   - record preview start/inspect/stop results and their source-state relation;
   - keep only bounded recent observations and identify active entries deterministically.

5. **PR / CI**
   - record typed PR create/inspect results and typed CI repository/status/run observations only when those tools are already invoked;
   - retain repository identity in summaries so multi-workspace ambiguity remains visible;
   - no provider request occurs while serving `console.state`.

## Cockpit projection

`console.state` remains backward-compatible at the existing top level and adds a bounded `cockpit` projection with:

- active workspace summary: workspace id, branch when known, head when known, dirty when known, observation freshness;
- objective/checkpoint summary;
- recent verification evidence and freshness;
- active process and preview summaries;
- latest observed PR and CI summaries;
- at most five next-action hints derived only from explicit observed state.

A hint contains a stable kind, short label, and reason. Hints never contain executable hidden workflows and never invoke tools themselves.

## UI

The MCP App should default to a dashboard that renders the cockpit projection as compact cards, with dedicated Evidence, Processes, Remote, Security, and Diagnostics views. Raw JSON remains available only where it is useful for diagnostics. Existing Continue/Run/Changes/Stop interactions remain host-mediated.

## Deterministic hint priority

1. blocked checkpoint → surface checkpoint blocker/next action;
2. running process/preview → inspect active execution;
3. failed CI → inspect CI failure evidence;
4. dirty source with no fresh verification → verify current source;
5. stale verification → rerun affected verification;
6. explicit checkpoint next actions → surface in stored order;
7. otherwise continue the current objective when one is active.

The list is deduplicated and capped at five.

## Acceptance

- `console.state` source contains no `context.git`, `context.ci`, or `context.github` calls.
- Repeated `console.state` calls do not cause provider/Git activity.
- Cockpit summarizes observed workspace/head/dirty and branch when explicitly known.
- P0 source-state refs drive verification/preview freshness.
- Checkpoint objective/status is visible.
- Observed PR/CI are visible without additional network calls.
- UI renders the cockpit rather than dumping all primary state as JSON.
- focused tests, full deterministic gates, exact-head CI, merged-main CI, package/release smoke, live health, and ChatGPT-host dogfood pass.
