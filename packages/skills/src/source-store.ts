import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import {
  MAX_SOURCES,
  SKILL_STATE_SCHEMA_VERSION,
  type PersistedSkillSource,
  type PersistedSkillSourceIdentity,
  type SkillSourceAdmissionInput
} from "./contracts.js";
import { SkillError } from "./errors.js";

interface SkillSourceStoreDocument {
  schemaVersion: typeof SKILL_STATE_SCHEMA_VERSION;
  sources: PersistedSkillSource[];
}

const identitySchema = z
  .object({
    deviceMajor: z.number().int().nonnegative().safe(),
    deviceMinor: z.number().int().nonnegative().safe(),
    inode: z.string().regex(/^\d+$/)
  })
  .strict();

const persistedSourceSchema = z
  .object({
    sourceId: z.string().regex(/^ss_[a-f0-9]{32}$/),
    label: z.string().min(1),
    kind: z.literal("agent-skills"),
    canonicalRoot: z
      .string()
      .startsWith("/")
      .refine((value) => resolve(value) === value),
    identity: identitySchema
  })
  .strict();

const admissionSchema = persistedSourceSchema.omit({ sourceId: true });

const documentSchema = z
  .object({
    schemaVersion: z.literal(SKILL_STATE_SCHEMA_VERSION),
    sources: z.array(persistedSourceSchema).max(MAX_SOURCES)
  })
  .strict();

export class SkillSourceStore {
  readonly #path: string;

  constructor(stateRoot: string) {
    this.#path = join(stateRoot, "skills", "sources.json");
  }

  get path(): string {
    return this.#path;
  }

  async list(): Promise<PersistedSkillSource[]> {
    const document = await this.#read();
    return document.sources.map(cloneSource);
  }

  async get(sourceId: string): Promise<PersistedSkillSource | undefined> {
    const document = await this.#read();
    const source = document.sources.find((candidate) => candidate.sourceId === sourceId);
    return source === undefined ? undefined : cloneSource(source);
  }

  async add(input: SkillSourceAdmissionInput): Promise<PersistedSkillSource> {
    const parsedInput = admissionSchema.safeParse(input);
    if (!parsedInput.success) {
      throw registryInvalid();
    }

    const document = await this.#read();
    if (document.sources.length >= MAX_SOURCES) {
      throw new SkillError("SKILL_SOURCE_LIMIT_EXCEEDED", "Skill source limit exceeded");
    }
    if (document.sources.some((source) => sameIdentity(source.identity, parsedInput.data.identity))) {
      throw registryInvalid();
    }

    const source: PersistedSkillSource = {
      sourceId: `ss_${randomUUID().replaceAll("-", "")}`,
      ...parsedInput.data
    };
    document.sources.push(source);
    await this.#write(document);
    return cloneSource(source);
  }

  async remove(sourceId: string): Promise<boolean> {
    const document = await this.#read();
    const next = document.sources.filter((source) => source.sourceId !== sourceId);
    if (next.length === document.sources.length) {
      return false;
    }
    document.sources = next;
    await this.#write(document);
    return true;
  }

  async #read(): Promise<SkillSourceStoreDocument> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: SKILL_STATE_SCHEMA_VERSION, sources: [] };
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw registryInvalid();
    }

    if (isRecord(value) && "schemaVersion" in value && value.schemaVersion !== SKILL_STATE_SCHEMA_VERSION) {
      throw new SkillError(
        "SKILL_REGISTRY_SCHEMA_UNSUPPORTED",
        "Skill registry schema version is unsupported"
      );
    }

    const parsed = documentSchema.safeParse(value);
    if (!parsed.success) {
      throw registryInvalid();
    }
    validateUniqueSources(parsed.data.sources);
    return {
      schemaVersion: SKILL_STATE_SCHEMA_VERSION,
      sources: parsed.data.sources.map(cloneSource)
    };
  }

  async #write(document: SkillSourceStoreDocument): Promise<void> {
    validateUniqueSources(document.sources);
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);

    const temporaryPath = join(
      directory,
      `.sources.json.${process.pid}.${randomUUID().replaceAll("-", "")}.tmp`
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;

      await rename(temporaryPath, this.#path);
      await chmod(this.#path, 0o600);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function validateUniqueSources(sources: PersistedSkillSource[]): void {
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const source of sources) {
    const identityKey = `${source.identity.deviceMajor}:${source.identity.deviceMinor}:${source.identity.inode}`;
    if (ids.has(source.sourceId) || identities.has(identityKey)) {
      throw registryInvalid();
    }
    ids.add(source.sourceId);
    identities.add(identityKey);
  }
}

function sameIdentity(
  left: PersistedSkillSourceIdentity,
  right: PersistedSkillSourceIdentity
): boolean {
  return (
    left.deviceMajor === right.deviceMajor &&
    left.deviceMinor === right.deviceMinor &&
    left.inode === right.inode
  );
}

function cloneSource(source: PersistedSkillSource): PersistedSkillSource {
  return {
    ...source,
    identity: { ...source.identity }
  };
}

function registryInvalid(): SkillError {
  return new SkillError("SKILL_REGISTRY_INVALID", "Skill registry is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
