# KodeGPT Provider Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved Provider Gateway v1 as a private, typed, remote-read integration boundary with local operator admission, durable identity, bounded credentials/network/inventory/output, fail-closed audit ordering, and no new public MCP authority.

**Architecture:** Add one private `provider-gateway` subsystem under `@kodegpt/capabilities`, one global provider-audit RPC in the existing Rust runtime audit authority, and one local `kodegpt provider ...` operator command family. Provider adapters remain compiled KodeGPT code. The first implementation proves the full gateway contract with a test-only conformance adapter and mapping; the production adapter registry is intentionally empty, so this phase does not invent a third-party semantic capability, expose `provider.*` MCP tools, or route existing `ci.*` through the gateway.

**Tech Stack:** Node.js 24, TypeScript 5.9, Zod 4, Vitest 3, Rust workspace runtime/protocol crates, existing KodeGPT JSONL audit sink, existing profile/workspace manager APIs, Node `https`/`dns` primitives, pnpm 10.

**Canonical design:** `docs/superpowers/specs/2026-08-16-kodegpt-provider-gateway-design.md`.

## Global Constraints

- Runtime remains `0.1`; MCP protocol remains `2026-07-28`; MCP surface remains exactly `0.7`.
- Do not add any public MCP `provider.*` tool, generic provider tool enumeration, generic provider invocation, arbitrary HTTP capability, or `skill.run`.
- Do not add a production provider-backed semantic capability in this phase. The gateway is private infrastructure; its complete behavior is proven through a deterministic test-only conformance adapter/mapping.
- Do not refactor `packages/capabilities/src/remote-ci/**` through Provider Gateway. Remote-CI remains a shipped sibling service.
- V1 effect class is exactly `REMOTE_READ`. Remote provider mutation is outside this plan.
- Provider admission/reapproval/mutation is local operator CLI authority only. Workspace/repository/skill content never selects or mutates the registry, adapter, credential broker, helper path, or semantic mapping.
- Registry is `~/.kodegpt/providers/registry.json`, schema `1`, parent directory `0700`, file `0600`, strict unknown-field rejection, atomic durable replacement, no raw provider secrets.
- Provider instance IDs match `^prv_[0-9a-f]{32}$` and are immutable.
- Admission/reapproval ordering is security-critical: local validation -> compiled manifest -> helper identity without execution -> implementation identity -> operation ID -> durable audit decision -> credential acquisition if required -> dynamic inventory fetch if required -> structural inventory fingerprint -> atomic state write -> bounded success audit.
- No credential helper execution and no provider network side effect occurs before a durable provider audit decision.
- Dynamic inventory policy uses structural facts only. Provider descriptions, prompts, prose, and display text never participate in policy or fingerprints.
- Dynamic inventory ceilings are: 128 tools; 32 KiB input schema/tool; 32 KiB output schema/tool; structural depth 16; canonical inventory 512 KiB.
- Inventory drift fails closed with `PROVIDER_INVENTORY_CHANGED` until explicit local operator reapproval.
- Credentials are acquired just-in-time from an external provider-specific broker and retained only for one operation. KodeGPT v1 does not persist raw provider secrets.
- Credential helpers are absolute/canonical, outside every workspace root, SHA-256 pinned and revalidated before execution, invoked without shell or arbitrary argv, with no inherited environment, closed stdin, 64 KiB stdout/stderr caps, 5 second timeout, and process-tree cleanup.
- Internet provider traffic is HTTPS only, uses exact compiled origins, normal TLS verification, no caller-controlled scheme/host/port/auth destination/raw IP, rejects loopback/unspecified/link-local/multicast/private resolved addresses, and binds a validated address to the actual connection. Every retry performs fresh resolution and validation.
- Adapter requests use reviewed fixed method/endpoint/header templates and typed parameters. Generic REST/GraphQL passthrough is forbidden.
- Redirects are denied by default. A manifest may describe at most one reviewed redirect rule; a redirected origin is revalidated and credentials are removed on cross-origin redirect.
- Hard ceilings: semantic input 64 KiB; provider request body 256 KiB; provider metadata response 2 MiB; public semantic result 512 KiB; result elements 1000; structural depth 16.
- Provider output is untrusted: byte limit before parse, fatal UTF-8, strict structural parse, ASCII identifiers, NFC user strings, CRLF/CR normalized to LF, NUL rejected, no raw binary output.
- Credential/helper budget 5s; one network attempt 10s; total provider operation 30s; maximum 8 provider requests. Retry is off by default and may be one retry only for an explicitly idempotent read mapping.
- Cancellation is propagated with `AbortSignal`; pending sockets/helpers are terminated and there is no background provider session.
- Stable errors remain exactly: `PROVIDER_INPUT_INVALID`, `PROVIDER_STATE_INVALID`, `PROVIDER_NOT_ADMITTED`, `PROVIDER_DISABLED`, `PROVIDER_IDENTITY_CHANGED`, `PROVIDER_CREDENTIAL_UNAVAILABLE`, `PROVIDER_CREDENTIAL_REJECTED`, `PROVIDER_NETWORK_DENIED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT`, `PROVIDER_CANCELLED`, `PROVIDER_RATE_LIMITED`, `PROVIDER_RESPONSE_INVALID`, `PROVIDER_OUTPUT_LIMIT_EXCEEDED`, `PROVIDER_TOOL_UNAVAILABLE`, `PROVIDER_INVENTORY_CHANGED`, `PROVIDER_REQUEST_FAILED`, `PROVIDER_AUDIT_UNAVAILABLE`.
- Audit metadata is allowlisted and must never contain credentials, auth headers, raw request bodies, raw provider responses/logs, environment, local paths, PIDs, or file descriptors.
- Existing skill `capabilityPlan` may only gain advisory availability information derived from KodeGPT-owned provider state; skill metadata remains non-authoritative and `skill.load` remains non-executing.
- No force/reset/rebase/history rewrite. Implementation begins in an isolated worktree, not directly on canonical `main`.

## Repository Map and Ownership

| Area | Existing pattern | Provider Gateway ownership |
| --- | --- | --- |
| Capability contracts/errors | `packages/capabilities/src/{contracts.ts,errors.ts,index.ts}` | Stable provider error vocabulary plus private gateway exports; do not add to `NATIVE_CAPABILITY_IDS`. |
| Remote read service pattern | `packages/capabilities/src/remote-ci/**` | Pattern reference only. New code lives under `packages/capabilities/src/provider-gateway/**`; existing Remote-CI files are not refactored. |
| Private durable state | `packages/trust/src/workspace-trust-store.ts` | Reuse atomic temp-write/fsync/rename/mode discipline in a new provider registry store; add stricter unknown-field validation. |
| Workspace/network profile | `packages/core/src/workspace-manager.ts`, `packages/profiles/src/{schema.ts,presets.ts}` | Production workspace authority adapter reads READY workspace `effectivePolicy.network`; provider code does not mutate workspace policy. |
| Durable audit | `crates/runtime/src/{audit.rs,dispatcher.rs}`, `crates/protocol/src/types.rs`, `packages/protocol/src/runtime-types.ts` | Add global private `provider.audit`; unlike `ci.audit`, it is not workspace-capability-bound because `workspaceBinding=NONE` is valid. |
| Local CLI | `apps/cli/src/main.ts`, `apps/cli/src/commands/{workspace.ts,skill.ts}` | Add `apps/cli/src/commands/provider.ts` + tests for add/remove/enable/disable/reapprove/list/inspect. No `invoke`. |
| Production stack | `apps/cli/src/commands/start.ts` | Construct a private provider runtime factory without adding it to MCP tool context; startup performs no provider contact. |
| Skill advisory plan | `packages/skills/src/{capability-plan.ts,capability-plan.test.ts}` | Optional advisory availability only after gateway core is complete; no authority input from skill data. |
| Security gates | `scripts/forbidden-patterns.mjs`, `tests/security/**`, `tests/integration/**` | Lock absence of generic provider/MCP/process/network authority and preserve exact 51-tool surface. |

## Stable Core Contracts

The following names/signatures are the cross-task contract. Later tasks consume these exact names rather than redefining near-duplicates.

```ts
export type ProviderEffectClass = "REMOTE_READ";
export type ProviderWorkspaceBinding = "REQUIRED" | "OPTIONAL" | "NONE";
export type ProviderInventoryMode = "STATIC" | "DYNAMIC";
export type ProviderAuditPhase = "decision" | "success" | "failed";

export interface ProviderRegistryRecord {
  schemaVersion: 1;
  providerInstanceId: string;
  operatorName: string;
  adapterId: string;
  adapterContractVersion: string;
  enabled: boolean;
  implementationFingerprint: string;
  inventoryMode: ProviderInventoryMode;
  approvedInventoryFingerprint: string | null;
  credentialBroker: ProviderCredentialBrokerDescriptor;
  nonSecretAdapterConfig: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderCredentialBrokerDescriptor {
  kind: "none" | "external-helper";
  helperPath?: string;
  helperSha256?: string;
}

export interface ProviderSemanticMappingDefinition {
  semanticCapabilityId: string;
  adapterId: string;
  adapterOperationId: string;
  effect: "REMOTE_READ";
  workspaceBinding: ProviderWorkspaceBinding;
  inputSchema: z.ZodType<unknown>;
  outputSchema: z.ZodType<unknown>;
  maxProviderRequests: number;
  retry: "none" | "one-idempotent-read";
  auditFields: readonly string[];
}

export interface ProviderAdapterManifest {
  adapterId: string;
  adapterContractVersion: string;
  implementationDigest: string;
  inventoryMode: ProviderInventoryMode;
  networkPolicy: ProviderNetworkPolicy;
  credentialBroker: ProviderCredentialBrokerPolicy;
  operations: readonly ProviderOperationDefinition[];
  mappings: readonly ProviderSemanticMappingDefinition[];
}

export interface ProviderGatewayService {
  execute(input: ProviderSemanticExecutionInput): Promise<ProviderSemanticExecutionResult>;
}
```

`implementationDigest` is supplied only by compiled adapter code. In this phase production manifests are empty; tests inject a deterministic conformance manifest and digest. A future real adapter must tie this field to its reviewed compiled artifact/package identity before it can be admitted in production.

## Task Dependency Graph

1. Task 1 defines the vocabulary consumed by every later task.
2. Task 2 persists only Task 1 records.
3. Task 3 defines compiled manifests/mappings consumed by identity, inventory, transport, operator, and runtime tasks.
4. Task 4 adds global provider audit consumed by all side-effecting provider flows.
5. Tasks 5–8 implement identity, credentials, network, and inventory independently against Task 1/3 contracts.
6. Task 9 implements output normalization; Task 10 implements operation budgets/cancellation.
7. Task 11 implements admission/reapproval by composing Tasks 2–8 and audit.
8. Task 12 implements semantic execution by composing Tasks 2–10 and workspace authority.
9. Task 13 adds local CLI over Task 11 state authority.
10. Task 14 adds production wiring but no MCP registration.
11. Task 15 adds advisory skill availability without authority transfer.
12. Tasks 16–18 lock security, run complete verification, and close readiness.

---

## Task 1 — Provider domain contracts, schemas, limits, and stable errors

**Files:**
- Create: `packages/capabilities/src/provider-gateway/contracts.ts`
- Create: `packages/capabilities/src/provider-gateway/schemas.ts`
- Create: `packages/capabilities/src/provider-gateway/contracts.test.ts`
- Create: `packages/capabilities/src/provider-gateway/index.ts`
- Modify: `packages/capabilities/src/errors.ts`
- Modify: `packages/capabilities/src/index.ts`

- [ ] Add the exact stable provider error union to `CapabilityErrorCode`; do not rename existing CI/native errors.
- [ ] Define constants for all byte/count/time/request ceilings from the approved design and exact enums for effect/workspace binding/inventory mode.
- [ ] Define strict Zod schemas for IDs, registry records, credential broker descriptors, normalized inventory structures, execution input/result envelopes, and bounded audit metadata.
- [ ] Keep provider semantic IDs out of `NATIVE_CAPABILITY_IDS`; this task must not change MCP inventory.
- [ ] Export the private gateway module from `@kodegpt/capabilities` only for internal package consumers.

**RED test example:**

```ts
it("locks the provider error and authority vocabulary", () => {
  expect(PROVIDER_ERROR_CODES).toEqual([
    "PROVIDER_INPUT_INVALID",
    "PROVIDER_STATE_INVALID",
    "PROVIDER_NOT_ADMITTED",
    "PROVIDER_DISABLED",
    "PROVIDER_IDENTITY_CHANGED",
    "PROVIDER_CREDENTIAL_UNAVAILABLE",
    "PROVIDER_CREDENTIAL_REJECTED",
    "PROVIDER_NETWORK_DENIED",
    "PROVIDER_UNAVAILABLE",
    "PROVIDER_TIMEOUT",
    "PROVIDER_CANCELLED",
    "PROVIDER_RATE_LIMITED",
    "PROVIDER_RESPONSE_INVALID",
    "PROVIDER_OUTPUT_LIMIT_EXCEEDED",
    "PROVIDER_TOOL_UNAVAILABLE",
    "PROVIDER_INVENTORY_CHANGED",
    "PROVIDER_REQUEST_FAILED",
    "PROVIDER_AUDIT_UNAVAILABLE"
  ]);
  expect(PROVIDER_MAX_TOOLS).toBe(128);
  expect(PROVIDER_OPERATION_TIMEOUT_MS).toBe(30_000);
});
```

- [ ] Run RED and confirm failure is missing provider module/types, not an unrelated baseline failure:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/contracts.test.ts
```

- [ ] Implement the minimum contracts/schemas and rerun GREEN.
- [ ] Verify package type consistency:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/contracts.test.ts packages/capabilities/src/contracts.test.ts
pnpm --filter @kodegpt/capabilities typecheck
```

**Commit:** `feat: define provider gateway contracts`

---

## Task 2 — Private provider registry with strict atomic state authority

**Files:**
- Create: `packages/capabilities/src/provider-gateway/registry.ts`
- Create: `packages/capabilities/src/provider-gateway/registry.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/index.ts`

**Contract:**

```ts
export class ProviderRegistryStore {
  constructor(stateRoot: string);
  get path(): string;
  list(): Promise<ProviderRegistryRecord[]>;
  get(providerInstanceId: string): Promise<ProviderRegistryRecord | null>;
  insert(record: ProviderRegistryRecord): Promise<void>;
  replace(record: ProviderRegistryRecord): Promise<void>;
  remove(providerInstanceId: string): Promise<boolean>;
}
```

- [ ] Make the path exactly `join(stateRoot, "providers", "registry.json")`.
- [ ] Store one document `{ schemaVersion: 1, entries: [...] }`, sorted by `providerInstanceId` for deterministic persistence.
- [ ] Reject unknown document keys, unknown record keys, malformed timestamps, non-opaque IDs, invalid fingerprints, and raw secret-looking credential fields.
- [ ] Reuse the existing trust-store durability shape: parent `0700`, temp file `wx` `0600`, write + file `sync`, close, rename, final chmod `0600`, directory `sync`, cleanup temp on failure.
- [ ] Preserve the previous valid registry on failed replacement; no partial file becomes authoritative.
- [ ] Treat absent file as an empty registry, but malformed/unsupported existing state as `PROVIDER_STATE_INVALID`.

**RED test example:**

```ts
it("rejects unknown authority-bearing fields", async () => {
  await writeFile(store.path, JSON.stringify({
    schemaVersion: 1,
    entries: [{ ...validRecord(), providerInvoke: true }]
  }));
  await expect(store.list()).rejects.toMatchObject({ code: "PROVIDER_STATE_INVALID" });
});
```

- [ ] Run RED:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/registry.test.ts
```

- [ ] Implement the store and GREEN tests including mode checks via `stat`.
- [ ] Verify:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/registry.test.ts
pnpm --filter @kodegpt/capabilities typecheck
```

**Commit:** `feat: persist provider admission state`

---

## Task 3 — Compiled adapter registry and semantic mapping contracts

**Files:**
- Create: `packages/capabilities/src/provider-gateway/adapter-registry.ts`
- Create: `packages/capabilities/src/provider-gateway/adapter-registry.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/contracts.ts`
- Modify: `packages/capabilities/src/provider-gateway/index.ts`

**Contract:**

```ts
export class ProviderAdapterRegistry {
  constructor(manifests: readonly ProviderAdapterManifest[]);
  list(): readonly ProviderAdapterManifest[];
  require(adapterId: string): ProviderAdapterManifest;
  requireMapping(semanticCapabilityId: string): ProviderSemanticMappingDefinition;
}

export const PRODUCTION_PROVIDER_MANIFESTS: readonly ProviderAdapterManifest[] = Object.freeze([]);
```

- [ ] Validate manifests at construction: unique adapter IDs, unique semantic capability IDs, `REMOTE_READ` only, request budget `1..8`, valid retry/binding, HTTPS exact origins, fixed operations, no generic URL/method/header templates.
- [ ] Ensure mappings reference only operations owned by the same manifest.
- [ ] Ensure descriptions/prompts are not authority fields in manifest or mapping types.
- [ ] Freeze compiled manifest/mapping objects so runtime/provider data cannot mutate policy after construction.
- [ ] Keep `PRODUCTION_PROVIDER_MANIFESTS` empty in this phase. Test code supplies a conformance manifest under test fixtures; no production provider is silently selected.

**RED test example:**

```ts
it("rejects generic transport-shaped operations", () => {
  expect(() => new ProviderAdapterRegistry([manifest({
    operations: [{ id: "request", method: "*", pathTemplate: "{url}" }]
  })])).toThrowError(/fixed provider operation/i);
});
```

- [ ] Run RED, implement, run GREEN:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/adapter-registry.test.ts
```

- [ ] Verify no public ID changed:

```bash
pnpm vitest run packages/capabilities/src/contracts.test.ts
pnpm --filter @kodegpt/capabilities typecheck
```

**Commit:** `feat: define compiled provider mappings`

---

## Task 4 — Global durable provider audit RPC

**Files:**
- Modify: `crates/protocol/src/types.rs`
- Modify: `crates/protocol/src/lib.rs` if exports are explicit
- Modify: `crates/protocol/tests/protocol_contract.rs`
- Modify: `packages/protocol/src/runtime-types.ts`
- Modify: `packages/protocol/src/index.ts` if exports are explicit
- Modify: `crates/runtime/src/audit.rs`
- Modify: `crates/runtime/src/dispatcher.rs`
- Modify: `packages/capabilities/src/provider-gateway/contracts.ts`
- Create: `packages/capabilities/src/provider-gateway/audit.ts`
- Create: `packages/capabilities/src/provider-gateway/audit.test.ts`

**Private RPC:** `provider.audit`.

**RPC shape:**

```ts
interface ProviderAuditParams {
  operationId: string;
  operation: "add" | "remove" | "enable" | "disable" | "reapprove" | "execute" | "inventory";
  phase: "decision" | "success" | "failed";
  providerInstanceId: string;
  adapterId: string;
  semanticCapabilityId?: string;
  errorCode?: ProviderErrorCode;
  inventoryChanged?: boolean;
  truncated?: boolean;
  durationMs?: number;
}
```

- [ ] Add Rust protocol enums/params with `deny_unknown_fields`; validate opaque IDs, bounded adapter/semantic IDs, known error enum, nonnegative bounded duration.
- [ ] Add `AuditAction` variants for provider operator and execution operations; add provider metadata fields to `AuditRecord` only from the allowlist above.
- [ ] Do not include helper path, origin, URL, request body, response data, credential material, environment, workspace path, PID, or FD.
- [ ] `provider.audit` is global and does not accept/require a workspace capability ID; this is required for `workspaceBinding=NONE`.
- [ ] Return exactly `{ "ok": true }`. Audit sink failure returns `AUDIT_UNAVAILABLE` and TypeScript maps it to `PROVIDER_AUDIT_UNAVAILABLE`.

**RED Rust test example:**

```rust
#[test]
fn provider_audit_rejects_unknown_fields() {
    let value = json!({
        "operationId": "op_test",
        "operation": "execute",
        "phase": "decision",
        "providerInstanceId": "prv_0123456789abcdef0123456789abcdef",
        "adapterId": "fixture.read",
        "credential": "must-not-be-accepted"
    });
    assert!(serde_json::from_value::<ProviderAuditParams>(value).is_err());
}
```

- [ ] Run RED:

```bash
cargo test --workspace provider_audit
pnpm vitest run packages/capabilities/src/provider-gateway/audit.test.ts
```

- [ ] Implement Rust + TypeScript audit adapter.
- [ ] GREEN verify:

```bash
cargo test --workspace provider_audit
pnpm vitest run packages/capabilities/src/provider-gateway/audit.test.ts tests/protocol
pnpm --filter @kodegpt/protocol typecheck
pnpm --filter @kodegpt/capabilities typecheck
```

**Commit:** `feat: audit provider gateway operations`

---

## Task 5 — Adapter/helper implementation identity verification

**Files:**
- Create: `packages/capabilities/src/provider-gateway/identity.ts`
- Create: `packages/capabilities/src/provider-gateway/identity.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/index.ts`

**Contract:**

```ts
export interface ProviderImplementationIdentity {
  implementationFingerprint: string;
  helperIdentity: null | { canonicalPath: string; sha256: string };
}

export function resolveProviderImplementationIdentity(input: {
  manifest: ProviderAdapterManifest;
  credentialBroker: ProviderCredentialBrokerDescriptor;
  workspaceRoots: readonly string[];
}): Promise<ProviderImplementationIdentity>;
```

- [ ] Require compiled `manifest.implementationDigest` to be lowercase SHA-256.
- [ ] For `external-helper`, canonicalize absolute helper path without execution, require regular executable file, reject any path inside any currently open/trusted workspace root, compute SHA-256, and require exact equality with operator-provided pin.
- [ ] Compute the implementation fingerprint from a canonical object containing adapter ID, adapter contract version, manifest implementation digest, and helper SHA-256 when present; do not include provider prose or secrets.
- [ ] Revalidate helper canonical path + SHA immediately before every helper execution in Task 6.

**RED test example:**

```ts
it("rejects a helper selected from a workspace", async () => {
  await expect(resolveProviderImplementationIdentity({
    manifest: fixtureManifest,
    credentialBroker: { kind: "external-helper", helperPath: workspaceHelper, helperSha256: digest },
    workspaceRoots: [workspaceRoot]
  })).rejects.toMatchObject({ code: "PROVIDER_INPUT_INVALID" });
});
```

- [ ] Run RED, implement, GREEN:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/identity.test.ts
```

- [ ] Verify typecheck:

```bash
pnpm --filter @kodegpt/capabilities typecheck
```

**Commit:** `feat: verify provider implementation identity`

---

## Task 6 — JIT credential broker and bounded helper execution

**Files:**
- Create: `packages/capabilities/src/provider-gateway/credential-broker.ts`
- Create: `packages/capabilities/src/provider-gateway/credential-broker.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/index.ts`

**Contract:**

```ts
export interface ProviderCredential {
  readonly value: string;
  readonly kind: "bearer" | "opaque";
}

export interface ProviderCredentialBroker {
  acquire(input: {
    provider: ProviderRegistryRecord;
    manifest: ProviderAdapterManifest;
    signal: AbortSignal;
  }): Promise<ProviderCredential | null>;
}
```

- [ ] Implement `none` broker and external-helper broker only.
- [ ] External helper execution uses `spawn(absoluteCanonicalPath, fixedManifestArgv, { shell:false, env:minimalEnv, stdio:["ignore","pipe","pipe"], detached:true })` or the repo-equivalent process-tree strategy.
- [ ] No caller controls argv. The argv comes from compiled credential-broker policy in the manifest.
- [ ] Do not pass secrets in argv or environment. No parent environment inheritance; only an exact compiled allowlist required by the helper contract.
- [ ] Bound stdout/stderr to 64 KiB each, fail on overflow, 5 second deadline, kill process group/tree on timeout/cancellation, trim only the exact credential framing defined by the broker.
- [ ] Map missing helper/login to `PROVIDER_CREDENTIAL_UNAVAILABLE`; malformed/rejected helper output to `PROVIDER_CREDENTIAL_REJECTED`; cancellation/timeout to their stable codes.
- [ ] Never persist/log/return credential contents outside the operation object.

**RED test example:**

```ts
it("kills the helper on abort and never inherits arbitrary env", async () => {
  const pending = broker.acquire({ provider, manifest, signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "PROVIDER_CANCELLED" });
  expect(runner.lastEnv).toEqual({ LANG: "C.UTF-8" });
  expect(runner.killedProcessTree).toBe(true);
});
```

- [ ] Run RED, implement, GREEN:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/credential-broker.test.ts
```

- [ ] Verify:

```bash
pnpm --filter @kodegpt/capabilities typecheck
```

**Commit:** `feat: acquire provider credentials safely`

---

## Task 7 — Exact-origin DNS-bound ProviderNetworkTransport

**Files:**
- Create: `packages/capabilities/src/provider-gateway/network-policy.ts`
- Create: `packages/capabilities/src/provider-gateway/network-policy.test.ts`
- Create: `packages/capabilities/src/provider-gateway/network-transport.ts`
- Create: `packages/capabilities/src/provider-gateway/network-transport.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/contracts.ts`
- Modify: `packages/capabilities/src/provider-gateway/index.ts`

**Contract:**

```ts
export interface ProviderNetworkTransport {
  request(input: {
    manifest: ProviderAdapterManifest;
    operationId: string;
    operationInput: unknown;
    credential: ProviderCredential | null;
    signal: AbortSignal;
    budget: ProviderRequestBudget;
  }): Promise<ProviderRawResponse>;
}
```

- [ ] Resolve the compiled operation by `operationId`, validate `operationInput` against that operation's compiled input schema, and call its reviewed request encoder. The caller never supplies a raw URL, host, port, method, header set, query-key set, or request body bytes.
- [ ] Validate the compiled encoder result before URL construction and reject control characters, traversal, userinfo, raw IP origins, unapproved query keys, or a body that exceeds the operation/body ceiling.
- [ ] Require `https:` and normal certificate verification with SNI/Host set to the compiled hostname.
- [ ] Resolve with an injected resolver (`dns.promises.lookup(..., { all:true, verbatim:true })` in production), reject loopback/unspecified/link-local/multicast/private IPv4/IPv6 ranges, and choose only a validated address.
- [ ] Use `node:https.request` (or a tiny injected socket connector around it) so the exact validated address is supplied to the connection while TLS validates the original hostname. Do not fall back to a second implicit DNS lookup.
- [ ] Re-resolve/revalidate on the one allowed retry.
- [ ] Default redirect mode is deny. Only a compiled one-hop redirect policy may follow; validate destination origin and strip credentials on cross-origin redirect.
- [ ] Enforce request body <=256 KiB and response body <=2 MiB before parse; cancel the socket/stream on overflow.
- [ ] Map network/TLS/rate-limit/timeout/cancel errors to the stable provider taxonomy without raw remote response text.

**RED test example:**

```ts
it("connects only to the prevalidated address", async () => {
  resolver.answers = [{ address: "203.0.113.10", family: 4 }];
  await transport.request(requestFor("fixture.read"));
  expect(connector.calls).toEqual([{
    address: "203.0.113.10",
    servername: "api.fixture.example",
    port: 443
  }]);
});
```

**Negative RED:**

```ts
resolver.answers = [{ address: "127.0.0.1", family: 4 }];
await expect(transport.request(requestFor("fixture.read")))
  .rejects.toMatchObject({ code: "PROVIDER_NETWORK_DENIED" });
```

- [ ] Run RED:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/network-policy.test.ts packages/capabilities/src/provider-gateway/network-transport.test.ts
```

- [ ] Implement minimal transport, then GREEN.
- [ ] Verify no Remote-CI transport modification occurred:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/network-policy.test.ts packages/capabilities/src/provider-gateway/network-transport.test.ts packages/capabilities/src/remote-ci/github-http.test.ts
pnpm --filter @kodegpt/capabilities typecheck
```

**Commit:** `feat: add bounded provider network transport`

---

## Task 8 — Structural inventory normalization and fingerprinting

**Files:**
- Create: `packages/capabilities/src/provider-gateway/inventory.ts`
- Create: `packages/capabilities/src/provider-gateway/inventory.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/contracts.ts`
- Modify: `packages/capabilities/src/provider-gateway/index.ts`

**Contract:**

```ts
export interface ProviderStructuralTool {
  id: string;
  inputSchema: unknown;
  outputSchema: unknown;
}

export interface ProviderStructuralInventory {
  adapterContractVersion: string;
  providerContractVersion: string | null;
  tools: readonly ProviderStructuralTool[];
}

export function normalizeProviderInventory(value: unknown): ProviderStructuralInventory;
export function fingerprintProviderInventory(value: ProviderStructuralInventory): string;
```

- [ ] Normalize only structural fields. Explicitly discard provider descriptions, prompts, examples, instructions, and display prose before fingerprinting.
- [ ] Require ASCII bounded tool IDs and deterministic UTF-8 byte-order sorting.
- [ ] Enforce 128 tools, 32 KiB per input/output schema, depth 16, and final canonical JSON <=512 KiB.
- [ ] Canonicalize object keys recursively and reject non-JSON values, duplicate semantic keys after normalization, cycles, NUL/control-bearing identifiers, or excess numeric forms.
- [ ] Produce lowercase SHA-256 over canonical structural bytes only.

**RED test example:**

```ts
it("ignores provider prose when computing the structural fingerprint", () => {
  const a = normalizeProviderInventory(inventory({ description: "first prose" }));
  const b = normalizeProviderInventory(inventory({ description: "attacker changed prose" }));
  expect(fingerprintProviderInventory(a)).toBe(fingerprintProviderInventory(b));
});
```

- [ ] Run RED, implement, GREEN:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/inventory.test.ts
```

- [ ] Verify package typecheck:

```bash
pnpm --filter @kodegpt/capabilities typecheck
```

**Commit:** `feat: fingerprint provider inventory structure`

---

## Task 9 — Strict provider output parsing, normalization, and result budget

**Files:**
- Create: `packages/capabilities/src/provider-gateway/output.ts`
- Create: `packages/capabilities/src/provider-gateway/output.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/index.ts`

**Contract:**

```ts
export function decodeProviderUtf8(bytes: Uint8Array): string;
export function normalizeProviderValue(value: unknown): unknown;
export function fitProviderSemanticResult<T>(input: T): {
  value: T;
  truncated: boolean;
  truncationReasons: readonly string[];
};
```

- [ ] Decode with fatal UTF-8 before JSON parse; reject malformed bytes and NUL.
- [ ] Normalize strings to NFC and newlines to `\n`; enforce ASCII on fields classified as identifiers by mapping output schema.
- [ ] Strictly parse provider output through the mapping output schema; unknown fields fail unless the reviewed mapping schema explicitly allows them.
- [ ] Enforce max structural depth 16 and max elements 1000.
- [ ] Fit semantic results to 512 KiB using only mapping-declared safe truncation fields/reasons. If mandatory content cannot fit, throw `PROVIDER_OUTPUT_LIMIT_EXCEEDED`.
- [ ] Never return raw binary/provider body as a public semantic result.

**RED test example:**

```ts
it("rejects invalid UTF-8 before structural parsing", () => {
  expect(() => decodeProviderUtf8(Uint8Array.from([0xc3, 0x28])))
    .toThrowError(expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID" }));
});
```

- [ ] Run RED, implement, GREEN:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/output.test.ts
```

- [ ] Verify:

```bash
pnpm --filter @kodegpt/capabilities typecheck
```

**Commit:** `feat: normalize provider output safely`

---

## Task 10 — Operation deadlines, request budgets, retry, and cancellation

**Files:**
- Create: `packages/capabilities/src/provider-gateway/lifecycle.ts`
- Create: `packages/capabilities/src/provider-gateway/lifecycle.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/contracts.ts`
- Modify: `packages/capabilities/src/provider-gateway/index.ts`

**Contract:**

```ts
export class ProviderOperationBudget {
  constructor(input: { signal?: AbortSignal; now?: () => number });
  readonly signal: AbortSignal;
  claimRequest(): void;
  withAttemptTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T>;
  canRetry(mapping: ProviderSemanticMappingDefinition, attempt: number): boolean;
  close(): void;
}
```

- [ ] Total deadline 30s; each network attempt 10s; request count maximum 8 and also no greater than mapping `maxProviderRequests`.
- [ ] Retry off by default; exactly one retry for `one-idempotent-read`, only while total deadline/request budget permits.
- [ ] Compose caller abort + total timeout + attempt timeout into signals without leaked timers/listeners.
- [ ] Map caller abort to `PROVIDER_CANCELLED`, total/attempt deadline to `PROVIDER_TIMEOUT`.
- [ ] `close()` aborts remaining children and leaves no background helper/socket/session.

**RED test example:**

```ts
it("permits one retry only for an idempotent read mapping", () => {
  const budget = new ProviderOperationBudget({ now });
  expect(budget.canRetry(mapping({ retry: "none" }), 0)).toBe(false);
  expect(budget.canRetry(mapping({ retry: "one-idempotent-read" }), 0)).toBe(true);
  expect(budget.canRetry(mapping({ retry: "one-idempotent-read" }), 1)).toBe(false);
});
```

- [ ] Run RED, implement, GREEN:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/lifecycle.test.ts
```

**Commit:** `feat: bound provider operation lifecycle`

---

## Task 11 — Local admission, mutation, and reapproval orchestration

**Files:**
- Create: `packages/capabilities/src/provider-gateway/operator-service.ts`
- Create: `packages/capabilities/src/provider-gateway/operator-service.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/index.ts`

**Contract:**

```ts
export class ProviderOperatorService {
  add(input: ProviderAddInput): Promise<ProviderRegistryRecord>;
  remove(providerInstanceId: string): Promise<boolean>;
  enable(providerInstanceId: string): Promise<ProviderRegistryRecord>;
  disable(providerInstanceId: string): Promise<ProviderRegistryRecord>;
  reapprove(providerInstanceId: string): Promise<ProviderRegistryRecord>;
  list(): Promise<ProviderRegistryRecord[]>;
  inspect(providerInstanceId: string): Promise<ProviderRegistryRecord>;
}
```

- [ ] Generate `prv_<32 lowercase hex>` using cryptographic random bytes before the audit decision.
- [ ] `add` exact order: validate config -> manifest -> helper identity without execution -> implementation fingerprint -> generate op ID -> durable `add/decision` -> acquire credential if dynamic inventory requires it -> fetch inventory through bounded transport -> structural fingerprint -> write record atomically -> `add/success`.
- [ ] On any post-decision failure: attempt bounded failed audit, ensure no record exists, return the normalized original/provider-audit error according to fail-closed rules.
- [ ] `reapprove`: re-resolve manifest/helper identity, decision audit first, acquire/fetch dynamic inventory, require valid structural inventory, replace implementation/inventory fingerprints atomically, then success audit.
- [ ] `enable`: require current implementation identity and approved dynamic inventory fingerprint to still match before enabling; audit decision precedes state mutation.
- [ ] `disable/remove`: audit decision before mutation and outcome after; no network or credential acquisition required.
- [ ] Operator config may select only a compiled `adapterId`, display name, adapter-specific nonsecret config, and broker helper identity fields allowed by that manifest. It may not supply endpoints/methods/mappings.

**Security RED test example:**

```ts
it("records a durable decision before credential or inventory side effects", async () => {
  await service.add(addInput);
  expect(events).toEqual([
    "validate-config",
    "resolve-manifest",
    "verify-helper-identity",
    "compute-implementation-identity",
    "audit-decision",
    "credential-acquire",
    "inventory-fetch",
    "registry-write",
    "audit-success"
  ]);
});
```

**Failure RED:**

```ts
it("leaves no admitted record when dynamic inventory fails", async () => {
  fixture.inventoryError = new CapabilityError("PROVIDER_RESPONSE_INVALID", "invalid inventory");
  await expect(service.add(addInput)).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
  expect(await fixture.store.list()).toEqual([]);
});
```

- [ ] Run RED, implement, GREEN:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/operator-service.test.ts
```

- [ ] Verify all composed units:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway
pnpm --filter @kodegpt/capabilities typecheck
```

**Commit:** `feat: orchestrate provider admission state`

---

## Task 12 — Semantic ProviderGatewayService execution with workspace/profile authority

**Files:**
- Create: `packages/capabilities/src/provider-gateway/service.ts`
- Create: `packages/capabilities/src/provider-gateway/service.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/index.ts`
- Modify: `packages/core/src/index.ts` only if an existing public workspace type needs re-export; avoid changing WorkspaceManager behavior unless necessary.

**Dependencies:**

```ts
export interface ProviderWorkspaceAuthorityResolver {
  resolve(workspaceId: string): Promise<{
    workspaceId: string;
    network: "deny" | "unrestricted";
  }>;
}

export interface ProviderGatewayServiceDependencies {
  registry: ProviderRegistryStore;
  adapters: ProviderAdapterRegistry;
  audit: ProviderAuditSink;
  credentials: ProviderCredentialBrokerFactory;
  transport: ProviderNetworkTransport;
  workspaceAuthority: ProviderWorkspaceAuthorityResolver;
  workspaceRoots: () => readonly string[];
}
```

- [ ] Parse semantic input first and enforce serialized semantic input <=64 KiB before provider work.
- [ ] Resolve mapping by `semanticCapabilityId`; require `REMOTE_READ`.
- [ ] Resolve provider record by opaque ID; require admitted/enabled, manifest adapter/version match, implementation/helper identity match, and static/dynamic inventory approval match before any credential acquisition.
- [ ] Enforce workspace binding:
  - `REQUIRED`: valid READY workspace ID required; effective network must be `unrestricted`.
  - `OPTIONAL`: when workspace data/ID is present, apply the same network gate; when absent, mapping must not consume workspace data.
  - `NONE`: do not read workspace profile/repository policy as authority input.
- [ ] Never automatically upload repository contents, context bundles, environment, skill content, or prompt content.
- [ ] Generate operation ID and write durable `execute/decision` before credential/helper/network.
- [ ] Acquire JIT credential, execute only the reviewed mapping operation through `ProviderNetworkTransport`, parse/normalize output, enforce request/deadline/result budgets, write success audit, then return semantic result.
- [ ] On failure after decision, abort helpers/sockets, record bounded failure audit, and return normalized error; final audit failure fails closed with `PROVIDER_AUDIT_UNAVAILABLE` and discards any provider result.
- [ ] Detect dynamic inventory drift before mapped execution when the adapter contract requires a metadata refresh; mismatch returns `PROVIDER_INVENTORY_CHANGED` and does not auto-update registry.

**RED test example:**

```ts
it("denies workspace-bound provider reads under develop profile before credentials", async () => {
  fixture.workspace.network = "deny";
  await expect(service.execute(execInput({ workspaceId: "ws_1" })))
    .rejects.toMatchObject({ code: "PROVIDER_NETWORK_DENIED" });
  expect(fixture.credentialCalls).toBe(0);
  expect(fixture.transportCalls).toBe(0);
});
```

**Audit-order RED:**

```ts
it("fails before all side effects when the decision audit is unavailable", async () => {
  fixture.failDecisionAudit = true;
  await expect(service.execute(execInput()))
    .rejects.toMatchObject({ code: "PROVIDER_AUDIT_UNAVAILABLE" });
  expect(fixture.credentialCalls).toBe(0);
  expect(fixture.transportCalls).toBe(0);
});
```

- [ ] Run RED, implement, GREEN:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/service.test.ts
```

- [ ] Regression verify profile assumptions and Remote-CI sibling behavior:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/service.test.ts packages/profiles/src/resolve-profile.test.ts packages/capabilities/src/remote-ci/service.test.ts
pnpm --filter @kodegpt/capabilities typecheck
```

**Commit:** `feat: execute typed provider semantic reads`

---

## Task 13 — Local `kodegpt provider` operator commands

**Files:**
- Create: `apps/cli/src/commands/provider.ts`
- Create: `apps/cli/src/commands/provider.test.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/packaged-cli.test.ts`
- Modify: `apps/cli/package.json` only if an existing workspace dependency export requires declaration; do not add unrelated dependencies.

**Command family:**

```text
kodegpt provider add
kodegpt provider remove
kodegpt provider enable
kodegpt provider disable
kodegpt provider reapprove
kodegpt provider list
kodegpt provider inspect
```

There is no `kodegpt provider invoke`.

- [ ] Model command dependencies on `ProviderOperatorService`; unit tests inject a fake service rather than touching the real home directory.
- [ ] `add` accepts `--adapter`, `--name`, manifest-approved nonsecret config fields, and manifest-approved helper identity fields. Reject endpoint/method/header/mapping/credential-value flags.
- [ ] `remove/enable/disable/reapprove/inspect` accept only a valid opaque provider instance ID plus `--state-root` at the top-level CLI convention where already supported.
- [ ] `list/inspect` redact helper local path from default human output if it is not needed operationally; JSON output may include the nonsecret registry descriptor but never credential values.
- [ ] Update help text with the seven commands and explicitly omit invocation semantics.
- [ ] Production construction uses `PRODUCTION_PROVIDER_MANIFESTS` (empty in this phase), so `provider add --adapter <unknown>` fails with `PROVIDER_INPUT_INVALID`; tests inject the conformance manifest to exercise complete command behavior.

**RED test example:**

```ts
it("does not accept an invoke subcommand", async () => {
  await expect(runProviderCommand(["invoke", "prv_0123456789abcdef0123456789abcdef"], deps))
    .rejects.toThrow(/unknown provider command/i);
});
```

- [ ] Run RED, implement, GREEN:

```bash
pnpm vitest run apps/cli/src/commands/provider.test.ts
```

- [ ] Packaged CLI regression:

```bash
pnpm vitest run apps/cli/src/commands/provider.test.ts apps/cli/src/packaged-cli.test.ts
pnpm --filter @kodegpt/cli typecheck
```

**Commit:** `feat: add provider operator commands`

---

## Task 14 — Private production factory/wiring with zero MCP expansion

**Files:**
- Create: `packages/capabilities/src/provider-gateway/production.ts`
- Create: `packages/capabilities/src/provider-gateway/production.test.ts`
- Modify: `packages/capabilities/src/provider-gateway/index.ts`
- Modify: `apps/cli/src/commands/start.ts`
- Modify: `apps/cli/src/commands/start.test.ts`

**Contract:**

```ts
export function createProviderGatewayRuntime(input: {
  stateRoot: string;
  manifests: readonly ProviderAdapterManifest[];
  audit: ProviderAuditSink;
  workspaceAuthority: ProviderWorkspaceAuthorityResolver;
  workspaceRoots: () => readonly string[];
}): {
  operator: ProviderOperatorService;
  gateway: ProviderGatewayService;
  close(): Promise<void>;
};
```

- [ ] Build registry/adapters/identity/credential/network services but perform no provider network request, helper execution, credential acquisition, or dynamic inventory refresh at startup.
- [ ] Wire the global audit sink to `kernel.request("provider.audit", ...)` through a narrow adapter in `start.ts`.
- [ ] Wire workspace authority from `WorkspaceManager.listWorkspaces()` READY entries/effective policy without exposing provider mutation through WorkspaceManager.
- [ ] Keep the provider runtime private in `ProductionServiceStack`; do not add it to MCP `ToolContext`, server tool registration, system capability list, or public native capability IDs.
- [ ] `close()` aborts only in-flight provider operations owned by the gateway; it does not own MCP lifecycle and does not spawn a background provider agent.
- [ ] Startup remains healthy when registry is malformed or credentials are absent. Provider use fails locally with `PROVIDER_STATE_INVALID`/credential errors when called; unrelated native KodeGPT starts normally.

**RED test example:**

```ts
it("starts without contacting providers or credentials", async () => {
  const started = await createProductionServiceStack(options, deps);
  expect(events).not.toContain("provider-network");
  expect(events).not.toContain("provider-helper");
  await started.close();
});
```

- [ ] Run RED, implement, GREEN:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway/production.test.ts apps/cli/src/commands/start.test.ts
```

- [ ] Verify MCP inventory remains exactly current baseline:

```bash
pnpm vitest run packages/mcp-server/src/server.test.ts tests/host/host-compatibility-checklist.test.ts
pnpm run typecheck
```

**Commit:** `feat: wire private provider gateway runtime`

---

## Task 15 — Preserve the skills boundary with regression evidence only

**Files:**
- Modify: `packages/skills/src/capability-plan.test.ts`
- Modify: `packages/mcp-server/src/skills.test.ts` only if an additional serialization assertion is needed.

No production skill code is planned in this task. Because `PRODUCTION_PROVIDER_MANIFESTS` is empty, there is no truthful production provider availability to surface yet; adding a new advisory schema now would be speculative churn.

- [ ] Add regression evidence that existing provider requirements remain advisory through `externalRequirements` and do not carry provider instance IDs, helper paths, mappings, credentials, or invocation authority.
- [ ] Keep `classification`, missing capability logic, source/pin behavior, and `skill.load` non-execution unchanged.
- [ ] Prove no provider execution is triggered by `skill.list`, `skill.inspect`, or `skill.load`.
- [ ] Prove provider metadata in a skill cannot select an admitted provider or mutate provider state.

**RED test example:**

```ts
it("keeps provider requirements advisory and authority-free", () => {
  const plan = buildSkillCapabilityPlan(skill, compatibility);
  expect(plan.externalRequirements).toContain("provider:github");
  expect(plan).not.toHaveProperty("providerInstanceId");
  expect(plan).not.toHaveProperty("credentialBroker");
  expect(plan).not.toHaveProperty("invoke");
});
```

- [ ] Run the regression test first and confirm it fails only because the new boundary assertion is not yet present in the suite, then add the minimal test coverage without changing production skill behavior.
- [ ] Verify:

```bash
pnpm vitest run packages/skills/src/capability-plan.test.ts packages/mcp-server/src/skills.test.ts
pnpm --filter @kodegpt/skills typecheck
pnpm run verify:forbidden
```

**Commit:** `test: preserve provider skill boundary`

---

## Task 16 — Test-only conformance adapter and full security/integration lock

**Files:**
- Create: `tests/helpers/provider-gateway-fixture.ts`
- Create: `tests/integration/provider-gateway.test.ts`
- Modify: `tests/integration/full-stack.test.ts` only if production-stack lifecycle coverage needs one assertion; do not expose a new MCP tool.
- Modify: `tests/security/forbidden-patterns.test.ts`
- Modify: `tests/security/security-invariants.test.ts`
- Modify: `scripts/forbidden-patterns.mjs`

**Conformance scope:**

- Adapter ID: `test.fixture.read.v1`.
- Semantic capability ID: `test.fixture.record.read`.
- Effect: `REMOTE_READ`.
- Workspace binding variants are exercised separately in tests (`REQUIRED`, `OPTIONAL`, `NONE`).
- Compiled origin in fixture manifest: `https://api.fixture.example`; actual network behavior is supplied by injected resolver/connector/fake response, never by a public raw URL input.
- Dynamic inventory advertises a bounded structural tool `record.read`; descriptions are varied deliberately to prove they do not affect policy/fingerprint.
- This fixture is imported from `tests/**` only and is absent from `PRODUCTION_PROVIDER_MANIFESTS`.

- [ ] Prove complete happy-path ordering: provider add decision -> JIT credential -> dynamic inventory -> registry -> semantic execute decision -> credential -> bounded request -> strict output -> success audits.
- [ ] Prove pre-decision audit failure causes zero helper/network side effects.
- [ ] Prove helper identity change -> `PROVIDER_IDENTITY_CHANGED` before execution.
- [ ] Prove inventory structural drift -> `PROVIDER_INVENTORY_CHANGED` and disabled execution until reapproval.
- [ ] Prove prose-only inventory change does not change fingerprint.
- [ ] Prove `observe` and `develop` deny workspace-bound network while `trusted` permits it; `NONE` does not consult repo/workspace policy.
- [ ] Prove DNS private/loopback/rebinding attempts fail before a socket is connected.
- [ ] Prove invalid UTF-8, NUL, excessive depth/elements/body, oversized output, and unknown response fields fail closed.
- [ ] Prove 30s/10s/5s budgets, max 8 requests, one-read retry ceiling, cancellation cleanup, and no background activity.
- [ ] Prove audit records contain only allowlisted provider metadata and never helper path/credential/header/body/response/environment.
- [ ] Extend forbidden scanner for authored production source to reject public/generic names/patterns such as `provider.invoke`, `provider.tools`, generic provider request dispatch, generic GraphQL, raw URL/method/header selection, `skill.run`, provider-agent/process proxy, and remote mutation verbs. Exempt only intentional quoted negative-test strings where scanner architecture already supports test fixtures.
- [ ] Lock public MCP inventory at exactly the current 51 tools and surface `0.7`.

**RED integration example:**

```ts
it("never registers provider gateway as an MCP tool", async () => {
  const names = await publicToolNames();
  expect(names).toHaveLength(51);
  expect(names.some((name) => name.startsWith("provider."))).toBe(false);
  expect(surfaceVersion()).toBe("0.7");
});
```

- [ ] Run focused RED/GREEN:

```bash
pnpm vitest run tests/integration/provider-gateway.test.ts tests/security/forbidden-patterns.test.ts tests/security/security-invariants.test.ts
node scripts/forbidden-patterns.mjs
```

- [ ] Run regression against Remote-CI and skills:

```bash
pnpm vitest run packages/capabilities/src/remote-ci tests/integration/ci-contract.test.ts packages/skills/src/capability-plan.test.ts
```

**Commit:** `test: lock provider gateway security boundary`

---

## Task 17 — Complete automated verification and whole-branch review

**Files:** no intended source changes unless a failing gate identifies a specific owning task.

- [ ] Run fresh focused Provider Gateway suite:

```bash
pnpm vitest run packages/capabilities/src/provider-gateway apps/cli/src/commands/provider.test.ts tests/integration/provider-gateway.test.ts
```

- [ ] Run full TypeScript and Rust verification:

```bash
pnpm test
cargo test --workspace
pnpm run typecheck
pnpm run build
pnpm run verify:forbidden
pnpm run verify:package
pnpm run test:acceptance
```

- [ ] Review branch diff from the implementation base. Confirm there is no public MCP registration, no surface bump, no Remote-CI refactor, no raw credential persistence, no provider-operation subprocess, no repo-controlled admission/reapproval, and no generic provider/network request API.
- [ ] Search authored source for the hard-stop vocabulary and manually classify every hit as an intentional negative test/documentation occurrence or a defect. Any source defect returns to its owning task with a regression test before correction.
- [ ] Verify `PRODUCTION_PROVIDER_MANIFESTS` is still empty and the conformance adapter exists only under `tests/**`.
- [ ] Verify provider registry modes and audit redaction in integration evidence.
- [ ] If any gate fails, fix only the smallest owning task and create a narrow corrective commit after its RED/GREEN evidence; do not batch unrelated cleanup.

No planned commit when all gates pass unchanged.

---

## Task 18 — Readiness evidence, authority reconciliation, and implementation handoff

**Files:**
- Create: `docs/release/2026-08-16-provider-gateway-readiness.md`
- Modify: `docs/architecture/README.md`
- Modify: `docs/implementation/v0.1-execution-tracker.md`

- [ ] Record exact implementation branch/base/head, verification commands/results, registry path/modes, audit evidence, test-only conformance scope, and explicit absence of production adapter/public MCP provider capability.
- [ ] Record runtime/protocol/surface as `0.1 / 2026-07-28 / 0.7`; do not claim a surface increment.
- [ ] Record that Provider Gateway core/operator authority is implemented only when Task 17 is fully green; production provider-backed semantic capabilities remain absent until a separately reviewed compiled adapter/mapping is added.
- [ ] Preserve Remote-CI as standalone shipped sibling and record that no `ci.*` code was routed through the gateway.
- [ ] Reconcile the tracker next-action line from design/planning state to verified implementation state only after all code gates pass.
- [ ] Run final docs/source smoke:

```bash
pnpm run typecheck
pnpm run verify:forbidden
git diff --check
```

**Commit:** `docs: close provider gateway readiness`

- [ ] Stop before push/PR/merge unless explicitly authorized by the user. Prepare a handoff containing exact base/head, commits, verification evidence, known production-adapter absence, and unchanged public MCP surface.

---

## Plan Coverage Matrix

| Approved design requirement | Owning task(s) |
| --- | --- |
| Provider admission/trust/local-only authority | 2, 11, 13 |
| Provider implementation/helper identity | 5, 11, 12 |
| Dynamic structural inventory | 8, 11, 12, 16 |
| Drift and local reapproval | 11, 12, 13, 16 |
| Typed semantic mappings / `REMOTE_READ` | 3, 12, 16 |
| Workspace binding and profile network gate | 12, 16 |
| External JIT credentials / no secret persistence | 6, 11, 12, 16 |
| Exact-origin HTTPS/DNS binding/redirect rules | 7, 16 |
| Credential-helper process authority | 5, 6, 16 |
| Durable audit decision/outcome ordering | 4, 11, 12, 16 |
| Bounded semantic input/request/provider response | 1, 7, 9, 12, 16 |
| UTF-8/NFC/newline/NUL/output normalization | 9, 16 |
| Cancellation/deadline/request/retry lifecycle | 10, 12, 16 |
| Stable provider errors | 1, 4–12, 16 |
| Public MCP boundary / surface `0.7` | 1, 3, 14, 16–18 |
| Skills remain advisory/non-executing | 15, 16 |
| Remote-CI coexistence | Global constraints, 7, 12, 14, 16–18 |
| No production provider adapter invented | 3, 13, 14, 16–18 |

## Plan Self-Review Gate

Before implementation starts, the implementing session must perform these checks against this plan and the approved design:

- [ ] Confirm every file named in a task exists at the expected repository location or is explicitly marked `Create`.
- [ ] Confirm type names and method signatures introduced in Tasks 1–4 are used unchanged by Tasks 5–16.
- [ ] Confirm there is no task that changes `NATIVE_CAPABILITY_IDS`, MCP tool registration, MCP surface version, or existing `ci.*` production behavior.
- [ ] Confirm no task admits provider-controlled descriptions/prompts as policy or fingerprint input.
- [ ] Confirm every credential/helper/network path is downstream of a durable audit decision.
- [ ] Confirm `workspaceBinding=NONE` has no repository/workspace authority input.
- [ ] Confirm local operator commands contain no invocation command.
- [ ] Confirm the only first adapter/mapping scope is the test-only conformance fixture and production manifest inventory remains empty.
- [ ] Scan this plan for unfinished-marker language and remove any accidental incomplete instruction before execution.
- [ ] Run:

```bash
git diff --check
pnpm run verify:forbidden
```

## Execution Start Gate

After this plan is committed, stop. Production implementation is a separate phase. That phase must:

1. use `superpowers:using-git-worktrees` to create an isolated worktree from the accepted plan commit;
2. use `superpowers:subagent-driven-development` (preferred) or `superpowers:executing-plans` task-by-task;
3. use `superpowers:test-driven-development` for every production behavior change;
4. use `superpowers:verification-before-completion` before any completion claim;
5. preserve each task's commit boundary unless a verified repository constraint requires a documented narrow adjustment.
