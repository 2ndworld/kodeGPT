# KodeGPT Process Observability Design

Date: 2026-08-20
Status: approved direction; written-spec review pending

## Goal

Make long-running `process.run(background:true)` and `verify.run(background:true)` useful to ChatGPT without adding a workflow engine, scheduler, task database, or new public tool.

The public process surface stays:

- `process.run`
- `process.status`
- `process.cancel`

`process.status` gains one optional field:

- `waitMs?: integer` — bounded long-poll duration, default `0`, maximum `30000`.

## Problem

The runtime already spools background stdout/stderr incrementally, and `artifact.read` can read those bytes before process completion. However, `ProcessOperationRecord` is only populated with stdout/stderr previews and final byte counts when capture completes. Therefore `process.status` reports a running process with empty previews and `bytesSpooled:0` even when output already exists.

The host also has to issue repeated immediate `process.status` calls to learn when a long verification or build finishes.

## Design

### 1. Live operation progress in the runtime

Keep the existing process registry and spool architecture. Do not create another task/session store.

While `capture_child` receives stdout/stderr chunks, update the existing `ProcessOperationRecord` with:

- bounded `stdoutPreview` / `stderrPreview` using the existing preview limits;
- current truncation flags;
- current spooled byte count;
- current artifact metadata/size where available.

The final completion path remains authoritative for exit code and terminal state. Cancellation semantics are unchanged.

Updates may occur once per captured chunk; the existing capture chunk is already bounded. No background polling thread is added.

### 2. Bounded wait at the core/MCP layer

Do not widen the Rust runtime request protocol solely for long-polling.

Add `waitMs` to the MCP `process.status` input and implement the wait in the existing core execution path by repeatedly calling the current runtime `process.status` RPC until either:

1. the operation becomes terminal (`completed`, `failed`, or `cancelled`); or
2. the requested wait duration expires.

Requirements:

- `waitMs` omitted or `0` preserves current immediate behavior;
- integer only, range `0..30000` milliseconds;
- bounded polling interval (approximately 100 ms; implementation may use a monotonic deadline and shorter final sleep);
- return the latest observed operation on timeout rather than raising a timeout error;
- no hidden retry of failed/cancelled operations;
- no process ownership or lifecycle changes.

This keeps the kernel protocol stable and makes the public tool ergonomic.

### 3. Verification compatibility

`verify.run(background:true)` already returns the underlying process operation. The same operation ID remains usable with `process.status(waitMs=...)`; no separate `verify.status` tool is introduced.

## Interfaces

Public MCP shape:

```ts
process.status({
  workspaceId: string,
  operationId: string,
  waitMs?: number
})
```

Returned operation shape stays backward-compatible. Running operations may now contain non-empty live previews and non-zero `bytesSpooled`.

## Versioning

This is an additive public MCP input change, so the semantic MCP surface version should bump once as part of the development-efficiency program. Runtime version `0.1` and protocol `2026-07-28` remain unchanged because the Rust request schema is not widened for `waitMs`.

## Tests

TDD must prove:

1. a background process exposes stdout progress through `process.status` before completion;
2. stderr progress is also visible before completion;
3. live preview truncation obeys the existing preview limit;
4. final state/output remains correct after live updates;
5. cancellation still terminates the process group and yields cancelled state;
6. `waitMs:0` is immediate;
7. positive `waitMs` returns early when the process becomes terminal;
8. positive `waitMs` returns the latest running state when the deadline expires;
9. MCP schema rejects negative, fractional, and `>30000` waits;
10. existing process/verification/runtime tests remain green.

## Non-Goals

This phase does not add:

- `process.wait` or another public process tool;
- workflow/session engines;
- scheduler, queue, supervisor, or task database;
- process persistence across service restart;
- Codex/CodexPro invocation or dependency;
- multi-agent execution;
- host-wide environment inheritance;
- changes to Git/GitHub/CI/browser/preview authority.

## Acceptance

A live dogfood run must start a background shell command that prints output, sleeps, prints again, and verify that:

- `process.status` sees the first output while state is still `running`;
- `process.status(waitMs=30000)` returns when the operation reaches a terminal state without manual repeated polling;
- the final captured output and artifact remain correct.
