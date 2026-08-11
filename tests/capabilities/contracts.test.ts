import { describe, expect, it } from "vitest";

import {
  CAPABILITY_SCHEMA_VERSION,
  NativeCapabilityService,
  WorkspaceInspectInputSchema,
  WorkspaceInspectResultSchema
} from "../../packages/capabilities/src/index.js";

describe("native capability public package boundary", () => {
  it("exports the Task 1–3 service and workspace.inspect runtime contracts from the package entrypoint", () => {
    expect(CAPABILITY_SCHEMA_VERSION).toBe(1);
    expect(typeof NativeCapabilityService).toBe("function");
    expect(
      WorkspaceInspectInputSchema.parse({ workspaceId: "ws_public", maxEntries: 2_000 })
    ).toEqual({ workspaceId: "ws_public", maxEntries: 2_000 });
    expect(
      WorkspaceInspectResultSchema.parse({
        schemaVersion: 1,
        workspaceId: "ws_public",
        root: ".",
        projectTypes: [],
        languages: [],
        entrypoints: [],
        areas: [],
        manifests: [],
        warnings: [],
        truncated: false
      })
    ).toMatchObject({ workspaceId: "ws_public", truncated: false });
  });
});
