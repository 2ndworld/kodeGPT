# Trusted Linked-Worktree Git Metadata — P0/P1 Verification Audit

Date: 2026-08-18

## Scope

This audit closes the focused P0 Trusted Linked-Worktree Git Metadata phase and records the evidence-based P1 decision. It does not authorize a new public MCP tool, provider/agent framework, generic external mount, arbitrary host-path admission, or nested user-namespace relaxation.

Baseline before this phase: `main == origin/main` at `af4958cf1ba5d144276c4ad2f921fe1b6f6970c6` (post-PR #30), runtime `0.1`, protocol `2026-07-28`, MCP surface `0.10`.

Feature candidate: `06857dc42da2ea6f789df5bc224a4bc7f1dfc32e` (`fix(sandbox): admit linked worktree git metadata`).

## P0 result

Pre-fix live dogfood reproduced the material parity failure from a trusted linked worktree: typed `git.status` failed with `GIT_INSPECTION_FAILED`, and trusted shell Git failed because the retained worktree `.git` pointer resolved to `<canonical>/.git/worktrees/<name>` outside the retained source root.

The implementation remains Git-specific. It validates the retained worktree `.git` pointer, canonical linked-worktree `gitdir`, exact `commondir=../..`, reciprocal `gitdir` backlink, canonical non-symlink metadata paths, and bounded pointer files. Bubblewrap receives only the validated common Git metadata directory by retained FD at its original absolute location. The canonical checkout source tree is never mounted.

External Git metadata authority is separate from source workspace authority:

- default process execution: no external Git metadata admission;
- typed Git read/history: metadata read-only;
- typed Git mutation: metadata read-write through existing mutation authority;
- `trusted` process execution: metadata read-write when the existing trusted profile is write-capable;
- `observe` and `develop` process execution: no external Git metadata mount.

Runtime `0.1`, protocol `2026-07-28`, and MCP surface `0.10` remain unchanged.

## TDD and security evidence

The focused sandbox regression test was observed RED before production changes with `fatal: not a git repository` for the linked worktree metadata path, then GREEN after admission was implemented.

Adversarial coverage includes ordinary repositories, `.git` symlink rejection, parent traversal rejection, mismatched repository/backlink rejection, stale/deleted gitdir rejection, canonical source invisibility, and separation of source-write authority from external Git-metadata write authority.

A runtime integration test proves typed linked-worktree `status -> stage -> commit` against the feature branch. Review also caught and corrected an early over-broad draft where source `ReadWrite` implied metadata `ReadWrite`; the final implementation uses an explicit internal `None | ReadOnly | ReadWrite` metadata mode instead.

Fresh post-review deterministic gates passed:

- `cargo check --workspace`;
- `cargo test --workspace`;
- `pnpm run typecheck`;
- `pnpm run build`;
- `pnpm run test` — 118 test files / 812 tests passed;
- `pnpm run verify:forbidden`;
- `pnpm run verify:package`;
- `git diff --check`.

## P0.5 operational cleanup

Fresh inspection showed the historical `github-read-provider-adapter` and `provider-gateway` worktrees were no longer marked prunable, but both were clean and their branches were already merged into `main`. They were removed with normal `git worktree remove` after proving no unique work.

Two stale KodeGPT trust records whose historical worktree roots no longer existed (`bounded-github-pr-write` and `four-priority-followthrough`) were removed. No garbage collector, watcher, daemon, or worktree lifecycle subsystem was added.

## Candidate release dogfood

Because the implementation worktree contains unrelated concurrent untracked planning documents, those files were preserved untouched. A separate clean detached worktree at exact commit `06857dc42da2ea6f789df5bc224a4bc7f1dfc32e` was used to produce clean provenance with `sourceDirty=false`.

The candidate was staged through the existing immutable service lifecycle as `rel_0f83f198f582b3aab444563d40cbffe3`, then explicitly restarted. Post-cutover `system.health` reported healthy audit and filesystem boundary. `system.capabilities` still reports runtime `0.1`, protocol `2026-07-28`, surface `0.10`.

## P1 linked-worktree dogfood matrix

| Workflow | Evidence | Classification |
| --- | --- | --- |
| Typed Git status/changes | Live `git.status` and `git.changes` returned normal structured output from the linked worktree | `NO_GAP` |
| Typed Git history | Live `git.log` and `git.show` resolved feature HEAD `06857dc...` and changed paths | `NO_GAP` |
| Trusted shell Git | `git rev-parse --git-dir`, `--git-common-dir`, and `git status --short` succeeded | `NO_GAP` |
| Canonical source isolation | Trusted shell probe confirmed `/home/sauron/dev/kodegpt/package.json` is hidden | `NO_GAP` |
| Source mutation + Git diff | Disposable `file.edit -> git.diff -> file.edit revert` succeeded without residual tracked change | `NO_GAP` |
| Typed Git commit identity | First live `git.commit` correctly failed because sandboxed Git does not inherit host HOME/global identity; existing trusted shell configured the already-used repository identity with repo-local `git config`, without widening environment inheritance | `DOC/ERGONOMIC_GAP` |
| Typed remote Git push | Live `git.push` to the repository HTTPS `origin` failed closed because terminal prompts are disabled and this Git mutation path does not consume the already-existing GitHub `gh` credential helper; CodexPro host Git published the exact branch without changing KodeGPT authority | `EXISTING_PRIMITIVE_GAP` |
| Build / provenance path | `verify.run(package:build)` completed successfully from `/workspace`, including Rust runtime build | `NO_GAP` |
| Repository context | `context.build(intent=review)` returned repository map, Git evidence, target source, and verification recipes | `NO_GAP` |
| Failure diagnosis | Deliberate trusted-shell exit `7` returned deterministic failed state, stderr, and artifact | `NO_GAP` |
| Cancellation | Background trusted-shell operation transitioned `running -> cancelled`, exit `143`, and remained observable by `process.status` | `NO_GAP` |
| Linked-worktree creation lifecycle from inside sandbox | `git worktree add` executed inside `/workspace` caused Git 2.43 to persist sandbox-absolute `/workspace/...` paths in linked-worktree metadata; host-side `git worktree repair <real-path>` was needed | `NEW_BEHAVIOR_REQUIRES_SEPARATE_SPEC` |

## P1 decision

Do **not** add `git.worktreeCreate`, `git.worktreeList`, or `git.worktreeRemove` in this phase.

P0 removes the development-authority gap that blocked existing linked worktrees: typed Git, trusted shell, build/provenance, context, source edits, failure handling, and cancellation now work from the linked worktree. The remaining lifecycle friction is narrower: Git invoked inside the sandbox sees `/workspace`, so creating a new linked worktree there can persist sandbox-absolute paths that are not valid host paths.

Solving that lifecycle issue would require a distinct authority/design decision about sibling worktree creation and path/provenance representation. Adding three public tools now would therefore be premature and would violate the dogfood-first rule. Keep the current trusted-shell workflow for ordinary nested Git use; create/repair worktrees host-side when needed until repeated dogfood justifies a separate focused design.

Dogfood also exposed a separate existing-primitive gap: typed HTTPS `git.push` does not currently consume the already-admitted GitHub `gh` credential helper, while host Git can publish the same branch. This is not caused by linked-worktree metadata and does not justify a provider framework. If it recurs, prefer a narrow credential-bridge fix for the existing typed Git remote mutation path before adding new worktree lifecycle tools.

## Roadmap outcome

P0: **DONE** — Trusted Linked-Worktree Git Metadata implemented and live-dogfooded.

P0.5: **DONE** — bounded operational residue cleaned without a new subsystem.

P1: **DONE AS AUDIT/DECISION** — no new typed worktree tools were added in that phase; one lifecycle behavior was recorded for a separate spec only if future dogfood proved it frequent enough.

Next roadmap selection should remain dogfood-driven rather than feature-count-driven.

## Superseding Phase 7 implementation evidence — 2026-08-19

Repeated application-development dogfood subsequently justified the separate bounded lifecycle design. Phase 7 implements exactly `git.worktreeCreate` and `git.worktreeRemove`, fixed to `.worktrees/<name>` with an existing local branch, clean-only removal, no force semantics, and no scheduler/agent lifecycle.

The new private sandbox path authority is narrower than generic process execution: only the fixed typed worktree lifecycle command may bind the already-retained workspace FD at its validated canonical display path. A full-stack regression proves ordinary trusted `process.run` still cannot observe the canonical source path, while typed worktree creation writes reciprocal host-valid Git metadata without `/workspace/` and without any `git worktree repair` step.

Focused full-stack acceptance also proves fail-closed public behavior for invalid worktree names, missing branches, branches already checked out, pre-existing targets, dirty worktrees, and locked worktrees. The happy path completes `git.branchCreate -> git.worktreeCreate -> child workspace open/status/edit/diff -> child close -> parent reopen -> git.worktreeRemove -> git.branchDelete` and returns only repository-relative `.worktrees/<name>` evidence.
