# KodeGPT Hybrid Skill Interoperability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let GPT Web discover, inspect, and load portable Agent Skills/Codex skill assets without executing Codex, while preserving live read-only discovery and explicit reproducible pinned snapshots.

**Architecture:** Add a separate `@kodegpt/skills` subsystem, backed by a Rust retained read-only skill-source capability for directories outside workspace trust. Source registration and pin/unpin remain local CLI authority; upstream MCP exposes only `skill.list`, `skill.inspect`, and `skill.load` over already-registered sources and pinned KodeGPT-owned snapshots.

**Tech Stack:** Node.js >=24, TypeScript 5.9, pnpm 10, Vitest 3, Zod 4, YAML parser (`yaml@2`), Rust workspace crates, existing framed runtime protocol, workspace-io openat/identity/mount boundary primitives, existing KodeGPT state-store conventions.

## Global Constraints

- KodeGPT MUST NOT spawn `codex`, invoke `codex exec`, attach to Codex sessions, reuse Codex auth/session state, or require a Codex process.
- There is intentionally NO `skill.run` MCP tool.
- A skill is instruction/resource data; GPT Web remains the reasoning actor.
- Live external skill directories are read-only and MUST NOT be modified by KodeGPT.
- External source registration/removal and pin/unpin are local CLI operations only; MCP cannot add arbitrary host paths.
- Rust remains final authority for reading registered external skill roots.
- Skill source identity is pinned to canonical root + filesystem identity; replacement/mismatch fails closed.
- Skill source roots overlapping KodeGPT state root are rejected.
- Symlink/magic-link/mount escapes remain rejected by retained-root resolution.
- Skills cannot widen workspace trust, write, process, network, executable, env, or provider permissions.
- MCP output MUST NOT expose absolute external skill-source paths, FDs, capability IDs, credentials, or raw host errors.
- Pinned state uses schemaVersion 1, private permissions, atomic persistence, immutable fingerprint directories, and rejects unsupported future versions.
- All skill/resource lists and payloads are bounded.
- Existing native capability, trust, audit, process, transport, packaging, and security gates remain green.

---

## File Structure

Create:

```text
packages/skills/
  package.json
  tsconfig.json
  vitest.config.ts
  src/index.ts
  src/contracts.ts
  src/source-store.ts
  src/source-manager.ts
  src/parser.ts
  src/fingerprint.ts
  src/catalog.ts
  src/pin-store.ts
  src/compatibility.ts
  src/*.test.ts

apps/cli/src/commands/skill.ts
apps/cli/src/commands/skill.test.ts
```

Modify:

```text
packages/protocol/src/types.ts
packages/protocol/src/index.ts
crates/protocol/src/types.rs
crates/workspace-io/src/lib.rs
crates/workspace-io/src/registry.rs
crates/workspace-io/src/read.rs
crates/runtime/src/dispatcher.rs
packages/capabilities/src/contracts.ts
packages/capabilities/src/index.ts
packages/mcp-server/package.json
packages/mcp-server/src/tool-context.ts
packages/mcp-server/src/tools.ts
packages/mcp-server/src/index.ts
apps/cli/package.json
apps/cli/src/commands/start.ts
apps/cli/src/main.ts
docs/compatibility/chatgpt.md
tests/security/security-invariants.test.ts
```

Do not merge this subsystem into `packages/extensions`; extension manifests and skills keep distinct security semantics.

---

### Task 1: Add Rust Retained Read-Only Skill Source Authority

**Files:**
- Modify: `packages/protocol/src/types.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `crates/protocol/src/types.rs`
- Modify: `crates/workspace-io/src/registry.rs`
- Modify: `crates/workspace-io/src/read.rs`
- Modify: `crates/workspace-io/src/lib.rs`
- Modify: `crates/runtime/src/dispatcher.rs`
- Add focused Rust tests beside registry/read/dispatcher tests.

**Interfaces:**
- Produces internal runtime methods: `skill_source.inspect_root`, `skill_source.register`, `skill_source.tree`, `skill_source.read`, `skill_source.unregister`.
- No new MCP tools in this task.

- [ ] **Step 1: Add RED protocol tests for the skill-source methods**

Add these `RuntimeMethod` values in TS/Rust parity:

```text
skill_source.inspect_root
skill_source.register
skill_source.tree
skill_source.read
skill_source.unregister
```

Logical request/response contracts:

```ts
// inspect
{ path: string }
=> { canonicalRoot: string, identity: { deviceMajor: number, deviceMinor: number, inode: string } }

// register
{ rootPath: string, expectedIdentity: PersistentFilesystemIdentity }
=> { sourceCapabilityId: string } // prefix src_

// tree
{ sourceCapabilityId: string, path: string, maxEntries: number }
=> { entries: Array<{ path: string, kind: "file"|"directory"|"symlink"|"other", bytes?: number }>, truncated: boolean }

// read
{ sourceCapabilityId: string, path: string, offset: number, maxBytes: number }
=> { contents: string, bytesRead: number, eof: boolean }

// unregister
{ sourceCapabilityId: string }
=> { ok: true }
```

No write/process method accepts `sourceCapabilityId`.

- [ ] **Step 2: Run protocol/runtime RED**

```bash
pnpm test:protocol
cargo test -p kodegpt-protocol
cargo test -p kodegpt-workspace-io
cargo test -p kodegpt-runtime
```

- [ ] **Step 3: Implement a separate source-capability registry**

Do not reuse a workspace capability ID as a skill source. Add a registry type that stores only retained read-only root information and identity. IDs use `src_` + opaque random material.

Registration sequence:

```text
canonical root / identity already inspected
→ compare expected filesystem identity
→ verify directory
→ verify mount topology/boundary using existing workspace-io primitives
→ retain root FD/capability
→ return src_... id
```

Do not attach profile/write/process state to this capability.

- [ ] **Step 4: Implement bounded tree/read only**

Reuse existing beneath/no-magiclink/no-cross-mount read helpers. `skill_source.read` is UTF-8 text only in v1; invalid UTF-8 returns a stable unsupported-resource error.

Hard runtime ceilings:

```text
max tree entries per call: 10_000
max read bytes per call: 1 MiB
```

- [ ] **Step 5: Add state-root overlap rejection**

At runtime startup the dispatcher knows state root. `skill_source.inspect_root`/`register` must reject a source whose visible/backing root equals, contains, or is contained by the active KodeGPT state root. Use a stable code such as `SKILL_SOURCE_STATE_OVERLAP`.

- [ ] **Step 6: Preserve durable audit-before-read policy**

Source registration and source reads are security-relevant host access. Follow existing audit decision/outcome patterns. Audit public source IDs/relative paths, never raw capability FDs.

- [ ] **Step 7: Add isolation tests**

Required cases:

```text
identity replacement => register fails
../ traversal => read fails
symlink escape => read fails
cross-mount escape => read fails
state-root overlap => inspect/register fails
workspace file.write with src_ id => rejected
process.run with src_ id => rejected
unregister invalidates future reads
```

- [ ] **Step 8: Run GREEN and commit**

```bash
pnpm test:protocol
cargo test -p kodegpt-workspace-io
cargo test -p kodegpt-runtime

git add packages/protocol crates/protocol crates/workspace-io crates/runtime

git commit -m "feat(runtime): add read-only skill source authority"
```

---

### Task 2: Create Skill Contracts and Local Source Registry

**Files:**
- Create: `packages/skills/package.json`
- Create: `packages/skills/tsconfig.json`
- Create: `packages/skills/vitest.config.ts`
- Create: `packages/skills/src/contracts.ts`
- Create: `packages/skills/src/source-store.ts`
- Create: `packages/skills/src/source-store.test.ts`
- Create: `packages/skills/src/index.ts`

**Interfaces:**
- Produces: `SkillSourceStore`, source entry schema, public skill contract types and bounds.

- [ ] **Step 1: Add package and dependency**

`packages/skills/package.json`:

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
    "@kodegpt/capabilities": "workspace:*",
    "@kodegpt/trust": "workspace:*",
    "yaml": "^2.0.0"
  }
}
```

Run once after creating the package:

```bash
pnpm install
```

- [ ] **Step 2: Write RED store tests**

Tests must prove:

```text
missing sources.json => empty store
add persists schemaVersion 1
same canonical root cannot be added twice
remove is deterministic/idempotent
dir/file modes are 0700/0600 consistent with existing stores
future schemaVersion => SKILL_REGISTRY_SCHEMA_UNSUPPORTED
unknown fields => SKILL_REGISTRY_INVALID
```

- [ ] **Step 3: Define contracts and limits**

`contracts.ts`:

```ts
export const SKILL_STATE_SCHEMA_VERSION = 1 as const;
export const MAX_SKILL_SOURCES = 32;
export const MAX_DISCOVERED_SKILLS = 500;
export const MAX_SKILL_MAIN_BYTES = 256 * 1024;
export const MAX_SKILL_RESOURCE_BYTES = 256 * 1024;
export const MAX_SKILL_BUNDLE_BYTES = 1024 * 1024;
export const MAX_SKILL_RESOURCES = 128;
export const MAX_SKILL_LOAD_BYTES = 512 * 1024;

export type SkillSourceKind = "agent-skills";
export type SkillCompatibility = "NATIVE" | "PARTIAL" | "PROVIDER_REQUIRED" | "UNSUPPORTED";
```

Source persistence type:

```ts
interface PersistedSkillSource {
  id: string;              // ksrc_<opaque>
  kind: "agent-skills";
  canonicalRoot: string;   // local-only, never returned by MCP
  identity: PersistentFilesystemIdentity;
}
```

- [ ] **Step 4: Implement atomic source persistence**

State path:

```text
<stateRoot>/skills/sources.json
```

Use temp file + rename. Reject IDs not matching `^ksrc_[A-Za-z0-9_-]{16,64}$`.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @kodegpt/skills typecheck
pnpm --filter @kodegpt/skills test

git add packages/skills pnpm-lock.yaml

git commit -m "feat(skills): add local skill source registry"
```

---

### Task 3: Add Skill Source Manager Over Runtime Authority

**Files:**
- Create: `packages/skills/src/source-manager.ts`
- Create: `packages/skills/src/source-manager.test.ts`
- Modify: `packages/skills/src/index.ts`

**Interfaces:**
- Consumes: `SkillSourceStore` + a narrow runtime adapter.
- Produces: `SkillSourceManager.inspect/add/remove/register/read/tree/close`.

- [ ] **Step 1: Add a RED source-manager test with a fake runtime**

Runtime adapter:

```ts
export interface SkillSourceRuntime {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
}
```

Test add flow:

```ts
runtime skill_source.inspect_root => canonical root + identity
store.add => persisted ksrc_ entry
manager.register => runtime skill_source.register with exact expectedIdentity
```

- [ ] **Step 2: Implement local-only add/remove**

`addSource(path)`:

```text
validate non-empty absolute path
→ runtime skill_source.inspect_root
→ generate ksrc_ id with randomUUID stripped of dashes
→ persist canonicalRoot + identity
```

`removeSource(id)` removes store entry and unregisters an active runtime source capability if present.

- [ ] **Step 3: Implement lazy runtime registration**

`ensureRegistered(sourceId)` reads the persisted entry then calls:

```ts
runtime.request("skill_source.register", {
  rootPath: entry.canonicalRoot,
  expectedIdentity: entry.identity
});
```

Cache only the opaque `sourceCapabilityId` in memory. If identity changed, propagate a stable source-identity error; never silently refresh the identity.

- [ ] **Step 4: Implement source read/tree wrappers**

Public manager methods accept `sourceId` + relative path and never return `canonicalRoot` or `sourceCapabilityId`.

- [ ] **Step 5: Implement `close()`**

Unregister all cached runtime capabilities before kernel stop; best-effort close must attempt every active source and aggregate/report failures only to local lifecycle logs, not leak capability IDs upstream.

- [ ] **Step 6: Run GREEN and commit**

```bash
pnpm --filter @kodegpt/skills test

git add packages/skills

git commit -m "feat(skills): manage retained read-only skill sources"
```

---

### Task 4: Parse Skills, Discover Live Catalog, and Fingerprint Bundles

**Files:**
- Create: `packages/skills/src/parser.ts`
- Create: `packages/skills/src/fingerprint.ts`
- Create: `packages/skills/src/catalog.ts`
- Create: `packages/skills/src/parser.test.ts`
- Create: `packages/skills/src/fingerprint.test.ts`
- Create: `packages/skills/src/catalog.test.ts`
- Modify: `packages/skills/src/index.ts`

**Interfaces:**
- Consumes: `SkillSourceManager.tree/read`.
- Produces: live `SkillCatalog.list/inspect/loadRaw` with host-safe identities.

- [ ] **Step 1: Write RED parser tests**

Fixture:

```markdown
---
name: systematic-debugging
description: Debug failures systematically before proposing fixes.
---
# Systematic Debugging
Follow evidence before changes.
```

Assert parsed `name`, `description`, Markdown body, and normalized metadata. Add malformed frontmatter, duplicate YAML key, oversized main file, and non-object frontmatter rejection tests.

- [ ] **Step 2: Implement conservative YAML parsing**

Use `yaml` `parseDocument` with strict/unique-key behavior and no custom executable tags. Accept bounded scalar/object metadata only; never evaluate tags/functions.

Require skill directory main file name exactly `SKILL.md` for v1 discovery.

- [ ] **Step 3: Write RED catalog discovery tests**

Discovery walks registered source tree and identifies directories containing `SKILL.md`. Bounds:

```text
max discovered skills: 500
max supported resources per skill: 128
max bundle supported-text bytes: 1 MiB
```

Resource paths are relative to the skill directory and sorted lexically.

- [ ] **Step 4: Define stable public skill ID**

Generate:

```ts
skillId = "skill_" + sha256(`${sourceId}\0${relativeSkillDir}`).slice(0, 32)
```

Public metadata may include `sourceId` and skill-relative path, but never the external source absolute path.

- [ ] **Step 5: Implement supported resource rules**

Supported loadable resource extensions in v1:

```text
.md .txt .json .yaml .yml .toml .ts .tsx .js .mjs .cjs .py .rs .sh
```

They are treated strictly as text data; `.sh`, `.py`, `.js`, etc. are **never executed** by the skill subsystem.

Non-UTF8/binary resources are recorded as unsupported metadata and excluded from `skill.load` bodies.

- [ ] **Step 6: Write RED fingerprint tests**

Fingerprint must be stable when directory listing order/timestamps differ and must change when any included supported resource path or bytes change.

Canonical digest stream:

```text
for each included file sorted by relative path:
  UTF8(path)
  NUL
  UTF8(decimal byte length)
  NUL
  raw UTF8 bytes
  NUL
```

Use SHA-256 lowercase hex.

- [ ] **Step 7: Implement live list/inspect/raw-load**

`list()` returns bounded metadata + current fingerprint. `inspect()` includes resource manifest and byte counts. `loadRaw()` can read the main instructions and requested text resources but does not yet apply pin/compatibility semantics.

- [ ] **Step 8: Run GREEN and commit**

```bash
pnpm --filter @kodegpt/skills test

git add packages/skills

git commit -m "feat(skills): discover and fingerprint live agent skills"
```

---

### Task 5: Add Immutable Pinned Skill Snapshots

**Files:**
- Create: `packages/skills/src/pin-store.ts`
- Create: `packages/skills/src/pin-store.test.ts`
- Modify: `packages/skills/src/catalog.ts`
- Modify: `packages/skills/src/index.ts`

**Interfaces:**
- Consumes: live catalog raw bundle.
- Produces: `pin`, `unpin`, pinned list/inspect/load fallback.

- [ ] **Step 1: Write RED pin-store tests**

Required cases:

```text
pin creates immutable fingerprint directory
pin same fingerprint is idempotent
pin never calls any source write operation
pinned snapshot remains loadable after live source disappears
live source changes => old pin remains + new live fingerprint visible
future manifest schema rejected
absolute source path absent from pinned manifest
unpin removes only selected fingerprint
```

- [ ] **Step 2: Define pinned layout and manifest**

```text
<stateRoot>/skills/pinned/<skillId>/<fingerprint>/
  manifest.json
  SKILL.md
  resources/<relative paths>
```

`manifest.json`:

```ts
{
  schemaVersion: 1,
  skillId,
  name,
  description,
  fingerprint,
  provenance: {
    sourceId,
    sourceKind: "agent-skills",
    sourceRelativePath,
    pinnedAt
  },
  files: [{ path, bytes, sha256 }]
}
```

No canonical source root is persisted in the snapshot manifest.

- [ ] **Step 3: Implement atomic immutable pin**

Write to a temporary directory beneath `skills/pinned`, fs-safe/private modes, then rename into the final fingerprint directory. If final directory already exists, validate its manifest fingerprint and treat as idempotent.

Never overwrite a different existing snapshot.

- [ ] **Step 4: Merge live + pinned catalog views**

A skill listing may expose:

```ts
{
  skillId,
  name,
  fingerprint,
  availability: "live" | "pinned" | "live+pinned",
  pinned: boolean
}
```

If live is missing but a pin exists, pinned remains loadable.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @kodegpt/skills test

git add packages/skills

git commit -m "feat(skills): add reproducible pinned skill snapshots"
```

---

### Task 6: Implement Conservative Capability Compatibility Analysis

**Files:**
- Create: `packages/skills/src/compatibility.ts`
- Create: `packages/skills/src/compatibility.test.ts`
- Modify: `packages/capabilities/src/contracts.ts`
- Modify: `packages/capabilities/src/index.ts`
- Modify: `packages/skills/src/catalog.ts`

**Interfaces:**
- Consumes: stable native capability vocabulary from Phase 1.
- Produces: `SkillCompatibilityReport` included in list/inspect/load.

- [ ] **Step 1: Export native capability IDs from `@kodegpt/capabilities`**

Add a frozen set:

```ts
export const NATIVE_CAPABILITY_IDS = Object.freeze([
  "workspace.inspect",
  "code.search",
  "file.read",
  "file.write",
  "file.edit",
  "file.patch",
  "git.status",
  "git.diff",
  "git.changes",
  "process.run",
  "verify.list",
  "verify.run",
  "context.build"
] as const);
```

This is descriptive capability vocabulary, not a permission grant.

- [ ] **Step 2: Write RED compatibility tests**

Test four classes:

```text
pure instruction skill using native reads/search => NATIVE
skill mentioning an unmodeled external CLI/workflow => PARTIAL
skill declaring metadata.kodegpt.providers=["figma"] => PROVIDER_REQUIRED
skill declaring/requiring codex exec or subagent session semantics => UNSUPPORTED
```

- [ ] **Step 3: Support optional structured KodeGPT metadata without requiring it**

Recognize optional frontmatter:

```yaml
metadata:
  kodegpt:
    requires:
      capabilities: [code.search, verify.run]
      providers: [figma]
    unsupported: []
```

Unknown metadata does not execute anything and does not grant permissions.

- [ ] **Step 4: Add deterministic static warnings for generic skills**

Static analysis may recognize explicit code-span/command references such as `codex exec`, `codex`, subagent/session-only workflow terms, and tool/provider references. Classification remains conservative and includes:

```ts
interface SkillCompatibilityReport {
  classification: SkillCompatibility;
  requiredCapabilities: string[];
  missingCapabilities: string[];
  requiredProviders: string[];
  reasons: string[];
  analysisBasis: "declared" | "static" | "declared+static";
}
```

Never infer a permission grant from prose.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @kodegpt/capabilities test
pnpm --filter @kodegpt/skills test

git add packages/capabilities packages/skills

git commit -m "feat(skills): classify skill capability compatibility"
```

---

### Task 7: Expose `skill.list`, `skill.inspect`, and `skill.load` Through MCP

**Files:**
- Modify: `packages/mcp-server/package.json`
- Modify: `packages/mcp-server/src/tool-context.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/index.ts`
- Add: `packages/mcp-server/src/skills.test.ts`

**Interfaces:**
- Consumes: host-safe `SkillCatalogToolAdapter`.
- Produces: three read-only MCP tools; still no pin/source mutation and no `skill.run`.

- [ ] **Step 1: Add dependency and RED surface tests**

Add:

```json
"@kodegpt/skills": "workspace:*"
```

Assert surface contains exactly:

```text
skill.list
skill.inspect
skill.load
```

and does not contain:

```text
skill.run
skill.pin
skill.unpin
skill.source.add
skill.source.remove
```

- [ ] **Step 2: Add typed skill context**

```ts
export interface SkillToolContext {
  list(input: { limit?: number; sourceId?: string; pinned?: boolean }): Promise<SkillListResult>;
  inspect(input: { skillId: string; fingerprint?: string }): Promise<SkillInspectResult>;
  load(input: {
    skillId: string;
    fingerprint?: string;
    resources?: string[];
    maxBytes?: number;
  }): Promise<SkillLoadResult>;
}
```

- [ ] **Step 3: Implement expected-fingerprint semantics**

For live skills, if `fingerprint` input is supplied and current fingerprint differs, fail with `SKILL_FINGERPRINT_MISMATCH`. Do not silently return updated instructions.

Pinned lookup with an exact fingerprint remains stable.

- [ ] **Step 4: Register bounded schemas**

`skill.list`:

```ts
{
  limit: z.number().int().positive().max(500).optional(),
  sourceId: z.string().startsWith("ksrc_").optional(),
  pinned: z.boolean().optional()
}
```

`skill.inspect`:

```ts
{
  skillId: z.string().startsWith("skill_"),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional()
}
```

`skill.load`:

```ts
{
  skillId: z.string().startsWith("skill_"),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  resources: z.array(z.string().min(1)).max(32).optional(),
  maxBytes: z.number().int().positive().max(512 * 1024).optional()
}
```

All use read-only annotations and structured result helper.

- [ ] **Step 5: Prove absolute host paths are absent**

Tests recursively inspect serialized `structuredContent` and fail if a known fixture canonical source root occurs anywhere.

- [ ] **Step 6: Run GREEN and commit**

```bash
pnpm --filter @kodegpt/mcp-server test
pnpm --filter @kodegpt/mcp-server typecheck

git add packages/mcp-server packages/skills pnpm-lock.yaml

git commit -m "feat(mcp): expose read-only skill catalog tools"
```

---

### Task 8: Add Local CLI Skill Source and Pin Commands

**Files:**
- Create: `apps/cli/src/commands/skill.ts`
- Create: `apps/cli/src/commands/skill.test.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/package.json`

**Interfaces:**
- Consumes: `SkillSourceStore`, `SkillSourceManager`, `SkillCatalog`, `KernelClient`.
- Produces local commands: source list/add/remove and pin/unpin.

- [ ] **Step 1: Write RED command parser tests**

Supported syntax:

```text
kodegpt skill source list [--state-root <path>]
kodegpt skill source add <absolute-path> [--kind agent-skills] [--state-root <path>]
kodegpt skill source remove <ksrc-id> [--state-root <path>]
kodegpt skill pin <skill-id> [--fingerprint <sha256>] [--state-root <path>]
kodegpt skill unpin <skill-id> [--fingerprint <sha256>] [--state-root <path>]
```

Reject unknown options, relative source path, unsupported kind, malformed IDs/fingerprints, and extra positional arguments.

- [ ] **Step 2: Follow the existing `workspace` local-authority pattern**

In `main.ts`, add `skill` command handling. Resolve/start `KernelClient` only for the duration needed by the local command, like workspace root inspection does today.

Source add uses runtime inspection before persistence. Source list output may show the canonical path because it is local terminal output; this restriction applies to MCP, not the operator’s own CLI.

- [ ] **Step 3: Implement local pin/unpin**

Pin resolves live skill, optionally enforces expected fingerprint, copies the supported bounded bundle into the pin store, and prints:

```text
pinned <skillId> <fingerprint>
```

Unpin prints:

```text
unpinned <skillId> <fingerprint>
```

No MCP mutation tool is added.

- [ ] **Step 4: Update help text**

Add exact skill command forms. Keep workspace/auth/start/bridge/expose help intact.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @kodegpt/cli test
pnpm --filter @kodegpt/cli typecheck

git add apps/cli packages/skills pnpm-lock.yaml

git commit -m "feat(cli): manage local skill sources and pins"
```

---

### Task 9: Wire Skill Catalog Into Production Stack and Lifecycle

**Files:**
- Modify: `apps/cli/src/commands/start.ts`
- Modify: `apps/cli/src/commands/start.test.ts`
- Modify: `packages/mcp-server/src/tool-context.ts`

**Interfaces:**
- Produces: production MCP tool context backed by a live/pinned `SkillCatalog`.

- [ ] **Step 1: Add RED production-stack lifecycle test**

Assert startup order conceptually:

```text
prepare state/audit/auth/extensions
→ start kernel + hello validation
→ open SkillSourceStore/SkillSourceManager/SkillCatalog using the running kernel
→ create managers/capabilities/tool context
```

Assert close order calls `skillCatalog.close()` / source-manager unregister before `kernel.stop()`.

- [ ] **Step 2: Add production dependency boundary**

Extend stack dependencies with a testable factory:

```ts
prepareSkillCatalog(options: {
  stateRoot: string;
  kernel: StartKernel;
}): Promise<SkillCatalogToolAdapter & { close(): Promise<void> }>;
```

Do not make `@kodegpt/mcp-server` know stateRoot or host paths.

- [ ] **Step 3: Wire skill context**

Pass catalog methods through `createKodegptToolContext`. On stack-start failure after catalog creation, close catalog then stop kernel.

- [ ] **Step 4: Run GREEN and commit**

```bash
pnpm --filter @kodegpt/cli test
pnpm --filter @kodegpt/mcp-server test
pnpm --filter @kodegpt/skills test

git add apps/cli packages/mcp-server packages/skills

git commit -m "feat(skills): wire skill catalog into production stack"
```

---

### Task 10: Security Regression, Documentation, and Release Gate

**Files:**
- Modify: `tests/security/security-invariants.test.ts`
- Add: focused integration/security tests under `tests/integration/` and `tests/isolation/`
- Modify: `docs/compatibility/chatgpt.md`
- Modify: MCP surface version tests if the native phase did not already bump the version for this release line.

**Interfaces:**
- Produces: releasable hybrid skill interoperability surface.

- [ ] **Step 1: Add explicit invariant tests**

Assert source/mutation tools are absent upstream:

```text
skill.run
skill.pin
skill.unpin
skill.source.add
skill.source.remove
workspace.trust
```

Assert skill read tools are read-only annotated.

- [ ] **Step 2: Add end-to-end live/pin fixture**

Use a temporary source containing one `SKILL.md` + text resource:

```text
local source add
→ MCP skill.list sees live skill
→ skill.inspect returns fingerprint, no absolute source root
→ skill.load returns instructions
→ local pin
→ mutate/delete live source
→ pinned fingerprint still loads
→ expected old live fingerprint mismatch fails when live content changed
```

The test harness may call local command functions directly rather than spawn the packaged CLI.

- [ ] **Step 3: Add negative security fixtures**

Required:

```text
skill source points into stateRoot => rejected
skill resource symlink escapes source => rejected
binary resource load => SKILL_RESOURCE_UNSUPPORTED
oversized main/resource/bundle => bounded error
malformed YAML => SKILL_BUNDLE_INVALID
live source identity changes => fails closed
skill content containing `codex exec` => classified unsupported, never executed
script resource is returned only as text when explicitly loaded, never executed
```

- [ ] **Step 4: Update ChatGPT compatibility docs**

Document the user model:

```text
GPT Web chooses/follows a skill
KodeGPT only discovers/loads instruction resources
KodeGPT native tools perform the actual allowed host operations
Codex is not launched or proxied
live skills auto-reflect source updates
pin important skills for reproducibility
source add/remove and pin/unpin are local CLI actions
```

Also explain compatibility classifications and their advisory/non-permission nature.

- [ ] **Step 5: Run complete verification**

```bash
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
```

Run the existing host-only mandatory sandbox/AppArmor gate in its established release environment where required.

- [ ] **Step 6: Run forbidden architecture scans**

```bash
git diff --check
git grep -nE 'codex exec|spawn\([^)]*codex|exec\([^)]*codex' -- . ':!docs/**' ':!packages/skills/src/compatibility.test.ts'
git grep -n 'skill.run' -- packages apps crates tests ':!tests/security/**' ':!packages/mcp-server/src/skills.test.ts'
```

Expected: no runtime Codex execution and no implementation of `skill.run`.

- [ ] **Step 7: Commit**

```bash
git add packages apps crates tests docs pnpm-lock.yaml Cargo.lock

git commit -m "feat: ship hybrid agent skill interoperability"
```

---

## Self-Review Checklist

- Rust read-only external source authority: Task 1.
- Local source persistence with identity pinning: Task 2–3.
- YAML skill parsing/live discovery/fingerprinting: Task 4.
- Immutable reproducible pinning: Task 5.
- Native/partial/provider-required/unsupported compatibility: Task 6.
- MCP only exposes list/inspect/load: Task 7.
- Source and pin mutation remain local CLI-only: Task 8.
- Production stack lifecycle owns source capability cleanup: Task 9.
- No host path leak, no skill execution, no Codex runtime, full security regression: Task 10.

Provider invocation (`provider.list/tools/invoke`) is intentionally excluded and requires its own future design/implementation plan after this phase is proven.
