import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export const CONNECTOR_CREDENTIAL_SCHEMA_VERSION = 1 as const;
export const CONNECTOR_TOKEN_PREFIX = "kgc_" as const;
export const CONNECTOR_ID_BYTES = 12;
export const CONNECTOR_SECRET_BYTES = 32;
export const CONNECTOR_VERIFIER_BYTES = 32;
export const CONNECTOR_AUTH_DOMAIN = "kodegpt-connector-v1" as const;

interface ConnectorCredentialDocument {
  schemaVersion: typeof CONNECTOR_CREDENTIAL_SCHEMA_VERSION;
  id: string;
  verifier: string;
  createdAt: string;
  rotatedAt: string;
}

export interface ConnectorVerifierRecord {
  id: string;
  verifier: string;
}

export type ConnectorCredentialStatus =
  | { configured: false }
  | {
      configured: true;
      id: string;
      createdAt: string;
      rotatedAt: string;
    };

export interface IssuedConnectorCredential {
  token: string;
  status: Extract<ConnectorCredentialStatus, { configured: true }>;
}

export class ConnectorCredentialStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConnectorCredentialStoreError";
    this.code = code;
  }
}

export class ConnectorCredentialStore {
  readonly #path: string;

  constructor(stateRoot: string) {
    this.#path = join(stateRoot, "auth", "connector.json");
  }

  get path(): string {
    return this.#path;
  }

  async status(): Promise<ConnectorCredentialStatus> {
    const document = await this.#read();
    return document === undefined ? { configured: false } : publicStatus(document);
  }

  async loadVerifier(): Promise<ConnectorVerifierRecord | undefined> {
    const document = await this.#read();
    return document === undefined ? undefined : { id: document.id, verifier: document.verifier };
  }

  async rotate(): Promise<IssuedConnectorCredential> {
    const previous = await this.#read();
    const id = randomBytes(CONNECTOR_ID_BYTES).toString("base64url");
    const secret = randomBytes(CONNECTOR_SECRET_BYTES).toString("base64url");
    const now = new Date().toISOString();
    const document: ConnectorCredentialDocument = {
      schemaVersion: CONNECTOR_CREDENTIAL_SCHEMA_VERSION,
      id,
      verifier: deriveConnectorVerifier(id, secret),
      createdAt: previous?.createdAt ?? now,
      rotatedAt: now
    };
    await this.#write(document);
    return {
      token: [CONNECTOR_TOKEN_PREFIX, id, ".", secret].join(""),
      status: publicStatus(document)
    };
  }

  async #read(): Promise<ConnectorCredentialDocument | undefined> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      throw new ConnectorCredentialStoreError(
        "CONNECTOR_CREDENTIAL_INVALID",
        `Connector credential store is invalid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!isRecord(value)) {
      throw new ConnectorCredentialStoreError(
        "CONNECTOR_CREDENTIAL_INVALID",
        "Connector credential store must be an object"
      );
    }
    if (value.schemaVersion !== CONNECTOR_CREDENTIAL_SCHEMA_VERSION) {
      throw new ConnectorCredentialStoreError(
        "CONNECTOR_CREDENTIAL_VERSION_UNSUPPORTED",
        `Unsupported connector credential schema version: ${String(value.schemaVersion)}`
      );
    }
    const keys = Object.keys(value).sort();
    const expectedKeys = ["createdAt", "id", "rotatedAt", "schemaVersion", "verifier"];
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
      throw new ConnectorCredentialStoreError(
        "CONNECTOR_CREDENTIAL_INVALID",
        "Connector credential store contains unexpected fields"
      );
    }
    if (
      typeof value.id !== "string" ||
      !isCanonicalBase64Url(value.id, CONNECTOR_ID_BYTES) ||
      typeof value.verifier !== "string" ||
      !isCanonicalBase64Url(value.verifier, CONNECTOR_VERIFIER_BYTES) ||
      typeof value.createdAt !== "string" ||
      !isIsoTimestamp(value.createdAt) ||
      typeof value.rotatedAt !== "string" ||
      !isIsoTimestamp(value.rotatedAt)
    ) {
      throw new ConnectorCredentialStoreError(
        "CONNECTOR_CREDENTIAL_INVALID",
        "Connector credential store fields are invalid"
      );
    }
    return {
      schemaVersion: CONNECTOR_CREDENTIAL_SCHEMA_VERSION,
      id: value.id,
      verifier: value.verifier,
      createdAt: value.createdAt,
      rotatedAt: value.rotatedAt
    };
  }

  async #write(document: ConnectorCredentialDocument): Promise<void> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = join(
      directory,
      `.connector.json.${process.pid}.${randomUUID().replaceAll("-", "")}.tmp`
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

export function deriveConnectorVerifier(id: string, secret: string): string {
  if (!isCanonicalBase64Url(id, CONNECTOR_ID_BYTES)) {
    throw new ConnectorCredentialStoreError("CONNECTOR_TOKEN_INVALID", "Connector token id is invalid");
  }
  if (!isCanonicalBase64Url(secret, CONNECTOR_SECRET_BYTES)) {
    throw new ConnectorCredentialStoreError(
      "CONNECTOR_TOKEN_INVALID",
      "Connector token secret is invalid"
    );
  }
  return createHash("sha256")
    .update(CONNECTOR_AUTH_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(id, "utf8")
    .update("\0", "utf8")
    .update(secret, "utf8")
    .digest("base64url");
}

export function isCanonicalBase64Url(value: string, expectedBytes: number): boolean {
  const expectedEncodedLength = Math.ceil((expectedBytes * 8) / 6);
  if (value.length !== expectedEncodedLength || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return false;
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === expectedBytes && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

function publicStatus(
  document: ConnectorCredentialDocument
): Extract<ConnectorCredentialStatus, { configured: true }> {
  return {
    configured: true,
    id: document.id,
    createdAt: document.createdAt,
    rotatedAt: document.rotatedAt
  };
}

function isIsoTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
