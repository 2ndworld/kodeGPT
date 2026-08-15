import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function source(relativePath: string): Promise<string> {
  const url = new URL(`../../${relativePath}`, import.meta.url);
  return readFile(fileURLToPath(url), "utf8");
}

describe("hardened Git source regressions", () => {
  it("routes Git only through the retained-root Bubblewrap provider with helper hardening", async () => {
    const implementation = await source("crates/runtime/src/git.rs");
    const production = implementation.split("#[cfg(test)]", 1)[0] ?? implementation;

    for (const required of [
      "WorkspaceAccess::ReadOnly",
      "WorkspaceAccess::ReadWrite",
      "SandboxNetworkMode::Deny",
      "run_git_local_mutation",
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

  it("publishes only typed Git inspection and bounded trusted mutation tools on opaque workspace IDs", async () => {
    const tools = await source("packages/mcp-server/src/tools.ts");

    for (const name of [
      "git.status",
      "git.diff",
      "git.log",
      "git.show",
      "git.range",
      "git.diffHistory",
      "git.stage",
      "git.commit",
      "git.branchCreate",
      "git.branchSwitch",
      "git.branchDelete",
      "git.fetch",
      "git.pull",
      "git.push"
    ]) {
      expect(tools).toContain(`"${name}"`);
    }
    expect(tools).toContain("READ_ONLY_TOOL_ANNOTATIONS");
    expect(tools).toContain("LOCAL_GIT_MUTATION_TOOL_ANNOTATIONS");
    expect(tools).toContain("REMOTE_GIT_FETCH_TOOL_ANNOTATIONS");
    expect(tools).toContain("REMOTE_GIT_MUTATION_TOOL_ANNOTATIONS");
    for (const forbidden of ["git.run", "git.exec", "git.command", "git.reset", "git.rebase"]) {
      expect(tools).not.toContain(`"${forbidden}"`);
    }
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
    expect(audit).toContain("GitStage");
    expect(audit).toContain("GitCommit");
    expect(audit).toContain("GitBranchCreate");
    expect(audit).toContain("GitBranchSwitch");
    expect(audit).toContain("GitBranchDelete");
    expect(audit).toContain("GitFetch");
    expect(audit).toContain("GitPull");
    expect(audit).toContain("GitPush");
    expect(dispatcher).toContain("AuditAction::GitStatus");
    expect(dispatcher).toContain("AuditAction::GitDiff");
    expect(dispatcher).toContain("AuditAction::GitHistoryList");
    expect(dispatcher).toContain("AuditAction::GitCommitInspect");
    expect(dispatcher).toContain("AuditAction::GitHistoryRange");
    expect(dispatcher).toContain("AuditAction::GitHistoryDiff");
    expect(dispatcher).toContain("AuditAction::GitStage");
    expect(dispatcher).toContain("AuditAction::GitCommit");
    expect(dispatcher).toContain("AuditAction::GitBranchCreate");
    expect(dispatcher).toContain("AuditAction::GitBranchSwitch");
    expect(dispatcher).toContain("AuditAction::GitBranchDelete");
    expect(dispatcher).toContain("AuditAction::GitFetch");
    expect(dispatcher).toContain("AuditAction::GitPull");
    expect(dispatcher).toContain("AuditAction::GitPush");
  });
});
