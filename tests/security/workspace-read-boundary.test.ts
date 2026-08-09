import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function source(relativePath: string): Promise<string> {
  const url = new URL(`../../${relativePath}`, import.meta.url);
  return readFile(fileURLToPath(url), "utf8");
}

describe("workspace read boundary source regressions", () => {
  it("keeps read/tree/search traversal fd-relative without canonical pathname recursion", async () => {
    const implementation = await source("crates/workspace-io/src/read.rs");

    for (const forbidden of [
      "canonicalize",
      "canonical_display_root",
      "canonicalRoot",
      "read_dir(",
      "WalkDir",
      "walkdir"
    ]) {
      expect(implementation).not.toContain(forbidden);
    }

    expect(implementation).toContain("open_existing_beneath");
    expect(implementation).toContain("open_directory_beneath");
    expect(implementation).toContain("RawDir");
  });

  it("keeps every runtime file method behind the durable audit operation wrapper", async () => {
    const dispatcher = await source("crates/runtime/src/dispatcher.rs");

    for (const action of ["FileRead", "FileTree", "FileSearch"]) {
      expect(dispatcher).toContain(`AuditAction::${action}`);
    }
    expect(dispatcher).toContain("audited_workspace_operation(");
  });
});
