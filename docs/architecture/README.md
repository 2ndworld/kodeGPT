# KodeGPT Architecture Authority Index

This index points to the current repository authorities for KodeGPT v0.1. It does not recreate missing blueprint prose, does not override locked security decisions, and does not treat historical unchecked plan boxes as implementation truth.

## Current authorities

| Responsibility | Current authority |
| --- | --- |
| v0.1 execution state and release evidence | `docs/implementation/v0.1-execution-tracker.md` and `docs/release/v0.1-checklist.md` |
| Native capability architecture and hardening reconciliation | `docs/superpowers/specs/2026-08-11-kodegpt-native-capability-layer-hardening-design.md`, `docs/superpowers/plans/2026-08-11-kodegpt-native-capability-layer-hardening.md`, and `docs/superpowers/specs/2026-08-12-kodegpt-capability-quality-reconciliation-design.md` |
| Managed public exposure | current zrok implementation and its repository design/operational documentation; older ngrok/generic-tunnel drafts are historical unless explicitly marked current |
| Stable local service + exposure lifecycle | `docs/superpowers/specs/2026-08-14-kodegpt-stable-local-service-lifecycle-design.md`, `docs/superpowers/plans/2026-08-14-kodegpt-stable-local-service-lifecycle.md`, and current `apps/cli/src/service` + service CLI tests |
| Hybrid skill interoperability | `docs/superpowers/specs/2026-08-12-kodegpt-hybrid-skill-interoperability-reconciled-design.md` plus current `packages/skills`, `packages/mcp-server`, integration tests, and the capability-quality reconciliation plan |
| ChatGPT compatibility and host evidence contract | `docs/compatibility/chatgpt.md` and `tests/host/README.md`; only observed host behavior may be recorded as observed |
| Security/runtime invariants | Rust runtime/workspace authority, security tests, protocol tests, isolation tests, and the execution tracker; source/tests take precedence over stale historical prose |

## Locked authority boundaries

- Rust remains the final OS/security authority for workspace filesystem and process effects.
- MCP cannot establish workspace trust, add/remove skill sources, pin/unpin skills, or invoke a generic skill runtime.
- `file.tree` and `file.search` are literal primitives. High-level repository understanding uses the internal semantic traversal scope for relevance only.
- Local service lifecycle is operator-only CLI authority. It is not an MCP capability and does not grant workspace/process/filesystem authority.
- `systemd --user` owns only the outer installed KodeGPT foreground service; KodeGPT's existing managed-zrok path remains the single supervisor for the loopback MCP server, Rust runtime, and zrok child.
- Installed service releases live outside Git worktrees so deleting a feature worktree cannot invalidate the running executable. The general KodeGPT state root remains `~/.kodegpt`.
- Provider interoperability is not part of the current shipped authority and requires a separate future security/design gate before implementation.
- CodexPro/Codex/Claude are not KodeGPT runtime dependencies.

## Deferred authority-bearing work

### Provider interoperability — separate future security/design gate

The following provider actions are **genuinely absent** from the current KodeGPT product/runtime and must not be added opportunistically inside capability, skill, or tunnel maintenance work:

```text
provider.list
provider.tools
provider.invoke
```

Before any provider code is written, a dedicated future design must resolve at least:

- provider admission, trust, and durable identity;
- tool-inventory identity/versioning and capability mapping;
- credential ownership, storage, rotation, and redaction;
- process/network authority and how provider calls remain subordinate to KodeGPT policy;
- durable audit ordering and provenance;
- timeout, cancellation, and child/provider lifecycle behavior;
- bounded request/output/artifact semantics;
- host-path, environment, prompt, and secret redaction across every public result/error path.

Provider interoperability does **not** imply a generic `skill.run`. GPT Web continues to interpret loaded skill instructions. Any future provider tools must be separately named, typed, bounded actions with their own authority and audit contracts; they must not turn a skill bundle into executable authority.

### Superseded transport work

Older ngrok or generic managed-tunnel drafts are historical context, not pending implementation obligations. The current v0.1 managed public exposure path is zrok. A generic tunnel/provider abstraction must not be resurrected merely because older documents discussed one; changing the exposure architecture requires its own approved design.

### Desktop/computer-use work

Desktop/computer-use automation remains paused/deferred and is not part of this authority index's current implementation sequence. No desktop automation, GUI-control, screen-control, or equivalent host authority is introduced by the capability-quality reconciliation work.

## Reconciliation rule

When a historical design or implementation plan disagrees with current source, tests, release evidence, or a later reconciled design, preserve the historical text for auditability and add an explicit reconciliation note. Do not silently rewrite history or infer completion solely from unchecked/checked boxes.
