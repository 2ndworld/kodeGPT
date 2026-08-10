export const ARTIFACT_READ_MAX_BYTES = 1024 * 1024;

export interface ArtifactKernelTransport {
  request<T>(method: "artifact.read", params: Record<string, unknown>): Promise<T>;
}

export interface KernelArtifactMetadata {
  schemaVersion: 1;
  artifactId: string;
  mediaType: string;
  bytesWritten: number;
  sourceTruncated: boolean;
}

export interface ArtifactMetadata {
  schemaVersion: 1;
  uri: `artifact://${string}`;
  mediaType: string;
  sizeBytes: number;
  sourceTruncated: boolean;
}

export interface ArtifactReadResult {
  schemaVersion: 1;
  uri: `artifact://${string}`;
  dataBase64: string;
  bytesRead: number;
  nextOffset: number;
  eof: boolean;
}

export class ArtifactStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ArtifactStoreError";
    this.code = code;
  }
}

export class ArtifactStore {
  readonly #kernel: ArtifactKernelTransport;

  constructor(kernel: ArtifactKernelTransport) {
    this.#kernel = kernel;
  }

  async read(
    uri: string,
    options: { offset?: number; maxBytes?: number } = {}
  ): Promise<ArtifactReadResult> {
    const artifactId = artifactIdFromUri(uri);
    const offset = boundedInteger(options.offset ?? 0, "offset", 0, Number.MAX_SAFE_INTEGER);
    const requested = boundedInteger(
      options.maxBytes ?? ARTIFACT_READ_MAX_BYTES,
      "maxBytes",
      1,
      Number.MAX_SAFE_INTEGER
    );
    const maxBytes = Math.min(requested, ARTIFACT_READ_MAX_BYTES);
    const value = await this.#kernel.request<unknown>("artifact.read", {
      artifactId,
      offset,
      maxBytes
    });
    return validateArtifactRead(value, uri, offset, maxBytes);
  }
}

export function toPublicArtifactMetadata(value: unknown): ArtifactMetadata {
  if (!isRecord(value)) {
    throw invalidMetadata();
  }
  assertOnlyKeys(value, [
    "schemaVersion",
    "artifactId",
    "mediaType",
    "bytesWritten",
    "sourceTruncated"
  ]);
  if (
    value.schemaVersion !== 1 ||
    typeof value.artifactId !== "string" ||
    !isArtifactId(value.artifactId) ||
    typeof value.mediaType !== "string" ||
    value.mediaType.length === 0 ||
    !Number.isSafeInteger(value.bytesWritten) ||
    (value.bytesWritten as number) < 0 ||
    typeof value.sourceTruncated !== "boolean"
  ) {
    throw invalidMetadata();
  }
  return {
    schemaVersion: 1,
    uri: `artifact://${value.artifactId}`,
    mediaType: value.mediaType,
    sizeBytes: value.bytesWritten as number,
    sourceTruncated: value.sourceTruncated
  };
}

export function artifactIdFromUri(uri: string): string {
  const match = /^artifact:\/\/(ka_[A-Za-z0-9_-]{1,93})$/.exec(uri);
  if (match === null || !isArtifactId(match[1])) {
    throw new ArtifactStoreError("ARTIFACT_URI_INVALID", "artifact URI is invalid");
  }
  return match[1];
}

function validateArtifactRead(
  value: unknown,
  uri: string,
  offset: number,
  maxBytes: number
): ArtifactReadResult {
  if (!isRecord(value)) {
    throw invalidRead();
  }
  assertOnlyKeys(value, ["schemaVersion", "dataBase64", "bytesRead", "nextOffset", "eof"]);
  if (
    value.schemaVersion !== 1 ||
    typeof value.dataBase64 !== "string" ||
    !Number.isSafeInteger(value.bytesRead) ||
    (value.bytesRead as number) < 0 ||
    (value.bytesRead as number) > maxBytes ||
    !Number.isSafeInteger(value.nextOffset) ||
    value.nextOffset !== offset + (value.bytesRead as number) ||
    typeof value.eof !== "boolean"
  ) {
    throw invalidRead();
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.dataBase64)) {
    throw invalidRead();
  }
  const decoded = Buffer.from(value.dataBase64, "base64");
  if (decoded.toString("base64") !== value.dataBase64 || decoded.byteLength !== value.bytesRead) {
    throw invalidRead();
  }
  return {
    schemaVersion: 1,
    uri: uri as `artifact://${string}`,
    dataBase64: value.dataBase64,
    bytesRead: value.bytesRead as number,
    nextOffset: value.nextOffset as number,
    eof: value.eof
  };
}

function isArtifactId(value: string): boolean {
  const suffix = value.startsWith("ka_") ? value.slice(3) : "";
  return (
    suffix.length > 0 &&
    value.length <= 96 &&
    [...suffix].every((character) => /[A-Za-z0-9_-]/.test(character))
  );
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ArtifactStoreError("ARTIFACT_READ_INVALID", `${name} is outside the supported range`);
  }
  return value;
}

function assertOnlyKeys(value: Record<string, unknown>, keys: string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ArtifactStoreError(
      "RUNTIME_PROTOCOL_INVALID",
      "runtime artifact payload contains an unknown field"
    );
  }
}

function invalidMetadata(): ArtifactStoreError {
  return new ArtifactStoreError(
    "RUNTIME_PROTOCOL_INVALID",
    "runtime returned invalid artifact metadata"
  );
}

function invalidRead(): ArtifactStoreError {
  return new ArtifactStoreError("RUNTIME_PROTOCOL_INVALID", "runtime returned invalid artifact read payload");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
