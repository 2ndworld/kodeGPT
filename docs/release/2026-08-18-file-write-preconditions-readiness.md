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

## Post-merge closure

PR #37 merged with exact head `db82820750bfe5dd63b0f4a89938fa26e15eb91a` as merge commit `a15934e8457cb274930356b3b3dd9b1cf0398651`. Both deterministic CI runs on that exact amended head passed: push run `32105275834` and pull-request run `32105279200`. Canonical `main` was then fast-forwarded exactly to the merge commit with a clean working tree.

Merged-main `pnpm --filter kodegpt build` completed successfully and produced clean artifact provenance with `sourceRevision=a15934e8457cb274930356b3b3dd9b1cf0398651`, `sourceDirty=false`, pair `pair_d97c7a6daaf511685164e718668a609f`, CLI SHA-256 `0b7c3b6b239b649d05a6ad32c8df80eeb198b76b6f3a781b41a9b3f39952ac98`, and runtime SHA-256 `b1095606a8e55e43bdab589e605b612bd0bc18e7de844b0c1ddc271de9acc98e`.

`service install --name public:kodegpt-dev --port 43121` staged immutable release `rel_10e8b6a2dcd15560fd1a515578840caf` while `rel_ef2a32659085c0fccc419e2a6ed3d007` remained active, proving there was no hidden cutover. Explicit `service restart` then promoted `rel_10e8b6a2dcd15560fd1a515578840caf` and retained `rel_ef2a32659085c0fccc419e2a6ed3d007` as rollback. Final service status is running, enabled, listener-ready, managed-exposure ready, and reports runtime/protocol/semantic surface `0.1 / 2026-07-28 / 0.10`; `kodegpt doctor --json` returns `ok=true` with the packaged runtime executable available.

The running server contains the optional precondition schema, but this ChatGPT session does not expose a refreshed KodeGPT connector action snapshot after the input-definition change. Per host compatibility policy, the connector/tool actions must be refreshed/rescanned before host-level evidence can exercise `file.write.precondition`. No synthetic guarded-write MCP result is claimed. Source, focused tests, complete local verification, and exact-head CI prove the guarded semantics; host-schema acceptance remains a refresh step rather than an implementation gap.
