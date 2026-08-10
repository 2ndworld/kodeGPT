import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function source(relativePath: string): Promise<string> {
  const url = new URL(`../../${relativePath}`, import.meta.url);
  return readFile(fileURLToPath(url), "utf8");
}

describe("race-safe file mutation source regressions", () => {
  it("keeps mutation traversal fd-relative and atomic beneath the retained root", async () => {
    const implementation = await source("crates/workspace-io/src/write.rs");

    for (const forbidden of [
      "canonicalize",
      "canonical_display_root",
      "std::fs::write",
      "std::fs::rename",
      "PathBuf::from"
    ]) {
      expect(implementation).not.toContain(forbidden);
    }

    for (const required of [
      "open_parent_beneath",
      "open_existing_beneath",
      "OFlags::EXCL",
      "OFlags::NOFOLLOW",
      "renameat",
      "fsync(parent.parent_fd())",
      "AtFlags::SYMLINK_NOFOLLOW"
    ]) {
      expect(implementation).toContain(required);
    }
  });

  it("keeps write/edit behind runtime policy and durable audit authority", async () => {
    const dispatcher = await source("crates/runtime/src/dispatcher.rs");

    expect(dispatcher).toContain("policy.allow_write && policy.name != ProfileName::Observe");
    expect(dispatcher).toContain("AuditAction::FileWrite");
    expect(dispatcher).toContain("AuditAction::FileEdit");
    expect(dispatcher).toContain("audited_workspace_operation(");
    expect(dispatcher).toContain("write_file_with_policy");
    expect(dispatcher).toContain("edit_file_with_policy");
  });

  it("keeps public MCP mutation inputs on opaque workspace IDs with exact mutating annotations", async () => {
    const tools = await source("packages/mcp-server/src/tools.ts");
    const annotations = await source("packages/mcp-server/src/annotations.ts");

    expect(tools).toContain('"file.write"');
    expect(tools).toContain('"file.edit"');
    expect(tools).toContain("MUTATING_FILE_TOOL_ANNOTATIONS");
    expect(tools).not.toContain("capabilityId: z.");
    expect(annotations).toContain("MUTATING_FILE_TOOL_ANNOTATIONS");
    expect(annotations).toContain("readOnlyHint: false");
    expect(annotations).toContain("destructiveHint: true");
    expect(annotations).toContain("idempotentHint: false");
    expect(annotations).toContain("openWorldHint: false");
  });
});
