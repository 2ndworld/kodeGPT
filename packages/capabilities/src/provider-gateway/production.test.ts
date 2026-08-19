import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProviderAdapterManifest } from "./contracts.js";
import { createProviderGatewayRuntime } from "./production.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function manifest(overrides: Partial<ProviderAdapterManifest> = {}): ProviderAdapterManifest {
  return {
    adapterId: "fixture.adapter.v1",
    adapterContractVersion: "2",
    implementationDigest: "a".repeat(64),
    inventoryMode: "STATIC",
    networkPolicy: {
      kind: "internet",
      origins: ["https://example.com"],
      redirect: null
    },
    credentialBroker: { kind: "none" },
    operations: [],
    mappings: [],
    ...overrides
  };
}

describe("createProviderGatewayRuntime", () => {
  it("constructs and closes without provider, credential, audit, or workspace effects", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "kodegpt-provider-production-"));
    roots.push(stateRoot);
    const events: string[] = [];

    const runtime = createProviderGatewayRuntime({
      stateRoot,
      manifests: [],
      audit: { async record() { events.push("audit"); } },
      workspaceAuthority: {
        async resolve(workspaceId) {
          events.push("workspace-authority");
          return { workspaceId, network: "unrestricted" };
        }
      },
      workspaceRoots: () => {
        events.push("workspace-roots");
        return [];
      }
    });

    expect(events).toEqual([]);
    expect(typeof (runtime as unknown as { acquireCredentialForEnabledAdapter?: unknown }).acquireCredentialForEnabledAdapter)
      .toBe("function");
    await expect(
      (runtime as unknown as { acquireCredentialForEnabledAdapter(adapterId: string): Promise<unknown> })
        .acquireCredentialForEnabledAdapter("github.read.v1")
    ).resolves.toBeNull();
    await runtime.close();
    await runtime.close();
    expect(events).toEqual([]);
  });

  it("refuses credentials from an enabled provider that requires manifest reapproval", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "kodegpt-provider-production-"));
    roots.push(stateRoot);
    await mkdir(join(stateRoot, "providers"), { recursive: true });
    await writeFile(
      join(stateRoot, "providers", "registry.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        entries: [{
          schemaVersion: 1,
          providerInstanceId: "prv_0123456789abcdef0123456789abcdef",
          operatorName: "fixture",
          adapterId: "fixture.adapter.v1",
          adapterContractVersion: "2",
          enabled: true,
          implementationFingerprint: "b".repeat(64),
          inventoryMode: "STATIC",
          approvedInventoryFingerprint: null,
          credentialBroker: { kind: "none" },
          nonSecretAdapterConfig: {},
          createdAt: "2026-08-19T00:00:00.000Z",
          updatedAt: "2026-08-19T00:00:00.000Z"
        }]
      }, null, 2)}\n`,
      "utf8"
    );

    const runtime = createProviderGatewayRuntime({
      stateRoot,
      manifests: [manifest()],
      audit: { async record() { throw new Error("unexpected audit"); } },
      workspaceAuthority: {
        async resolve() { throw new Error("unexpected workspace authority"); }
      },
      workspaceRoots: () => []
    });

    await expect(runtime.acquireCredentialForEnabledAdapter("fixture.adapter.v1"))
      .rejects.toMatchObject({ code: "PROVIDER_IDENTITY_CHANGED" });
    await runtime.close();
  });

  it("does not read malformed provider registry state during unrelated startup", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "kodegpt-provider-production-"));
    roots.push(stateRoot);
    await mkdir(join(stateRoot, "providers"), { recursive: true });
    await writeFile(join(stateRoot, "providers", "registry.json"), "not-json\n", "utf8");

    const runtime = createProviderGatewayRuntime({
      stateRoot,
      manifests: [],
      audit: { async record() { throw new Error("unexpected audit"); } },
      workspaceAuthority: {
        async resolve() { throw new Error("unexpected workspace authority"); }
      },
      workspaceRoots: () => []
    });

    await expect(runtime.operator.list()).rejects.toMatchObject({ code: "PROVIDER_STATE_INVALID" });
    await runtime.close();
  });

  it("keeps the production manifest inventory empty and fails provider use locally", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "kodegpt-provider-production-"));
    roots.push(stateRoot);
    const runtime = createProviderGatewayRuntime({
      stateRoot,
      manifests: [],
      audit: { async record() { throw new Error("unexpected audit"); } },
      workspaceAuthority: {
        async resolve() { throw new Error("unexpected workspace authority"); }
      },
      workspaceRoots: () => []
    });

    await expect(runtime.gateway.execute({
      semanticCapabilityId: "provider.unregistered.read",
      providerInstanceId: "prv_0123456789abcdef0123456789abcdef",
      input: {}
    })).rejects.toMatchObject({ code: "PROVIDER_TOOL_UNAVAILABLE" });
    await runtime.close();
  });
});
