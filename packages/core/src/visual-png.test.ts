import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  VISUAL_MAX_PIXELS,
  VisualVerificationError,
  compareVisualPixels,
  decodeVisualPng,
  type DecodedVisualPng
} from "./visual-png.js";

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(header, 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 0);
  return Buffer.concat([header, Buffer.from(data), crc]);
}

function paeth(left: number, up: number, upperLeft: number): number {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

function encodeFilteredRow(
  row: Uint8Array,
  previous: Uint8Array | undefined,
  bytesPerPixel: number,
  filter: number
): Uint8Array {
  const encoded = new Uint8Array(row.byteLength);
  for (let index = 0; index < row.byteLength; index += 1) {
    const value = row[index] ?? 0;
    const left = index >= bytesPerPixel ? (row[index - bytesPerPixel] ?? 0) : 0;
    const up = previous?.[index] ?? 0;
    const upperLeft = index >= bytesPerPixel ? (previous?.[index - bytesPerPixel] ?? 0) : 0;
    let predictor = 0;
    if (filter === 1) predictor = left;
    if (filter === 2) predictor = up;
    if (filter === 3) predictor = Math.floor((left + up) / 2);
    if (filter === 4) predictor = paeth(left, up, upperLeft);
    encoded[index] = (value - predictor + 256) & 0xff;
  }
  return encoded;
}

function makePng(input: {
  width: number;
  height: number;
  colorType?: 2 | 6 | number;
  bitDepth?: number;
  compression?: number;
  filterMethod?: number;
  interlace?: number;
  rows?: Uint8Array[];
  rowFilters?: number[];
}): Uint8Array {
  const colorType = input.colorType ?? 6;
  const bitDepth = input.bitDepth ?? 8;
  const bytesPerPixel = colorType === 2 ? 3 : 4;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(input.width, 0);
  ihdr.writeUInt32BE(input.height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = input.compression ?? 0;
  ihdr[11] = input.filterMethod ?? 0;
  ihdr[12] = input.interlace ?? 0;

  const rows = input.rows ?? [];
  const rawParts: Buffer[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    const filter = input.rowFilters?.[rowIndex] ?? 0;
    const filtered = encodeFilteredRow(row, rows[rowIndex - 1], bytesPerPixel, filter);
    rawParts.push(Buffer.from([filter]), Buffer.from(filtered));
  }

  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rawParts))),
    chunk("IEND", new Uint8Array())
  ]);
}

function rgba(...pixels: Array<[number, number, number, number]>): Uint8Array {
  return Uint8Array.from(pixels.flat());
}

function decoded(width: number, height: number, pixels: Uint8Array): DecodedVisualPng {
  return { width, height, rgba: pixels };
}

describe("bounded visual PNG decoding", () => {
  it("decodes 8-bit RGBA scanlines exactly", () => {
    const row = rgba([1, 2, 3, 4], [10, 20, 30, 40]);
    const image = decodeVisualPng(makePng({ width: 2, height: 1, rows: [row] }));

    expect(image).toEqual({ width: 2, height: 1, rgba: row });
  });

  it("converts 8-bit RGB scanlines to opaque RGBA", () => {
    const image = decodeVisualPng(
      makePng({
        width: 2,
        height: 1,
        colorType: 2,
        rows: [Uint8Array.from([1, 2, 3, 10, 20, 30])]
      })
    );

    expect(image.rgba).toEqual(rgba([1, 2, 3, 255], [10, 20, 30, 255]));
  });

  it.each([0, 1, 2, 3, 4])("reconstructs PNG filter %i", (filter) => {
    const first = rgba([10, 20, 30, 40], [50, 60, 70, 80]);
    const second = rgba([11, 22, 33, 44], [55, 66, 77, 88]);
    const image = decodeVisualPng(
      makePng({
        width: 2,
        height: 2,
        rows: [first, second],
        rowFilters: [filter, filter]
      })
    );

    expect(image.rgba).toEqual(Uint8Array.from([...first, ...second]));
  });

  it("rejects malformed signature and chunk structure", () => {
    const valid = makePng({ width: 1, height: 1, rows: [rgba([1, 2, 3, 4])] });
    const badSignature = Uint8Array.from(valid);
    badSignature[0] = 0;
    expect(() => decodeVisualPng(badSignature)).toThrowError(VisualVerificationError);

    const truncated = valid.slice(0, valid.byteLength - 3);
    expect(() => decodeVisualPng(truncated)).toThrowError(
      expect.objectContaining({ code: "VISUAL_PNG_INVALID" })
    );
  });

  it.each([
    { bitDepth: 16, colorType: 6, compression: 0, filterMethod: 0, interlace: 0 },
    { bitDepth: 8, colorType: 4, compression: 0, filterMethod: 0, interlace: 0 },
    { bitDepth: 8, colorType: 6, compression: 1, filterMethod: 0, interlace: 0 },
    { bitDepth: 8, colorType: 6, compression: 0, filterMethod: 1, interlace: 0 },
    { bitDepth: 8, colorType: 6, compression: 0, filterMethod: 0, interlace: 1 }
  ])("rejects unsupported PNG metadata %#", (metadata) => {
    expect(() =>
      decodeVisualPng(
        makePng({
          width: 1,
          height: 1,
          rows: [rgba([1, 2, 3, 4])],
          ...metadata
        })
      )
    ).toThrowError(expect.objectContaining({ code: "VISUAL_PNG_INVALID" }));
  });

  it("rejects decoded geometry above the fixed pixel bound before inflate allocation", () => {
    expect(VISUAL_MAX_PIXELS).toBe(3840 * 2160);
    expect(() => decodeVisualPng(makePng({ width: 3840, height: 2161 }))).toThrowError(
      expect.objectContaining({ code: "VISUAL_ARTIFACT_TOO_LARGE" })
    );
  });
});

describe("deterministic visual pixel comparison", () => {
  it("returns zero changed pixels for equal images", () => {
    const pixels = rgba([0, 0, 0, 255], [1, 2, 3, 255]);
    expect(compareVisualPixels(decoded(2, 1, pixels), decoded(2, 1, pixels))).toEqual({
      currentDimensions: { width: 2, height: 1 },
      referenceDimensions: { width: 2, height: 1 },
      dimensionsMatch: true,
      changedPixels: 0,
      totalPixels: 2,
      changedPixelRatio: 0
    });
  });

  it("counts a pixel changed when any RGBA channel differs", () => {
    const current = decoded(2, 1, rgba([0, 0, 0, 255], [1, 2, 3, 255]));
    const reference = decoded(2, 1, rgba([0, 0, 0, 255], [1, 2, 4, 255]));
    const result = compareVisualPixels(current, reference);

    expect(result.changedPixels).toBe(1);
    expect(result.totalPixels).toBe(2);
    expect(result.changedPixelRatio).toBe(0.5);
  });

  it("uses the union rectangle when dimensions differ", () => {
    const result = compareVisualPixels(
      decoded(2, 1, rgba([0, 0, 0, 255], [1, 1, 1, 255])),
      decoded(1, 1, rgba([0, 0, 0, 255]))
    );

    expect(result.dimensionsMatch).toBe(false);
    expect(result.totalPixels).toBe(2);
    expect(result.changedPixels).toBe(1);
    expect(result.changedPixelRatio).toBe(0.5);
  });
});
