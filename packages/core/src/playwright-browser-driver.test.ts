import { describe, expect, it } from "vitest";

import {
  BROWSER_FULL_PAGE_MAX_PIXELS,
  fullPageScreenshotGeometry,
  isAllowedPreviewDocumentUrl,
  isAllowedPreviewRequest,
  isAllowedPreviewWebSocket,
  isCurrentPreviewWebSocketAllowed,
  isScreenshotGeometryAllowed,
  toPlaywrightCssSelector
} from "./playwright-browser-driver.js";

describe("Playwright preview navigation guard", () => {
  it("forces kind css targets through the CSS selector engine", () => {
    expect(toPlaywrightCssSelector("#save")).toBe("css=#save");
    expect(toPlaywrightCssSelector("xpath=//button")).toBe("css=xpath=//button");
  });

  it("allows only documents on the exact stored preview origin", () => {
    const origin = "http://127.0.0.1:4173";
    expect(isAllowedPreviewDocumentUrl(origin, "http://127.0.0.1:4173/")).toBe(true);
    expect(isAllowedPreviewDocumentUrl(origin, "http://127.0.0.1:4173/path?x=1#fragment")).toBe(true);
    expect(isAllowedPreviewDocumentUrl(origin, "http://127.0.0.1:4174/")).toBe(false);
    expect(isAllowedPreviewDocumentUrl(origin, "http://localhost:4173/")).toBe(false);
    expect(isAllowedPreviewDocumentUrl(origin, "https://127.0.0.1:4173/")).toBe(false);
    expect(isAllowedPreviewDocumentUrl(origin, "https://example.test/")).toBe(false);
    expect(isAllowedPreviewDocumentUrl(origin, "not a url")).toBe(false);
  });

  it("re-applies workspace network policy to page-initiated subresources", () => {
    const origin = "http://127.0.0.1:4173";
    expect(isAllowedPreviewRequest(origin, "http://127.0.0.1:4173/app.js", "script", "deny")).toBe(true);
    expect(isAllowedPreviewRequest(origin, "https://cdn.example.test/app.js", "script", "deny")).toBe(false);
    expect(isAllowedPreviewRequest(origin, "http://127.0.0.1:9999/api", "fetch", "localhost")).toBe(true);
    expect(isAllowedPreviewRequest(origin, "https://cdn.example.test/app.js", "script", "localhost")).toBe(false);
    expect(isAllowedPreviewRequest(origin, "https://cdn.example.test/app.js", "script", "unrestricted")).toBe(true);
    expect(isAllowedPreviewRequest(origin, "https://cdn.example.test/page", "document", "unrestricted")).toBe(false);
    expect(isAllowedPreviewRequest(origin, "https://cdn.example.test/app.js", "script", "allowlist")).toBe(false);
  });

  it("applies the same bounded authority to WebSocket connections", () => {
    const origin = "http://127.0.0.1:4173";
    expect(isAllowedPreviewWebSocket(origin, "ws://127.0.0.1:4173/socket", "deny")).toBe(true);
    expect(isAllowedPreviewWebSocket(origin, "ws://127.0.0.1:4174/socket", "deny")).toBe(false);
    expect(isAllowedPreviewWebSocket(origin, "ws://127.0.0.1:9999/socket", "localhost")).toBe(true);
    expect(isAllowedPreviewWebSocket(origin, "wss://example.test/socket", "localhost")).toBe(false);
    expect(isAllowedPreviewWebSocket(origin, "wss://example.test/socket", "unrestricted")).toBe(true);
    expect(isAllowedPreviewWebSocket(origin, "https://example.test/not-websocket", "unrestricted")).toBe(false);
  });

  it("re-evaluates active WebSocket authority when workspace policy tightens", async () => {
    const origin = "http://127.0.0.1:4173";
    const external = "wss://example.test/socket";
    let mode: "unrestricted" | "deny" = "unrestricted";
    let fail = false;
    const resolve = () => {
      if (fail) throw new Error("policy unavailable");
      return mode;
    };

    expect(await isCurrentPreviewWebSocketAllowed(origin, external, resolve)).toBe(true);
    mode = "deny";
    expect(await isCurrentPreviewWebSocketAllowed(origin, external, resolve)).toBe(false);
    fail = true;
    expect(await isCurrentPreviewWebSocketAllowed(origin, external, resolve)).toBe(false);
  });

  it("rejects oversized full-page screenshot geometry before capture", () => {
    expect(isScreenshotGeometryAllowed(3840, 2160)).toBe(true);
    expect(isScreenshotGeometryAllowed(3840, 2161)).toBe(false);
    expect(isScreenshotGeometryAllowed(BROWSER_FULL_PAGE_MAX_PIXELS, 1)).toBe(true);
    expect(isScreenshotGeometryAllowed(BROWSER_FULL_PAGE_MAX_PIXELS + 1, 1)).toBe(false);
  });

  it("derives full-page bounds from scrollable document dimensions rather than element boxes", () => {
    expect(
      fullPageScreenshotGeometry({
        contentSize: { width: 1280, height: 20_000 },
        viewport: { width: 1280, height: 720 }
      })
    ).toEqual({ width: 1280, height: 20_000 });
  });
});
