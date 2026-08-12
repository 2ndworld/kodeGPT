# KodeGPT Hybrid Skill Interoperability Reconciled Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let GPT Web discover, inspect, and load explicitly admitted Agent Skills-compatible instruction/resource bundles without executing Codex or skill scripts, while preserving Rust-owned live-source filesystem authority and reproducible immutable pins.

**Architecture:** Add a separate `@kodegpt/skills` orchestration package plus a retained read-only Rust skill-source registry. Local CLI alone admits/removes sources and pins; production wiring is completed and E2E-proven before MCP advertises `skill.list`, `skill.inspect`, and `skill.load`. Existing `KernelClient`, state root, Native Capability Service, workspace/process authorities, audit model, and MCP transport are reused rather than duplicated.

**Tech Stack:** Node.js 24, TypeScript 5.9, pnpm 10, Vitest 3, Zod 4, `yaml@2`, Rust/Tokio/serde/rustix, existing framed JSON-RPC protocol, retained-root openat2/mount boundary primitives, existing state-store conventions.

## Global Constraints

- Exact implementation base: `main@b8a3b71` or a verified descendant with no conflicting Phase 2 work.
- MCP protocol remains `2026-07-28`.
- MCP semantic surface remains `0.2` until Task 9, then advances exactly once to `0.3`.
- No `skill.run`.
- No Codex subprocess/runtime/session/auth dependency.
- No automatic skill script execution.
- No provider invocation in Phase 2.
- MCP cannot add/remove skill sources or pin/unpin skills.
- Skill metadata/instructions cannot widen trust, profile, process, executable, env, network, provider, desktop, or filesystem authority.
- Live external sources are read-only and accessed only through Rust retained-root authority.
- No TypeScript direct live-source `node:fs` traversal fallback.
- Source roots overlapping KodeGPT state equal/ancestor/descendant visible/backing trees fail closed.
- Skill-directory, `SKILL.md`, and resource symlinks are not followed in v1.
- Public MCP output/errors never expose canonical source roots, FDs, runtime capability IDs, credentials, or raw host errors.
- Persisted KodeGPT-owned skill state uses schemaVersion 1, private permissions, atomic persistence, and rejects future schemas.
- Every list/read/bundle operation has explicit deterministic bounds and incompleteness behavior.
- Every task follows AUDIT → RED → GREEN → focused gates → review → fix → re-review → commit.

---

## File Structure

### New TypeScript package

```text
packages/skills/
  package.json
  tsconfig.json
  vitest.config.ts
  src/index.ts
  src/contracts.ts
  src/errors.ts
  src/source-store.ts
  src/source-runtime.ts
  src/source-manager.ts
  src/parser.ts
  src/fingerprint.ts
  src/catalog.ts
  src/pin-store.ts
  src/compatibility.ts
  src/test-support.ts
  src/*.test.ts
```

### Rust additions

```text
crates/workspace-io/src/skill_source.rs
```

Modify existing:

```text
crates/workspace-io/src/lib.rs
crates/runtime/src/dispatcher.rs
crates/runtime/src/audit.rs
crates/protocol/src/types.rs
crates/protocol/src/lib.rs
packages/protocol/src/runtime-types.ts
schemas/runtime/request.schema.json
packages/core/src/kernel-client.ts
packages/core/src/kernel-client.test.ts
packages/mcp-server/src/tool-context.ts
packages/mcp-server/src/tools.ts
packages/mcp-server/src/annotations.ts
packages/mcp-server/src/surface-version.ts
packages/mcp-server/src/structured-results.test.ts
apps/cli/src/commands/start.ts
apps/cli/src/commands/start.test.ts
apps/cli/src/main.ts
apps/cli/src/commands/skill.ts
apps/cli/src/commands/skill.test.ts
pnpm-lock.yaml (new workspace package dependency resolution)
docs/compatibility/chatgpt.md
docs/release/v0.1-checklist.md
tests/fixtures/mcp-surface.ts
tests/protocol/*
tests/integration/full-stack.test.ts
tests/security/security-invariants.test.ts
tests/security/forbidden-patterns.test.ts
```

Do not merge skills into `packages/extensions`.

---

### Task 1: Rust Retained Read-Only Skill Source Authority

**Files:**
- Create: `crates/workspace-io/src/skill_source.rs`
- Modify: `crates/workspace-io/src/lib.rs`
- Modify: `crates/protocol/src/types.rs`
- Modify: `crates/protocol/src/lib.rs`
- Modify: `packages/protocol/src/runtime-types.ts`
- Modify: `schemas/runtime/request.schema.json`
- Modify: `crates/runtime/src/dispatcher.rs`
- Modify: `crates/runtime/src/audit.rs`
- Add runtime fixture JSON files under `tests/fixtures/runtime/`
- Modify: `tests/protocol/runtime-schema.test.ts`
- Modify: `tests/protocol/framing-parity.test.ts`

**Interfaces:**

Internal methods:

```text
skill_source.inspect_root
skill_source.register
skill_source.tree
skill_source.read
skill_source.unregister
```

Closed request shapes:

```ts
skill_source.inspect_root {
  path: string;
}

skill_source.register {
  rootPath: string;
  expectedIdentity: { deviceMajor:number; deviceMinor:number; inode:string };
}

skill_source.tree {
  sourceCapabilityId: string;
  path: string;
  maxEntries: number;
}

skill_source.read {
  sourceCapabilityId: string;
  path: string;
  offset: number;
  maxBytes: number;
}

skill_source.unregister {
  sourceCapabilityId: string;
}
```

Runtime capability ID is private and uses prefix `sc_`; it is never persisted or exposed through MCP.

- [ ] **Step 1: Write protocol RED fixtures and closed-schema tests**

Add fixtures proving every method accepts the exact documented shape and rejects unknown fields. Add Rust protocol tests for unknown/future/cross-field malformed requests.

Run:

```bash
pnpm test:protocol
cargo test -p kodegpt-protocol
```

Expected: RED because methods do not exist.

- [ ] **Step 2: Add the runtime method schemas in TS, JSON Schema, and Rust**

Add all five methods to `RUNTIME_METHODS`, Zod request union, canonical request JSON Schema, Rust request types, and fixture parity. Keep all params `deny_unknown_fields` / `.strict()`.

- [ ] **Step 3: Write workspace-io RED tests for retained source identity and boundaries**

Required cases:

```text
regular source accepted
state-root equal overlap rejected by dispatcher inspection/registration
visible ancestor/descendant state overlap rejected
backing-tree alias overlap rejected where mount topology exposes it
visible path replacement after retained open does not redirect reads
expected identity mismatch fails
../ traversal rejected
magic-link escape rejected
cross-mount escape rejected
skill-directory symlink entry remains non-followed
SKILL.md/resource symlink read rejected
unregister invalidates future reads
```

- [ ] **Step 4: Implement `SkillSourceRegistry`**

Core structure:

```rust
pub struct SkillSourceRegistry {
    entries: HashMap<String, SkillSourceEntry>,
}

struct SkillSourceEntry {
    retained_root: OwnedFd,
    identity: FilesystemIdentity,
    backing: BackingTreeIdentity,
}
```

Registration opens/revalidates the root using existing workspace-io openat/mount helpers. It stores no write/process/profile policy.

No workspace registry method accepts `sc_` IDs and no skill-source method accepts workspace capability IDs.

- [ ] **Step 5: Implement bounded tree/read**

Hard runtime maxima:

```text
max tree entries per call = 20_000
max read bytes per call = 1 MiB
```

Tree is deterministic lexical order and returns entry kind/size metadata. Read is UTF-8 only; invalid UTF-8 maps to `SKILL_RESOURCE_UNSUPPORTED` without returning bytes.

- [ ] **Step 6: Wire dispatcher state-root overlap and durable audit**

Add stable audit actions equivalent to:

```text
SkillSourceInspectRoot
SkillSourceRegister
SkillSourceTree
SkillSourceRead
SkillSourceUnregister
```

For inspect/register/tree/read: durable decision precedes the host access; outcome follows. Audit contains only opaque source capability ID/relative path/count/result metadata, not file contents or host root.

Stable error data codes include:

```text
SKILL_SOURCE_INVALID
SKILL_SOURCE_STATE_OVERLAP
SKILL_SOURCE_IDENTITY_CHANGED
SKILL_SOURCE_UNAVAILABLE
SKILL_SOURCE_BOUNDARY_VIOLATION
SKILL_SOURCE_LIMIT_EXCEEDED
SKILL_RESOURCE_UNSUPPORTED
```

- [ ] **Step 7: Prove audit failure and authority isolation**

Add dispatcher tests:

```text
audit decision failure => zero source filesystem action
workspace write/process with sc_ id => rejected by existing schemas/registries
source methods never mutate source tree
runtime response contains no canonical host root after registration
```

- [ ] **Step 8: Run Task 1 gates and review**

```bash
pnpm test:protocol
cargo test -p kodegpt-protocol
cargo test -p kodegpt-workspace-io
cargo test -p kodegpt-runtime
cargo fmt --all -- --check
pnpm typecheck
```

Review for duplicated openat/mount logic, path leaks, workspace/source ID confusion, and missing audit ordering. Fix all findings and rerun.

- [ ] **Step 9: Commit**

```bash
git add crates packages/protocol schemas/runtime tests/protocol tests/fixtures/runtime Cargo.lock
git commit -m "feat(skills): add retained skill source authority"
```

---

### Task 2: Skill Contracts, Errors, and Local Source Store

**Files:**
- Create: `packages/skills/package.json`
- Create: `packages/skills/tsconfig.json`
- Create: `packages/skills/vitest.config.ts`
- Create: `packages/skills/src/contracts.ts`
- Create: `packages/skills/src/errors.ts`
- Create: `packages/skills/src/source-store.ts`
- Create: `packages/skills/src/source-store.test.ts`
- Create: `packages/skills/src/test-support.ts`
- Create: `packages/skills/src/index.ts`
- Modify: `pnpm-lock.yaml` after adding the new workspace package

**Interfaces:**

Initial `packages/skills/package.json`:

```json
{
  "name": "@kodegpt/skills",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json --noEmit",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "zod": "4.3.6"
  }
}
```

`pnpm-workspace.yaml` already includes `packages/*`, so it must not be edited merely to register this package.

Hard exported limits:

```ts
export const SKILL_STATE_SCHEMA_VERSION = 1 as const;
export const MAX_SOURCES = 16;
export const MAX_SKILLS_PER_SOURCE = 1_000;
export const MAX_SOURCE_ENTRIES = 20_000;
export const SKILL_DESCRIPTOR_MAX_BYTES = 64 * 1024;
export const SKILL_MD_MAX_BYTES = 256 * 1024;
export const MAX_RESOURCES_PER_SKILL = 256;
export const RESOURCE_TEXT_MAX_BYTES = 256 * 1024;
export const SKILL_BUNDLE_MAX_BYTES = 1024 * 1024;
export const SKILL_LOAD_MAX_BYTES = 1024 * 1024;
```

Persisted source:

```ts
export interface PersistedSkillSource {
  sourceId: string; // ss_<opaque>
  label: string;
  kind: "agent-skills";
  canonicalRoot: string; // local-only
  identity: { deviceMajor:number; deviceMinor:number; inode:string };
}
```

Store file:

```text
<stateRoot>/skills/sources.json
```

- [ ] **Step 1: Add package and RED source-store tests**

Prove missing store => empty, schemaVersion 1 persistence, future schema reject, unknown owned-state fields reject, duplicate source identity reject, max 16 sources, private `skills/` 0700 and file 0600, atomic persistence, and no temporary file after success.

- [ ] **Step 2: Define stable skill errors**

Create `SkillError` with closed codes including all `SKILL_*` codes from the reconciled spec. Unknown internal errors must be convertible later to a generic safe MCP error.

- [ ] **Step 3: Implement atomic source store**

Use existing state-store patterns: private parent, exclusive temp, fsync file, rename, chmod final, fsync parent. Source IDs use `ss_` plus opaque random material. Duplicate labels are allowed; duplicate filesystem identity is not.

- [ ] **Step 4: Run Task 2 gates and review**

```bash
pnpm --filter @kodegpt/skills test
pnpm --filter @kodegpt/skills typecheck
pnpm typecheck
```

Review for raw path exposure from public contract types and dependency cycles. Fix all findings.

- [ ] **Step 5: Commit**

```bash
git add packages/skills pnpm-lock.yaml
git commit -m "feat(skills): add skill contracts and source registry"
```

---

### Task 3: Typed Skill Source Runtime Adapter and Manager

**Files:**
- Create: `packages/skills/src/source-runtime.ts`
- Create: `packages/skills/src/source-runtime.test.ts`
- Create: `packages/skills/src/source-manager.ts`
- Create: `packages/skills/src/source-manager.test.ts`
- Modify: `packages/skills/src/index.ts`
- Modify: `packages/skills/package.json` to add `@kodegpt/core: workspace:*`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

Do not expose `request(method:string, ...)` to `SkillSourceManager`.

```ts
export interface SkillSourceRuntimeAdapter {
  inspectRoot(path: string): Promise<SkillSourceRootInspection>;
  register(input: {
    rootPath: string;
    expectedIdentity: PersistentSkillSourceIdentity;
  }): Promise<{ sourceCapabilityId: string }>;
  tree(input: {
    sourceCapabilityId: string;
    path: string;
    maxEntries: number;
  }): Promise<SkillSourceTreeResult>;
  read(input: {
    sourceCapabilityId: string;
    path: string;
    offset: number;
    maxBytes: number;
  }): Promise<SkillSourceReadResult>;
  unregister(sourceCapabilityId: string): Promise<void>;
}
```

`createSkillSourceRuntimeAdapter(kernel: Pick<KernelClient,"request">)` is the only place in `@kodegpt/skills` that knows runtime method strings. It validates every runtime response as a closed shape and strips capability IDs from public manager results.

- [ ] **Step 1: Write RED adapter response-validation tests**

Prove wrong/missing fields, extra host-path field, malformed capability ID, invalid tree kind, invalid byte counts, and invalid read EOF semantics fail closed.

- [ ] **Step 2: Implement explicit runtime adapter**

Each method calls one fixed runtime method name with exact params. Map `KernelRpcError.data.code` into stable `SkillError` codes; unknown runtime failures become `SKILL_SOURCE_UNAVAILABLE` without raw host text.

- [ ] **Step 3: Write RED manager lifecycle tests**

Test:

```text
addSource(path,label) => inspectRoot then persist only after successful inspection
ensureRegistered(sourceId) => runtime register with persisted exact identity
identity mismatch => no silent refresh
read/tree => lazy registration and relative paths only
removeSource => unregister active capability then remove local admission
close => attempt all active unregisters before returning
```

- [ ] **Step 4: Implement `SkillSourceManager`**

Cache only `{sourceId -> private sourceCapabilityId}` in memory. Public manager methods use persistent `sourceId` and never return `canonicalRoot` except explicit local CLI source-list view.

- [ ] **Step 5: Run Task 3 gates/review**

```bash
pnpm --filter @kodegpt/skills test
pnpm --filter @kodegpt/skills typecheck
pnpm typecheck
```

Review that no generic string-RPC adapter leaks past `source-runtime.ts` and no direct live-source `node:fs` read exists. Fix all findings.

- [ ] **Step 6: Commit**

```bash
git add packages/skills packages/core
git commit -m "feat(skills): manage retained live skill sources"
```

---

### Task 4: Strict Agent Skills Parser, Discovery, and Fingerprints

**Files:**
- Create: `packages/skills/src/parser.ts`
- Create: `packages/skills/src/parser.test.ts`
- Create: `packages/skills/src/fingerprint.ts`
- Create: `packages/skills/src/fingerprint.test.ts`
- Create: `packages/skills/src/catalog.ts`
- Create: `packages/skills/src/catalog.test.ts`
- Modify: `packages/skills/src/contracts.ts`
- Modify: `packages/skills/src/index.ts`
- Modify: `packages/skills/package.json` to add `yaml: 2.9.0`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

Required SKILL.md fields:

```ts
interface ParsedSkillDocument {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  allowedTools?: string[] | string;
  unknownMetadataKeys: string[];
  instructions: string;
}
```

Public identifiers:

```text
sk_<opaque deterministic hash of sourceId + relative skill directory>
```

Fingerprints:

```text
descriptorFingerprint = SHA-256(exact SKILL.md bytes)
bundleFingerprint = SHA-256(versioned canonical file-record stream)
```

- [ ] **Step 1: Write parser RED tests**

Cover minimal valid skill, optional standard fields, malformed YAML, duplicate key, non-object frontmatter, missing name/description, invalid Agent Skills name, oversized SKILL.md, UTF-8 instructions, unknown metadata keys, and custom/executable YAML tags rejected.

- [ ] **Step 2: Implement strict parser**

Use `yaml.parseDocument` with unique-key/strict behavior and no custom executable tags. Markdown body remains opaque instruction text.

- [ ] **Step 3: Write discovery RED tests**

Discovery examines direct child skill directories only and requires a regular non-symlink `SKILL.md`. Test >1000 skills, >20000 source entries, duplicate names, weird UTF-8 filenames, skill-directory symlink, and deterministic lexical ordering.

- [ ] **Step 4: Implement catalog discovery + explicit incompleteness**

`listLive()` returns descriptors plus `truncated` and stable reasons such as:

```text
SOURCE_ENTRY_LIMIT
SKILL_COUNT_LIMIT
DESCRIPTOR_SIZE_LIMIT
```

Never silently skip an oversized descriptor and still report complete.

- [ ] **Step 5: Write fingerprint/resource inventory RED tests**

Cover resource inventory under accepted skill directory, max 256 resources, aggregate bundle 1 MiB, per-text resource 256 KiB, binary resource inventory, scripts/references/assets, symlink resource rejection, same content at different host paths => same bundle fingerprint, and content/path changes => different bundle fingerprint.

- [ ] **Step 6: Implement descriptor and bundle fingerprints**

Bundle canonical record excludes source ID/host path/timestamps/inode. Use lexical relative paths and SHA-256 of raw file bytes.

- [ ] **Step 7: Implement `inspectLive` and `loadLiveRaw`**

`inspectLive` reads complete bounded inventory and bundle fingerprint but not resource bodies. `loadLiveRaw` accepts only resource paths from a freshly validated inventory and enforces aggregate `SKILL_LOAD_MAX_BYTES`.

- [ ] **Step 8: Run Task 4 gates/review**

```bash
pnpm --filter @kodegpt/skills test
pnpm --filter @kodegpt/skills typecheck
pnpm typecheck
```

Review parser trust boundaries, silent truncation, duplicate-name behavior, script inertness, and arbitrary relative read risks. Fix and rerun.

- [ ] **Step 9: Commit**

```bash
git add packages/skills pnpm-lock.yaml
git commit -m "feat(skills): discover and fingerprint agent skills"
```

---

### Task 5: Immutable Content-Addressed Pin Store

**Files:**
- Create: `packages/skills/src/pin-store.ts`
- Create: `packages/skills/src/pin-store.test.ts`
- Modify: `packages/skills/src/catalog.ts`
- Modify: `packages/skills/src/contracts.ts`
- Modify: `packages/skills/src/index.ts`

**Interfaces:**

Layout:

```text
<stateRoot>/skills/pins/<bundleFingerprint>/
  manifest.json
  files/<relative bundle files>
```

Manifest:

```ts
interface PinnedSkillManifest {
  schemaVersion: 1;
  pinId: string; // sp_<opaque>
  bundleFingerprint: string;
  originalSkillName: string;
  sourceId: string;
  sourceKind: "agent-skills";
  sourceDescriptorFingerprint: string;
  pinnedAt: string;
  files: Array<{ relativePath:string; bytes:number; sha256:string }>;
}
```

- [ ] **Step 1: Write RED pin-store persistence tests**

Prove private modes, future-schema reject, unknown KodeGPT-owned fields reject, same fingerprint idempotent, failed temp write leaves no visible pin, and unpin cannot escape pins root.

- [ ] **Step 2: Write RED live-to-pin consistency tests**

Test live mutation after inspect but before/during copy, source identity replacement, resource symlink swap, bundle exceeding limit, and live deletion. Pin must publish only when the copied file set hashes exactly to the inspected bundle fingerprint.

- [ ] **Step 3: Implement atomic pin publication**

Pin receives a complete validated bundle from catalog/source manager; writes private temp directory under `skills/pins`, fsyncs every file + manifest + directory, then atomically renames to final content-addressed fingerprint directory. Never modify external source.

- [ ] **Step 4: Merge live + pinned catalog views**

Pinned skills remain loadable after live source disappears. Live and pinned copies with identical fingerprint deduplicate availability metadata but retain provenance.

- [ ] **Step 5: Run Task 5 gates/review**

```bash
pnpm --filter @kodegpt/skills test
pnpm --filter @kodegpt/skills typecheck
pnpm typecheck
```

Review partial-publish behavior, host-path persistence, content-addressing invariants, and state-root isolation. Fix all findings.

- [ ] **Step 6: Commit**

```bash
git add packages/skills
git commit -m "feat(skills): add immutable content-addressed pins"
```

---

### Task 6: Conservative Compatibility Resolver

**Files:**
- Create: `packages/skills/src/compatibility.ts`
- Create: `packages/skills/src/compatibility.test.ts`
- Modify: `packages/skills/src/contracts.ts`
- Modify: `packages/skills/src/catalog.ts`
- Modify: `packages/skills/src/index.ts`
- Modify: `packages/skills/package.json` to add `@kodegpt/capabilities: workspace:*`
- Modify: `packages/capabilities/src/contracts.ts`
- Modify: `packages/capabilities/src/index.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

Export descriptive native vocabulary from capabilities:

```ts
export const NATIVE_CAPABILITY_IDS = Object.freeze([
  "workspace.inspect",
  "context.build",
  "code.search",
  "file.read",
  "file.patch",
  "git.changes",
  "git.status",
  "git.diff",
  "verify.list",
  "verify.run",
  "artifact.read",
  "process.run"
] as const);
```

Compatibility result:

```ts
interface SkillCompatibilityReport {
  classification: "NATIVE" | "PARTIAL" | "PROVIDER_REQUIRED" | "UNSUPPORTED";
  requiredCapabilities: string[];
  missingCapabilities: string[];
  requiredProviders: string[];
  reasons: string[];
  evidence: Array<{ source:"kodegpt-metadata"|"allowed-tools"|"compatibility-text"|"unknown"; detail:string }>;
}
```

- [ ] **Step 1: Write four-class RED tests**

Required fixtures:

```text
explicit code.search/file.read/verify.run => NATIVE
no declared machine-readable requirements => PARTIAL
known native + unknown tool token => PARTIAL
explicit provider figma => PROVIDER_REQUIRED
requires unrestricted shell => UNSUPPORTED
requires Codex runtime => UNSUPPORTED
requires executing bundled script as authority => UNSUPPORTED
```

- [ ] **Step 2: Implement evidence precedence**

Recognize optional KodeGPT-owned structured metadata under `metadata.kodegpt.requires`. Map known `allowed-tools` tokens conservatively. Free-text compatibility is displayed as evidence but cannot promote a skill to NATIVE.

- [ ] **Step 3: Prove resolver cannot alter policy**

Compatibility API returns data only. Tests must show no WorkspaceManager/profile/process adapter is accepted by resolver and no effective-policy mutation occurs.

- [ ] **Step 4: Run Task 6 gates/review**

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/skills test
pnpm typecheck
```

Review overclaim risks and provider leakage. Fix all findings.

- [ ] **Step 5: Commit**

```bash
git add packages/capabilities packages/skills
git commit -m "feat(skills): resolve skill compatibility conservatively"
```

---

### Task 7: Local CLI Source and Pin Administration

**Files:**
- Create: `apps/cli/src/commands/skill.ts`
- Create: `apps/cli/src/commands/skill.test.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/package.json` to add `@kodegpt/skills: workspace:*`
- Modify: `packages/skills/src/index.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

Commands:

```text
kodegpt skill source list [--state-root <path>]
kodegpt skill source add <absolute-path> [--label <label>] [--state-root <path>]
kodegpt skill source remove <source-id> [--state-root <path>]
kodegpt skill pin <skill-id> [--fingerprint <sha256>] [--state-root <path>]
kodegpt skill pins [--state-root <path>]
kodegpt skill unpin <pin-id> [--state-root <path>]
```

- [ ] **Step 1: Write RED CLI parser tests**

Reject relative add path, malformed IDs/fingerprint, unknown flags, extra positionals, and unsupported source kinds. Preserve existing CLI help exactly plus new forms.

- [ ] **Step 2: Implement local source lifecycle using the same kernel authority**

Source add starts/resolves the normal runtime only for the local command, calls typed source manager inspect/register validation, and persists only after successful Rust inspection. Source list may print canonical path because it is local operator output; remote MCP never sees it.

- [ ] **Step 3: Implement pin/pins/unpin**

Pin requires a live discovered skill, optionally enforces expected fingerprint, publishes immutable pin, and prints only safe local identifiers. Unpin deletes only KodeGPT-owned pin directory selected by validated pin ID.

- [ ] **Step 4: Add public-surface absence regression**

At this task the MCP fixture must still contain zero `skill.*` tools. Assert no source/pin mutation tool is registered.

- [ ] **Step 5: Run Task 7 gates/review**

```bash
pnpm --filter kodegpt test
pnpm --filter kodegpt typecheck
pnpm --filter @kodegpt/skills test
pnpm typecheck
```

Review local-only admission, runtime cleanup on command failure, and no MCP mutation exposure.

- [ ] **Step 6: Commit**

```bash
git add apps/cli packages/skills pnpm-lock.yaml
git commit -m "feat(cli): manage local skill sources and pins"
```

---

### Task 8: Production Wiring and Pre-Advertisement E2E

**Files:**
- Modify: `apps/cli/src/commands/start.ts`
- Modify: `apps/cli/src/commands/start.test.ts`
- Modify: `packages/skills/src/index.ts`
- Add/modify focused integration fixture under `tests/integration/`
- Do NOT modify MCP tool registration/surface version in this task

**Interfaces:**

Add production preparation dependency:

```ts
interface ProductionSkillCatalog {
  list(input: SkillListInput): Promise<SkillListResult>;
  inspect(input: SkillInspectInput): Promise<SkillInspectResult>;
  load(input: SkillLoadInput): Promise<SkillLoadResult>;
  close(): Promise<void>;
}
```

Use the same running `StartKernel`/`KernelClient` transport. Do not create another runtime, WorkspaceManager, ExecutionManager, NativeCapabilityService, audit sink, or state root.

- [ ] **Step 1: Write RED production lifecycle test**

Required start order:

```text
prepare state/audit/auth/extensions
→ start kernel + hello validation
→ create existing managers/native capabilities
→ open SkillSourceStore + typed runtime adapter + SkillSourceManager + SkillCatalog
→ create tool context (skill methods not yet publicly registered)
```

Required close order:

```text
skill catalog/source manager close/unregister all live capabilities
→ kernel stop
```

Failure after catalog creation must close catalog before stopping kernel.

- [ ] **Step 2: Implement production skill catalog factory**

Factory receives `{stateRoot, kernel}` and returns `ProductionSkillCatalog`. It may use local canonical paths from source store internally but must not put them into tool context/public results.

- [ ] **Step 3: Add real pre-advertisement E2E**

Temporary state + external source fixture:

```text
source/skill-a/SKILL.md
source/skill-a/references/guide.md
```

Exercise local registration, production stack startup, catalog list/inspect/load, pin, production restart, live source mutation/replacement, pinned load. Assert no host path in catalog result/audit and source identity replacement fails closed.

- [ ] **Step 4: Prove public MCP surface is still 0.2 and has no skill tools**

This is intentional: production usability must precede advertisement.

- [ ] **Step 5: Run Task 8 gates/review**

```bash
pnpm --filter kodegpt test
pnpm --filter @kodegpt/skills test
pnpm test:integration
pnpm typecheck
```

Review duplicated authority/lifecycle leaks. Fix all findings.

- [ ] **Step 6: Commit**

```bash
git add apps/cli packages/skills tests/integration
git commit -m "feat(skills): wire skill catalog into production"
```

---

### Task 9: Advertise `skill.list`, `skill.inspect`, `skill.load`

**Files:**
- Modify: `packages/mcp-server/package.json` to add `@kodegpt/skills: workspace:*`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/mcp-server/src/tool-context.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/annotations.ts`
- Modify: `packages/mcp-server/src/surface-version.ts`
- Modify: `packages/mcp-server/src/structured-results.test.ts`
- Modify: `apps/cli/src/commands/start.ts`
- Modify: `apps/cli/src/commands/start.test.ts`
- Modify: `tests/fixtures/mcp-surface.ts`
- Modify: `tests/integration/mcp-http.test.ts`, `mcp-stdio.test.ts`, `cli-bridge.test.ts` as locked surface expectations require
- Modify: `tests/integration/full-stack.test.ts`

**Interfaces:**

Tool context:

```ts
export interface SkillToolContext {
  list(input: SkillListInput): Promise<SkillListResult>;
  inspect(input: SkillInspectInput): Promise<SkillInspectResult>;
  load(input: SkillLoadInput): Promise<SkillLoadResult>;
}
```

Public schemas:

```ts
skill.list {
  limit?: number;                 // <=1000
  sourceId?: string;              // ss_
  compatibility?: "NATIVE"|"PARTIAL"|"PROVIDER_REQUIRED"|"UNSUPPORTED";
  pinned?: boolean;
}

skill.inspect {
  skillId: string;                // sk_ or sp_
  fingerprint?: string;           // 64 lowercase hex
}

skill.load {
  skillId: string;
  fingerprint?: string;
  resources?: string[];           // <=64, must be inventory members
  maxBytes?: number;              // <=1 MiB
}
```

- [ ] **Step 1: Write RED locked surface/schema tests**

Assert exactly three new read-only skill tools and explicit absence of:

```text
skill.run
skill.pin
skill.unpin
skill.source.add
skill.source.remove
```

- [ ] **Step 2: Wire typed skill context from already-created production catalog**

No MCP/server code receives state root, canonical source path, runtime capability ID, or filesystem adapter.

- [ ] **Step 3: Implement expected-fingerprint and resource-inventory semantics**

Live mismatch => `SKILL_FINGERPRINT_MISMATCH`. Requested resource not in inspect inventory => `SKILL_RESOURCE_UNSUPPORTED`/input-invalid stable code. Binary resource is never inlined.

- [ ] **Step 4: Add safe MCP error mapping and structured/text parity**

Unknown errors become safe generic skill failure. Recursively assert a known fixture host root never appears in structuredContent, text fallback, or error text.

- [ ] **Step 5: Advance surface 0.2 → 0.3 exactly once**

MCP protocol version stays unchanged.

- [ ] **Step 6: Run real transport/full-stack regressions**

```bash
pnpm --filter @kodegpt/mcp-server test
pnpm test -- tests/integration/mcp-http.test.ts tests/integration/mcp-stdio.test.ts tests/integration/cli-bridge.test.ts tests/integration/full-stack.test.ts
pnpm typecheck
```

Full-stack must prove `skill.list → skill.inspect → skill.load` over a production stack, not a fake unconfigured adapter.

- [ ] **Step 7: Review public authority and commit**

Review annotations, bounded schemas, no mutation/admission tools, no host path, no pre-wiring advertisement. Fix all findings, rerun, then:

```bash
git add packages/mcp-server apps/cli packages/skills tests pnpm-lock.yaml
git commit -m "feat(skills): expose bounded skill interoperability"
```

---

### Task 10: Security Audit, Documentation, and Release Gate

**Files:**
- Modify: `tests/security/security-invariants.test.ts`
- Modify: `tests/security/forbidden-patterns.test.ts`
- Add focused skill security/isolation tests under `tests/security/` and `tests/isolation/`
- Modify: `docs/compatibility/chatgpt.md`
- Modify: `docs/release/v0.1-checklist.md`
- Modify: original capability-hub spec with a short reconciliation link/note
- Modify: original 2026-08-11 Phase 2 plan with a short superseded-for-execution link/note
- Reconcile this plan's checkboxes/results

- [ ] **Step 1: Add final authority inventory assertions**

MCP surface contains no:

```text
workspace.trust
skill.run
skill.pin
skill.unpin
skill.source.add
skill.source.remove
codex.run
codex.exec
shell.run
provider.invoke
```

All three skill tools are read-only annotated.

- [ ] **Step 2: Add source-boundary/security regressions**

Prove:

```text
state-root overlap rejected
source replacement invalidates live authority
symlink/magic-link/cross-mount escape rejected
source writes never occur
allowed-tools cannot widen effective policy
compatibility classification cannot mutate policy
script resources are inert and never spawned
Node product source has no direct live-source filesystem traversal
host roots absent from MCP/audit
skill contents/resource bodies absent from audit
Codex is never spawned
```

- [ ] **Step 3: Add pin/live acceptance regression**

Real sequence:

```text
local source add
→ production start
→ MCP list/inspect/load live
→ local pin
→ mutate/delete live source
→ pinned load still succeeds
→ stale expected live fingerprint fails explicitly
```

- [ ] **Step 4: Reconcile docs**

Document:

```text
skills are instructions/resources, not authority
scripts are inert in Phase 2
PARTIAL is expected when requirements are undeclared/ambiguous
PROVIDER_REQUIRED does not imply provider support exists
source/pin administration is local CLI-only
live sources update; pin for reproducibility
MCP semantic surface 0.3
Phase 3 remains separate
```

- [ ] **Step 5: Run complete final verification on the final tree**

```bash
cargo fmt --all -- --check
pnpm typecheck
pnpm test
pnpm test:protocol
pnpm test:integration
pnpm test:security
pnpm test:isolation
pnpm test:acceptance
pnpm verify:forbidden
pnpm build
cargo test --workspace
pnpm verify:package
pnpm bench:baseline
```

Run established host-only mandatory sandbox/AppArmor checks where applicable.

- [ ] **Step 6: Run architecture scans**

At minimum:

```bash
git diff --check
git grep -nE 'codex exec|spawn\([^)]*codex|exec\([^)]*codex|shell:[[:space:]]*true' -- . ':!docs/**'
git grep -n 'skill.run' -- packages apps crates ':!**/*.test.ts'
```

Expected: no runtime Codex execution, no unrestricted shell shortcut, no `skill.run` implementation.

- [ ] **Step 7: Final branch review**

Review for:

```text
duplicate KernelClient/runtime/manager authority
raw host path leak
silent limit skipping
source/pin state confusion
live source write path
script execution path
compatibility overclaim
MCP admission/mutation leak
provider subsystem accidentally started
public tool advertised without production E2E
```

Fix every finding and rerun affected focused + final gates.

- [ ] **Step 8: Final commit**

```bash
git add packages apps crates schemas tests docs pnpm-lock.yaml Cargo.lock
git commit -m "chore(skills): complete hybrid skill interoperability"
```

---

## Self-Review Checklist

- Spec bounds/security invariants: Tasks 1–10.
- Rust retained external authority: Task 1.
- Schema/future-version-safe local source state: Task 2.
- Explicit typed runtime adapter, no generic request in manager: Task 3.
- Strict Agent Skills parsing + honest discovery completeness: Task 4.
- Content-addressed immutable pins: Task 5.
- Conservative four-state compatibility with no permission effect: Task 6.
- Source/pin mutation local CLI-only: Task 7.
- Production wiring before advertisement: Task 8.
- MCP only list/inspect/load and surface 0.3: Task 9.
- No Codex/script execution/provider gateway and full regression: Task 10.

Provider Gateway remains a separate Phase 3 design/plan.
