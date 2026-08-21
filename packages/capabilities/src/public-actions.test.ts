import { describe, expect, it } from "vitest";

import { NATIVE_CAPABILITY_IDS } from "./contracts.js";
import * as capabilities from "./index.js";
import {
  PUBLIC_ACTION_IDS,
  getPublicActionDescriptor,
  listPublicActionDescriptors
} from "./public-actions.js";

describe("public action catalog", () => {
  it("exports the catalog through the capabilities package entrypoint", () => {
    expect((capabilities as Record<string, unknown>).PUBLIC_ACTION_IDS).toBe(PUBLIC_ACTION_IDS);
    expect((capabilities as Record<string, unknown>).getPublicActionDescriptor).toBe(getPublicActionDescriptor);
    expect((capabilities as Record<string, unknown>).listPublicActionDescriptors).toBe(listPublicActionDescriptors);
  });

  it("contains the published 76-action discovery surface exactly once", () => {
    expect(PUBLIC_ACTION_IDS).toHaveLength(76);
    expect(new Set(PUBLIC_ACTION_IDS).size).toBe(76);
    expect(PUBLIC_ACTION_IDS).toContain("workspace.info");
    expect(PUBLIC_ACTION_IDS).toContain("visual.captureMatrix");
    expect(PUBLIC_ACTION_IDS).toContain("github.pr.create");
    expect(PUBLIC_ACTION_IDS).toContain("system.discover");
    expect(getPublicActionDescriptor("system.discover").requiredInputs).toEqual(["query"]);
  });

  it("provides complete immutable discovery metadata", () => {
    const descriptors = listPublicActionDescriptors();
    expect(Object.isFrozen(descriptors)).toBe(true);

    for (const id of PUBLIC_ACTION_IDS) {
      const descriptor = getPublicActionDescriptor(id);
      expect(descriptor.id).toBe(id);
      expect(descriptor.family).toBe(id.slice(0, id.indexOf(".")));
      expect(descriptor.purpose.length).toBeGreaterThan(0);
      expect(descriptor.aliases.length).toBeGreaterThan(0);
      expect(descriptor.tags.length).toBeGreaterThan(0);
      expect(descriptor.requiredInputs).toBeDefined();
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(Object.isFrozen(descriptor.aliases)).toBe(true);
      expect(Object.isFrozen(descriptor.tags)).toBe(true);
      expect(Object.isFrozen(descriptor.requiredInputs)).toBe(true);
    }
  });

  it("keeps native capabilities as a strict public-action subset", () => {
    const publicIds = new Set<string>(PUBLIC_ACTION_IDS);
    for (const id of NATIVE_CAPABILITY_IDS) expect(publicIds.has(id)).toBe(true);
    expect(PUBLIC_ACTION_IDS.length).toBeGreaterThan(NATIVE_CAPABILITY_IDS.length);
  });
});
