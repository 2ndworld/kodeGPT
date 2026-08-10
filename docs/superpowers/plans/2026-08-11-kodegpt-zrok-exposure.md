# KodeGPT zrok Exposure Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the managed ngrok v0.1 path with a single managed zrok v2 path so `kodegpt expose zrok --name public:kodegpt-dev` resolves a reserved zrok name, starts KodeGPT on loopback, supervises a local zrok share, reuses the existing connector credential model, and reaches real ChatGPT host testing without retaining ngrok as a supported provider.

**Architecture:** Keep the existing production KodeGPT HTTP/auth stack and exposure-only query credential compatibility unchanged. Replace only the orchestration module: resolve the public hostname from `zrok2 list names --json`, start KodeGPT on `127.0.0.1`, spawn `zrok2 share public ... --force-local`, verify readiness from structured `zrok2 list shares --json`, then issue a first-run connector credential. Do not add a generic provider abstraction or manage zrok account credentials.

**Tech Stack:** Node.js 24+, TypeScript 5.9, pnpm 10.15.0, Vitest 3.2.4, Rust stable, existing KodeGPT auth/MCP/CLI packages, Bubblewrap 0.11.2, and externally installed/enabled zrok v2 CLI `zrok2`.

## Global Constraints

- Work only in `/home/sauron/dev/kodegpt/.worktrees/kodegpt-v0.1-execution` on `feat/kodegpt-v0.1-execution-wt` until the real-host gate closes.
- Never modify Pranikah; only passive capture/compare via `scripts/host-compatibility-checklist.mjs` is allowed.
- Never add CodexPro as runtime/package dependency.
- `kodegpt start` remains loopback-only and never spawns zrok.
- `kodegpt bridge` remains stdio/private and never spawns zrok.
- `kodegpt expose zrok` is the only managed public exposure provider in v0.1.
- `kodegpt expose ngrok` must be unsupported after the replacement.
- Do not add a generic `TunnelProvider` abstraction.
- zrok Agent lifecycle, API keys, account tokens, namespace provisioning, and reserved-name creation are outside KodeGPT.
- `zrok2` must already be installed, enabled, and have a persistent reserved name.
- The MCP listener remains on `127.0.0.1`; zrok is reachability only.
- Query credential compatibility continues to reuse the existing `ConnectorCredentialStore`; no second credential store or OAuth flow.
- A missing connector credential is issued only after structured zrok readiness succeeds. Existing credentials are never silently rotated.
- Never log/persist raw `zrok2 list shares --json` output because it may contain zrok-owned credential material.
- The current real reserved target is `public:kodegpt-dev`, whose metadata currently resolves to `kodegpt-dev.shares.zrok.io`; production code must derive this from zrok JSON rather than hard-code it.
- Keep the stabilized root Vitest behavior (`extends: true`, root-test serialization, and canonical `pnpm test --no-file-parallelism`) intact.

## File Map

- Create `apps/cli/src/commands/expose-zrok.ts`: zrok name parsing/resolution, readiness, child lifecycle, credential sequencing, status formatting.
- Create `apps/cli/src/commands/expose-zrok.test.ts`: focused unit/TDD contract for parser, metadata, readiness, secrets, and lifecycle.
- Delete `apps/cli/src/commands/expose-ngrok.ts` and `apps/cli/src/commands/expose-ngrok.test.ts` after zrok unit behavior is green.
- Modify `apps/cli/src/main.ts`: route only provider `zrok`, update help/imports, reject ngrok.
- Create `tests/integration/cli-expose-zrok.test.ts`: executable test with fake `zrok2` supporting `list names`, `share public`, and `list shares`.
- Delete `tests/integration/cli-expose-ngrok.test.ts` after replacement integration is green.
- Modify `tests/integration/manual-exposure.test.ts`: assert zrok ownership only in explicit exposure module and no tunnel ownership in `start`/`bridge`.
- Modify `docs/compatibility/chatgpt.md`, `docs/compatibility/manual-https-exposure.md`, `docs/implementation/v0.1-execution-tracker.md`, `docs/release/v0.1-checklist.md`, and `tests/host/README.md` for the zrok connection path.
- Mark the 2026-08-10 ngrok spec/plan as superseded historical records rather than deleting project history.

---

### Task 1: Replace the exposure command core with zrok v2 reserved-name resolution

**Files:**
- Create: `apps/cli/src/commands/expose-zrok.test.ts`
- Create: `apps/cli/src/commands/expose-zrok.ts`
- Delete after GREEN: `apps/cli/src/commands/expose-ngrok.test.ts`
- Delete after GREEN: `apps/cli/src/commands/expose-ngrok.ts`

**Interfaces:**

```ts
export interface ExposeZrokOptions {
  runtimePath: string;
  name: string;
  stateRoot?: string;
  port?: number;
}

export interface ZrokReservedName {
  namespaceToken: string;
  name: string;
  namespaceName: string;
  reserved: true;
}

export interface SpawnedZrokProcess {
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface ExposureCredentialStore {
  status(): Promise<ConnectorCredentialStatus>;
  rotate(): Promise<IssuedConnectorCredential>;
}

export interface ExposeZrokDependencies {
  createCredentialStore(stateRoot: string): ExposureCredentialStore;
  startKodegpt(options: StartKodegptOptions): Promise<StartedKodegpt>;
  runZrokJson(args: string[]): Promise<string>;
  spawnZrok(
    command: string,
    args: string[],
    options: { shell: false; stdio: "inherit" }
  ): SpawnedZrokProcess;
  delay(milliseconds: number): Promise<void>;
}

export interface ExposeZrokStatus {
  local: KodegptStartStatus;
  publicUrl: string;
  chatgptServerUrl?: string;
  credentialCreated: boolean;
}

export interface ExposedZrokKodegpt {
  status: ExposeZrokStatus;
  termination: Promise<never>;
  close(): Promise<void>;
}

export function parseExposeZrokArguments(args: string[]): ExposeZrokOptions;
export function resolveZrokReservedName(selection: string, rawJson: string): ZrokReservedName;
export function exposeZrok(options: ExposeZrokOptions, dependencies?: ExposeZrokDependencies): Promise<ExposedZrokKodegpt>;
export function runExposeZrokCommand(args: string[], dependencies?: ExposeZrokDependencies): Promise<ExposedZrokKodegpt>;
export function formatExposeZrokStatus(status: ExposeZrokStatus): string;
```

- [ ] **Step 1: Write RED parser and reserved-name tests**

Parser success:

```ts
expect(parseExposeZrokArguments([
  "--runtime", "/runtime",
  "--name", "public:kodegpt-dev",
  "--port", "43121",
  "--state-root", "/state"
])).toEqual({
  runtimePath: "/runtime",
  name: "public:kodegpt-dev",
  port: 43121,
  stateRoot: "/state"
});
```

Reject missing runtime/name, missing or extra `:`, empty components, schemes/paths/query/fragment/userinfo/whitespace, duplicate flags, unknown flags, and ports outside `1..65535`.

Reserved-name success fixture:

```ts
const namesJson = JSON.stringify([{
  name: "kodegpt-dev",
  namespaceName: "shares.example.test",
  namespaceToken: "public",
  reserved: true
}]);

expect(resolveZrokReservedName("public:kodegpt-dev", namesJson)).toEqual({
  namespaceToken: "public",
  name: "kodegpt-dev",
  namespaceName: "shares.example.test",
  reserved: true
});
```

Fail closed for malformed/non-array JSON, no match, duplicate exact matches, `reserved:false`, namespace mismatch, empty/invalid `namespaceName`, or invalid derived DNS hostname.

- [ ] **Step 2: Verify RED**

```bash
pnpm exec vitest run apps/cli/src/commands/expose-zrok.test.ts
```

Expected: FAIL because `expose-zrok.ts` is absent.

- [ ] **Step 3: Implement parser, sanitized `zrok2` JSON runner, and reserved-name resolution**

Use Node `execFile` without a shell:

```ts
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runZrokJson(args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("zrok2", args, {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024
    });
    return result.stdout;
  } catch {
    throw new Error("zrok2 command failed");
  }
}
```

Do not propagate raw child stdout/stderr in errors.

Resolve metadata with:

```ts
const namesRaw = await dependencies.runZrokJson([
  "list", "names", "-n", namespaceToken, "--json"
]);
```

Build the public URL only from validated metadata:

```ts
const hostname = validateDnsHostname(`${reserved.name}.${reserved.namespaceName}`);
const publicUrl = `https://${hostname}/mcp`;
```

- [ ] **Step 4: Write RED lifecycle/readiness tests**

Track exact order:

```text
list-names → credential-status → start → spawn-share → list-shares/readiness → rotate-if-needed
```

Assert exact spawn:

```ts
expect(calls.spawn).toEqual([{
  command: "zrok2",
  args: [
    "share", "public",
    "http://127.0.0.1:43121",
    "--headless",
    "--force-local",
    "--backend-mode", "proxy",
    "-n", "public:kodegpt-dev"
  ],
  options: { shell: false, stdio: "inherit" }
}]);
```

Assert local start:

```ts
expect(calls.start[0]).toEqual({
  runtimePath: "/runtime",
  stateRoot: "/state",
  port: 43121,
  publicUrl: "https://kodegpt-dev.shares.example.test/mcp",
  queryCredentialCompatibility: true,
  allowMissingConnectorCredential: true
});
```

Readiness initially returns `{"shares":[]}` and later one exact matching share with target `http://127.0.0.1:43121`, `shareMode:"public"`, `backendMode:"proxy"`, frontend endpoint `kodegpt-dev.shares.example.test`, plus a test-only redacted credential field. Prove credential rotation occurs only after readiness. Cover wrong target/mode/backend/endpoint, malformed list-shares JSON, repeated command failure until timeout, child exit/error before readiness, local startup failure, spawn failure, rotate failure, unexpected exit after readiness, and idempotent close. Errors/output must never echo the raw zrok JSON.

- [ ] **Step 5: Implement structured readiness and child supervision**

Use:

```ts
const ZROK_READINESS_ATTEMPTS = 120;
const ZROK_READINESS_POLL_MS = 250;
```

Poll exact command:

```ts
[
  "list", "shares",
  "--target", `http://127.0.0.1:${port}`,
  "--share-mode", "public",
  "--backend-mode", "proxy",
  "--json"
]
```

Parse only `target`, `shareMode`, `backendMode`, and `frontendEndpoints`; discard all other fields. Ready means exactly one matching share with the expected frontend hostname. Race polling/delay against the child termination promise.

First-run sequence:

```text
resolve name → status → start KodeGPT → spawn zrok → readiness → rotate if missing → output
```

`close()` sends `SIGTERM` to zrok, closes KodeGPT, and is idempotent.

- [ ] **Step 6: Verify GREEN**

```bash
pnpm exec vitest run apps/cli/src/commands/expose-zrok.test.ts apps/cli/src/commands/start.test.ts tests/integration/mcp-http.test.ts
```

Expected: PASS.

- [ ] **Step 7: Remove ngrok command files and commit**

```bash
git rm apps/cli/src/commands/expose-ngrok.ts apps/cli/src/commands/expose-ngrok.test.ts
git add apps/cli/src/commands/expose-zrok.ts apps/cli/src/commands/expose-zrok.test.ts
git commit -m "feat(cli): replace ngrok exposure core with zrok"
```

---

### Task 2: Wire the production CLI and executable fake-zrok contract

**Files:**
- Modify: `apps/cli/src/main.ts`
- Create: `tests/integration/cli-expose-zrok.test.ts`
- Delete: `tests/integration/cli-expose-ngrok.test.ts`
- Modify: `tests/integration/manual-exposure.test.ts`

**Interfaces:**

```ts
import {
  formatExposeZrokStatus,
  runExposeZrokCommand
} from "./commands/expose-zrok.js";
```

Provider dispatch:

```ts
const [provider, ...rest] = args;
if (provider !== "zrok") {
  throw new Error("expose command requires provider: zrok");
}
```

- [ ] **Step 1: Write executable RED integration**

Create fake executable `zrok2` at the front of test `PATH`. It supports:

```text
list names -n public --json
share public http://127.0.0.1:<port> --headless --force-local --backend-mode proxy -n public:kodegpt-dev
list shares --target http://127.0.0.1:<port> --share-mode public --backend-mode proxy --json
```

Use temp files `KODEGPT_TEST_ZROK_STATE` and `KODEGPT_TEST_ZROK_ARGS`. `list names` returns the fixed `shares.example.test` metadata. `share public` records argv, marks the test-local share ready, and stays alive until SIGTERM. `list shares` returns the exact ready share with a test-only redacted credential field that production output must never leak.

Start:

```text
expose zrok --name public:kodegpt-dev --port <free-port> --state-root <temp-state>
```

Assert first output includes:

```text
KodeGPT exposure ready
Public MCP endpoint: https://kodegpt-dev.shares.example.test/mcp
ChatGPT Server URL:
kodegpt_token=[REDACTED_SECRET]
```

The test should assert the actual generated credential exists without hard-coding it; `[REDACTED_SECRET]` is documentation notation only.

Assert recorded share argv is exact. Stop with SIGTERM. Second run reuses the verifier, includes `existing connector credential`, and does not include a query credential.

Assert help contains `kodegpt expose zrok --name` and excludes `kodegpt expose ngrok`.

- [ ] **Step 2: Verify RED**

```bash
pnpm exec vitest run tests/integration/cli-expose-zrok.test.ts
```

Expected: FAIL because `main.ts` still routes ngrok.

- [ ] **Step 3: Switch `main.ts` to zrok only**

Final help line:

```text
  kodegpt expose zrok --name <namespace:name> [--port <port>] [--state-root <path>]
```

Keep test/development-only `--runtime` behavior unchanged.

- [ ] **Step 4: Update manual exposure invariants**

Read `apps/cli/src/commands/expose-zrok.ts` and assert it owns `node:child_process`, `spawn`, `zrok2`, `127.0.0.1`, and never `0.0.0.0`. Extend normal-start absence checks so `start.ts` has no zrok process ownership.

- [ ] **Step 5: Delete ngrok integration test and verify GREEN**

```bash
git rm tests/integration/cli-expose-ngrok.test.ts
pnpm exec vitest run tests/integration/cli-expose-zrok.test.ts tests/integration/manual-exposure.test.ts
pnpm --filter kodegpt typecheck
node apps/cli/bin/kodegpt.mjs --help
```

Expected: all tests/typecheck PASS; help shows zrok only.

- [ ] **Step 6: Commit Task 2**

```bash
git add apps/cli/src/main.ts tests/integration/cli-expose-zrok.test.ts tests/integration/manual-exposure.test.ts
git add -u tests/integration/cli-expose-ngrok.test.ts
git commit -m "feat(cli): expose KodeGPT through zrok"
```

---

### Task 3: Replace active ngrok docs/contracts with zrok

**Files:**
- Modify: `docs/compatibility/chatgpt.md`
- Modify: `docs/compatibility/manual-https-exposure.md`
- Modify: `docs/implementation/v0.1-execution-tracker.md`
- Modify: `docs/release/v0.1-checklist.md`
- Modify: `tests/host/README.md`
- Modify: `docs/superpowers/specs/2026-08-10-kodegpt-ngrok-exposure-design.md`
- Modify: `docs/superpowers/plans/2026-08-10-kodegpt-ngrok-exposure.md`
- Modify if active wording remains: `docs/superpowers/plans/2026-08-09-kodegpt-v0.1-detailed-execution-plan.md`

**Interfaces:**

```text
connectionPath = zrok-public-https-query-credential
command = kodegpt expose zrok --name public:kodegpt-dev
```

- [ ] **Step 1: Update compatibility docs**

Describe exactly:

```text
kodegpt bridge       -> stdio/private
kodegpt start        -> loopback HTTP/operator-managed exposure only
kodegpt expose zrok  -> managed personal/development public HTTPS path
```

Document reserved-name precondition, structured JSON resolution/readiness, `--force-local`, and that zrok never grants workspace trust or owns KodeGPT credentials.

- [ ] **Step 2: Update tracker/release/host evidence**

Keep Task 24 `IMPLEMENTED / GATE PENDING` until actual ChatGPT observation and fresh Pranikah compare. Record zrok as the active managed path without rewriting historical commit evidence.

- [ ] **Step 3: Mark old ngrok spec/plan superseded**

Add at top:

```text
Status: Superseded on 2026-08-11 by the approved zrok v2 managed exposure design. Retained only as historical implementation context; ngrok is not a supported v0.1 provider.
```

- [ ] **Step 4: Scan stale claims and verify guards**

```bash
rg -n "ngrok|expose ngrok|ngrok-public" apps packages tests docs
rg -n "zrok|expose zrok|zrok-public-https-query-credential" apps tests docs
pnpm exec vitest run tests/integration/manual-exposure.test.ts tests/integration/ci-contract.test.ts tests/host/host-compatibility-checklist.test.ts
pnpm verify:forbidden
```

Expected: no active ngrok support in product code/tests; documentation ngrok hits only in explicitly superseded/history text. All guards PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add docs tests/host/README.md
git commit -m "docs: replace managed ngrok path with zrok"
```

---

### Task 4: Full verification, cold proof, push, and user-level reinstall

**Files:**
- Modify only for fresh evidence if needed: `docs/implementation/v0.1-execution-tracker.md`

- [ ] **Step 1: Run deterministic gates**

Run separately and require exit code 0:

```bash
pnpm build
pnpm typecheck
pnpm test
cargo fmt --all -- --check
cargo test -p kodegpt-sandbox
pnpm test:rust
pnpm test:protocol
pnpm test:integration
pnpm test:security
pnpm test:isolation
pnpm test:acceptance
pnpm verify:forbidden
pnpm verify:package
```

Record fresh counts if they changed.

- [ ] **Step 2: Deliberate cold-run proof**

```bash
rm -rf target
rm -f packages/runtime-linux-x64/bin/kodegpt-runtime
pnpm test
```

Expected: full suite PASS from cold Cargo/runtime state.

Then restore release artifacts:

```bash
cargo build --release -p kodegpt-runtime
node scripts/stage-runtime.mjs
pnpm --filter kodegpt build
```

- [ ] **Step 3: Verify ngrok absence / zrok ownership**

```bash
rg -n "\bngrok\b|expose-ngrok|ExposeNgrok" apps packages tests
```

Expected: zero matches.

```bash
rg -n "\bzrok2\b|expose-zrok|ExposeZrok" apps packages tests
```

Expected: explicit zrok exposure only; `start.ts` and `bridge.ts` do not own zrok.

- [ ] **Step 4: Commit fresh evidence if tracker changed**

```bash
git add docs/implementation/v0.1-execution-tracker.md
git commit -m "docs: record zrok replacement verification"
```

Skip the commit if no tracked evidence changed.

- [ ] **Step 5: Push and require CI GREEN**

```bash
git push origin feat/kodegpt-v0.1-execution-wt
gh run list --branch feat/kodegpt-v0.1-execution-wt --limit 2
RUN_ID=$(gh run list --branch feat/kodegpt-v0.1-execution-wt --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
```

Expected: entire KodeGPT CI workflow succeeds.

- [ ] **Step 6: Reinstall the exact candidate at user level**

```bash
rm -rf /tmp/kodegpt-user-install
mkdir -p /tmp/kodegpt-user-install
cargo build --release -p kodegpt-runtime
node scripts/stage-runtime.mjs
pnpm --filter kodegpt build
pnpm --filter @kodegpt/runtime-linux-x64 pack --pack-destination /tmp/kodegpt-user-install
pnpm --filter kodegpt pack --pack-destination /tmp/kodegpt-user-install
npm install --global --ignore-scripts /tmp/kodegpt-user-install/kodegpt-runtime-linux-x64-0.1.0.tgz /tmp/kodegpt-user-install/kodegpt-0.1.0.tgz
kodegpt doctor --json
kodegpt --help
kodegpt workspace list
```

Expected: installed CLI resolves package runtime, help shows zrok only, and existing trusted `/home/sauron/dev/kodegpt` with ceiling `develop` remains valid.

---

### Task 5: Real zrok go-live and Task 24 host gate

**Files:**
- Local-only evidence under `/tmp`.
- Modify after actual host observation: `docs/implementation/v0.1-execution-tracker.md`

**Interfaces:**

```text
reserved name: public:kodegpt-dev
connection path: zrok-public-https-query-credential
```

- [ ] **Step 1: Confirm real prerequisites**

```bash
zrok2 status
zrok2 list names -n public --json
kodegpt doctor --json
kodegpt workspace list
```

Require `public:kodegpt-dev` to exist and be reserved.

- [ ] **Step 2: Fresh Pranikah BEFORE**

```bash
node scripts/host-compatibility-checklist.mjs capture --pranikah-root /home/sauron/dev/Pranikah-Labs --output /tmp/kodegpt-pranikah-zrok-host-before.json
```

- [ ] **Step 3: Start real zrok exposure**

```bash
kodegpt expose zrok --name public:kodegpt-dev
```

Expected first run prints a sanitized public endpoint plus a credential-bearing ChatGPT Server URL. The credential value must remain local and must not be pasted into Git or chat; represent it only as `[REDACTED_SECRET]` in documentation.

- [ ] **Step 4: Configure ChatGPT and observe host behavior**

Record actual discovery, `system.health`, workspace open, file read, write/edit if exposed by host, process availability under `develop`, MCP Apps rendering/fallback, and mutation confirmations. Claim `WRITE_OBSERVED` only after a real successful write/edit.

- [ ] **Step 5: Fresh Pranikah AFTER and compare**

```bash
node scripts/host-compatibility-checklist.mjs capture --pranikah-root /home/sauron/dev/Pranikah-Labs --output /tmp/kodegpt-pranikah-zrok-host-after.json
node scripts/host-compatibility-checklist.mjs compare --before /tmp/kodegpt-pranikah-zrok-host-before.json --after /tmp/kodegpt-pranikah-zrok-host-after.json
```

Expected: `guard unchanged`.

- [ ] **Step 6: Record Task 24 evidence without secrets**

Update tracker with exact commit/date/workspace/connection path and observed read/write/apps behavior, then:

```bash
pnpm verify:forbidden
git diff --check
git add docs/implementation/v0.1-execution-tracker.md
git commit -m "docs: record ChatGPT zrok host evidence"
git push origin feat/kodegpt-v0.1-execution-wt
```

- [ ] **Step 7: Stop at branch completion gate**

After the exact host-evidence commit has final CI GREEN, invoke `superpowers:finishing-a-development-branch` before fast-forwarding `main`, changing the GitHub default branch, removing `.worktrees/kodegpt-v0.1-execution`, deleting redundant branches, or creating `v0.1`.
