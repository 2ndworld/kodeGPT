# KodeGPT GitHub Read-Only Provider Adapter Implementation Plan

Date: 2026-08-16
Design authority: `docs/superpowers/specs/2026-08-16-kodegpt-github-read-provider-adapter-design.md`
Branch: `feat/github-read-provider-adapter`
Worktree: `/home/sauron/dev/kodegpt/.worktrees/github-read-provider-adapter`
Parent before feature spec: `5fa2866`

## Execution rules

- Follow strict RED → GREEN → REFACTOR for every behavior change.
- Do not add public MCP tools or bump runtime/protocol/surface.
- Keep exactly three semantic operations: `github.repository.inspect`, `github.pr.inspect`, `github.pr.list`.
- Reuse existing Provider Gateway credential, transport, audit, lifecycle, registry, admission, and error taxonomy.
- Do not import Remote-CI runtime code into the adapter.
- Do not add a dependency, SDK, generic HTTP facade, pagination framework, issue support, write operation, or provider plugin framework.
- Before each implementation commit, run the smallest fresh command that proves the task plus package typecheck where applicable.
- Before PR/push, run the complete verification sequence and inspect the exact diff.

---

## Task 1 — Restore the designed raw-provider → semantic-result mapping stage

**Purpose:** The first real REST adapter needs the Provider Gateway design's already-approved two-stage output path: parse bounded provider JSON, then map it into a KodeGPT-owned semantic result. Existing conformance mappings must keep identity behavior.

**Files:**
- Modify: `packages/capabilities/src/provider-gateway/contracts.ts`
- Modify: `packages/capabilities/src/provider-gateway/adapter-registry.ts`
- Modify: `packages/capabilities/src/provider-gateway/output.ts`
- Modify: `packages/capabilities/src/provider-gateway/output.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/service.ts`
- Modify only if required by an existing manifest fixture: the smallest affected Provider Gateway test fixture(s)

### RED

1. Add output-layer tests proving an optional mapper receives decoded provider JSON plus semantic input, selects a bounded semantic result, and that the mapped result is subsequently normalized and validated by the final output schema.
2. Add a test proving mapper exceptions are converted to `PROVIDER_RESPONSE_INVALID` and raw parser/provider exception text is not propagated.
3. Add/extend adapter-registry tests proving `mapOutput`, when present, must be a function, is preserved on the frozen mapping, and existing mappings without it remain valid.
4. Run:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/output.test.ts packages/capabilities/src/provider-gateway/adapter-registry.test.ts
```

Expected RED: compile/test failure because `mapOutput` and the output parser option do not exist yet.

### GREEN

1. Extend `ProviderSemanticMappingDefinition` with:

```ts
mapOutput?: (providerValue: unknown, semanticInput: unknown) => unknown;
```

2. Update mapping validation to allow the optional field while retaining deny-unknown-field behavior for every other mapping field.
3. Freeze/preserve `mapOutput` without changing existing mapping objects' behavior.
4. Extend `parseProviderSemanticOutput` with a small options object containing optional `semanticInput` and `mapOutput`.
5. Keep the response sequence minimal:
   - fatal UTF-8 decode;
   - JSON parse under the existing transport response-byte ceiling;
   - for mappings without `mapOutput`, preserve generic raw structural normalization/bounds;
   - for mappings with `mapOutput`, let the pure mapping-owned strict parser select reviewed provider fields before the generic semantic structural ceiling;
   - generic structural normalization/bounds on the mapped semantic value;
   - final reviewed `outputSchema.safeParse`.
   Real host acceptance later proved this ordering necessary because valid GitHub repository payloads can exceed 1,000 raw structural elements even when the reviewed semantic result is small; do not raise the global semantic ceiling to accommodate irrelevant provider fields.
6. Catch mapper/parser exceptions at this boundary and return generic `PROVIDER_RESPONSE_INVALID`; do not leak raw error text.
7. Pass `mappingInput.data` and `mapping.mapOutput` from `ProviderGatewayServiceImpl.execute`.
8. Do not change network status mapping or provider error taxonomy.

### Verify

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/output.test.ts packages/capabilities/src/provider-gateway/adapter-registry.test.ts packages/capabilities/src/provider-gateway/service.test.ts
pnpm --filter @kodegpt/capabilities typecheck
```

**Commit:** `feat: map provider responses to semantic output`

---

## Task 2 — Add GitHub adapter contract and strict semantic input authority

**Purpose:** Create the one production adapter source file with fixed identity, credential policy, origin, operations, strict inputs, and encoders. Do not register it in production yet so RED/GREEN remains focused.

**Files:**
- Create: `packages/capabilities/src/provider-gateway/github.ts`
- Create: `packages/capabilities/src/provider-gateway/github.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/index.ts` only if package-level test/import ergonomics require export

### RED

Write `github.test.ts` first with tests for:

1. manifest identity:
   - adapter ID `github.read.v1`;
   - contract version `1`;
   - lowercase 64-hex implementation digest;
   - `STATIC` inventory;
   - exact origin `https://api.github.com`;
   - redirect `null`;
   - external-helper bearer policy;
   - fixed argv exactly `auth`, `token`;
   - empty fixed environment;
   - no credential-bearing fixed header.
2. exactly three GET operations with paths:
   - `/repos/{owner}/{repo}`;
   - `/repos/{owner}/{repo}/pulls/{number}`;
   - `/repos/{owner}/{repo}/pulls`.
3. exactly three mappings with semantic IDs:
   - `github.repository.inspect`;
   - `github.pr.inspect`;
   - `github.pr.list`;
   all `REMOTE_READ`, `NONE`, one request, no retry.
4. fixed headers:
   - `Accept: application/vnd.github+json`;
   - `X-GitHub-Api-Version: 2026-03-10`;
   - `User-Agent: KodeGPT/0.1 Provider-GitHub-Read`.
5. repository schema accepts `2ndworld/kodeGPT` and rejects:
   - `https://github.com/2ndworld/kodeGPT`;
   - `2ndworld/kodeGPT/extra`;
   - `../kodeGPT`;
   - `2ndworld/`;
   - `/kodeGPT`;
   - `owner?x/repo`;
   - `owner/repo#x`;
   - leading/trailing whitespace and a control-character case.
6. PR number rejects 0, negative, fraction, `2147483648`, and unsafe integer.
7. PR list defaults to `state=open`, `limit=30`, rejects unknown state and limit outside 1..50.
8. every otherwise-valid semantic input rejects each extra authority key:
   `url`, `uri`, `host`, `hostname`, `origin`, `path`, `method`, `query`, `headers`, `authorization`, `token`, `graphql`, `command`.
9. encoders split `repository` into `owner`/`repo`, convert PR number to a path parameter string, and emit only reviewed list query keys `state` + `per_page`.
10. constructing `ProviderAdapterRegistry([GITHUB_READ_PROVIDER_MANIFEST])` succeeds and an unknown GitHub semantic ID fails with `PROVIDER_TOOL_UNAVAILABLE`.

Run:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/github.test.ts
```

Expected RED: module/exports do not exist.

### GREEN

Implement one compact `github.ts` with:

- constants for adapter ID, origin, API version, accept header, user agent;
- one bounded repository schema/helper;
- three strict semantic input schemas;
- one canonical implementation identity descriptor and SHA-256 digest;
- three compiled operations;
- three mappings referencing those operations;
- no transport/network/process code.

Use the existing operation encoder format only: `pathParameters`, `query`, and no request body.

### Verify

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/github.test.ts packages/capabilities/src/provider-gateway/adapter-registry.test.ts
pnpm --filter @kodegpt/capabilities typecheck
```

**Commit:** `feat: define github read provider adapter`

---

## Task 3 — Normalize selected GitHub REST payloads into KodeGPT semantic results

**Purpose:** Prove the adapter never returns raw GitHub JSON and that the requested repository remains available for empty PR lists.

**Files:**
- Modify: `packages/capabilities/src/provider-gateway/github.ts`
- Modify: `packages/capabilities/src/provider-gateway/github.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/output.ts` only if RED reveals a defect in the Task 1 mapper boundary

### RED

Add tests using real-shaped but bounded GitHub fixtures with extra unreviewed fields and credential-like fields.

1. `github.repository.inspect` raw response maps exactly to:

```text
repository, name, owner, description, private, defaultBranch,
archived, fork, htmlUrl, createdAt, updatedAt, pushedAt
```

2. `github.pr.inspect` raw response maps exactly to:

```text
repository, number, title, state, authorLogin, baseBranch,
headBranch, merged, draft, htmlUrl, createdAt, updatedAt,
closedAt, mergedAt
```

3. `github.pr.list` maps an array to:

```text
repository, items[]
```

with each item containing only the approved summary fields.
4. Empty raw list returns `{ repository: <validated input>, items: [] }`.
5. Raw GitHub extra fields such as body/labels/repository/user detail plus a fake `authorization`/`token` field are absent from final semantic output.
6. Repository/full-name mismatch returns `PROVIDER_RESPONSE_INVALID` through `parseProviderSemanticOutput`.
7. PR number mismatch returns `PROVIDER_RESPONSE_INVALID`.
8. PR list with more items than the semantic `limit` returns `PROVIDER_RESPONSE_INVALID`; the adapter does not silently paginate or truncate provider protocol violations.
9. Nullable deleted author handling returns `authorLogin: null`.

Run:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/github.test.ts packages/capabilities/src/provider-gateway/output.test.ts
```

Expected RED: GitHub mappings do not yet define raw→semantic normalization and final output schemas.

### GREEN

In `github.ts`:

1. define small selected-field raw GitHub schemas; allow external GitHub payloads to contain unrelated extra fields only so Zod discards them before mapping;
2. define strict final semantic output schemas;
3. implement three pure `mapOutput` functions;
4. case-insensitively validate response repository identity against validated semantic input;
5. validate exact PR number for inspect;
6. validate every PR list base repository and item count against requested limit;
7. construct fresh semantic objects only from reviewed fields;
8. keep all text/collection bounds small enough to remain below generic Provider Gateway ceilings.

### Verify

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/github.test.ts packages/capabilities/src/provider-gateway/output.test.ts packages/capabilities/src/provider-gateway/service.test.ts
pnpm --filter @kodegpt/capabilities typecheck
```

**Commit:** `feat: normalize github provider responses`

---

## Task 4 — Prove compiled GitHub requests use existing transport authority and credential injection

**Purpose:** Demonstrate the production adapter cannot escape the existing Provider Gateway request boundary and does not carry credentials itself.

**Files:**
- Modify: `packages/capabilities/src/provider-gateway/github.test.ts`
- Modify generic transport source only if a new test demonstrates an actual defect; otherwise leave it unchanged

### RED

Using `DefaultProviderNetworkTransport` with the existing injectable DNS resolver/HTTPS requester test seam, add focused adapter tests that prove:

1. repository inspect emits one GET to `https://api.github.com/repos/2ndworld/kodeGPT`;
2. PR inspect emits the fixed path with the requested positive number;
3. PR list emits only `state` and `per_page`, no arbitrary query key;
4. fixed GitHub metadata headers are present;
5. the manifest has no Authorization header;
6. a provided in-memory bearer credential is injected by the generic transport as `Authorization: Bearer ...`;
7. the credential value does not appear in returned semantic data or any adapter-owned output object.

Run:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/github.test.ts packages/capabilities/src/provider-gateway/network-transport.test.ts
```

Expected RED if adapter request assertions are not yet fully satisfied. If the generic transport already passes all behavior, do not modify it merely to create code churn.

### GREEN

Make only adapter-side corrections proven by RED. No new HTTP class, fetch wrapper, redirect handler, DNS policy, or authorization injector is allowed.

### Verify

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/github.test.ts packages/capabilities/src/provider-gateway/network-transport.test.ts packages/capabilities/src/provider-gateway/credential-broker.test.ts
pnpm --filter @kodegpt/capabilities typecheck
```

**Commit:** `test: prove github adapter transport authority`

---

## Task 5 — Register exactly one production adapter and preserve the public MCP boundary

**Purpose:** Make `github.read.v1` the sole production manifest and update stale zero-adapter assertions without expanding MCP.

**Files:**
- Modify: `packages/capabilities/src/provider-gateway/adapter-registry.ts`
- Modify: `packages/capabilities/src/provider-gateway/adapter-registry.test.ts`
- Modify: `tests/integration/provider-gateway.test.ts`
- Modify: `tests/security/security-invariants.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/index.ts` if needed for internal manifest export

### RED

Update tests first to require:

```text
PRODUCTION_PROVIDER_MANIFESTS.length === 1
PRODUCTION_PROVIDER_MANIFESTS[0].adapterId === github.read.v1
```

while retaining:

```text
MCP_SURFACE_VERSION === 0.7
public tool count === 51
no public provider.*
```

Also assert the production registry resolves exactly the three approved semantic mappings and rejects an unknown semantic mapping.

Run:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/adapter-registry.test.ts tests/integration/provider-gateway.test.ts tests/security/security-invariants.test.ts
```

Expected RED: production manifest array is still empty.

### GREEN

Import the GitHub manifest into the existing adapter registry module and change only:

```ts
PRODUCTION_PROVIDER_MANIFESTS = Object.freeze([GITHUB_READ_PROVIDER_MANIFEST]);
```

Do not add sample/demo adapters or any MCP registration.

### Verify

```bash
pnpm vitest run packages/capabilities/src/provider-gateway tests/integration/provider-gateway.test.ts tests/security/security-invariants.test.ts
pnpm run typecheck
pnpm run verify:forbidden
```

**Commit:** `feat: register github read production adapter`

---

## Task 6 — Whole-feature review and repository verification

**Purpose:** Validate the complete local candidate before host dogfood or remote publication.

**Files:** no planned source changes; fix only evidence-backed failures.

### Focused gate

```bash
pnpm vitest run packages/capabilities/src/provider-gateway
pnpm vitest run tests/integration/provider-gateway.test.ts
pnpm vitest run tests/security/security-invariants.test.ts
pnpm run typecheck
pnpm run verify:forbidden
```

### Full repo gate

```bash
pnpm test
pnpm run typecheck
pnpm run build
pnpm run verify:forbidden
pnpm run package:smoke
```

Run additional acceptance commands required by the current repository scripts/config. Do not run Rust merely by habit if no Rust file changed and no repo gate requires it. If a required gate invokes Rust, run it as required.

### Review checklist

Use exact `show_changes`/diff review and verify:

- only intended Provider Gateway/docs/test files changed;
- exactly one production adapter;
- exactly three semantic mappings;
- no issue/write/GraphQL/raw GitHub/provider generic API;
- no Remote-CI production change;
- no new dependency;
- no token/Authorization literal except reviewed test assertions/fixed generic transport behavior;
- no credential value, raw GitHub body, or raw headers in semantic/audit output;
- no public MCP registration change;
- runtime/protocol/surface remain `0.1 / 2026-07-28 / 0.7` and tool count remains 51.

If a gate fails, use systematic debugging and make the smallest evidence-backed correction, then rerun the failed gate plus affected focused tests.

**Commit only if review-driven corrections are required:** `fix: close github adapter verification gaps`

---

## Task 7 — Local operator/host dogfood without unnecessary service cutover

**Purpose:** Prove the first real adapter against the actual host credential helper and GitHub API through existing operator/provider mechanics where the repository exposes a safe private execution path.

### Preflight

Use allowlisted local commands to obtain:

```text
canonical gh path
gh SHA-256
gh auth status / gh auth token viability without printing the token
```

Never log `gh auth token` output.

### Admission

Using the existing provider CLI syntax from current `--help`/tests:

1. create a temporary isolated provider state root if production state mutation is unnecessary;
2. add `github.read.v1` with operator name plus admitted `gh` helper path/SHA;
3. inspect the provider record;
4. prove implementation identity and static inventory admission;
5. execute all three mappings through the safest existing private test/source harness path using repository `2ndworld/kodeGPT` and a known PR number available from the current project history (PR #16 is acceptable if still readable);
6. confirm semantic output is normalized and bounded;
7. inspect provider audit and scan the isolated state for credential/header leakage;
8. clean the temporary state when complete.

Do not restart or install the live service solely for this source-level dogfood. If the private execution path is not exposed outside tests without adding a new API, use a bounded temporary test harness instead of adding a production command.

### Public boundary proof

Run the existing MCP inventory/conformance test again and verify 51 tools / surface `0.7` / no `provider.*`.

Record concise acceptance evidence in the existing execution tracker or a single readiness document only if current repo conventions require a durable closure artifact; do not create duplicate status documents.

---

## Task 8 — Push, PR, CI, merge, and canonical reconciliation

**Purpose:** Integrate only the reviewed candidate.

### Pre-push

1. `show_changes` exact diff review.
2. Run fresh focused + full gates from Task 6 after the final code change.
3. Run a no-secret/forbidden review using existing scanners and targeted repository search for accidental token material.
4. Confirm feature worktree is clean after intended commits.

### Publish

```bash
git push -u origin feat/github-read-provider-adapter
```

Create a PR describing:

- first production `github.read.v1` adapter;
- exactly three private read-only semantic mappings;
- existing credential/transport reuse;
- minimal `mapOutput` reconciliation required by the original Provider Gateway response-flow design;
- no MCP expansion and no Remote-CI migration;
- local verification/dogfood evidence.

### CI/review

1. monitor exact-head GitHub Actions;
2. inspect failures before changing code;
3. fix only evidence-backed defects using RED/GREEN;
4. address actionable review feedback with the receiving-code-review workflow;
5. request final code review before merge;
6. merge only when checks are green and mergeable.

### Post-merge

1. fetch/reconcile canonical local `main` to the merged remote head without losing unique work;
2. verify merged-main CI success on the exact merge head;
3. run targeted merged-main Provider Gateway/public-inventory verification;
4. read installed service status without restart and verify it remains healthy at runtime/protocol/surface `0.1 / 2026-07-28 / 0.7`;
5. do not cut over/restart the installed service unless the accepted release workflow explicitly requires it;
6. remove/prune the feature worktree only after the branch contains no unique work and canonical `main` is reconciled.

## Stop condition

Stop after the GitHub read-only adapter phase is integrated and verified. Do not continue to issue operations, GitHub writes, a second provider, generic provider invocation, public GitHub/provider MCP tools, Remote-CI migration, OAuth/account management, or skill/provider auto-execution.
