# KodeGPT Architecture Authority Index

This index points to the current repository authorities for KodeGPT v0.1. It does not recreate missing blueprint prose, does not override locked security decisions, and does not treat historical unchecked plan boxes as implementation truth.

## Current authorities

| Responsibility | Current authority |
| --- | --- |
| v0.1 execution state and release evidence | `docs/implementation/v0.1-execution-tracker.md` and `docs/release/v0.1-checklist.md` |
| Native capability architecture and hardening reconciliation | `docs/superpowers/specs/2026-08-11-kodegpt-native-capability-layer-hardening-design.md`, `docs/superpowers/plans/2026-08-11-kodegpt-native-capability-layer-hardening.md`, and `docs/superpowers/specs/2026-08-12-kodegpt-capability-quality-reconciliation-design.md` |
| Repository Intelligence v2 candidate | `docs/superpowers/specs/2026-08-17-kodegpt-repository-intelligence-v2-design.md`, `docs/superpowers/plans/2026-08-17-kodegpt-repository-intelligence-v2.md`, and current `packages/capabilities/src/repository-analysis.ts` + `workspace-inspect.ts`; adds bounded source symbols, import/test/module relationships, and source entrypoints without new dependency, tool, or authority |
| Managed public exposure | current zrok implementation and its repository design/operational documentation; older ngrok/generic-tunnel drafts are historical unless explicitly marked current |
| Stable local service + exposure lifecycle | `docs/superpowers/specs/2026-08-14-kodegpt-stable-local-service-lifecycle-design.md`, `docs/superpowers/plans/2026-08-14-kodegpt-stable-local-service-lifecycle.md`, and current `apps/cli/src/service` + service CLI tests |
| Hybrid skill interoperability | `docs/superpowers/specs/2026-08-12-kodegpt-hybrid-skill-interoperability-reconciled-design.md` plus current `packages/skills`, `packages/mcp-server`, integration tests, and the capability-quality reconciliation plan |
| Personal trusted authority | `docs/superpowers/specs/2026-08-15-kodegpt-personal-trusted-authority-design.md`, `docs/superpowers/plans/2026-08-15-kodegpt-personal-trusted-authority.md`, current trust/Git tool source and tests, and merged PR #13 baseline `3e568ead27346d6670ecd9acca991708048431c2` |
| Bounded Remote-CI Intelligence / current MCP surface `0.7` | `docs/superpowers/specs/2026-08-16-kodegpt-bounded-remote-ci-intelligence-design.md`, `docs/superpowers/plans/2026-08-16-kodegpt-bounded-remote-ci-intelligence.md`, `docs/release/2026-08-16-bounded-remote-ci-readiness.md`, current `ci.*` source/tests, and merged PR #15 baseline `f6113b3eef12ab6f3d6b8b7b7952aa18d3f4bae1` |
| Provider Gateway private core/operator authority | `docs/superpowers/specs/2026-08-16-kodegpt-provider-gateway-design.md`, `docs/superpowers/plans/2026-08-16-kodegpt-provider-gateway.md`, `docs/release/2026-08-16-provider-gateway-readiness.md`, current `packages/capabilities/src/provider-gateway` + local provider CLI source/tests, and merged PR #16 baseline `105547db2f1a8f97dc5ad6fb1a1efc1a12755607`; production adapter inventory remains empty and public MCP remains `0.7` |
| ChatGPT compatibility and host evidence contract | `docs/compatibility/chatgpt.md` and `tests/host/README.md`; only observed host behavior may be recorded as observed |
| Security/runtime invariants | Rust runtime/workspace authority, security tests, protocol tests, isolation tests, and the execution tracker; source/tests take precedence over stale historical prose |

## Locked authority boundaries

- Rust remains the final OS/security authority for workspace filesystem and process effects.
- Explicit MCP trust mutation is supported only through the typed `trust.list`, `workspace.trust`, and `workspace.untrust` control plane. Repository-controlled content cannot mutate trust state. Skill-source add/remove and pin/unpin remain local-CLI authority, and no generic `skill.run` surface exists.
- In the `trusted` profile, structured local Git mutation plus typed `git.fetch`, `git.pull`, and `git.push` are allowed inside the trusted workspace and remain auditable. Arbitrary Git argv, force push, hard reset, and aggressive rebase remain outside the shipped authority.
- `file.tree` and `file.search` are literal primitives. High-level repository understanding uses the internal semantic traversal scope for relevance only.
- Local service lifecycle is operator-only CLI authority. It is not an MCP capability and does not grant workspace/process/filesystem authority.
- `systemd --user` owns only the outer installed KodeGPT foreground service; KodeGPT's existing managed-zrok path remains the single supervisor for the loopback MCP server, Rust runtime, and zrok child.
- Installed service releases live outside Git worktrees so deleting a feature worktree cannot invalidate the running executable. The general KodeGPT state root remains `~/.kodegpt`.
- Provider Gateway core/operator authority is implemented privately and merged through PR #16 at canonical baseline `105547db2f1a8f97dc5ad6fb1a1efc1a12755607`, with readiness evidence at `docs/release/2026-08-16-provider-gateway-readiness.md`. The first production adapter remains `github.read.v1`: PR #17 originally shipped `github.repository.inspect`, `github.pr.inspect`, and `github.pr.list`, and the post-PR #17 GitHub Issue Read Extension adds `github.issue.inspect` plus `github.issue.list` through the same credential/transport/audit boundary. The current adapter therefore has exactly five internal read-only semantic mappings. No public `provider.*` or GitHub MCP tool was added; runtime/protocol/surface remain `0.1 / 2026-07-28 / 0.7` and public MCP remains exactly 51 tools.
- CodexPro/Codex/Claude are not KodeGPT runtime dependencies.

## Deferred authority-bearing work

### Provider interoperability — first production read-only adapter implemented; generic/public provider authority deferred

Current authorities are the Provider Gateway design/plan/readiness evidence, merged PR #16 baseline `105547db2f1a8f97dc5ad6fb1a1efc1a12755607`, the first GitHub read-only adapter design/plan, and the post-PR #17 GitHub Issue Read Extension design/plan. The private typed gateway, operator admission/reapproval, JIT credential/helper boundary, bounded semantic transport, structural inventory identity, lifecycle limits, global private audit path, and one compiled production manifest (`github.read.v1`) are implemented. PR #17 host acceptance used admitted `/usr/bin/gh` with its SHA identity and successfully executed the original three GitHub semantics against `api.github.com`; durable audit contained those semantic IDs without credential/header leakage. The adapter now additionally implements bounded issue inspect/list semantics without widening credentials, origin policy, request budgets, or public MCP surface. Generic/public provider invocation, further GitHub semantics, additional providers, and Remote-CI migration remain deferred.

The following **public/generic** provider actions remain genuinely absent and must not be added opportunistically inside capability, skill, or tunnel maintenance work:

```text
provider.list
provider.tools
provider.invoke
```

The approved design and implementation plan lock the implementation requirements for:

- provider admission, trust, and durable identity;
- tool-inventory identity/versioning and typed semantic capability mapping;
- external JIT credential ownership, helper identity, and redaction;
- exact-origin process/network authority subordinate to KodeGPT policy;
- durable audit ordering and provenance;
- timeout, cancellation, and helper/provider lifecycle behavior;
- bounded request/output/inventory semantics;
- host-path, environment, prompt, and secret redaction across every result/error path.

Provider interoperability does **not** imply a generic `skill.run`. GPT Web continues to interpret loaded skill instructions. Any future provider-backed public action must be separately named, typed, bounded, and reviewed; provider advertisements cannot create KodeGPT authority. Historical names such as `provider.list`, `provider.tools`, and `provider.invoke` are design inputs, not pre-approved public surface names.

### Superseded transport work

Older ngrok or generic managed-tunnel drafts are historical context, not pending implementation obligations. The current v0.1 managed public exposure path is zrok. A generic tunnel/provider abstraction must not be resurrected merely because older documents discussed one; changing the exposure architecture requires its own approved design.

### Desktop/computer-use work

Desktop/computer-use automation remains paused/deferred and is not part of this authority index's current implementation sequence. No desktop automation, GUI-control, screen-control, or equivalent host authority is introduced by the capability-quality reconciliation work.

## Reconciliation rule

When a historical design or implementation plan disagrees with current source, tests, release evidence, or a later reconciled design, preserve the historical text for auditability and add an explicit reconciliation note. Do not silently rewrite history or infer completion solely from unchecked/checked boxes.
