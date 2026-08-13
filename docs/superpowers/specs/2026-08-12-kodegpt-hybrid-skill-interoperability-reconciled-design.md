# KodeGPT Phase 2 — Hybrid Skill Interoperability Reconciled Design

Date: 2026-08-12
Status: Approved reconciliation for implementation
Baseline: `main@b8a3b71` (`chore(capabilities): complete native capability surface`)
Supersedes for Phase 2 execution only: stale assumptions in `2026-08-11-kodegpt-hybrid-skill-interoperability.md`
Preserves: `2026-08-11-kodegpt-capability-hub-skill-interoperability-design.md`

> **Execution reconciliation (2026-08-13):** Phase 2 is now shipped and the semantic MCP surface is `0.3` with protocol `2026-07-28`. Current source/tests define the final public bounds, stable `sk_... + fingerprint` identity model, `skill.list.compatibility` filter, and private `skills/pinned/<skillId>/<fingerprint>` storage layout documented below. Baseline references to surface `0.2` describe the pre-Phase-2 starting point, not the current release state.

## 1. Goal

Phase 2 lets GPT Web discover, inspect, and load portable Agent Skills-compatible instruction/resource bundles without executing Codex, Codex CLI, Codex app-server, a second reasoning agent, or bundled skill scripts.

The execution model remains:

```text
GPT Web reasons
  → skill.list / skill.inspect / skill.load
  → bounded instructions/resources
  → GPT Web reasons
  → existing native KodeGPT capabilities
  → existing WorkspaceManager / ExecutionManager / Rust authority
```

There is no `skill.run`.

## 2. Baseline facts that changed after the original Phase 2 plan

Phase 1 is now complete and production-wired. The baseline already contains:

```text
workspace.inspect
code.search
git.changes
file.patch
verify.list
verify.run
context.build
stable CapabilityError boundaries
retained-root path identity
content-sensitive Git checkpoints
semantic verification audit
one production NativeCapabilityService
one production WorkspaceManager
MCP semantic surface 0.2
```

Canonical runtime TypeScript schema is `packages/protocol/src/runtime-types.ts`, not the stale `packages/protocol/src/types.ts` path from the original Phase 2 plan.

Phase 1 also established a permanent lifecycle rule:

```text
implemented
  → production-wired
  → real production E2E-tested
  → advertised on MCP
```

Phase 2 must not repeat the earlier `workspace.inspect` ordering bug by advertising `skill.*` before production wiring.

## 3. Permanent security invariants

1. Rust remains final authority for external live-source filesystem access.
2. No Codex subprocess, `codex exec`, Codex session attachment, Codex credential reuse, or Codex runtime dependency.
3. No `skill.run`.
4. No automatic execution of `scripts/` resources.
5. Skill metadata/instructions cannot widen workspace trust, write, process, network, executable, environment, provider, or desktop authority.
6. Workspace trust remains local-only and unrelated to skill-source admission.
7. Live external skill sources are read-only by construction.
8. Skill-source registration/removal and pin/unpin are local CLI authority only; MCP cannot admit host paths.
9. No Node/TypeScript fallback that directly traverses live source roots when Rust fails.
10. External skill roots cannot overlap `~/.kodegpt` by equal/ancestor/descendant visible or backing-tree identity.
11. Retained-root operations remain beneath/no-magiclink/no-cross-mount and reject symlink escape.
12. Audit decision must be durable before live external filesystem reads and source admission effects.
13. Audit failure fails closed.
14. Host absolute source paths, retained FDs, capability IDs, credentials, and raw host errors never enter MCP results/errors.
15. All list/inspect/load outputs are bounded and explicitly incomplete when limits are reached.
16. Provider execution remains Phase 3; `PROVIDER_REQUIRED` is classification only.

## 4. Agent Skills compatibility boundary

KodeGPT targets the Agent Skills directory model:

```text
<skill-dir>/
  SKILL.md
  scripts/        optional
  references/     optional
  assets/         optional
  other resources optional
```

`SKILL.md` contains YAML frontmatter plus Markdown instructions. Required v1 fields are `name` and `description`.

Recognized advisory metadata may include:

```text
license
compatibility
metadata
allowed-tools
```

`allowed-tools` is treated as advisory compatibility evidence only. It never grants authority.

Scripts and executable-looking resources are inert data. KodeGPT may inventory, hash, pin, and explicitly return bounded text source, but never execute them through the skill subsystem.

## 5. Source model

Skill sources are separate from workspaces.

Supported v1 source modes:

```text
live registered source
immutable pinned snapshot
```

Conventional live roots such as `~/.codex/skills` or `~/.agents/skills` may be registered only by explicit local CLI action. They are not auto-enabled.

Public MCP never accepts an arbitrary source path.

### 5.1 Source identity

Persisted source admission stores:

```ts
interface PersistedSkillSource {
  schemaVersion: 1;
  sourceId: string; // ss_<opaque>
  label: string;
  kind: "agent-skills";
  canonicalRoot: string; // local state only, never MCP
  identity: {
    deviceMajor: number;
    deviceMinor: number;
    inode: string;
  };
}
```

Source replacement/mismatch returns `SKILL_SOURCE_IDENTITY_CHANGED`; KodeGPT never silently refreshes identity.

### 5.2 Rust retained source registry

Add a dedicated read-only source registry in Rust/workspace-io, separate from workspace registry. It retains a root FD and filesystem identity but has no policy/write/process fields.

Internal runtime methods use source IDs/capabilities and relative paths. No write/process runtime method accepts a source capability.

## 6. Symlink and resource boundary policy

V1 fail-closed behavior:

```text
source root: canonicalized and identity-pinned at local admission
skill directory symlink: rejected
SKILL.md symlink: rejected
resource symlink: rejected/unloadable
magic-link escape: rejected
cross-mount escape: rejected
```

KodeGPT does not follow a resource symlink to obtain bytes from outside the retained source root.

## 7. Bounded discovery and loading

Hard design ceilings:

```text
MAX_SOURCES                  = 16
MAX_SKILLS_PER_SOURCE        = 1_000
MAX_SOURCE_ENTRIES           = 20_000
SKILL_DESCRIPTOR_MAX_BYTES   = 64 KiB
SKILL_MD_MAX_BYTES           = 256 KiB
MAX_RESOURCES_PER_SKILL      = 256
RESOURCE_TEXT_MAX_BYTES      = 256 KiB
SKILL_BUNDLE_MAX_BYTES       = 1 MiB
SKILL_LOAD_MAX_BYTES         = 1 MiB
MAX_SKILL_NAME_BYTES         = 128
MAX_DESCRIPTION_BYTES        = 4 KiB
```

Discovery is shallow at source-root skill-directory level: identify direct child directories containing regular `SKILL.md`. Do not recursively scan an entire home tree looking for arbitrary `SKILL.md` files.

Limit exhaustion is explicit; no result may claim completeness after silently skipping entries because of a bound.

The public MCP skill tools intentionally use stricter bounds than the internal catalog/bundle ceilings:

```text
skill.list result limit            <= 500
skill.load requested resources     <= 32
skill.load returned bytes          <= 512 KiB
```

The internal 1,000-skill/source, 64 loaded-resource, and 1 MiB bundle/load ceilings remain internal implementation bounds and must not be presented as the public MCP contract.

## 8. Progressive disclosure

### `skill.list`

Returns bounded descriptors only:

```text
skillId
name
description
sourceId/sourceKind (host-safe)
live/pinned availability
descriptor fingerprint
compatibility summary
warnings/truncation metadata
```

Optional read-only filters are applied before the public result limit in this order: `sourceId`, `compatibility`, `pinned`, then limit. `compatibility` accepts only `NATIVE | PARTIAL | PROVIDER_REQUIRED | UNSUPPORTED`.

### `skill.inspect`

Adds:

```text
validated frontmatter
resource inventory
bundle fingerprint
byte counts
compatibility evidence
warnings
```

It does not automatically return every resource body.

### `skill.load`

Returns bounded `SKILL.md` instructions plus explicitly requested text resources. Requested resource paths must exactly match the inventory produced by inspect; this is not an arbitrary relative-path read API.

Live load supports an expected fingerprint. If the live bundle changed, fail with `SKILL_FINGERPRINT_MISMATCH` rather than silently returning different instructions.

## 9. Parsing rules

Use strict YAML parsing with unique keys and no executable/custom tags.

Require `name` and `description`.

The Markdown body is opaque instruction text, not an executable DSL.

Unknown external metadata keys are ignored or surfaced as bounded `unknownMetadataKeys`; they are never interpreted as permission.

Binary/non-UTF8 resources may appear in inventory metadata but are not inlined by `skill.load` v1.

## 10. Skill identity and fingerprints

Public identity never depends on a host absolute path.

Use opaque IDs and immutable version selectors:

```text
ss_... source identity
sk_... stable skill identity
(skillId, fingerprint) immutable live/pinned version selector
availability/pinned live-vs-pinned state
```

The shipped contract does not create a second public `sp_...` identity for pinned content. Keeping the same `sk_...` identity across live and pinned versions avoids identity churn while the fingerprint preserves immutable reproducibility.

Duplicate skill names across sources are not shadowed. They remain separate opaque IDs and may expose `nameCollision:true`.

### 10.1 Descriptor fingerprint

```text
SHA-256(exact SKILL.md bytes)
```

Used for cheap discovery-change detection.

### 10.2 Bundle fingerprint

Canonical versioned stream over every accepted regular file in the bounded bundle:

```text
schema marker
relative path
entry type
byte length
SHA-256 content
```

Records are sorted lexically. Host path, timestamps, inode, source ID, request ID, operation ID, and pin ID are excluded.

The same content at another admitted path yields the same bundle fingerprint.

## 11. Immutable pin store

Pinned content is KodeGPT-owned private state under the current shipped layout:

```text
<stateRoot>/skills/pinned/<skillId>/<fingerprint>/
```

with a versioned manifest containing provenance-safe metadata equivalent to:

```text
schemaVersion
skillId
name
description
fingerprint
provenance { sourceId, sourceKind, sourceRelativePath, pinnedAt }
files[{path, bytes, sha256}]
```

There is no separate public pin ID. No canonical source root is stored in model-visible skill results or in the pin manifest.

Pin creation uses the Rust source authority to read the complete bounded bundle, writes to a temporary private state directory, fsyncs, then atomically publishes the content-addressed directory. Same fingerprint is idempotent. Failed pin creation leaves no visible partial pin.

## 12. Compatibility resolver

Locked public classes:

```text
NATIVE
PARTIAL
PROVIDER_REQUIRED
UNSUPPORTED
```

The resolver is advisory only and never changes effective policy.

Evidence precedence:

```text
1. KodeGPT-owned explicit compatibility overlay/pin metadata
2. safely recognized structured skill metadata
3. conservative allowed-tools mapping
4. free-text compatibility shown for humans only
5. unknown requirements => PARTIAL
```

Do not heuristically parse general Markdown prose to grant `NATIVE`.

### NATIVE
All explicitly known requirements map to native KodeGPT capability vocabulary.

### PARTIAL
Skill is readable/useful but full requirements cannot be proven or some requirement is unmapped.

### PROVIDER_REQUIRED
A known requirement belongs to an external provider/integration that Phase 2 does not implement.

### UNSUPPORTED
Known requirement contradicts the product/security model, e.g. unrestricted shell, mandatory Codex runtime, hidden subagent/session semantics, or executing bundled arbitrary scripts as authority.

## 13. Native capability vocabulary

Compatibility vocabulary is descriptive, not permission. It may include:

```text
workspace.inspect
context.build
code.search
file.read
file.patch
git.changes
git.status
git.diff
verify.list
verify.run
artifact.read
process.run
```

`process.run` remains subject to existing workspace policy, trusted executable resolution, Bubblewrap, env/network restrictions, and audit. Skill metadata cannot override any of them.

## 14. Audit semantics

Add Rust audit actions for every external live-source operation that crosses the retained host-filesystem authority:

```text
skill_source_inspect_root
skill_source_register
skill_source_tree
skill_source_read
skill_source_unregister
```

For those operations:

```text
durable audit decision
  → retained-root filesystem operation
  → durable audit outcome
```

Pinned snapshot creation/removal is a local-only mutation of KodeGPT-owned versioned state, analogous to other Node-owned local state stores. Phase 2 v1 does **not** add a generic Node→Rust audit-record RPC merely to log pin/unpin; doing so would create a new generic audit surface without guarding the actual state write. Pin/unpin instead require private permissions, fsync/atomic publication, strict schema validation, and local CLI-only authority.

Audit may contain source/skill opaque IDs, safe digest, counts, and result category.

Audit must not contain skill instruction text, resource bodies, host paths, credentials, environment values, or script bodies.

## 15. Stable error contract

Phase 2 extends stable errors with at least:

```text
SKILL_SOURCE_NOT_FOUND
SKILL_SOURCE_INVALID
SKILL_SOURCE_STATE_OVERLAP
SKILL_SOURCE_IDENTITY_CHANGED
SKILL_SOURCE_UNAVAILABLE
SKILL_SOURCE_BOUNDARY_VIOLATION
SKILL_SOURCE_LIMIT_EXCEEDED
SKILL_REGISTRY_INVALID
SKILL_REGISTRY_SCHEMA_UNSUPPORTED
SKILL_NOT_FOUND
SKILL_BUNDLE_INVALID
SKILL_FINGERPRINT_MISMATCH
SKILL_RESOURCE_UNSUPPORTED
SKILL_LOAD_LIMIT_EXCEEDED
SKILL_PIN_INVALID
SKILL_PIN_SCHEMA_UNSUPPORTED
```

Unknown internal failures collapse to a safe generic skill error at MCP boundary; host paths/raw OS messages are not forwarded.

## 16. Production integration rule

There must remain exactly one production kernel/runtime authority.

`@kodegpt/skills` orchestrates through narrow typed adapters over the existing `KernelClient`/production stack. It must not create another `WorkspaceManager`, `ExecutionManager`, runtime process, audit sink, or direct live-source filesystem implementation.

The public lifecycle is:

```text
Tasks 1–7: implement internal/source/pin/compatibility + local CLI
Task 8: production wire and E2E without public skill tools
Task 9: advertise skill.list / skill.inspect / skill.load and bump surface 0.2 → 0.3
Task 10: full security/release audit
```

## 17. MCP surface

Phase 2 adds only:

```text
skill.list
skill.inspect
skill.load
```

All are read-only annotated.

MCP does not expose:

```text
skill.run
skill.pin
skill.unpin
skill.source.add
skill.source.remove
```

MCP semantic surface advances exactly once from `0.2` to `0.3` when all three tools are already production-wired and E2E-proven. MCP protocol remains `2026-07-28`.

## 18. Local CLI authority

Recommended local commands:

```text
kodegpt skill source list
kodegpt skill source add <absolute-path> [--label <label>]
kodegpt skill source remove <source-id>
kodegpt skill pin <skill-id> [--fingerprint <sha256>]
kodegpt skill pins
kodegpt skill unpin <pin-id>
```

Exact spelling may follow existing CLI parsing conventions, but source/pin mutation remains local only.

## 19. Phase 3 boundary

Phase 2 does not call downstream MCP providers or external integrations.

`PROVIDER_REQUIRED` records a compatibility gap only. Provider credentials, allowlists, invocation audit, and provider policy belong to a separate future Provider Gateway design.

## 20. Definition of done

Phase 2 is complete only when GPT Web can discover an explicitly admitted Agent Skill, inspect its metadata/resources, load bounded instructions/resources, and understand compatibility classification while remaining unable to execute the skill, execute its scripts automatically, register arbitrary roots remotely, access `~/.kodegpt`, launch Codex, bypass Rust/audit, or widen policy.
