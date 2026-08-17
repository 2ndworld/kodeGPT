# KodeGPT Bounded Typed GitHub PR Write Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exactly `github.pr.create` and guarded `github.pr.merge` as typed public MCP tools backed by a separately admitted `github.write.v1` Provider Gateway adapter.

**Architecture:** Keep `github.read.v1` unchanged and add one new static write adapter with exactly two fixed GitHub API operations. Extend Provider Gateway with an explicit `REMOTE_MUTATION` effect that is single-attempt only and conservatively reports `PROVIDER_MUTATION_OUTCOME_UNKNOWN` after ambiguous post-dispatch failures. Reuse the existing credential broker, network transport, provider registry, durable audit, output normalization, MCP error mapping, and production provider runtime; no generic provider surface or new dependency is introduced.

**Tech Stack:** TypeScript 5.9, Zod, Vitest, Node HTTPS, existing KodeGPT Provider Gateway, MCP server SDK.

## Global Constraints

- Runtime stays `0.1`; MCP protocol stays `2026-07-28`.
- Public MCP surface advances from `0.8` to `0.9` and exact tool count from 56 to 58.
- Add exactly `github.pr.create` and `github.pr.merge`; seven total public `github.*` tools; zero public `provider.*` tools.
- Keep `github.read.v1` behavior and implementation descriptor unchanged.
- Add a separately admitted static adapter `github.write.v1`; no automatic migration/admission from `github.read.v1`.
- Extend effect classes only with `REMOTE_MUTATION` and provider methods only with `PUT` as required by PR merge.
- Every mutation mapping uses `retry: "none"` and `maxProviderRequests: 1`.
- Add `PROVIDER_MUTATION_OUTCOME_UNKNOWN` for ambiguous mutation outcomes; never automatically retry a mutation.
- `github.pr.merge` requires a caller-supplied full lowercase 40- or 64-hex `expectedHeadOid` and always sends it as GitHub's `sha` precondition.
- Merge method is fixed to `merge`; no squash/rebase/merge queue/custom commit message/source-branch deletion.
- No comments, labels, reviewers, PR updates/close, issue mutation, CI mutation, arbitrary REST/GraphQL, generic `provider.invoke`, provider inventory surface, raw credential persistence, or new dependencies.
- Provider admission/enable/reapproval stays local operator CLI authority; MCP callers never select provider instance IDs.
- Full linked-worktree Vitest verification must run on the host because the retained-root KodeGPT sandbox intentionally cannot expose the external common gitdir/cargo path to nested subprocesses; targeted TypeScript tests and typecheck may run through KodeGPT.

---

### Task 1: Extend Provider Gateway with a Single-Attempt Remote Mutation Effect

**Files:**
- Modify: `packages/capabilities/src/provider-gateway/contracts.ts`
- Modify: `packages/capabilities/src/provider-gateway/adapter-registry.ts`
- Modify: `packages/capabilities/src/provider-gateway/adapter-registry.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/contracts.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/service.ts`
- Modify: `packages/capabilities/src/provider-gateway/service.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/network-transport.ts`
- Modify: `packages/capabilities/src/provider-gateway/network-transport.test.ts`

**Interfaces:**
- Consumes: existing `ProviderSemanticMappingDefinition`, `ProviderOperationDefinition`, `ProviderGatewayServiceImpl`, `DefaultProviderNetworkTransport`.
- Produces: `ProviderEffectClass = "REMOTE_READ" | "REMOTE_MUTATION"`, provider method `GET | POST | PUT`, stable error `PROVIDER_MUTATION_OUTCOME_UNKNOWN`, and mutation-safe execution behavior.

- [ ] **Step 1: Write failing contract/validator tests**

Add assertions equivalent to:

```ts
expect(PROVIDER_EFFECT_CLASSES).toEqual(["REMOTE_READ", "REMOTE_MUTATION"]);
expect(PROVIDER_ERROR_CODES).toContain("PROVIDER_MUTATION_OUTCOME_UNKNOWN");
```

Create a fixture mutation mapping:

```ts
{
  semanticCapabilityId: "test.fixture.record.mutate",
  adapterId: "test.fixture.write.v1",
  adapterOperationId: "record.mutate",
  effect: "REMOTE_MUTATION",
  workspaceBinding: "NONE",
  inputSchema: z.object({ id: z.string() }).strict(),
  outputSchema: z.object({ ok: z.literal(true) }).strict(),
  maxProviderRequests: 1,
  retry: "none",
  auditFields: ["id"]
}
```

Prove the registry accepts that exact mutation mapping, but rejects:

```ts
{ ...mutationMapping, retry: "one-idempotent-read" }
{ ...mutationMapping, maxProviderRequests: 2 }
```

Add a fixed operation test proving `method: "PUT"` is accepted while `DELETE`, `PATCH`, or caller-selected methods remain rejected.

- [ ] **Step 2: Run validator tests and confirm RED**

Run:

```bash
pnpm exec vitest run packages/capabilities/src/provider-gateway/contracts.test.ts packages/capabilities/src/provider-gateway/adapter-registry.test.ts packages/capabilities/src/provider-gateway/network-transport.test.ts --no-file-parallelism
```

Expected: FAIL because `REMOTE_MUTATION`, `PUT`, and the new error code are absent.

- [ ] **Step 3: Implement the minimal contract extensions**

Change only the closed enums/types:

```ts
export const PROVIDER_EFFECT_CLASSES = Object.freeze(["REMOTE_READ", "REMOTE_MUTATION"] as const);
```

Add:

```ts
"PROVIDER_MUTATION_OUTCOME_UNKNOWN"
```

to `PROVIDER_ERROR_CODES`, and change the operation method union to:

```ts
method: "GET" | "POST" | "PUT";
```

Update `ProviderHttpsRequestInput` / transport method types to the same fixed union. In `validateMapping`, keep existing read retry behavior and add:

```ts
if (mapping.effect === "REMOTE_MUTATION") {
  if (mapping.retry !== "none") throw invalid("Provider mutation mappings may not retry");
  if (mapping.maxProviderRequests !== 1) throw invalid("Provider mutation mappings must use exactly one request");
}
```

Do not add a generic idempotency/replay abstraction.

- [ ] **Step 4: Write failing gateway mutation-ambiguity tests**

Extend the existing service fixture so a mutation manifest can be selected and transport/audit behavior injected. Tests must prove:

```ts
expect(events).toEqual(["audit-decision", "credential", "transport", "audit-success"]);
```

for success, and:

```ts
await expect(service.execute(mutationInput)).rejects.toMatchObject({
  code: "PROVIDER_MUTATION_OUTCOME_UNKNOWN"
});
expect(transportCalls).toBe(1);
```

for `PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`, and `PROVIDER_CANCELLED` thrown once transport execution has begun.

Also prove:

```ts
// decision audit failure: no credential/network effect
expect(credentialCalls).toBe(0);
expect(transportCalls).toBe(0);

// provider 4xx normalized as PROVIDER_REQUEST_FAILED stays ordinary, not outcome-unknown
expect(error.code).toBe("PROVIDER_REQUEST_FAILED");

// malformed successful response after 2xx becomes outcome-unknown
expect(error.code).toBe("PROVIDER_MUTATION_OUTCOME_UNKNOWN");

// success-audit failure after valid 2xx also becomes outcome-unknown
expect(error.code).toBe("PROVIDER_MUTATION_OUTCOME_UNKNOWN");
```

Read-operation failure/audit expectations must remain unchanged.

- [ ] **Step 5: Run service tests and confirm RED**

Run:

```bash
pnpm exec vitest run packages/capabilities/src/provider-gateway/service.test.ts --no-file-parallelism
```

Expected: FAIL because the gateway still rejects every non-`REMOTE_READ` mapping and has no ambiguity handling.

- [ ] **Step 6: Implement mutation-safe execution with no retry**

In `execute`, allow only the two reviewed effect classes. Track whether a mutation request phase has begun and whether a successful provider response has been received. Preserve the existing read path.

Use one small helper:

```ts
function mutationOutcomeUnknown(): CapabilityError {
  return new CapabilityError(
    "PROVIDER_MUTATION_OUTCOME_UNKNOWN",
    "Provider mutation outcome is unknown; inspect remote state before retrying"
  );
}
```

For a mutation, convert timeout/unavailable/cancelled failures after request execution begins to that error. After a successful provider response, convert any output mapping/fit/success-audit failure to the same error. Attempt a bounded failed audit with the outcome-unknown code, but never replace the public mutation-unknown error with `PROVIDER_AUDIT_UNAVAILABLE` if that outcome audit itself fails.

Keep `#request` unchanged for reads; mutation mappings cannot retry because validator + mapping contract fix `retry:"none"` and request budget 1.

- [ ] **Step 7: Run gateway/registry/transport tests and confirm GREEN**

Run:

```bash
pnpm exec vitest run packages/capabilities/src/provider-gateway/contracts.test.ts packages/capabilities/src/provider-gateway/adapter-registry.test.ts packages/capabilities/src/provider-gateway/network-transport.test.ts packages/capabilities/src/provider-gateway/service.test.ts packages/capabilities/src/provider-gateway/lifecycle.test.ts --no-file-parallelism
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

Stage only Task 1 files and commit:

```text
feat: add bounded provider mutation effect
```

---

### Task 2: Add the Private `github.write.v1` Adapter and Typed Tool Adapter

**Files:**
- Modify: `packages/capabilities/src/provider-gateway/github.ts`
- Create: `packages/capabilities/src/provider-gateway/github-write.ts`
- Create: `packages/capabilities/src/provider-gateway/github-write.test.ts`
- Create: `packages/capabilities/src/provider-gateway/github-write-tool-adapter.ts`
- Create: `packages/capabilities/src/provider-gateway/github-write-tool-adapter.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/adapter-registry.ts`
- Modify: `packages/capabilities/src/provider-gateway/adapter-registry.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/index.ts`
- Modify: `packages/capabilities/src/provider-gateway/production.test.ts` if its exact manifest inventory assertion requires the second production adapter.

**Interfaces:**
- Consumes: shared GitHub repository/title/branch/timestamp/login validation exported from `github.ts`; `ProviderGatewayRuntime.operator` and `.gateway`.
- Produces: `GITHUB_WRITE_PROVIDER_ADAPTER_ID`, `GITHUB_WRITE_PROVIDER_MANIFEST`, `GitHubPrCreateInput/Result`, `GitHubPrMergeInput/Result`, `GitHubWriteToolAdapter`, `createGitHubWriteToolAdapter(runtime)`.

- [ ] **Step 1: Export only reusable validation atoms from the existing read module**

Expose aliases without changing the `GITHUB_READ_PROVIDER_MANIFEST` descriptor, operations, semantics, or digest inputs:

```ts
export const GitHubRepositorySchema = RepositorySchema;
export const GitHubLoginSchema = GitHubLoginSchemaInternal;
export const GitHubBranchSchema = GitHubBranchSchemaInternal;
export const GitHubTitleSchema = GitHubTitleSchemaInternal;
export const GitHubTimestampSchema = GitHubTimestampSchemaInternal;
export const GitHubUrlSchema = GitHubUrlSchemaInternal;
```

If local names collide, rename only the private constants, not the read manifest semantics or descriptor contents.

- [ ] **Step 2: Write failing GitHub write manifest tests**

Define exact desired inputs:

```ts
GitHubPrCreateInputSchema.parse({
  repository: "2ndworld/kodeGPT",
  title: "feat: bounded write",
  headBranch: "feat/bounded-write",
  baseBranch: "main",
  body: "body\r\nline"
});

GitHubPrMergeInputSchema.parse({
  repository: "2ndworld/kodeGPT",
  number: 23,
  expectedHeadOid: "a".repeat(40)
});
```

Prove create rejects empty title, body above 16 KiB, control/NUL branch names, cross-repository/arbitrary fields, `draft`, headers/tokens/provider IDs; prove merge rejects missing/uppercase/abbreviated OIDs, `mergeMethod`, `deleteBranch`, provider IDs, endpoint/method/header/token fields.

Assert exact operations:

```ts
expect(createOperation.method).toBe("POST");
expect(createOperation.origin).toBe("https://api.github.com");
expect(createOperation.pathTemplate).toBe("/repos/{owner}/{repo}/pulls");
expect(createOperation.encodeRequest(input).body).toEqual({
  title: input.title,
  head: input.headBranch,
  base: input.baseBranch,
  body: "body\nline"
});

expect(mergeOperation.method).toBe("PUT");
expect(mergeOperation.pathTemplate).toBe("/repos/{owner}/{repo}/pulls/{number}/merge");
expect(mergeOperation.encodeRequest(input).body).toEqual({
  sha: input.expectedHeadOid,
  merge_method: "merge"
});
```

Assert exactly two mappings, both `REMOTE_MUTATION`, request budget 1, retry none.

- [ ] **Step 3: Run GitHub write tests and confirm RED**

Run:

```bash
pnpm exec vitest run packages/capabilities/src/provider-gateway/github-write.test.ts packages/capabilities/src/provider-gateway/adapter-registry.test.ts --no-file-parallelism
```

Expected: FAIL because the write module and second production manifest do not exist.

- [ ] **Step 4: Implement `github-write.ts` with no framework extraction**

Use constants:

```ts
const GITHUB_WRITE_ADAPTER_ID = "github.write.v1";
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_USER_AGENT = "KodeGPT/0.1 Provider-GitHub-Write";
```

Create strict Zod schemas. `body` uses a refinement based on `Buffer.byteLength(value, "utf8") <= 16 * 1024`, rejects NUL, and normalizes CRLF/CR in the encoder. `expectedHeadOid` uses `/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/`.

Create strict raw response schemas for only the fields required by normalized results. Create response mappers that verify repository/PR identity and require merge response `merged === true`; otherwise throw so the gateway treats a successful-but-invalid mutation response as outcome unknown.

Add `GITHUB_WRITE_PROVIDER_MANIFEST` with exactly `pr.create` and `pr.merge`. Add it to `PRODUCTION_PROVIDER_MANIFESTS` alongside the unchanged read manifest.

- [ ] **Step 5: Write failing concrete write-tool adapter tests**

Desired interface:

```ts
export interface GitHubWriteToolAdapter {
  prCreate(input: GitHubPrCreateInput): Promise<GitHubPrCreateResult>;
  prMerge(input: GitHubPrMergeInput): Promise<GitHubPrMergeResult>;
}
```

Prove each method selects exactly one enabled `github.write.v1` provider and calls a fixed semantic ID. Selection failures must match `PROVIDER_NOT_ADMITTED`, `PROVIDER_DISABLED`, and `PROVIDER_STATE_INVALID`. Returned data must be parsed from `result.value`; provider instance/envelope fields are not exposed.

- [ ] **Step 6: Run adapter test and confirm RED**

Run:

```bash
pnpm exec vitest run packages/capabilities/src/provider-gateway/github-write-tool-adapter.test.ts --no-file-parallelism
```

Expected: FAIL because `createGitHubWriteToolAdapter` does not exist.

- [ ] **Step 7: Implement the minimal write-tool adapter and exports**

Mirror the existing read adapter structure, filtering only `GITHUB_WRITE_PROVIDER_ADAPTER_ID`. Do not share a generic adapter selector unless duplication becomes more than the two tiny concrete selectors; YAGNI favors explicit read/write boundaries here.

Export write schemas/types/manifest adapter ID and write tool adapter from `provider-gateway/index.ts` / package exports following the current read pattern.

- [ ] **Step 8: Run all GitHub/provider tests and confirm GREEN**

Run:

```bash
pnpm exec vitest run packages/capabilities/src/provider-gateway/github.test.ts packages/capabilities/src/provider-gateway/github-write.test.ts packages/capabilities/src/provider-gateway/github-tool-adapter.test.ts packages/capabilities/src/provider-gateway/github-write-tool-adapter.test.ts packages/capabilities/src/provider-gateway/adapter-registry.test.ts packages/capabilities/src/provider-gateway/production.test.ts packages/capabilities/src/provider-gateway/service.test.ts --no-file-parallelism
```

Expected: PASS; production manifest IDs exactly `github.read.v1`, `github.write.v1`; read semantics remain five and unchanged.

- [ ] **Step 9: Commit Task 2**

Commit message:

```text
feat: add bounded github write provider
```

---

### Task 3: Expose Exactly Two Typed GitHub Mutation MCP Tools and Surface 0.9

**Files:**
- Modify: `packages/mcp-server/src/annotations.ts`
- Modify: `packages/mcp-server/src/tool-context.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/surface-version.ts`
- Modify: `packages/mcp-server/src/server.test.ts`
- Modify: `packages/mcp-server/src/structured-results.test.ts`
- Modify: `tests/fixtures/mcp-surface.ts`
- Modify: `tests/integration/mcp-conformance.test.ts`
- Modify: `tests/integration/provider-gateway.test.ts`
- Modify: `tests/security/security-invariants.test.ts`

**Interfaces:**
- Consumes: `GitHubReadToolAdapter` plus Task 2 `GitHubWriteToolAdapter` and write schemas.
- Produces: one `KodegptToolContext.github` containing five read + two write methods and exact public MCP surface `0.9` / 58 tools.

- [ ] **Step 1: Change exact surface/security tests first**

Add to locked tool inventory:

```ts
{ name: "github.pr.create", required: ["repository", "title", "headBranch", "baseBranch"] },
{ name: "github.pr.merge", required: ["repository", "number", "expectedHeadOid"] },
```

Assert:

```ts
expect(MCP_SURFACE_VERSION).toBe("0.9");
expect(listSurfaceTools()).toHaveLength(58);
expect(names.filter((name) => name.startsWith("github."))).toEqual([
  "github.issue.inspect",
  "github.issue.list",
  "github.pr.create",
  "github.pr.inspect",
  "github.pr.list",
  "github.pr.merge",
  "github.repository.inspect"
]);
expect(names.some((name) => name.startsWith("provider."))).toBe(false);
```

Structured-result/schema tests must prove unknown caller fields such as `providerInstanceId`, `endpoint`, `method`, `headers`, `token`, `credential`, `mergeMethod`, and `deleteBranch` are rejected.

- [ ] **Step 2: Run MCP/security tests and confirm RED**

Run:

```bash
pnpm exec vitest run packages/mcp-server/src/server.test.ts packages/mcp-server/src/structured-results.test.ts tests/integration/mcp-conformance.test.ts tests/integration/provider-gateway.test.ts tests/security/security-invariants.test.ts --no-file-parallelism
```

Expected: FAIL because the two tools/context/version are absent.

- [ ] **Step 3: Add two explicit mutation annotation constants**

```ts
export const REMOTE_GITHUB_CREATE_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
});

export const REMOTE_GITHUB_MERGE_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
});
```

Do not reuse the local/remote Git mutation annotation if its semantics obscure the create-vs-merge destructive distinction.

- [ ] **Step 4: Extend only the existing GitHub tool context**

Define:

```ts
export interface GitHubToolContext extends GitHubReadToolAdapter, GitHubWriteToolAdapter {}
```

Add optional `githubWrite?: GitHubWriteToolAdapter` to `createKodegptToolContext`, combine read and write adapters into the returned `github` object, and provide unavailable fallbacks for tests that omit write wiring. Do not add `provider` context.

- [ ] **Step 5: Register the two fixed MCP handlers**

Create:

```ts
server.registerTool(
  "github.pr.create",
  {
    description: "Create one bounded GitHub pull request through the separately admitted write provider.",
    inputSchema: GitHubPrCreateInputSchema,
    outputSchema: GitHubPrCreateResultSchema,
    annotations: REMOTE_GITHUB_CREATE_TOOL_ANNOTATIONS
  },
  async (input) => nativeCapabilityResult(async () =>
    GitHubPrCreateResultSchema.parse(await context.github.prCreate(input))
  )
);
```

and the analogous `github.pr.merge` using `GitHubPrMerge*` schemas and merge annotations. Keep all five existing read handlers unchanged.

- [ ] **Step 6: Bump surface and run GREEN tests**

Set:

```ts
export const MCP_SURFACE_VERSION = "0.9" as const;
```

Run:

```bash
pnpm exec vitest run packages/mcp-server/src/server.test.ts packages/mcp-server/src/structured-results.test.ts packages/mcp-server/src/skills.test.ts tests/integration/mcp-conformance.test.ts tests/integration/provider-gateway.test.ts tests/security/security-invariants.test.ts --no-file-parallelism
```

Expected: PASS with exact 58 tools, seven `github.*`, zero `provider.*`.

- [ ] **Step 7: Commit Task 3**

Commit message:

```text
feat(mcp): expose guarded github pr writes
```

---

### Task 4: Production-Wire the Write Adapter Without Startup Mutation

**Files:**
- Modify: `apps/cli/src/commands/start.ts`
- Modify: `apps/cli/src/commands/start.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/production.ts` only if no change is required beyond the production manifest registry; avoid unnecessary runtime abstraction.

**Interfaces:**
- Consumes: existing full `ProviderGatewayRuntime`, `createGitHubReadToolAdapter`, and Task 2 `createGitHubWriteToolAdapter`.
- Produces: production MCP tool context backed by both private GitHub adapters, with no provider admission/execution during startup.

- [ ] **Step 1: Write failing startup wiring assertions**

Keep startup provider operations idle:

```ts
expect(providerExecutions).toEqual([]);
```

Then exercise both tool-context methods through the fake runtime:

```ts
await stack.toolContext.github.prCreate({
  repository: "2ndworld/kodeGPT",
  title: "feat: test",
  headBranch: "feat/test",
  baseBranch: "main"
});
expect(providerExecutions.at(-1)?.semanticCapabilityId).toBe("github.pr.create");
```

and guarded merge:

```ts
await stack.toolContext.github.prMerge({
  repository: "2ndworld/kodeGPT",
  number: 23,
  expectedHeadOid: "a".repeat(40)
});
expect(providerExecutions.at(-1)?.semanticCapabilityId).toBe("github.pr.merge");
```

No `operator.add`, `operator.enable`, or write execution may occur before explicit tool calls.

- [ ] **Step 2: Run startup test and confirm RED**

Run:

```bash
pnpm exec vitest run apps/cli/src/commands/start.test.ts --no-file-parallelism
```

Expected: FAIL because startup injects only `githubRead` today.

- [ ] **Step 3: Inject the concrete write adapter**

Import `createGitHubWriteToolAdapter` and pass:

```ts
githubRead: createGitHubReadToolAdapter(providerRuntime),
githubWrite: createGitHubWriteToolAdapter(providerRuntime)
```

into `createKodegptToolContext`. Do not change provider registry state during startup.

- [ ] **Step 4: Run startup + provider/MCP focused suite and confirm GREEN**

Run:

```bash
pnpm exec vitest run apps/cli/src/commands/start.test.ts packages/capabilities/src/provider-gateway/github-write-tool-adapter.test.ts packages/mcp-server/src/server.test.ts packages/mcp-server/src/structured-results.test.ts tests/integration/provider-gateway.test.ts --no-file-parallelism
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

Commit message:

```text
feat(cli): wire github write surface
```

---

### Task 5: Full Verification, Review, Remote Integration, and Live Dogfood

**Files:**
- Modify docs/tracker only after code gates are green; do not claim merged/deployed status before remote evidence exists.
- Candidate docs: `docs/implementation/v0.1-execution-tracker.md`, `docs/architecture/README.md`, `.ai-bridge/current-plan.md` as appropriate for final closure.

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: reviewed feature branch, exact-head CI evidence, merged/deployed surface 0.9 if all gates pass, and real create -> inspect/CI -> guarded merge evidence.

- [ ] **Step 1: Run focused mutation/provider/MCP/security suite through KodeGPT**

```bash
pnpm exec vitest run packages/capabilities/src/provider-gateway/contracts.test.ts packages/capabilities/src/provider-gateway/adapter-registry.test.ts packages/capabilities/src/provider-gateway/service.test.ts packages/capabilities/src/provider-gateway/network-transport.test.ts packages/capabilities/src/provider-gateway/github.test.ts packages/capabilities/src/provider-gateway/github-write.test.ts packages/capabilities/src/provider-gateway/github-tool-adapter.test.ts packages/capabilities/src/provider-gateway/github-write-tool-adapter.test.ts packages/capabilities/src/provider-gateway/production.test.ts packages/mcp-server/src/server.test.ts packages/mcp-server/src/structured-results.test.ts packages/mcp-server/src/skills.test.ts apps/cli/src/commands/start.test.ts tests/integration/provider-gateway.test.ts tests/integration/mcp-conformance.test.ts tests/security/security-invariants.test.ts --no-file-parallelism
```

- [ ] **Step 2: Run full host gates from the linked worktree**

Run separately with fresh exit-code evidence:

```bash
pnpm typecheck
pnpm build
pnpm test
cargo fmt --all -- --check
cargo test --workspace
pnpm run verify:forbidden
pnpm run verify:package
git diff --check
```

The known KodeGPT retained-root nested-process limitation is not a product failure; full `pnpm test` must be judged from the host run, where the approved baseline is 115/115 files and 779/779 tests before this feature.

- [ ] **Step 3: Review the complete diff defect-first**

Verify:

```text
no provider.* public tools
no generic REST/GraphQL/provider invocation
no automatic provider admission
no mutation retry
no unguarded PR merge
no configurable merge strategy
no source-branch deletion
no raw credential/provider response/audit leakage
no dependency changes
read provider descriptor/semantics unchanged
surface exactly 0.9 / 58 tools / seven github.*
```

Fix every qualifying defect and rerun affected + full gates.

- [ ] **Step 4: Push feature branch and create a normal PR**

Push only `feat/bounded-github-pr-write` without force. Create a PR against `main`, then inspect it using the existing read-only KodeGPT `github.pr.inspect` and observe exact-head CI with `ci.*`.

- [ ] **Step 5: Merge only after exact-head CI is green**

Because the user approved implementation of this phase, merge normally once exact-head PR CI is successful and the diff/review gates are clean. Do not rebase/force/reset. Reconcile canonical `main` by fast-forward/fetch as supported.

- [ ] **Step 6: Build/install candidate merged-main release and admit write provider explicitly**

Use the existing supported package/service lifecycle. Do not auto-admit. Admit exactly one `github.write.v1` provider using the already-established external `/usr/bin/gh` helper identity; keep the existing one enabled `github.read.v1` provider. Verify service health and exact runtime/protocol/surface `0.1 / 2026-07-28 / 0.9`, exact 58-tool registry, seven `github.*`, zero `provider.*`.

- [ ] **Step 7: Real dogfood the new lifecycle**

Use a harmless reviewed branch/PR to exercise:

```text
git push
-> github.pr.create
-> github.pr.inspect
-> ci.status / ci.run until current observed state is available
-> github.pr.merge with exact expectedHeadOid after CI success
-> github.pr.inspect confirms merged=true
```

If any mutation returns `PROVIDER_MUTATION_OUTCOME_UNKNOWN`, do not retry; reconcile via `github.pr.inspect`/list first.

- [ ] **Step 8: Perform leakage/audit/provenance checks and close docs**

Verify provider audit has one decision + bounded outcome per mutation and contains no token/header/raw body/helper stderr/host path. Verify active Node/Rust service provenance remains under immutable installed release root. Update tracker/architecture/current-plan with exact merge commit, CI run, active/rollback release, provider IDs, and live smoke facts only after those facts are observed.

- [ ] **Step 9: Final full verification after docs-only closure changes**

Run at minimum:

```bash
pnpm typecheck
pnpm exec vitest run packages/capabilities/src/provider-gateway packages/mcp-server/src apps/cli/src/commands/start.test.ts tests/integration/provider-gateway.test.ts tests/security/security-invariants.test.ts --no-file-parallelism
pnpm run verify:forbidden
git diff --check
```

If runtime/source changed after the last full gate, rerun the entire Step 2 gate set before completion claims.
