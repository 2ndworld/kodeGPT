# KodeGPT Architecture Authority Index

This index points to the current repository authorities for KodeGPT v0.1. It does not recreate missing blueprint prose, does not override locked security decisions, and does not treat historical unchecked plan boxes as implementation truth.

## Current authorities

| Responsibility | Current authority |
| --- | --- |
| v0.1 execution state and release evidence | `docs/implementation/v0.1-execution-tracker.md` and `docs/release/v0.1-checklist.md` |
| Native capability architecture and hardening reconciliation | `docs/superpowers/specs/2026-08-11-kodegpt-native-capability-layer-hardening-design.md`, `docs/superpowers/plans/2026-08-11-kodegpt-native-capability-layer-hardening.md`, and `docs/superpowers/specs/2026-08-12-kodegpt-capability-quality-reconciliation-design.md` |
| Managed public exposure | current zrok implementation and its repository design/operational documentation; older ngrok/generic-tunnel drafts are historical unless explicitly marked current |
| Hybrid skill interoperability | `docs/superpowers/specs/2026-08-12-kodegpt-hybrid-skill-interoperability-reconciled-design.md` plus current `packages/skills`, `packages/mcp-server`, integration tests, and the capability-quality reconciliation plan |
| ChatGPT compatibility and host evidence contract | `docs/compatibility/chatgpt.md` and `tests/host/README.md`; only observed host behavior may be recorded as observed |
| Security/runtime invariants | Rust runtime/workspace authority, security tests, protocol tests, isolation tests, and the execution tracker; source/tests take precedence over stale historical prose |

## Locked authority boundaries

- Rust remains the final OS/security authority for workspace filesystem and process effects.
- MCP cannot establish workspace trust, add/remove skill sources, pin/unpin skills, or invoke a generic skill runtime.
- `file.tree` and `file.search` are literal primitives. High-level repository understanding uses the internal semantic traversal scope for relevance only.
- Provider interoperability is not part of the current shipped authority and requires a separate future security/design gate before implementation.
- CodexPro/Codex/Claude are not KodeGPT runtime dependencies.

## Reconciliation rule

When a historical design or implementation plan disagrees with current source, tests, release evidence, or a later reconciled design, preserve the historical text for auditability and add an explicit reconciliation note. Do not silently rewrite history or infer completion solely from unchecked/checked boxes.
