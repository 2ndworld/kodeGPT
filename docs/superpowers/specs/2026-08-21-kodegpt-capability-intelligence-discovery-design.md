# KodeGPT Capability Intelligence + Unified Discovery Design

Date: 2026-08-21
Status: user-approved direction; written-spec review gate
Baseline: `main == origin/main == b3d502c598ec6595bec4e5427dc9f3305ff264a4`
Branch: `feat/capability-intelligence-discovery`
Worktree: `.worktrees/capability-intelligence-discovery`
Target: runtime `0.1` / MCP protocol `2026-07-28` / semantic surface `0.18` / exactly `76` public tools

## 1. Problem

KodeGPT's current development authority is already broad and mature: the public MCP surface contains 75 typed tools spanning workspace/context/code, file/process/verification, Git/GitHub/CI, preview/browser/visual evidence, skills, profiles, artifacts, trust, health, and workspace continuity.

The remaining weakness is not primarily missing execution authority. It is **capability intelligence**: the host can list tool names, but it cannot reliably ask KodeGPT which existing actions, skills, stages, and supporting capabilities best satisfy a development intent.

The audit found a structural cause rather than a single metadata bug:

1. `listSurfaceTools()` exposes the complete public MCP action set, currently 75 tools.
2. `NATIVE_CAPABILITY_IDS` contains a smaller semantic/native subset, currently 36 entries.
3. `SkillCapabilityPlan` understands `NATIVE_CAPABILITY_IDS`, external CLI requirements, providers, and blocked semantics, but does not model the complete public MCP action set.
4. `system.capabilities.publicTools` exposes names grouped by family, but not the richer purpose/alias/routing metadata needed for intent-based discovery.
5. `skill.list` can filter by source, compatibility, pin state, and workspace, but does not accept an intent/query and does not rank relevant skills.
6. A skill can legitimately use public actions such as `workspace.info`, `preview.*`, `browser.*`, `visual.*`, and `github.*` in its instructions while those actions remain absent from its native capability plan.
7. Therefore a host can incorrectly conclude that KodeGPT lacks a feature which is already present, or discover the correct capability only after manually scanning a large tool/skill inventory.

The built-in `kodegpt-application-development-workflow` demonstrates the issue directly: its instructions cover continuity, preview, browser evidence, visual verification, PR creation/inspection, and CI, while its current capability plan is centered on the smaller native-capability model.

The correct fix is not to append several missing names to that one skill. The public action surface and native capability subset are different concepts and should remain different concepts, with an explicit relationship between them.

## 2. Design principle

KodeGPT should answer two separate questions accurately:

```text
What can KodeGPT do?
        -> Public Action Catalog

What semantic/native capability supports or constrains this work?
        -> Native Capability Catalog

What does this skill/workflow need, including conditional stages?
        -> Skill Requirement Graph

What should I use for this intent right now?
        -> Deterministic Discovery
```

The design therefore introduces one coherent capability-intelligence layer instead of treating tool listing, native capability metadata, skill compatibility, and skill search as unrelated features.

This is deliberately more ambitious than a minimal `skill.list(query)` patch, but it does not introduce a model runtime, workflow engine, dynamic authority, embeddings service, or plugin runtime.

## 3. Goals

1. Make every public MCP action discoverable by intent, not only by exact tool name.
2. Keep the public action set distinct from the smaller `NATIVE_CAPABILITY_IDS` subset.
3. Establish one authoritative discovery metadata catalog for the complete public action surface.
4. Make native capability semantic metadata derive from or reconcile against the public action catalog instead of maintaining a divergent semantic registry.
5. Add deterministic intent-aware discovery over actions and skills.
6. Add optional intent-aware ranking to `skill.list` without creating a separate `skill.search` public tool.
7. Model skill requirements as core requirements plus conditional workflow stages.
8. Ensure optional stages do not incorrectly downgrade a skill's core compatibility.
9. Expose enough match reasoning for a host to understand why an action or skill ranked highly.
10. Preserve duplicate skill provenance while preventing identical copies from dominating high-level discovery results.
11. Return bounded, local, deterministic discovery evidence with no network calls and no execution side effects.
12. Add a quality benchmark so discoverability is measured rather than judged by anecdote.
13. Prefer higher-level/composite actions for broad intents when they are a better fit than low-level primitives.
14. Allow the public MCP tool count to increase when the new tool provides real host leverage; do not preserve 75 tools as an artificial constraint.

## 4. Non-goals

This phase does **not** add:

- `workflow.run` or a workflow DSL/state machine;
- `skill.run` or automatic skill execution;
- an autonomous model/agent/subagent runtime;
- a scheduler, queue, supervisor, or agent session database;
- conversation transcript persistence;
- Continuity v2 milestone history (separate P1 design);
- managed skill install/update/remove lifecycle (separate P1 design);
- executable JavaScript/Python plugin loading;
- the proposed out-of-process MCP Plugin Gateway (separate P2 design);
- generic `provider.invoke`, generic HTTP, or dynamic provider authority;
- embeddings, a vector database, an indexing daemon, or an LSP subsystem merely for discovery;
- arbitrary browser/computer-use authority;
- automatic invocation of discovered actions;
- automatic activation of new external skill sources;
- automatic mutation of workspace checkpoints.

Discovery is advisory/read-only. The caller still invokes normal typed KodeGPT actions under their existing policies and schemas.

## 5. Alternatives considered

### 5.1 Patch the built-in workflow metadata only — rejected

Adding preview/browser/visual/GitHub names to the current workflow would improve one skill but preserve the architectural mismatch between the 75-action public surface and the 36-entry native capability subset.

It would also recur for every future skill using public actions outside `NATIVE_CAPABILITY_IDS`.

### 5.2 Add only `skill.list(query)` — insufficient by itself

Intent-aware skill ranking is useful and remains part of this design, but it does not solve host discovery of KodeGPT actions when no relevant skill is present or when a direct typed action is the best route.

### 5.3 Expand `NATIVE_CAPABILITY_IDS` to equal the public MCP tool list — rejected

The two concepts are not equivalent. Public MCP actions include lifecycle, integration, browser, visual, artifact, profile, trust, and system actions which should not be forced into the existing native semantic capability taxonomy simply to obtain search metadata.

### 5.4 `system.discover` backed by embeddings/vector search — rejected for this phase

The search corpus is small and bounded: roughly dozens of actions and at most hundreds of visible skills. A deterministic lexical/alias/tag scorer is cheaper, explainable, reproducible, and straightforward to benchmark. Embeddings can be reconsidered only if measured recall on realistic intents remains inadequate after this design.

### 5.5 Selected approach — unified catalog + deterministic discovery

Create an explicit public action catalog, reconcile native capability metadata against it, add a skill requirement graph with conditional stages, and expose one new read-only `system.discover` tool which searches both actions and skills.

## 6. Architecture

```text
                           +-------------------------+
                           | Public Action Catalog   |
                           | all MCP actions         |
                           | purpose/aliases/tags    |
                           +------------+------------+
                                        |
                         +--------------+---------------+
                         |                              |
                         v                              v
             +-----------------------+       +------------------------+
             | Native Capability     |       | Action Discovery       |
             | subset + semantics    |       | deterministic ranking  |
             +-----------+-----------+       +-----------+------------+
                         |                               |
                         v                               |
             +-----------------------+                  |
             | Skill Requirement     |<-----------------+
             | Graph                 |
             | core + stages         |
             +-----------+-----------+
                         |
                         v
             +-----------------------+
             | system.discover       |
             | actions + skills +    |
             | stage/flow evidence   |
             +-----------------------+
```

### 6.1 Ownership boundaries

- `@kodegpt/capabilities` owns the public action discovery metadata and pure action-ranking utilities because this metadata describes KodeGPT capability semantics and is already consumed by both MCP and skill logic.
- `@kodegpt/skills` owns skill requirement parsing, stage analysis, compatibility, duplicate-aware skill ranking, and skill search metadata.
- `@kodegpt/mcp-server` owns the public `system.discover` composition and schemas, combining action discovery with the existing skill adapter and workspace context.
- `apps/cli` continues to assemble runtime/tool contexts and exposes feature summaries through `system.capabilities`.

No new package is required for P0 unless implementation evidence demonstrates a real dependency cycle. Avoid creating `@kodegpt/discovery` merely for naming symmetry. The current package graph supports this ownership cleanly: `@kodegpt/capabilities` has no KodeGPT workspace-package dependencies, `@kodegpt/skills` already depends on `@kodegpt/capabilities`, and `@kodegpt/mcp-server` already depends on both.

## 7. Public Action Catalog

### 7.1 Purpose

Create one bounded metadata record for every public MCP action.

Representative contract:

```ts
export type PublicActionRole =
  | "primitive"
  | "composite"
  | "lifecycle"
  | "integration"
  | "introspection";

export type PublicActionScope =
  | "global"
  | "workspace"
  | "repository"
  | "preview";

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

The exact implementation type names may differ, but the semantic fields above are required.

### 7.2 Single-source relationship with the MCP surface

The current `SURFACE_TOOLS` inventory already centralizes public names and required input names inside `packages/mcp-server`.

P0 should remove the need for two independently authored inventories. The preferred design is:

1. move or recreate the authoritative `{id, requiredInputs}` public action inventory in `@kodegpt/capabilities` together with its discovery metadata;
2. make `listSurfaceTools()` derive names/required inputs from that catalog;
3. keep actual MCP handler registration in `@kodegpt/mcp-server`;
4. add a registration completeness test proving the handlers registered by the MCP server equal the public action catalog exactly.

If an implementation detail makes direct derivation impractical, a strict bidirectional equality test is the minimum acceptable fallback. Silent inventory divergence is not acceptable.

### 7.3 Native capability relationship

`NATIVE_CAPABILITY_IDS` remains the authoritative native-capability subset.

Every native capability ID must also exist as a public action ID in the catalog. The existing `NATIVE_CAPABILITY_SEMANTICS` purpose/alias records should be derived from the public action descriptor when possible rather than separately authored.

The invariant is:

```text
NATIVE_CAPABILITY_IDS subset-of PUBLIC_ACTION_IDS
```

and a compile-time/runtime test must enforce it.

This preserves the useful native-capability model while eliminating semantic metadata drift.

### 7.4 Catalog quality

Every public action must have:

- a concise discovery-oriented purpose;
- at least one meaningful alias distinct from the raw action ID when possible;
- bounded tags describing user intent/domain rather than implementation internals;
- a role;
- a scope;
- required input names.

Aliases should favor phrases a host is likely to derive from user intent, for example:

```text
visual.captureMatrix
  aliases: responsive screenshots, capture viewport matrix, visual regression evidence
  tags: ui, visual, responsive, browser, verification

workspace.info
  aliases: current workspace, resume workspace, workspace state
  tags: workspace, continuity, resume, state

ci.failure
  aliases: why ci failed, workflow failure logs, github actions failure
  tags: ci, github-actions, debug, failure
```

The catalog is not a security policy and cannot grant authority.

## 8. Deterministic Action Discovery

### 8.1 Query normalization

Search remains local and deterministic.

At minimum:

- input query: 1..512 UTF-8 bytes;
- Unicode normalization with stable lower-casing;
- bounded tokenization over letters/numbers plus action-family separators;
- no model calls;
- no filesystem crawling beyond the already-bounded skill catalog;
- no network calls.

### 8.2 Ranking signals

Action scoring must use explicit weighted evidence rather than an opaque fuzzy score.

Required signal order:

1. exact action ID match;
2. exact alias match;
3. exact family/action-segment match;
4. all-query-token match in ID/alias;
5. partial token overlap in ID/aliases;
6. purpose match;
7. tag match;
8. role-aware preference when a broad user intent is better served by a composite action;
9. deterministic UTF-8 tie-break by action ID.

The concrete numeric weights belong in the implementation plan/tests. They must not rely on nondeterministic locale sorting.

### 8.3 Explainability

Each returned action match includes bounded reasons, for example:

```json
{
  "score": 870,
  "matchReasons": ["ALIAS_EXACT", "TAG_MATCH:visual", "ROLE:composite"]
}
```

The reasons are evidence for routing/debugging, not a promise that the action has already been executed.

## 9. Skill Requirement Graph

### 9.1 Why a new graph is required

The existing `SkillCapabilityPlan` remains useful for native capability guidance, missing capabilities, external CLIs, providers, and blocked semantics. It should not be stretched until every public MCP action becomes a `NativeCapabilityId`.

P0 adds a separate **Skill Requirement Graph** to represent complete public-action requirements and conditional stages while preserving the existing capability plan for its current semantic purpose.

This avoids both conceptual overload and a breaking replacement of working capability-resolution behavior.

### 9.2 Metadata model

Extend `metadata.kodegpt` compatibly.

Representative authored metadata:

```yaml
metadata:
  kodegpt:
    requires:
      actions:
        - context.build
        - workspace.inspect
        - code.search
        - file.edit
        - verify.run
        - git.diff
      capabilities:
        - process.run
    stages:
      - id: continuity
        description: Resume or reconcile existing work.
        actions:
          - workspace.info
          - workspace.checkpoint
      - id: preview
        description: Run and inspect a local application preview when relevant.
        actions:
          - preview.start
          - preview.inspect
          - preview.stop
      - id: browser
        description: Gather preview-scoped browser evidence when relevant.
        actions:
          - browser.openPreview
          - browser.inspect
          - browser.console
          - browser.networkFailures
          - browser.screenshot
      - id: visual
        description: Gather responsive visual evidence when relevant.
        actions:
          - visual.captureMatrix
          - visual.compare
      - id: pull-request
        description: Create and inspect a pull request when delivery requires one.
        actions:
          - github.pr.create
          - github.pr.inspect
      - id: ci
        description: Inspect or reconcile CI after remote delivery.
        actions:
          - ci.status
          - ci.runs
          - ci.run
          - ci.failure
          - ci.cancel
          - ci.rerun
```

`requires.capabilities`, existing provider declarations, unsupported declarations, and current legacy forms remain accepted.

### 9.3 Stage semantics

A stage is conditional by definition in P0. It describes a coherent capability group that may be needed depending on the user's task.

P0 intentionally does **not** define a conditional-expression language such as `when: branch == ...`. The host reasons about whether a stage is needed.

Each stage has:

- stable ID, 1..64 bytes, lowercase/digit/hyphen form;
- optional description, <= 512 UTF-8 bytes;
- bounded action IDs;
- optional bounded native capability requirements;
- optional bounded provider requirements, using the existing provider requirement semantics rather than inventing a second provider model.

Suggested hard bounds:

- at most 16 stages/skill;
- at most 32 actions/stage;
- at most 32 core actions;
- at most 16 native capabilities/stage;
- at most 8 providers/stage;
- retain the existing declared-requirement ceilings for other requirement classes.

### 9.4 Core versus stage compatibility

Overall skill compatibility is determined by **core** requirements.

Conditional stage **support classification** is reported independently using the existing compatibility vocabulary (`NATIVE`, `PARTIAL`, `PROVIDER_REQUIRED`, `UNSUPPORTED`). It describes whether KodeGPT can satisfy the declared/static requirements for that stage; it is not a promise that a future remote call, repository state, or required argument will succeed.

Example:

```text
skill core: NATIVE
preview stage: NATIVE
browser stage: NATIVE
visual stage: NATIVE
external-publish stage: PROVIDER_REQUIRED

=> overall skill remains NATIVE for its core workflow
```

A conditional stage with missing or provider-required support must not automatically make the whole skill `PARTIAL` or `PROVIDER_REQUIRED`.

### 9.5 Static instruction reconciliation

The requirement graph must not trust metadata blindly.

Static analysis scans instructions for exact public action references in addition to the existing native capability/CLI/provider analysis.

Rules:

1. actions explicitly declared in a stage remain assigned to that stage;
2. exact public action references found in instructions but not declared in any stage/core requirement are added to inferred core action requirements;
3. declared unknown action IDs are reported as missing/invalid requirements rather than silently ignored;
4. a stage action absent from prose is allowed because a skill may describe it indirectly, but an optional diagnostic may report declared/unreferenced drift;
5. static analysis must remain bounded and deterministic.

This gives conservative compatibility even for third-party skills which have not adopted the new KodeGPT stage metadata.

### 9.6 Result shape

`skill.inspect` gains an additive `requirementGraph` field rather than replacing the existing `capabilityPlan` in P0.

Representative shape:

```ts
interface SkillRequirementGraph {
  schemaVersion: 1;
  core: {
    classification: SkillCompatibility;
    actions: PublicActionRequirement[];
    inferredActions: PublicActionId[];
    missingActions: string[];
  };
  stages: Array<{
    id: string;
    description?: string;
    classification: SkillCompatibility;
    actions: PublicActionRequirement[];
    missingActions: string[];
  }>;
  analysisBasis: "declared" | "static" | "declared+static";
  truncated: boolean;
  truncationReasons: string[];
}
```

The implementation can normalize action requirement fields further, but the core/stage split and independent stage classification are required.

## 10. Intent-aware `skill.list`

Add an optional bounded `query` input to the existing `skill.list` tool.

Do **not** add `skill.search`.

When `query` is absent, preserve current list/filter/order semantics.

When `query` is present:

1. apply existing source/compatibility/pinned/workspace filters;
2. score remaining skills deterministically;
3. return only positive matches in relevance order;
4. use stable identity-aware tie-breaking.

Ranking signals:

1. exact skill name;
2. full name-token match;
3. name partial match;
4. description token match;
5. compatibility bonus (`NATIVE` > `PARTIAL` > `PROVIDER_REQUIRED` > `UNSUPPORTED`);
6. live/workspace relevance bonus when the matching workspace is supplied;
7. pinned availability as a small reproducibility signal, not a dominant relevance signal;
8. stable UTF-8 identity tie-break.

`skill.list(query)` may expose bounded match reasons if doing so keeps the list schema clear. If exposing match metadata would contaminate the general `SkillCatalogEntry` contract, keep match reasoning inside `system.discover` and use `skill.list(query)` primarily as a ranked filtered list.

## 11. Duplicate skill handling

Raw catalog identity/provenance remains unchanged.

`skill.list`, including `query`, continues to return distinct opaque skill identities where distinct sources expose the same content. Do not collapse catalog records and do not change fingerprint/source semantics.

High-level `system.discover` should, however, prevent exact duplicates from occupying most of the result window.

For discovery only, group skills when:

```text
name equal AND bundle fingerprint equal
```

Return one representative plus bounded alternate provenance.

Representative preference order:

1. matching workspace-local skill when `workspaceId` is supplied;
2. pinned/live+pinned copy;
3. remaining sources by deterministic source/skill ID order.

Skills with the same name but different fingerprints are **not** grouped because they may be materially different versions.

## 12. New public tool: `system.discover`

### 12.1 Input

Representative schema:

```ts
{
  query: string;          // required, 1..512 UTF-8 bytes
  workspaceId?: string;  // optional READY workspace context
  limit?: number;        // default 8, hard max 20
}
```

P0 does not need a complex `kinds`, `intent`, or weighting configuration surface. The host asks one natural-language intent; KodeGPT returns bounded action and skill candidates.

### 12.2 Output

Representative result:

```ts
{
  schemaVersion: 1;
  query: string;
  actions: Array<{
    id: PublicActionId;
    family: string;
    purpose: string;
    role: PublicActionRole;
    score: number;
    matchReasons: string[];
    requiredInputs: string[];
    availability: {
      status: "AVAILABLE" | "CONTEXT_REQUIRED" | "UNAVAILABLE";
      reasons: string[];
    };
  }>;
  skills: Array<{
    skillId: string;
    name: string;
    description: string;
    sourceId: string;
    fingerprint: string;
    compatibility: SkillCompatibility;
    score: number;
    matchReasons: string[];
    alternateSources?: Array<{
      skillId: string;
      sourceId: string;
    }>;
    matchedStages?: Array<{
      id: string;
      classification: string;
      actionIds: PublicActionId[];
    }>;
  }>;
  flows: Array<{
    source: "skill-stage";
    skillId: string;
    skillName: string;
    stageId: string;
    description?: string;
    actionIds: PublicActionId[];
  }>;
  truncated: boolean;
  truncationReasons: string[];
}
```

Exact result naming may be refined during implementation planning, but the three distinct surfaces are required:

- ranked **actions**;
- ranked/grouped **skills**;
- bounded **stage-derived flows**, not generated workflow execution plans.

### 12.3 Availability semantics

Discovery must not overclaim operational readiness.

Action availability means only local KodeGPT surface/context readiness, not that every future required argument or remote provider request will succeed.

Required behavior:

- global registered actions can report `AVAILABLE`;
- workspace-scoped actions without `workspaceId` report `CONTEXT_REQUIRED`;
- supplied unknown/closed/non-ready workspace context reports `UNAVAILABLE` for workspace-scoped actions;
- required argument names remain visible so a host knows a `previewId`, `repository`, `number`, etc. is still required;
- discovery does not call remote GitHub/CI/provider APIs merely to claim readiness;
- skill runtime compatibility may reuse the existing safe local executable-resolution path when `workspaceId` is provided, as `skill.inspect` already does.

### 12.4 Flow semantics

`flows` are descriptive routing evidence derived from explicit skill stage metadata. They are not executable plans.

Example:

```text
query: "check the responsive UI"

matched action:
  visual.captureMatrix

matched skill stage:
  kodegpt-application-development-workflow / visual

flow evidence:
  visual.captureMatrix
  visual.compare
```

If the relevant skill stage also declares preview/browser stages separately, the host may combine them through its own reasoning. P0 must not introduce a hidden workflow engine to automatically execute or conditionally branch those stages.

### 12.5 Side-effect guarantee

`system.discover` is read-only.

It must never:

- run a process;
- mutate files/Git/workspace state;
- create a preview;
- navigate a browser;
- mutate a checkpoint;
- invoke GitHub/CI/provider network operations;
- install or activate skills/plugins.

Tests must prove discovery does not dispatch action handlers.

## 13. `system.capabilities` reconciliation

Keep the existing compact public tool family inventory rather than dumping all action descriptions on every capabilities call.

Add a small discovery feature summary, for example:

```ts
discovery: {
  systemDiscover: true;
  publicActionCatalogVersion: 1;
  skillRequirementGraphVersion: 1;
  deterministicRanking: true;
}
```

`publicTools.count` and families continue to derive from the same authoritative action catalog used by discovery.

This makes feature support self-describing without forcing hosts to load the entire discovery corpus until they need it.

## 14. Built-in application workflow migration

Update `skills/kodegpt-application-development-workflow/SKILL.md` metadata to declare truthful core actions and conditional stages.

At minimum model:

- continuity/resume;
- repository understanding/context;
- editing/implementation;
- verification/process;
- preview;
- browser evidence;
- visual verification;
- Git delivery;
- pull request;
- CI.

Do not duplicate long prose into metadata. Metadata names the machine-readable requirements/stages; instructions continue to own nuanced host behavior and decision rules.

The workflow's current resume behavior is already correct in prose (`workspace.info`, checkpoint hints, live Git validation). P0 therefore improves **machine-readable discoverability**, not the resume algorithm itself.

## 15. Search quality benchmark

Discovery is not complete merely because the API exists.

Add a deterministic benchmark fixture with realistic intents and expected rankings.

The fixture should contain at least 40 intents covering the major public action families and development workflows, including examples such as:

```text
understand this repository
find where this symbol is used
what will this change affect
edit this file safely
run the tests
run a local development command
see whether the preview is ready
inspect browser console errors
check responsive UI screenshots
compare visual evidence
create a pull request
why did CI fail
rerun the failed CI workflow
continue the work from the previous chat
show current workspace state
create an isolated worktree
```

Because KodeGPT is personally used in an Indonesian-language workflow, the benchmark should also contain a representative bounded set of Indonesian intent phrasings, for example:

```text
cek CI
kenapa CI gagal
cek tampilan mobile
lanjutkan pekerjaan sebelumnya
cari dampak perubahan ini
buat worktree terpisah
```

The catalog itself does not need to become locale-specific if the ranking/aliases and model-generated query normalization already satisfy these cases. Add localized aliases only when the benchmark demonstrates a real miss.

Acceptance gates:

- >= 95% top-3 recall across the benchmark;
- >= 90% top-1 accuracy across the benchmark;
- 100% top-3 recall for critical routing intents: resume/workspace state, verification, preview/browser/visual verification, PR, CI failure, process execution, and Git/worktree lifecycle;
- stable identical ordering across repeated runs;
- no network/model dependency.

If these targets are missed, improve metadata/ranking before considering embeddings.

## 16. Bounds and denial-of-service controls

Required bounds:

- query <= 512 UTF-8 bytes;
- `limit` 1..20, default 8;
- action catalog fixed by the compiled public surface;
- skill discovery remains subject to existing source/entry/count/descriptor limits;
- inspect at most 5 top skill candidates to derive stage detail per `system.discover` call;
- return at most 5 flows;
- match reasons bounded per candidate;
- alternate duplicate provenance bounded per grouped skill;
- stage/action counts bounded as described above;
- explicit truncation reasons propagated from skill discovery and new discovery-specific bounds.

No background index is necessary. Search is computed over the bounded in-memory/loaded catalog for each request.

## 17. Error behavior

Prefer existing MCP input validation for malformed query/limit/workspace IDs.

New stable domain failures should be kept small. Candidate codes only if needed by the implementation:

```text
SKILL_REQUIREMENT_GRAPH_INVALID
SKILL_STAGE_LIMIT_EXCEEDED
PUBLIC_ACTION_CATALOG_INVALID
```

Unknown declared action IDs should ordinarily appear as structured missing requirements rather than crashing discovery.

A bad third-party skill must not make the complete action catalog or other skills undiscoverable. Existing source-unavailable/truncation behavior remains the model.

## 18. Testing strategy

### 18.1 Public action catalog

- every `PublicActionId` has metadata;
- every catalog ID is registered as an MCP handler;
- every registered public tool exists in the catalog;
- required input names match the public surface inventory;
- every `NATIVE_CAPABILITY_ID` exists in the public action catalog;
- native semantic purpose/aliases remain reconciled with the action catalog;
- catalog metadata is immutable and deterministically ordered.

### 18.2 Ranking

- exact ID outranks alias/purpose-only matches;
- exact alias outranks partial description matches;
- token ranking is deterministic;
- composite action can outrank primitive for an intentionally broad benchmark phrase;
- UTF-8 tie-breaking is stable;
- zero-match queries return bounded empty results rather than unrelated fallback actions.

### 18.3 Skill requirement graph

- parses valid core actions/stages;
- rejects/bounds malformed stage metadata conservatively;
- detects public action references statically;
- assigns declared stage actions to their stages;
- unassigned static action references become conservative core requirements;
- unknown action declarations appear as missing requirements;
- missing conditional stage action does not downgrade otherwise-native core compatibility;
- existing external CLI resolution still works;
- existing provider/unsupported semantics still work;
- legacy skill metadata remains supported.

### 18.4 `skill.list(query)`

- no-query behavior unchanged;
- existing filters compose with query ranking;
- exact name/name token/description ranking behaves as specified;
- workspace-local preference only applies when relevant;
- duplicate catalog identities remain distinct;
- result limit/truncation semantics remain correct.

### 18.5 `system.discover`

- returns relevant actions and skills;
- returns match reasons;
- groups exact duplicate skill content only at discovery presentation level;
- same-name/different-fingerprint skills remain distinct;
- derives flows only from explicit stage metadata;
- workspace-scoped action without workspace context reports `CONTEXT_REQUIRED`;
- invalid/closed workspace produces bounded unavailable evidence;
- does not invoke process/GitHub/CI/browser/preview/file mutation handlers;
- propagates truncation evidence;
- all response arrays obey hard bounds.

### 18.6 Quality benchmark

Add the benchmark described in Section 15 and treat its thresholds as a release gate.

### 18.7 Regression gates

At minimum, before merge:

- `@kodegpt/capabilities` tests PASS;
- `@kodegpt/skills` tests PASS;
- `@kodegpt/mcp-server` tests PASS;
- `@kodegpt/core` tests PASS;
- repository typecheck/build PASS;
- Rust deterministic/security gates PASS;
- forbidden-patterns PASS;
- package smoke PASS;
- host compatibility/conformance gates PASS;
- exact public tool count = 76;
- live dogfood of `system.discover`, `skill.list(query)`, and `skill.inspect(requirementGraph)` PASS;
- merged-main CI PASS.

## 19. Release and compatibility strategy

This phase is a deliberate semantic surface change:

```text
runtime:       0.1 -> 0.1
MCP protocol:  2026-07-28 -> 2026-07-28
MCP surface:   0.17 -> 0.18
public tools:  75 -> 76
```

The one new tool is:

```text
system.discover
```

Existing public tools remain named and available.

`skill.list` gains optional `query`.

`skill.inspect` gains additive `requirementGraph` evidence while retaining `capabilityPlan`.

`system.capabilities` gains additive discovery feature metadata.

No existing execution authority is widened by the surface bump.

## 20. Implementation decomposition

The later implementation plan should split P0 into independently reviewable steps, approximately:

1. Public Action Catalog foundation and catalog/surface invariants.
2. Native capability semantic reconciliation against the catalog.
3. Deterministic action search + quality fixture foundation.
4. Skill Requirement Graph parser/contracts/static analysis.
5. Built-in application workflow stage metadata migration.
6. Intent-aware `skill.list(query)` with stable ranking.
7. `system.discover` composition, duplicate grouping, availability, and stage-derived flows.
8. `system.capabilities` discovery summary and surface bump to 0.18/76.
9. Full regression, dogfood, release evidence, PR/CI closure.

The implementation plan must use TDD for each behavioral step and must not hide the surface bump until the final task.

## 21. Relationship to later approved roadmap

This spec deliberately establishes the discovery foundation required by the later user-approved roadmap but does not implement those later phases.

### P1A — Continuity v2

Future design can make `context.build(intent="resume")` and bounded milestone history discoverable through this action catalog and skill-stage model.

### P1B — Skill Ecosystem v2

Future managed skill search/install/update/remove/doctor/sync can feed the same catalog and deterministic skill discovery rather than creating a second search UX.

### P2 — MCP Plugin Gateway

Future admitted out-of-process plugin tools can be represented as a separate plugin discovery domain without turning provider/plugin advertisements into native KodeGPT public actions automatically. This P0 catalog therefore remains KodeGPT-owned static authority.

### P2/P3 — Browser v2

Future operator-approved browser target expansion can change action availability/metadata without changing the discovery architecture.

## 22. Rejected scope growth during P0

Do not use this work as a reason to add:

```text
workflow.run
skill.run
agent.spawn
agent.delegate
agent.session
provider.invoke
plugin.call
plugin.install over MCP
conversation/session database
vector database
background indexing daemon
arbitrary computer use
```

Those are separate architectural decisions. P0 succeeds when KodeGPT accurately understands and surfaces the substantial capability it already has.

## 23. Acceptance summary

P0 is complete only when all of the following are true:

1. one authoritative public action catalog covers exactly the live MCP surface;
2. native semantic metadata cannot silently diverge from corresponding public action metadata;
3. `system.discover` exists and provides deterministic bounded action + skill discovery;
4. `skill.list(query)` ranks skills without adding a redundant public search tool;
5. `skill.inspect` reports a core/stage requirement graph covering public actions outside `NATIVE_CAPABILITY_IDS`;
6. the built-in application workflow truthfully exposes continuity/preview/browser/visual/PR/CI stages;
7. duplicate identical skills do not crowd high-level discovery while source identity is preserved;
8. search-quality thresholds pass on realistic development intents;
9. discovery causes no execution/network/mutation side effects;
10. surface is explicitly `0.18` with exactly `76` public tools;
11. all deterministic repository, MCP, package, security, and live dogfood gates pass;
12. merged-main CI is green before P0 is declared complete.
