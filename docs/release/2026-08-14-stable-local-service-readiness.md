# Stable Local Service & Managed Exposure Lifecycle — Candidate Readiness

Status date: 2026-08-14
Branch: `feat/stable-local-service-lifecycle`
Status: implementation complete through deterministic focused/package/security gates; exact final candidate matrix, real host cutover, ChatGPT smoke, push/CI, and PR preparation remain gated below.

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
- `KillSignal=SIGTERM` and cgroup shutdown;
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

Fresh green evidence observed during implementation includes:

- CLI package focused suite: up to 84/84 tests green after service lifecycle/cutover work;
- core focused suite: 17/17 tests green after unexpected Rust termination signaling;
- `pnpm test:security`: 12 files / 39 tests PASS;
- `pnpm test:integration`: 13 files / 33 tests PASS;
- `pnpm --filter kodegpt build`: PASS;
- `pnpm verify:forbidden`: PASS;
- `pnpm verify:package`: PASS with clean-prefix CLI/runtime tarball installation, service release re-snapshot outside both source checkout and package prefix, Rust checksum match, fake-manager service status, and clean uninstall.

These focused/package results are implementation evidence, not a substitute for the exact final candidate matrix below.

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

Before PR preparation, all of the following remain required on the final exact candidate SHA:

1. clean working tree and exact candidate identity recorded;
2. complete candidate command gate from `docs/release/v0.1-checklist.md`;
3. passive protected-repository isolation evidence required by the release checklist;
4. comprehensive security/architecture review and full `main...feature` diff review;
5. install the exact candidate release while the old foreground `main` exposure remains live;
6. gracefully stop the exact old foreground supervisor and prove its Rust/zrok children exit;
7. activate the installed candidate through real `systemd --user`;
8. prove the outer CLI and Rust runtime paths resolve under the installed service release and no running path references the feature worktree;
9. verify zrok still targets loopback and uses the expected reserved name without credential rotation/re-emission;
10. actual ChatGPT bounded smoke: `system.health`, `system.capabilities`, and `skill.list compatibility=NATIVE` with runtime `0.1`, protocol `2026-07-28`, surface `0.3`;
11. push the exact candidate, require CI success for that SHA, and review the final remote diff;
12. prepare a PR only after all gates above pass. Do not merge automatically.

The first migration from the historical foreground operational bridge cannot use installed-release rollback until the first managed release is active. If that initial activation fails after the old foreground process has been stopped, the operational rollback is to restart the previously verified canonical-main foreground `kodegpt expose zrok --name public:kodegpt-dev` process using the unchanged connector state. Once the first managed release is active, subsequent staged upgrades use the built-in one-step installed-release rollback contract.

## v0.1 tag

Historical tag `v0.1` is outside this phase and must remain untouched.
