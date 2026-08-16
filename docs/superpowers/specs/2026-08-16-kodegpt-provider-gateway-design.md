# KodeGPT Provider Gateway Security Boundary Design

Date: 2026-08-16
Status: design-only, awaiting explicit user review/approval before implementation planning
Baseline: canonical `main` after PR #15, source baseline `f6113b3eef12ab6f3d6b8b7b7952aa18d3f4bae1`, runtime `0.1`, MCP protocol `2026-07-28`, semantic surface `0.7`

## 1. Decision summary

KodeGPT will add Provider Gateway only as a **KodeGPT-owned bounded integration boundary**. Provider integrations do not become authority merely because a provider advertises a tool, schema, prompt, endpoint, or description.

The selected v1 architecture is **Approach A: typed provider-backed semantic capabilities**:

- public authority remains named and typed by KodeGPT;
- provider adapters are private implementation details;
- provider admission is local-operator authority, never repository authority;
- provider credentials are fetched just-in-time from provider-specific external credential owners and are not persisted by KodeGPT in v1;
- provider network/process access is statically constrained by a KodeGPT-owned adapter manifest;
- provider inventory and implementation identity are fingerprinted and drift is fail-closed;
- every provider operation records a durable audit decision before credential/process/network effects and a bounded outcome afterward;
- provider outputs must be transformed into strict KodeGPT-owned schemas before they can cross MCP;
- initial Provider Gateway authority is **remote read-only**. Provider-backed remote mutation is outside this design and requires a separate additive security design;
- no generic `provider.invoke`, raw REST/GraphQL/MCP passthrough, arbitrary HTTP method/URL, provider-agent spawn/proxy, generic shell, or `skill.run` is introduced;
- Remote-CI v1 remains a proven sibling native service and is not refactored into Provider Gateway merely for symmetry.

The Provider Gateway core can therefore be implemented without immediately adding a public MCP tool. A future provider-backed semantic capability advances the MCP surface only when that capability itself is separately designed, implemented, tested, and registered.

## 2. Goals

The Provider Gateway must make third-party provider access possible without turning provider-controlled metadata into KodeGPT security policy.

It must provide:

1. local-operator provider admission and revocation;
2. durable provider instance identity and implementation identity;
3. deterministic inventory identity and fail-closed inventory drift handling;
4. explicit mapping from provider operations into KodeGPT-owned semantic capabilities;
5. bounded credential acquisition without secret persistence in v1;
6. explicit provider-specific network/process policy;
7. decision-before-effect durable audit and bounded provenance;
8. strict request/result schemas, byte/element/depth ceilings, and explicit truncation;
9. stable redacted error semantics;
10. timeout, cancellation, helper cleanup, and restart behavior;
11. no authority inheritance from skills, repositories, provider descriptions, or dynamic provider inventories;
12. coexistence with existing native Remote-CI without unnecessary refactoring.

## 3. Non-goals and rejected authority

This design does **not** authorize:

- generic REST proxying;
- generic GraphQL proxying;
- arbitrary URL or HTTP method execution;
- arbitrary request headers;
- raw provider request bodies supplied by MCP callers;
- provider-defined schemas becoming public KodeGPT tools automatically;
- generic MCP proxying;
- provider-agent spawn/proxy;
- generic subprocess execution;
- generic shell execution;
- arbitrary executable or argv selection;
- repository-controlled provider admission or configuration;
- repository-controlled credential selection;
- automatic workspace/context upload;
- `skill.run`;
- remote provider mutation in the first Provider Gateway implementation;
- CI rerun/cancel/dispatch or replacement of existing Remote-CI v1;
- service lifecycle authority over MCP;
- new desktop/computer-use authority.

## 4. Architecture alternatives

### 4.1 Approach A — typed provider-backed semantic capabilities — selected

KodeGPT exposes only reviewed KodeGPT semantic capabilities. Each capability has a private mapping to one admitted provider adapter operation.

Example shape, deliberately illustrative rather than a promised public tool name:

```text
MCP semantic capability
  -> KodeGPT input schema
  -> capability policy
  -> admitted provider instance
  -> KodeGPT-owned adapter mapping
  -> bounded provider transport
  -> provider response parser
  -> KodeGPT result schema
  -> MCP
```

Advantages:

- smallest authority surface;
- provider descriptions and dynamic tool names never become upstream policy;
- schemas, effects, audit, and errors remain stable even when provider APIs change;
- easiest model for ChatGPT to use safely;
- aligns with the proven Remote-CI pattern of semantic capabilities over a private provider adapter.

Cost:

- every new semantic capability requires deliberate KodeGPT code/review.

This cost is intentional because each new provider-backed operation is new network authority.

### 4.2 Approach B — allowlisted typed dynamic invocation — not selected for v1

An admitted provider inventory could be visible and invocable only through KodeGPT-owned pre-approved mappings.

This can be safe in principle if provider/tool IDs, schemas, effect class, inventory fingerprint, and request/result adapters are pinned. It is still more complex than Approach A because inventory drift and dynamic invocation become part of the public contract.

Approach B is not part of v1. Adopting it later requires a new design amendment and must not be smuggled into the v1 implementation plan.

### 4.3 Approach C — generic provider passthrough — rejected

KodeGPT will not expose an invocation contract where an MCP caller selects arbitrary provider names, tool names, HTTP methods, endpoints, GraphQL documents, MCP method names, request bodies, headers, or arbitrary provider-defined schema payloads.

This would make provider-supplied metadata effectively define upstream authority and is incompatible with KodeGPT's explicit bounded-authority model.

## 5. High-level component model

The private Provider Gateway consists of the following independently testable units.

### 5.1 `ProviderRegistry`

Owns durable non-secret provider admission records beneath the KodeGPT state root.

Responsibilities:

- parse a versioned registry with deny-unknown-field semantics;
- return immutable admitted provider snapshots;
- perform atomic private-permission updates from local operator commands;
- reject corrupt, unsupported, or ambiguous state;
- never read provider authority from repository content.

### 5.2 `ProviderAdapterRegistry`

A KodeGPT-owned compiled registry of supported adapter implementations.

Each adapter manifest defines:

- `adapterId`;
- adapter contract version;
- supported semantic capability mappings;
- effect class;
- transport type;
- allowed origins/endpoints/methods or helper identity policy;
- credential broker type;
- request/output limits no weaker than gateway hard ceilings;
- inventory strategy;
- implementation fingerprint inputs.

Provider-supplied descriptions are not part of this policy manifest.

### 5.3 `ProviderIdentityVerifier`

Recomputes the compiled adapter identity and any credential-helper identity before every provider call and compares them with the admitted record.

Identity mismatch is fail-closed and never auto-updated.

### 5.4 `ProviderInventoryVerifier`

Produces a canonical normalized inventory fingerprint and checks it against the locally approved fingerprint when the adapter has dynamic inventory.

For fixed HTTP adapters, the inventory is the KodeGPT-owned static adapter manifest and does not require a provider inventory network request.

### 5.5 `ProviderCredentialBroker`

Obtains credentials just-in-time from an admitted provider-specific external owner. It returns an in-memory secret object scoped to one operation.

KodeGPT v1 does not persist raw provider credentials.

### 5.6 `ProviderNetworkTransport`

Performs only adapter-authorized network requests with fixed origin/method/endpoint templates, TLS validation, redirect rules, DNS/address checks, body ceilings, timeout, and cancellation.

### 5.7 `ProviderHelperRunner`

Optional in v1 and limited to credential bootstrap for a specific reviewed credential broker. Provider operation traffic itself uses `ProviderNetworkTransport`; a helper/CLI may not become an alternate provider-network execution path in v1.

It is not a general subprocess API. Any future adapter that requires a CLI to perform the provider network operation itself requires a new design amendment because KodeGPT would otherwise lose direct method/origin/redirect enforcement.

### 5.8 `ProviderGatewayService`

Coordinates one semantic provider operation:

1. parse KodeGPT semantic input;
2. resolve active profile/workspace policy;
3. resolve admitted provider instance;
4. verify local adapter/credential-helper identity and resolve the KodeGPT mapping;
5. create an operation ID;
6. durably record decision;
7. obtain credential if required through the bounded credential broker/helper path;
8. for dynamic-inventory adapters, fetch the bounded live inventory through `ProviderNetworkTransport` and verify the approved fingerprint;
9. perform the bounded semantic provider request through `ProviderNetworkTransport`;
10. parse provider data into a strict intermediate schema;
11. map into a strict KodeGPT result schema;
12. durably record outcome;
13. return only the bounded KodeGPT result.

## 6. Provider admission and durable identity

Provider admission is **local-operator-only authority**.

The first implementation must use the local operator command family `kodegpt provider add`, `kodegpt provider remove`, `kodegpt provider enable`, `kodegpt provider disable`, and `kodegpt provider reapprove`. Read-only operator inspection uses `kodegpt provider list` / `kodegpt provider inspect`. These commands are local CLI authority and are not MCP tools; there is no local `provider invoke` command in v1.

Repository content may reference a semantic capability requirement, but may not:

- create a provider record;
- change a provider record;
- enable a disabled provider;
- select arbitrary transport configuration;
- change credentials;
- change endpoint/origin policy;
- approve identity or inventory drift.

### 6.1 Durable registry location and permissions

The registry is stored under:

```text
~/.kodegpt/providers/registry.json
```

Requirements:

- parent directory mode `0700`;
- registry mode `0600`;
- schema version `1` initially;
- deny unknown fields;
- atomic write/rename consistent with existing KodeGPT private state stores;
- unsupported schema or malformed content causes provider operations and provider mutations to fail closed;
- core KodeGPT startup remains available when provider registry state is unusable; provider-backed operations report a normalized provider-state error instead of blocking unrelated native capabilities.

### 6.2 Provider record

A normalized provider record contains only non-secret KodeGPT-owned fields:

```text
schemaVersion
providerInstanceId
operatorName
adapterId
adapterContractVersion
enabled
implementationFingerprint
inventoryMode
approvedInventoryFingerprint | null
credentialBroker
nonSecretAdapterConfig
createdAt
updatedAt
```

`providerInstanceId` is KodeGPT-generated and immutable, using an opaque ID such as `prv_<32 lowercase hex>`.

`operatorName` is display metadata only and is never used as an authority key.

### 6.3 Admission workflow

Local admission performs, in order:

1. validate operator-supplied adapter-specific non-secret configuration;
2. resolve the compiled `adapterId` manifest;
3. resolve and verify any required credential-helper executable without executing it;
4. compute implementation identity;
5. generate the admission operation ID and durably record the audit decision;
6. if dynamic inventory exists, obtain credentials through the approved broker and fetch/normalize inventory through the adapter's bounded network path;
7. compute inventory fingerprint;
8. atomically persist the admitted record;
9. record durable audit success.

If durable audit is unavailable before the mutation, no provider state is changed.

If identity, credential acquisition, dynamic inventory validation, fingerprinting, or persistence fails after the decision record, admission records a bounded failed outcome when audit remains available and leaves no partially admitted provider. No failed admission can leave an enabled provider record behind.

### 6.4 Removal, disable, and reapproval

- disable preserves the record but makes all provider-backed capabilities unavailable immediately;
- removal deletes the admission record after durable decision logging;
- reapproval is required after implementation or inventory drift;
- no provider call can auto-reapprove itself;
- reapproval must show the operator the normalized non-secret identity/inventory delta through local CLI before persisting the new fingerprint.

## 7. Provider implementation identity

Provider identity has two layers.

### 7.1 KodeGPT adapter identity

The compiled adapter identity includes:

- `adapterId`;
- adapter contract version;
- KodeGPT package/runtime version identity relevant to that adapter;
- canonical policy manifest hash.

### 7.2 Credential-helper identity

When a reviewed `credentialBroker` requires a local helper, admission pins:

- canonical absolute executable path;
- content SHA-256;
- executable file type;
- file ownership/mode constraints appropriate to the host;
- proof that the executable is outside every admitted workspace root.

Before every provider operation that uses that broker, the helper is canonicalized and its content SHA-256 is recomputed. Any path or content change yields `PROVIDER_IDENTITY_CHANGED` before the helper is executed.

A credential helper located inside a workspace is never trusted.

Adapters whose credential broker does not use a helper rely on the KodeGPT adapter identity plus the compiled network policy manifest and broker configuration identity.

## 8. Tool inventory identity and drift

Provider tool descriptions are **untrusted data**, not policy.

### 8.1 Static adapters

A direct HTTP adapter with fixed KodeGPT-owned semantic operations uses a static local inventory derived from its compiled manifest. Provider discovery is unnecessary.

### 8.2 Dynamic-inventory adapters

If a future reviewed adapter must inspect a remote tool inventory, the inventory path itself is explicitly coded and bounded.

Normalized inventory retains only policy-relevant structural data:

- stable provider tool identifier;
- provider API/tool contract version when available;
- normalized input schema;
- normalized output schema when available.

Provider descriptions, examples, prompts, marketing text, and arbitrary annotations are excluded from policy and excluded from the security fingerprint.

Hard inventory ceilings for v1:

- maximum 128 tools;
- maximum 32 KiB normalized input schema per tool;
- maximum 32 KiB normalized output schema per tool;
- maximum nesting depth 16;
- maximum 512 KiB canonical normalized inventory.

Exceeding a ceiling fails inventory validation; inventory is not silently partially approved.

### 8.3 Fingerprint

The fingerprint is SHA-256 over deterministic canonical JSON containing only normalized structural fields in deterministic order.

A mapped capability is callable only when the current fingerprint equals the operator-approved fingerprint.

Unexpected change yields `PROVIDER_INVENTORY_CHANGED` before semantic invocation. The mapping stays blocked until local operator reapproval.

A previously approved mapping never remains valid merely because a provider tool retained the same display name.

## 9. KodeGPT capability mapping

Provider tools never register themselves into MCP.

A provider-backed semantic mapping is KodeGPT code, reviewed like any other authority-bearing capability.

Each mapping declares:

- semantic capability ID;
- exact KodeGPT input schema;
- exact KodeGPT result schema;
- admitted adapter IDs it supports;
- provider operation/tool ID if relevant;
- expected provider schema fingerprint or adapter contract version;
- effect class;
- workspace binding policy;
- request budget;
- output/truncation policy;
- timeout/retry policy;
- audit metadata allowlist.

### 9.1 Effect class

The first Provider Gateway implementation accepts only:

```text
REMOTE_READ
```

Provider-backed remote mutation is intentionally outside v1. Adding `REMOTE_MUTATION` requires a separate security design addressing authorization, idempotency, replay, partial success, post-effect audit failure, conflict/precondition behavior, and user-visible mutation provenance.

### 9.2 Workspace binding

Each semantic capability declares one of:

- `REQUIRED` — a trusted READY workspace must be selected and provider data may use only explicitly typed workspace-derived fields;
- `OPTIONAL` — a workspace may provide bounded context but is not authority for provider admission;
- `NONE` — the provider call is independent of workspace state.

When a `REQUIRED` mapping uses a workspace, the effective workspace profile must permit network access. With the current presets, `observe` and `develop` have `network=deny`, while `trusted` has `network=unrestricted`; therefore provider network effects for a workspace-bound call are denied unless the effective resolved profile permits them. An `OPTIONAL` mapping follows the same rule whenever it actually consumes workspace-derived data. Project/repository profile restrictions may only narrow this permission and can never elevate it.

A `NONE` mapping has no workspace profile to consult. Its network authority comes only from the reviewed KodeGPT semantic mapping plus the locally admitted provider record and compiled adapter `NetworkPolicy`. Repository content has no input into that decision.

Repository content never changes the provider mapping, provider admission, or transport policy.

### 9.3 No implicit context upload

The gateway never automatically sends:

- repository files;
- full diffs;
- environment variables;
- shell history;
- host paths;
- skill bundles;
- prompts from unrelated turns;
- credentials from other providers.

Only fields explicitly present in the semantic capability's KodeGPT-owned request builder may cross the provider boundary.

## 10. Credential ownership and lifecycle

### 10.1 v1 decision: no KodeGPT-persisted raw provider secrets

Raw provider credentials are not stored under `~/.kodegpt` in Provider Gateway v1.

Each adapter uses a KodeGPT-owned `credentialBroker` definition that points to a specific external credential owner such as an already-authenticated provider CLI or OS credential facility.

The durable provider record stores only non-secret broker metadata such as broker type and hostname/account selector where safe.

### 10.2 Just-in-time acquisition

Credential acquisition occurs only after:

- provider admission and enabled state pass;
- local adapter/credential-helper identity passes;
- static inventory validation passes when the adapter is static;
- capability/profile/workspace policy passes;
- durable audit decision succeeds.

For a dynamic-inventory adapter, live inventory is fetched and fingerprint-checked only after this credential acquisition, through the same bounded `ProviderNetworkTransport`, and before the semantic provider request. The credential is retained in memory only for the current operation and references are dropped afterward.

### 10.3 External CLI credential broker

If an adapter uses a CLI credential broker:

- helper executable identity is pinned/revalidated as described above;
- `shell=false`;
- argv is fixed by adapter code;
- stdin is closed;
- environment is a minimal KodeGPT-owned allowlist;
- arbitrary inherited environment is forbidden;
- stdout/stderr are separately bounded;
- credential output is accepted only as one bounded single-line token/secret value where the broker contract requires that format;
- the token is never logged, audited, returned, or copied into error text.

### 10.4 Rotation and revocation

Rotation/revocation is owned by the external credential system. KodeGPT re-fetches credentials per provider operation, so rotated or revoked credentials take effect without updating the provider registry.

Provider authentication rejection maps to `PROVIDER_CREDENTIAL_REJECTED`; absence of usable credential maps to `PROVIDER_CREDENTIAL_UNAVAILABLE`.

A future KodeGPT-owned encrypted secret store is outside v1 and requires a separate design amendment. No implementation plan may add raw-secret persistence as an incidental convenience.

## 11. Network authority

Every network-capable adapter has a compiled provider-specific `NetworkPolicy`.

### 11.1 Origin and protocol

- HTTPS only for Internet providers;
- exact host/origin allowlist owned by adapter code;
- no caller-supplied scheme, hostname, port, username, or password;
- no raw IP address provider configuration for Internet adapters;
- TLS certificate and hostname verification remain enabled;
- no `NODE_TLS_REJECT_UNAUTHORIZED=0`, custom trust bypass, or equivalent downgrade.

### 11.2 DNS/address validation

Before Internet connection, the transport resolves the admitted hostname and rejects loopback, unspecified, link-local, multicast, and private-address results for adapters declared `internet`.

The validated address set must remain authoritative for the connection attempt: the transport must bind the request to the validated resolution (or an equivalent resolver hook) so the connection cannot silently re-resolve to a different address after policy validation. Every retry performs a fresh bounded validation. The transport must not follow a provider-controlled DNS result into a local/private service.

Provider adapters explicitly intended for local endpoints are outside this v1 Internet-provider policy and require a separate design.

### 11.3 Methods and endpoints

- method is a fixed adapter mapping, never caller-selected;
- endpoint is a fixed template owned by adapter code;
- typed path/query parameters are separately validated and encoded;
- request headers are a fixed allowlist;
- caller-supplied arbitrary headers are forbidden;
- credential headers are injected only by transport code after all policy checks;
- generic GraphQL documents are forbidden; a future adapter may use a fixed compiled GraphQL document only if separately reviewed.

### 11.4 Redirects

Default: redirects are manual and denied.

An adapter may explicitly permit one bounded redirect flow only when:

- the initial endpoint is fixed;
- the redirect target policy is separately validated;
- credential headers are stripped before crossing to any different origin;
- redirect depth is exactly bounded;
- subsequent redirects are denied.

### 11.5 Request and response hard ceilings

Gateway-wide hard ceilings for v1:

- serialized semantic input: 64 KiB;
- serialized provider request body: 256 KiB;
- provider metadata response body: 2 MiB;
- public KodeGPT semantic result: 512 KiB;
- maximum collection elements before capability-specific reduction: 1,000;
- maximum normalized structural depth: 16.

Each adapter/capability may impose lower bounds. It may never raise them above the gateway hard ceilings without a new reviewed design.

Provider bodies larger than a parser-safe bound fail closed rather than being partially parsed.

## 12. Process authority

A local provider helper in v1 is allowed only as the credential bootstrap mechanism of one reviewed `credentialBroker`. Provider semantic requests themselves must use the direct bounded `ProviderNetworkTransport`; a CLI/helper is not an alternate provider execution transport in v1.

Requirements:

- absolute canonical executable path;
- helper outside admitted workspace roots;
- content SHA-256 pinned and revalidated;
- regular executable file only;
- no shell;
- no arbitrary executable selection;
- no arbitrary argv;
- fixed argv template owned by credential-broker code;
- no credential value in argv;
- no inherited secrets/environment;
- minimal environment allowlist;
- stdin closed;
- maximum stdout 64 KiB;
- maximum stderr 64 KiB;
- process timeout no greater than 5 seconds;
- cancellation terminates the child;
- process group/descendant cleanup is required so credential helpers cannot become orphan background services;
- raw PID, cwd, executable path, environment, and host path are never published through MCP.

Long-lived provider agents, provider-operation CLIs, generic MCP subprocess proxies, and provider-controlled child spawning are not part of v1. Supporting provider operation traffic through a CLI requires a new design amendment with an enforceable equivalent of the network policy.

## 13. Operation flow and audit ordering

A provider-backed semantic call follows this order:

1. validate public semantic input;
2. resolve profile/workspace binding;
3. resolve admitted provider instance;
4. verify enabled state;
5. verify local adapter/credential-helper identity;
6. verify static inventory when the adapter is static;
7. resolve the KodeGPT capability mapping;
8. generate stable bounded operation ID;
9. durably record **decision**;
10. acquire credential;
11. for a dynamic-inventory adapter, fetch the bounded live inventory through `ProviderNetworkTransport` and compare it with the approved fingerprint;
12. invoke the semantic provider operation only after inventory validation succeeds;
13. parse bounded provider response into strict intermediate data;
14. map/fit into KodeGPT result schema;
15. durably record **success** or **failed** outcome;
16. return result or normalized error.

No credential acquisition, helper execution, or network request may occur before the decision record is durable.

If the decision record fails, the operation returns `PROVIDER_AUDIT_UNAVAILABLE` without effect.

Because v1 is remote-read-only, an outcome-audit failure after a provider read does not create remote mutation ambiguity; the call still fails closed to the caller with `PROVIDER_AUDIT_UNAVAILABLE`.

## 14. Audit and provenance contract

Provider security events use the existing durable audit discipline and must remain bounded/redacted.

### 14.1 Invocation audit metadata

Allowed metadata includes:

- workspace ID when applicable;
- operation ID;
- semantic capability ID;
- provider instance ID;
- adapter ID and adapter contract version;
- implementation fingerprint prefix or full non-secret digest;
- inventory fingerprint when applicable;
- normalized provider operation/tool ID;
- credential broker **type only**;
- provider hostname identifier only when it is already part of compiled policy;
- success/failure phase;
- normalized error code;
- truncation boolean/reasons;
- provider request count;
- duration.

Audit must never persist:

- credential/token values;
- Authorization/Cookie headers;
- raw request bodies;
- raw provider response bodies;
- raw provider logs;
- environment dumps;
- local home/workspace absolute paths;
- PIDs/file descriptors;
- provider prompts/descriptions unless a future capability explicitly defines a safe bounded field.

### 14.2 Inventory audit

Admission and inventory reapproval records include old/new non-secret fingerprints and structural counts, never raw provider descriptions or credentials.

Unexpected runtime inventory drift records a failed outcome with `PROVIDER_INVENTORY_CHANGED`.

## 15. Provider response and public output contracts

Provider output is untrusted data.

### 15.1 Parsing sequence

1. enforce transport byte ceiling;
2. decode text as fatal UTF-8 where the contract is textual;
3. parse expected JSON/structured form;
4. deny malformed required structure;
5. validate field-specific identifier/text rules;
6. normalize permitted user-visible text;
7. apply semantic collection/text limits;
8. add explicit truncation reasons where safe truncation is defined;
9. validate the final KodeGPT-owned result schema;
10. publish only the final result.

### 15.2 Text normalization

- opaque provider IDs use explicit ASCII/format validation and are not Unicode-normalized;
- provider labels/user-visible Unicode text must be valid UTF-8 and normalized to NFC;
- CRLF/CR in permitted multiline text normalize to LF;
- NUL is rejected;
- field-specific control-character rules are explicit;
- provider strings are never interpreted as shell fragments, URLs, paths, headers, or policy solely because of their textual value.

### 15.3 Binary data

Raw binary provider objects are not published by default.

A future semantic capability that needs binary/artifact data must define a separate typed artifact contract with MIME allowlist, byte limit, provenance, storage lifetime, and redaction rules. Generic base64/raw-binary passthrough is not allowed by this design.

### 15.4 Truncation

Safe truncation must be capability-defined and observable via fields such as:

```text
truncated: boolean
truncationReasons: string[]
```

If truncation would make the semantic result misleading or structurally invalid, the operation fails with `PROVIDER_OUTPUT_LIMIT_EXCEEDED` instead of returning partial data.

## 16. Timeouts, retries, cancellation, and lifecycle

### 16.1 Deadlines

Default gateway limits:

- helper/credential command: 5 seconds unless a stricter adapter limit is defined;
- one provider network attempt: 10 seconds;
- total provider operation deadline: 30 seconds;
- maximum provider network requests per semantic operation: 8 unless a lower capability budget applies.

No capability may raise the total deadline or request budget above these v1 ceilings without design review.

### 16.2 Retries

Retries are disabled by default.

A read-only adapter may opt into at most one retry only for a transport failure or explicit retryable server response when:

- the request is idempotent;
- retry remains within the same total deadline;
- rate-limit responses are not blindly retried;
- request count remains within the capability budget.

Provider mutation has no retry policy because provider mutation is outside v1.

### 16.3 Cancellation

Cancellation propagates through an operation-scoped cancellation token/`AbortSignal` to network requests and helper processes.

Cancellation:

- stops further provider requests;
- terminates helper process trees;
- releases in-memory credentials;
- records a bounded failed outcome when audit is available;
- returns `PROVIDER_CANCELLED`.

### 16.4 Startup and shutdown

- normal KodeGPT startup does not contact providers;
- missing provider credentials do not block native KodeGPT startup;
- Provider Gateway creates no background provider session in v1;
- provider state is loaded/validated lazily for provider-backed calls and local provider CLI operations;
- shutdown cancels in-flight calls and waits only for bounded cleanup;
- restart does not resurrect provider sessions or helpers;
- provider registry/admission state remains durable across restart.

## 17. Stable error taxonomy

The Provider Gateway defines normalized non-secret errors. Public semantic capabilities may expose these codes directly or map them one-to-one into an equivalent capability-specific code, but raw provider error text is never published.

Required codes:

```text
PROVIDER_INPUT_INVALID
PROVIDER_STATE_INVALID
PROVIDER_NOT_ADMITTED
PROVIDER_DISABLED
PROVIDER_IDENTITY_CHANGED
PROVIDER_CREDENTIAL_UNAVAILABLE
PROVIDER_CREDENTIAL_REJECTED
PROVIDER_NETWORK_DENIED
PROVIDER_UNAVAILABLE
PROVIDER_TIMEOUT
PROVIDER_CANCELLED
PROVIDER_RATE_LIMITED
PROVIDER_RESPONSE_INVALID
PROVIDER_OUTPUT_LIMIT_EXCEEDED
PROVIDER_TOOL_UNAVAILABLE
PROVIDER_INVENTORY_CHANGED
PROVIDER_REQUEST_FAILED
PROVIDER_AUDIT_UNAVAILABLE
```

Semantics:

- `PROVIDER_INPUT_INVALID`: caller input fails the KodeGPT-owned semantic schema or bounded field rules;
- `PROVIDER_STATE_INVALID`: the local provider registry or admitted record is corrupt, unsupported, or internally inconsistent;
- `PROVIDER_NOT_ADMITTED`: no locally admitted instance exists for the semantic mapping;
- `PROVIDER_DISABLED`: the admitted instance is disabled;
- `PROVIDER_IDENTITY_CHANGED`: compiled/helper identity no longer matches the approved record;
- `PROVIDER_CREDENTIAL_UNAVAILABLE`: credential broker cannot provide a credential;
- `PROVIDER_CREDENTIAL_REJECTED`: provider rejects the credential;
- `PROVIDER_NETWORK_DENIED`: origin/address/method/endpoint/redirect policy rejects the request before an unauthorized connection/request is made;
- `PROVIDER_UNAVAILABLE`: connection/provider server unavailable;
- `PROVIDER_TIMEOUT`: operation or attempt deadline exceeded;
- `PROVIDER_CANCELLED`: caller/service cancellation stopped the provider operation and bounded cleanup was initiated;
- `PROVIDER_RATE_LIMITED`: normalized 429/provider-specific rate limit, optionally with bounded `retryAfter`/`resetAt` metadata;
- `PROVIDER_RESPONSE_INVALID`: malformed or policy-incompatible provider response;
- `PROVIDER_OUTPUT_LIMIT_EXCEEDED`: response cannot be safely represented within KodeGPT limits;
- `PROVIDER_TOOL_UNAVAILABLE`: approved provider operation is absent;
- `PROVIDER_INVENTORY_CHANGED`: live inventory fingerprint differs from approved inventory;
- `PROVIDER_REQUEST_FAILED`: bounded catch-all for a non-auth, non-rate-limit, non-availability provider rejection;
- `PROVIDER_AUDIT_UNAVAILABLE`: durable audit gate cannot be satisfied.

Raw HTTP status text, provider exception messages, response bodies, helper stderr, secrets, paths, and headers are never copied into public messages.

## 18. Public MCP surface decision

### 18.1 `provider.invoke`

**Rejected for v1.** There is no generic public invocation API.

The name may remain in historical documents as an old concept, but it is not approved authority.

### 18.2 `provider.list` and `provider.tools`

**Not public in v1.** Provider inventory and admission inspection are local operator CLI concerns initially.

Reasons:

- provider metadata is dynamic and provider-controlled;
- exposing arbitrary descriptions/tool catalogs can become prompt-injection/noise surface even if read-only;
- Approach A does not need dynamic provider discovery for ChatGPT to call reviewed semantic capabilities.

If future host usability evidence proves public read-only provider metadata is necessary, it requires an explicit surface design amendment with strict sanitization, count/byte bounds, and no authority effect.

### 18.3 Semantic provider-backed tools

Any public MCP tool backed by Provider Gateway must be a separately named KodeGPT semantic capability with explicit schemas/effects. Registering such a capability is what advances semantic MCP surface version, not merely adding private Provider Gateway internals.

This P1 design document changes no MCP surface and keeps current surface `0.7`.

## 19. Relationship with skills

Provider interoperability does **not** imply skill execution.

Locked rules:

- `skill.list`, `skill.inspect`, and `skill.load` remain read-only skill operations;
- loading a skill never invokes a provider;
- `skill.run` remains absent;
- skill source/pin metadata cannot admit or enable a provider;
- skill metadata cannot choose transport origin, credential broker, helper executable, or provider tool mapping;
- `skill.inspect.capabilityPlan` may report that a KodeGPT semantic capability is provider-backed or unavailable because a provider is not admitted;
- provider-backed capability execution still requires a separate explicit MCP capability call and all Provider Gateway policy/audit gates;
- provider descriptions/prompts cannot rewrite skill compatibility classifications or KodeGPT policy.

A loaded skill may instruct ChatGPT to use an existing semantic capability, just as it can instruct ChatGPT to use a native capability; that instruction does not grant or widen authority.

## 20. Relationship with Remote-CI v1

Remote-CI v1 remains a sibling native bounded service.

It already has proven properties that Provider Gateway should emulate:

- explicit semantic `ci.*` surface;
- fixed GitHub provider mapping;
- bounded credential bootstrap;
- fixed HTTPS origin/method behavior;
- provider response ceilings;
- normalized errors;
- decision-before-effect durable audit;
- strict result schemas;
- no generic GitHub/API passthrough.

### 20.1 No mandatory migration

Provider Gateway implementation must not refactor `ci.*` through the gateway merely for architectural symmetry.

Remote-CI migration is allowed only if later evidence shows a concrete maintenance/security benefit and a separate change proves:

- byte-for-byte/public-schema compatibility where promised;
- unchanged audit semantics;
- unchanged credential/network authority;
- no new generic provider authority;
- full Remote-CI regression and fresh-host acceptance.

### 20.2 Shared lower-level abstractions

Later code may share lower-level primitives such as:

- trusted helper identity verification;
- minimal credential-command runner;
- bounded network transport utilities;
- redaction helpers;
- operation deadline utilities;
- audit metadata helpers.

Extraction is opt-in and evidence-driven. Provider Gateway does not require rewriting Remote-CI v1 first.

## 21. Security invariants

The implementation plan must preserve all of these invariants.

1. Provider authority is created only by local operator admission plus reviewed KodeGPT adapter code.
2. Repository content cannot admit/reapprove/enable a provider.
3. Provider metadata/descriptions are never policy.
4. Dynamic provider inventory cannot automatically create MCP tools.
5. Inventory/implementation drift is fail-closed.
6. Credential values are never persisted by KodeGPT v1.
7. Credential acquisition happens only after durable audit decision.
8. Network requests use exact adapter-owned origins/methods/endpoints.
9. No arbitrary URL/header/body passthrough exists.
10. No shell or arbitrary subprocess interface exists.
11. Credential helpers are pinned and outside workspace roots; provider operation traffic never executes through them in v1.
12. No automatic repository/workspace/environment upload exists.
13. Provider output is parsed and mapped into strict KodeGPT schemas.
14. Raw provider errors/secrets/paths/PIDs/environment are never public/audited.
15. Every call has bounded time, request count, input, provider response, and public output.
16. Cancellation cleans up provider requests/helpers.
17. v1 provider authority is remote-read-only.
18. `skill.run` remains absent.
19. Remote-CI remains standalone unless separately justified.
20. Rust remains final OS/security authority for local filesystem/process effects already under Rust authority; Provider Gateway does not bypass retained-root or existing local process authority.

## 22. Threat model and required mitigations

### Provider schema/description prompt injection

Threat: a provider advertises malicious descriptions/prompts intended to influence ChatGPT or policy.

Mitigation: descriptions are excluded from authority and inventory fingerprint; v1 does not expose generic provider inventory over MCP; semantic mappings are KodeGPT-owned.

### Repository attempts to create provider trust

Threat: repository configuration or skill metadata names a provider and silently enables it.

Mitigation: provider admission/enable/reapproval are local CLI-only durable state mutations. Repository data is never loaded as provider configuration.

### Credential exfiltration

Threat: a provider response/error/audit record leaks secret material.

Mitigation: JIT credential scope, fixed transport injection, no raw body/error logging, redaction tests with canary tokens, no credential persistence.

### SSRF / arbitrary network authority

Threat: caller/provider data controls URL, redirect, DNS target, method, or headers.

Mitigation: fixed origin/method/endpoint templates, typed encoded parameters, address-class validation, manual redirect policy, TLS validation, no arbitrary headers.

### Helper replacement

Threat: admitted CLI/helper changes after approval.

Mitigation: canonical path plus content SHA-256 revalidated before every execution; mismatch fails closed.

### Inventory drift

Threat: provider silently changes tool schema/semantics.

Mitigation: deterministic structural fingerprint; mismatch blocks mapped capability until local reapproval.

### Output flooding / parser exhaustion

Threat: provider returns huge/deep/invalid responses.

Mitigation: byte ceilings before parse, depth/count ceilings, fatal UTF-8, strict schemas, bounded truncation or explicit limit failure.

### Orphan provider processes

Threat: helper survives timeout/shutdown.

Mitigation: no background sessions, process-tree cancellation/kill, bounded shutdown cleanup, lifecycle tests.

## 23. Verification strategy for the future implementation

The future implementation plan must be test-first and include at least the following executable evidence.

### Registry/admission

- unknown fields/schema fail closed;
- private permissions and atomic update behavior;
- repository content cannot mutate provider registry;
- disabled/removed provider cannot execute;
- audit failure prevents admission mutation.

### Identity

- helper outside workspace accepted only when pinned;
- workspace-contained helper rejected;
- helper content replacement produces `PROVIDER_IDENTITY_CHANGED` before execution;
- adapter manifest version/fingerprint drift blocks calls.

### Inventory

- deterministic fingerprint independent of description text/order noise;
- tool/schema structural change changes fingerprint;
- drift blocks execution;
- inventory count/schema/depth/total-byte ceilings fail closed;
- no dynamic public MCP registration occurs.

### Credentials

- no secret persistence in provider registry/state;
- minimal child environment;
- fixed credential argv;
- bounded stdout/stderr and timeout;
- credential canary never appears in result/error/audit;
- revoked/missing credential maps to stable codes.

### Network

- arbitrary URL/method/header attempts impossible at the public schema layer;
- wrong origin rejected before transport;
- private/loopback/link-local address resolution rejected for Internet adapters;
- TLS validation remains enabled;
- redirects denied unless adapter-specific rule permits them;
- credentials stripped on permitted cross-origin redirect;
- body/request-count/deadline ceilings enforced.

### Audit

- durable decision occurs before credential/helper/network effect;
- audit decision failure prevents effect;
- success/failed outcomes carry only allowlisted metadata;
- audit scanning finds no secret/header/raw-body/path/environment canaries.

### Output

- malformed UTF-8/JSON/schema rejected;
- Unicode/newline normalization deterministic;
- explicit truncation reasons tested;
- unsafe partial results produce `PROVIDER_OUTPUT_LIMIT_EXCEEDED`;
- no raw provider object crosses MCP.

### Cancellation/lifecycle

- cancelled network request aborts;
- cancelled helper/process tree exits;
- no orphan child remains after timeout/shutdown;
- startup succeeds with provider absent/unauthed;
- restart does not create provider sessions.

### Skills and surface

- `skill.load` cannot execute provider actions;
- skill metadata cannot mutate provider admission;
- `skill.run` remains absent;
- no `provider.invoke`/generic passthrough surface appears;
- private gateway core alone does not bump surface above `0.7`.

### Remote-CI regression

- existing `ci.*` behavior/tests remain unchanged unless a separately approved migration exists;
- no Provider Gateway implementation may weaken current Remote-CI credential/network/audit bounds.

## 24. Implementation gate

This document is the security/design gate only.

Before production Provider Gateway code is written:

1. this spec must be explicitly reviewed and approved by the user;
2. after approval, a separate detailed implementation plan must be written using repository planning conventions;
3. that plan must choose a bounded first adapter/capability scope and define RED/GREEN evidence;
4. implementation must not include authority excluded by this spec;
5. any need for remote mutation, generic dynamic invocation, public provider inventory, raw-secret persistence, local/private-network providers, persistent provider sessions, or provider-agent/MCP proxying requires a new design amendment before code.

No design-only commit may bump MCP surface above `0.7` or register provider tools.

## 25. Resolved acceptance checklist

This design resolves the required P1 questions as follows:

- provider admission/trust: local operator only, durable private registry, repository cannot create authority;
- durable identity/version: opaque provider instance ID plus compiled adapter and optional credential-helper implementation fingerprints;
- tool inventory identity/drift: deterministic bounded structural fingerprint; unexpected drift blocks execution pending local reapproval;
- capability mapping: KodeGPT-owned typed semantic mappings only in v1;
- credential ownership/storage/rotation/redaction: external owner, JIT in-memory acquisition, no KodeGPT raw-secret persistence in v1, external rotation/revocation, strict redaction;
- network authority: HTTPS, fixed origins/methods/endpoints, address validation, redirect policy, bounds, deadlines;
- process authority: optional pinned credential-helper only, no provider-operation CLI, no shell/arbitrary argv, clean environment, bounded I/O/lifecycle;
- durable audit/provenance: decision before effect, bounded outcome, stable provider/mapping identity, no secrets/raw payloads;
- request/output bounds: explicit gateway ceilings plus stricter per-capability limits;
- timeout/cancellation/lifecycle: concrete deadlines, bounded retry, abort/kill cleanup, no background sessions;
- stable errors: explicit `PROVIDER_*` taxonomy with redacted normalization;
- public MCP surface: no generic provider surface in v1; only separately reviewed semantic capabilities may become public;
- skills relationship: advisory capability planning only; no execution authority and no `skill.run`;
- Remote-CI coexistence: remains standalone; lower-level sharing/migration only if separately justified and proven;
- rejected alternatives: generic passthrough rejected; typed dynamic invocation deferred behind a new design amendment;
- implementation gate: explicit user approval, then a separate implementation plan, then test-first code.

All security-critical v1 decisions in this boundary are closed. Features explicitly outside v1 require a new additive design rather than an implicit implementation-time decision.
