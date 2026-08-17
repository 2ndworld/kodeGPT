import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { LookupFunction } from "node:net";

import { CapabilityError } from "../errors.js";
import {
  PROVIDER_MAX_METADATA_RESPONSE_BYTES,
  PROVIDER_MAX_REQUEST_BODY_BYTES,
  type ProviderAdapterManifest,
  type ProviderEncodedRequest,
  type ProviderRawResponse,
  type ProviderRequestBudget
} from "./contracts.js";
import type { ProviderCredential } from "./credential-broker.js";
import {
  selectProviderInternetAddress,
  type ProviderResolvedAddress
} from "./network-policy.js";

export interface ProviderNetworkTransport {
  request(input: {
    manifest: ProviderAdapterManifest;
    operationId: string;
    operationInput: unknown;
    credential: ProviderCredential | null;
    signal: AbortSignal;
    budget: ProviderRequestBudget;
  }): Promise<ProviderRawResponse>;
}

export interface ProviderDnsResolver {
  lookup(hostname: string): Promise<readonly ProviderResolvedAddress[]>;
}

export interface ProviderHttpsRequestInput {
  readonly address: string;
  readonly family: 4 | 6;
  readonly hostname: string;
  readonly servername: string;
  readonly port: number;
  readonly method: "GET" | "POST" | "PUT";
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer | null;
  readonly signal: AbortSignal;
  readonly maxResponseBytes: number;
}

export interface ProviderHttpsResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  readonly body: Buffer;
}

export interface ProviderHttpsRequester {
  request(input: ProviderHttpsRequestInput): Promise<ProviderHttpsResponse>;
}

export class DefaultProviderNetworkTransport implements ProviderNetworkTransport {
  readonly #resolver: ProviderDnsResolver;
  readonly #requester: ProviderHttpsRequester;

  constructor(input: {
    resolver?: ProviderDnsResolver;
    requester?: ProviderHttpsRequester;
  } = {}) {
    this.#resolver = input.resolver ?? new NodeProviderDnsResolver();
    this.#requester = input.requester ?? new NodeProviderHttpsRequester();
  }

  async request(input: {
    manifest: ProviderAdapterManifest;
    operationId: string;
    operationInput: unknown;
    credential: ProviderCredential | null;
    signal: AbortSignal;
    budget: ProviderRequestBudget;
  }): Promise<ProviderRawResponse> {
    if (input.signal.aborted) throw cancelled();
    const operation = input.manifest.operations.find((candidate) => candidate.id === input.operationId);
    if (operation === undefined) {
      throw new CapabilityError("PROVIDER_TOOL_UNAVAILABLE", "Compiled provider operation is unavailable");
    }

    const parsed = operation.inputSchema.safeParse(input.operationInput);
    if (!parsed.success) throw invalid("Provider operation input is invalid");

    let encoded: ProviderEncodedRequest;
    try {
      encoded = operation.encodeRequest(parsed.data);
    } catch {
      throw invalid("Provider request encoder rejected operation input");
    }
    const request = buildCompiledRequest({
      origin: operation.origin,
      pathTemplate: operation.pathTemplate,
      allowedQueryKeys: operation.allowedQueryKeys,
      fixedHeaders: operation.fixedHeaders,
      encoded,
      method: operation.method,
      credential: input.credential
    });

    const first = await this.#requestOnce({
      url: request.url,
      method: operation.method,
      headers: request.headers,
      body: request.body,
      signal: input.signal,
      budget: input.budget
    });

    if (!isRedirect(first.statusCode)) {
      return normalizeStatus(first, request.url.origin, input.credential !== null);
    }

    const redirectPolicy = input.manifest.networkPolicy.redirect;
    if (redirectPolicy === null || redirectPolicy.fromOrigin !== request.url.origin) {
      throw denied("Provider redirect is not permitted by compiled policy");
    }
    const location = singleHeader(first.headers, "location");
    if (location === null) throw responseInvalid("Provider redirect response is invalid");

    let redirectUrl: URL;
    try {
      redirectUrl = new URL(location, request.url);
    } catch {
      throw responseInvalid("Provider redirect location is invalid");
    }
    assertSafeHttpsUrl(redirectUrl);
    if (redirectUrl.origin !== redirectPolicy.toOrigin) {
      throw denied("Provider redirect target origin is not permitted");
    }

    const redirectHeaders = { ...request.headers };
    delete redirectHeaders.authorization;
    const second = await this.#requestOnce({
      url: redirectUrl,
      method: operation.method,
      headers: redirectHeaders,
      body: request.body,
      signal: input.signal,
      budget: input.budget
    });
    if (isRedirect(second.statusCode)) {
      throw denied("Provider redirect depth exceeded compiled policy");
    }
    return normalizeStatus(second, redirectUrl.origin, input.credential !== null);
  }

  async #requestOnce(input: {
    url: URL;
    method: "GET" | "POST" | "PUT";
    headers: Readonly<Record<string, string>>;
    body: Buffer | null;
    signal: AbortSignal;
    budget: ProviderRequestBudget;
  }): Promise<ProviderHttpsResponse> {
    if (input.signal.aborted) throw cancelled();
    input.budget.claimRequest();

    let answers: readonly ProviderResolvedAddress[];
    try {
      answers = await this.#resolver.lookup(input.url.hostname);
    } catch (error) {
      if (error instanceof CapabilityError) throw error;
      if (input.signal.aborted) throw cancelled();
      throw unavailable("Provider DNS resolution failed");
    }
    if (input.signal.aborted) throw cancelled();
    const selected = selectProviderInternetAddress(answers);

    try {
      const response = await this.#requester.request({
        address: selected.address,
        family: selected.family,
        hostname: input.url.hostname,
        servername: input.url.hostname,
        port: normalizedPort(input.url),
        method: input.method,
        path: `${input.url.pathname}${input.url.search}`,
        headers: input.headers,
        body: input.body,
        signal: input.signal,
        maxResponseBytes: PROVIDER_MAX_METADATA_RESPONSE_BYTES
      });
      if (response.body.length > PROVIDER_MAX_METADATA_RESPONSE_BYTES) {
        throw responseInvalid("Provider response exceeded its bounded transport size");
      }
      if (!Number.isInteger(response.statusCode) || response.statusCode < 100 || response.statusCode > 599) {
        throw responseInvalid("Provider returned an invalid HTTP status");
      }
      return response;
    } catch (error) {
      if (error instanceof CapabilityError) throw error;
      if (input.signal.aborted) throw cancelled();
      if (isTimeoutError(error)) {
        throw new CapabilityError("PROVIDER_TIMEOUT", "Provider network attempt timed out");
      }
      throw unavailable("Provider network request failed");
    }
  }
}

export class NodeProviderDnsResolver implements ProviderDnsResolver {
  async lookup(hostname: string): Promise<readonly ProviderResolvedAddress[]> {
    const answers = await dnsLookup(hostname, { all: true, verbatim: true });
    return answers
      .filter((answer): answer is typeof answer & { family: 4 | 6 } => answer.family === 4 || answer.family === 6)
      .map((answer) => ({ address: answer.address, family: answer.family }));
  }
}

export class NodeProviderHttpsRequester implements ProviderHttpsRequester {
  async request(input: ProviderHttpsRequestInput): Promise<ProviderHttpsResponse> {
    if (input.signal.aborted) throw cancelled();
    return await new Promise<ProviderHttpsResponse>((resolve, reject) => {
      let settled = false;
      const chunks: Buffer[] = [];
      let size = 0;
      const lookup: LookupFunction = ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
        if (typeof options === "object" && options !== null && "all" in options && (options as { all?: boolean }).all === true) {
          callback(null, [{ address: input.address, family: input.family }]);
        } else {
          callback(null, input.address, input.family);
        }
      }) as LookupFunction;
      const options: RequestOptions = {
        protocol: "https:",
        hostname: input.hostname,
        port: input.port,
        servername: input.servername,
        method: input.method,
        path: input.path,
        headers: { ...input.headers },
        rejectUnauthorized: true,
        lookup
      };

      const request = httpsRequest(options, (response) => {
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > input.maxResponseBytes) {
            if (!settled) {
              settled = true;
              response.destroy();
              request.destroy();
              cleanup();
              reject(responseInvalid("Provider response exceeded its bounded transport size"));
            }
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.once("end", () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: normalizeHeaders(response.headers),
            body: Buffer.concat(chunks, size)
          });
        });
        response.once("error", onError);
      });

      const onAbort = () => {
        if (settled) return;
        settled = true;
        request.destroy();
        cleanup();
        reject(cancelled());
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        input.signal.removeEventListener("abort", onAbort);
        request.removeListener("error", onError);
      };

      request.once("error", onError);
      input.signal.addEventListener("abort", onAbort, { once: true });
      if (input.body !== null && input.body.length > 0) request.write(input.body);
      request.end();
      if (input.signal.aborted) onAbort();
    });
  }
}

function buildCompiledRequest(input: {
  origin: string;
  pathTemplate: string;
  allowedQueryKeys: readonly string[];
  fixedHeaders: Readonly<Record<string, string>>;
  encoded: ProviderEncodedRequest;
  method: "GET" | "POST" | "PUT";
  credential: ProviderCredential | null;
}): { url: URL; headers: Record<string, string>; body: Buffer | null } {
  assertExactEncoderKeys(input.encoded);
  const path = substitutePathParameters(input.pathTemplate, input.encoded.pathParameters ?? {});
  const url = new URL(path, input.origin);
  assertSafeHttpsUrl(url);
  if (url.origin !== input.origin) throw invalid("Provider request escaped its compiled origin");

  const query = input.encoded.query ?? {};
  if (!isPlainRecord(query)) throw invalid("Provider request query must be a typed object");
  const allowed = new Set(input.allowedQueryKeys);
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.has(key)) throw invalid("Provider request encoder emitted an unapproved query key");
    appendQueryValue(url, key, value);
  }

  let body: Buffer | null = null;
  if (input.encoded.body !== undefined) {
    let serialized: string;
    try {
      serialized = JSON.stringify(input.encoded.body);
    } catch {
      throw invalid("Provider request body is not serializable JSON");
    }
    if (serialized === undefined) throw invalid("Provider request body is not serializable JSON");
    body = Buffer.from(serialized, "utf8");
    if (body.length > PROVIDER_MAX_REQUEST_BODY_BYTES) {
      throw invalid("Provider request body exceeds the gateway hard ceiling");
    }
  }

  const headers: Record<string, string> = { ...input.fixedHeaders };
  if (body !== null) headers["content-length"] = String(body.length);
  if (input.credential !== null) {
    if (/\r|\n|\0/.test(input.credential.value)) {
      throw new CapabilityError("PROVIDER_CREDENTIAL_REJECTED", "Provider credential framing is invalid");
    }
    headers.authorization = input.credential.kind === "bearer"
      ? `Bearer ${input.credential.value}`
      : input.credential.value;
  }
  return { url, headers, body };
}

function assertExactEncoderKeys(encoded: ProviderEncodedRequest): void {
  if (!isPlainRecord(encoded)) throw invalid("Provider request encoder result is invalid");
  const allowed = new Set(["pathParameters", "query", "body"]);
  for (const key of Object.keys(encoded)) {
    if (!allowed.has(key)) throw invalid("Provider request encoder emitted unsupported authority");
  }
}

function substitutePathParameters(template: string, parameters: Readonly<Record<string, string>>): string {
  if (!isPlainRecord(parameters)) throw invalid("Provider path parameters must be a typed object");
  const expected = new Set<string>();
  for (const match of template.matchAll(/\{([A-Za-z0-9._-]+)\}/g)) expected.add(match[1]!);
  for (const key of Object.keys(parameters)) {
    if (!expected.has(key)) throw invalid("Provider request encoder emitted an unapproved path parameter");
  }
  let output = template;
  for (const key of expected) {
    if (!Object.hasOwn(parameters, key)) throw invalid("Provider request encoder omitted a required path parameter");
    const value = parameters[key];
    if (typeof value !== "string" || hasControl(value) || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
      throw invalid("Provider path parameter is unsafe");
    }
    output = output.replaceAll(`{${key}}`, encodeURIComponent(value));
  }
  if (/[\u0000-\u001f\u007f]/.test(output) || /\{[^}]+\}/.test(output)) {
    throw invalid("Provider request path is invalid");
  }
  return output;
}

function appendQueryValue(url: URL, key: string, value: unknown): void {
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw invalid("Provider query collection is too large");
    for (const item of value) appendScalarQueryValue(url, key, item);
    return;
  }
  appendScalarQueryValue(url, key, value);
}

function appendScalarQueryValue(url: URL, key: string, value: unknown): void {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw invalid("Provider query value is invalid");
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw invalid("Provider query number is invalid");
  const text = String(value);
  if (hasControl(text)) throw invalid("Provider query value contains control characters");
  url.searchParams.append(key, text);
}

function assertSafeHttpsUrl(url: URL): void {
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw denied("Provider URL violates compiled HTTPS authority");
  }
}

function normalizedPort(url: URL): number {
  if (url.port === "") return 443;
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw denied("Provider port is invalid");
  return port;
}

function normalizeStatus(
  response: ProviderHttpsResponse,
  finalOrigin: string,
  hadCredential: boolean
): ProviderRawResponse {
  if (response.statusCode === 429) {
    throw new CapabilityError("PROVIDER_RATE_LIMITED", "Provider rate limited the request");
  }
  if ((response.statusCode === 401 || response.statusCode === 403) && hadCredential) {
    throw new CapabilityError("PROVIDER_CREDENTIAL_REJECTED", "Provider rejected the operation credential");
  }
  if (response.statusCode === 408 || response.statusCode === 504) {
    throw new CapabilityError("PROVIDER_TIMEOUT", "Provider request timed out");
  }
  if (response.statusCode >= 500) throw unavailable("Provider is unavailable");
  if (response.statusCode < 200 || response.statusCode >= 400) {
    throw new CapabilityError("PROVIDER_REQUEST_FAILED", "Provider request failed");
  }
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body,
    finalOrigin
  };
}

function isRedirect(statusCode: number): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

function singleHeader(
  headers: Readonly<Record<string, string | readonly string[]>>,
  name: string
): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length === 1) return value[0] ?? null;
  return null;
}

function normalizeHeaders(headers: import("node:http").IncomingHttpHeaders): Record<string, string | readonly string[]> {
  const output: Record<string, string | readonly string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") output[key.toLowerCase()] = value;
    else if (Array.isArray(value)) output[key.toLowerCase()] = [...value];
  }
  return output;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function isTimeoutError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && ["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(String((error as { code?: unknown }).code));
}

function invalid(message: string): CapabilityError {
  return new CapabilityError("PROVIDER_INPUT_INVALID", message);
}

function denied(message: string): CapabilityError {
  return new CapabilityError("PROVIDER_NETWORK_DENIED", message);
}

function responseInvalid(message: string): CapabilityError {
  return new CapabilityError("PROVIDER_RESPONSE_INVALID", message);
}

function unavailable(message: string): CapabilityError {
  return new CapabilityError("PROVIDER_UNAVAILABLE", message);
}

function cancelled(): CapabilityError {
  return new CapabilityError("PROVIDER_CANCELLED", "Provider network request was cancelled");
}
