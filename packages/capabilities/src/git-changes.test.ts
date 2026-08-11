import { describe, expect, it } from "vitest";

import type { GitInspectionAdapter, GitInspectionAdapterResult } from "./adapters.js";
import { NativeCapabilityService } from "./native-capability-service.js";
import { createTestCapabilityDependencies } from "./test-support.js";

function inspection(
  stdoutPreview: string,
  options: Partial<GitInspectionAdapterResult> = {}
): GitInspectionAdapterResult {
  return {
    schemaVersion: 1,
    exitCode: 0,
    stdoutPreview,
    stderrPreview: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    sourceTruncated: false,
    bytesSpooled: Buffer.byteLength(stdoutPreview),
    artifact: {
      schemaVersion: 1,
      uri: "artifact://ka_git_fixture",
      mediaType: "application/vnd.kodegpt.execution-stream",
      sizeBytes: Buffer.byteLength(stdoutPreview),
      sourceTruncated: false
    },
    ...options
  };
}

function service(options: {
  status: GitInspectionAdapterResult;
  diff?: GitInspectionAdapterResult;
  onStatus?: () => void;
  onDiff?: () => void;
}): NativeCapabilityService {
  const gitInspection: GitInspectionAdapter = {
    gitStatus: async () => {
      options.onStatus?.();
      return options.status;
    },
    gitDiff: async () => {
      options.onDiff?.();
      return options.diff ?? inspection("");
    }
  };

  return new NativeCapabilityService(
    createTestCapabilityDependencies({ git: gitInspection })
  );
}

describe("git.changes", () => {
  it("normalizes staged, worktree, both-side, added, deleted, renamed, and untracked paths", async () => {
    const capability = service({
      status: inspection(
        [
          "M  staged.ts",
          " M worktree.ts",
          "MM both.ts",
          "A  added.ts",
          " D deleted.ts",
          "R  old-name.ts -> renamed.ts",
          "?? untracked.ts"
        ].join("\n") + "\n"
      )
    });

    const result = await capability.gitChanges({ workspaceId: "ws_git" });

    expect(result).toEqual({
      schemaVersion: 1,
      workspaceId: "ws_git",
      clean: false,
      changedPaths: [
        { path: "added.ts", indexStatus: "A" },
        { path: "both.ts", indexStatus: "M", worktreeStatus: "M" },
        { path: "deleted.ts", worktreeStatus: "D" },
        { path: "renamed.ts", indexStatus: "R" },
        { path: "staged.ts", indexStatus: "M" },
        { path: "untracked.ts", worktreeStatus: "?" },
        { path: "worktree.ts", worktreeStatus: "M" }
      ],
      summary: { changedFiles: 7 },
      truncated: false,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });

  it("normalizes worktree-only renames to the destination path", async () => {
    const capability = service({
      status: inspection(" R old-worktree.ts -> renamed-worktree.ts\n")
    });

    const result = await capability.gitChanges({ workspaceId: "ws_worktree_rename" });

    expect(result.changedPaths).toEqual([
      { path: "renamed-worktree.ts", worktreeStatus: "R" }
    ]);
  });

  it("decodes Git C-quoted UTF-8 paths before normalization", async () => {
    const capability = service({
      status: inspection(' M "caf\\303\\251.ts"\n')
    });

    const result = await capability.gitChanges({ workspaceId: "ws_quoted" });

    expect(result.changedPaths).toEqual([{ path: "café.ts", worktreeStatus: "M" }]);
  });

  it("returns a deterministic clean checkpoint without running git diff when patch is omitted", async () => {
    let statusCalls = 0;
    let diffCalls = 0;
    const capability = service({
      status: inspection(""),
      onStatus: () => statusCalls++,
      onDiff: () => diffCalls++
    });

    const first = await capability.gitChanges({ workspaceId: "ws_clean" });
    const second = await capability.gitChanges({ workspaceId: "ws_clean" });

    expect(first).toEqual({
      schemaVersion: 1,
      workspaceId: "ws_clean",
      clean: true,
      changedPaths: [],
      summary: { changedFiles: 0 },
      truncated: false,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(statusCalls).toBe(2);
    expect(diffCalls).toBe(0);
  });

  it("produces the same fingerprint for semantically identical status lines in different order", async () => {
    const first = service({
      status: inspection(" M zeta.ts\nA  alpha.ts\nMM middle.ts\n")
    });
    const second = service({
      status: inspection("MM middle.ts\n M zeta.ts\nA  alpha.ts\n")
    });

    const firstResult = await first.gitChanges({ workspaceId: "ws_order" });
    const secondResult = await second.gitChanges({ workspaceId: "ws_order" });

    expect(firstResult.changedPaths).toEqual(secondResult.changedPaths);
    expect(firstResult.fingerprint).toBe(secondResult.fingerprint);
  });

  it("includes bounded patch preview and artifact metadata when requested", async () => {
    const patch = "diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const capability = service({
      status: inspection(" M file.ts\n"),
      diff: inspection(patch, {
        bytesSpooled: 123,
        artifact: {
          schemaVersion: 1,
          uri: "artifact://ka_diff_fixture",
          mediaType: "application/vnd.kodegpt.execution-stream",
          sizeBytes: 123,
          sourceTruncated: false
        }
      })
    });

    const result = await capability.gitChanges({ workspaceId: "ws_patch", includePatch: true });

    expect(result).toMatchObject({
      schemaVersion: 1,
      workspaceId: "ws_patch",
      clean: false,
      patchPreview: patch,
      patchArtifact: { uri: "artifact://ka_diff_fixture", bytes: 123 },
      truncated: false
    });
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("propagates status truncation without claiming a complete changed-path set", async () => {
    const capability = service({
      status: inspection(" M partial.ts\n", { stdoutTruncated: true, sourceTruncated: true })
    });

    const result = await capability.gitChanges({ workspaceId: "ws_status_truncated" });

    expect(result.changedPaths).toEqual([{ path: "partial.ts", worktreeStatus: "M" }]);
    expect(result.truncated).toBe(true);
  });

  it("propagates patch truncation when patch output is requested", async () => {
    const capability = service({
      status: inspection(" M file.ts\n"),
      diff: inspection("diff --git a/file.ts b/file.ts\n", {
        stdoutTruncated: true,
        sourceTruncated: true,
        artifact: {
          schemaVersion: 1,
          uri: "artifact://ka_truncated_diff",
          mediaType: "application/vnd.kodegpt.execution-stream",
          sizeBytes: 65_536,
          sourceTruncated: true
        }
      })
    });

    const result = await capability.gitChanges({
      workspaceId: "ws_patch_truncated",
      includePatch: true
    });

    expect(result.truncated).toBe(true);
    expect(result.patchArtifact).toEqual({ uri: "artifact://ka_truncated_diff", bytes: 65_536 });
  });
});
