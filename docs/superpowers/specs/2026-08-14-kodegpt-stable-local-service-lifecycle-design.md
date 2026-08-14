# KodeGPT Stable Local Service & Managed Exposure Lifecycle — Design

Status: Approved for implementation from the post-PR #6 baseline on 2026-08-14.

## 1. Goal

Make the local KodeGPT + managed zrok lifecycle independent from a foreground shell and from any repository checkout or feature worktree, while preserving the existing security architecture and MCP semantic surface.

The supported operational shape becomes:

```text
systemd --user
  -> one foreground installed KodeGPT CLI process
     -> KodeGPT HTTP/MCP loopback listener
     -> one packaged Rust runtime child
     -> one managed zrok2 child
```

systemd owns only the outer service process. KodeGPT continues to own the Rust and zrok child lifecycles. There is no second KodeGPT daemon loop and no PID-file supervisor.

## 2. Baseline evidence

The design is based on the actual post-PR #6 state rather than the historical handoff alone:

- `main == origin/main == 13f791eb4faa5ef9e50cafa1ac84fe4906ca7212` at the initial audit;
- working tree clean, one worktree, no stash;
- `v0.1` remains at historical commit `b8eae12cea3be002a9a61d06cecfd34f86283eb4`;
- live supervisor CWD is `/home/sauron/dev/kodegpt`, not a feature worktree;
- live Rust runtime is the canonical packaged runtime path under that checkout;
- live zrok target is loopback `127.0.0.1:43121` with reserved name `public:kodegpt-dev`;
- actual host health is green and reports runtime `0.1`, protocol `2026-07-28`, surface `0.3`;
- Linux user systemd is available (`systemd 255` in the audited environment);
- the audited user has `Linger=no`.

The current CLI already gives `kodegpt expose zrok` correct foreground ownership of the local server, Rust runtime, zrok child, shutdown ordering, reserved-name validation, readiness polling, and one-time connector credential behavior. The service phase must reuse that ownership rather than replacing it.

## 3. Non-goals and hard boundaries

This phase does not add or authorize:

- `skill.run`;
- `provider.list`, `provider.tools`, or `provider.invoke`;
- provider-agent/Codex/Claude execution;
- generic shell execution;
- generic tunnel/provider abstraction;
- MCP workspace trust, skill source, skill pin, or service lifecycle mutation;
- desktop/computer-use authority;
- a different KodeGPT state root;
- connector or zrok credential rotation during ordinary restart/upgrade;
- zrok account credential ownership by KodeGPT;
- movement, recreation, or deletion of tag `v0.1`.

Rust remains the final OS/security authority. Service management is machine-local operator control only.

## 4. Alternatives considered

### A. systemd user service + immutable installed release snapshot — selected

A user unit runs one foreground installed KodeGPT release. `kodegpt expose zrok` remains the child supervisor. A service install materializes an immutable release snapshot outside the repository and the unit points to that release.

Advantages:

- no root daemon is required;
- shell closure no longer terminates KodeGPT;
- repository/worktree cleanup cannot invalidate the running executable;
- systemd supplies bounded restart/start-limit semantics, journaling, state, and stale-process ownership;
- existing KodeGPT shutdown semantics remain authoritative for Rust/zrok children.

### B. systemd user service pointing at the invoking checkout — rejected

This removes the foreground-shell dependency but preserves the worktree/checkout dependency. It fails the primary cutover and provenance requirement.

### C. PID file, `start-stop-daemon`, or a KodeGPT-owned daemon loop — rejected

This would duplicate process ownership, add stale-PID/reaping/backoff logic, and make system integration harder to audit. `start-stop-daemon` remains an operational bridge only, not product architecture.

## 5. Installed release model

### 5.1 Layout

Service-owned release artifacts live outside the Git checkout, under a user-owned data directory:

```text
~/.local/share/kodegpt/service/
  releases/
    <release-id>/
      bin/kodegpt.mjs
      node_modules/
        @kodegpt/runtime-linux-x64/
          package.json
          bin/kodegpt-runtime
        yaml/
          ...
```

The application state root remains exactly:

```text
~/.kodegpt
```

Service metadata is local operator state beneath that existing state root, not a new public/MCP state surface.

### 5.2 Release identity

A release identity is derived from stable local artifacts, not from a mutable checkout path. The initial contract records:

- CLI package version (`0.1.0` on this baseline);
- runtime package identity (`@kodegpt/runtime-linux-x64`);
- CLI bundle SHA-256;
- Rust runtime SHA-256;
- release ID derived from package version plus the artifact digests;
- absolute installed release path in machine-local metadata;
- absolute Node executable used by the unit in machine-local metadata.

A source Git commit may be recorded only when supplied by a build contract later. This phase does not spawn arbitrary Git commands from product code merely to infer provenance.

Machine-local `service status` may expose installed paths/digests because it is an operator command. MCP must not expose them.

### 5.3 Snapshot construction

`service install` snapshots the exact currently executing bundled CLI, the exact runtime package resolved by the existing runtime resolver, and the CLI's required `yaml` package into a new immutable release directory. It does not point the service unit at `apps/cli`, `packages/runtime-linux-x64`, `.worktrees`, or a mutable repository path.

An existing release directory with the same identity must be verified rather than overwritten silently. Hash mismatch is a hard failure.

## 6. Service manager contract

### 6.1 Supported manager

The v0.1 service manager is Linux `systemd --user` only. This matches the current Linux/x64 packaged-runtime scope and the audited environment.

KodeGPT must fail closed with a clear local error when user systemd is unavailable. It must not silently fall back to a home-grown daemon.

### 6.2 Unit ownership

Canonical user unit:

```text
~/.config/systemd/user/kodegpt.service
```

The unit uses:

- `Type=simple`;
- one `ExecStart` for the installed KodeGPT CLI;
- `kodegpt expose zrok --name <reserved-name> --port <port>`;
- `Restart=on-failure`;
- bounded restart delay and start limits;
- normal SIGTERM shutdown;
- no shell;
- a minimal, explicit PATH sufficient for the captured Node executable and resolved `zrok2` executable plus standard system paths;
- `NODE_ENV=production`;
- the user's normal home for KodeGPT/zrok configuration.

The unit must not contain connector credentials, connector verifiers, zrok account credentials, or raw zrok JSON.

### 6.3 Linger and reboot behavior

`service install` may enable the user unit for the user's default target, but it must not change systemd linger automatically.

Therefore:

- the service is independent of the shell that installed/started it;
- with normal user-manager behavior it can start automatically when the user session/user manager starts;
- boot-before-login persistence requires the operator to enable linger separately if desired;
- status may report that linger is disabled as an informational operator fact, but KodeGPT does not mutate it.

This avoids an unexpected host-level policy change during a product install.

## 7. Local CLI contract

The first-class local-only surface is:

```text
kodegpt service install --name <namespace:name> [--port <port>] [--state-root <path>]
kodegpt service start [--state-root <path>]
kodegpt service stop [--state-root <path>]
kodegpt service restart [--state-root <path>]
kodegpt service status [--json] [--state-root <path>]
kodegpt service uninstall [--state-root <path>]
```

The default state root remains `~/.kodegpt`; the default port remains the existing `43121`. Initial acceptance uses the existing reserved name `public:kodegpt-dev`.

These commands are not registered as MCP tools.

### 7.1 Install

`install`:

1. validates platform/user-systemd availability;
2. validates the reserved zrok name syntax using the same bounded contract as managed exposure;
3. resolves the exact current CLI/runtime/dependency artifacts;
4. resolves `zrok2` without a shell;
5. materializes and verifies an immutable release snapshot;
6. writes sanitized service metadata atomically;
7. writes the user unit atomically;
8. runs user `daemon-reload` and enables the unit without starting it;
9. records the new release as staged.

If a service is already running, installing a new release must not kill or replace the running process. The old process continues until explicit `start`/`restart` activation.

### 7.2 Start

`start` starts the configured/staged release, waits for bounded local readiness, then records that release as active. When a previous active release exists and the staged candidate fails readiness, activation restores the prior unit/release and attempts one bounded rollback start.

### 7.3 Stop

`stop` asks systemd to stop the unit. systemd sends SIGTERM to the KodeGPT supervisor; existing KodeGPT shutdown closes zrok and the local stack/Rust runtime. No connector credential is rotated or printed.

### 7.4 Restart

`restart` is the controlled cutover primitive:

- without a staged release, it performs a bounded restart of the current active release;
- with a staged release, it gracefully stops the old service, starts the staged unit, performs readiness verification, promotes it on success, and rolls back to the previous release on failed startup/readiness.

There is no infinite retry loop in KodeGPT. systemd's bounded restart policy remains the steady-state crash policy.

### 7.5 Status

`status` normalizes manager/service facts into a sanitized local structure. It should report when available:

```text
installed / not-installed
running / stopped / failed / activating / unknown
unit enabled state
CLI package version
release ID and artifact digests (local-only)
runtime package identity
active release vs staged release
local listener port/readiness
managed exposure enabled
reserved zrok name
public endpoint hostname/URL when known
last bounded failure summary
linger enabled/disabled/unknown
```

Status must not emit:

- connector token;
- connector verifier;
- zrok account credential;
- raw zrok JSON;
- sensitive environment;
- raw journal output;
- unnecessary KodeGPT state-root path.

Human output is concise. `--json` is intended for deterministic local/operator tests and automation and follows the same redaction boundary.

### 7.6 Uninstall

`uninstall` stops and disables the service, removes the KodeGPT user unit, reloads the user manager, and removes service-owned release snapshots/metadata only after the service is no longer running.

It does **not** delete the general `~/.kodegpt` state, workspace trust, skill state, audit history, connector credential/verifier, or zrok account configuration.

## 8. Managed zrok semantics

The service preserves the existing managed exposure contract rather than generalizing it:

- only `zrok` is supported;
- target remains `http://127.0.0.1:<port>`;
- `--force-local` remains mandatory;
- `backend-mode` remains `proxy`;
- the configured reserved name is exact and validated;
- the current query credential compatibility remains supported;
- an existing connector credential is reused on restart/upgrade;
- a connector credential is created only by the existing first-run exposure flow when absent;
- no credential is re-emitted by service start/restart/status;
- zrok account login/config remains external to KodeGPT.

Service metadata stores only sanitized exposure identity (reserved name, port, public hostname/URL when known).

## 9. Crash, stale state, and recovery

### 9.1 Outer KodeGPT crash

systemd observes non-zero termination and applies `Restart=on-failure` with a bounded delay plus `StartLimitIntervalSec`/`StartLimitBurst`. Repeated failure becomes a stable failed state visible through `service status`.

### 9.2 zrok crash

The existing `expose zrok` termination promise closes the local KodeGPT stack and makes the CLI fail. systemd then applies the bounded outer restart policy.

### 9.3 Rust runtime crash

The runtime client already poisons subsequent operations when the Rust process exits. During implementation, an integration test must determine whether the foreground supervisor reliably terminates after an unexpected Rust exit. If it does not, the smallest explicit liveness propagation should be added so the outer service fails and systemd can restart it. This must not move OS/security authority out of Rust.

### 9.4 Port conflict or failed readiness

The candidate service fails startup/readiness. During a staged cutover, KodeGPT restores the prior unit and attempts one rollback start. Normal service restarts remain bounded by systemd start limits.

### 9.5 Stale PID/orphan handling

KodeGPT does not maintain a product PID file. systemd's unit cgroup/MainPID is authoritative for service ownership. Stop/restart operate on the unit rather than guessed PIDs. An orphan outside the unit is reported only when it creates a concrete conflict (for example port ownership); KodeGPT does not kill unrelated processes by pattern.

## 10. Upgrade and cutover

The supported release-A to candidate-B sequence is:

```text
build/package candidate B
  -> run deterministic candidate verification
  -> invoke candidate `kodegpt service install ...` to snapshot B
  -> verify staged identity/status while release A keeps running
  -> `kodegpt service restart`
     -> graceful SIGTERM of A
     -> start B
     -> bounded local readiness/identity check
     -> promote B on success
     -> otherwise restore A unit and attempt one rollback start
  -> ChatGPT smoke (`system.health`, `system.capabilities`, native skill filter)
  -> prove service ExecStart/release metadata no longer references the candidate worktree
  -> feature worktree may then be removed safely
```

Installed release snapshots intentionally remain outside the feature worktree. Cleanup of superseded release snapshots is bounded and never removes the active, staged, or immediate rollback release.

## 11. Security and authority review

The service phase preserves these invariants:

- Rust remains final OS/security authority for workspace/process effects;
- service commands are local CLI operations only;
- MCP cannot install/start/stop/restart/uninstall the service;
- workspace trust stays local-only;
- no new user process capability is granted;
- no generic shell is introduced;
- service-manager invocations use direct argv with `shell: false`;
- managed exposure keeps loopback-only local binding and zrok `--force-local`;
- connector/zrok secrets are never written to unit files or service status;
- normal restart/cutover reuses the existing connector verifier/credential state;
- audit-before-effect semantics inside KodeGPT are unchanged;
- MCP protocol `2026-07-28` and semantic surface `0.3` remain unchanged unless a separate semantic contract change is later justified.

## 12. Testing strategy

### 12.1 Unit

Cover:

- service CLI parsing and help;
- service metadata schema/atomic updates;
- release identity/hash computation;
- immutable release verification;
- systemd unit generation/escaping;
- environment sanitization;
- normalized service status;
- secret redaction;
- restart/start-limit policy;
- staged/active/rollback transitions;
- unsupported-platform/manager failure;
- stale/missing metadata handling.

### 12.2 Integration

Use fake service-manager and fake zrok fixtures for deterministic CI:

- install -> start -> ready -> status -> stop -> restart -> uninstall;
- managed zrok argv remains loopback-only/`--force-local`/exact-name;
- Rust lifecycle follows outer service lifecycle;
- zrok crash closes children and yields an outer failure;
- runtime crash behavior is explicitly tested;
- port conflict/startup failure rolls back a staged candidate;
- existing connector verifier is reused;
- token is never re-emitted in status/restart output;
- child shutdown is clean.

Real `systemctl --user` and real zrok are acceptance-only, not deterministic CI dependencies.

### 12.3 Package

Extend package smoke to prove that a clean-prefix installed CLI can create/verify a service release snapshot whose CLI and Rust runtime resolve wholly outside the repository checkout. Deterministic package tests must use a fake service manager rather than modifying the developer's real user unit.

### 12.4 Security

Keep explicit assertions that the real MCP inventory contains no:

```text
skill.run
provider.list
provider.tools
provider.invoke
workspace trust mutation
service lifecycle mutation
generic shell
```

Also assert that service status/unit/metadata contain no connector token/verifier, zrok account secret, or raw zrok status payload.

## 13. Verification matrix rationalization

Do not remove substantive gates. Document three intent levels instead:

- **Focused development gate:** changed package/unit/integration tests plus forbidden scan as applicable.
- **Candidate gate:** full TypeScript tests/typecheck/build, protocol/integration/security/isolation/acceptance, Rust workspace tests, package smoke, forbidden scan, and required sandbox evidence.
- **Final release/integration gate:** candidate gate on exact final SHA plus CI, final diff review, real local service cutover, and minimal ChatGPT host smoke.

A focused suite may overlap `pnpm test`; the duplicate run is justified only when it represents a distinct named gate (fast development feedback versus exact final candidate/release evidence). No security coverage is removed merely to optimize elapsed time.

## 14. Acceptance target

The phase is accepted only when:

- an installed service release has no runtime path dependency on a Git feature worktree;
- install/start/stop/restart/status/uninstall are deterministic and tested;
- systemd owns the outer foreground KodeGPT service and KodeGPT owns Rust/zrok children;
- managed exposure remains `public:kodegpt-dev`, loopback upstream only, credential-safe, and healthy;
- controlled candidate cutover and one-step rollback are tested;
- actual local service acceptance passes on the development host;
- ChatGPT still reports runtime `0.1`, protocol `2026-07-28`, surface `0.3` and green health;
- provider interoperability remains unimplemented;
- `skill.run` and provider tools remain absent;
- `v0.1` remains untouched.
