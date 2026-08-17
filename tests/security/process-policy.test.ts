import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function source(relativePath: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)), "utf8");
}

describe("sandboxed process policy source regressions", () => {
  it("routes execution only through retained-root Bubblewrap with trusted logical executables", async () => {
    const implementation = await source("crates/runtime/src/process.rs");
    const productionImplementation = implementation.split("#[cfg(test)]", 1)[0] ?? implementation;
    for (const required of [
      "resolve_trusted_executable",
      "BubblewrapProvider::discover",
      "WorkspaceAccess::ReadOnly",
      "WorkspaceAccess::ReadWrite",
      "ExecutionKind::Process",
      "spool.create(",
      "operation_id",
      "kill_process_group",
      "open_directory_beneath"
    ]) {
      expect(productionImplementation).toContain(required);
    }
    expect(productionImplementation).not.toContain("Command::new");
    expect(productionImplementation).not.toContain("canonicalize(");
  });

  it("exposes opaque process operation tools without PID/PGID authority", async () => {
    const tools = await source("packages/mcp-server/src/tools.ts");
    expect(tools).toContain('"process.run"');
    expect(tools).toContain('"process.status"');
    expect(tools).toContain('"process.cancel"');
    expect(tools).not.toContain("processGroup: z.");
    expect(tools).not.toContain("pid: z.");
  });

  it("keeps process execution under policy and durable audit lifecycle", async () => {
    const dispatcher = await source("crates/runtime/src/dispatcher.rs");
    const audit = await source("crates/runtime/src/audit.rs");
    expect(dispatcher).toContain("allow_process");
    expect(dispatcher).toContain("AuditAction::ProcessRun");
    expect(dispatcher).toContain("AuditAction::ProcessCancel");
    expect(audit).toContain("ProcessRun");
    expect(audit).toContain("ProcessCancel");
  });
});
