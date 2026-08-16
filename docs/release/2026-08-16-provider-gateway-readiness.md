# Provider Gateway — Local Core Readiness

Status date: 2026-08-16
Branch: `feat/provider-gateway`
Implementation baseline: `e1ae8bd03a8690123b8c8def971c97817b6e0949`
Pre-documentation exact source/evidence candidate: `f6523c3297fb0e0e77045d780bf8a4119b86dd8a`
Runtime / protocol / public MCP surface: `0.1 / 2026-07-28 / 0.7`
Status: PASS — the private Provider Gateway core, local operator authority, security boundary, and automated verification are implemented and green. Production provider-backed semantic capability remains intentionally absent because the production compiled-adapter inventory is empty and no public MCP provider capability was added.

## Scope and authority result

This phase implements a private, typed semantic-provider bridge for `REMOTE_READ` mappings. It does not implement a generic provider passthrough and does not add a public provider MCP namespace.

Implemented local/private authority includes:

- durable local provider admission state;
- compiled adapter and semantic mapping validation;
- implementation/helper identity verification and JIT credential acquisition;
- exact-origin bounded HTTPS transport;
- structural inventory fingerprinting and explicit local reapproval;
- bounded output normalization;
- cancellation/deadline/retry/request budgeting;
- local operator CLI commands `provider add`, `remove`, `enable`, `disable`, `reapprove`, `list`, and `inspect`;
- private production runtime construction and lifecycle ownership;
- durable global `provider.audit` decision/outcome routing;
- workspace/profile network gating for workspace-bound provider reads.

Explicitly absent after this phase:

- any public `provider.*` MCP tool;
- `provider.invoke`, generic request/GraphQL/REST/write/mutation authority, or caller-selected raw URL/method/header/argv authority;
- provider-agent or provider-operation subprocess proxying;
- raw credential persistence;
- repository/CI-controlled provider admission or reapproval;
- a production compiled provider adapter/mapping;
- `skill.run` or provider execution authority derived from skill metadata;
- any MCP surface increment above `0.7`.

The only provider subprocess authority is the reviewed external credential-helper bootstrap path. Provider operations themselves use the bounded in-process semantic transport rather than an arbitrary provider process.

## Exact implementation commits

The branch implementation sequence from the accepted baseline through the pre-documentation candidate is:

```text
b6bd3f3 feat: define provider gateway contracts
4cfdae5 feat: persist provider admission state
bd2a0ab feat: define compiled provider mappings
5cc978e feat: audit provider gateway operations
d2896a6 feat: verify provider implementation identity
09f481d feat: acquire provider credentials safely
0369988 feat: add bounded provider network transport
48bbd76 feat: fingerprint provider inventory structure
8fc33d5 feat: normalize provider output safely
bca8798 feat: bound provider operation lifecycle
5894505 feat: orchestrate provider admission state
1e78cf5 feat: execute typed provider semantic reads
f1bfe5c feat: add provider operator commands
d785671 feat: wire private provider gateway runtime
5f50d2f test: preserve provider skill boundary
f6523c3 test: lock provider gateway security boundary
```

Task 17 required no corrective source commit after final verification and whole-branch review.

## Local registry and admission evidence

Provider admission state is stored beneath the selected KodeGPT state root at:

```text
$STATE_ROOT/providers/registry.json
```

The implementation enforces:

- provider state directory mode `0700`;
- registry file mode `0600`;
- strict schema version `1` and fail-closed malformed/unsupported state handling;
- deterministic entry ordering;
- atomic temporary-file write, file `fsync`, rename, final mode enforcement, and directory `fsync`;
- secret-looking non-secret adapter config rejection;
- provider instance IDs in the form `prv_<32 lowercase hex>`.

Task 11 regression coverage additionally locks recovery when insert/replace/remove becomes authoritative before a durability error is reported and prevents generated-ID collision handling from deleting an existing provider.

Admission and mutation remain operator-local. No repository file, CI workflow, skill bundle, MCP caller, or provider response can self-admit or self-reapprove a provider.

## Credential/helper boundary

External credentials are acquired JIT. The registry persists only non-secret broker/helper identity metadata; it never stores the returned credential value.

The external helper boundary requires the reviewed implementation identity path and retains the approved limits:

- absolute/canonical regular executable outside workspace roots;
- pinned SHA-256 and revalidation immediately before execution;
- compiled argv and environment only;
- `shell=false` and no inherited parent environment;
- stdin ignored;
- detached process group for cancellation/timeout cleanup;
- stdout and stderr each bounded to 64 KiB;
- credential helper deadline `5,000 ms`.

Credential values are transient and are used only downstream of a durable provider audit decision.

## Network and semantic execution boundary

Public/caller inputs select a compiled semantic capability and admitted provider instance; they cannot supply transport authority.

The transport and lifecycle remain bounded by:

```text
request body              <= 256 KiB
provider metadata response <= 2 MiB
semantic result            <= 512 KiB
structural depth           <= 16
structural elements        <= 1000
hard provider requests     <= 8
total operation deadline   = 30 s
network attempt deadline   = 10 s
credential helper deadline = 5 s
```

Internet transport uses HTTPS exact compiled origins, validates all resolved addresses, rejects loopback/private/link-local/multicast/unspecified and IPv4-mapped forbidden addresses, rejects mixed public/private DNS answers, connects to a validated address while retaining the compiled hostname for TLS/SNI, denies redirects by default, and strips credentials on permitted cross-origin redirects.

Retry is limited to one additional attempt only for a mapping explicitly compiled as `one-idempotent-read`, and only for transient unavailable/timeout failures. Effective request authority is bounded by both the global ceiling and the mapping-specific ceiling.

Workspace-bound semantic execution accepts network access only from a READY workspace whose effective network policy resolves to `unrestricted`. `observe` and `develop` remain denied in conformance coverage; `trusted` permits the reviewed read; `workspaceBinding=NONE` does not consult workspace authority.

## Inventory and drift evidence

Dynamic inventory identity is structural only. Provider-controlled descriptions, prose, prompts, and instructions do not contribute policy authority or the structural fingerprint.

Execution fails closed on:

- implementation fingerprint drift: `PROVIDER_IDENTITY_CHANGED`;
- structural inventory drift: `PROVIDER_INVENTORY_CHANGED`.

`enable` never auto-updates an approved fingerprint. Only explicit local `reapprove` may accept a changed implementation/inventory identity. Conformance evidence proves structural drift remains blocked across repeated executions until reapproval, while prose-only inventory changes do not change the approved fingerprint.

The conformance adapter is test-only under `tests/**`. It is not present in `PRODUCTION_PROVIDER_MANIFESTS`.

## Durable audit evidence

Provider audit uses the private runtime method:

```text
provider.audit
```

It is global/private runtime authority and records `capability_id = None`; it does not depend on a workspace capability identifier. Decision audit is required before credential/helper/network/state-mutation effects. If the durable decision audit is unavailable, execution/admission fails closed before those effects.

Provider audit metadata is allowlisted and bounded. Conformance tests verify that audit serialization does not contain helper path, credential value, Authorization/header values, request/response body, or environment data.

Task 16 integration evidence locks admission ordering:

```text
audit add decision
-> credential
-> inventory
-> registry insert
-> audit add success
```

and semantic execution ordering:

```text
workspace authority
-> audit execute decision
-> credential
-> inventory check
-> bounded semantic transport
-> audit execute success
```

Failure paths emit a bounded failed outcome where audit remains available, while preserving fail-closed audit semantics.

## Complete automated verification

Fresh Task 17 verification on source/evidence candidate `f6523c3297fb0e0e77045d780bf8a4119b86dd8a`:

- focused Provider Gateway + provider CLI + integration: PASS — 16 files / 125 tests;
- `pnpm test`: initial run completed 730/731 with one timing-only `KernelClient` responsiveness failure under full-suite load; the exact test then passed in isolation, the entire `kernel-client.test.ts` file passed 7/7, and a fresh full rerun passed 112 files / 731 tests;
- `cargo test --workspace`: PASS across the complete Rust workspace, including global `provider.audit` protocol/runtime coverage;
- `pnpm run typecheck`: PASS across all TypeScript workspace projects;
- `pnpm run build`: PASS; existing Rust unused/dead-code warnings remained non-fatal;
- `pnpm run verify:forbidden`: PASS — `forbidden-pattern scan ok`;
- `pnpm run verify:package`: PASS — `package smoke ok`;
- `pnpm run test:acceptance`: PASS — 2 files / 6 tests;
- final worktree status before readiness documentation: clean.

Task 16 security/conformance evidence immediately preceding the full gate also passed:

- provider integration conformance: 17/17;
- focused integration + forbidden scanner + security invariants: 50/50;
- Provider Gateway + Remote-CI + CI-contract + skill regressions: 196/196;
- actual authored-product forbidden scan: PASS.

The isolated `KernelClient` timing result is recorded as a verification-run flake, not hidden: it was not reproducible in the owning test/file and the complete suite passed unchanged on the fresh rerun.

## Whole-branch authority review

Review from baseline `e1ae8bd03a8690123b8c8def971c97817b6e0949` through source candidate `f6523c3297fb0e0e77045d780bf8a4119b86dd8a` confirmed:

- no branch commit changed `packages/capabilities/src/remote-ci/**`;
- no branch commit changed production `packages/mcp-server/src/**`; Task 15 changed MCP tests only;
- public MCP inventory remains exactly 51 tools and surface `0.7`, with no tool name beginning `provider.`;
- `PRODUCTION_PROVIDER_MANIFESTS` remains `Object.freeze([])`;
- no CI/repository automation contains provider admission or reapproval wiring;
- hard-stop vocabulary for public/generic provider request/GraphQL/write/process authority is absent from authored product source; occurrences of `provider.invoke` are negative tests/forbidden guards;
- the only Provider Gateway `child_process` use is the bounded external credential-helper bootstrap;
- credential value references exist only in transient request authorization construction, not persisted registry state;
- the test-only conformance adapter remains under `tests/helpers/provider-gateway-fixture.ts` and is not production-registered.

## Remote-CI reconciliation

Bounded Remote-CI Intelligence remains the shipped standalone sibling capability. The Provider Gateway branch did not route, refactor, or replace any `ci.*` production implementation through the gateway.

Remote-CI therefore retains its independently reviewed GitHub-backed bounded semantic read implementation and its five public `ci.*` tools. Provider Gateway does not claim ownership of those shipped operations.

## Public surface and production-adapter status

The current release identity remains:

```text
runtime = 0.1
protocol = 2026-07-28
surface = 0.7
public MCP tools = 51
production provider manifests = 0
public provider MCP tools = 0
```

Provider Gateway core/operator authority is locally implemented and verified. That statement does **not** mean a production provider-backed semantic capability is available.

A future production provider capability requires a separately reviewed compiled adapter and semantic mapping to be added intentionally to the production manifest inventory, with its own provider-specific tests and acceptance. It must not be inferred from the existence of the generic core.

## Readiness decision

**PASS for local Provider Gateway core/operator implementation readiness.**

**NOT a production provider capability release.** No provider production adapter is registered, no public MCP provider capability exists, and no public surface increment is authorized by this closure.

This branch must stop before push, PR creation, or merge unless the user explicitly authorizes those actions.
