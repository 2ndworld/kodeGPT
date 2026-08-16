import { createHash } from "node:crypto";

import { CapabilityError } from "../errors.js";
import {
  PROVIDER_MAX_CANONICAL_INVENTORY_BYTES,
  PROVIDER_MAX_STRUCTURAL_DEPTH,
  PROVIDER_MAX_TOOL_INPUT_SCHEMA_BYTES,
  PROVIDER_MAX_TOOL_OUTPUT_SCHEMA_BYTES,
  PROVIDER_MAX_TOOLS,
  type ProviderStructuralInventory,
  type ProviderStructuralTool
} from "./contracts.js";

const PROSE_FIELDS = new Set([
  "description",
  "displayName",
  "examples",
  "instructions",
  "prompt",
  "prompts",
  "summary",
  "title"
]);

const INVENTORY_FIELDS = new Set([
  "adapterContractVersion",
  "providerContractVersion",
  "tools"
]);

const TOOL_FIELDS = new Set([
  "id",
  "inputSchema",
  "outputSchema"
]);

export function normalizeProviderInventory(value: unknown): ProviderStructuralInventory {
  const root = requirePlainRecord(value, "Provider inventory must be an object");
  rejectUnknownAuthorityFields(root, INVENTORY_FIELDS, "inventory");

  const adapterContractVersion = normalizeVersion(root.adapterContractVersion, "adapter contract version");
  const providerContractVersion = root.providerContractVersion === null
    ? null
    : normalizeVersion(root.providerContractVersion, "provider contract version");

  if (!Array.isArray(root.tools)) throw invalid("Provider inventory tools must be an array");
  if (root.tools.length > PROVIDER_MAX_TOOLS) {
    throw invalid(`Provider inventory exceeds the ${PROVIDER_MAX_TOOLS} tool ceiling`);
  }

  const tools: ProviderStructuralTool[] = root.tools.map((candidate, index) => {
    const tool = requirePlainRecord(candidate, `Provider inventory tool ${index} must be an object`);
    rejectUnknownAuthorityFields(tool, TOOL_FIELDS, `tool ${index}`);
    const id = normalizeToolId(tool.id);
    const inputSchema = canonicalizeJson(tool.inputSchema, 0, new Set<object>());
    const outputSchema = canonicalizeJson(tool.outputSchema, 0, new Set<object>());
    enforceSchemaBytes(inputSchema, PROVIDER_MAX_TOOL_INPUT_SCHEMA_BYTES, "input");
    enforceSchemaBytes(outputSchema, PROVIDER_MAX_TOOL_OUTPUT_SCHEMA_BYTES, "output");
    return Object.freeze({ id, inputSchema, outputSchema });
  });

  tools.sort((left, right) => compareUtf8(left.id, right.id));
  for (let index = 1; index < tools.length; index += 1) {
    if (tools[index - 1]?.id === tools[index]?.id) {
      throw invalid(`Provider inventory contains duplicate tool id: ${tools[index]!.id}`);
    }
  }

  const normalized = Object.freeze({
    adapterContractVersion,
    providerContractVersion,
    tools: Object.freeze(tools)
  });
  const canonicalBytes = Buffer.from(JSON.stringify(normalized), "utf8");
  if (canonicalBytes.length > PROVIDER_MAX_CANONICAL_INVENTORY_BYTES) {
    throw invalid("Provider canonical inventory exceeds the 512 KiB ceiling");
  }
  return normalized;
}

export function fingerprintProviderInventory(value: ProviderStructuralInventory): string {
  const normalized = normalizeProviderInventory(value);
  const bytes = Buffer.from(JSON.stringify(normalized), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeVersion(value: unknown, label: string): string {
  if (typeof value !== "string") throw invalid(`Provider ${label} must be a string`);
  const normalized = value.normalize("NFC");
  if (
    normalized.length < 1 ||
    Buffer.byteLength(normalized, "utf8") > 128 ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw invalid(`Provider ${label} is invalid`);
  }
  return normalized;
}

function normalizeToolId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/.test(value)) {
    throw invalid("Provider tool id must be bounded ASCII without control characters");
  }
  return value;
}

function canonicalizeJson(value: unknown, depth: number, seen: Set<object>): unknown {
  if (depth > PROVIDER_MAX_STRUCTURAL_DEPTH) {
    throw invalid(`Provider structural JSON exceeds depth ${PROVIDER_MAX_STRUCTURAL_DEPTH}`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.includes("\0")) throw invalid("Provider structural JSON contains NUL");
    return value.normalize("NFC");
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid("Provider structural JSON contains an invalid number");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw invalid("Provider structural JSON integer exceeds safe numeric form");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw invalid("Provider structural JSON contains a cycle");
    seen.add(value);
    const result = value.map((item) => canonicalizeJson(item, depth + 1, seen));
    seen.delete(value);
    return Object.freeze(result);
  }
  if (typeof value !== "object" || value === undefined) {
    throw invalid("Provider structural schema must contain JSON values only");
  }
  if (!isPlainRecord(value)) {
    throw invalid("Provider structural schema must contain plain JSON objects only");
  }
  if (seen.has(value)) throw invalid("Provider structural JSON contains a cycle");
  seen.add(value);

  const normalizedEntries = new Map<string, unknown>();
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.normalize("NFC");
    if (key.includes("\0")) throw invalid("Provider structural JSON key contains NUL");
    if (normalizedEntries.has(key)) {
      throw invalid(`Provider structural JSON contains duplicate semantic key: ${key}`);
    }
    normalizedEntries.set(key, canonicalizeJson(rawValue, depth + 1, seen));
  }
  seen.delete(value);

  const output: Record<string, unknown> = {};
  for (const key of [...normalizedEntries.keys()].sort(compareUtf8)) {
    output[key] = normalizedEntries.get(key);
  }
  return Object.freeze(output);
}

function enforceSchemaBytes(value: unknown, maximum: number, kind: "input" | "output"): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > maximum) {
    throw invalid(`Provider ${kind} schema exceeds the 32 KiB ceiling`);
  }
}

function rejectUnknownAuthorityFields(
  value: Record<string, unknown>,
  structuralFields: ReadonlySet<string>,
  label: string
): void {
  for (const key of Object.keys(value)) {
    if (structuralFields.has(key) || PROSE_FIELDS.has(key)) continue;
    throw invalid(`Provider ${label} contains unknown authority field: ${key}`);
  }
  for (const key of structuralFields) {
    if (!Object.hasOwn(value, key)) throw invalid(`Provider ${label} is missing structural field: ${key}`);
  }
}

function requirePlainRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw invalid(message);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function invalid(message: string): CapabilityError {
  return new CapabilityError("PROVIDER_RESPONSE_INVALID", message);
}
