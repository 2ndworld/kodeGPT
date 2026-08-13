# Native Skill Execution Orchestration — Evidence-Based Design

Status date: 2026-08-13 baseline reconciliation of the 2026-08-12 future design.

> **Current baseline:** this design remains future advisory/read-only work. KodeGPT is now at MCP semantic surface `0.3` with protocol `2026-07-28`, and fresh ChatGPT host inventory has directly exposed the optional `skill.list.compatibility` filter. Nothing in this design authorizes `skill.run`, provider invocation, provider processes, credential forwarding, or additional OS authority.

## Goal

Make Markdown/Agent-Skills workflows easier for GPT Web to execute using KodeGPT's existing bounded native primitives, without adding `skill.run`, provider-agent execution, provider credential forwarding, or a second security authority.

The orchestration actor remains GPT Web. KodeGPT remains a typed capability server plus Rust security/policy authority.

## Evidence driving the design

Post-merge dogfooding shows that the frequently proposed desktop/repository primitives are already present:

- `workspace.inspect`
- `code.search`
- `file.read`
- `file.write`
- `file.edit`
- `file.patch`
- `git.status`
- `git.diff`
- `git.changes`
- `process.run`
- `verify.list`
- `verify.run`
- `context.build`

The host acceptance run also proved that ChatGPT can open a locally trusted disposable workspace, read/write through KodeGPT, and inspect Git status/diff. The main usability gap observed in that run was not missing filesystem authority: the ChatGPT app retained an older frozen tool inventory until its actions are refreshed. That is a host deployment/readiness concern, not a reason to expand KodeGPT authority.

Representative skill patterns show four distinct classes:

| Skill pattern | Current class | Evidence | Actual gap |
|---|---|---|---|
| Generic semantic/refactoring workflow | `NATIVE` | Markdown-only workflow can be reasoned about by GPT and mapped to current file/search/Git/verify capabilities | Better skill-to-capability guidance, not new authority |
| GitHub Actions remediation workflow (`gh-fix-ci`) | `PARTIAL` | Workflow depends on GitHub app data plus `gh`/Python helper commands | A bounded remote-CI inspection interface; do not replace it with generic shell |
| Explicit declared provider dependency | `PROVIDER_REQUIRED` | Classifier already represents declared provider requirements | Provider remains an external semantic dependency; no provider execution in this phase |
| `codex exec` / provider-agent / subagent-session workflow | `UNSUPPORTED` | Existing classifier and integration fixtures reject these semantics | Intentionally unsupported; no missing primitive should be added to emulate them |

## Architectural decision

Use a **planning/advisory layer**, not an execution endpoint.

```text
skill.list / skill.inspect / skill.load
             ↓
   bounded skill semantics
             ↓
 optional skill capability plan
             ↓
        GPT Web reasoning
             ↓
 existing KodeGPT native MCP tools
             ↓
 TypeScript capability adapters
             ↓
 Rust policy / audit / retained-FD authority
```

The new layer may tell GPT which existing native capability families are relevant, which declared requirements are already satisfied, and which requirements remain external or unsupported. It must never invoke those capabilities on the model's behalf.

## Proposed surface

### 1. Extend `skill.inspect` with an advisory execution plan

Do not add a fourth skill execution tool. Add a bounded optional field to the existing read-only inspection result:

```ts
interface SkillCapabilityPlan {
  schemaVersion: 1;
  classification: "NATIVE" | "PARTIAL" | "PROVIDER_REQUIRED" | "UNSUPPORTED";
  nativeCapabilities: readonly NativeCapabilityId[];
  missingCapabilities: readonly string[];
  externalRequirements: readonly string[];
  blockedSemantics: readonly string[];
  guidance: readonly SkillCapabilityGuidanceStep[];
  truncated: boolean;
  truncationReasons: readonly (
    | "MISSING_CAPABILITIES"
    | "EXTERNAL_REQUIREMENTS"
    | "BLOCKED_SEMANTICS"
  )[];
}

interface SkillCapabilityGuidanceStep {
  capability: NativeCapabilityId;
  purpose: string;
}
```

`guidance` is declarative and deterministic. It is derived from declared/static skill semantics and existing capability metadata. It contains no generated shell command, host path, credential, provider invocation, workspace ID, or security handle.

`truncated` is advisory-output completeness only; it never changes `classification`. `truncationReasons` identifies which finding arrays were deterministically capped after bytewise sort/deduplication, so bounded output never silently drops a security-relevant compatibility finding.

**Baseline implementation reconciliation (2026-08-13):** the current three skill tools return `structuredContent` but do not advertise MCP `outputSchema`. This phase extends the typed `SkillInspectResult`/structured result contract and descriptions only; it must not add a new `outputSchema` solely to carry `capabilityPlan`. Repository precedent keeps additive fields within an already-established semantic phase version, so this additive result field remains surface `0.3` unless implementation demonstrates an actually incompatible contract break. MCP protocol remains `2026-07-28`.

This keeps the number of MCP skill tools unchanged and avoids a new orchestration authority.

### 2. Capability metadata registry

Create one shared, static metadata registry adjacent to `NATIVE_CAPABILITY_IDS` that gives each native capability a bounded semantic description and aliases/patterns used by the skill planner.

The registry is not a permission table. Runtime policy remains authoritative after GPT chooses a tool.

The registry should cover the current capability IDs only. Adding a capability to the registry must not make it available unless the corresponding MCP/runtime implementation already exists.

### 3. Remote-CI gap as a separate future adapter

Do **not** fold GitHub, `gh`, or arbitrary external CLIs into `process.run` just to turn `gh-fix-ci` into `NATIVE`.

The highest-value non-native gap observed in dogfooding is read-oriented remote CI/workflow inspection. Treat it as a separate bounded integration design after the advisory planner is shipped. A future interface should return structured repository/check/run/job evidence and should use an explicit connector/service boundary with its own authentication model.

This design intentionally does not define write/dispatch/rerun authority for remote CI.

## Data flow

1. GPT calls `skill.list` to discover candidate skills.
2. GPT calls `skill.inspect`.
3. KodeGPT parses the skill and runs the existing compatibility classifier.
4. A deterministic planner maps recognized semantics to the existing native capability metadata registry.
5. `skill.inspect` returns the current public metadata plus a bounded `capabilityPlan`.
6. GPT decides whether and how to call `workspace.inspect`, `context.build`, `code.search`, `file.*`, `git.*`, `verify.*`, or policy-approved `process.run`.
7. Each actual operation independently passes through the existing tool schema, workspace trust, effective policy, Rust authority, sandbox, and audit flow.

No stateful execution session is created by the skill layer.

## Security invariants

The phase must preserve all of the following:

- no `skill.run`;
- no provider invocation, session attachment, or credential reuse;
- no runtime dependency on Codex, Claude, CodexPro, or another provider agent;
- source admission/removal remains local CLI only;
- pin/unpin remains local CLI only;
- workspace trust remains local CLI only;
- compatibility/planning output is advisory and cannot widen effective policy;
- no state root, canonical trusted/source root, source capability ID, retained FD, private execution ID, PID/PGID, or provider credential in MCP output;
- script/resource loading remains data-only and never implies execution;
- source identity replacement remains fail closed even if a pin exists;
- Rust remains final OS/security authority;
- audit decision-before-OS-action ordering remains unchanged.

## Determinism and boundedness

The capability planner must be pure for a parsed skill plus static capability registry. It must not:

- read arbitrary workspace files;
- inspect environment variables;
- call external networks/providers;
- spawn processes;
- perform model inference;
- use host-specific paths;
- mutate skill/source/pin state.

All output arrays must have explicit hard bounds. `nativeCapabilities` and `guidance` are bounded by the exact current `NATIVE_CAPABILITY_IDS` registry size. `missingCapabilities`, `externalRequirements`, and `blockedSemantics` are each capped at 64 entries after bytewise sort/deduplication; exceeding a cap sets `truncated=true` and the matching stable `truncationReasons` entry. Ordering must be bytewise/deterministic, matching the current compatibility report conventions. The planner may reduce advisory detail only with this explicit truncation signal; it must never change or downgrade the full compatibility `classification` to fit a bound.

## Error handling

The planner does not convert errors into permissions.

- invalid declared requirements stay `PARTIAL` with the existing reason/missing-capability behavior;
- explicit provider requirements stay `PROVIDER_REQUIRED`;
- Codex/provider-agent/subagent execution semantics stay `UNSUPPORTED`;
- unknown external CLI semantics stay `PARTIAL`;
- planner serialization/schema failures fail the read-only inspection request rather than silently dropping security-relevant classification information.

## Host ergonomics

Tool descriptions should tell GPT that:

- `skill.inspect` returns an advisory plan, not an execution grant;
- `skill.load` returns instructions/resources as data;
- GPT should call ordinary native tools explicitly and respect their normal policy/confirmation behavior.

After any MCP tool schema or metadata change, release acceptance must refresh/rescan the ChatGPT app actions before claiming host evidence.

## Test strategy

Use TDD at four levels:

1. **Unit:** deterministic planner mapping, stable ordering, bounds, provider/unsupported preservation.
2. **MCP schema:** `skill.inspect` structured result includes the advisory plan while source paths/security handles remain absent; tool inventory remains exactly the same three read-only skill tools.
3. **Integration:** production MCP loads representative NATIVE/PARTIAL/PROVIDER_REQUIRED/UNSUPPORTED fixtures and returns expected plans without side effects or provider launch.
4. **Security/forbidden:** scan continues to reject `skill.run`, provider execution/spawning, MCP source/pin/trust mutation, and security-handle leakage.

Real ChatGPT host acceptance then verifies that the refreshed connector discovers the updated inspection schema and that GPT can use the returned advisory plan to call an existing native capability without KodeGPT auto-executing anything.

## Non-goals

This phase does not implement:

- autonomous agent loops;
- task/session orchestration inside KodeGPT;
- `skill.run`;
- Codex/Claude/provider process launch;
- generic shell execution;
- provider credential forwarding;
- MCP source/pin/trust mutation;
- new filesystem/Git/search/verify primitives that already exist;
- remote CI writes/reruns.

## Priorities

1. Add deterministic capability metadata and advisory planning to `skill.inspect`.
2. Improve tool descriptions/schema ergonomics and host acceptance around the advisory plan.
3. Dogfood again against representative skills and measure whether PARTIAL cases decrease without authority expansion.
4. Only then design a separate bounded remote-CI inspection adapter if `gh`/GitHub-dependent workflows remain a high-frequency gap.

This sequence keeps the next phase small, measurable, and reversible while preserving KodeGPT's core architecture: GPT Web reasons, KodeGPT exposes bounded capabilities, and Rust decides what the host may actually do.
