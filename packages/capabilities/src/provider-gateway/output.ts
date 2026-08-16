import type { z } from "zod";

import { CapabilityError } from "../errors.js";
import {
  PROVIDER_MAX_RESULT_ELEMENTS,
  PROVIDER_MAX_SEMANTIC_RESULT_BYTES,
  PROVIDER_MAX_STRUCTURAL_DEPTH
} from "./contracts.js";

export function decodeProviderUtf8(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw responseInvalid("Provider response is not valid UTF-8");
  }
  if (text.includes("\0")) {
    throw responseInvalid("Provider response contains NUL");
  }
  return text;
}

export function normalizeProviderValue(value: unknown): unknown {
  const state = { elements: 0 };
  return normalizeValue(value, 0, new Set<object>(), state);
}

export function parseProviderSemanticOutput<T>(
  bytes: Uint8Array,
  schema: z.ZodType<T>,
  options: {
    semanticInput?: unknown;
    mapOutput?: (providerValue: unknown, semanticInput: unknown) => unknown;
  } = {}
): T {
  const text = decodeProviderUtf8(bytes);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text) as unknown;
  } catch {
    throw responseInvalid("Provider response is not valid JSON");
  }
  const normalized = normalizeProviderValue(parsedJson);
  let semanticValue = normalized;
  if (options.mapOutput !== undefined) {
    try {
      semanticValue = options.mapOutput(normalized, options.semanticInput);
    } catch {
      throw responseInvalid("Provider response mapping failed");
    }
  }
  const mapped = normalizeProviderValue(semanticValue);
  const parsed = schema.safeParse(mapped);
  if (!parsed.success) {
    throw responseInvalid("Provider response does not match the reviewed semantic output schema");
  }
  return parsed.data;
}

export function fitProviderSemanticResult<T>(input: T): {
  value: T;
  truncated: boolean;
  truncationReasons: readonly string[];
} {
  const value = normalizeProviderValue(input) as T;
  const result = {
    value,
    truncated: false as const,
    truncationReasons: Object.freeze([]) as readonly string[]
  };
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  } catch {
    throw responseInvalid("Provider semantic result is not serializable JSON");
  }
  if (bytes > PROVIDER_MAX_SEMANTIC_RESULT_BYTES) {
    throw new CapabilityError(
      "PROVIDER_OUTPUT_LIMIT_EXCEEDED",
      "Provider semantic result exceeds the 512 KiB ceiling and has no reviewed safe truncation policy"
    );
  }
  return result;
}

function normalizeValue(
  value: unknown,
  depth: number,
  seen: Set<object>,
  state: { elements: number }
): unknown {
  if (depth > PROVIDER_MAX_STRUCTURAL_DEPTH) {
    throw responseInvalid(`Provider result exceeds structural depth ${PROVIDER_MAX_STRUCTURAL_DEPTH}`);
  }
  state.elements += 1;
  if (state.elements > PROVIDER_MAX_RESULT_ELEMENTS) {
    throw responseInvalid(`Provider result exceeds ${PROVIDER_MAX_RESULT_ELEMENTS} structural elements`);
  }

  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.includes("\0")) throw responseInvalid("Provider result contains NUL");
    return value.replace(/\r\n?/g, "\n").normalize("NFC");
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw responseInvalid("Provider result contains an invalid number");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw responseInvalid("Provider result integer exceeds the safe JSON numeric range");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol" || value === undefined) {
    throw responseInvalid("Provider result must contain JSON values only");
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw responseInvalid("Provider binary values are not allowed in semantic results");
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw responseInvalid("Provider result contains a cycle");
    seen.add(value);
    const normalized = value.map((item) => normalizeValue(item, depth + 1, seen, state));
    seen.delete(value);
    return normalized;
  }
  if (!isPlainRecord(value)) {
    throw responseInvalid("Provider result must contain plain JSON objects only");
  }
  if (seen.has(value)) throw responseInvalid("Provider result contains a cycle");
  seen.add(value);
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.includes("\0")) throw responseInvalid("Provider result object key contains NUL");
    normalized[key] = normalizeValue(item, depth + 1, seen, state);
  }
  seen.delete(value);
  return normalized;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function responseInvalid(message: string): CapabilityError {
  return new CapabilityError("PROVIDER_RESPONSE_INVALID", message);
}
