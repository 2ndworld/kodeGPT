# Bounded Preview Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add typed `preview.start`, `preview.inspect`, and `preview.stop` capabilities that compose KodeGPT's existing background process authority and expose only a fixed loopback preview endpoint.

**Architecture:** Implement an ephemeral `PreviewManager` in `@kodegpt/core`, backed by the existing `ExecutionManager` and a tiny injectable loopback HEAD probe. Wire it through MCP and the production service stack. Do not add Rust RPCs, dependencies, persistent state, arbitrary URLs, browser automation, or a second process supervisor.

**Tech Stack:** TypeScript, Node `http`, Vitest, existing KodeGPT core/MCP/CLI packages.

**Spec:** `docs/superpowers/specs/2026-08-18-kodegpt-bounded-preview-lifecycle-design.md`

## Global Constraints

- Keep runtime version `0.1` and MCP protocol `2026-07-28` unchanged.
- Bump MCP surface from `0.10` to `0.11` only after the public tools are implemented.
- Public tool count becomes exactly 65.
- No new npm dependency and no Rust protocol/runtime method.
- Probe host is always `127.0.0.1`; no arbitrary URL/host/scheme input.
- Existing process policy, Bubblewrap, artifacts, audit, cancellation, and workspace lifecycle remain the execution authority.
- Preview registry is ephemeral and bounded to 32 records.

---

### Task 1: Core PreviewManager contract and start behavior

**Files:**
- Create: `packages/core/src/preview-manager.test.ts`
- Create: `packages/core/src/preview-manager.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `ExecutionManager`-compatible `run/status/cancel` methods and `WorkspaceProcessOperationResult`.
- Produces: `PreviewManager`, `PreviewStartInput`, `PreviewLookupInput`, `PreviewStatusResult`, `PreviewProcessAdapter`, `PreviewProbe`, `PreviewManagerError`.

- [ ] **Step 1: Write RED tests for start and validation**

Create tests proving `start()` forces `background:true`, constructs `http://127.0.0.1:<port><path>`, returns a generated `pv_...` ID, reports an immediately reachable HTTP status, rejects ports outside `1024..65535`, and rejects non-canonical/unsafe request paths including network-path (`//host`), raw-space, fragment, and control-character forms.

Use a fake process adapter recording its `run` input and an injected probe returning deterministic evidence. Production change that makes these tests pass: existence of `PreviewManager.start` with the specified contract.

- [ ] **Step 2: Run focused RED test**

Run:
```bash
pnpm --filter @kodegpt/core exec vitest run src/preview-manager.test.ts
```
Expected: FAIL because `preview-manager.ts`/exports do not exist.

- [ ] **Step 3: Implement minimal start contract**

Create `preview-manager.ts` with:
```ts
export const MAX_PREVIEW_SESSIONS = 32;
export const DEFAULT_PREVIEW_WAIT_MS = 3_000;
export const MAX_PREVIEW_WAIT_MS = 10_000;

export interface PreviewProcessAdapter {
  run(input: ProcessRunInput): Promise<WorkspaceProcessOperationResult>;
  status(workspaceId: string, operationId: string): Promise<WorkspaceProcessOperationResult>;
  cancel(workspaceId: string, operationId: string): Promise<WorkspaceProcessOperationResult>;
}

export interface PreviewProbe {
  inspect(input: { port: number; requestPath: string }): Promise<{
    reachable: boolean;
    httpStatus: number | null;
  }>;
}
```

Add input/result interfaces from the design, validation helpers, `pv_` ID generation, in-memory record creation, and immediate probe behavior. Export through `packages/core/src/index.ts`.

- [ ] **Step 4: Run GREEN test and core typecheck**

```bash
pnpm --filter @kodegpt/core exec vitest run src/preview-manager.test.ts
pnpm --filter @kodegpt/core typecheck
```
Expected: PASS.

### Task 2: Readiness wait, inspect, stop, and bounded registry

**Files:**
- Modify: `packages/core/src/preview-manager.test.ts`
- Modify: `packages/core/src/preview-manager.ts`

**Interfaces:**
- Consumes: Task 1 preview record and process/probe abstractions.
- Produces: complete bounded preview lifecycle.

- [ ] **Step 1: Add RED tests**

Add tests proving:
- start retries a not-yet-reachable probe only within `waitMs` and returns running/not-ready instead of throwing;
- terminal process state stops readiness probing;
- inspect rejects unknown/cross-workspace preview IDs and probes only the stored endpoint;
- stop cancels a running operation, does not cancel an already-terminal operation, removes the record only after successful status/cancellation;
- successful `workspace.close` releases only that workspace's preview registry records after existing workspace/process cleanup succeeds;
- a full 32-record registry prunes terminal records before raising `PREVIEW_LIMIT_REACHED`;
- the same 32-session ceiling holds when multiple `preview.start` calls overlap, by counting in-flight starts as reserved slots.

Inject `sleep` for deterministic zero-time tests; do not use real timers for manager unit tests.

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @kodegpt/core exec vitest run src/preview-manager.test.ts
```
Expected: new lifecycle tests FAIL on missing behavior.

- [ ] **Step 3: Implement lifecycle minimally**

Add fixed `100ms` readiness interval, injected sleep function, lookup ownership validation, stop semantics, and capacity-time terminal pruning. `PREVIEW_NOT_FOUND` covers both unknown IDs and workspace mismatch to avoid leaking preview ownership.

- [ ] **Step 4: GREEN and regression**

```bash
pnpm --filter @kodegpt/core test
pnpm --filter @kodegpt/core typecheck
```
Expected: all core tests PASS.

### Task 3: Production loopback HTTP probe

**Files:**
- Modify: `packages/core/src/preview-manager.test.ts`
- Modify: `packages/core/src/preview-manager.ts`

**Interfaces:**
- Produces: `NodeLoopbackPreviewProbe` used by default by `PreviewManager`.

- [ ] **Step 1: Add RED loopback probe test**

Create an in-test Node HTTP server on `127.0.0.1` with an ephemeral host port. Assert the production probe detects the occupied port through a bounded no-payload TCP connect, sends HEAD for readiness, reports the returned status, does not follow a 302 redirect, and normalizes an unreachable loopback port to `{reachable:false,httpStatus:null}`. Add manager evidence that an already-listening port yields `PREVIEW_ENDPOINT_IN_USE` before process launch.

- [ ] **Step 2: Verify RED**

```bash
pnpm --filter @kodegpt/core exec vitest run src/preview-manager.test.ts
```
Expected: FAIL because the production probe is absent.

- [ ] **Step 3: Implement probe**

Use `node:net` for a bounded no-payload `127.0.0.1:<port>` occupancy check and `node:http` `request()` for readiness with hard-coded host `127.0.0.1`, method `HEAD`, fixed short timeout, response destruction without body collection, and no redirect handling. Resolve readiness request errors as not reachable; reject an occupied port before process launch.

- [ ] **Step 4: GREEN**

```bash
pnpm --filter @kodegpt/core test
```
Expected: PASS.

### Task 4: MCP context and semantic surface

**Files:**
- Modify: `packages/mcp-server/src/tool-context.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/server.test.ts`
- Add or modify targeted structured/tool-context tests if dispatch coverage requires it.

**Interfaces:**
- Consumes: `PreviewManager.start/inspect/stop` signatures.
- Produces: public `preview.start`, `preview.inspect`, `preview.stop` tools.

- [ ] **Step 1: RED surface/dispatch tests**

Update the locked surface expectation with:
```ts
{ name: "preview.inspect", required: ["workspaceId", "previewId"] },
{ name: "preview.start", required: ["workspaceId", "logicalExecutable", "argv", "port"] },
{ name: "preview.stop", required: ["workspaceId", "previewId"] }
```

Keep deterministic lexical/group placement consistent between `SURFACE_TOOLS` and the locked snapshot. Add a fake preview context and assert registration/dispatch parses the typed schema.

Run:
```bash
pnpm --filter @kodegpt/mcp-server test
```
Expected: FAIL because the tools/context do not exist and surface is still 62.

- [ ] **Step 2: Implement context wiring**

Add `PreviewToolContext`, `preview` to `KodegptToolContext`, and optional `preview?: PreviewToolContext` to `createKodegptToolContext`. Provide an unavailable fallback producing `CAPABILITY_NOT_IMPLEMENTED` for test stacks that omit preview wiring. Normalize the closed PreviewManager error vocabulary to stable MCP error codes without exposing raw internal messages; unrelated process/runtime errors keep their existing behavior.

- [ ] **Step 3: Register tools**

Schemas:
- start: workspace/executable/argv/port required; cwd/env/requestPath/waitMs optional with exact bounds;
- inspect/stop: workspaceId + `previewId` regex `^pv_[a-f0-9]{32}$`.

Annotations:
- start → `PROCESS_RUN_TOOL_ANNOTATIONS`;
- inspect → `READ_ONLY_TOOL_ANNOTATIONS`;
- stop → `PROCESS_CANCEL_TOOL_ANNOTATIONS`.

- [ ] **Step 4: GREEN MCP tests**

```bash
pnpm --filter @kodegpt/mcp-server test
pnpm --filter @kodegpt/mcp-server typecheck
```
Expected: PASS except the surface-version assertion remains RED until Task 5.

### Task 5: Production stack injection and surface version

**Files:**
- Modify: `apps/cli/src/commands/start.ts`
- Modify: relevant `apps/cli/src/commands/start*.test.ts` only where required by type/wiring evidence
- Modify: `packages/mcp-server/src/surface-version.ts`
- Modify: `packages/mcp-server/src/server.test.ts`

**Interfaces:**
- Consumes: `PreviewManager` and existing `ExecutionManager`.
- Produces: production preview capability.

- [ ] **Step 1: Add RED production-stack assertion**

In the most focused existing start-stack test, exercise `stack.toolContext.preview.start` with a fake manager/process path or assert the injected preview context is callable without introducing runtime dependencies. Keep test fixtures narrow.

- [ ] **Step 2: Wire PreviewManager**

In `createProductionServiceStack`:
```ts
const executionManager = new ExecutionManager(managers.workspaceManager);
const previewManager = new PreviewManager(executionManager);
```
Pass `preview: previewManager` into `createKodegptToolContext`.

- [ ] **Step 3: Bump the public surface**

Set:
```ts
export const MCP_SURFACE_VERSION = "0.11" as const;
```
Update server lock test to expect 65 tools and 0.11.

- [ ] **Step 4: Focused verification**

```bash
pnpm --filter @kodegpt/core test
pnpm --filter @kodegpt/mcp-server test
pnpm --filter kodegpt exec vitest run src/commands/start.test.ts src/commands/start-skill-lifecycle.test.ts
pnpm --filter @kodegpt/core typecheck
pnpm --filter @kodegpt/mcp-server typecheck
pnpm --filter kodegpt typecheck
```
Expected: PASS.

### Task 6: Documentation, full verification, and dogfood

**Files:**
- Modify: `docs/architecture/README.md`
- Modify: `.ai-bridge/current-plan.md` or closure/status evidence as appropriate after implementation
- Modify: `docs/implementation/v0.1-execution-tracker.md` only when recording verified implementation evidence.

- [ ] **Step 1: Reconcile architecture authority**

Record Preview Lifecycle as current surface `0.11`, exactly 65 tools, with fixed loopback/readiness semantics and explicit non-goals for arbitrary browser/desktop/network control.

- [ ] **Step 2: Run repository gates**

```bash
pnpm test
pnpm run typecheck
pnpm run build
cargo test --workspace -- --test-threads=1
```
Also run repository protocol/schema/MCP/security/package gates currently defined by root scripts.

Known baseline caveat: packaged CLI tests that invoke `git rev-parse HEAD` inside a linked worktree may fail because linked-worktree Git metadata is not admitted by the current live KodeGPT sandbox. Verify those host-side from canonical/host tooling rather than widening sandbox authority.

- [ ] **Step 3: Live dogfood candidate**

Create a tiny temporary HTTP dev-server fixture inside the feature worktree or use an existing safe test fixture. Through the candidate MCP/runtime, prove:
1. `preview.start` returns a `pv_...` identity and loopback URL;
2. readiness becomes true with an actual HTTP status;
3. `preview.inspect` observes it;
4. `preview.stop` terminates it;
5. `process.status` confirms the underlying operation is no longer running;
6. no arbitrary host/URL field exists in the public schema.

- [ ] **Step 4: Review exact diff**

Use CodexPro when available for high-context review. If CodexPro remains unavailable, perform host-side diff review plus KodeGPT code impact/context inspection. Reject any accidental Rust, provider, agent, browser, Figma, generic HTTP, or persistent-state expansion.

- [ ] **Step 5: Git/PR lifecycle**

After all verification passes, commit the scoped feature, push, create PR, inspect CI, address failures, and merge only when exact head/CI evidence is clean. Release/cutover follows the current immutable service lifecycle; do not claim live availability before post-cutover dogfood passes.