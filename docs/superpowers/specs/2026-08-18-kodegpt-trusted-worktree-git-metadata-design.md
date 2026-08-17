# KodeGPT Trusted Linked-Worktree Git Metadata — Follow-up Design Record

Date: 2026-08-18  
Status: **Separate design required; not approved for implementation in Trusted Development Parity P0/P1**

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

## Non-goals

This record does not authorize implementation, broad `.git` mounting, canonical-repository mounting, host-root access, generic path admission, generic Git argv, or weaker workspace identity checks.

## Next decision

If linked-worktree Git parity is prioritized, produce a focused approved design and TDD plan around validated Git metadata admission. Until then, use the canonical ordinary checkout for typed Git/merged-main release operations and keep linked-worktree failures fail-closed and explicit.
