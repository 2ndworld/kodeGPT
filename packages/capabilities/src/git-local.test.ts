import { describe, expect, it, vi } from "vitest";

import type { GitLocalAuthorityAdapter, GitLocalMutationAdapter } from "./adapters.js";
import { GitBranchInputSchema, GitCommitInputSchema, GitLocalMutationResultSchema, GitStageInputSchema } from "./schemas.js";
import { gitBranchCreate, gitBranchDelete, gitBranchSwitch, gitCommit, gitStage } from "./git-local.js";

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
