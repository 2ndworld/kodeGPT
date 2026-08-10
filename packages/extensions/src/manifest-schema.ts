import { readFile } from "node:fs/promises";

export const EXTENSION_MANIFEST_SCHEMA_VERSION = 1 as const;
export const EXTENSION_LIST_MAX = 100;

export type ExtensionProfileName = "observe" | "develop" | "trusted";

export interface ExtensionManifestV1 {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  capabilities: {
    documentation?: {
      summary?: string;
      url?: string;
    };
    profileRestrictions?: {
      maxProfile?: ExtensionProfileName;
      denyWrite?: boolean;
      denyProcess?: boolean;
      denyNetwork?: boolean;
    };
  };
}

export class ExtensionManifestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ExtensionManifestError";
    this.code = code;
  }
}

export async function loadExtensionManifest(path: string): Promise<ExtensionManifestV1> {
  if (path.length === 0) {
    throw new ExtensionManifestError("EXTENSION_MANIFEST_PATH_INVALID", "manifest path is empty");
  }
  const source = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new ExtensionManifestError("EXTENSION_MANIFEST_JSON_INVALID", "manifest is not valid JSON");
  }
  return parseExtensionManifest(parsed);
}

export function parseExtensionManifest(value: unknown): ExtensionManifestV1 {
  const root = requireObject(value, "manifest");
  assertExactKeys(root, ["schemaVersion", "id", "name", "version", "description", "capabilities"]);
  if (root.schemaVersion !== EXTENSION_MANIFEST_SCHEMA_VERSION) {
    throw new ExtensionManifestError(
      "EXTENSION_MANIFEST_SCHEMA_UNSUPPORTED",
      "only extension manifest schemaVersion 1 is supported"
    );
  }
  const id = boundedString(root.id, "id", 1, 96);
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(id)) {
    throw new ExtensionManifestError("EXTENSION_MANIFEST_INVALID", "id is invalid");
  }
  const name = boundedString(root.name, "name", 1, 120);
  const version = boundedString(root.version, "version", 1, 64);
  const description = optionalBoundedString(root.description, "description", 1, 500);

  const capabilities = requireObject(root.capabilities, "capabilities");
  assertExactKeys(capabilities, ["documentation", "profileRestrictions"]);
  const documentation = parseDocumentation(capabilities.documentation);
  const profileRestrictions = parseProfileRestrictions(capabilities.profileRestrictions);
  if (documentation === undefined && profileRestrictions === undefined) {
    throw new ExtensionManifestError(
      "EXTENSION_MANIFEST_INVALID",
      "capabilities must declare documentation or profileRestrictions"
    );
  }

  return {
    schemaVersion: 1,
    id,
    name,
    version,
    ...(description === undefined ? {} : { description }),
    capabilities: {
      ...(documentation === undefined ? {} : { documentation }),
      ...(profileRestrictions === undefined ? {} : { profileRestrictions })
    }
  };
}

function parseDocumentation(value: unknown): ExtensionManifestV1["capabilities"]["documentation"] {
  if (value === undefined) return undefined;
  const object = requireObject(value, "capabilities.documentation");
  assertExactKeys(object, ["summary", "url"]);
  const summary = optionalBoundedString(object.summary, "documentation.summary", 1, 1000);
  const urlValue = optionalBoundedString(object.url, "documentation.url", 1, 2048);
  let url: string | undefined;
  if (urlValue !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(urlValue);
    } catch {
      throw new ExtensionManifestError("EXTENSION_MANIFEST_INVALID", "documentation.url is invalid");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
      throw new ExtensionManifestError(
        "EXTENSION_MANIFEST_INVALID",
        "documentation.url must be credential-free HTTPS"
      );
    }
    url = parsed.toString();
  }
  if (summary === undefined && url === undefined) {
    throw new ExtensionManifestError("EXTENSION_MANIFEST_INVALID", "documentation is empty");
  }
  return { ...(summary === undefined ? {} : { summary }), ...(url === undefined ? {} : { url }) };
}

function parseProfileRestrictions(
  value: unknown
): ExtensionManifestV1["capabilities"]["profileRestrictions"] {
  if (value === undefined) return undefined;
  const object = requireObject(value, "capabilities.profileRestrictions");
  assertExactKeys(object, ["maxProfile", "denyWrite", "denyProcess", "denyNetwork"]);
  const maxProfile = object.maxProfile;
  if (maxProfile !== undefined && maxProfile !== "observe" && maxProfile !== "develop" && maxProfile !== "trusted") {
    throw new ExtensionManifestError("EXTENSION_MANIFEST_INVALID", "profileRestrictions.maxProfile is invalid");
  }
  for (const key of ["denyWrite", "denyProcess", "denyNetwork"] as const) {
    if (object[key] !== undefined && typeof object[key] !== "boolean") {
      throw new ExtensionManifestError("EXTENSION_MANIFEST_INVALID", `profileRestrictions.${key} must be boolean`);
    }
  }
  if (
    maxProfile === undefined &&
    object.denyWrite === undefined &&
    object.denyProcess === undefined &&
    object.denyNetwork === undefined
  ) {
    throw new ExtensionManifestError("EXTENSION_MANIFEST_INVALID", "profileRestrictions is empty");
  }
  return {
    ...(maxProfile === undefined ? {} : { maxProfile }),
    ...(object.denyWrite === undefined ? {} : { denyWrite: object.denyWrite as boolean }),
    ...(object.denyProcess === undefined ? {} : { denyProcess: object.denyProcess as boolean }),
    ...(object.denyNetwork === undefined ? {} : { denyNetwork: object.denyNetwork as boolean })
  };
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExtensionManifestError("EXTENSION_MANIFEST_INVALID", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowedKeys: string[]): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ExtensionManifestError(
      "EXTENSION_MANIFEST_UNKNOWN_FIELD",
      `unknown manifest field: ${unknown.sort()[0]}`
    );
  }
}

function boundedString(value: unknown, field: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || value.trim() !== value) {
    throw new ExtensionManifestError("EXTENSION_MANIFEST_INVALID", `${field} is invalid`);
  }
  return value;
}

function optionalBoundedString(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
): string | undefined {
  return value === undefined ? undefined : boundedString(value, field, minimum, maximum);
}
