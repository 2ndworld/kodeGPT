import { describe, expect, it } from "vitest";

import { createKodegptToolContext } from "./tool-context.js";

const SOURCE_STATE = {
  headOid: "1".repeat(40),
  changesFingerprint: "a".repeat(64)
};

function checkpointBody() {
  return {
    objective: "Continue implementation",
    status: "active" as const,
    nextActions: ["Run focused tests"],
    evidenceRefs: []
  };
}

function baseOptions(input: {
  onCheckpoint: (value: unknown) => void;
  gitChanges: () => Promise<unknown>;
}) {
  return {
    workspaceManager: {
      checkpointWorkspace: async (value: unknown) => {
        input.onCheckpoint(value);
        return {
          schemaVersion: 1,
          operation: "upsert",
          checkpoint: {
            schemaVersion: 1,
            revision: 1,
            ...checkpointBody(),
            updatedAt: "2026-08-21T00:00:00.000Z"
          }
        };
      }
    } as never,
    executionManager: {} as never,
    artifactStore: {} as never,
    nativeCapabilities: {
      gitChanges: input.gitChanges
    } as never,
    inspectProfile: () => ({}),
    capabilities: () => ({}),
    health: () => ({})
  };
}

describe("continuity tool-context composition", () => {
  it("captures source state exactly once before forwarding a checkpoint upsert", async () => {
    const checkpointInputs: unknown[] = [];
    let gitChangesCalls = 0;
    const context = createKodegptToolContext(
      baseOptions({
        onCheckpoint: (value) => checkpointInputs.push(value),
        gitChanges: async () => {
          gitChangesCalls += 1;
          return { sourceState: SOURCE_STATE };
        }
      })
    );

    await context.workspace.checkpoint({
      workspaceId: "ws_test",
      operation: "upsert",
      checkpoint: checkpointBody()
    });

    expect(gitChangesCalls).toBe(1);
    expect(checkpointInputs).toEqual([
      {
        workspaceId: "ws_test",
        operation: "upsert",
        checkpoint: checkpointBody(),
        capturedSourceState: SOURCE_STATE
      }
    ]);
  });

  it("does not mutate checkpoint state when source-state capture fails", async () => {
    let checkpointCalls = 0;
    const context = createKodegptToolContext(
      baseOptions({
        onCheckpoint: () => {
          checkpointCalls += 1;
        },
        gitChanges: async () => {
          throw new Error("source state unavailable");
        }
      })
    );

    await expect(
      context.workspace.checkpoint({
        workspaceId: "ws_test",
        operation: "upsert",
        checkpoint: checkpointBody()
      })
    ).rejects.toThrow("source state unavailable");
    expect(checkpointCalls).toBe(0);
  });
});
