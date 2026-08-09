import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConnectorBearerAuthenticator, parseConnectorToken } from "./bearer-auth.js";
import { ConnectorCredentialStore } from "./credential-store.js";

const roots: string[] = [];
const AUTH_SCHEME = "Bear" + "er";

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kodegpt-auth-bearer-"));
  roots.push(root);
  return root;
}

function authorization(token: string): string {
  return [AUTH_SCHEME, token].join(" ");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("connector bearer authentication", () => {
  it("rejects malformed connector token syntax", () => {
    expect(parseConnectorToken("invalid-token")).toBeNull();
  });

  it("accepts only the current valid authorization credential", async () => {
    const root = await stateRoot();
    const store = new ConnectorCredentialStore(root);
    const issued = await store.rotate();
    const authenticator = new ConnectorBearerAuthenticator(store);

    await expect(authenticator.authenticate(undefined)).resolves.toBe(false);
    await expect(authenticator.authenticate(issued.token)).resolves.toBe(false);
    await expect(authenticator.authenticate(authorization(issued.token))).resolves.toBe(true);

    const pieces = issued.token.split(".");
    const prefix = pieces[0];
    const credential = pieces[1];
    if (prefix === undefined || credential === undefined) throw new Error("token shape");
    const mutated = `${credential.slice(0, -1)}${credential.endsWith("A") ? "B" : "A"}`;
    await expect(authenticator.authenticate(authorization(`${prefix}.${mutated}`))).resolves.toBe(false);
  });

  it("invalidates the previous credential immediately after durable rotation", async () => {
    const root = await stateRoot();
    const store = new ConnectorCredentialStore(root);
    const first = await store.rotate();
    const authenticator = new ConnectorBearerAuthenticator(store);
    await expect(authenticator.authenticate(authorization(first.token))).resolves.toBe(true);

    const second = await store.rotate();
    await expect(authenticator.authenticate(authorization(first.token))).resolves.toBe(false);
    await expect(authenticator.authenticate(authorization(second.token))).resolves.toBe(true);
  });
});
