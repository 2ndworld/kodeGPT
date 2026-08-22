import { describe, expect, it } from "vitest";

import {
  CONSOLE_GIT_FRESH_MS,
  ConsoleStateStore,
  resolveConsoleStatus
} from "./state.js";

describe("ConsoleState", () => {
  it("locks precedence FAILED > BLOCKED > DEGRADED > WORKING > READY", () => {
    expect(resolveConsoleStatus({ failed: true, blocked: true, degraded: true, working: true })).toBe(
      "FAILED"
    );
    expect(resolveConsoleStatus({ blocked: true, degraded: true, working: true })).toBe("BLOCKED");
    expect(resolveConsoleStatus({ degraded: true, working: true })).toBe("DEGRADED");
    expect(resolveConsoleStatus({ working: true })).toBe("WORKING");
    expect(resolveConsoleStatus({})).toBe("READY");
  });

  it("treats git cache older than five seconds as stale without refreshing it", () => {
    const store = new ConsoleStateStore();
    store.recordGitStatus("ws_fixture", { clean: true }, 1_000);

    const fresh = store.snapshot(
      { workspaces: [{ id: "ws_fixture" }], health: { ok: true } },
      1_000 + CONSOLE_GIT_FRESH_MS
    );
    expect(fresh.changes).toMatchObject({ workspaceId: "ws_fixture", stale: false });
    expect(fresh.status).toBe("READY");

    const stale = store.snapshot(
      { workspaces: [{ id: "ws_fixture" }], health: { ok: true } },
      1_001 + CONSOLE_GIT_FRESH_MS
    );
    expect(stale.changes).toMatchObject({ workspaceId: "ws_fixture", stale: true });
    expect(stale.status).toBe("DEGRADED");
  });

  it("tracks running process operations and security failure without recomputing in the UI", () => {
    const store = new ConsoleStateStore();
    store.recordProcessOperation({ operationId: "op_running", state: "running" });

    expect(store.snapshot({ workspaces: [], health: { ok: true } }, 5_000).status).toBe("WORKING");
    expect(
      store.snapshot(
        { workspaces: [], health: { ok: false, auditHealthy: false } },
        5_000
      ).status
    ).toBe("FAILED");
  });

  it("projects observed source state into a bounded cockpit without refreshing it", () => {
    const store = new ConsoleStateStore();
    store.recordGitStatus(
      "ws_fixture",
      {
        schemaVersion: 1,
        workspaceId: "ws_fixture",
        clean: false,
        sourceState: {
          headOid: "a".repeat(40),
          changesFingerprint: "f".repeat(64)
        }
      },
      1_000
    );

    const state = store.snapshot(
      { workspaces: [{ id: "ws_fixture", canonicalRoot: "/repo" }], health: { ok: true } },
      1_000
    ) as unknown as {
      cockpit?: {
        workspace?: {
          workspaceId: string;
          root?: string;
          headOid?: string;
          dirty?: boolean;
          freshness: string;
        };
      };
    };

    expect(state.cockpit?.workspace).toEqual({
      workspaceId: "ws_fixture",
      root: "/repo",
      headOid: "a".repeat(40),
      dirty: true,
      freshness: "fresh"
    });
  });

  it("reuses checkpoint and source-bound evidence to build the development cockpit", () => {
    const store = new ConsoleStateStore();
    const sourceState = { headOid: "a".repeat(40), changesFingerprint: "f".repeat(64) };
    store.recordContextBuild(
      "ws_fixture",
      {
        git: { workspaceId: "ws_fixture", clean: true, sourceState },
        resume: {
          checkpointPresent: true,
          checkpoint: {
            revision: 11,
            objective: "Complete P1-B Dev Console v2",
            status: "active",
            baseline: { branch: "feat/p1b", headOid: sourceState.headOid },
            nextActions: ["Run focused verification"]
          },
          checkpointState: { relation: "fresh" }
        }
      },
      1_000
    );
    store.recordVerification(
      {
        workspaceId: "ws_fixture",
        recipe: { id: "package:test", label: "Package test", category: "test" },
        operation: { operationId: "op_verify", state: "completed", exitCode: 0 },
        sourceState
      },
      1_100
    );
    store.recordPreview(
      "ws_fixture",
      {
        previewId: "pv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        operationId: "op_preview",
        processState: "running",
        reachable: true,
        httpStatus: 200,
        sourceState
      },
      1_200
    );
    store.recordProcessOperation(
      { operationId: "op_running", state: "running" },
      "ws_fixture",
      1_300
    );
    store.recordPullRequest(
      {
        repository: "2ndworld/kodeGPT",
        number: 71,
        title: "P1-B Dev Console v2",
        state: "open",
        headBranch: "feat/p1b",
        baseBranch: "main",
        draft: false,
        merged: false
      },
      1_400
    );
    store.recordCi(
      {
        workspaceId: "ws_fixture",
        repository: { fullName: "2ndworld/kodeGPT" },
        revision: { oid: sourceState.headOid, branch: "feat/p1b" },
        state: "SUCCESS",
        checks: [],
        runs: [],
        failures: []
      },
      1_500
    );

    const state = store.snapshot(
      { workspaces: [{ id: "ws_fixture", canonicalRoot: "/repo" }], health: { ok: true } },
      1_500
    );

    expect(state.cockpit.workspace).toMatchObject({
      workspaceId: "ws_fixture",
      branch: "feat/p1b",
      headOid: sourceState.headOid,
      dirty: false,
      freshness: "fresh"
    });
    expect(state.cockpit.objective).toEqual({
      revision: 11,
      objective: "Complete P1-B Dev Console v2",
      status: "active",
      relation: "fresh",
      nextActions: ["Run focused verification"]
    });
    expect(state.cockpit.verification.items[0]).toMatchObject({
      recipeId: "package:test",
      label: "Package test",
      state: "completed",
      freshness: "fresh"
    });
    expect(state.cockpit.previews.active[0]).toMatchObject({
      previewId: "pv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      reachable: true,
      freshness: "fresh"
    });
    expect(state.cockpit.processes.active[0]).toMatchObject({ operationId: "op_running", state: "running" });
    expect(state.cockpit.remote.pullRequest).toMatchObject({
      repository: "2ndworld/kodeGPT",
      number: 71,
      state: "open"
    });
    expect(state.cockpit.remote.ci).toMatchObject({
      repository: "2ndworld/kodeGPT",
      state: "SUCCESS",
      branch: "feat/p1b"
    });
    expect(state.cockpit.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "inspect-active-execution" }),
        expect.objectContaining({ kind: "checkpoint-next-action", label: "Run focused verification" })
      ])
    );
  });

  it("marks source-bound evidence stale after a newer observed source state", () => {
    const store = new ConsoleStateStore();
    const oldSource = { headOid: "a".repeat(40), changesFingerprint: "1".repeat(64) };
    const currentSource = { headOid: "b".repeat(40), changesFingerprint: "2".repeat(64) };
    store.recordGitStatus("ws_fixture", { clean: true, sourceState: oldSource }, 1_000);
    store.recordVerification(
      {
        workspaceId: "ws_fixture",
        recipe: { id: "package:test", label: "Package test", category: "test" },
        operation: { operationId: "op_verify", state: "completed", exitCode: 0 },
        sourceState: oldSource
      },
      1_100
    );
    store.recordPreview(
      "ws_fixture",
      {
        previewId: "pv_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        operationId: "op_preview",
        processState: "running",
        reachable: true,
        httpStatus: 200,
        sourceState: oldSource
      },
      1_200
    );
    store.recordGitStatus("ws_fixture", { clean: false, sourceState: currentSource }, 2_000);

    const state = store.snapshot(
      { workspaces: [{ id: "ws_fixture" }], health: { ok: true } },
      2_000
    );
    expect(state.cockpit.verification.items[0]?.freshness).toBe("stale");
    expect(state.cockpit.previews.active[0]?.freshness).toBe("stale");
    expect(state.cockpit.nextActions).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "verify-current-source" })])
    );
  });

  it("keeps verification freshness unknown until current source state has been observed", () => {
    const store = new ConsoleStateStore();
    store.recordVerification(
      {
        workspaceId: "ws_fixture",
        recipe: { id: "package:test", label: "Package test", category: "test" },
        operation: { operationId: "op_verify", state: "completed", exitCode: 0 },
        sourceState: { headOid: "a".repeat(40), changesFingerprint: "1".repeat(64) }
      },
      1_000
    );

    const state = store.snapshot(
      { workspaces: [{ id: "ws_fixture" }], health: { ok: true } },
      1_000
    );

    expect(state.cockpit.verification.items[0]?.freshness).toBe("unknown");
  });

  it("associates active processes with their observed workspace", () => {
    const store = new ConsoleStateStore();
    store.recordProcessOperation({ operationId: "op_a", state: "running" }, "ws_a", 1_000);
    store.recordProcessOperation({ operationId: "op_b", state: "running" }, "ws_b", 1_100);

    const state = store.snapshot(
      { workspaces: [{ id: "ws_a" }, { id: "ws_b" }], health: { ok: true } },
      1_100
    );

    expect(state.cockpit.processes.active).toEqual([{ operationId: "op_a", state: "running" }]);
  });

  it("surfaces a normalized FAIL CI state as an inspection action", () => {
    const store = new ConsoleStateStore();
    store.recordCi(
      {
        workspaceId: "ws_fixture",
        repository: { fullName: "2ndworld/kodeGPT" },
        state: "FAIL",
        failures: []
      },
      1_000
    );

    const state = store.snapshot(
      { workspaces: [{ id: "ws_fixture" }], health: { ok: true } },
      1_000
    );

    expect(state.cockpit.nextActions).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "inspect-ci-failure" })])
    );
  });

  it("prioritizes a blocked checkpoint ahead of execution, CI, verification, and checkpoint actions", () => {
    const store = new ConsoleStateStore();
    const sourceState = { headOid: "a".repeat(40), changesFingerprint: "1".repeat(64) };
    store.recordGitStatus("ws_fixture", { clean: false, sourceState }, 1_000);
    store.recordWorkspaceInfo(
      "ws_fixture",
      {
        checkpoint: {
          revision: 12,
          objective: "Complete P1-B Dev Console v2",
          status: "blocked",
          nextActions: ["Resolve blocker"],
          blocker: "CI credentials unavailable"
        }
      },
      1_100
    );
    store.recordProcessOperation({ operationId: "op_running", state: "running" }, "ws_fixture", 1_200);
    store.recordCi(
      {
        workspaceId: "ws_fixture",
        repository: { fullName: "2ndworld/kodeGPT" },
        revision: { oid: sourceState.headOid, branch: "feat/p1b" },
        state: "FAILURE",
        failures: [{}]
      },
      1_300
    );

    const state = store.snapshot(
      { workspaces: [{ id: "ws_fixture" }], health: { ok: true } },
      1_300
    );

    expect(state.cockpit.nextActions[0]).toMatchObject({
      kind: "resolve-blocker",
      label: "Resolve checkpoint blocker"
    });
    expect(state.cockpit.nextActions).toHaveLength(5);
  });
});
