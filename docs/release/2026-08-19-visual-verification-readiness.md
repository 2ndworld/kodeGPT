# Visual Verification — Pre-Merge Readiness

Date: 2026-08-19
Branch: `feat/visual-verification`
Base: `db1407e65a76f39c975e4ea2e101090e23285201` (Phase 2 merged baseline)
Implementation source head before this readiness record: `3c40154166c6787400f2c89885acf30edccf56e8`
Target runtime / protocol / MCP surface: `0.1 / 2026-07-28 / 0.13`
Target public tool count: 74

## Scope

Phase 3 adds exactly two semantic MCP tools:

- `visual.captureMatrix`
- `visual.compare`

The implementation is a thin composition layer over the Phase 2 preview-scoped browser evidence primitive and the existing artifact spool. It does not add a second browser driver, a second screenshot path, a Rust RPC, filesystem authority, process authority, network authority, arbitrary browser navigation, JavaScript evaluation, arbitrary viewport lists, CV/OCR, a persistent baseline database, or automatic baseline mutation.

`visual.captureMatrix` uses the existing live browser session and captures exactly three fixed viewports, sequentially, then restores the original viewport in a `finally` path:

1. mobile — `390x844`
2. tablet — `768x1024`
3. desktop — `1440x900`

`visual.compare` captures the current viewport itself through the existing browser screenshot path and compares it against one explicit `artifact://ka_...` PNG reference. Comparison is exact RGBA equality with an optional finite threshold in `[0,1]`, default `0`. Dimension mismatch always fails even when the changed-pixel ratio is within threshold.

## Bounded evidence design

The PNG comparison path is intentionally deterministic and bounded:

- encoded artifact limit: 5 MiB per input;
- artifact reads: at most 1 MiB per read operation;
- decoded image bound: `3840 * 2160` pixels;
- comparison union bound: `3840 * 2160` pixels;
- supported format: PNG bit depth 8, non-interlaced RGB/RGBA, compression/filter method 0;
- PNG scanline filters 0 through 4 are implemented;
- malformed/unsupported PNG input fails closed with stable `VISUAL_*` errors;
- no perceptual tolerance, OCR, semantic image interpretation, or image-processing dependency is introduced.

A review pass found one allocation/CPU-bound gap before public exposure: two individually bounded images could form an oversized comparison union. That was closed test-first by rejecting a union above `3840 * 2160` with `VISUAL_ARTIFACT_TOO_LARGE`.

## Surface and service compatibility

The public MCP surface is locked to `0.13` and exactly 74 tools. Input schemas reject URL/path/current-artifact/arbitrary-viewport/baseline-update authority. Visual tools use the existing browser capture annotation class and normalize `VISUAL_*`, composed `BROWSER_*`, and `ARTIFACT_*` failures to bounded public messages.

Full monorepo typecheck exposed two pre-existing manual service surface-version allowlists that ended at `0.12`. They were extended to admit `0.13` in:

- `apps/cli/src/commands/service.ts`
- `apps/cli/src/service/runtime-status.ts`

The matching service fixture was updated. Focused service/runtime tests then passed 29/29, followed by a clean root typecheck.

## Fresh deterministic verification

Fresh evidence on implementation source head `3c40154166c6787400f2c89885acf30edccf56e8`:

- Phase 3 focused core/MCP set: **7 files / 75 tests PASS**.
- Service/runtime surface compatibility: **2 files / 29 tests PASS**.
- Root TypeScript typecheck: **PASS** across all workspace projects.
- Root build: **PASS** after providing the linked worktree's mount-correct `GIT_DIR` / `GIT_WORK_TREE` to the KodeGPT nested sandbox; the source build itself is clean.
- `pnpm verify:forbidden`: **PASS** (`forbidden-pattern scan ok`).
- `pnpm verify:package`: **PASS** (`package smoke ok`).
  - CLI package SHA-256: `b60dcc0fce7cfc82d215f6faf7ef4c0036c428d1e67b703d9189e22fd6b23e95`
  - runtime package SHA-256: `1ff0c7b45d6491e962ca440f0de6bd0fe8e593ec738088f7975ac5943edfd081`
  - runtime binary SHA-256: `1e40b6ab5eca56093adc9a262a241dea11849360644a89b80550382db04a7942`
- `cargo fmt --all -- --check`: **PASS**.
- `cargo check --workspace`: **PASS**; existing Rust warning set only and no Rust production file changed.
- `git diff --check db1407e...HEAD`: **PASS**.
- Feature worktree status after implementation: **clean**.
- Actual Playwright browser spike: **PASS**, including resize of the existing Chrome session to `390x844` and inspection of the resized viewport.

## Nested-sandbox full-suite evidence

A root `pnpm test` run from inside the already-sandboxed live KodeGPT process completed with:

- 121 passed test files;
- 1 skipped test file;
- 898 passed tests;
- 10 skipped tests;
- 2 failed tests plus 3 suite setup failures.

The three setup failures are a linked-worktree mount artifact: packaged CLI tests invoke `git rev-parse HEAD`, while the worktree `.git` file contains the host path `/home/sauron/dev/kodegpt/.git/worktrees/visual-verification`, which is not visible as that path inside KodeGPT's retained-root mount. The same build passes when the identical worktree metadata is addressed at its sandbox mount path; no build-script relaxation was made.

The remaining two failed tests are `tests/integration/full-stack.test.ts`. They report:

1. verification recipes blocked with `SANDBOX_UNAVAILABLE`; and
2. the Remote-CI fixture returning the same bounded non-JSON `CI_REPOSIT...` capability failure seen under nested execution.

An A/B run of that exact full-stack file on unchanged canonical `main == db1407e65a76f39c975e4ea2e101090e23285201` inside the same live KodeGPT sandbox failed **2/2 with the same two failure modes**. These are therefore baseline nested-sandbox limitations, not Visual Verification regressions. GitHub host CI remains the authoritative complete full-suite gate and must pass on the exact PR head before merge.

## Exact-diff review

A second-path typed Git review used KodeGPT `git.diffHistory` directly from canonical repository authority across:

`db1407e65a76f39c975e4ea2e101090e23285201..3c40154166c6787400f2c89885acf30edccf56e8`

Result:

- 26 files changed;
- 2219 insertions;
- 16 deletions;
- 0 binary files;
- returned patch not truncated.

The review checked browser/session ownership, viewport restoration, artifact read bounds, PNG decoded/union allocation bounds, exact-pixel semantics, public schema closure, error redaction, surface/tool-count exactness, service compatibility, and absence of new filesystem/process/network/deployment authority. No blocking finding remains.

CodexPro was used successfully for design, planning, RED/GREEN implementation, tests, and early diff review, then began returning persistent upstream HTTP 502. No independent CodexPro approval is claimed after that transport failure. Prior PR #41 has no submitted GitHub review records to reuse as an independent reviewer. Exact-head GitHub CI is therefore mandatory before merge in addition to the typed exact-diff audit above.

## Pre-merge decision

**READY FOR PR/CI.**

This is not a Phase 3 completion claim. Still required before closure:

1. push exact branch and create PR;
2. exact-head host CI PASS;
3. merge with expected-head protection;
4. merged-main CI PASS, including clean-install package smoke;
5. immutable merged-main release staging and explicit service cutover;
6. live health proving `0.1 / 2026-07-28 / 0.13` and exactly 74 tools;
7. direct live Visual Verification acceptance proving fixed matrix capture, identical-reference PASS at threshold `0`, deterministic mismatch FAIL, preview health after visual operations, and cleanup;
8. canonical Git tree clean.

Typed Preview Deployment remains out of scope until all of the above passes.
