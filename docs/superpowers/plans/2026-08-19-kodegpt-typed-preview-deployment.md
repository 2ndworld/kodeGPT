# KodeGPT Typed Preview Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exactly `deploy.preview.create({workspaceId})` and `deploy.preview.inspect({workspaceId, deploymentId})` as a bounded Netlify branch-preview surface at MCP `0.14 / 76 tools`.

**Architecture:** Reuse one existing `ProviderGatewayRuntime`, READY workspace Git identity, `git.changes`, and the existing network/credential/audit/no-retry authority. Add one static `netlify.deploy.v1` manifest and one narrow deployment tool adapter; extract the hardened GitHub remote resolver so Remote-CI and deployment share repository identity logic instead of duplicating it.

**Tech Stack:** TypeScript, Zod, Vitest, existing KodeGPT Provider Gateway, MCP server, WorkspaceManager, pnpm monorepo, Rust runtime verification.

**Spec:** `docs/superpowers/specs/2026-08-19-kodegpt-typed-preview-deployment-design.md`

## Global Constraints

- Public tools are exactly `deploy.preview.create` and `deploy.preview.inspect`; do not add `deploy.preview.logs`.
- Target stays `runtime 0.1 / protocol 2026-07-28 / surface 0.14 / 76 tools`.
- Provider adapter is exactly `netlify.deploy.v1`; do not add Cloudflare/Vercel or a generic deployment abstraction.
- No generic HTTP, `provider.invoke`, caller provider/site/token/branch/SHA input, database, queue, supervisor, polling worker, or automatic mutation retry.
- Create must derive repository/branch/head OID and require clean, non-truncated checkpoint before provider mutation.
- Create mapping is `REMOTE_MUTATION`, `workspaceBinding:"REQUIRED"`, one request, `retry:"none"`; proof failure after response must reuse `PROVIDER_MUTATION_OUTCOME_UNKNOWN`.
- Inspect is one bounded typed `REMOTE_READ` and exposes no raw provider response.
- Provider non-secret config is strict `{siteId, repository, productionBranch}`; credentials remain JIT through the existing credential helper broker with fixed helper argv `['token']`.
- Preserve all existing Remote-CI repository-resolution behavior and tests.
- Do not change Phase 3 behavior except surface-version fixtures that necessarily move from 0.13/74 to 0.14/76.

---

### Task 1: Shared GitHub Repository Identity Resolver

**Files:**
- Create: `packages/capabilities/src/github-repository-identity.ts`
- Modify: `packages/capabilities/src/remote-ci/repository-resolver.ts`
- Modify: `packages/capabilities/src/index.ts`
- Test: `packages/capabilities/src/github-repository-identity.test.ts`
- Test: `packages/capabilities/src/remote-ci/repository-resolver.test.ts`

**Interfaces:**
- Consumes: workspace Git remotes shaped as `{name, fetchUrl, pushUrl}`.
- Produces: `resolveGitHubRepositoryIdentity(remotes): {owner, name, fullName, selectedRemote}` and preserves existing `CI_REPOSITORY_UNAVAILABLE` / `CI_REMOTE_UNSUPPORTED` failures.

- [ ] **Step 1: Write failing shared-resolver tests**

```ts
expect(resolveGitHubRepositoryIdentity([
  { name: "origin", fetchUrl: "git@github.com:2ndworld/kodeGPT.git", pushUrl: "git@github.com:2ndworld/kodeGPT.git" }
])).toEqual({ owner: "2ndworld", name: "kodeGPT", fullName: "2ndworld/kodeGPT", selectedRemote: "origin" });
expect(() => resolveGitHubRepositoryIdentity([])).toThrowError(/no Git remote/i);
expect(() => resolveGitHubRepositoryIdentity([
  { name: "one", fetchUrl: "git@github.com:a/one.git", pushUrl: "" },
  { name: "two", fetchUrl: "git@github.com:a/two.git", pushUrl: "" }
])).toThrowError(/ambiguous/i);
```

- [ ] **Step 2: Run RED tests**

Run: `pnpm exec vitest run packages/capabilities/src/github-repository-identity.test.ts packages/capabilities/src/remote-ci/repository-resolver.test.ts --no-file-parallelism`
Expected: FAIL because the shared module/export does not exist.

- [ ] **Step 3: Extract the existing hardened selection/parser without changing semantics**

```ts
export interface GitHubRepositoryIdentity {
  owner: string;
  name: string;
  fullName: string;
  selectedRemote: string;
}

export function resolveGitHubRepositoryIdentity(remotes: readonly GitRepositoryRemote[]): GitHubRepositoryIdentity {
  const remote = selectRemote(remotes);
  const parsed = parseGitHubRemote(remote.fetchUrl);
  if (parsed === null) throw new CapabilityError("CI_REMOTE_UNSUPPORTED", "Git remote is not a supported GitHub repository");
  return { ...parsed, selectedRemote: remote.name };
}
```

Move the current exact URL validation and owner/repository bounds from `remote-ci/repository-resolver.ts` into this file. Make `resolveGitHubRepository` call the shared function and add only workspace/head/branch fields.

- [ ] **Step 4: Run GREEN tests**

Run: `pnpm exec vitest run packages/capabilities/src/github-repository-identity.test.ts packages/capabilities/src/remote-ci/repository-resolver.test.ts --no-file-parallelism`
Expected: PASS with all pre-existing Remote-CI resolver cases unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/github-repository-identity.ts packages/capabilities/src/github-repository-identity.test.ts packages/capabilities/src/remote-ci/repository-resolver.ts packages/capabilities/src/index.ts
git commit -m "refactor: share GitHub repository identity resolution"
```

### Task 2: Static Netlify Deployment Provider Adapter

**Files:**
- Create: `packages/capabilities/src/provider-gateway/netlify-deploy.ts`
- Create: `packages/capabilities/src/provider-gateway/netlify-deploy.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/adapter-registry.ts`
- Modify: `packages/capabilities/src/provider-gateway/index.ts`
- Test: `packages/capabilities/src/provider-gateway/production.test.ts`

**Interfaces:**
- Produces: `NETLIFY_DEPLOY_PROVIDER_ADAPTER_ID`, strict `NetlifyDeployProviderConfigSchema`, internal create/inspect input/result schemas, and `NETLIFY_DEPLOY_PROVIDER_MANIFEST`.
- Semantic IDs: `netlify.deploy.preview.create`, `netlify.deploy.preview.inspect`.

- [ ] **Step 1: Write RED manifest/encoding/output tests**

```ts
expect(NETLIFY_DEPLOY_PROVIDER_MANIFEST.networkPolicy.origins).toEqual(["https://api.netlify.com"]);
expect(NETLIFY_DEPLOY_PROVIDER_MANIFEST.operations.map(x => x.id)).toEqual(["preview.create", "preview.inspect"]);
expect(createMapping).toMatchObject({ effect: "REMOTE_MUTATION", workspaceBinding: "REQUIRED", maxProviderRequests: 1, retry: "none" });
expect(inspectMapping).toMatchObject({ effect: "REMOTE_READ", workspaceBinding: "REQUIRED", maxProviderRequests: 1 });
```

Also assert create encodes `POST /api/v1/sites/{site_id}/builds` with only `branch`, inspect encodes `GET /api/v1/sites/{site_id}/deploys/{deploy_id}`, config rejects extra keys/URL-like site IDs, and create output rejects SHA mismatch.

- [ ] **Step 2: Run RED test**

Run: `pnpm exec vitest run packages/capabilities/src/provider-gateway/netlify-deploy.test.ts --no-file-parallelism`
Expected: FAIL because Netlify adapter does not exist.

- [ ] **Step 3: Implement strict schemas and manifest**

```ts
export const NetlifyDeployProviderConfigSchema = z.object({
  siteId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  repository: GitHubRepositorySchema,
  productionBranch: boundedBranchSchema
}).strict();

export const NETLIFY_DEPLOY_PROVIDER_MANIFEST: ProviderAdapterManifest = {
  adapterId: "netlify.deploy.v1",
  adapterContractVersion: "1",
  implementationDigest: NETLIFY_DEPLOY_IMPLEMENTATION_DIGEST,
  inventoryMode: "STATIC",
  networkPolicy: { kind: "internet", origins: ["https://api.netlify.com"], redirect: null },
  credentialBroker: { kind: "external-helper", credentialKind: "bearer", argv: ["token"], environment: {} },
  operations: [createOperation, inspectOperation],
  mappings: [createMapping, inspectMapping]
};
```

Create `mapOutput` so build `deploy_id` + `sha` must be bounded/full-OID and `sha === expectedHeadOid`; inspect validates requested ID/site and normalizes only approved fields.

- [ ] **Step 4: Admit the manifest and run GREEN tests**

Run: `pnpm exec vitest run packages/capabilities/src/provider-gateway/netlify-deploy.test.ts packages/capabilities/src/provider-gateway/adapter-registry.test.ts packages/capabilities/src/provider-gateway/production.test.ts --no-file-parallelism`
Expected: PASS; production manifest inventory now includes the separate Netlify adapter.

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/provider-gateway/netlify-deploy.ts packages/capabilities/src/provider-gateway/netlify-deploy.test.ts packages/capabilities/src/provider-gateway/adapter-registry.ts packages/capabilities/src/provider-gateway/index.ts packages/capabilities/src/provider-gateway/production.test.ts
git commit -m "feat: add static Netlify deployment adapter"
```

### Task 3: Typed Preview Deployment Orchestration

**Files:**
- Create: `packages/capabilities/src/provider-gateway/netlify-deploy-tool-adapter.ts`
- Create: `packages/capabilities/src/provider-gateway/netlify-deploy-tool-adapter.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/index.ts`

**Interfaces:**
- Produces public strict schemas/types: `DeployPreviewCreateInputSchema`, `DeployPreviewCreateResultSchema`, `DeployPreviewInspectInputSchema`, `DeployPreviewInspectResultSchema`, `DeployPreviewToolAdapter`, `createDeployPreviewToolAdapter(...)`.
- Dependencies: existing `ProviderGatewayRuntime`; repository inspection returning `{headOid, branch, remotes}`; existing `gitChanges(input)`.

- [ ] **Step 1: Write RED orchestration tests for success and every preflight**

```ts
await expect(adapter.create({ workspaceId: "ws_ready" })).resolves.toEqual({
  deploymentId: "deploy_123",
  branch: "feat/typed-preview",
  sourceOid: OID,
  createdAt: "2026-08-19T00:00:00Z"
});
expect(executions).toEqual([{
  semanticCapabilityId: "netlify.deploy.preview.create",
  providerInstanceId: PROVIDER_ID,
  workspaceId: "ws_ready",
  input: { siteId: "site_123", branch: "feat/typed-preview", expectedHeadOid: OID }
}]);
```

Add separate tests proving zero gateway executions for detached HEAD, dirty checkpoint, truncated checkpoint, production branch, repository mismatch, missing provider, disabled provider, multiple enabled providers, and malformed provider config. Add inspect test proving dirty/different revision is allowed while repository/provider binding remains enforced.

- [ ] **Step 2: Run RED test**

Run: `pnpm exec vitest run packages/capabilities/src/provider-gateway/netlify-deploy-tool-adapter.test.ts --no-file-parallelism`
Expected: FAIL because the typed tool adapter does not exist.

- [ ] **Step 3: Implement minimal create/inspect orchestration**

```ts
async create({ workspaceId }) {
  const repo = await dependencies.repository.inspect(workspaceId);
  const github = resolveGitHubRepositoryIdentity(repo.remotes);
  requireAttachedBranchAndOid(repo.branch, repo.headOid);
  const checkpoint = await dependencies.gitChanges({ workspaceId, includePatch: false });
  requireCleanCompleteCheckpoint(checkpoint);
  const { provider, config } = await requireNetlifyProvider(runtime.operator);
  requireRepositoryMatch(github.fullName, config.repository);
  requireNonProductionBranch(repo.branch!, config.productionBranch);
  const execution = await runtime.gateway.execute({ semanticCapabilityId: CREATE_ID, providerInstanceId: provider.providerInstanceId, workspaceId, input: { siteId: config.siteId, branch: repo.branch!, expectedHeadOid: repo.headOid! } });
  return DeployPreviewCreateResultSchema.parse(execution.value);
}
```

Inspect performs no clean/branch/head precondition and sends only admitted `siteId` + caller bounded `deploymentId` through the inspect semantic mapping.

- [ ] **Step 4: Run GREEN orchestration and provider-service mutation-unknown tests**

Run: `pnpm exec vitest run packages/capabilities/src/provider-gateway/netlify-deploy-tool-adapter.test.ts packages/capabilities/src/provider-gateway/service.test.ts packages/capabilities/src/provider-gateway/netlify-deploy.test.ts --no-file-parallelism`
Expected: PASS, including a response-mapping SHA mismatch surfaced by the real gateway as `PROVIDER_MUTATION_OUTCOME_UNKNOWN`.

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities/src/provider-gateway/netlify-deploy-tool-adapter.ts packages/capabilities/src/provider-gateway/netlify-deploy-tool-adapter.test.ts packages/capabilities/src/provider-gateway/index.ts
git commit -m "feat: add typed preview deployment orchestration"
```

### Task 4: Production Stack and MCP Tool Context Wiring

**Files:**
- Modify: `apps/cli/src/commands/start.ts`
- Modify: `apps/cli/src/commands/start.test.ts`
- Modify: `packages/mcp-server/src/tool-context.ts`
- Create/Modify Test: `packages/mcp-server/src/tool-context.deploy.test.ts`

**Interfaces:**
- Consumes: `createDeployPreviewToolAdapter(providerRuntime, deps)` from Task 3.
- Produces: `context.deploy.previewCreate(input)` and `context.deploy.previewInspect(input)` backed by the same provider runtime/workspace/native capability objects already created by production startup.

- [ ] **Step 1: Write RED context/wiring tests**

```ts
expect(await context.deploy.previewCreate({ workspaceId: "ws_ready" })).toEqual(createResult);
expect(await context.deploy.previewInspect({ workspaceId: "ws_ready", deploymentId: "deploy_123" })).toEqual(inspectResult);
```

Production-stack test must assert the deployment adapter receives the existing `providerRuntime`, `workspaceManager.inspectGitRepositoryIdentity`, and `nativeCapabilities.gitChanges`; do not construct another Provider Gateway.

- [ ] **Step 2: Run RED tests**

Run: `pnpm exec vitest run packages/mcp-server/src/tool-context.deploy.test.ts apps/cli/src/commands/start.test.ts --no-file-parallelism`
Expected: FAIL because `deploy` context is absent.

- [ ] **Step 3: Wire one deployment context**

```ts
const deployPreview = createDeployPreviewToolAdapter(providerRuntime, {
  repository: { inspect: (workspaceId) => managers.workspaceManager.inspectGitRepositoryIdentity(workspaceId) },
  gitChanges: (input) => nativeCapabilities.gitChanges(input)
});

const toolContext = createKodegptToolContext({
  ...existing,
  deployPreview
});
```

`createKodegptToolContext` maps that adapter only to `deploy.previewCreate` and `deploy.previewInspect`; unavailable fallback returns `CAPABILITY_NOT_IMPLEMENTED` like other optional contexts.

- [ ] **Step 4: Run GREEN tests**

Run: `pnpm exec vitest run packages/mcp-server/src/tool-context.deploy.test.ts apps/cli/src/commands/start.test.ts --no-file-parallelism`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/start.ts apps/cli/src/commands/start.test.ts packages/mcp-server/src/tool-context.ts packages/mcp-server/src/tool-context.deploy.test.ts
git commit -m "feat: wire typed preview deployment runtime"
```

### Task 5: Public MCP Surface 0.14 / 76 Tools

**Files:**
- Modify: `packages/mcp-server/src/annotations.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/surface-version.ts`
- Modify: `packages/mcp-server/src/server.test.ts`
- Modify: `packages/mcp-server/src/structured-results.test.ts`
- Modify: `tests/integration/provider-gateway.test.ts`
- Modify: `tests/security/security-invariants.test.ts`
- Modify: `tests/integration/mcp-stdio.test.ts`
- Modify: `apps/cli/src/commands/service.ts`
- Modify: `apps/cli/src/commands/service.test.ts`
- Modify: `apps/cli/src/service/runtime-status.ts`
- Modify: `apps/cli/src/service/runtime-status.test.ts`

**Interfaces:**
- Public input create: strict `{workspaceId}` only.
- Public input inspect: strict `{workspaceId, deploymentId}` only.
- Public outputs: Task 3 strict result schemas.

- [ ] **Step 1: Update tests first to demand exactly 76 tools, surface 0.14, strict schemas, and no forbidden deployment authority**

```ts
expect(MCP_SURFACE_VERSION).toBe("0.14");
expect(listSurfaceTools()).toHaveLength(76);
expect(names).toContain("deploy.preview.create");
expect(names).toContain("deploy.preview.inspect");
expect(names).not.toContain("deploy.preview.logs");
expect(names).not.toContain("provider.invoke");
```

Schema tests must reject `siteId`, `providerInstanceId`, `branch`, `sha`, `token`, `url`, and extra properties on create; inspect rejects all extras beyond deploymentId.

- [ ] **Step 2: Run RED MCP/security tests**

Run: `pnpm exec vitest run packages/mcp-server/src/server.test.ts packages/mcp-server/src/structured-results.test.ts tests/integration/provider-gateway.test.ts tests/security/security-invariants.test.ts tests/integration/mcp-stdio.test.ts --no-file-parallelism`
Expected: FAIL on 0.13/74 and missing tools.

- [ ] **Step 3: Register exactly two tools and deployment annotations**

```ts
server.registerTool("deploy.preview.create", {
  description: "Create one Netlify branch preview from the exact clean trusted workspace HEAD.",
  inputSchema: DeployPreviewCreateInputSchema,
  outputSchema: DeployPreviewCreateResultSchema,
  annotations: REMOTE_DEPLOY_CREATE_TOOL_ANNOTATIONS
}, async input => nativeCapabilityResult(async () => DeployPreviewCreateResultSchema.parse(await context.deploy.previewCreate(input))));

server.registerTool("deploy.preview.inspect", {
  description: "Inspect one bounded normalized Netlify preview deployment.",
  inputSchema: DeployPreviewInspectInputSchema,
  outputSchema: DeployPreviewInspectResultSchema,
  annotations: REMOTE_DEPLOY_READ_ONLY_TOOL_ANNOTATIONS
}, async input => nativeCapabilityResult(async () => DeployPreviewInspectResultSchema.parse(await context.deploy.previewInspect(input))));
```

Set `MCP_SURFACE_VERSION = "0.14"`, extend the two manual service-version allowlists to 0.14, and update canonical fixtures from 74 to 76 without changing runtime/protocol.

- [ ] **Step 4: Run GREEN MCP/version/security tests**

Run: `pnpm exec vitest run packages/mcp-server/src/server.test.ts packages/mcp-server/src/structured-results.test.ts tests/integration/provider-gateway.test.ts tests/security/security-invariants.test.ts tests/integration/mcp-stdio.test.ts apps/cli/src/commands/service.test.ts apps/cli/src/service/runtime-status.test.ts --no-file-parallelism`
Expected: PASS at exactly 0.14/76.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/annotations.ts packages/mcp-server/src/tools.ts packages/mcp-server/src/surface-version.ts packages/mcp-server/src/server.test.ts packages/mcp-server/src/structured-results.test.ts tests/integration/provider-gateway.test.ts tests/security/security-invariants.test.ts tests/integration/mcp-stdio.test.ts apps/cli/src/commands/service.ts apps/cli/src/commands/service.test.ts apps/cli/src/service/runtime-status.ts apps/cli/src/service/runtime-status.test.ts
git commit -m "feat: expose typed preview deployment tools"
```

### Task 6: Independent Review, Full Verification, Readiness, PR/Release

**Files:**
- Create: `docs/release/2026-08-19-typed-preview-deployment-readiness.md`
- Modify only findings justified by independent review.

**Interfaces:**
- Consumes exact feature HEAD and all Phase 4 tests/gates.
- Produces review evidence, readiness record, and—only if green—PR/CI/merge/release/live-acceptance progression.

- [ ] **Step 1: Run independent diff review against baseline**

Review exact `5bfcf2e7969a7f1690678340df4b33f3a532883e...HEAD` for scope, auth growth, generic provider/HTTP leakage, source-proof correctness, mutation retry semantics, raw-response leakage, version count, and duplicated Git resolver logic. Any finding gets a failing regression test before a fix.

- [ ] **Step 2: Run focused and full deterministic verification**

Run host-scoped commands (the full-stack fixture intentionally creates its own sandbox):

```bash
pnpm exec vitest run packages/capabilities/src/github-repository-identity.test.ts packages/capabilities/src/provider-gateway/netlify-deploy.test.ts packages/capabilities/src/provider-gateway/netlify-deploy-tool-adapter.test.ts packages/mcp-server/src/tool-context.deploy.test.ts packages/mcp-server/src/server.test.ts tests/security/security-invariants.test.ts --no-file-parallelism
pnpm run test
pnpm run typecheck
pnpm run build
pnpm run verify:forbidden
pnpm run verify:package
cargo fmt --all -- --check
cargo check --workspace
git diff --check 5bfcf2e7969a7f1690678340df4b33f3a532883e...HEAD
```

Expected: all deterministic gates PASS. If the monorepo test exceeds a connector timeout after all tests report pass, split it into bounded host-scoped project/test groups and record terminal exit codes rather than claiming a timed-out run as proof.

- [ ] **Step 3: Write readiness evidence**

Record baseline, exact feature HEAD, changed files, focused/full test totals, typecheck/build/package/forbidden/Rust/diff-check results, authority audit, expected `0.14 / 76`, and whether real Netlify admission/credential exists for live acceptance.

- [ ] **Step 4: Push, open PR, verify exact-head CI, merge only exact accepted head**

Use KodeGPT typed GitHub/CI tools. Do not merge a head that differs from the reviewed/verified SHA. No automatic mutation retry.

- [ ] **Step 5: Release/cutover and live acceptance only when green and externally configured**

Use the established immutable release mechanism on merged main, verify provenance `sourceRevision=<merge SHA>` and `sourceDirty=false`, cut over service, then verify runtime/protocol/surface `0.1 / 2026-07-28 / 0.14` and exactly 76 tools. If a valid admitted Netlify site/helper is present, execute create+inspect on a clean non-production branch and prove returned source OID equals exact HEAD; otherwise record the external acceptance prerequisite without adding mock authority or weakening the design.
