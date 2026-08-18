# KodeGPT Bounded Preview Lifecycle Design

Date: 2026-08-18
Status: implementation authority for Phase 1 of the audited application-development roadmap

## Problem

KodeGPT can already run a long-lived dev server with `process.run(background=true)`, inspect it with `process.status`, and stop it with `process.cancel`. The host still has to infer which operation is an application preview, remember its port/path, repeatedly probe readiness, construct a loopback URL, and keep lifecycle bookkeeping outside KodeGPT. That makes the application-development loop brittle and prevents a later browser capability from having a safe authoritative local origin.

## Goal

Add a minimal semantic preview lifecycle that composes the existing process authority and binds one opaque preview ID to one workspace process operation and one fixed loopback HTTP endpoint.

## Public surface

### `preview.start`

Input:
```ts
{
  workspaceId: string;
  logicalExecutable: string;
  argv: string[];
  port: number;             // integer 1024..65535
  cwd?: string;             // existing process semantics, default "."
  env?: Record<string,string>;
  requestPath?: string;     // default "/", absolute-path form only
  waitMs?: number;          // default 3000, integer 0..10000
}
```

Result:
```ts
{
  schemaVersion: 1;
  previewId: `pv_${string}`;
  operationId: string;
  url: string;
  processState: "running" | "completed" | "failed" | "cancelled";
  exitCode?: number;
  reachable: boolean;
  httpStatus: number | null;
}
```

Semantics:
- call the existing `ExecutionManager.run` with the supplied process fields and force `background: true`;
- create the preview record only after process launch returns a valid operation;
- URL is always `http://127.0.0.1:<port><requestPath>`; callers cannot choose scheme/host;
- if the process is running, probe readiness immediately and then at a fixed short interval until reachable or `waitMs` is exhausted;
- any received HTTP response counts as reachable, including 4xx/5xx; `httpStatus` preserves the response status;
- if the process becomes terminal while waiting, stop probing and return terminal process state;
- timeout/not-yet-ready is not an error: return `reachable:false` while preserving the running preview identity.

### `preview.inspect`

Input:
```ts
{ workspaceId: string; previewId: string }
```

Result: same status shape as `preview.start`.

Semantics:
- preview ID must exist and belong to the supplied workspace;
- obtain authoritative process state through existing `ExecutionManager.status`;
- probe the bound loopback endpoint only while the process is running;
- never accept a new URL/host/port/path from the caller.

### `preview.stop`

Input:
```ts
{ workspaceId: string; previewId: string }
```

Result: same status shape.

Semantics:
- preview ID must exist and belong to the supplied workspace;
- inspect process status first;
- cancel only if still running; otherwise preserve the terminal result;
- remove the preview registry record only after status/cancellation succeeds;
- return `reachable:false` and `httpStatus:null` after stop/terminal resolution.

## Internal architecture

Create `PreviewManager` in `@kodegpt/core`.

It composes a narrow process interface rather than `WorkspaceManager` directly:
```ts
export interface PreviewProcessAdapter {
  run(input: ProcessRunInput): Promise<WorkspaceProcessOperationResult>;
  status(workspaceId: string, operationId: string): Promise<WorkspaceProcessOperationResult>;
  cancel(workspaceId: string, operationId: string): Promise<WorkspaceProcessOperationResult>;
}
```

`ExecutionManager` already satisfies this interface.

Create an injectable probe abstraction:
```ts
export interface PreviewProbe {
  inspect(input: { port: number; requestPath: string }): Promise<{
    reachable: boolean;
    httpStatus: number | null;
  }>;
}
```

The production probe uses Node `http.request` with:
- host exactly `127.0.0.1`;
- method `HEAD`;
- caller-bound port/path only;
- fixed short socket/request timeout;
- no redirects;
- no response body collection;
- request errors normalized to `reachable:false`.

The manager owns an in-memory `Map<previewId, PreviewRecord>`. Records contain only preview ID, workspace ID, operation ID, port, request path, and URL. No PIDs, capability IDs, host paths, credentials, or response data are stored.

Use a bounded registry (`MAX_PREVIEW_SESSIONS = 32`). Before rejecting a start at capacity, inspect existing operation states and prune terminal records. This cleanup is exceptional/capacity-driven rather than background polling. `PreviewManager.releaseWorkspace(workspaceId)` is an internal registry-cleanup hook invoked only after `WorkspaceManager.closeWorkspace` succeeds; workspace/process authority remains responsible for cancellation, while the preview hook only removes stale in-memory preview identities.

Preview IDs are generated as `pv_` plus 32 lowercase hex characters from `randomUUID().replaceAll("-", "")`.

## Input validation

- workspace ID and executable must be non-empty;
- argv must remain an array of strings through MCP schema;
- port must be a safe integer in `1024..65535`;
- `waitMs` must be safe integer `0..10000`;
- request path must be a canonical absolute-path/reference form: start with exactly one `/`, be at most 2048 UTF-8 bytes, contain no fragment marker `#` or ASCII control characters, and require no URL normalization/escaping (so values such as `//host` and paths containing raw spaces are rejected);
- before process launch, production performs a bounded TCP connect check to `127.0.0.1:<port>` without reading payload data; if a listener already exists, start fails with `PREVIEW_ENDPOINT_IN_USE` so readiness cannot be attributed to a pre-existing local service;
- do not accept host, origin, URL, scheme, redirect policy, browser flags, or generic HTTP parameters.

## Error model

Stable PreviewManager errors:
- `PREVIEW_NOT_FOUND` — unknown ID or ID belongs to another workspace;
- `PREVIEW_LIMIT_REACHED` — bounded registry remains full after terminal pruning;
- `PREVIEW_ENDPOINT_IN_USE` — the requested loopback port already has a listener before preview process launch.

Malformed inputs use normal `TypeError`/`RangeError` before process execution. Existing process/runtime errors pass through unchanged; preview must not hide execution failures.

## MCP wiring

Add a `PreviewToolContext` with start/inspect/stop and include it in `KodegptToolContext`.

`createKodegptToolContext` accepts an optional preview adapter. Tests/stacks that omit it receive a narrow unavailable adapter. Production `createProductionServiceStack` constructs `new PreviewManager(executionManager)` and injects it.

Register three tools:
- `preview.start` with process-run annotations;
- `preview.inspect` with read-only annotations;
- `preview.stop` with process-cancel annotations.

Bump MCP surface `0.10 -> 0.11`; expected public tool count `62 -> 65`. Runtime version and MCP protocol version stay unchanged because no Rust RPC method changes.

Do not add preview IDs to `NATIVE_CAPABILITY_IDS` in this phase: that list represents capability planning semantics and currently omits process status/cancel. Preview is an MCP/core orchestration surface, not a new low-level native execution authority.

## Security and authority analysis

Preview adds no executable authority: launch still flows through existing process policy and Bubblewrap. It adds no arbitrary network authority: probe target is fixed loopback and derives only from an explicitly supplied port/path bound at preview creation. With trusted/unrestricted process networking, the sandbox shares the host network namespace; with a profile unable to start the selected executable, existing process policy fails normally.

No response body, headers, cookies, credentials, or arbitrary local service data are returned. Later browser phases must consume a live preview ID instead of adding arbitrary navigation.

## Testing

Core unit tests must prove:
- `background:true` is forced;
- fixed URL construction and canonical request-path validation;
- pre-existing loopback listeners prevent process launch;
- immediate reachable result;
- bounded wait then not-ready result;
- terminal process stops probing;
- inspect uses only stored endpoint;
- cross-workspace/unknown IDs fail;
- stop cancels running operation and removes the record;
- stop of terminal operation does not call cancel;
- successful workspace close releases only that workspace's preview registry records, while failed close leaves records intact;
- capacity rejects only after bounded terminal pruning;
- default Node probe never follows redirects or returns bodies (small integration-style loopback test if practical).

MCP tests must prove exact tool names/required fields, tool count 65, surface 0.11, and correct adapter dispatch.

CLI/start tests must prove production stack injects PreviewManager without new runtime dependencies.

## Non-goals

No browser automation, screenshot, DOM, console, network capture, port auto-detection, restart, persistent preview registry, public tunnel, deployment, arbitrary HTTP, or desktop automation is included in this phase.