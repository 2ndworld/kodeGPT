import { Buffer } from "node:buffer";

import { isMap, parseDocument, visit } from "yaml";
import { z } from "zod";

import {
  MAX_DESCRIPTION_BYTES,
  MAX_SKILL_NAME_BYTES,
  SKILL_DESCRIPTOR_MAX_BYTES,
  SKILL_MD_MAX_BYTES,
  type ParsedSkillDocument
} from "./contracts.js";
import { SkillError } from "./errors.js";

const OFFICIAL_MAX_NAME_CHARACTERS = 64;
const OFFICIAL_MAX_DESCRIPTION_CHARACTERS = 1024;
const OFFICIAL_MAX_COMPATIBILITY_CHARACTERS = 500;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KNOWN_TOP_LEVEL_KEYS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools"
]);

const metadataSchema = z.record(z.string(), z.unknown());
const frontmatterSchema = z
  .object({
    name: z.string().min(1).max(OFFICIAL_MAX_NAME_CHARACTERS),
    description: z.string().min(1).max(OFFICIAL_MAX_DESCRIPTION_CHARACTERS),
    license: z.string().min(1).optional(),
    compatibility: z.string().min(1).max(OFFICIAL_MAX_COMPATIBILITY_CHARACTERS).optional(),
    metadata: metadataSchema.optional(),
    "allowed-tools": z
      .union([z.string().min(1), z.array(z.string().min(1)).max(64)])
      .optional()
  })
  .passthrough();

export type SkillDocumentParseReason = "INVALID" | "DESCRIPTOR_SIZE_LIMIT";

export class SkillDocumentParseError extends SkillError {
  readonly reason: SkillDocumentParseReason;

  constructor(reason: SkillDocumentParseReason) {
    super("SKILL_BUNDLE_INVALID", "Skill bundle is invalid");
    this.name = "SkillDocumentParseError";
    this.reason = reason;
  }
}

export function parseSkillDocument(
  documentBytes: Uint8Array,
  directoryName: string
): ParsedSkillDocument {
  if (documentBytes.byteLength > SKILL_MD_MAX_BYTES) {
    throw bundleInvalid("DESCRIPTOR_SIZE_LIMIT");
  }

  const text = decodeUtf8(documentBytes);
  const split = splitFrontmatter(text);
  if (Buffer.byteLength(split.descriptor, "utf8") > SKILL_DESCRIPTOR_MAX_BYTES) {
    throw bundleInvalid("DESCRIPTOR_SIZE_LIMIT");
  }

  const document = parseDocument(split.frontmatter, {
    strict: true,
    uniqueKeys: true,
    customTags: []
  });
  if (document.errors.length > 0 || document.warnings.length > 0 || !isMap(document.contents)) {
    throw bundleInvalid();
  }

  let containsAlias = false;
  visit(document, {
    Alias() {
      containsAlias = true;
    }
  });
  if (containsAlias) {
    throw bundleInvalid();
  }

  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw bundleInvalid();
  }
  if (!isPlainRecord(raw)) {
    throw bundleInvalid();
  }

  const parsed = frontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    throw bundleInvalid();
  }
  if (!validSkillName(parsed.data.name) || parsed.data.name !== directoryName) {
    throw bundleInvalid();
  }
  if (Buffer.byteLength(parsed.data.name, "utf8") > MAX_SKILL_NAME_BYTES) {
    throw bundleInvalid();
  }
  if (Buffer.byteLength(parsed.data.description, "utf8") > MAX_DESCRIPTION_BYTES) {
    throw bundleInvalid();
  }

  const unknownMetadataKeys = Object.keys(raw)
    .filter((key) => !KNOWN_TOP_LEVEL_KEYS.has(key))
    .sort(compareUtf8);

  const result: ParsedSkillDocument = {
    name: parsed.data.name,
    description: parsed.data.description,
    unknownMetadataKeys,
    instructions: split.instructions
  };
  if (parsed.data.license !== undefined) {
    result.license = parsed.data.license;
  }
  if (parsed.data.compatibility !== undefined) {
    result.compatibility = parsed.data.compatibility;
  }
  if (parsed.data.metadata !== undefined) {
    result.metadata = cloneJsonLikeRecord(parsed.data.metadata);
  }
  if (parsed.data["allowed-tools"] !== undefined) {
    result.allowedTools = Array.isArray(parsed.data["allowed-tools"])
      ? [...parsed.data["allowed-tools"]]
      : parsed.data["allowed-tools"];
  }
  return result;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw bundleInvalid();
  }
}

function splitFrontmatter(text: string): {
  descriptor: string;
  frontmatter: string;
  instructions: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (match === null || match.index !== 0 || match[1] === undefined) {
    throw bundleInvalid();
  }
  return {
    descriptor: match[0],
    frontmatter: match[1],
    instructions: text.slice(match[0].length)
  };
}

function validSkillName(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= OFFICIAL_MAX_NAME_CHARACTERS &&
    SKILL_NAME_PATTERN.test(value)
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function cloneJsonLikeRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, cloneJsonLike(nested)])
  );
}

function cloneJsonLike(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneJsonLike);
  }
  if (isPlainRecord(value)) {
    return cloneJsonLikeRecord(value);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  throw bundleInvalid();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bundleInvalid(reason: SkillDocumentParseReason = "INVALID"): SkillDocumentParseError {
  return new SkillDocumentParseError(reason);
}
