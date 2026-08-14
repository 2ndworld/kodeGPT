# KodeGPT Bounded Read-Only Git History Intelligence Design

**Date:** 2026-08-14  
**Status:** Design candidate; implementation has not started  
**Baseline:** post-PR #8 canonical `main` (`3e3e257500d8d35d887ab8a68d55439dbdae0c1a`)  
**Scope:** local, read-only, structured, bounded Git history intelligence for READY trusted workspaces

## 1. Problem statement

KodeGPT already exposes hardened current-state Git inspection through `git.status`, `git.diff`, and the structured `git.changes` checkpoint. It cannot yet answer bounded historical questions such as:

- which commits are recent;
- what one commit changed;
- whether one commit is an ancestor of another;
- which commits are in a bounded range;
- what changed between two historical revisions.

The new capability must not turn KodeGPT into an arbitrary Git or shell executor. The security authority remains in Rust, every Git process remains confined to the retained READY workspace root, repository data remains local-only, and all public results are structured and explicitly bounded.

This phase does **not** add provider interoperability, provider-agent execution, `skill.run`, generic shell, raw Git argument execution, Git mutation, network Git, workspace-trust mutation over MCP, or service-lifecycle mutation over MCP.

## 2. Fresh baseline and current Git capability audit

The 2026-08-14 fresh host audit established:

- repo root: `/home/sauron/dev/kodegpt`;
- branch: `main`;
- `HEAD == origin/main == 3e3e257500d8d35d887ab8a68d55439dbdae0c1a` after `git fetch origin --prune`;
- `main...origin/main = 0 0`;
- working tree initially clean;
- only the canonical worktree existed;
- stash was empty;
- `v0.1^{}` remained `b8eae12cea3be002a9a61d06cecfd34f86283eb4`;
- installed KodeGPT service remained running and listener-ready on active release `rel_fa7cf9e07de98ae6941da6c4e3f9a918`;
- runtime `0.1`, MCP protocol `2026-07-28`, semantic surface `0.3`.

### 2.1 Existing Rust Git authority

`crates/runtime/src/git.rs` is the existing hardened Git execution implementation. Current public `git.status` and `git.diff`, plus internal structured `git.checkpoint` and `git.checkpoint_patch`, ultimately use this path.

Current invariants already implemented and to be reused:

- `git` is selected by logical name only and resolved with `resolve_trusted_executable("git")`;
- trusted executable resolution is restricted to `/usr/local/bin`, `/usr/bin`, and `/bin`;
- the canonical executable and its directory chain must be root-owned and not group/world writable;
- executable identity stores canonical path/device/inode/mode/uid and is revalidated immediately before spawn;
- Git is launched through `BubblewrapProvider`, never through a shell;
- the READY retained root FD is duplicated in the runtime and mounted as `/workspace`;
- Git workspace access is `WorkspaceAccess::ReadOnly`;
- the sandbox clears the environment, sets a fixed PATH/HOME/TMPDIR, drops capabilities, uses a new session, and denies network with `--unshare-net`;
- `GIT_OPTIONAL_LOCKS=0`, system/global Git configuration, pager, prompt, and system attributes are neutralized;
- `core.fsmonitor`, hooks, credential helper, external diff, auto refresh, file transport, textconv, submodules, and repository-defined filter drivers are neutralized by fixed arguments/config overrides;
- output is captured through an opaque raw spool and bounded public preview;
- public MCP serialization does not expose private capability IDs, process groups, PIDs, or host artifact paths;
- a durable audit decision is written before READY root duplication/spawn and an outcome is written after completion.

The existing security test `tests/security/git-helper-isolation.test.ts` and Rust Git tests prove helper suppression and byte-for-byte repository stability for current `git.status`/`git.diff` fixtures.

### 2.2 Existing retained-root authority

`crates/workspace-io/src/registry.rs` owns READY capability state and retained root FDs. `duplicate_ready_root_fd()` succeeds only for a registered READY capability. Git dispatch therefore does not receive an arbitrary host path from TypeScript.

Historical Git must use the same retained capability path. No new public host-path parameter or TypeScript filesystem authority is permitted.

### 2.3 Existing public/TypeScript layers

`packages/core/src/workspace-manager.ts` maps opaque public `workspaceId` to the private runtime capability and validates runtime Git payloads. `packages/mcp-server/src/tool-context.ts` and `tools.ts` expose only the public workspace ID.

`git.changes` already demonstrates the preferred high-level pattern:

1. Rust owns low-level Git/process security and structured primitives;
2. `WorkspaceManager` validates the runtime contract;
3. `@kodegpt/capabilities` normalizes a stable structured capability result/error contract;
4. MCP registers a bounded read-only schema and returns structured content.

Historical Git should follow that pattern rather than teaching TypeScript how to construct arbitrary Git argv.

### 2.4 Gaps relevant to history

The audit found several gaps that are acceptable for the current narrow status/diff surface but must be addressed for history traversal:

- current Git capture has no explicit wall-clock command timeout;
- the global raw spool source cap is 64 MiB, much larger than an appropriate history response budget;
- current Git errors are mostly collapsed to `GIT_INSPECTION_FAILED`;
- no historical revision grammar exists;
- no semantic cursor/pagination convention exists in the public capability layer;
- there is no structured commit/range/history-diff runtime contract;
- current semantic surface inventory is `0.3` and does not advertise history tools.

The timeout finding is a design input for the new phase, not evidence of a separate production defect requiring an unrelated current-state Git rewrite.

## 3. Threat model

The attacker may control repository contents, local repository configuration, refs, commit metadata, paths, object graph shape, history depth, commit size, `.gitattributes`, and requested public Git-history inputs.

The design must prevent those inputs from causing:

- shell execution or arbitrary Git option injection;
- helper/hook/editor/pager/textconv/filter execution;
- repository mutation, index/ref/worktree mutation, or automatic object acquisition;
- credential access or network transport;
- access outside the retained READY workspace root;
- host absolute path leakage;
- unbounded history traversal, patch generation, stdout/stderr growth, or runtime;
- ambiguous revision parsing that changes Git command meaning;
- exposing machine-local reflog or unrelated operational history.

The design does not attempt to make malicious commit text trustworthy. Commit messages, names, and paths are untrusted data and must remain data only.

## 4. Approaches considered

### 4.1 Recommended: typed Rust history operations over the existing hardened Git runner

Extend the Rust Git module with typed history requests and parsers while reusing the existing trusted executable resolution, Bubblewrap launch specification, retained root FD, execution registry, filter/helper hardening, audit flow, and bounded capture infrastructure.

TypeScript receives already constrained runtime methods and never receives a raw Git argument surface.

**Why chosen:** this preserves the existing security authority and makes every new Git invocation reviewable as a fixed command template.

### 4.2 Rejected: TypeScript composes Git argv and invokes a generic process adapter

This would make public/capability TypeScript responsible for Git grammar and would couple read-only Git to the workspace process policy. It would also create a reusable route toward arbitrary Git execution.

**Rejected because:** authority would move away from the hardened Rust Git boundary.

### 4.3 Rejected: new libgit2/JGit-style history subsystem

A library implementation could avoid a Git subprocess, but it would introduce a new object/parser/security subsystem, new dependency and compatibility burden, and a second repository access path beside the already-hardened one.

**Rejected because:** there is no evidence that the existing fixed-command Git path is inadequate.

## 5. Proposed public tools

The MVP adds exactly four read-only tools:

1. `git.log`
2. `git.show`
3. `git.range`
4. `git.diffHistory`

The existing `git.status`, `git.diff`, and `git.changes` contracts remain unchanged. `git.diffHistory` is deliberately separate from `git.diff` so working-tree diff semantics are not overloaded.

Deferred from the MVP:

- `git.blame`;
- reflog inspection;
- remote refs and remote APIs;
- submodule history traversal;
- rename/copy detection;
- arbitrary object/blob reads;
- arbitrary revision expressions;
- generic pagination cursors.

### 5.1 `git.log`

Input:

```ts
{
  workspaceId: string;
  revision?: GitRevision; // default {kind:"head"}
  path?: string;
  limit?: number;         // default 20, hard max 100
}
```

Output:

```ts
{
  schemaVersion: 1;
  workspaceId: string;
  resolvedRevision: GitResolvedRevision;
  commits: GitCommitSummary[];
  returnedCount: number;
  truncated: boolean;
  truncationReasons: GitHistoryTruncationReason[];
}
```

Each `GitCommitSummary` contains only:

- full `oid`;
- derived display-only `shortOid` (first 12 hex characters; never accepted as input);
- full parent OIDs;
- `authorName`;
- author Unix time;
- committer Unix time;
- bounded subject.

Author email, decorations, body, signatures, and reflog metadata are omitted from `git.log` for data minimization and output stability.

No cursor is added in the MVP because the repository has no existing semantic cursor convention. A bounded call is intentionally finite. Future pagination, if justified, must use an opaque/typed contract rather than raw revision syntax.

### 5.2 `git.show`

Input:

```ts
{
  workspaceId: string;
  revision?: GitRevision; // default HEAD
  path?: string;
  includePatch?: boolean; // default false
  maxPatchBytes?: number; // default 64 KiB, hard max 256 KiB
}
```

Output includes:

- canonical resolved commit OID;
- parents;
- bounded author name/times;
- bounded subject and body;
- changed paths and fixed status classification;
- bounded stat summary;
- optional bounded patch;
- explicit truncation metadata.

Rename/copy detection is disabled. A rename therefore appears as deletion/addition in the MVP.

### 5.3 `git.range`

Input:

```ts
{
  workspaceId: string;
  baseRevision: GitRevision;
  headRevision: GitRevision;
  mode?: "direct" | "symmetric"; // default direct
  limit?: number;                 // default 50, hard max 100
}
```

Output includes:

- canonical base/head commit OIDs;
- `isAncestor` for base -> head;
- merge-base OID when one exists;
- bounded commits for the requested range;
- bounded ahead/behind counts represented with exactness metadata;
- explicit truncation metadata.

`direct` represents commits reachable from head but not base. `symmetric` represents commits unique to either side and includes a `side` discriminator on returned commits.

Ahead/behind counting is capped at 10,000 per side. Results use `{value, exact}` rather than claiming an unbounded exact count.

### 5.4 `git.diffHistory`

Input:

```ts
{
  workspaceId: string;
  baseRevision: GitRevision;
  headRevision: GitRevision;
  path?: string;
  maxPatchBytes?: number; // default 64 KiB, hard max 256 KiB
}
```

Output includes:

- canonical base/head OIDs;
- changed paths;
- stat summary;
- bounded textual patch;
- explicit truncation metadata.

It never compares against the index/worktree and never mutates them.

## 6. Revision grammar and resolution

Raw revision strings are not accepted.

The public revision type is a closed union:

```ts
type GitRevision =
  | { kind: "head" }
  | { kind: "oid"; oid: string }
  | { kind: "branch"; name: string }
  | { kind: "tag"; name: string };
```

### 6.1 Full object IDs only

`kind:"oid"` accepts only lowercase full hexadecimal object IDs of exactly 40 or 64 characters. Abbreviated IDs are deliberately excluded from the MVP.

Consequences:

- no ambiguity lookup is needed;
- `REVISION_AMBIGUOUS` is reserved for a possible future abbreviated-ID feature but is unreachable in the MVP;
- `shortOid` is presentation only.

### 6.2 Safe local branch/tag subset

Branch/tag names are accepted only when every `/`-separated component:

- is non-empty;
- begins with ASCII alphanumeric;
- otherwise contains only ASCII alphanumeric, `.`, `_`, or `-`;
- does not end in `.lock`;
- does not end in `.`.

The complete name is at most 128 bytes and may not contain `..`, `@{`, `//`, control characters, NUL, or a leading/trailing slash.

Rust constructs the complete ref name itself:

- `refs/heads/<validated-name>`;
- `refs/tags/<validated-name>`.

Remote refs are not accepted.

### 6.3 Explicitly unsupported Git revision syntax

The public schema cannot express:

- `--all`, `--glob`, or any `--*` option;
- `HEAD~3`, `HEAD^`, or arbitrary ancestry suffixes;
- `@{...}` selectors;
- `:/regex` or other commit-message search syntax;
- revision/pathspec combinations;
- reflog selectors;
- raw `A..B` or `A...B` strings.

Range and ancestry are represented by structured `baseRevision`, `headRevision`, and `mode` fields instead.

### 6.4 Canonical commit resolution

Rust resolves a validated revision to one canonical full commit OID using fixed Git command templates. Safety does not depend on caller-provided Git parsing: the candidate is always exactly `HEAD`, a full hex OID, or a Rust-constructed full local ref, and the resolver uses `rev-parse --verify --end-of-options`.

Resolution is two-step so missing objects and unsupported object types remain distinguishable:

1. verify `<candidate>^{object}`; failure means the object/ref is not locally available;
2. verify `<candidate>^{commit}`; failure after step 1 means the object cannot peel to a commit.

Both successful forms must return exactly one complete lowercase 40- or 64-hex OID and no extra record.

Resolution distinguishes:

- invalid public grammar -> `REVISION_INVALID`;
- locally missing ref/object -> `REVISION_NOT_FOUND`;
- existing object that cannot peel to a commit -> `OBJECT_TYPE_UNSUPPORTED`.

No resolver fetches or contacts a remote.

## 7. Path security

Optional history paths are repository-relative logical paths, not host filesystem paths.

Validation requires:

- UTF-8 byte length 1..4096;
- no leading `/`;
- no ASCII C0 control byte (`0x00..0x1f`) or DEL (`0x7f`);
- no empty, `.` or `..` path component;
- no pathspec-magic prefix such as `:`.

Every Git command that accepts a path also uses fixed `--literal-pathspecs` and a fixed `--` separator before the validated path.

Historical path selection must not canonicalize through worktree symlinks or turn a repository-relative path into a host path. Parsed paths returned by Git are checked again before public serialization and remain repository-relative.

The sandbox mount set is not broadened to follow linked worktree metadata or an external gitdir. If required repository objects are not reachable inside the existing read-only retained-root sandbox, the request fails locally instead of mounting additional host locations.

## 8. Hardened Git process path

History operations must use the existing primitives:

- `resolve_trusted_executable("git")`;
- `BubblewrapProvider`;
- `hardened_git_spec` / `base_git_args`;
- READY retained root FD;
- `ExecutionKind::Git` registry;
- helper/filter neutralization;
- network deny;
- read-only workspace mount;
- clean environment;
- raw spool where useful.

History commands additionally set `GIT_NO_LAZY_FETCH=1` so a partial/promisor repository cannot turn a missing local object into an implicit remote-object acquisition attempt. The sandbox network denial remains the outer fail-closed boundary.

No production `Command::new("git")`, shell, `process.run`, PATH lookup, or public argv array is added.

### 8.1 Shared bounded command runner

Refactor the internal Git capture implementation so the same hardened spawn path can accept an internal command budget:

```text
wallTimeout
stdoutSourceBytes
stderrSourceBytes
previewBytes
overflowPolicy
```

Existing `git.status`/`git.diff` behavior must remain semantically unchanged. History operations use stricter command-specific budgets.

### 8.2 Timeout

Every history Git subprocess has a fixed 5-second wall-clock deadline. The deadline is not caller-configurable in the MVP.

On deadline:

- terminate the whole sandbox Git process group, not only the leader;
- drain/reap deterministically;
- remove the execution registry record;
- record failed audit outcome;
- return `PROCESS_TIMEOUT` without raw stderr.

Tests may inject a shorter internal timeout under test-only configuration. No test-only timeout control is exposed through MCP/runtime production schemas.

### 8.3 Source byte limits

The 64 MiB global raw-spool cap is only a final storage ceiling; history commands use much lower logical caps and terminate when a command-specific cap is reached.

Initial internal caps:

- revision resolution output: 8 KiB;
- bounded OID walk output: 32 KiB;
- single commit-object metadata input: 64 KiB before fail/controlled message truncation;
- changed-path/stat stream: 512 KiB;
- public patch source: requested maximum plus one bounded detection chunk, never more than 272 KiB for the 256 KiB public maximum;
- stderr diagnostic capture: 16 KiB, never directly exposed publicly.

Structured parsers accept only complete records. An incomplete security-critical record caused by a hard source cap returns `OUTPUT_LIMIT_EXCEEDED`; optional lists/patches may return successful explicit truncation only when complete preceding records are safe to return.

## 9. Git command templates

All Git argv sequences are Rust-owned fixed templates. User data never selects a flag or subcommand.

Each top-level history request first runs a fixed repository preflight:

```text
git <fixed-config> rev-parse --git-dir
```

Only the exit status is relevant; its path output is discarded inside the runtime and never serialized. Failure is classified as `NOT_A_GIT_REPOSITORY`. This preflight lets later revision-resolution failures be classified without conflating a missing revision with a non-repository workspace.

Representative templates after repository preflight and revision resolution:

### Commit walk

```text
git <fixed-config> --literal-pathspecs rev-list --topo-order --max-count=<validated-limit+1> <full-oid> [-- <validated-path>]
```

### Commit object

```text
git <fixed-config> cat-file commit <full-oid>
```

Rust parses the commit object and does not expose raw object bytes. This avoids delimiter injection from commit messages and keeps the public encoding contract under KodeGPT control.

### Changed paths

```text
git <fixed-config> --literal-pathspecs diff-tree --root --no-commit-id -r --name-status -z --no-renames <full-oid> [-- <validated-path>]
```

### Stats

```text
git <fixed-config> --literal-pathspecs diff-tree --root --no-commit-id -r --numstat -z --no-renames <full-oid> [-- <validated-path>]
```

### Commit patch

```text
git <fixed-config> --literal-pathspecs show --format= --no-ext-diff --no-textconv --no-renames --ignore-submodules=all <full-oid> [-- <validated-path>]
```

### Ancestry / merge base

```text
git <fixed-config> merge-base --is-ancestor <base-full-oid> <head-full-oid>
git <fixed-config> merge-base <base-full-oid> <head-full-oid>
```

### Historical diff

```text
git <fixed-config> --literal-pathspecs diff --no-ext-diff --no-textconv --no-renames --ignore-submodules=all <base-full-oid> <head-full-oid> [-- <validated-path>]
```

Internal range expressions such as `<base-full-oid>..<head-full-oid>` are constructed only from already-resolved full hex OIDs. They are never accepted as public strings.

No template uses `--binary`, rename detection, submodule traversal, remote operations, external helpers, or mutation.

## 10. Output contract and bounds

All history results use `schemaVersion: 1` and structured MCP output.

### 10.1 Fixed limits

```text
git.log default commits                 20
git.log hard max commits               100
git.range default returned commits      50
git.range hard max returned commits    100
ahead/behind traversal cap          10,000 per side
changed paths hard max                 500
commit subject max UTF-8 bytes         512
commit body max UTF-8 bytes         16 KiB
author name max UTF-8 bytes            256
single path max UTF-8 bytes          4 KiB
patch default bytes                  64 KiB
patch hard max bytes                256 KiB
serialized public history response  512 KiB hard budget
Git history wall timeout                 5 s
```

The capability assembly layer enforces the 512 KiB public budget. Optional content is consumed in deterministic priority order: fixed metadata, commit summaries/changed-path records, body, then patch. When optional content cannot fit, it is omitted/truncated with an explicit reason rather than silently overflowing the response.

### 10.2 Truncation metadata

Use a stable union such as:

```ts
type GitHistoryTruncationReason =
  | "COMMIT_LIMIT"
  | "COUNT_LIMIT"
  | "PATH_LIMIT"
  | "MESSAGE_LIMIT"
  | "PATCH_LIMIT"
  | "RESPONSE_LIMIT";
```

Every result with bounded optional/list content includes:

- `truncated: boolean`;
- `truncationReasons: GitHistoryTruncationReason[]`;
- `returnedCount` where a commit list is returned.

`truncated` must be exactly equivalent to `truncationReasons.length > 0`.

Do not report an `availableCount` unless it is obtained within an already-required bounded traversal. Do not launch a second unbounded count solely to populate metadata.

### 10.3 Commit metadata and privacy

`authorEmail` is not part of the MVP. `authorName` is sufficient for the normal “who authored this commit?” use case and avoids adding unnecessary identity data.

Decorations are omitted because they can expose machine-local ref layout and are not needed for commit identity.

Commit text is converted to bounded UTF-8 data. If commit-object bytes cannot be represented exactly as UTF-8, use deterministic lossy conversion and expose `encodingLossy: true`; never fail open into raw bytes or terminal control interpretation.

## 11. Error model

Add stable public capability errors:

```text
WORKSPACE_NOT_READY
GIT_UNAVAILABLE
NOT_A_GIT_REPOSITORY
REVISION_INVALID
REVISION_NOT_FOUND
OBJECT_TYPE_UNSUPPORTED
PATH_INVALID
OUTPUT_LIMIT_EXCEEDED
PROCESS_TIMEOUT
GIT_READ_FAILED
```

Reserve but do not emit in the MVP:

```text
REVISION_AMBIGUOUS
```

Rules:

- grammar validation errors are classified before spawning Git where possible;
- missing local objects/refs never trigger network resolution;
- raw Git stderr and host paths are never returned through public MCP errors;
- runtime errors are mapped through `WorkspaceManager` and the capability layer into the stable public codes;
- unexpected internal failures become a generic stable error, not a raw exception containing command lines or paths.

## 12. Audit semantics

Existing Git reads are decision/outcome audited. Historical reads follow the same model.

Add specific Rust audit actions:

```text
GitHistoryList     -> git_history_list
GitCommitInspect   -> git_commit_inspect
GitHistoryRange    -> git_history_range
GitHistoryDiff     -> git_history_diff
```

For each top-level history request:

1. validate the public/runtime request shape;
2. write durable allow decision (`RequestValidated`);
3. duplicate the READY retained root FD;
4. execute all bounded Git subcommands for that top-level request;
5. write one success/failed outcome.

Artifact spool creation/read retains its existing independent audit actions.

Do not write revision names, commit messages, author names, paths, command lines, or stderr into the security audit record. The action and sanitized request/operation/capability IDs are sufficient.

## 13. Performance and DoS behavior

History is treated as adversarially expensive.

MVP rules:

- every walk uses `--max-count` with a hard validated numeric cap;
- limit+1 is used only to determine `COMMIT_LIMIT` without an unbounded count;
- ahead and behind are counted independently with fixed `rev-list --count --max-count=10001 <resolved-range>` walks; a result of 10,001 is exposed as `{value:10000, exact:false}`, otherwise the returned count is exact;
- rename/copy detection is disabled;
- binary patch payloads are not requested (`--binary` is forbidden);
- textconv/external diff remain disabled;
- submodules are ignored;
- no full blob API is introduced;
- command source bytes and response bytes are independently bounded;
- each subprocess has a fixed timeout;
- timeout/source overflow kills the complete process group and reaps it.

The implementation should resolve provider/program once per top-level operation and reuse the fixed hardened runner for its subcommands. It must not run the repository filter-configuration probe redundantly for every inspected commit.

## 14. Local-only network/remote boundary

Historical intelligence only inspects objects already present in the local repository reachable inside the retained-root sandbox.

Forbidden commands/behaviors include:

- `fetch`, `pull`, `push`, `ls-remote`;
- SSH/HTTPS/file transport;
- credential prompting/helpers;
- remote API fallback;
- automatic missing-object retrieval;
- partial-clone lazy object fetching.

`GIT_TERMINAL_PROMPT=0`, `credential.helper=`, `protocol.file.allow=never`, and sandbox network denial remain in effect.

If an object is not locally available, return `REVISION_NOT_FOUND` or `GIT_READ_FAILED` as appropriate. Do not fetch it.

## 15. MCP semantic surface/version decision

The external MCP protocol version remains:

```text
2026-07-28
```

The KodeGPT runtime version remains:

```text
0.1
```

The semantic MCP surface advances **once for this coherent new public capability phase**:

```text
0.3 -> 0.4
```

Evidence for the decision:

- project history treats advertised public capability inventory as a semantic surface contract;
- the first Phase 1 capability generation advanced the semantic surface once and later tools in that same generation reused it;
- the skill inventory generation later advanced the shipped surface to `0.3` without changing MCP protocol;
- this phase adds four new advertised action schemas and requires a fresh ChatGPT action inventory/schema refresh.

Therefore retaining `0.3` would make a materially different public inventory indistinguishable from the post-PR #8 baseline. This is a semantic-surface generation bump, not an MCP protocol break or runtime-version change.

Required surface updates include:

- `packages/mcp-server/src/surface-version.ts` -> `0.4`;
- locked `SURFACE_TOOLS` inventory;
- `tests/fixtures/mcp-surface.ts`;
- protocol/transport/host compatibility snapshots that intentionally pin the semantic surface.

## 16. Internal component design

### 16.1 Rust runtime

Extend `crates/runtime/src/git.rs` with:

- validated internal revision/ref/path types;
- canonical revision resolver;
- bounded command budget and timeout support sharing the existing hardened launch spec;
- commit-object parser;
- NUL-delimited changed-path/stat parsers;
- structured log/show/range/history-diff result types;
- fixed command builders per operation.

Add dedicated typed request structs/enums to `crates/protocol/src/types.rs` with `deny_unknown_fields`. No request contains `argv` or a raw revision expression.

Add dispatcher methods and specific audit actions.

### 16.2 Core workspace manager

Add validated methods such as:

- `gitLog`;
- `gitShow`;
- `gitRange`;
- `gitDiffHistory`.

Each method:

- calls `#requireReadyState(workspaceId)`;
- sends only the private `capabilityId` plus typed structured input;
- validates the complete runtime response;
- rejects private IDs/PIDs/host paths in results;
- maps runtime error messages to stable workspace error codes.

### 16.3 Native capability layer

Add a `GitHistoryAdapter` to `packages/capabilities/src/adapters.ts` and history contracts/schemas to `contracts.ts`.

Implement a focused Git history capability service/module that:

- validates public numeric/text bounds again at the TypeScript boundary;
- maps workspace/runtime errors to stable `CapabilityError` codes;
- enforces public response-budget/truncation invariants;
- contains no Git command construction.

Extend `NativeCapabilityService` and production CLI wiring with these four methods.

### 16.4 MCP adapter

Add four tools to `GitToolContext` and `registerKodegptTools` using explicit Zod input/output schemas and `READ_ONLY_TOOL_ANNOTATIONS`.

No new public host paths, capability IDs, process IDs, command arrays, network settings, or mutation flags are introduced.

## 17. Tests and acceptance strategy

All behavior changes follow RED -> minimal GREEN -> focused refactor/verification.

### 17.1 Rust security/unit tests

Required RED-first tests cover:

- valid/invalid revision union parsing;
- rejection of `--all`, `--glob`, `HEAD~3`, `HEAD^`, `@{}`, `:/...`, ref traversal/structural edge cases, and abbreviated OIDs;
- full SHA-1 and SHA-256 OID grammar;
- branch/tag construction only under `refs/heads/` and `refs/tags/`;
- missing revision and non-commit object classification;
- raw option confusion and fixed `--` path separator;
- `--literal-pathspecs` for all path-taking commands;
- absolute/parent/magic paths rejected;
- weird valid UTF-8 repository paths survive NUL parsing without host-path conversion;
- deterministic bounded commit order;
- limit+1 truncation behavior;
- long subject/body truncation;
- changed-path count cap;
- binary diff does not return binary payload;
- patch cap produces explicit truncation;
- timeout kills/reaps the Git process group and removes execution registry state;
- helper/hook/pager/editor/textconv/filter execution remains impossible;
- PATH hijacking cannot choose Git;
- network remains denied;
- repository fingerprint before/after all history operations is identical.

### 17.2 Protocol/core/capability tests

Required RED-first tests cover:

- `deny_unknown_fields` on every new runtime request;
- no argv/raw revision fields in runtime schemas;
- WorkspaceManager READY requirement and private capability translation;
- strict runtime result validation;
- stable public error mapping without stderr/host paths;
- response/truncation invariant (`truncated === reasons.length > 0`);
- public output schema rejects private process/capability/artifact implementation fields;
- no semantic cursor accidentally introduced.

### 17.3 MCP/integration/security tests

Required tests cover:

- exact four-tool addition to the locked surface;
- semantic surface `0.4`, protocol still `2026-07-28`, runtime still `0.1`;
- read-only annotations on every history tool;
- known repository log/show/range/history-diff fixtures;
- invalid revision stable error;
- truncation case;
- untrusted/not-READY workspace rejection;
- repository unchanged after all operations;
- no provider, `skill.run`, generic shell, raw Git, Git mutation, network Git, service lifecycle, or workspace-trust MCP tools appear.

Expand the current helper-isolation coverage or add a focused `tests/security/git-history-isolation.test.ts`; do not weaken the existing `git.status`/`git.diff` regression.

### 17.4 Host acceptance

After deterministic gates and exact-candidate deployment, perform only bounded fresh ChatGPT acceptance:

- action inventory contains the four new read-only tools;
- schemas contain structured revisions rather than raw argv/revision expressions;
- open a known trusted workspace;
- `git.log(limit=5)`;
- `git.show` on a known full OID;
- positive and negative ancestry/range checks;
- bounded historical diff;
- one truncation case;
- one invalid revision case;
- existing `git.status`, `git.diff`, `git.changes`, health, and capabilities remain otherwise correct;
- semantic surface reports `0.4`;
- no provider/mutation/generic-shell tools appear.

Do not repeat unrelated full host acceptance without a defect signal.

## 18. Compatibility and migration

This is additive at the tool-contract level and requires no repository/state data migration.

Compatibility rules:

- existing tools keep their names and schemas;
- historical tools are new and read-only;
- runtime state schema remains unchanged;
- historical tag `v0.1` is untouched;
- stable installed-service lifecycle remains unchanged;
- installed service is only cut over after normal exact-candidate packaging/deployment gates later in the phase;
- clients that cache action schemas require refresh because semantic surface becomes `0.4`.

## 19. Explicit non-goals

This phase does not implement or expose:

- arbitrary `git <args...>`;
- shell execution through Git;
- Git mutation of any kind;
- network or remote Git;
- fetch-on-missing-object;
- local reflog;
- remote ref enumeration;
- blame;
- rename/copy heuristics;
- submodule history;
- blob/content checkout;
- worktree/index/ref mutation;
- provider interoperability or provider-agent execution;
- workspace trust mutation over MCP;
- service lifecycle mutation over MCP;
- desktop/computer use.

## 20. Alternatives rejected and future extensions

### Abbreviated OIDs

Deferred. Supporting them would require explicit ambiguity handling and additional resolution semantics while adding little value because every result already returns a full canonical OID.

### Relative ancestry syntax (`HEAD~N`, `^`)

Deferred. Structured range inputs cover the important use cases without exposing Git revision-expression grammar.

### Cursor pagination

Deferred until a broader capability pagination convention exists. Hard bounded result sets are simpler and safer for the MVP.

### `git.blame`

Deferred until a concrete use case justifies line-range grammar, author/privacy handling, and potentially expensive traversal.

### Reflog

Explicitly deferred because reflog is machine-local operational history rather than ordinary repository history and can expose local activity not represented by shared commits.

## 21. Design acceptance criteria

The design is ready for implementation planning when all of the following are explicit:

- Rust remains final Git/process/security authority;
- the existing hardened Git path is reused;
- no public raw Git argument or arbitrary revision syntax exists;
- the revision union and strict branch/tag grammar are fixed;
- full OIDs only are accepted in the MVP;
- pathspec magic and outside paths are rejected;
- repository data is local-only and sandbox-network-denied;
- command timeout and source/output byte limits are fixed;
- public response/truncation semantics are fixed;
- stable error and audit models are fixed;
- `git.blame`, reflog, remotes, rename detection, and pagination are deferred;
- `git.diffHistory` is distinct from current `git.diff`;
- semantic surface advances once from `0.3` to `0.4` with runtime/protocol unchanged;
- TDD/security/host acceptance expectations are defined;
- no production implementation has begun.
