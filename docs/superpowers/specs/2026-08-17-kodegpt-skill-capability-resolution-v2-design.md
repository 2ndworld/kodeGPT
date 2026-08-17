# KodeGPT Skill Capability Resolution v2 Design

**Date:** 2026-08-17
**Status:** Approved by the user's instruction to continue the previously recommended Skill Capability Resolution v2 scope

## 1. Goal

Make `skill.inspect` explain whether external CLI requirements can actually be fulfilled in a specific READY workspace, without adding `skill.run`, automatic script execution, generic shell authority, or workspace-dependent skill discovery.

The feature turns static findings such as `external-cli:npx` into actionable runtime evidence when the caller supplies a workspace.

## 2. Existing behavior

Skill compatibility is intentionally static. `analyzeSkillCompatibility` classifies external CLI command snippets as missing capabilities such as `external-cli:npx`, and `buildSkillCapabilityPlan` mirrors those findings into an advisory plan.

That is correct for catalog/listing, but it cannot distinguish these materially different states:

- the executable is allowed and available in the current workspace;
- process/executable policy blocks it;
- policy allows it but the executable is not installed/visible;
- the executable exists but the sandbox needed to run it is unavailable.

The live KodeGPT repository demonstrates the gap: `find-skills` is statically `PARTIAL` because it requires `npx`, while a `trusted` workspace already permits `npx` and the runtime can inspect its availability.

## 3. Chosen architecture

Keep static compatibility and runtime resolution separate.

1. `SkillCatalog` and `skill.list` remain workspace-independent and unchanged.
2. `skill.inspect` gains one optional input: `workspaceId`.
3. Without `workspaceId`, current behavior/output remains unchanged.
4. With `workspaceId`, MCP orchestration obtains the READY workspace's effective policy and calls the existing `WorkspaceManager.inspectExecutable` runtime probe.
5. A focused resolver in `@kodegpt/skills` produces a context-aware `capabilityPlan`; it does not execute anything.

This avoids injecting `WorkspaceManager` into `SkillCatalog`, avoids reordering the production startup stack, and reuses the same policy/executable evidence already used by verification discovery.

## 4. Public contract

`skill.inspect` input becomes:

```ts
{
  skillId: string;
  fingerprint?: string;
  workspaceId?: string;
}
```

`SkillCapabilityPlan` gains an optional field that appears only for workspace-aware resolution:

```ts
export type SkillExternalCliStatus =
  | "available"
  | "not-allowed"
  | "not-installed"
  | "sandbox-unavailable";

export interface SkillExternalCliResolution {
  requirement: string;       // e.g. external-cli:npx
  executable: string;        // e.g. npx
  status: SkillExternalCliStatus;
  capability: "process.run";
}

interface SkillCapabilityPlan {
  // existing fields remain
  externalCliRequirements?: readonly SkillExternalCliResolution[];
}
```

The existing `skill.compatibility` report stays static. This is deliberate: listing and fingerprint-era compatibility should not change merely because a different workspace is active.

The context-aware `capabilityPlan.classification` is effective readiness:

- `UNSUPPORTED` remains `UNSUPPORTED`;
- `PROVIDER_REQUIRED` remains `PROVIDER_REQUIRED`;
- `PARTIAL` remains `PARTIAL` while any missing capability is unresolved;
- a plan whose only missing findings are external CLIs that resolve `available` becomes `NATIVE` for that workspace.

## 5. External CLI resolution

For each bounded `missingCapabilities` entry with prefix `external-cli:`:

1. If `allowProcess` is false, status is `not-allowed`.
2. If the executable name is absent from `allowedExecutableNames`, status is `not-allowed`.
3. Otherwise call the existing runtime `inspectExecutable(workspaceId, executable)`.
4. If `executableAvailable` is false, status is `not-installed`.
5. Else if `sandboxAvailable` is false, status is `sandbox-unavailable`.
6. Otherwise status is `available`.

Available requirements are removed from effective `missingCapabilities`. Blocked/unavailable ones remain.

When at least one external CLI is available, `process.run` is added to effective `nativeCapabilities` and guidance (deduplicated and deterministically ordered), making the ordinary capability needed to fulfill the requirement explicit.

No command argv is inferred or executed by this feature.

## 6. Errors and authority

Supplying `workspaceId` requires a READY workspace. Unknown/closed workspaces use the existing workspace error path; there is no fallback to host-global executable inspection.

The runtime probe is read-only and returns only booleans already exposed internally (`executableAvailable`, `sandboxAvailable`). No executable host path is returned.

The feature does not widen profile authority. `trusted`, `develop`, and `observe` continue to control process/network/executable permission exactly as before.

## 7. Bounds and determinism

The existing capability-plan finding ceiling of 64 remains authoritative.

- only already-bounded `missingCapabilities` entries are resolved;
- at most 64 executable probes can occur per inspect call;
- duplicate external CLI requirements are resolved once;
- output is UTF-8 deterministically sorted;
- no filesystem scan, PATH scan, network call, package installation, or background work is added.

## 8. Testing

TDD must prove:

1. generic `skill.inspect` without `workspaceId` remains unchanged;
2. allowed + executable available + sandbox available => `available`, missing entry removed, effective classification can become `NATIVE`, `process.run` guidance appears;
3. process disabled => `not-allowed`, no executable probe;
4. executable not allowlisted => `not-allowed`, no executable probe;
5. allowlisted but unavailable => `not-installed`;
6. executable available but sandbox unavailable => `sandbox-unavailable`;
7. non-external missing capabilities are untouched;
8. `UNSUPPORTED` and `PROVIDER_REQUIRED` cannot be promoted by external CLI resolution;
9. multiple/duplicate requirements are deterministically deduplicated/bounded;
10. MCP `skill.inspect` accepts optional `workspaceId` and uses READY workspace policy/probe evidence;
11. no `skill.run`, tool-count change, automatic command execution, or authority widening occurs.

## 9. Non-goals

Deferred unless usage proves value:

- `skill.run` or automatic skill execution;
- inferring argv from skill prose and executing it;
- installing missing CLIs;
- arbitrary PATH/host environment exposure;
- provider resolution in this phase;
- changing `skill.list` classification based on active workspace;
- generic requirement/plugin resolver framework;
- persistent capability-resolution cache;
- background executable monitoring.

## 10. Versioning

This is an additive refinement of the existing `skill.inspect` tool rather than a new capability. Runtime/protocol/MCP surface remain `0.1 / 2026-07-28 / 0.7`, and the public tool count remains unchanged.

## 11. Completion gate

Complete when focused skills/MCP/startup tests, full TypeScript tests, typecheck, build, Rust/security gates, and host smoke pass; a live `skill.inspect` against a `trusted` workspace must show `find-skills`' `external-cli:npx` as `available` when the existing runtime probe confirms it, while the static `skill.compatibility` remains `PARTIAL`.
