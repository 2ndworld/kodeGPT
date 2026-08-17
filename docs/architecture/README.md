# KodeGPT Architecture Authority Index

This index points to the current repository authorities for KodeGPT v0.1. It does not recreate missing blueprint prose, does not override locked security decisions, and does not treat historical unchecked plan boxes as implementation truth.

## Current authorities

| Responsibility | Current authority |
| --- | --- |
| v0.1 execution state and release evidence | `docs/implementation/v0.1-execution-tracker.md` and `docs/release/v0.1-checklist.md` |
| Native capability architecture and hardening reconciliation | `docs/superpowers/specs/2026-08-11-kodegpt-native-capability-layer-hardening-design.md`, `docs/superpowers/plans/2026-08-11-kodegpt-native-capability-layer-hardening.md`, and `docs/superpowers/specs/2026-08-12-kodegpt-capability-quality-reconciliation-design.md` |
| Repository Intelligence v2 | `docs/superpowers/specs/2026-08-17-kodegpt-repository-intelligence-v2-design.md`, `docs/superpowers/plans/2026-08-17-kodegpt-repository-intelligence-v2.md`, current `packages/capabilities/src/repository-analysis.ts` + `workspace-inspect.ts`, and merged PR #19 baseline `7c8d1fc8d3421f861d4567186aff7ad67815439b`; adds bounded source symbols, import/test/module relationships, and source entrypoints without new dependency, tool, or authority |
| Managed public exposure | current zrok implementation and its repository design/operational documentation; older ngrok/generic-tunnel drafts are historical unless explicitly marked current |
| Stable local service + exposure lifecycle | `docs/superpowers/specs/2026-08-14-kodegpt-stable-local-service-lifecycle-design.md`, `docs/superpowers/plans/2026-08-14-kodegpt-stable-local-service-lifecycle.md`, and current `apps/cli/src/service` + service CLI tests |
| Hybrid skill interoperability | `docs/superpowers/specs/2026-08-12-kodegpt-hybrid-skill-interoperability-reconciled-design.md` plus current `packages/skills`, `packages/mcp-server`, integration tests, and the capability-quality reconciliation plan |
| Skill Capability Resolution v2 | `docs/superpowers/specs/2026-08-17-kodegpt-skill-capability-resolution-v2-design.md`, `docs/superpowers/plans/2026-08-17-kodegpt-skill-capability-resolution-v2.md`, current `packages/skills/src/capability-plan.ts` + MCP skill tool-context/tests, and merged PR #20 baseline `dc2586a5a898ad97210416adabdc3eb2d76eaa11`; adds optional workspace-aware resolution of bounded `external-cli:*` findings against existing process policy plus `process.inspect_executable`, maps usable CLIs to advisory `process.run`, and conservatively preserves `PARTIAL` when missing-capability evidence is truncated, without `skill.run`, execution, new authority, new dependency, or surface/tool-count change |
| Personal trusted authority | `docs/superpowers/specs/2026-08-15-kodegpt-personal-trusted-authority-design.md`, `docs/superpowers/plans/2026-08-15-kodegpt-personal-trusted-authority.md`, current trust/Git tool source and tests, and merged PR #13 baseline `3e568ead27346d6670ecd9acca991708048431c2` |
| Bounded Remote-CI Intelligence / historical surface `0.7` baseline | `docs/superpowers/specs/2026-08-16-kodegpt-bounded-remote-ci-intelligence-design.md`, `docs/superpowers/plans/2026-08-16-kodegpt-bounded-remote-ci-intelligence.md`, `docs/release/2026-08-16-bounded-remote-ci-readiness.md`, current `ci.*` source/tests, and merged PR #15 baseline `f6113b3eef12ab6f3d6b8b7b7952aa18d3f4bae1`; PR #15 introduced surface `0.7`, while the current aggregate MCP surface is tracked separately below |
| Provider Gateway private core/operator authority | `docs/superpowers/specs/2026-08-16-kodegpt-provider-gateway-design.md`, `docs/superpowers/plans/2026-08-16-kodegpt-provider-gateway.md`, `docs/release/2026-08-16-provider-gateway-readiness.md`, current `packages/capabilities/src/provider-gateway` + local provider CLI source/tests, merged PR #16 baseline `105547db2f1a8f97dc5ad6fb1a1efc1a12755607`, merged GitHub read adapter/extensions, and merged PR #23 bounded write surface; production adapter inventory contains exactly `github.read.v1` with five read semantics plus `github.write.v1` with exactly `github.pr.create` and guarded `github.pr.merge`, while generic provider authority remains private |
| Public Typed GitHub Read Surface / historical MCP surface `0.8` baseline | `docs/superpowers/specs/2026-08-17-kodegpt-public-typed-github-read-surface-design.md`, `docs/superpowers/plans/2026-08-17-kodegpt-public-typed-github-read-surface.md`, current MCP/provider adapter source and tests, merged PR #21 baseline `085660684a7f2cac215945e5ae1e73d9bd2d47e6`, and post-merge closure in `docs/implementation/v0.1-execution-tracker.md`; PR #21 introduced exactly 56 tools with five fixed `github.*` reads and no `provider.*` tool |
| Bounded GitHub PR Write Surface / current MCP surface `0.9` | `docs/superpowers/specs/2026-08-17-kodegpt-bounded-github-pr-write-surface-design.md`, `docs/superpowers/plans/2026-08-17-kodegpt-bounded-github-pr-write-surface.md`, current Provider Gateway/MCP/startup source and tests, merged PR #23 baseline `57c6061750a8193b8e9c56b80d55607f96eaaaf6`, and live dogfood/closure evidence in `docs/implementation/v0.1-execution-tracker.md`; the public registry is exactly 58 tools with five GitHub reads plus `github.pr.create` and guarded `github.pr.merge`, zero `provider.*` tools, and remote mutation mappings are single-attempt only |
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
- Provider Gateway core/operator authority is implemented privately and merged through PR #16 at canonical baseline `105547db2f1a8f97dc5ad6fb1a1efc1a12755607`, with readiness evidence at `docs/release/2026-08-16-provider-gateway-readiness.md`. `github.read.v1` supplies the five fixed read semantics exposed by PR #21. PR #23 adds a separately admitted `github.write.v1` with exactly `github.pr.create` and guarded `github.pr.merge`; mutation mappings are single-attempt only, merge requires exact `expectedHeadOid`, and ambiguous post-dispatch outcomes are reconciled rather than retried. Current runtime/protocol/surface are `0.1 / 2026-07-28 / 0.9` with exactly 58 public tools and exactly seven `github.*` tools; no public `provider.*` tool, generic provider invocation, caller-selected endpoint/method/header/credential, or provider envelope is exposed.
- CodexPro/Codex/Claude are not KodeGPT runtime dependencies.

## Deferred authority-bearing work

### Provider interoperability — typed GitHub read + bounded PR write adapters implemented; generic/public provider authority deferred

Current authorities are the Provider Gateway design/plan/readiness evidence, merged PR #16 baseline `105547db2f1a8f97dc5ad6fb1a1efc1a12755607`, the GitHub read adapter/extensions, PR #21 Public Typed GitHub Read Surface design/plan, and PR #23 Bounded GitHub PR Write Surface design/plan. The private typed gateway, operator admission/reapproval, JIT credential/helper boundary, bounded semantic transport, structural inventory identity, lifecycle limits, global private audit path, and exactly two compiled production manifests are implemented: `github.read.v1` with five fixed reads and `github.write.v1` with exactly PR create + guarded merge. Live acceptance uses the existing `/usr/bin/gh` helper identity and durable audit without credential/header leakage. PR #23 does not expose provider identity/envelopes or generic request authority; mutation retry remains forbidden and merge is guarded by exact expected head identity. Generic/public provider invocation, additional GitHub semantics beyond the shipped seven, additional providers, and Remote-CI migration remain deferred.

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
