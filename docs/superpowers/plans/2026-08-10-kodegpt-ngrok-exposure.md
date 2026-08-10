# KodeGPT ngrok Exposure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit personal/development `kodegpt expose ngrok` path while preserving loopback binding, the existing connector verifier, and existing `start`/`bridge` behavior.

**Architecture:** Reuse the production HTTP stack. Add one opt-in query-credential compatibility switch and one focused CLI ngrok orchestration module. Do not add OAuth, a generic tunnel framework, ngrok inspector integration, or ngrok account credential management.

**Tech Stack:** Node.js 24+, TypeScript 5.9, pnpm 10.15, Vitest 3.2, existing KodeGPT auth/MCP/CLI packages, and an externally installed/configured ngrok executable.

## Global Constraints

- Work only in the existing KodeGPT implementation worktree and feature branch.
- Never modify Pranikah; only passive guard capture/compare is allowed.
- Never add CodexPro as a runtime or package dependency.
- `kodegpt start` stays loopback-only and never spawns a tunnel.
- `kodegpt bridge` stays stdio/private and never spawns a tunnel.
- Only `kodegpt expose ngrok` may supervise ngrok in v0.1.
- Stable/reserved hostname is mandatory; no random URL discovery.
- KodeGPT does not manage ngrok account credentials.
- No OAuth implementation in this scope.
- Query compatibility reuses the existing connector credential/verifier and must not create a second credential store.
- Existing connector credentials are reused; only a missing credential is created automatically.
- The MCP listener remains on `127.0.0.1`; ngrok is transport only.
- Current CodexPro surface has no dedicated git commit/push action. Do not misuse the verification shell to bypass that boundary.

## Execution Status — 2026-08-10

- Task 1 implementation + RED/GREEN verification: DONE; git durability checkpoint pending.
- Task 2 implementation + RED/GREEN verification: DONE; git durability checkpoint pending.
- Task 3 production CLI + executable fake-ngrok proof: DONE; git durability checkpoint pending.
- Task 4 documentation/Task 20/24 amendment + docs-sensitive verification: DONE; git durability checkpoint pending.
- Task 5 deterministic verification/review: DONE with 172/172 Vitest PASS and complete release/security/package/Rust gates PASS.
- Task 5 real-host steps remain PENDING: fresh Pranikah before snapshot, isolated host workspace, actual ChatGPT observation, after snapshot/compare, and Task 24 closure.

## File Map

- `packages/mcp-server/src/http.ts`: query credential resolution and URL sanitization.
- `apps/cli/src/commands/start.ts`: programmatic-only `queryCredentialCompatibility` plumbing.
- `tests/integration/mcp-http.test.ts`: HTTP behavior tests.
- `apps/cli/src/commands/start.test.ts`: start-mode regression.
- `apps/cli/src/commands/expose-ngrok.ts`: focused ngrok command implementation.
- `apps/cli/src/commands/expose-ngrok.test.ts`: parser, credential, and lifecycle unit tests.
- `apps/cli/src/main.ts`: production CLI wiring.
- `tests/integration/cli-expose-ngrok.test.ts`: executable-level test with a fake ngrok binary.
- `tests/integration/manual-exposure.test.ts`: preserve tunnel ownership outside `start.ts`.
- Compatibility docs, original detailed execution plan, and tracker: contract amendment and evidence.

---

### Task 1: Exposure-only query credential compatibility

**Files:**
- Modify: `packages/mcp-server/src/http.ts`
- Modify: `apps/cli/src/commands/start.ts`
- Modify: `tests/integration/mcp-http.test.ts`
- Modify: `apps/cli/src/commands/start.test.ts`

**Interfaces:**
- Consumes the existing HTTP credential authenticator.
- Produces optional `queryCredentialCompatibility?: boolean` on HTTP handler/node handler and `StartKodegptOptions`.

- [ ] **Step 1: Write failing HTTP tests**

Extend the HTTP test helper so a request can supply a custom URL. Cover normal mode with query-only compatibility data, exposure mode with one valid query value, duplicate query values, mixed header/query credentials, an incorrect query value, and sanitization of the forwarded URL.

Use only fixed non-secret fixture strings.

- [ ] **Step 2: Verify RED**

```bash
pnpm exec vitest run tests/integration/mcp-http.test.ts
```

Expected: FAIL because the compatibility switch and resolver do not exist.

- [ ] **Step 3: Add a pure resolver in `packages/mcp-server/src/http.ts`**

Add the exact API:

```ts
export interface ResolvedHttpCredential {
  authorization: string | undefined;
  forwardedUrl: string;
}

export function resolveHttpCredential(
  request: Request,
  queryCredentialCompatibility: boolean
): ResolvedHttpCredential | null;
```

The resolver must keep normal mode header-only, permit exactly one query credential only when compatibility is enabled, reject duplicate or mixed credential sources, and remove the compatibility field from the URL forwarded into MCP dispatch. Adapt the query value into the same input format already consumed by the existing authenticator; do not implement a second verifier.

- [ ] **Step 4: Thread the switch through `startKodegpt`**

Add:

```ts
queryCredentialCompatibility?: boolean;
```

on `StartKodegptOptions` and `StartDependencies.createMcp`, and pass `options.queryCredentialCompatibility ?? false` into `dependencies.createMcp(...)`. Do not add a corresponding `kodegpt start` CLI flag.

- [ ] **Step 5: Add start-mode regression**

Capture `createMcp` options in `start.test.ts`; prove normal command parsing leaves compatibility disabled, a direct programmatic start can enable it, and both still bind `127.0.0.1`.

- [ ] **Step 6: Verify GREEN**

```bash
pnpm exec vitest run tests/integration/mcp-http.test.ts apps/cli/src/commands/start.test.ts
```

Expected: PASS.

- [ ] **Step 7: Durability checkpoint**

If an authorized commit action exists, use message `feat(auth): add exposure query credential compatibility`. Otherwise keep the reviewed working-tree checkpoint and do not bypass the git boundary.

---

### Task 2: Focused `expose ngrok` command module

**Files:**
- Create: `apps/cli/src/commands/expose-ngrok.ts`
- Create: `apps/cli/src/commands/expose-ngrok.test.ts`

**Interfaces:**

```ts
export interface ExposeNgrokOptions {
  runtimePath: string;
  hostname: string;
  stateRoot?: string;
  port?: number;
}

export interface ExposureCredentialStore {
  status(): Promise<ConnectorCredentialStatus>;
  rotate(): Promise<IssuedConnectorCredential>;
}

export interface ExposeNgrokStatus {
  local: KodegptStartStatus;
  publicUrl: string;
  chatgptServerUrl?: string;
  credentialCreated: boolean;
}

export interface ExposedNgrokKodegpt {
  status: ExposeNgrokStatus;
  termination: Promise<never>;
  close(): Promise<void>;
}
```

Also export `parseExposeNgrokArguments`, `exposeNgrok`, `runExposeNgrokCommand`, and `formatExposeNgrokStatus`.

- [ ] **Step 1: Write parser RED tests**

Accept `--runtime`, mandatory `--hostname`, optional `--port`, and optional `--state-root`; default port is `43121`. Reject missing required values, unknown/duplicate flags, port outside `1..65535`, schemes, paths, userinfo, query/fragment characters, empty DNS labels, labels starting/ending with `-`, labels over 63 characters, and total hostname over 253 characters. Require at least one dot and normalize accepted hostname to lowercase.

- [ ] **Step 2: Write credential lifecycle RED tests**

Inject a fake store exposing `status()` and `rotate()`. Prove a missing connector credential is created exactly once and makes first-run onboarding output available; an existing credential is never silently rotated and no recoverable plaintext value is fabricated.

- [ ] **Step 3: Write ngrok lifecycle RED tests**

Use this narrow dependency surface:

```ts
export interface SpawnedNgrokProcess {
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface ExposeNgrokDependencies {
  createCredentialStore(stateRoot: string): ExposureCredentialStore;
  startKodegpt(options: StartKodegptOptions): Promise<StartedKodegpt>;
  spawnNgrok(
    command: string,
    args: string[],
    options: { shell: false; stdio: "inherit" }
  ): SpawnedNgrokProcess;
  delay(milliseconds: number): Promise<void>;
}
```

Assert exact process invocation:

```text
command: ngrok
argv: http, http://127.0.0.1:43121, --url, https://my-kodegpt.ngrok-free.dev
shell: false
stdio: inherit
```

Assert the local start receives `publicUrl: "https://my-kodegpt.ngrok-free.dev/mcp"` and `queryCredentialCompatibility: true`.

Cover startup failure before ngrok, ngrok error/exit during the 1-second grace window, no persisted first-run credential on either startup failure, credential-creation failure after readiness, unexpected exit after readiness, intentional SIGTERM on close, KodeGPT close on every failure path, and idempotent repeated close.

- [ ] **Step 4: Verify RED**

```bash
pnpm exec vitest run apps/cli/src/commands/expose-ngrok.test.ts
```

Expected: FAIL because the module is absent.

- [ ] **Step 5: Implement minimal orchestration**

Use Node `child_process.spawn`, `homedir`, `join`, existing `ConnectorCredentialStore`, `DEFAULT_MCP_PORT`, and `startKodegpt`.

```ts
const DEFAULT_STATE_ROOT = join(homedir(), ".kodegpt");
const NGROK_STARTUP_GRACE_MS = 1_000;
```

Implementation order is fixed:

```text
parse/validate arguments
read connector credential status
start existing loopback HTTP stack with exact public URL and query compatibility enabled; only exposure bootstrap may temporarily allow a missing verifier
spawn ngrok with shell=false
race child termination against the 1-second startup delay
create credential only when missing, after ngrok survives startup grace
return status, termination promise, and idempotent close
```

The ngrok argv is constructed as separate arguments; never build a shell command string. On intentional close mark `closing=true`, signal the ngrok child, then close the KodeGPT stack. Do not poll ngrok inspector, parse ngrok config, add restart loops, or add provider abstractions.

- [ ] **Step 6: Implement safe output formatting**

First run prints `KodeGPT exposure ready`, the public MCP endpoint, and the ChatGPT Server URL containing only the newly issued connector credential. Later runs print the public endpoint and instructions to reuse the already-configured Server URL or explicitly rotate the connector credential. Never print verifier data or ngrok account credential values.

- [ ] **Step 7: Verify GREEN**

```bash
pnpm exec vitest run apps/cli/src/commands/expose-ngrok.test.ts
```

Expected: PASS.

- [ ] **Step 8: Durability checkpoint**

If authorized commit exists, use message `feat(cli): add managed ngrok exposure`. Otherwise preserve the reviewed working-tree checkpoint.

---

### Task 3: Production CLI wiring and executable proof

**Files:**
- Modify: `apps/cli/src/main.ts`
- Create: `tests/integration/cli-expose-ngrok.test.ts`
- Modify: `tests/integration/manual-exposure.test.ts`

**Interfaces:**
- Consumes Task 2 exports and existing `resolveRuntimePath()`.
- Produces `kodegpt expose ngrok --hostname <stable-hostname> [--port <port>] [--state-root <path>]`.

- [ ] **Step 1: Write executable-level RED test**

Follow the staging pattern in `tests/integration/cli-bridge.test.ts`. Build/stage runtime and CLI; create a temporary fake `ngrok` executable placed first in the spawned process `PATH`; make it record argv to a temporary file, handle SIGTERM, and remain alive. Use a free port and temp state root.

Assert first run prints exposure-ready text, the public endpoint, and a first-run ChatGPT Server URL. Assert the fake ngrok argv is exactly the expected `http`, loopback upstream, `--url`, and stable HTTPS hostname sequence. Send SIGTERM and require clean exit. Run a second time with the same state root and assert the output reports an existing connector credential rather than creating another.

The automated test must never contact the real ngrok network.

- [ ] **Step 2: Verify RED**

```bash
pnpm exec vitest run tests/integration/cli-expose-ngrok.test.ts
```

Expected: FAIL because production CLI does not know `expose`.

- [ ] **Step 3: Wire `expose` in `apps/cli/src/main.ts`**

Import `runExposeNgrokCommand` and `formatExposeNgrokStatus`, add `case "expose"`, require provider `ngrok`, resolve runtime exactly like `start` and `bridge`, execute the exposure command, print its formatted status, and race signal shutdown against `exposed.termination.finally(() => exposed.close())`.

Add help text:

```text
kodegpt expose ngrok --hostname <stable-hostname> [--port <port>] [--state-root <path>]
```

Do not move ngrok spawning into `start()` or `bridge()`.

- [ ] **Step 4: Amend the manual exposure invariant test without weakening it**

Keep all existing source assertions proving `apps/cli/src/commands/start.ts` has no child-process/tunnel responsibility. Add a separate source check proving `expose-ngrok.ts` owns ngrok spawning, uses `127.0.0.1`, and contains no `0.0.0.0` binding.

- [ ] **Step 5: Verify GREEN**

```bash
pnpm exec vitest run tests/integration/cli-expose-ngrok.test.ts tests/integration/manual-exposure.test.ts apps/cli/src/commands/expose-ngrok.test.ts
```

Expected: PASS.

- [ ] **Step 6: Re-run bridge regression**

```bash
pnpm exec vitest run tests/integration/cli-bridge.test.ts
```

Expected: PASS.

- [ ] **Step 7: Durability checkpoint**

If authorized commit exists, use message `feat(cli): expose KodeGPT through stable ngrok`. Otherwise preserve the reviewed working tree.

---

### Task 4: Documentation and Task 20/24 amendment

**Files:**
- Modify: `docs/compatibility/chatgpt.md`
- Modify: `docs/compatibility/manual-https-exposure.md`
- Modify: `docs/superpowers/plans/2026-08-09-kodegpt-v0.1-detailed-execution-plan.md`
- Modify: `docs/implementation/v0.1-execution-tracker.md`
- Keep: `docs/superpowers/specs/2026-08-10-kodegpt-ngrok-exposure-design.md`

- [ ] **Step 1: Re-check official OpenAI product documentation**

Use official OpenAI sources only for current Developer Mode/full-MCP product-state claims. The repository must not say Secure MCP Tunnel is mandatory; it remains an alternative private path.

- [ ] **Step 2: Update ChatGPT compatibility docs**

Document the three paths:

```text
bridge       -> stdio/private; no ngrok
start        -> loopback HTTP; operator-managed exposure only
expose ngrok -> explicit personal/development managed ngrok exposure
```

State that the ChatGPT Server URL used by personal query compatibility is a credential and must be kept private. Preserve the rule that host-observed and write-observed claims require real ChatGPT evidence.

- [ ] **Step 3: Update manual HTTPS docs**

Keep `start --public-url` semantics intact. Add `kodegpt expose ngrok --hostname <stable-hostname>` as the managed personal/development path and state explicitly that `start` itself never starts a tunnel.

- [ ] **Step 4: Amend Task 20.6/20.7**

Task 20.6 must state that normal `kodegpt start` remains loopback/tunnel-independent while explicit `kodegpt expose ngrok` may supervise ngrok and apply exact public Host/Origin trust. Task 20.7 must document generic manual HTTPS and explicit managed ngrok exposure separately.

Do not rewrite unrelated completed tasks.

- [ ] **Step 5: Amend Task 24.1 and tracker**

Permit an explicitly recorded ngrok public-HTTPS connection path while retaining stdio/Secure MCP Tunnel as an alternative. Keep Task 24 `IMPLEMENTED / GATE PENDING` until actual ChatGPT observation. Update Task 20 evidence only after amended tests are green.

- [ ] **Step 6: Verify documentation-sensitive gates**

```bash
pnpm exec vitest run tests/host/host-compatibility-checklist.test.ts tests/integration/manual-exposure.test.ts
pnpm verify:forbidden
```

Expected: PASS.

- [ ] **Step 7: Durability checkpoint**

If authorized commit exists, commit documentation/spec/plan with message `docs: define personal ngrok exposure contract`. Otherwise leave the reviewed documentation visible for later authorized durability handling.

---

### Task 5: Full verification and real-host handoff

**Files:**
- Verify all Task 1–4 changes.
- Keep machine-specific hostnames, connector credentials, host evidence files, and Pranikah fingerprints outside Git.

- [ ] **Step 1: Focused verification**

```bash
pnpm --filter @kodegpt/mcp-server typecheck
pnpm --filter kodegpt typecheck
pnpm exec vitest run tests/integration/mcp-http.test.ts apps/cli/src/commands/start.test.ts apps/cli/src/commands/expose-ngrok.test.ts tests/integration/cli-expose-ngrok.test.ts tests/integration/manual-exposure.test.ts tests/integration/cli-bridge.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Full release regression**

Run each command separately:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:protocol
pnpm test:integration
pnpm test:security
pnpm test:isolation
pnpm test:acceptance
pnpm verify:forbidden
pnpm verify:package
cargo fmt --all -- --check
cargo test --workspace
```

Expected: all PASS with fresh output.

- [ ] **Step 3: Review final diff**

Explicitly confirm:

```text
no 0.0.0.0 listener
no ngrok spawn in start.ts
no ngrok spawn in bridge.ts
no OAuth subsystem
no second connector credential store
no ngrok account credential reads
no CodexPro dependency
no Pranikah modification
no MCP trust-admission tool
no normal-start CLI flag enabling query compatibility
```

- [ ] **Step 4: Fresh passive Pranikah BEFORE snapshot only when real host testing is ready**

```bash
node scripts/host-compatibility-checklist.mjs capture --pranikah-root <PRANIKAH_ROOT> --output /tmp/kodegpt-pranikah-ngrok-host-before.json
```

- [ ] **Step 5: Prepare isolated host-test state/workspace**

Use `/tmp/kodegpt-host-state` and `/tmp/kodegpt-host-workspace`, trust the workspace with ceiling `develop`, then run exposure with a user-owned reserved stable hostname. Do not store that hostname or the personal connector credential in the repository. If no reserved hostname exists, report that external prerequisite instead of weakening the contract or using a random URL.

- [ ] **Step 6: Real ChatGPT observation**

Configure the Developer Mode custom MCP app with the first-run Server URL and observe MCP discovery, `system.health`, isolated `workspace.open`, `file.read`, and—only if the host exposes them—`file.write`/`file.edit`, plus Dev Console rendering/fallback. Local tests never substitute for this evidence.

- [ ] **Step 7: Passive Pranikah AFTER snapshot and compare**

```bash
node scripts/host-compatibility-checklist.mjs capture --pranikah-root <PRANIKAH_ROOT> --output /tmp/kodegpt-pranikah-ngrok-host-after.json
node scripts/host-compatibility-checklist.mjs compare --before /tmp/kodegpt-pranikah-ngrok-host-before.json --after /tmp/kodegpt-pranikah-ngrok-host-after.json
```

Expected: `guard unchanged`.

- [ ] **Step 8: Close Task 24 only from observed evidence**

Record the actual connection path, discovery/read/write/App behavior, confirmation behavior, exact tested commit, and host limitations. Only then may host-observed/write-observed claims be used. If final commit/push/tag requires a git-capable executor, hand off the already-reviewed working tree and verification evidence without redesigning the feature.
