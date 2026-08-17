# KodeGPT Bounded Typed GitHub PR Write Surface Design

Date: 2026-08-17
Status: design for the user-approved next phase; production implementation remains gated on review of this written spec
Baseline: post-PR21 surface `0.8`, with the post-PR21 architecture reconciliation commit `1a48edb96312244b61d75b01f072eaefb291ab77` as this branch parent

## 1. Goal

Close the remaining normal GitHub pull-request lifecycle gap without introducing generic provider authority.

Add exactly two public typed MCP tools:

- `github.pr.create`
- `github.pr.merge`

The intended end-to-end development loop becomes:

```text
inspect/edit/verify
  -> git commit
  -> git push
  -> github.pr.create
  -> github.pr.inspect + ci.*
  -> github.pr.merge
```

This phase does not add comments, labels, reviewers, PR updates, issue mutation, branch deletion, workflow dispatch, generic GitHub REST access, `provider.invoke`, or public `provider.*` tools.

Runtime remains `0.1`; MCP protocol remains `2026-07-28`; the public MCP surface advances from `0.8` to `0.9`. With no unrelated surface changes, the tool inventory advances from 56 to exactly 58 tools.

## 2. Selected architecture

Use a second private static Provider Gateway adapter, `github.write.v1`, containing only the two reviewed mutation semantics. Keep the existing `github.read.v1` adapter unchanged.

### Why a separate write adapter

The existing provider is intentionally named and admitted as `github.read.v1`. Adding remote writes to that adapter would make its authority name false and would couple a software upgrade to a material authority expansion. Even if implementation-fingerprint drift forced reapproval, the operator boundary would be harder to reason about.

A separate `github.write.v1` adapter gives one explicit least-privilege boundary:

- existing GitHub reads keep working with the existing read admission;
- GitHub writes remain unavailable until the operator separately admits/enables the write adapter;
- disabling/removing the write adapter cannot disable read-only GitHub intelligence;
- deployment rollback can remove write authority without changing the read provider record.

The write adapter may reuse the same externally owned `/usr/bin/gh` credential-helper mechanism and the same exact `https://api.github.com` network transport, but it gets its own provider instance and implementation fingerprint.

No automatic migration, cloning, or admission from `github.read.v1` to `github.write.v1` is allowed.

## 3. Alternatives rejected

### 3.1 Add mutations to `github.read.v1`

Rejected. It blurs the admission boundary and turns a read-named provider into mutation authority.

### 3.2 Call `gh pr create` / `gh pr merge` as provider operations

Rejected. The Provider Gateway design deliberately permits the external helper only for credential acquisition. Provider traffic must remain under KodeGPT's fixed method/origin/path/redirect/body policy rather than delegating network authority to a CLI subprocess.

### 3.3 Add generic GitHub/provider invocation

Rejected. Callers may not choose arbitrary provider IDs, URLs, methods, paths, headers, request bodies, GraphQL documents, or provider tool names.

## 4. Provider Gateway mutation effect

Extend the private Provider Gateway effect model with exactly one additional effect class:

```text
REMOTE_MUTATION
```

`REMOTE_READ` behavior remains unchanged.

For this initial mutation phase, a `REMOTE_MUTATION` mapping must satisfy all of the following:

- `retry: "none"`;
- `maxProviderRequests: 1`;
- fixed compiled provider operation;
- no caller-selected URL, method, headers, credential, redirect, or provider instance;
- decision audit is durable before credential acquisition or network effect;
- no background retry, queue, or replay machinery.

The fixed provider HTTP method set expands only as needed from `GET | POST` to `GET | POST | PUT`. `PUT` is required only for the reviewed GitHub PR merge endpoint in this phase.

The manifest validator must reject a mutation mapping that requests automatic retry or more than one provider request.

## 5. Mutation ambiguity and audit semantics

Remote mutation differs from remote read because a transport failure can occur after the provider has already applied the effect. Retrying blindly can therefore duplicate or compound a mutation.

Add the stable provider error:

```text
PROVIDER_MUTATION_OUTCOME_UNKNOWN
```

Meaning: a reviewed remote mutation may have reached or succeeded at the provider, but KodeGPT cannot safely prove the final remote outcome. The caller must inspect remote state before any retry.

Required behavior:

1. If decision audit fails, no credential/network effect occurs and the existing `PROVIDER_AUDIT_UNAVAILABLE` behavior remains valid.
2. Validation, provider admission, disabled state, identity drift, credential failure, network-policy denial, and provider 4xx rejection before a successful mutation response remain ordinary typed failures.
3. Mutation mappings never auto-retry.
4. For a mutation, `PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`, or cancellation during provider request execution is conservatively surfaced as `PROVIDER_MUTATION_OUTCOME_UNKNOWN` after a decision has been recorded, because the request may already have reached GitHub.
5. Once a successful 2xx mutation response has been received, any later response-mapping/output-validation/success-audit failure is surfaced as `PROVIDER_MUTATION_OUTCOME_UNKNOWN`; KodeGPT must not record a misleading ordinary failed outcome and invite a blind retry.
6. When durable audit is still available, an outcome-unknown event is recorded with that normalized error code. If outcome audit itself is unavailable, the public error still remains `PROVIDER_MUTATION_OUTCOME_UNKNOWN` because remote-state reconciliation is the primary safety requirement.

This is intentionally conservative. False-positive ambiguity is preferable to an unsafe duplicate write.

## 6. `github.pr.create`

### Input

Strict schema:

```text
{
  repository: string,
  title: string,
  headBranch: string,
  baseBranch: string,
  body?: string
}
```

Bounds:

- `repository` reuses the existing `owner/repo` validation;
- `title`: non-empty, maximum 1024 characters;
- `headBranch` / `baseBranch`: non-empty, maximum 255 characters, no control characters;
- `body`: optional, maximum 16 KiB of UTF-8 text, NUL rejected, CRLF/CR normalized to LF before request construction.

Not accepted in v1:

- `draft`;
- `issue` conversion;
- `head_repo` / cross-repository head selection;
- `maintainer_can_modify`;
- reviewers, labels, assignees, milestone, or arbitrary fields.

The reviewed request is fixed to:

```text
POST https://api.github.com/repos/{owner}/{repo}/pulls
```

with a JSON body containing only:

```text
{
  title,
  head: headBranch,
  base: baseBranch,
  body? 
}
```

### Output

Return a strict normalized result sufficient for follow-up inspection:

```text
{
  repository,
  number,
  title,
  state,
  authorLogin,
  baseBranch,
  headBranch,
  draft,
  htmlUrl,
  createdAt,
  updatedAt
}
```

The output never includes raw provider response data, provider instance ID, token, request headers, internal operation ID, or arbitrary GitHub fields.

`github.pr.inspect` remains the canonical read tool for later status/merged-state inspection.

## 7. `github.pr.merge`

### Input

Strict schema:

```text
{
  repository: string,
  number: integer,
  expectedHeadOid: string
}
```

`expectedHeadOid` is mandatory and must be a lowercase full hexadecimal Git object ID of 40 or 64 characters. The caller may obtain the expected OID from the exact local branch/revision it pushed; the tool never silently substitutes the PR's current head.

This phase intentionally does not add an unguarded merge mode.

The reviewed request is fixed to:

```text
PUT https://api.github.com/repos/{owner}/{repo}/pulls/{number}/merge
```

with a body containing only:

```text
{
  sha: expectedHeadOid,
  merge_method: "merge"
}
```

The merge method is fixed to `merge` for this first phase. `squash`, `rebase`, merge queue, asynchronous merge, custom commit title/message, and branch update are outside scope.

GitHub's merge endpoint uses `sha` as the head precondition; a head mismatch must therefore fail rather than merging a different revision. The provider's non-success response remains a normalized failure and is never retried automatically.

### Output

Strict normalized result:

```text
{
  repository,
  number,
  merged: true,
  mergeCommitOid
}
```

A successful tool call never returns `merged:false`; such a response is not accepted as a successful semantic result.

The tool does not delete the source branch.

## 8. Provider manifest

Add a static `github.write.v1` manifest with exactly two operations and two semantic mappings:

```text
pr.create -> github.pr.create -> REMOTE_MUTATION
pr.merge  -> github.pr.merge  -> REMOTE_MUTATION
```

Provider properties:

- static inventory;
- exact origin `https://api.github.com`;
- GitHub API version remains the repository's pinned `2026-03-10`;
- fixed GitHub JSON accept header;
- reviewed KodeGPT user agent;
- external-helper bearer credential broker using fixed `gh auth token` argv;
- redirect policy remains `null`;
- one request maximum per semantic call;
- no retry.

The existing `GITHUB_READ_PROVIDER_MANIFEST` implementation descriptor/digest and semantic mappings must remain behaviorally unchanged.

## 9. Provider selection and admission

Add a concrete GitHub write tool adapter analogous to the existing read tool adapter.

Selection rules:

1. list local operator provider records;
2. filter only `adapterId === "github.write.v1"`;
3. require exactly one enabled matching instance;
4. invoke only the fixed write semantic through `ProviderGatewayService`;
5. return only the strict semantic value.

Errors:

- no admitted write adapter: `PROVIDER_NOT_ADMITTED`;
- admitted but none enabled: `PROVIDER_DISABLED`;
- more than one enabled write adapter: `PROVIDER_STATE_INVALID`.

The MCP caller cannot choose a provider instance. Provider admission/enable/reapproval remains local operator CLI authority.

## 10. MCP wiring and annotations

Extend the existing `github` tool context with the two write methods; do not introduce a generic provider namespace.

Annotations:

- `github.pr.create`: `readOnlyHint=false`, `destructiveHint=false`, `idempotentHint=false`, `openWorldHint=true`;
- `github.pr.merge`: `readOnlyHint=false`, `destructiveHint=true`, `idempotentHint=false`, `openWorldHint=true`.

Both tools use the existing structured capability-error path. Their public schemas reject unknown fields, including caller-supplied provider ID, endpoint, method, headers, tokens, credentials, raw request bodies, merge method, or arbitrary GitHub fields.

The registry snapshot after this phase must contain exactly seven `github.*` tools and zero `provider.*` tools.

## 11. Security invariants

1. `github.read.v1` remains read-only and independently admissible.
2. GitHub write authority exists only when `github.write.v1` is separately admitted and enabled by the local operator.
3. No repository/skill content can admit, enable, select, or reapprove the write provider.
4. Public callers cannot select provider instance, URL, method, path, headers, credential, merge strategy, or retry policy.
5. Every mutation has a durable decision before credential/network effect.
6. Mutations are never automatically retried.
7. Ambiguous post-dispatch failures use `PROVIDER_MUTATION_OUTCOME_UNKNOWN` and require read-side reconciliation before retry.
8. PR merge always carries the caller-supplied exact expected head OID.
9. No unguarded merge tool exists.
10. No source-branch deletion, PR update, comment, label, review, issue mutation, CI mutation, or generic provider mutation is added.
11. Provider request/response bodies, credentials, helper stderr, environment, and host paths never enter public output or durable audit.
12. Network origin/TLS/DNS/address/redirect/body/time bounds remain under the existing Provider Gateway transport.
13. `skill.run` remains absent.
14. Remote-CI remains unchanged.

## 12. Testing strategy

Implementation is test-first.

### Provider contracts / registry

- `REMOTE_MUTATION` is accepted only as the new explicit effect;
- mutation mappings reject retry other than `none`;
- mutation mappings reject request budget other than exactly one;
- fixed provider method accepts `PUT` but still rejects arbitrary methods;
- production manifests become exactly `github.read.v1` + `github.write.v1`;
- read manifest identity/semantics remain unchanged.

### Gateway service

- decision audit occurs before credential/network effect;
- decision-audit failure prevents write;
- normal provider 4xx failure records a failed outcome and does not retry;
- timeout/unavailable/cancelled mutation request becomes `PROVIDER_MUTATION_OUTCOME_UNKNOWN`;
- successful remote response followed by output-parse failure becomes outcome unknown;
- successful remote response followed by success-audit failure becomes outcome unknown;
- read operation error/audit behavior remains unchanged;
- mutation request count is exactly one.

### GitHub write adapter

- strict create/merge input schemas reject unknown fields;
- create request path/method/body are exact;
- create body cannot inject arbitrary GitHub fields;
- merge request is fixed PUT with exact `sha` and `merge_method:"merge"`;
- merge without `expectedHeadOid` is impossible;
- malformed provider response is rejected;
- normalized outputs contain no provider envelope or credential-bearing fields.

### MCP

- exact public inventory is 58 tools;
- exactly seven `github.*` tools exist;
- no `provider.*` tool exists;
- mutation annotations are locked;
- structured result schemas are registered and enforced;
- existing five GitHub reads remain compatible.

### Security / acceptance

- canary credential never appears in public result/error/audit;
- caller-supplied URL/method/header/token/provider ID fields are rejected;
- mutation network failure never triggers automatic retry;
- `git.status` / local repository state is not mutated by provider operations except through the already-separate local Git actions;
- existing full provider, MCP, integration, security, forbidden-pattern, and package-smoke suites remain green.

## 13. Deployment and dogfood

The implementation may be built and tested without admitting a write provider.

For real-host acceptance after candidate verification:

1. admit exactly one `github.write.v1` instance through the existing local operator CLI using the already-established external `gh` helper identity;
2. verify the active/candidate service reports surface `0.9` and exactly 58 tools;
3. prove `github.pr.create` on a reviewed feature branch;
4. inspect the created PR and CI using the existing read-only `github.*` / `ci.*` tools;
5. merge only with the exact expected head OID after CI is green;
6. re-inspect the PR and repository state;
7. scan public result/audit evidence for credential/provider-envelope leakage.

If the current ChatGPT conversation has a stale cached action registry, acceptance may use the exact candidate release through the official stdio bridge, as was already necessary for the post-PR21 surface refresh. This must not be confused with a second authority path: it invokes the same registered MCP tools against the same candidate/provider state.

## 14. Explicitly deferred

- `github.pr.update`;
- `github.pr.close`;
- comments/reviews/review requests;
- labels/assignees/milestones;
- issue create/update/comment/close;
- source-branch deletion;
- squash/rebase/merge-queue/asynchronous merge;
- CI rerun/cancel/dispatch;
- generic GitHub REST/GraphQL;
- generic `provider.invoke` / public provider inventory;
- automatic provider admission;
- write-provider credentials stored by KodeGPT;
- mutation retry/idempotency framework beyond the explicit outcome-unknown safety rule.

These remain separate future design questions and must not be added incidentally.

## 15. Acceptance definition

This phase is complete only when:

- production code contains exactly the two reviewed public mutation tools;
- `github.write.v1` is separate from the unchanged read provider;
- Provider Gateway supports `REMOTE_MUTATION` with no retry and mutation ambiguity handling;
- merge requires and sends the exact expected head OID;
- public MCP inventory is exactly 58 with seven `github.*` and zero `provider.*` tools;
- deterministic local/full CI/security/package gates pass;
- real provider acceptance proves create -> read/CI inspect -> guarded merge without credential/provider-envelope leakage;
- canonical docs/tracker and live service are reconciled only after merge/deployment verification.
