# KodeGPT v0.1 — Personal ChatGPT ngrok Exposure Design

Date: 2026-08-10
Status: Design approved; implemented locally with deterministic verification PASS; real ChatGPT host observation and git durability pending
Scope: Amendment to Task 20 manual exposure contract and Task 24 ChatGPT host compatibility

## 1. Purpose

KodeGPT v0.1 needs a simple personal/development connection path that behaves like the already-working CodexPro deployment on this machine:

```text
ChatGPT Developer Mode custom MCP app
        ↓ HTTPS
stable ngrok endpoint
        ↓
ngrok local agent
        ↓ HTTP loopback
KodeGPT MCP server
        ↓
workspace trust / policy / runtime
        ↓
read / write / edit / git / process
```

The goal is not to replace the existing transports. The goal is to add one explicit opt-in command that makes the existing KodeGPT HTTP MCP server usable from ChatGPT through a stable ngrok endpoint without OAuth or OpenAI Secure MCP Tunnel.

The user experience target is:

```bash
kodegpt expose ngrok --hostname my-kodegpt.ngrok-free.dev
```

On first use, KodeGPT creates a connector credential if none exists, starts its loopback MCP server, starts ngrok, and prints the ChatGPT Server URL containing a one-time-visible query compatibility token.

## 2. Design Principles

1. **Keep the core unchanged.** ngrok is transport only. Workspace trust, write permission, process permission, filesystem authority, audit, and sandboxing remain KodeGPT responsibilities.
2. **Keep existing modes.** `kodegpt start` and `kodegpt bridge` remain supported and keep their existing security behavior.
3. **Opt-in public exposure only.** ngrok may be spawned only by the explicit `kodegpt expose ngrok` command.
4. **No OAuth in v0.1 personal mode.** ChatGPT compatibility uses a strong static connector token in the MCP URL, matching the proven CodexPro pattern.
5. **No ngrok secret management.** KodeGPT never stores, reads, rotates, or prints the ngrok authtoken. The installed ngrok CLI owns its own configuration.
6. **No generic tunnel framework yet.** v0.1 has only an ngrok exposure module. A provider abstraction is deferred until a second provider actually exists.
7. **Stable hostname required.** Dynamic/random ngrok URLs are out of scope for v0.1.
8. **Fail closed on lifecycle failures.** The public exposure and the local KodeGPT server are supervised as one user-facing operation.

## 3. Command Surface

### Existing commands retained

```text
kodegpt start [--state-root <path>] [--port <port>] [--public-url <https-url>]
kodegpt bridge [--state-root <path>]
```

Their behavior remains unchanged:

- `start` binds only to `127.0.0.1` and never spawns a tunnel.
- `start` keeps normal Bearer authentication.
- `bridge` uses MCP stdio and never spawns a tunnel.

### New command

```text
kodegpt expose ngrok \
  --hostname <stable-hostname> \
  [--port <port>] \
  [--state-root <path>]
```

Rules:

- `--hostname` is mandatory.
- The value must be a hostname only, not a URL, path, query, fragment, username, or password.
- KodeGPT does not enforce a particular ngrok suffix; ngrok itself decides whether the requested hostname belongs to the configured account.
- `--port` defaults to the existing KodeGPT MCP port, `43121`.
- `--state-root` uses the same semantics as `start`, `workspace`, and `auth`.
- KodeGPT resolves `ngrok` through normal `PATH` lookup and invokes it without a shell.

## 4. Startup Flow

The startup sequence is deliberately small:

```text
parse + validate CLI args
        ↓
prepare connector credential
        ├─ existing → reuse verifier, do not rotate
        └─ missing  → create once and retain raw token in memory only
        ↓
start KodeGPT HTTP using existing startKodegpt stack
        ↓
listener bound to 127.0.0.1:<port>
query compatibility enabled for this invocation only
publicUrl = https://<hostname>/mcp
        ↓
spawn ngrok without shell
        ↓
ngrok http http://127.0.0.1:<port> --url https://<hostname>
        ↓
1-second startup grace: child must remain running and emit no spawn error
        ↓
ready
```

`startKodegpt()` already validates the production runtime, kernel hello, filesystem boundary, audit health, MCP construction, authentication setup, and loopback binding before it returns. `expose ngrok` must reuse that behavior rather than creating a second production stack.

No ngrok inspector polling, control API integration, dynamic URL discovery, or separate readiness subsystem is required for v0.1.

## 5. Connector Credential Behavior

The existing KodeGPT connector credential remains the only credential source of truth.

Current properties are retained:

- token prefix and format remain unchanged;
- secret entropy remains unchanged;
- the state store contains only the verifier and metadata;
- store file permissions remain private;
- verification continues to use the existing timing-safe comparison path;
- `kodegpt auth rotate` remains available to explicitly invalidate and replace the credential.

### First expose

If no connector credential exists, `kodegpt expose ngrok` creates one using the existing credential store. The raw token exists only in process memory and may be printed once for onboarding.

Example:

```text
KodeGPT exposure ready

ChatGPT Server URL:
https://my-kodegpt.ngrok-free.dev/mcp?kodegpt_token=kgc_<secret>

Keep this URL private. The credential is shown only when it is newly issued.
```

### Later exposes

If a credential already exists, KodeGPT must not rotate it automatically and cannot reconstruct the old plaintext token from the verifier.

Example:

```text
KodeGPT exposure ready

Public MCP endpoint:
https://my-kodegpt.ngrok-free.dev/mcp

An existing connector credential is active.
Use the Server URL already configured in ChatGPT, or run `kodegpt auth rotate` to issue a new credential.
```

This preserves the existing non-recoverable secret design.

## 6. HTTP Authentication Modes

### Normal `kodegpt start`

Behavior stays Bearer-only:

```http
Authorization: Bearer kgc_<token>
```

A `kodegpt_token` query parameter does not authenticate a request in normal start mode; without a valid Bearer header the request returns the existing generic `401 Unauthorized`. Query compatibility must not become a global HTTP authentication method.

### `kodegpt expose ngrok`

This invocation enables personal/development query compatibility:

```text
https://<hostname>/mcp?kodegpt_token=kgc_<token>
```

The implementation should adapt the query token into the existing connector verifier path rather than create a second credential database or verifier implementation.

Rules:

- Bearer authentication remains valid in exposure mode.
- A valid `kodegpt_token` query credential is also valid in exposure mode.
- Header and query credentials supplied together are rejected as ambiguous.
- Duplicate `kodegpt_token` parameters are rejected.
- Malformed or incorrect tokens are rejected with generic unauthorized behavior.
- Query compatibility applies only to the MCP path and only when explicitly enabled by the exposure command.

### Secret sanitization

After the outer HTTP auth layer extracts and validates `kodegpt_token`, the token parameter must be removed from the Request URL before the request is passed into the MCP library/handler.

This prevents the MCP server, tool context, downstream diagnostics, and ordinary error paths from receiving the query secret unnecessarily.

No new generalized request logging system is introduced in this work.

## 7. ngrok Invocation

KodeGPT runs ngrok directly as a child process, without shell evaluation.

Conceptual invocation:

```text
executable: ngrok
argv:
  http
  http://127.0.0.1:<port>
  --url
  https://<hostname>
shell: false
```

KodeGPT does not:

- parse or store `~/.config/ngrok/ngrok.yml`;
- read the ngrok authtoken;
- pass ngrok credentials on the command line;
- configure OAuth, Basic Auth, or ngrok Traffic Policy;
- depend on ngrok's local inspector API;
- require CodexPro.

The user's installed/configured ngrok CLI is the only ngrok prerequisite.

## 8. Lifecycle and Failure Semantics

The implementation should avoid a complex state machine. These behavioral rules are sufficient:

### Local KodeGPT startup failure

If `startKodegpt()` fails, ngrok is never started and the command exits non-zero. On a first exposure, no connector credential is created before local startup succeeds.

### ngrok immediate startup failure

If ngrok cannot be spawned or exits during the 1-second startup grace period, KodeGPT closes the MCP listener/runtime and exits non-zero. On a first exposure, the connector credential is still not created, so no one-time plaintext credential is lost before it can be displayed.

### First-run credential creation failure

After ngrok survives the startup grace period, a missing connector credential is created. Until that succeeds, the authenticator has no verifier and rejects all requests. If credential creation fails, KodeGPT terminates ngrok, closes the local MCP stack, and exits non-zero.

### ngrok unexpected exit after startup

If ngrok exits while the exposure command is still running, KodeGPT closes the local MCP stack and exits non-zero. The command must not continue pretending that public exposure is active.

### SIGINT / SIGTERM

On user termination:

```text
terminate ngrok child
        ↓
close KodeGPT MCP listener
        ↓
stop runtime/kernel
        ↓
exit
```

Shutdown should be idempotent and should not deliberately leave the ngrok child running.

A dedicated daemon, service manager, background persistence layer, or restart loop is out of scope.

## 9. Amendment to Task 20 Contract

The old Task 20.6 intent remains correct for normal manual HTTP configuration, but its wording is too broad for the newly approved explicit exposure command.

The amended contract is:

> `kodegpt start` MUST remain loopback-only and MUST NOT spawn tunnel subprocesses. `kodegpt bridge` MUST remain tunnel-independent. An explicit `kodegpt expose <provider>` command MAY supervise an exposure subprocess while the KodeGPT MCP listener itself remains loopback-only.

For v0.1, the only implemented exposure provider is `ngrok`.

The existing `tests/integration/manual-exposure.test.ts` should therefore continue proving that `start.ts` has no tunnel spawning responsibility. It must not be weakened into allowing ngrok inside `start.ts`.

## 10. Task 24 Host Compatibility Target

Task 24's final host observation path becomes:

```text
ChatGPT Developer Mode custom MCP app
        ↓
Server URL containing kodegpt_token
        ↓ HTTPS
stable ngrok hostname
        ↓
ngrok local agent
        ↓
KodeGPT HTTP on 127.0.0.1
        ↓
existing MCP surface
```

Host acceptance should observe, in sequence:

1. MCP discovery succeeds.
2. `system.health` succeeds.
3. a locally trusted test workspace can be opened.
4. `file.read` succeeds.
5. `file.write` succeeds when the ChatGPT workspace permits write tools.
6. `file.edit` succeeds when the ChatGPT workspace permits write tools.
7. Dev Console MCP App behavior is recorded.
8. Pranikah passive before/after guard remains unchanged.

The final evidence must distinguish host limitations from KodeGPT limitations. If the ChatGPT plan/workspace does not expose write tools, that is recorded rather than inferred away.

## 11. Testing Strategy

Use TDD for the new behavior, but keep the test surface proportional to v0.1.

### A. CLI behavior

Verify:

- `expose ngrok` exists in production CLI/help;
- `--hostname` is required and validated;
- normal `start` and `bridge` behavior is unchanged.

### B. Authentication behavior

Verify:

- normal start accepts Bearer auth and does not accept query compatibility;
- exposure mode accepts a valid query credential through the existing verifier;
- invalid, duplicate, or ambiguous credentials fail;
- the forwarded MCP Request URL no longer contains `kodegpt_token`.

### C. Credential lifecycle

Verify:

- first exposure creates a connector credential if absent, but only after local/ngrok startup survives the grace period;
- local/ngrok startup failure does not persist an unrecoverable first-run credential;
- credential creation failure closes both ngrok and KodeGPT;
- an existing credential is reused and not silently rotated;
- raw existing credentials are not reconstructed or printed.

### D. ngrok process lifecycle

With a fake/spawn dependency rather than requiring a live ngrok network session, verify:

- exact executable/argv shape;
- shell execution is disabled;
- KodeGPT startup failure prevents ngrok startup;
- ngrok startup/exit failure closes KodeGPT;
- shutdown closes both sides.

### E. Existing security contracts

Retain verification that:

- KodeGPT listener is still loopback-only;
- `kodegpt start` does not spawn tunnels;
- no MCP trust-admission tool exists;
- workspace policy controls write/process authority;
- full existing integration/security/acceptance/package gates continue to pass.

### F. Actual host test

A real ngrok + ChatGPT test is required for `CHATGPT_HOST_OBSERVED`. Unit/integration tests cannot substitute for this final observation.

## 12. Documentation Changes

Update compatibility and implementation tracker documentation to state:

- personal/development ChatGPT compatibility may use `kodegpt expose ngrok`;
- the public MCP URL contains a secret and must be treated as a credential;
- ngrok is a transport, not a source of filesystem/process authority;
- `kodegpt bridge` remains the private stdio transport;
- `kodegpt start` remains the generic loopback HTTP transport;
- query-token compatibility is not positioned as shared/multi-user production authentication;
- OAuth and OpenAI Secure MCP Tunnel are alternative future/advanced paths, not v0.1 prerequisites.

## 13. Non-Goals for v0.1

The following are intentionally excluded:

- OAuth 2.x server implementation;
- OpenAI Secure MCP Tunnel as a required dependency;
- Cloudflare or other tunnel providers;
- generic `TunnelProvider` registry/framework;
- dynamic/random ngrok hostname discovery;
- ngrok inspector/control API integration;
- KodeGPT management of ngrok authtokens;
- systemd/background daemon installation;
- automatic restart loops;
- multi-user account/auth systems;
- rate-limit/account-lockout subsystem;
- dedicated web onboarding UI;
- a second credential database for query authentication;
- refactoring the core filesystem/process security model.

## 14. Expected User Experience

One-time prerequisite outside KodeGPT:

```text
ngrok installed and authenticated by the user
stable/reserved ngrok hostname available
```

Then:

```bash
kodegpt expose ngrok --hostname my-kodegpt.ngrok-free.dev
```

First run prints a ChatGPT Server URL once. The user configures that URL in a ChatGPT Developer Mode custom MCP app with no separate OAuth flow.

After configuration, normal use is simply:

```bash
kodegpt expose ngrok --hostname my-kodegpt.ngrok-free.dev
```

and ChatGPT can call the KodeGPT MCP tools allowed by KodeGPT workspace trust/policy and by the current ChatGPT host permissions.

## 15. Acceptance Criteria

The design is complete when implementation demonstrates all of the following:

- `kodegpt expose ngrok --hostname <stable-host>` is available from the packaged CLI;
- the KodeGPT MCP listener remains bound to loopback;
- ngrok is spawned only by the explicit exposure command;
- first exposure can create the existing connector credential automatically;
- normal HTTP Bearer auth remains intact;
- query-token compatibility is limited to exposure mode;
- secrets are not propagated into the downstream MCP Request URL;
- lifecycle failures close the exposure stack cleanly;
- existing release/security gates stay green;
- real ChatGPT discovery/read and, where the host permits, write/edit are observed through the ngrok endpoint;
- Pranikah remains unchanged;
- no CodexPro runtime or package dependency is introduced.
