# KodeGPT GitHub Issue Read Extension Design

Date: 2026-08-17
Status: approved design, post-PR #17 minimal extension
Baseline: post-PR #17 canonical `main` plus Phase A reconciliation commit `d1bdc090603aea6b23df9b16b2d9c9930ef62bd9`

## 1. Goal

Extend the existing production Provider Gateway adapter `github.read.v1` with exactly two internal read-only semantic capabilities:

```text
github.issue.inspect
github.issue.list
```

This is an incremental extension of the existing GitHub adapter, not a second provider framework. It must reuse the existing provider manifest contract, external-helper credential broker, admitted `gh auth token` path, exact-origin HTTPS transport, response normalization, durable audit, lifecycle, and inventory.

## 2. Preserved invariants and non-goals

The implementation must preserve:

```text
runtime version: 0.1
MCP protocol: 2026-07-28
MCP surface: 0.7
public MCP tools: exactly 51
public provider.* tools: none
provider adapter: github.read.v1
network origin: https://api.github.com
credential broker: existing external-helper bearer flow
```

This phase does not add issue mutation, comments, PR mutation, generic `provider.invoke`, public provider-backed MCP tools, OAuth/device flow, native credential storage, GitHub Enterprise, GraphQL, Octokit/SDK, generic pagination, cache, workers/background monitoring, Remote-CI migration, or a second provider framework.

## 3. Chosen architecture

The approved approach is to extend `packages/capabilities/src/provider-gateway/github.ts` directly, following the existing repository/PR patterns.

Alternatives intentionally rejected:

1. A generic GitHub resource abstraction: rejected because five operations in one adapter do not justify a new abstraction layer.
2. A new issue-specific provider adapter: rejected because it would duplicate manifest, credential, network, lifecycle, and inventory machinery already owned by `github.read.v1`.
3. Generic provider invocation/pagination: rejected because it broadens authority and complexity beyond this read-only semantic slice.

The resulting path remains:

```text
typed internal semantic request
        ↓
ProviderGatewayServiceImpl
        ↓
github.read.v1 mapping
        ↓
existing credential broker
        ↓
existing exact-origin HTTPS transport
        ↓
fixed GitHub REST GET
        ↓
mapping-owned strict raw schema + semantic normalization
        ↓
existing final semantic output validation/bounds
```

## 4. Operations

Add exactly two adapter-local GET operations:

```text
issue.inspect  GET /repos/{owner}/{repo}/issues/{number}
issue.list     GET /repos/{owner}/{repo}/issues
```

`issue.inspect` has no caller-controlled query fields.

`issue.list` allows only:

```text
state
per_page
```

No URL, method, header, origin, path, token, command, GraphQL, or arbitrary query authority is accepted from semantic input.

Each semantic mapping remains:

```text
effect: REMOTE_READ
workspaceBinding: NONE
maxProviderRequests: 1
retry: none
```

## 5. Input contracts

Reuse the existing validated `owner/repo` repository identifier shape.

### 5.1 `github.issue.inspect`

```ts
{
  repository: string;
  number: integer; // 1..2_147_483_647
}
```

Unknown fields are rejected by the strict schema.

### 5.2 `github.issue.list`

```ts
{
  repository: string;
  state?: "open" | "closed" | "all"; // default "open"
  limit?: integer;                      // 1..50, default 30
}
```

The list controls intentionally match the existing PR list contract.

`limit` is a provider page-size/result ceiling, not a guarantee that the semantic result contains that many issues. Because GitHub's issues endpoint can mix pull requests into the same response, filtering PR entries may produce fewer semantic issue results. This phase does not issue extra provider requests to refill the list.

## 6. Issue-versus-pull-request semantics

GitHub's REST issues endpoints can return pull requests, identified by a `pull_request` field. KodeGPT must not silently mix those into issue semantics.

### 6.1 Inspect

For `github.issue.inspect`:

1. parse the selected reviewed raw issue fields including optional `pull_request` presence;
2. if `pull_request` is present, reject the mapping;
3. rely on the existing Provider Gateway output wrapper to normalize that mapping failure to `PROVIDER_RESPONSE_INVALID`.

No new public or provider error code is introduced.

### 6.2 List

For `github.issue.list`:

1. parse the bounded response array with selected reviewed fields including optional `pull_request` presence;
2. require provider array length not to exceed the requested `limit`;
3. filter entries containing `pull_request`;
4. map only remaining issue entries to the semantic result.

The final `items` array is therefore issue-only and remains bounded by the requested `limit` and the hard maximum of 50.

## 7. Output contracts

Keep output deliberately small and do not forward raw GitHub payloads.

### 7.1 Inspect output

```ts
{
  repository: string;
  number: integer;
  title: string;
  state: "open" | "closed";
  authorLogin: string | null;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  commentsCount: integer;
  labels: string[];
  assigneeLogins: string[];
}
```

### 7.2 List output

```ts
{
  repository: string;
  items: Array<{
    number: integer;
    title: string;
    state: "open" | "closed";
    authorLogin: string | null;
    htmlUrl: string;
    createdAt: string;
    updatedAt: string;
    closedAt: string | null;
    commentsCount: integer;
    labels: string[];
    assigneeLogins: string[];
  }>;
}
```

Bounds:

- title follows the existing GitHub title bound;
- logins follow the existing GitHub login bound;
- URLs and timestamps follow the existing adapter schemas;
- comments count must be a non-negative safe integer;
- labels and assignees are each capped at 20 entries per issue;
- label names are capped at 255 characters;
- no body/body summary is included in this phase, avoiding a new truncation policy where the existing shipped adapter has none;
- the generic Provider Gateway structural and 512 KiB semantic-result ceilings remain unchanged.

If GitHub returns more than the reviewed per-issue label/assignee caps, the response is rejected as `PROVIDER_RESPONSE_INVALID` rather than silently truncating provider data without an approved truncation contract.

## 8. Validation and identity checks

The mapping must reject:

- malformed repository identifiers;
- issue numbers outside the reviewed positive 32-bit-safe range;
- invalid list state/limit values;
- unknown authority-like input fields;
- malformed provider JSON/shape;
- `issue.inspect` payloads that contain `pull_request`;
- provider list arrays larger than the requested `limit`;
- malformed selected issue fields;
- per-issue labels/assignees exceeding reviewed caps.

The requested repository is carried from validated semantic input into output. Unlike PR payloads, issue payloads do not provide a repository identity field suitable for the existing PR-style cross-check, so no new provider lookup or URL-derived repository identity parser is introduced.

## 9. Provider HTTP error handling

No generic HTTP/status mapping changes are needed. Existing Provider Gateway behavior remains authoritative for provider 404, authentication failure, rate/HTTP errors, timeouts, malformed responses, and output limits.

Focused integration coverage must prove the new issue semantics travel through the same gateway path rather than bypassing it.

## 10. Manifest identity

The existing canonical implementation descriptor must be updated to include:

```text
issue.inspect
issue.list
github.issue.inspect
github.issue.list
```

Because the reviewed operation/schema/normalizer contract changes, increment the descriptor's schema/normalizer revision values so `implementationDigest` changes and existing provider admission identity cannot silently masquerade as the prior three-operation adapter build.

The adapter ID and contract version remain:

```text
adapterId: github.read.v1
adapterContractVersion: 1
```

No second production manifest is added.

## 11. Testing strategy

Use strict TDD.

RED coverage must be added first for at least:

- manifest now has exactly five GET operations and five `REMOTE_READ` mappings;
- issue inspect/list schemas and defaults/bounds;
- rejection of unknown authority fields;
- exact request encoding and fixed GitHub origin/headers;
- normalized inspect output;
- inspect rejection when `pull_request` is present;
- list filtering of PR entries;
- list may return fewer items than requested after filtering;
- list rejects provider arrays over requested `limit`;
- label/assignee bounds and deleted/null author/assignee behavior where applicable;
- registry exposes both new mappings;
- Provider Gateway integration covers successful issue reads and existing HTTP/error mapping;
- security/public-surface assertions remain unchanged at 51 tools / MCP surface 0.7 / no public provider tools.

GREEN should make the smallest direct changes necessary. Refactor only if duplication introduced by these two operations materially harms clarity.

## 12. Documentation and completion

After implementation and verification:

- update current architecture/tracker wording so `github.read.v1` is documented as five internal semantic mappings;
- preserve historical PR #17 chronology as three mappings at the time it shipped;
- do not rewrite historical plans/specs as if they originally included issue support;
- run focused tests, full suite, typecheck, build, forbidden-pattern scan, package smoke, and current acceptance checks required by the repo;
- review the exact diff;
- commit logical changes and report the exact HEAD and verification results.

## 13. Deferred scope

Still deferred after this phase:

- public provider-backed MCP surface;
- generic `provider.list/tools/invoke`;
- GitHub write/mutation/comment operations;
- GitHub Enterprise;
- OAuth/device flow;
- native credential storage;
- second provider;
- Remote-CI migration;
- CI rerun/cancel/dispatch;
- background CI monitoring;
- generic pagination/provider framework;
- `skill.run`;
- desktop/computer-use;
- git reflog;
- relative revision grammar.
