# KodeGPT Verification Recipes Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add strict repository-defined `.kodegpt/verify.json` recipes to the existing `verify.list` / `verify.run` surface and make verification availability honor trusted dynamic Developer Environments.

**Architecture:** Keep `packages/capabilities/src/verification.ts` as the orchestration layer and add one focused parser module for the repository config. The parser reads through existing retained-workspace authority only; availability remains a combination of effective process policy plus the existing `process.inspect_executable` adapter, and `verify.run` continues to rediscover recipes immediately before execution.

**Tech Stack:** TypeScript 5.9, Vitest, existing capability adapters/contracts, retained workspace I/O, existing Rust-backed executable inspection/execution.

**Spec:** `docs/superpowers/specs/2026-08-20-kodegpt-developer-environment-continuity-design.md` Part C.

## Global Constraints

- Do not add public MCP tools or bump the semantic surface in Phase 2.
- Keep built-in Node package-script and Cargo discovery unchanged.
- Config path is exactly `.kodegpt/verify.json` and is workspace-local.
- Config file is UTF-8 JSON <= 64 KiB with exact top-level keys `schemaVersion` and `recipes`.
- `schemaVersion` is exactly `1`; unknown fields fail closed.
- Maximum 32 config recipes.
- Recipe key matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; public ID is `config:<key>`.
- Every recipe has exact keys `label`, `category`, `logicalExecutable`, `argv`, `cwd`.
- Label is 1..120 UTF-8 bytes; category uses the existing verification category enum.
- `logicalExecutable` is a simple logical name, never a path, and config recipes may not select `bash` or `sh`.
- `argv` has <= 64 elements, each <= 4096 UTF-8 bytes.
- `cwd` is `.` or a safe workspace-relative path <= 4096 UTF-8 bytes.
- Config recipes cannot set environment variables or shell snippets.
- Discovery executes no commands.
- `verify.run` rediscovery remains authoritative immediately before execution.
- Dynamic executable availability is allowed only when effective `allowDynamicExecutables:true`; actual executable/sandbox availability still comes from the existing inspection adapter.

---

### Task 1: Verification policy snapshot understands dynamic executable authority

**Files:**
- Modify: `packages/capabilities/src/adapters.ts`
- Modify: `packages/capabilities/src/verification.ts`
- Modify: `packages/capabilities/src/verification.test.ts`
- Modify: `apps/cli/src/commands/start.ts`
- Modify affected typed test adapters.

**Interfaces:**
- `VerificationWorkspaceAdapter.effectivePolicy(workspaceId)` adds `allowDynamicExecutables:boolean`.
- Internal verification `PolicySnapshot` adds the same boolean.
- `withStaticAvailability` permits an executable not in the fixed allowlist only when `allowDynamicExecutables:true`, then always asks `availability.inspectExecutable`.

- [ ] Write a failing verification test where an unlisted `uv` recipe is available only under `allowDynamicExecutables:true` and `inspectExecutable(...).executableAvailable=true`.
- [ ] Run focused verification tests and confirm failure because the fixed allowlist currently blocks `uv`.
- [ ] Extend the adapter/policy snapshot and update start wiring to return `allowDynamicExecutables` from the READY workspace policy.
- [ ] Implement the minimal static availability rule: `allowProcess` required; then fixed allowlist OR dynamic authority; then executable/sandbox inspection.
- [ ] Run verification tests and monorepo typecheck GREEN.
- [ ] Commit: `feat: allow dynamic verification executables`.

---

### Task 2: Strict `.kodegpt/verify.json` parser

**Files:**
- Create: `packages/capabilities/src/verification-config.ts`
- Create: `packages/capabilities/src/verification-config.test.ts`

**Interfaces:**

```ts
export interface ConfigVerificationDefinition {
  id: `config:${string}`;
  label: string;
  category: VerificationCategory;
  logicalExecutable: string;
  argv: string[];
  cwd: string;
  source: "kodegpt-config";
}

export async function readVerificationConfig(
  workspace: VerificationWorkspaceAdapter,
  workspaceId: string
): Promise<ConfigVerificationDefinition[]>;
```

- [ ] Write failing parser tests for absent config => `[]`, one valid recipe, file truncation/size mismatch, unknown/future schema, unknown top-level/recipe fields, >32 recipes, invalid key, bad label bytes, invalid category, `bash`/`sh`, path-like executable, >64 argv, >4096-byte argv item, and unsafe cwd.
- [ ] Run the new test and confirm RED because the module is absent.
- [ ] Implement strict bounded read using `pathIdentity` first and `readFile(...,{offset:0,maxBytes:64*1024})`; non-file/symlink config fails closed.
- [ ] Parse exact schema and normalize definitions to `source:"kodegpt-config"` / `id:"config:<key>"` without executing commands.
- [ ] Run parser tests and capability typecheck GREEN.
- [ ] Commit: `feat: parse verification recipes`.

---

### Task 3: Merge config recipes into discovery and execution

**Files:**
- Modify: `packages/capabilities/src/verification.ts`
- Modify: `packages/capabilities/src/verification.test.ts`

**Interfaces:**
- Consumes `readVerificationConfig` from Task 2.
- `verify.list` appends config recipes in deterministic config-key order after built-in package/Cargo discovery and decorates each with existing static availability.
- `verify.run` requires no new execution API: its existing rediscovery path re-reads config and re-checks availability immediately before execution.

- [ ] Write a failing `verify.list` test proving `config:pytest` appears with exact executable/argv/cwd/source and dynamic availability.
- [ ] Write a failing `verify.run` test proving the config is rediscovered and the execution adapter receives exactly `{workspaceId,recipeId,logicalExecutable,argv,cwd,background}`.
- [ ] Implement config discovery + `withStaticAvailability` merge in stable recipe-key order.
- [ ] Add a mutation test: change/remove config after list; subsequent `verify.run` must use the new state or return `VERIFICATION_NOT_FOUND/NOT_ALLOWED`, never cached launch data.
- [ ] Run all `@kodegpt/capabilities` tests GREEN.
- [ ] Commit: `feat: discover configured verification recipes`.

---

### Task 4: Phase 2 regression and surface invariants

**Files:**
- Modify security/source regression tests only if needed.

- [ ] Run `pnpm --filter @kodegpt/capabilities test`.
- [ ] Run `pnpm --filter @kodegpt/mcp-server test` and `pnpm --filter kodegpt test` to ensure unchanged `verify.list/run` public wiring.
- [ ] Run `pnpm -r typecheck`, `pnpm run verify:forbidden`, and `pnpm run build`.
- [ ] Verify `packages/mcp-server/src/surface-version.ts` remains `0.16` and source still registers exactly 75 unique public tools.
- [ ] Run `git diff --check` and verify the worktree is clean after commit.
- [ ] Commit any final regression-only changes as `test: verify configured verification recipes`.

## Host/CI Gate Before Merge

The full root suites that launch Bubblewrap remain host/CI-only because this implementation session itself runs inside KodeGPT's Bubblewrap sandbox:

```text
cargo test --workspace
pnpm test
pnpm run verify:package
```

Do not merge or deploy until those host/CI gates pass.
