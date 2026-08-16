import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProviderGatewayRuntime } from "./production.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
    await runtime.close();
    await runtime.close();
    expect(events).toEqual([]);
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
