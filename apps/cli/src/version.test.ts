import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { KODEGPT_PACKAGE_VERSION } from "./version.js";

describe("CLI package version", () => {
  it("stays synchronized with apps/cli/package.json", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8")
    ) as { version: string };

    expect(KODEGPT_PACKAGE_VERSION).toBe(manifest.version);
  });
});
