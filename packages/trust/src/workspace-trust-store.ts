import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export const TRUST_STORE_SCHEMA_VERSION = 1 as const;

export type ProfileCeiling = "observe" | "develop" | "trusted";

export interface PersistentFilesystemIdentity {
  deviceMajor: number;
  deviceMinor: number;
  inode: string;
}

export interface TrustedWorkspaceEntry {
  id: string;
  canonicalRoot: string;
  identity: PersistentFilesystemIdentity;
  profileCeiling: ProfileCeiling;
  trustedAt: string;
}

interface TrustStoreDocument {
  schemaVersion: typeof TRUST_STORE_SCHEMA_VERSION;
  entries: TrustedWorkspaceEntry[];
}

export class WorkspaceTrustError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkspaceTrustError";
    this.code = code;
  }
}

export class WorkspaceIdentityChangedError extends WorkspaceTrustError {
  constructor(canonicalRoot: string) {
    super(
      "WORKSPACE_IDENTITY_CHANGED",
      `Trusted workspace identity changed for ${canonicalRoot}`
    );
    this.name = "WorkspaceIdentityChangedError";
  }
}

export class WorkspaceTrustStoreVersionError extends WorkspaceTrustError {
  constructor(version: unknown) {
    super(
      "TRUST_STORE_VERSION_UNSUPPORTED",
      `Unsupported workspace trust store schema version: ${String(version)}`
    );
    this.name = "WorkspaceTrustStoreVersionError";
  }
}

export class WorkspaceNotTrustedError extends WorkspaceTrustError {
  constructor(canonicalRoot: string) {
    super("WORKSPACE_NOT_TRUSTED", `Workspace is not trusted: ${canonicalRoot}`);
    this.name = "WorkspaceNotTrustedError";
  }
}

export class WorkspaceTrustStore {
  readonly #path: string;

  constructor(stateRoot: string) {
    this.#path = join(stateRoot, "trust", "workspaces.json");
  }

  get path(): string {
    return this.#path;
  }

  async list(): Promise<TrustedWorkspaceEntry[]> {
    const document = await this.#read();
    return document.entries.map(cloneEntry);
  }

  async trust(input: {
    canonicalRoot: string;
    identity: PersistentFilesystemIdentity;
    profileCeiling: ProfileCeiling;
  }): Promise<TrustedWorkspaceEntry> {
    validateCanonicalRoot(input.canonicalRoot);
    validateIdentity(input.identity);
    validateProfileCeiling(input.profileCeiling);

    const document = await this.#read();
    const existingIndex = document.entries.findIndex(
      (entry) => entry.canonicalRoot === input.canonicalRoot
    );
    const existing = existingIndex >= 0 ? document.entries[existingIndex] : undefined;
    const entry: TrustedWorkspaceEntry = {
      id: existing?.id ?? `trust_${randomUUID().replaceAll("-", "")}`,
      canonicalRoot: input.canonicalRoot,
      identity: { ...input.identity },
      profileCeiling: input.profileCeiling,
      trustedAt: new Date().toISOString()
    };

    if (existingIndex >= 0) {
      document.entries[existingIndex] = entry;
    } else {
      document.entries.push(entry);
    }
    document.entries.sort((left, right) => left.canonicalRoot.localeCompare(right.canonicalRoot));
    await this.#write(document);
    return cloneEntry(entry);
  }

  async untrust(id: string): Promise<boolean> {
    const document = await this.#read();
    const next = document.entries.filter((entry) => entry.id !== id);
    if (next.length === document.entries.length) {
      return false;
    }
    document.entries = next;
    await this.#write(document);
    return true;
  }

  async requireTrusted(
    canonicalRoot: string,
    actualIdentity: PersistentFilesystemIdentity
  ): Promise<TrustedWorkspaceEntry> {
    validateIdentity(actualIdentity);
    const document = await this.#read();
    const entry = document.entries.find((candidate) => candidate.canonicalRoot === canonicalRoot);
    if (entry === undefined) {
      throw new WorkspaceNotTrustedError(canonicalRoot);
    }
    if (!sameIdentity(entry.identity, actualIdentity)) {
      throw new WorkspaceIdentityChangedError(canonicalRoot);
    }
    return cloneEntry(entry);
  }

  async #read(): Promise<TrustStoreDocument> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: TRUST_STORE_SCHEMA_VERSION, entries: [] };
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      throw new WorkspaceTrustError(
        "TRUST_STORE_INVALID",
        `Workspace trust store is invalid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (!isRecord(value)) {
      throw new WorkspaceTrustError("TRUST_STORE_INVALID", "Workspace trust store must be an object");
    }
    if (value.schemaVersion !== TRUST_STORE_SCHEMA_VERSION) {
      throw new WorkspaceTrustStoreVersionError(value.schemaVersion);
    }
    if (!Array.isArray(value.entries)) {
      throw new WorkspaceTrustError("TRUST_STORE_INVALID", "Workspace trust entries must be an array");
    }

    const entries = value.entries.map(parseEntry);
    return { schemaVersion: TRUST_STORE_SCHEMA_VERSION, entries };
  }

  async #write(document: TrustStoreDocument): Promise<void> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);

    const temporaryPath = join(
      directory,
      `.workspaces.json.${process.pid}.${randomUUID().replaceAll("-", "")}.tmp`
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

function parseEntry(value: unknown): TrustedWorkspaceEntry {
  if (!isRecord(value)) {
    throw new WorkspaceTrustError("TRUST_STORE_INVALID", "Trusted workspace entry must be an object");
  }
  if (
    typeof value.id !== "string" ||
    typeof value.canonicalRoot !== "string" ||
    !isRecord(value.identity) ||
    typeof value.profileCeiling !== "string" ||
    typeof value.trustedAt !== "string"
  ) {
    throw new WorkspaceTrustError("TRUST_STORE_INVALID", "Trusted workspace entry has invalid fields");
  }

  const identity: PersistentFilesystemIdentity = {
    deviceMajor: value.identity.deviceMajor as number,
    deviceMinor: value.identity.deviceMinor as number,
    inode: value.identity.inode as string
  };
  validateCanonicalRoot(value.canonicalRoot);
  validateIdentity(identity);
  validateProfileCeiling(value.profileCeiling);

  return {
    id: value.id,
    canonicalRoot: value.canonicalRoot,
    identity,
    profileCeiling: value.profileCeiling,
    trustedAt: value.trustedAt
  };
}

function validateCanonicalRoot(value: string): void {
  if (!value.startsWith("/")) {
    throw new WorkspaceTrustError("TRUST_STORE_INVALID", "Canonical workspace root must be absolute");
  }
}

function validateIdentity(value: PersistentFilesystemIdentity): void {
  if (
    !Number.isSafeInteger(value.deviceMajor) ||
    value.deviceMajor < 0 ||
    !Number.isSafeInteger(value.deviceMinor) ||
    value.deviceMinor < 0 ||
    typeof value.inode !== "string" ||
    !/^\d+$/.test(value.inode)
  ) {
    throw new WorkspaceTrustError("TRUST_STORE_INVALID", "Invalid persistent filesystem identity");
  }
}

function validateProfileCeiling(value: string): asserts value is ProfileCeiling {
  if (value !== "observe" && value !== "develop" && value !== "trusted") {
    throw new WorkspaceTrustError("TRUST_STORE_INVALID", `Invalid profile ceiling: ${value}`);
  }
}

function sameIdentity(
  left: PersistentFilesystemIdentity,
  right: PersistentFilesystemIdentity
): boolean {
  return (
    left.deviceMajor === right.deviceMajor &&
    left.deviceMinor === right.deviceMinor &&
    left.inode === right.inode
  );
}

function cloneEntry(entry: TrustedWorkspaceEntry): TrustedWorkspaceEntry {
  return {
    ...entry,
    identity: { ...entry.identity }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
