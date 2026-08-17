# KodeGPT Trusted Toolchain, Repository Impact, and CI Mutation Design

Date: 2026-08-17
Status: approved by the user's four-priority execution request
Baseline: canonical `main` at `39b4a4ea04d206fac50bbb3c7cbda0c922cec0aa` (PR #26 merge)

## Goal

Close three concrete gaps on top of Trusted Process Policy v2 and Repository Intelligence v2 without widening KodeGPT into a generic host shell, generic repository indexer, or generic GitHub API client:

1. make trusted verification/process execution compose already-trusted Node and Rust toolchains in one Bubblewrap sandbox;
2. add bounded targeted repository impact evidence for a file or symbol target;
3. add typed bounded GitHub Actions mutations for rerun, cancel, and workflow dispatch.

`.ai-bridge/current-plan.md` is reconciled separately as a chronology-preserving planning update.

## 1. Trusted multi-toolchain sandbox

### Problem

`verify.run(package:test)` launches `pnpm` through an explicitly mounted Node toolchain root. The sandbox PATH therefore contains only the Node toolchain mount plus fixed system paths. Nested tests that spawn `cargo` fail with `spawnSync cargo ENOENT`, even though `cargo` is independently trusted and allowed by the effective trusted policy.

### Design

Keep top-level executable resolution unchanged. Extend `SandboxLaunchSpec` with a bounded list of additional already-resolved trusted executables. For the `trusted` profile only, `run_process` resolves the other allowed Node/Rust toolchain executables that are present (`node`, `npm`, `npx`, `pnpm`, `cargo`, `rustc`) and passes successful resolutions as auxiliary toolchain evidence. Missing optional tools are ignored; an identity/revalidation failure for a tool that is selected for mounting fails closed.

`BubblewrapProvider` deduplicates explicit roots by validated root identity, opens each root by FD, mounts them read-only at deterministic child paths such as `/opt/kodegpt-toolchains/0`, `/opt/kodegpt-toolchains/1`, and constructs PATH only from their `/bin` directories followed by the existing fixed `/usr/local/bin:/usr/bin:/bin`. It never imports host PATH or arbitrary environment directories. The primary executable is executed from its mounted root when applicable. Corepack remains a separately validated optional Node support mount.

`observe` and `develop` do not receive auxiliary toolchain mounts and retain current behavior.

### Security invariants

- Bubblewrap remains mandatory.
- Workspace remains retained-root `/workspace`; writeability still comes only from effective policy.
- `HOME=/home/kodegpt` and environment clearing remain unchanged.
- Host PATH/environment is never inherited.
- Every explicit toolchain root comes from existing trusted executable resolution and is revalidated before spawn.
- System runtime mounts remain read-only.
- Audit, opaque operation IDs, output spooling, cancellation, and filesystem boundaries remain unchanged.

## 2. Bounded repository impact intelligence

### Public shape

Add one read-only capability and typed MCP tool: `code.impact`.

Input:

```ts
interface CodeImpactInput {
  workspaceId: string;
  target: string;
  kind?: "file" | "symbol" | "auto";
  path?: string;
  maxResults?: number;
}
```

Output is deterministic and evidence-oriented:

```ts
interface CodeImpactResult {
  schemaVersion: 1;
  target: { kind: "file" | "symbol"; value: string; resolvedPaths: string[] };
  dependents: Array<{ path: string; relationship: "imports" | "module" | "reference"; line?: number }>;
  relatedTests: string[];
  affectedAreas: string[];
  truncated: boolean;
  truncationReasons: Array<"TARGET_LIMIT" | "DEPENDENT_LIMIT" | "TEST_LIMIT" | "AREA_LIMIT" | "SEARCH_LIMIT">;
}
```

### Implementation

Reuse the existing bounded `workspace.inspect` / repository-analysis relationships and the existing code-search adapter. Do not add a parser dependency or index.

- File target: normalize/validate a workspace-relative path, then derive reverse `imports`/`module` relationships, direct `tests` relationships, and bounded lexical references to the file stem/exported symbols only when useful.
- Symbol target: use existing `code.search` definition/symbol/reference machinery to resolve bounded definitions and references, then combine their files with repository relationships and conventional related tests.
- `affectedAreas` are stable top-level/scoped package or crate areas derived from impacted paths, not guessed semantic ownership.
- All arrays are deduplicated and sorted.
- Bounds are explicit and truncation reasons are stable.
- No network, execution, persistent cache, background indexing, Tree-sitter, compiler API, or plugin framework.

## 3. Bounded CI mutation

### Public tools

Add three typed tools next to the existing `ci.*` reads:

- `ci.rerun({ workspaceId?, runId, failedOnly? })`
- `ci.cancel({ workspaceId?, runId })`
- `ci.dispatch({ workspaceId?, workflow, ref, inputs? })`

`inputs` is a bounded string-to-string map with bounded key/value counts and lengths. No arbitrary headers, methods, URLs, endpoints, REST/GraphQL payloads, or `gh api` surface are accepted.

### Provider path

Reuse the existing remote-CI repository resolver, `gh` credential provider, GitHub adapter/HTTP transport, redaction, and durable audit path. Do not introduce a second credential source. The mutation methods use fixed GitHub Actions endpoints constructed exclusively from normalized repository identity and typed IDs/workflow/ref values.

### Retry semantics

Mutation requests are single-attempt. The transport may perform no blind retry after a request has been written. Definite provider rejection is returned as a typed failure. Network/timeout/connection failures after dispatch are reported as `CI_MUTATION_OUTCOME_UNKNOWN` (or equivalent dedicated CI error) so callers can observe state before deciding whether to try again manually. Read requests retain their existing retry behavior, if any.

### Result

Each mutation returns a small acknowledgement with `schemaVersion: 1`, repository identity, operation kind, typed target, and `accepted: true` when GitHub definitively accepts the mutation. No token/provider raw body is exposed.

### Audit and redaction

Decision is durably recorded before the effect. Success/failed outcome is recorded after the single attempt. Audit records contain only typed public identifiers and never credential values, headers, arbitrary inputs values, or raw provider bodies. Dispatch input values are omitted from durable audit.

## 4. Versioning and compatibility

- Trusted multi-toolchain is an internal sandbox behavior fix and does not by itself change MCP surface version.
- `code.impact` and the three CI mutation tools are new public tools, so MCP surface version must bump once from current `0.9` to `0.10`.
- Runtime protocol version remains `2026-07-28` unless implementation proves a protocol schema change is actually required; these capabilities are TypeScript/MCP/provider-side and should not require one.
- Existing read tools and `observe`/`develop` behavior remain backward compatible.

## 5. Test strategy

TDD must prove:

1. baseline `verify.run(package:test)` fails with nested `cargo ENOENT` before the fix;
2. sandbox unit/integration coverage demonstrates a primary Node tool can invoke auxiliary trusted Rust tooling with controlled PATH;
3. trusted process/verify execution can compose Node and Rust while `observe`/`develop` remain unchanged;
4. host PATH/environment is not inherited and external filesystem boundaries remain intact;
5. `code.impact` returns deterministic reverse relationships, references, related tests, affected areas, and stable truncation semantics for file and symbol targets;
6. impact analysis is read-only and bounded;
7. CI rerun/cancel/dispatch schemas reject generic or oversized inputs;
8. GitHub adapter uses only fixed typed endpoints and single-attempt mutation semantics;
9. ambiguous mutation outcomes are surfaced distinctly and are not retried;
10. audit/redaction never persist credentials or dispatch input values;
11. MCP tools, structured-result fixtures, capability plans/contracts, security invariants, and surface version reflect exactly the intended new tools;
12. focused tests, full Vitest/typecheck/build, Rust fmt/test, forbidden-pattern/security/integration/package verification pass;
13. post-release live acceptance proves `verify.run(package:test)` no longer fails because `cargo` is missing, `code.impact` returns bounded evidence, and safe CI mutation dogfood works where a non-destructive target is available.

## 6. Non-goals

No host PATH inheritance, generic shell widening outside existing trusted behavior, new host mounts, Docker/root authority, background index, watch mode, Tree-sitter/compiler dependency, generic provider invoke, generic REST/GraphQL, `gh api`, arbitrary GitHub endpoint/method/header input, new credential path, automatic repeated mutation attempts, or changes to the `observe`/`develop` philosophy.
