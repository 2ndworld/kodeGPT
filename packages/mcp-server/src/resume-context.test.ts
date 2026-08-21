import { describe, expect, it } from "vitest";

import type {
  ContextBuildResult,
  GitRangeInput,
  GitRangeResult
} from "@kodegpt/capabilities";
import type {
  WorkspaceCheckpointSourceStateRef,
  WorkspaceInfo
} from "../../core/src/index.js";

import {
  composeResumeSynthesis,
  reconcileCheckpointSourceState,
  type ResumeContextAdapter
} from "./resume-context.js";

const CURRENT: WorkspaceCheckpointSourceStateRef = {
  headOid: "2".repeat(40),
  changesFingerprint: "b".repeat(64)
};
const CAPTURED: WorkspaceCheckpointSourceStateRef = {
  headOid: "1".repeat(40),
  changesFingerprint: "a".repeat(64)
};
const PV_LIVE = `pv_${"1".repeat(32)}`;
const PV_STALE = `pv_${"2".repeat(32)}`;

function rangeResult(input: GitRangeInput, isAncestor: boolean): GitRangeResult {
  const baseOid = input.baseRevision.kind === "oid" ? input.baseRevision.oid : "";
  const headOid = input.headRevision.kind === "oid" ? input.headRevision.oid : "";
  return {
    schemaVersion: 1,
    baseOid,
    headOid,
    isAncestor,
    mergeBaseOid: isAncestor ? baseOid : null,
    ahead: { value: 0, exact: true },
    behind: { value: 0, exact: true },
    commits: [],
    returnedCount: 0,
    truncated: false,
    truncationReasons: []
  };
}

function ancestry(sequence: Array<boolean | Error>) {
  const calls: GitRangeInput[] = [];
  return {
    calls,
    adapter: {
      gitRange: async (input: GitRangeInput) => {
        calls.push(input);
        const next = sequence.shift();
        if (next instanceof Error) throw next;
        return rangeResult(input, next ?? false);
      }
    }
  };
}

describe("resume checkpoint source-state reconciliation", () => {
  it("classifies an exact source-state match as fresh without ancestry reads", async () => {
    const fixture = ancestry([]);
    const result = await reconcileCheckpointSourceState(
      fixture.adapter,
      "ws_test",
      CURRENT,
      CURRENT
    );

    expect(result).toEqual({
      relation: "fresh",
      reasons: ["SOURCE_STATE_MATCH"],
      capturedSourceState: CURRENT,
      currentSourceState: CURRENT
    });
    expect(fixture.calls).toEqual([]);
  });

  it("classifies same-HEAD working-tree changes as stale without ancestry reads", async () => {
    const fixture = ancestry([]);
    const captured = { ...CURRENT, changesFingerprint: "c".repeat(64) };
    const result = await reconcileCheckpointSourceState(
      fixture.adapter,
      "ws_test",
      captured,
      CURRENT
    );

    expect(result.relation).toBe("stale");
    expect(result.reasons).toEqual(["WORKTREE_CHANGED"]);
    expect(fixture.calls).toEqual([]);
  });

  it("classifies a captured ancestor as HEAD_ADVANCED with one bounded range read", async () => {
    const fixture = ancestry([true]);
    const result = await reconcileCheckpointSourceState(
      fixture.adapter,
      "ws_test",
      CAPTURED,
      CURRENT
    );

    expect(result.relation).toBe("stale");
    expect(result.reasons).toEqual(["HEAD_ADVANCED"]);
    expect(fixture.calls).toEqual([
      {
        workspaceId: "ws_test",
        baseRevision: { kind: "oid", oid: CAPTURED.headOid },
        headRevision: { kind: "oid", oid: CURRENT.headOid },
        mode: "direct"
      }
    ]);
  });

  it("classifies a rewind with exactly two bounded range reads", async () => {
    const fixture = ancestry([false, true]);
    const result = await reconcileCheckpointSourceState(
      fixture.adapter,
      "ws_test",
      CAPTURED,
      CURRENT
    );

    expect(result.relation).toBe("superseded");
    expect(result.reasons).toEqual(["HEAD_REWOUND"]);
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls[1]).toEqual({
      workspaceId: "ws_test",
      baseRevision: { kind: "oid", oid: CURRENT.headOid },
      headRevision: { kind: "oid", oid: CAPTURED.headOid },
      mode: "direct"
    });
  });

  it("classifies divergent history when neither direction is ancestral", async () => {
    const fixture = ancestry([false, false]);
    const result = await reconcileCheckpointSourceState(
      fixture.adapter,
      "ws_test",
      CAPTURED,
      CURRENT
    );

    expect(result.relation).toBe("superseded");
    expect(result.reasons).toEqual(["HEAD_DIVERGED"]);
    expect(fixture.calls).toHaveLength(2);
  });

  it("keeps legacy checkpoints unverifiable without fabricating ancestry", async () => {
    const fixture = ancestry([]);
    const result = await reconcileCheckpointSourceState(
      fixture.adapter,
      "ws_test",
      undefined,
      CURRENT
    );

    expect(result).toEqual({
      relation: "unverifiable",
      reasons: ["LEGACY_SOURCE_STATE_UNKNOWN"],
      currentSourceState: CURRENT
    });
    expect(fixture.calls).toEqual([]);
  });

  it("degrades ancestry failures to unverifiable instead of guessing", async () => {
    const fixture = ancestry([new Error("git range unavailable")]);
    const result = await reconcileCheckpointSourceState(
      fixture.adapter,
      "ws_test",
      CAPTURED,
      CURRENT
    );

    expect(result.relation).toBe("unverifiable");
    expect(result.reasons).toEqual(["GIT_ANCESTRY_UNAVAILABLE"]);
    expect(fixture.calls).toHaveLength(1);
  });
});

function baseContext(sourceState: WorkspaceCheckpointSourceStateRef | null = CURRENT): ContextBuildResult {
  return {
    schemaVersion: 1,
    intent: "resume",
    evidenceStatus: {
      workspace: "available",
      git: sourceState === null ? "unavailable" : "available",
      search: "available",
      verification: "available"
    },
    workspace: {
      schemaVersion: 1,
      workspaceId: "ws_test",
      root: ".",
      scope: { kind: "workspace" },
      projectTypes: [],
      languages: [],
      entrypoints: [],
      areas: [],
      manifests: [],
      warnings: [],
      truncated: false
    },
    ...(sourceState === null
      ? {}
      : {
          git: {
            schemaVersion: 1,
            workspaceId: "ws_test",
            clean: true,
            changedPaths: [],
            summary: { changedFiles: 0 },
            truncated: false,
            fingerprint: sourceState.changesFingerprint,
            sourceState
          }
        }),
    selectedFiles: [],
    relevantMatches: [],
    verifications: [],
    warnings: [],
    totalBytes: 0,
    truncated: false
  };
}

function workspaceInfo(evidenceRefs: WorkspaceInfo["checkpoint"] extends infer _ ? Array<{ kind: "artifact" | "process" | "preview" | "pr" | "ci" | "git" | "note"; ref: string; summary?: string }> : never): WorkspaceInfo {
  return {
    id: "ws_test",
    canonicalRoot: "/workspace",
    effectivePolicy: {
      name: "trusted",
      allowWrite: true,
      allowProcess: true,
      allowDynamicExecutables: true,
      network: "unrestricted",
      allowedExecutableNames: [],
      inheritEnv: false,
      envAllowlist: []
    },
    checkpoint: {
      schemaVersion: 1,
      revision: 2,
      objective: "Resume implementation",
      status: "active",
      nextActions: ["Continue"],
      evidenceRefs,
      updatedAt: "2026-08-21T00:00:00.000Z"
    },
    continuity: {
      schemaVersion: 1,
      capturedSourceState: CURRENT,
      milestones: []
    }
  };
}

function resumeAdapter(info: WorkspaceInfo) {
  const calls: string[] = [];
  const adapter: ResumeContextAdapter = {
    workspaceInfo: async () => info,
    gitRange: async (input) => rangeResult(input, false),
    processStatus: async (_workspaceId, operationId) => {
      calls.push(`process:${operationId}`);
      if (operationId === "op_missing") throw new Error("missing process");
      return {
        schemaVersion: 1,
        operationId,
        state: "completed",
        exitCode: 0,
        stdoutPreview: "",
        stderrPreview: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        sourceTruncated: false,
        bytesSpooled: 0,
        artifact: {
          schemaVersion: 1,
          uri: "artifact://ka_process",
          mediaType: "application/vnd.kodegpt.execution-stream",
          sizeBytes: 0,
          sourceTruncated: false
        }
      } as never;
    },
    previewInspect: async ({ previewId }) => {
      calls.push(`preview:${previewId}`);
      return {
        schemaVersion: 1,
        previewId,
        operationId: "op_preview",
        url: "http://127.0.0.1:3000",
        processState: "running",
        reachable: true,
        httpStatus: 200,
        sourceState: previewId === PV_STALE ? CAPTURED : CURRENT
      };
    },
    repository: async () => {
      calls.push("repository");
      return {
        schemaVersion: 1,
        workspaceId: "ws_test",
        provider: "github",
        repository: { owner: "2ndworld", name: "kodeGPT", fullName: "2ndworld/kodeGPT" },
        selectedRemote: "origin",
        defaultBranch: "main",
        currentRevision: { oid: CURRENT.headOid, branch: "main" },
        available: true,
        authState: "READY",
        credentialSource: "gh",
        truncated: false,
        truncationReasons: []
      } as never;
    },
    prInspect: async ({ number }) => {
      calls.push(`pr:${number}`);
      return { state: "open", merged: false } as never;
    },
    ciRun: async ({ runId }) => {
      calls.push(`ci:${runId}`);
      return {
        run: { id: runId, status: "COMPLETED", conclusion: "SUCCESS", headOid: CURRENT.headOid }
      } as never;
    },
    artifactProbe: async (uri) => {
      calls.push(`artifact:${uri}`);
      if (uri.includes("missing")) throw new Error("missing artifact");
    }
  };
  return { adapter, calls };
}

describe("resume evidence synthesis", () => {
  it("returns an explicit no-checkpoint state without touching evidence adapters", async () => {
    const info = workspaceInfo([]);
    delete info.checkpoint;
    delete info.continuity;
    const fixture = resumeAdapter(info);

    const result = await composeResumeSynthesis(fixture.adapter, "ws_test", baseContext());

    expect(result).toEqual({
      schemaVersion: 1,
      checkpointPresent: false,
      milestones: [],
      evidence: [],
      warnings: []
    });
    expect(fixture.calls).toEqual([]);
  });

  it("reconciles explicit evidence one-shot in checkpoint order and degrades individual failures", async () => {
    const evidenceRefs = [
      { kind: "process" as const, ref: "op_done", summary: "test operation" },
      { kind: "process" as const, ref: "op_missing" },
      { kind: "preview" as const, ref: PV_LIVE },
      { kind: "preview" as const, ref: PV_STALE },
      { kind: "pr" as const, ref: "64" },
      { kind: "ci" as const, ref: "32499062107" },
      { kind: "artifact" as const, ref: "artifact://ka_resume" },
      { kind: "git" as const, ref: "3".repeat(40) },
      { kind: "note" as const, ref: "decision-note" },
      { kind: "pr" as const, ref: "not-a-number" }
    ];
    const fixture = resumeAdapter(workspaceInfo(evidenceRefs));

    const result = await composeResumeSynthesis(fixture.adapter, "ws_test", baseContext());

    expect(result.checkpointPresent).toBe(true);
    if (!result.checkpointPresent) throw new Error("expected checkpoint");
    expect(result.checkpointState.relation).toBe("fresh");
    expect(result.evidence.map(({ kind, ref, availability }) => ({ kind, ref, availability }))).toEqual([
      { kind: "process", ref: "op_done", availability: "observed" },
      { kind: "process", ref: "op_missing", availability: "missing" },
      { kind: "preview", ref: PV_LIVE, availability: "observed" },
      { kind: "preview", ref: PV_STALE, availability: "observed" },
      { kind: "pr", ref: "64", availability: "observed" },
      { kind: "ci", ref: "32499062107", availability: "observed" },
      { kind: "artifact", ref: "artifact://ka_resume", availability: "observed" },
      { kind: "git", ref: "3333333333333333333333333333333333333333", availability: "informational" },
      { kind: "note", ref: "decision-note", availability: "informational" },
      { kind: "pr", ref: "not-a-number", availability: "invalid" }
    ]);
    expect(result.evidence[0]).toMatchObject({ state: "completed", relation: "unverifiable" });
    expect(result.evidence[2]).toMatchObject({ relation: "fresh" });
    expect(result.evidence[3]).toMatchObject({ relation: "stale" });
    expect(result.evidence[4]).toMatchObject({ state: "open" });
    expect(result.evidence[5]).toMatchObject({ state: "COMPLETED/SUCCESS" });
    expect(fixture.calls).toEqual([
      "process:op_done",
      "process:op_missing",
      `preview:${PV_LIVE}`,
      `preview:${PV_STALE}`,
      "repository",
      "pr:64",
      "ci:32499062107",
      "artifact:artifact://ka_resume"
    ]);
  });

  it("keeps checkpoint synthesis useful when current Git source state is unavailable", async () => {
    const fixture = resumeAdapter(workspaceInfo([{ kind: "note", ref: "legacy" }]));
    const result = await composeResumeSynthesis(
      fixture.adapter,
      "ws_test",
      baseContext(null)
    );

    expect(result.checkpointPresent).toBe(true);
    if (!result.checkpointPresent) throw new Error("expected checkpoint");
    expect(result.checkpointState.relation).toBe("unverifiable");
    expect(result.warnings).toContain("resume-current-source-state-unavailable");
    expect(result.evidence).toEqual([
      { kind: "note", ref: "legacy", availability: "informational" }
    ]);
  });
});
