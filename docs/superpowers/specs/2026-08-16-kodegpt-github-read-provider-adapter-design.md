# KodeGPT First GitHub Read-Only Provider Adapter Design

Date: 2026-08-16
Status: approved design reconciled to canonical Provider Gateway implementation
Baseline parent: `5fa2866` (post-PR #16 documentation reconciliation)
Canonical Provider Gateway merge: `105547db2f1a8f97dc5ad6fb1a1efc1a12755607` (PR #16)

## 1. Goal

Ship the first real production Provider Gateway adapter as a deliberately small GitHub read-only vertical slice. The adapter must exercise the already-merged private Provider Gateway instead of creating a second transport, credential, provider, or public MCP framework.

The production adapter ID is:

```text
github.read.v1
```

It exposes exactly three internal semantic capabilities:

```text
github.repository.inspect
github.pr.inspect
github.pr.list
```

This phase does not add GitHub issue operations, write operations, generic provider invocation, public GitHub MCP tools, or Remote-CI migration.

## 2. Preserved public/runtime invariants

The implementation must preserve all of the following:

```text
runtime version: 0.1
MCP protocol: 2026-07-28
MCP surface: 0.7
public MCP tools: exactly 51
public provider.* tools: none
```

`github.repository.inspect`, `github.pr.inspect`, and `github.pr.list` are Provider Gateway semantic IDs only. They are not MCP tool names in this phase.

Remote-CI remains a standalone sibling implementation. Its GitHub source may be used as evidence for GitHub metadata conventions, but the new adapter must not import or depend on Remote-CI runtime classes.

## 3. Architecture

The complete path is:

```text
typed internal semantic request
        ↓
ProviderGatewayServiceImpl
        ↓
github.read.v1 compiled manifest + mapping
        ↓
existing external-helper credential broker
        ↓
existing DefaultProviderNetworkTransport
        ↓
fixed GitHub REST GET
        ↓
strict selected provider response fields
        ↓
small mapping-owned raw→semantic normalizer
        ↓
reviewed KodeGPT result schema + existing result bounds
```

No new transport abstraction, SDK, Octokit dependency, plugin registry, endpoint registry, pagination framework, cache, worker, or account manager is introduced.

## 4. One material reconciliation with the PR #16 core

The approved Provider Gateway design already specifies this response sequence:

1. parse bounded provider response into strict intermediate data;
2. map/fit it into the KodeGPT result schema;
3. publish only the final semantic result.

The PR #16 implementation currently collapses those two stages by validating raw provider JSON directly with `mapping.outputSchema`. That is sufficient for the conformance provider but not for a real GitHub REST payload. In particular, `github.pr.list` must be able to return the requested repository even when GitHub returns an empty array, so the semantic result cannot be derived from provider JSON alone.

The minimal correction is an optional mapping-owned callback:

```ts
mapOutput?: (providerValue: unknown, semanticInput: unknown) => unknown;
```

Rules:

- existing mappings without `mapOutput` retain identity behavior;
- the callback receives only already-bounded/decoded/structurally-normalized JSON plus the already-validated semantic input;
- it has no transport, credential, filesystem, process, registry, or network authority;
- callback exceptions are normalized to `PROVIDER_RESPONSE_INVALID` rather than leaking provider/parser details;
- the mapped value is normalized again and must pass the existing final `outputSchema` before publication;
- this is not a generic provider extension mechanism beyond the response-mapping stage already required by the Provider Gateway design.

No generic status mapping change is planned.

## 5. Adapter manifest

### 5.1 Identity and inventory

```text
adapterId: github.read.v1
adapterContractVersion: 1
inventoryMode: STATIC
effect: REMOTE_READ
workspaceBinding: NONE
```

The explicit repository in semantic input is the target authority for these three provider reads, so no workspace is required. This also matches the approved internal request form that contains `semanticCapabilityId`, `providerInstanceId`, and typed semantic `input` without requiring `workspaceId`.

The manifest `implementationDigest` is a lowercase SHA-256 computed from a small KodeGPT-owned canonical implementation descriptor containing the reviewed adapter identity, endpoint/header contract, semantic operation IDs, schema revision, and normalizer revision. The same constants drive the manifest where practical so the digest is not an unrelated magic value. Schema/normalizer contract changes require a revision change and therefore a new digest/reapproval identity.

### 5.2 Network policy

Exactly one origin is compiled:

```text
https://api.github.com
```

Redirect policy is `null`.

Exactly three operations are compiled and all are `GET`:

```text
repository.inspect  GET /repos/{owner}/{repo}
pr.inspect          GET /repos/{owner}/{repo}/pulls/{number}
pr.list             GET /repos/{owner}/{repo}/pulls
```

The operation IDs above are adapter-local IDs. Their semantic mappings are the three `github.*` IDs named in section 1.

Fixed request metadata follows the already-shipped Remote-CI GitHub convention without coupling to its source:

```text
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2026-03-10
User-Agent: KodeGPT/0.1 Provider-GitHub-Read
```

The existing transport remains responsible for HTTPS, exact-origin enforcement, DNS/IP policy, redirect denial, request budgets, timeouts, response byte ceilings, and Authorization injection.

### 5.3 Retry and request budget

Each mapping uses:

```text
maxProviderRequests: 1
retry: none
```

The first production adapter does not need an additional retry policy. The existing gateway retry machinery remains available for future reviewed mappings without being exercised here.

## 6. Credential design

The manifest requires the existing `external-helper` broker:

```ts
{
  kind: "external-helper",
  credentialKind: "bearer",
  argv: ["auth", "token"],
  environment: {}
}
```

The operator admits the canonical trusted `gh` executable separately through the existing helper path + SHA-256 mechanism. Therefore the actual helper invocation is equivalent to:

```text
<admitted-gh-path> auth token
```

The executable is not selected by the semantic caller and no shell is involved.

The caller cannot provide a token, credential value, Authorization header, executable, argv, environment, or `gh api` command. The acquired token exists only in memory and is injected by `DefaultProviderNetworkTransport` as a bearer credential.

Credential material must not appear in semantic input, non-secret provider config, audit, normalized output, thrown error text, or test snapshots.

## 7. Input contract

All semantic input objects are Zod `.strict()` objects. Unknown keys therefore fail before credential acquisition or transport.

The following authority-shaped names are explicitly covered by rejection tests when injected into otherwise-valid input:

```text
url
uri
host
hostname
origin
path
method
query
headers
authorization
token
graphql
command
```

### 7.1 Repository identifier

All three operations use one small shared repository string schema with the public form:

```text
owner/name
```

Accepted example:

```text
2ndworld/kodeGPT
```

Validation rules:

- exactly two non-empty components separated by exactly one `/`;
- each component is at most 100 characters;
- allowed component characters are ASCII letters, digits, `.`, `_`, and `-`;
- neither component may be `.` or `..`;
- no leading/trailing whitespace, control characters, backslash, query, hash, URL syntax, or additional slash can pass the schema.

The request encoder splits the already-validated value into `owner` and `repo`. The existing transport path-parameter encoder then provides a second boundary by rejecting slash/backslash/traversal-like path parameters and percent-encoding the components.

### 7.2 `github.repository.inspect`

```ts
{
  repository: string
}
```

No other input is accepted.

### 7.3 `github.pr.inspect`

```ts
{
  repository: string,
  number: number
}
```

`number` must be a safe positive integer in:

```text
1..2147483647
```

### 7.4 `github.pr.list`

```ts
{
  repository: string,
  state?: "open" | "closed" | "all",
  limit?: number
}
```

Defaults and bounds:

```text
state default: open
limit default: 30
limit range: 1..50
```

The only compiled query keys are:

```text
state
per_page
```

The encoder maps semantic `limit` to GitHub `per_page`. It does not expose `page`, arbitrary sort/direction, labels, cursors, raw query strings, or a query key/value bag.

## 8. Provider-response parsing and semantic output

GitHub REST JSON is never returned directly.

Each GitHub mapping owns a small selected-field raw response schema. GitHub may add unrelated fields over time; the selected-field schema discards unneeded object properties immediately and the normalizer constructs a fresh final object containing only reviewed KodeGPT-owned fields. The final semantic output schemas are strict.

Text still passes through the existing Provider Gateway UTF-8/NUL/NFC/newline normalization and structural limits.

The adapter additionally checks provider identity facts relevant to the requested resource, such as returned PR numbers and base repository names, before creating semantic output. Mismatch is treated as `PROVIDER_RESPONSE_INVALID`.

### 8.1 `github.repository.inspect`

Final value:

```ts
{
  repository: string,
  name: string,
  owner: string,
  description: string | null,
  private: boolean,
  defaultBranch: string,
  archived: boolean,
  fork: boolean,
  htmlUrl: string,
  createdAt: string,
  updatedAt: string,
  pushedAt: string | null
}
```

`repository` is the requested repository after validation. The GitHub `full_name` response must match it case-insensitively before the result is accepted.

### 8.2 `github.pr.inspect`

Final value:

```ts
{
  repository: string,
  number: number,
  title: string,
  state: "open" | "closed",
  authorLogin: string | null,
  baseBranch: string,
  headBranch: string,
  merged: boolean,
  draft: boolean,
  htmlUrl: string,
  createdAt: string,
  updatedAt: string,
  closedAt: string | null,
  mergedAt: string | null
}
```

The returned PR number must equal the requested number. The returned base repository must match the requested repository case-insensitively.

### 8.3 `github.pr.list`

Final value:

```ts
{
  repository: string,
  items: Array<{
    number: number,
    title: string,
    state: "open" | "closed",
    authorLogin: string | null,
    baseBranch: string,
    headBranch: string,
    draft: boolean,
    htmlUrl: string,
    createdAt: string,
    updatedAt: string
  }>
}
```

The list contains at most the requested `limit` and never more than 50 items. Every returned item's base repository must match the requested repository case-insensitively. The top-level `repository` always comes from validated semantic input, so it remains present even for an empty GitHub array.

No raw GitHub body, headers, rate-limit metadata, user object, repository object, labels, issue body, comments, diffs, or arbitrary URLs are retained beyond the explicitly listed final fields.

## 9. Error model

The adapter reuses Provider Gateway errors. It does not add a `GITHUB_*` hierarchy.

Expected relevant errors remain:

```text
PROVIDER_INPUT_INVALID
PROVIDER_DISABLED
PROVIDER_NOT_ADMITTED
PROVIDER_IDENTITY_CHANGED
PROVIDER_CREDENTIAL_UNAVAILABLE
PROVIDER_CREDENTIAL_REJECTED
PROVIDER_NETWORK_DENIED
PROVIDER_UNAVAILABLE
PROVIDER_TIMEOUT
PROVIDER_RATE_LIMITED
PROVIDER_RESPONSE_INVALID
PROVIDER_OUTPUT_LIMIT_EXCEEDED
PROVIDER_TOOL_UNAVAILABLE
PROVIDER_REQUEST_FAILED
```

No generic transport status change is part of this design. If a real acceptance test later proves a material Provider Gateway status-classification defect, it must be fixed narrowly with a regression test rather than by creating a GitHub-specific error layer.

## 10. Production registration

At the successful end state:

```ts
PRODUCTION_PROVIDER_MANIFESTS
```

contains exactly one manifest:

```text
[github.read.v1]
```

The existing conformance provider stays under `tests/**` only.

The public MCP registry is untouched. Tests continue to lock:

```text
MCP_SURFACE_VERSION === "0.7"
public tool count === 51
no public tool starts with "provider."
```

## 11. Test strategy

Implementation follows strict RED → GREEN → REFACTOR.

Adapter-specific RED coverage must prove:

- production manifest inventory contains exactly `github.read.v1`;
- adapter is `STATIC`, exact origin `https://api.github.com`, all operations `GET`, exactly three mappings, all `REMOTE_READ`;
- unknown semantic operation is unavailable;
- all authority-shaped extra semantic input keys fail strict schemas;
- repository validation accepts `2ndworld/kodeGPT` and rejects URL, extra path component, traversal, missing owner/repo, query, hash, whitespace/control forms relevant to the parser;
- PR number rejects zero, negatives, fractions, unsafe/excessive values;
- PR list accepts only reviewed `state`, enforces `limit` 1..50, and encoder emits only `state` + `per_page`;
- fixed GitHub headers are correct and credential-bearing headers are absent from the manifest;
- credential policy is external-helper bearer with fixed argv `auth token` and empty environment;
- raw GitHub repository/PR/list samples normalize to exactly the reviewed semantic shapes;
- empty PR list retains the requested repository;
- response number/repository mismatch fails as `PROVIDER_RESPONSE_INVALID` through the real output parsing path;
- provider raw extra fields and credential-like provider fields are not present in semantic results;
- existing generic Provider Gateway tests continue to cover admission, enable/disable, identity mismatch, credential redaction, audit redaction, DNS/IP denial, request budget, timeout, and cancellation without duplicating those invariants in GitHub-specific tests;
- integration/security tests still lock surface `0.7`, 51 public tools, and no public `provider.*`.

## 12. Expected source shape

Prefer the smallest source change that fits current conventions:

```text
Create: packages/capabilities/src/provider-gateway/github.ts
Create: packages/capabilities/src/provider-gateway/github.test.ts
Modify: packages/capabilities/src/provider-gateway/contracts.ts
Modify: packages/capabilities/src/provider-gateway/adapter-registry.ts
Modify: packages/capabilities/src/provider-gateway/output.ts
Modify: packages/capabilities/src/provider-gateway/output.test.ts
Modify: packages/capabilities/src/provider-gateway/service.ts
Modify: packages/capabilities/src/provider-gateway/index.ts only if the adapter manifest needs package-level export
Modify: tests/integration/provider-gateway.test.ts
Modify: tests/security/security-invariants.test.ts
```

Only files demonstrated necessary by RED tests should be touched. `production.ts`, Remote-CI source, MCP registration code, Rust crates, package dependencies, and service lifecycle code are not expected to change.

## 13. Acceptance and operator dogfood

After local tests are green, use the existing operator path if host prerequisites permit:

1. resolve the trusted host `gh` executable;
2. compute its SHA-256;
3. add one `github.read.v1` provider instance through the existing provider CLI with that helper path/SHA;
4. inspect the admitted provider;
5. invoke the three internal semantic mappings through an existing private/operator-capable source-level or test harness path;
6. confirm normalized outputs, including an empty-or-bounded list case when practical;
7. inspect provider audit and confirm no token/header leakage;
8. verify the public MCP inventory remains exactly 51 tools with no `provider.*`;
9. remove or disable temporary dogfood provider state if it was created only for acceptance.

Do not restart or cut over the installed service solely to prove source-level adapter behavior. A live service restart is justified only if the accepted release workflow later explicitly requires installed-service proof.

## 14. YAGNI boundary

This phase intentionally excludes:

- GitHub issues;
- GitHub mutations;
- GraphQL;
- `gh api`;
- arbitrary URLs/paths/methods/query/header input;
- Octokit/GitHub SDK dependency;
- pagination/cursor abstraction;
- rate-limit scheduler;
- caching/background jobs;
- OAuth UI/token vault/account switcher;
- generic provider MCP invocation;
- public GitHub MCP tools;
- second provider;
- Remote-CI migration/refactor;
- skill/provider automatic execution.

If two safe implementations satisfy this design, choose the one with fewer files, fewer new concepts, less caller authority, and lower everyday maintenance cost.

## 15. Completion condition

This phase is complete only when all of the following are evidenced:

- PR #16 post-merge docs reconciliation is preserved;
- `github.read.v1` is the only production Provider Gateway manifest;
- exactly three approved semantic mappings work;
- all three use fixed GitHub REST GET authority through existing Provider Gateway transport and credentials;
- normalized output contains no raw GitHub payload or credential material;
- focused and repo-required verification are green;
- CI is green and the feature is merged if the repository workflow reaches merge;
- canonical `main` is reconciled after merge;
- installed/live service remains healthy without unnecessary restart;
- runtime/protocol/surface remain `0.1 / 2026-07-28 / 0.7`;
- public MCP remains exactly 51 tools with no public `provider.*`.
