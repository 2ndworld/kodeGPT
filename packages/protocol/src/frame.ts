const HEADER_PREFIX = "Content-Length: ";
const HEADER_END = "\r\n\r\n";
const MAX_HEADER_BYTES = 64;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

export function encodeFrame(value: unknown): Uint8Array {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new FrameError("FRAME_JSON_UNSERIALIZABLE");
  }

  const body = textEncoder.encode(json);
  if (body.byteLength > MAX_FRAME_BYTES) {
    throw new FrameError("FRAME_TOO_LARGE");
  }

  const header = textEncoder.encode(`${HEADER_PREFIX}${body.byteLength}${HEADER_END}`);
  const frame = new Uint8Array(header.byteLength + body.byteLength);
  frame.set(header, 0);
  frame.set(body, header.byteLength);
  return frame;
}

export class FrameDecoder {
  readonly #headerBytes: number[] = [];
  #expectedBodyBytes: number | null = null;
  #body: Uint8Array | null = null;
  #bodyOffset = 0;
  #finished = false;

  push(chunk: Uint8Array): unknown[] {
    if (this.#finished) {
      throw new FrameError("FRAME_DECODER_FINISHED");
    }

    const values: unknown[] = [];
    let offset = 0;

    while (offset < chunk.byteLength) {
      if (this.#expectedBodyBytes === null) {
        const byte = chunk[offset] ?? 0;
        offset += 1;
        this.#pushHeaderByte(byte);

        if (this.#hasCompleteHeader()) {
          this.#beginBody();
          if (this.#expectedBodyBytes === 0) {
            values.push(this.#finishBody());
          }
        }
        continue;
      }

      const body = this.#body;
      if (body === null) {
        throw new FrameError("FRAME_DECODER_STATE_INVALID");
      }

      const remaining = this.#expectedBodyBytes - this.#bodyOffset;
      const available = chunk.byteLength - offset;
      const take = Math.min(remaining, available);
      body.set(chunk.subarray(offset, offset + take), this.#bodyOffset);
      this.#bodyOffset += take;
      offset += take;

      if (this.#bodyOffset === this.#expectedBodyBytes) {
        values.push(this.#finishBody());
      }
    }

    return values;
  }

  finish(): void {
    if (this.#expectedBodyBytes !== null || this.#headerBytes.length > 0) {
      throw new FrameError("TRUNCATED_FRAME");
    }
    this.#finished = true;
  }

  #pushHeaderByte(byte: number): void {
    if (byte > 0x7f) {
      throw new FrameError("INVALID_CONTENT_LENGTH_HEADER");
    }

    this.#headerBytes.push(byte);
    if (this.#headerBytes.length > MAX_HEADER_BYTES) {
      throw new FrameError("CONTENT_LENGTH_HEADER_TOO_LARGE");
    }

    const index = this.#headerBytes.length - 1;
    if (index < HEADER_PREFIX.length && byte !== HEADER_PREFIX.charCodeAt(index)) {
      throw new FrameError("INVALID_CONTENT_LENGTH_HEADER");
    }

    if (byte === 0x0a && this.#headerBytes[index - 1] !== 0x0d) {
      throw new FrameError("INVALID_CONTENT_LENGTH_HEADER");
    }
  }

  #hasCompleteHeader(): boolean {
    if (this.#headerBytes.length < HEADER_END.length) {
      return false;
    }

    const end = this.#headerBytes.slice(-HEADER_END.length);
    return (
      end[0] === 0x0d &&
      end[1] === 0x0a &&
      end[2] === 0x0d &&
      end[3] === 0x0a
    );
  }

  #beginBody(): void {
    const header = String.fromCharCode(...this.#headerBytes);
    const match = /^Content-Length: (0|[1-9][0-9]*)\r\n\r\n$/.exec(header);
    this.#headerBytes.length = 0;

    if (match === null) {
      throw new FrameError("INVALID_CONTENT_LENGTH_HEADER");
    }

    const rawLength = match[1];
    if (rawLength === undefined) {
      throw new FrameError("INVALID_CONTENT_LENGTH_HEADER");
    }

    const length = Number(rawLength);
    if (!Number.isSafeInteger(length) || length > MAX_FRAME_BYTES) {
      throw new FrameError("FRAME_TOO_LARGE");
    }

    this.#expectedBodyBytes = length;
    this.#body = new Uint8Array(length);
    this.#bodyOffset = 0;
  }

  #finishBody(): unknown {
    const body = this.#body;
    if (body === null) {
      throw new FrameError("FRAME_DECODER_STATE_INVALID");
    }

    let json: string;
    try {
      json = textDecoder.decode(body);
    } catch (error) {
      this.#resetBody();
      throw new FrameError(`INVALID_FRAME_UTF8: ${String(error)}`);
    }

    try {
      const value: unknown = JSON.parse(json);
      this.#resetBody();
      return value;
    } catch (error) {
      this.#resetBody();
      throw new FrameError(`INVALID_FRAME_JSON: ${String(error)}`);
    }
  }

  #resetBody(): void {
    this.#expectedBodyBytes = null;
    this.#body = null;
    this.#bodyOffset = 0;
  }
}
