import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function source(relativePath: string): Promise<string> {
  const url = new URL(`../../${relativePath}`, import.meta.url);
  return readFile(fileURLToPath(url), "utf8");
}

describe("sandboxed process execution source regressions", () => {
  it("keeps process execution sandbox-only, policy-derived, and root-FD scoped", async () => {
    const implementation = await source("crates/runtime/src/process.rs");
    const production = implementation.split("#[cfg(test)]", 1)[0] ?? implementation;

    for (const required of [
      "policy.allow_process",
      "policy.allowed_executable_names",
      "WorkspaceAccess::ReadOnly",
      "WorkspaceAccess::ReadWrite",
      "open_directory_beneath",
      "resolve_trusted_executable",
      "SandboxNetworkMode::Deny",
      "SandboxNetworkMode::Localhost",
      "SandboxNetworkMode::Allowlist",
      "SandboxNetworkMode::Unrestricted",
      "ExecutionKind::Process",
      "spool.create(",
      "kill_process_group",
      "Signal::TERM",
      "Signal::KILL"
    ]) {
      expect(production).toContain(required);
    }

    expect(production).not.toContain("Command::new");
    expect(production).not.toContain("std::process::Command");
    expect(production).not.toContain("canonicalize(");
  });

  it("does not inherit host environment and exposes only public operation IDs", async () => {
    const implementation = await source("crates/runtime/src/process.rs");
    const tools = await source("packages/mcp-server/src/tools.ts");

    expect(implementation).toContain("env_allowlist");
    expect(implementation).toContain("ReservedEnvironment");
    expect(implementation).toContain('format!("op_');
    expect(tools).toContain('"process.run"');
    expect(tools).toContain('"process.status"');
    expect(tools).toContain('"process.cancel"');
    expect(tools).not.toContain("capabilityId: z.");
    expect(tools).not.toContain("processGroup");
    expect(tools).not.toContain("pid: z.");
  });

  it("keeps process run/cancel behind durable audit lifecycle", async () => {
    const audit = await source("crates/runtime/src/audit.rs");
    const dispatcher = await source("crates/runtime/src/dispatcher.rs");

    for (const action of ["ProcessRun", "ProcessStatus", "ProcessCancel"]) {
      expect(audit).toContain(action);
      expect(dispatcher).toContain(`AuditAction::${action}`);
    }
    expect(dispatcher).toContain("AuditDecision::Allow");
    expect(dispatcher).toContain("AuditOutcome::Success");
    expect(dispatcher).toContain("AuditOutcome::Failed");
  });
});
