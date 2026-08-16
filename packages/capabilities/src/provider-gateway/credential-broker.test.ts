import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { ProviderAdapterManifest, ProviderRegistryRecord } from "./contracts.js";
import { DefaultProviderCredentialBroker } from "./credential-broker.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kodegpt-provider-credential-"));
});

afterEach(async () => {
  delete process.env.PROVIDER_HELPER_LEAK;
  await rm(root, { recursive: true, force: true });
});

function baseManifest(): ProviderAdapterManifest {
  return {
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
}

function provider(helperPath?: string, helperSha256?: string): ProviderRegistryRecord {
  return {
    schemaVersion: 1,
    providerInstanceId: "prv_0123456789abcdef0123456789abcdef",
    operatorName: "Fixture",
    adapterId: "test.fixture.read.v1",
    adapterContractVersion: "1",
    enabled: true,
    implementationFingerprint: "b".repeat(64),
    inventoryMode: "STATIC",
    approvedInventoryFingerprint: "c".repeat(64),
    credentialBroker: helperPath === undefined
      ? { kind: "none" }
      : { kind: "external-helper", helperPath, helperSha256: helperSha256! },
    nonSecretAdapterConfig: {},
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z"
  };
}

async function writeHelper(name: string, body: string) {
  const path = join(root, name);
  await writeFile(path, body, { mode: 0o700 });
  await chmod(path, 0o700);
  const sha256 = createHash("sha256").update(body).digest("hex");
  return { path, sha256 };
}

function helperManifest(): ProviderAdapterManifest {
  return {
    ...baseManifest(),
    credentialBroker: {
      kind: "external-helper",
      credentialKind: "bearer",
      argv: ["credential"],
      environment: { LANG: "C.UTF-8" }
    }
  };
}

describe("DefaultProviderCredentialBroker", () => {
  it("returns null for the compiled none broker", async () => {
    const broker = new DefaultProviderCredentialBroker({ workspaceRoots: () => [] });
    await expect(broker.acquire({ provider: provider(), manifest: baseManifest(), signal: new AbortController().signal }))
      .resolves.toBeNull();
  });

  it("uses only fixed argv/minimal env and accepts one single-line credential", async () => {
    process.env.PROVIDER_HELPER_LEAK = "must-not-inherit";
    const fixture = await writeHelper("credential-helper", `#!/bin/sh\n[ "$1" = "credential" ] || exit 9\n[ "$LANG" = "C.UTF-8" ] || exit 8\n[ -z "\${PROVIDER_HELPER_LEAK+x}" ] || exit 7\nprintf 'credential-value\\n'\n`);
    const broker = new DefaultProviderCredentialBroker({ workspaceRoots: () => [] });
    await expect(broker.acquire({ provider: provider(fixture.path, fixture.sha256), manifest: helperManifest(), signal: new AbortController().signal }))
      .resolves.toEqual({ kind: "bearer", value: "credential-value" });
  });

  it("kills the helper on abort and returns PROVIDER_CANCELLED", async () => {
    const fixture = await writeHelper("slow-helper", "#!/bin/sh\n/bin/sleep 30\nprintf 'late\\n'\n");
    const broker = new DefaultProviderCredentialBroker({ workspaceRoots: () => [] });
    const controller = new AbortController();
    const pending = broker.acquire({ provider: provider(fixture.path, fixture.sha256), manifest: helperManifest(), signal: controller.signal });
    setTimeout(() => controller.abort(), 25);
    await expect(pending).rejects.toMatchObject({ code: "PROVIDER_CANCELLED" });
  });

  it("enforces the helper deadline and output framing/limits without echoing output", async () => {
    const slow = await writeHelper("timeout-helper", "#!/bin/sh\n/bin/sleep 30\n");
    const broker = new DefaultProviderCredentialBroker({ workspaceRoots: () => [], timeoutMs: 30 });
    await expect(broker.acquire({ provider: provider(slow.path, slow.sha256), manifest: helperManifest(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });

    const multiline = await writeHelper("multiline-helper", "#!/bin/sh\nprintf 'first\\nsecond\\n'\n");
    await expect(broker.acquire({ provider: provider(multiline.path, multiline.sha256), manifest: helperManifest(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "PROVIDER_CREDENTIAL_REJECTED" });

    const overflow = await writeHelper("overflow-helper", "#!/bin/sh\nprintf '%065537d' 0\n");
    await expect(broker.acquire({ provider: provider(overflow.path, overflow.sha256), manifest: helperManifest(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "PROVIDER_CREDENTIAL_REJECTED" });
  });

  it("maps missing/login failures to unavailable and helper drift to identity changed", async () => {
    const failing = await writeHelper("failing-helper", "#!/bin/sh\nexit 1\n");
    const broker = new DefaultProviderCredentialBroker({ workspaceRoots: () => [] });
    await expect(broker.acquire({ provider: provider(failing.path, failing.sha256), manifest: helperManifest(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "PROVIDER_CREDENTIAL_UNAVAILABLE" });

    await writeFile(failing.path, "#!/bin/sh\nprintf 'changed\\n'\n", { mode: 0o700 });
    await expect(broker.acquire({ provider: provider(failing.path, failing.sha256), manifest: helperManifest(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "PROVIDER_IDENTITY_CHANGED" });
  });
});
