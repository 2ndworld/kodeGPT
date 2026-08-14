import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function source(relativePath: string): Promise<string> {
  const url = new URL(`../../${relativePath}`, import.meta.url);
  return readFile(fileURLToPath(url), "utf8");
}

describe("hardened read-only Git inspection source regressions", () => {
  it("routes Git only through the retained-root Bubblewrap provider with helper hardening", async () => {
    const implementation = await source("crates/runtime/src/git.rs");
    const production = implementation.split("#[cfg(test)]", 1)[0] ?? implementation;

    for (const required of [
      "WorkspaceAccess::ReadOnly",
      "GIT_OPTIONAL_LOCKS",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_PAGER",
      "GIT_TERMINAL_PROMPT",
      "core.fsmonitor=false",
      "--no-ext-diff",
      "--no-textconv",
      "ExecutionKind::Git",
      "resolve_trusted_executable(\"git\")",
      "spool.create("
    ]) {
      expect(production).toContain(required);
    }

    for (const required of [
      "GIT_ATTR_NOSYSTEM",
      "diff.autoRefreshIndex=false",
      "--ignore-submodules=all",
      "filter_probe_args",
      "filter_overrides"
    ]) {
      expect(production).toContain(required);
    }

    expect(production).not.toContain("Command::new");
    expect(production).not.toContain("canonicalize(");
    expect(production).not.toContain("GIT_EXTERNAL_DIFF=");
    expect(production).not.toContain('b"[stdout]"');
    expect(production).not.toContain('b"[stderr]"');
    expect(production).not.toContain("to_be_bytes()");
  });

  it("publishes only read-only Git MCP tools on opaque workspace IDs", async () => {
    const tools = await source("packages/mcp-server/src/tools.ts");

    expect(tools).toContain('"git.status"');
    expect(tools).toContain('"git.diff"');
    expect(tools).toContain('"git.log"');
    expect(tools).toContain('"git.show"');
    expect(tools).toContain('"git.range"');
    expect(tools).toContain('"git.diffHistory"');
    expect(tools).toContain("READ_ONLY_TOOL_ANNOTATIONS");
    expect(tools).not.toContain("process_group: z.");
    expect(tools).not.toContain("capabilityId: z.");
  });

  it("keeps Git actions covered by durable audit decisions and outcomes", async () => {
    const audit = await source("crates/runtime/src/audit.rs");
    const dispatcher = await source("crates/runtime/src/dispatcher.rs");

    expect(audit).toContain("GitStatus");
    expect(audit).toContain("GitDiff");
    expect(audit).toContain("GitHistoryList");
    expect(audit).toContain("GitCommitInspect");
    expect(audit).toContain("GitHistoryRange");
    expect(audit).toContain("GitHistoryDiff");
    expect(dispatcher).toContain("AuditAction::GitStatus");
    expect(dispatcher).toContain("AuditAction::GitDiff");
    expect(dispatcher).toContain("AuditAction::GitHistoryList");
    expect(dispatcher).toContain("AuditAction::GitCommitInspect");
    expect(dispatcher).toContain("AuditAction::GitHistoryRange");
    expect(dispatcher).toContain("AuditAction::GitHistoryDiff");
  });
});
