# KodeGPT Skill Capability Resolution v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `skill.inspect` optionally resolve static `external-cli:*` findings against one READY workspace's existing process policy and executable availability without executing commands or changing skill discovery.

**Architecture:** Keep `SkillCatalog` static. Add one focused resolver in `@kodegpt/skills`; MCP `skill.inspect` passes optional `workspaceId`, reads the existing READY workspace policy, and calls the existing `WorkspaceManager.inspectExecutable` probe before returning a context-aware capability plan. No dependency, startup reordering, generic resolver framework, or new MCP tool is introduced.

**Tech Stack:** TypeScript 5.9, Vitest, existing KodeGPT skills contracts, WorkspaceManager, Rust runtime `process.inspect_executable`.

## Global Constraints

- Runtime/protocol/MCP surface remain `0.1 / 2026-07-28 / 0.7`.
- Public tool count remains unchanged.
- `skill.list` and stored/static `skill.compatibility` remain workspace-independent.
- `skill.inspect.workspaceId` is optional; omitting it preserves existing behavior.
- No `skill.run`, command execution, package installation, host PATH disclosure, provider resolution, background monitoring, or authority widening.
- Resolve at most the existing 64 bounded capability-plan findings.
- Reuse existing `WorkspaceManager.requireReady`, effective policy, and `inspectExecutable`; do not add a second executable-discovery path.

---

### Task 1: Add context-aware external CLI resolution

**Files:**
- Modify: `packages/skills/src/contracts.ts`
- Modify: `packages/skills/src/capability-plan.ts`
- Modify: `packages/skills/src/capability-plan.test.ts`
- Modify: `packages/skills/src/index.ts`

**Interfaces:**
- Produces:

```ts
export type SkillExternalCliStatus =
  | "available"
  | "not-allowed"
  | "not-installed"
  | "sandbox-unavailable";

export interface SkillExternalCliResolution {
  readonly requirement: string;
  readonly executable: string;
  readonly status: SkillExternalCliStatus;
  readonly capability: "process.run";
}

export interface SkillCapabilityRuntimeContext {
  readonly workspaceId: string;
  readonly allowProcess: boolean;
  readonly allowedExecutableNames: readonly string[];
  inspectExecutable(executable: string): Promise<{
    executableAvailable: boolean;
    sandboxAvailable: boolean;
  }>;
}

export async function resolveSkillCapabilityPlan(
  plan: SkillCapabilityPlan,
  context: SkillCapabilityRuntimeContext
): Promise<SkillCapabilityPlan>;
```

- Extends `SkillCapabilityPlan` with optional `externalCliRequirements`.

- [ ] **Step 1: Write failing resolver tests**

Add tests for these exact behaviors:

```ts
const plan = buildSkillCapabilityPlan(parsedSkillWithNpx, compatibilityWithExternalNpx);
const resolved = await resolveSkillCapabilityPlan(plan, {
  workspaceId: "ws_1",
  allowProcess: true,
  allowedExecutableNames: ["npx"],
  inspectExecutable: async () => ({ executableAvailable: true, sandboxAvailable: true })
});
expect(resolved.classification).toBe("NATIVE");
expect(resolved.missingCapabilities).not.toContain("external-cli:npx");
expect(resolved.externalCliRequirements).toEqual([
  { requirement: "external-cli:npx", executable: "npx", status: "available", capability: "process.run" }
]);
expect(resolved.nativeCapabilities).toContain("process.run");
```

Also prove:
- `allowProcess:false` => `not-allowed`, probe call count 0;
- executable absent from allowlist => `not-allowed`, probe call count 0;
- allowlisted but `executableAvailable:false` => `not-installed`;
- available executable with `sandboxAvailable:false` => `sandbox-unavailable`;
- unrelated missing capabilities remain and keep classification `PARTIAL`;
- `UNSUPPORTED` and `PROVIDER_REQUIRED` remain unchanged;
- output ordering/deduplication is deterministic.

- [ ] **Step 2: Run RED**

```bash
pnpm exec vitest run packages/skills/src/capability-plan.test.ts
```

Expected: FAIL because resolver/types do not exist.

- [ ] **Step 3: Implement minimal resolver**

In `contracts.ts`, add the types above and:

```ts
readonly externalCliRequirements?: readonly SkillExternalCliResolution[];
```

In `capability-plan.ts`, implement only external CLI findings already present in `plan.missingCapabilities`:

```ts
const prefix = "external-cli:";
const requirements = sortedUnique(
  new Set(plan.missingCapabilities.filter((value) => value.startsWith(prefix)))
);
```

For each requirement, derive the executable from the suffix, apply policy checks before probing, call `context.inspectExecutable` only when allowed, and build one resolution record. Remove only `available` external CLI findings from effective missing capabilities. Add `process.run` to native capabilities/guidance iff at least one requirement is `available`. Recompute effective classification while preserving `UNSUPPORTED` and `PROVIDER_REQUIRED` precedence.

Export the resolver and new public types from `packages/skills/src/index.ts`.

- [ ] **Step 4: Run GREEN**

```bash
pnpm exec vitest run packages/skills/src/capability-plan.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/contracts.ts packages/skills/src/capability-plan.ts packages/skills/src/capability-plan.test.ts packages/skills/src/index.ts
git commit -m "feat: resolve external skill cli requirements"
```

---

### Task 2: Wire optional workspace resolution into MCP `skill.inspect`

**Files:**
- Modify: `packages/mcp-server/src/tool-context.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/skills.test.ts`
- Modify if required by public type assertions: `packages/mcp-server/src/index.ts`

**Interfaces:**
- `SkillToolContext.inspect` becomes:

```ts
inspect(input: {
  skillId: string;
  fingerprint?: string;
  workspaceId?: string;
}): Promise<SkillInspectResult>;
```

- `WorkspaceManagerToolAdapter` additionally picks `inspectExecutable`.

- [ ] **Step 1: Write failing MCP tests**

Extend the existing skill tool registration test to prove `workspaceId` is accepted by the closed input schema.

Add a tool-context/MCP behavior test with a `PARTIAL` `external-cli:npx` inspection and a READY workspace whose policy is:

```ts
{
  name: "trusted",
  allowWrite: true,
  allowProcess: true,
  network: "unrestricted",
  allowedExecutableNames: ["npx"],
  inheritEnv: false,
  envAllowlist: []
}
```

The executable probe returns available+sandbox available. Assert returned `capabilityPlan` is effective `NATIVE`, contains `externalCliRequirements[0].status === "available"`, and the static `skill.compatibility.classification` is still `PARTIAL`.

Also assert omitting `workspaceId` does not call `requireReady`/`inspectExecutable` and leaves the existing generic plan unchanged.

- [ ] **Step 2: Run RED**

```bash
pnpm exec vitest run packages/mcp-server/src/skills.test.ts packages/mcp-server/src/structured-results.test.ts
```

Expected: FAIL because `workspaceId` is not accepted/wired.

- [ ] **Step 3: Implement minimal MCP orchestration**

In `tool-context.ts`:

- import `resolveSkillCapabilityPlan` from `@kodegpt/skills`;
- add `inspectExecutable` to `WorkspaceManagerToolAdapter`;
- widen `SkillToolContext.inspect` input with optional `workspaceId`;
- when omitted, return `skill.inspect({ skillId, fingerprint })` unchanged;
- when supplied:
  1. get `ready = workspaceManager.requireReady(workspaceId)`;
  2. get generic inspection from `skill.inspect`;
  3. call `resolveSkillCapabilityPlan(inspection.capabilityPlan, {...})` using `ready.effectivePolicy` and `workspaceManager.inspectExecutable`;
  4. return a cloned `SkillInspectResult` with only `capabilityPlan` replaced.

In `tools.ts`, add optional `workspaceId: z.string().min(1)` and pass it through.

- [ ] **Step 4: Run GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tool-context.ts packages/mcp-server/src/tools.ts packages/mcp-server/src/skills.test.ts packages/mcp-server/src/index.ts
git commit -m "feat: make skill inspection workspace aware"
```

---

### Task 3: Production-stack regression and documentation closure

**Files:**
- Modify only as required: `apps/cli/src/commands/start.test.ts`
- Modify: `docs/architecture/README.md`
- Modify: `docs/implementation/v0.1-execution-tracker.md`

**Interfaces:**
- Existing production stack supplies a real `WorkspaceManager`, so no startup-order or constructor change should be required.

- [ ] **Step 1: Run production/startup focused tests**

```bash
pnpm exec vitest run apps/cli/src/commands/start.test.ts packages/skills/src/capability-plan.test.ts packages/mcp-server/src/skills.test.ts tests/integration/skill-interoperability.test.ts
```

If a production-stack test fixture lacks `inspectExecutable` because of the widened `Pick`, add the minimal stub using the existing fixture's WorkspaceManager shape. Do not restructure startup.

- [ ] **Step 2: Run typecheck and build**

```bash
pnpm typecheck
pnpm build
```

Expected: PASS.

- [ ] **Step 3: Run full TypeScript suite and deterministic repository gates**

```bash
pnpm test
pnpm run verify:forbidden
pnpm run verify:package
cargo test --workspace
```

Expected: PASS.

- [ ] **Step 4: Verify public surface invariants**

Confirm tests still pin MCP surface `0.7`, no `skill.run` exists, and public tool count is unchanged. Use repository tests/search, not a new implementation mechanism.

- [ ] **Step 5: Update docs with verified local evidence**

Record only facts proven by the preceding checks: optional workspace-aware `skill.inspect`, external CLI statuses, `process.run` advisory mapping, unchanged static compatibility, no new authority/tool/dependency/surface bump.

- [ ] **Step 6: Review exact diff**

Use CodexPro `show_changes`. Reject unrelated refactors, startup-order changes, dependency changes, provider resolution, or authority widening.

- [ ] **Step 7: Commit closure**

```bash
git add apps/cli/src/commands/start.test.ts docs/architecture/README.md docs/implementation/v0.1-execution-tracker.md
git commit -m "docs: record skill capability resolution v2"
```

- [ ] **Step 8: Integration/live acceptance after PR merge**

After exact-head CI and merge:
- fast-forward canonical `main`;
- build/stage/restart installed service from canonical main;
- reopen `/home/sauron/dev/kodegpt` as the existing `trusted` workspace;
- call live `skill.list` to locate `find-skills`;
- call live `skill.inspect` with that skill ID plus the READY `workspaceId`;
- require static compatibility `PARTIAL`, effective `capabilityPlan.classification === "NATIVE"`, `external-cli:npx` status `available`, and `process.run` guidance;
- verify health/audit/filesystem boundary and surface `0.7` remain healthy.
