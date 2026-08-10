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
});
