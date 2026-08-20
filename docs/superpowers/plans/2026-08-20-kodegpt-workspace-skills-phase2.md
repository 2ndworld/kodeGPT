# KodeGPT Workspace Skills Phase 2 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans and superpowers:test-driven-development task-by-task.

**Goal:** Auto-discover repository-local Agent Skills inside READY trusted workspaces through existing `skill.list/inspect/load`, and make external-CLI compatibility honor dynamic Developer Environments.

**Architecture:** Keep one parser/fingerprint/catalog pipeline. Extend `SkillSourceManager` with an optional read-only workspace source provider. `SkillCatalog` receives optional `workspaceId` and passes it through source discovery/read operations. Workspace-local roots are read only through retained `WorkspaceManager` authority, never raw host filesystem access. Global registered/pinned behavior remains unchanged without `workspaceId`.

**Spec:** `docs/superpowers/specs/2026-08-20-kodegpt-developer-environment-continuity-design.md` Part D / Phase 2.

**Surface:** no new MCP tool; remain `0.16 / 75 tools`.

## Constraints

- Auto-discover only `skills/`, `.agents/skills/`, `.codex/skills/` below a READY trusted workspace.
- Never auto-discover user-home/external roots.
- Skills remain instructions/resources only; no executable skill runtime.
- Preserve existing parser, resource, bundle, count, and fingerprint bounds.
- Workspace source IDs are deterministic from durable trust ID + conventional root; do not create another persisted registry.
- Closing/untrusting a workspace makes local skills inaccessible.
- `skill.list` and `skill.load` gain optional `workspaceId`; inspect keeps its existing optional `workspaceId`.
- Known local skills use `SKILL_WORKSPACE_REQUIRED` / `SKILL_WORKSPACE_MISMATCH` for missing/wrong scope.
- External CLI compatibility uses fixed allowlist OR `allowDynamicExecutables`, then executable/sandbox inspection; inspection never executes the CLI.

### Task 1 — Retained workspace binary reads

**Files:** `packages/core/src/workspace-manager.ts`, tests, core index.

Add private-core `WorkspaceManager.readFileBytes(workspaceId,path,{offset,maxBytes})` over runtime `file.read` with `encoding:"base64"`. Validate canonical base64, exact byte counts, eof, and existing bounds. No MCP tool.

- [ ] RED tests for base64 request/decoding and malformed runtime payloads.
- [ ] Minimal implementation + exports.
- [ ] Core tests/typecheck GREEN.
- [ ] Commit `feat: add retained workspace byte reads`.

### Task 2 — Conventional workspace skill source provider

**Files:** new `packages/skills/src/workspace-source.ts` + tests; contracts/index.

Provider authority supplies READY `{workspaceId,trustId}`, path identity, literal tree, and binary read. Source ID is `ss_<first32 sha256(trustId + NUL + conventionalRoot)>`. `listSources(workspaceId)` probes exactly three conventional roots and returns directories only. Tree/read prepend the bound root and normalize results back to source-relative paths. Bindings are ephemeral and workspace-matched.

- [ ] RED tests: three-root discovery, stable IDs across restart, outside-root exclusion, mismatch, tree normalization, bytes, symlink/other rejection.
- [ ] Implement read-only provider.
- [ ] Skills tests/typecheck GREEN.
- [ ] Commit `feat: add workspace skill sources`.

### Task 3 — Workspace-aware source manager and catalog

**Files:** `source-manager.ts`, `catalog.ts`, errors, tests.

`SkillSourceManager` optionally merges workspace sources when `workspaceId` is present and routes local tree/read/readBytes to the workspace provider; global sources keep existing runtime registration. Catalog `list/inspect/loadRaw` accept optional `workspaceId`, pass scope through discovery/build, and keep pin/live CLI flows global-only. On inspect/load miss, bounded scan of currently READY workspace scopes distinguishes `SKILL_WORKSPACE_REQUIRED`, `SKILL_WORKSPACE_MISMATCH`, and true `SKILL_NOT_FOUND` without a persisted mapping database.

- [ ] RED routing and catalog scope tests.
- [ ] Implement scope propagation and on-miss scope resolution.
- [ ] All skills tests GREEN.
- [ ] Commit `feat: scope skills to ready workspaces`.

### Task 4 — MCP contracts and production wiring

**Files:** skills contracts/tool-adapter tests; MCP tool-context/tools/skills tests; CLI start wiring/tests.

Propagate optional `workspaceId` through list/inspect/load. Add optional `workspaceId` to MCP `skill.list` and `skill.load` schemas. Production startup creates trust/managers before skill catalog and passes workspace authority to `prepareSkillCatalog`. Default authority derives READY trust IDs from `listWorkspaces + listTrustedWorkspaces`, and uses only `pathIdentity`, literal `treeBounded`, and private `readFileBytes`.

- [ ] RED MCP forwarding/schema tests and production auto-discovery test.
- [ ] Implement wiring; global no-workspace behavior unchanged.
- [ ] Skills/MCP/CLI tests + monorepo typecheck GREEN.
- [ ] Commit `feat: expose workspace-local skills`.

### Task 5 — Dynamic skill CLI compatibility

**Files:** skills contracts/capability-plan tests; MCP tool-context tests.

Add `allowDynamicExecutables` to `SkillCapabilityRuntimeContext`. External CLI is `not-allowed` only when process is disabled or neither fixed-listed nor dynamically admitted. Dynamic admission still requires executable+sandbox availability from inspect.

- [ ] RED `external-cli:uv` test: dynamic true + available => NATIVE; dynamic false => not-allowed.
- [ ] Minimal implementation and MCP wiring.
- [ ] Skills/MCP tests GREEN.
- [ ] Commit `feat: resolve dynamic skill cli requirements`.

### Task 6 — Workflow guidance and regression

Audit the existing application-development workflow skill for stale manual source-registration or Node/Rust-specific guidance; change only what is necessary.

- [ ] Skills, MCP, CLI tests.
- [ ] `pnpm -r typecheck`.
- [ ] `pnpm run verify:forbidden`.
- [ ] `pnpm run build`.
- [ ] Verify `0.16 / 75 tools`, `git diff --check`, clean worktree.

## Host/CI gate before merge

Outside this nested Bubblewrap session: `cargo test --workspace`, root `pnpm test`, and `pnpm run verify:package` must pass before merge/deploy.
