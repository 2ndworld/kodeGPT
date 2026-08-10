import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  EXTENSION_LIST_MAX,
  ExtensionManifestError,
  parseExtensionManifest,
  type ExtensionManifestV1
} from "./manifest-schema.js";

export interface PublicExtensionMetadata extends ExtensionManifestV1 {
  enabled: true;
}

type PersistedExtension = {
  enabled: true;
  manifest: ExtensionManifestV1;
};

type PersistedRegistry = {
  schemaVersion: 1;
  extensions: PersistedExtension[];
};

export class ExtensionRegistryError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExtensionRegistryError";
    this.code = code;
  }
}

export class ExtensionRegistry {
  readonly #registryDir: string;
  readonly #registryPath: string;
  readonly #extensions = new Map<string, PersistedExtension>();

  private constructor(stateRoot: string) {
    this.#registryDir = join(stateRoot, "extensions");
    this.#registryPath = join(this.#registryDir, "registry.json");
  }

  static async open(stateRoot: string): Promise<ExtensionRegistry> {
    if (stateRoot.length === 0) {
      throw new ExtensionRegistryError("EXTENSION_REGISTRY_ROOT_INVALID", "state root is empty");
    }
    const registry = new ExtensionRegistry(stateRoot);
    await mkdir(registry.#registryDir, { recursive: true, mode: 0o700 });
    await registry.#load();
    return registry;
  }

  async enable(manifest: ExtensionManifestV1): Promise<void> {
    const validated = parseExtensionManifest(manifest);
    this.#extensions.set(validated.id, { enabled: true, manifest: validated });
    await this.#persist();
  }

  async disable(id: string): Promise<void> {
    if (id.length === 0) return;
    if (this.#extensions.delete(id)) {
      await this.#persist();
    }
  }

  listEnabled(limit = EXTENSION_LIST_MAX): PublicExtensionMetadata[] {
    const bounded = Number.isFinite(limit)
      ? Math.min(EXTENSION_LIST_MAX, Math.max(1, Math.trunc(limit)))
      : EXTENSION_LIST_MAX;
    return [...this.#extensions.values()]
      .filter((entry) => entry.enabled)
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
      .slice(0, bounded)
      .map(({ manifest }) => ({ ...structuredClone(manifest), enabled: true as const }));
  }

  async #load(): Promise<void> {
    let source: string;
    try {
      source = await readFile(this.#registryPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new ExtensionRegistryError(
        "EXTENSION_REGISTRY_READ_FAILED",
        "extension registry could not be read",
        { cause: error }
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new ExtensionRegistryError(
        "EXTENSION_REGISTRY_INVALID",
        "extension registry is not valid JSON",
        { cause: error }
      );
    }
    const persisted = parsePersistedRegistry(parsed);
    this.#extensions.clear();
    for (const extension of persisted.extensions) {
      if (this.#extensions.has(extension.manifest.id)) {
        throw new ExtensionRegistryError(
          "EXTENSION_REGISTRY_INVALID",
          `duplicate extension id ${extension.manifest.id}`
        );
      }
      this.#extensions.set(extension.manifest.id, extension);
    }
  }

  async #persist(): Promise<void> {
    const persisted: PersistedRegistry = {
      schemaVersion: 1,
      extensions: [...this.#extensions.values()].sort((left, right) =>
        left.manifest.id.localeCompare(right.manifest.id)
      )
    };
    const temporary = join(this.#registryDir, `.registry.${process.pid}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
      await rename(temporary, this.#registryPath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new ExtensionRegistryError(
        "EXTENSION_REGISTRY_WRITE_FAILED",
        "extension registry could not be persisted",
        { cause: error }
      );
    }
  }
}

function parsePersistedRegistry(value: unknown): PersistedRegistry {
  const root = requireRecord(value);
  assertExactKeys(root, ["schemaVersion", "extensions"]);
  if (root.schemaVersion !== 1) {
    throw new ExtensionRegistryError(
      "EXTENSION_REGISTRY_SCHEMA_UNSUPPORTED",
      "only extension registry schemaVersion 1 is supported"
    );
  }
  if (!Array.isArray(root.extensions) || root.extensions.length > EXTENSION_LIST_MAX) {
    throw new ExtensionRegistryError("EXTENSION_REGISTRY_INVALID", "extensions list is invalid");
  }
  const extensions = root.extensions.map((value) => {
    const entry = requireRecord(value);
    assertExactKeys(entry, ["enabled", "manifest"]);
    if (entry.enabled !== true) {
      throw new ExtensionRegistryError("EXTENSION_REGISTRY_INVALID", "persisted extension must be enabled");
    }
    try {
      return { enabled: true as const, manifest: parseExtensionManifest(entry.manifest) };
    } catch (error) {
      if (error instanceof ExtensionManifestError) {
        throw new ExtensionRegistryError(
          "EXTENSION_REGISTRY_INVALID",
          "persisted extension manifest is invalid",
          { cause: error }
        );
      }
      throw error;
    }
  });
  return { schemaVersion: 1, extensions };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExtensionRegistryError("EXTENSION_REGISTRY_INVALID", "registry entry must be an object");
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) {
    throw new ExtensionRegistryError("EXTENSION_REGISTRY_INVALID", "registry contains unknown fields");
  }
}
