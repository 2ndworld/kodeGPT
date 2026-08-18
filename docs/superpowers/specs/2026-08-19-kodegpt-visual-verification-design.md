# KodeGPT Visual Verification Design

Date: 2026-08-19
Status: implementation authority for Phase 3 of the audited application-development roadmap
Baseline: `db1407e65a76f39c975e4ea2e101090e23285201`

## Problem

Phase 2 provides preview-scoped browser sessions and bounded PNG screenshot artifacts, but application development still requires callers to manually coordinate responsive screenshots and reason about whether a current render differs from a known reference. Visual Verification must add deterministic visual evidence without creating a second browser stack, adding arbitrary image/desktop authority, or moving visual interpretation into KodeGPT.

## Goal

Add a thin typed visual-verification layer that reuses the existing live preview browser session and artifact spool to:

1. capture a fixed responsive viewport matrix; and
2. compare the current viewport screenshot against one explicit PNG artifact reference using deterministic pixel equality.

KodeGPT reports bounded numeric evidence and artifact references. GPT Web/Codex/CodexPro remains responsible for interpreting what a visual difference means.

## Public surface

Add exactly two tools:

- `visual.captureMatrix({workspaceId, previewId})`
- `visual.compare({workspaceId, previewId, referenceArtifact, threshold?})`

No tool accepts a URL, host, file path, JavaScript expression, arbitrary viewport matrix, or baseline-update action.

Expected MCP surface after completion: `0.13`, exactly 74 public tools. Runtime version remains `0.1`; protocol identifier remains `2026-07-28`.

## Fixed viewport matrix

`visual.captureMatrix` captures exactly these viewport screenshots, in this order:

1. `mobile`: `390x844`
2. `tablet`: `768x1024`
3. `desktop`: `1440x900`

The manager uses the already-open preview-scoped browser session. It resizes that same page sequentially, captures ordinary viewport PNGs through the existing `BrowserManager.screenshot`, then restores the original viewport in a `finally` path. It does not open additional browser sessions or acquire screenshots outside the Phase 2 path.

Each result contains the matrix name, viewport, and normal screenshot artifact metadata. Matrix size and viewports are constants, not caller-controlled inputs.

## Browser composition

`BrowserDriverSession` gains an internal `setViewport(viewport)` operation implemented by Playwright `page.setViewportSize`. `BrowserManager` gains an internal typed `setViewport({workspaceId, previewId, viewport})` method. This method uses the same viewport validation and live-session checks as existing browser operations, updates the stored session viewport only after the driver resize succeeds, and is not registered as an MCP tool.

`VisualVerificationManager` lives in `@kodegpt/core` and depends only on a narrow browser adapter and artifact reader. Production wiring passes the existing `BrowserManager` and existing `ArtifactStore`; there is no second browser driver, artifact spool, process supervisor, or network authority.

## Comparison semantics

`visual.compare`:

1. requires an existing live browser session for `(workspaceId, previewId)`;
2. captures the current viewport using existing `BrowserManager.screenshot({fullPage:false})`;
3. reads both the newly captured current artifact and the explicit `referenceArtifact` URI from the existing artifact spool using bounded chunked reads;
4. validates and decodes both PNGs;
5. compares RGBA pixels at the same coordinates; and
6. returns dimensions, changed-pixel evidence, threshold, pass/fail, and artifact references.

`threshold` is the maximum allowed changed-pixel ratio. It defaults to `0` and must be a finite number in `[0,1]`.

A pixel is changed when any RGBA channel differs exactly. There is no perceptual tolerance, antialiasing heuristic, OCR, object detection, or semantic image interpretation.

For equal dimensions:

- `totalPixels = width * height`
- `changedPixels = count(currentRGBA != referenceRGBA)`
- `changedPixelRatio = changedPixels / totalPixels`

For unequal dimensions, comparison uses the union rectangle `max(width) * max(height)`. A coordinate that exists in only one image counts as changed. The union rectangle itself must not exceed `3840 * 2160` pixels; otherwise comparison fails closed with `VISUAL_ARTIFACT_TOO_LARGE`. This keeps CPU work bounded while forcing a dimension mismatch to contribute directly to deterministic failure evidence.

`passed` is true only when dimensions match and `changedPixelRatio <= threshold`.

The result includes:

- current and reference dimensions;
- `dimensionsMatch`;
- `changedPixels`;
- `totalPixels`;
- `changedPixelRatio`;
- `threshold`;
- `passed`;
- the newly captured current screenshot artifact metadata; and
- the explicit reference artifact URI.

## PNG and artifact bounds

Visual Verification accepts PNG artifacts only by validating the PNG signature and structure. Artifact reads are chunked through `ArtifactStore.read`, never host filesystem paths.

Hard bounds:

- maximum encoded artifact bytes: existing screenshot write limit, 5 MiB;
- maximum decoded pixels: `3840 * 2160`;
- supported PNG: bit depth 8, non-interlaced, color type RGB (2) or RGBA (6), compression method 0, filter method 0;
- decompressed scanline output must equal the exact bounded expected length;
- IDAT input and decoded buffers remain bounded by the encoded and pixel limits.

The decoder implements PNG scanline filters 0-4 and converts RGB to RGBA. Unsupported/malformed PNG input fails closed with a stable visual error. No image-processing dependency is added.

## Errors

Stable core visual errors:

- `VISUAL_INPUT_INVALID` — invalid threshold or malformed public input;
- `VISUAL_ARTIFACT_TOO_LARGE` — artifact exceeds the 5 MiB comparison bound;
- `VISUAL_PNG_INVALID` — malformed or unsupported PNG;
- `VISUAL_ACTION_FAILED` — browser resize/capture/restore or artifact-read failure that is not an existing browser error.

Existing `BrowserManagerError` and `ArtifactStoreError` codes pass through the existing MCP normalization path where appropriate. Public visual errors expose stable codes and generic bounded messages.

## Lifecycle and authority

Visual Verification creates no persistent records. Matrix capture and compare are synchronous compositions over an existing preview/browser session and existing artifact spool. Preview stop/workspace close continue to own browser lifecycle through the Phase 2 cleanup path.

No filesystem authority is added. No process authority is added. No network authority is added. No persistent baseline database is added. No automatic reference acceptance/update exists.

## MCP/versioning

Register exactly two new public tools and closed schemas. Update canonical surface fixtures and security invariants from 72 to 74 tools and surface `0.12 -> 0.13`.

Tool schemas:

- `visual.captureMatrix`: required `workspaceId`, `previewId`; no additional properties.
- `visual.compare`: required `workspaceId`, `previewId`, `referenceArtifact`; optional `threshold`; no additional properties. `referenceArtifact` must match the canonical `artifact://ka_...` URI shape.

Structured result schemas must be closed and verify fixed matrix names/viewports, artifact metadata, finite ratio bounds, and compare pass/fail fields.

## Testing

TDD must cover:

- internal browser resize uses the existing session and updates/restores viewport state;
- fixed matrix order and exact viewport constants;
- matrix captures exactly three screenshots through existing browser screenshot authority;
- restore executes after success and failure;
- artifact chunk reads remain bounded and reject >5 MiB references;
- PNG signature/IHDR validation, supported RGB/RGBA decode, all five filters, malformed/unsupported input rejection, and pixel-count bounds;
- equal-image comparison, single-pixel change, threshold boundary, and unequal-dimension union semantics;
- compare captures the current screenshot rather than accepting a caller-selected current artifact;
- exact MCP schemas, result schemas, tool count, surface version, and security invariants;
- production stack wiring reuses the same `BrowserManager` and `ArtifactStore` instances;
- deterministic full verification and direct live acceptance using an actual preview/browser session.

## Live acceptance

Phase 3 is complete only after merged-main release/cutover (because public MCP surface changes) and direct live acceptance proves:

1. `visual.captureMatrix` returns the three exact viewport artifacts while the preview remains running/reachable;
2. one returned artifact can be used as an explicit reference after restoring/opening the matching viewport;
3. `visual.compare` against an identical reference passes at threshold `0` with ratio `0`;
4. a deliberately changed render or mismatched viewport fails deterministically with non-zero ratio and/or dimension mismatch;
5. preview/browser/process cleanup still succeeds and the canonical Git tree returns clean.

## Non-goals

No perceptual diffing, AI/CV inference, OCR, baseline database, automatic baseline updates, arbitrary viewport lists, full-page matrix capture, arbitrary file-path image loading, arbitrary browser navigation, JavaScript evaluate, deployment, or Typed Preview Deployment work in this phase.
