import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { FrameDecoder, MAX_FRAME_BYTES, encodeFrame } from "./frame.js";

const HEADER_END = Buffer.from("\r\n\r\n", "ascii");

function rawFrame(header: string, body: Uint8Array = new Uint8Array()): Uint8Array {
  return Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(body)]);
}

function bodyFrame(bodyText: string, declaredBytes = Buffer.byteLength(bodyText, "utf8")): Uint8Array {
  return rawFrame(
    `Content-Length: ${declaredBytes}\r\n\r\n`,
    Buffer.from(bodyText, "utf8")
  );
}

describe("exact Content-Length runtime framing", () => {
  it("encodes Content-Length using UTF-8 bytes, not JavaScript character count", () => {
    const value = { text: "🙂 café" };
    const json = JSON.stringify(value);
    const encoded = Buffer.from(encodeFrame(value));
    const headerEnd = encoded.indexOf(HEADER_END);

    expect(headerEnd).toBeGreaterThan(0);
    expect(encoded.subarray(0, headerEnd).toString("ascii")).toBe(
      `Content-Length: ${Buffer.byteLength(json, "utf8")}`
    );
    expect(encoded.subarray(headerEnd + HEADER_END.length).toString("utf8")).toBe(json);
  });

  it("decodes a frame split across header and body chunks", () => {
    const frame = encodeFrame({ ok: true, value: "split" });
    const decoder = new FrameDecoder();

    expect(decoder.push(frame.slice(0, 7))).toEqual([]);
    expect(decoder.push(frame.slice(7, 23))).toEqual([]);
    expect(decoder.push(frame.slice(23, frame.length - 2))).toEqual([]);
    expect(decoder.push(frame.slice(frame.length - 2))).toEqual([{ ok: true, value: "split" }]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("decodes multiple complete frames from one chunk", () => {
    const first = encodeFrame({ id: 1 });
    const second = encodeFrame({ id: 2 });
    const decoder = new FrameDecoder();

    expect(decoder.push(Buffer.concat([Buffer.from(first), Buffer.from(second)]))).toEqual([
      { id: 1 },
      { id: 2 }
    ]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it.each([
    ["missing Content-Length", "X-Length: 2\r\n\r\n", "{}"],
    ["duplicate Content-Length", "Content-Length: 2\r\nContent-Length: 2\r\n\r\n", "{}"],
    ["invalid Content-Length", "Content-Length: nope\r\n\r\n", "{}"],
    ["non-decimal Content-Length", "Content-Length: 2.0\r\n\r\n", "{}"],
    ["lowercase header name", "content-length: 2\r\n\r\n", "{}"],
    ["extra header whitespace", "Content-Length:  2\r\n\r\n", "{}"],
    ["LF-only header terminator", "Content-Length: 2\n\n", "{}"]
  ])("rejects %s", (_name, header, body) => {
    const decoder = new FrameDecoder();

    expect(() => decoder.push(rawFrame(header, Buffer.from(body, "utf8")))).toThrow();
  });

  it("rejects a declared frame larger than the 8 MiB ceiling before buffering its body", () => {
    const decoder = new FrameDecoder();

    expect(MAX_FRAME_BYTES).toBe(8 * 1024 * 1024);
    expect(() =>
      decoder.push(rawFrame(`Content-Length: ${MAX_FRAME_BYTES + 1}\r\n\r\n`))
    ).toThrow(/frame|content-length|max|large/i);
  });

  it("rejects encoding a JSON body larger than the 8 MiB ceiling", () => {
    expect(() => encodeFrame("x".repeat(MAX_FRAME_BYTES))).toThrow(/frame|max|large/i);
  });

  it("rejects a truncated body when the stream finishes", () => {
    const decoder = new FrameDecoder();

    expect(decoder.push(bodyFrame("{}", 10))).toEqual([]);
    expect(() => decoder.finish()).toThrow(/truncat|incomplete|frame/i);
  });

  it("rejects malformed JSON after receiving the declared body bytes", () => {
    const decoder = new FrameDecoder();

    expect(() => decoder.push(bodyFrame("{"))).toThrow(/json|syntax|unexpected/i);
  });
});
