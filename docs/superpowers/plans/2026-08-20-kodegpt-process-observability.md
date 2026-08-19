# KodeGPT Process Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make background process progress observable live and let `process.status` optionally wait up to 30 seconds for a state change/terminal result without adding a new tool or runtime protocol method.

**Architecture:** Keep the existing Rust process registry and raw spool. Update the existing operation record as output chunks are captured, then implement bounded long-polling only in the TypeScript `ExecutionManager`; MCP forwards optional `waitMs`. No scheduler, durable task store, agent runtime, or new public tool.

**Tech Stack:** Rust runtime, TypeScript core/MCP server, Vitest, Cargo tests.

**Spec:** `docs/superpowers/specs/2026-08-20-kodegpt-process-observability-design.md`

## Global Constraints

- Runtime version stays `0.1`.
- Runtime protocol stays `2026-07-28`.
- MCP semantic surface advances `0.15 -> 0.16`.
- Public tool count remains exactly 78.
- `waitMs` is optional, integer, `0..30000`, default `0`.
- No `process.wait`, scheduler, workflow/session engine, process persistence, Codex dependency, or multi-agent runtime.

---

### Task 1: Live background process progress

**Files:**
- Modify: `crates/runtime/src/process.rs`
- Test: `crates/runtime/src/process.rs`

**Interfaces:**
- Consumes: existing `ProcessOperationRegistry`, `RawSpoolWriter::metadata()`, `PREVIEW_MAX_BYTES`.
- Produces: running `ProcessOperationView` values whose previews, truncation flags, byte count, and artifact metadata reflect already-captured output.

- [ ] **Step 1: Write failing stdout-progress test**

Add a runtime test that launches a background Python process which prints `first`, flushes stdout, sleeps, then prints `second`. Poll the existing registry until the operation is still `Running` and assert `stdout_preview` contains `first` and `bytes_spooled > 0` before completion.

- [ ] **Step 2: Run the focused Rust test and verify RED**

Run: `cargo test -p kodegpt-runtime background_operation_exposes_stdout_progress_before_completion -- --exact`

Expected: FAIL because running operation records currently keep empty previews and zero bytes until `complete_operation`.

- [ ] **Step 3: Implement minimal live-record update**

Change `capture_child` to receive the operation registry and operation ID. After each successfully spooled chunk, update the matching `ProcessOperationRecord` while it is running:

```rust
fn append_live_preview(target: &mut String, truncated: &mut bool, source: &[u8]) {
    let remaining = PREVIEW_MAX_BYTES.saturating_sub(target.as_bytes().len());
    let accepted = remaining.min(source.len());
    target.push_str(&String::from_utf8_lossy(&source[..accepted]));
    if accepted < source.len() {
        *truncated = true;
    }
}

fn update_operation_progress(
    operations: &ProcessOperationRegistry,
    operation_id: &str,
    kind: StreamKind,
    bytes: &[u8],
    artifact: RawSpoolMetadata,
) {
    if let Ok(mut records) = operations.records.lock()
        && let Some(record) = records.get_mut(operation_id)
        && record.state == ProcessState::Running
    {
        match kind {
            StreamKind::Stdout => append_live_preview(
                &mut record.stdout_preview,
                &mut record.stdout_truncated,
                bytes,
            ),
            StreamKind::Stderr => append_live_preview(
                &mut record.stderr_preview,
                &mut record.stderr_truncated,
                bytes,
            ),
        }
        record.bytes_spooled = artifact.bytes_written;
        record.artifact = artifact;
    }
}
```

Call the helper immediately after `writer.write_source(&bytes)?`, using `writer.metadata()` for current artifact metadata. Keep final `complete_operation` authoritative so final output remains byte-for-byte compatible with the existing capture path.

- [ ] **Step 4: Run focused Rust test and verify GREEN**

Run the same command. Expected: PASS.

- [ ] **Step 5: Add stderr-progress and final-output regression tests**

Add separate tests proving stderr is visible while running and final output/state still match the complete capture.

- [ ] **Step 6: Run runtime process tests**

Run: `cargo test -p kodegpt-runtime process::tests`

Expected: PASS.

- [ ] **Step 7: Commit Task 1**

```bash
git add crates/runtime/src/process.rs
git commit -m "feat: expose live process progress"
```

---

### Task 2: Bounded `waitMs` in `ExecutionManager`

**Files:**
- Modify: `packages/core/src/execution-manager.ts`
- Test: `packages/core/src/execution-manager.test.ts`

**Interfaces:**
- Consumes: `WorkspaceManager.processStatus(workspaceId, operationId)` immediate runtime RPC.
- Produces: `ExecutionManager.status(workspaceId, operationId, waitMs?)` with bounded long-polling.

- [ ] **Step 1: Write failing early-terminal wait test**

Create a fake workspace whose first status is `running` and second status is `completed`. Call:

```ts
await manager.status("ws_public", "op_0000000000000001", 1000)
```

Assert it returns completed and calls status twice rather than waiting the whole duration.

- [ ] **Step 2: Run focused Vitest and verify RED**

Run: `pnpm exec vitest run packages/core/src/execution-manager.test.ts --no-file-parallelism`

Expected: FAIL because `status` currently accepts only two parameters and performs one lookup.

- [ ] **Step 3: Implement minimal bounded wait**

Add:

```ts
const PROCESS_STATUS_POLL_MS = 100;

async status(workspaceId: string, operationId: string, waitMs = 0) {
  const deadline = Date.now() + waitMs;
  let current = await this.#workspace.processStatus(workspaceId, operationId);
  while (current.state === "running" && Date.now() < deadline) {
    await sleep(Math.min(PROCESS_STATUS_POLL_MS, Math.max(0, deadline - Date.now())));
    current = await this.#workspace.processStatus(workspaceId, operationId);
  }
  return current;
}
```

Do not add retries for errors or terminal states.

- [ ] **Step 4: Verify GREEN**

Run the focused Vitest. Expected: PASS.

- [ ] **Step 5: Add deadline test**

Use a workspace that always returns running; assert a small positive `waitMs` returns a running value after more than one status lookup, without throwing.

- [ ] **Step 6: Re-run focused Vitest**

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add packages/core/src/execution-manager.ts packages/core/src/execution-manager.test.ts
git commit -m "feat: add bounded process status wait"
```

---

### Task 3: Expose `waitMs` through MCP and bump semantic surface

**Files:**
- Modify: `packages/mcp-server/src/tool-context.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/server.test.ts`
- Modify: `packages/mcp-server/src/surface-version.ts`
- Modify: `tests/security/security-invariants.test.ts`
- Modify: `tests/integration/provider-gateway.test.ts`
- Test: `packages/mcp-server/src/server.test.ts`
- Test: `packages/mcp-server/src/structured-results.test.ts` if handler forwarding needs direct coverage.

**Interfaces:**
- Consumes: `ExecutionManager.status(workspaceId, operationId, waitMs?)`.
- Produces: public `process.status({ workspaceId, operationId, waitMs? })`.

- [ ] **Step 1: Write failing MCP schema/forwarding test**

Capture the `process.status` definition/handler. Prove the schema accepts `waitMs:30000`, rejects `-1`, `1.5`, and `30001`, and the handler forwards a valid wait value to the process context.

- [ ] **Step 2: Run focused MCP tests and verify RED**

Run: `pnpm exec vitest run packages/mcp-server/src/server.test.ts packages/mcp-server/src/structured-results.test.ts --no-file-parallelism`

Expected: FAIL because `waitMs` is absent.

- [ ] **Step 3: Add MCP field and plumbing**

Use a strict bounded schema equivalent to:

```ts
waitMs: z.number().int().min(0).max(30_000).optional()
```

Update `ProcessToolContext.status` and `createKodegptToolContext` to pass `waitMs` to `ExecutionManager.status`. Keep output unchanged.

- [ ] **Step 4: Bump surface to `0.16` without changing tool count**

Set `MCP_SURFACE_VERSION = "0.16"` and update only current-version assertions. Do not modify the 78-tool fixture except for the optional field behavior; required-field lists remain unchanged because `waitMs` is optional.

- [ ] **Step 5: Run focused MCP tests and verify GREEN**

Run the same focused command. Expected: PASS.

- [ ] **Step 6: Run TypeScript validation**

Run:

```bash
pnpm exec vitest run packages/core/src/execution-manager.test.ts packages/mcp-server/src/server.test.ts packages/mcp-server/src/structured-results.test.ts tests/security/security-invariants.test.ts tests/integration/provider-gateway.test.ts --no-file-parallelism
pnpm run typecheck
pnpm run build
```

Expected: all commands exit 0.

- [ ] **Step 7: Run Rust validation**

Run:

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo check --workspace
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit Task 3**

```bash
git add packages/mcp-server/src/tool-context.ts packages/mcp-server/src/tools.ts packages/mcp-server/src/server.test.ts packages/mcp-server/src/structured-results.test.ts packages/mcp-server/src/surface-version.ts tests/security/security-invariants.test.ts tests/integration/provider-gateway.test.ts
git commit -m "feat: expose bounded process status wait"
```

---

### Task 4: Full verification and live dogfood

**Files:**
- Create/modify only readiness documentation if the repository's current release workflow requires it.

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: fresh verification evidence and live behavior evidence.

- [ ] **Step 1: Run repository deterministic gates**

Run the repository's current full test, typecheck, build, forbidden-pattern/package checks, Cargo fmt/check/test, and `git diff --check` gates using existing scripts/recipes.

- [ ] **Step 2: Dogfood live progress on the built/current service path**

Start a background command that prints, sleeps, and prints again. While state is `running`, verify `process.status` contains the first output. Then call `process.status(waitMs=30000)` and verify it returns terminal state with complete output.

- [ ] **Step 3: Review exact diff**

Confirm no scheduler, workflow/session engine, Codex dependency, runtime protocol widening, or unrelated authority changes entered the diff.

- [ ] **Step 4: Commit readiness evidence only if required by current repo convention**

Use a concise docs commit; otherwise leave code commits as the complete feature history.
