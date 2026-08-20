# KodeGPT Developer Environment + Continuity Design

Date: 2026-08-20
Status: written-spec review gate
Baseline: `main == origin/main == 1c06de42cd1374edaaab9f2fef0c14401bb2b232`
Final target: `runtime 0.1 / MCP protocol 2026-07-28 / semantic surface 0.17 / 76 public tools`
Branch: `feat/developer-environment-continuity`
Worktree: `.worktrees/developer-environment-continuity`

## Problem

KodeGPT's current development surface is already strong for typed repository work, Git/GitHub/CI, preview/browser/visual evidence, and trusted shell execution. The remaining capability gaps are concentrated in four areas that currently look separate but share common roots:

1. generic terminal / shell freedom is available in the `trusted` profile through `bash` / `sh`, but the sandbox's controlled `PATH` and executable resolver still make user-managed developer toolchains awkward;
2. multi-language/toolchain support is therefore narrower in practice than the trusted shell semantics imply, despite the shell already being able to invoke nested commands;
3. the extension registry is declarative metadata/restriction state, not a real executable plugin ecosystem, while the skill system already provides the more useful portable extension model;
4. development continuity across chats or host sessions relies on conversational state and `.ai-bridge/current-plan.md`, but KodeGPT has no small native workspace checkpoint that records the current development objective/evidence without duplicating a full conversation database.

Treating those gaps independently would create redundant subsystems: a shell subsystem, a language registry, an executable plugin runtime, and a session database. This design instead addresses the shared causes with a small set of coherent primitives.

## Goals

1. Make `trusted` development effectively language/toolchain-agnostic without inheriting the host user's entire environment or making KodeGPT an unsandboxed shell.
2. Preserve the existing structured tools as the preferred deterministic interface while making `process.run` a practical escape hatch for arbitrary project CLIs.
3. Generalize Node/Rust user-managed toolchain handling into one reusable developer-environment model rather than adding language-specific hard-coding.
4. Extend `verify.list` / `verify.run` to any ecosystem through explicit repository-defined recipes while preserving current Node/Cargo automatic discovery.
5. Use Agent Skills as the primary extension ecosystem; do not turn `packages/extensions` into an executable plugin VM.
6. Improve skill discovery for trusted repository-local skills without widening authority over arbitrary user-home directories.
7. Add bounded native development continuity without creating a conversation/session engine.
8. Make KodeGPT multi-agent-ready through conflict-resistant shared state, while keeping agent reasoning/orchestration owned by the host.
9. Improve capability discoverability so trusted-shell and developer-environment behavior is visible to hosts without historical-document archaeology.

## Non-Goals

This design does **not** add:

- a second KodeGPT agent or model runtime;
- `agent.spawn`, `agent.delegate`, subagent scheduling, queues, supervisors, or model/provider selection;
- a conversation transcript database, session fork/resume engine, or chat archive;
- an executable JavaScript/Python extension runtime;
- extension-defined arbitrary MCP tools loaded at runtime;
- a KodeGPT skill marketplace;
- generic provider invocation, arbitrary HTTP, or provider credential scraping;
- automatic execution of code embedded in Agent Skills;
- automatic activation of arbitrary user-home skill directories;
- host-wide `PATH`, `HOME`, shell startup files, or environment inheritance;
- language-specific public MCP tools such as `go.test`, `java.run`, `python.test`, or `flutter.run`;
- a replacement for typed Git/GitHub/CI/file/browser/preview capabilities that already exist.

## Architectural Direction

The target remains:

```text
ChatGPT / host reasoning
        |
        | may use host-native subagents when available
        v
KodeGPT capability layer
        |
        +-- typed repository/Git/GitHub/CI/browser capabilities
        +-- Developer Environment
        +-- Verification recipes
        +-- Skills
        +-- Workspace Continuity Checkpoint
        |
        v
Rust policy / executable identity / sandbox / audit authority
        |
        v
Bubblewrap + retained workspace + approved read-only toolchain roots
```

KodeGPT remains a capability/control plane. It becomes more portable and stateful where that directly improves development, but it does not become an autonomous coding-agent platform.

# Part A — Execution Discoverability Reconciliation

## Current behavior

The built-in `trusted` profile already allows top-level `bash` and `sh`. Trusted Process Policy v2 intentionally permits nested commands launched by those shells inside the existing Bubblewrap sandbox without revalidating each nested executable against the top-level `allowedExecutableNames` list.

Therefore the current gap is not the absence of shell execution. It is primarily that the public capability description and effective environment do not make the real semantics obvious enough.

## Design

Do not add `shell.run` or another process tool.

Keep:

- `process.run`
- `process.status`
- `process.cancel`

Refine public self-description so the host can discover feature support without confusing it with one workspace's effective policy:

```ts
execution: {
  processRun: true;
  explicitTrustedShell: true;
  dynamicExecutableResolution: true;
  developerEnvironmentRegistry: true;
  inheritsHostEnvironment: false;
}
```

Expose this feature summary through the existing global `system.capabilities` result. `profile.current` / `profile.inspect` expose the workspace/preset-specific `allowDynamicExecutables`, `allowedExecutableNames`, `inheritEnv`, and network policy. The feature summary is derived from registered runtime capabilities rather than historical documentation.

Update `process.run` documentation to make the distinction explicit:

- KodeGPT does not implicitly wrap every command in a shell;
- on a profile where `bash` or `sh` is admitted, callers may explicitly run `bash -lc ...` / `sh -lc ...` inside the existing sandbox;
- structured tools remain preferred when they match the operation.

No public tool is added for this part.

# Part B — Registered Developer Environment

## Problem

The trusted executable resolver currently supports system executables plus special user-managed roots for Node and Rust through dedicated environment variables. This proves the required trust mechanism exists, but the model is language-specific.

The desired capability is not "support Go/Java/Python/Flutter individually." The desired capability is "allow explicitly registered developer-tool roots to participate in the controlled sandbox environment."

## Model

Introduce a KodeGPT-owned **Developer Environment Registry** containing explicit local toolchain roots.

A registry entry represents one operator-approved root, for example:

```text
~/.nvm/versions/node/v24.x
~/.rustup/toolchains/stable-...
~/.local/share/uv/...
/usr/lib/jvm/java-...
/usr/local/go
~/flutter
```

Persist the registry beneath the private KodeGPT state root at `developer-environments/registry.json` with schema version 1, atomic replacement, and private permissions. The v1 persisted entry is language-agnostic:

```ts
interface DeveloperEnvironmentEntryV1 {
  id: string;
  label: string;
  source: "bootstrap" | "operator" | "synced-shell";
  canonicalRoot: string;
  executableDirs: string[]; // relative to canonicalRoot, usually ["bin"]
  identity: PersistentFilesystemIdentity;
}
```

The registry contains at most 32 entries. Each entry has 1..4 normalized executable directories, a label <= 120 UTF-8 bytes, and a canonical root outside KodeGPT state and all currently trusted workspace roots. Unknown schema versions or malformed entries fail closed rather than being skipped.

`canonicalRoot` and filesystem identity are local/operator state and are not returned through MCP. `kodegpt env list/doctor` may show local paths because those commands execute locally. MCP exposes only feature/effective-policy availability, not the registry paths.

## Local-only management

Developer-environment registration is local authority, not remote MCP authority.

CLI surface:

```text
kodegpt env sync
kodegpt env add <root> [--exec-dir <relative>]
kodegpt env list
kodegpt env remove <id>
kodegpt env doctor [executable]
```

`env add` is the explicit path for a toolchain that is intentionally not present on the current shell `PATH`. It canonicalizes and validates the root using the same rules as `env sync`; `--exec-dir` defaults to `bin`, must stay beneath the root, and is stored as a normalized relative path.

### `env sync`

`env sync` is a local convenience operation. It inspects the CLI process's current `PATH` once, ignores standard system executable directories already covered by the trusted system resolver, canonicalizes remaining candidate executable directories, and persists each safe candidate directory itself as a minimal root with executable directory `.`. It does not automatically widen a `.../bin` path to its parent toolchain root. Toolchains that need sibling `lib`/runtime resources or whose executable symlinks escape the PATH directory use explicit `env add <toolchain-root> --exec-dir bin` instead.

It must reject roots that are missing, unsafe, world/group-writable beyond the existing explicit-root rules, beneath the KodeGPT state root, or located beneath any currently trusted workspace root. This prevents project-controlled `node_modules/.bin` or similar workspace content from silently becoming top-level trusted executables and avoids broad mounting of unrelated user directories such as all of `~/.local`. Duplicate/nested candidates are normalized deterministically. Persistent service behavior does not depend on the source shell remaining active, and registry changes are read on demand by the runtime so no service restart is required.

### `env list`

Shows registered roots, availability, executable count/summary, and drift/staleness status without exposing unnecessary secret/environment data.

### `env doctor`

Diagnoses why a developer executable is or is not usable through KodeGPT, including at least:

- root missing;
- root identity changed;
- executable absent;
- unsafe ownership/permissions;
- sandbox mount unavailable;
- policy does not admit registered developer executables.

It must not execute arbitrary project commands merely to diagnose availability.

## Resolver behavior

Generalize the current Node/Rust explicit-root mechanism into a generic registered-root resolver.

Resolution is deterministic and separates security-authority executables from developer executables:

1. internal Bubblewrap/Git authority continues to use the existing trusted-system resolver only;
2. top-level `bash` and `sh` remain system-only and cannot be shadowed by a registered developer root;
3. for other `process.run` / verification logical executable names when `allowDynamicExecutables:true`, search registered roots in persisted order first, then trusted system executable locations;
4. when `allowDynamicExecutables:false`, use only the existing fixed-policy/system resolution path.

This lets an explicitly selected NVM/JDK/Go/etc. environment override an older system toolchain without weakening the trusted system shell or internal Git/Bubblewrap authority.

A logical executable name remains a simple name, not a caller-supplied path. Path traversal/absolute path selection remains forbidden.

For each registered root:

- the root identity is validated locally before use;
- the executable must remain beneath the registered root;
- executable identity/permission checks remain authoritative;
- the root is mounted read-only in Bubblewrap;
- the executable is revalidated immediately before launch consistent with existing trusted executable semantics.

On first open of an absent v1 registry, KodeGPT seeds `bootstrap` entries from the same Node runtime root and stable Rust toolchain root it currently supplies through `KODEGPT_HOST_NODE_ROOT` / `KODEGPT_HOST_RUST_TOOLCHAIN_ROOT`, when those roots pass validation. After the registry migration is active, the runtime resolver reads the registry from `KODEGPT_STATE_ROOT` on demand and the Node/Rust-specific resolver environment variables are removed. This leaves one explicit-root model rather than permanent parallel special cases. Existing managed Cargo home and Corepack support remain functional; their writable/cache semantics are runtime support concerns and are not converted into developer-environment roots.

## Controlled PATH

Do **not** set `inheritEnv:true` and do not import the host user's raw `PATH` into runtime policy.

Inside a trusted sandbox with `allowDynamicExecutables:true`, build a deterministic `PATH` from:

1. registered developer executable directories in persisted order, mounted read-only with their containing roots;
2. existing trusted system executable directories;
3. any existing KodeGPT-private paths required by runtime behavior.

When `allowDynamicExecutables:false`, omit developer directories entirely. System `bash` / `sh` selection remains system-only even though nested shell command lookup uses the controlled developer `PATH`.

For a dynamic trusted launch, the runtime opens and revalidates all currently registered roots (bounded to 32) before spawn, passes the retained read-only root descriptors to Bubblewrap, and mounts them using the existing `/opt/kodegpt-toolchain[-N]` pattern. `PATH` entries point to each entry's normalized executable directories inside those mounts. This generalizes the current explicit Node/Rust mount mechanism and ensures nested tools such as `npm -> node`, `cargo -> rustc`, or `gradle -> java` see the same admitted environment.

This same path is available to nested `bash` / `sh` commands so that:

```text
go test ./...
uv run pytest
bun test
gradle test
flutter test
```

can work when their executables belong to registered roots.

## Policy

Do not expand the built-in trusted `allowedExecutableNames` list indefinitely.

Add one runtime/profile policy field:

```ts
allowDynamicExecutables: boolean
```

Built-in values are:

- `observe`: `allowDynamicExecutables:false`;
- `develop`: `allowDynamicExecutables:false`;
- `trusted`: `allowDynamicExecutables:true`.

`resolveProfile` treats `true` as additional authority: a project restriction may change `true -> false` but never `false -> true`. The field is carried through the existing runtime policy contract alongside `allowProcess` and `allowedExecutableNames`.

When `allowDynamicExecutables:false`, `allowedExecutableNames` remains the complete top-level process allowlist. When `allowDynamicExecutables:true`, a logical name absent from that fixed list may still run only if the trusted resolver finds it either in an approved registered developer root or in an existing trusted system executable directory. Resolution failure remains a hard denial. `bash` and `sh` keep their system-only special rule.

This makes the `trusted` profile genuinely high-agency without forcing every developer/system CLI name into a hard-coded preset, while `develop` keeps the current fixed-list behavior.

# Part C — Language-Agnostic Verification Recipes

## Current behavior

`verify.list` automatically discovers common package scripts and Cargo recipes. That behavior is valuable and should remain.

The mistake would be to hard-code every ecosystem manifest and standard command into KodeGPT core.

## Design

Keep automatic built-in discovery for current high-value ecosystems, but add one explicit repository-defined verification recipe source.

Use the existing repository-local `.kodegpt/` namespace and define bounded recipes in:

```text
.kodegpt/verify.json
```

A workspace-owned config can declare recipes like:

```json
{
  "schemaVersion": 1,
  "recipes": {
    "test": {
      "label": "Go test",
      "category": "test",
      "logicalExecutable": "go",
      "argv": ["test", "./..."],
      "cwd": "."
    },
    "lint": {
      "label": "Go lint",
      "category": "lint",
      "logicalExecutable": "golangci-lint",
      "argv": ["run"],
      "cwd": "."
    }
  }
}
```

The file uses a strict schema-versioned format (`schemaVersion: 1`) and is read through retained workspace authority with the same boundary discipline as `.kodegpt/profile.json`.

Requirements:

- file size <= 64 KiB UTF-8 and exact top-level keys `schemaVersion` + `recipes`;
- <= 32 recipes; recipe keys match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`;
- public recipe ID is `config:<recipe-key>`;
- every recipe has exact keys `label`, `category`, `logicalExecutable`, `argv`, and `cwd`; unknown fields are rejected;
- `label` is 1..120 UTF-8 bytes;
- `category` uses the existing verification category enum;
- `logicalExecutable` uses the existing simple logical-name validation, never a path, and repository-defined recipes may not select `bash` or `sh`;
- `argv` has <= 64 elements, each <= 4096 UTF-8 bytes;
- `cwd` is a safe workspace-relative path <= 4096 UTF-8 bytes;
- no shell snippets or recipe-specific environment overrides are accepted;
- discovery performs no command execution;
- `verify.list` reuses current static availability/policy checks;
- `verify.run` re-resolves the recipe and environment immediately before execution;
- registered developer executables may satisfy recipe availability when effective policy permits them;
- existing `verify.list` / `verify.run` public tools remain the only verification tools.

This produces language/toolchain flexibility without a language registry.

# Part D — Skills as the Primary Extension Ecosystem

## Current state

`packages/extensions` currently represents declarative extension metadata and profile restrictions. It is not an executable plugin runtime. `skill.list` / `skill.inspect` / `skill.load`, live/pinned sources, fingerprints, compatibility resolution, and workspace-aware CLI readiness already provide a stronger foundation for reusable development behavior.

## Decision

Do not evolve extensions into an executable plugin runtime merely to achieve feature-parity branding with Codex plugins.

The capability role is intentionally singular:

```text
skills = reusable instructions/resources + compatibility requirements
```

Phase 4 source/live audit found no production writer for the legacy declarative extension registry, no runtime consumer for `profileRestrictions`, and an empty live `extension.list`. The unreleased `0.17` candidate therefore removes `extension.list`, its startup registry wiring, and `packages/extensions` instead of preserving dead metadata or expanding it into a plugin runtime. No `extension.run`, dynamic handler loader, plugin VM, arbitrary code import, or runtime MCP tool registration is introduced.

## Workspace-local skill discovery

Add automatic discovery for these conservative conventional skill roots **inside an already READY trusted workspace**:

```text
skills/
.agents/skills/
.codex/skills/
```

Rules:

- only roots beneath the READY workspace retained authority are eligible;
- no additional filesystem authority is created;
- existing skill parser/resource bounds/fingerprinting remain authoritative;
- repository-local auto-discovery is read-only;
- duplicate skill identity/fingerprint conflicts are handled deterministically;
- explicit registered external sources continue to work independently.

External roots such as `~/.agents/skills` or `~/.codex/skills` remain explicit local operator registrations because they are outside workspace authority.

Because repository-local skills are workspace-scoped rather than global, extend the existing skill inputs without adding tools:

- `skill.list` gains optional `workspaceId`; without it, behavior remains the current global registered/pinned catalog, while with it the result additionally includes conventional skills beneath that READY workspace;
- `skill.inspect` already accepts `workspaceId`; a workspace-local skill requires the matching `workspaceId`;
- `skill.load` gains optional `workspaceId`; a workspace-local skill requires the matching `workspaceId`.

Workspace-local source identity is derived from durable trust identity + conventional relative source root, so opaque skill IDs remain deterministic across service restart while the trust and skill fingerprint remain unchanged. Closing a workspace removes only the ephemeral runtime binding; untrust makes those local skills inaccessible.

Optional CLI assistance may suggest conventional external roots, but KodeGPT must not silently activate them.

## Skill compatibility integration

The existing workspace-aware skill capability plan should consume the generalized Developer Environment availability rather than Node/Rust-specific executable assumptions.

Example:

```text
skill requires external-cli:uv
        |
        v
registered Developer Environment resolves `uv`
        |
        v
skill.inspect(..., workspaceId) => effective NATIVE/available
```

Skills remain instructions/data only. They never grant process/network/write authority and never execute embedded scripts automatically.

# Part E — Extension Cleanup

After the preceding skill/environment changes were proven, Phase 4 audited `packages/extensions` for actual remaining value.

The evidence-based compatibility decision is **remove**:

- the live registry is empty;
- `ExtensionRegistry.enable/disable` have no production callers;
- `profileRestrictions` have no runtime/profile consumer;
- production startup opened the registry only to expose `extension.list`;
- Agent Skills already provide the reusable development-extension path with stronger discovery, compatibility, and workspace semantics.

Therefore the unreleased `0.17` candidate removes `extension.list`, the registry startup path, and `packages/extensions`. This is a cleanup of unused declarative metadata, not a replacement plugin subsystem. The forbidden outcome remains expanding it into a plugin runtime merely because an ecosystem comparison score is lower than Codex.

# Part F — Workspace Continuity Checkpoint

## Problem

The host currently owns conversational workflow state. `.ai-bridge/current-plan.md` is useful for explicit handoff to Codex/OpenCode/Pi-style executors, but it should not become a universal session database.

KodeGPT needs only a small native record sufficient to continue a development task in a new host conversation or coordinate bounded concurrent workers.

## Model

Store at most one **Workspace Continuity Checkpoint** per trusted workspace. A checkpoint with `status:"complete"` is terminal evidence and remains readable until explicitly cleared or the workspace is untrusted.

It is development state, not conversation state.

Example contract:

```ts
interface WorkspaceCheckpoint {
  schemaVersion: 1;
  revision: number;
  objective?: string;
  status: "active" | "blocked" | "complete";
  baseline?: {
    branch?: string;
    headOid?: string;
  };
  nextActions: string[];
  evidenceRefs: Array<{
    kind: "artifact" | "process" | "preview" | "pr" | "ci" | "git" | "note";
    ref: string;
    summary?: string;
  }>;
  blocker?: string;
  notes?: string;
  updatedAt: string;
}
```

The v1 record uses the fields above and stays deliberately small. Bounds are:

- `objective`: <= 2 KiB UTF-8;
- `nextActions`: <= 8 items, each <= 512 bytes UTF-8;
- `evidenceRefs`: <= 16 items; each `ref` <= 512 bytes and each optional `summary` <= 1 KiB UTF-8;
- `blocker`: <= 2 KiB UTF-8;
- `notes`: <= 4 KiB UTF-8;
- total serialized checkpoint: <= 16 KiB.

`revision` starts at `1` on create and increases by exactly one on every successful upsert. `updatedAt` is server-generated UTC RFC 3339 time and is not caller-controlled. `baseline.headOid`, when present, must be a full 40- or 64-hex Git object ID; baseline is an intentional historical snapshot and is never auto-rewritten. Current branch/head/worktree are not persisted because they are authoritative Git/workspace state and can be re-read during resume.

Status invariants are strict: `blocked` requires a non-empty `blocker`; `active` forbids `blocker`; `complete` forbids `blocker` and requires `nextActions:[]`.

Do not persist:

- full conversation messages;
- chain-of-thought/reasoning;
- complete stdout/stderr logs;
- source files/diffs already available elsewhere;
- duplicated PR/CI databases;
- scheduler timestamps or autonomous retry state.

## Read surface

Expose the active checkpoint, when present, through the existing `workspace.info` result as an optional bounded `checkpoint` field. No dedicated checkpoint-read tool is added.

## Mutation surface

Add exactly one public mutation tool:

```text
workspace.checkpoint
```

It supports bounded `upsert` and `clear` operations through one schema rather than separate create/update/delete tools. An `upsert` supplies the complete caller-controlled checkpoint body (`objective`, `status`, `baseline`, `nextActions`, `evidenceRefs`, `blocker`, and `notes`); it is replacement semantics, not a partial merge. `revision` and `updatedAt` are always generated by KodeGPT.

Create uses `operation:"upsert"` with no `expectedRevision` and fails with `CHECKPOINT_STALE` if a checkpoint already exists. Update uses `operation:"upsert"` with the exact current `expectedRevision`. Clear requires the exact current `expectedRevision`.

Compare-and-swap semantics are therefore:

```text
no checkpoint + upsert(no expectedRevision) -> revision 1
read revision 12
upsert(expectedRevision=12) -> success, revision 13
stale upsert(expectedRevision=12) -> CHECKPOINT_STALE
clear(expectedRevision=13) -> checkpoint absent
```

This prevents concurrent writers targeting the same trusted workspace from silently overwriting each other without introducing locks, queues, or a task database. Separate worktrees remain separate trusted workspaces/checkpoints; any aggregation across them remains host-owned.

## Persistence and identity

The checkpoint is KodeGPT-owned state tied to the durable workspace trust record, not a file silently written into the application repository. Persist it beneath the private KodeGPT state root at `workspace-checkpoints/<trustId>.json` using atomic replacement and private permissions.

It must:

- use a schema-versioned persisted representation;
- reject unsupported future schema versions;
- survive workspace close/reopen and KodeGPT service restart;
- avoid leaking raw filesystem identity internals;
- be deleted when the corresponding workspace trust is removed;
- preserve durable decision/success/failed audit semantics for mutations.

## Relationship to `.ai-bridge`

The responsibilities are distinct:

```text
Workspace Continuity Checkpoint
  = KodeGPT-native current development state

.ai-bridge
  = explicit cross-agent/executor handoff artifacts
```

The workflow skill should prefer the checkpoint for native resume evidence when available, while continuing to inspect `.ai-bridge/current-plan.md` when explicit external-agent handoff context is relevant.

No automatic mirroring between the two stores is required in v1.

# Part G — Multi-Agent Readiness Without Agent Runtime

KodeGPT should support hosts that can run multiple agents, but KodeGPT itself does not spawn them.

The necessary properties are already mostly present:

- worktree isolation;
- conditional file writes/patch preconditions;
- exact-head GitHub mutation guards;
- opaque process/preview IDs;
- bounded artifacts;
- CI state reconciliation;
- audit evidence.

The continuity checkpoint adds compare-and-swap shared task state.

This is sufficient for a host topology such as:

```text
             Host reasoning
          /        |        \
     Subagent A Subagent B Subagent C
          \        |        /
                KodeGPT
                   |
             typed authority
```

Do not add an agent scheduler until a concrete future requirement proves host-owned orchestration is insufficient.

# Public Surface Strategy

The preferred public-surface change is minimal:

- no new shell tool;
- no language-specific tools;
- no new verification tools;
- no plugin execution tools;
- no session-list/resume/archive tool family;
- no agent tool family;
- exactly **one** new mutation tool, `workspace.checkpoint`;
- an optional `checkpoint` field on `workspace.info`;
- an `execution` summary on `system.capabilities`;
- the additive `allowDynamicExecutables` effective-policy field on `profile.current` / `profile.inspect`;
- optional `workspaceId` inputs on `skill.list` and `skill.load` for repository-local skill scope.

Ship the completed program as one semantic surface bump from `0.16` to `0.17` while keeping the public MCP tool count at exactly `75`: add `workspace.checkpoint` and remove the unused `extension.list` one-for-one. External MCP protocol negotiation remains `2026-07-28` and the product runtime version remains `0.1`. The internal TypeScript↔Rust request/policy schema may change in lockstep to carry developer-environment authority, but those internal contract changes update runtime schemas/fixtures without changing the external MCP protocol identifier.

# Data Flow

## Developer executable

```text
operator `kodegpt env sync`
        |
        v
Developer Environment Registry
        |
        +-- canonical root + persistent filesystem identity
        +-- normalized executable directories
        |
process.run / verify.run / skill.inspect
        |
        v
resolver checks system + registered roots
        |
        v
Bubblewrap mounts approved root read-only
        |
        v
controlled PATH + executable revalidation
        |
        v
process lifecycle / artifact / audit
```

## Continuity

```text
host reads workspace.info
        |
        v
checkpoint revision N
        |
        +-- reason / work / gather evidence
        |
        v
workspace.checkpoint(expectedRevision=N)
        |
        v
persist revision N+1
```

# Error Contract

Representative stable errors:

```text
DEV_ENV_REGISTRY_INVALID
DEV_ENV_SCHEMA_UNSUPPORTED
DEV_ENV_LIMIT_EXCEEDED
DEV_ENV_ROOT_NOT_FOUND
DEV_ENV_ROOT_UNTRUSTED
DEV_ENV_ROOT_INSIDE_WORKSPACE
DEV_ENV_ROOT_CHANGED
DEV_ENV_EXECUTABLE_NOT_FOUND
DEV_ENV_EXECUTABLE_UNAVAILABLE
VERIFICATION_CONFIG_INVALID
VERIFICATION_RECIPE_CONFLICT
SKILL_WORKSPACE_REQUIRED
SKILL_WORKSPACE_MISMATCH
CHECKPOINT_NOT_FOUND
CHECKPOINT_STALE
CHECKPOINT_INVALID
CHECKPOINT_LIMIT_EXCEEDED
CHECKPOINT_SCHEMA_UNSUPPORTED
```

Public errors must not expose raw host secrets, environment contents, retained file descriptors, or unnecessary absolute host paths.

# Testing Strategy

## Developer Environment

Prove:

1. existing trusted system executable resolution still works;
2. Node/Rust legacy explicit roots migrate or adapt without regression;
3. a registered user-owned safe root can expose an executable by logical name;
4. absolute/path-like logical executable names remain rejected;
5. missing/changed/unsafe registered roots fail deterministically, including roots beneath KodeGPT state or a trusted workspace;
6. registered roots are read-only inside Bubblewrap;
7. nested trusted shell sees the controlled developer `PATH`;
8. host raw `PATH`, `HOME`, and arbitrary environment are still not inherited;
9. project policy can narrow dynamic-executable authority;
10. `allowDynamicExecutables:true` permits an otherwise-unlisted trusted system executable, while `false` denies that same top-level launch;
11. a registered developer executable takes deterministic precedence over the same developer executable name in system locations;
12. registered roots cannot shadow top-level `bash` / `sh` or internal Git/Bubblewrap authority;
13. all admitted registered roots are mounted for a dynamic launch so chained tools can resolve sibling toolchain executables;
14. registry changes become effective on the next launch without service restart;
15. process cancellation/artifacts/audit behavior is unchanged.

Use at least one non-Node/Rust fixture/toolchain executable to prove the generic path is real rather than another special case.

## Verification

Prove:

1. existing package-script discovery remains unchanged;
2. existing Cargo discovery remains unchanged;
3. repository-defined recipes parse deterministically;
4. invalid paths/shell injection/oversized fields are rejected;
5. discovery performs no execution;
6. a custom recipe becomes allowed when its executable is available through Developer Environment;
7. the same recipe is blocked under a narrower policy;
8. `verify.run` revalidates the current recipe/environment before execution.

## Skills

Prove:

1. a skill under a conventional trusted workspace path is auto-discovered;
2. no skill outside workspace authority is auto-discovered;
3. explicit external source behavior remains intact;
4. duplicate/collision handling is deterministic;
5. a workspace-local skill cannot be inspected or loaded through a different workspace ID and requires `workspaceId` when its scope is otherwise ambiguous;
6. `skill.list` without `workspaceId` preserves the current global catalog behavior;
7. workspace-aware external CLI readiness uses generalized developer roots;
8. skill content remains data/instructions only and cannot execute automatically.

## Continuity

Prove:

1. checkpoint create/update/read/clear behavior within bounds;
2. compare-and-swap stale update rejection;
3. future schema rejection;
4. workspace identity isolation;
5. checkpoint persistence across KodeGPT service restart;
6. checkpoint revocation/deletion behavior on workspace untrust follows the documented lifecycle;
7. no conversation transcript or process log is accidentally persisted;
8. mutation auditing is ordered consistently with existing state changes.

## Global regression

- workspace trust/identity tests remain green;
- Bubblewrap/AppArmor isolation remains green;
- Git/GitHub/CI/browser/preview/visual behavior remains unchanged;
- existing skills remain compatible;
- package/build/typecheck/Rust tests pass;
- clean-install package smoke remains green;
- public tool inventory changes only by explicitly approved additive surface.

# Delivery Order

## Phase 1 — Execution + Environment foundation

1. reconcile execution self-description;
2. design/persist Developer Environment Registry;
3. generalize trusted executable root resolution;
4. mount registered roots read-only and construct deterministic sandbox PATH;
5. local CLI `env sync/add/list/remove/doctor`;
6. migrate existing Node/Rust explicit-root handling through the generalized mechanism;
7. dogfood at least one additional ecosystem/toolchain.

## Phase 2 — Verification + Skills integration

1. repository-defined generic verification config;
2. integrate Developer Environment availability into `verify.list`;
3. workspace-local conventional skill discovery;
4. integrate Developer Environment availability into skill capability plans;
5. update application-development workflow guidance where needed.

## Phase 3 — Continuity checkpoint

1. bounded persisted checkpoint store;
2. CAS revision semantics;
3. one mutation surface plus existing-state read integration;
4. resume/continuation workflow integration;
5. concurrent-writer tests.

## Phase 4 — Extension reconciliation

1. audit remaining extension-registry consumers;
2. keep narrow if useful;
3. otherwise prepare an explicit compatibility-safe deprecation/cleanup;
4. do not build executable plugin infrastructure.

Each phase must remain independently valuable. Do not continue to a later phase merely to improve comparison scores if dogfooding shows the earlier phases already solve the practical need.

# Acceptance Criteria

The program is successful when:

1. a trusted KodeGPT workspace can use an explicitly registered non-Node/Rust developer toolchain without host-wide environment inheritance;
2. `bash -lc` inside trusted execution resolves approved developer executables through a deterministic controlled PATH;
3. direct `process.run` and repository-defined `verify.run` can use registered developer executables under effective policy;
4. KodeGPT core does not need language-specific public tools to support new ecosystems;
5. repository-local Agent Skills are discoverable from trusted workspace authority without local source-registration ceremony;
6. external user-home skill roots remain explicit opt-in;
7. skill compatibility reflects generalized executable availability;
8. no executable plugin VM is added;
9. KodeGPT can persist one small conflict-resistant development checkpoint per workspace without storing conversations;
10. continuation in a fresh host context can reconstruct objective, current branch/head/worktree, next actions, and important evidence from bounded native state plus Git/evidence tools;
11. concurrent host/subagent writers targeting the same trusted workspace cannot silently overwrite checkpoint state due to CAS revisions;
12. existing typed capabilities remain the preferred deterministic interface and all established security/audit boundaries remain intact;
13. KodeGPT becomes effectively toolchain-agnostic and multi-agent-ready without becoming a second autonomous agent platform.

# Design Summary

The capability gaps should not be solved as four independent feature families.

The coherent solution is:

```text
Registered Developer Environment
        +
Generic verification recipes
        +
Agent Skills as extensibility
        +
Workspace Continuity Checkpoint
```

This reuses the architecture KodeGPT already has: trusted shell, retained workspace authority, Bubblewrap, typed capabilities, skill compatibility, worktrees, process lifecycle, audit, and host-owned reasoning.

The result should materially close the terminal/toolchain/extensibility/continuity gap with Codex CLI while preserving KodeGPT's stronger deterministic control-plane identity and avoiding redundant agent, plugin, workflow, or session runtimes.
