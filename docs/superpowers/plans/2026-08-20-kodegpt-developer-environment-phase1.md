# KodeGPT Developer Environment Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make KodeGPT trusted execution genuinely toolchain-agnostic through bounded dynamic executable resolution, a persisted Developer Environment Registry, controlled sandbox PATH composition, local `kodegpt env` management, and accurate execution self-description.

**Architecture:** Keep `process.run` as the only generic execution primitive. Extend the existing runtime policy with `allowDynamicExecutables`, generalize the Rust explicit-root resolver from Node/Rust special cases to a schema-versioned registry beneath KodeGPT private state, and mount all admitted developer roots read-only for trusted dynamic launches so direct and nested toolchain commands share one controlled PATH. TypeScript owns local registry mutation/bootstrap and Rust independently validates the persisted registry before execution.

**Tech Stack:** TypeScript 5.9, Zod, Vitest, Node.js fs/path APIs, Rust/Serde/Rustix, Bubblewrap 0.11.2, Cargo tests.

**Spec:** `docs/superpowers/specs/2026-08-20-kodegpt-developer-environment-continuity-design.md`

## Global Constraints

- Final program target remains `runtime 0.1 / MCP protocol 2026-07-28 / semantic surface 0.17 / 76 public tools`; Phase 1 itself adds no MCP tool.
- Do not add `shell.run`, language-specific MCP tools, agent orchestration, executable plugins, session databases, generic HTTP/provider execution, or host-wide environment inheritance.
- `observe` and `develop` use `allowDynamicExecutables:false`; `trusted` uses `allowDynamicExecutables:true`.
- A project profile may narrow `allowDynamicExecutables:true -> false` but never widen `false -> true`.
- `bash` and `sh` remain system-only top-level executables and cannot be shadowed by developer roots.
- Internal Git/Bubblewrap authority continues to use the trusted-system resolver only.
- Registered roots are read-only, bounded to 32 entries, outside KodeGPT state and all trusted workspace roots, and revalidated before launch.
- No production code is written before a test that fails for the intended missing behavior.
- Sandbox-sensitive full acceptance cannot run correctly from inside KodeGPT's own Bubblewrap sandbox; targeted pure/unit tests run here, while host/CI acceptance is required before merge.

---

## File Structure

### New files

- `packages/core/src/developer-environment-store.ts` — TypeScript schema, persistence, bootstrap, add/sync/remove/list/doctor-facing store behavior for `developer-environments/registry.json`.
- `packages/core/src/developer-environment-store.test.ts` — store validation, atomic persistence, bootstrap, PATH candidate normalization, trusted-workspace overlap rejection.
- `apps/cli/src/commands/env.ts` — local-only `kodegpt env sync|add|list|remove|doctor` parser/formatter.
- `apps/cli/src/commands/env.test.ts` — CLI behavior tests independent of the runtime.
- `crates/sandbox/src/developer_environment.rs` — Rust schema-versioned registry reader, retained root validation, executable directory normalization, developer executable lookup, and root mount preparation.

### Modified files

- `packages/protocol/src/runtime-types.ts` — add `allowDynamicExecutables` to `runtimePolicySchema`.
- `crates/protocol/src/types.rs` — mirror `allow_dynamic_executables` in `RuntimePolicy`.
- `packages/profiles/src/presets.ts` — built-in values false/false/true.
- `packages/profiles/src/resolve-profile.ts` — boolean monotonic narrowing rule.
- `packages/profiles/src/resolve-profile.test.ts` — policy narrowing/widening tests.
- `tests/protocol/runtime-schema.test.ts` and `crates/protocol/tests/protocol_contract.rs` — closed TS/Rust runtime policy contract tests.
- `packages/core/src/index.ts` — export the Developer Environment store API.
- `packages/core/src/kernel-client.ts` — bootstrap generic Node/Rust registry entries before runtime start; stop passing Node/Rust special resolver env vars.
- `packages/core/src/kernel-client.test.ts` — runtime spawn environment/bootstrap tests.
- `apps/cli/src/main.ts` — route `kodegpt env`, help text, and state-root handling.
- `apps/cli/src/packaged-cli.test.ts` — packaged help/env smoke.
- `crates/sandbox/src/lib.rs` — expose developer-environment internals needed by runtime.
- `crates/sandbox/src/executable.rs` — make explicit-root trust generic; preserve system-only resolver for security authority; add dynamic resolution entry point.
- `crates/sandbox/src/bubblewrap.rs` — admit additional retained developer-root mounts and construct PATH from normalized executable directories.
- `crates/runtime/src/process.rs` — dynamic policy authorization, generic resolver, all-root mount composition, managed Cargo/Corepack compatibility.
- `crates/runtime/src/dispatcher.rs` — `process.inspect_executable` uses effective dynamic policy/registry availability without host paths.
- `crates/policy/src/lib.rs` — Rust monotonic restriction semantics for `allow_dynamic_executables`.
- `tests/security/process-policy.test.ts` — source-level invariant coverage for dynamic execution and no host PATH inheritance.
- `packages/mcp-server/src/tools.ts` — clarify `process.run` description; no schema/tool-name change.
- `apps/cli/src/commands/start.ts` — add global `system.capabilities.execution` feature summary.
- relevant `*.test.ts` files for self-description assertions.

---

### Task 1: Runtime policy contract and monotonic profile semantics

**Files:**
- Modify: `packages/protocol/src/runtime-types.ts`
- Modify: `crates/protocol/src/types.rs`
- Modify: `packages/profiles/src/presets.ts`
- Modify: `packages/profiles/src/resolve-profile.ts`
- Modify: `packages/profiles/src/resolve-profile.test.ts`
- Modify: `tests/protocol/runtime-schema.test.ts`
- Modify: `crates/policy/src/lib.rs`
- Modify: `crates/protocol/tests/protocol_contract.rs`

**Interfaces:**
- Produces: `RuntimePolicy.allowDynamicExecutables: boolean` in TypeScript and `RuntimePolicy.allow_dynamic_executables: bool` in Rust.
- Produces: profile presets `observe=false`, `develop=false`, `trusted=true`.
- Produces: restriction rule `true -> false` allowed; `false -> true` rejected.

- [ ] **Step 1: Add failing TypeScript profile tests**

Add focused expectations equivalent to:

```ts
expect(getProfilePreset("observe").allowDynamicExecutables).toBe(false);
expect(getProfilePreset("develop").allowDynamicExecutables).toBe(false);
expect(getProfilePreset("trusted").allowDynamicExecutables).toBe(true);

expect(() =>
  resolveProfile(
    { ...getProfilePreset("develop"), allowDynamicExecutables: false },
    { ...getProfilePreset("develop"), allowDynamicExecutables: true }
  )
).toThrow(ProfileEscalationError);

expect(
  resolveProfile(
    getProfilePreset("trusted"),
    { ...getProfilePreset("trusted"), allowDynamicExecutables: false }
  ).allowDynamicExecutables
).toBe(false);
```

- [ ] **Step 2: Run the focused TS tests and confirm RED**

Run:

```text
pnpm --filter @kodegpt/profiles test -- --run src/resolve-profile.test.ts
```

Expected: FAIL because `allowDynamicExecutables` is not yet part of the policy schema/presets.

- [ ] **Step 3: Add failing protocol-contract tests in TS and Rust**

Require a valid policy fixture to include:

```json
"allowDynamicExecutables": false
```

and assert unknown/missing/widening behavior remains closed.

- [ ] **Step 4: Run focused protocol tests and confirm RED**

Run:

```text
pnpm vitest run tests/protocol/runtime-schema.test.ts
cargo test -p kodegpt-protocol --test protocol_contract
cargo test -p kodegpt-policy
```

Expected: contract/profile tests fail for the missing field/rule; no Bubblewrap spawn is involved.

- [ ] **Step 5: Implement the minimal cross-language policy field**

TypeScript runtime schema gains:

```ts
allowDynamicExecutables: z.boolean(),
```

Rust `RuntimePolicy` gains:

```rust
pub allow_dynamic_executables: bool,
```

Presets use `false`, `false`, `true`, and `resolveProfile` rejects:

```ts
if (!parsedCurrent.allowDynamicExecutables && parsedRestriction.allowDynamicExecutables) {
  throw new ProfileEscalationError("Project profile cannot enable dynamic executables");
}
```

Rust policy mirrors the same monotonic check.

- [ ] **Step 6: Run all Task 1 focused tests and confirm GREEN**

Run the three commands from Steps 2/4 again plus `pnpm --filter @kodegpt/protocol typecheck` and `cargo check -p kodegpt-runtime`.

- [ ] **Step 7: Commit Task 1**

```text
git add packages/protocol crates/protocol packages/profiles crates/policy tests/protocol
git commit -m "feat: add dynamic executable policy"
```

---

### Task 2: TypeScript Developer Environment Registry store

**Files:**
- Create: `packages/core/src/developer-environment-store.ts`
- Create: `packages/core/src/developer-environment-store.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:

```ts
export interface DeveloperEnvironmentEntry {
  id: string;
  label: string;
  source: "bootstrap" | "operator" | "synced-shell";
  canonicalRoot: string;
  executableDirs: string[];
  identity: PersistentFilesystemIdentity;
}

export class DeveloperEnvironmentStore {
  constructor(stateRoot: string);
  list(): Promise<DeveloperEnvironmentEntry[]>;
  add(input: { root: string; executableDirs: string[]; label: string; source: ...; trustedWorkspaceRoots: string[] }): Promise<DeveloperEnvironmentEntry>;
  syncPath(pathValue: string, trustedWorkspaceRoots: string[]): Promise<DeveloperEnvironmentEntry[]>;
  remove(id: string): Promise<boolean>;
  ensureBootstrap(input: { nodeRoot?: string; rustRoot?: string; trustedWorkspaceRoots: string[] }): Promise<void>;
}
```

- [ ] **Step 1: Write failing store tests**

Cover real filesystem behavior:

```ts
it("persists a schema-v1 private registry and round-trips entries", async () => { ... });
it("rejects roots beneath state root or a trusted workspace", async () => { ... });
it("syncPath stores the PATH directory itself with executableDirs dot", async () => { ... });
it("rejects group/world writable roots and changed filesystem identity", async () => { ... });
it("bounds registry entries at 32 and executableDirs at 4", async () => { ... });
it("ensureBootstrap is idempotent and preserves operator entries", async () => { ... });
```

Use temporary directories with actual chmod/stat; do not mock filesystem semantics.

- [ ] **Step 2: Run the new test and confirm RED**

Run:

```text
pnpm --filter @kodegpt/core test -- --run src/developer-environment-store.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement strict parsing/validation and atomic persistence**

Persist exactly:

```ts
interface DeveloperEnvironmentDocument {
  schemaVersion: 1;
  entries: DeveloperEnvironmentEntry[];
}
```

Use `mkdir(..., {mode:0o700})`, temporary `open(...,"wx",0o600)`, `writeFile`, `sync`, `rename`, and directory fsync following the existing trust-store pattern. Canonicalize roots with `realpath`, derive device/inode using `stat`, reject symlink/root drift, and enforce all bounds from the spec.

- [ ] **Step 4: Implement PATH sync normalization**

For each PATH component:
- skip empty values;
- canonicalize;
- skip `/usr/local/bin`, `/usr/bin`, `/bin`;
- store the directory itself as `canonicalRoot` + `executableDirs:["."]`;
- reject directories inside state/trusted workspace roots;
- de-duplicate canonical roots in stable PATH order.

- [ ] **Step 5: Implement bootstrap entries**

`ensureBootstrap` inserts/refreshes only `source:"bootstrap"` entries for valid Node/Rust roots, preserving operator/synced entries and stable ordering. Missing roots are skipped, not fatal.

- [ ] **Step 6: Run store tests and typecheck GREEN**

Run:

```text
pnpm --filter @kodegpt/core test -- --run src/developer-environment-store.test.ts
pnpm --filter @kodegpt/core typecheck
```

- [ ] **Step 7: Commit Task 2**

```text
git add packages/core/src/developer-environment-store* packages/core/src/index.ts
git commit -m "feat: persist developer environments"
```

---

### Task 3: Kernel bootstrap migration away from Node/Rust resolver env vars

**Files:**
- Modify: `packages/core/src/kernel-client.ts`
- Modify: `packages/core/src/kernel-client.test.ts`

**Interfaces:**
- Consumes: `DeveloperEnvironmentStore.ensureBootstrap(...)` from Task 2.
- Produces: runtime child env keeps `KODEGPT_STATE_ROOT` and Corepack support but no longer passes `KODEGPT_HOST_NODE_ROOT` or `KODEGPT_HOST_RUST_TOOLCHAIN_ROOT`.

- [ ] **Step 1: Add failing KernelClient spawn-environment test**

Arrange a fake/spawn-observable runtime and assert startup creates bootstrap registry state, while runtime env does **not** contain Node/Rust special resolver variables.

- [ ] **Step 2: Run focused KernelClient test RED**

```text
pnpm --filter @kodegpt/core test -- --run src/kernel-client.test.ts
```

Expected: FAIL because startup still sets the old variables / does not bootstrap registry.

- [ ] **Step 3: Implement bootstrap-before-spawn**

Before `spawn(options.runtimePath, ...)`, create a `DeveloperEnvironmentStore(options.stateRoot)`, list trusted workspace roots from no external source (bootstrap overlap check uses state root only here), and call `ensureBootstrap` with:

```ts
nodeRoot: dirname(dirname(process.execPath)),
rustRoot: stableRustToolchainRoot()
```

Keep Corepack env temporarily because it is cache/runtime support, not executable authority.

- [ ] **Step 4: Remove Node/Rust resolver env variables**

Runtime child env becomes conceptually:

```ts
const environment = {
  KODEGPT_STATE_ROOT: options.stateRoot,
  KODEGPT_HOST_COREPACK_HOME: join(homedir(), ".cache", "node", "corepack")
};
```

- [ ] **Step 5: Run KernelClient tests GREEN**

Run the Step 2 command and core typecheck.

- [ ] **Step 6: Commit Task 3**

```text
git add packages/core/src/kernel-client.ts packages/core/src/kernel-client.test.ts
git commit -m "refactor: bootstrap generic toolchain roots"
```

---

### Task 4: Rust schema-v1 registry reader and generic explicit-root resolver

**Files:**
- Create: `crates/sandbox/src/developer_environment.rs`
- Modify: `crates/sandbox/src/lib.rs`
- Modify: `crates/sandbox/src/executable.rs`

**Interfaces:**
- Produces:

```rust
pub struct DeveloperEnvironmentRegistry { ... }
pub struct DeveloperEnvironmentMount { ... }

impl DeveloperEnvironmentRegistry {
    pub fn load(state_root: &Path) -> Result<Self, DeveloperEnvironmentError>;
    pub fn resolve(&self, name: &str) -> Result<TrustedExecutable, TrustedExecutableError>;
    pub fn open_mounts(&self) -> Result<Vec<DeveloperEnvironmentMount>, DeveloperEnvironmentError>;
}
```

- `resolve_trusted_executable(name)` remains **system-only** for Git/Bubblewrap/security authority.
- Add `resolve_dynamic_executable(state_root, name)` that checks registered roots in order then system roots, except `bash|sh` always use the system-only resolver.

- [ ] **Step 1: Write failing pure Rust registry tests**

Tests create temp schema-v1 files and roots; cover:
- valid user-owned non-group/world-writable root loads;
- unknown schema/version/unknown fields fail closed;
- >32 entries or >4 exec dirs fail;
- relative exec dir traversal fails;
- root identity mismatch fails;
- logical executable symlink escaping root fails;
- registered root resolves before system fallback in the dynamic resolver;
- `bash`/`sh` are never resolved from registry.

- [ ] **Step 2: Run pure sandbox tests RED**

```text
cargo test -p kodegpt-sandbox developer_environment
cargo test -p kodegpt-sandbox executable
```

Expected: new module/API is missing. These tests must not spawn Bubblewrap.

- [ ] **Step 3: Implement strict Serde registry types**

Use `#[serde(rename_all="camelCase", deny_unknown_fields)]`, exact schemaVersion=1 validation, bounds, `canonicalize`, `metadata`, uid/gid/mode/device/inode validation, and normalized relative executable dirs.

- [ ] **Step 4: Generalize explicit-root trust metadata**

Replace the Node/Rust-only `ExplicitToolchain` discriminator with generic explicit-root metadata sufficient for:
- canonical root identity;
- relative executable path;
- optional runtime-support tags only where genuinely needed (Node for Corepack, Rust/Cargo managed state may remain inferred by logical name).

Do not change `resolve_bubblewrap()` or internal Git resolution to dynamic lookup.

- [ ] **Step 5: Implement dynamic lookup and mount opening**

Search registered roots in persisted order. For each executable candidate, enforce simple logical name, containment, regular executable file, matching owner, no setid, no group/world write, and immediate identity revalidation.

- [ ] **Step 6: Run pure Rust tests GREEN**

Run the Step 2 commands plus:

```text
cargo check -p kodegpt-sandbox
cargo check -p kodegpt-runtime
```

- [ ] **Step 7: Commit Task 4**

```text
git add crates/sandbox
git commit -m "feat: resolve registered developer executables"
```

---

### Task 5: Bubblewrap developer-root mounts and controlled PATH

**Files:**
- Modify: `crates/sandbox/src/bubblewrap.rs`
- Add/modify tests in the same file or a focused sandbox test module.

**Interfaces:**
- Consumes: `DeveloperEnvironmentMount` from Task 4.
- Produces: `SandboxLaunchSpec.developer_environment_mounts` (or equivalently named bounded field) containing retained root FDs + normalized executable dirs.
- PATH order: registered developer dirs in persisted order, then `/usr/local/bin:/usr/bin:/bin`.

- [ ] **Step 1: Write failing command-construction tests**

Without spawning a nested sandbox, build a launch command/spec and assert:
- each retained developer root is `--ro-bind-fd` mounted beneath `/opt/kodegpt-toolchain[-N]`;
- PATH maps `.` to the mount root and `bin` to `<mount>/bin`;
- developer PATH precedes fixed system PATH;
- no developer mounts/path are present when none are admitted;
- duplicate root mounts are eliminated deterministically.

- [ ] **Step 2: Run the focused sandbox tests RED**

```text
cargo test -p kodegpt-sandbox bubblewrap --no-fail-fast
```

Filter to the newly added non-spawn tests if the existing spawn tests are sandbox-sensitive.

- [ ] **Step 3: Implement retained additional mounts**

Open/revalidate roots before launch, clear CLOEXEC only for the retained descriptors passed to Bubblewrap, append read-only mount arguments, and construct PATH from mount-index + relative executable dir.

- [ ] **Step 4: Preserve current program path translation**

If the selected top-level executable comes from one of the developer mounts, translate it to the corresponding `/opt/kodegpt-toolchain[-N]/<relative-program>`; do not assume mount index 0 is the program root.

- [ ] **Step 5: Run focused non-spawn tests GREEN and `cargo check`**

- [ ] **Step 6: Commit Task 5**

```text
git add crates/sandbox/src/bubblewrap.rs
git commit -m "feat: mount developer environments in sandbox"
```

---

### Task 6: Process authorization, direct dynamic launch, nested toolchain composition, and inspect availability

**Files:**
- Modify: `crates/runtime/src/process.rs`
- Modify: `crates/runtime/src/dispatcher.rs`
- Modify/add pure/unit tests in those files.

**Interfaces:**
- Consumes: `policy.allow_dynamic_executables`, `resolve_dynamic_executable`, and registry mounts.
- Produces: trusted dynamic launch for unlisted safe logical executables; fixed-list behavior remains for dynamic=false.
- `process.inspect_executable` reports only `{executableAvailable,sandboxAvailable}`.

- [ ] **Step 1: Write failing policy-unit tests**

Assert:
- dynamic=false + unlisted name => `ExecutableDenied`;
- dynamic=true + syntactically valid unlisted name reaches resolver instead of policy denial;
- `bash`/`sh` still require their fixed-list admission;
- environment allowlist behavior is unchanged.

- [ ] **Step 2: Run process policy tests RED**

```text
cargo test -p kodegpt-runtime process::tests::policy_
```

- [ ] **Step 3: Implement minimal authorization change**

Top-level admission rule:

```rust
let fixed = policy.allowed_executable_names.iter().any(|n| n == &request.logical_executable);
let dynamic_candidate = policy.allow_dynamic_executables
    && !matches!(request.logical_executable.as_str(), "bash" | "sh");
if !fixed && !dynamic_candidate { return Err(ProcessError::ExecutableDenied); }
```

Actual resolver failure remains denial/unavailable; policy alone never proves availability.

- [ ] **Step 4: Load registry once per process launch and pass all retained mounts**

For trusted dynamic environments:
- load registry from `state_root`;
- resolve top-level executable dynamically when appropriate;
- open all admitted roots for PATH composition;
- preserve managed Cargo home and Corepack behavior;
- do not set host raw PATH/HOME.

- [ ] **Step 5: Update `process.inspect_executable`**

Inspect against the effective policy:
- fixed-list/system behavior when dynamic=false;
- dynamic registry/system lookup when dynamic=true;
- never return canonical paths/registry roots.

- [ ] **Step 6: Add pure dispatcher/inspection tests and run GREEN**

Use tests that do not need nested Bubblewrap to prove policy + lookup result classification. Run `cargo check -p kodegpt-runtime`.

- [ ] **Step 7: Commit Task 6**

```text
git add crates/runtime/src/process.rs crates/runtime/src/dispatcher.rs
git commit -m "feat: enable trusted dynamic executables"
```

---

### Task 7: Local `kodegpt env` CLI

**Files:**
- Create: `apps/cli/src/commands/env.ts`
- Create: `apps/cli/src/commands/env.test.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/packaged-cli.test.ts`

**Interfaces:**
- Consumes: `DeveloperEnvironmentStore`.
- Produces local commands:

```text
kodegpt env sync
kodegpt env add <root> [--exec-dir <relative>]
kodegpt env list
kodegpt env remove <id>
kodegpt env doctor [executable]
```

- [ ] **Step 1: Write failing command parser tests**

Cover exact arity/options, invalid `--exec-dir`, unknown command, deterministic JSON/text formatting, and no runtime start requirement.

- [ ] **Step 2: Run CLI tests RED**

```text
pnpm --filter @kodegpt/cli test -- --run src/commands/env.test.ts
```

- [ ] **Step 3: Implement command module**

`sync` reads `process.env.PATH ?? ""`; `add` uses explicit root/exec dir; both receive trusted workspace roots from `WorkspaceTrustStore(stateRoot).list()` in `main.ts`; `doctor [name]` diagnoses registry validity/identity/executable visibility without executing project commands.

- [ ] **Step 4: Route command/help in `main.ts`**

Add `case "env"` and help lines. Keep `--state-root` behavior identical to auth/workspace/skill.

- [ ] **Step 5: Add packaged CLI smoke and run GREEN**

Run:

```text
pnpm --filter @kodegpt/cli test -- --run src/commands/env.test.ts src/packaged-cli.test.ts
pnpm --filter @kodegpt/cli typecheck
```

- [ ] **Step 6: Commit Task 7**

```text
git add apps/cli
git commit -m "feat: add developer environment CLI"
```

---

### Task 8: Execution self-description and `process.run` discoverability

**Files:**
- Modify: `apps/cli/src/commands/start.ts`
- Modify: corresponding start/system capability tests
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: MCP tool metadata tests if snapshots/assertions exist.

**Interfaces:**
- Produces global `system.capabilities.execution`:

```ts
{
  processRun: true,
  explicitTrustedShell: true,
  dynamicExecutableResolution: true,
  developerEnvironmentRegistry: true,
  inheritsHostEnvironment: false
}
```

- [ ] **Step 1: Add failing system-capabilities assertion**

Require the exact execution object above while preserving the derived public tool inventory.

- [ ] **Step 2: Add failing `process.run` description assertion**

Require description text to communicate that `process.run` executes a logical executable directly, while admitted callers can explicitly choose `bash -lc`/`sh -lc`; structured tools remain preferred.

- [ ] **Step 3: Run focused tests RED**

Use the owning CLI/MCP test files.

- [ ] **Step 4: Implement minimal self-description changes**

No tool names/schemas are added or removed in Phase 1.

- [ ] **Step 5: Run focused tests GREEN**

- [ ] **Step 6: Commit Task 8**

```text
git add apps/cli/src/commands/start.ts packages/mcp-server/src/tools.ts <tests>
git commit -m "docs: expose trusted execution capabilities"
```

---

### Task 9: Phase 1 regression gates and non-Node/Rust dogfood fixture

**Files:**
- Modify: `tests/security/process-policy.test.ts` as needed.
- Add a bounded test fixture only if needed to prove a generic developer executable without depending on host-installed Go/Java/etc.

**Interfaces:**
- Proves the generic path using a temporary executable owned by the test user and registered as an operator developer root.

- [ ] **Step 1: Add/complete a generic executable fixture**

Use a temporary executable such as `kodegpt-fixture-tool` that prints a deterministic marker and invokes a sibling helper through PATH. It must be unrelated to Node/Rust naming so the test proves generic behavior.

- [ ] **Step 2: Run all sandbox-safe focused suites**

```text
pnpm --filter @kodegpt/profiles test
pnpm --filter @kodegpt/core test
pnpm --filter @kodegpt/cli test
pnpm vitest run tests/protocol/runtime-schema.test.ts tests/security/process-policy.test.ts
cargo test -p kodegpt-policy
cargo test -p kodegpt-protocol --test protocol_contract
cargo test -p kodegpt-sandbox developer_environment
cargo test -p kodegpt-sandbox executable
cargo check --workspace
pnpm -r typecheck
```

Expected: PASS. Do not treat nested-Bubblewrap full-stack failures as acceptable substitutes for these focused gates.

- [ ] **Step 3: Run repository static gates**

```text
pnpm run verify:forbidden
pnpm run build
```

Expected: PASS.

- [ ] **Step 4: Record host/CI-required gates before merge**

The following must later run outside the already-sandboxed KodeGPT process:

```text
cargo test --workspace
pnpm test
pnpm run verify:package
```

and any merged deterministic CI gates. Do not merge/deploy until those are green.

- [ ] **Step 5: Commit final Phase 1 test/docs adjustments**

```text
git add <phase-1-test-files>
git commit -m "test: verify generic developer environments"
```

---

## Phase 1 Self-Review Checklist

- [ ] Every spec Part A/Part B requirement maps to a task above.
- [ ] No placeholder or unspecified implementation step remains.
- [ ] `allowDynamicExecutables` spelling is identical across TS public policy and Rust camelCase serialization.
- [ ] Developer Environment Registry stays local/private and exposes no host paths over MCP.
- [ ] `bash`/`sh`, Git, and Bubblewrap cannot be shadowed by developer roots.
- [ ] Dynamic=true expands trusted logical-name resolution without importing raw host PATH/env.
- [ ] All registered roots are retained/read-only for nested toolchain lookup.
- [ ] Node/Rust resolver special env vars are removed only after bootstrap registry migration is tested.
- [ ] Phase 1 adds zero public MCP tools and does not bump surface version by itself.
