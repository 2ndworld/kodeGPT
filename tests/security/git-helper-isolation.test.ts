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
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_OPTIONAL_LOCKS",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_GLOBAL",
      "GIT_PAGER",
      "GIT_TERMINAL_PROMPT",
      "GIT_ATTR_NOSYSTEM",
      "--git-dir=/workspace/.git",
      "--work-tree=/workspace",
      "--no-optional-locks",
      "core.bare=false",
      "core.fsmonitor=false",
      "core.hooksPath=/dev/null",
      "core.excludesFile=/dev/null",
      "credential.helper=",
      "diff.external=",
      "--no-ext-diff",
      "--no-textconv",
      "worktreeconfig",
      "filter.{driver}.{key}=",
      "filter.{driver}.required=false",
      "UnsafeRepositoryConfig",
      "ExecutionKind::Git",
      "resolve_trusted_executable(\"git\")",
      "spool.create("
    ]) {
      expect(production).toContain(required);
    }

    expect(production).not.toContain("Command::new");
    expect(production).not.toContain("canonicalize(");
    expect(production).not.toContain("GIT_EXTERNAL_DIFF=");
  });

  it("spools captured output before exposing bounded previews", async () => {
    const implementation = await source("crates/runtime/src/git.rs");
    const spoolWrite = implementation.indexOf("writer.write_source(&bytes)?");
    const previewAppend = implementation.indexOf("append_preview(");

    expect(spoolWrite).toBeGreaterThanOrEqual(0);
    expect(previewAppend).toBeGreaterThan(spoolWrite);
    expect(implementation).toContain("GIT_PREVIEW_MAX_BYTES");
    expect(implementation).toContain("RawSpoolMetadata");
  });

  it("publishes only read-only Git MCP tools on opaque workspace IDs", async () => {
    const tools = await source("packages/mcp-server/src/tools.ts");
    const context = await source("packages/mcp-server/src/tool-context.ts");

    expect(tools).toContain('"git.status"');
    expect(tools).toContain('"git.diff"');
    expect(tools).toContain("READ_ONLY_TOOL_ANNOTATIONS");
    expect(tools).not.toContain("process_group: z.");
    expect(tools).not.toContain("capabilityId: z.");
    expect(context).toContain("gitStatus(workspaceId");
    expect(context).toContain("gitDiff(workspaceId");
  });

  it("keeps Git actions covered by durable audit decisions and outcomes", async () => {
    const audit = await source("crates/runtime/src/audit.rs");
    const dispatcher = await source("crates/runtime/src/dispatcher.rs");

    expect(audit).toContain("GitStatus");
    expect(audit).toContain("GitDiff");
    expect(audit).toContain('Self::GitStatus => "git_status"');
    expect(audit).toContain('Self::GitDiff => "git_diff"');
    expect(dispatcher).toContain("AuditAction::GitStatus");
    expect(dispatcher).toContain("AuditAction::GitDiff");
    expect(dispatcher).toContain("AuditDecision::Allow");
    expect(dispatcher).toContain("AuditOutcome::Success");
    expect(dispatcher).toContain("AuditOutcome::Failed");
  });
});
