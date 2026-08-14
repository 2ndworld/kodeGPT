# KodeGPT Stable Local Service & Managed Exposure Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Linux user-systemd lifecycle for an immutable installed KodeGPT release so managed zrok exposure survives shell closure and never depends on a repository feature worktree.

**Architecture:** `systemd --user` owns one foreground installed KodeGPT CLI process; the CLI's existing managed exposure path continues to own the loopback MCP server, Rust runtime, and zrok child. `service install` snapshots the executing CLI + runtime package + YAML dependency into an immutable user-data release, stages that release in local metadata, and generates a secret-free unit. `service start/restart` activates the staged release with a sanitized runtime-ready file and bounded rollback to the previous active release on startup failure.

**Tech Stack:** TypeScript 5.9, Node.js >=24, Vitest 3.2, existing KodeGPT CLI/auth/core packages, Linux `systemd --user`, existing `zrok2` managed exposure, Rust runtime unchanged except for explicit failure propagation only if the RED crash test proves it necessary.

## Global Constraints

- Keep KodeGPT state root default exactly `~/.kodegpt`.
- Keep MCP protocol `2026-07-28` and semantic surface `0.3` unchanged.
- Keep managed exposure zrok-only; do not introduce a tunnel/provider abstraction.
- Preserve loopback target plus zrok `--force-local` and `backend-mode proxy` semantics.
- Preserve connector credential/verifier state across ordinary restart and upgrade; never print it from service install/start/stop/restart/status.
- KodeGPT does not own, copy, rotate, or print zrok account credentials.
- Service lifecycle is local CLI only and must not appear in MCP tool definitions.
- Do not add `skill.run`, `provider.list`, `provider.tools`, `provider.invoke`, provider-agent execution, generic shell execution, desktop/computer-use, MCP trust/source/pin mutation, or new workspace/process authority.
- Rust remains final OS/security authority; audit-before-effect semantics stay unchanged.
- Use direct argv with `shell: false` for product process launches.
- Do not move/delete/recreate/force-update `v0.1`.
- Do not reset, rebase, force-push, or discard user changes.
- Real systemd/zrok operations are acceptance-only; deterministic tests use injected/fake process-manager behavior.
- TDD every behavior change: RED -> GREEN -> refactor -> focused verification.

## File structure locked by this plan

- `apps/cli/src/commands/service.ts` — parse/operator orchestration for install/start/stop/restart/status/uninstall plus one hidden systemd `run` entrypoint; no low-level filesystem/systemd implementation.
- `apps/cli/src/service/metadata.ts` — schema-1 service metadata, atomic read/write/delete, active/staged/rollback state transitions.
- `apps/cli/src/service/release.ts` — immutable release snapshot, digests, package/runtime identity, release verification and cleanup.
- `apps/cli/src/service/systemd.ts` — secret-free unit rendering, direct `systemctl --user` execution, normalized manager status, optional linger observation, executable resolution.
- `apps/cli/src/service/runtime-status.ts` — sanitized service-run readiness file, stale-state validation/removal, bounded readiness polling.
- `apps/cli/src/version.ts` — one CLI package version constant with a test that keeps it synchronized with `apps/cli/package.json`.
- `apps/cli/src/main.ts` — dispatch/help only; no service-manager logic.
- `packages/core/src/kernel-client.ts` — only if Task 6 RED proves unexpected Rust exit does not propagate to the foreground CLI; expose a bounded unexpected-runtime failure signal without changing Rust authority.
- `tests/integration/cli-service.test.ts` — end-to-end CLI/service contract with fake manager/zrok and isolated HOME/state.
- `scripts/package-smoke.mjs` — clean-prefix service-release snapshot smoke using fake `systemctl`/`loginctl`/`zrok2` binaries in the temporary PATH; never touches the real user unit.
- docs listed in Task 11 — final current-state/verification/runbook reconciliation.

---

### Task 1: CLI service contract and parser

**Files:**
- Create: `apps/cli/src/commands/service.ts`
- Create: `apps/cli/src/commands/service.test.ts`
- Create: `apps/cli/src/version.ts`
- Create: `apps/cli/src/version.test.ts`
- Modify: `apps/cli/src/main.ts`

**Interfaces:**
- Produces `ServiceCommand = "install" | "start" | "stop" | "restart" | "status" | "uninstall" | "run"`.
- Produces `ServiceInstallOptions { stateRoot: string; name: string; port: number }`.
- Produces `ServiceSimpleOptions { stateRoot: string }` and `ServiceStatusOptions extends ServiceSimpleOptions { json: boolean }`.
- Produces `parseServiceArguments(args, homeDir)` used by `runServiceCommand`.
- Produces `KODEGPT_PACKAGE_VERSION = "0.1.0"`; test must compare it to `apps/cli/package.json`.

- [ ] **Step 1: Write failing parser/help/version tests**

Add tests that prove:

```ts
expect(parseServiceArguments(["install", "--name", "public:kodegpt-dev"], "/home/test")).toEqual({
  command: "install",
  stateRoot: "/home/test/.kodegpt",
  name: "public:kodegpt-dev",
  port: 43121
});
expect(parseServiceArguments(["status", "--json"], "/home/test")).toEqual({
  command: "status",
  stateRoot: "/home/test/.kodegpt",
  json: true
});
expect(() => parseServiceArguments(["install"], "/home/test")).toThrow(/--name/);
expect(() => parseServiceArguments(["status", "--name", "x:y"], "/home/test")).toThrow();
```

The version test reads `apps/cli/package.json` and asserts `KODEGPT_PACKAGE_VERSION === manifest.version`.

- [ ] **Step 2: Run RED**

Run: `pnpm --filter kodegpt test -- src/commands/service.test.ts src/version.test.ts`

Expected: FAIL because service parser/version module/dispatch do not exist.

- [ ] **Step 3: Implement minimal parser/version/dispatch**

Implement strict named-option parsing. Reuse the existing default port value and the zrok reserved-name parser through an exported validation helper rather than duplicate a looser regex. Add `case "service"` to `main.ts` and service help rows, but keep hidden `service run` out of normal help.

- [ ] **Step 4: Run GREEN and existing CLI parser tests**

Run: `pnpm --filter kodegpt test -- src/commands/service.test.ts src/version.test.ts src/packaged-cli.test.ts`

Expected: PASS.

- [ ] **Step 5: Review and commit**

Commit message: `feat(cli): define local service lifecycle contract`

---

### Task 2: Installed release identity and service metadata

**Files:**
- Create: `apps/cli/src/service/release.ts`
- Create: `apps/cli/src/service/release.test.ts`
- Create: `apps/cli/src/service/metadata.ts`
- Create: `apps/cli/src/service/metadata.test.ts`

**Interfaces:**

```ts
export interface ServiceReleaseRecord {
  releaseId: string;
  packageVersion: string;
  runtimePackage: "@kodegpt/runtime-linux-x64";
  cliSha256: string;
  runtimeSha256: string;
  releaseRoot: string;
  cliPath: string;
  runtimePath: string;
  nodePath: string;
  zrokPath: string;
  reservedName: string;
  port: number;
}

export interface ServiceMetadataV1 {
  schemaVersion: 1;
  unitName: "kodegpt.service";
  activeReleaseId?: string;
  stagedReleaseId?: string;
  rollbackReleaseId?: string;
  releases: Record<string, ServiceReleaseRecord>;
}
```

`materializeServiceRelease(input)` copies the exact CLI bundle, runtime package root, and YAML package root to `<serviceDataRoot>/releases/<releaseId>` and verifies digests before returning a record. `ServiceMetadataStore` uses atomic temp-file + rename with mode `0600`.

- [ ] **Step 1: Write RED tests for deterministic release ID and immutable verification**

Use temp files with fixed bytes. Assert same CLI/runtime bytes produce the same release ID; changing either changes it. Materialize once, mutate the installed runtime, then assert re-materialization/verification fails instead of overwriting the directory.

- [ ] **Step 2: Write RED tests for metadata transitions**

Cover no-file -> empty, atomic write/read, unknown schema rejection, `stageRelease`, `promoteStagedRelease`, rollback retention, missing referenced release rejection, and delete without touching sibling state-root files.

- [ ] **Step 3: Run RED**

Run: `pnpm --filter kodegpt test -- src/service/release.test.ts src/service/metadata.test.ts`

Expected: FAIL because modules do not exist.

- [ ] **Step 4: Implement minimal snapshot + metadata store**

Use `createHash("sha256")`, `fs.cp`, `chmod`, `mkdir`, `readFile`, `writeFile`, `rename`, and `rm`; no shell or Git subprocess. Snapshot layout must be:

```text
<releaseRoot>/bin/kodegpt.mjs
<releaseRoot>/node_modules/@kodegpt/runtime-linux-x64/package.json
<releaseRoot>/node_modules/@kodegpt/runtime-linux-x64/bin/kodegpt-runtime
<releaseRoot>/node_modules/yaml/...
```

- [ ] **Step 5: Run GREEN**

Run: `pnpm --filter kodegpt test -- src/service/release.test.ts src/service/metadata.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

Commit message: `feat(cli): add immutable service release metadata`

---

### Task 3: Install and uninstall semantics with systemd user unit

**Files:**
- Create: `apps/cli/src/service/systemd.ts`
- Create: `apps/cli/src/service/systemd.test.ts`
- Modify: `apps/cli/src/commands/service.ts`
- Modify: `apps/cli/src/commands/service.test.ts`

**Interfaces:**

```ts
export interface UserServiceState {
  loadState: string;
  activeState: string;
  subState: string;
  unitFileState: string;
  mainPid?: number;
  result?: string;
}

export interface SystemdUserManager {
  daemonReload(): Promise<void>;
  enable(): Promise<void>;
  disable(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  resetFailed(): Promise<void>;
  show(): Promise<UserServiceState>;
  linger(): Promise<"enabled" | "disabled" | "unknown">;
}
```

`renderKodegptUserUnit(record, metadataPath)` returns a deterministic unit with `Type=simple`, direct Node + installed CLI path, hidden `service run`, `Restart=on-failure`, `RestartSec=5s`, `StartLimitIntervalSec=60`, `StartLimitBurst=5`, SIGTERM semantics, production NODE_ENV, and an explicit PATH containing only the captured Node/zrok directories plus `/usr/local/bin:/usr/bin:/bin`.

- [ ] **Step 1: Write RED unit-generation tests**

Assert the unit contains release-installed paths and exact reserved name/port but does not contain `.worktrees`, repository `apps/cli`, connector token/verifier keys, raw zrok JSON, `bash`, `sh -c`, `Restart=always`, or unbounded restart settings. Include quoting tests for spaces, `%`, quotes, and backslashes in local paths.

- [ ] **Step 2: Write RED install/uninstall orchestration tests**

Inject fake filesystem/manager/release dependencies. Prove install stages a release, writes unit atomically, calls `daemon-reload` then `enable`, does not start or stop an already-running old release, and uninstall stops/disables/removes only service-owned unit/release/metadata while preserving a sentinel credential/audit file under the state root.

- [ ] **Step 3: Run RED**

Run: `pnpm --filter kodegpt test -- src/service/systemd.test.ts src/commands/service.test.ts`

- [ ] **Step 4: Implement direct-argv systemd adapter and install/uninstall**

Use `spawn` with capped stdout/stderr for `systemctl --user ...` and read-only `loginctl show-user ... -p Linger --value`; never use `exec`, `execFile`, or a shell. Resolve `systemctl`, `loginctl`, and `zrok2` from PATH with executable checks; store no environment secret.

- [ ] **Step 5: Run GREEN + forbidden scan**

Run: `pnpm --filter kodegpt test -- src/service/systemd.test.ts src/commands/service.test.ts`

Run: `pnpm verify:forbidden`

Expected: PASS.

- [ ] **Step 6: Commit**

Commit message: `feat(cli): install KodeGPT systemd user service`

---

### Task 4: Start, stop, restart, status, and sanitized readiness

**Files:**
- Create: `apps/cli/src/service/runtime-status.ts`
- Create: `apps/cli/src/service/runtime-status.test.ts`
- Modify: `apps/cli/src/commands/service.ts`
- Modify: `apps/cli/src/commands/service.test.ts`

**Interfaces:**

```ts
export interface ServiceRuntimeStatusV1 {
  schemaVersion: 1;
  releaseId: string;
  pid: number;
  ready: true;
  localPort: number;
  runtimeVersion: string;
  protocolVersion: "2026-07-28";
  surfaceVersion: "0.3";
  reservedName: string;
  publicUrl: string;
}
```

`ServiceRuntimeStatusStore` writes atomically with mode `0600`, validates schema, and only removes a file when release ID/PID match the caller. `waitForServiceReady` polls manager `show()` plus the runtime-status file for at most 30 seconds and accepts readiness only when `ActiveState=active`, `MainPID === status.pid`, and the expected release ID matches.

- [ ] **Step 1: Write RED runtime-status/stale-state tests**

Cover valid write/read/remove, stale PID mismatch, stale release mismatch, malformed JSON, unknown schema, and secret-marker rejection from persisted JSON.

- [ ] **Step 2: Write RED lifecycle tests**

Prove:

- start of initial staged release calls manager start and promotes only after matching readiness;
- stop calls manager stop and returns stopped status without deleting general state;
- restart with no staged release restarts the active release;
- restart with a staged release switches the unit, reloads, restarts, waits for matching readiness, then promotes staged -> active and stores prior active as rollback;
- status normalizes installed/running/stopped/failed/activating plus linger, release identity, port, reserved name, public URL when runtime-ready, and systemd result;
- human and JSON status output contain no credential/verifier/raw-zrok markers.

- [ ] **Step 3: Run RED**

Run: `pnpm --filter kodegpt test -- src/service/runtime-status.test.ts src/commands/service.test.ts`

- [ ] **Step 4: Implement minimal lifecycle/status behavior**

Do not authenticate back into MCP. Readiness is the matching local runtime-status record plus manager MainPID, so the verifier-only connector store remains verifier-only.

- [ ] **Step 5: Run GREEN**

Run the same focused test command; expect PASS.

- [ ] **Step 6: Commit**

Commit message: `feat(cli): manage and observe local KodeGPT service`

---

### Task 5: Managed zrok service-run integration without secret re-emission

**Files:**
- Modify: `apps/cli/src/commands/service.ts`
- Modify: `apps/cli/src/commands/service.test.ts`
- Modify: `apps/cli/src/commands/expose-zrok.ts`
- Modify: `apps/cli/src/commands/expose-zrok.test.ts`
- Modify: `apps/cli/src/main.ts`

**Interfaces:**
- Hidden `kodegpt service run --state-root <path> --release-id <id>` is accepted only for the systemd unit path and remains absent from help.
- `service run` resolves its own packaged runtime through the existing resolver, loads the exact release record, requires an existing connector credential, invokes existing `exposeZrok(...)`, writes `ServiceRuntimeStatusV1` only after zrok readiness, then waits for signal/zrok/runtime termination.
- Standard foreground `kodegpt expose zrok` first-run behavior remains unchanged.

- [ ] **Step 1: Write RED service-run tests**

Prove service-run refuses missing connector configuration instead of creating/printing a token; with existing credential it invokes managed zrok using exact `share public http://127.0.0.1:<port> --headless --force-local --backend-mode proxy -n <reserved-name>`, writes only sanitized ready fields, and removes its ready file on graceful shutdown.

- [ ] **Step 2: Write RED regression for ordinary expose**

Keep the existing first-run test that `kodegpt expose zrok` can create a connector credential and show the one-time onboarding URL. Add an assertion that this path is not used by service-run.

- [ ] **Step 3: Run RED**

Run: `pnpm --filter kodegpt test -- src/commands/service.test.ts src/commands/expose-zrok.test.ts`

- [ ] **Step 4: Implement service-run by composing existing `exposeZrok`**

Do not fork/reimplement zrok validation, readiness, query-credential compatibility, or child supervision. The service path is a thin local wrapper around the existing implementation.

- [ ] **Step 5: Run GREEN**

Run the same focused tests and `pnpm verify:forbidden`.

- [ ] **Step 6: Commit**

Commit message: `feat(cli): run managed zrok under local service`

---

### Task 6: Crash, runtime failure, stale process, and rollback semantics

**Files:**
- Modify: `apps/cli/src/commands/service.ts`
- Modify: `apps/cli/src/commands/service.test.ts`
- Modify if RED requires: `packages/core/src/kernel-client.ts`
- Modify if RED requires: `packages/core/src/kernel-client.test.ts`
- Modify if RED requires: `apps/cli/src/commands/start.ts`
- Modify if RED requires: `apps/cli/src/commands/start.test.ts`
- Modify: `apps/cli/src/commands/expose-zrok.test.ts`

**Interfaces:**
- Staged activation failure restores the prior release unit, daemon-reloads, performs exactly one rollback start/restart, waits for prior-release readiness, and leaves the failed candidate staged for explicit retry.
- KodeGPT never kills a process discovered only by PID/name pattern; systemd unit ownership is authoritative.
- If the production foreground process currently survives an unexpected Rust child exit, add one explicit unexpected-runtime signal from `KernelClient` through `StartedKodegpt` so `start`/`expose`/service-run terminate non-zero and systemd can restart them.

- [ ] **Step 1: Write RED rollback tests**

Inject candidate readiness timeout/failed manager state. Assert the sequence is candidate unit -> daemon-reload -> restart/start -> failure -> prior unit -> daemon-reload -> one rollback restart/start; metadata keeps old active and failed candidate staged. Assert rollback failure is reported without an additional loop.

- [ ] **Step 2: Write RED zrok-crash process-tree test**

Use the existing fake child to force unexpected zrok exit after readiness and assert the local KodeGPT stack closes and the foreground command rejects/fails.

- [ ] **Step 3: Write RED Rust-crash test against the current foreground lifecycle**

Use a controlled test runtime/fixture to terminate the Rust child unexpectedly after startup. The required result is outer foreground termination/failure. If current code already does this, make no kernel change. If it remains alive, proceed to Step 4.

- [ ] **Step 4: Add the smallest runtime-unavailable signal only if Step 3 fails**

Prefer a one-shot, non-secret unexpected-runtime failure signal on `KernelClient` that does not resolve on normal `stop()`. Thread it through the start/expose foreground lifecycle and race it with shutdown. Do not add new runtime RPC, authority, or restart logic inside Rust.

- [ ] **Step 5: Run GREEN**

Run focused core/start/expose/service tests, then `pnpm verify:forbidden`.

- [ ] **Step 6: Commit**

Commit message: `fix(cli): recover bounded local service failures`

---

### Task 7: Upgrade/cutover mechanics and release cleanup

**Files:**
- Modify: `apps/cli/src/service/release.ts`
- Modify: `apps/cli/src/service/release.test.ts`
- Modify: `apps/cli/src/commands/service.ts`
- Modify: `apps/cli/src/commands/service.test.ts`

**Interfaces:**
- `install` while active release A is running stages B and leaves A untouched.
- Successful restart promotes B, retains A as `rollbackReleaseId`, and may delete only releases not equal to active/staged/rollback.
- Failed B activation restores A and keeps B staged.
- Unit `ExecStart` always names a release-root CLI outside repository/worktree paths.

- [ ] **Step 1: Write RED A -> B successful cutover test**

Build two temp release inputs with different bytes. Start A, install B while A is marked running, prove no stop/restart occurred during install, then restart and assert B becomes active, A becomes rollback, and A/B paths are outside the source fixture.

- [ ] **Step 2: Write RED cleanup tests**

Create active/staged/rollback plus two obsolete release directories; cleanup may remove only the obsolete directories and must reject any resolved path escaping the service release root.

- [ ] **Step 3: Run RED**

Run focused release/service tests.

- [ ] **Step 4: Implement minimal cutover/cleanup logic**

Keep cleanup explicit after successful activation/uninstall; never delete a running/staged/rollback release.

- [ ] **Step 5: Run GREEN and commit**

Commit message: `feat(cli): add atomic local service cutover`

---

### Task 8: Security, redaction, and forbidden invariants

**Files:**
- Create: `tests/security/service-lifecycle.test.ts`
- Modify: `tests/security/security-invariants.test.ts` only if the inventory assertion belongs there cleanly
- Modify: `scripts/forbidden-patterns.mjs` only for a precise new authored-product invariant, not broad text matching

**Interfaces:**
- Security test consumes real built CLI/service modules and generated unit/metadata/status structures.
- No MCP registration for service lifecycle is permitted.

- [ ] **Step 1: Write security tests with explicit secret markers**

Use values such as `connector-token-DO-NOT-LEAK`, `connector-verifier-DO-NOT-LEAK`, and `zrok-secret-DO-NOT-LEAK`. Assert they are absent from generated unit text, service metadata, runtime status, human status, JSON status, errors, and MCP tool inventory.

- [ ] **Step 2: Assert forbidden authority inventory**

The real MCP inventory must still exclude exactly these additions:

```text
skill.run
provider.list
provider.tools
provider.invoke
service.install
service.start
service.stop
service.restart
service.uninstall
workspace trust mutation
generic shell
```

- [ ] **Step 3: Run RED/GREEN as needed**

Run: `pnpm test:security`

Run: `pnpm verify:forbidden`

Fix only concrete failures.

- [ ] **Step 4: Commit**

Commit message: `test(security): lock local service authority boundaries`

---

### Task 9: Integration and clean-prefix package smoke

**Files:**
- Create: `tests/integration/cli-service.test.ts`
- Modify: `scripts/package-smoke.mjs`
- Modify: `tests/integration/packaged-runtime.test.ts` only if a package-resolution assertion belongs there

**Interfaces:**
- Integration fixture uses isolated HOME/state/service-data roots and fake manager/zrok implementations; no real user unit or real zrok network call.
- Package smoke installs tarballs into a clean prefix and prepends temporary fake `systemctl`, `loginctl`, and `zrok2` executables to PATH.

- [ ] **Step 1: Write RED integration lifecycle test**

Exercise install -> staged status -> start -> ready status -> restart -> stop -> uninstall. Assert installed CLI/runtime paths are beneath the temp service data root and contain no source/worktree path. Assert fake zrok argv preserves loopback/`--force-local`/proxy/exact-name semantics.

- [ ] **Step 2: Add credential-reuse regression**

Seed connector auth once, run service start/restart, and assert no credential rotation output or second verifier creation occurs.

- [ ] **Step 3: Extend package smoke**

After clean-prefix install, invoke `kodegpt service install --name public:kodegpt-dev --state-root <temp-state>` against fake manager/zrok binaries. Parse `service status --json`, verify staged release artifacts exist outside the repository and their runtime digest matches the packaged runtime, then uninstall. Do not start a real service.

- [ ] **Step 4: Run GREEN**

Run: `pnpm test:integration`

Run: `pnpm verify:package`

Expected: PASS without changing the developer's real user service.

- [ ] **Step 5: Commit**

Commit message: `test(integration): prove installed service lifecycle`

---

### Task 10: Real local service acceptance and ChatGPT smoke

**Files:**
- No product source changes unless a real defect is reproduced and receives a new RED test first.
- Record final evidence in Task 11 docs.

**Interfaces:**
- Candidate must be built from the feature worktree but installed snapshot must live outside it.
- Existing live canonical-main foreground exposure remains untouched until candidate gate is green.

- [ ] **Step 1: Run candidate gate before cutover**

Run the relevant exact-head matrix from Task 11's documented candidate gate. Any failure is investigated before touching the live service.

- [ ] **Step 2: Install candidate service release without stopping current live main**

Invoke candidate `kodegpt service install --name public:kodegpt-dev`. Confirm status shows candidate staged and current foreground main process remains alive until explicit cutover.

- [ ] **Step 3: Gracefully stop the old operational bridge and activate candidate**

Stop the old `start-stop-daemon`-detached canonical-main foreground supervisor gracefully with SIGTERM, proving its Rust/zrok children exit. Then `kodegpt service start` (or restart if a prior managed unit exists) and verify systemd owns the installed candidate process.

- [ ] **Step 4: Verify local service provenance**

Check systemd unit/MainPID and child process paths. Required result: outer CLI and Rust runtime resolve under the service release root; no process CWD/executable/argument references `.worktrees/...` or the candidate repository worktree. zrok target remains `127.0.0.1:43121` and reserved name `public:kodegpt-dev`.

- [ ] **Step 5: Actual ChatGPT smoke only**

Call actual host:

```text
system.health
system.capabilities
skill.list compatibility=NATIVE
```

Required: health green; runtime `0.1`; protocol `2026-07-28`; surface `0.3`; native filter succeeds. Do not replay the full PR #6 script/resource acceptance without a defect signal.

- [ ] **Step 6: Rollback drill without rotating credentials**

Stage a deliberately non-startable test candidate only in an isolated acceptance fixture, or use the deterministic integration rollback evidence if disturbing the live endpoint would be unsafe. Prove one-step rollback semantics without leaking or rotating connector credentials.

- [ ] **Step 7: Confirm feature worktree is removable**

Before removal, prove no running path points to it. Do not remove the worktree until this assertion passes.

---

### Task 11: Documentation, verification matrix, final candidate review, push/CI readiness

**Files:**
- Modify: `docs/implementation/v0.1-execution-tracker.md`
- Modify: `docs/architecture/README.md`
- Modify: `docs/compatibility/chatgpt.md`
- Modify: `docs/verification/host-acceptance.md`
- Modify: `docs/release/v0.1-checklist.md`
- Create: `docs/release/2026-08-14-stable-local-service-readiness.md`
- Modify this plan's task checkboxes/evidence only when each exact gate is actually run.

**Interfaces:**
- Docs distinguish historical evidence, completed PR #6 state, current service lifecycle behavior, and deferred provider interoperability.
- Verification docs define three intent levels without deleting substantive tests.

- [ ] **Step 1: Document gate rationalization**

Record:

```text
Focused development gate:
  changed package/tests + targeted integration/security + forbidden scan

Candidate gate:
  pnpm typecheck
  pnpm build
  pnpm test
  pnpm test:protocol
  pnpm test:integration
  pnpm test:security
  pnpm test:isolation
  pnpm test:acceptance
  pnpm test:rust
  pnpm verify:forbidden
  pnpm verify:package
  required sandbox/host-isolation evidence already mandated by release docs

Final integration gate:
  exact final candidate SHA candidate gate
  CI success for exact SHA
  final main...feature diff review
  real local service cutover/provenance proof
  minimal ChatGPT smoke
```

State explicitly that overlapping suites are retained when they serve distinct named gates; no substantive security verification is removed for speed.

- [ ] **Step 2: Reconcile architecture/compatibility/host/release docs**

Document systemd user ownership, linger behavior, installed release identity, secret-safe status, zrok semantics, cutover/rollback, and MCP surface unchanged at `0.3`.

- [ ] **Step 3: Run exact candidate verification**

Run every candidate-gate command and record exact pass/fail output counts where the existing project convention does so. Do not claim PASS from older runs after code changes.

- [ ] **Step 4: Run final forbidden inventory searches**

Verify authored product/MCP surface has no `skill.run`, provider tools, MCP service mutation, generic shell, or worktree-coupled service ExecStart.

- [ ] **Step 5: Review complete diff**

Use `main...feat/stable-local-service-lifecycle` diff and review specifically for secret leakage, unsafe process ownership, stale path dependencies, over-broad refactors, and accidental MCP/schema changes.

- [ ] **Step 6: Push candidate and require CI**

Push only after the working tree is clean and local exact-head gates are green. Wait for CI on that exact SHA and fix only reproduced defects with RED -> GREEN. Do not merge automatically.

- [ ] **Step 7: Final commit**

Commit message: `docs: record stable local service readiness`

## Final acceptance invariants

Before preparing a PR, all of the following must be true simultaneously:

```text
installed service: independent from feature worktree
outer owner: systemd --user
inner owner: existing KodeGPT expose-zrok supervisor
zrok name: public:kodegpt-dev
zrok upstream: loopback only
credential: preserved and never re-emitted by service lifecycle
runtime: 0.1
protocol: 2026-07-28
surface: 0.3
v0.1 tag: untouched
skill.run: absent
provider.list/tools/invoke: absent
provider interoperability: NOT STARTED
MCP service lifecycle mutation: absent
```
