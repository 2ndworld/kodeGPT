# KodeGPT Capability Quality & Contract Reconciliation Design

**Date:** 2026-08-12  
**Status:** Approved direction from real ChatGPT-host acceptance; implementation plan follows in the paired plan document.  
**Scope:** Post-merge quality hardening, contract reconciliation, host evidence reconciliation, and bounded follow-up backlog extraction.  

## 1. Purpose

KodeGPT's current `main` has the native capability hub, zrok exposure, and hybrid skill interoperability implemented and exposed to ChatGPT. Real ChatGPT-host acceptance on a second trusted local project proved that the critical mutation path now works end-to-end, but it also revealed a quality defect that unit/integration fixtures did not expose strongly enough: high-level repository-understanding capabilities spend bounded search/tree/context budget on generated, vendored, VCS, cache, and linked-worktree content before reaching the most relevant project files.

This phase has four goals:

1. Make `workspace.inspect`, `code.search`, `context.build`, and verification discovery semantically relevant on large real repositories without weakening low-level filesystem authority.
2. Reconcile the implemented hybrid-skill surface with the authoritative reconciled design, fixing true missing behavior while documenting intentional stricter/safer divergences.
3. Reconcile stale tracker/release/host-evidence documents with what has now actually been observed from ChatGPT Web.
4. Extract genuinely unimplemented future work from historical documents without mistakenly reimplementing completed work from unchecked historical checkboxes.

This phase is not a redesign of KodeGPT and does not introduce a new agent runtime.

## 2. Evidence that drives this design

### 2.1 Real local-project host acceptance

The target ChatGPT host successfully:

- discovered the current KodeGPT MCP inventory;
- opened a separately trusted local project with `develop` policy;
- read a real project file;
- built context for that project;
- executed `file.edit`, read back the changed contents, reverted the exact change, and left Git clean;
- reached `skill.list`, `skill.inspect`, and `skill.load` through the ChatGPT action layer;
- preserved the expected KodeGPT-side denial for a process executable not allowed by policy.

This closes the earlier ChatGPT action-exposure blocker for file mutation and proves that the local-only workspace-trust boundary still works.

### 2.2 Repository-relevance defect observed on a real project

`workspace.inspect`, `code.search`, and `context.build` observed paths under areas such as:

```text
.git/
.worktrees/
node_modules/
target/
```

A path search for `package.json` returned the intended project manifest but also many dependency manifests and a linked-worktree copy. `context.build` then inherited that noisy search evidence. The bounded design correctly reported truncation, but the budget was spent on low-value evidence.

This is a product-quality defect rather than a security failure: KodeGPT remains bounded, but the bounded result is less useful and can consume unnecessary model context and host I/O.

### 2.3 Verification discovery gap

On the same multi-project repository, `verify.list` discovered root Cargo recipes but did not discover the nested frontend `package.json` scripts. The current verification design intentionally uses root evidence, which is safe and bounded, but that behavior is too narrow for common repositories containing application projects below the repository root.

### 2.4 Skill contract drift

The authoritative reconciled hybrid-skill plan states that exposing `skill.list`, `skill.inspect`, and `skill.load` advances the semantic MCP surface from `0.2` to `0.3`. **Planning-time finding:** when this design was written, source already exposed the three skill tools while `MCP_SURFACE_VERSION` still remained `0.2`; the reconciliation implementation subsequently advances the shipped surface to `0.3`.

The reconciled plan also specified an optional `compatibility` filter for `skill.list`. **Planning-time finding:** the public adapter/schema initially supported only `limit`, `sourceId`, and `pinned`; the reconciliation implementation subsequently adds the compatibility filter before result limiting.

Other differences are not automatically defects:

- current public skill bounds are stricter than the design draft;
- current pin identity uses stable `sk_...` skill identity plus an immutable fingerprint instead of adding a separate public `sp_...` identity;
- current pin storage is keyed by skill identity plus fingerprint.

Those implemented choices are coherent, tested, and do not widen authority. This design retains them and reconciles the older spec rather than creating compatibility-breaking churn solely to match stale prose.

### 2.5 Historical-document staleness

Historical execution plans contain unchecked boxes even where source and tests are now implemented. The v0.1 tracker also contains contradictory host-acceptance statements: some sections say real ChatGPT host evidence exists, while later sections still label it unobserved. The tracker still describes feature-worktree-era release state even though the current repository is on `main`.

Unchecked historical boxes are therefore not implementation truth. Source, tests, current runtime behavior, and explicit authoritative reconciliation documents take precedence when classifying remaining work.

## 3. Non-negotiable architecture invariants

1. Rust remains final OS/security authority for security-sensitive filesystem/process operations.
2. MCP never establishes workspace trust.
3. Primitive `file.read`, `file.tree`, `file.search`, `file.write`, `file.edit`, and `file.patch` retain their existing retained-root security semantics.
4. Semantic relevance filtering is a high-level capability behavior; it must not silently remove the operator's ability to explicitly inspect a normally excluded subtree.
5. No public arbitrary ignore-glob language is added in this phase.
6. No shell execution path is added.
7. No Codex, Claude, or other agent process is launched or proxied.
8. Existing audit fail-closed, root-FD, `openat2`, sandbox, executable-trust, policy, state-root isolation, and host-path-redaction invariants remain unchanged.
9. No second workspace manager, Git executor, process executor, runtime kernel, or capability service is introduced.
10. Skill source admission/removal and pin/unpin remain local CLI authority only.
11. `skill.run`, workspace trust mutation, provider invocation, and agent execution remain absent from MCP in this phase.
12. Results remain bounded, deterministic, typed, and explicit about incompleteness.

## 4. Semantic repository scope

### 4.1 Scope policy

Add one internal, deterministic semantic-scope policy used by high-level repository-understanding capabilities.

Default semantic traversal excludes a directory only when one of its path components exactly matches the fixed VCS/worktree/generated/vendor/cache set:

```text
.git
.worktrees
node_modules
vendor
target
dist
build
coverage
out
__pycache__
.cache
.vite
.turbo
.next
.nuxt
.svelte-kit
.pytest_cache
.mypy_cache
.ruff_cache
.tox
.venv
venv
.VSCodeCounter
.code-review-graph
```

Do **not** exclude arbitrary hidden directories merely because their names start with `.`. First-party configuration such as `.github`, `.cargo`, `.storybook`, `.devcontainer`, or other project-specific hidden directories may be semantically relevant. `workspace.inspect` may separately avoid presenting arbitrary hidden top-level directories as generic `kind:"other"` areas; that presentation rule is not a traversal deny rule.

The exclusion set is fixed product behavior, not read from `.gitignore`, because `.gitignore` is not a reliable semantic-authority contract and may contain project-specific generated syntax, negation, or broad patterns.

### 4.2 Explicit-path opt-in

A client may intentionally scope a high-level operation to a normally excluded subtree by providing that subtree as the operation's explicit root/path. Examples:

```text
code.search(path="node_modules/some-package", ...)
workspace.inspect(path=".worktrees/example", ...)
```

In that case, the requested root is admitted as the semantic root and exclusions apply only below it. This keeps default results relevant without turning the semantic policy into an access-control policy.

### 4.3 Primitive tools remain literal

`file.tree` and `file.search` remain literal workspace primitives. They do not inherit the semantic exclusion policy. A user asking for raw repository contents must still be able to inspect them within the existing workspace boundary.

## 5. `workspace.inspect` quality behavior

`workspace.inspect` applies semantic scope before language counts, manifest detection, entrypoint detection, and area classification.

Required behavior:

- generated/vendor/VCS/worktree content does not consume semantic entry budget by default;
- arbitrary hidden top-level directories are not emitted as `kind:"other"` areas;
- source language counts describe the semantic project rather than installed dependencies;
- nested first-party manifests remain visible within the bounded semantic tree;
- explicit scoped inspection of an excluded subtree remains possible;
- lexical deterministic ordering and current truncation semantics are preserved.

No new filesystem authority is needed.

## 6. `code.search` quality behavior

All five high-level search modes use semantic scope by default:

```text
text
path
symbol
definition
reference
```

For path search, filter the bounded semantic tree.

For lexical text search, extend the existing internal bounded-search request with a fixed, validated semantic-exclusion option used only by `NativeCapabilityService`. The public MCP client does not provide arbitrary exclusion names.

Required behavior:

- default search ignores generated/vendor/VCS/worktree directories;
- explicit `path` rooted inside one of those directories opts in;
- existing hard limits and truncation reasons remain authoritative;
- filtering itself must not make an incomplete result look complete;
- heuristic modes remain labeled heuristic.

## 7. `context.build` relevance behavior

`context.build` continues to compose existing native capabilities rather than directly traversing the filesystem.

Priority remains:

1. exact target;
2. changed files in the target area;
3. governing first-party manifests/config;
4. exact semantic search hits;
5. nearby tests.

Additional rules:

- an exact target explicitly requested by the caller is never dropped merely because its path would normally be excluded;
- incidental dependency/worktree/cache matches do not enter `selectedFiles` or `relevantMatches` under default semantic scope;
- the composer deduplicates equivalent search candidates before byte-budget accounting;
- a repository should not become `search-evidence-truncated` solely because ignored dependency/generated trees are large;
- current max-byte bounds and explicit truncation reporting remain unchanged.

## 8. Multi-project verification discovery

### 8.1 Goal

Extend `verify.list` from root-only project discovery to bounded first-party project-manifest discovery using the same semantic scope.

### 8.2 Discovery limits

Introduce:

```text
MAX_VERIFICATION_PROJECT_MANIFESTS = 128
VERIFICATION_MANIFEST_MAX_BYTES    = 64 KiB
```

Only semantic-scope manifests participate. Dependency/generated/worktree manifests are ignored by default.

### 8.3 Node package recipes

For each semantic `package.json` with a supported package manager declaration and one of these fixed scripts:

```text
test
lint
typecheck
build
```

emit a stable recipe with the project directory as `cwd`.

Stable IDs preserve the existing root-package contract and add the project-relative directory only for nested projects:

```text
package:test
package:lint
package:frontend:test
package:frontend:lint
```

This keeps existing root recipe IDs backward-compatible while making nested project recipes collision-free.

The script body remains metadata only; KodeGPT does not parse it into shell authority. `verify.run` re-resolves current discovery and executable/sandbox availability immediately before execution, preserving existing process authority.

Package-manager support remains whatever the current hardened implementation supports; this task broadens project discovery, not executable trust.

### 8.4 Cargo recipes

Existing root Cargo recipes remain unchanged. This phase does not recursively invent arbitrary Cargo commands for every nested crate.

## 9. Hybrid-skill public contract reconciliation

### 9.1 Semantic surface version

Because the three skill tools are now part of the advertised semantic inventory, advance:

```text
MCP_SURFACE_VERSION: 0.2 -> 0.3
```

The MCP protocol version remains `2026-07-28`.

This is one semantic-surface version correction, not a protocol break.

### 9.2 `skill.list.compatibility`

Add the missing optional filter:

```ts
compatibility?: "NATIVE" | "PARTIAL" | "PROVIDER_REQUIRED" | "UNSUPPORTED";
```

Filter before applying the requested public result limit so `limit` describes the filtered result set.

No new authority is introduced; the catalog already computes compatibility metadata.

### 9.3 Retain current stricter public bounds

Keep the implemented public skill-tool bounds:

```text
skill.list max results       = 500
skill.load requested files   = 32
skill.load max returned bytes= 512 KiB
```

Internal catalog/bundle limits may remain broader where already implemented. The public bounds are intentionally stricter defense-in-depth and should be documented as the authoritative v0.3 contract.

### 9.4 Retain stable `sk_` identity model

Keep one stable public skill identity:

```text
sk_<sha256>
```

An immutable pinned version is selected by `(skillId, fingerprint)` and represented through `availability`/`pinned` metadata. Do not add a second public `sp_` identity solely to match historical prose.

Pin storage remains private KodeGPT state keyed by the implemented stable identity/fingerprint layout. Update the reconciled design/plan to record this as the approved execution model.

## 10. ChatGPT host evidence and release-document reconciliation

Update the host evidence model using only observations actually made from the target ChatGPT host.

Record as observed where supported by evidence:

- discovery of the current KodeGPT action inventory;
- `workspace.open` for a locally trusted project;
- read action;
- write/edit availability and successful mutation/readback/revert;
- process action reaching KodeGPT, including expected policy denial cases;
- skill action exposure reaching KodeGPT.

Do not infer:

- MCP Apps visual rendering merely from `host.uiSupported` or console capability metadata;
- positive `skill.list -> skill.inspect -> skill.load` host behavior when the runtime catalog has no live/pinned skill source;
- behavior for a different ChatGPT plan/workspace.

Add one explicit positive skill-host acceptance procedure using local-only source admission, then ChatGPT read-only skill calls, optional local pinning, live mutation/deletion, and pinned reload proof. Source/pin mutation must not be added to MCP.

Reconcile the execution tracker so it no longer simultaneously claims host evidence is both observed and unavailable.

## 11. Documentation source-of-truth reconciliation

Historical plans remain historical execution records. Do not rewrite them to pretend their original checkboxes were maintained in real time.

Instead:

- add explicit reconciliation notes from historical plans to the current authoritative design/plan;
- update status prose that is factually stale;
- update the release checklist to semantic surface `0.3`;
- update current compatibility docs with semantic-scope and skill contract behavior;
- add `docs/architecture/README.md` as a durable authority index that points to the current architecture/security/spec authorities already stored in the repo, rather than inventing missing blueprint text.

## 12. Out of scope and extracted future work

### 12.1 Provider interoperability is genuinely unimplemented

Historical skill documents explicitly defer:

```text
provider.list
provider.tools
provider.invoke
```

This remains genuine future work and requires its own security/design phase after this quality/reconciliation phase is accepted. Provider interoperability must not be smuggled into this implementation plan because it creates a new authority boundary.

### 12.2 `skill.run` remains out of scope

A generic `skill.run` would conflate instructions with execution and is intentionally absent. Existing KodeGPT native tools remain the execution surface.

### 12.3 Generic tunnel-provider abstraction remains out of scope

The zrok replacement design explicitly rejected carrying both ngrok and zrok or creating a generic tunnel abstraction for v0.1. Do not resurrect superseded ngrok work as a missing task.

### 12.4 Desktop/computer-use work is not part of this phase

This phase is repository capability quality and contract reconciliation only.

## 13. Acceptance criteria

This phase is complete when all of the following are true:

1. A Pranikah-like regression fixture proves default `workspace.inspect`, `code.search`, and `context.build` do not spend result/context budget on `.git`, `.worktrees`, `node_modules`, `target`, or hidden cache/agent directories.
2. Explicitly scoping a semantic capability to an excluded subtree still works within the existing security boundary.
3. `context.build` for a nested first-party manifest selects first-party evidence and avoids dependency/worktree duplicates.
4. `verify.list` discovers fixed scripts for bounded nested first-party package manifests such as `frontend/package.json` while preserving existing execution trust checks.
5. The three skill tools remain read-only and source/pin mutation remains absent from MCP.
6. `skill.list` supports the optional compatibility filter.
7. MCP semantic surface reports `0.3`; MCP protocol remains `2026-07-28`.
8. Current stricter skill public bounds and the stable `sk_ + fingerprint` identity model are documented consistently across source tests, compatibility docs, and reconciliation docs.
9. Tracker/release docs no longer contradict current host observations.
10. MCP Apps rendering remains separately marked observed or unobserved based on an actual host test.
11. Positive ChatGPT-host skill acceptance has an executable local-only fixture procedure and is not faked through MCP mutation authority.
12. All focused and complete TypeScript/Rust/security/integration/isolation/acceptance/package gates pass with no security invariant weakened.
13. Provider interoperability is recorded as a separate future design item, not partially implemented here.
