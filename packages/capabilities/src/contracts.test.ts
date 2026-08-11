import { describe, expect, it } from "vitest";

import {
  CAPABILITY_SCHEMA_VERSION,
  DEFAULT_CONTEXT_MAX_BYTES,
  DEFAULT_INSPECT_MAX_ENTRIES,
  DEFAULT_SEARCH_MAX_RESULTS,
  MAX_CONTEXT_MAX_BYTES,
  MAX_INSPECT_MAX_ENTRIES,
  MAX_PATCH_BYTES,
  MAX_PATCH_FILES,
  MAX_PATCH_HUNKS,
  MAX_SEARCH_MAX_RESULTS
} from "./contracts.js";
import { CapabilityNotImplementedError, NativeCapabilityService } from "./native-capability-service.js";

describe("capability contracts", () => {
  it("pins public schema and bounded defaults", () => {
    expect(CAPABILITY_SCHEMA_VERSION).toBe(1);
    expect(DEFAULT_CONTEXT_MAX_BYTES).toBe(256 * 1024);
    expect(MAX_CONTEXT_MAX_BYTES).toBe(1024 * 1024);
    expect(DEFAULT_INSPECT_MAX_ENTRIES).toBe(2_000);
    expect(MAX_INSPECT_MAX_ENTRIES).toBe(10_000);
    expect(DEFAULT_SEARCH_MAX_RESULTS).toBe(100);
    expect(MAX_SEARCH_MAX_RESULTS).toBe(500);
    expect(MAX_PATCH_BYTES).toBe(1024 * 1024);
    expect(MAX_PATCH_FILES).toBe(64);
    expect(MAX_PATCH_HUNKS).toBe(256);
  });

  it("keeps unimplemented capability methods explicit and stable", async () => {
    const service = new NativeCapabilityService({
      workspace: {} as never,
      execution: {} as never
    });

    await expect(service.inspectWorkspace({ workspaceId: "ws_1" })).rejects.toEqual(
      expect.objectContaining<Partial<CapabilityNotImplementedError>>({
        name: "CapabilityNotImplementedError",
        code: "CAPABILITY_NOT_IMPLEMENTED",
        capability: "workspace.inspect"
      })
    );
  });
});
