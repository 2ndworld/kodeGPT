# KodeGPT Preview-Scoped Browser Evidence Design

Date: 2026-08-18
Status: implementation authority for Phase 2 of the audited application-development roadmap

## Problem

Bounded previews now provide an authoritative KodeGPT-owned loopback origin, but application development still lacks typed browser evidence. A generic browser URL surface would widen KodeGPT into arbitrary web/desktop automation and duplicate GPT Web. The browser must therefore be attached only to a live preview identity and expose bounded evidence/actions needed for local UI verification.

## Goal

Add one ephemeral browser session per live preview, navigated only to the preview's stored exact origin, with bounded DOM/accessibility inspection, click/type interaction, PNG screenshot artifacts, console evidence, and failed-request evidence.

## Public surface

Add exactly seven tools:

- `browser.openPreview({workspaceId, previewId, viewport?})`
- `browser.inspect({workspaceId, previewId})`
- `browser.click({workspaceId, previewId, target})`
- `browser.type({workspaceId, previewId, target, text, submit?})`
- `browser.screenshot({workspaceId, previewId, fullPage?})`
- `browser.console({workspaceId, previewId})`
- `browser.networkFailures({workspaceId, previewId})`

`target` is a discriminated union: `{kind:"css", selector}` or `{kind:"role", role, name?}`. Text, selectors, role/name, evidence collections, and screenshots are hard bounded.

## Browser authority

`BrowserManager` lives in `@kodegpt/core` and composes two narrow dependencies:

1. `PreviewBrowserAdapter.inspect(workspaceId, previewId)` to resolve the authoritative live preview URL. No browser method accepts a URL, host, scheme, or port.
2. `BrowserArtifactWriter.write(mediaType, bytes)` to persist screenshots into the existing raw artifact spool.

Production uses Playwright Core with the installed Google Chrome channel. Launch is headless with Chromium sandbox enabled. Contexts disable downloads and use deterministic locale/color-scheme settings. Browser contexts/pages are ephemeral and never persisted.

Before open and every operation, the manager requires the preview to exist, be `running`, and be reachable. The preview URL must parse as HTTP with hostname exactly `127.0.0.1`. The manager stores the exact origin and closes the session if preview identity or origin no longer matches.

Top-level document navigation is restricted to the exact stored preview origin. Page-created extra tabs/windows are immediately closed. Cross-origin subresources requested by the page remain governed by the browser/current network policy, matching the audited roadmap, but browser APIs never expose arbitrary navigation.

## Evidence bounds

- inspect: title, URL, viewport, body text preview, and ARIA snapshot; combined evidence capped at 32 KiB with explicit truncation flags.
- console: ring buffer of at most 100 normalized entries; each text value at most 2 KiB; no handles/objects/raw stack payloads.
- network failures: ring buffer of at most 100 failed requests; URL redacted to origin + pathname + query removed, method/resource type/failure text bounded.
- screenshot: PNG only, at most 5 MiB. The response returns normal public artifact metadata and viewport dimensions, never base64 image bytes inline. The 5 MiB raw cap leaves deterministic headroom for base64 plus JSON inside the existing 8 MiB runtime frame limit.
- interactions: action timeout 5 seconds; type text at most 16 KiB; CSS selector/name at most 2 KiB.

## Artifact ingestion

The existing Rust `RawSpoolStore` remains the only artifact authority. Add private runtime method `artifact.write` taking media type plus bounded base64 bytes. It validates canonical base64, decodes at most 5 MiB, creates one raw spool artifact through existing retention/audit/0600 protections, writes bytes, and returns existing opaque artifact metadata. This method is internal kernel transport only; no new public MCP `artifact.write` tool is added.

`@kodegpt/artifacts` gains `ArtifactStore.write(mediaType, bytes)` which calls the private runtime method and returns public opaque metadata.

## Lifecycle

A browser session is keyed by `(workspaceId, previewId)`. `openPreview` is idempotent for the same live preview and returns current session metadata. Maximum sessions: 8 globally.

`BrowserManager.releasePreview(workspaceId, previewId)` closes the page/context/browser and deletes buffers. `releaseWorkspace(workspaceId)` closes all matching sessions. MCP preview stop wiring releases the browser before stopping the preview; workspace close releases browser sessions only after workspace close succeeds. Unexpected browser disconnect evicts the session.

## Errors

Stable core errors:

- `BROWSER_PREVIEW_NOT_READY`
- `BROWSER_SESSION_NOT_FOUND`
- `BROWSER_LIMIT_REACHED`
- `BROWSER_ORIGIN_INVALID`
- `BROWSER_TARGET_INVALID`
- `BROWSER_ACTION_FAILED`
- `BROWSER_SCREENSHOT_TOO_LARGE`
- `BROWSER_UNAVAILABLE`

Existing preview/runtime/artifact errors pass through where appropriate. Public MCP errors expose only stable codes and generic messages.

## MCP/versioning

Bump MCP surface `0.11 -> 0.12`; public tool count `65 -> 72`. Runtime version remains `0.1`; protocol identifier remains `2026-07-28` because `artifact.write` is an internal kernel method within the same runtime protocol family and is not a public MCP protocol change.

## Testing

TDD must cover: exact preview-origin binding; no arbitrary URL input; invalid/non-loopback origin rejection; live-preview requirement; session cap; idempotent open; CSS/role targets; click/type dispatch; bounded inspect/console/network evidence; external top-level navigation abort; popup closing; PNG artifact persistence/readback; screenshot size cap; preview/workspace lifecycle cleanup; browser disconnect cleanup; private artifact.write strict parsing/size/audit; exact MCP tools/schemas/count/version; production stack injection; and a host spike proving Playwright Core can launch installed Chrome with sandbox and load a real KodeGPT preview.

## Non-goals

No arbitrary URL navigation, generic HTTP client, JavaScript evaluate, file upload/download, cookie/storage export, browser extension control, desktop/OS input, persistent browser profiles, multiple pages, remote browsers, video/trace recording, visual diffing, deployment, or public artifact mutation tool in this phase.
