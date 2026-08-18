import { describe, expect, it } from "vitest";

import {
  isAllowedPreviewDocumentUrl,
  isAllowedPreviewRequest
} from "./playwright-browser-driver.js";

describe("Playwright preview navigation guard", () => {
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
});
