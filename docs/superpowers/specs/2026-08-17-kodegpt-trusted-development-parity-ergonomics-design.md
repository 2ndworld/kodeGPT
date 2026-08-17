# KodeGPT Trusted Development Parity & Ergonomics — Approved Design

Date prepared: 2026-08-18  
Historical design date/path retained: `docs/superpowers/specs/2026-08-17-kodegpt-trusted-development-parity-ergonomics-design.md`  
Status: **Design B approved by user**  
Target repo: `/home/sauron/dev/kodegpt`

## 1. Goal

Make KodeGPT profile `trusted` reliable and comfortable for ordinary development and CI/CD workflows, close to CodexPro ergonomics, without adding narrow public MCP tools and without weakening KodeGPT's existing sandbox/trust boundary.

P0 specifically fixes the remaining trusted verification friction:

- `verify.run(cargo:test)` must produce a deterministic, actionable result.
- `verify.run(package:test)` must pass when the repository is healthy, or expose the real failure rather than an opaque synthetic `128`.
- nested Node -> Rust trusted tooling must continue to work.
- trusted network access must actually be usable when policy says `unrestricted`.
- Cargo dependency state should persist in KodeGPT-owned state rather than cold-starting from an empty private HOME on every invocation.

P1 happens only after P0 is proven: audit practical workflow parity against CodexPro and implement only small, evidence-backed gaps with high leverage.

## 2. Canonical Baseline

Canonical repo:

`/home/sauron/dev/kodegpt`

Remote:

`https://github.com/2ndworld/kodeGPT.git`

Canonical branch:

`main`

Verified canonical HEAD before this phase:

`4cf2e481743aa3be0d13186eaeaa3c6aded8e987`

Commit:

`Merge pull request #29 from 2ndworld/docs/four-priority-closure`

Product/source merge immediately before the docs-only closure:

`1c097ada98a578f25fd1bf675b840440f4e8ac07`

Current public MCP contract before this work:

- runtimeVersion: `0.1`
- protocol: `2026-07-28`
- surface: `0.10`
- exactly 62 public tools

The design branch already exists remotely:

`design/trusted-dev-parity-ergonomics`

At the last verified check it still pointed to the baseline commit `4cf2e481...`; the earlier attempted design file was **not committed**.

## 3. Already Closed — Do Not Reimplement

The Four-Priority phase is closed. In particular, do not redo:

- Trusted Process Policy v2;
- trusted `bash` / `sh`;
- trusted Node + Rust multi-toolchain composition;
- `code.impact`;
- CI mutations;
- Rust CI audit admission;
- existing audit/cancellation/spooling;
- existing Git/GitHub/CI typed surfaces.

Relevant merges remain historical evidence:

- PR #25 Trusted Process Policy v2:
  `72df14365f743f0e2166f34b43abb5b0bf2ef495`
- PR #27 Four-Priority Followthrough:
  `64b01964e570ef27884c6770a097773a73e08b89`
- PR #28 CI mutation audit closure:
  `1c097ada98a578f25fd1bf675b840440f4e8ac07`
- PR #29 docs closure:
  `4cf2e481743aa3be0d13186eaeaa3c6aded8e987`

## 4. Reproduced Evidence

The following was reproduced directly against the canonical workspace through live KodeGPT and independently checked with CodexPro host execution.

### 4.1 Trusted toolchain composition is healthy

`process.run(cargo --version)` in `trusted` succeeded:

`cargo 1.97.1 (c980f4866 2026-06-30)`

A Node child calling:

`spawnSync("cargo", ["--version"])`

also succeeded inside the trusted sandbox.

Conclusion: the earlier Node + Rust auxiliary toolchain work is working. Do not redesign it.

### 4.2 `cargo:test` fails because trusted DNS is broken

`verify.run(cargo:test)` reached Cargo and failed while updating crates.io:

`Could not resolve host: index.crates.io`

A separate KodeGPT `git.fetch` similarly failed with:

`Could not resolve host: github.com`

Host-side `getent hosts github.com` succeeded.

Inside the KodeGPT sandbox:

- `/etc/resolv.conf` was a symlink to:
  `../run/systemd/resolve/stub-resolv.conf`
- `/run/systemd/resolve` was not mounted.
- therefore `/etc/resolv.conf` was effectively broken in the sandbox.

A direct Bubblewrap experiment preserving the same isolation but adding only a read-only mount of `/run/systemd/resolve` made:

`getent hosts github.com`

succeed immediately.

Conclusion: policy says `unrestricted`, but the sandbox currently omits resolver runtime state required by the host's `/etc/resolv.conf`.

### 4.3 Cargo state is fully ephemeral

`cargo check --workspace --offline` inside trusted failed immediately:

`no matching package named 'serde' found`

This proves the private `HOME=/home/kodegpt` has no persistent Cargo registry/cache/source state between sandbox invocations.

This is not fixed by multi-toolchain mounts, and mounting host `~/.cargo` wholesale is explicitly rejected.

### 4.4 Repository itself is healthy

Host-side baseline:

`pnpm run test`

completed successfully:

- 118 test files passed
- 812 tests passed

Therefore the trusted verification failures are environmental/runtime issues, not a known failing repository baseline.

### 4.5 `package:test` opaque `128`

`verify.run(package:test)` currently starts Vitest and then ends with `exitCode=128` and only a tiny stdout artifact.

Isolation showed:

- `tests/protocol/runtime-schema.test.ts` passed;
- the failure is reached around the framing-parity Rust execution path;
- top-level/nested Cargo visibility itself is no longer missing;
- direct existing Rust example binary can execute successfully;
- Cargo operations that need dependency/index state are still affected by the DNS/cache problem.

Runtime currently maps a signalled child status with:

`status.code().unwrap_or(128)`

in `crates/runtime/src/process.rs`.

Do **not** change diagnostics pre-emptively. First fix the proven resolver/state root causes and rerun. Only add signal diagnostics if a real opaque signalled failure remains afterward.

## 5. Approved Architecture — Design B

### 5.1 Resolver compatibility

Keep Bubblewrap and current namespace/capability isolation.

For `SandboxNetworkMode::Unrestricted` only:

1. continue mounting existing runtime system paths read-only;
2. inspect the host's resolved `/etc/resolv.conf` target;
3. when it resolves beneath the known systemd-resolved runtime directory `/run/systemd/resolve`, open that directory and mount it **read-only** at the same sandbox path;
4. do not mount all of `/run`;
5. do not inherit host environment or PATH;
6. do not change `Deny`, `Localhost`, or `Allowlist` semantics.

The intended current-host result is that `/etc/resolv.conf` remains the host-provided read-only file/symlink from `/etc`, but its referenced runtime resolver file becomes reachable.

If `/etc/resolv.conf` is already self-contained and does not require this runtime directory, no extra mount is necessary.

### 5.2 KodeGPT-owned persistent Cargo state

Create persistent Cargo state under the existing KodeGPT state root, not under host HOME.

Canonical logical location:

`<kodegpt-state-root>/tool-state/cargo-home`

Sandbox location:

`/home/kodegpt/.cargo`

Rules:

- only profile `trusted` may receive this managed Cargo state;
- only when the trusted policy includes the Rust toolchain (`cargo` or `rustc`);
- the directory is created and owned by KodeGPT;
- mount it read/write into the otherwise private `/home/kodegpt`;
- keep `HOME=/home/kodegpt`;
- do not set or inherit host `CARGO_HOME`;
- do not mount host `~/.cargo`;
- do not put GitHub/provider credentials there;
- do not generalize this into a generic dependency-state framework in this phase.

The state may be shared across trusted workspaces under the same KodeGPT state root because it is a dependency/tool cache, not workspace source state. Trusted workspaces already represent explicit local trust.

### 5.3 Runtime plumbing

Reuse existing process and sandbox primitives.

Expected implementation surface:

- `crates/runtime/src/dispatcher.rs`
  - pass the internal KodeGPT state root into process execution plumbing.
- `crates/runtime/src/process.rs`
  - for `ProfileName::Trusted` with Rust allowed, prepare `<state-root>/tool-state/cargo-home`;
  - attach that managed path to `SandboxLaunchSpec`;
  - keep existing auxiliary toolchain resolution/revalidation unchanged.
- `crates/sandbox/src/bubblewrap.rs`
  - add the narrow resolver runtime mount;
  - add the single managed writable Cargo-home mount;
  - preserve `env_clear`, fixed/controlled PATH, private `/tmp`, private HOME base, retained workspace fd mount, capability drop, namespaces, and executable revalidation.

Avoid a new daemon, service, diagnostic subsystem, public MCP tool, generic mount framework, or provider abstraction.

## 6. Security / Boundary Invariants

All of these are hard acceptance requirements:

1. Bubblewrap remains mandatory for process execution.
2. Workspace remains the retained-root `/workspace` boundary.
3. `HOME` remains `/home/kodegpt`.
4. Host PATH is not inherited.
5. Arbitrary host environment is not inherited.
6. Host HOME is not mounted.
7. Host `~/.cargo` is not mounted.
8. `/run` is not mounted wholesale.
9. Resolver state is read-only and narrow.
10. Managed Cargo state is KodeGPT-owned and limited to the Cargo-home directory.
11. `observe` behavior remains unchanged.
12. `develop` behavior remains unchanged.
13. trusted executable resolution and revalidation remain active.
14. cancellation/process-group behavior remains active.
15. durable audit and execution spool/artifacts remain active.
16. no Docker socket, root-host authority, admin authority, or host filesystem root.
17. no new public MCP tool unless separately justified and approved.
18. keep MCP surface `0.10` and 62 public tools if this implementation remains internal.

## 7. Error / Diagnostics Policy

After resolver and Cargo state are implemented:

- rerun `verify.run(cargo:test)`;
- warm the managed Cargo state;
- prove `cargo check --workspace --offline` works after warm-up;
- rerun `verify.run(package:test)`.

If `package:test` now passes, do not modify process result shape.

If an actual signalled process still produces opaque synthetic `128` with insufficient evidence:

1. reproduce it independently;
2. add a focused RED test around signalled-child reporting;
3. improve the existing process operation/spool path only;
4. prefer preserving actual signal information or an actionable diagnostic;
5. do not create a separate verification observability subsystem.

Any such diagnostics work is contingent on fresh evidence after the primary fix.

## 8. Testing Strategy

Use TDD.

### Resolver tests

Add focused Rust tests in `crates/sandbox/src/bubblewrap.rs` covering:

- recognized `/run/systemd/resolve` target classification;
- unrestricted network command includes the narrow read-only resolver mount when required;
- denied network does not gain resolver/network access semantics;
- no broad `/run` bind is introduced;
- existing reserved environment and unsupported network tests remain green.

Live acceptance must additionally prove DNS resolution from a trusted KodeGPT process.

### Managed Cargo-state tests

Add process/sandbox tests proving:

- trusted Rust-capable policy receives the managed Cargo home;
- the managed directory persists across two sandbox invocations;
- a marker written through `/home/kodegpt/.cargo` is visible in a second trusted invocation;
- the host path is under the KodeGPT state root;
- `develop` does not receive the managed Cargo state;
- `observe` remains denied/unchanged;
- HOME/PATH/env sanitization remains enforced;
- Node -> Cargo composition remains healthy.

Prefer fake toolchain/marker fixtures for unit tests so tests do not depend on the internet.

### Live P0 acceptance

Against the rebuilt candidate runtime:

1. `process.run(cargo --version)` -> exit 0.
2. trusted DNS lookup for `github.com` or `index.crates.io` -> succeeds.
3. `verify.run(cargo:test)` -> meaningful deterministic result; expected pass on healthy baseline.
4. immediately run `cargo check --workspace --offline` -> expected pass, proving warm managed cache.
5. `verify.run(package:test)` -> expected pass on current healthy baseline.
6. inspect stdout/stderr/spool/artifact and audit.
7. run cancellation smoke on a benign background process.
8. confirm git working tree has no unexpected mutation.
9. confirm current profile remains `trusted` with `inheritEnv=false`.
10. confirm public surface remains `0.10` / 62 tools.

## 9. P1 — Evidence-Gated Parity Audit

P1 starts only after P0 is proven.

Compare practical workflows, not tool counts:

- workspace inspect/context;
- search/read;
- edit/patch;
- shell/process;
- build/test/typecheck;
- git workflow;
- failure diagnosis;
- cancellation;
- iterative develop -> verify -> inspect loop.

Use CodexPro as the ergonomic comparison and KodeGPT as the dogfood subject.

Record concrete friction and number of unnecessary steps. Prefer fixes to existing primitives.

Do not implement a P1 gap in this phase if it requires:

- a new generic provider framework;
- generic REST/GraphQL;
- generic `skill.run`;
- desktop automation;
- a public tool added only for convenience;
- a new indexing/compiler framework;
- agent orchestration.

If P1 finds a genuinely new behavior requiring design, write a small follow-up spec rather than expanding this P0 design opportunistically.

## 10. Non-Goals

Explicitly out of scope:

- generic `provider.list`;
- generic `provider.tools`;
- generic `provider.invoke`;
- generic GitHub REST/GraphQL;
- generic `skill.run`;
- automatic execution of arbitrary skill prose;
- desktop/computer-use automation;
- Docker socket;
- root/admin authority;
- host filesystem root;
- host HOME;
- arbitrary PATH/env inheritance;
- Tree-sitter/compiler framework;
- persistent repository indexing;
- agent orchestration framework;
- second provider adapter;
- generic dependency-state framework;
- host `~/.cargo` reuse.

## 11. Acceptance Criteria

P0 is complete only with fresh evidence that:

1. trusted `cargo --version` succeeds;
2. trusted DNS works under `unrestricted`;
3. `verify.run(cargo:test)` is deterministic and actionable;
4. managed Cargo state persists;
5. warm `cargo check --workspace --offline` succeeds;
6. `verify.run(package:test)` passes on the current healthy baseline, or exposes a genuine actionable repository failure;
7. nested Node -> Rust works;
8. host PATH is not inherited;
9. arbitrary host env is not inherited;
10. host HOME is not mounted;
11. host `~/.cargo` is not mounted;
12. Bubblewrap remains active;
13. workspace retained-root remains active;
14. `observe` and `develop` remain unchanged;
15. cancellation/audit/spooling remain correct;
16. no unnecessary public surface addition;
17. runtime/protocol/surface stay `0.1 / 2026-07-28 / 0.10` unless a separately justified contract change is required;
18. full deterministic repository gates pass before merge;
19. merged-main runtime is rebuilt/staged and explicitly cut over because this phase changes production Rust source;
20. live post-cutover smoke re-proves the key P0 checks.
