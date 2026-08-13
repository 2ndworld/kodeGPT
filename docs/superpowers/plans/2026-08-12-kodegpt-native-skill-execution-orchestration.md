# Native Skill Execution Orchestration Implementation Plan

> **Baseline reconciliation (2026-08-13):** this remains future advisory/read-only work and has not been implemented. The current released candidate baseline is MCP semantic surface `0.3` with protocol `2026-07-28`, including the host-visible optional `skill.list.compatibility` filter. Reconcile any implementation of this plan against that baseline; do not revive the earlier `0.2` assumption, add provider invocation, or create `skill.run`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic, read-only skill-to-native-capability guidance to `skill.inspect` so GPT Web can orchestrate existing KodeGPT primitives without introducing `skill.run` or provider-agent execution.

**Architecture:** Keep the current three-tool skill MCP surface unchanged. Add static metadata for existing native capability IDs, derive a pure bounded `SkillCapabilityPlan` from the existing compatibility report plus recognized skill semantics, and expose that plan through `skill.inspect`; GPT Web still explicitly calls ordinary KodeGPT native tools, whose existing trust/policy/Rust/audit boundaries remain authoritative.

**Tech Stack:** TypeScript 5.9, Zod-backed skill contracts, Vitest 3.2, existing `@kodegpt/capabilities`, `@kodegpt/skills`, and `@kodegpt/mcp-server` packages; Rust runtime is intentionally unchanged unless a later test demonstrates a missing authority contract.

## Global Constraints

- MCP semantic surface baseline is `0.3`. Any future additive `skill.inspect` result-field version treatment must follow the repository's existing compatibility/versioning policy; do not invent a new versioning scheme or regress the baseline to `0.2`.
- The public skill tool inventory remains exactly `skill.list`, `skill.inspect`, and `skill.load`.
- Do not add `skill.run`, provider invocation, provider process spawning, provider credential forwarding, or provider session attachment.
- Source add/remove, pin/unpin, and workspace trust remain local CLI only.
- Do not expose state root, canonical trusted/source roots, source capability IDs, retained FDs, private execution IDs, PID/PGID, provider credentials, or unnecessary host paths.
- Compatibility/planning output is advisory and cannot widen effective policy.
- Skill scripts/resources remain data-only and are never auto-executed.
- Source identity replacement remains fail closed even when a pinned snapshot exists.
- Rust remains final OS/security authority and durable audit ordering remains unchanged.
- Use TDD RED → GREEN → refactor for every behavioral change.

---

### Task 1: Native capability semantic metadata registry

**Files:**
- Create: `packages/capabilities/src/skill-metadata.ts`
- Create: `packages/capabilities/src/skill-metadata.test.ts`
- Modify: `packages/capabilities/src/index.ts`
- Reference: `packages/capabilities/src/contracts.ts:11-25`

**Interfaces:**
- Consumes: `NativeCapabilityId` and `NATIVE_CAPABILITY_IDS` from `packages/capabilities/src/contracts.ts`.
- Produces: `NativeCapabilitySemanticMetadata`, `NATIVE_CAPABILITY_SEMANTICS`, and `getNativeCapabilitySemanticMetadata(id: NativeCapabilityId)`.

- [ ] **Step 1: Write the RED registry completeness test**

Create `packages/capabilities/src/skill-metadata.test.ts` with tests equivalent to:

```ts
import { describe, expect, it } from "vitest";
import {
  NATIVE_CAPABILITY_IDS,
  NATIVE_CAPABILITY_SEMANTICS,
  getNativeCapabilitySemanticMetadata
} from "./index.js";

describe("native capability semantic metadata", () => {
  it("has exactly one immutable metadata entry for every existing native capability", () => {
    expect(Object.keys(NATIVE_CAPABILITY_SEMANTICS).sort()).toEqual([...NATIVE_CAPABILITY_IDS].sort());
    for (const id of NATIVE_CAPABILITY_IDS) {
      const metadata = getNativeCapabilitySemanticMetadata(id);
      expect(metadata.id).toBe(id);
      expect(metadata.purpose.length).toBeGreaterThan(0);
      expect(metadata.semanticAliases.length).toBeGreaterThan(0);
      expect(Object.isFrozen(metadata.semanticAliases)).toBe(true);
    }
    expect(Object.isFrozen(NATIVE_CAPABILITY_SEMANTICS)).toBe(true);
  });

  it("contains descriptions only and no authority-bearing runtime state", () => {
    const serialized = JSON.stringify(NATIVE_CAPABILITY_SEMANTICS);
    for (const forbidden of ["workspaceId", "sourceCapabilityId", "canonicalRoot", "stateRoot", "token", "credential"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
pnpm exec vitest run packages/capabilities/src/skill-metadata.test.ts --no-file-parallelism
```

Expected: FAIL because the semantic registry exports do not exist.

- [ ] **Step 3: Implement the minimal static registry**

Create `skill-metadata.ts` with a closed type:

```ts
import { NATIVE_CAPABILITY_IDS, type NativeCapabilityId } from "./contracts.js";

export interface NativeCapabilitySemanticMetadata {
  id: NativeCapabilityId;
  purpose: string;
  semanticAliases: readonly string[];
}

type Registry = Readonly<Record<NativeCapabilityId, NativeCapabilitySemanticMetadata>>;
```

Populate exactly the current 13 IDs. Use narrow aliases describing semantics, not shell commands or host-specific implementation details. Examples:

```ts
"workspace.inspect": ["inspect workspace", "project structure", "repository structure"],
"code.search": ["search code", "find symbol", "find reference"],
"file.patch": ["apply patch", "unified patch", "structured patch"],
"verify.run": ["run verification", "run test recipe", "run typecheck recipe"]
```

Freeze each alias array, each metadata object, and the registry. Export a direct lookup that accepts only `NativeCapabilityId`.

- [ ] **Step 4: Export the registry through `packages/capabilities/src/index.ts`**

Add only the public metadata types/functions required by `@kodegpt/skills`; do not add new capability IDs.

- [ ] **Step 5: Run focused package tests GREEN**

Run:

```bash
pnpm exec vitest run packages/capabilities/src/contracts.test.ts packages/capabilities/src/skill-metadata.test.ts --no-file-parallelism
pnpm --filter @kodegpt/capabilities typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add packages/capabilities/src/skill-metadata.ts packages/capabilities/src/skill-metadata.test.ts packages/capabilities/src/index.ts
git commit -m "feat(capabilities): describe native skill semantics"
```

---

### Task 2: Pure bounded skill capability planner

**Files:**
- Create: `packages/skills/src/capability-plan.ts`
- Create: `packages/skills/src/capability-plan.test.ts`
- Modify: `packages/skills/src/contracts.ts`
- Modify: `packages/skills/src/index.ts`
- Reference: `packages/skills/src/compatibility.ts`

**Interfaces:**
- Consumes: `ParsedSkillDocument`, `SkillCompatibilityReport`, `NativeCapabilityId`, and the Task 1 semantic registry.
- Produces: `SkillCapabilityPlan`, `SkillCapabilityGuidanceStep`, and `buildSkillCapabilityPlan(skill, compatibility)`.

- [ ] **Step 1: Add RED tests for all four compatibility classes**

Create fixtures inside `capability-plan.test.ts` that call the existing parser/compatibility analyzer and then the new planner. Assert:

```ts
expect(nativePlan).toMatchObject({
  schemaVersion: 1,
  classification: "NATIVE",
  missingCapabilities: [],
  externalRequirements: [],
  blockedSemantics: []
});
expect(nativePlan.nativeCapabilities).toContain("git.status");
expect(nativePlan.nativeCapabilities).toContain("git.diff");
```

For a declared missing capability:

```ts
expect(partialPlan.classification).toBe("PARTIAL");
expect(partialPlan.missingCapabilities).toContain("example.missing");
```

For a declared provider:

```ts
expect(providerPlan.classification).toBe("PROVIDER_REQUIRED");
expect(providerPlan.externalRequirements).toContain("provider:figma");
expect(providerPlan.blockedSemantics).toEqual([]);
```

For Codex/subagent semantics:

```ts
expect(unsupportedPlan.classification).toBe("UNSUPPORTED");
expect(unsupportedPlan.blockedSemantics).toEqual(
  expect.arrayContaining(["codex.exec", "subagent.session"])
);
```

Also assert all arrays are deterministic, unique, bounded, and stable over repeated calls.

- [ ] **Step 2: Run the planner test and confirm RED**

```bash
pnpm exec vitest run packages/skills/src/capability-plan.test.ts --no-file-parallelism
```

Expected: FAIL because planner/contracts are absent.

- [ ] **Step 3: Add closed public plan contracts**

Add to `packages/skills/src/contracts.ts`:

```ts
export interface SkillCapabilityGuidanceStep {
  capability: NativeCapabilityId;
  purpose: string;
}

export type SkillCapabilityPlanTruncationReason =
  | "MISSING_CAPABILITIES"
  | "EXTERNAL_REQUIREMENTS"
  | "BLOCKED_SEMANTICS";

export interface SkillCapabilityPlan {
  schemaVersion: 1;
  classification: SkillCompatibility;
  nativeCapabilities: readonly NativeCapabilityId[];
  missingCapabilities: readonly string[];
  externalRequirements: readonly string[];
  blockedSemantics: readonly string[];
  guidance: readonly SkillCapabilityGuidanceStep[];
  truncated: boolean;
  truncationReasons: readonly SkillCapabilityPlanTruncationReason[];
}
```

Import `NativeCapabilityId` as a type from `@kodegpt/capabilities`. Keep array-size hard limits private to the planner implementation and cover them by tests.

- [ ] **Step 4: Implement a pure planner without execution**

`buildSkillCapabilityPlan` must:

1. reuse `compatibility.classification` verbatim;
2. map `compatibility.requiredCapabilities` that are current `NativeCapabilityId`s into `nativeCapabilities`;
3. preserve `compatibility.missingCapabilities` in `missingCapabilities`;
4. map `requiredProviders` to deterministic `provider:<name>` strings in `externalRequirements`;
5. map existing unsupported reasons (`CODEX_EXEC_UNSUPPORTED`, `CODEX_RUNTIME_UNSUPPORTED`, `SUBAGENT_SESSION_UNSUPPORTED`, declared unsupported requirements) into stable `blockedSemantics` values;
6. optionally recognize aliases from Task 1 in the parsed skill instructions only to add existing native capability IDs, never to remove a missing/provider/unsupported finding;
7. create one `guidance` row per selected native capability using the registry purpose;
8. bytewise-sort/dedupe all arrays; `nativeCapabilities`/`guidance` are naturally capped by the exact `NATIVE_CAPABILITY_IDS` set, while each finding array is capped at 64 entries;
9. set `truncated=true` plus stable `truncationReasons` when a finding array exceeds its cap, without changing `compatibility.classification` or silently pretending the omitted advisory details are complete;
10. freeze the returned plan and nested arrays/steps so internal consumers cannot mutate advisory evidence after planning.

The module must import no filesystem, child-process, network, environment, credential, workspace-manager, or runtime code.

- [ ] **Step 5: Export planner/types and run focused GREEN tests**

```bash
pnpm exec vitest run packages/skills/src/compatibility.test.ts packages/skills/src/capability-plan.test.ts --no-file-parallelism
pnpm --filter @kodegpt/skills typecheck
```

Expected: PASS and existing classifier behavior unchanged.

- [ ] **Step 6: Commit Task 2**

```bash
git add packages/skills/src/capability-plan.ts packages/skills/src/capability-plan.test.ts packages/skills/src/contracts.ts packages/skills/src/index.ts
git commit -m "feat(skills): plan native capability guidance"
```

---

### Task 3: Attach the advisory plan to `skill.inspect`

**Files:**
- Modify: `packages/skills/src/catalog.ts:149-176,567-603`
- Modify: `packages/skills/src/tool-adapter.ts:97-116`
- Modify: `packages/skills/src/contracts.ts:170-201`
- Modify: `packages/skills/src/catalog.test.ts`
- Modify: `packages/skills/src/tool-adapter.test.ts`

**Interfaces:**
- Consumes: `buildSkillCapabilityPlan()` from Task 2.
- Produces: `SkillInspectResult.capabilityPlan: SkillCapabilityPlan` while preserving every current inspection field.

- [ ] **Step 1: Write RED catalog tests for live and pinned inspection**

Extend existing `catalog.inspect` tests so both live/current and pinned inspections contain a `capabilityPlan` whose classification equals `inspection.skill.compatibility.classification` and whose native/missing/provider/blocked findings reflect the same selected bundle.

Assert that inspecting a pinned fingerprint after live mutation plans from pinned content/metadata, not from the mutated live document.

- [ ] **Step 2: Write RED tool-adapter public-shape test**

Extend `packages/skills/src/tool-adapter.test.ts`:

```ts
expect(result.capabilityPlan).toMatchObject({
  schemaVersion: 1,
  classification: result.skill.compatibility.classification
});
const serialized = JSON.stringify(result);
for (const forbidden of [sourceRoot, stateRoot, "canonicalRoot", "sourceCapabilityId"]) {
  expect(serialized).not.toContain(forbidden);
}
```

Use fixture values already available in the test rather than inventing production paths.

- [ ] **Step 3: Run the two focused tests and confirm RED**

```bash
pnpm exec vitest run packages/skills/src/catalog.test.ts packages/skills/src/tool-adapter.test.ts --no-file-parallelism
```

Expected: FAIL on missing `capabilityPlan`.

- [ ] **Step 4: Compute the plan at the bundle inspection boundary**

Extend `SkillCatalogInspection` and `SkillInspectResult` with required `capabilityPlan`.

In `inspectionFromBundle`, call `buildSkillCapabilityPlan` using the exact parsed skill document/metadata and the compatibility report already associated with that bundle. In `inspectionFromPinned`, derive the same plan from the immutable pinned snapshot so reproducibility includes advisory semantics.

Do not read live source data when satisfying an inspection explicitly pinned to fingerprint A.

- [ ] **Step 5: Pass the plan through `publicInspection` unchanged**

The tool adapter may clone arrays for public immutability, but it must not recompute, execute, or enrich the plan with host state.

- [ ] **Step 6: Run focused and package tests GREEN**

```bash
pnpm exec vitest run packages/skills/src/catalog.test.ts packages/skills/src/tool-adapter.test.ts --no-file-parallelism
pnpm --filter @kodegpt/skills test
pnpm --filter @kodegpt/skills typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add packages/skills/src/catalog.ts packages/skills/src/tool-adapter.ts packages/skills/src/contracts.ts packages/skills/src/catalog.test.ts packages/skills/src/tool-adapter.test.ts
git commit -m "feat(skills): expose advisory capability plans"
```

---

### Task 4: MCP schema and host-oriented descriptions without new authority

**Files:**
- Modify: `packages/mcp-server/src/tools.ts:485-520`
- Modify: `packages/mcp-server/src/skills.test.ts`
- Reference only: `packages/mcp-server/src/structured-results.test.ts` (the current baseline uses it for capability tools that advertise MCP `outputSchema`; skill tools do not)
- `tests/fixtures/mcp-surface.ts` should remain unchanged because this phase changes neither tool names nor required input fields.

**Interfaces:**
- Consumes: extended `SkillInspectResult` from Task 3.
- Produces: unchanged tool name/input inventory; clearer `skill.inspect`/`skill.load` descriptions and typed/structured result coverage for the advisory plan. Current skill tools do not advertise MCP `outputSchema`; do not introduce one solely for this additive field.

- [ ] **Step 1: Add RED inventory/description assertions**

In `packages/mcp-server/src/skills.test.ts`, keep:

```ts
const READ_ONLY_SKILL_TOOLS = ["skill.list", "skill.inspect", "skill.load"];
```

Add assertions that `skill.inspect` description contains the concepts `advisory` and `native capabilities`, and `skill.load` makes clear resources are returned as data/text rather than executed.

Continue asserting mutation/execution names are absent.

- [ ] **Step 2: Add RED structured-result contract coverage**

Extend the existing MCP skill-result tests (use `skills.test.ts`; `structured-results.test.ts` is capability-output-schema-specific on the current baseline) so `skill.inspect`'s returned structured result includes:

```ts
capabilityPlan: {
  schemaVersion: 1,
  classification: "NATIVE",
  nativeCapabilities: ["git.status"],
  missingCapabilities: [],
  externalRequirements: [],
  blockedSemantics: [],
  guidance: [{ capability: "git.status", purpose: expect.any(String) }]
}
```

Assert the fallback text and structured content agree.

- [ ] **Step 3: Run focused MCP tests and confirm RED**

```bash
pnpm exec vitest run packages/mcp-server/src/skills.test.ts packages/mcp-server/src/structured-results.test.ts --no-file-parallelism
```

- [ ] **Step 4: Update only descriptions/result schema plumbing**

Do not add a tool. Do not add write annotations to skill tools. Do not add workspace/source/pin IDs beyond the existing public skill/source identifiers.

`skill.inspect` description should explicitly state that the plan is advisory and actual host operations require separate normal KodeGPT tool calls.

- [ ] **Step 5: Run MCP package and surface tests GREEN**

```bash
pnpm exec vitest run packages/mcp-server/src/skills.test.ts packages/mcp-server/src/structured-results.test.ts packages/mcp-server/src/server.test.ts --no-file-parallelism
pnpm --filter @kodegpt/mcp-server typecheck
```

Expected: PASS and exact skill tool-name set unchanged.

- [ ] **Step 6: Commit Task 4**

```bash
git add packages/mcp-server/src/tools.ts packages/mcp-server/src/skills.test.ts packages/mcp-server/src/structured-results.test.ts tests/fixtures/mcp-surface.ts
git commit -m "feat(mcp): clarify native skill orchestration"
```

If `tests/fixtures/mcp-surface.ts` did not require a change, omit it from `git add`.

---

### Task 5: Production integration and non-execution proof

**Files:**
- Modify: `tests/integration/skill-interoperability.test.ts`
- Modify: `tests/security/security-invariants.test.ts`
- Modify: `scripts/forbidden-patterns.mjs` only if a new authored production pattern needs an explicit guard; do not loosen existing guards.

**Interfaces:**
- Consumes: complete advisory-plan pipeline from Tasks 1-4.
- Produces: release-level evidence for all four classifications and proof that planning does not become execution.

- [ ] **Step 1: Extend the production MCP fixture with a declared provider skill**

Keep the existing `codex exec`/subagent fixture as `UNSUPPORTED`. Add a separate fixture whose frontmatter declares a provider requirement using the already-supported `kodegpt.requires.providers` shape, so the integration suite covers `PROVIDER_REQUIRED` independently.

- [ ] **Step 2: Add RED assertions for advisory plans**

Through the real HTTP MCP helper already in the test, assert:

- NATIVE portable skill returns a non-empty native guidance plan appropriate to its declared/static semantics;
- declared provider fixture remains `PROVIDER_REQUIRED` and returns `provider:<name>` in external requirements;
- Codex/subagent fixture remains `UNSUPPORTED` with blocked semantics;
- script resource load still returns text and does not create the execution marker;
- no new skill execution/mutation tools appear in `tools/list`.

- [ ] **Step 3: Run focused integration/security tests**

```bash
pnpm exec vitest run tests/integration/skill-interoperability.test.ts tests/security/security-invariants.test.ts --no-file-parallelism
```

Expected after Tasks 1-4: PASS. If it fails, fix the first root cause without broadening authority.

- [ ] **Step 4: Run official forbidden scan**

```bash
pnpm verify:forbidden
```

Expected: PASS. Do not scope away production files to hide a provider-spawn or `skill.run` regression.

- [ ] **Step 5: Commit Task 5**

```bash
git add tests/integration/skill-interoperability.test.ts tests/security/security-invariants.test.ts scripts/forbidden-patterns.mjs
git commit -m "test(skills): prove advisory orchestration boundaries"
```

Omit `scripts/forbidden-patterns.mjs` if unchanged.

---

### Task 6: Documentation, host re-scan, and release verification

**Files:**
- Modify: `docs/compatibility/chatgpt.md`
- Modify: `docs/verification/host-acceptance.md`
- Modify: `docs/release/v0.1-checklist.md` only if the additive schema requires a new explicit host-evidence row under existing versioning rules.
- Modify: the dated release-readiness report for the implementation run.

**Interfaces:**
- Consumes: completed implementation and test evidence.
- Produces: reproducible host acceptance and release-readiness evidence; no runtime behavior.

- [ ] **Step 1: Document the advisory contract**

State factually:

- `skill.inspect` may return a bounded advisory capability plan;
- it is not permission and does not execute tools;
- GPT Web remains the orchestrator;
- actual operations still use ordinary native KodeGPT tools;
- provider execution remains unavailable;
- the public skill tool inventory remains exactly three read-only tools.

- [ ] **Step 2: Refresh/rescan the ChatGPT app actions before host evidence**

Because MCP tool schemas can be retained as a previously approved host snapshot, refresh the custom app actions after deploying the exact candidate. Confirm the current host discovers the updated `skill.inspect` schema before claiming host PASS.

If the host cannot refresh or still exposes the prior snapshot, record `BLOCKED`; do not infer PASS from the integration suite.

- [ ] **Step 3: Run real ChatGPT host acceptance**

Follow `docs/verification/host-acceptance.md`. At minimum verify:

1. `skill.list` discovers the live fixture;
2. `skill.inspect` returns `capabilityPlan` and no security/path leakage;
3. GPT uses one suggested existing read-only native capability explicitly;
4. `skill.load` returns instructions/script text without executing the script;
5. no source/pin/trust/provider execution tool appears.

- [ ] **Step 4: Run the full release matrix**

```bash
pnpm typecheck
pnpm test
pnpm test:protocol
pnpm test:integration
pnpm test:security
pnpm test:isolation
pnpm test:acceptance
pnpm verify:forbidden
pnpm build
cargo fmt --all -- --check
cargo test --workspace
pnpm verify:package
git diff --check
```

Also run release-checklist-specific mandatory gates that remain applicable, including the sandbox package test and performance baseline.

Expected: all executable gates exit zero; host-only rows are reported separately as observed PASS/FAIL/BLOCKED.

- [ ] **Step 5: Review final diff for architecture violations**

Confirm production implementation contains no:

- `skill.run` registration;
- MCP source/pin/trust mutation;
- provider/Codex/Claude process launch;
- credential forwarding;
- host-path/security-handle leakage;
- policy bypass or TypeScript filesystem/process fallback around Rust authority.

- [ ] **Step 6: Commit docs/release evidence**

```bash
git add docs/compatibility/chatgpt.md docs/verification/host-acceptance.md docs/release
git commit -m "docs: document native skill orchestration acceptance"
```

Do not tag or publish a release unless every existing tag gate is satisfied for the exact commit.

---

## Deferred separate design: bounded remote CI inspection

Do not implement this as part of the plan above. After another dogfood cycle, if GitHub/CI-oriented skills remain a common `PARTIAL` category, write a separate design that compares:

1. connector-backed structured GitHub Actions reads;
2. a narrowly policy-bound remote-CI adapter owned by KodeGPT;
3. keeping the dependency external and leaving those skills `PARTIAL`.

The design must explicitly reject a generic `gh`/shell escape hatch as the default solution. It should begin read-only and must define its own authentication, redaction, audit, bounds, and failure model before any implementation plan is approved.
