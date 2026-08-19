# KodeGPT Typed Preview Deployment Design

Date: 2026-08-19
Status: implementation authority for Phase 4 of the audited application-development roadmap
Baseline: `5bfcf2e7969a7f1690678340df4b33f3a532883e`

## Problem

Phase 3 can verify a local preview visually, but KodeGPT still cannot turn one exact clean trusted-workspace revision into a bounded public branch preview. A deployment capability must preserve KodeGPT's typed-authority model: callers identify only the trusted workspace (and, for reads, one opaque deployment ID), while repository identity, branch, revision, provider, site, production-branch boundary, credential acquisition, HTTP origin/method/path, retry behavior, and response normalization remain derived or statically admitted.

## Goal

Add **Typed Netlify Branch Preview Deployment** as a thin orchestration layer over the existing Provider Gateway and workspace Git evidence.

Public MCP surface, exactly:

- `deploy.preview.create({workspaceId})`
- `deploy.preview.inspect({workspaceId, deploymentId})`

Expected MCP surface after completion: `0.14`, exactly 76 public tools. Runtime remains `0.1`; protocol remains `2026-07-28`.

No `deploy.preview.logs` is added in v1. No Cloudflare or Vercel adapter is added.

## Authority model

The public caller never supplies:

- a URL, hostname, HTTP method, header, or arbitrary provider operation;
- provider instance ID or provider selection;
- Netlify site ID;
- repository identity;
- production branch;
- Git branch or Git object ID;
- credential/token;
- build/deploy payload, file digest, ZIP, or artifact;
- retry policy.

The only caller-controlled values are a READY trusted `workspaceId` and, for inspect, one bounded opaque `deploymentId`.

The implementation reuses:

- existing READY workspace authority;
- existing structured repository identity (`headOid`, `branch`, remotes);
- existing `git.changes` clean/truncation evidence;
- shared GitHub remote/repository parsing extracted from Remote-CI rather than duplicated;
- existing Provider Gateway static adapter admission, workspace-network binding, credential broker, audit, response bounds, `REMOTE_READ`, `REMOTE_MUTATION`, no-retry mutation semantics, and `PROVIDER_MUTATION_OUTCOME_UNKNOWN` handling.

No second deployment manager, supervisor, database, queue, polling loop, retry worker, or generic provider invocation is introduced.

## Netlify provider adapter

Add one separately admitted static adapter:

`netlify.deploy.v1`

Its reviewed network policy contains exactly the Netlify API origin:

`https://api.netlify.com`

The adapter has exactly two semantic mappings:

1. `netlify.deploy.preview.create` -> one fixed `POST /api/v1/sites/{site_id}/builds` request with only the reviewed `branch` query key.
2. `netlify.deploy.preview.inspect` -> one fixed `GET /api/v1/sites/{site_id}/deploys/{deploy_id}` request.

Netlify's API defines `POST /sites/{site_id}/builds?branch=...` as a branch deploy when the supplied branch differs from the site's main branch. Its build response identifies both `deploy_id` and source `sha`. The deploy detail endpoint returns deploy state, URLs, branch, `commit_ref`, timestamps, and bounded error evidence. Phase 4 uses these documented operations; it does not use manual file-digest/ZIP deploy APIs.

Provider mappings are:

- create: `effect:"REMOTE_MUTATION"`, `workspaceBinding:"REQUIRED"`, `maxProviderRequests:1`, `retry:"none"`;
- inspect: `effect:"REMOTE_READ"`, `workspaceBinding:"REQUIRED"`, `maxProviderRequests:1`, `retry:"one-idempotent-read"`.

The create mapping therefore inherits the Provider Gateway rule that a mutation is never blindly retried. If a mutation response is received but cannot be normalized/proven, or an ambiguous transport failure occurs after mutation request start, the existing gateway returns `PROVIDER_MUTATION_OUTCOME_UNKNOWN`.

## Provider admission configuration

Each admitted `netlify.deploy.v1` provider has exactly this non-secret adapter configuration:

```json
{
  "siteId": "<bounded Netlify site identifier>",
  "repository": "owner/repository",
  "productionBranch": "main"
}
```

Rules:

- object is strict; no additional keys;
- `siteId` is a bounded opaque safe identifier, not a URL/path;
- `repository` uses the same normalized GitHub `owner/name` contract as existing typed GitHub/Remote-CI logic;
- `productionBranch` is a bounded Git branch value without control characters.

The operator-approved configuration is the binding between one Netlify site and one expected GitHub repository. No caller can override it.

Credential acquisition remains JIT through the existing Provider Gateway external-helper broker. The Netlify manifest uses bearer credentials with the fixed helper argv `['token']`; the operator-admitted helper executable must implement that one-line token command. The helper executable path and SHA-256 remain separately admitted in the existing provider registry. No credential is stored in adapter configuration, surfaced through MCP, inherited from the workspace, or written to audit output.

## Shared GitHub repository identity

Remote-CI currently owns hardened logic for selecting a Git fetch remote and parsing supported `github.com` remote forms. Phase 4 must extract/re-export the narrow repository-identity helper needed by both Remote-CI and deployment preflight.

The shared helper preserves current behavior:

- prefer `origin`;
- otherwise accept exactly one fallback remote;
- reject missing or ambiguous remotes;
- accept only reviewed `github.com` HTTPS, `ssh://git@...`, and scp-style `git@github.com:...` forms;
- reject credential-bearing, port-bearing, query/hash-bearing, malformed, or control-character-bearing remotes;
- normalize bounded owner/name identity.

Remote-CI behavior and tests must remain unchanged after extraction.

## `deploy.preview.create`

Input schema is strict and contains only:

```ts
{ workspaceId: string }
```

Before any provider request, the deployment service performs all bounded local/admission preflight:

1. require the requested workspace to be READY;
2. resolve its structured repository identity and selected GitHub repository using the shared hardened helper;
3. require a non-null current branch (detached HEAD fails closed);
4. require an exact valid current `headOid`;
5. obtain `git.changes({workspaceId, includePatch:false})`;
6. require `clean === true` and `truncated === false`;
7. select exactly one enabled admitted `netlify.deploy.v1` provider;
8. strictly validate its non-secret adapter configuration;
9. require the local GitHub repository identity to match the admitted `repository` case-insensitively under the existing GitHub identity convention;
10. reject the admitted `productionBranch` exactly;
11. execute the typed Provider Gateway mutation with `workspaceId`, admitted `siteId`, derived branch, and exact derived `headOid`.

The Provider Gateway itself is the final workspace-network authority check: its `workspaceBinding:"REQUIRED"` mapping must resolve the workspace and require `network:"unrestricted"`. A workspace without unrestricted network authority fails before provider transport.

No Git fetch, push, branch mutation, or automatic repository synchronization is performed.

### Provider create request and proof

The internal create semantic input contains only derived/admitted values:

```ts
{
  siteId,
  branch,
  expectedHeadOid
}
```

The encoder sends only `siteId` as the path parameter and `branch` as the query value. `expectedHeadOid` is not sent; it is retained solely for response proof.

The Netlify build response must provide:

- a bounded deploy ID; and
- an exact Git object ID in `sha` equal to `expectedHeadOid`.

The response mapper rejects a missing/invalid deploy ID, missing/invalid SHA, or SHA mismatch. Because this validation occurs after a remote mutation response exists, the existing Provider Gateway converts that inability to prove final mutation identity into `PROVIDER_MUTATION_OUTCOME_UNKNOWN`, preserving the required reconciliation behavior without a retry.

A successful public create result contains only normalized evidence:

```ts
{
  deploymentId,
  branch,
  sourceOid,
  createdAt
}
```

`sourceOid` is guaranteed to equal the exact local `headOid` used for preflight. No raw build object is exposed.

## `deploy.preview.inspect`

Input schema is strict:

```ts
{
  workspaceId: string,
  deploymentId: string
}
```

`deploymentId` is an opaque bounded safe identifier. It is never interpreted as a URL/path and cannot alter the fixed Netlify origin or endpoint shape.

Inspect is a read/reconciliation operation, so it does **not** require the workspace to be clean, attached to a branch, or still at the deployed revision. It does require:

1. the workspace to be READY;
2. its current GitHub repository identity to match the admitted provider `repository`;
3. exactly one enabled valid `netlify.deploy.v1` provider; and
4. Provider Gateway workspace binding to authorize unrestricted network access.

It performs exactly one typed Provider Gateway read for admitted `siteId` plus caller `deploymentId`.

The provider response mapper validates that returned `id` equals the requested deployment ID and returned `site_id` equals the admitted site ID. It returns no raw provider response.

The normalized public inspect result is:

```ts
{
  deploymentId,
  state,
  previewUrl,
  branch,
  sourceOid,
  createdAt,
  updatedAt,
  errorMessage?
}
```

Rules:

- `state` is normalized to a bounded known Netlify deploy-state vocabulary plus a non-provider-specific `unknown` fallback;
- `previewUrl` is a validated HTTPS Netlify deploy/SSL URL selected from reviewed response fields, never an arbitrary caller URL;
- `branch` is bounded text without controls;
- `sourceOid` is a valid Git object ID from `commit_ref`;
- timestamps are bounded valid provider timestamps;
- `errorMessage`, when present in the actual API response, is length-bounded and redacted through normal provider/public error handling;
- no admin URL, user ID, build logs, raw headers, raw body, credential evidence, or unrelated deploy fields are exposed.

## Provider selection and failure behavior

Selection mirrors existing typed GitHub tool adapters:

- no admitted `netlify.deploy.v1` -> `PROVIDER_NOT_ADMITTED`;
- admitted but none enabled -> `PROVIDER_DISABLED`;
- more than one enabled matching provider -> `PROVIDER_STATE_INVALID`;
- malformed admitted adapter config -> `PROVIDER_STATE_INVALID`;
- provider implementation/helper identity drift -> existing Provider Gateway identity errors;
- missing credential -> existing credential error;
- workspace network denial -> `PROVIDER_NETWORK_DENIED`;
- mutation ambiguity after request start/response -> `PROVIDER_MUTATION_OUTCOME_UNKNOWN`.

Local source precondition failures happen before `gateway.execute`, so they cannot trigger a remote mutation. Existing bounded capability/repository errors are reused rather than inventing a second deployment error hierarchy.

## MCP and production wiring

Add a narrow typed deployment adapter/context, not a generic Provider Gateway surface. `createProductionServiceStack` constructs it from:

- the existing `ProviderGatewayRuntime`;
- the existing `WorkspaceManager` repository-identity inspection and READY policy authority;
- the existing native `git.changes` capability (or the same underlying checkpoint adapter without duplicating Git parsing).

`createKodegptToolContext` gains one deployment context that exposes only create/inspect. The MCP registry adds exactly two tools under `deploy.preview.*` with closed input/output schemas.

No `provider.invoke`, generic provider selector, arbitrary HTTP operation, or public provider instance identifier is added.

Update surface fixtures and manual service-version allowlists from `0.13 / 74` to `0.14 / 76`. Runtime and protocol identifiers remain unchanged.

## Testing

TDD must cover, at minimum:

- Netlify manifest is static, exact-origin, exact-operation, and contains only create+inspect semantic mappings;
- create is `REMOTE_MUTATION`, request budget 1, retry none, workspace required;
- inspect is `REMOTE_READ`, request budget 1, workspace required;
- create encoder can send only admitted site ID and derived branch;
- create mapper proves returned `sha === expectedHeadOid` and normalizes deploy ID/source revision;
- post-response create identity failure becomes `PROVIDER_MUTATION_OUTCOME_UNKNOWN` through the existing gateway;
- inspect validates site/deployment identity and normalizes only approved evidence;
- malformed/oversized IDs, branch values, URLs, timestamps, SHAs, and error evidence fail or normalize closed;
- shared GitHub remote parsing keeps all existing Remote-CI cases green;
- create rejects detached HEAD, dirty checkpoint, truncated checkpoint, production branch, repository mismatch, missing/disabled/ambiguous provider, malformed provider config, and workspace network denial before any provider mutation;
- inspect accepts a dirty/different-revision workspace but still enforces repository/provider/network binding;
- no generic HTTP/provider invocation or deployment logs tool appears in the public surface;
- MCP schemas are strict, structured results are typed, tool count is exactly 76, and surface version is exactly `0.14`;
- production stack reuses the existing Provider Gateway and workspace/native capability instances.

## Verification and live acceptance

Before merge, run focused deployment/provider/MCP tests, full deterministic test suite, typecheck, build, forbidden-pattern verification, package verification, Rust formatting/checks, and `git diff --check` using the established repository gates. Host-only tests must be run in the host context when nested KodeGPT sandbox execution would intentionally deny creation of another sandbox.

After exact-head CI is green and the PR is merged, use the existing immutable release/cutover mechanism. Verify `runtime 0.1 / protocol 2026-07-28 / surface 0.14 / 76 tools` and healthy audit/runtime state.

Live Netlify acceptance is performed only when a valid `netlify.deploy.v1` provider admission exists for a non-production test branch and its JIT credential helper is available. Acceptance must prove:

1. create rejects dirty/detached/production source without a provider request;
2. a clean non-production branch create returns a deployment ID whose `sourceOid` equals the exact local HEAD;
3. inspect of that ID reports the same branch/source revision and a bounded preview URL/state;
4. a deliberately invalid deployment ID fails through the typed read path without exposing raw provider data;
5. no mutation is automatically retried;
6. canonical Git state and service health remain clean after acceptance.

Absence of a real admitted Netlify site/credential is an external acceptance prerequisite, not permission to add mock authority or weaken the design.

## Non-goals

No deployment logs, production deployment, automatic branch pushing, Git synchronization, Cloudflare, Vercel, generic static-host abstraction, generic HTTP, generic provider selection, public provider invocation, arbitrary site/token/branch/SHA input, file/ZIP deploy, background queue, polling worker, automatic mutation retry, deployment database, rollback manager, or persistent deployment supervisor is included in Phase 4 v1.
