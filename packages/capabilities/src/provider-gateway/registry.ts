import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { CapabilityError } from "../errors.js";
import type { ProviderRegistryRecord } from "./contracts.js";
import { ProviderRegistryRecordSchema } from "./schemas.js";

const PROVIDER_REGISTRY_SCHEMA_VERSION = 1 as const;

const ProviderRegistryDocumentSchema = z
  .object({
    schemaVersion: z.literal(PROVIDER_REGISTRY_SCHEMA_VERSION),
    entries: z.array(ProviderRegistryRecordSchema)
  })
  .strict();

type ProviderRegistryDocument = z.infer<typeof ProviderRegistryDocumentSchema>;

export class ProviderRegistryStore {
  readonly #path: string;

  constructor(stateRoot: string) {
    this.#path = join(stateRoot, "providers", "registry.json");
  }

  get path(): string {
    return this.#path;
  }

  async list(): Promise<ProviderRegistryRecord[]> {
    const document = await this.#read();
    return document.entries.map(cloneRecord);
  }

  async get(providerInstanceId: string): Promise<ProviderRegistryRecord | null> {
    const document = await this.#read();
    const record = document.entries.find((entry) => entry.providerInstanceId === providerInstanceId);
    return record === undefined ? null : cloneRecord(record);
  }

  async insert(record: ProviderRegistryRecord): Promise<void> {
    const parsed = parseRecord(record);
    const document = await this.#read();
    if (document.entries.some((entry) => entry.providerInstanceId === parsed.providerInstanceId)) {
      throw stateInvalid(`Provider registry already contains ${parsed.providerInstanceId}`);
    }
    document.entries.push(parsed);
    sortEntries(document.entries);
    await this.#write(document);
  }

  async replace(record: ProviderRegistryRecord): Promise<void> {
    const parsed = parseRecord(record);
    const document = await this.#read();
    const index = document.entries.findIndex((entry) => entry.providerInstanceId === parsed.providerInstanceId);
    if (index < 0) {
      throw stateInvalid(`Provider registry does not contain ${parsed.providerInstanceId}`);
    }
    document.entries[index] = parsed;
    sortEntries(document.entries);
    await this.#write(document);
  }

  async remove(providerInstanceId: string): Promise<boolean> {
    const document = await this.#read();
    const next = document.entries.filter((entry) => entry.providerInstanceId !== providerInstanceId);
    if (next.length === document.entries.length) return false;
    document.entries = next;
    await this.#write(document);
    return true;
  }

  async #read(): Promise<ProviderRegistryDocument> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: PROVIDER_REGISTRY_SCHEMA_VERSION, entries: [] };
      }
      throw stateInvalid("Provider registry could not be read");
    }

    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw stateInvalid("Provider registry is invalid JSON");
    }

    const result = ProviderRegistryDocumentSchema.safeParse(value);
    if (!result.success) {
      throw stateInvalid("Provider registry has invalid or unsupported state");
    }

    const seen = new Set<string>();
    const entries = result.data.entries.map((entry) => {
      const parsed = parseRecord(entry);
      if (seen.has(parsed.providerInstanceId)) {
        throw stateInvalid(`Provider registry contains duplicate ${parsed.providerInstanceId}`);
      }
      seen.add(parsed.providerInstanceId);
      return parsed;
    });
    sortEntries(entries);
    return { schemaVersion: PROVIDER_REGISTRY_SCHEMA_VERSION, entries };
  }

  async #write(document: ProviderRegistryDocument): Promise<void> {
    const validated = parseDocument(document);
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);

    const temporaryPath = join(
      directory,
      `.registry.json.${process.pid}.${randomUUID().replaceAll("-", "")}.tmp`
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
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
      if (error instanceof CapabilityError) throw error;
      throw stateInvalid("Provider registry durable write failed");
    }
  }
}

function parseDocument(value: unknown): ProviderRegistryDocument {
  const result = ProviderRegistryDocumentSchema.safeParse(value);
  if (!result.success) throw stateInvalid("Provider registry document is invalid");
  const entries = result.data.entries.map(parseRecord);
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.providerInstanceId)) {
      throw stateInvalid(`Provider registry contains duplicate ${entry.providerInstanceId}`);
    }
    ids.add(entry.providerInstanceId);
  }
  sortEntries(entries);
  return { schemaVersion: PROVIDER_REGISTRY_SCHEMA_VERSION, entries };
}

function parseRecord(value: unknown): ProviderRegistryRecord {
  const result = ProviderRegistryRecordSchema.safeParse(value);
  if (!result.success) throw stateInvalid("Provider registry record is invalid");
  assertSafeConfig(result.data.nonSecretAdapterConfig);
  return cloneRecord(result.data);
}

function assertSafeConfig(value: Record<string, unknown>): void {
  const seen = new Set<object>();
  visitJson(value, seen);
}

function visitJson(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw stateInvalid("Provider non-secret config must contain finite JSON numbers");
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw stateInvalid("Provider non-secret config must not contain cycles");
    seen.add(value);
    for (const item of value) visitJson(item, seen);
    seen.delete(value);
    return;
  }
  if (typeof value !== "object" || value === undefined) {
    throw stateInvalid("Provider non-secret config must be JSON data");
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw stateInvalid("Provider non-secret config must contain plain JSON objects");
  }
  if (seen.has(value)) throw stateInvalid("Provider non-secret config must not contain cycles");
  seen.add(value);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (looksSecretBearing(key)) {
      throw stateInvalid("Provider registry must not persist secret-bearing config fields");
    }
    visitJson(item, seen);
  }
  seen.delete(value);
}

function looksSecretBearing(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return /(?:password|passwd|secret|token|credential|authorization|apikey|accesskey|privatekey)/.test(normalized);
}

function sortEntries(entries: ProviderRegistryRecord[]): void {
  entries.sort((left, right) => Buffer.from(left.providerInstanceId).compare(Buffer.from(right.providerInstanceId)));
}

function cloneRecord(record: ProviderRegistryRecord): ProviderRegistryRecord {
  return structuredClone(record);
}

function stateInvalid(message: string): CapabilityError {
  return new CapabilityError("PROVIDER_STATE_INVALID", message);
}
