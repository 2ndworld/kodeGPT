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

  it("generalizes developer executable authority without restoring host PATH or toolchain env hints", async () => {
    const runtime = await source("crates/runtime/src/process.rs");
    const sandbox = await source("crates/sandbox/src/developer_environment.rs");
    const executable = await source("crates/sandbox/src/executable.rs");
    const bubblewrap = await source("crates/sandbox/src/bubblewrap.rs");
    const kernelClient = await source("packages/core/src/kernel-client.ts");

    expect(runtime).toContain("allow_dynamic_executables");
    expect(runtime).toContain("resolve_dynamic_executable");
    expect(runtime).toContain("DeveloperEnvironmentRegistry");
    expect(sandbox).toContain("DeveloperEnvironmentRegistry");
    expect(bubblewrap).toContain("developer_environment");
    expect(bubblewrap).toContain("--ro-bind-fd");
    for (const implementation of [runtime, sandbox, executable, kernelClient]) {
      expect(implementation).not.toContain("KODEGPT_HOST_NODE_ROOT");
      expect(implementation).not.toContain("KODEGPT_HOST_RUST_TOOLCHAIN_ROOT");
    }
    expect(kernelClient).not.toContain("process.env.PATH");
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
