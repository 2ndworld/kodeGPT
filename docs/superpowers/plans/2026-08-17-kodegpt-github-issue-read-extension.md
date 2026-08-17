# KodeGPT GitHub Issue Read Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing production `github.read.v1` Provider Gateway adapter with bounded internal `github.issue.inspect` and `github.issue.list` semantics without adding public MCP surface or write authority.

**Architecture:** Modify the existing GitHub adapter in place. Reuse its repository validation, fixed GitHub origin/headers, credential broker, transport, mapping/output normalization, registry, and Provider Gateway service; add only two GET operations, two strict input/output mapping contracts, and focused documentation/tests. `issue.inspect` rejects provider objects containing `pull_request`; `issue.list` filters those objects and never performs refill pagination.

**Tech Stack:** TypeScript 5.9, Zod, Vitest 3.2, Node >=24, pnpm 10.15, existing KodeGPT Provider Gateway.

## Global Constraints

- Runtime version remains `0.1`.
- MCP protocol remains `2026-07-28`.
- MCP surface remains `0.7`.
- Public MCP tool count remains exactly `51`.
- Production provider adapter remains exactly `github.read.v1`; no second manifest.
- Add exactly `github.issue.inspect` and `github.issue.list` as internal `REMOTE_READ` mappings.
- GitHub origin remains exactly `https://api.github.com`; redirects remain denied.
- Existing external-helper bearer flow remains unchanged: admitted `gh` helper with argv `auth token`.
- `issue.list.state`: `open|closed|all`, default `open`.
- `issue.list.limit`: integer `1..50`, default `30`.
- Each new mapping uses `maxProviderRequests: 1`, `retry: none`, `workspaceBinding: NONE`.
- No mutation, generic `provider.invoke`, public `provider.*`, OAuth/device flow, native credential store, GitHub Enterprise, GraphQL, SDK, generic pagination/cache/background framework, or Remote-CI migration.

## File Structure

- Modify `packages/capabilities/src/provider-gateway/github.ts`: all GitHub adapter-local schemas, encoders, raw→semantic mappings, manifest operations/mappings, and implementation digest descriptor.
- Modify `packages/capabilities/src/provider-gateway/github.test.ts`: focused TDD contract, request encoding, transport, normalization, PR filtering/rejection, and HTTP mapping coverage.
- Modify `packages/capabilities/src/provider-gateway/adapter-registry.test.ts`: production mapping inventory changes from three to five semantic IDs.
- Modify `tests/integration/provider-gateway.test.ts`: lock production adapter mapping inventory while preserving 51-tool/MCP 0.7 assertions.
- Modify `docs/architecture/README.md`: current-state adapter scope becomes five internal semantics while preserving PR #17 history.
- Modify `docs/implementation/v0.1-execution-tracker.md`: append/reconcile current GitHub issue-read extension status without rewriting historical PR #17 chronology.
- Modify `.ai-bridge/current-plan.md`: coordination-only status update after implementation is actually verified.

---

### Task 1: RED — Lock the five-operation GitHub adapter contract

**Files:**
- Modify: `packages/capabilities/src/provider-gateway/github.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/adapter-registry.test.ts`

**Interfaces:**
- Consumes: existing `GITHUB_READ_PROVIDER_MANIFEST`, `DefaultProviderNetworkTransport`, `parseProviderSemanticOutput`.
- Produces: failing tests that define `issue.inspect`, `issue.list`, their exact inputs/outputs, and production registry expectations before source implementation exists.

- [ ] **Step 1: Expand manifest and registry expectations to five operations/mappings**

In `github.test.ts`, change the manifest contract test so the expected operations are exactly:

```ts
[
  ["repository.inspect", "GET", "/repos/{owner}/{repo}"],
  ["pr.inspect", "GET", "/repos/{owner}/{repo}/pulls/{number}"],
  ["pr.list", "GET", "/repos/{owner}/{repo}/pulls"],
  ["issue.inspect", "GET", "/repos/{owner}/{repo}/issues/{number}"],
  ["issue.list", "GET", "/repos/{owner}/{repo}/issues"]
]
```

and the semantic IDs are exactly:

```ts
[
  "github.repository.inspect",
  "github.pr.inspect",
  "github.pr.list",
  "github.issue.inspect",
  "github.issue.list"
]
```

In `adapter-registry.test.ts`, update the production manifest mapping list to the same five semantic IDs and add direct `requireMapping` assertions for both new issue mappings.

- [ ] **Step 2: Add RED input/default/authority tests**

Add tests equivalent to:

```ts
const inspect = mapping("github.issue.inspect").inputSchema;
expect(inspect.safeParse({ repository: REPOSITORY, number: 1 }).success).toBe(true);
for (const number of [0, -1, 1.5, 2_147_483_648]) {
  expect(inspect.safeParse({ repository: REPOSITORY, number }).success).toBe(false);
}

const list = mapping("github.issue.list").inputSchema;
expect(list.parse({ repository: REPOSITORY })).toEqual({
  repository: REPOSITORY,
  state: "open",
  limit: 30
});
expect(list.safeParse({ repository: REPOSITORY, state: "closed", limit: 1 }).success).toBe(true);
expect(list.safeParse({ repository: REPOSITORY, state: "all", limit: 50 }).success).toBe(true);
expect(list.safeParse({ repository: REPOSITORY, state: "draft" }).success).toBe(false);
expect(list.safeParse({ repository: REPOSITORY, limit: 0 }).success).toBe(false);
expect(list.safeParse({ repository: REPOSITORY, limit: 51 }).success).toBe(false);
```

Extend the existing `AUTHORITY_FIELDS` loop with valid issue inspect/list examples so `url`, `origin`, `path`, `method`, `query`, `headers`, `authorization`, `token`, `graphql`, and `command` remain rejected.

- [ ] **Step 3: Add RED request encoding and fixed-transport tests**

Add encoder assertions:

```ts
expect(operation("issue.inspect").encodeRequest({ repository: REPOSITORY, number: 7 })).toEqual({
  pathParameters: { owner: "2ndworld", repo: "kodeGPT", number: "7" }
});
expect(operation("issue.list").encodeRequest({ repository: REPOSITORY, state: "all", limit: 17 })).toEqual({
  pathParameters: { owner: "2ndworld", repo: "kodeGPT" },
  query: { state: "all", per_page: 17 }
});
```

Extend the existing transport call collection so the new paths are exactly:

```text
/repos/2ndworld/kodeGPT/issues/7
/repos/2ndworld/kodeGPT/issues?state=all&per_page=17
```

and the same fixed headers and internal bearer injection are observed.

- [ ] **Step 4: Add RED raw issue fixtures and semantic mapping tests**

Add a local helper in `github.test.ts`:

```ts
function rawIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    title: "Issue read extension",
    state: "open",
    user: { login: "octocat" },
    html_url: "https://github.com/2ndworld/kodeGPT/issues/7",
    created_at: "2026-08-17T01:00:00Z",
    updated_at: "2026-08-17T02:00:00Z",
    closed_at: null,
    comments: 3,
    labels: [{ name: "provider" }, { name: "read-only" }],
    assignees: [{ login: "octocat" }, { login: "hubot" }],
    body: "must not leak",
    authorization: "must not leak",
    ...overrides
  };
}
```

Assert inspect maps only reviewed fields:

```ts
expect(parseSemanticOutput(
  "github.issue.inspect",
  { repository: REPOSITORY, number: 7 },
  rawIssue()
)).toEqual({
  repository: REPOSITORY,
  number: 7,
  title: "Issue read extension",
  state: "open",
  authorLogin: "octocat",
  htmlUrl: "https://github.com/2ndworld/kodeGPT/issues/7",
  createdAt: "2026-08-17T01:00:00Z",
  updatedAt: "2026-08-17T02:00:00Z",
  closedAt: null,
  commentsCount: 3,
  labels: ["provider", "read-only"],
  assigneeLogins: ["octocat", "hubot"]
});
```

Also assert the serialized result contains neither `body` nor `authorization`.

- [ ] **Step 5: Add RED PR rejection/filtering and bounds tests**

Add these behaviors:

```ts
expect(() => parseSemanticOutput(
  "github.issue.inspect",
  { repository: REPOSITORY, number: 7 },
  rawIssue({ pull_request: { url: "https://api.github.com/repos/2ndworld/kodeGPT/pulls/7" } })
)).toThrowError(expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID" }));

const listValue = parseSemanticOutput(
  "github.issue.list",
  { repository: REPOSITORY, state: "all", limit: 3 },
  [
    rawIssue(),
    rawIssue({ number: 8, html_url: "https://github.com/2ndworld/kodeGPT/pull/8", pull_request: { url: "x" } }),
    rawIssue({ number: 9, title: "Second issue", html_url: "https://github.com/2ndworld/kodeGPT/issues/9" })
  ]
);
expect((listValue as { items: unknown[] }).items).toHaveLength(2);
```

Add tests that list responses larger than requested `limit` fail, and that 21 labels or 21 assignees cause `PROVIDER_RESPONSE_INVALID` while exactly 20 are accepted.

- [ ] **Step 6: Add RED HTTP error coverage for new issue operation**

Using `DefaultProviderNetworkTransport` with the production manifest and `issue.inspect`, assert existing mappings are reused:

```ts
await expect(runIssueStatus(404)).rejects.toMatchObject({ code: "PROVIDER_REQUEST_FAILED" });
await expect(runIssueStatus(401)).rejects.toMatchObject({ code: "PROVIDER_CREDENTIAL_REJECTED" });
await expect(runIssueStatus(429)).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
```

The helper must use the fixed `issue.inspect` operation, a bearer credential, and the existing request budget; it must not create a new status mapper.

- [ ] **Step 7: Run focused tests and confirm RED**

Run:

```bash
pnpm exec vitest run packages/capabilities/src/provider-gateway/github.test.ts packages/capabilities/src/provider-gateway/adapter-registry.test.ts --no-file-parallelism
```

Expected: FAIL because `github.issue.inspect` / `github.issue.list` operations and mappings do not yet exist and the registry still exposes only three GitHub semantics.

---

### Task 2: GREEN — Implement issue schemas, encoders, mappings, and digest identity

**Files:**
- Modify: `packages/capabilities/src/provider-gateway/github.ts`

**Interfaces:**
- Consumes: existing `RepositorySchema`, repository splitter, fixed headers, `ProviderEncodedRequest`, `ProviderAdapterManifest`, and Provider Gateway `mapOutput` normalization behavior.
- Produces: manifest operations `issue.inspect` / `issue.list` and semantic mappings `github.issue.inspect` / `github.issue.list`.

- [ ] **Step 1: Add issue constants and input schemas**

Reuse the PR numeric/list bounds rather than introduce new policy values:

```ts
const GITHUB_ISSUE_NUMBER_MAX = GITHUB_PR_NUMBER_MAX;
const GITHUB_ISSUE_LIST_LIMIT_MAX = GITHUB_PR_LIST_LIMIT_MAX;
const GITHUB_ISSUE_LABELS_MAX = 20;
const GITHUB_ISSUE_ASSIGNEES_MAX = 20;
const GITHUB_ISSUE_LABEL_NAME_MAX = 255;

const IssueInspectInputSchema = z.object({
  repository: RepositorySchema,
  number: z.number().int().min(1).max(GITHUB_ISSUE_NUMBER_MAX)
}).strict();

const IssueListInputSchema = z.object({
  repository: RepositorySchema,
  state: z.enum(["open", "closed", "all"]).default("open"),
  limit: z.number().int().min(1).max(GITHUB_ISSUE_LIST_LIMIT_MAX).default(30)
}).strict();
```

- [ ] **Step 2: Add strict selected raw issue schema**

Define reviewed fields only, including an explicit optional `pull_request` marker:

```ts
const RawIssueSchema = z.object({
  number: z.number().int().min(1).max(GITHUB_ISSUE_NUMBER_MAX),
  title: GitHubTitleSchema,
  state: z.enum(["open", "closed"]),
  user: z.object({ login: GitHubLoginSchema }).nullable(),
  html_url: GitHubUrlSchema,
  created_at: GitHubTimestampSchema,
  updated_at: GitHubTimestampSchema,
  closed_at: GitHubTimestampSchema.nullable(),
  comments: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  labels: z.array(z.object({ name: z.string().max(GITHUB_ISSUE_LABEL_NAME_MAX) })).max(GITHUB_ISSUE_LABELS_MAX),
  assignees: z.array(z.object({ login: GitHubLoginSchema })).max(GITHUB_ISSUE_ASSIGNEES_MAX),
  pull_request: z.unknown().optional()
});

const RawIssueListSchema = z.array(RawIssueSchema).max(GITHUB_ISSUE_LIST_LIMIT_MAX);
```

Do not call `.strict()` on raw GitHub objects; the existing adapter intentionally selects reviewed fields from larger provider payloads. Final semantic output schemas remain strict.

- [ ] **Step 3: Add strict semantic output schemas**

Create one shared issue item schema and use it for inspect/list:

```ts
const IssueItemOutputSchema = z.object({
  number: z.number().int().min(1).max(GITHUB_ISSUE_NUMBER_MAX),
  title: GitHubTitleSchema,
  state: z.enum(["open", "closed"]),
  authorLogin: GitHubLoginSchema.nullable(),
  htmlUrl: GitHubUrlSchema,
  createdAt: GitHubTimestampSchema,
  updatedAt: GitHubTimestampSchema,
  closedAt: GitHubTimestampSchema.nullable(),
  commentsCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  labels: z.array(z.string().max(GITHUB_ISSUE_LABEL_NAME_MAX)).max(GITHUB_ISSUE_LABELS_MAX),
  assigneeLogins: z.array(GitHubLoginSchema).max(GITHUB_ISSUE_ASSIGNEES_MAX)
}).strict();

const IssueInspectOutputSchema = IssueItemOutputSchema.extend({
  repository: RepositorySchema
}).strict();

const IssueListOutputSchema = z.object({
  repository: RepositorySchema,
  items: z.array(IssueItemOutputSchema).max(GITHUB_ISSUE_LIST_LIMIT_MAX)
}).strict();
```

- [ ] **Step 4: Add request encoders**

```ts
function encodeIssueInspect(input: unknown): ProviderEncodedRequest {
  const parsed = IssueInspectInputSchema.parse(input);
  return {
    pathParameters: {
      ...repositoryParts(parsed.repository),
      number: String(parsed.number)
    }
  };
}

function encodeIssueList(input: unknown): ProviderEncodedRequest {
  const parsed = IssueListInputSchema.parse(input);
  return {
    pathParameters: repositoryParts(parsed.repository),
    query: { state: parsed.state, per_page: parsed.limit }
  };
}
```

- [ ] **Step 5: Add mapping functions with explicit PR semantics**

Use one small helper:

```ts
function mapIssueItem(raw: z.infer<typeof RawIssueSchema>) {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    authorLogin: raw.user?.login ?? null,
    htmlUrl: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at,
    commentsCount: raw.comments,
    labels: raw.labels.map(({ name }) => name),
    assigneeLogins: raw.assignees.map(({ login }) => login)
  };
}
```

Inspect must reject PR marker presence:

```ts
function mapIssueInspect(providerValue: unknown, semanticInput: unknown): unknown {
  const input = IssueInspectInputSchema.parse(semanticInput);
  const raw = RawIssueSchema.parse(providerValue);
  if (raw.number !== input.number) throw new Error("GitHub issue identity mismatch");
  if (raw.pull_request !== undefined) throw new Error("GitHub issue semantic resolved to pull request");
  return { repository: input.repository, ...mapIssueItem(raw) };
}
```

List must check provider length before filtering, then filter PRs:

```ts
function mapIssueList(providerValue: unknown, semanticInput: unknown): unknown {
  const input = IssueListInputSchema.parse(semanticInput);
  const raw = RawIssueListSchema.parse(providerValue);
  if (raw.length > input.limit) throw new Error("GitHub issue list exceeded requested limit");
  return {
    repository: input.repository,
    items: raw.filter((item) => item.pull_request === undefined).map(mapIssueItem)
  };
}
```

- [ ] **Step 6: Add operations/mappings and change implementation identity**

Append operations:

```ts
{
  id: "issue.inspect",
  method: "GET",
  origin: GITHUB_API_ORIGIN,
  pathTemplate: "/repos/{owner}/{repo}/issues/{number}",
  allowedQueryKeys: [],
  fixedHeaders: FIXED_HEADERS,
  inputSchema: IssueInspectInputSchema,
  encodeRequest: encodeIssueInspect
},
{
  id: "issue.list",
  method: "GET",
  origin: GITHUB_API_ORIGIN,
  pathTemplate: "/repos/{owner}/{repo}/issues",
  allowedQueryKeys: ["state", "per_page"],
  fixedHeaders: FIXED_HEADERS,
  inputSchema: IssueListInputSchema,
  encodeRequest: encodeIssueList
}
```

Append mappings using `REMOTE_READ`, `NONE`, `maxProviderRequests: 1`, `retry: "none"`, `auditFields: ["repository", "number"]` for inspect and `["repository", "state", "limit"]` for list.

Update `IMPLEMENTATION_DESCRIPTOR` to include both operations and semantic IDs and increment:

```ts
schemaRevision: 2,
normalizerRevision: 2,
```

Keep `adapterId` and `adapterContractVersion` unchanged.

- [ ] **Step 7: Run focused tests and confirm GREEN**

Run:

```bash
pnpm exec vitest run packages/capabilities/src/provider-gateway/github.test.ts packages/capabilities/src/provider-gateway/adapter-registry.test.ts --no-file-parallelism
```

Expected: PASS.

- [ ] **Step 8: Commit the adapter feature**

```bash
git add packages/capabilities/src/provider-gateway/github.ts packages/capabilities/src/provider-gateway/github.test.ts packages/capabilities/src/provider-gateway/adapter-registry.test.ts
git commit -m "feat: add github issue read semantics"
```

---

### Task 3: Lock integration/public-surface invariants and current documentation

**Files:**
- Modify: `tests/integration/provider-gateway.test.ts`
- Modify: `docs/architecture/README.md`
- Modify: `docs/implementation/v0.1-execution-tracker.md`
- Modify: `.ai-bridge/current-plan.md`

**Interfaces:**
- Consumes: final production manifest from Task 2.
- Produces: explicit integration assertion that the sole production adapter has exactly five mappings while MCP surface remains unchanged, plus accurate current-state docs.

- [ ] **Step 1: Strengthen integration inventory assertion**

In the existing test that locks one production adapter and zero MCP expansion, add:

```ts
expect(PRODUCTION_PROVIDER_MANIFESTS[0]?.mappings.map(({ semanticCapabilityId }) => semanticCapabilityId)).toEqual([
  "github.repository.inspect",
  "github.pr.inspect",
  "github.pr.list",
  "github.issue.inspect",
  "github.issue.list"
]);
```

Leave these existing assertions unchanged:

```ts
expect(PRODUCTION_PROVIDER_MANIFESTS.map(({ adapterId }) => adapterId)).toEqual(["github.read.v1"]);
expect(MCP_SURFACE_VERSION).toBe("0.7");
expect(names).toHaveLength(51);
expect(names.some((name) => name.startsWith("provider."))).toBe(false);
```

- [ ] **Step 2: Run integration/security acceptance tests before docs**

Run:

```bash
pnpm exec vitest run tests/integration/provider-gateway.test.ts tests/security/security-invariants.test.ts --no-file-parallelism
```

Expected: PASS after Task 2; no public surface or security invariant regression.

- [ ] **Step 3: Update current architecture documentation**

In `docs/architecture/README.md`, change only current-state wording that says `github.read.v1` has three mappings. State that the adapter now has five internal read-only semantics, listing the two new issue semantics. Keep PR #17 historical text explicitly describing the original three-operation adapter at merge time.

- [ ] **Step 4: Update execution tracker without rewriting history**

In `docs/implementation/v0.1-execution-tracker.md`:

- preserve the PR #17 completion entry as the historical three-semantic milestone;
- add a dated post-PR #17 entry for the GitHub Issue Read Extension with `github.issue.inspect` and `github.issue.list`;
- state that no MCP surface, credential authority, provider count, or write authority changed;
- record final verification counts only after Task 4 supplies them.

- [ ] **Step 5: Reconcile `.ai-bridge/current-plan.md` as execution coordination**

Change the backlog state from design/implementation pending to implemented-and-verifying only after focused tests are green. Preserve its statement that `docs/` remains canonical authority.

- [ ] **Step 6: Commit integration/docs change**

```bash
git add tests/integration/provider-gateway.test.ts docs/architecture/README.md docs/implementation/v0.1-execution-tracker.md .ai-bridge/current-plan.md
git commit -m "docs: record github issue read extension"
```

---

### Task 4: Full verification, diff review, and final closure commit if needed

**Files:**
- Review: all files changed since the feature branch point.
- Modify only if verification reveals a scoped defect or documentation needs exact final counts.

**Interfaces:**
- Consumes: Tasks 1–3 feature implementation.
- Produces: evidence that acceptance criteria are met and a clean committed branch.

- [ ] **Step 1: Run focused GitHub/provider tests fresh**

```bash
pnpm exec vitest run packages/capabilities/src/provider-gateway/github.test.ts packages/capabilities/src/provider-gateway/adapter-registry.test.ts packages/capabilities/src/provider-gateway/network-transport.test.ts packages/capabilities/src/provider-gateway/service.test.ts tests/integration/provider-gateway.test.ts tests/security/security-invariants.test.ts --no-file-parallelism
```

Expected: all PASS.

- [ ] **Step 2: Run the full JavaScript/TypeScript suite**

```bash
pnpm test
```

Expected: all PASS. Record exact test-file and test counts from Vitest output.

- [ ] **Step 3: Run typecheck and build**

```bash
pnpm run typecheck
pnpm run build
```

Expected: both exit 0.

- [ ] **Step 4: Run Rust workspace tests**

```bash
pnpm run test:rust
```

Expected: all PASS; no runtime/security regression.

- [ ] **Step 5: Run forbidden/package/acceptance checks**

```bash
pnpm run verify:forbidden
pnpm run verify:package
pnpm run test:acceptance
```

Expected: all exit 0; acceptance remains green with MCP surface `0.7` and 51 tools.

- [ ] **Step 6: Review the complete diff**

Use CodexPro `show_changes`/`git_diff`, not shell `git diff`. Verify specifically:

```text
only github.read.v1 expanded
only GET operations added
no provider.* MCP tools
no mutation method/endpoint
no new dependency/SDK
no credential/network-policy widening
no pagination/refill loop
PRs filtered from issue.list
PR payload rejected by issue.inspect
implementationDigest descriptor changed
historical PR #17 chronology preserved
```

- [ ] **Step 7: Update tracker with exact verification evidence if not already present**

Write the exact focused/full test counts and successful verification command set into the new post-PR #17 issue-extension tracker entry. Do not fabricate counts before commands run.

- [ ] **Step 8: Commit any final evidence-only correction**

If Task 7 changed tracked docs:

```bash
git add docs/implementation/v0.1-execution-tracker.md .ai-bridge/current-plan.md
git commit -m "docs: close github issue read verification"
```

If no files changed, do not create an empty commit.

- [ ] **Step 9: Confirm clean final state and report exact HEAD**

Use CodexPro `git_status` after all commits. Report:

```text
branch/worktree
exact HEAD
focused test result/count
full test result/count
Rust result
 typecheck/build
forbidden/package/acceptance
diff review outcome
remaining deferred scope
```

Do not push, open a PR, or merge unless explicitly requested separately.
