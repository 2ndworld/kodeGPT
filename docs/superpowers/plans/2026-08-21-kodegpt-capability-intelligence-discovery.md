# KodeGPT Capability Intelligence + Unified Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic capability-intelligence layer that makes all KodeGPT public actions and Agent Skills discoverable by intent, adds machine-readable core/stage skill requirements, and exposes one read-only `system.discover` MCP tool.

**Architecture:** Move the authoritative public action inventory and discovery metadata into `@kodegpt/capabilities`, derive the MCP surface inventory from it, and reconcile native capability semantics against the same catalog. Extend `@kodegpt/skills` with a separate public-action requirement graph plus deterministic query ranking while preserving the existing capability plan. Compose action search, skill search, duplicate grouping, workspace availability, and stage-derived flow evidence in `@kodegpt/mcp-server` without adding a model runtime, workflow engine, network search, or background index.

**Tech Stack:** TypeScript 5.9, Node.js 24, pnpm workspace, Vitest 3, Zod 4, existing MCP server packages, existing Rust runtime/security gates unchanged.

**Spec:** `docs/superpowers/specs/2026-08-21-kodegpt-capability-intelligence-discovery-design.md`

## Global Constraints

- Baseline is `b3d502c598ec6595bec4e5427dc9f3305ff264a4`; this feature branch starts from that exact commit.
- Final runtime version remains `0.1`.
- Final MCP protocol remains `2026-07-28`.
- Final MCP semantic surface is exactly `0.18`.
- Final public MCP tool count is exactly `76`, adding only `system.discover`.
- `system.discover` is read-only and must never dispatch action handlers, run processes, mutate workspace/Git/files/checkpoints, create previews, navigate browsers, install skills, or call GitHub/CI/provider networks.
- Keep `NATIVE_CAPABILITY_IDS` as a strict subset of the public action IDs; do not expand it to all public tools merely for discovery.
- Keep existing `SkillCapabilityPlan` behavior and external-CLI resolution; add a separate `SkillRequirementGraph` instead of replacing the capability plan.
- Conditional skill stages do not downgrade overall core compatibility.
- No `workflow.run`, `skill.run`, `agent.*`, generic `provider.invoke`, plugin runtime, vector database, embeddings call, LSP/index daemon, conversation database, or automatic checkpoint mutation.
- Discovery query is bounded to 512 UTF-8 bytes. `system.discover.limit` defaults to 8 and is hard-bounded to 20.
- Skill stage bounds: maximum 16 stages/skill, 32 actions/stage, 32 core actions, 16 native capabilities/stage, and 8 providers/stage.
- `system.discover` inspects at most 5 ranked skill candidates for stage details, returns at most 5 flow records, and bounds match reasons/alternate duplicate provenance.
- Deterministic discovery acceptance: >=95% top-3 recall, >=90% top-1 accuracy, and 100% top-3 recall for critical routing intents defined by the spec.
- All ranking/tie-breaking must be deterministic and locale-independent; use UTF-8 byte comparison where a stable tie-break is required.
- Use TDD for every behavior change: failing test, verify red, minimal implementation, verify green, then commit.

---

## File/Responsibility Map

### New files

- `packages/capabilities/src/public-actions.ts` — authoritative public action IDs, required input names, purpose, aliases, tags, role, scope, immutable descriptors, and lookup helpers.
- `packages/capabilities/src/public-actions.test.ts` — catalog completeness/immutability/native-subset invariants.
- `packages/capabilities/src/public-action-search.ts` — deterministic query normalization, scoring, match reasons, and bounded action search.
- `packages/capabilities/src/public-action-search.test.ts` — unit ranking/tie-break/no-match tests.
- `packages/skills/src/declared-requirements.ts` — one parser for `metadata.kodegpt` capability/provider/unsupported/action/stage declarations used by both compatibility and requirement-graph logic.
- `packages/skills/src/declared-requirements.test.ts` — declaration validation/bounds/legacy tests.
- `packages/skills/src/requirement-graph.ts` — core/stage public-action requirement analysis and static public-action reference reconciliation.
- `packages/skills/src/requirement-graph.test.ts` — graph, stage classification, inference, bounds, and unknown-action tests.
- `packages/skills/src/skill-search.ts` — deterministic skill query scoring and ordering.
- `packages/skills/src/skill-search.test.ts` — exact-name/token/description/compatibility/workspace ordering tests.
- `packages/mcp-server/src/discovery.ts` — bounded `system.discover` composition, action availability, duplicate grouping, stage matching, flows, truncation.
- `packages/mcp-server/src/discovery.test.ts` — composition/side-effect/bounds/duplicate/availability tests.
- `tests/performance/discovery-quality.test.ts` — release-gate quality benchmark across realistic English + Indonesian development intents.
- `docs/release/2026-08-21-capability-intelligence-discovery-readiness.md` — final release evidence created only after implementation verification.

### Existing files to modify

- `packages/capabilities/src/contracts.ts` — export public-action types only if shared contracts belong here; keep `NATIVE_CAPABILITY_IDS` unchanged.
- `packages/capabilities/src/skill-metadata.ts` — derive native purpose/aliases from public action descriptors rather than maintaining separate authored semantic text.
- `packages/capabilities/src/skill-metadata.test.ts` — prove semantic reconciliation.
- `packages/capabilities/src/index.ts` — export public action catalog/search contracts/helpers.
- `packages/skills/src/contracts.ts` — add query input, requirement-graph result types, stage/support types, truncation reasons.
- `packages/skills/src/compatibility.ts` — consume shared declared-requirements parser; preserve current compatibility semantics.
- `packages/skills/src/compatibility.test.ts` — regression coverage for legacy/current capability/provider/CLI behavior.
- `packages/skills/src/catalog.ts` — attach requirement graph to inspections; do not change raw identity/provenance semantics.
- `packages/skills/src/catalog.test.ts` — graph presence and fingerprint/source regressions.
- `packages/skills/src/tool-adapter.ts` — add optional query ranking to `list`, clone/publicize requirement graph in `inspect`.
- `packages/skills/src/tool-adapter.test.ts` — query behavior and public graph cloning.
- `packages/skills/src/index.ts` — export new types/builders/search helpers needed by MCP.
- `skills/kodegpt-application-development-workflow/SKILL.md` — add `metadata.kodegpt.requires.actions` + conditional stage declarations; keep existing prose behavior.
- `packages/mcp-server/src/tools.ts` — derive `listSurfaceTools()` from public catalog, add `skill.list.query`, register read-only `system.discover`.
- `packages/mcp-server/src/tool-context.ts` — extend skill list query input and system discovery composition/context contract.
- `packages/mcp-server/src/server.test.ts` — exact surface/version assertions.
- `packages/mcp-server/src/skills.test.ts` — updated skill schema/requirement graph/query tests.
- `packages/mcp-server/src/structured-results.test.ts` — structured result schema for `system.discover` and skill graph.
- `packages/mcp-server/src/surface-version.ts` — final bump `0.17 -> 0.18` in the public surface task.
- `packages/mcp-server/src/index.ts` — export any discovery result/public action types that are intentionally public to internal consumers.
- `apps/cli/src/commands/start.ts` — derive public tool inventory from catalog through `listSurfaceTools`; add compact discovery feature summary to `system.capabilities`.
- `apps/cli/src/commands/start.test.ts` — assert discovery summary and 76-tool inventory.
- `tests/fixtures/mcp-surface.ts` — final locked 76-tool fixture including `system.discover` required `query`.
- `tests/integration/mcp-conformance.test.ts`, `tests/integration/mcp-http.test.ts`, `tests/integration/mcp-stdio.test.ts`, `tests/integration/cli-bridge.test.ts`, `tests/integration/full-stack.test.ts` — exact public surface/transport/dogfood coverage as required by existing fixtures.
- `tests/integration/provider-gateway.test.ts`, `tests/security/security-invariants.test.ts` — update current semantic surface assertion only; provider/security authority remains unchanged.
- `docs/architecture/README.md` — reconcile current capability map and authority index after merge-ready verification.
- `docs/implementation/v0.1-execution-tracker.md` — append verified implementation/release evidence; do not rewrite historical entries.

---

### Task 1: Authoritative Public Action Catalog and MCP Surface Derivation

**Files:**
- Create: `packages/capabilities/src/public-actions.ts`
- Create: `packages/capabilities/src/public-actions.test.ts`
- Modify: `packages/capabilities/src/index.ts`
- Modify: `packages/mcp-server/src/tools.ts:317-403`
- Modify: `packages/mcp-server/src/server.test.ts`

**Interfaces:**
- Produces: `PUBLIC_ACTION_IDS`, `PublicActionId`, `PublicActionDescriptor`, `PUBLIC_ACTIONS`, `getPublicActionDescriptor(id)`, `listPublicActionDescriptors()`.
- Produces: `listSurfaceTools()` derived from `listPublicActionDescriptors()` instead of local `SURFACE_TOOLS` duplication.
- Consumes later: Task 2 action search; Task 3 requirement graph; Task 6 `system.discover`.

- [ ] **Step 1: Add failing catalog completeness tests**

Create `packages/capabilities/src/public-actions.test.ts` with tests equivalent to:

```ts
import { describe, expect, it } from "vitest";
import { NATIVE_CAPABILITY_IDS } from "./contracts.js";
import {
  PUBLIC_ACTION_IDS,
  getPublicActionDescriptor,
  listPublicActionDescriptors
} from "./public-actions.js";

describe("public action catalog", () => {
  it("contains the current 75 public actions exactly once before system.discover is added", () => {
    expect(PUBLIC_ACTION_IDS).toHaveLength(75);
    expect(new Set(PUBLIC_ACTION_IDS).size).toBe(75);
    expect(PUBLIC_ACTION_IDS).toContain("workspace.info");
    expect(PUBLIC_ACTION_IDS).toContain("visual.captureMatrix");
    expect(PUBLIC_ACTION_IDS).toContain("github.pr.create");
    expect(PUBLIC_ACTION_IDS).not.toContain("system.discover");
  });

  it("provides complete immutable discovery metadata", () => {
    for (const id of PUBLIC_ACTION_IDS) {
      const descriptor = getPublicActionDescriptor(id);
      expect(descriptor.id).toBe(id);
      expect(descriptor.family).toBe(id.slice(0, id.indexOf(".")));
      expect(descriptor.purpose.length).toBeGreaterThan(0);
      expect(descriptor.aliases.length).toBeGreaterThan(0);
      expect(descriptor.tags.length).toBeGreaterThan(0);
      expect(descriptor.requiredInputs).toBeDefined();
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(Object.isFrozen(descriptor.aliases)).toBe(true);
      expect(Object.isFrozen(descriptor.tags)).toBe(true);
      expect(Object.isFrozen(descriptor.requiredInputs)).toBe(true);
    }
    expect(Object.isFrozen(listPublicActionDescriptors())).toBe(true);
  });

  it("keeps native capabilities as a strict public-action subset", () => {
    const publicIds = new Set<string>(PUBLIC_ACTION_IDS);
    for (const id of NATIVE_CAPABILITY_IDS) expect(publicIds.has(id)).toBe(true);
    expect(PUBLIC_ACTION_IDS.length).toBeGreaterThan(NATIVE_CAPABILITY_IDS.length);
  });
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
pnpm --filter @kodegpt/capabilities test -- public-actions.test.ts
```

Expected: FAIL because `public-actions.ts`/exports do not exist.

- [ ] **Step 3: Implement the catalog types and helper**

Create `public-actions.ts` with these exact public contracts:

```ts
export type PublicActionRole =
  | "primitive"
  | "composite"
  | "lifecycle"
  | "integration"
  | "introspection";

export type PublicActionScope = "global" | "workspace" | "repository" | "preview";

export interface PublicActionDescriptor {
  readonly id: PublicActionId;
  readonly family: string;
  readonly purpose: string;
  readonly aliases: readonly string[];
  readonly tags: readonly string[];
  readonly role: PublicActionRole;
  readonly scope: PublicActionScope;
  readonly requiredInputs: readonly string[];
}
```

Define the 75 pre-P0 IDs exactly from the current `SURFACE_TOOLS` inventory, preserving its current deterministic order and required inputs:

```text
artifact.read
browser.click
browser.console
browser.inspect
browser.networkFailures
browser.openPreview
browser.screenshot
browser.type
ci.cancel
ci.dispatch
ci.failure
ci.repository
ci.rerun
ci.run
ci.runs
ci.status
code.impact
code.search
console.state
context.build
file.edit
file.patch
file.read
file.tree
file.write
git.branchCreate
git.branchDelete
git.branchSwitch
git.worktreeCreate
git.worktreeRemove
git.changes
git.commit
git.diff
git.diffHistory
git.fetch
git.log
git.pull
git.push
git.range
git.show
git.stage
git.status
github.issue.inspect
github.issue.list
github.pr.create
github.pr.inspect
github.pr.list
github.pr.merge
github.repository.inspect
process.cancel
process.run
process.status
preview.inspect
preview.start
preview.stop
profile.current
profile.inspect
skill.list
skill.inspect
skill.load
system.capabilities
system.health
trust.list
verify.list
verify.run
visual.captureMatrix
visual.compare
workspace.close
workspace.checkpoint
workspace.info
workspace.inspect
workspace.list
workspace.open
workspace.trust
workspace.untrust
```

For each descriptor:

1. copy `requiredInputs` exactly from current `SURFACE_TOOLS`;
2. use the existing `registerTool` description as the source of truth for `purpose`, shortening only implementation detail that harms search;
3. preserve existing native semantic aliases for the 36 native capability IDs;
4. add 2-6 intent-oriented aliases and 2-6 tags for each non-native action;
5. classify lifecycle operations (`workspace.open/close`, preview/process lifecycle, branch/worktree lifecycle) as `lifecycle`; GitHub/CI as `integration`; state/capability/inspect/list/read/status operations as `introspection` unless a more useful composite/primitive classification applies; high-level context/verification/visual operations may be `composite`.

Use a helper that freezes every descriptor and nested array, rejects duplicate IDs at module initialization, and sorts/canonicalizes aliases/tags using UTF-8 comparison. Do not expose mutable catalog objects.

- [ ] **Step 4: Export catalog APIs**

Update `packages/capabilities/src/index.ts` to export the public action types/constants/helpers. Do not export implementation-only scoring internals yet.

- [ ] **Step 5: Run capability tests and verify GREEN**

Run:

```bash
pnpm --filter @kodegpt/capabilities test
```

Expected: all capability tests PASS.

- [ ] **Step 6: Add failing MCP derivation test**

In `packages/mcp-server/src/server.test.ts`, add/adjust an assertion so `listSurfaceTools()` equals the catalog projection:

```ts
expect(listSurfaceTools()).toEqual(
  listPublicActionDescriptors().map(({ id, requiredInputs }) => ({
    name: id,
    required: [...requiredInputs]
  }))
);
```

Run:

```bash
pnpm --filter @kodegpt/mcp-server test -- server.test.ts
```

Expected: FAIL while `tools.ts` still owns local `SURFACE_TOOLS` independently.

- [ ] **Step 7: Derive MCP surface inventory from the catalog**

Remove the local authored `SURFACE_TOOLS` array from `packages/mcp-server/src/tools.ts`. Implement:

```ts
export function listSurfaceTools(): Array<{ name: string; required: string[] }> {
  return listPublicActionDescriptors().map(({ id, requiredInputs }) => ({
    name: id,
    required: [...requiredInputs]
  }));
}
```

Actual handler registration remains in `registerKodegptTools`; do not move handlers into `@kodegpt/capabilities`.

- [ ] **Step 8: Verify catalog/surface tests GREEN**

Run:

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/mcp-server test -- server.test.ts
pnpm --filter @kodegpt/mcp-server typecheck
```

Expected: PASS; public count is still 75 in this task.

- [ ] **Step 9: Commit Task 1**

```bash
git add packages/capabilities/src/public-actions.ts packages/capabilities/src/public-actions.test.ts packages/capabilities/src/index.ts packages/mcp-server/src/tools.ts packages/mcp-server/src/server.test.ts
git commit -m "feat: add authoritative public action catalog"
```

---

### Task 2: Native Semantic Reconciliation and Deterministic Action Search

**Files:**
- Create: `packages/capabilities/src/public-action-search.ts`
- Create: `packages/capabilities/src/public-action-search.test.ts`
- Modify: `packages/capabilities/src/skill-metadata.ts`
- Modify: `packages/capabilities/src/skill-metadata.test.ts`
- Modify: `packages/capabilities/src/index.ts`
- Create: `tests/performance/discovery-quality.test.ts` with the first action-only benchmark table; later tasks extend it.

**Interfaces:**
- Consumes: Task 1 `PublicActionDescriptor`/catalog.
- Produces: `normalizeDiscoveryQuery(value: string) -> { normalized: string; tokens: readonly string[] }` and `searchPublicActions(query, options?) -> readonly PublicActionSearchMatch[]`; Task 5 reuses the same normalization helper through `@kodegpt/capabilities`.
- Produces: native semantic metadata derived from matching public action descriptors.

- [ ] **Step 1: Write failing semantic reconciliation tests**

Update `skill-metadata.test.ts`:

```ts
it("derives native purpose and aliases from the public action catalog", () => {
  for (const id of NATIVE_CAPABILITY_IDS) {
    const native = getNativeCapabilitySemanticMetadata(id);
    const action = getPublicActionDescriptor(id);
    expect(native.purpose).toBe(action.purpose);
    expect(native.semanticAliases).toEqual(action.aliases);
  }
});
```

Run:

```bash
pnpm --filter @kodegpt/capabilities test -- skill-metadata.test.ts
```

Expected: FAIL until `skill-metadata.ts` delegates to the action catalog.

- [ ] **Step 2: Reconcile native semantic metadata**

Replace separately authored semantic text in `skill-metadata.ts` with a projection from public actions:

```ts
export function getNativeCapabilitySemanticMetadata(
  id: NativeCapabilityId
): NativeCapabilitySemanticMetadata {
  const action = getPublicActionDescriptor(id);
  return Object.freeze({
    id,
    purpose: action.purpose,
    semanticAliases: action.aliases
  });
}
```

If the existing exported `NATIVE_CAPABILITY_SEMANTICS` object is part of internal consumers/tests, build it programmatically from `NATIVE_CAPABILITY_IDS`; do not retain a second authored alias registry.

- [ ] **Step 3: Verify semantic tests GREEN**

Run:

```bash
pnpm --filter @kodegpt/capabilities test
```

Expected: PASS.

- [ ] **Step 4: Write failing deterministic ranking tests**

Create `public-action-search.test.ts` with at least these tests:

```ts
it("ranks exact action ids first", () => {
  expect(searchPublicActions("ci.failure", { limit: 5 })[0]?.action.id).toBe("ci.failure");
});

it("ranks exact aliases above description-only matches", () => {
  expect(searchPublicActions("why ci failed", { limit: 5 })[0]?.action.id).toBe("ci.failure");
});

it("finds visual verification from broad intent", () => {
  expect(searchPublicActions("check responsive UI screenshots", { limit: 3 }).map(x => x.action.id))
    .toContain("visual.captureMatrix");
});

it("returns no unrelated fallback for a no-match query", () => {
  expect(searchPublicActions("zxqv completely unrelated tokens", { limit: 8 })).toEqual([]);
});

it("is byte-for-byte deterministic across repeated calls", () => {
  const first = JSON.stringify(searchPublicActions("continue previous work", { limit: 8 }));
  for (let index = 0; index < 20; index += 1) {
    expect(JSON.stringify(searchPublicActions("continue previous work", { limit: 8 }))).toBe(first);
  }
});
```

Also assert every match has an integer non-negative score and 1..8 bounded reasons.

- [ ] **Step 5: Run ranking tests and verify RED**

```bash
pnpm --filter @kodegpt/capabilities test -- public-action-search.test.ts
```

Expected: FAIL because action search does not exist.

- [ ] **Step 6: Implement deterministic query normalization/scoring**

Implement local-only scoring in `public-action-search.ts` using integer weights and explicit reason codes. Use this ordering and initial weights; tune only through benchmark evidence:

```ts
const SCORE = Object.freeze({
  ACTION_ID_EXACT: 10_000,
  ALIAS_EXACT: 9_000,
  FAMILY_OR_SEGMENT_EXACT: 7_500,
  ALL_TOKENS_ID_OR_ALIAS: 6_000,
  ID_OR_ALIAS_TOKEN: 700,
  PURPOSE_TOKEN: 300,
  TAG_TOKEN: 250,
  COMPOSITE_BROAD_INTENT_BONUS: 150
});
```

Normalize with `value.normalize("NFKC").toLowerCase()`, tokenize Unicode letters/numbers and tool separators, drop empty tokens, cap normalized internal token count to a safe bound such as 64, and never use locale-dependent `localeCompare` for final ties.

Return:

```ts
export interface PublicActionSearchMatch {
  readonly action: PublicActionDescriptor;
  readonly score: number;
  readonly matchReasons: readonly string[];
}

export function searchPublicActions(
  query: string,
  options: { limit?: number } = {}
): readonly PublicActionSearchMatch[];
```

Filter zero-score actions; sort score descending then action ID by UTF-8 byte comparison. Freeze results/reason arrays.

- [ ] **Step 7: Verify ranking tests GREEN**

```bash
pnpm --filter @kodegpt/capabilities test -- public-action-search.test.ts
pnpm --filter @kodegpt/capabilities typecheck
```

Expected: PASS.

- [ ] **Step 8: Add the first quality benchmark fixture**

Create `tests/performance/discovery-quality.test.ts` with a table of at least 40 query/expected action cases. Include all of these critical intents plus enough additional families to cover the public surface:

```text
understand this repository -> workspace.inspect/context.build
find where this symbol is used -> code.search
what will this change affect -> code.impact
edit this file safely -> file.edit/file.patch
run the tests -> verify.run
run a local development command -> process.run
see whether the preview is ready -> preview.inspect
inspect browser console errors -> browser.console
check responsive UI screenshots -> visual.captureMatrix
compare visual evidence -> visual.compare
create a pull request -> github.pr.create
inspect pull request -> github.pr.inspect
why did CI fail -> ci.failure
rerun the failed CI workflow -> ci.rerun
continue the work from the previous chat -> workspace.info
show current workspace state -> workspace.info
create an isolated worktree -> git.worktreeCreate
remove the worktree -> git.worktreeRemove
show changed files -> git.changes/git.status
commit these changes -> git.commit
push this branch -> git.push
read a file -> file.read
list files -> file.tree
read an artifact -> artifact.read
check service health -> system.health
what tools are available -> system.capabilities
list skills -> skill.list
inspect a skill -> skill.inspect
load skill instructions -> skill.load
current profile -> profile.current
list trusted workspaces -> trust.list
open workspace -> workspace.open
close workspace -> workspace.close
create branch -> git.branchCreate
switch branch -> git.branchSwitch
show commit history -> git.log
compare commits -> git.diffHistory
list GitHub issues -> github.issue.list
inspect issue -> github.issue.inspect
list pull requests -> github.pr.list
```

Include Indonesian critical cases:

```text
cek CI -> ci.status
kenapa CI gagal -> ci.failure
cek tampilan mobile -> visual.captureMatrix
lanjutkan pekerjaan sebelumnya -> workspace.info
cari dampak perubahan ini -> code.impact
buat worktree terpisah -> git.worktreeCreate
jalankan test -> verify.run
cek error console browser -> browser.console
buat PR -> github.pr.create
cek status workspace -> workspace.info
```

Compute top-1 and top-3 metrics in the test. Mark the acceptance threshold now; the test may remain RED until aliases/weights are tuned:

```ts
expect(top3Recall).toBeGreaterThanOrEqual(0.95);
expect(top1Accuracy).toBeGreaterThanOrEqual(0.90);
expect(criticalTop3Recall).toBe(1);
```

- [ ] **Step 9: Run the benchmark, tune only catalog metadata/weights, and make it GREEN**

Run:

```bash
pnpm exec vitest run tests/performance/discovery-quality.test.ts
```

Expected final state: thresholds PASS without model/network/embedding dependencies. Fix misses by improving action aliases/tags first; change weights only when the same weighting error appears across multiple intents.

- [ ] **Step 10: Commit Task 2**

```bash
git add packages/capabilities/src packages/capabilities/src/index.ts tests/performance/discovery-quality.test.ts
git commit -m "feat: add deterministic public action discovery"
```

---

### Task 3: Shared Declared Requirements and Skill Requirement Graph

**Files:**
- Create: `packages/skills/src/declared-requirements.ts`
- Create: `packages/skills/src/declared-requirements.test.ts`
- Create: `packages/skills/src/requirement-graph.ts`
- Create: `packages/skills/src/requirement-graph.test.ts`
- Modify: `packages/skills/src/contracts.ts`
- Modify: `packages/skills/src/compatibility.ts`
- Modify: `packages/skills/src/compatibility.test.ts`
- Modify: `packages/skills/src/catalog.ts`
- Modify: `packages/skills/src/catalog.test.ts`
- Modify: `packages/skills/src/tool-adapter.ts`
- Modify: `packages/skills/src/tool-adapter.test.ts`
- Modify: `packages/skills/src/index.ts`

**Interfaces:**
- Consumes: Task 1 public action catalog and current `ParsedSkillDocument`.
- Produces: `readKodegptDeclaredRequirements(skill.metadata)` shared by compatibility + graph.
- Produces: `buildSkillRequirementGraph(skill, compatibility)`.
- Produces: additive `SkillInspectResult.requirementGraph`.

- [ ] **Step 1: Define failing declared-requirements tests**

Cover existing forms and new forms:

```ts
expect(readKodegptDeclaredRequirements({
  kodegpt: {
    requires: {
      capabilities: ["process.run"],
      providers: ["github"],
      actions: ["context.build", "verify.run"]
    },
    unsupported: ["subagent.session"],
    stages: [{
      id: "visual",
      description: "Gather responsive visual evidence.",
      actions: ["visual.captureMatrix", "visual.compare"]
    }]
  }
})).toMatchObject({ present: true, valid: true });
```

Add RED cases for duplicate stage IDs, >16 stages, >32 core actions, >32 stage actions, >16 stage capabilities, >8 stage providers, invalid stage ID, unknown shape/type, overlong description. Preserve existing legacy `kodegpt.providers` behavior.

- [ ] **Step 2: Verify declaration tests RED**

```bash
pnpm --filter @kodegpt/skills test -- declared-requirements.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Extract and extend declared-requirements parsing**

Move the private parsing logic currently inside `compatibility.ts` into `declared-requirements.ts`. Use a normalized result:

```ts
export interface KodegptDeclaredStage {
  readonly id: string;
  readonly description?: string;
  readonly actions: readonly string[];
  readonly capabilities: readonly string[];
  readonly providers: readonly string[];
}

export interface KodegptDeclaredRequirements {
  readonly present: boolean;
  readonly valid: boolean;
  readonly actions: readonly string[];
  readonly capabilities: readonly string[];
  readonly providers: readonly string[];
  readonly unsupported: readonly string[];
  readonly stages: readonly KodegptDeclaredStage[];
}
```

Use existing max requirement byte rules where applicable. Stage ID regex: `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, max 64 UTF-8 bytes. Keep deterministic de-duplication/order for string requirements and fail `valid:false` on ambiguous duplicate stage IDs rather than silently merging them.

Update `compatibility.ts` to consume this parser but only use fields it already understands for overall compatibility: capabilities/providers/unsupported. New `actions` and `stages` are handled by the requirement graph, not retrofitted into native capability classification.

- [ ] **Step 4: Run declaration + compatibility regression tests GREEN**

```bash
pnpm --filter @kodegpt/skills test -- declared-requirements.test.ts compatibility.test.ts
```

Expected: PASS with current external CLI/Codex/subagent/provider behavior unchanged.

- [ ] **Step 5: Add failing requirement-graph tests**

Define these exact semantic expectations:

```ts
it("keeps conditional stage support independent from core compatibility", () => {
  const graph = buildSkillRequirementGraph(skillWithMissingOptionalStageAction, compatibility);
  expect(graph.core.classification).toBe("NATIVE");
  expect(graph.stages.find(x => x.id === "visual")?.classification).toBe("PARTIAL");
});

it("infers exact public action references not declared in metadata into core", () => {
  const graph = buildSkillRequirementGraph(skillWhoseInstructionsMentionWorkspaceInfo, compatibility);
  expect(graph.core.inferredActions).toContain("workspace.info");
});

it("does not move declared stage actions into inferred core", () => {
  const graph = buildSkillRequirementGraph(skillWhoseVisualStageAndProseMentionVisualActions, compatibility);
  expect(graph.core.inferredActions).not.toContain("visual.captureMatrix");
  expect(graph.stages.find(x => x.id === "visual")?.actions.map(x => x.id))
    .toContain("visual.captureMatrix");
});

it("reports unknown declared actions as missing instead of crashing", () => {
  const graph = buildSkillRequirementGraph(skillWithUnknownAction, compatibility);
  expect(graph.core.missingActions).toContain("future.unknown");
  expect(graph.core.classification).toBe("PARTIAL");
});
```

Also test declared+static `analysisBasis`, stage provider classification, legacy metadata with no stages, truncation arrays, frozen results.

- [ ] **Step 6: Verify requirement graph tests RED**

```bash
pnpm --filter @kodegpt/skills test -- requirement-graph.test.ts
```

Expected: FAIL.

- [ ] **Step 7: Add requirement graph contracts**

In `contracts.ts`, add:

```ts
export type PublicActionRequirement =
  | {
      readonly id: PublicActionId;
      readonly known: true;
      readonly source: "declared" | "static" | "declared+static";
    }
  | {
      readonly id: string;
      readonly known: false;
      readonly source: "declared";
    };

export interface SkillRequirementStage {
  readonly id: string;
  readonly description?: string;
  readonly classification: SkillCompatibility;
  readonly actions: readonly PublicActionRequirement[];
  readonly missingActions: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly requiredProviders: readonly string[];
}

export interface SkillRequirementGraph {
  readonly schemaVersion: 1;
  readonly core: {
    readonly classification: SkillCompatibility;
    readonly actions: readonly PublicActionRequirement[];
    readonly inferredActions: readonly PublicActionId[];
    readonly missingActions: readonly string[];
  };
  readonly stages: readonly SkillRequirementStage[];
  readonly analysisBasis: SkillCompatibilityAnalysisBasis;
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
}
```

Update the existing contracts import to `import type { NativeCapabilityId, PublicActionId } from "@kodegpt/capabilities";`. Unknown identifiers exist only in declared metadata and remain `string`; statically inferred actions are always known `PublicActionId` values.

- [ ] **Step 8: Implement graph builder**

`buildSkillRequirementGraph` must:

1. parse shared declarations;
2. create a known-action set from `PUBLIC_ACTION_IDS`;
3. statically scan instructions for exact action IDs using boundary-safe matching analogous to current native capability reference detection;
4. reserve declared stage actions from core inference;
5. merge declared core actions and unassigned static action references;
6. mark unknown declared core actions missing and downgrade core `NATIVE -> PARTIAL` while preserving stronger existing states (`PROVIDER_REQUIRED`/`UNSUPPORTED`);
7. classify each stage independently: unknown action/capability -> `PARTIAL`; provider requirement -> `PROVIDER_REQUIRED` unless the stage is already `UNSUPPORTED`; explicit unsupported stage semantics are not added in P0 unless already expressible by existing metadata;
8. freeze nested output;
9. keep sorted deterministic fields and explicit bounded truncation evidence.

Do not inspect runtime/provider networks here. This is support classification, not remote readiness.

- [ ] **Step 9: Attach graph to catalog inspection and public skill inspect**

Add `requirementGraph` to `SkillCatalogInspection` and `SkillInspectResult`. In `catalog.ts`, build it alongside `capabilityPlan`. In `tool-adapter.ts`, deep-clone/publicize all nested graph arrays so callers cannot mutate internal state.

- [ ] **Step 10: Add catalog/adapter regression assertions**

In catalog and adapter tests, assert:

```ts
expect(inspected.requirementGraph.schemaVersion).toBe(1);
expect(inspected.requirementGraph.core.actions).toEqual(expect.any(Array));
expect(publicResult.requirementGraph).not.toBe(internalGraphObjectReference);
```

Retain exact source ID/fingerprint/nameCollision/pin behavior.

- [ ] **Step 11: Verify complete Skills package GREEN**

```bash
pnpm --filter @kodegpt/skills test
pnpm --filter @kodegpt/skills typecheck
```

Expected: PASS.

- [ ] **Step 12: Commit Task 3**

```bash
git add packages/skills/src
git commit -m "feat: add skill action requirement graph"
```

---

### Task 4: Migrate the Built-in Application Workflow to Core + Conditional Stage Metadata

**Files:**
- Modify: `skills/kodegpt-application-development-workflow/SKILL.md`
- Modify: `packages/skills/src/catalog.test.ts` or add a focused test under `tests/integration/skill-interoperability.test.ts` to exercise the real built-in skill.

**Interfaces:**
- Consumes: Task 3 metadata parser/requirement graph.
- Produces: truthful machine-readable stages used later by `system.discover.flows`.

- [ ] **Step 1: Add a failing real-skill requirement assertion**

Load the repository-local built-in skill through existing catalog/workspace-source test infrastructure and assert at minimum these stage IDs exist:

```ts
expect(stageIds).toEqual(expect.arrayContaining([
  "continuity",
  "repository-understanding",
  "implementation",
  "verification",
  "preview",
  "browser",
  "visual",
  "git-delivery",
  "pull-request",
  "ci"
]));
```

Assert representative actions:

```ts
expect(stage("continuity").actions).toContain("workspace.info");
expect(stage("preview").actions).toContain("preview.start");
expect(stage("browser").actions).toContain("browser.openPreview");
expect(stage("visual").actions).toContain("visual.captureMatrix");
expect(stage("pull-request").actions).toContain("github.pr.create");
expect(stage("ci").actions).toContain("ci.status");
```

- [ ] **Step 2: Verify RED against current three-line frontmatter**

Run the focused test. Expected: FAIL because current skill has no `metadata` stages.

- [ ] **Step 3: Add exact frontmatter requirements/stages**

Extend the existing frontmatter; do not rewrite the instruction body. Use core actions for operations universally needed by the workflow and conditional stages for situational work.

Required metadata structure:

```yaml
metadata:
  kodegpt:
    requires:
      actions:
        - context.build
        - workspace.inspect
        - code.search
        - code.impact
        - file.read
        - file.edit
        - file.patch
        - file.write
        - git.status
        - git.diff
        - git.changes
        - verify.list
        - verify.run
    stages:
      - id: continuity
        description: Resume and reconcile bounded prior development state when continuation is requested.
        actions: [workspace.info, workspace.checkpoint, git.status, git.log]
      - id: repository-understanding
        description: Build target-scoped repository context and impact evidence.
        actions: [context.build, workspace.inspect, code.search, code.impact]
      - id: implementation
        description: Read and modify bounded workspace files.
        actions: [file.read, file.edit, file.patch, file.write]
      - id: verification
        description: Discover and run deterministic checks or approved local development commands.
        actions: [verify.list, verify.run, process.run, process.status, process.cancel]
      - id: preview
        description: Start, inspect, and stop a bounded local application preview when relevant.
        actions: [preview.start, preview.inspect, preview.stop]
      - id: browser
        description: Gather preview-scoped browser interaction and diagnostic evidence when relevant.
        actions: [browser.openPreview, browser.inspect, browser.console, browser.networkFailures, browser.click, browser.type, browser.screenshot]
      - id: visual
        description: Gather responsive visual evidence and compare explicit captures when relevant.
        actions: [visual.captureMatrix, visual.compare]
      - id: git-delivery
        description: Isolate, review, commit, and publish repository changes when delivery requires it.
        actions: [git.branchCreate, git.branchSwitch, git.worktreeCreate, git.worktreeRemove, git.stage, git.commit, git.push]
      - id: pull-request
        description: Create and inspect a pull request when remote review is required.
        actions: [github.pr.create, github.pr.inspect]
      - id: ci
        description: Inspect and reconcile remote CI after delivery.
        actions: [ci.status, ci.runs, ci.run, ci.failure, ci.cancel, ci.rerun]
```

Keep metadata compact; prose remains authority for decisions such as when checkpoints are written or stages are optional.

- [ ] **Step 4: Verify real skill graph GREEN and no parser regressions**

```bash
pnpm --filter @kodegpt/skills test
pnpm exec vitest run tests/integration/skill-interoperability.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add skills/kodegpt-application-development-workflow/SKILL.md packages/skills/src/catalog.test.ts tests/integration/skill-interoperability.test.ts
git commit -m "feat: declare application workflow capability stages"
```

Only stage files that actually changed.

---

### Task 5: Intent-Aware `skill.list(query)` Ranking

**Files:**
- Create: `packages/skills/src/skill-search.ts`
- Create: `packages/skills/src/skill-search.test.ts`
- Modify: `packages/skills/src/contracts.ts`
- Modify: `packages/skills/src/tool-adapter.ts`
- Modify: `packages/skills/src/tool-adapter.test.ts`
- Modify: `packages/skills/src/index.ts`
- Modify: `packages/mcp-server/src/tool-context.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/skills.test.ts`

**Interfaces:**
- Produces: optional `query?: string` on skill list adapter and MCP schema.
- Produces: deterministic `rankSkillsForQuery(skills, query, workspaceId?)` internal/exported helper for Task 6.
- Preserves: no-query list/filter/order behavior exactly.

- [ ] **Step 1: Add failing unit ranking tests**

Create `skill-search.test.ts` with fixture entries and these expectations:

```ts
expect(rankSkillsForQuery(skills, "application development")[0]?.name)
  .toBe("kodegpt-application-development-workflow");
expect(rankSkillsForQuery(skills, "kodegpt-application-development-workflow")[0]?.matchReasons)
  .toContain("NAME_EXACT");
```

Test signal order: exact name > all name tokens > partial name > description > compatibility bonus. Test stable UTF-8 tie break. Test workspace-local relevance bonus only when `workspaceId` is provided and candidate source represents that workspace. Test `NATIVE > PARTIAL > PROVIDER_REQUIRED > UNSUPPORTED` only as a relevance bonus, not enough to outrank a substantially stronger text match.

- [ ] **Step 2: Verify unit tests RED**

```bash
pnpm --filter @kodegpt/skills test -- skill-search.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement skill search scoring**

Use the same normalization utility/algorithmic semantics as action search; share a tiny normalization helper only if it does not create a package dependency cycle. Because `@kodegpt/skills` already depends on `@kodegpt/capabilities`, it may reuse an exported generic discovery tokenization helper from Task 2 if that API is clean; otherwise keep a deterministic local helper and add equality tests for normalization edge cases.

Return internal matches:

```ts
export interface SkillSearchMatch {
  readonly skill: SkillCatalogEntry;
  readonly score: number;
  readonly matchReasons: readonly string[];
}
```

Use integer scores and stable UTF-8 tie breaks. Filter zero-text-match results; compatibility is a bonus, never a reason by itself to return an unrelated skill.

- [ ] **Step 4: Verify unit search GREEN**

```bash
pnpm --filter @kodegpt/skills test -- skill-search.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add failing tool-adapter no-query/query regression tests**

Add two adapter tests:

```ts
it("preserves current list ordering when query is absent", async () => {
  expect(await adapter.list({ limit: 20 })).toEqual(existingExpectedList);
});

it("filters and relevance-ranks skills when query is present", async () => {
  const result = await adapter.list({ query: "application development", limit: 20 });
  expect(result.skills[0]?.name).toBe("kodegpt-application-development-workflow");
});
```

Also compose query with `sourceId`, `compatibility`, `pinned`, and `workspaceId` filters.

- [ ] **Step 6: Wire query through contracts/adapter**

Add `query?: string` to `SkillCatalogToolAdapter.list`. Validate in adapter as a non-empty normalized query with <=512 UTF-8 bytes; MCP Zod validation also enforces `.min(1).max(512)` by characters but adapter byte validation remains authoritative for UTF-8 byte bound.

Apply existing filters first, then query ranking, then result limit/truncation. Preserve `RESULT_LIMIT` semantics.

Do not put match metadata into `SkillCatalogEntry`; keep raw list schema clean. Task 6 can call `rankSkillsForQuery` directly when it needs reasons.

- [ ] **Step 7: Wire query through MCP input schema**

Update `SkillToolContext.list` and `skill.list` schema/handler:

```ts
query: z.string().min(1).max(512).optional()
```

Update description to say query triggers deterministic local relevance ranking. No public tool count change yet.

- [ ] **Step 8: Verify Skills + MCP focused tests GREEN**

```bash
pnpm --filter @kodegpt/skills test
pnpm --filter @kodegpt/mcp-server test -- skills.test.ts
pnpm --filter @kodegpt/skills typecheck
pnpm --filter @kodegpt/mcp-server typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit Task 5**

```bash
git add packages/skills/src packages/mcp-server/src/tool-context.ts packages/mcp-server/src/tools.ts packages/mcp-server/src/skills.test.ts
git commit -m "feat: add intent-aware skill discovery"
```

---

### Task 6: Compose Bounded `system.discover`

**Files:**
- Create: `packages/mcp-server/src/discovery.ts`
- Create: `packages/mcp-server/src/discovery.test.ts`

**Interfaces:**
- Consumes: `searchPublicActions`, `rankSkillsForQuery`, skill adapter `list/inspect`, workspace `info` through injected read-only dependencies.
- Produces: `SystemDiscoverInput`, `SystemDiscoverResult`, `discoverKodegpt(input, deps)`.
- Remains internal in this task; public registration/surface publication is atomic in Task 7.

- [ ] **Step 1: Add failing pure composition tests**

Create `discovery.test.ts` with fake dependencies and prove:

1. query returns relevant actions + skills;
2. action match reasons survive bounded cloning;
3. identical skill `name + fingerprint` from two sources becomes one discovery result with alternate provenance;
4. same-name/different-fingerprint skills remain separate;
5. workspace-local copy wins duplicate representative when the supplied workspace matches;
6. pinned/live+pinned wins when no matching workspace-local candidate exists;
7. only top 5 skill candidates are inspected;
8. at most 5 stage-derived flows returned;
9. stage flow comes only from explicit `requirementGraph.stages`, never generated action sequencing;
10. no skill stage detail causes an implicit action execution.

Representative test dependency shape:

```ts
const deps = {
  searchActions: vi.fn(() => actionMatches),
  rankSkills: vi.fn(() => skillMatches),
  listSkills: vi.fn(async () => skillList),
  inspectSkill: vi.fn(async (input) => inspections[input.skillId]),
  workspaceInfo: vi.fn(async ({ workspaceId }) => readyWorkspace)
};
```

- [ ] **Step 2: Verify composition tests RED**

```bash
pnpm --filter @kodegpt/mcp-server test -- discovery.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement discovery contracts and composition**

Use exact bounds/constants:

```ts
export const SYSTEM_DISCOVER_DEFAULT_LIMIT = 8;
export const SYSTEM_DISCOVER_MAX_LIMIT = 20;
export const SYSTEM_DISCOVER_MAX_QUERY_BYTES = 512;
export const SYSTEM_DISCOVER_MAX_SKILL_INSPECTIONS = 5;
export const SYSTEM_DISCOVER_MAX_FLOWS = 5;
export const SYSTEM_DISCOVER_MAX_MATCH_REASONS = 8;
export const SYSTEM_DISCOVER_MAX_ALTERNATE_SOURCES = 5;
```

Result fields must be:

```ts
interface SystemDiscoverResult {
  readonly schemaVersion: 1;
  readonly query: string;
  readonly actions: readonly SystemDiscoverActionMatch[];
  readonly skills: readonly SystemDiscoverSkillMatch[];
  readonly flows: readonly SystemDiscoverFlow[];
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
}
```

Use `AVAILABLE | CONTEXT_REQUIRED | UNAVAILABLE` only for local action/context readiness. Never probe GitHub/CI/provider networks. Required action inputs are always returned so a host sees missing `repository`, `previewId`, etc.

- [ ] **Step 4: Implement local availability semantics**

Rules:

```text
global/repository scoped action:
  -> AVAILABLE (registered locally; still needs requiredInputs)
workspace/preview scoped action + no workspaceId:
  -> CONTEXT_REQUIRED, reason WORKSPACE_REQUIRED
workspace/preview scoped action + valid READY workspace:
  -> AVAILABLE
workspace/preview scoped action + workspaceInfo failure/not-ready:
  -> UNAVAILABLE, bounded reason WORKSPACE_UNAVAILABLE
```

Call `workspaceInfo` at most once per discovery request, cache the result, and do not leak raw host paths/errors in reason strings.

- [ ] **Step 5: Add explicit side-effect tests**

Build discovery dependencies where every operation outside the allowed read-only dependency set (`searchActions`, `rankSkills`, `listSkills`, `inspectSkill`, `workspaceInfo`) is represented by a `vi.fn(() => { throw new Error("MUST NOT CALL"); })`. Invoke the pure composer and assert it only consumes the declared read-only dependencies. Task 7 adds a public-tool integration guard against the full `KodegptToolContext` mutation/remote families.

- [ ] **Step 6: Verify pure discovery GREEN**

```bash
pnpm --filter @kodegpt/mcp-server test -- discovery.test.ts
```

Expected: PASS.

- [ ] **Step 7: Verify the internal composer does not alter the public surface**

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/skills test
pnpm --filter @kodegpt/mcp-server test -- discovery.test.ts server.test.ts
pnpm --filter @kodegpt/mcp-server typecheck
```

Expected: PASS with `MCP_SURFACE_VERSION === "0.17"`, exactly 75 public actions, and no public `system.discover` yet.

- [ ] **Step 8: Commit Task 6**

```bash
git add packages/mcp-server/src/discovery.ts packages/mcp-server/src/discovery.test.ts
git commit -m "feat: add bounded discovery composer"
```

---

### Task 7: Surface 0.18, Capability Self-Description, and Locked Transport Fixtures

**Files:**
- Modify: `packages/capabilities/src/public-actions.ts`
- Modify: `packages/capabilities/src/public-actions.test.ts`
- Modify: `packages/mcp-server/src/tool-context.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/structured-results.test.ts`
- Modify: `packages/mcp-server/src/surface-version.ts`
- Modify: `packages/mcp-server/src/server.test.ts`
- Modify: `tests/fixtures/mcp-surface.ts`
- Modify: `apps/cli/src/commands/start.ts`
- Modify: `apps/cli/src/commands/start.test.ts`
- Modify: `tests/integration/provider-gateway.test.ts`
- Modify: `tests/security/security-invariants.test.ts`
- Modify as required by locked fixture: `tests/integration/cli-bridge.test.ts`, `mcp-http.test.ts`, `mcp-stdio.test.ts`, `mcp-conformance.test.ts`, `full-stack.test.ts`.

**Interfaces:**
- Produces final `MCP_SURFACE_VERSION = "0.18"` and exact 76-tool public fixture.
- Publishes the already-tested Task 6 composer as the single new read-only tool `system.discover`.
- Produces compact `system.capabilities.discovery` summary.

- [ ] **Step 1: Add failing public publication tests**

Add tests that expect `system.discover` in the public catalog/handler surface, a `SystemToolContext.discover` implementation, read-only annotations, structured result output, and zero mutation/remote dispatch. Keep the source catalog and surface version unchanged for this RED step.

Use a full fake `KodegptToolContext` where process/file mutation/Git mutation/preview/browser interaction/GitHub/CI/checkpoint mutation handlers throw `MUST NOT CALL`; invoke only the registered `system.discover` handler and assert those functions remain untouched.

- [ ] **Step 2: Verify publication tests RED**

```bash
pnpm --filter @kodegpt/mcp-server test -- server.test.ts structured-results.test.ts
pnpm --filter @kodegpt/capabilities test -- public-actions.test.ts
```

Expected: FAIL because `system.discover` is still internal and the catalog remains 75 actions.

- [ ] **Step 3: Add `system.discover` to the authoritative action catalog**

Append the 76th descriptor atomically with public publication:

```ts
{
  id: "system.discover",
  family: "system",
  purpose: "Find relevant KodeGPT actions, skills, and declared skill stages for a development intent without executing them.",
  aliases: [
    "discover capabilities",
    "find tools",
    "find what kodegpt can do",
    "route development intent",
    "search capabilities"
  ],
  tags: ["discovery", "capabilities", "routing", "skills", "tools"],
  role: "introspection",
  scope: "global",
  requiredInputs: ["query"]
}
```

Update catalog tests from 75 to 76 and require `system.discover` present.

- [ ] **Step 4: Register the read-only MCP tool and context method**

Extend `SystemToolContext`:

```ts
interface SystemToolContext {
  capabilities(): MaybePromise<JsonObject>;
  health(): MaybePromise<JsonObject>;
  discover(input: SystemDiscoverInput): Promise<SystemDiscoverResult>;
}
```

Inside `createKodegptToolContext`, compose `discover` from the Task 6 helper, already-created skill adapter, action search, and workspace info. Do not create another service container.

Register:

```ts
server.registerTool(
  "system.discover",
  {
    description: "Deterministically find relevant KodeGPT actions, Agent Skills, and declared workflow stages for an intent without executing them.",
    inputSchema: {
      query: z.string().min(1).max(512),
      workspaceId: z.string().min(1).optional(),
      limit: z.number().int().positive().max(20).safe().optional()
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS
  },
  async (input) => structuredToolResult(await context.system.discover(input))
);
```

Keep the Task 6 UTF-8 byte-length validation authoritative because Zod `.max(512)` counts characters, not bytes.

- [ ] **Step 5: Add structured-result assertions**

In `structured-results.test.ts`, assert successful discovery returns `structuredContent` plus JSON text fallback, including `schemaVersion`, actions, skills, flows, scores/reasons, availability, and required inputs. Test invalid/over-byte-limit query rejects without invoking discovery dependencies.

- [ ] **Step 6: Add/update failing exact surface assertions**

Before changing version source, update expected assertions to:

```ts
expect(MCP_SURFACE_VERSION).toBe("0.18");
expect(listSurfaceTools()).toHaveLength(76);
expect(listSurfaceTools()).toContainEqual({ name: "system.discover", required: ["query"] });
```

Update `EXPECTED_MCP_SURFACE_TOOLS` with only this additional entry in deterministic catalog order:

```ts
{ name: "system.discover", required: ["query"] }
```

Run focused server/integration tests; expected RED on version until Step 7.

- [ ] **Step 7: Bump semantic surface exactly once**

Set:

```ts
export const MCP_SURFACE_VERSION = "0.18" as const;
```

Do not change runtime version or protocol identifier.

- [ ] **Step 8: Add discovery summary to `system.capabilities`**

Add:

```ts
discovery: {
  systemDiscover: true,
  publicActionCatalogVersion: 1,
  skillRequirementGraphVersion: 1,
  deterministicRanking: true
}
```

Keep current `execution` summary. Keep `publicTools` compact family/name inventory; do not dump full purposes/aliases/tags into every `system.capabilities` call.

- [ ] **Step 9: Add CLI/start capability tests**

Assert:

```ts
expect(capabilities.mcpSurfaceVersion).toBe("0.18");
expect(capabilities.publicTools.count).toBe(76);
expect(capabilities.publicTools.families.system).toContain("system.discover");
expect(capabilities.discovery).toEqual({
  systemDiscover: true,
  publicActionCatalogVersion: 1,
  skillRequirementGraphVersion: 1,
  deterministicRanking: true
});
```

- [ ] **Step 10: Update only current-version assertions in provider/security tests**

Change current expected surface `0.17 -> 0.18`; do not change Provider Gateway manifests, credential policy, Rust authority, or public provider tool expectations.

- [ ] **Step 11: Verify locked public transports GREEN**

Run:

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/mcp-server test
pnpm exec vitest run tests/integration/mcp-conformance.test.ts tests/integration/mcp-http.test.ts tests/integration/mcp-stdio.test.ts tests/integration/cli-bridge.test.ts tests/integration/full-stack.test.ts
pnpm exec vitest run apps/cli/src/commands/start.test.ts
pnpm exec vitest run tests/integration/provider-gateway.test.ts tests/security/security-invariants.test.ts
```

Expected: PASS with exactly 76 public tools and surface `0.18`.

- [ ] **Step 12: Commit Task 7**

```bash
git add packages/capabilities/src/public-actions.ts packages/capabilities/src/public-actions.test.ts packages/mcp-server/src/tool-context.ts packages/mcp-server/src/tools.ts packages/mcp-server/src/structured-results.test.ts packages/mcp-server/src/surface-version.ts packages/mcp-server/src/server.test.ts tests/fixtures/mcp-surface.ts apps/cli/src/commands/start.ts apps/cli/src/commands/start.test.ts tests/integration tests/security/security-invariants.test.ts
git commit -m "feat: publish capability discovery surface 0.18"
```

Review staged paths before commit so unrelated integration files are not accidentally included.

---

### Task 8: End-to-End Discovery Quality, Side-Effect, and Dogfood Coverage

**Files:**
- Modify: `tests/performance/discovery-quality.test.ts`
- Modify: `tests/integration/mcp-stdio.test.ts` — real stdio `system.discover` transport/dogfood requests.
- Modify: `tests/integration/full-stack.test.ts` — full-stack READY-workspace discovery and side-effect assertions.
- Modify: `packages/mcp-server/src/discovery.test.ts`
- Modify: `packages/skills/src/skill-search.test.ts`

**Interfaces:**
- Validates all P0 acceptance metrics before documentation/release evidence.

- [ ] **Step 1: Extend quality benchmark beyond action-only search**

Add assertions that the workflow skill is a top skill result for intents such as:

```text
develop this application end to end
fix the app and verify it before PR
lanjutkan development lalu cek CI
check the UI and create a PR
```

Use the pure skill ranking helper for deterministic package-level scoring. Do not fabricate temporary user-home skill sources.

- [ ] **Step 2: Add real MCP request test for `system.discover`**

Use existing MCP stdio/http test harness to call:

```json
{
  "query": "cek tampilan mobile",
  "workspaceId": "<READY fixture workspace>"
}
```

Assert `visual.captureMatrix` appears in top 3 actions, application workflow appears in skills when the fixture workspace exposes it, and response has no mutation side effects.

Add another call:

```json
{ "query": "lanjutkan pekerjaan sebelumnya" }
```

without `workspaceId` and assert `workspace.info` is relevant but marked `CONTEXT_REQUIRED`.

- [ ] **Step 3: Verify 512 UTF-8 byte bound, not merely character bound**

Test a multibyte string whose character count is <=512 but byte count >512; expect bounded input failure. Test exactly 512 ASCII bytes succeeds.

- [ ] **Step 4: Verify truncation paths**

Force fake skill catalog source truncation and >5 matching stage flows. Assert discovery returns `truncated:true`, includes explicit reasons, inspects <=5 candidates, returns <=5 flows, and returns <=limit actions/skills.

- [ ] **Step 5: Run quality and focused integration gates**

```bash
pnpm exec vitest run tests/performance/discovery-quality.test.ts
pnpm --filter @kodegpt/skills test -- skill-search.test.ts
pnpm --filter @kodegpt/mcp-server test -- discovery.test.ts
pnpm exec vitest run tests/integration/mcp-stdio.test.ts tests/integration/full-stack.test.ts
```

Expected: >=95% top-3, >=90% top-1, critical top-3 = 100%, all functional tests PASS.

- [ ] **Step 6: Commit Task 8**

```bash
git add tests/performance/discovery-quality.test.ts packages/skills/src/skill-search.test.ts packages/mcp-server/src/discovery.test.ts tests/integration/mcp-stdio.test.ts tests/integration/full-stack.test.ts
git commit -m "test: verify capability discovery quality"
```

Only include changed files.

---

### Task 9: Full Repository Verification, Documentation Reconciliation, Review, PR, and CI Closure

**Files:**
- Create after gates PASS: `docs/release/2026-08-21-capability-intelligence-discovery-readiness.md`
- Modify after gates PASS: `docs/architecture/README.md`
- Modify after gates PASS: `docs/implementation/v0.1-execution-tracker.md`
- Modify: `docs/compatibility/chatgpt.md` — replace only its current-state `0.17 / 75` capability statement with the verified `0.18 / 76` discovery surface; preserve its historical `0.16` narrative.

**Interfaces:**
- Produces merge-ready evidence and repository authority updates.

- [ ] **Step 1: Run package-focused gates from a clean dependency state**

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/skills test
pnpm --filter @kodegpt/mcp-server test
pnpm --filter @kodegpt/core test
```

Expected: all PASS; Core retains only its existing intentional Playwright spike skip unless implementation legitimately changes that test inventory.

- [ ] **Step 2: Run full TypeScript and Rust deterministic gates**

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm test:rust
pnpm test:protocol
pnpm test:integration
pnpm test:security
pnpm test:isolation
pnpm verify:forbidden
pnpm verify:package
```

Expected: all commands exit 0. Do not claim completion from focused package tests alone.

- [ ] **Step 3: Verify exact public contract mechanically**

Run a focused test/command that proves:

```text
runtimeVersion = 0.1
MCP protocol = 2026-07-28
MCP surface = 0.18
public action count = 76
system.discover required input = query
no provider.* / workflow.run / skill.run / agent.* public tools
```

Use `packages/mcp-server/src/server.test.ts` plus integration/full-stack evidence rather than a prose-only check.

- [ ] **Step 4: Review the complete implementation diff**

Use `show_changes`/review tooling and inspect especially:

- catalog vs handler registration completeness;
- no duplicate authored semantic registry remains;
- query/ranking determinism;
- no network/process/mutation calls from discovery;
- skill stage/core classification correctness;
- duplicate grouping only in `system.discover`, not raw catalog identity;
- exact surface bump and fixture consistency;
- no unrelated historical plan edits.

If review finds defects, fix them using systematic debugging/TDD and rerun affected + full gates before proceeding.

- [ ] **Step 5: Write release readiness evidence only from fresh outputs**

Create `docs/release/2026-08-21-capability-intelligence-discovery-readiness.md` recording:

```text
baseline / feature head
runtime 0.1
protocol 2026-07-28
surface 0.18
76 public tools
quality benchmark top-1/top-3/critical metrics
package test counts
full pnpm/Rust/security/isolation/package gates
live/local dogfood examples for system.discover and skill.list(query)
non-goals verified absent
```

Do not invent PR/CI numbers before they exist.

- [ ] **Step 6: Reconcile current architecture, ChatGPT compatibility, and execution tracker**

Update `docs/architecture/README.md` current capability map to describe:

- public Action Catalog + deterministic discovery;
- `system.discover` read-only intent routing;
- Skill Requirement Graph core/stage semantics;
- current `0.18 / 76` surface;
- existing non-goals unchanged.

Update only the current-state paragraph in `docs/compatibility/chatgpt.md` from the completed `0.17 / 75` baseline to `0.18 / 76`, naming `system.discover`, deterministic skill query ranking, and additive `skill.inspect.requirementGraph`; preserve its historical Development Efficiency `0.16` statement.

Append implementation evidence to `docs/implementation/v0.1-execution-tracker.md`; preserve historical entries as history.

- [ ] **Step 7: Verify docs-only reconciliation has no stale current assertions**

Search current authoritative docs/tests for stale live `0.17`/75 statements. Distinguish historical baselines (leave them) from current-state claims (update them). Run `git diff --check`.

- [ ] **Step 8: Commit verification/docs checkpoint**

```bash
git add docs/release/2026-08-21-capability-intelligence-discovery-readiness.md docs/architecture/README.md docs/compatibility/chatgpt.md docs/implementation/v0.1-execution-tracker.md
git commit -m "docs: record capability discovery readiness"
```

- [ ] **Step 9: Run verification-before-completion again after the docs commit**

At minimum rerun:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm test:rust
pnpm verify:forbidden
pnpm verify:package
git status --short
```

Expected: all PASS and working tree clean.

- [ ] **Step 10: Request code review before PR/merge**

Use the `requesting-code-review` skill/workflow. Review against the approved spec and this plan, not just local style. Resolve actionable findings before remote delivery.

- [ ] **Step 11: Create/push PR only after review + fresh gates**

Use the existing typed Git/GitHub path. PR title should be equivalent to:

```text
feat: add capability intelligence discovery
```

Push exact reviewed feature head. Record PR number/head OID once real.

- [ ] **Step 12: Verify exact-head CI and reconcile failures without blind retries**

Use existing `ci.status`, `ci.runs`, `ci.run`, and `ci.failure`. If CI fails, diagnose from bounded evidence, fix via TDD, rerun local gates, push new exact head, and wait for the new exact-head CI. Do not treat `ci.cancel` acceptance as terminal completion; preserve existing CI state reconciliation semantics.

- [ ] **Step 13: Merge only the reviewed passing head and verify merged-main CI**

Use guarded `github.pr.merge` with exact expected head OID. After merge, verify canonical `main == origin/main`, merged-main CI PASS, and live/candidate service surface before declaring P0 closed.

- [ ] **Step 14: Final closure state**

Only after merged-main CI and live dogfood PASS:

```text
P0 Capability Intelligence = COMPLETE
runtime 0.1
protocol 2026-07-28
surface 0.18
76 tools
system.discover verified
skill.list(query) verified
skill.inspect.requirementGraph verified
quality gates verified
next phase may be Continuity v2 (separate approved design cycle)
```

Do not automatically start P1A in the same implementation branch.

---

## Plan Self-Review Checklist

- [x] Spec Sections 1-8: catalog, separation of public/native concepts, deterministic action discovery -> Tasks 1-2.
- [x] Spec Section 9: core/stage Skill Requirement Graph and static reconciliation -> Task 3.
- [x] Spec Section 10: `skill.list(query)` without `skill.search` -> Task 5.
- [x] Spec Section 11: raw provenance preserved; exact duplicates grouped only in high-level discovery -> Task 6.
- [x] Spec Section 12: bounded read-only `system.discover`, availability, flows, no effects -> Task 6 + Task 8.
- [x] Spec Section 13: compact `system.capabilities.discovery` -> Task 7.
- [x] Spec Section 14: built-in application workflow stage migration -> Task 4.
- [x] Spec Section 15: English + Indonesian quality benchmark with explicit thresholds -> Tasks 2 and 8.
- [x] Spec Section 16: bounds and truncation -> Tasks 3, 5, 6, 8.
- [x] Spec Section 17: bounded errors/invalid third-party skill behavior -> Tasks 3 and 6.
- [x] Spec Section 18: unit/integration/quality/regression strategy -> all tasks, final in Task 9.
- [x] Spec Section 19: `0.18 / 76` release contract -> Task 7 + Task 9.
- [x] Spec Sections 20-22: decomposition and non-goals -> plan decomposition preserves P1/P2 separation.
- [x] Spec Section 23 acceptance summary -> Task 9 closure gate.
- [x] No implementation placeholders such as TBD/TODO/"handle later" remain.
- [x] Cross-task interfaces are named before consumers use them.
- [x] TDD red/green cycle is explicit for each behavioral task.
