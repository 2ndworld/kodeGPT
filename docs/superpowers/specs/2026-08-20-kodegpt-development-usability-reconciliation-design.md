# KodeGPT Development Usability Reconciliation Design

Date: 2026-08-20
Canonical repo: `/home/sauron/dev/kodegpt`
Baseline: `main == origin/main == 7419b42e06dee52c6509e4e14242ed264fe85449`
Runtime / protocol / MCP semantic surface: `0.1 / 2026-07-28 / 0.16`
Public MCP tool count: exactly `75`

## Objective

Improve the KodeGPT areas that still reduce practical development quality without turning KodeGPT into a Codex clone or adding generic orchestration. The changes must make existing capabilities easier to discover, eliminate proven skill-compatibility false positives, prevent target-scoped context from being monopolized by one large file, and make cross-chat continuation practical through the already-existing workflow skill and `.ai-bridge` convention.

## Audit findings that govern this design

1. `system.capabilities` is under-descriptive. Its name suggests a capability map, but it currently returns only runtime/protocol/surface/boundary fields. The authoritative 75-tool MCP inventory already exists in `SURFACE_TOOLS` / `listSurfaceTools()`.
2. Workspace-aware external-CLI skill resolution already exists. `resolveSkillCapabilityPlan()` checks effective process policy, executable availability, and sandbox availability, and `skill.inspect(..., workspaceId)` is already production-wired. It must not be reimplemented.
3. Static skill compatibility has proven false positives. `Lean already. Ship.` is interpreted as `external-cli:lean`, and template text such as `Total users: ${users.length}` is interpreted as `external-cli:total`. Real command requirements such as fenced `npx skills ...` are legitimate.
4. `context.build(target=...)` is already target-aware, but candidate reads consume the whole remaining byte budget. A large dependency can therefore crowd out later tests/config/evidence. Full semantic slicing, indexing, LSP, embeddings, or caches are not justified.
5. Repository-owned workflow skill discovery does not require a new runtime source type. The existing operator-only persistent `kodegpt skill source add/list/remove` control plane can register `/home/sauron/dev/kodegpt/skills` directly.
6. `.ai-bridge` already provides continuation artifacts. Automatically injecting `.ai-bridge/current-plan.md` into `context.build` would mix orchestration state with semantic repository context. Continuation should remain host/workflow guidance, not a context subsystem responsibility.
7. Trusted execution is already a practical escape hatch: `process.run` plus trusted `bash`/`sh`, controlled PATH, unrestricted trusted-network policy, background progress, status waiting, cancellation, and artifacts. No additional executor is required.

## Design

### 1. Capability discoverability and self-description

Enrich the existing `system.capabilities` result with one additive `publicTools` object derived directly from `listSurfaceTools()`:

```ts
{
  runtimeVersion: "0.1",
  filesystemBoundaryAvailable: true,
  mcpProtocolVersion: "2026-07-28",
  mcpSurfaceVersion: "0.16",
  publicTools: {
    count: 75,
    families: {
      artifact: ["artifact.read"],
      browser: [...],
      ci: [...],
      code: [...],
      ...
    }
  }
}
```

The family key is the prefix before the first `.`. Both family keys and tool names are deterministic and sorted. `publicTools` covers only public MCP tools. It must not duplicate operator CLI commands, private provider internals, or semantic skill metadata.

No new MCP tool is introduced. `listSurfaceTools()` remains the single machine source of truth for public MCP inventory.

Clarify MCP descriptions:

- `system.capabilities`: explicitly says it reports runtime/boundaries plus derived public MCP inventory and does not enumerate operator-only/private capabilities.
- `skill.list`: explicitly says compatibility is static/source-level.
- `skill.inspect`: explicitly says adding `workspaceId` resolves effective external-CLI readiness against workspace policy/executable/sandbox state without executing anything.

Add a short current-state capability map to the top of `docs/architecture/README.md`, before historical authority rows. The table distinguishes public MCP, trusted escape hatch, operator CLI, private internals, and deliberately absent authority. It does not create a second exhaustive tool registry.

### 2. Skill static compatibility precision

Keep static compatibility conservative, but stop interpreting arbitrary inline-code prose as shell commands.

Rules:

- Shell-fenced commands remain command evidence.
- Inline code is external-CLI evidence only when the surrounding same-line prose explicitly introduces command execution, e.g. `run`, `execute`, `invoke`, or `launch`, or labels the snippet as a command/CLI.
- Explicit Codex command detection remains conservative and independent so `codex review` / `codex exec` do not become accidentally accepted.
- Do not blacklist words such as `lean` or `total`; fix the classification rule.
- Keep runtime-aware `resolveSkillCapabilityPlan()` unchanged unless a regression test proves a separate defect.

Expected current skill behavior after the fix:

- `ponytail`: static `NATIVE`.
- `ponytail-audit`: static `NATIVE`.
- `ponytail-review`: static `NATIVE`.
- `refactor`: static `NATIVE` unless another genuine requirement exists.
- `find-skills`: may remain static `PARTIAL` because `npx` is a real command requirement, while `skill.inspect(..., workspaceId)` may resolve its effective plan to `NATIVE` when `npx` is allowed/installed/sandboxable.

### 3. Target-scoped context budget fairness

Preserve current candidate selection, intent weighting, target-area scoping, verification scoping, warnings, and result schema. Change only per-file read ceilings for target-scoped builds:

- exact target: at most 50% of `maxBytes` per read;
- every non-target candidate: at most 25% of `maxBytes` per read;
- always cap again by the current `remaining` budget;
- a small file consumes only its actual bytes, so unused quota naturally remains available to later candidates;
- when `target` is omitted, preserve existing whole-remaining-budget behavior.

The returned `ContextSelectedFile.truncated` flag remains the signal that the host may follow with targeted `file.read` when more of that particular file is needed.

Do not add symbol-range extraction, AST/LSP parsing, persistent index/cache, code.impact invocation inside `context.build`, or a new context tool in this phase. If real post-change dogfood still misses critical evidence because repository relationship analysis is truncated, target-focused repository analysis becomes a separately justified future change rather than part of this phase.

### 4. Repository workflow skill activation

Use the existing operator control plane to register the canonical repository skill root if not already present:

```bash
node apps/cli/bin/kodegpt.mjs skill source add /home/sauron/dev/kodegpt/skills --kind agent-skills
```

Registration is idempotence-by-precheck: run `skill source list` first and do not add a duplicate source. No MCP mutation, auto-discovery, `~/.kodegpt/skills` convention, marketplace, or new source type is introduced.

### 5. Resume / continuation convention

Extend `skills/kodegpt-application-development-workflow/SKILL.md` with a small resume rule:

1. When the user asks to continue/resume/lanjutkan, inspect current Git state first.
2. If present, read `.ai-bridge/current-plan.md`; consult `.ai-bridge/agent-status.md`, `decisions.md`, or `open-questions.md` only when relevant.
3. Treat explicit `CLOSED`, `RECONCILED`, `CLEAN`, or equivalent terminal state as terminal; do not invent a new phase.
4. Determine the active objective/target before calling `context.build`.
5. Keep `.ai-bridge` as host coordination state; do not inject it automatically into semantic context results.

No session database, memory daemon, task scheduler, autonomous agent, worktree-per-agent orchestration, or workflow execution endpoint is added.

## Public contract/version decision

Runtime remains `0.1` and MCP protocol remains `2026-07-28`.

MCP semantic surface remains `0.16` with exactly 75 tools. This repository already treats the semantic surface snapshot primarily as tool names plus required input fields; this work adds no tool and no required input field. `system.capabilities.publicTools` is an additive result field, skill description wording is metadata, the skill parser fix is behavioral correctness, and context budgeting changes only selection/read behavior within the existing result schema.

A refreshed ChatGPT action discovery is still useful for final host acceptance because tool descriptions change, but no semantic-surface bump is required.

## Non-goals

Do not add or revive:

- `workflow.run`;
- `skill.run`;
- `system.inventory`, `capability.list`, or `feature.list`;
- generic `shell.run` / `command.run`;
- autonomous agent/session runtime;
- multi-agent scheduler or worktree-per-agent orchestration;
- generic provider invocation or provider tool discovery;
- arbitrary browser navigation/computer-use;
- generic deployment abstraction;
- persistent context index/cache/vector database/LSP daemon;
- automatic skill marketplace/import sync;
- host PATH inheritance or wildcard executable authority.

## Acceptance criteria

1. A fresh host can use `system.capabilities` to enumerate all current public MCP tool families and exactly 75 tools without source-code archaeology.
2. `skill.list` and `skill.inspect` descriptions make static versus workspace-effective compatibility discoverable.
3. `Lean already. Ship.` and `Total users: ...` no longer become external CLI requirements; explicit `terraform plan` command context and fenced `npx skills ...` remain detected.
4. The existing workspace-aware skill resolver tests remain green and `find-skills` can resolve `npx` through `process.run` in a trusted workspace.
5. A target-scoped context build with multiple large candidates includes more than one evidence class instead of allowing the first large file to consume the full budget.
6. `context.build` without a target preserves existing budgeting behavior.
7. Repository workflow skill is visible through live `skill.list` after using the existing source registry.
8. Resume guidance reads `.ai-bridge` only when the user intent requires continuation and does not alter `context.build` semantics.
9. Runtime/protocol/surface/tool count remain `0.1 / 2026-07-28 / 0.16 / 75`.
10. Full deterministic verification and live KodeGPT dogfood pass before merge/cutover claims.
