# KodeGPT Public Typed GitHub Read Surface Design

Date: 2026-08-17

## Goal

Expose the five already-proven `github.read.v1` read semantics as named, typed, closed-schema public MCP tools without exposing generic Provider Gateway execution or any GitHub mutation authority.

Public tools:

- `github.repository.inspect`
- `github.pr.inspect`
- `github.pr.list`
- `github.issue.inspect`
- `github.issue.list`

## Constraints

- Reuse the existing production Provider Gateway and `github.read.v1` manifest.
- Do not duplicate GitHub HTTP, credential, normalization, network-policy, response-budget, or audit logic.
- Do not expose `provider.invoke`, provider inventory/control tools, provider instance IDs, arbitrary endpoints, methods, headers, or credentials.
- Do not add GitHub write/comment/merge/label/create/update operations.
- Do not add dependencies or a generic provider framework.
- Preserve current bounded list semantics, including issue filtering with no refill pagination.
- Preserve provider audit, credential broker, exact-origin network policy, and normalized bounded results.
- Public surface changes from `0.7` to `0.8`; runtime remains `0.1`; protocol remains `2026-07-28`.

## Existing Contract Reuse

The public MCP schemas reuse the existing strict semantic schemas from `packages/capabilities/src/provider-gateway/github.ts` rather than defining a second GitHub API contract.

Inputs stay aligned with current Provider Gateway semantics:

- `github.repository.inspect`: `{ repository }`
- `github.pr.inspect`: `{ repository, number }`
- `github.pr.list`: `{ repository, state?, limit? }`
- `github.issue.inspect`: `{ repository, number }`
- `github.issue.list`: `{ repository, state?, limit? }`

This intentionally does not add `workspaceId`: all five existing mappings have `workspaceBinding: "NONE"`. Adding a workspace-based repository resolution layer here would create a second contract and unnecessary behavior.

Existing defaults and bounds remain authoritative:

- PR/issue `state`: `open | closed | all`, default `open`.
- PR/issue list `limit`: `1..50`, default `30`.
- Issue inspect rejects GitHub payloads that contain `pull_request`.
- Issue list filters PR payloads from the single bounded response and performs no refill request.

Outputs reuse the existing normalized strict schemas. Public tools return only the normalized semantic value; they do not expose the internal Provider Gateway execution envelope or provider instance ID.

## Provider Selection Boundary

`ProviderGatewayService.execute()` requires an internal `providerInstanceId`, while the public API must not allow callers to choose one.

Add one concrete GitHub read adapter at the existing Provider Gateway boundary. It selects the admitted production adapter internally:

1. list operator-side provider records;
2. filter to adapter `github.read.v1`;
3. require exactly one enabled matching instance;
4. execute the fixed semantic ID through the existing gateway;
5. return `result.value` only.

Failure behavior:

- no admitted `github.read.v1`: `PROVIDER_NOT_ADMITTED`;
- matching provider exists but none is enabled: `PROVIDER_DISABLED`;
- more than one enabled matching provider: `PROVIDER_STATE_INVALID`;
- gateway/provider failures remain existing typed `CapabilityError` failures and are sanitized by the existing MCP capability-error path.

The read adapter never auto-admits or mutates provider registry state. Provider admission remains an operator/deployment action through the existing CLI. This is important because the current live registry is empty and read-only MCP calls must not acquire hidden mutation authority.

## MCP Wiring

`createProductionServiceStack` already creates the production `ProviderGatewayRuntime`. Keep that runtime alive and inject only the concrete GitHub read adapter into `createKodegptToolContext`.

Add a `github` tool-context namespace with five typed methods matching the public tools. No generic provider method is added to `KodegptToolContext`.

`registerKodegptTools` registers the five names using:

- the exported existing GitHub input/output schemas;
- read-only, non-destructive, idempotent, open-world annotations;
- the existing `nativeCapabilityResult`/`toPublicCapabilityError` structured-error path;
- output-schema parsing before returning structured content.

## Surface and Security

The surface snapshot becomes 56 tools and MCP surface version `0.8`, following the existing convention that additive public MCP capabilities increment the surface version.

Regression assertions must prove:

- exactly the five intended `github.*` names are public;
- no `provider.*` public surface is added;
- no GitHub mutation tool is added;
- schemas reject unknown fields and specifically reject caller-supplied provider IDs, endpoint/path, HTTP method, headers, credentials, tokens, and unrelated workspace authority;
- public structured results contain normalized GitHub values only;
- provider instance IDs and generic semantic execution fields do not leak;
- existing Provider Gateway issue-vs-PR and bounded list behavior remains covered by its current tests.

## Deployment

Implementation and CI can proceed without changing the live provider registry. Before live smoke after merge/release, admit exactly one `github.read.v1` instance through the existing operator CLI using the already-established GitHub credential-helper identity. Do not add automatic admission to service startup.

Live smoke after an approved merge must verify all five tools, surface `0.8`, actual tool count `56`, audit health, filesystem boundary health, and absence of credential/provider-envelope leakage.
