# KodeGPT Trusted Process Policy v2 Design

Date: 2026-08-17
Status: approved for implementation

## Goal

Make the `trusted` workspace profile substantially more flexible for KodeGPT's personal-use workflow without turning KodeGPT into an unsandboxed host shell.

The accepted behavior is a trusted-shell escape hatch: `process.run` may launch trusted system `bash` or `sh`; once inside that shell, the command may invoke normal workspace/system commands without requiring each nested command to appear in KodeGPT's top-level executable allowlist.

## Scope

This change applies only to the built-in `trusted` profile.

`observe` and `develop` remain conservative and keep their current process policies. They do not gain `bash` or `sh`.

No new public MCP tool is added. `process.run`, `process.status`, and `process.cancel` remain the public process surface.

No new generic host-shell tool, raw PID/PGID authority, or per-command approval workflow is introduced.

## Trusted Profile Behavior

The built-in `trusted` preset keeps:

- `allowWrite: true`;
- `allowProcess: true`;
- `network: "unrestricted"`;
- `inheritEnv: false`;
- the current explicit environment allowlist;
- the current directly allowed toolchain executables.

It additionally allows the logical executables:

- `bash`;
- `sh`.

Top-level `process.run` still validates its own `logicalExecutable` against `allowedExecutableNames`. The flexibility comes from allowing a trusted shell itself: commands launched *inside* that shell are normal child processes in the existing Bubblewrap sandbox and are not individually revalidated against KodeGPT's top-level executable allowlist.

Example intended use:

```text
process.run(logicalExecutable="bash", argv=["-lc", "git status && ./scripts/check.sh"])
```

## Sandbox and Authority Boundaries

Trusted shell execution must continue to use the existing Rust process path:

`process.run` -> runtime policy validation -> trusted executable resolution -> `BubblewrapProvider` -> retained-root workspace mount -> process registry/spool/audit lifecycle.

The trusted shell does **not** gain automatic host authority outside that sandbox.

The following remain unchanged:

- workspace is mounted at `/workspace` from the retained workspace root FD;
- trusted workspaces receive read-write workspace access because `allowWrite=true`;
- system runtime paths are read-only inside Bubblewrap;
- child `HOME` remains the private `/home/kodegpt` sandbox home;
- child `PATH` remains controlled by KodeGPT rather than inherited from the host user;
- process environment remains cleared and rebuilt from KodeGPT policy;
- `$HOME`, arbitrary host filesystem paths, KodeGPT state, Docker socket, host devices, and host-admin authority are not automatically exposed;
- unrestricted network mode continues to share the host network namespace for the trusted profile;
- process status/cancel continue to use opaque operation IDs and process-group cancellation;
- durable audit decision/outcome semantics remain unchanged.

## Executable Trust

`bash` and `sh` themselves must pass the existing `resolve_trusted_executable` rules before spawn. KodeGPT must not resolve the top-level shell from workspace-controlled `PATH`.

The existing trusted executable identity/revalidation rules remain authoritative. No weakening of root ownership, group/world-write checks, set-id rejection, location checks, or pre-spawn revalidation is part of this change.

Nested commands are resolved by the shell within the sandbox's controlled filesystem and `PATH`. This is the intentional high-agency behavior for `trusted` only.

## Structured Tools

Structured KodeGPT capabilities remain available and are still the preferred deterministic interface when they fit:

- structured Git tools;
- verification recipes;
- typed GitHub read/write tools.

Trusted shell is an escape hatch for workflows that would otherwise require expanding KodeGPT's executable allowlist one binary at a time. It is not a replacement for those structured tools and does not remove their independent safety contracts.

## Compatibility and Versioning

This is an additive policy change to the existing `trusted` preset and existing `process.run` semantics.

- No runtime protocol schema change is required.
- No public tool is added or removed.
- No MCP surface-version bump is required solely for this change.
- Existing project-level monotonic restriction semantics remain unchanged: project policy may narrow the trusted preset but may not widen a narrower effective policy.

## Test Strategy

Implementation must be test-first and prove all of the following:

1. the built-in `trusted` profile includes `bash` and `sh`;
2. `observe` and `develop` do not include either shell;
3. a trusted policy accepts `bash`/`sh` as top-level `process.run` executables;
4. a develop policy still denies them;
5. a real sandboxed trusted shell can invoke a nested system executable that is **not** in the top-level allowlist;
6. the same shell can read/write the retained trusted workspace;
7. the shell still cannot see a deliberately created host path outside the workspace/state mounts;
8. the sandbox still supplies private `HOME` and controlled `PATH` rather than the host user's values;
9. existing process cancellation, audit, source-regression, profile monotonicity, and broader security tests remain green.

## Non-Goals

Trusted Process Policy v2 does not add:

- automatic access to the host user's home directory;
- writable host root mounts;
- `/var/run/docker.sock` or equivalent container-engine authority;
- arbitrary host device access;
- sudo/root-host escalation;
- host environment inheritance;
- a new `shell.run` MCP tool;
- a public raw Git/REST/GraphQL provider API;
- per-command confirmation prompts;
- changes to `observe` or `develop` policy philosophy.
