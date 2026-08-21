import { describe, expect, it } from "vitest";

import type {
  CapabilityGitCheckpointRecord,
  CapabilityGitCheckpointResult,
  GitCheckpointAdapter,
  GitInspectionAdapterResult
} from "./adapters.js";
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
      uri: "artifact://ka_git_checkpoint_patch",
      mediaType: "application/vnd.kodegpt.execution-stream",
      sizeBytes: Buffer.byteLength(stdoutPreview),
      sourceTruncated: false
    },
    ...options
  };
}

function identity(sha256: string, sizeBytes = 7) {
  return {
    exists: true,
    kind: "file" as const,
    sizeBytes,
    sha256,
    hashTruncated: false
  };
}

function checkpoint(
  records: CapabilityGitCheckpointRecord[],
  truncated = false,
  headOid = "f".repeat(40)
): CapabilityGitCheckpointResult {
  return { schemaVersion: 1, headOid, records, truncated };
}

function service(options: {
  checkpoint: CapabilityGitCheckpointResult | (() => Promise<CapabilityGitCheckpointResult>);
  patch?: GitInspectionAdapterResult;
  onCheckpoint?: () => void;
  onPatch?: () => void;
}): NativeCapabilityService {
  const git: GitCheckpointAdapter = {
    checkpoint: async () => {
      options.onCheckpoint?.();
      return typeof options.checkpoint === "function"
        ? options.checkpoint()
        : options.checkpoint;
    },
    checkpointPatch: async () => {
      options.onPatch?.();
      return options.patch ?? inspection("");
    }
  };
  return new NativeCapabilityService(createTestCapabilityDependencies({ git }));
}

const oidA = "1".repeat(40);
const oidB = "2".repeat(40);
const shaA = "a".repeat(64);
const shaB = "b".repeat(64);

function ordinary(
  path: string,
  options: Partial<CapabilityGitCheckpointRecord> = {}
): CapabilityGitCheckpointRecord {
  return {
    recordType: "ordinary",
    path,
    headMode: "100644",
    indexMode: "100644",
    worktreeMode: "100644",
    headOid: oidA,
    indexOid: oidA,
    ...options
  };
}

describe("git.changes", () => {
  it("derives deterministic changed paths from structured checkpoint records", async () => {
    const capability = service({
      checkpoint: checkpoint([
        ordinary("worktree.ts", { worktreeStatus: "M", currentIdentity: identity(shaA) }),
        ordinary("staged.ts", { indexStatus: "M", indexOid: oidB }),
        ordinary("both.ts", {
          indexStatus: "M",
          worktreeStatus: "M",
          indexOid: oidB,
          currentIdentity: identity(shaB)
        }),
        {
          recordType: "rename",
          path: "renamed.ts",
          originalPath: "old -> quoted name.ts",
          indexStatus: "R",
          headMode: "100644",
          indexMode: "100644",
          worktreeMode: "100644",
          headOid: oidA,
          indexOid: oidB
        },
        {
          recordType: "untracked",
          path: "untracked -> \"é.ts",
          worktreeStatus: "?",
          currentIdentity: identity(shaA)
        }
      ])
    });

    const result = await capability.gitChanges({ workspaceId: "ws_git" });

    expect(result.changedPaths).toEqual([
      { path: "both.ts", indexStatus: "M", worktreeStatus: "M" },
      { path: "renamed.ts", indexStatus: "R" },
      { path: "staged.ts", indexStatus: "M" },
      { path: "untracked -> \"é.ts", worktreeStatus: "?" },
      { path: "worktree.ts", worktreeStatus: "M" }
    ]);
    expect(result.clean).toBe(false);
    expect(result.summary).toEqual({ changedFiles: 5 });
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sourceState).toEqual({
      headOid: "f".repeat(40),
      changesFingerprint: result.fingerprint
    });
  });

  it("returns a deterministic clean checkpoint without generating patch presentation", async () => {
    let patchCalls = 0;
    const capability = service({
      checkpoint: checkpoint([]),
      onPatch: () => patchCalls++
    });

    const first = await capability.gitChanges({ workspaceId: "ws_clean" });
    const second = await capability.gitChanges({ workspaceId: "ws_clean" });

    expect(first.clean).toBe(true);
    expect(first.truncated).toBe(false);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(patchCalls).toBe(0);
  });

  it("changes fingerprint when worktree content changes despite identical status", async () => {
    const first = service({
      checkpoint: checkpoint([
        ordinary("file.ts", { worktreeStatus: "M", currentIdentity: identity(shaA) })
      ])
    });
    const second = service({
      checkpoint: checkpoint([
        ordinary("file.ts", { worktreeStatus: "M", currentIdentity: identity(shaB) })
      ])
    });

    const firstResult = await first.gitChanges({ workspaceId: "ws_content" });
    const secondResult = await second.gitChanges({ workspaceId: "ws_content" });
    expect(secondResult.fingerprint).not.toBe(firstResult.fingerprint);
  });

  it("changes fingerprint when staged index object changes", async () => {
    const first = service({
      checkpoint: checkpoint([ordinary("file.ts", { indexStatus: "M", indexOid: oidA })])
    });
    const second = service({
      checkpoint: checkpoint([ordinary("file.ts", { indexStatus: "M", indexOid: oidB })])
    });

    expect((await first.gitChanges({ workspaceId: "ws_index" })).fingerprint).not.toBe(
      (await second.gitChanges({ workspaceId: "ws_index" })).fingerprint
    );
  });

  it("changes fingerprint when untracked content changes", async () => {
    const first = service({
      checkpoint: checkpoint([
        {
          recordType: "untracked",
          path: "new.txt",
          worktreeStatus: "?",
          currentIdentity: identity(shaA)
        }
      ])
    });
    const second = service({
      checkpoint: checkpoint([
        {
          recordType: "untracked",
          path: "new.txt",
          worktreeStatus: "?",
          currentIdentity: identity(shaB)
        }
      ])
    });

    expect((await first.gitChanges({ workspaceId: "ws_untracked" })).fingerprint).not.toBe(
      (await second.gitChanges({ workspaceId: "ws_untracked" })).fingerprint
    );
  });

  it("keeps fingerprint invariant when patch presentation is requested", async () => {
    const state = checkpoint([
      ordinary("file.ts", { worktreeStatus: "M", currentIdentity: identity(shaA) })
    ]);
    const capability = service({
      checkpoint: state,
      patch: inspection(
        "=== KODEGPT STAGED DIFF ===\n=== KODEGPT WORKTREE DIFF ===\ndiff --git a/file.ts b/file.ts\n"
      )
    });

    const compact = await capability.gitChanges({ workspaceId: "ws_option_invariant" });
    const withPatch = await capability.gitChanges({
      workspaceId: "ws_option_invariant",
      includePatch: true
    });

    expect(withPatch.fingerprint).toBe(compact.fingerprint);
    expect(withPatch.patchCoverage).toEqual({ staged: true, worktree: true, untracked: false });
  });

  it("produces the same fingerprint for semantically identical records in different order", async () => {
    const alpha = ordinary("alpha.ts", { indexStatus: "A", indexOid: oidB });
    const zeta = ordinary("zeta.ts", { worktreeStatus: "M", currentIdentity: identity(shaA) });
    const first = service({ checkpoint: checkpoint([zeta, alpha]) });
    const second = service({ checkpoint: checkpoint([alpha, zeta]) });

    expect((await first.gitChanges({ workspaceId: "ws_order" })).fingerprint).toBe(
      (await second.gitChanges({ workspaceId: "ws_order" })).fingerprint
    );
  });

  it("returns bounded combined patch metadata and explicit coverage when requested", async () => {
    const patch =
      "=== KODEGPT STAGED DIFF ===\ndiff --git a/staged.ts b/staged.ts\n" +
      "=== KODEGPT WORKTREE DIFF ===\ndiff --git a/worktree.ts b/worktree.ts\n";
    const capability = service({
      checkpoint: checkpoint([ordinary("staged.ts", { indexStatus: "A", indexOid: oidB })]),
      patch: inspection(patch, {
        bytesSpooled: 123,
        artifact: {
          schemaVersion: 1,
          uri: "artifact://ka_combined_patch",
          mediaType: "application/vnd.kodegpt.execution-stream",
          sizeBytes: 123,
          sourceTruncated: false
        }
      })
    });

    const result = await capability.gitChanges({ workspaceId: "ws_patch", includePatch: true });
    expect(result.patchPreview).toBe(patch);
    expect(result.patchArtifact).toEqual({ uri: "artifact://ka_combined_patch", bytes: 123 });
    expect(result.patchCoverage).toEqual({ staged: true, worktree: true, untracked: false });
    expect(result.truncated).toBe(false);
  });

  it("propagates checkpoint and patch truncation without claiming clean state", async () => {
    const checkpointTruncated = service({ checkpoint: checkpoint([], true) });
    const checkpointResult = await checkpointTruncated.gitChanges({ workspaceId: "ws_truncated" });
    expect(checkpointResult.clean).toBe(false);
    expect(checkpointResult.truncated).toBe(true);

    const patchTruncated = service({
      checkpoint: checkpoint([ordinary("file.ts", { indexStatus: "M", indexOid: oidB })]),
      patch: inspection("=== KODEGPT STAGED DIFF ===\n", {
        stdoutTruncated: true,
        sourceTruncated: true
      })
    });
    expect(
      (await patchTruncated.gitChanges({ workspaceId: "ws_patch_truncated", includePatch: true }))
        .truncated
    ).toBe(true);
  });

  it("maps invalid input and runtime checkpoint failures to stable capability errors", async () => {
    const capability = service({ checkpoint: checkpoint([]) });
    await expect(capability.gitChanges({ workspaceId: "" })).rejects.toMatchObject({
      code: "CAPABILITY_INPUT_INVALID"
    });

    const invalid = service({
      checkpoint: async () => {
        throw Object.assign(new Error("host path /home/private"), {
          code: "RUNTIME_PROTOCOL_INVALID"
        });
      }
    });
    await expect(invalid.gitChanges({ workspaceId: "ws_invalid" })).rejects.toMatchObject({
      code: "GIT_STATUS_INVALID",
      message: "Git checkpoint status is invalid"
    });
  });
});
