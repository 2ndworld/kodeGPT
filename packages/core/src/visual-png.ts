import { inflateSync } from "node:zlib";

export const VISUAL_ARTIFACT_MAX_BYTES = 5 * 1024 * 1024;
export const VISUAL_MAX_PIXELS = 3840 * 2160;

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

export type VisualVerificationErrorCode =
  | "VISUAL_INPUT_INVALID"
  | "VISUAL_ARTIFACT_TOO_LARGE"
  | "VISUAL_PNG_INVALID"
  | "VISUAL_ACTION_FAILED";

export class VisualVerificationError extends Error {
  constructor(
    readonly code: VisualVerificationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "VisualVerificationError";
  }
}

export interface DecodedVisualPng {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface VisualDimensions {
  width: number;
  height: number;
}

export interface VisualPixelComparison {
  currentDimensions: VisualDimensions;
  referenceDimensions: VisualDimensions;
  dimensionsMatch: boolean;
  changedPixels: number;
  totalPixels: number;
  changedPixelRatio: number;
}

interface PngHeader {
  width: number;
  height: number;
  colorType: 2 | 6;
  bytesPerPixel: 3 | 4;
}

function pngInvalid(message: string): VisualVerificationError {
  return new VisualVerificationError("VISUAL_PNG_INVALID", message);
}

function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PNG_SIGNATURE.byteLength) return false;
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function parseHeader(data: Uint8Array): PngHeader {
  if (data.byteLength !== 13) throw pngInvalid("visual PNG IHDR is invalid");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(0, false);
  const height = view.getUint32(4, false);
  const bitDepth = data[8];
  const colorType = data[9];
  const compression = data[10];
  const filterMethod = data[11];
  const interlace = data[12];
  if (width === 0 || height === 0) throw pngInvalid("visual PNG dimensions are invalid");
  if (width * height > VISUAL_MAX_PIXELS) {
    throw new VisualVerificationError(
      "VISUAL_ARTIFACT_TOO_LARGE",
      "visual PNG dimensions exceed the bounded pixel limit"
    );
  }
  if (
    bitDepth !== 8 ||
    (colorType !== 2 && colorType !== 6) ||
    compression !== 0 ||
    filterMethod !== 0 ||
    interlace !== 0
  ) {
    throw pngInvalid("visual PNG format is unsupported");
  }
  return {
    width,
    height,
    colorType,
    bytesPerPixel: colorType === 2 ? 3 : 4
  };
}

function paethPredictor(left: number, up: number, upperLeft: number): number {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

function reconstructRows(
  inflated: Uint8Array,
  header: PngHeader,
  rowBytes: number
): Uint8Array {
  const reconstructed = new Uint8Array(rowBytes * header.height);
  let sourceOffset = 0;
  for (let rowIndex = 0; rowIndex < header.height; rowIndex += 1) {
    const filter = inflated[sourceOffset];
    if (filter === undefined || filter > 4) throw pngInvalid("visual PNG scanline filter is invalid");
    sourceOffset += 1;
    const rowOffset = rowIndex * rowBytes;
    const previousOffset = rowOffset - rowBytes;
    for (let column = 0; column < rowBytes; column += 1) {
      const encoded = inflated[sourceOffset + column];
      if (encoded === undefined) throw pngInvalid("visual PNG scanline is truncated");
      const left = column >= header.bytesPerPixel
        ? (reconstructed[rowOffset + column - header.bytesPerPixel] ?? 0)
        : 0;
      const up = rowIndex > 0 ? (reconstructed[previousOffset + column] ?? 0) : 0;
      const upperLeft = rowIndex > 0 && column >= header.bytesPerPixel
        ? (reconstructed[previousOffset + column - header.bytesPerPixel] ?? 0)
        : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      if (filter === 2) predictor = up;
      if (filter === 3) predictor = Math.floor((left + up) / 2);
      if (filter === 4) predictor = paethPredictor(left, up, upperLeft);
      reconstructed[rowOffset + column] = (encoded + predictor) & 0xff;
    }
    sourceOffset += rowBytes;
  }
  return reconstructed;
}

function toRgba(raw: Uint8Array, header: PngHeader): Uint8Array {
  if (header.colorType === 6) return Uint8Array.from(raw);
  const rgba = new Uint8Array(header.width * header.height * 4);
  for (let source = 0, target = 0; source < raw.byteLength; source += 3, target += 4) {
    rgba[target] = raw[source] ?? 0;
    rgba[target + 1] = raw[source + 1] ?? 0;
    rgba[target + 2] = raw[source + 2] ?? 0;
    rgba[target + 3] = 255;
  }
  return rgba;
}

export function decodeVisualPng(bytes: Uint8Array): DecodedVisualPng {
  if (bytes.byteLength > VISUAL_ARTIFACT_MAX_BYTES) {
    throw new VisualVerificationError(
      "VISUAL_ARTIFACT_TOO_LARGE",
      "visual PNG exceeds the bounded encoded artifact limit"
    );
  }
  if (!hasPngSignature(bytes)) throw pngInvalid("visual PNG signature is invalid");

  let offset = PNG_SIGNATURE.byteLength;
  let header: PngHeader | undefined;
  let sawIdat = false;
  let sawIend = false;
  const idatParts: Uint8Array[] = [];
  let idatBytes = 0;

  while (offset < bytes.byteLength) {
    if (sawIend || offset + 12 > bytes.byteLength) throw pngInvalid("visual PNG chunk structure is invalid");
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
    const length = view.getUint32(0, false);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.byteLength) throw pngInvalid("visual PNG chunk length is invalid");
    const type = Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);

    if (header === undefined && type !== "IHDR") throw pngInvalid("visual PNG IHDR must be first");
    if (type === "IHDR") {
      if (header !== undefined || offset !== PNG_SIGNATURE.byteLength) {
        throw pngInvalid("visual PNG contains duplicate IHDR");
      }
      header = parseHeader(data);
    } else if (type === "IDAT") {
      if (header === undefined) throw pngInvalid("visual PNG IDAT precedes IHDR");
      sawIdat = true;
      idatBytes += data.byteLength;
      if (idatBytes > VISUAL_ARTIFACT_MAX_BYTES) {
        throw new VisualVerificationError(
          "VISUAL_ARTIFACT_TOO_LARGE",
          "visual PNG compressed payload exceeds the bounded limit"
        );
      }
      idatParts.push(data);
    } else if (type === "IEND") {
      if (length !== 0 || header === undefined || !sawIdat) {
        throw pngInvalid("visual PNG IEND is invalid");
      }
      sawIend = true;
    }

    offset = chunkEnd;
  }

  if (header === undefined || !sawIdat || !sawIend || offset !== bytes.byteLength) {
    throw pngInvalid("visual PNG is incomplete");
  }

  const rowBytes = header.width * header.bytesPerPixel;
  const expectedInflatedBytes = (rowBytes + 1) * header.height;
  let inflated: Uint8Array;
  try {
    inflated = inflateSync(Buffer.concat(idatParts.map((part) => Buffer.from(part))), {
      maxOutputLength: expectedInflatedBytes
    });
  } catch {
    throw pngInvalid("visual PNG compressed data is invalid");
  }
  if (inflated.byteLength !== expectedInflatedBytes) {
    throw pngInvalid("visual PNG decompressed size is invalid");
  }

  const raw = reconstructRows(inflated, header, rowBytes);
  return {
    width: header.width,
    height: header.height,
    rgba: toRgba(raw, header)
  };
}

function pixelOffset(image: DecodedVisualPng, x: number, y: number): number | null {
  if (x >= image.width || y >= image.height) return null;
  return (y * image.width + x) * 4;
}

export function compareVisualPixels(
  current: DecodedVisualPng,
  reference: DecodedVisualPng
): VisualPixelComparison {
  const width = Math.max(current.width, reference.width);
  const height = Math.max(current.height, reference.height);
  const totalPixels = width * height;
  if (totalPixels > VISUAL_MAX_PIXELS) {
    throw new VisualVerificationError(
      "VISUAL_ARTIFACT_TOO_LARGE",
      "visual comparison union exceeds the bounded pixel limit"
    );
  }
  let changedPixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const currentOffset = pixelOffset(current, x, y);
      const referenceOffset = pixelOffset(reference, x, y);
      if (currentOffset === null || referenceOffset === null) {
        changedPixels += 1;
        continue;
      }
      if (
        current.rgba[currentOffset] !== reference.rgba[referenceOffset] ||
        current.rgba[currentOffset + 1] !== reference.rgba[referenceOffset + 1] ||
        current.rgba[currentOffset + 2] !== reference.rgba[referenceOffset + 2] ||
        current.rgba[currentOffset + 3] !== reference.rgba[referenceOffset + 3]
      ) {
        changedPixels += 1;
      }
    }
  }

  return {
    currentDimensions: { width: current.width, height: current.height },
    referenceDimensions: { width: reference.width, height: reference.height },
    dimensionsMatch: current.width === reference.width && current.height === reference.height,
    changedPixels,
    totalPixels,
    changedPixelRatio: changedPixels / totalPixels
  };
}
