# KodeGPT Target-Scoped Context Build Implementation Plan

**Goal:** Make targeted `context.build` compact and area-relevant without changing its public schema or adding new tools.

**Spec:** `docs/superpowers/specs/2026-08-20-kodegpt-target-scoped-context-build-design.md`

## Task 1 — TDD: scope lexical search to target area

Files:
- `packages/capabilities/src/context-build.test.ts`
- `packages/capabilities/src/context-build.ts`

Steps:
1. Extend the test fixture to capture `CodeSearchInput`.
2. Add a failing test proving target `packages/core/src/workspace-manager.ts` invokes search with `path: "packages/core"` while untargeted builds do not add a search scope.
3. Resolve target area once from the full workspace inspection and pass it to `collectSearchEvidence`.
4. Run focused context-build tests.

## Task 2 — TDD: compact returned workspace evidence

Files:
- `packages/capabilities/src/context-build.test.ts`
- `packages/capabilities/src/context-build.ts`

Steps:
1. Add fixture entrypoints/symbols/relationships from both target and unrelated areas.
2. Add a failing test asserting targeted output keeps only containing areas, governing manifests, target-area entrypoints, relevant symbols, and direct relationships touching candidate evidence.
3. Implement one private `compactWorkspaceEvidence(...)` helper; keep untargeted output unchanged.
4. Do not synthesize evidence or change `WorkspaceInspectResult` schema.
5. Run focused tests.

## Task 3 — TDD: filter verification recipes

Files:
- `packages/capabilities/src/context-build.test.ts`
- `packages/capabilities/src/context-build.ts`

Steps:
1. Add root, target-package, and unrelated-package recipes to the fixture.
2. Add a failing test proving a targeted build keeps root + target-area/ancestor recipes and drops unrelated-package recipes.
3. Implement one private filter helper using existing `cwd` values only.
4. Preserve all recipes for untargeted builds.
5. Run focused tests.

## Task 4 — verification and dogfood

1. Run `pnpm exec vitest run packages/capabilities/src/context-build.test.ts --no-file-parallelism`.
2. Run package capability tests, typecheck, build, forbidden-pattern scan, package smoke, and full Vitest shards.
3. Run Rust workspace tests from host context only; do not treat nested-Bubblewrap failure inside KodeGPT as a code regression.
4. Dogfood `context.build` on `packages/capabilities/src/context-build.ts` and compare target-scoped evidence to the pre-change behavior.
5. Confirm no public schema/tool/version change and `git diff --check` is clean.
