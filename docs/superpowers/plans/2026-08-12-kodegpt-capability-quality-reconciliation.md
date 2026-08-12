# KodeGPT Capability Quality & Contract Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix real-repository search/context relevance, add bounded multi-project verification discovery, reconcile the shipped hybrid-skill MCP contract, and bring host/release documentation in line with observed ChatGPT behavior without weakening KodeGPT's security architecture.

**Architecture:** Add one internal `literal | semantic` traversal scope to the existing retained-root tree/search authority. Primitive file tools remain literal; high-level repository-understanding capabilities use semantic scope, which skips a fixed VCS/worktree/generated/vendor/cache directory set by default but admits an explicitly requested excluded root. Extend the existing verification and skill orchestration layers only through their current managers/adapters, then reconcile semantic surface/version and host evidence; do not introduce a second authority, shell path, agent runtime, provider gateway, or MCP trust/source/pin mutation.

**Tech Stack:** Node.js >=24, TypeScript 5.9, pnpm 10, Vitest, Zod 4, Rust stable, existing framed runtime protocol, retained-root `openat2` workspace authority, Bubblewrap sandbox, MCP protocol `2026-07-28`.

## Global Constraints

- Rust remains final OS/security authority for filesystem/process effects.
- MCP MUST NOT establish workspace trust.
- Primitive `file.tree` and `file.search` remain literal retained-root primitives; semantic filtering applies only when an internal high-level caller explicitly selects semantic scope.
- Explicitly scoping `workspace.inspect` or `code.search` to a normally excluded subtree MUST still work.
- Do not parse `.gitignore` into authority or filtering rules in this phase.
- Do not add public arbitrary ignore globs.
- Existing `TREE_LIMIT`, `FILE_SIZE_LIMIT`, `SCAN_BYTE_LIMIT`, `MATCH_LIMIT`, and `SNIPPET_BYTE_LIMIT` honesty MUST remain intact.
- Existing audit, root-FD, `openat2`, policy, trusted-executable, sandbox, artifact, state-root, and host-path-redaction invariants MUST remain green.
- No second `WorkspaceManager`, `NativeCapabilityService`, Git executor, process executor, or runtime kernel.
- No `shell.run`, Codex/Claude spawn/proxy, `skill.run`, workspace trust mutation, skill source mutation, or pin mutation through MCP.
- Skill source add/remove and pin/unpin remain local CLI-only authority.
- Provider interoperability (`provider.list`, `provider.tools`, `provider.invoke`) is explicitly deferred to a separate future design/plan.
- Keep current public skill limits: list <=500 results, load <=32 requested resources, load <=512 KiB returned bytes.
- Preserve stable public `sk_...` identity plus fingerprint for immutable pinned versions; do not introduce a new public `sp_...` identifier in this phase.
- Advance only the semantic MCP surface version from `0.2` to `0.3`; keep MCP protocol `2026-07-28`.
- Do not infer MCP Apps rendering from capability metadata; only actual ChatGPT rendering counts as observed.
- Historical unchecked plan boxes are not implementation truth; reconcile them against current source/tests instead of reimplementing already-shipped behavior.

---

## File Structure

Create:

```text
packages/capabilities/src/semantic-scope.test.ts
crates/workspace-io/src/semantic_scope.rs
crates/workspace-io/tests/semantic_scope.rs
tests/host/evidence-template.json
docs/architecture/README.md
```

Modify:

```text
packages/protocol/src/runtime-types.ts
schemas/runtime/request.schema.json
crates/protocol/src/types.rs
crates/protocol/tests/protocol_contract.rs
crates/workspace-io/src/lib.rs
crates/workspace-io/src/read.rs
crates/workspace-io/src/registry.rs
crates/runtime/src/dispatcher.rs
packages/core/src/workspace-manager.ts
packages/core/src/workspace-manager.test.ts
packages/capabilities/src/adapters.ts
packages/capabilities/src/workspace-inspect.ts
packages/capabilities/src/workspace-inspect.test.ts
packages/capabilities/src/code-search.ts
packages/capabilities/src/code-search.test.ts
packages/capabilities/src/context-build.ts
packages/capabilities/src/context-build.test.ts
packages/capabilities/src/verification.ts
packages/capabilities/src/verification.test.ts
packages/capabilities/src/native-capability-service.ts
apps/cli/src/commands/start.ts
apps/cli/src/commands/start.test.ts
packages/skills/src/contracts.ts
packages/skills/src/tool-adapter.ts
packages/skills/src/tool-adapter.test.ts
packages/mcp-server/src/tool-context.ts
packages/mcp-server/src/tools.ts
packages/mcp-server/src/skills.test.ts
packages/mcp-server/src/surface-version.ts
packages/mcp-server/src/server.test.ts
packages/mcp-server/src/structured-results.test.ts
tests/fixtures/mcp-surface.ts
tests/protocol/runtime-schema.test.ts
tests/protocol/framing-parity.test.ts
tests/integration/full-stack.test.ts
tests/integration/skill-interoperability.test.ts
tests/security/security-invariants.test.ts
docs/compatibility/chatgpt.md
docs/release/v0.1-checklist.md
docs/implementation/v0.1-execution-tracker.md
docs/superpowers/specs/2026-08-12-kodegpt-hybrid-skill-interoperability-reconciled-design.md
docs/superpowers/plans/2026-08-12-kodegpt-hybrid-skill-interoperability-reconciled.md
docs/superpowers/specs/2026-08-11-kodegpt-native-capability-layer-hardening-design.md
docs/superpowers/plans/2026-08-11-kodegpt-native-capability-layer-hardening.md
tests/host/README.md
```

Do not modify the primitive MCP schemas for `file.tree`/`file.search`; the new traversal scope belongs to the private runtime/core adapter path and is selected by production capability wiring, not by the public primitive tool input.

---

### Task 1: Add a Retained-Root Semantic Traversal Scope

**Files:**
- Modify: `packages/protocol/src/runtime-types.ts`
- Modify: `schemas/runtime/request.schema.json`
- Modify: `crates/protocol/src/types.rs`
- Modify: `crates/protocol/tests/protocol_contract.rs`
- Create: `crates/workspace-io/src/semantic_scope.rs`
- Create: `crates/workspace-io/tests/semantic_scope.rs`
- Modify: `crates/workspace-io/src/lib.rs`
- Modify: `crates/workspace-io/src/read.rs`
- Modify: `crates/workspace-io/src/registry.rs`
- Modify: `crates/runtime/src/dispatcher.rs`
- Modify: `packages/core/src/workspace-manager.ts`
- Modify: `packages/core/src/workspace-manager.test.ts`
- Modify: `tests/protocol/runtime-schema.test.ts`
- Modify: `tests/protocol/framing-parity.test.ts`

**Interfaces:**
- Consumes: existing retained-root `file.tree` and `file.search` runtime methods.
- Produces: private traversal discriminator `scope: "literal" | "semantic"`; `WorkspaceManager.treeBounded(..., scope)` and `searchBounded(..., scope)`; fixed semantic-scope behavior implemented inside Rust workspace authority.

- [ ] **Step 1: Add RED protocol tests for explicit traversal scope**

Extend private runtime request fixtures/types so both methods carry an explicit scope:

```ts
{
  method: "file.tree",
  params: {
    capabilityId: "kc_fixture",
    path: ".",
    maxEntries: 100,
    scope: "semantic"
  }
}

{
  method: "file.search",
  params: {
    capabilityId: "kc_fixture",
    path: ".",
    query: "needle",
    maxMatches: 100,
    scope: "semantic"
  }
}
```

Assert `literal` and `semantic` are accepted and values such as `"gitignore"`, `"all"`, arrays, or unknown fields are rejected.

- [ ] **Step 2: Run protocol RED**

Run:

```bash
pnpm test:protocol
cargo test -p kodegpt-protocol
```

Expected: FAIL because runtime request contracts do not yet contain `scope`.

- [ ] **Step 3: Add the closed TS/Rust traversal-scope contract**

Add:

```ts
export type WorkspaceTraversalScope = "literal" | "semantic";
```

and make `scope` required on private `file.tree` / `file.search` runtime params. Mirror the exact enum in Rust. Update all existing internal callers to send `"literal"` so existing primitive behavior is explicit rather than inferred.

Do not expose `scope` in MCP `file.tree` or `file.search` schemas.

- [ ] **Step 4: Write RED Rust semantic-tree tests**

Build a temporary retained-root fixture containing:

```text
src/app.ts
frontend/package.json
.github/workflows/ci.yml
.git/objects/aa/object
.worktrees/feature/frontend/package.json
node_modules/pkg/package.json
target/debug/generated.rs
dist/app.js
vendor/lib/source.ts
.cache/value.txt
```

Required assertions:

```text
literal tree at "."             -> sees all bounded entries
semantic tree at "."            -> sees src/, frontend/, .github/ but not excluded roots
semantic tree limit N            -> excluded descendants do not consume N
semantic tree at "node_modules"  -> admits requested root and sees pkg/package.json
semantic tree at ".worktrees/feature" -> admits requested root
```

- [ ] **Step 5: Run semantic-tree RED**

Run:

```bash
cargo test -p kodegpt-workspace-io semantic
```

Expected: FAIL because no semantic traversal policy exists.

- [ ] **Step 6: Implement the fixed semantic directory policy in Rust**

Create `semantic_scope.rs` with one deterministic predicate. For entries relative to the requested traversal root, exclude descent only when a directory name exactly equals one of:

```text
.git
.worktrees
node_modules
vendor
target
dist
build
coverage
out
__pycache__
.cache
.vite
.turbo
.next
.nuxt
.svelte-kit
.pytest_cache
.mypy_cache
.ruff_cache
.tox
.venv
venv
.VSCodeCounter
.code-review-graph
```

Do not exclude arbitrary hidden directories. The requested traversal root itself is never rejected by this predicate. This is relevance filtering, not access control.

Reuse existing directory-FD iteration/openat2 behavior. Do not canonicalize child paths through host pathnames and do not follow symlinks.

- [ ] **Step 7: Write RED Rust semantic-search tests**

Use a fixture where excluded directories contain both matching text and an oversized file that would otherwise create truncation pressure:

```text
src/main.ts                         -> "needle"
node_modules/pkg/index.ts           -> "needle"
.worktrees/feature/src/main.ts      -> "needle"
target/generated/huge.txt           -> >1 MiB
```

Assert:

```text
literal search at "."       -> may see excluded matches / existing truncation reasons
semantic search at "."      -> returns only src/main.ts and does not gain FILE_SIZE_LIMIT from target/
semantic search at "node_modules/pkg" -> returns pkg/index.ts
```

- [ ] **Step 8: Implement semantic search before candidate-file reads**

Apply the same traversal predicate during recursive candidate enumeration so excluded files do not consume the 64 MiB scan budget, per-file size checks, match budget, or snippet budget.

Do not filter after reading; the defect being fixed is wasted bounded I/O as well as noisy output.

- [ ] **Step 9: Extend `WorkspaceManager` without adding a new authority**

Use signatures equivalent to:

```ts
async treeBounded(
  workspaceId: string,
  path = ".",
  maxEntries = 2_000,
  scope: WorkspaceTraversalScope = "literal"
): Promise<WorkspaceTreeResult>

async searchBounded(
  workspaceId: string,
  query: string,
  path = ".",
  maxMatches = 200,
  scope: WorkspaceTraversalScope = "literal"
): Promise<WorkspaceSearchResult>
```

Existing primitive `tree()`/`search()` and MCP wiring continue to use `literal`.

- [ ] **Step 10: Prove primitive behavior remains literal**

Add a core/full-stack regression where primitive `file.tree` or `file.search` can still see a file under a normally excluded directory when explicitly called through the primitive tool.

This protects against accidentally turning relevance filtering into a hidden filesystem deny policy.

- [ ] **Step 11: Run Task 1 GREEN**

```bash
pnpm test:protocol
pnpm --filter @kodegpt/core test
cargo test -p kodegpt-protocol
cargo test -p kodegpt-workspace-io
cargo test -p kodegpt-runtime
pnpm exec vitest run tests/integration/full-stack.test.ts --no-file-parallelism
```

Expected: PASS.

- [ ] **Step 12: Review and commit Task 1**

Review for host-path access, symlink descent, accidental public `scope`, and changed primitive behavior. Then:

```bash
git add packages/protocol schemas crates/protocol crates/workspace-io crates/runtime packages/core tests/protocol tests/integration

git commit -m "feat(workspace): add semantic traversal scope"
```

---

### Task 2: Make `workspace.inspect` and `code.search` Use Semantic Scope

**Files:**
- Modify: `packages/capabilities/src/adapters.ts`
- Modify: `packages/capabilities/src/workspace-inspect.ts`
- Modify: `packages/capabilities/src/workspace-inspect.test.ts`
- Modify: `packages/capabilities/src/code-search.ts`
- Modify: `packages/capabilities/src/code-search.test.ts`
- Create: `packages/capabilities/src/semantic-scope.test.ts`
- Modify: `apps/cli/src/commands/start.ts`
- Modify: `apps/cli/src/commands/start.test.ts`
- Modify: `tests/integration/full-stack.test.ts`

**Interfaces:**
- Consumes: Task 1 `treeBounded(..., "semantic")` / `searchBounded(..., "semantic")` through the existing production `WorkspaceManager`.
- Produces: semantically relevant high-level inspect/search while primitive tools stay literal.

- [ ] **Step 1: Add a real-repository-shaped RED fixture**

Create a capability test fixture with at least:

```text
frontend/package.json
frontend/src/App.tsx
frontend/src/App.test.tsx
.git/objects/...
.worktrees/old/frontend/package.json
node_modules/pkg/package.json
node_modules/pkg/index.ts
target/generated.rs
.github/workflows/ci.yml
.ai-bridge/state.md
```

The adapter should record which scope each call requested.

- [ ] **Step 2: Write RED `workspace.inspect` assertions**

Assert root inspection:

```ts
expect(result.manifests).toContainEqual({ path: "frontend/package.json", kind: "node-package" });
expect(result.manifests.some(({ path }) => path.includes("node_modules"))).toBe(false);
expect(result.manifests.some(({ path }) => path.includes(".worktrees"))).toBe(false);
expect(result.areas.some(({ path }) => path === ".git")).toBe(false);
expect(result.areas.some(({ path }) => path === ".ai-bridge")).toBe(false);
```

Also assert an explicit inspection rooted at `.worktrees/old` succeeds using semantic scope relative to that requested root.

- [ ] **Step 3: Write RED `code.search` assertions for all five modes**

For default root search, assert matches never come from excluded paths. For an explicit `path:"node_modules/pkg"`, assert matching dependency content can be returned.

Require adapter-call assertions:

```ts
expect(treeCall.scope).toBe("semantic");
expect(searchCall.scope).toBe("semantic");
```

- [ ] **Step 4: Run capability RED**

```bash
pnpm --filter @kodegpt/capabilities test -- workspace-inspect code-search semantic-scope
```

Expected: FAIL because adapters/capabilities currently use literal traversal implicitly.

- [ ] **Step 5: Extend narrow capability adapters with scope**

Use explicit signatures:

```ts
tree(
  workspaceId: string,
  path: string | undefined,
  maxEntries: number,
  scope: "literal" | "semantic"
): Promise<CapabilityTreeResult>;

search(
  workspaceId: string,
  query: string,
  path: string | undefined,
  maxMatches: number,
  scope: "literal" | "semantic"
): Promise<CapabilitySearchResult>;
```

Capability callers always pass scope; test fakes must not silently default so regressions are visible.

- [ ] **Step 6: Switch `workspace.inspect` to semantic tree and clean area presentation**

Change its tree call to semantic scope. Keep existing lexical ordering, root-manifest evidence rules, warnings, and hard entry limits.

Because Rust excludes low-value directories before counting semantic entries, do not add a second TS post-filter that could create divergent completeness semantics. Separately tighten `detectAreas`: the generic top-level `kind:"other"` fallback must ignore directory names beginning with `.`; known `.github` workflow/config detection remains available through its existing explicit rules. This presentation rule does not remove hidden first-party files from semantic traversal/search.

- [ ] **Step 7: Switch all `code.search` modes to semantic traversal**

Use semantic tree for `path`, and semantic search for text/symbol/definition/reference candidate retrieval.

Keep precision labels and truncation reason ordering unchanged.

- [ ] **Step 8: Wire production adapters to the same `WorkspaceManager`**

In `createProductionServiceStack`, map semantic adapter calls to Task 1 methods. Do not create a separate repository index or scanner.

- [ ] **Step 9: Add full-stack relevance regression**

Through real MCP, open a trusted temporary workspace containing first-party and excluded duplicate `package.json` files. Assert `workspace.inspect` and `code.search(mode:"path", query:"package.json")` expose the first-party manifest but not dependency/worktree duplicates.

Then call primitive `file.search` against `node_modules` and prove the literal primitive remains available.

- [ ] **Step 10: Run Task 2 GREEN**

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter kodegpt test
pnpm --filter @kodegpt/mcp-server test
pnpm exec vitest run tests/integration/full-stack.test.ts --no-file-parallelism
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 11: Review and commit Task 2**

```bash
git add packages/capabilities apps/cli tests/integration

git commit -m "fix(capabilities): focus repository search evidence"
```

---

### Task 3: Harden `context.build` Against Dependency and Worktree Noise

**Files:**
- Modify: `packages/capabilities/src/context-build.ts`
- Modify: `packages/capabilities/src/context-build.test.ts`
- Modify: `tests/integration/full-stack.test.ts`

**Interfaces:**
- Consumes: Task 2 semantic `workspace.inspect` and `code.search`.
- Produces: bounded context bundles that prioritize first-party evidence and do not refill model context with excluded duplicates.

- [ ] **Step 1: Add RED regression matching the observed host failure shape**

Fixture:

```text
frontend/package.json
frontend/src/App.tsx
frontend/src/App.test.tsx
.worktrees/old/frontend/package.json
node_modules/pkg/package.json
node_modules/pkg/src/App.tsx
```

Call:

```ts
buildContext(adapter, {
  workspaceId: "ws_fixture",
  intent: "understand",
  target: "frontend/package.json",
  maxBytes: 64 * 1024
});
```

Assert:

```ts
expect(result.selectedFiles[0]?.path).toBe("frontend/package.json");
expect(result.selectedFiles.some(({ path }) => path.includes("node_modules"))).toBe(false);
expect(result.selectedFiles.some(({ path }) => path.includes(".worktrees"))).toBe(false);
expect(result.relevantMatches.some(({ path }) => path.includes("node_modules"))).toBe(false);
expect(result.relevantMatches.some(({ path }) => path.includes(".worktrees"))).toBe(false);
```

- [ ] **Step 2: Add RED deduplication and exact-target tests**

Prove one path appearing from multiple evidence channels is read once and receives the highest-priority reason. Also prove an explicitly requested target such as `node_modules/pkg/package.json` is still read as the exact target even though default semantic discovery would exclude incidental dependency paths.

- [ ] **Step 3: Run RED**

```bash
pnpm --filter @kodegpt/capabilities test -- context-build
```

Expected: at least the explicit relevance/dedup contract fails before the composer is hardened.

- [ ] **Step 4: Keep selection authority compositional**

Do not add direct tree traversal to `context-build.ts`. Continue consuming inspect/Git/search/verify/read only.

Normalize candidate paths into one `Map<string, Candidate>` before reads, retain the highest tier/score, and preserve lexical tie-breaking.

- [ ] **Step 5: Make search warnings reflect semantic evidence only**

`search-evidence-truncated` remains valid when semantic search itself is incomplete. Do not synthesize a warning from directories that semantic scope intentionally skipped.

- [ ] **Step 6: Preserve exact target override**

The exact target is added directly from caller input before semantic search candidates and remains eligible for `readFile`. Semantic scope is relevance policy for discovery, not a deny policy for an explicit target.

- [ ] **Step 7: Add full-stack context regression**

Through MCP `context.build`, use a real temporary workspace with the fixture shape above. Assert selected file paths and relevant matches contain no excluded incidental paths and total bytes remain within the requested budget.

- [ ] **Step 8: Run Task 3 GREEN**

```bash
pnpm --filter @kodegpt/capabilities test -- context-build
pnpm exec vitest run tests/integration/full-stack.test.ts --no-file-parallelism
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 9: Review and commit Task 3**

```bash
git add packages/capabilities/src/context-build.ts packages/capabilities/src/context-build.test.ts tests/integration/full-stack.test.ts

git commit -m "fix(context): prefer first-party repository evidence"
```

---

### Task 4: Discover Bounded Verification Recipes in Nested First-Party Projects

**Files:**
- Modify: `packages/capabilities/src/adapters.ts`
- Modify: `packages/capabilities/src/verification.ts`
- Modify: `packages/capabilities/src/verification.test.ts`
- Modify: `packages/capabilities/src/native-capability-service.ts`
- Modify: `apps/cli/src/commands/start.ts`
- Modify: `apps/cli/src/commands/start.test.ts`
- Modify: `tests/integration/full-stack.test.ts`

**Interfaces:**
- Consumes: Task 1 semantic bounded tree plus existing exact path identity/read, effective policy, executable availability inspection, and verification execution adapter.
- Produces: root-compatible plus nested project recipes; root IDs remain unchanged (`package:test`), nested IDs use `package:<project-path>:<script>`.

- [ ] **Step 1: Write RED nested-project discovery tests**

Fixture:

```text
package.json                  # root packageManager pnpm@10.15.1
pnpm-lock.yaml
frontend/package.json         # scripts test/lint/typecheck/build
backend/package.json          # scripts test
node_modules/pkg/package.json # must not participate
.worktrees/old/frontend/package.json # must not participate
Cargo.toml
```

Expected IDs include:

```text
package:frontend:test
package:frontend:lint
package:frontend:typecheck
package:frontend:build
package:backend:test
cargo:test
cargo:check
cargo:fmt-check
```

If root scripts exist, preserve current IDs such as `package:test`, not `package:root:test`.

- [ ] **Step 2: Add RED recipe launch assertions**

For nested `frontend` with pnpm resolution:

```ts
expect(recipe).toMatchObject({
  id: "package:frontend:test",
  logicalExecutable: "pnpm",
  argv: ["run", "test"],
  cwd: "frontend",
  source: "package-script"
});
```

The script body itself must never be parsed into argv.

- [ ] **Step 3: Add RED boundedness tests**

Set constants:

```ts
const MAX_VERIFICATION_PROJECT_MANIFESTS = 128;
const MANIFEST_READ_MAX_BYTES = 64 * 1024;
```

Assert:

```text
semantic tree truncated                         -> VERIFICATION_DISCOVERY_INVALID
>128 first-party package manifests              -> VERIFICATION_DISCOVERY_INVALID
manifest >64 KiB / malformed JSON               -> VERIFICATION_DISCOVERY_INVALID
excluded dependency manifests                   -> do not count toward 128
```

Because `VerifyListResult` has no partial-discovery marker, do not silently return an incomplete recipe set.

- [ ] **Step 4: Run verification RED**

```bash
pnpm --filter @kodegpt/capabilities test -- verification
```

Expected: FAIL because current discovery probes root evidence only.

- [ ] **Step 5: Extend `VerificationWorkspaceAdapter` with semantic tree only**

Add:

```ts
tree(
  workspaceId: string,
  path: string | undefined,
  maxEntries: number,
  scope: "literal" | "semantic"
): Promise<CapabilityTreeResult>;
```

Production wiring maps it to the existing `WorkspaceManager.treeBounded`.

- [ ] **Step 6: Discover first-party package manifests deterministically**

Call semantic tree at `.` with the existing 10,000 hard tree ceiling. Collect regular files whose basename is exactly `package.json`, sort lexically, and enforce the 128-manifest hard ceiling.

Keep exact root evidence probes for lockfiles/Cargo and backward-compatible root semantics.

- [ ] **Step 7: Resolve package manager without creating command authority**

For each package manifest:

1. parse an explicit supported `packageManager` if present;
2. otherwise inherit the resolved root manager/lock evidence;
3. if explicit nested manager conflicts with authoritative root lock evidence, report the existing package-manager conflict blocked reason for that package's recipes;
4. if no manager can be resolved, report `PACKAGE_MANAGER_UNKNOWN`.

No lifecycle scripts execute during discovery.

- [ ] **Step 8: Generate collision-free nested recipe IDs**

Use:

```ts
function packageRecipeId(projectDir: string, script: string): string {
  return projectDir === "." ? `package:${script}` : `package:${projectDir}:${script}`;
}
```

Use the project directory as `cwd`. Labels may include the project directory for human clarity but IDs remain the stable machine contract.

- [ ] **Step 9: Preserve run-time re-resolution**

Do not cache recipe launch tuples. `runVerification` must call the updated `listVerifications` again immediately before execution, then re-check current policy/executable/sandbox availability exactly as today.

- [ ] **Step 10: Add full-stack multi-project verification coverage**

Through real MCP `verify.list`, prove a first-party nested frontend package appears while `node_modules` and `.worktrees` packages do not. The test may leave recipes blocked by executable trust; discovery correctness is independent from launch permission.

- [ ] **Step 11: Run Task 4 GREEN**

```bash
pnpm --filter @kodegpt/capabilities test -- verification
pnpm --filter kodegpt test
pnpm exec vitest run tests/integration/full-stack.test.ts --no-file-parallelism
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 12: Review and commit Task 4**

Review that no recursive dependency traversal, shell parsing, package lifecycle execution, or executable-trust relaxation was introduced. Then:

```bash
git add packages/capabilities apps/cli tests/integration/full-stack.test.ts

git commit -m "feat(verify): discover nested project recipes"
```

---

### Task 5: Reconcile `skill.list` Filtering and the Semantic MCP Surface

**Files:**
- Modify: `packages/skills/src/contracts.ts`
- Modify: `packages/skills/src/tool-adapter.ts`
- Modify: `packages/skills/src/tool-adapter.test.ts`
- Modify: `packages/mcp-server/src/tool-context.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/skills.test.ts`
- Modify: `packages/mcp-server/src/surface-version.ts`
- Modify: `packages/mcp-server/src/server.test.ts`
- Modify: `packages/mcp-server/src/structured-results.test.ts`
- Modify: `tests/fixtures/mcp-surface.ts`
- Modify: `tests/integration/skill-interoperability.test.ts`
- Modify: `tests/security/security-invariants.test.ts`

**Interfaces:**
- Consumes: existing `SkillCompatibilityReport.classification` already produced by the catalog.
- Produces: optional read-only `skill.list.compatibility` filter and `MCP_SURFACE_VERSION = "0.3"`; tool count remains unchanged.

- [ ] **Step 1: Write RED skill-adapter compatibility-filter tests**

Add entries covering all classifications:

```text
NATIVE
PARTIAL
PROVIDER_REQUIRED
UNSUPPORTED
```

Call:

```ts
adapter.list({ compatibility: "NATIVE", limit: 1 })
```

Assert filtering occurs before the result limit. A nonmatching classification must not consume `limit`.

- [ ] **Step 2: Add RED MCP schema tests**

Assert `skill.list` accepts exactly:

```ts
compatibility: z.enum(["NATIVE", "PARTIAL", "PROVIDER_REQUIRED", "UNSUPPORTED"]).optional()
```

Reject arbitrary strings and unknown fields. Keep read-only annotations.

- [ ] **Step 3: Add RED semantic-surface assertion**

Change expected server capability to:

```ts
expect(MCP_SURFACE_VERSION).toBe("0.3");
```

Keep protocol expectation at `2026-07-28`.

- [ ] **Step 4: Run RED**

```bash
pnpm --filter @kodegpt/skills test -- tool-adapter
pnpm --filter @kodegpt/mcp-server test
```

Expected: FAIL because compatibility filter is absent and surface remains `0.2`.

- [ ] **Step 5: Add the filter to the public skill adapter contract**

Reuse the existing `SkillCompatibility` union already defined in `packages/skills/src/contracts.ts`:

```ts
export type SkillCompatibility = "NATIVE" | "PARTIAL" | "PROVIDER_REQUIRED" | "UNSUPPORTED";

export interface SkillCatalogToolAdapter {
  list(input: {
    limit?: number;
    sourceId?: string;
    compatibility?: SkillCompatibility;
    pinned?: boolean;
  }): Promise<SkillListResult>;
  // inspect/load unchanged
}
```

Do not create a second classification union.

- [ ] **Step 6: Filter before limiting**

In `createSkillCatalogToolAdapter`, apply filters in this semantic order before slicing:

```text
sourceId
compatibility
pinned
result limit
```

Preserve source discovery truncation reasons and add `RESULT_LIMIT` only when the filtered set exceeds the public limit.

- [ ] **Step 7: Thread the filter through MCP tool context/schema**

Update `SkillToolContext.list`, `tools.ts`, structured result tests, and test fixtures. Do not add a new tool.

- [ ] **Step 8: Advance semantic surface exactly once**

Set:

```ts
export const MCP_SURFACE_VERSION = "0.3" as const;
```

Update all literal surface-version tests and system capability expectations. Do not alter the MCP protocol version.

- [ ] **Step 9: Lock the current stricter public bounds in tests**

Add/retain explicit tests for:

```text
skill.list limit max         500
skill.load resources max      32
skill.load maxBytes       524288
```

Do not widen them to the older draft's 1000/64/1 MiB merely to match historical prose.

- [ ] **Step 10: Preserve stable `sk_ + fingerprint` behavior**

Strengthen the real skill integration fixture so the same `skillId` is used before and after pinning, while an old fingerprint continues to select the immutable pinned version after live mutation/deletion.

Do not introduce `sp_` IDs.

- [ ] **Step 11: Reassert forbidden authority**

Security tests must continue to prove public absence of:

```text
skill.run
skill.pin
skill.unpin
skill.source.add
skill.source.remove
workspace.trust
provider.list
provider.tools
provider.invoke
```

- [ ] **Step 12: Run Task 5 GREEN**

```bash
pnpm --filter @kodegpt/skills test
pnpm --filter @kodegpt/mcp-server test
pnpm exec vitest run tests/integration/skill-interoperability.test.ts --no-file-parallelism
pnpm test:security
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 13: Review and commit Task 5**

```bash
git add packages/skills packages/mcp-server tests/fixtures tests/integration/skill-interoperability.test.ts tests/security

git commit -m "fix(skills): reconcile public skill surface"
```

---

### Task 6: Reconcile Current Architecture, Skill Design, and Historical Plan Status

**Files:**
- Create: `docs/architecture/README.md`
- Modify: `docs/superpowers/specs/2026-08-12-kodegpt-hybrid-skill-interoperability-reconciled-design.md`
- Modify: `docs/superpowers/plans/2026-08-12-kodegpt-hybrid-skill-interoperability-reconciled.md`
- Modify: `docs/superpowers/specs/2026-08-11-kodegpt-native-capability-layer-hardening-design.md`
- Modify: `docs/superpowers/plans/2026-08-11-kodegpt-native-capability-layer-hardening.md`
- Modify: `docs/compatibility/chatgpt.md`
- Modify: `docs/release/v0.1-checklist.md`

**Interfaces:**
- Consumes: Tasks 1-5 code contracts as the current implementation truth.
- Produces: a durable authority index plus explicit reconciliation notes; historical plans remain auditable rather than being silently rewritten as if checkboxes were maintained contemporaneously.

- [ ] **Step 1: Add architecture authority index**

Create `docs/architecture/README.md` listing, by responsibility, the current repo authorities:

```text
v0.1 execution tracker / release checklist
native capability design + hardening reconciliation
zrok exposure design
hybrid skill reconciled design
ChatGPT compatibility evidence contract
security/runtime invariants represented by tests and tracker
```

State that this index does not recreate missing blueprint prose and does not override locked security decisions.

- [ ] **Step 2: Correct hybrid-skill identity/storage prose**

Reconcile the current authoritative skill design to the shipped model:

```text
ss_... = source identity
sk_... = stable skill identity
(skillId, fingerprint) = immutable version selector
availability/pinned = live/pinned state
private pin layout = <stateRoot>/skills/pins/<skillId>/<fingerprint>/...
```

Remove `sp_...` as a required public identity and explain that the shipped stable-skill-plus-fingerprint model avoids identity churn while preserving immutable reproducibility.

- [ ] **Step 3: Correct public skill bounds in the authoritative docs**

Document:

```text
public skill.list <=500
public skill.load requested resources <=32
public skill.load <=512 KiB
internal bundle/catalog bounds remain separately defined
```

Do not conflate internal and public limits.

- [ ] **Step 4: Reconcile `skill.list.compatibility` and surface `0.3`**

Update the reconciled skill plan/spec and compatibility docs to match Task 5. Preserve the MCP protocol version `2026-07-28`.

- [ ] **Step 5: Reconcile stale native-hardening status notes**

Where the hardening design/plan still says later tasks are unimplemented or “pending implementation plan,” append an execution-reconciliation note that points to current source/tests and the new capability-quality design. Do not mass-flip old RED/GREEN historical boxes without evidence records.

- [ ] **Step 6: Document semantic repository scope**

In `docs/compatibility/chatgpt.md`, explain:

```text
high-level inspect/search/context/verify discovery use semantic scope by default
primitive file tools remain literal
the fixed VCS/worktree/generated/vendor/cache exclusion set is skipped for relevance, not denied
arbitrary hidden first-party config directories are not excluded merely because they start with a dot
explicit high-level path into an excluded subtree opts in
```

- [ ] **Step 7: Update release semantic surface**

Change the release checklist from `0.2` to `0.3`, with protocol unchanged.

- [ ] **Step 8: Run documentation consistency searches**

Run repository searches and inspect every hit:

```bash
rg -n 'MCP semantic surface: `0\.2`|MCP_SURFACE_VERSION.*0\.2|surface 0\.2' docs packages tests
rg -n 'sp_|pins/<bundleFingerprint>|skill\.list.*1000|resources.*64|maxBytes.*1 MiB' docs/superpowers docs/compatibility
rg -n 'Task 7.*unimplemented|Task 8.*unimplemented|pending implementation plan' docs/superpowers
```

Expected: any remaining historical hit is explicitly labeled historical/superseded, not presented as current contract.

- [ ] **Step 9: Review and commit Task 6**

```bash
git add docs/architecture docs/superpowers docs/compatibility/chatgpt.md docs/release/v0.1-checklist.md

git commit -m "docs: reconcile capability and skill contracts"
```

---

### Task 7: Reconcile Real ChatGPT Host Acceptance and Add Positive Skill Host Procedure

**Files:**
- Create: `tests/host/evidence-template.json`
- Modify: `tests/host/README.md`
- Modify: `docs/compatibility/chatgpt.md`
- Modify: `docs/implementation/v0.1-execution-tracker.md`
- Modify: `docs/release/v0.1-checklist.md`

**Interfaces:**
- Consumes: real ChatGPT-host observations plus the current local-only trust/source/pin CLI authority.
- Produces: one non-contradictory release-evidence state and a repeatable positive skill-host acceptance procedure.

- [ ] **Step 1: Reconcile the host evidence template fields**

Keep machine-specific values outside Git. The reusable template must distinguish at least:

```json
{
  "discovery": { "observed": false },
  "workspaceOpen": { "observed": false },
  "readAction": { "observed": false },
  "writeAvailability": { "observed": false },
  "writeRoundTrip": { "observed": false },
  "processAction": { "observed": false },
  "skillActionExposure": { "observed": false },
  "skillPositiveRoundTrip": { "observed": false },
  "appsRendering": { "observed": false },
  "fallbackBehavior": { "observed": false }
}
```

An `observed:true` value must require actual target-host evidence, never inference.

- [ ] **Step 2: Record the already-proven claim categories in tracker prose**

Reconcile contradictory tracker sections so they agree that the target host has observed:

```text
tool discovery
locally-trusted workspace open
read
write/edit mutation -> readback -> exact revert
process call reaching KodeGPT, including policy-side denial behavior
skill action exposure reaching KodeGPT
```

Do not put machine-local project paths or credentials into Git.

- [ ] **Step 3: Keep unproven claim categories explicitly pending**

Until actually exercised, retain separate pending status for:

```text
MCP Apps visual rendering
positive skill list -> inspect -> load on a real configured host catalog
```

`host.uiSupported:true` is not Apps rendering evidence.

- [ ] **Step 4: Add a positive skill-host acceptance procedure**

Document operator-side setup with local-only authority:

```bash
mkdir -p /tmp/kodegpt-host-skill-source/portable/references
cat > /tmp/kodegpt-host-skill-source/portable/SKILL.md <<'EOF'
---
name: portable-host-acceptance
description: Host acceptance skill
---
Read the requested reference and report its exact marker.
EOF
printf 'kodegpt-host-skill-reference\n' > /tmp/kodegpt-host-skill-source/portable/references/marker.txt
kodegpt skill source add /tmp/kodegpt-host-skill-source --kind agent-skills
```

The procedure then requires ChatGPT to call:

```text
skill.list -> obtain skillId/fingerprint
skill.inspect -> verify no host path leakage and inventory includes references/marker.txt
skill.load(resources:["references/marker.txt"]) -> verify marker text
```

No MCP source-add operation is allowed.

- [ ] **Step 5: Add optional pin reproducibility procedure**

Using local CLI only, pin the observed `(skillId, fingerprint)`, modify/delete the live source, then have ChatGPT load the old fingerprint and verify the pinned immutable instructions/resources remain available.

The exact local CLI output should be copied only into local evidence, not committed if it contains environment-specific metadata.

- [ ] **Step 6: Add cleanup procedure**

Document local cleanup using `kodegpt skill source list`, `kodegpt skill source remove <source-id>`, optional `kodegpt skill unpin <skill-id> --fingerprint <sha256>`, and removal of `/tmp/kodegpt-host-skill-source`.

Do not automate cleanup through MCP.

- [ ] **Step 7: Add Apps rendering observation procedure**

Require a real host attempt to render `ui://kodegpt/dev-console/v1`. Record actual rendering separately from text fallback. A non-rendering host can still pass semantic tool acceptance, but the Apps field remains false/unobserved.

- [ ] **Step 8: Reconcile Task 24 / release gate language**

Remove the current contradiction where one tracker section says real host evidence exists and later sections say it is wholly unavailable. Use granular claim states instead of one all-or-nothing sentence.

- [ ] **Step 9: Review and commit Task 7 docs**

```bash
git add tests/host docs/compatibility/chatgpt.md docs/implementation/v0.1-execution-tracker.md docs/release/v0.1-checklist.md

git commit -m "docs(host): reconcile ChatGPT acceptance evidence"
```

---

### Task 8: Run Real-Repository Regression and Full Release Verification

**Files:**
- Modify only if a failing gate exposes a real defect; do not hide source fixes inside an evidence-only commit.
- Update: `docs/implementation/v0.1-execution-tracker.md` with fresh gate evidence after all source changes are stable.

**Interfaces:**
- Consumes: Tasks 1-7.
- Produces: fresh behavioral/security/release evidence for the exact final commit candidate.

- [ ] **Step 1: Run focused capability tests**

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/core test
pnpm --filter @kodegpt/skills test
pnpm --filter @kodegpt/mcp-server test
pnpm --filter kodegpt test
```

Expected: all PASS.

- [ ] **Step 2: Run protocol/Rust focused tests**

```bash
pnpm test:protocol
cargo test -p kodegpt-protocol
cargo test -p kodegpt-workspace-io
cargo test -p kodegpt-runtime
```

Expected: all PASS.

- [ ] **Step 3: Run integration/security gates**

```bash
pnpm test:integration
pnpm test:security
pnpm test:isolation
pnpm test:acceptance
```

Expected: all PASS.

- [ ] **Step 4: Run complete project gates**

```bash
cargo fmt --all -- --check
pnpm typecheck
pnpm build
pnpm test
cargo test --workspace
pnpm verify:forbidden
pnpm verify:package
pnpm bench:baseline
```

Expected: all PASS; performance remains record-only unless the release checklist has been explicitly amended through an approved design.

- [ ] **Step 5: Run architecture absence scans**

```bash
git grep -nE 'codex exec|spawn\([^)]*codex|exec\([^)]*codex|shell:[[:space:]]*true' -- . ':!docs/**'
git grep -nE 'skill\.run|provider\.(list|tools|invoke)' -- packages apps crates ':!**/*.test.ts'
```

Expected: no runtime agent/Codex execution, no public skill execution, no provider invocation implementation.

- [ ] **Step 6: Run the real trusted-project regression**

Using a locally trusted, already-existing multi-project repository, from ChatGPT host or equivalent exact KodeGPT MCP path:

```text
workspace.inspect(root)
code.search(mode=path, query=package.json)
context.build(target=<nested first-party package.json>)
verify.list
```

Required observations:

```text
no incidental node_modules/.worktrees/.git/target evidence in high-level results
nested first-party manifest remains visible
context target remains first-party and bounded
nested package verification recipes are discoverable
primitive file tools can still explicitly inspect excluded paths
```

Do not mutate that external project for this regression unless a separate reversible write probe is explicitly required; earlier write acceptance already exists.

- [ ] **Step 7: Run passive external-state/isolation guard if required by the release checklist**

Use the established before/after guard workflow around the final local command set. A changed protected external repository/listener state is a failure; do not modify the protected project to make the guard pass.

- [ ] **Step 8: Update tracker with exact fresh evidence**

Record the exact final commit, commands, result counts, semantic surface `0.3`, host-evidence claim granularity, and any still-pending Apps/positive-skill host observation.

Do not mark an unobserved host category PASS.

- [ ] **Step 9: Review final diff and commit evidence-only reconciliation**

If source is unchanged after Step 4, commit only evidence/docs:

```bash
git add docs/implementation/v0.1-execution-tracker.md docs/release/v0.1-checklist.md docs/compatibility/chatgpt.md

git commit -m "docs: record capability quality release evidence"
```

If any source changed after a failing gate, create a separate focused fix commit, rerun the affected focused gate plus the complete gates, then create the evidence commit.

---

### Task 9: Record Genuine Deferred Work Without Starting It

**Files:**
- Modify: `docs/architecture/README.md`
- Modify: `docs/implementation/v0.1-execution-tracker.md`

**Interfaces:**
- Consumes: historical documents audited during this planning phase.
- Produces: an explicit boundary between current completed/quality work and genuinely future authority-bearing features.

- [ ] **Step 1: Record provider interoperability as a separate future design gate**

Document that these are genuinely absent and require a dedicated security/design phase:

```text
provider.list
provider.tools
provider.invoke
```

The future design must answer provider admission/trust, tool inventory identity, capability mapping, credentials, process/network authority, audit, timeout/cancellation, output bounds, and host-path/secret redaction before any code is written.

- [ ] **Step 2: Keep `skill.run` explicitly excluded**

Document that provider interoperability does not imply a generic `skill.run`. GPT Web continues to interpret skill instructions; KodeGPT native/provider tools remain separately typed actions.

- [ ] **Step 3: Mark superseded tunnel work as superseded, not pending**

Document that old ngrok/generic-tunnel-plan text is historical and the current managed v0.1 exposure provider is zrok. Do not create a generic provider abstraction merely because an old document once deferred it.

- [ ] **Step 4: Verify no removed/paused desktop-computer-use work is pulled into this phase**

The authority index for this plan should contain no desktop automation implementation tasks.

- [ ] **Step 5: Commit backlog boundary docs**

```bash
git add docs/architecture/README.md docs/implementation/v0.1-execution-tracker.md

git commit -m "docs: separate deferred provider interoperability"
```

---

## Final Self-Review Checklist

Before execution begins, verify this plan against `docs/superpowers/specs/2026-08-12-kodegpt-capability-quality-reconciliation-design.md`:

- Semantic filtering happens before high-level tree/search budgets are consumed: Task 1.
- Primitive file tools remain literal and explicit excluded-root access remains possible: Tasks 1-2.
- `workspace.inspect` no longer reports generated/VCS/worktree noise as project evidence: Task 2.
- All five `code.search` modes use semantic scope while preserving honest truncation: Task 2.
- `context.build` keeps exact target priority and avoids incidental dependency/worktree evidence: Task 3.
- Nested first-party verification recipes are bounded and backward-compatible for root recipe IDs: Task 4.
- Verification still uses named scripts and existing executable/sandbox authority, not shell parsing: Task 4.
- `skill.list.compatibility` exists and filters before limit: Task 5.
- Semantic MCP surface is `0.3`; protocol remains `2026-07-28`: Task 5.
- Public skill limits remain 500 / 32 / 512 KiB: Tasks 5-6.
- Stable `sk_ + fingerprint` pinned identity is preserved and older `sp_` prose is reconciled: Tasks 5-6.
- Historical unchecked boxes are reconciled rather than blindly reimplemented: Task 6.
- Tracker no longer simultaneously says host evidence is both observed and unavailable: Task 7.
- Apps rendering remains a separate actual-host observation: Task 7.
- Positive skill-host acceptance uses local-only source/pin setup and read-only MCP skill actions: Task 7.
- Full local/Rust/security/package and real-repository regression gates are fresh: Task 8.
- Provider interoperability is captured as genuinely future work and is not partially implemented: Task 9.
- No generic tunnel resurrection, Codex/Claude runtime dependency, shell shortcut, MCP trust mutation, or `skill.run`: all tasks.

## Execution Order

Execute Tasks 1 -> 9 in order. Tasks 1-4 modify the capability contract and must stabilize before the skill semantic-surface correction and documentation reconciliation are declared final. Do not start provider interoperability after Task 9 inside the same branch/session; it requires a new design review and implementation plan.
