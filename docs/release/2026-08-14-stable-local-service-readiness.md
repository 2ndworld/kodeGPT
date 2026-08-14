# Stable Local Service & Managed Exposure Lifecycle — Candidate Readiness

Status date: 2026-08-14
Branch: `feat/stable-local-service-lifecycle`
Status: local implementation, exact source-head candidate verification through `9a3b27c5e8a79b95aa17df9769d2464a8a9347d4`, real systemd migration/upgrade/stop-start acceptance, installed-path provenance proof, and bounded ChatGPT smoke PASS. Final documentation-head verification, push/CI, final diff review, and PR preparation remain gated below.

## Scope

This phase adds a Linux user-systemd lifecycle around the existing managed-zrok foreground architecture. It does **not** change MCP tool names/input schemas, protocol `2026-07-28`, or semantic surface `0.3`.

The installed-service ownership chain is:

```text
systemd --user
  -> installed KodeGPT CLI foreground process
     -> loopback KodeGPT MCP/HTTP server
     -> packaged Rust runtime
     -> managed zrok2 share
```

systemd owns the outer service only. KodeGPT remains the single supervisor for Rust and zrok children.

## Implemented local operator surface

```text
kodegpt service install --name <namespace:name> [--port <port>] [--state-root <path>]
kodegpt service start [--state-root <path>]
kodegpt service stop [--state-root <path>]
kodegpt service restart [--state-root <path>]
kodegpt service status [--json] [--state-root <path>]
kodegpt service uninstall [--state-root <path>]
```

A hidden `service run` entrypoint exists only for the generated user unit. It is not shown in normal CLI help and is not an MCP tool.

## Installed release identity

`service install` snapshots the exact bundled CLI, packaged Rust runtime, and required YAML dependency into an immutable release under the user's service data root outside the repository/worktree. Release identity is derived from the CLI package version plus SHA-256 identities of the CLI bundle and Rust runtime. Existing immutable releases are verified rather than silently overwritten.

Machine-local schema-1 service metadata tracks active, staged, and rollback release identities. General KodeGPT state remains under `~/.kodegpt`.

## systemd contract

The generated user unit uses:

- `Type=simple`;
- one direct Node/installed-CLI `ExecStart`;
- `Restart=on-failure`;
- `RestartSec=5s`;
- `StartLimitIntervalSec=60` and `StartLimitBurst=5`;
- `KillSignal=SIGTERM` with `KillMode=mixed`, so graceful SIGTERM goes to the KodeGPT supervisor first while systemd retains cgroup SIGKILL authority if shutdown exceeds the bounded timeout;
- an explicit runtime PATH plus production NODE_ENV;
- no shell wrapper and no product PID file.

KodeGPT enables/disables the user unit but does not change systemd linger automatically.

## Managed zrok and credential semantics

Service mode composes the existing managed-zrok implementation. It preserves:

- loopback-only KodeGPT listener;
- zrok public share targeting `http://127.0.0.1:<port>`;
- `--force-local` and `backend-mode proxy` semantics;
- exact reserved-name validation;
- structured readiness and raw-zrok redaction;
- query connector compatibility already used by the existing ChatGPT connection.

Service-mode start/restart requires an existing connector credential. It does not create, rotate, or re-emit a connector credential. KodeGPT does not own zrok account credentials.

## Crash/recovery and cutover

- Unexpected zrok exit fails the outer managed exposure and closes the local stack.
- Unexpected Rust runtime exit now produces an explicit one-shot `RUNTIME_UNAVAILABLE` termination signal through the foreground stack so the outer service fails and systemd can apply its bounded restart policy.
- `service install` stages a new release without stopping a currently active service.
- `service restart` with a staged candidate rewrites the unit to that candidate, waits for correlated systemd MainPID + release readiness, and promotes only after readiness succeeds.
- Failed staged readiness performs exactly one rollback attempt to the prior active installed release. There is no KodeGPT-owned infinite restart loop.
- Release cleanup preserves active, staged, and immediate rollback releases and deletes only obsolete service-owned release directories after validating ownership boundaries.

## Sanitized status

Machine-local `service status` can report installed/running/enabled/linger state, release identity, package/runtime/protocol/surface identity when ready, local port, reserved zrok name, public endpoint, and bounded manager failure result. It does not report connector tokens/verifiers, zrok account secrets, raw zrok JSON, or sensitive environment.

## Deterministic evidence already observed

Focused TDD cycles observed RED before production implementation for parser/version, immutable release/metadata, systemd unit/install, readiness/lifecycle, managed service-run exposure, crash/rollback, cleanup, production package wiring, and integration lifecycle behaviors.

Fresh green evidence observed during implementation and exact source-head verification includes:

- CLI package focused suite: 85/85 tests green after the final systemd acceptance regressions;
- core focused suite: 17/17 tests green after unexpected Rust termination signaling;
- exact source/runtime head `e66337f0b59ffa11577b13922481dca8d787d095` passed frozen install, `cargo fmt --check`, workspace typecheck/build, and full `pnpm test` at 82 files / 430 tests;
- `cargo test -p kodegpt-sandbox`: 7/7 PASS;
- `pnpm test:rust`: complete Rust workspace PASS, including 44 runtime tests and 47 workspace-I/O tests;
- `pnpm test:protocol`: 2 files / 11 tests PASS;
- `pnpm test:integration`: 13 files / 33 tests PASS;
- `pnpm test:security`: 12 files / 39 tests PASS;
- `pnpm test:isolation`: 1 file / 3 tests PASS;
- `pnpm test:acceptance`: 2 files / 5 tests PASS;
- `pnpm verify:forbidden`: PASS;
- `pnpm verify:package`: PASS with clean-prefix CLI/runtime tarball installation, service release re-snapshot outside both source checkout and package prefix, Rust checksum match, fake-manager service status, and clean uninstall;
- `pnpm bench:baseline`: PASS under the record-only policy and recorded exact source/runtime head `e66337f0b59ffa11577b13922481dca8d787d095`;
- passive Pranikah before/after guard: `guard unchanged`.

After the final staged-activation regression fix, exact source head `9a3b27c5e8a79b95aa17df9769d2464a8a9347d4` repeated the complete candidate command gate successfully: frozen install, Rust format, typecheck, build, full TypeScript suite at 82 files / 433 tests, sandbox functional tests, complete Rust workspace, protocol 11/11, integration 33/33, security 39/39, isolation 3/3, acceptance 5/5, forbidden scan, clean-prefix package smoke, and record-only benchmark. The benchmark recorded that exact Git head, and the passive Pranikah before/after comparison again returned `guard unchanged`.

The exact final documentation head created after recording real acceptance must repeat the candidate gate before push so CI and local final evidence refer to the same Git SHA.

## Real local service and ChatGPT acceptance

Real acceptance was performed against the same source/runtime tree as `e66337f0b59ffa11577b13922481dca8d787d095` while the historical canonical-main foreground exposure was initially still live.

Acceptance/final-gate verification found four concrete lifecycle defects and fixed each with regression coverage before continuing:

1. A detached operator shell had neither `XDG_RUNTIME_DIR` nor `DBUS_SESSION_BUS_ADDRESS` even though the user manager and `/run/user/<uid>/bus` existed. `systemctl --user` therefore failed with `No medium found`. The service-manager runner now recovers the canonical current-user bus environment only when the variables are missing and the current-user bus socket is actually present; explicit operator/session values remain authoritative.
2. `WorkingDirectory="..."` was rejected by the real systemd parser as a non-absolute path because the quotes were treated as literal directive content. The unit now uses directive-safe absolute-path escaping, including `\\x20` for spaces and `%%` for systemd percent escaping. `systemd-analyze --user verify` and real `LoadState=loaded` then passed.
3. `KillMode=control-group` caused a normal service stop to signal the Rust/zrok children concurrently with the Node supervisor, allowing the runtime death to look unexpected and yielding systemd `Result=exit-code`. The unit now uses `KillMode=mixed`: SIGTERM reaches the Node supervisor first so KodeGPT performs its established graceful child shutdown, while systemd retains bounded cgroup SIGKILL cleanup after timeout. Real `service stop` subsequently reported `state=stopped`, `MainPID=0`, `Result=success`, and no failure summary.
4. A staged upgrade previously rewrote and daemon-reloaded the user unit during `service install` even while release A remained active. That meant a later systemd restart/crash before the explicit operator cutover boundary could start staged release B prematurely. The final regression fix keeps the loaded/unit-file release on A while B is only staged, then switches the unit only at explicit `service start`/`service restart`; staged `start` also uses the same one-step rollback behavior as staged `restart`. Unit and packaged integration tests lock this boundary.

After those fixes and exact source-head verification:

- the candidate was staged while the old canonical-main foreground Node/Rust/zrok tree remained running;
- the old exact foreground supervisor was terminated with SIGTERM and all three historical PIDs exited before managed service activation;
- the first installed service started successfully under `systemd --user` and reused the existing connector credential without re-emission;
- the generated unit passed `systemd-analyze --user verify` and contained no repository/worktree path;
- systemd MainPID CWD and CLI argv resolved under the immutable installed service release root;
- the Rust runtime executable resolved under that same installed release root;
- zrok remained a direct child of the KodeGPT supervisor with `share public http://127.0.0.1:43121 --headless --force-local --backend-mode proxy -n public:kodegpt-dev`;
- a second source-equivalent installed release was staged while release A remained healthy, then `service restart` promoted release B, retained A as rollback, changed MainPID, and left systemd `Result=success`;
- obsolete release cleanup left only the active and immediate rollback release directories;
- a real managed `service stop` followed by `service start` passed cleanly and left the service running;
- final process inspection found no `.worktrees` or canonical repository path in the running CLI/child command lines or service CWD.

After defect 4 was committed as `9a3b27c`, a second real staged cutover proved the corrected boundary against the live service: release `rel_58d7fd8c090c97616852f4d4888d671a` remained active with the same running Node/Rust/zrok process tree while `rel_b5c0aa12cf67ec805540a440a050f16a` was only staged; explicit `service restart` then promoted `rel_b5c0aa12cf67ec805540a440a050f16a` and retained the former release as rollback. The new MainPID, Rust executable, and service CWD all resolve under the immutable installed release root, while zrok remains a direct child targeting loopback port 43121 with reserved name `public:kodegpt-dev`. No repository or feature-worktree path is required by the running service.

Bounded actual ChatGPT smoke after the final managed service start PASS:

```text
system.health:
  ok = true
  auditHealthy = true
  filesystemBoundaryAvailable = true
  testMethods = false

system.capabilities:
  runtimeVersion = 0.1
  mcpProtocolVersion = 2026-07-28
  mcpSurfaceVersion = 0.3
  filesystemBoundaryAvailable = true

skill.list compatibility=NATIVE:
  native-host-acceptance returned
  classification = NATIVE
```

No ChatGPT action refresh/reinstall was performed because this phase did not change the MCP semantic contract.

## Explicit authority exclusions

Automated security inventory continues to require absence of:

```text
skill.run
provider.list
provider.tools
provider.invoke
service.install/start/stop/restart/uninstall as MCP tools
workspace trust mutation over MCP
generic shell authority
Codex/Claude/provider-agent execution
```

Rust remains final OS/security authority. Provider interoperability is **NOT STARTED**.

## Remaining gates

Local runtime acceptance is complete on source head `9a3b27c`. Before PR preparation, the remaining gates are limited to final exact-documentation identity and remote integration readiness:

1. commit this acceptance evidence and require a clean final feature head;
2. repeat the complete candidate command gate from `docs/release/v0.1-checklist.md` on that exact final documentation SHA;
3. repeat the passive protected-repository before/after guard on that same SHA;
4. perform a comprehensive security/architecture review plus the complete `main...feature` and `origin/main...feature` diff review;
5. push the exact candidate branch without force;
6. require CI success for that exact pushed SHA;
7. review the final remote diff/CI evidence and prepare a PR only if every gate remains green.

Do not merge automatically.

The first migration from the historical foreground operational bridge is now completed evidence rather than a pending procedure. Its emergency rollback would have been the previously verified canonical-main foreground `kodegpt expose zrok --name public:kodegpt-dev` process using unchanged connector state. The managed service is now active, so future staged upgrades use the built-in one-step installed-release rollback contract.

## v0.1 tag

Historical tag `v0.1` is outside this phase and must remain untouched.
