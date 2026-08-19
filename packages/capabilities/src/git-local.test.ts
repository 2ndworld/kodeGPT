import { describe, expect, it, vi } from "vitest";

import type { GitLocalAuthorityAdapter, GitLocalMutationAdapter, GitWorktreeMutationAdapter } from "./adapters.js";
import {
  GitBranchInputSchema,
  GitCommitInputSchema,
  GitLocalMutationResultSchema,
  GitStageInputSchema,
  GitWorktreeCreateInputSchema,
  GitWorktreeCreateResultSchema,
  GitWorktreeRemoveInputSchema,
  GitWorktreeRemoveResultSchema
} from "./schemas.js";
import {
  gitBranchCreate,
  gitBranchDelete,
  gitBranchSwitch,
  gitCommit,
  gitStage,
  gitWorktreeCreate,
  gitWorktreeRemove
} from "./git-local.js";

const RESULT = {
  schemaVersion: 1 as const,
  operation: "stage" as const,
  exitCode: 0,
  stdoutPreview: "",
  stderrPreview: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  sourceTruncated: false,
  bytesSpooled: 0,
  artifact: {
    schemaVersion: 1 as const,
    uri: "artifact://ka_git_local_fixture" as const,
    mediaType: "application/vnd.kodegpt.execution-stream",
    sizeBytes: 0,
    sourceTruncated: false
  }
};

const WORKTREE_CREATE_RESULT = {
  schemaVersion: 1 as const,
  operation: "create" as const,
  name: "phase7",
  relativePath: ".worktrees/phase7" as const,
  branch: "feat/phase7",
  headOid: "a".repeat(40)
};

const WORKTREE_REMOVE_RESULT = {
  schemaVersion: 1 as const,
  operation: "remove" as const,
  name: "phase7",
  relativePath: ".worktrees/phase7" as const,
  removed: true as const
};

describe("trusted local Git capability", () => {
  it("rejects unsafe typed inputs before adapter execution", () => {
    expect(() => GitStageInputSchema.parse({ workspaceId: "ws", paths: ["../outside"] })).toThrow();
    expect(() => GitStageInputSchema.parse({ workspaceId: "ws", paths: ["."] })).toThrow();
    expect(() => GitCommitInputSchema.parse({ workspaceId: "ws", message: "" })).toThrow();
    expect(() => GitBranchInputSchema.parse({ workspaceId: "ws", name: "-danger" })).toThrow();
    expect(() => GitBranchInputSchema.parse({ workspaceId: "ws", name: "bad..name" })).toThrow();
    expect(() => GitLocalMutationResultSchema.parse({ ...RESULT, capabilityId: "kc_secret" })).toThrow();
  });

  it("requires effective trusted authority even when develop is writable", async () => {
    const authority: GitLocalAuthorityAdapter = {
      effectivePolicy: () => ({ name: "develop", allowWrite: true })
    };
    const mutation: GitLocalMutationAdapter = {
      stage: vi.fn(async () => RESULT),
      commit: vi.fn(async () => ({ ...RESULT, operation: "commit" as const })),
      branchCreate: vi.fn(async () => ({ ...RESULT, operation: "branch_create" as const })),
      branchSwitch: vi.fn(async () => ({ ...RESULT, operation: "branch_switch" as const })),
      branchDelete: vi.fn(async () => ({ ...RESULT, operation: "branch_delete" as const }))
    };

    await expect(gitStage(authority, mutation, { workspaceId: "ws", paths: ["src/a.ts"] })).rejects.toMatchObject({
      code: "GIT_POLICY_DENIED"
    });
    expect(mutation.stage).not.toHaveBeenCalled();
  });

  it("routes all five typed operations only after trusted policy passes", async () => {
    const authority: GitLocalAuthorityAdapter = {
      effectivePolicy: () => ({ name: "trusted", allowWrite: true })
    };
    const mutation: GitLocalMutationAdapter = {
      stage: vi.fn(async () => RESULT),
      commit: vi.fn(async () => ({ ...RESULT, operation: "commit" as const })),
      branchCreate: vi.fn(async () => ({ ...RESULT, operation: "branch_create" as const })),
      branchSwitch: vi.fn(async () => ({ ...RESULT, operation: "branch_switch" as const })),
      branchDelete: vi.fn(async () => ({ ...RESULT, operation: "branch_delete" as const }))
    };

    await expect(gitStage(authority, mutation, { workspaceId: "ws", paths: ["src/a.ts"] })).resolves.toMatchObject({ operation: "stage" });
    await expect(gitCommit(authority, mutation, { workspaceId: "ws", message: "message" })).resolves.toMatchObject({ operation: "commit" });
    await expect(gitBranchCreate(authority, mutation, { workspaceId: "ws", name: "feature/a" })).resolves.toMatchObject({ operation: "branch_create" });
    await expect(gitBranchSwitch(authority, mutation, { workspaceId: "ws", name: "feature/a" })).resolves.toMatchObject({ operation: "branch_switch" });
    await expect(gitBranchDelete(authority, mutation, { workspaceId: "ws", name: "feature/a" })).resolves.toMatchObject({ operation: "branch_delete" });
  });
});

describe("bounded linked-worktree capability", () => {
  it("rejects path-like names and non-closed structured results", () => {
    expect(() => GitWorktreeCreateInputSchema.parse({ workspaceId: "ws", name: "phase7", branch: "feat/phase7" })).not.toThrow();
    expect(() => GitWorktreeRemoveInputSchema.parse({ workspaceId: "ws", name: "phase7" })).not.toThrow();
    for (const name of ["", ".", "..", "-phase7", "feature/phase7", "feature phase7", "../escape", "a%2Fb", "a".repeat(65)]) {
      expect(() => GitWorktreeRemoveInputSchema.parse({ workspaceId: "ws", name })).toThrow();
    }
    expect(() => GitWorktreeCreateResultSchema.parse({ ...WORKTREE_CREATE_RESULT, canonicalPath: "/host/repo/.worktrees/phase7" })).toThrow();
    expect(() => GitWorktreeCreateResultSchema.parse({ ...WORKTREE_CREATE_RESULT, headOid: "abc" })).toThrow();
    expect(() => GitWorktreeCreateResultSchema.parse({ ...WORKTREE_CREATE_RESULT, relativePath: ".worktrees/other" })).toThrow();
    expect(() => GitWorktreeRemoveResultSchema.parse({ ...WORKTREE_REMOVE_RESULT, removed: false })).toThrow();
    expect(() => GitWorktreeRemoveResultSchema.parse({ ...WORKTREE_REMOVE_RESULT, relativePath: ".worktrees/other" })).toThrow();
  });

  it("requires trusted authority and routes exactly create/remove", async () => {
    const deniedAuthority: GitLocalAuthorityAdapter = {
      effectivePolicy: () => ({ name: "develop", allowWrite: true })
    };
    const trustedAuthority: GitLocalAuthorityAdapter = {
      effectivePolicy: () => ({ name: "trusted", allowWrite: true })
    };
    const mutation: GitWorktreeMutationAdapter = {
      worktreeCreate: vi.fn(async () => WORKTREE_CREATE_RESULT),
      worktreeRemove: vi.fn(async () => WORKTREE_REMOVE_RESULT)
    };

    await expect(
      gitWorktreeCreate(deniedAuthority, mutation, { workspaceId: "ws", name: "phase7", branch: "feat/phase7" })
    ).rejects.toMatchObject({ code: "GIT_POLICY_DENIED" });
    expect(mutation.worktreeCreate).not.toHaveBeenCalled();

    await expect(
      gitWorktreeCreate(trustedAuthority, mutation, { workspaceId: "ws", name: "phase7", branch: "feat/phase7" })
    ).resolves.toEqual(WORKTREE_CREATE_RESULT);
    await expect(
      gitWorktreeRemove(trustedAuthority, mutation, { workspaceId: "ws", name: "phase7" })
    ).resolves.toEqual(WORKTREE_REMOVE_RESULT);
    expect(mutation.worktreeCreate).toHaveBeenCalledWith("ws", "phase7", "feat/phase7");
    expect(mutation.worktreeRemove).toHaveBeenCalledWith("ws", "phase7");
  });
});
