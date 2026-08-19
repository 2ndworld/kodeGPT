# KodeGPT Bounded Linked-Worktree Lifecycle Readiness

Date: 2026-08-19
Status: **CLOSED — merged, remote-CI verified, deployed, live-dogfooded, and implementation worktree cleaned**
Baseline: `ed5113f553b5d8beb24800165a07c01935165aa9` (merged PR #47)
Accepted feature head: `a119dc7fba63b4ded21cef0ac806d8d3ef6f1279`
Merge: PR #48 → `9082bfcd325d0b4428588c2608ad5be5b4459ff4`
Live contract: `runtime 0.1 / protocol 2026-07-28 / surface 0.15 / 78 tools`
Installed production: active `rel_0d1fe87d689de32e7afd466769d59db5`; rollback `rel_258b83f4f3932614cfca69c99d9b45ac`

## Scope

Phase 7 closes the linked-worktree creation lifecycle gap recorded by the 2026-08-18 trusted-worktree audit. Existing linked worktrees were already usable, but Git 2.43 invoked inside the ordinary `/workspace` sandbox view persisted sandbox-only paths during `git worktree add`, requiring host-side `git worktree repair`.

The implementation adds exactly two public semantic tools:

- `git.worktreeCreate({ workspaceId, name, branch })`
- `git.worktreeRemove({ workspaceId, name })`

The destination is always derived internally as `.worktrees/<name>`. Creation consumes one already-existing validated local branch. Removal is clean-only, never uses `--force`, and never deletes the branch.

No `git.worktreeList`, `git.worktreeInspect`, `git.worktreeMove`, `git.worktreeRepair`, `git.worktreePrune`, `git.worktreeLock`, or `git.worktreeUnlock` public tool is added. No scheduler, task queue, worktree-per-agent orchestration, arbitrary path authority, generic mount API, host HOME mount, provider change, deployment change, or CI-monitoring subsystem is introduced.

## Security architecture

Rust remains final filesystem/process authority. `WorkspaceRegistry::duplicate_ready_root` returns a cloned retained root FD together with the already-validated canonical display root only after the workspace is READY.

The sandbox has a private Rust-only `WorkspaceAlias::Canonical` mode. For the fixed typed worktree lifecycle command only, Bubblewrap binds the same retained workspace FD at both `/workspace` and the validated canonical display path. Parent path components are sandbox-created empty directories; neighboring host directories are not mounted. Reserved/unclean alias targets such as `/workspace`, `/proc`, `/dev`, `/run`, `/tmp`, and `/home/kodegpt` fail closed.

Generic `process.run`, `verify.run`, preview/browser execution, and caller-defined public schemas cannot request this alias. Full-stack acceptance explicitly proves trusted `process.run` still cannot observe the repository at its host canonical path.

## Runtime lifecycle

The private Node-to-Rust protocol adds the closed method `git.worktree_mutation` with only `create` and `remove` variants. Canonical JSON Schema, TypeScript runtime validation, Rust serde types, and framing fixtures agree on the same closed shape.

Create validates the worktree-name grammar and existing local branch, derives `.worktrees/<name>`, rejects an existing target and branch already checked out, and runs a fixed Git worktree-add command through the canonical alias. A zero Git exit is not sufficient: Rust reopens the child beneath the retained root, validates the linked-worktree `.git` pointer, private admin directory, exact `commondir`, reciprocal backlink, requested branch, and full HEAD OID before returning success.

Remove first validates the child linked-worktree metadata, refuses locked or dirty worktrees, then runs fixed non-force `git worktree remove` through the same private alias. Success requires both the child path and private Git admin entry to be gone. The branch is preserved for a separate explicit `git.branchDelete`.

## Public result boundary

Create returns only:

- `schemaVersion: 1`
- `operation: "create"`
- `name`
- `relativePath: ".worktrees/<name>"`
- `branch`
- `headOid`

Remove returns only:

- `schemaVersion: 1`
- `operation: "remove"`
- `name`
- `relativePath: ".worktrees/<name>"`
- `removed: true`

Structured-result tests reject extra fields such as `canonicalPath`. No canonical source path, retained FD, private `.git/worktrees/<admin>` path, raw Git argv, or raw Git output is part of either public result.

## TDD and focused evidence

Implementation was split into small reviewed commits:

- `4657cae` — implementation plan
- `082f278` — bounded canonical workspace alias
- `26e774b` — Rust worktree lifecycle authority
- `92ab59a` — typed core/capability surface
- `6ba10b5` — MCP tools and `0.15 / 78` source surface
- `26d004a` — full-stack lifecycle/security acceptance

Focused RED/GREEN evidence included:

- workspace-registry retained canonical identity;
- sandbox canonical alias construction/rejection;
- private protocol closed variants;
- bounded worktree name grammar;
- Git 2.43 create metadata without `/workspace/`;
- clean-only remove plus dirty/locked rejection;
- core private-RPC payload/result validation;
- capability strict input/result schemas;
- MCP surface equality and structured-result host-path rejection;
- TypeScript/Rust framing and canonical JSON-schema parity.

A full-stack acceptance test reproduces the production composition and completes:

`git.branchCreate -> git.worktreeCreate -> child trust/open -> git.status -> file edit -> git.diff -> child close -> parent reopen -> git.worktreeRemove -> git.branchDelete`

The same acceptance proves:

- generic trusted `process.run` cannot see the canonical repository alias;
- invalid worktree names are rejected at the MCP input boundary;
- missing branches fail with `GIT_WORKTREE_BRANCH_MISSING`;
- an already-checked-out branch fails with `GIT_WORKTREE_BRANCH_IN_USE`;
- pre-existing targets fail with `GIT_WORKTREE_TARGET_EXISTS`;
- dirty removal fails with `GIT_WORKTREE_DIRTY` and preserves the child;
- locked removal fails with `GIT_WORKTREE_LOCKED` and preserves the child;
- successful create writes neither `.git` pointer nor reciprocal backlink with `/workspace/`;
- no `git worktree repair` is invoked anywhere in the happy path.

During full-stack development, an initial disposable repository under `/tmp` failed with `GIT_WORKTREE_UNAVAILABLE`. Systematic debugging showed this was the intended sandbox rule rejecting canonical aliases below sandbox-owned `/tmp`, not a lifecycle defect. The acceptance fixture was moved to a non-reserved canonical test root; production alias policy was not weakened.

## Deterministic verification

Fresh verification on the Phase 7 candidate passed:

- `cargo fmt --all -- --check` — PASS
- `cargo check --workspace` — PASS
- `cargo test --workspace` — PASS
  - protocol contract: 18 passed
  - runtime: 99 passed / 3 intentional ignores
  - sandbox: 27 passed / 4 intentional ignores
  - workspace-io: 47 passed
- `pnpm run typecheck` — PASS across all 14 participating packages
- `pnpm run build` — PASS
- `pnpm run test` — 129 files passed / 1 file intentionally skipped; 949 tests passed / 1 intentional skip
- `pnpm run verify:forbidden` — PASS
- `pnpm run verify:package` — PASS
- `git diff --check` — PASS

Existing Rust dead-code/test-only warnings remain unchanged in nature and are outside this phase. Review of the Phase 7 diff in `crates/runtime/src/audit.rs` shows only the two intended worktree audit actions were added there.

## Final scope review

The complete feature diff from baseline was searched for forbidden authority expansion. Production additions contain no `--force` worktree invocation, no generic `git.worktreeList/Repair/Move/Prune/Lock/Unlock`, no `workflow.run`, no `skill.run`, no `provider.invoke`, and no caller-selected worktree path. Public surface growth is exactly two tools, from `0.14 / 76` to live `0.15 / 78`.

## Final closure evidence

Phase 7 passed every release gate that was pending in the pre-merge readiness snapshot:

- PR #48 merged accepted feature head `a119dc7fba63b4ded21cef0ac806d8d3ef6f1279` into canonical `main` as `9082bfcd325d0b4428588c2608ad5be5b4459ff4`.
- Exact PR-head KodeGPT CI run `32252802187` completed `SUCCESS` on `a119dc7fba63b4ded21cef0ac806d8d3ef6f1279`.
- Exact merged-main KodeGPT CI run `32253363463` completed `SUCCESS` on `9082bfcd325d0b4428588c2608ad5be5b4459ff4`.
- The immutable installed service is running/listener-ready/managed-exposure ready on active release `rel_0d1fe87d689de32e7afd466769d59db5`, with Phase 6 release `rel_258b83f4f3932614cfca69c99d9b45ac` retained as rollback.
- Live `system.health` reports `ok=true`, `auditHealthy=true`, and `filesystemBoundaryAvailable=true`; live `system.capabilities` reports exactly `runtime 0.1 / protocol 2026-07-28 / surface 0.15`, and the refreshed connector inventory exposes exactly 78 public tools.
- Native disposable dogfood on branch `dogfood/phase7-live-final` created `.worktrees/phase7-live-final` from exact merged-main HEAD, returned only the relative path plus branch/OID, closed the parent, trusted/opened the child, observed clean child `git.status`, closed/untrusted the child, reopened the parent, removed the worktree through `git.worktreeRemove`, deleted the merged disposable branch, and returned canonical `git.status` to clean. No `git worktree repair`, prune, force removal, or canonical-path result was used.
- A second minimal audit probe confirmed durable `git_worktree_create` and `git_worktree_remove` outcomes as `success`; both public results remained relative-only and exposed no canonical host path.
- The Phase 7 implementation worktree was independently opened after parent closure, proven clean at exact HEAD `a119dc7fba63b4ded21cef0ac806d8d3ef6f1279`, then removed through `git.worktreeRemove`. Its dedicated trust record was revoked and the safely merged local branch `feat/bounded-linked-worktree-lifecycle` was deleted without force. Historical unrelated worktrees were not pruned or removed.

Phase 7 is therefore **CLOSED**. The final repository-only reconciliation that records this evidence changes documentation only and does not alter runtime, protocol, public schemas, provider state, deployment behavior, or authority boundaries.
