import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONNECTOR_CREDENTIAL_SCHEMA_VERSION,
  ConnectorCredentialStore
} from "./credential-store.js";

const roots: string[] = [];

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kodegpt-auth-store-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ConnectorCredentialStore", () => {
  it("issues kgc tokens while persisting verifier-only durable state", async () => {
    const root = await stateRoot();
    const store = new ConnectorCredentialStore(root);

    expect(await store.status()).toEqual({ configured: false });

    const issued = await store.rotate();
    expect(issued.token).toMatch(/^kgc_[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
    expect(issued.status.configured).toBe(true);
    if (!issued.status.configured) throw new Error("credential must be configured");
    expect(issued.status.id).toMatch(/^[A-Za-z0-9_-]{16}$/);

    const text = await readFile(store.path, "utf8");
    const document = JSON.parse(text) as Record<string, unknown>;
    expect(document.schemaVersion).toBe(CONNECTOR_CREDENTIAL_SCHEMA_VERSION);
    expect(text).not.toContain(issued.token);
    expect(text).not.toContain(issued.token.split(".")[1] ?? "unexpected");
    expect(document).not.toHaveProperty("token");
    expect(document).not.toHaveProperty("secret");

    const fileStat = await stat(store.path);
    const directoryStat = await stat(join(root, "auth"));
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(directoryStat.mode & 0o777).toBe(0o700);

    const restarted = new ConnectorCredentialStore(root);
    expect(await restarted.status()).toEqual(issued.status);
    expect(await restarted.loadVerifier()).toMatchObject({ id: issued.status.id });
  });

  it("persists the exact domain-separated SHA-256 verifier", async () => {
    const root = await stateRoot();
    const store = new ConnectorCredentialStore(root);
    const issued = await store.rotate();
    const [prefixAndId, secret] = issued.token.split(".");
    if (prefixAndId === undefined || secret === undefined) throw new Error("token shape");
    const id = prefixAndId.slice("kgc_".length);
    const expected = createHash("sha256")
      .update("kodegpt-connector-v1", "utf8")
      .update("\0", "utf8")
      .update(id, "utf8")
      .update("\0", "utf8")
      .update(secret, "utf8")
      .digest("base64url");
    const persisted = JSON.parse(await readFile(store.path, "utf8")) as Record<string, unknown>;
    expect(persisted.verifier).toBe(expected);
  });

  it("rotates to a new id/verifier and never exposes the previous plaintext", async () => {
    const root = await stateRoot();
    const store = new ConnectorCredentialStore(root);

    const first = await store.rotate();
    const second = await store.rotate();

    expect(second.token).not.toBe(first.token);
    if (!first.status.configured || !second.status.configured) {
      throw new Error("credential must be configured");
    }
    expect(second.status.id).not.toBe(first.status.id);
    const text = await readFile(store.path, "utf8");
    expect(text).not.toContain(first.token);
    expect(text).not.toContain(second.token);
    expect(text).not.toContain(first.token.split(".")[1] ?? "unexpected");
    expect(text).not.toContain(second.token.split(".")[1] ?? "unexpected");
  });

  it("rejects future schema versions instead of silently accepting them", async () => {
    const root = await stateRoot();
    const store = new ConnectorCredentialStore(root);
    await store.rotate();
    const current = JSON.parse(await readFile(store.path, "utf8")) as Record<string, unknown>;
    await writeFile(
      store.path,
      `${JSON.stringify({ ...current, schemaVersion: CONNECTOR_CREDENTIAL_SCHEMA_VERSION + 1 })}\n`,
      "utf8"
    );

    await expect(store.status()).rejects.toMatchObject({
      code: "CONNECTOR_CREDENTIAL_VERSION_UNSUPPORTED"
    });
  });
});
