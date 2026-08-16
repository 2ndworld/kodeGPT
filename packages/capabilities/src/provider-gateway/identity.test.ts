import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { ProviderAdapterManifest } from "./contracts.js";
import { resolveProviderImplementationIdentity } from "./identity.js";

let root = "";
const manifest: ProviderAdapterManifest = {
  adapterId: "test.fixture.read.v1",
  adapterContractVersion: "1",
  implementationDigest: "a".repeat(64),
  inventoryMode: "STATIC",
  networkPolicy: { kind: "internet", origins: ["https://fixture.example"], redirect: null },
  credentialBroker: { kind: "none" },
  operations: [{
    id: "record.read",
    method: "GET",
    origin: "https://fixture.example",
    pathTemplate: "/records/{id}",
    allowedQueryKeys: [],
    fixedHeaders: {},
    inputSchema: z.object({ id: z.string() }).strict(),
    encodeRequest: (input) => ({ pathParameters: { id: (input as { id: string }).id } })
  }],
  mappings: [{
    semanticCapabilityId: "test.fixture.record.read",
    adapterId: "test.fixture.read.v1",
    adapterOperationId: "record.read",
    effect: "REMOTE_READ",
    workspaceBinding: "NONE",
    inputSchema: z.object({ id: z.string() }).strict(),
    outputSchema: z.object({ id: z.string() }).strict(),
    maxProviderRequests: 1,
    retry: "none",
    auditFields: ["id"]
  }]
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kodegpt-provider-identity-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function helper(path: string, body = "#!/bin/sh\nexit 0\n") {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body, { mode: 0o700 });
  await chmod(path, 0o700);
  return createHash("sha256").update(body).digest("hex");
}

describe("resolveProviderImplementationIdentity", () => {
  it("computes a deterministic manifest-only identity when credentials need no helper", async () => {
    const first = await resolveProviderImplementationIdentity({ manifest, credentialBroker: { kind: "none" }, workspaceRoots: [] });
    const second = await resolveProviderImplementationIdentity({ manifest, credentialBroker: { kind: "none" }, workspaceRoots: [join(root, "workspace")] });
    expect(first).toEqual(second);
    expect(first.helperIdentity).toBeNull();
    expect(first.implementationFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("resolves and pins an executable helper outside workspaces", async () => {
    const helperPath = join(root, "helpers", "auth-helper");
    const digest = await helper(helperPath);
    const identity = await resolveProviderImplementationIdentity({
      manifest,
      credentialBroker: { kind: "external-helper", helperPath, helperSha256: digest },
      workspaceRoots: [join(root, "workspace")]
    });
    expect(identity.helperIdentity).toEqual({ canonicalPath: helperPath, sha256: digest });
    expect(identity.implementationFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a helper selected from a workspace, including through a symlink", async () => {
    const workspaceRoot = join(root, "workspace");
    const workspaceHelper = join(workspaceRoot, "auth-helper");
    const digest = await helper(workspaceHelper);
    await expect(resolveProviderImplementationIdentity({
      manifest,
      credentialBroker: { kind: "external-helper", helperPath: workspaceHelper, helperSha256: digest },
      workspaceRoots: [workspaceRoot]
    })).rejects.toMatchObject({ code: "PROVIDER_INPUT_INVALID" });

    const link = join(root, "outside-link");
    await symlink(workspaceHelper, link);
    await expect(resolveProviderImplementationIdentity({
      manifest,
      credentialBroker: { kind: "external-helper", helperPath: link, helperSha256: digest },
      workspaceRoots: [workspaceRoot]
    })).rejects.toMatchObject({ code: "PROVIDER_INPUT_INVALID" });
  });

  it("rejects relative, missing, non-executable, non-regular, and digest-mismatched helpers", async () => {
    const valid = join(root, "helper");
    const digest = await helper(valid);
    await expect(resolveProviderImplementationIdentity({ manifest, credentialBroker: { kind: "external-helper", helperPath: "./helper", helperSha256: digest }, workspaceRoots: [] }))
      .rejects.toMatchObject({ code: "PROVIDER_INPUT_INVALID" });
    await expect(resolveProviderImplementationIdentity({ manifest, credentialBroker: { kind: "external-helper", helperPath: join(root, "missing"), helperSha256: digest }, workspaceRoots: [] }))
      .rejects.toMatchObject({ code: "PROVIDER_INPUT_INVALID" });

    await chmod(valid, 0o600);
    await expect(resolveProviderImplementationIdentity({ manifest, credentialBroker: { kind: "external-helper", helperPath: valid, helperSha256: digest }, workspaceRoots: [] }))
      .rejects.toMatchObject({ code: "PROVIDER_INPUT_INVALID" });
    await chmod(valid, 0o700);
    await expect(resolveProviderImplementationIdentity({ manifest, credentialBroker: { kind: "external-helper", helperPath: root, helperSha256: digest }, workspaceRoots: [] }))
      .rejects.toMatchObject({ code: "PROVIDER_INPUT_INVALID" });
    await expect(resolveProviderImplementationIdentity({ manifest, credentialBroker: { kind: "external-helper", helperPath: valid, helperSha256: "b".repeat(64) }, workspaceRoots: [] }))
      .rejects.toMatchObject({ code: "PROVIDER_IDENTITY_CHANGED" });
  });

  it("rejects malformed compiled implementation digests and workspace roots", async () => {
    await expect(resolveProviderImplementationIdentity({ manifest: { ...manifest, implementationDigest: "bad" }, credentialBroker: { kind: "none" }, workspaceRoots: [] }))
      .rejects.toMatchObject({ code: "PROVIDER_INPUT_INVALID" });
    await expect(resolveProviderImplementationIdentity({ manifest, credentialBroker: { kind: "none" }, workspaceRoots: ["relative"] }))
      .rejects.toMatchObject({ code: "PROVIDER_INPUT_INVALID" });
  });
});
