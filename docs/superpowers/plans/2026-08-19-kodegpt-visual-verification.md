# KodeGPT Visual Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded responsive screenshot matrix capture and deterministic current-vs-reference PNG comparison as exactly two preview-scoped MCP tools.

**Architecture:** Extend the existing preview-bound `BrowserManager` with one internal viewport-resize primitive, then compose it with the existing `ArtifactStore` in a new `VisualVerificationManager`. PNG decoding and pixel comparison remain pure bounded core logic; MCP wiring exposes only `visual.captureMatrix` and `visual.compare`, while production injects the same `BrowserManager` and `ArtifactStore` instances already used by Phase 2.

**Tech Stack:** TypeScript 5.9, Node.js 24 (`node:zlib`), Vitest 3.2, Playwright Core 1.62.1, MCP TypeScript server, pnpm 10.15.0.

**Spec:** `docs/superpowers/specs/2026-08-19-kodegpt-visual-verification-design.md`

## Global Constraints

- Baseline is `db1407e65a76f39c975e4ea2e101090e23285201`; Phase 2 is complete and must not be reimplemented.
- Add exactly two public tools: `visual.captureMatrix` and `visual.compare`.
- Surface changes from `0.12 / 72 tools` to `0.13 / 74 tools`; runtime remains `0.1`, protocol remains `2026-07-28`.
- Reuse the existing `BrowserManager`, Playwright session, preview identity, and raw artifact spool; no second browser/screenshot/artifact/process/network authority.
- Fixed matrix is exactly `mobile 390x844`, `tablet 768x1024`, `desktop 1440x900`, in that order.
- Comparison captures the current screenshot itself; caller supplies only one explicit reference artifact URI and optional threshold.
- Threshold defaults to `0`, must be finite and within `[0,1]`, and comparison is exact RGBA equality.
- Reference/current encoded PNG artifacts are bounded to 5 MiB and decoded geometry to `3840 * 2160` pixels.
- PNG support is bit depth 8, non-interlaced RGB/RGBA, filters 0-4, with no new image-processing dependency.
- No persistent baseline database, automatic baseline acceptance/update, arbitrary viewport list, arbitrary file path, arbitrary URL/navigation, JavaScript evaluate, CV/OCR, or deployment work.
- All code changes use TDD. Production completion requires deterministic verification, exact-diff review, PR/CI, merge, merged-main CI, immutable release/cutover, and direct live acceptance.

---

### Task 1: Internal Browser Viewport Resize

**Files:**
- Modify: `packages/core/src/browser-manager.test.ts`
- Modify: `packages/core/src/browser-manager.ts`
- Modify: `packages/core/src/playwright-browser-driver.ts`
- Modify: `packages/core/src/playwright-browser-driver.test.ts`

**Interfaces:**
- Consumes: existing `(workspaceId, previewId)` live-session lookup and `BrowserViewport` validation.
- Produces: `BrowserDriverSession.setViewport(viewport: BrowserViewport): Promise<void>` and `BrowserManager.setViewport(input: BrowserSetViewportInput): Promise<BrowserOpenResult>` for internal composition only.

- [ ] **Step 1: Write failing BrowserManager tests**

Add tests that open one fixture session, call `setViewport({workspaceId, previewId, viewport:{width:390,height:844}})`, and assert the fake driver was resized without a second `open`; then assert `inspect`/returned session metadata reflect the new viewport. Add failure coverage proving invalid viewport values are rejected with `BROWSER_TARGET_INVALID` and a driver resize failure leaves the stored viewport unchanged.

Representative assertions:

```ts
await fixture.manager.openPreview({ workspaceId: "ws_test", previewId: "pv_test" });
const resized = await fixture.manager.setViewport({
  workspaceId: "ws_test",
  previewId: "pv_test",
  viewport: { width: 390, height: 844 }
});
expect(fixture.driver.opens).toHaveLength(1);
expect(fixture.session.viewports).toEqual([{ width: 390, height: 844 }]);
expect(resized.viewport).toEqual({ width: 390, height: 844 });
```

- [ ] **Step 2: Run BrowserManager RED test**

Run:

```bash
pnpm exec vitest run packages/core/src/browser-manager.test.ts --no-file-parallelism
```

Expected: FAIL because `setViewport` does not yet exist on the driver/manager.

- [ ] **Step 3: Implement minimal BrowserManager resize**

Add:

```ts
export interface BrowserSetViewportInput extends BrowserPreviewInput {
  viewport: BrowserViewport;
}
```

Extend `BrowserDriverSession` with `setViewport(viewport)`. In `BrowserManager.setViewport`, call existing `validateViewport`, require the same live session, call the driver, update `record.viewport` only after success, and return `#openResult(record)`. Map driver failure to `BROWSER_ACTION_FAILED`.

- [ ] **Step 4: Write and run Playwright driver RED/GREEN test**

Add a focused test around the session/page viewport behavior where feasible through the existing Playwright-driver test seams. Implement `PlaywrightBrowserSession.setViewport` as:

```ts
async setViewport(viewport: BrowserViewport): Promise<void> {
  await this.#page.setViewportSize({ ...viewport });
  this.#viewport = { ...viewport };
}
```

Change the stored fallback viewport from readonly to mutable. Run:

```bash
pnpm exec vitest run packages/core/src/browser-manager.test.ts packages/core/src/playwright-browser-driver.test.ts --no-file-parallelism
```

Expected: PASS.

- [ ] **Step 5: Commit the browser primitive**

```bash
git add packages/core/src/browser-manager.ts packages/core/src/browser-manager.test.ts packages/core/src/playwright-browser-driver.ts packages/core/src/playwright-browser-driver.test.ts
git commit -m "feat(core): add internal browser viewport resize"
```

---

### Task 2: Bounded PNG Decode and Pixel Comparison

**Files:**
- Create: `packages/core/src/visual-png.test.ts`
- Create: `packages/core/src/visual-png.ts`

**Interfaces:**
- Consumes: encoded PNG bytes only.
- Produces:

```ts
export interface DecodedVisualPng {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export function decodeVisualPng(bytes: Uint8Array): DecodedVisualPng;
export function compareVisualPixels(current: DecodedVisualPng, reference: DecodedVisualPng): VisualPixelComparison;
```

where `VisualPixelComparison` contains `currentDimensions`, `referenceDimensions`, `dimensionsMatch`, `changedPixels`, `totalPixels`, and `changedPixelRatio`.

- [ ] **Step 1: Write PNG decoder/comparison RED tests**

Generate tiny deterministic PNG fixtures inside the test using `node:zlib` + CRC helper so fixtures stay self-contained. Cover:

- valid 8-bit RGBA decode;
- valid 8-bit RGB to RGBA conversion;
- filters 0, 1, 2, 3, and 4;
- invalid signature/IHDR/chunk length;
- unsupported bit depth, color type, interlace, compression/filter method;
- decoded geometry above `3840 * 2160` rejected before large allocation;
- identical images ratio `0`;
- one changed pixel ratio exact;
- unequal dimensions use union rectangle and missing coordinates count as changed.

Example comparison:

```ts
const result = compareVisualPixels(
  { width: 2, height: 1, rgba: Uint8Array.from([0,0,0,255, 1,1,1,255]) },
  { width: 1, height: 1, rgba: Uint8Array.from([0,0,0,255]) }
);
expect(result.dimensionsMatch).toBe(false);
expect(result.totalPixels).toBe(2);
expect(result.changedPixels).toBe(1);
expect(result.changedPixelRatio).toBe(0.5);
```

- [ ] **Step 2: Run PNG RED tests**

```bash
pnpm exec vitest run packages/core/src/visual-png.test.ts --no-file-parallelism
```

Expected: FAIL because `visual-png.ts` does not exist.

- [ ] **Step 3: Implement bounded PNG decoder**

Use `inflateSync` from `node:zlib`. Validate PNG signature, a single first `IHDR`, chunk bounds, supported metadata, accumulated IDAT size under the encoded cap, and `IEND`. Calculate exact expected decompressed scanline length before inflate. Reconstruct filters 0-4 using byte-per-pixel 3 or 4 and convert RGB rows to RGBA. Throw `VisualVerificationError("VISUAL_PNG_INVALID", ...)` for malformed/unsupported input and `VISUAL_ARTIFACT_TOO_LARGE` for encoded/pixel bounds.

- [ ] **Step 4: Implement deterministic union comparison**

Iterate the union rectangle. Compare four RGBA channels for coordinates present in both images and count a coordinate present in only one image as changed. Compute `ratio = changedPixels / totalPixels` without perceptual tolerance.

- [ ] **Step 5: Run PNG GREEN tests**

```bash
pnpm exec vitest run packages/core/src/visual-png.test.ts --no-file-parallelism
```

Expected: PASS.

- [ ] **Step 6: Commit PNG evidence logic**

```bash
git add packages/core/src/visual-png.ts packages/core/src/visual-png.test.ts
git commit -m "feat(core): add bounded PNG visual comparison"
```

---

### Task 3: Visual Verification Orchestration

**Files:**
- Create: `packages/core/src/visual-verification.test.ts`
- Create: `packages/core/src/visual-verification.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes narrow browser methods `inspect`, `setViewport`, `screenshot` plus artifact `read`.
- Produces:

```ts
export class VisualVerificationManager {
  captureMatrix(input: VisualPreviewInput): Promise<VisualCaptureMatrixResult>;
  compare(input: VisualCompareInput): Promise<VisualCompareResult>;
}
```

with fixed `VISUAL_VIEWPORT_MATRIX` and stable `VisualVerificationError` codes.

- [ ] **Step 1: Write matrix orchestration RED tests**

Use a fake browser adapter that records `inspect`, `setViewport`, and `screenshot` calls. Assert capture order is exactly mobile/tablet/desktop, all three screenshots come from the browser adapter, and the original viewport is restored after success. Add a screenshot failure test asserting restore is still attempted and the original failure remains observable.

- [ ] **Step 2: Write artifact/read/compare RED tests**

Use a fake artifact reader with 1 MiB chunk behavior. Assert:

- current screenshot is obtained from `browser.screenshot`, not caller input;
- current and reference artifacts are read in bounded chunks;
- reference larger than 5 MiB fails `VISUAL_ARTIFACT_TOO_LARGE`;
- threshold default 0, exact boundary passes, out-of-range/NaN/Infinity fail `VISUAL_INPUT_INVALID`;
- equal PNGs pass with ratio 0;
- changed PNG fails at threshold 0 and can pass only when threshold admits the ratio;
- dimension mismatch always has `passed:false` even if threshold is 1.

- [ ] **Step 3: Run orchestration RED tests**

```bash
pnpm exec vitest run packages/core/src/visual-verification.test.ts --no-file-parallelism
```

Expected: FAIL because `VisualVerificationManager` does not exist.

- [ ] **Step 4: Implement `VisualVerificationManager`**

Implement a 5 MiB `readArtifactFully` loop using the existing artifact reader `offset/maxBytes` contract with each request capped at 1 MiB. `captureMatrix` first calls `browser.inspect` to obtain the original viewport, then resizes/screenshots sequentially and restores in `finally`. `compare` captures a normal current screenshot, reads/decode both artifacts, calls `compareVisualPixels`, validates threshold, and returns bounded scalar evidence + artifact refs.

- [ ] **Step 5: Export public core types/classes**

Update `packages/core/src/index.ts` to export the visual manager, constants, errors, result/input types, and pure PNG comparison types needed by tests/MCP wiring. Do not expose a new runtime/protocol method.

- [ ] **Step 6: Run core GREEN suite**

```bash
pnpm exec vitest run packages/core/src/browser-manager.test.ts packages/core/src/playwright-browser-driver.test.ts packages/core/src/visual-png.test.ts packages/core/src/visual-verification.test.ts --no-file-parallelism
pnpm --filter @kodegpt/core typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit visual orchestration**

```bash
git add packages/core/src/visual-verification.ts packages/core/src/visual-verification.test.ts packages/core/src/index.ts
git commit -m "feat(core): add visual verification orchestration"
```

---

### Task 4: Production Composition and MCP Tool Context

**Files:**
- Modify: `apps/cli/src/commands/start.ts`
- Modify: `apps/cli/src/commands/start.test.ts`
- Modify: `packages/mcp-server/src/tool-context.ts`
- Modify: `packages/mcp-server/src/tool-context.browser.test.ts`

**Interfaces:**
- Consumes: one existing `browserManager` and one existing `artifactStore` created by the production stack.
- Produces: `VisualToolContext` with `captureMatrix` and `compare`, injected into `KodegptToolContext.visual`.

- [ ] **Step 1: Write tool-context/production RED tests**

Extend context tests to prove visual calls delegate to the injected visual manager and that the unavailable fallback fails closed with `CAPABILITY_NOT_IMPLEMENTED`. In CLI start tests, capture the tool context or injected managers using existing seams and assert the visual manager is constructed from the same browser/artifact objects rather than new instances.

- [ ] **Step 2: Run RED tests**

```bash
pnpm exec vitest run packages/mcp-server/src/tool-context.browser.test.ts apps/cli/src/commands/start.test.ts --no-file-parallelism
```

Expected: FAIL because the context has no `visual` capability.

- [ ] **Step 3: Wire visual manager once**

In production stack:

```ts
const visualVerificationManager = new VisualVerificationManager(browserManager, artifactStore);
```

Pass it into `createKodegptToolContext`. Add optional `visual` input, `VisualToolContext`, returned `context.visual`, and `unavailableVisual()` in `tool-context.ts`. Do not modify preview/browser cleanup ownership.

- [ ] **Step 4: Run GREEN tests**

```bash
pnpm exec vitest run packages/mcp-server/src/tool-context.browser.test.ts apps/cli/src/commands/start.test.ts --no-file-parallelism
```

Expected: PASS.

- [ ] **Step 5: Commit production composition**

```bash
git add apps/cli/src/commands/start.ts apps/cli/src/commands/start.test.ts packages/mcp-server/src/tool-context.ts packages/mcp-server/src/tool-context.browser.test.ts
git commit -m "feat: wire visual verification into production context"
```

---

### Task 5: Public MCP Visual Surface 0.13

**Files:**
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/server.test.ts`
- Modify: `packages/mcp-server/src/structured-results.test.ts`
- Modify: `packages/mcp-server/src/surface-version.ts`
- Modify: `tests/fixtures/mcp-surface.ts`
- Modify: `tests/integration/mcp-stdio.test.ts`
- Modify: `tests/security/security-invariants.test.ts`

**Interfaces:**
- Consumes: `KodegptToolContext.visual.captureMatrix/compare`.
- Produces: exactly two strict MCP tool schemas and normalized structured results at surface `0.13` / 74 tools.

- [ ] **Step 1: Write surface RED tests**

Update expected surface fixtures first. Assert exactly 74 public tools and surface `0.13`. Add strict schema tests:

```ts
visual.captureMatrix({ workspaceId, previewId })
visual.compare({ workspaceId, previewId, referenceArtifact, threshold? })
```

Reject `url`, `path`, `viewport`, `viewports`, `currentArtifact`, baseline-update fields, threshold outside `[0,1]`, and malformed artifact URIs. Update security invariant tests to require exactly these two visual tools and no arbitrary visual/browser authority.

- [ ] **Step 2: Run MCP RED tests**

```bash
pnpm exec vitest run packages/mcp-server/src/server.test.ts packages/mcp-server/src/structured-results.test.ts tests/integration/mcp-stdio.test.ts tests/security/security-invariants.test.ts --no-file-parallelism
```

Expected: FAIL because public visual tools are not registered and surface remains 0.12.

- [ ] **Step 3: Register visual tools**

Add `visual.captureMatrix` and `visual.compare` to `SURFACE_TOOLS` and `registerKodegptTools`. Use the same capture-oriented annotation class as screenshot-producing browser tools because both calls create current screenshot artifacts. Add a `visualToolResult` helper that redacts stable `VISUAL_*` errors exactly as `browserToolResult` redacts `BROWSER_*` errors, while preserving existing browser errors generated by the composed manager.

The schemas must be closed by the MCP SDK registration path and use:

```ts
referenceArtifact: z.string().regex(/^artifact:\/\/ka_[A-Za-z0-9_-]{1,93}$/),
threshold: z.number().finite().min(0).max(1).optional()
```

- [ ] **Step 4: Bump surface and integration fixtures**

Change `MCP_SURFACE_VERSION` from `0.12` to `0.13`, update 72->74 expectations and stdio fixture dispatch for both visual tools. Do not change runtime/protocol versions.

- [ ] **Step 5: Run MCP GREEN tests**

```bash
pnpm exec vitest run packages/mcp-server/src/server.test.ts packages/mcp-server/src/structured-results.test.ts packages/mcp-server/src/tool-context.browser.test.ts tests/integration/mcp-stdio.test.ts tests/security/security-invariants.test.ts --no-file-parallelism
pnpm --filter @kodegpt/mcp-server typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit public surface**

```bash
git add packages/mcp-server/src/tools.ts packages/mcp-server/src/server.test.ts packages/mcp-server/src/structured-results.test.ts packages/mcp-server/src/surface-version.ts tests/fixtures/mcp-surface.ts tests/integration/mcp-stdio.test.ts tests/security/security-invariants.test.ts
git commit -m "feat(mcp): expose bounded visual verification"
```

---

### Task 6: Deterministic Verification and Readiness Record

**Files:**
- Create after all gates pass: `docs/release/2026-08-19-visual-verification-readiness.md`
- Modify only if needed for final phase status: `.ai-bridge/current-plan.md`

**Interfaces:**
- Consumes: complete feature branch.
- Produces: exact-head deterministic evidence suitable for independent review/PR.

- [ ] **Step 1: Run focused core/MCP verification**

```bash
pnpm exec vitest run packages/core/src/browser-manager.test.ts packages/core/src/playwright-browser-driver.test.ts packages/core/src/visual-png.test.ts packages/core/src/visual-verification.test.ts packages/mcp-server/src/server.test.ts packages/mcp-server/src/structured-results.test.ts packages/mcp-server/src/tool-context.browser.test.ts --no-file-parallelism
```

Expected: PASS.

- [ ] **Step 2: Run full TypeScript gates**

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm verify:forbidden
pnpm verify:package
```

Expected: PASS. If the full test wall time exceeds a connector command timeout only after Vitest prints complete PASS totals, rerun authoritative subsets individually and use host CI as the full timeout-unbounded gate rather than treating timeout as a functional failure.

- [ ] **Step 3: Run Rust/protocol formatting gates**

```bash
cargo fmt --all -- --check
cargo check --workspace
```

No Rust production code is expected to change; these gates prove no cross-language regression.

- [ ] **Step 4: Run diff hygiene**

```bash
git diff --check db1407e65a76f39c975e4ea2e101090e23285201...HEAD
git status --short
```

Expected: no whitespace errors; only intended Phase 3 files changed.

- [ ] **Step 5: Write readiness evidence**

Record exact feature head, changed-file list, focused/full test totals, typecheck/build/Rust/package/forbidden results, authority audit, expected surface 0.13/74, and any host-only gates deferred to CI. Do not claim live acceptance yet.

- [ ] **Step 6: Commit readiness record**

```bash
git add docs/release/2026-08-19-visual-verification-readiness.md .ai-bridge/current-plan.md
git commit -m "docs: record visual verification readiness"
```

---

### Task 7: Independent Review, PR, CI, Merge, Release, and Live Acceptance

**Files:**
- Review exact diff from baseline; no planned source changes unless review/CI exposes a defect.
- Update readiness/closure evidence with final PR/CI/merge/release/acceptance identifiers.

**Interfaces:**
- Consumes: exact feature head from Task 6.
- Produces: merged and live Phase 3 closure.

- [ ] **Step 1: Independent exact-diff review**

Review `db1407e...HEAD` against the Phase 3 spec, especially authority widening, artifact bounds, PNG allocation safety, matrix restoration, schema closure, error normalization, and tool-count/version exactness. Any substantive finding returns to TDD RED/GREEN before proceeding.

- [ ] **Step 2: Push exact feature branch and create PR**

Push `feat/visual-verification` without force, confirm remote head equals local head, then create a PR to `main` titled `feat: add visual verification` (or equivalent) with scope/tests/authority notes.

- [ ] **Step 3: Require exact-head deterministic CI**

Inspect CI on the exact PR head. If a gate fails, obtain bounded failure evidence, fix via TDD, push a new exact head, and require green CI on that new head before merge.

- [ ] **Step 4: Merge with expected-head protection**

Merge only when the PR head OID matches the accepted reviewed/green head. Record merge commit, fast-forward canonical local `main`, and verify `main == origin/main` clean.

- [ ] **Step 5: Require merged-main CI**

Require deterministic merged-main CI, including clean-install package smoke, before release cutover.

- [ ] **Step 6: Build immutable merged-main release and cut over**

Use the existing service-release mechanism only. Build/stage the immutable release from the exact clean merge commit, verify provenance (`sourceRevision`, `sourceDirty=false`, CLI/runtime hashes/pair ID), preserve the prior active release as rollback, perform explicit service restart/cutover, and verify `system.health` plus `0.1 / 2026-07-28 / 0.13` and exactly 74 tools.

- [ ] **Step 7: Direct live Visual Verification acceptance**

Use an actual live preview and browser session. Because a same-chat connector may cache the pre-change 0.12 schema, use the exact active-release host-side MCP/stdio bridge if the top-level connector cannot expose the newly added `visual.*` methods; this still exercises the real installed 0.13 service/runtime rather than mocks.

Acceptance sequence:

1. start one disposable preview fixture and verify running/reachable/HTTP 200;
2. open the preview browser at a known viewport;
3. call `visual.captureMatrix` and assert exactly the three fixed artifact/viewports;
4. restore/open the matching viewport and call `visual.compare` using an identical captured artifact reference at threshold 0 -> `passed:true`, ratio 0;
5. compare at a mismatched viewport or after deliberate render change -> `passed:false` with dimension mismatch and/or non-zero ratio;
6. verify preview remains running/reachable after visual operations;
7. stop/release browser/preview/process and verify no leak;
8. verify canonical Git tree clean.

- [ ] **Step 8: Close Phase 3 only after acceptance PASS**

Update final closure/readiness evidence with PR number, accepted head, CI run IDs, merge SHA, merged-main CI, immutable release/rollback IDs, provenance hashes, live surface/tool count, and direct acceptance evidence. Only then mark Phase 3 COMPLETE. Do not start Typed Preview Deployment in this branch/session.
