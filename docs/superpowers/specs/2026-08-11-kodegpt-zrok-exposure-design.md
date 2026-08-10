# KodeGPT v0.1 — Managed zrok Exposure Design

Date: 2026-08-11
Status: Approved; implementation in progress on `feat/kodegpt-v0.1-execution-wt`

## 1. Goal

Replace the v0.1 managed ngrok exposure path with a single managed zrok v2 path for personal/development ChatGPT connectivity.

The supported command becomes:

```text
kodegpt expose zrok --name public:kodegpt-dev
```

KodeGPT remains loopback-only. zrok provides public HTTPS reachability only; workspace trust, connector authentication, policy, sandboxing, filesystem/process authority, and audit remain owned by KodeGPT.

## 2. Scope

### In scope

- Replace `kodegpt expose ngrok` with `kodegpt expose zrok`.
- Resolve a zrok v2 reserved name through the installed `zrok2` CLI.
- Start the existing KodeGPT HTTP/MCP stack on `127.0.0.1`.
- Reuse the existing query-credential compatibility mode and verifier-only connector credential store.
- Supervise one foreground local zrok child process.
- Preserve first-run credential issuance semantics: reveal the newly issued connector token only once after the local server and zrok child survive startup.
- Update CLI help, docs, tracker, unit tests, executable integration tests, release checks, and forbidden/source-contract checks that reference ngrok.
- Remove the managed-ngrok implementation and its tests/docs rather than retaining two providers.

### Out of scope

- Generic tunnel/provider abstraction.
- Supporting ngrok and zrok simultaneously in v0.1.
- zrok Agent lifecycle management.
- zrok API-key, account-token, OAuth, namespace, or reserved-name provisioning.
- Automatic creation/deletion of zrok names.
- Private zrok shares.
- KodeGPT-managed zrok configuration files.
- Cloudflare, SSH reverse forwarding, or other tunnel providers.

## 3. Preconditions

The operator must already have:

1. `zrok2` installed and available on `PATH`.
2. A zrok environment enabled with `zrok2 enable`.
3. A persistent reserved name already created in a namespace accessible to the environment.

For the current machine, the target example is:

```text
public:kodegpt-dev
```

Machine-specific account tokens, zrok environment secrets, connector credentials, and host evidence must never be committed to Git.

## 4. CLI contract

### Supported command

```text
kodegpt expose zrok --name <namespace-token>:<reserved-name> [--port <port>] [--state-root <path>]
```

`--runtime` remains development/test-only and is injected internally by the packaged CLI just as it is for `start` and `bridge`.

### Removed command

```text
kodegpt expose ngrok ...
```

The CLI must reject `ngrok` as an unsupported provider after this replacement.

### Name validation

`--name` must contain exactly one namespace/name separator and non-empty components:

```text
<namespace-token>:<reserved-name>
```

The CLI must reject schemes, paths, query strings, fragments, credentials, whitespace, empty components, and duplicate `--name` flags.

No public hostname is accepted directly from the user. The hostname must be resolved from zrok's reserved-name metadata.

## 5. Reserved-name resolution

Before starting KodeGPT or a zrok share, KodeGPT invokes:

```text
zrok2 list names -n <namespace-token> --json
```

The `-n <namespace-token>` argument is the authoritative namespace scope. Within that namespace-limited JSON array, KodeGPT requires exactly one matching record with:

```text
name           == <reserved-name>
reserved       == true
namespaceName  == non-empty hostname
```

KodeGPT does not need to trust or re-export a credential-like namespace field from the returned JSON; the namespace value comes from the already validated CLI selection and the zrok command scope. If zrok is missing, the environment is not enabled, the command exits non-zero, JSON is malformed, no matching name exists, more than one matching name exists, the record is not reserved, or `namespaceName` is invalid, exposure fails before opening the KodeGPT listener.

The public MCP URL is derived from the resolved metadata:

```text
https://<reserved-name>.<namespaceName>/mcp
```

For the current reserved name this resolves to:

```text
https://kodegpt-dev.shares.zrok.io/mcp
```

KodeGPT does not scrape human-readable zrok logs to discover the URL.

## 6. Runtime and zrok process lifecycle

After reserved-name resolution succeeds:

1. Read connector credential status from the selected state root.
2. Start KodeGPT on `127.0.0.1:<port>` with:
   - `publicUrl` set to the resolved HTTPS `/mcp` URL;
   - query-credential compatibility enabled;
   - missing-credential bootstrap allowed only when no connector verifier exists.
3. Spawn zrok with `shell:false` and structured argv:

```text
zrok2 share public \
  http://127.0.0.1:<port> \
  --headless \
  --force-local \
  --backend-mode proxy \
  -n <namespace-token>:<reserved-name>
```

`--force-local` is mandatory. KodeGPT must supervise the zrok process directly rather than allowing zrok Agent mode to own the share lifecycle.

4. Wait for structured zrok readiness instead of relying on a fixed grace period or scraping logs. For up to 30 seconds, poll:

```text
zrok2 list shares \
  --target http://127.0.0.1:<port> \
  --share-mode public \
  --backend-mode proxy \
  --json
```

Readiness is proven only when exactly one returned share matches the exact loopback target, `shareMode == "public"`, `backendMode == "proxy"`, and its `frontendEndpoints` contains the hostname resolved from the reserved-name metadata. The command's raw JSON may contain zrok-owned fields such as `shareToken`; KodeGPT must parse the minimum required fields in memory and must never print, persist, audit, or include the raw response in an error.
5. If the zrok child errors/exits before readiness, the readiness command fails persistently, or the 30-second readiness deadline expires, exposure fails and KodeGPT closes without issuing a new connector credential.
6. If the connector credential was initially missing, issue it only after structured zrok readiness succeeds.
7. Print the credential-bearing ChatGPT Server URL only when a credential was newly issued.
8. Keep both processes alive until shutdown or unexpected zrok termination.

### Failure semantics

- Reserved-name resolution failure: no local listener, no credential mutation, no zrok share.
- KodeGPT startup failure: no zrok child and no credential mutation.
- zrok spawn/startup failure: close KodeGPT and do not create a new credential.
- Credential creation failure after zrok startup: terminate zrok and close KodeGPT.
- Unexpected zrok exit/error after readiness: close KodeGPT and exit non-zero.
- SIGINT/SIGTERM: terminate zrok, close KodeGPT, and exit cleanly.
- Repeated close requests must be idempotent.

## 7. Authentication and secret handling

The existing KodeGPT connector credential model is unchanged.

First successful exposure when no verifier exists:

```text
https://<resolved-host>/mcp?kodegpt_token=[CONNECTOR_TOKEN]
```

The plaintext connector token is returned only at issuance time and is not persisted by KodeGPT. The credential store persists only the verifier.

Later exposure runs reuse the existing verifier and must not reconstruct or print the plaintext token. They print the sanitized public MCP endpoint and instruct the operator to use the already configured ChatGPT Server URL or explicitly rotate the connector credential.

zrok account/environment credentials remain owned entirely by zrok. KodeGPT must not read, print, copy, persist, rotate, or modify them. Structured zrok status/list responses may contain zrok-owned identifiers or share tokens; KodeGPT must select only the non-secret fields required for validation and discard the rest without logging.

The query credential remains accepted only on exact `/mcp` in managed exposure mode. Duplicate query credentials, malformed credentials, and simultaneous Authorization + query credentials remain rejected. The query credential is stripped before canonical MCP dispatch/logging.

## 8. Security invariants retained

- KodeGPT binds only to `127.0.0.1`; never `0.0.0.0`.
- `kodegpt start` never launches zrok.
- `kodegpt bridge` never launches zrok.
- Only explicit `kodegpt expose zrok` enables query-credential compatibility and managed public exposure.
- zrok never grants workspace trust.
- Workspace trust remains local-only.
- Rust remains final OS/security authority.
- Audit-before-effect, retained root-FD authority, `openat2` boundaries, Bubblewrap isolation, execution policy, and artifact controls are unchanged.
- No zrok request URL containing the connector token is supplied as the local upstream target; zrok receives only `http://127.0.0.1:<port>`.

## 9. Output contract

First successful exposure with a newly issued credential:

```text
KodeGPT exposure ready
Public MCP endpoint: https://kodegpt-dev.shares.zrok.io/mcp
ChatGPT Server URL: https://kodegpt-dev.shares.zrok.io/mcp?kodegpt_token=[CONNECTOR_TOKEN]
Keep this URL private. The connector credential is shown only when newly issued.
```

Subsequent exposure with an existing credential:

```text
KodeGPT exposure ready
Public MCP endpoint: https://kodegpt-dev.shares.zrok.io/mcp
An existing connector credential is active.
Use the Server URL already configured in ChatGPT, or run `kodegpt auth rotate` to issue a new credential.
```

No zrok account token, environment identity, connector verifier, or machine-specific state path may appear in normal status output.

## 10. Implementation shape

The implementation remains intentionally small:

```text
apps/cli/src/commands/expose-zrok.ts
```

This module owns:

- parsing/validation of `--name`;
- reserved-name lookup through a small injected command dependency;
- public URL derivation;
- KodeGPT start orchestration;
- zrok child lifecycle;
- first-run credential sequencing;
- status formatting.

`apps/cli/src/main.ts` routes only `expose zrok` to this module.

The existing `expose-ngrok.ts` implementation and ngrok-specific tests/docs are removed or rewritten. No generic provider interface is introduced.

## 11. Testing contract

### Unit tests

Cover the following behavioral groups:

1. `--name` parsing/validation.
2. Reserved-name lookup and URL derivation from JSON metadata.
3. Missing/non-reserved/duplicate/malformed zrok metadata fail closed before KodeGPT startup.
4. Exact `zrok2 share public` argv includes `--headless`, `--force-local`, `--backend-mode proxy`, loopback upstream, and selected reserved name; spawn uses `shell:false`.
5. Structured readiness polling accepts only the exact active share target/mode/backend/frontend endpoint, times out fail-closed, and never exposes raw zrok JSON or `shareToken` values in errors/logs.
6. First-run credential issuance occurs only after structured zrok readiness succeeds; restart reuses the existing verifier without revealing a token.
7. zrok spawn/exit/error/readiness/credential-creation failures close all started resources correctly.

### Executable integration

Use a fake `zrok2` executable on `PATH`; do not call the real zrok service in CI.

The fake must support the three production interactions:

```text
zrok2 list names -n <namespace> --json
zrok2 share public ...
zrok2 list shares --target <loopback-target> --share-mode public --backend-mode proxy --json
```

The fake share process records only test-local readiness state; the fake `list shares` response may include a sentinel `shareToken` specifically to prove production error/status formatting never leaks raw zrok JSON.

The packaged CLI integration proves:

- `kodegpt expose zrok --name ...` works from an empty state root;
- the first invocation emits a connector-bearing URL;
- a second invocation reuses the verifier and does not reveal a new token;
- the exact public MCP URL is derived from fake reserved-name metadata;
- child lifecycle cleanup works;
- `kodegpt expose ngrok` is rejected.

### Regression gates

Run the complete deterministic suite, including cold-run CI behavior already stabilized for Cargo-heavy Vitest tests. Existing `start`, `bridge`, workspace trust, MCP, security, isolation, packaging, and release gates must remain green.

## 12. Documentation and tracker changes

Update:

- CLI help/output examples.
- `docs/compatibility/chatgpt.md`.
- `docs/compatibility/manual-https-exposure.md` or rename its managed-exposure section as appropriate.
- `docs/implementation/v0.1-execution-tracker.md`.
- release checklist/host-test instructions where managed ngrok is mentioned.
- source-contract/forbidden tests that assert `start`/`bridge` remain tunnel-independent.

Remove or replace stale claims that ngrok is the v0.1 managed exposure provider.

The real-host Task 24 claim remains pending until the exact zrok path is observed from ChatGPT and enclosed by fresh Pranikah BEFORE/AFTER guard snapshots.

## 13. Go-live sequence after implementation

1. Build and reinstall the local `kodegpt` package from the exact committed candidate.
2. Preserve the already trusted real workspace unless identity validation reports a legitimate change.
3. Capture a fresh Pranikah BEFORE snapshot.
4. Run:

```text
kodegpt expose zrok --name public:kodegpt-dev
```

5. Configure the emitted Server URL in ChatGPT without pasting the connector token into repository files or chat messages.
6. Observe from the real ChatGPT host: discovery, health, workspace open, read, write/edit, process availability, and MCP Apps rendering/fallback.
7. Capture Pranikah AFTER and require unchanged comparison.
8. Record Task 24 host evidence for the exact commit and connection path `zrok-public-https-query-credential`.
9. Only then consolidate the development branch to canonical `main`, clean redundant worktrees/branches, run final CI, and create the v0.1 tag if every release gate remains satisfied.

## 14. Acceptance criteria

This replacement is complete when all of the following are true:

- `kodegpt expose zrok --name public:kodegpt-dev` is the only managed exposure provider in v0.1.
- `kodegpt expose ngrok` is unsupported and ngrok-specific managed-exposure code is removed.
- Public URL resolution comes from zrok reserved-name JSON metadata, not log scraping or hard-coded `shares.zrok.io` assumptions.
- KodeGPT remains loopback-only and supervises zrok locally with `--force-local`.
- Connector credential semantics and security invariants remain unchanged.
- Unit/integration/full deterministic gates pass, including a cold-run CI proof.
- Local installed CLI is rebuilt/reinstalled from the final candidate.
- Real ChatGPT host evidence through zrok is captured before Task 24, branch cleanup, and v0.1 release/tag are closed.
