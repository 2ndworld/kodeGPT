# KodeGPT Public Typed GitHub Read Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the five existing `github.read.v1` read semantics as named typed MCP tools without exposing generic Provider Gateway execution or GitHub mutation authority.

**Architecture:** Export the existing strict GitHub semantic schemas, add one concrete adapter that internally selects exactly one enabled admitted `github.read.v1` instance and calls the existing Provider Gateway, then inject only that typed adapter into the MCP tool context. The MCP layer registers five fixed tool names and returns only normalized semantic values. Provider admission remains an operator/deployment action and never happens inside a read tool or at startup.

**Tech Stack:** TypeScript 5.9, Zod, Vitest, existing KodeGPT Provider Gateway, MCP server SDK.

## Global Constraints

- Keep runtime `0.1` and MCP protocol `2026-07-28`.
- Bump public MCP surface `0.7` to `0.8` because five additive public tools are introduced.
- Expose exactly `github.repository.inspect`, `github.pr.inspect`, `github.pr.list`, `github.issue.inspect`, and `github.issue.list`.
- Do not expose any `provider.*` tool or caller-supplied provider instance ID.
- Do not add GitHub write/comment/merge/label/create/update tools.
- Reuse existing GitHub semantic schemas, gateway transport, credential broker, output normalization, response budgets, and durable audit.
- Do not add dependencies, generic pagination/cache abstractions, or automatic provider admission.
- Preserve issue-vs-PR rejection/filtering and list bounds/defaults already implemented by `github.read.v1`.

---

### Task 1: Export the Existing GitHub Contracts and Add the Concrete Read Adapter

**Files:**
- Modify: `packages/capabilities/src/provider-gateway/github.ts`
- Create: `packages/capabilities/src/provider-gateway/github-tool-adapter.ts`
- Create: `packages/capabilities/src/provider-gateway/github-tool-adapter.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/index.ts`

**Interfaces:**
- Consumes: `ProviderGatewayRuntime.operator.list()`, `ProviderGatewayRuntime.gateway.execute(...)`, existing `github.read.v1` semantic schemas.
- Produces: `GitHubReadToolAdapter` with five fixed typed methods and `createGitHubReadToolAdapter(runtime)`.

- [ ] **Step 1: Write failing contract/selection tests**

Test exported schema identity and a concrete adapter whose public-facing methods are exactly:

```ts
interface GitHubReadToolAdapter {
  repositoryInspect(input: GitHubRepositoryInspectInput): Promise<GitHubRepositoryInspectResult>;
  prInspect(input: GitHubPrInspectInput): Promise<GitHubPrInspectResult>;
  prList(input: GitHubPrListInput): Promise<GitHubPrListResult>;
  issueInspect(input: GitHubIssueInspectInput): Promise<GitHubIssueInspectResult>;
  issueList(input: GitHubIssueListInput): Promise<GitHubIssueListResult>;
}
```

Tests must prove:

```ts
expect(await adapter.repositoryInspect({ repository: "2ndworld/kodeGPT" })).toEqual(repositoryValue);
expect(executions[0]).toMatchObject({
  semanticCapabilityId: "github.repository.inspect",
  providerInstanceId: "prv_0123456789abcdef0123456789abcdef",
  input: { repository: "2ndworld/kodeGPT" }
});
```

and selection failures:

```ts
await expect(noProvider.repositoryInspect({ repository: "2ndworld/kodeGPT" }))
  .rejects.toMatchObject({ code: "PROVIDER_NOT_ADMITTED" });
await expect(disabled.repositoryInspect({ repository: "2ndworld/kodeGPT" }))
  .rejects.toMatchObject({ code: "PROVIDER_DISABLED" });
await expect(ambiguous.repositoryInspect({ repository: "2ndworld/kodeGPT" }))
  .rejects.toMatchObject({ code: "PROVIDER_STATE_INVALID" });
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
pnpm exec vitest run packages/capabilities/src/provider-gateway/github-tool-adapter.test.ts --no-file-parallelism
```

Expected: FAIL because the exported public GitHub schemas/tool adapter do not yet exist.

- [ ] **Step 3: Export exact existing schemas/types and implement the adapter**

Expose aliases for the existing strict semantic schemas rather than creating new schemas:

```ts
export const GITHUB_READ_PROVIDER_ADAPTER_ID = GITHUB_ADAPTER_ID;
export const GitHubRepositoryInspectInputSchema = RepositoryInspectInputSchema;
export const GitHubRepositoryInspectResultSchema = RepositoryInspectOutputSchema;
// same pattern for PR inspect/list and issue inspect/list
```

Define `z.infer` input/result types from those aliases. Implement fixed semantic routing and an internal selector:

```ts
async function selectedProviderInstanceId(runtime: Pick<ProviderGatewayRuntime, "operator">): Promise<string> {
  const matching = (await runtime.operator.list()).filter(
    (record) => record.adapterId === GITHUB_READ_PROVIDER_ADAPTER_ID
  );
  if (matching.length === 0) throw new CapabilityError("PROVIDER_NOT_ADMITTED", "GitHub read provider is not admitted");
  const enabled = matching.filter((record) => record.enabled);
  if (enabled.length === 0) throw new CapabilityError("PROVIDER_DISABLED", "GitHub read provider is disabled");
  if (enabled.length !== 1) throw new CapabilityError("PROVIDER_STATE_INVALID", "Multiple enabled GitHub read providers are admitted");
  return enabled[0]!.providerInstanceId;
}
```

Each adapter method calls `gateway.execute` with a fixed semantic ID and parses only `result.value` with the existing output schema.

- [ ] **Step 4: Run adapter + existing GitHub provider tests and confirm GREEN**

Run:

```bash
pnpm exec vitest run packages/capabilities/src/provider-gateway/github-tool-adapter.test.ts packages/capabilities/src/provider-gateway/github.test.ts packages/capabilities/src/provider-gateway/service.test.ts --no-file-parallelism
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/capabilities/src/provider-gateway/github.ts packages/capabilities/src/provider-gateway/github-tool-adapter.ts packages/capabilities/src/provider-gateway/github-tool-adapter.test.ts packages/capabilities/src/provider-gateway/index.ts
git commit -m "feat: add typed github read adapter"
```

---

### Task 2: Add the Five Closed-Schema MCP Tools and Surface 0.8

**Files:**
- Modify: `packages/mcp-server/src/annotations.ts`
- Modify: `packages/mcp-server/src/tool-context.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/surface-version.ts`
- Modify: `packages/mcp-server/src/server.test.ts`
- Modify: `packages/mcp-server/src/structured-results.test.ts`
- Modify: `tests/fixtures/mcp-surface.ts`
- Modify: `tests/integration/mcp-conformance.test.ts` only if its assertions require explicit GitHub coverage
- Modify: `tests/integration/provider-gateway.test.ts`
- Modify: `tests/security/security-invariants.test.ts` if needed for explicit mutation/provider-surface assertions

**Interfaces:**
- Consumes: `GitHubReadToolAdapter` and the ten exported GitHub input/result schemas from Task 1.
- Produces: `KodegptToolContext.github` and five public MCP descriptors/handlers.

- [ ] **Step 1: Change locked surface/tests first**

Update exact surface expectations to include:

```ts
{ name: "github.issue.inspect", required: ["repository", "number"] },
{ name: "github.issue.list", required: ["repository"] },
{ name: "github.pr.inspect", required: ["repository", "number"] },
{ name: "github.pr.list", required: ["repository"] },
{ name: "github.repository.inspect", required: ["repository"] },
```

and assert:

```ts
expect(MCP_SURFACE_VERSION).toBe("0.8");
expect(listSurfaceTools()).toHaveLength(56);
expect(names.filter((name) => name.startsWith("github."))).toEqual([
  "github.issue.inspect",
  "github.issue.list",
  "github.pr.inspect",
  "github.pr.list",
  "github.repository.inspect"
]);
expect(names.some((name) => name.startsWith("provider."))).toBe(false);
```

Add structured-result tests that reject unknown fields including `providerId`, `providerInstanceId`, `workspaceId`, `endpoint`, `method`, `headers`, `token`, and `credential`, and that prove public results contain only normalized semantic values.

- [ ] **Step 2: Run MCP tests and confirm RED**

Run:

```bash
pnpm exec vitest run packages/mcp-server/src/server.test.ts packages/mcp-server/src/structured-results.test.ts tests/integration/mcp-conformance.test.ts tests/integration/provider-gateway.test.ts --no-file-parallelism
```

Expected: FAIL because the new tools/context/version are not implemented.

- [ ] **Step 3: Add one remote GitHub read annotation constant**

Use the existing remote-read semantics without repurposing CI naming:

```ts
export const REMOTE_GITHUB_READ_ONLY_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
});
```

- [ ] **Step 4: Add only a typed GitHub namespace to `KodegptToolContext`**

Define:

```ts
export interface GitHubToolContext extends GitHubReadToolAdapter {}
```

Add `github: GitHubToolContext` to `KodegptToolContext` and optional `githubRead?: GitHubReadToolAdapter` to `createKodegptToolContext(...)`, with an unavailable fallback that raises `CAPABILITY_NOT_IMPLEMENTED` for tests/stacks that do not configure it. Do not add a generic provider context.

- [ ] **Step 5: Register the five fixed tools**

Each descriptor uses the existing input and output schema and remote GitHub read annotations. Handler shape:

```ts
server.registerTool(
  "github.repository.inspect",
  {
    description: "Inspect one bounded normalized GitHub repository through the admitted read-only provider.",
    inputSchema: GitHubRepositoryInspectInputSchema,
    outputSchema: GitHubRepositoryInspectResultSchema,
    annotations: REMOTE_GITHUB_READ_ONLY_TOOL_ANNOTATIONS
  },
  async (input) => nativeCapabilityResult(async () =>
    GitHubRepositoryInspectResultSchema.parse(await context.github.repositoryInspect(input))
  )
);
```

Repeat only for the four remaining fixed methods; no generic helper that accepts a semantic ID from callers.

- [ ] **Step 6: Bump the surface version and update exact fixtures**

```ts
export const MCP_SURFACE_VERSION = "0.8" as const;
```

Ensure the actual registered/snapshot count is exactly 56.

- [ ] **Step 7: Run MCP/security/provider tests and confirm GREEN**

Run:

```bash
pnpm exec vitest run packages/mcp-server/src/server.test.ts packages/mcp-server/src/structured-results.test.ts packages/mcp-server/src/skills.test.ts tests/integration/mcp-conformance.test.ts tests/integration/provider-gateway.test.ts tests/security/security-invariants.test.ts --no-file-parallelism
```

Expected: PASS, with no `provider.*` surface and no GitHub mutation names.

- [ ] **Step 8: Commit Task 2**

```bash
git add packages/mcp-server/src tests/fixtures/mcp-surface.ts tests/integration/mcp-conformance.test.ts tests/integration/provider-gateway.test.ts tests/security/security-invariants.test.ts
git commit -m "feat(mcp): expose typed github read tools"
```

---

### Task 3: Production-Wire the Existing Provider Runtime Without Startup Mutation

**Files:**
- Modify: `apps/cli/src/commands/start.ts`
- Modify: `apps/cli/src/commands/start.test.ts`

**Interfaces:**
- Consumes: full `ProviderGatewayRuntime` and `createGitHubReadToolAdapter` from Task 1.
- Produces: production `KodegptToolContext.github` backed by the already-created provider runtime.

- [ ] **Step 1: Write a failing startup wiring test**

Change the fake `createProviderGateway` return value to include `operator`, `gateway`, and `close`, then assert startup does not call operator/gateway work. Invoke one `stack.toolContext.github.repositoryInspect(...)` call and assert it routes through the fake gateway only at tool invocation time.

Core expectation:

```ts
expect(providerExecutions).toEqual([]);
await stack.toolContext.github.repositoryInspect({ repository: "2ndworld/kodeGPT" });
expect(providerExecutions).toHaveLength(1);
expect(providerExecutions[0]?.semanticCapabilityId).toBe("github.repository.inspect");
```

- [ ] **Step 2: Run startup test and confirm RED**

Run:

```bash
pnpm exec vitest run apps/cli/src/commands/start.test.ts --no-file-parallelism
```

Expected: FAIL because production startup does not yet inject the typed GitHub adapter.

- [ ] **Step 3: Keep the full provider runtime and inject the concrete adapter**

Change the dependency contract from `Pick<ProviderGatewayRuntime, "close">` to `ProviderGatewayRuntime`, keep `providerRuntime` as the full runtime, and pass:

```ts
githubRead: createGitHubReadToolAdapter(providerRuntime)
```

into `createKodegptToolContext`. Do not call `operator.add`, `operator.enable`, or `gateway.execute` during startup.

- [ ] **Step 4: Run startup and focused end-to-end tests**

Run:

```bash
pnpm exec vitest run apps/cli/src/commands/start.test.ts packages/mcp-server/src/server.test.ts packages/mcp-server/src/structured-results.test.ts packages/capabilities/src/provider-gateway/github-tool-adapter.test.ts tests/integration/provider-gateway.test.ts --no-file-parallelism
```

Expected: PASS and startup remains provider-work idle.

- [ ] **Step 5: Commit Task 3**

```bash
git add apps/cli/src/commands/start.ts apps/cli/src/commands/start.test.ts
git commit -m "feat(cli): wire typed github read surface"
```

---

### Task 4: Verification, Diff Review, Push, and PR Preparation

**Files:**
- Review all feature changes.
- Do not mark architecture/tracker `DONE MERGED` until the PR is actually merged.

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: merge-ready feature branch and exact-head CI evidence, without merging.

- [ ] **Step 1: Run focused provider/MCP/integration/security suite**

```bash
pnpm exec vitest run packages/capabilities/src/provider-gateway/github-tool-adapter.test.ts packages/capabilities/src/provider-gateway/github.test.ts packages/capabilities/src/provider-gateway/service.test.ts packages/capabilities/src/provider-gateway/production.test.ts packages/mcp-server/src/server.test.ts packages/mcp-server/src/structured-results.test.ts packages/mcp-server/src/skills.test.ts apps/cli/src/commands/start.test.ts tests/integration/provider-gateway.test.ts tests/integration/mcp-conformance.test.ts tests/security/security-invariants.test.ts --no-file-parallelism
```

- [ ] **Step 2: Run full TypeScript and Rust gates**

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm run verify:forbidden
pnpm run verify:package
cargo test --workspace
git diff --check
```

The CodexPro command timeout must exceed the known ~191 second full Vitest baseline, or the completed Vitest summary must be treated separately from wrapper timeout evidence.

- [ ] **Step 3: Review entire feature diff**

Verify no hidden provider mutation, no generic provider surface, no new dependency, no raw GitHub response/credential leakage, and no write tool. Use `show_changes`/`git_diff`, not shell file inspection.

- [ ] **Step 4: Request a defect-first code review**

Use the repository review workflow against the complete feature diff. Fix every qualifying blocker and rerun affected tests.

- [ ] **Step 5: Push the feature branch and open a PR**

Push `feat/public-typed-github-read-surface`, open a normal PR, and wait for exact-head push/PR CI. Do not merge without explicit user approval.

- [ ] **Step 6: Stop at merge approval gate**

Report exact feature HEAD, test counts, CI IDs/status, surface/tool count, and review findings. The next action after user approval is merge + post-merge closure/live release per the handoff.
