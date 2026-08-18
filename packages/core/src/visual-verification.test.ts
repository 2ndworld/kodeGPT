import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type {
  BrowserArtifactMetadata,
  BrowserInspectResult,
  BrowserOpenResult,
  BrowserScreenshotResult,
  BrowserViewport
} from "./browser-manager.js";
import {
  VISUAL_ARTIFACT_READ_CHUNK_BYTES,
  VISUAL_VIEWPORT_MATRIX,
  VisualVerificationError,
  VisualVerificationManager,
  type VisualArtifactReadResult,
  type VisualArtifactReader,
  type VisualBrowserAdapter
} from "./visual-verification.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngChunk(type: string, data: Uint8Array): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.byteLength, 0);
  Buffer.from(type, "ascii").copy(header, 4);
  return Buffer.concat([header, Buffer.from(data), Buffer.alloc(4)]);
}

function makeRgbaPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rowBytes = width * 4;
  const scanlines: Buffer[] = [];
  for (let row = 0; row < height; row += 1) {
    scanlines.push(Buffer.from([0]), Buffer.from(rgba.subarray(row * rowBytes, (row + 1) * rowBytes)));
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(scanlines))),
    pngChunk("IEND", new Uint8Array())
  ]);
}

function artifact(uri: string): BrowserArtifactMetadata {
  return {
    schemaVersion: 1,
    uri,
    mediaType: "image/png",
    sizeBytes: 64,
    sourceTruncated: false
  };
}

class FakeVisualBrowser implements VisualBrowserAdapter {
  viewport: BrowserViewport = { width: 1280, height: 720 };
  readonly resizes: BrowserViewport[] = [];
  readonly screenshots: Array<{ viewport: BrowserViewport; fullPage: boolean }> = [];
  screenshotErrorAt: number | null = null;
  resizeErrorAt: number | null = null;
  screenshotArtifact = artifact("artifact://ka_current");

  async inspect(input: { workspaceId: string; previewId: string }): Promise<BrowserInspectResult> {
    return {
      schemaVersion: 1,
      previewId: input.previewId,
      url: "http://127.0.0.1:4173/",
      viewport: { ...this.viewport },
      title: "Fixture",
      bodyText: "fixture",
      ariaSnapshot: "",
      truncated: false,
      truncationReasons: []
    };
  }

  async setViewport(input: {
    workspaceId: string;
    previewId: string;
    viewport: BrowserViewport;
  }): Promise<BrowserOpenResult> {
    const callIndex = this.resizes.length;
    this.resizes.push({ ...input.viewport });
    if (this.resizeErrorAt === callIndex) throw new Error("resize failed");
    this.viewport = { ...input.viewport };
    return {
      schemaVersion: 1,
      previewId: input.previewId,
      url: "http://127.0.0.1:4173/",
      viewport: { ...this.viewport }
    };
  }

  async screenshot(input: {
    workspaceId: string;
    previewId: string;
    fullPage?: boolean;
  }): Promise<BrowserScreenshotResult> {
    const callIndex = this.screenshots.length;
    this.screenshots.push({ viewport: { ...this.viewport }, fullPage: input.fullPage ?? false });
    if (this.screenshotErrorAt === callIndex) throw new Error("capture failed");
    return {
      schemaVersion: 1,
      previewId: input.previewId,
      artifact: { ...this.screenshotArtifact, uri: `${this.screenshotArtifact.uri}_${callIndex}` },
      viewport: { ...this.viewport }
    };
  }
}

class FakeArtifactReader implements VisualArtifactReader {
  readonly data = new Map<string, Uint8Array>();
  readonly reads: Array<{ uri: string; offset: number; maxBytes: number }> = [];

  async read(
    uri: string,
    options: { offset?: number; maxBytes?: number } = {}
  ): Promise<VisualArtifactReadResult> {
    const bytes = this.data.get(uri);
    if (!bytes) throw new Error(`missing artifact: ${uri}`);
    const offset = options.offset ?? 0;
    const maxBytes = options.maxBytes ?? VISUAL_ARTIFACT_READ_CHUNK_BYTES;
    this.reads.push({ uri, offset, maxBytes });
    const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + maxBytes));
    return {
      schemaVersion: 1,
      uri,
      dataBase64: Buffer.from(chunk).toString("base64"),
      bytesRead: chunk.byteLength,
      nextOffset: offset + chunk.byteLength,
      eof: offset + chunk.byteLength >= bytes.byteLength
    };
  }
}

function fixture() {
  const browser = new FakeVisualBrowser();
  const artifacts = new FakeArtifactReader();
  return {
    browser,
    artifacts,
    manager: new VisualVerificationManager(browser, artifacts)
  };
}

describe("VisualVerificationManager responsive capture", () => {
  it("captures the exact fixed matrix sequentially and restores the original viewport", async () => {
    const test = fixture();

    const result = await test.manager.captureMatrix({ workspaceId: "ws_test", previewId: "pv_test" });

    expect(VISUAL_VIEWPORT_MATRIX).toEqual([
      { name: "mobile", viewport: { width: 390, height: 844 } },
      { name: "tablet", viewport: { width: 768, height: 1024 } },
      { name: "desktop", viewport: { width: 1440, height: 900 } }
    ]);
    expect(result.captures.map(({ name, viewport }) => ({ name, viewport }))).toEqual(VISUAL_VIEWPORT_MATRIX);
    expect(test.browser.screenshots).toEqual([
      { viewport: { width: 390, height: 844 }, fullPage: false },
      { viewport: { width: 768, height: 1024 }, fullPage: false },
      { viewport: { width: 1440, height: 900 }, fullPage: false }
    ]);
    expect(test.browser.resizes).toEqual([
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
      { width: 1440, height: 900 },
      { width: 1280, height: 720 }
    ]);
    expect(test.browser.viewport).toEqual({ width: 1280, height: 720 });
  });

  it("restores the original viewport after a capture failure without hiding the primary error", async () => {
    const test = fixture();
    test.browser.screenshotErrorAt = 1;

    await expect(
      test.manager.captureMatrix({ workspaceId: "ws_test", previewId: "pv_test" })
    ).rejects.toMatchObject({ code: "VISUAL_ACTION_FAILED", message: expect.stringContaining("capture failed") });
    expect(test.browser.resizes.at(-1)).toEqual({ width: 1280, height: 720 });
    expect(test.browser.viewport).toEqual({ width: 1280, height: 720 });
  });
});

describe("VisualVerificationManager comparison", () => {
  it("captures current evidence itself, reads artifacts in bounded chunks, and passes an exact match", async () => {
    const test = fixture();
    const pixels = Uint8Array.from([0, 0, 0, 255, 10, 20, 30, 255]);
    const png = makeRgbaPng(2, 1, pixels);
    const currentUri = "artifact://ka_current_0";
    const referenceUri = "artifact://ka_reference";
    test.artifacts.data.set(currentUri, png);
    test.artifacts.data.set(referenceUri, png);

    const result = await test.manager.compare({
      workspaceId: "ws_test",
      previewId: "pv_test",
      referenceArtifact: referenceUri
    });

    expect(test.browser.screenshots).toEqual([{ viewport: { width: 1280, height: 720 }, fullPage: false }]);
    expect(result.currentArtifact.uri).toBe(currentUri);
    expect(result.referenceArtifact).toBe(referenceUri);
    expect(result.dimensionsMatch).toBe(true);
    expect(result.changedPixels).toBe(0);
    expect(result.changedPixelRatio).toBe(0);
    expect(result.threshold).toBe(0);
    expect(result.passed).toBe(true);
    expect(test.artifacts.reads.every((read) => read.maxBytes <= 1024 * 1024)).toBe(true);
  });

  it("applies the exact threshold boundary to changed pixels", async () => {
    const test = fixture();
    const currentUri = "artifact://ka_current_0";
    const referenceUri = "artifact://ka_reference";
    test.artifacts.data.set(
      currentUri,
      makeRgbaPng(2, 1, Uint8Array.from([0, 0, 0, 255, 10, 20, 30, 255]))
    );
    test.artifacts.data.set(
      referenceUri,
      makeRgbaPng(2, 1, Uint8Array.from([0, 0, 0, 255, 10, 20, 31, 255]))
    );

    const result = await test.manager.compare({
      workspaceId: "ws_test",
      previewId: "pv_test",
      referenceArtifact: referenceUri,
      threshold: 0.5
    });

    expect(result.changedPixels).toBe(1);
    expect(result.changedPixelRatio).toBe(0.5);
    expect(result.passed).toBe(true);
  });

  it("rejects non-artifact reference inputs before capture", async () => {
    const test = fixture();
    await expect(
      test.manager.compare({
        workspaceId: "ws_test",
        previewId: "pv_test",
        referenceArtifact: "file:///tmp/reference.png"
      })
    ).rejects.toMatchObject({ code: "VISUAL_INPUT_INVALID" });
    expect(test.browser.screenshots).toHaveLength(0);
  });

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid threshold %s",
    async (threshold) => {
      const test = fixture();
      await expect(
        test.manager.compare({
          workspaceId: "ws_test",
          previewId: "pv_test",
          referenceArtifact: "artifact://ka_reference",
          threshold
        })
      ).rejects.toMatchObject({ code: "VISUAL_INPUT_INVALID" });
      expect(test.browser.screenshots).toHaveLength(0);
    }
  );

  it("fails dimension mismatch even when the changed-pixel threshold would otherwise admit it", async () => {
    const test = fixture();
    const currentUri = "artifact://ka_current_0";
    const referenceUri = "artifact://ka_reference";
    test.artifacts.data.set(
      currentUri,
      makeRgbaPng(2, 1, Uint8Array.from([0, 0, 0, 255, 10, 20, 30, 255]))
    );
    test.artifacts.data.set(referenceUri, makeRgbaPng(1, 1, Uint8Array.from([0, 0, 0, 255])));

    const result = await test.manager.compare({
      workspaceId: "ws_test",
      previewId: "pv_test",
      referenceArtifact: referenceUri,
      threshold: 1
    });

    expect(result.dimensionsMatch).toBe(false);
    expect(result.changedPixelRatio).toBe(0.5);
    expect(result.passed).toBe(false);
  });

  it("rejects artifacts that exceed the bounded 5 MiB read budget", async () => {
    const test = fixture();
    const currentUri = "artifact://ka_current_0";
    const referenceUri = "artifact://ka_reference";
    const png = makeRgbaPng(1, 1, Uint8Array.from([0, 0, 0, 255]));
    test.artifacts.data.set(currentUri, png);
    test.artifacts.data.set(referenceUri, new Uint8Array(5 * 1024 * 1024 + 1));

    await expect(
      test.manager.compare({
        workspaceId: "ws_test",
        previewId: "pv_test",
        referenceArtifact: referenceUri
      })
    ).rejects.toMatchObject({ code: "VISUAL_ARTIFACT_TOO_LARGE" });
    expect(test.artifacts.reads.filter((read) => read.uri === referenceUri)).toHaveLength(5);
  });

  it("wraps unexpected artifact-read failures without widening error detail", async () => {
    const test = fixture();
    test.artifacts.data.set(
      "artifact://ka_current_0",
      makeRgbaPng(1, 1, Uint8Array.from([0, 0, 0, 255]))
    );

    await expect(
      test.manager.compare({
        workspaceId: "ws_test",
        previewId: "pv_test",
        referenceArtifact: "artifact://ka_missing"
      })
    ).rejects.toBeInstanceOf(VisualVerificationError);
  });
});
