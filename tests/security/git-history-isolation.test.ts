import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  GitDiffHistoryInputSchema,
  GitLogInputSchema,
  GitRangeInputSchema,
  GitShowInputSchema
} from "../../packages/capabilities/src/index.js";
import { describe, expect, it } from "vitest";

async function source(relativePath: string): Promise<string> {
  const url = new URL(`../../${relativePath}`, import.meta.url);
  return readFile(fileURLToPath(url), "utf8");
}

const OID = "1".repeat(40);
const OID2 = "2".repeat(40);

describe("bounded Git history authority isolation", () => {
  it("rejects raw revision expressions and option-shaped paths at public schemas", () => {
    for (const raw of ["--all", "--glob=refs/*", "--output=/tmp/x", "HEAD~3", "HEAD^", "HEAD@{1}", ":/regex", "main..HEAD", "main...HEAD"]) {
      expect(() => GitLogInputSchema.parse({ workspaceId: "ws_x", revision: { kind: "branch", name: raw } })).toThrow();
    }

    for (const path of ["/etc/passwd", "../outside", "src/../../outside", ":(attr:foo)", ":!secret"]) {
      expect(() => GitShowInputSchema.parse({ workspaceId: "ws_x", revision: { kind: "head" }, path })).toThrow();
    }

    expect(GitShowInputSchema.parse({
      workspaceId: "ws_x",
      revision: { kind: "oid", oid: OID },
      path: "src/space ünicode/quote'/-hyphen.txt"
    }).path).toBe("src/space ünicode/quote'/-hyphen.txt");
  });

  it("keeps public schemas structured and free of raw Git or host authority fields", () => {
    const schemas = [GitLogInputSchema, GitShowInputSchema, GitRangeInputSchema, GitDiffHistoryInputSchema];
    for (const schema of schemas) {
      const text = JSON.stringify(schema);
      for (const forbidden of ["argv", "command", "gitArgs", "revisionExpression", "network", "rootPath", "hostPath", "capabilityId"]) {
        expect(text).not.toContain(forbidden);
      }
    }
    expect(GitRangeInputSchema.parse({ workspaceId: "ws_x", baseRevision: { kind: "oid", oid: OID }, headRevision: { kind: "oid", oid: OID2 } })).toBeDefined();
  });

  it("pins history execution to fixed hardened commands, trusted Git, lazy-fetch denial, and read-only workspace access", async () => {
    const git = await source("crates/runtime/src/git.rs");
    const history = await source("crates/runtime/src/git_history.rs");
    const dispatcher = await source("crates/runtime/src/dispatcher.rs");
    const productionGit = git.split("#[cfg(test)]", 1)[0] ?? git;
    const productionHistory = history.split("#[cfg(test)]", 1)[0] ?? history;

    for (const required of [
      'resolve_trusted_executable("git")',
      "WorkspaceAccess::ReadOnly",
      "GIT_OPTIONAL_LOCKS",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_TERMINAL_PROMPT",
      "core.fsmonitor=false",
      "filter_probe_args",
      "filter_overrides"
    ]) expect(productionGit).toContain(required);

    expect(productionHistory).toContain("run_hardened_git_command(");
    expect(productionHistory).toContain("executions,\n        true,");
    for (const required of [
      "--literal-pathspecs",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--ignore-submodules=all",
      "merge-base",
      "rev-list",
      "diff-tree"
    ]) expect(productionHistory).toContain(required);

    for (const forbidden of ["Command::new", "--binary", "gitArgs", "revisionExpression"]) {
      expect(productionHistory).not.toContain(forbidden);
    }

    for (const method of ['"git.log"', '"git.show"', '"git.range"', '"git.diff_history"']) {
      expect(dispatcher).toContain(method);
    }
  });

  it("pins bounded constants and public leakage guards", async () => {
    const history = await source("crates/runtime/src/git_history.rs");
    const core = await source("packages/core/src/workspace-manager.ts");
    const capabilities = await source("packages/capabilities/src/contracts.ts");

    for (const required of ["GIT_LOG_MAX_LIMIT", "GIT_RANGE_MAX_LIMIT", "GIT_PATCH_HARD_MAX_BYTES", "MESSAGE_BODY_MAX_BYTES", "--max-count=10001", "GIT_HISTORY_TIMEOUT: Duration = Duration::from_secs(5)"]) {
      expect(history).toContain(required);
    }
    for (const required of ["MAX_GIT_HISTORY_RESPONSE_BYTES = 512 * 1024", "MAX_GIT_HISTORY_PATHS = 500", "MAX_GIT_PATCH_BYTES = 256 * 1024"]) {
      expect(capabilities).toContain(required);
    }
    for (const forbidden of ["stderrRaw", "commandLine", "processGroup", "artifactId"]) {
      expect(core).not.toContain(`${forbidden}: z.`);
    }
  });
});
