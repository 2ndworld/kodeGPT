import type {
  BrowserArtifactMetadata,
  BrowserInspectResult,
  BrowserOpenResult,
  BrowserScreenshotResult,
  BrowserViewport
} from "./browser-manager.js";
import type { EvidenceSourceStateRef } from "./preview-manager.js";
import {
  VISUAL_ARTIFACT_MAX_BYTES,
  VisualVerificationError,
  compareVisualPixels,
  decodeVisualPng,
  type VisualDimensions
} from "./visual-png.js";

export const VISUAL_ARTIFACT_READ_CHUNK_BYTES = 1024 * 1024;

export const VISUAL_VIEWPORT_MATRIX = Object.freeze([
  Object.freeze({ name: "mobile" as const, viewport: Object.freeze({ width: 390, height: 844 }) }),
  Object.freeze({ name: "tablet" as const, viewport: Object.freeze({ width: 768, height: 1024 }) }),
  Object.freeze({ name: "desktop" as const, viewport: Object.freeze({ width: 1440, height: 900 }) })
]);

export interface VisualPreviewInput {
  workspaceId: string;
  previewId: string;
}

export interface VisualCompareInput extends VisualPreviewInput {
  referenceArtifact: string;
  threshold?: number;
}

export interface VisualArtifactReadResult {
  schemaVersion: 1;
  uri: string;
  dataBase64: string;
  bytesRead: number;
  nextOffset: number;
  eof: boolean;
}

export interface VisualArtifactReader {
  read(
    uri: string,
    options?: { offset?: number; maxBytes?: number }
  ): Promise<VisualArtifactReadResult>;
}

export interface VisualBrowserAdapter {
  inspect(input: VisualPreviewInput): Promise<BrowserInspectResult>;
  setViewport(input: VisualPreviewInput & { viewport: BrowserViewport }): Promise<BrowserOpenResult>;
  screenshot(input: VisualPreviewInput & { fullPage?: boolean }): Promise<BrowserScreenshotResult>;
}

export type VisualViewportName = (typeof VISUAL_VIEWPORT_MATRIX)[number]["name"];

export interface VisualCaptureEntry {
  name: VisualViewportName;
  viewport: BrowserViewport;
  artifact: BrowserArtifactMetadata;
}

export interface VisualCaptureMatrixResult {
  schemaVersion: 1;
  previewId: string;
  captures: VisualCaptureEntry[];
  sourceState: EvidenceSourceStateRef;
}

export interface VisualCompareResult {
  schemaVersion: 1;
  previewId: string;
  sourceState: EvidenceSourceStateRef;
  currentArtifact: BrowserArtifactMetadata;
  referenceArtifact: string;
  currentDimensions: VisualDimensions;
  referenceDimensions: VisualDimensions;
  dimensionsMatch: boolean;
  changedPixels: number;
  totalPixels: number;
  changedPixelRatio: number;
  threshold: number;
  passed: boolean;
}

const ARTIFACT_URI = /^artifact:\/\/ka_[A-Za-z0-9_-]{1,93}$/;

function hasStableComposedCode(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === "string" &&
    (code.startsWith("BROWSER_") || code.startsWith("ARTIFACT_") || code.startsWith("VISUAL_"))
  );
}

function actionError(error: unknown, action: string): unknown {
  if (hasStableComposedCode(error)) return error;
  return new VisualVerificationError("VISUAL_ACTION_FAILED", `${action}: ${String(error)}`);
}

function validateCompareInput(input: VisualCompareInput): number {
  if (!ARTIFACT_URI.test(input.referenceArtifact)) {
    throw new VisualVerificationError("VISUAL_INPUT_INVALID", "visual reference artifact is invalid");
  }
  const threshold = input.threshold ?? 0;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new VisualVerificationError("VISUAL_INPUT_INVALID", "visual comparison threshold is invalid");
  }
  return threshold;
}

async function readArtifactFully(reader: VisualArtifactReader, uri: string): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    if (offset >= VISUAL_ARTIFACT_MAX_BYTES) {
      throw new VisualVerificationError(
        "VISUAL_ARTIFACT_TOO_LARGE",
        "visual artifact exceeds the bounded read limit"
      );
    }
    const maxBytes = Math.min(
      VISUAL_ARTIFACT_READ_CHUNK_BYTES,
      VISUAL_ARTIFACT_MAX_BYTES - offset
    );
    let result: VisualArtifactReadResult;
    try {
      result = await reader.read(uri, { offset, maxBytes });
    } catch (error) {
      throw actionError(error, "visual artifact read failed");
    }
    let decoded: Buffer;
    try {
      decoded = Buffer.from(result.dataBase64, "base64");
    } catch (error) {
      throw actionError(error, "visual artifact decode failed");
    }
    if (
      result.uri !== uri ||
      result.bytesRead !== decoded.byteLength ||
      result.nextOffset !== offset + result.bytesRead ||
      result.bytesRead > maxBytes ||
      result.bytesRead < 0
    ) {
      throw new VisualVerificationError("VISUAL_ACTION_FAILED", "visual artifact read contract is invalid");
    }
    parts.push(decoded);
    offset = result.nextOffset;
    if (result.eof) return Buffer.concat(parts, offset);
    if (result.bytesRead === 0) {
      throw new VisualVerificationError("VISUAL_ACTION_FAILED", "visual artifact read made no progress");
    }
  }
}

export class VisualVerificationManager {
  readonly #browser: VisualBrowserAdapter;
  readonly #artifacts: VisualArtifactReader;

  constructor(browser: VisualBrowserAdapter, artifacts: VisualArtifactReader) {
    this.#browser = browser;
    this.#artifacts = artifacts;
  }

  async captureMatrix(input: VisualPreviewInput): Promise<VisualCaptureMatrixResult> {
    let inspected: BrowserInspectResult;
    try {
      inspected = await this.#browser.inspect(input);
    } catch (error) {
      throw actionError(error, "visual browser inspect failed");
    }
    const originalViewport = { ...inspected.viewport };
    const captures: VisualCaptureEntry[] = [];
    let primaryError: unknown;

    try {
      for (const entry of VISUAL_VIEWPORT_MATRIX) {
        try {
          await this.#browser.setViewport({ ...input, viewport: { ...entry.viewport } });
          const screenshot = await this.#browser.screenshot({ ...input, fullPage: false });
          captures.push({
            name: entry.name,
            viewport: { ...entry.viewport },
            artifact: { ...screenshot.artifact }
          });
        } catch (error) {
          primaryError = actionError(error, "visual matrix capture failed");
          break;
        }
      }
    } finally {
      try {
        await this.#browser.setViewport({ ...input, viewport: originalViewport });
      } catch (error) {
        if (primaryError === undefined) {
          primaryError = actionError(error, "visual viewport restore failed");
        }
      }
    }

    if (primaryError !== undefined) throw primaryError;
    return {
      schemaVersion: 1,
      previewId: input.previewId,
      captures,
      sourceState: { ...inspected.sourceState }
    };
  }

  async compare(input: VisualCompareInput): Promise<VisualCompareResult> {
    const threshold = validateCompareInput(input);
    let current: BrowserScreenshotResult;
    try {
      current = await this.#browser.screenshot({
        workspaceId: input.workspaceId,
        previewId: input.previewId,
        fullPage: false
      });
    } catch (error) {
      throw actionError(error, "visual current capture failed");
    }

    const [currentBytes, referenceBytes] = await Promise.all([
      readArtifactFully(this.#artifacts, current.artifact.uri),
      readArtifactFully(this.#artifacts, input.referenceArtifact)
    ]);
    const comparison = compareVisualPixels(
      decodeVisualPng(currentBytes),
      decodeVisualPng(referenceBytes)
    );

    return {
      schemaVersion: 1,
      previewId: input.previewId,
      sourceState: { ...current.sourceState },
      currentArtifact: { ...current.artifact },
      referenceArtifact: input.referenceArtifact,
      currentDimensions: comparison.currentDimensions,
      referenceDimensions: comparison.referenceDimensions,
      dimensionsMatch: comparison.dimensionsMatch,
      changedPixels: comparison.changedPixels,
      totalPixels: comparison.totalPixels,
      changedPixelRatio: comparison.changedPixelRatio,
      threshold,
      passed: comparison.dimensionsMatch && comparison.changedPixelRatio <= threshold
    };
  }
}

export { VisualVerificationError } from "./visual-png.js";
export type { VisualVerificationErrorCode } from "./visual-png.js";
