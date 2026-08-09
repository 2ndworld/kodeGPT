export interface HttpTrustConfig {
  readonly allowedHosts: readonly string[];
  readonly allowedOriginHosts: readonly string[];
  readonly publicUrl?: string;
  readonly maxRequestBodyBytes: number;
}

export interface HttpTrustConfigInput {
  allowedHosts: readonly string[];
  allowedOriginHosts: readonly string[];
  publicUrl?: string;
  maxRequestBodyBytes: number;
}

export interface HttpRequestTrustInput {
  host: string | undefined;
  origin: string | undefined;
  contentType: string | undefined;
  contentLength: string | undefined;
  actualBodyBytes: number;
}

export class HttpTrustError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "HttpTrustError";
    this.code = code;
    this.status = status;
  }
}

export function createHttpTrustConfig(input: HttpTrustConfigInput): HttpTrustConfig {
  if (!Number.isSafeInteger(input.maxRequestBodyBytes) || input.maxRequestBodyBytes < 0) {
    throw new TypeError("maxRequestBodyBytes must be a non-negative safe integer");
  }

  const allowedHosts = new Set(input.allowedHosts.map(normalizeAuthority));
  const allowedOriginHosts = new Set(input.allowedOriginHosts.map(normalizeAuthority));
  let publicUrl: string | undefined;
  if (input.publicUrl !== undefined) {
    const url = parsePublicUrl(input.publicUrl);
    publicUrl = url.toString();
    allowedHosts.add(url.host.toLowerCase());
    allowedOriginHosts.add(url.host.toLowerCase());
  }
  if (allowedHosts.size === 0) {
    throw new TypeError("allowedHosts must contain at least one host");
  }

  return Object.freeze({
    allowedHosts: Object.freeze([...allowedHosts].sort()),
    allowedOriginHosts: Object.freeze([...allowedOriginHosts].sort()),
    ...(publicUrl === undefined ? {} : { publicUrl }),
    maxRequestBodyBytes: input.maxRequestBodyBytes
  });
}

export function enforceHttpRequestTrust(
  config: HttpTrustConfig,
  request: HttpRequestTrustInput
): void {
  if (request.host === undefined || request.host.length === 0) {
    throw new HttpTrustError("HTTP_HOST_REQUIRED", 400, "Host header is required");
  }

  let host: string;
  try {
    host = normalizeAuthority(request.host);
  } catch {
    throw new HttpTrustError("HTTP_HOST_REJECTED", 421, "Host header is invalid");
  }
  if (!config.allowedHosts.includes(host)) {
    throw new HttpTrustError("HTTP_HOST_REJECTED", 421, "Host header is not allowed");
  }

  if (request.origin !== undefined) {
    const originHost = parseOriginHost(request.origin);
    if (!config.allowedOriginHosts.includes(originHost)) {
      throw new HttpTrustError("HTTP_ORIGIN_REJECTED", 403, "Origin is not allowed");
    }
  }

  if (!isJsonContentType(request.contentType)) {
    throw new HttpTrustError(
      "HTTP_CONTENT_TYPE_UNSUPPORTED",
      415,
      "Content-Type must be application/json"
    );
  }

  const declaredLength = parseContentLength(request.contentLength);
  if (declaredLength !== undefined && declaredLength > config.maxRequestBodyBytes) {
    throw new HttpTrustError("HTTP_BODY_TOO_LARGE", 413, "Declared request body is too large");
  }
  if (!Number.isSafeInteger(request.actualBodyBytes) || request.actualBodyBytes < 0) {
    throw new HttpTrustError("HTTP_CONTENT_LENGTH_INVALID", 400, "Actual body size is invalid");
  }
  if (request.actualBodyBytes > config.maxRequestBodyBytes) {
    throw new HttpTrustError("HTTP_BODY_TOO_LARGE", 413, "Request body is too large");
  }
  if (declaredLength !== undefined && declaredLength !== request.actualBodyBytes) {
    throw new HttpTrustError(
      "HTTP_CONTENT_LENGTH_MISMATCH",
      400,
      "Content-Length does not match the received body"
    );
  }
}

function normalizeAuthority(value: string): string {
  if (value.length === 0 || value.trim() !== value || value.includes(",")) {
    throw new TypeError("invalid host authority");
  }
  let url: URL;
  try {
    url = new URL(`http://${value}`);
  } catch {
    throw new TypeError("invalid host authority");
  }
  if (
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    url.pathname !== "/" ||
    url.search.length !== 0 ||
    url.hash.length !== 0 ||
    url.host.length === 0 ||
    url.host.toLowerCase() !== value.toLowerCase()
  ) {
    throw new TypeError("invalid host authority");
  }
  return url.host.toLowerCase();
}

function parsePublicUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("publicUrl must be an absolute HTTP(S) URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    url.host.length === 0 ||
    url.hash.length !== 0
  ) {
    throw new TypeError("publicUrl must be a credential-free absolute HTTP(S) URL");
  }
  return url;
}

function parseOriginHost(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpTrustError("HTTP_ORIGIN_REJECTED", 403, "Origin is invalid");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    url.pathname !== "/" ||
    url.search.length !== 0 ||
    url.hash.length !== 0 ||
    url.host.length === 0 ||
    url.origin.toLowerCase() !== value.toLowerCase()
  ) {
    throw new HttpTrustError("HTTP_ORIGIN_REJECTED", 403, "Origin is invalid");
  }
  return url.host.toLowerCase();
}

function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new HttpTrustError("HTTP_CONTENT_LENGTH_INVALID", 400, "Content-Length is invalid");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new HttpTrustError("HTTP_CONTENT_LENGTH_INVALID", 400, "Content-Length is invalid");
  }
  return parsed;
}
