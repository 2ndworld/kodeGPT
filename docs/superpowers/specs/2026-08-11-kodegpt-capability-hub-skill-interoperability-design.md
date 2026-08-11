# KodeGPT Capability Hub + Hybrid Skill Interoperability Design

Date: 2026-08-11
Status: Approved
Scope: Post-v0.1 evolution of KodeGPT as the deterministic capability bridge between GPT Web and the local desktop

## 1. Purpose

KodeGPT already provides a secure low-level bridge from GPT Web to a locally trusted workspace: bounded file operations, hardened Git inspection, sandboxed process execution, artifacts, profiles, extensions, audit, and MCP transport. The next development stage should make GPT Web substantially more capable without changing KodeGPT into a second autonomous agent and without introducing Codex as a runtime dependency.

This design has two concrete goals:

1. KodeGPT can consume portable Codex/Agent Skills as reusable workflow instructions and resources **without executing Codex itself**.
2. KodeGPT can adapt useful Codex-like repository operations into **native deterministic capabilities** so GPT Web needs fewer low-level round trips and receives better structured context.

The product direction is:

```text
GPT Web = reasoning / planning / decisions
KodeGPT = capability hub / context engineering / desktop bridge
Rust runtime = final OS and security authority
Skills = reusable instructions + capability requirements
Providers = optional external capability sources
```

KodeGPT is not intended to become “Codex behind ChatGPT”. It is intended to make GPT Web itself better able to observe and operate the desktop through a constrained, typed, auditable local capability layer.

## 2. Current Baseline and Factual Gaps

The current production stack is already well separated:

```text
ChatGPT / MCP client
        ↓
packages/mcp-server
        ↓
createKodegptToolContext
        ↓
WorkspaceManager / ExecutionManager / ArtifactStore / ExtensionRegistry
        ↓
KernelClient
        ↓
Rust runtime
        ↓
workspace-io / sandbox / policy / audit
```

The current MCP surface exposes low-level tools such as `file.read`, `file.write`, `file.edit`, `file.search`, `file.tree`, `git.status`, `git.diff`, `process.run`, workspace lifecycle tools, profiles, extensions, artifacts, and system health.

Important limitations in the current baseline:

- most tool-context interfaces return `unknown`, even though lower layers already have typed results;
- most MCP tool results are only JSON serialized into text rather than exposing stable `structuredContent`;
- `file.search` is bounded and safe but lexical only;
- `file.edit` is intentionally primitive and does not support multi-file patches;
- Git status and diff are separate low-level calls rather than a compact change checkpoint;
- there is no deterministic repository inspection/context-building capability;
- verification requires GPT Web to know and orchestrate raw `process.run` calls;
- the extension registry stores declarative metadata and restrictions only; it is not a skill engine or executable plugin framework;
- the existing process contract intentionally executes a logical executable + argv without an arbitrary shell.

These are product-capability gaps, not reasons to weaken the existing security model.

## 3. Architectural Invariants

The following are hard requirements for all work covered by this design.

1. **No Codex runtime dependency.** KodeGPT must not spawn `codex`, invoke `codex exec`, attach to Codex sessions, proxy prompts through Codex, or require a Codex process to be running.
2. **No second reasoning agent.** KodeGPT may classify, parse, index, assemble, validate, and route deterministic data, but GPT Web remains the reasoning/planning actor.
3. **Rust remains final OS/security authority.** Security-sensitive filesystem/process actions continue to pass through KodeGPT’s Rust authority and retained capability model.
4. **MCP cannot establish workspace trust.** Existing local-only workspace trust semantics remain unchanged.
5. **Skills cannot widen authority.** A skill may request capabilities; it may never grant write, process, network, trust, executable, environment, or provider permissions.
6. **Profiles remain monotonic restrictions.** Effective policy is always the intersection of the existing workspace ceiling and any additional restriction.
7. **No arbitrary shell shortcut.** Higher-level verification and recipes must compile down to known logical executables + argv or native operations rather than introducing unrestricted shell execution.
8. **No Codex credential reuse.** Provider credentials, source configuration, and persistent state belong to KodeGPT. KodeGPT must not scrape or depend on Codex session/auth/private state.
9. **External skill sources are read-only.** Live discovery must never modify Codex/Agent Skills installation directories.
10. **Pinned skill state is explicit and reproducible.** Pinned content has a stable fingerprint, provenance record, schema version, and bounded copied resources.
11. **Unknown future persisted schemas fail closed.** New persistent stores follow the existing `schemaVersion` pattern and reject unsupported future versions.
12. **All remote-facing outputs are bounded.** Repository inspection, search, context, skill content, verification output, and provider metadata have explicit limits and truncation indicators.
13. **No fake transaction claims.** Multi-file patching must document its real filesystem semantics rather than claim global atomicity that the host filesystem cannot provide.

## 4. Target Architecture

```text
GPT Web
   │ MCP
   ▼
KodeGPT Capability Hub
   │
   ├── Native Capability Service
   │     ├── workspace.inspect
   │     ├── code.search
   │     ├── context.build
   │     ├── file.patch
   │     ├── git.changes
   │     └── verify.list / verify.run
   │
   ├── Skill Catalog
   │     ├── live read-only sources
   │     ├── pinned immutable snapshots
   │     ├── provenance + fingerprinting
   │     └── compatibility analysis
   │
   └── Future Provider Gateway
         └── downstream MCP / app providers
              │
              ▼
        Policy / Trust / Audit
              │
              ▼
           Rust Authority
              │
              ▼
             Host
```

The native capability service is intentionally between the MCP adapter and low-level managers. MCP should not contain repository-analysis business logic. The service consumes narrow typed adapters and returns stable typed capability results.

The skill catalog is a separate subsystem from `packages/extensions`. Extensions remain declarative installation metadata/restrictions. Skills represent instruction/resource bundles and must not be overloaded onto extension semantics.

## 5. Capability Contract Layer

### 5.1 Shared typed results

Create a dedicated `@kodegpt/capabilities` package for deterministic high-level capabilities and their public contracts.

The package owns:

- public input/result interfaces;
- capability version constants;
- bounded defaults and validation helpers;
- `NativeCapabilityService`;
- project inspection/search/context/verification logic;
- adapters for existing `WorkspaceManager` and `ExecutionManager` APIs.

It does **not** own:

- HTTP/MCP transport;
- workspace trust;
- raw filesystem authority;
- process sandbox implementation;
- credential storage;
- model inference.

### 5.2 Structured MCP output

All deterministic tools, old and new, should use a common response helper that returns both:

```ts
{
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value
}
```

Text remains for compatibility. `structuredContent` becomes the stable machine-readable result.

Where the MCP SDK supports output schemas for registered tools, deterministic tools should declare them using shared Zod schemas. The TypeScript type and runtime schema must be derived from one source wherever practical.

### 5.3 Surface version

Adding the native capability and skill surfaces is a user-visible MCP contract change. `MCP_SURFACE_VERSION` must advance from the v0.1 surface when the first new capability is shipped. The version bump happens once at the first merged capability-surface release, not for every individual tool.

## 6. Native Capability Surface

### 6.1 `workspace.inspect`

Purpose: provide a bounded repository map in one deterministic call.

Input:

```ts
interface WorkspaceInspectInput {
  workspaceId: string;
  path?: string;
  maxEntries?: number;
}
```

Result shape:

```ts
interface WorkspaceInspectResult {
  schemaVersion: 1;
  workspaceId: string;
  root: string;
  projectTypes: string[];
  languages: Array<{ name: string; fileCount: number }>;
  entrypoints: Array<{ path: string; kind: string }>;
  areas: Array<{ path: string; kind: "app" | "package" | "crate" | "test" | "config" | "docs" | "other" }>;
  manifests: Array<{ path: string; kind: string }>;
  warnings: string[];
  truncated: boolean;
}
```

Detection is deterministic and evidence-based. Initial implementation may recognize current KodeGPT-relevant ecosystems such as Node/pnpm, Rust/Cargo, common test/config files, and conventional app/package/crate directories. Unknown projects remain usable and return generic areas rather than guessed semantics.

The first version does not need a full LSP or compiler graph.

### 6.2 `code.search`

Purpose: replace repeated tree/search/read loops with a richer bounded search primitive.

Input:

```ts
type CodeSearchMode = "text" | "path" | "symbol" | "definition" | "reference";

interface CodeSearchInput {
  workspaceId: string;
  query: string;
  mode?: CodeSearchMode;
  path?: string;
  maxResults?: number;
}
```

Result:

```ts
interface CodeSearchResult {
  schemaVersion: 1;
  mode: CodeSearchMode;
  precision: "exact" | "lexical" | "heuristic";
  matches: Array<{
    path: string;
    line?: number;
    column?: number;
    kind: "text" | "path" | "symbol" | "definition" | "reference";
    preview?: string;
  }>;
  truncated: boolean;
}
```

Version 1 is deliberately progressive:

- `text`: current exact lexical search semantics;
- `path`: bounded filename/path matching from the retained-root tree;
- `symbol`, `definition`, `reference`: deterministic lexical/syntax-pattern heuristics with `precision` explicitly reported.

Tree-sitter/LSP integration is a later optimization and must not be required to ship the initial stable contract. The API must not pretend heuristic results are compiler-precise.

### 6.3 `git.changes`

Purpose: give GPT Web a compact change checkpoint rather than forcing separate status/diff orchestration.

Input:

```ts
interface GitChangesInput {
  workspaceId: string;
  includePatch?: boolean;
}
```

Result:

```ts
interface GitChangesResult {
  schemaVersion: 1;
  workspaceId: string;
  clean: boolean;
  changedPaths: Array<{
    path: string;
    indexStatus?: string;
    worktreeStatus?: string;
  }>;
  summary: {
    changedFiles: number;
    insertions?: number;
    deletions?: number;
  };
  patchPreview?: string;
  patchArtifact?: { uri: string; bytes: number };
  truncated: boolean;
  fingerprint: string;
}
```

The fingerprint is a deterministic digest of normalized observable Git change state, not a security credential. It enables future `sinceFingerprint`/“what changed since last checkpoint” behavior without storing model session state in KodeGPT.

### 6.4 `file.patch`

Purpose: apply a bounded multi-file unified patch with stronger preconditions than repeated `file.edit` calls.

Input:

```ts
interface FilePatchInput {
  workspaceId: string;
  patch: string;
  mode?: "check" | "apply";
}
```

Required semantics:

1. parse a bounded unified patch;
2. reject absolute paths, traversal, unsupported file operations, malformed hunks, binary patches, and excessive file/hunk/byte counts;
3. resolve every affected path through existing workspace authority;
4. read and validate **all** current file preconditions before any mutation;
5. compute expected post-image content in memory;
6. in `check` mode, return the plan without writing;
7. in `apply` mode, perform per-file conditional/atomic writes through the existing Rust filesystem authority;
8. return exactly which files were committed;
9. if commit-phase failure occurs, abort remaining files and report partial commit state explicitly.

KodeGPT must not describe this as a globally atomic cross-file filesystem transaction. The guarantee is “full preflight before first write + atomic conditional replacement per file”.

To prevent stale overwrite/TOCTOU, the Rust write path used by patching must support an expected-content digest or equivalent compare-and-swap precondition for each file.

### 6.5 `verify.list`

Purpose: discover safe named verification recipes for the current workspace.

Result examples may include:

```ts
interface VerificationRecipe {
  id: string;
  label: string;
  category: "test" | "lint" | "typecheck" | "build" | "format-check" | "custom";
  logicalExecutable: string;
  argv: string[];
  cwd: string;
  source: "package-script" | "cargo" | "kodegpt-config";
  allowed: boolean;
  blockedReason?: string;
}
```

Discovery may inspect known manifests/configuration but must never execute package-manager lifecycle scripts merely to discover commands.

A discovered recipe is marked `allowed: true` only if its executable/cwd/network requirements fit the current effective KodeGPT policy.

### 6.6 `verify.run`

Purpose: execute one recipe returned by `verify.list` using existing process authority.

Input:

```ts
interface VerifyRunInput {
  workspaceId: string;
  recipeId: string;
  background?: boolean;
}
```

The client cannot inject an arbitrary replacement executable/argv through `verify.run`; it selects a discovered recipe ID. The recipe is re-resolved and policy-checked immediately before execution.

`process.run` remains available for lower-level advanced use, but `verify.run` becomes the preferred deterministic verification path.

### 6.7 `context.build`

Purpose: deterministically assemble a high-value context bundle for GPT Web.

Input:

```ts
type ContextIntent = "understand" | "implement" | "debug" | "review" | "verify";

interface ContextBuildInput {
  workspaceId: string;
  intent: ContextIntent;
  target?: string;
  maxBytes?: number;
}
```

Result:

```ts
interface ContextBuildResult {
  schemaVersion: 1;
  intent: ContextIntent;
  target?: string;
  workspace: WorkspaceInspectResult;
  git: GitChangesResult;
  selectedFiles: Array<{
    path: string;
    reason: string;
    content?: string;
    truncated: boolean;
  }>;
  relevantMatches: CodeSearchResult["matches"];
  verifications: VerificationRecipe[];
  warnings: string[];
  totalBytes: number;
  truncated: boolean;
}
```

`context.build` is context engineering, not inference. Selection uses deterministic rules such as target-path proximity, manifest relevance, exact search hits, changed-file relevance, and bounded project conventions. It must not call an LLM.

## 7. Hybrid Skill Interoperability

### 7.1 Skill model

A skill is an instruction/resource bundle compatible with the Agent Skills style: metadata + Markdown instructions + bounded supporting resources.

KodeGPT does not execute a skill. It loads a skill for GPT Web to follow.

There is intentionally **no `skill.run` tool**.

### 7.2 Two storage modes

#### Live source

- points at an explicitly registered read-only local skill root;
- KodeGPT rescans metadata when listing/inspecting;
- updates in the external source become visible automatically;
- every returned skill includes the current content fingerprint;
- source files are never modified.

#### Pinned snapshot

- explicit local operator action copies a bounded skill bundle into KodeGPT state;
- content is immutable for that fingerprint;
- provenance records the source adapter/source identity/fingerprint/time;
- the snapshot remains available even if the external skill later changes or disappears.

This produces the desired hybrid behavior: discover broadly and stay current, but pin important workflows when reproducibility matters.

### 7.3 Source registration is local-only

Skill source registration/removal must not be exposed through MCP in the first version.

Local CLI surface:

```text
kodegpt skill source list
kodegpt skill source add <path> [--kind agent-skills]
kodegpt skill source remove <source-id>
kodegpt skill pin <skill-id>
kodegpt skill unpin <skill-id> [--fingerprint <sha256>]
```

A future convenience command may suggest conventional Agent Skills/Codex skill roots, but source activation still requires an explicit local operator action.

This avoids silently turning arbitrary user-home directories into remote-readable MCP resources.

### 7.4 External-source authority

Live skill directories are outside normal workspace trust and therefore require a separate **read-only local resource capability** rather than pretending they are workspaces.

The Rust runtime should own source registration/opening for external skill roots with these constraints:

- canonical directory root;
- retained read-only root capability;
- no write methods;
- beneath/no-magiclink/no-cross-mount rules consistent with the existing filesystem boundary where applicable;
- bounded file types and bytes returned to the Node catalog;
- local CLI controls persistence of the source registry;
- MCP can only list/inspect/load skills from already-registered sources.

The source registry is KodeGPT state and follows `schemaVersion: 1` + future-version rejection.

### 7.5 Skill identity and fingerprint

Public skill identity must not depend on an absolute host path.

A discovered skill has:

```ts
interface SkillIdentity {
  id: string;
  name: string;
  sourceId: string;
  relativePath: string;
  fingerprint: string;
}
```

`fingerprint` is SHA-256 over a canonical bundle representation containing the main skill file plus included resource path/bytes in stable sorted order. Host timestamps are not part of the digest.

The MCP surface must not expose the external source’s absolute host path.

### 7.6 Parsing

The catalog supports a conservative subset:

- YAML frontmatter with at least `name` and `description` when present;
- Markdown body;
- relative supporting-resource references contained beneath the skill directory;
- bounded UTF-8 text resources;
- unknown metadata preserved only when explicitly safe/bounded, otherwise ignored rather than executed.

Symlinks that escape the registered source root are rejected by the underlying filesystem authority.

Scripts/binaries may be listed as unsupported resources but are not executed by skill loading.

### 7.7 Compatibility classification

Public classification:

```ts
type SkillCompatibility =
  | "NATIVE"
  | "PARTIAL"
  | "PROVIDER_REQUIRED"
  | "UNSUPPORTED";
```

Compatibility analysis is advisory and conservative; policy enforcement remains independent.

Meaning:

- `NATIVE`: the workflow can be followed using currently available KodeGPT native capabilities and instruction resources;
- `PARTIAL`: useful portions can be followed, but one or more referenced capabilities have no exact native equivalent;
- `PROVIDER_REQUIRED`: structured or recognized dependencies require a configured external provider;
- `UNSUPPORTED`: the workflow fundamentally requires unsupported behavior such as spawning Codex, hidden subagent/session semantics, unsafe host access, or another unavailable execution model.

The result must include machine-readable reasons and missing capabilities. A skill classification never causes KodeGPT to auto-enable tools or profiles.

### 7.8 MCP skill surface

#### `skill.list`

Returns bounded metadata for live and pinned skills, including source kind, fingerprint, pinned state, compatibility, and short description.

#### `skill.inspect`

Returns metadata, provenance-safe source identity, compatibility analysis, resource manifest, and instruction byte counts without automatically returning every resource body.

#### `skill.load`

Returns the selected instruction body plus explicitly requested bounded text resources. Input includes the expected fingerprint so callers can opt into stable-load semantics and detect live-source changes.

Example:

```ts
interface SkillLoadInput {
  skillId: string;
  fingerprint?: string;
  resources?: string[];
  maxBytes?: number;
}
```

If an expected fingerprint no longer matches a live skill, loading fails with a specific stale-skill error instead of silently returning changed instructions.

## 8. Relationship to Extensions

The current extension subsystem remains separate.

`packages/extensions` continues to represent declarative extension metadata and profile restrictions. It must not gain executable handlers merely to support skills.

Long term, a plugin/package may install both:

- extension metadata/restrictions;
- one or more skills;
- optional provider configuration templates.

But these remain separate capability domains with separate security semantics.

## 9. Future Provider Gateway

Provider integration is intentionally not part of the first two implementation plans, but this design reserves its place.

Target future surface:

```text
provider.list
provider.tools
provider.invoke
```

Requirements when implemented:

- KodeGPT acts as downstream MCP/app client without executing Codex;
- provider credentials/config are KodeGPT-owned;
- tools are namespaced and allowlisted;
- invocation is intersected with workspace/profile/provider policy;
- provider tool metadata is bounded and does not flood the upstream MCP surface;
- every invocation is audited;
- skills may declare provider requirements but may not activate providers themselves.

Figma or other Codex-configured MCP capabilities should therefore be connected directly to KodeGPT in the future rather than proxied through Codex.

## 10. State Layout

Proposed state layout beneath the existing state root:

```text
~/.kodegpt/
  skills/
    sources.json
    pinned/
      <skill-id>/
        <fingerprint>/
          manifest.json
          SKILL.md
          resources/...
```

`manifest.json` stores only KodeGPT-owned normalized metadata/provenance. External absolute paths must not be returned through MCP.

Persistent JSON stores use private permissions consistent with existing KodeGPT state stores.

## 11. Auditing

New security-relevant actions must integrate with the existing durable audit path.

Audit-worthy operations include:

- external skill source registration/unregistration;
- skill pin/unpin;
- skill live read/load;
- `file.patch` decision and outcome;
- `verify.run` decision and outcome;
- future provider invocation.

Pure in-memory composition such as `context.build` may rely on the audited low-level reads/inspections if that matches existing audit volume policy, but any new privileged runtime method must preserve “durable decision before OS action”.

## 12. Error Contract

New subsystems should expose stable error codes rather than leaking raw host errors.

Representative codes:

```text
CAPABILITY_INPUT_INVALID
CAPABILITY_LIMIT_EXCEEDED
PATCH_INVALID
PATCH_PRECONDITION_FAILED
PATCH_COMMIT_INCOMPLETE
VERIFICATION_NOT_FOUND
VERIFICATION_NOT_ALLOWED
SKILL_SOURCE_NOT_FOUND
SKILL_SOURCE_INVALID
SKILL_NOT_FOUND
SKILL_FINGERPRINT_MISMATCH
SKILL_BUNDLE_INVALID
SKILL_RESOURCE_UNSUPPORTED
SKILL_REGISTRY_SCHEMA_UNSUPPORTED
```

Host paths, file descriptors, process IDs, provider secrets, and raw credentials must not appear in MCP-facing error text.

## 13. Delivery Order

### Phase 1 — Native Agent-Grade Capabilities

Ship independently testable native capability improvements first:

1. shared typed capability contracts + structured MCP results;
2. `workspace.inspect`;
3. `code.search`;
4. `git.changes`;
5. `verify.list` / `verify.run`;
6. `file.patch` with preflight + per-file conditional writes;
7. `context.build`;
8. surface-version/docs/security regression gate.

This phase alone should materially reduce GPT Web tool-call count and improve context quality.

### Phase 2 — Hybrid Skill Interoperability

After capability vocabulary is stable:

1. read-only external skill source authority + local source registry;
2. skill parser/fingerprinting;
3. live catalog;
4. pinned immutable snapshots;
5. compatibility resolver against native capability vocabulary;
6. `skill.list` / `skill.inspect` / `skill.load`;
7. local CLI source/pin commands;
8. security/isolation/compatibility regression gate.

### Phase 3 — Provider Gateway

Deferred to a separate future spec/plan after Phase 2 is proven.

## 14. Testing Strategy

### Native capability tests

- contract/schema tests for every public result;
- bounded-output/truncation tests;
- deterministic ordering tests;
- workspace inspection fixtures for Node, Rust, mixed, and unknown projects;
- search mode/precision tests;
- patch parser tests including traversal/binary/malformed/limit rejection;
- patch stale-content precondition tests;
- partial-commit failure reporting tests;
- verification discovery tests that prove no discovery-time command execution;
- policy-blocked verification tests;
- deterministic context selection/budget tests;
- MCP structuredContent + text-fallback parity tests.

### Skill tests

- source registry schema/future-version rejection;
- source root escape/symlink/cross-boundary rejection;
- malformed frontmatter and oversized resource rejection;
- stable fingerprint independent of timestamps/listing order;
- live update produces a new fingerprint;
- expected-fingerprint mismatch fails explicitly;
- pinned snapshot survives live source deletion/change;
- pinning never writes into the external source;
- host absolute source path is absent from MCP output;
- compatibility reasons are deterministic;
- unsupported executable/binary resources are never executed;
- there is no MCP source-registration or `skill.run` tool.

### Global regression gates

- existing workspace trust and identity tests remain green;
- existing Bubblewrap/AppArmor/process policy tests remain green;
- no new arbitrary shell path is introduced;
- MCP trust-admission remains absent;
- audit health remains fail-closed;
- packaged CLI/start/bridge/exposure behavior remains intact;
- full TypeScript and Rust workspace suites pass.

## 15. Security Review Checklist

Before either phase is considered complete, verify all of the following:

- no code path spawns Codex;
- no Codex credential/config/session is required at runtime;
- all workspace file mutation still resolves through retained workspace authority;
- live skill source capabilities are read-only by construction;
- source registration and pin mutation are local CLI operations, not upstream MCP authority;
- skill instructions cannot change effective policy;
- verification recipes cannot replace their approved executable/argv at invocation time;
- patching has stale-content protection;
- public results contain no raw host capability IDs/FDs/PIDs/absolute skill-source paths/secrets;
- new persistent schemas reject unknown future versions;
- bounded limits have explicit tests;
- tool annotations accurately mark read/write/open-world behavior.

## 16. Non-Goals

The following are explicitly outside this design’s first two implementation phases:

- autonomous KodeGPT planning loops;
- subagent orchestration;
- model inference inside KodeGPT;
- executing Codex or another coding agent;
- importing the entire Codex runtime/config/session model;
- unrestricted shell access;
- compiler-perfect code intelligence for every language;
- global all-filesystem transactions for patching;
- automatic activation of arbitrary user-home skill directories;
- executing scripts embedded in skills;
- auto-installing skill dependencies;
- provider credential scraping;
- blindly exposing all downstream MCP tools upstream;
- replacing the current workspace trust/profile/audit architecture.

## 17. Acceptance Criteria

The design is implemented successfully when:

1. GPT Web can obtain structured repository understanding with materially fewer primitive calls.
2. New native capabilities remain deterministic and bounded and do not perform model reasoning.
3. GPT Web can inspect and load portable local Agent Skills without any Codex process being executed.
4. Live skills reflect source updates while pinned skills remain reproducible by fingerprint.
5. No external skill source can be modified through the skill subsystem.
6. Skills cannot widen workspace/profile/process/network/provider authority.
7. `file.patch` rejects stale/unsafe patches and reports its real commit semantics.
8. Verification recipes are discoverable and runnable without adding arbitrary shell execution.
9. MCP results have stable typed/structured contracts with text fallback.
10. Existing security, audit, trust, sandbox, packaging, and host-compatibility gates remain green.
11. KodeGPT remains conceptually and operationally a **GPT Web ↔ desktop capability bridge**, not a second agent and not a Codex proxy.
