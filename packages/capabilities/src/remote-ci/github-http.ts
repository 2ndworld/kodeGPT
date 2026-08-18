import { CapabilityError, type CapabilityErrorDetails } from "../errors.js";
import { MAX_CI_PROVIDER_METADATA_BYTES } from "./contracts.js";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_ACCEPT = "application/vnd.github+json";
const GITHUB_USER_AGENT = "KodeGPT/0.1 Remote-CI";

export interface GitHubLogRead {
  bytes: Uint8Array;
  truncated: boolean;
  providerRequests: number;
}

export class GitHubHttp {
  readonly #credential: string;
  readonly #fetch: typeof fetch;

  constructor(options: { credential: string; fetchImpl?: typeof fetch }) {
    this.#credential = options.credential;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async getJson<T>(path: string, query?: URLSearchParams): Promise<T> {
    const url = apiUrl(path, query);
    const response = await this.#request(url, true);
    if (isRedirect(response.status)) {
      throw new CapabilityError("CI_RESPONSE_INVALID", "GitHub returned an unexpected redirect");
    }
    this.#throwForProviderStatus(response);
    const bytes = await readBoundedBody(response, MAX_CI_PROVIDER_METADATA_BYTES, "metadata");
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new CapabilityError("CI_RESPONSE_INVALID", "GitHub returned an invalid response");
    }
    return parsed as T;
  }

  async postMutation(
    path: string,
    expectedStatus: 200 | 201 | 202,
    body?: Record<string, unknown>
  ): Promise<void> {
    const url = apiUrl(path);
    const headers = authenticatedHeaders(this.#credential);
    let serializedBody: string | undefined;
    if (body !== undefined) {
      serializedBody = JSON.stringify(body);
      if (Buffer.byteLength(serializedBody, "utf8") > 32 * 1024) {
        throw new CapabilityError("CAPABILITY_LIMIT_EXCEEDED", "GitHub mutation body exceeded the bounded request size");
      }
      headers.set("Content-Type", "application/json");
    }

    let response: Response;
    try {
      response = await this.#fetch(url.toString(), {
        method: "POST",
        redirect: "manual",
        headers,
        ...(serializedBody === undefined ? {} : { body: serializedBody })
      });
    } catch {
      throw new CapabilityError(
        "CI_MUTATION_OUTCOME_UNKNOWN",
        "GitHub mutation outcome is unknown; inspect current CI state before retrying",
        {
          reason: "MUTATION_OUTCOME_UNKNOWN",
          retryable: false,
          suggestedAction: "refresh-state"
        }
      );
    }

    if (isRedirect(response.status)) {
      throw new CapabilityError("CI_RESPONSE_INVALID", "GitHub returned an unexpected mutation redirect");
    }
    if (response.status === expectedStatus) return;
    this.#throwForProviderStatus(response);
    throw new CapabilityError("CI_RESPONSE_INVALID", "GitHub returned an unexpected mutation response");
  }

  async getJobLog(path: string, scanMaxBytes: number): Promise<GitHubLogRead> {
    if (!Number.isSafeInteger(scanMaxBytes) || scanMaxBytes <= 0) {
      throw new CapabilityError("CI_LOG_LIMIT_EXCEEDED", "CI log scan bound is invalid");
    }
    const firstUrl = apiUrl(path);
    const first = await this.#request(firstUrl, true);

    if (first.status === 200) {
      return { ...(await readBoundedLog(first, scanMaxBytes)), providerRequests: 1 };
    }
    if (!isRedirect(first.status)) {
      this.#throwForProviderStatus(first);
      throw new CapabilityError("CI_LOG_UNAVAILABLE", "CI log is unavailable");
    }

    const location = first.headers.get("location");
    const redirectUrl = validateLogRedirect(location);
    const second = await this.#request(redirectUrl, false);
    if (isRedirect(second.status)) {
      throw new CapabilityError("CI_LOG_UNAVAILABLE", "CI log redirect is unavailable");
    }
    if (second.status < 200 || second.status >= 300) {
      throw new CapabilityError("CI_LOG_UNAVAILABLE", "CI log is unavailable");
    }
    return { ...(await readBoundedLog(second, scanMaxBytes)), providerRequests: 2 };
  }

  async #request(url: URL, authenticated: boolean): Promise<Response> {
    const headers = authenticated ? authenticatedHeaders(this.#credential) : baseHeaders();
    try {
      return await this.#fetch(url.toString(), {
        method: "GET",
        redirect: "manual",
        headers
      });
    } catch {
      throw new CapabilityError("CI_PROVIDER_UNAVAILABLE", "GitHub provider is unavailable");
    }
  }

  #throwForProviderStatus(response: Response): void {
    if (response.status >= 200 && response.status < 300) return;
    if (response.status === 401) {
      throw new CapabilityError("CI_AUTH_FAILED", "GitHub authentication failed", {
        reason: "AUTHENTICATION_REQUIRED",
        retryable: false,
        suggestedAction: "authenticate"
      });
    }
    if (response.status === 429 || isRateLimited403(response)) {
      throw new CapabilityError(
        "CI_RATE_LIMITED",
        "GitHub rate limit was reached",
        rateLimitDetails(response.headers)
      );
    }
    if (response.status === 403) {
      throw new CapabilityError("CI_PERMISSION_DENIED", "GitHub permission was denied");
    }
    if (response.status === 404) {
      throw new CapabilityError("CI_NOT_FOUND", "GitHub resource was not found");
    }
    if (response.status >= 500) {
      throw new CapabilityError("CI_PROVIDER_UNAVAILABLE", "GitHub provider is unavailable");
    }
    throw new CapabilityError("CI_RESPONSE_INVALID", "GitHub returned an invalid response");
  }
}

function baseHeaders(): Headers {
  return new Headers({
    Accept: GITHUB_ACCEPT,
    "User-Agent": GITHUB_USER_AGENT,
    "X-GitHub-Api-Version": GITHUB_API_VERSION
  });
}

function authenticatedHeaders(credential: string): Headers {
  const headers = baseHeaders();
  headers.set("Authorization", `Bearer ${credential}`);
  return headers;
}

function apiUrl(path: string, query?: URLSearchParams): URL {
  if (!isSafeApiPath(path)) {
    throw new CapabilityError("CI_RESPONSE_INVALID", "GitHub request path is invalid");
  }
  const url = new URL(path, GITHUB_API_ORIGIN);
  if (url.origin !== GITHUB_API_ORIGIN) {
    throw new CapabilityError("CI_RESPONSE_INVALID", "GitHub request path is invalid");
  }
  if (query !== undefined) url.search = query.toString();
  return url;
}

function isSafeApiPath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.includes("?") &&
    !path.includes("#") &&
    !hasAsciiControl(path)
  );
}

function hasAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function isRateLimited403(response: Response): boolean {
  return response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0";
}

function rateLimitDetails(headers: Headers): CapabilityErrorDetails {
  const retryHeader = headers.get("retry-after");
  const resetHeader = headers.get("x-ratelimit-reset");
  const retryAfter = retryHeader === null ? undefined : parseSafeNonNegativeInteger(retryHeader);
  const resetEpoch = resetHeader === null ? undefined : parseSafeNonNegativeInteger(resetHeader);
  const resetAt = resetEpoch === undefined ? undefined : safeEpochToIso(resetEpoch);
  return {
    ...(retryAfter === undefined ? {} : { retryAfter }),
    ...(resetAt === undefined ? {} : { resetAt }),
    reason: "RATE_LIMITED",
    retryable: true,
    suggestedAction: "retry"
  };
}

function parseSafeNonNegativeInteger(value: string): number | undefined {
  if (!/^[0-9]{1,16}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function safeEpochToIso(epochSeconds: number): string | undefined {
  const milliseconds = epochSeconds * 1000;
  if (!Number.isSafeInteger(milliseconds)) return undefined;
  const value = new Date(milliseconds);
  return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  kind: "metadata"
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const length = parseSafeNonNegativeInteger(contentLength);
    if (length !== undefined && length > maxBytes) {
      throw new CapabilityError("CI_RESPONSE_LIMIT_EXCEEDED", "GitHub response exceeded the metadata bound");
    }
  }
  const body = response.body;
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new CapabilityError("CI_RESPONSE_LIMIT_EXCEEDED", "GitHub response exceeded the metadata bound");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw new CapabilityError(
      kind === "metadata" ? "CI_PROVIDER_UNAVAILABLE" : "CI_RESPONSE_INVALID",
      "GitHub provider is unavailable"
    );
  }
  return concatenate(chunks, total);
}

async function readBoundedLog(
  response: Response,
  scanMaxBytes: number
): Promise<Omit<GitHubLogRead, "providerRequests">> {
  const body = response.body;
  if (body === null) return { bytes: new Uint8Array(), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let truncated = false;
  try {
    while (retained <= scanMaxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const remaining = scanMaxBytes - retained;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        retained += remaining;
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      retained += value.byteLength;
      if (retained === scanMaxBytes) {
        const next = await reader.read();
        if (!next.done && next.value !== undefined && next.value.byteLength > 0) {
          truncated = true;
          await reader.cancel().catch(() => undefined);
        }
        break;
      }
    }
  } catch {
    throw new CapabilityError("CI_LOG_UNAVAILABLE", "CI log is unavailable");
  }
  return { bytes: concatenate(chunks, retained), truncated };
}

function concatenate(chunks: Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function validateLogRedirect(location: string | null): URL {
  if (location === null || location.length === 0 || location.length > 8192 || hasAsciiControl(location)) {
    throw new CapabilityError("CI_LOG_UNAVAILABLE", "CI log redirect is unavailable");
  }
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new CapabilityError("CI_LOG_UNAVAILABLE", "CI log redirect is unavailable");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    !isAllowedLogDownloadHost(url.hostname)
  ) {
    throw new CapabilityError("CI_LOG_UNAVAILABLE", "CI log redirect is unavailable");
  }
  return url;
}

function isAllowedLogDownloadHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "actions.githubusercontent.com" || host.endsWith(".actions.githubusercontent.com")) {
    return true;
  }
  return /^productionresultssa[0-9]+\.blob\.core\.windows\.net$/.test(host);
}
