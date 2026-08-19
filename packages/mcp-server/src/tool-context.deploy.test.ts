import { describe, expect, it } from "vitest";

import { createKodegptToolContext } from "./tool-context.js";

function baseOptions() {
  return {
    workspaceManager: {
      listWorkspaces: () => [],
      listTrustedWorkspaces: () => []
    } as never,
    executionManager: {} as never,
    artifactStore: {} as never,
    extensionRegistry: {} as never,
    inspectProfile: () => ({}),
    capabilities: () => ({}),
    health: () => ({})
  };
}

const createResult = {
  deploymentId: "deploy_123",
  branch: "feat/typed-preview",
  sourceOid: "a".repeat(40),
  createdAt: "2026-08-19T00:00:00Z"
};

const inspectResult = {
  deploymentId: "deploy_123",
  state: "ready" as const,
  previewUrl: "https://deploy-123--example.netlify.app",
  branch: "feat/typed-preview",
  sourceOid: "a".repeat(40),
  createdAt: "2026-08-19T00:00:00Z",
  updatedAt: "2026-08-19T00:01:00Z"
};

describe("deployment tool context", () => {
  it("delegates create and inspect through the separately injected typed deployment adapter", async () => {
    const calls: string[] = [];
    const context = createKodegptToolContext({
      ...baseOptions(),
      deployPreview: {
        async create(input: { workspaceId: string }) {
          calls.push(`create:${input.workspaceId}`);
          return createResult;
        },
        async inspect(input: { workspaceId: string; deploymentId: string }) {
          calls.push(`inspect:${input.workspaceId}:${input.deploymentId}`);
          return inspectResult;
        }
      }
    } as never);

    await expect(context.deploy.previewCreate({ workspaceId: "ws_ready" })).resolves.toEqual(createResult);
    await expect(context.deploy.previewInspect({ workspaceId: "ws_ready", deploymentId: "deploy_123" })).resolves.toEqual(inspectResult);
    expect(calls).toEqual(["create:ws_ready", "inspect:ws_ready:deploy_123"]);
  });

  it("fails closed when typed preview deployment is not configured", async () => {
    const context = createKodegptToolContext(baseOptions());
    await expect(context.deploy.previewCreate({ workspaceId: "ws_ready" })).rejects.toMatchObject({
      code: "CAPABILITY_NOT_IMPLEMENTED"
    });
    await expect(context.deploy.previewInspect({ workspaceId: "ws_ready", deploymentId: "deploy_123" })).rejects.toMatchObject({
      code: "CAPABILITY_NOT_IMPLEMENTED"
    });
  });
});
