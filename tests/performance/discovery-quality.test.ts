import { describe, expect, it } from "vitest";

import { searchPublicActions } from "../../packages/capabilities/src/public-action-search.js";

type Scenario = {
  query: string;
  expected: readonly string[];
  critical?: boolean;
};

const scenarios: readonly Scenario[] = [
  { query: "understand this repository", expected: ["context.build", "workspace.inspect"] },
  { query: "find where this symbol is used", expected: ["code.search"] },
  { query: "what will this change affect", expected: ["code.impact"] },
  { query: "edit this file safely", expected: ["file.edit", "file.patch"] },
  { query: "run the tests", expected: ["verify.run"] },
  { query: "run a local development command", expected: ["process.run"] },
  { query: "see whether the preview is ready", expected: ["preview.inspect"] },
  { query: "inspect browser console errors", expected: ["browser.console"] },
  { query: "check responsive UI screenshots", expected: ["visual.captureMatrix"] },
  { query: "compare visual evidence", expected: ["visual.compare"] },
  { query: "create a pull request", expected: ["github.pr.create"] },
  { query: "inspect pull request", expected: ["github.pr.inspect"] },
  { query: "why did CI fail", expected: ["ci.failure"] },
  { query: "rerun the failed CI workflow", expected: ["ci.rerun"] },
  { query: "continue the work from the previous chat", expected: ["workspace.info"] },
  { query: "show current workspace state", expected: ["workspace.info"] },
  { query: "create an isolated worktree", expected: ["git.worktreeCreate"] },
  { query: "remove the worktree", expected: ["git.worktreeRemove"] },
  { query: "show changed files", expected: ["git.changes", "git.status"] },
  { query: "commit these changes", expected: ["git.commit"] },
  { query: "push this branch", expected: ["git.push"] },
  { query: "read a file", expected: ["file.read"] },
  { query: "list files", expected: ["file.tree"] },
  { query: "read an artifact", expected: ["artifact.read"] },
  { query: "check service health", expected: ["system.health"] },
  { query: "what tools are available", expected: ["system.capabilities"] },
  { query: "list skills", expected: ["skill.list"] },
  { query: "inspect a skill", expected: ["skill.inspect"] },
  { query: "load skill instructions", expected: ["skill.load"] },
  { query: "current profile", expected: ["profile.current"] },
  { query: "list trusted workspaces", expected: ["trust.list"] },
  { query: "open workspace", expected: ["workspace.open"] },
  { query: "close workspace", expected: ["workspace.close"] },
  { query: "create branch", expected: ["git.branchCreate"] },
  { query: "switch branch", expected: ["git.branchSwitch"] },
  { query: "show commit history", expected: ["git.log"] },
  { query: "compare commits", expected: ["git.diffHistory"] },
  { query: "list GitHub issues", expected: ["github.issue.list"] },
  { query: "inspect issue", expected: ["github.issue.inspect"] },
  { query: "list pull requests", expected: ["github.pr.list"] },
  { query: "check CI", expected: ["ci.status"], critical: true },
  { query: "cek CI", expected: ["ci.status"], critical: true },
  { query: "kenapa CI gagal", expected: ["ci.failure"], critical: true },
  { query: "cek tampilan mobile", expected: ["visual.captureMatrix"], critical: true },
  { query: "lanjutkan pekerjaan sebelumnya", expected: ["workspace.info"], critical: true },
  { query: "cari dampak perubahan ini", expected: ["code.impact"], critical: true },
  { query: "buat worktree terpisah", expected: ["git.worktreeCreate"], critical: true },
  { query: "jalankan test", expected: ["verify.run"], critical: true },
  { query: "cek error console browser", expected: ["browser.console"], critical: true },
  { query: "buat PR", expected: ["github.pr.create"], critical: true },
  { query: "cek status workspace", expected: ["workspace.info"], critical: true }
];

describe("deterministic public action discovery quality", () => {
  it("meets top-1/top-3 routing thresholds including critical Indonesian intents", () => {
    let top1Hits = 0;
    let top3Hits = 0;
    let criticalCount = 0;
    let criticalTop3Hits = 0;
    const misses: Array<{
      query: string;
      expected: readonly string[];
      actual: string[];
      critical: boolean;
    }> = [];

    for (const scenario of scenarios) {
      const actual = searchPublicActions(scenario.query, { limit: 3 }).map(
        (match) => match.action.id
      );
      const top1 = actual[0] !== undefined && scenario.expected.includes(actual[0]);
      const top3 = actual.some((id) => scenario.expected.includes(id));
      if (top1) top1Hits += 1;
      if (top3) top3Hits += 1;
      if (scenario.critical) {
        criticalCount += 1;
        if (top3) criticalTop3Hits += 1;
      }
      if (!top1 || !top3) {
        misses.push({
          query: scenario.query,
          expected: scenario.expected,
          actual: [...actual],
          critical: scenario.critical === true
        });
      }
    }

    const top1Accuracy = top1Hits / scenarios.length;
    const top3Recall = top3Hits / scenarios.length;
    const criticalTop3Recall = criticalTop3Hits / criticalCount;
    const evidence = JSON.stringify(
      { top1Accuracy, top3Recall, criticalTop3Recall, misses },
      null,
      2
    );

    expect(top3Recall, evidence).toBeGreaterThanOrEqual(0.95);
    expect(top1Accuracy, evidence).toBeGreaterThanOrEqual(0.9);
    expect(criticalTop3Recall, evidence).toBe(1);
  });
});
