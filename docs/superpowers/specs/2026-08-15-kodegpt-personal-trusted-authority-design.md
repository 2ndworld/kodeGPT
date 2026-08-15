# KodeGPT Personal Trusted Authority — Design

Date: 2026-08-15
Status: approved design; implementation not started
Baseline: canonical `main`, MCP surface `0.4`

## 1. Goal

Make KodeGPT comfortable for daily personal development directly from ChatGPT without repeatedly returning to a local CLI for workspace trust or routine development authority.

Primary UX principle:

> **trusted means trusted**

Once the user explicitly trusts a workspace, KodeGPT should have enough authority for ordinary end-to-end software development without per-capability grant choreography or repeated permission prompts.

The intended experience is **CodexPro-like daily ergonomics with KodeGPT's durable security and provenance underneath**.

## 2. Scope

This phase adds only the authority needed for normal personal development:

- ChatGPT-managed workspace trust and profile selection;
- high-agency trusted process/toolchain behavior;
- structured local Git mutation;
- structured remote Git workflow;
- audit, surface/version reconciliation, and release closure.

This phase does **not** add:

- granular per-capability grants for routine trusted use;
- a separate Personal Admin Mode toggle;
- arbitrary raw Git argv;
- generic host-wide shell as the normal interface;
- implicit filesystem authority outside the trusted workspace;
- provider interoperability;
- credential disclosure or root/system administration.

## 3. User-facing authority model

Keep the existing three profiles.

### `observe`

Read-only inspection. No workspace mutation, process execution, network mutation, or Git mutation.

### `develop`

Conservative local development for users who want tighter defaults. Existing bounded development behavior remains the baseline unless fresh evidence shows a defect.

### `trusted`

High-agency personal development mode. A trusted workspace should support normal development without extra grants:

- workspace-scoped read/write/edit/patch;
- normal project toolchains and package managers;
- project verification, tests, builds, formatters, and similar recipes;
- outbound network needed for development;
- structured Git stage/commit/branch operations;
- structured Git fetch/pull/push;
- existing background process lifecycle.

The user should not separately enable `network=true`, `pnpm=true`, `git.push=true`, or equivalent routine permissions after selecting `trusted`.

## 4. ChatGPT as the normal control plane

ChatGPT becomes the normal trust control plane through a deliberately small typed surface.

Required public semantics:

- `trust.list` — list durable trusted workspace records;
- `workspace.trust` — trust a local root with an optional profile, defaulting according to current product convention;
- `workspace.untrust` — remove trust.

Re-running `workspace.trust` for an already trusted canonical root with a different profile updates that workspace's profile ceiling. A separate `policy.set`, `profile.set`, or granular grant API is not needed for this phase.

Normal flow:

1. User asks ChatGPT to trust a local repository as `trusted`.
2. KodeGPT canonicalizes and inspects the target locally.
3. Local/Rust authority derives persistent filesystem identity.
4. KodeGPT durably writes or updates the trust record.
5. The workspace can be opened and used immediately from ChatGPT.
6. Normal trusted development operations proceed without repeated authority configuration.

CLI remains available for bootstrap, diagnostics, and break-glass recovery, but is not required for everyday trust/profile changes.

## 5. Trust identity and persistence

Preserve the existing trust model rather than inventing a new one:

- canonical absolute workspace root;
- persistent filesystem identity (device/inode identity);
- atomic, versioned durable state;
- restrictive state-file permissions;
- identity mismatch fails closed;
- unsupported/corrupt state fails closed.

The existing `WorkspaceTrustStore` remains the persistence foundation. The existing `profileCeiling` remains sufficient unless implementation evidence proves otherwise.

Callers never supply device/inode identity directly.

## 6. Authorization boundary

Repository-controlled content is not an authority source.

The implementation does **not** need a separate prompt-injection detection subsystem. The required invariant is simpler and directly testable:

> No code path that only reads, parses, loads, or executes repository-controlled content may mutate the trust store.

Trust mutation is reachable only through explicit control-plane operations such as the typed MCP trust tools or existing CLI trust commands.

Once the user has selected `trusted`, ordinary capabilities covered by that profile do not need repeated confirmation.

## 7. Trusted process and verification behavior

The current trusted preset already includes write/process, unrestricted network, and common Node/Rust package tooling. Therefore implementation must **not assume the preset itself is wrong**.

Required workflow:

1. reproduce any trusted `verify.run` or `process.run` blocker;
2. identify whether the actual defect is profile resolution, executable discovery, sandbox visibility, installed runtime environment, or another layer;
3. fix only the blocking layer;
4. preserve `observe` and `develop` behavior unless independent evidence requires a change.

The target is that normal project verification recipes become usable when the effective profile is `trusted` and the executable is actually available.

A raw shell is not required as the normal public capability for this phase.

## 8. Local Git workflow

Trusted mode adds structured local Git mutation through the existing hardened Git authority chain.

Required local operations:

- stage/add bounded paths;
- commit with bounded message input;
- ordinary branch create;
- ordinary branch switch;
- ordinary branch delete with safe semantics.

Existing `git.status`, `git.diff`, `git.changes`, and bounded history capabilities remain unchanged.

Public APIs must remain typed and workspace-scoped. No generic `git.run(argv)` surface is introduced.

## 9. Remote Git workflow

Remote Git is a separate implementation boundary from local Git mutation.

Required operations:

- fetch;
- pull/integration with explicit semantics;
- push.

`fetch` changes refs but not the working tree, so it should not be treated as equivalent to destructive history mutation. `push` remains a remote mutation and must have clear typed semantics.

Force push, hard reset, and aggressive rebase are outside this phase.

Network Git is allowed in `trusted` because ordinary personal development requires it.

## 10. Filesystem and network boundaries

`trusted` means high authority **inside the trusted workspace**, not implicit whole-home or host filesystem authority.

Retain the existing retained-root/openat2-style filesystem boundary and workspace identity checks.

Trusted network behavior follows the existing high-agency profile intent and applies to workspace-scoped development operations. This phase does not add host networking administration APIs.

## 11. Audit

Trust/profile changes and newly introduced Git mutations are durable audit events.

Audit should capture enough structured provenance to reconstruct the operation and outcome without storing entire ChatGPT conversations.

At minimum, record operation type, target workspace/trust identity, relevant previous/resulting profile state, outcome, timestamp, and existing control-plane provenance fields.

Existing file/process/Git operations continue through the current audit architecture.

## 12. Revocation and recovery

`workspace.untrust` durably removes trust and prevents future opens under that trust record.

For an already-open workspace, implementation should reuse existing workspace lifecycle mechanisms to revoke/close retained authority and cancel workspace-owned operations where deterministic support already exists. Do not add a new supervisor solely for this feature.

CLI recovery remains available if MCP/ChatGPT is unavailable.

Invalid trust state never fails open to `trusted`.

## 13. MCP surface and versioning

Adding trust mutation and Git mutation changes the public capability surface. The implementation must choose the next semantic MCP surface version according to existing project conventions and update:

- `system.capabilities`;
- exact tool inventory;
- MCP schemas/tests;
- fresh-host acceptance expectations;
- release/readiness documentation.

Do not silently add tools while leaving surface `0.4` unchanged.

## 14. Retained security invariants

1. Rust/local hardened authority remains final OS/security authority.
2. Workspace identity remains canonical and persistent.
3. Repository content cannot directly mutate trust state.
4. Trusted authority remains workspace-scoped by default.
5. Durable audit remains mandatory.
6. State corruption/version mismatch fails closed.
7. Public Git mutation stays typed.
8. Generic shell is not required for the normal trusted workflow.
9. Provider interoperability remains a separate future design gate.

## 15. Implementation decomposition

Implement in five bounded tracks:

1. **ChatGPT Workspace Trust** — `trust.list`, `workspace.trust`, `workspace.untrust`, including profile update by re-trust.
2. **Trusted Runtime Ergonomics** — reproduce and fix only the actual trusted process/verification blocker.
3. **Local Git Workflow** — stage, commit, branch create/switch/delete.
4. **Remote Git Workflow** — fetch, pull, push.
5. **Surface & Release Closure** — surface bump, audit/security regressions, full verification, immutable service cutover, fresh ChatGPT acceptance, documentation.

Provider interoperability is not part of these tracks.

## 16. Success criteria

The phase is complete when the user can stay in ChatGPT and:

1. list durable trusted workspaces;
2. trust a new local repository as `trusted`;
3. change its profile by re-trusting it with another profile;
4. open it;
5. inspect and edit source;
6. use normal project tooling and verification;
7. stage and commit changes and manage ordinary branches;
8. fetch/pull/push during normal repository work;
9. inspect health/audit evidence;
10. untrust the workspace and prove future opens are denied;
11. use CLI only when the ChatGPT/MCP path itself requires recovery.
