# KodeGPT Bounded Linked-Worktree Lifecycle Design

Date: 2026-08-19
Status: design-only follow-up; no implementation in this reconciliation branch
Baseline: `main == origin/main == 75d341aec8c6a4f71cb2fe79d216eaba264e6dbb`
Current contract: `runtime 0.1 / protocol 2026-07-28 / surface 0.14 / 76 tools`
Candidate implementation target if separately approved: `runtime 0.1 / protocol 2026-07-28 / surface 0.15 / 78 tools`

## Problem

Existing linked worktrees are already supported after Trusted Linked-Worktree Git Metadata: typed Git, trusted process execution, verification, context building, source edits, and cancellation work when KodeGPT opens an already-correct linked worktree.

The remaining gap is creation lifecycle. Live dogfood on Git 2.43 showed that `git worktree add` executed inside KodeGPT's normal `/workspace` Bubblewrap view can persist `/workspace/...` into Git's linked-worktree administrative files. Those links are correct only inside that sandbox spelling and require host-side `git worktree repair <real-path>` before ordinary host/KodeGPT linked-worktree use is reliable.

This is not a reason to add a worktree scheduler or agent runtime. It is a narrow path-identity mismatch between one fixed Git lifecycle operation and KodeGPT's deliberate retained-root alias `/workspace`.

## Goal

Provide deterministic create/remove lifecycle for linked worktrees stored beneath the owning repository's fixed `.worktrees/` directory while preserving all existing authority boundaries:

- no arbitrary destination path;
- no host HOME mount;
- no canonical-repository visibility for generic `process.run`;
- no hidden rewriting after arbitrary shell commands;
- no autonomous task/agent/worktree scheduler;
- no force removal;
- no branch reset or force branch creation;
- no automatic trust/open/close of the new worktree;
- Rust remains final filesystem/process authority.

## Evidence and rejected shortcuts

### Hidden post-process repair for trusted shell — rejected

KodeGPT cannot safely infer that an arbitrary nested `bash`/`sh` command performed `git worktree add`. Scanning or rewriting Git metadata after every trusted process would create hidden mutation semantics and make an ordinary process capability unexpectedly responsible for repository lifecycle.

### Expose the canonical host path to every trusted process — rejected

Binding the retained source root at its host-visible canonical path for all trusted shell execution would make the old dogfood command work, but it would weaken the existing canonical-source isolation invariant for a broad class of user-controlled commands. The linked-worktree gap does not justify that expansion.

### Depend on newer Git `--relative-paths` behavior — rejected as the v1 requirement

The current acceptance host runs Git 2.43.0 and its `git worktree add -h` does not expose `--relative-paths`. Current upstream Git documents relative-path worktree linking, but making a newer host Git version a prerequisite would turn this lifecycle fix into a toolchain migration and would not address existing installations. KodeGPT should solve the current bounded operation without changing the project-wide Git floor.

### Explicit typed lifecycle — selected

A fixed typed operation can temporarily expose one additional alias of the *same retained workspace FD* only to a fixed hardened Git worktree command. Git then sees the real canonical repository spelling while creating/removing the worktree, so it writes ordinary host-valid absolute administrative links from the start. Generic process execution never receives this alias.

## Candidate public surface

If implementation is separately approved, add exactly two semantic MCP tools:

- `git.worktreeCreate({ workspaceId, name, branch })`
- `git.worktreeRemove({ workspaceId, name })`

Do not add `git.worktreeList`, `git.worktreeInspect`, `git.worktreeMove`, `git.worktreeRepair`, `git.worktreePrune`, `git.worktreeLock`, or `git.worktreeUnlock` in v1.

The two new names would advance the semantic surface from `0.14 / 76` to `0.15 / 78`. This design document itself does not change the current surface.

## Input contract

### `name`

`name` identifies only a directory immediately beneath `.worktrees/`.

Recommended grammar:

- 1..64 ASCII characters;
- first character `[A-Za-z0-9]`;
- remaining characters `[A-Za-z0-9._-]`;
- reject `.` and `..`;
- reject path separators, whitespace, control bytes, percent/path encoding tricks, leading dash, and normalization-dependent spellings.

The destination is always derived internally as `.worktrees/<name>`. The caller cannot supply an absolute path, relative traversal, sibling repository path, or arbitrary directory.

### `branch`

`branch` must be one existing validated local branch. Worktree creation does not create/reset a branch and does not accept an arbitrary revision expression.

The intended host flow is:

1. `git.branchCreate` when a new branch is needed;
2. `git.worktreeCreate` for that already-existing branch.

This keeps branch lifecycle separate and prevents one operation from combining branch reset/creation with filesystem lifecycle.

## Architecture

### 1. Existing retained root remains the source authority

The owning workspace must be READY, writable, and `trusted`. Creation/removal require the existing Git write authority. No new workspace trust is created.

The target must resolve beneath the same retained workspace root as `.worktrees/<name>`. Symlinked `.worktrees`, symlinked target components, mount/topology identity changes, or pre-existing unexpected filesystem objects fail closed.

### 2. Rust exposes a private canonical alias only for the fixed worktree command

`WorkspaceRegistry` already retains both the root FD and an internal canonical display path for the workspace. The sandbox layer may gain a private option used only by the typed worktree lifecycle operation:

- bind the existing retained workspace root FD at normal `/workspace` as today;
- additionally bind the exact same FD at the workspace's canonical display path inside the Bubblewrap namespace;
- create only the empty parent directories needed to reach that alias;
- do not bind the real host parent directories, HOME contents, or any neighboring path;
- never expose this option through `process.run`, `verify.run`, preview/browser execution, or caller-supplied sandbox fields.

This is an alias of already-admitted source authority, not a second filesystem root.

### 3. Creation uses fixed Git semantics

After validation, Rust invokes hardened Git with write-capable linked metadata admission and the private canonical alias enabled.

Conceptually the command is equivalent to:

`git worktree add <canonical-root>/.worktrees/<name> refs/heads/<branch>`

The exact argv remains runtime-owned. No `-B`, `--force`, arbitrary checkout option, arbitrary config, arbitrary path, or caller-provided Git argv is admitted.

Git itself continues to enforce that the branch is not already checked out elsewhere. KodeGPT normalizes expected failures into stable capability errors rather than retrying with force.

### 4. Creation result is revalidated before success

A zero Git exit is necessary but not sufficient. Before returning success, Rust must verify:

- `.worktrees/<name>` exists as the expected directory beneath the retained root;
- its `.git` is a bounded regular pointer file;
- the pointed private admin directory is beneath the owning repository's exact `.git/worktrees/` directory;
- `commondir` is exactly the accepted `../..` form;
- the reciprocal `gitdir` backlink resolves exactly to the created `.worktrees/<name>/.git` host path;
- no symlink or unexpected mount/path identity was substituted;
- the checked-out branch is exactly the requested local branch;
- the worktree HEAD is a full object ID and is returned only as ordinary Git identity evidence.

If Git exits zero but this validation fails, return a dedicated inconsistent-state error. Do not silently rewrite unknown metadata and do not blind-clean with force.

### 5. Removal is clean-only and fixed-path

`git.worktreeRemove` resolves only the same `.worktrees/<name>` target and first validates its reciprocal linked-worktree metadata.

The fixed Git removal command runs with the same private canonical alias so the host-valid absolute links remain reachable inside the sandbox. No `--force` is passed. Dirty, locked, missing, mismatched, or foreign worktrees fail closed.

Removal deletes the linked worktree and its Git administrative entry but does not delete the branch. Branch cleanup remains an explicit later `git.branchDelete` after merge/reconciliation.

### 6. No automatic workspace switching

Creation does not automatically open the child worktree and removal does not automatically close one. The reasoning host owns sequencing.

A host that wants to develop inside the child should:

1. create the branch and worktree;
2. close any active overlapping parent workspace if required by current workspace overlap rules;
3. explicitly trust/open the exact new worktree path using the existing workspace control plane;
4. perform ordinary KodeGPT development;
5. close the child before removal;
6. reopen the parent and invoke typed removal.

No task registry, worker registry, scheduler, session database, or delegated agent is introduced.

## Result contract

`git.worktreeCreate` should return only bounded repository-relative evidence, for example:

- `name`;
- `relativePath: ".worktrees/<name>"`;
- `branch`;
- `headOid`.

`git.worktreeRemove` should return:

- `name`;
- `relativePath`;
- `removed: true`.

Do not return the canonical host root, `.git/worktrees/<admin-name>` host path, retained FD identity, mount path, or raw Git output.

## Failure contract

Candidate stable capability reasons should distinguish at least:

- invalid name/branch input;
- target already exists;
- branch missing;
- branch already checked out;
- worktree metadata invalid/foreign;
- worktree dirty;
- worktree locked;
- filesystem identity/topology changed;
- sandbox/canonical-alias unavailable;
- Git lifecycle command failed;
- Git reported success but postcondition validation failed.

No failure class authorizes an automatic force retry.

## Security invariants

Implementation must prove all of the following:

1. the canonical alias is available only to the fixed typed worktree lifecycle command;
2. ordinary trusted `process.run` still cannot observe the canonical source path alias;
3. the alias mounts only the already-retained workspace FD, never the real host parent directories;
4. caller input cannot influence the alias target or destination outside `.worktrees/<name>`;
5. branch input cannot become arbitrary Git revision grammar or argv injection;
6. create/remove cannot use force semantics;
7. source and Git metadata path identity are revalidated around mutation;
8. no public result/audit event leaks canonical host paths;
9. existing linked-worktree metadata admission remains fail-closed;
10. runtime/protocol changes are closed-schema and unknown fields are rejected.

## TDD and verification strategy

If implementation is approved, start with RED tests before production edits.

### Sandbox/Rust tests

- private canonical alias mounts the same retained FD at the exact validated canonical target;
- alias parents are empty sandbox directories rather than host parent mounts;
- alias target collision with sandbox-owned paths fails closed;
- generic process specs cannot request the alias;
- create writes host-valid reciprocal metadata on the current Git 2.43 acceptance boundary;
- child linked-worktree metadata can subsequently be admitted by the existing validator;
- remove succeeds for a clean created worktree without `--force`;
- dirty removal fails and preserves files/metadata;
- symlink/substitution/path-identity races fail closed;
- branch already checked out fails without force fallback;
- zero-exit-but-invalid postcondition is surfaced as inconsistent state.

### TypeScript/MCP tests

- exactly two tool names are added only if implementation is approved;
- schemas reject arbitrary paths, unknown fields, bad names, and hidden Git options;
- results contain relative path only;
- existing `git.branchCreate/Delete`, Git remote credential bridge, preview/browser, provider, and CI contracts remain unchanged;
- surface equality moves only from `0.14 / 76` to `0.15 / 78`.

### Acceptance dogfood

The phase is complete only if a real lifecycle succeeds end to end:

`git.branchCreate -> git.worktreeCreate -> child workspace development smoke -> child close -> parent reopen -> git.worktreeRemove -> git.branchDelete`

Acceptance must explicitly inspect the created `.git`/backlink relationship from the Rust security boundary and prove that no host-side `git worktree repair` is required.

## Non-goals

This phase does not add:

- parallel-agent execution;
- worktree-per-agent scheduling;
- task queues or background workers;
- automatic branch creation/reset;
- arbitrary worktree destinations;
- move/repair/prune/lock/unlock/list APIs;
- force remove;
- generic external mount authority;
- generic host-path aliasing for process execution;
- model/provider changes;
- deployment changes;
- CI monitoring changes.

## Delivery decision

This reconciliation branch closes Phase 6 and records this Phase 7 design only. Current production remains `0.14 / 76`.

Implementation should begin only as a separate reviewed phase. If approved, the smallest acceptable implementation is the two fixed lifecycle tools plus the private sandbox canonical-alias mechanism and postcondition validation described above; any request for scheduler/orchestration or arbitrary worktree paths requires a new design rather than expansion of this one.
