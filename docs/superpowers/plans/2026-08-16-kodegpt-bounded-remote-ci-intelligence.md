# Bounded Remote-CI Intelligence v1 Implementation Plan

> Execution skill: `superpowers:executing-plans` in this ChatGPT/CodexPro session. Use TDD for every behavior change, `superpowers:using-git-worktrees` before implementation, and `superpowers:verification-before-completion` before completion claims.

**Goal:** Implement bounded read-only GitHub CI intelligence for the currently trusted KodeGPT workspace so `ci.status()` can inspect pushed/local HEAD without owner/repository/SHA/run/job boilerplate from the user.

**Canonical design:** `docs/superpowers/specs/2026-08-16-kodegpt-bounded-remote-ci-intelligence-design.md`.

## Global constraints

- Runtime remains `0.1`; MCP protocol remains `2026-07-28`; surface advances exactly `0.6 -> 0.7` absent unrelated concurrent work.
- Public MCP tools are exactly `ci.repository`, `ci.status`, `ci.runs`, `ci.run`, `ci.failure`; expected total inventory `46 -> 51`.
- Tool annotations: `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`.
- V1 provider is only `github.com`; GitHub Enterprise is unsupported.
- Public inputs never accept owner, repository, provider, remote URL, arbitrary URL/path, page, cursor, or generic provider arguments.
- Repository identity comes only from a READY trusted workspace and its configured fetch remote through a private Rust-backed inspection route.
- Remote selection: prefer `origin`; otherwise require exactly one fetch remote; unsupported `origin` fails without fallback; at most 32 remotes may be observed.
- `gh` is used privately only as fixed `gh auth token --hostname github.com`; no user-controlled argv and never through public `process.run`.
- GitHub semantic requests are typed HTTPS GET-only operations; no generic GitHub client/gateway and no mutation.
- Metadata body limit: `1 MiB`. Serialized public result limit: `512 KiB`.
- `CI_LOG_SCAN_MAX_BYTES=512 KiB`, `CI_LOG_EXCERPT_DEFAULT_BYTES=64 KiB`, `CI_LOG_EXCERPT_MAX_BYTES=256 KiB`.
- Collection bounds: status summaries 50, status failures 20, runs default 10/max 50, run jobs 100, steps/job 100, annotations 100, failure jobs 100, failure annotations 100.
- Request budgets per invocation: repository 1, status 6, runs 1, run 2, failure 5.
- No polling, retry-to-success loops, arbitrary pagination traversal, provider cache, webhook receiver, long-lived provider session, or credential store.
- Truncation reasons are exactly `SUMMARY_LIMIT`, `RUN_LIMIT`, `JOB_LIMIT`, `STEP_LIMIT`, `ANNOTATION_LIMIT`, `LOG_BYTE_LIMIT`, `PROVIDER_PAGE_LIMIT`, `RESPONSE_LIMIT`; invariant `truncated === (truncationReasons.length > 0)`.
- Current credential is redacted first, then high-confidence GitHub token/header/credential-URL/secret-env patterns. Raw/full logs are never exposed/persisted. Cross-origin log redirects never receive `Authorization`; redirect must be HTTPS, no userinfo, at most one validated provider-issued redirect.
- Durable audit decision must succeed before credential/network activity; final audit outcome must succeed before public result return. Any audit failure returns `CI_AUDIT_UNAVAILABLE` and fails closed.
- Stable CI errors: `CI_WORKSPACE_AMBIGUOUS`, `CI_AUDIT_UNAVAILABLE`, `CI_AUTH_REQUIRED`, `CI_AUTH_FAILED`, `CI_REPOSITORY_UNAVAILABLE`, `CI_REPOSITORY_MISMATCH`, `CI_REMOTE_UNSUPPORTED`, `CI_NOT_FOUND`, `CI_PERMISSION_DENIED`, `CI_RATE_LIMITED`, `CI_PROVIDER_UNAVAILABLE`, `CI_RESPONSE_INVALID`, `CI_RESPONSE_LIMIT_EXCEEDED`, `CI_LOG_UNAVAILABLE`, `CI_LOG_LIMIT_EXCEEDED`.
- Provider Gateway, generic `provider.*`, `skill.run`, generic GitHub REST/GraphQL, generic `gh`, CI mutation, and raw-log tools remain forbidden/deferred.
- Do not cut over the installed service until all automated verification passes and a separate release-acceptance checkpoint is reached. Do not merge without explicit user authorization.

## Task 1 — Public contracts, limits, schemas, errors

Create `packages/capabilities/src/remote-ci/{contracts.ts,schemas.ts,contracts.test.ts}` and modify capability contracts/errors/index.

TDD checks:
- exact five `ci.*` IDs;
- strict schemas reject repository/provider/url/page overrides;
- provider IDs are decimal strings;
- runs max 50;
- exact constants, truncation vocabulary, request budgets, and CI error vocabulary;
- safe rate-limit detail only.

Verify:
```bash
pnpm vitest run packages/capabilities/src/remote-ci/contracts.test.ts packages/capabilities/src/contracts.test.ts
pnpm --filter @kodegpt/capabilities typecheck
```
Commit: `feat: define remote ci contracts`.

## Task 2 — Private Rust-backed repository identity inspection

Modify protocol/runtime Git/dispatcher and `packages/core/src/workspace-manager.ts` plus tests.

Add closed private `git.repository_identity` behavior using only fixed hardened Git operations for HEAD/symbolic branch/configured remote URLs; no shell/caller argv. Return private bounded `{headOid, branch, remotes}` only through WorkspaceManager; reject >32 remotes.

Verify:
```bash
cargo test --workspace git_repository_identity
pnpm vitest run packages/core/src/workspace-manager.test.ts
```
Commit: `feat: inspect trusted git repository identity`.

## Task 3 — Durable Rust CI audit decision/outcome RPC

Modify protocol/runtime audit/dispatcher and WorkspaceManager plus tests.

Add closed private `ci.audit`; audit actions for all five capabilities; bounded sanitized repository/provider/credentialSource/runId/jobId/errorCode/truncated/duration metadata only. `credentialSource` only `gh`; repository only owner/name; IDs decimal strings. Fail closed on audit sink failure.

Verify:
```bash
cargo test --workspace ci_audit
pnpm vitest run packages/core/src/workspace-manager.test.ts
```
Commit: `feat: audit remote ci observations`.

## Task 4 — Trusted-workspace GitHub repository resolver

Create `packages/capabilities/src/remote-ci/{repository-resolver.ts,repository-resolver.test.ts}` and update adapters.

Accept exactly the approved GitHub remote forms, reject embedded credentials/GHE/unsupported hosts, select workspace and remote deterministically, and never allow public repository override.

Verify:
```bash
pnpm vitest run packages/capabilities/src/remote-ci/repository-resolver.test.ts
```
Commit: `feat: resolve trusted github repository`.

## Task 5 — Fixed `gh` credential bootstrap

Create `credential-provider.ts` and tests; update adapters.

Resolve/canonicalize executable outside workspace paths. Execute only absolute `gh` with argv `auth token --hostname github.com`, no shell, bounded stdout/stderr, fixed timeout, invocation-scoped token only. Missing login -> `CI_AUTH_REQUIRED`; malformed/helper unsafe -> `CI_AUTH_FAILED`.

Verify:
```bash
pnpm vitest run packages/capabilities/src/remote-ci/credential-provider.test.ts
```
Commit: `feat: read existing github credential safely`.

## Task 6 — GET-only bounded GitHub HTTP transport

Create `github-http.ts` and tests.

Use base `https://api.github.com`, method GET only, fixed headers, authenticated only for API origin, streaming 1 MiB metadata ceiling, sanitized provider errors, manual one-hop validated log redirect, no cross-origin Authorization, bounded log stream.

Verify:
```bash
pnpm vitest run packages/capabilities/src/remote-ci/github-http.test.ts
```
Commit: `feat: add bounded github read transport`.

## Task 7 — Typed GitHub adapter

Create `github-adapter.ts` and tests; update adapters.

Expose only provider-neutral typed operations `repository`, `statusEvidence`, `runs`, `run`, `failureMetadata`, `failureLog`. Normalize only required fields, use fixed endpoint families, decimal-string IDs, safe GitHub HTML URLs, case-insensitive canonical repository equality, deterministic provider-page truncation signals, and no generic request surface.

Verify:
```bash
pnpm vitest run packages/capabilities/src/remote-ci/github-adapter.test.ts
```
Commit: `feat: normalize github ci evidence`.

## Task 8 — Redaction and public response budget

Create `redaction.ts`, `redaction.test.ts`, `response-budget.ts`.

Implement exact-token-first deterministic redaction, UTF-8 safe clipping, serialized 512 KiB fitting, deterministic optional-evidence trimming, one `RESPONSE_LIMIT` reason, and `CI_RESPONSE_LIMIT_EXCEEDED` if mandatory content still exceeds limit.

Verify:
```bash
pnpm vitest run packages/capabilities/src/remote-ci/redaction.test.ts
```
Commit: `feat: bound and redact ci evidence`.

## Task 9 — RemoteCiService repository/runs/run with audit ordering

Create `service.ts`, `service.test.ts`, `index.ts`; update adapters.

Required success order: resolve repository -> audit decision -> credential -> provider read -> audit success. Pre-network audit failure stops before credential; final audit failure discards provider result. `ci.repository` missing auth is a diagnostic result (`available=false`, auth required) without metadata access. Enforce request/collection/response bounds.

Verify:
```bash
pnpm vitest run packages/capabilities/src/remote-ci/service.test.ts
```
Commit: `feat: orchestrate remote ci reads`.

## Task 10 — `ci.status` default-HEAD aggregation

Extend service/tests.

Zero-argument path chooses sole READY workspace, defaults revision to local HEAD, preserves repository identity, resolves allowed local GitRevision overrides, and normalizes overall state with exact precedence `FAIL > PENDING > CANCELLED > UNKNOWN > PASS`; no evidence -> `UNKNOWN`. Bound combined summaries to 50, failures to 20, requests to 6.

Verify:
```bash
pnpm vitest run packages/capabilities/src/remote-ci/service.test.ts -t status
```
Commit: `feat: summarize remote ci status`.

## Task 11 — Bounded failure evidence and streamed redacted logs

Extend adapter/service/redaction tests and implementation.

Deterministic failed-job selection: fail-like with failed step; fail-like without failed step; provider order when stable; start time; decimal ID. Optional job must belong to run. Examine <=100 jobs/100 annotations, scan <=512 KiB, excerpt default 64 KiB/max 256 KiB, redact before construction/audit derivation, no artifacts/full logs, unsafe redirect -> `CI_LOG_UNAVAILABLE`, unstreamable oversize -> `CI_LOG_LIMIT_EXCEEDED`, total provider requests <=5.

Verify:
```bash
pnpm vitest run packages/capabilities/src/remote-ci/github-adapter.test.ts packages/capabilities/src/remote-ci/service.test.ts -t failure
```
Commit: `feat: extract bounded ci failure evidence`.

## Task 12 — Production wiring

Modify `apps/cli/src/commands/start.ts`, tests, capability adapters/index.

Wire private repository inspection and audit through existing WorkspaceManager; construct credential/HTTP/provider/service lazily per invocation. Startup must not contact provider and must succeed with CI auth absent. Do not add a provider gateway or second trust store.

Verify:
```bash
pnpm vitest run apps/cli/src/commands/start.test.ts
```
Commit: `feat: wire remote ci service`.

## Task 13 — Exactly five MCP tools and surface 0.7

Modify MCP annotations/context/tools/surface version, structured/server inventory tests, and host compatibility checklist.

Register exactly the five tools with strict input/output schemas and Remote-CI read-only/open-world annotations. Update current surface to `0.7`; preserve intended prior-version parsing compatibility. Expected inventory 51.

Verify:
```bash
pnpm vitest run packages/mcp-server/src/structured-results.test.ts packages/mcp-server/src/server.test.ts tests/host/host-compatibility-checklist.test.ts
```
Commit: `feat: expose bounded remote ci tools`.

## Task 14 — Skill metadata reconciliation only

Modify capability skill metadata/tests and capability-plan tests.

Add bounded advisory semantic metadata for five CI capabilities. Do not add `skill.run`, provider invocation, generated `gh` commands, or execution authority.

Verify:
```bash
pnpm vitest run packages/capabilities/src/skill-metadata.test.ts packages/skills/src/capability-plan.test.ts
```
Commit: `feat: describe native ci capabilities`.

## Task 15 — Security guards and fake-provider integration

Modify `tests/integration/ci-contract.test.ts`, `tests/integration/full-stack.test.ts`, `tests/security/forbidden-patterns.test.ts`, `scripts/forbidden-patterns.mjs`.

Forbid public/generic/mutation names including `github.request`, `github.graphql`, `github.rest`, `gh.run`, `ci.logs.raw`, `ci.jobs.list`, `ci.steps.list`, `ci.rerun`, `ci.cancel`, `ci.dispatch`, `provider.list`, `provider.tools`, `provider.invoke`, `skill.run`; forbid `gh api`; prove Remote-CI semantic HTTP cannot select POST/PUT/PATCH/DELETE. Add fake-provider full-stack tests for all five tools and audit/redaction assertions.

Verify:
```bash
pnpm vitest run tests/integration/ci-contract.test.ts tests/integration/full-stack.test.ts tests/security/forbidden-patterns.test.ts
node scripts/forbidden-patterns.mjs
```
Commit: `test: lock remote ci security boundary`.

## Task 16 — Complete automated verification

Run fresh:
```bash
pnpm test
cargo test --workspace
pnpm run typecheck
pnpm run build
pnpm run verify:forbidden
pnpm run verify:package
pnpm run test:acceptance
```

Review whole branch for intended scope only, exact 51 tools, surface `0.7`, protocol unchanged, no token persistence/raw log artifacts/generic provider surface/mutation. If any gate fails, return to the smallest owning task, add regression coverage, fix, and commit separately.

## Task 17 — Live dogfood and readiness evidence

Only after Task 16 passes, use established immutable service staging/cutover flow. Verify running/enabled/listenerReady/managedExposure, runtime `0.1`, protocol `2026-07-28`, surface `0.7`, zrok `public:kodegpt-dev`, local port `43121`, and record active/rollback release IDs.

Refresh host surface and verify 51 tools. Live test against trusted `/home/sauron/dev/kodegpt`: `ci.repository`, zero-argument `ci.status`, `ci.runs`, `ci.run`, and `ci.failure` on a historical failed run if one exists; never intentionally break `main`. Verify durable audit contains bounded action/provider/repository/outcome only and no token/raw log/header/body.

Create `docs/release/2026-08-16-bounded-remote-ci-readiness.md` and commit `docs: record remote ci readiness`.

## Task 18 — Final review, tracker reconciliation, merge handoff

Update `docs/implementation/v0.1-execution-tracker.md` only with verified facts: candidate SHA, exact `0.1 / 2026-07-28 / 0.7`, 51 tools, automated/live status, active/rollback release evidence, Provider Gateway deferred.

Final smoke:
```bash
pnpm run typecheck
pnpm run verify:forbidden
```

Review cleanliness and absence of generated credentials/logs. Commit `docs: close bounded remote ci readiness`. Stop before merge/push/PR unless explicitly authorized by user; prepare handoff with branch, exact HEAD/base, verification evidence, readiness doc, release IDs, and live status.
