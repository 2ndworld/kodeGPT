# Optional File Write Preconditions — Readiness

Status date: 2026-08-18  
Branch: `feat/file-write-preconditions`  
Baseline: merged PR #36, `86847eb9be9f5a031118a30fc084246c12920cd8`  
Implementation commit: `29bb45d6d23d38680ed235290ce2cb3a32b494dd`  
Status: implementation and complete local verification are green; ready for PR/CI and merged-main release closure.

## Scope

`file.write` keeps its existing unconditional create-or-replace behavior and adds one optional precondition object:

- `{ "kind": "missing" }` — create only if the destination is still absent;
- `{ "kind": "sha256", "value": "<64 lowercase hex>" }` — replace only if the current regular UTF-8 file still matches the expected digest.

The field is optional. Existing callers that send only `workspaceId`, `path`, and `content` keep exactly the previous behavior and required-field contract.

The guarded path reuses the already hardened conditional file primitive used by `file.patch`: retained-root/openat boundary, no-clobber `RENAME_NOREPLACE` create, digest verification, destination revalidation immediately before rename, mode preservation for updates, fsync, and the existing audit/policy boundary. No second filesystem mutation subsystem was added.

Stale guarded writes return stable runtime/core error `FILE_PRECONDITION_FAILED`. Invalid or hidden precondition fields are rejected by the closed MCP/protocol schemas. Runtime/protocol/semantic MCP surface versions remain `0.1 / 2026-07-28 / 0.10`: the repository's locked semantic snapshot is tool names plus required input fields, and neither changes here. The optional `file.write.precondition` does change the full tool input definition, so ChatGPT connector/tool actions must be refreshed/rescanned before collecting host-level evidence for the new field.

## Threat-model decision

The audit considered using the existing `git.changes.fingerprint` as a local Git stage/commit precondition. That fingerprint covers the whole checkpoint: index, worktree, untracked identities, and all changed records. Requiring it for `git.commit` would reject legitimate commits merely because unrelated unstaged worktree state changed; requiring it for `git.stage` would likewise make a targeted stage depend on unrelated repository changes. It would also leave a check-then-mutate race unless a larger Git mutation redesign moved the semantics into the Rust Git workflow.

That approach was therefore rejected as too broad and ergonomically regressive for the demonstrated risk. Existing guarded alternatives already cover other high-risk mutations: `file.edit` uses exact-text replacement counts, `file.patch` uses digest/no-clobber preconditions, and `github.pr.merge` uses `expectedHeadOid`.

The remaining concrete stale-overwrite gap was unconditional full-content `file.write`. Optional CAS closes that gap without making simple personal-workspace writes more cumbersome.

## TDD evidence

The first runtime RED request added a `file.write` precondition and failed as `INVALID_PARAMS`, proving no guarded write contract existed. The GREEN path then added the closed protocol type and reused the existing conditional primitive.

Focused runtime behavior proves:

- ordinary `file.write` still creates normally;
- `missing` creates a new file successfully;
- `missing` against an existing file returns `FILE_PRECONDITION_FAILED` and preserves old bytes;
- stale SHA-256 returns `FILE_PRECONDITION_FAILED` and preserves old bytes;
- matching SHA-256 replaces the file successfully and reports `created=false`.

A protocol test caught an additional subtlety: a Serde unit variant would accept unknown fields on `{kind:"missing"}` despite the surrounding closed enum. The representation was tightened to an empty struct variant so unknown fields are now rejected. MCP Zod coverage independently proves plain input, valid missing/digest preconditions, uppercase/invalid digest rejection, and unknown precondition-field rejection.

## Verification

Fresh verification on the implementation tree after merging the benchmark baseline:

- focused core/MCP: `3` files / `51` tests PASS;
- focused runtime guarded-write behavior: PASS;
- focused protocol closed-precondition contract: PASS;
- complete TypeScript/Vitest suite: `119` files / `828` tests PASS;
- root `pnpm run typecheck`: PASS;
- root `pnpm run build`: PASS;
- `cargo fmt --all -- --check`: PASS;
- `cargo test --workspace -- --test-threads=1`: PASS across the complete Rust workspace;
- `git diff --check`: PASS.

Build/test output contains only the pre-existing Rust dead-code warning set.

## Review

Complete-diff review found no new process/network/provider authority, no retry/autonomy behavior, and no required-field change. Guarded create uses the same `0600` new-file mode as ordinary `file.write`; guarded update preserves the existing destination mode. Boundary violations remain access-denied failures rather than being disguised as precondition failures.

The production addition is deliberately opt-in. This preserves KodeGPT's existing flexibility while giving callers a compare-and-swap path when they are acting from previously observed file state.

## Remaining closure

1. commit this evidence separately;
2. push the exact branch and create a focused PR against `main`;
3. require deterministic CI PASS and exact-head merge;
4. fast-forward canonical `main` to the merge commit;
5. build/stage an immutable merged-main release without hidden cutover;
6. explicitly restart/cut over and verify service status/health at `0.1 / 2026-07-28 / 0.10`;
7. if the KodeGPT connector is exposed in the session, live-dogfood a guarded stale write; otherwise do not claim a synthetic MCP result.
