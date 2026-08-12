import { isAbsolute } from "node:path";

import {
  MAX_SOURCE_ENTRIES,
  SKILL_LOAD_MAX_BYTES,
  type PersistedSkillSource,
  type SkillSourceAdmissionResult,
  type SkillSourceReadResult,
  type SkillSourceRuntimeAdapter,
  type SkillSourceTreeResult
} from "./contracts.js";
import { SkillError } from "./errors.js";
import { SkillSourceStore } from "./source-store.js";

export class SkillSourceManager {
  readonly #store: SkillSourceStore;
  readonly #runtime: SkillSourceRuntimeAdapter;
  readonly #activeCapabilities = new Map<string, string>();
  readonly #registrationInFlight = new Map<string, Promise<void>>();

  constructor(store: SkillSourceStore, runtime: SkillSourceRuntimeAdapter) {
    this.#store = store;
    this.#runtime = runtime;
  }

  async addSource(path: string, label: string): Promise<SkillSourceAdmissionResult> {
    const inspection = await this.#runtime.inspectRoot(path);
    const source = await this.#store.add({
      label,
      kind: "agent-skills",
      canonicalRoot: inspection.canonicalRoot,
      identity: inspection.identity
    });
    return {
      sourceId: source.sourceId,
      label: source.label,
      kind: source.kind
    };
  }

  async listSources(): Promise<PersistedSkillSource[]> {
    return this.#store.list();
  }

  async ensureRegistered(sourceId: string): Promise<void> {
    if (this.#activeCapabilities.has(sourceId)) {
      return;
    }
    const existing = this.#registrationInFlight.get(sourceId);
    if (existing !== undefined) {
      return existing;
    }

    const registration = this.#registerSource(sourceId);
    this.#registrationInFlight.set(sourceId, registration);
    try {
      await registration;
    } finally {
      if (this.#registrationInFlight.get(sourceId) === registration) {
        this.#registrationInFlight.delete(sourceId);
      }
    }
  }

  async tree(input: { sourceId: string; path: string }): Promise<SkillSourceTreeResult> {
    if (!isCanonicalRelativePath(input.path, true)) {
      throw boundaryViolation();
    }
    const sourceCapabilityId = await this.#capabilityFor(input.sourceId);
    return this.#runtime.tree({
      sourceCapabilityId,
      path: input.path,
      maxEntries: MAX_SOURCE_ENTRIES
    });
  }

  async read(input: {
    sourceId: string;
    path: string;
    offset: number;
    maxBytes: number;
  }): Promise<SkillSourceReadResult> {
    if (!isCanonicalRelativePath(input.path, false)) {
      throw boundaryViolation();
    }
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes <= 0 ||
      input.maxBytes > SKILL_LOAD_MAX_BYTES
    ) {
      throw new SkillError("SKILL_SOURCE_LIMIT_EXCEEDED", "Skill source read limit exceeded");
    }

    const sourceCapabilityId = await this.#capabilityFor(input.sourceId);
    return this.#runtime.read({
      sourceCapabilityId,
      path: input.path,
      offset: input.offset,
      maxBytes: input.maxBytes
    });
  }

  async removeSource(sourceId: string): Promise<boolean> {
    const sourceCapabilityId = this.#activeCapabilities.get(sourceId);
    if (sourceCapabilityId !== undefined) {
      await this.#runtime.unregister(sourceCapabilityId);
      this.#activeCapabilities.delete(sourceId);
    }
    return this.#store.remove(sourceId);
  }

  async close(): Promise<void> {
    let firstError: unknown;
    for (const [sourceId, sourceCapabilityId] of [...this.#activeCapabilities.entries()]) {
      try {
        await this.#runtime.unregister(sourceCapabilityId);
        this.#activeCapabilities.delete(sourceId);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) {
      if (firstError instanceof SkillError) {
        throw firstError;
      }
      throw new SkillError("SKILL_SOURCE_UNAVAILABLE", "Skill source runtime request failed");
    }
  }

  async #registerSource(sourceId: string): Promise<void> {
    const source = await this.#store.get(sourceId);
    if (source === undefined) {
      throw new SkillError("SKILL_SOURCE_NOT_FOUND", "Skill source was not found");
    }
    const registration = await this.#runtime.register({
      rootPath: source.canonicalRoot,
      expectedIdentity: source.identity
    });
    this.#activeCapabilities.set(sourceId, registration.sourceCapabilityId);
  }

  async #capabilityFor(sourceId: string): Promise<string> {
    await this.ensureRegistered(sourceId);
    const sourceCapabilityId = this.#activeCapabilities.get(sourceId);
    if (sourceCapabilityId === undefined) {
      throw new SkillError("SKILL_SOURCE_UNAVAILABLE", "Skill source registration failed");
    }
    return sourceCapabilityId;
  }
}

function isCanonicalRelativePath(value: string, allowRootDot: boolean): boolean {
  if (value.includes("\0") || isAbsolute(value)) {
    return false;
  }
  if (value === ".") {
    return allowRootDot;
  }
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function boundaryViolation(): SkillError {
  return new SkillError(
    "SKILL_SOURCE_BOUNDARY_VIOLATION",
    "Skill source path must be canonical and relative"
  );
}
