# Bounded Remote-CI Intelligence v1 — Design

Status date: 2026-08-16.

Status: written design candidate for user review. Production implementation is intentionally blocked until this committed specification is explicitly approved.

Baseline: canonical `main` at `7a22bcd576e841dc7e49ba431679934af0f7284f` (merge of PR #14), runtime `0.1`, MCP protocol `2026-07-28`, MCP semantic surface `0.6`.

## 1. Goal

Make remote CI inspection a normal part of KodeGPT's daily trusted-workspace development loop without turning KodeGPT into a generic GitHub client or requiring repetitive repository/run identifiers from the user.

The intended user experience is:

```text
change code
  ↓
local verification
  ↓
commit + push
  ↓
"cek CI"
  ↓
PASS → done

or

FAIL
  ↓
"kenapa CI gagal?"
  ↓
bounded failure evidence
  ↓
local diagnosis / edit / verify
  ↓
commit + push
  ↓
check CI again
```

The normal path must not require the user to repeatedly supply owner, repository, SHA, run ID, or job ID. KodeGPT resolves those details from the trusted local workspace and returns structured identifiers only when drill-down needs them.

V1 is fully read-only with respect to remote CI and GitHub.

## 2. Evidence and existing repository patterns

The design deliberately extends current KodeGPT patterns rather than introducing a parallel integration framework.

Current repository evidence includes:

- capability contracts and strict Zod schemas under `packages/capabilities/src/contracts.ts` and `packages/capabilities/src/schemas.ts`;
- adapter/service separation under `packages/capabilities/src/adapters.ts` and `native-capability-service.ts`;
- deterministic Git history bounds in `git-history.ts`;
- trusted local/remote Git policy flows in `git-local.ts` and `git-remote.ts`;
- production composition in `apps/cli/src/commands/start.ts`;
- public MCP inventory and structured results in `packages/mcp-server/src/tools.ts` and `tool-context.ts`;
- read-only MCP annotations currently using `readOnlyHint=true`, while existing networked Git annotations set `openWorldHint=true`;
- durable Rust audit infrastructure under `crates/runtime/src/audit.rs`;
- historical design evidence that `gh-fix-ci` remains `PARTIAL` because a bounded remote-CI inspection interface is absent and that generic `gh`/shell is not an acceptable replacement.

Existing Git history limits provide the closest public-response precedent:

```text
DEFAULT_GIT_PATCH_BYTES       = 64 KiB
MAX_GIT_PATCH_BYTES           = 256 KiB
MAX_GIT_HISTORY_RESPONSE_BYTES = 512 KiB
```

Remote-CI adopts the same 64/256/512 KiB scale for log excerpts and structured response budgets instead of inventing unrelated byte budgets.

## 3. Architectural decision

Remote-CI is a standalone native KodeGPT capability service with provider-specific adapters behind a provider-neutral internal contract.

```text
ChatGPT / MCP
     │
     ▼
Typed ci.* tools
     │
     ▼
RemoteCiService
     │
     ├── trusted workspace selection
     ├── RepositoryResolver
     ├── bounds / deterministic truncation
     ├── secret redaction
     ├── normalized errors
     └── durable audit
     │
     ▼
RemoteCiAdapter
     │
     └── GitHubRemoteCiAdapter
              │
              ├── direct typed GitHub API reads
              └── GitHubCredentialProvider
                         │
                         └── existing `gh` authentication
```

Required internal units are:

- `RepositoryResolver`;
- `GitHubCredentialProvider`;
- `GitHubRemoteCiAdapter`;
- `RemoteCiService`.

A small private repository-inspection adapter and a private audit adapter are also required to connect those units to the existing trusted workspace/Rust authority and durable audit sink. They are implementation plumbing, not public MCP capabilities.

### 3.1 Service placement

`RemoteCiService` is a sibling native service to the current local `NativeCapabilityService`, not a Provider Gateway. It uses the same contracts/schemas/adapters conventions under `packages/capabilities` and is wired into the production service stack explicitly.

The public native capability registry should include the new `ci.*` capability IDs so skill metadata can describe them, but adding IDs to metadata never grants permission or creates a generic provider execution path.

### 3.2 Direct API, not `gh` semantics

GitHub API requests are made by `GitHubRemoteCiAdapter` directly over HTTPS through fixed typed operations.

`gh` is used only to obtain the credential already established by the user. It is not the API semantic surface.

The following are forbidden designs:

```text
process.run("gh ...")
gh api ...
github.request(...)
github.rest(...)
github.graphql(...)
arbitrary REST/GraphQL passthrough
```

The credential bootstrap itself is a private fixed operation with no user-controlled `gh` arguments. V1 permits only `gh auth token --hostname github.com`; its stdout is treated as secret material, is strictly bounded, and is never returned, persisted, or audited. It is not routed through the public `process.run` capability.

The implementation must resolve the `gh` executable outside workspace-controlled paths and must reject a credential helper that resolves inside the trusted workspace. This prevents repository contents from shadowing the credential source.

Native KodeGPT credential storage, OAuth, and device-flow login are future work and do not alter the v1 Remote-CI contract.

## 4. Trust and authority model

Remote-CI authority is derived only through this chain:

```text
READY trusted workspace
   ↓
private typed local Git repository inspection
   ↓
configured Git remote
   ↓
canonical GitHub repository identity
   ↓
bounded read-only Remote-CI capability
```

Repository content, prompts, skill text, environment variables from the workspace, and MCP arguments cannot replace the repository identity.

Remote-CI does not add filesystem authority, generic process authority, generic network authority, or a second workspace trust mechanism.

Rust remains final OS/security authority for local workspace identity and local Git inspection. Outbound GitHub reads occur in the typed Remote-CI adapter only after the local trusted repository identity has been resolved.

### 4.1 Workspace selection

Every `ci.*` input has an optional `workspaceId` except where no workspace selector is semantically needed; v1 retains it on all five tools for consistency.

When `workspaceId` is supplied, KodeGPT must require that exact workspace to be READY under existing trust semantics.

When omitted:

1. if exactly one READY workspace exists, use it;
2. if none exists, reuse `WORKSPACE_NOT_READY`;
3. if more than one READY workspace exists, fail with `CI_WORKSPACE_AMBIGUOUS` rather than guessing.

This gives the common one-workspace session the desired zero-argument fast path while keeping multi-workspace behavior deterministic and fail-closed.

No `ci.*` tool can establish or mutate workspace trust.

## 5. Repository resolution

`RepositoryResolver` converts the selected trusted workspace into a single immutable repository observation for the duration of one invocation.

The local source of truth is a new private typed Git repository-inspection route backed by the existing retained workspace capability/Rust boundary. It may return bounded internal data needed to resolve:

- configured fetch remotes;
- selected remote name;
- current HEAD OID;
- current symbolic branch/ref when available.

It must not expose raw `.git/config`, arbitrary Git commands, credential helpers, private runtime capability IDs, or raw remote URLs through MCP.

### 5.1 Remote selection

Remote selection is deterministic:

1. if `origin` exists, select `origin`;
2. otherwise, if exactly one configured fetch remote exists, select it;
3. otherwise fail `CI_REPOSITORY_UNAVAILABLE` because selection is ambiguous or absent.

If selected `origin` exists but is not a supported GitHub remote, v1 fails `CI_REMOTE_UNSUPPORTED`; it does not silently switch to another remote.

The private local inspection response is bounded to at most 32 remote records. Exceeding that bound fails repository resolution rather than silently dropping a candidate that could change identity.

### 5.2 Supported v1 remote forms

V1 accepts the GitHub forms needed by existing repository-resolution tests:

```text
https://github.com/owner/repository.git
https://github.com/owner/repository
git@github.com:owner/repository.git
ssh://git@github.com/owner/repository.git
```

The parser:

- accepts only `github.com` for v1;
- strips one terminal `.git` suffix;
- rejects embedded HTTPS userinfo/credentials;
- rejects unsupported schemes/hosts/custom ambiguous forms;
- rejects missing owner or repository components;
- never returns a credential-bearing URL publicly.

GitHub Enterprise is outside v1 and therefore returns `CI_REMOTE_UNSUPPORTED` rather than being guessed from host shape.

### 5.3 Canonical repository equality

The parsed remote identity establishes the trusted expected repository.

After GitHub repository metadata is observed, the provider's canonical owner/repository identity must equal the locally resolved identity using GitHub's case-insensitive repository-name comparison while preserving provider casing for display.

A redirect/rename that resolves to a different owner/repository path fails `CI_REPOSITORY_MISMATCH`. KodeGPT does not silently follow a repository rename and widen trust; the user can update the local Git remote first.

### 5.4 Revision overrides

No tool accepts owner/repository/provider override fields.

`ci.status` may accept only an optional bounded Git revision using the existing `GitRevisionSchema` shape (`head`, OID, branch, or tag). It is resolved within the already-selected local repository.

The default is local HEAD.

A supplied branch/tag/OID never changes repository identity. A revision that cannot be observed in the resolved GitHub repository returns `CI_NOT_FOUND`.

## 6. Public MCP surface

The exact v1 public Remote-CI surface is:

```text
ci.repository
ci.status
ci.runs
ci.run
ci.failure
```

No additional public CI/GitHub tools are part of v1.

All five tools have closed strict schemas, structured results, and network-aware read-only annotations:

```text
readOnlyHint     = true
destructiveHint  = false
idempotentHint   = true
openWorldHint    = true
```

A dedicated `REMOTE_CI_READ_ONLY_TOOL_ANNOTATIONS` constant should be used rather than the existing local `READ_ONLY_TOOL_ANNOTATIONS`, whose `openWorldHint` is false.

### 6.1 `ci.repository`

Purpose: resolve and diagnose Remote-CI context for a trusted workspace.

Input:

```ts
interface CiRepositoryInput {
  workspaceId?: string;
}
```

Result contains only bounded public metadata:

```ts
interface CiRepositoryResult {
  schemaVersion: 1;
  workspaceId: string;
  provider: "github";
  repository: {
    owner: string;
    name: string;
    fullName: string;
  };
  selectedRemote: string;
  defaultBranch: string | null;
  currentRevision: {
    oid: string;
    branch: string | null;
  };
  available: boolean;
  authState: "AVAILABLE" | "REQUIRED" | "FAILED";
  credentialSource: "gh" | null;
  truncated: boolean;
  truncationReasons: CiTruncationReason[];
}
```

`ci.repository` is the diagnostic exception to normal auth failure behavior: if local repository identity is valid but no usable `gh` credential exists, it returns `available=false`, `authState=REQUIRED` or `FAILED`, `defaultBranch=null`, and no token/error detail. This lets the user understand why CI is unavailable without needing a separate auth tool.

When a credential is available, default branch and canonical provider identity are verified through one bounded repository metadata read.

### 6.2 `ci.status`

Purpose: the main fast-path command corresponding to “cek CI”.

Input:

```ts
interface CiStatusInput {
  workspaceId?: string;
  revision?: GitRevision;
}
```

Defaults:

```text
workspace  = sole READY trusted workspace
repository = inferred from selected Git remote
revision   = local HEAD
provider   = inferred from repository identity
```

Result contains:

- resolved repository identity;
- resolved commit OID;
- overall state: `PENDING | PASS | FAIL | CANCELLED | UNKNOWN`;
- bounded check summaries;
- bounded workflow-run summaries;
- bounded failed job/step summaries when readily available;
- stable run/job/check identifiers and validated canonical GitHub web URLs when useful for drill-down;
- `truncated` and `truncationReasons`.

There is no repository, owner, provider, page, or arbitrary URL input.

#### Status normalization

Provider statuses are normalized before result construction.

Pending-like observations include queued/requested/waiting/in-progress states.

Pass-like terminal conclusions include success, neutral, and skipped.

Fail-like terminal conclusions include failure, timed-out, action-required, and startup-failure equivalents.

Cancelled remains distinct.

Unknown provider states remain `UNKNOWN` rather than being guessed.

Overall state precedence is deterministic:

```text
FAIL
  > PENDING
  > CANCELLED
  > UNKNOWN
  > PASS
```

If there are no relevant checks/runs for an otherwise valid commit, overall state is `UNKNOWN` rather than `PASS`.

Failure and pending observations are retained ahead of successful observations when a summary bound forces deterministic truncation.

### 6.3 `ci.runs`

Purpose: bounded recent workflow history for the resolved repository.

Input:

```ts
interface CiRunsInput {
  workspaceId?: string;
  workflow?: string;
  ref?: string;
  status?: "QUEUED" | "IN_PROGRESS" | "COMPLETED";
  conclusion?:
    | "SUCCESS"
    | "FAILURE"
    | "CANCELLED"
    | "NEUTRAL"
    | "SKIPPED"
    | "TIMED_OUT"
    | "ACTION_REQUIRED"
    | "STARTUP_FAILURE";
  limit?: number;
}
```

`workflow` is a bounded exact workflow name/identifier string, not a provider query language. `ref` reuses the safe Git ref grammar. Unknown fields are rejected.

Bounds:

```text
default limit = 10
hard max      = 50
```

There is no page/cursor input and no arbitrary pagination traversal. The GitHub adapter issues at most one bounded provider-list request for this tool. If more provider data exists than v1 will observe, the result is explicitly truncated.

### 6.4 `ci.run`

Purpose: inspect one known workflow run in the already-resolved repository.

Input:

```ts
interface CiRunInput {
  workspaceId?: string;
  runId: CiId;
}
```

`CiId` is a decimal string with no sign/whitespace/exponent form. Public provider IDs are strings rather than JavaScript numbers so precision is never inferred from provider integer width.

Result includes:

- workflow identity/name;
- event;
- triggering commit OID/ref;
- created/started/updated timestamps where available;
- status and conclusion;
- jobs;
- per-job step summaries;
- bounded failure annotations already available from metadata;
- stable IDs and validated GitHub web URLs;
- explicit truncation metadata.

V1 does not add `ci.jobs.list` or `ci.steps.list`; `ci.run` is the bounded drill-down surface.

### 6.5 `ci.failure`

Purpose: return failure-focused evidence suitable for local diagnosis without exposing full CI logs.

Input:

```ts
interface CiFailureInput {
  workspaceId?: string;
  runId: CiId;
  jobId?: CiId;
}
```

If `jobId` is supplied, the adapter must prove that the job belongs to the supplied run and resolved repository.

If omitted, `RemoteCiService` selects a failed job deterministically from the bounded job observation:

1. prefer a job with an explicit fail-like conclusion and a failed step;
2. then a fail-like job without step-level failure metadata;
3. sort candidates by provider job order when stable, then start time, then decimal ID;
4. select the first candidate.

If no failed job is present, return `CI_NOT_FOUND` rather than selecting a successful/cancelled job.

Result contains:

- selected failed job and step;
- normalized failure reason/category;
- bounded annotations;
- bounded redacted log excerpts around identified failure evidence where safely available;
- file/line/column metadata when supplied by the provider;
- truncation metadata.

Signed/raw log URLs are never returned.

## 7. Provider contract and GitHub adapter

`RemoteCiAdapter` exposes only the operations required by the five service methods. It does not expose generic HTTP verbs or arbitrary endpoint paths.

`GitHubRemoteCiAdapter` implements those operations with fixed HTTPS GET endpoint families for:

- repository metadata;
- commit/check observations;
- Actions run history;
- one Actions run;
- jobs for one run;
- annotations needed by a selected failure;
- one selected job's log evidence.

No POST, PUT, PATCH, DELETE, workflow dispatch, rerun, cancel, merge, or PR mutation is permitted in v1.

### 7.1 Network constraints

All authenticated metadata requests target the fixed `api.github.com` origin over HTTPS.

Request paths are constructed only from:

- validated canonical owner/repository identity;
- validated decimal IDs;
- bounded encoded refs/filters.

There is no arbitrary URL field in any public or service input.

The adapter must set a fixed user agent and fixed API media/version headers as required by the provider implementation. Raw response headers/bodies are never surfaced directly.

### 7.2 Controlled redirects for logs

Metadata requests do not accept cross-origin credential forwarding.

If the GitHub job-log endpoint redirects to a signed download URL, redirect handling is explicit rather than automatic:

- never forward `Authorization` to a different origin;
- require HTTPS;
- reject userinfo credentials;
- allow at most one provider-issued log redirect;
- reject a redirect that does not pass the dedicated log-download validator;
- map unsafe/unusable redirects to `CI_LOG_UNAVAILABLE`.

This prevents the current GitHub token from becoming an ambient credential for an arbitrary redirect target.

### 7.3 Request-count bounds

One MCP invocation may perform several fixed provider reads, but it is one bounded observation and may not poll.

Hard maximum provider request counts are:

```text
ci.repository  1
ci.status      6
ci.runs        1
ci.run         2
ci.failure     5
```

An implementation path that would exceed the tool's request-count budget must return the best already-safe bounded result with truncation when meaningful, or a normalized error when required data cannot be obtained safely. It must not silently paginate or retry until success.

Automatic provider retries are limited to transport behavior that does not create polling; rate-limit and provider-availability responses are returned immediately as normalized errors.

## 8. Authentication

V1 credential flow is:

```text
GitHubCredentialProvider
   ↓
private fixed `gh` credential bootstrap
   ↓
ephemeral token in memory
   ↓
GitHubRemoteCiAdapter Authorization header
   ↓
discard after invocation
```

Rules:

- no new KodeGPT login UI/command is introduced;
- no token is copied into durable KodeGPT state;
- no token is written into workspace files;
- no token is included in MCP results;
- no token is included in public errors;
- no token is included in audit records;
- no token is included in ordinary logs;
- no token is placed into provider URLs;
- the adapter depends on a credential interface, not on the mechanics of `gh`.

The provider returns only an in-memory credential object carrying secret material plus non-secret source metadata such as `source="gh"`. Account names, config paths, and raw `gh` stderr are not needed by the public contract.

Stable authentication failures are:

```text
CI_AUTH_REQUIRED
CI_AUTH_FAILED
```

`CI_AUTH_REQUIRED` covers absent `gh`/no logged-in credential. `CI_AUTH_FAILED` covers a credential that is present but unusable/expired/rejected, after removing provider/raw-token details.

## 9. Redaction and failure evidence

The `ci.failure` evidence pipeline is:

```text
provider metadata / bounded log stream
   ↓
bounded extraction
   ↓
secret redaction
   ↓
normalization
   ↓
structured MCP result
```

At minimum the redactor protects against:

- the exact current GitHub credential;
- GitHub token-like values supported by deterministic patterns;
- `Authorization` and similar credential headers;
- credential-bearing URL userinfo;
- obvious secret-bearing environment assignments;
- known high-confidence secret patterns already covered by KodeGPT's redaction tests.

Exact-current-credential replacement is mandatory before heuristic patterns are applied.

Heuristic redaction is not claimed to detect every possible secret. The primary defenses are bounded extraction, no full raw CI log surface, no arbitrary raw log URL, and no persistent raw logs.

### 9.1 Log handling

KodeGPT never intentionally materializes or stores a full job log.

Log reads use a streaming scan budget:

```text
CI_LOG_SCAN_MAX_BYTES        = 512 KiB
CI_LOG_EXCERPT_DEFAULT_BYTES = 64 KiB
CI_LOG_EXCERPT_MAX_BYTES     = 256 KiB
```

V1 does not expose `maxLogBytes`; those values are service-owned safety limits rather than user-tunable escape hatches.

If useful evidence is found before the scan budget, KodeGPT returns a deterministic excerpt around the selected failure markers and sets `LOG_BYTE_LIMIT` if input/output was clipped.

If the provider's log representation cannot be safely streamed/parsed within the scan budget, return `CI_LOG_LIMIT_EXCEEDED` rather than materializing the full content.

No raw log archive is persisted to the artifact store by default in v1.

## 10. Bounds and truncation

Remote-CI follows existing KodeGPT response-budget conventions.

### 10.1 Hard collection bounds

```text
ci.status
  combined check/run summaries: 50
  failure summaries:             20

ci.runs
  default runs:                  10
  hard max runs:                 50

ci.run
  jobs:                         100
  steps per job:                100
  annotations:                  100

ci.failure
  jobs examined:                100
  annotations:                  100
  log scan:                     512 KiB
  returned excerpt: default      64 KiB
  returned excerpt: hard max    256 KiB

all structured ci.* results
  serialized public response:   512 KiB

individual provider metadata response body
  hard parse budget:              1 MiB
```

The 1 MiB metadata parse ceiling matches the repository's existing maximum bounded context scale and exists only to prevent unbounded provider materialization. The public result ceiling remains 512 KiB, matching Git history.

### 10.2 Truncation reasons

All results that can lose optional/repeated data expose:

```ts
truncated: boolean;
truncationReasons: CiTruncationReason[];
```

The stable v1 reason set is:

```text
SUMMARY_LIMIT
RUN_LIMIT
JOB_LIMIT
STEP_LIMIT
ANNOTATION_LIMIT
LOG_BYTE_LIMIT
PROVIDER_PAGE_LIMIT
RESPONSE_LIMIT
```

Reasons are deduplicated and returned in a fixed canonical order. Schemas enforce:

```text
truncated === (truncationReasons.length > 0)
```

No silent data loss is permitted.

When mandatory fields alone cannot fit or a provider payload cannot be safely parsed inside its input budget, the operation returns `CI_RESPONSE_LIMIT_EXCEEDED` rather than fabricating a partial mandatory object.

### 10.3 Pagination

V1 performs no arbitrary pagination traversal.

Provider list requests request no more than the local hard bound in one page. If the provider indicates additional data, `PROVIDER_PAGE_LIMIT` is recorded. A user cannot supply page/cursor values.

## 11. Stable error model

Remote-CI extends the native capability error vocabulary with normalized provider-independent codes.

V1 codes are:

```text
CI_WORKSPACE_AMBIGUOUS
CI_AUDIT_UNAVAILABLE
CI_AUTH_REQUIRED
CI_AUTH_FAILED
CI_REPOSITORY_UNAVAILABLE
CI_REPOSITORY_MISMATCH
CI_REMOTE_UNSUPPORTED
CI_NOT_FOUND
CI_PERMISSION_DENIED
CI_RATE_LIMITED
CI_PROVIDER_UNAVAILABLE
CI_RESPONSE_INVALID
CI_RESPONSE_LIMIT_EXCEEDED
CI_LOG_UNAVAILABLE
CI_LOG_LIMIT_EXCEEDED
```

Existing workspace/trust/Git errors are reused when the failure occurs before Remote-CI owns the semantic boundary, especially `WORKSPACE_NOT_READY` and bounded revision validation errors.

Raw GitHub/`gh` exceptions, response bodies, headers, token fragments, remote URLs containing credentials, and host paths never become public error messages.

### 11.1 Rate limits

`CI_RATE_LIMITED` may carry only bounded sanitized details:

```ts
interface CiRateLimitDetails {
  retryAfter?: number; // non-negative seconds
  resetAt?: string;    // validated ISO timestamp
}
```

No raw rate-limit header map is returned.

### 11.2 Audit failures

`CI_AUDIT_UNAVAILABLE` is required because Remote-CI network reads happen outside existing Rust Git execution paths but still require durable audit.

If the pre-network audit decision cannot be written, no credential/API operation begins.

If final outcome auditing fails after the remote observation, the result is discarded and the invocation fails `CI_AUDIT_UNAVAILABLE`; KodeGPT does not claim a successful auditable operation when the durable outcome could not be recorded.

## 12. Durable audit design

Remote-CI reuses the existing Rust durable audit sink instead of creating a TypeScript-only log file.

A private audit adapter/RPC records sanitized decision/outcome events around the remote observation. It extends the audit action vocabulary for the five `ci.*` capabilities and supports only the fields explicitly needed by this phase.

Conceptual metadata is:

```text
capability
workspace identity
repository identity
provider
auth credential source ("gh", never the credential)
runId?
jobId?
result / normalized error code
truncated
duration
timestamp
```

The audit record must not contain:

- token/credential bytes;
- `Authorization` or cookie headers;
- raw remote URL if it can carry credentials;
- raw API response bodies;
- raw full CI logs;
- secret-bearing excerpts;
- workspace conversation/prompt content.

The Rust sink remains responsible for durability, rotation, timestamping, health, and fail-closed decision semantics.

## 13. Normal data flows

### 13.1 `ci.status()` fast path

```text
User: "cek CI"
        ↓
ci.status({})
        ↓
select sole READY trusted workspace
        ↓
private Rust-backed Git repository identity
        ↓
RepositoryResolver → GitHub owner/repository + local HEAD
        ↓
durable audit decision
        ↓
GitHubCredentialProvider → ephemeral existing gh credential
        ↓
GitHubRemoteCiAdapter fixed read operations
        ↓
normalize status + deterministic bounds
        ↓
redact any returned evidence
        ↓
durable audit outcome
        ↓
structured ci.status result
```

### 13.2 Failure diagnosis

```text
ci.status()
   ↓ FAIL with runId
ci.failure({ runId })
   ↓
resolve same trusted repository
   ↓
select failed job deterministically
   ↓
bounded annotations + bounded streamed log evidence
   ↓
redact + normalize
   ↓
local source analysis
   ↓
file/edit/verify/git capabilities
   ↓
commit + push
   ↓
ci.status()
```

Normal orchestration does not require the user to manually copy the run ID because the calling agent can pass the structured ID returned by `ci.status`.

### 13.3 No background state

Each invocation is a fresh bounded observation.

V1 introduces no:

- background poller;
- CI watch process;
- synchronized CI state database;
- provider cache;
- webhook receiver;
- long-lived provider session.

## 14. MCP and native-capability integration

Implementation must update the same explicit surfaces that current native capabilities use:

- capability contracts/types and strict schemas;
- adapter interfaces;
- `RemoteCiService` and provider implementation;
- `NATIVE_CAPABILITY_IDS` and semantic metadata for the five CI capability IDs;
- production dependency wiring in the CLI service stack;
- MCP tool context;
- `SURFACE_TOOLS` exact inventory;
- structured-results tests;
- annotations;
- system capabilities/surface version expectations;
- security/forbidden-pattern tests.

The five tools must use MCP `inputSchema` and `outputSchema`; they are not opaque JSON passthroughs.

## 15. Semantic surface version

Adding five public typed MCP tools changes the advertised semantic inventory.

Advance:

```text
MCP_SURFACE_VERSION: 0.6 → 0.7
```

The MCP protocol version remains:

```text
2026-07-28
```

With no unrelated additions/removals, the exact public tool inventory advances from 46 to 51 tools.

Service/runtime compatibility parsing, `system.capabilities`, fixture inventories, host compatibility evidence, and installed-service acceptance must be updated for surface `0.7` during implementation.

This is a semantic-surface change, not a protocol-version change.

## 16. Security invariants

V1 must preserve all of the following:

1. Rust remains final OS/security authority for trusted local workspace operations.
2. Workspace trust remains the only route to local repository context.
3. Repository identity comes from the trusted local Git remote, not prompt/repository content.
4. Public inputs cannot override owner/repository/provider/remote URL.
5. All GitHub operations are typed fixed GET reads.
6. `gh` is a private credential source only.
7. No public generic shell or GitHub API surface is introduced.
8. Remote-CI adds no filesystem boundary expansion.
9. Remote-CI adds no generic process boundary expansion.
10. Remote-CI adds no generic network client.
11. Credentials never enter public result/error/audit/log state.
12. Raw full CI logs are never exposed or durably stored by default.
13. Remote log redirects never receive the GitHub Authorization header cross-origin.
14. Bounds and truncation are explicit and deterministic.
15. Durable audit remains mandatory.
16. One invocation is one bounded observation; there is no hidden polling.
17. Provider Gateway/provider execution remains deferred.
18. No CI mutation authority exists in v1.

## 17. Explicit v1 non-goals and forbidden surface

The following public tools must not exist in v1:

```text
github.request
github.graphql
github.rest
gh.run
ci.logs.raw
ci.jobs.list
ci.steps.list
ci.rerun
ci.cancel
ci.dispatch
```

V1 also does not implement:

- workflow rerun;
- workflow cancel;
- workflow dispatch;
- PR mutation;
- merge;
- arbitrary GitHub API access;
- arbitrary repository browsing;
- multi-repository provider search;
- raw REST/GraphQL passthrough;
- generic `gh` execution;
- `process.run` as a GitHub integration layer;
- native OAuth/device-flow credential management;
- background CI polling;
- webhook ingestion;
- CI cache/synchronization;
- Provider Gateway or `provider.*`;
- `skill.run`.

## 18. Test strategy

Implementation follows TDD. Tests must be written at contract, service, provider, MCP, security, and live-acceptance levels.

### 18.1 Contract/schema tests

Cover all five tools:

```text
ci.repository
ci.status
ci.runs
ci.run
ci.failure
```

Required assertions:

- schemas are closed/strict;
- unknown fields are rejected;
- malformed IDs are rejected;
- unsafe refs are rejected;
- `ci.runs.limit > 50` is rejected;
- no repository/owner/provider/URL override field is accepted;
- `truncated` and `truncationReasons` remain consistent;
- output arrays enforce hard maximums;
- rate-limit details accept only safe bounded fields;
- public URLs satisfy GitHub HTTPS validation;
- provider IDs remain decimal strings.

### 18.2 Repository resolution tests

Positive cases:

- HTTPS GitHub remote with and without `.git`;
- scp-style `git@github.com:owner/repo.git`;
- `ssh://git@github.com/owner/repo.git`;
- `origin` preferred when present;
- sole non-origin remote selected when `origin` is absent;
- canonical owner/repository equality with case-only differences;
- local HEAD/ref captured through private typed Git inspection.

Negative cases:

- untrusted/not-ready workspace;
- more than one READY workspace with omitted `workspaceId`;
- missing remote;
- multiple remotes without `origin`;
- malformed remote;
- credential-bearing HTTPS remote;
- unsupported host/scheme/GitHub Enterprise in v1;
- provider canonical repository mismatch/rename;
- private repository-inspection response exceeds its bound.

### 18.3 Credential provider tests

Cover:

- usable existing `gh` authentication;
- `gh` absent;
- `gh` present but not logged in;
- bad/expired/rejected credential;
- helper executable resolving inside workspace is rejected;
- fixed invocation does not accept caller arguments;
- stdout/stderr are bounded;
- exact credential is absent from errors;
- exact credential is absent from ordinary logs;
- exact credential is absent from audit;
- credential lifetime is invocation-scoped.

### 18.4 GitHub adapter tests

Use fake HTTP/provider fixtures for the majority of coverage.

Cover:

- repository metadata success;
- successful checks/workflows;
- pending CI;
- failed workflow;
- cancelled workflow;
- no checks/runs → `UNKNOWN`;
- multiple workflows with deterministic aggregation;
- job/step normalization;
- annotations;
- unavailable job logs;
- safe log redirect with Authorization stripped;
- unsafe redirect rejection;
- permission denied;
- not found;
- rate limit with sanitized `retryAfter`/`resetAt`;
- GitHub 5xx/provider unavailable;
- malformed JSON/shape;
- provider body over 1 MiB;
- request-count bounds;
- no request methods other than GET;
- no endpoint outside the fixed adapter contract.

### 18.5 Redaction and bound tests

Adversarial fixtures include:

- the exact current fake credential;
- `Authorization: Bearer ...`;
- token-like GitHub values;
- credential-bearing URLs;
- environment-style secrets;
- very long multi-byte logs;
- failure marker near scan/excerpt boundaries;
- more runs/jobs/steps/annotations than each hard bound.

Expected assertions:

- secrets are absent from returned results;
- secrets are absent from public errors/audit fixtures;
- UTF-8 truncation is deterministic;
- failure/pending evidence is retained ahead of success summaries;
- `truncated=true` when any optional evidence is clipped;
- truncation reasons are stable and canonically ordered;
- no full raw log is persisted.

### 18.6 Service orchestration tests

Verify:

```text
ci.status({})
```

resolves the sole current trusted workspace, repository, and HEAD without explicit owner/repo/SHA.

Verify explicit `workspaceId` is honored only for a READY trusted workspace.

Verify multiple READY workspaces cause `CI_WORKSPACE_AMBIGUOUS` when omitted.

Verify `ci.failure({ runId })` selects the same obvious failed job across repeated fixture runs.

Verify a supplied `jobId` must belong to the supplied run/repository.

Verify auth errors are normalized before MCP serialization.

Verify pre-network audit failure prevents credential/API activity.

Verify post-observation audit failure discards the result and returns `CI_AUDIT_UNAVAILABLE`.

### 18.7 MCP tests

Confirm:

- exact surface contains the five approved CI tool names and no extra CI/GitHub/gh tools;
- exact overall inventory is 51 tools for surface `0.7`;
- all five tools use network-aware read-only annotations;
- all five expose typed input/output schemas;
- structured results pass schema validation;
- `system.capabilities` reports `0.7`;
- explicit negative assertions reject `github.*`, generic `gh`, raw logs, rerun/cancel/dispatch, and provider gateway tools.

### 18.8 Security/forbidden-pattern tests

Add explicit source-level guards against:

- public `github.request/rest/graphql`;
- `gh api`;
- `process.run` used for Remote-CI semantics;
- user-controlled `gh` argv;
- POST/PATCH/PUT/DELETE in the v1 GitHub adapter;
- token insertion into audit/error/result/log fields;
- full raw job log artifacts;
- arbitrary repo/URL inputs;
- CI background pollers/webhooks/caches.

## 19. Live dogfood acceptance

Use KodeGPT's own trusted repository after automated tests pass.

Required live acceptance:

1. trusted workspace `/home/sauron/dev/kodegpt` is READY;
2. Git remote auto-resolves to `2ndworld/kodeGPT`;
3. existing `gh` authentication is discovered without a new KodeGPT login;
4. `ci.repository` reports provider `github`, selected remote, canonical repository, current HEAD/ref, default branch, and auth availability without credential leakage;
5. `ci.status()` observes a real pushed commit/run;
6. `ci.runs()` returns recent Actions runs within default bound;
7. `ci.run({ runId })` inspects one real run;
8. `ci.failure({ runId })` is tested against a historical failed run if one already exists;
9. main is never intentionally broken merely to manufacture a failure;
10. if no suitable historical failure exists, failure extraction is accepted through adversarial fixtures plus a live no-failure/not-found behavior check.

Live acceptance also verifies the public ChatGPT/MCP host has refreshed the new surface and can perform the ergonomic flow without manually asking the user for repository/SHA/run/job identifiers.

## 20. Completion criteria

Bounded Remote-CI Intelligence v1 is complete only when all of the following are true:

- the exact five-tool typed public surface exists;
- semantic surface is `0.7`, protocol remains `2026-07-28`;
- the normal one-workspace `ci.status()` call requires no repository/SHA input;
- repository identity is derived from trusted local Git remote state;
- arbitrary repository override/browsing is impossible;
- existing `gh` login works as credential source without extra KodeGPT login;
- `gh` is credential bootstrap only, never an API semantic surface;
- GitHub reads use the typed direct adapter;
- all remote operations are GET/read-only;
- no generic GitHub REST/GraphQL or generic shell interface exists;
- no full/raw CI log surface exists;
- provider/log responses are bounded before public serialization;
- explicit deterministic truncation metadata is present;
- current credentials and obvious secrets are redacted from failure evidence;
- credentials cannot leak through MCP results, public errors, audit, or ordinary logs;
- normalized stable CI errors exist, including structured rate-limit metadata;
- durable audit decision/outcome records exist without becoming a secret store;
- no background polling/cache/webhook subsystem is introduced;
- automated TDD suites pass;
- live KodeGPT dogfood passes;
- pre-existing workspace/Rust security invariants remain intact;
- Provider Gateway remains deferred.

## 21. Future work deliberately deferred

The following may be designed only after v1 is implemented, accepted, and proven useful:

- native KodeGPT GitHub credential storage;
- OAuth/device flow;
- GitHub Enterprise support;
- other CI providers behind the same provider-neutral adapter contract;
- conditional background monitoring as a separately approved subsystem;
- CI mutation such as rerun/cancel/dispatch;
- provider interoperability/Provider Gateway.

None of those future items are implied authority in this specification.

## 22. Implementation gate

This document is design only.

The required sequence after this commit is:

1. user reviews and explicitly approves this written design;
2. invoke Superpowers `writing-plans`;
3. produce a detailed TDD implementation plan;
4. only then begin production implementation.

Until step 1 is complete, no Remote-CI production code, runtime surface, service rebuild, or live-service cutover is authorized.
