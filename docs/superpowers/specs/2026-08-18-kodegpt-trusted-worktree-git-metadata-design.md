# KodeGPT Trusted Linked-Worktree Git Metadata — Follow-up Design Record

Date: 2026-08-18  
Status: **Approved for the focused P0 implementation on 2026-08-18; no public-surface expansion approved**

## Goal

Close the practical parity gap where KodeGPT can open and edit a trusted Git linked worktree as retained-root source, but typed Git operations and Git-based build provenance fail because the worktree `.git` file points to common Git metadata outside that retained source root.

## Evidence

On `/home/sauron/dev/kodegpt/.worktrees/trusted-development-parity-ergonomics`:

- source inspection, search, read, edit/revert, shell/process and verification primitives work under KodeGPT;
- CodexPro host Git status works normally;
- KodeGPT `git.status` fails closed because `.git` resolves to `/home/sauron/dev/kodegpt/.git/worktrees/trusted-development-parity-ergonomics`, outside the retained worktree root;
- trusted `package:test` exposes the same boundary in Git-based CLI provenance tests.

This is a real ergonomics gap, but it is not evidence that the retained-root boundary should be bypassed generically.

## Required design constraints

Any future implementation must:

1. derive linked-worktree metadata only from validated Git worktree structure, never arbitrary request paths;
2. validate the `.git` indirection and Git `commondir` relationship against the same repository identity;
3. admit only the minimum required Git metadata directories/files rather than the canonical repository root or host filesystem;
4. distinguish read-only Git/provenance needs from the narrower metadata writes required by already-approved typed Git mutation operations;
5. retain source authority at the trusted worktree retained root;
6. preserve Bubblewrap, executable revalidation, controlled PATH/environment, private HOME, audit, cancellation and network rules;
7. avoid a generic external-mount framework or arbitrary host-path escape hatch;
8. include adversarial tests for forged `.git` files, symlink/path traversal, mismatched repository/common-dir identity and deleted/stale worktrees;
9. prove ordinary non-worktree repositories remain unchanged;
10. avoid adding a public tool solely to hide the metadata problem.

## Approved implementation decision

The approved P0 treats the validated Git common directory as the smallest reliable repository-metadata unit that preserves the existing typed Git surface and trusted-shell behavior without inventing a brittle per-file mount matrix. Admission is derived internally from the retained worktree `.git` pointer, requires the standard `<common>/.git/worktrees/<name>` structure, exact `commondir=../..`, a reciprocal `gitdir` backlink to the retained worktree, canonical non-symlink paths, and bounded pointer files.

Bubblewrap materializes only empty parent directories plus that validated common Git metadata directory at its original absolute location. It never mounts the canonical checkout source tree. Git metadata is not admitted to a process by default, even when the retained source workspace itself is writable. Existing typed Git reads explicitly request read-only metadata; existing typed Git mutations and `trusted` write-capable process execution may explicitly receive metadata read-write so trusted linked worktrees do not become less capable than ordinary trusted repositories. `observe` and `develop` process execution receive no external Git metadata authority. This is intentionally Git-specific and does not create generic external-mount or arbitrary host-path request authority.

## Non-goals

This approval does not authorize canonical-repository source mounting, host-root access, generic path admission, generic external mounts, generic Git argv, weaker workspace identity checks, or a new MCP tool solely for metadata admission. Runtime `0.1`, protocol `2026-07-28`, and MCP surface `0.10` remain unchanged.

## P1 decision rule

After P0, dogfood the development loop from a linked worktree. Do not add `git.worktree*` tools merely for API symmetry. If trusted-shell worktree lifecycle remains materially awkward after real use, record the evidence and require a separate small design before any new public authority is added.
