# Actionable Capability Errors — Readiness

Status date: 2026-08-18  
Branch: `feat/actionable-capability-errors`  
Baseline: merged PR #34, `7a2157508c93447268359925b7d2da5d4058242b`  
Implementation commit: `7c2ad72c7f6ea59e1d2a589f259a0e06583c6e82`  
Status: implementation and source verification complete; ready for PR/CI, merged-main release reconciliation, and live acceptance.

## Scope

Capability failures that already have a stable typed meaning can now carry bounded recovery metadata through the existing public `CapabilityError.details` object:

- `reason`: one of `AUTHENTICATION_REQUIRED`, `RATE_LIMITED`, `STALE_EXPECTED_STATE`, or `MUTATION_OUTCOME_UNKNOWN`;
- `retryable`: boolean caller guidance;
- `suggestedAction`: one of `authenticate`, `retry`, or `refresh-state`.

The metadata is emitted only where the existing typed semantics make the recovery action intrinsic:

- Remote-CI missing/not-logged-in `gh` authentication and GitHub HTTP 401 -> `AUTHENTICATION_REQUIRED`, `retryable=false`, `authenticate`;
- Remote-CI GitHub rate limiting -> `RATE_LIMITED`, `retryable=true`, `retry`, while preserving bounded `retryAfter` / `resetAt` when present;
- Remote-CI ambiguous mutation transport failure -> `MUTATION_OUTCOME_UNKNOWN`, `retryable=false`, `refresh-state`;
- provider HTTP 429 -> `RATE_LIMITED`, `retryable=true`, `retry`;
- provider 401/403 only when an operation credential was actually sent -> `AUTHENTICATION_REQUIRED`, `retryable=false`, `authenticate`;
- provider ambiguous mutation transport failure -> `MUTATION_OUTCOME_UNKNOWN`, `retryable=false`, `refresh-state`;
- `file.patch` stale/mismatched preconditions -> `STALE_EXPECTED_STATE`, `retryable=false`, `refresh-state`.

The serializer keeps these values closed and allowlisted. Invalid free-form `reason` or `suggestedAction` values cause details to be omitted rather than surfaced. Existing path, retry, and reset-time sanitization remains in force.

Runtime/protocol/public MCP surface remain `0.1 / 2026-07-28 / 0.10`.

## Explicit non-goals

This phase does **not** add a generic diagnostic framework, autonomous remediation, automatic authentication, a retry scheduler, provider-body/stderr parsing, arbitrary command suggestions, new MCP tools, provider authority, process/network/filesystem authority, or a surface-version bump.

`retryable=true` is caller guidance only. Existing provider retry behavior is unchanged. In particular, ambiguous mutation outcomes remain single-attempt and explicitly non-retryable until remote state is refreshed/reconciled.

## TDD evidence

The phase started from 60/60 PASS across the focused contracts/Remote-CI/provider suites. RED tests then proved the missing contract in four independently typed classes:

1. the public serializer dropped actionable fields because the closed detail vocabulary did not yet exist;
2. `CI_AUTH_REQUIRED` carried no recovery metadata;
3. GitHub auth/rate-limit/ambiguous mutation failures carried no recovery metadata;
4. provider auth/rate-limit/ambiguous mutation failures and patch stale-precondition failures carried no recovery metadata.

GREEN changes were limited to the shared error-detail contract plus the existing typed constructors for those failure classes. Final focused result: 69/69 PASS across six suites.

## Verification

Fresh verification on the implementation tree:

- focused actionable suites: `69/69` PASS;
- capability package: `39` files / `358` tests PASS;
- capability package typecheck: PASS;
- complete TypeScript/Vitest suite: `118` files / `825` tests PASS;
- root `pnpm run typecheck`: PASS;
- root `pnpm run build`: PASS;
- `cargo test --workspace -- --test-threads=1`: PASS across the complete Rust workspace;
- `git diff --check`: PASS.

Build/test output contains only pre-existing Rust dead-code/unused warnings.

## Review

Complete-diff review through CodexPro found no authority expansion and no retry-semantic drift. The public addition is a closed extension of the existing `CapabilityError.details` object, not a new tool/result surface. No raw provider body, credential helper stderr, host path, credential, token, or arbitrary suggested command is exposed.

Two deliberate distinctions remain:

- generic credential-helper bootstrap corruption/timeouts stay `CI_AUTH_FAILED` without an `authenticate` action because authentication is not necessarily the remedy;
- provider credential-helper unavailable/framing failures stay generic; only a remote 401/403 after a credential was actually sent is labeled `AUTHENTICATION_REQUIRED`.

These boundaries avoid overstating recovery guidance.

## Remaining closure

Before final phase closure:

1. push the exact branch and create a focused PR against `main`;
2. require deterministic CI PASS;
3. merge with exact-head protection;
4. fast-forward canonical `main` to the merge commit;
5. build/stage an immutable merged-main release and perform explicit restart/cutover;
6. live-dogfood a safe stale patch precondition and confirm the public failure contains `STALE_EXPECTED_STATE`, `retryable=false`, `refresh-state`, while health and `0.1 / 2026-07-28 / 0.10` remain unchanged.
