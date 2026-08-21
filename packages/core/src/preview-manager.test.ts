import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import { NodeLoopbackPreviewProbe, PreviewManager } from "./preview-manager.js";
import type { WorkspaceProcessOperationResult, WorkspaceProcessRunInput } from "./workspace-manager.js";

const PREVIEW_ID = "pv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOURCE_STATE = {
  headOid: "1".repeat(40),
  changesFingerprint: "a".repeat(64)
};
const SOURCE_STATE_ADAPTER = { resolve: async () => SOURCE_STATE };

const RUNNING: WorkspaceProcessOperationResult = {
  schemaVersion: 1,
  operationId: "op_preview_fixture",
  state: "running",
  stdoutPreview: "",
  stderrPreview: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  sourceTruncated: false,
  bytesSpooled: 0,
  artifact: {
    schemaVersion: 1,
    uri: "artifact://ka_preview_fixture",
    mediaType: "application/vnd.kodegpt.execution-stream",
    sizeBytes: 0,
    sourceTruncated: false
  }
};

function processFixture(calls: unknown[] = []) {
  return {
    async run(input: WorkspaceProcessRunInput) {
      calls.push(["run", input]);
      return RUNNING;
    },
    async status(workspaceId: string, operationId: string) {
      calls.push(["status", workspaceId, operationId]);
      return RUNNING;
    },
    async cancel(workspaceId: string, operationId: string) {
      calls.push(["cancel", workspaceId, operationId]);
      return { ...RUNNING, state: "cancelled" as const };
    }
  };
}

describe("PreviewManager", () => {
  it("captures source state once before launch and preserves it across inspect and stop", async () => {
    const events: string[] = [];
    let sourceStateCalls = 0;
    const process = {
      ...processFixture(),
      async run(input: WorkspaceProcessRunInput) {
        events.push("run");
        return processFixture().run(input);
      }
    };
    const manager = new PreviewManager(process, {
      idFactory: () => PREVIEW_ID,
      sourceState: {
        async resolve() {
          sourceStateCalls += 1;
          events.push("source-state");
          return SOURCE_STATE;
        }
      },
      probe: { inspect: async () => ({ reachable: false, httpStatus: null }) },
      sleep: async () => undefined
    });

    const started = await manager.start({
      workspaceId: "ws_preview",
      logicalExecutable: "node",
      argv: ["server.mjs"],
      port: 3000,
      waitMs: 0
    });
    const inspected = await manager.inspect({ workspaceId: "ws_preview", previewId: PREVIEW_ID });
    const stopped = await manager.stop({ workspaceId: "ws_preview", previewId: PREVIEW_ID });

    expect(events.slice(0, 2)).toEqual(["source-state", "run"]);
    expect(sourceStateCalls).toBe(1);
    expect(started.sourceState).toEqual(SOURCE_STATE);
    expect(inspected.sourceState).toEqual(SOURCE_STATE);
    expect(stopped.sourceState).toEqual(SOURCE_STATE);
  });

  it("does not launch a preview when source-state capture fails", async () => {
    const processCalls: unknown[] = [];
    const manager = new PreviewManager(processFixture(processCalls), {
      idFactory: () => PREVIEW_ID,
      sourceState: {
        async resolve() {
          throw new Error("source-state unavailable");
        }
      },
      probe: { inspect: async () => ({ reachable: false, httpStatus: null }) },
      sleep: async () => undefined
    });

    await expect(
      manager.start({
        workspaceId: "ws_preview",
        logicalExecutable: "node",
        argv: ["server.mjs"],
        port: 3000,
        waitMs: 0
      })
    ).rejects.toThrow("source-state unavailable");
    expect(processCalls).toEqual([]);
  });

  it("starts a background process and binds it to a fixed loopback preview", async () => {
    const processCalls: unknown[] = [];
    const probeCalls: unknown[] = [];
    const manager = new PreviewManager(processFixture(processCalls), {
      idFactory: () => PREVIEW_ID,
      sourceState: SOURCE_STATE_ADAPTER,
      probe: {
        async inspect(input) {
          probeCalls.push(input);
          return { reachable: true, httpStatus: 204 };
        }
      },
      sleep: async () => undefined
    });

    const result = await manager.start({
      workspaceId: "ws_preview",
      logicalExecutable: "pnpm",
      argv: ["dev", "--host", "127.0.0.1", "--port", "4173"],
      cwd: "apps/web",
      env: { NODE_ENV: "development" },
      port: 4173,
      requestPath: "/health",
      waitMs: 0
    });

    expect(processCalls).toEqual([
      [
        "run",
        {
          workspaceId: "ws_preview",
          logicalExecutable: "pnpm",
          argv: ["dev", "--host", "127.0.0.1", "--port", "4173"],
          cwd: "apps/web",
          env: { NODE_ENV: "development" },
          background: true
        }
      ]
    ]);
    expect(probeCalls).toEqual([{ port: 4173, requestPath: "/health" }]);
    expect(result).toEqual({
      schemaVersion: 1,
      previewId: PREVIEW_ID,
      operationId: "op_preview_fixture",
      url: "http://127.0.0.1:4173/health",
      processState: "running",
      reachable: true,
      httpStatus: 204,
      sourceState: SOURCE_STATE
    });
  });

  it("uses slash as the default request path", async () => {
    const probeCalls: unknown[] = [];
    const manager = new PreviewManager(processFixture(), {
      idFactory: () => PREVIEW_ID,
      sourceState: SOURCE_STATE_ADAPTER,
      probe: {
        async inspect(input) {
          probeCalls.push(input);
          return { reachable: false, httpStatus: null };
        }
      },
      sleep: async () => undefined
    });

    const result = await manager.start({
      workspaceId: "ws_preview",
      logicalExecutable: "node",
      argv: ["server.mjs"],
      port: 3000,
      waitMs: 0
    });

    expect(probeCalls).toEqual([{ port: 3000, requestPath: "/" }]);
    expect(result.url).toBe("http://127.0.0.1:3000/");
    expect(result.reachable).toBe(false);
  });

  it.each([1023, 65536, 3000.5, Number.NaN])("rejects invalid preview port %s", async (port) => {
    const manager = new PreviewManager(processFixture(), {
      idFactory: () => PREVIEW_ID,
      sourceState: SOURCE_STATE_ADAPTER,
      probe: { inspect: async () => ({ reachable: false, httpStatus: null }) },
      sleep: async () => undefined
    });

    await expect(
      manager.start({
        workspaceId: "ws_preview",
        logicalExecutable: "node",
        argv: ["server.mjs"],
        port
      })
    ).rejects.toThrow(RangeError);
  });

  it.each(["health", "//example.invalid", "/bad path", "/bad#fragment", "/bad\npath"]) (
    "rejects unsafe preview request path %j",
    async (requestPath) => {
      const manager = new PreviewManager(processFixture(), {
        idFactory: () => PREVIEW_ID,
        sourceState: SOURCE_STATE_ADAPTER,
        probe: { inspect: async () => ({ reachable: false, httpStatus: null }) },
        sleep: async () => undefined
      });

      await expect(
        manager.start({
          workspaceId: "ws_preview",
          logicalExecutable: "node",
          argv: ["server.mjs"],
          port: 3000,
          requestPath
        })
      ).rejects.toThrow(TypeError);
    }
  );

  it("does not launch a preview when the requested loopback port is already in use", async () => {
    const processCalls: unknown[] = [];
    const manager = new PreviewManager(processFixture(processCalls), {
      idFactory: () => PREVIEW_ID,
      sourceState: SOURCE_STATE_ADAPTER,
      probe: {
        portInUse: async () => true,
        inspect: async () => ({ reachable: false, httpStatus: null })
      },
      sleep: async () => undefined
    });

    await expect(
      manager.start({
        workspaceId: "ws_preview",
        logicalExecutable: "node",
        argv: ["server.mjs"],
        port: 3000,
        waitMs: 0
      })
    ).rejects.toMatchObject({ code: "PREVIEW_ENDPOINT_IN_USE" });
    expect(processCalls).toEqual([]);
  });

  it("waits within the bounded readiness budget until the preview becomes reachable", async () => {
    const probes = [
      { reachable: false, httpStatus: null },
      { reachable: false, httpStatus: null },
      { reachable: true, httpStatus: 200 }
    ];
    const sleeps: number[] = [];
    const statusCalls: unknown[] = [];
    const process = {
      ...processFixture(),
      async status(workspaceId: string, operationId: string) {
        statusCalls.push([workspaceId, operationId]);
        return RUNNING;
      }
    };
    const manager = new PreviewManager(process, {
      idFactory: () => PREVIEW_ID,
      sourceState: SOURCE_STATE_ADAPTER,
      probe: { inspect: async () => probes.shift() ?? { reachable: false, httpStatus: null } },
      sleep: async (ms) => {
        sleeps.push(ms);
      }
    });

    const result = await manager.start({
      workspaceId: "ws_preview",
      logicalExecutable: "node",
      argv: ["server.mjs"],
      port: 3000,
      waitMs: 200
    });

    expect(result.reachable).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(sleeps).toEqual([100, 100]);
    expect(statusCalls).toHaveLength(2);
  });

  it("stops readiness probing when the process becomes terminal", async () => {
    const probeCalls: unknown[] = [];
    let statusCalls = 0;
    const process = {
      ...processFixture(),
      async status() {
        statusCalls += 1;
        return { ...RUNNING, state: "failed" as const, exitCode: 1 };
      }
    };
    const manager = new PreviewManager(process, {
      idFactory: () => PREVIEW_ID,
      sourceState: SOURCE_STATE_ADAPTER,
      probe: {
        async inspect(input) {
          probeCalls.push(input);
          return { reachable: false, httpStatus: null };
        }
      },
      sleep: async () => undefined
    });

    const result = await manager.start({
      workspaceId: "ws_preview",
      logicalExecutable: "node",
      argv: ["server.mjs"],
      port: 3000,
      waitMs: 500
    });

    expect(statusCalls).toBe(1);
    expect(probeCalls).toHaveLength(1);
    expect(result.processState).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.reachable).toBe(false);
  });

  it("inspects only the endpoint already bound to the preview and hides workspace ownership", async () => {
    const calls: unknown[] = [];
    const process = processFixture(calls);
    const probeCalls: unknown[] = [];
    const manager = new PreviewManager(process, {
      idFactory: () => PREVIEW_ID,
      sourceState: SOURCE_STATE_ADAPTER,
      probe: {
        async inspect(input) {
          probeCalls.push(input);
          return { reachable: false, httpStatus: null };
        }
      },
      sleep: async () => undefined
    });
    await manager.start({
      workspaceId: "ws_preview",
      logicalExecutable: "node",
      argv: ["server.mjs"],
      port: 4173,
      requestPath: "/ready",
      waitMs: 0
    });
    probeCalls.length = 0;

    const inspected = await manager.inspect({ workspaceId: "ws_preview", previewId: PREVIEW_ID });

    expect(inspected.previewId).toBe(PREVIEW_ID);
    expect(probeCalls).toEqual([{ port: 4173, requestPath: "/ready" }]);
    await expect(
      manager.inspect({ workspaceId: "ws_other", previewId: PREVIEW_ID })
    ).rejects.toMatchObject({ code: "PREVIEW_NOT_FOUND" });
    await expect(
      manager.inspect({
        workspaceId: "ws_preview",
        previewId: "pv_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      })
    ).rejects.toMatchObject({ code: "PREVIEW_NOT_FOUND" });
  });

  it("stops a running preview through process cancellation and removes its registry record", async () => {
    const calls: unknown[] = [];
    const manager = new PreviewManager(processFixture(calls), {
      idFactory: () => PREVIEW_ID,
      sourceState: SOURCE_STATE_ADAPTER,
      probe: { inspect: async () => ({ reachable: false, httpStatus: null }) },
      sleep: async () => undefined
    });
    await manager.start({
      workspaceId: "ws_preview",
      logicalExecutable: "node",
      argv: ["server.mjs"],
      port: 3000,
      waitMs: 0
    });
    calls.length = 0;

    const stopped = await manager.stop({ workspaceId: "ws_preview", previewId: PREVIEW_ID });

    expect(calls).toEqual([
      ["status", "ws_preview", "op_preview_fixture"],
      ["cancel", "ws_preview", "op_preview_fixture"]
    ]);
    expect(stopped.processState).toBe("cancelled");
    expect(stopped.reachable).toBe(false);
    expect(stopped.httpStatus).toBeNull();
    await expect(
      manager.inspect({ workspaceId: "ws_preview", previewId: PREVIEW_ID })
    ).rejects.toMatchObject({ code: "PREVIEW_NOT_FOUND" });
  });

  it("does not cancel an already-terminal preview when stopping it", async () => {
    const calls: unknown[] = [];
    const process = {
      ...processFixture(calls),
      async status(workspaceId: string, operationId: string) {
        calls.push(["status", workspaceId, operationId]);
        return { ...RUNNING, state: "completed" as const, exitCode: 0 };
      }
    };
    const manager = new PreviewManager(process, {
      idFactory: () => PREVIEW_ID,
      sourceState: SOURCE_STATE_ADAPTER,
      probe: { inspect: async () => ({ reachable: false, httpStatus: null }) },
      sleep: async () => undefined
    });
    await manager.start({
      workspaceId: "ws_preview",
      logicalExecutable: "node",
      argv: ["server.mjs"],
      port: 3000,
      waitMs: 0
    });
    calls.length = 0;

    const stopped = await manager.stop({ workspaceId: "ws_preview", previewId: PREVIEW_ID });

    expect(calls).toEqual([["status", "ws_preview", "op_preview_fixture"]]);
    expect(stopped.processState).toBe("completed");
    expect(stopped.exitCode).toBe(0);
  });

  it("releases preview registry records when the owning workspace closes", async () => {
    let id = 0;
    const manager = new PreviewManager(processFixture(), {
      idFactory: () => `pv_${(id++).toString(16).padStart(32, "0")}`,
      sourceState: SOURCE_STATE_ADAPTER,
      probe: { inspect: async () => ({ reachable: false, httpStatus: null }) },
      sleep: async () => undefined
    });
    const first = await manager.start({
      workspaceId: "ws_first",
      logicalExecutable: "node",
      argv: ["server.mjs"],
      port: 3000,
      waitMs: 0
    });
    const second = await manager.start({
      workspaceId: "ws_second",
      logicalExecutable: "node",
      argv: ["server.mjs"],
      port: 3001,
      waitMs: 0
    });

    manager.releaseWorkspace("ws_first");

    await expect(
      manager.inspect({ workspaceId: "ws_first", previewId: first.previewId })
    ).rejects.toMatchObject({ code: "PREVIEW_NOT_FOUND" });
    await expect(
      manager.inspect({ workspaceId: "ws_second", previewId: second.previewId })
    ).resolves.toMatchObject({ previewId: second.previewId });
  });

  it("keeps the 32-session bound under concurrent starts", async () => {
    let runCount = 0;
    let releasePending!: (value: WorkspaceProcessOperationResult) => void;
    const process = {
      async run(_input: WorkspaceProcessRunInput) {
        const operationId = `op_preview_${runCount}`;
        runCount += 1;
        if (runCount === 32) {
          return new Promise<WorkspaceProcessOperationResult>((resolve) => {
            releasePending = resolve;
          });
        }
        return { ...RUNNING, operationId };
      },
      async status(_workspaceId: string, operationId: string) {
        return { ...RUNNING, operationId };
      },
      async cancel(_workspaceId: string, operationId: string) {
        return { ...RUNNING, operationId, state: "cancelled" as const };
      }
    };
    let id = 0;
    const manager = new PreviewManager(process, {
      idFactory: () => `pv_${(id++).toString(16).padStart(32, "0")}`,
      sourceState: SOURCE_STATE_ADAPTER,
      probe: { inspect: async () => ({ reachable: false, httpStatus: null }) },
      sleep: async () => undefined
    });
    for (let index = 0; index < 31; index += 1) {
      await manager.start({
        workspaceId: "ws_preview",
        logicalExecutable: "node",
        argv: ["server.mjs"],
        port: 3000 + index,
        waitMs: 0
      });
    }

    const pending = manager.start({
      workspaceId: "ws_preview",
      logicalExecutable: "node",
      argv: ["server.mjs"],
      port: 4000,
      waitMs: 0
    });
    await Promise.resolve();
    await Promise.resolve();

    await expect(
      manager.start({
        workspaceId: "ws_preview",
        logicalExecutable: "node",
        argv: ["server.mjs"],
        port: 4001,
        waitMs: 0
      })
    ).rejects.toMatchObject({ code: "PREVIEW_LIMIT_REACHED" });
    expect(runCount).toBe(32);

    releasePending({ ...RUNNING, operationId: "op_preview_31" });
    await expect(pending).resolves.toMatchObject({ processState: "running" });
  });

  it("prunes terminal sessions at capacity before rejecting a new preview", async () => {
    let next = 0;
    const process = {
      async run(_input: WorkspaceProcessRunInput) {
        const operationId = `op_preview_${next++}`;
        return { ...RUNNING, operationId };
      },
      async status(_workspaceId: string, operationId: string) {
        return operationId === "op_preview_0"
          ? { ...RUNNING, operationId, state: "completed" as const, exitCode: 0 }
          : { ...RUNNING, operationId };
      },
      async cancel(_workspaceId: string, operationId: string) {
        return { ...RUNNING, operationId, state: "cancelled" as const };
      }
    };
    let id = 0;
    const manager = new PreviewManager(process, {
      idFactory: () => `pv_${(id++).toString(16).padStart(32, "0")}`,
      sourceState: SOURCE_STATE_ADAPTER,
      probe: { inspect: async () => ({ reachable: false, httpStatus: null }) },
      sleep: async () => undefined
    });

    for (let index = 0; index < 32; index += 1) {
      await manager.start({
        workspaceId: "ws_preview",
        logicalExecutable: "node",
        argv: ["server.mjs"],
        port: 3000 + index,
        waitMs: 0
      });
    }

    const result = await manager.start({
      workspaceId: "ws_preview",
      logicalExecutable: "node",
      argv: ["server.mjs"],
      port: 4000,
      waitMs: 0
    });

    expect(result.previewId).toBe("pv_00000000000000000000000000000020");
  });

  it("rejects a new preview when the bounded registry remains full", async () => {
    let next = 0;
    const process = {
      async run(_input: WorkspaceProcessRunInput) {
        return { ...RUNNING, operationId: `op_preview_${next++}` };
      },
      async status(_workspaceId: string, operationId: string) {
        return { ...RUNNING, operationId };
      },
      async cancel(_workspaceId: string, operationId: string) {
        return { ...RUNNING, operationId, state: "cancelled" as const };
      }
    };
    let id = 0;
    const manager = new PreviewManager(process, {
      idFactory: () => `pv_${(id++).toString(16).padStart(32, "0")}`,
      sourceState: SOURCE_STATE_ADAPTER,
      probe: { inspect: async () => ({ reachable: false, httpStatus: null }) },
      sleep: async () => undefined
    });

    for (let index = 0; index < 32; index += 1) {
      await manager.start({
        workspaceId: "ws_preview",
        logicalExecutable: "node",
        argv: ["server.mjs"],
        port: 3000 + index,
        waitMs: 0
      });
    }

    await expect(
      manager.start({
        workspaceId: "ws_preview",
        logicalExecutable: "node",
        argv: ["server.mjs"],
        port: 4000,
        waitMs: 0
      })
    ).rejects.toMatchObject({ code: "PREVIEW_LIMIT_REACHED" });
  });

  it("probes only fixed loopback with HEAD and does not follow redirects", async () => {
    let method = "";
    let path = "";
    const server = createServer((request, response) => {
      method = request.method ?? "";
      path = request.url ?? "";
      response.statusCode = 302;
      response.setHeader("location", "http://example.com/should-not-be-followed");
      response.end("ignored-body");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing test port");
    const port = address.port;
    const probe = new NodeLoopbackPreviewProbe();

    try {
      await expect(probe.portInUse(port)).resolves.toBe(true);
      const result = await probe.inspect({ port, requestPath: "/redirect" });
      expect(result).toEqual({ reachable: true, httpStatus: 302 });
      expect(method).toBe("HEAD");
      expect(path).toBe("/redirect");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      );
    }

    await expect(probe.portInUse(port)).resolves.toBe(false);
    await expect(probe.inspect({ port, requestPath: "/redirect" })).resolves.toEqual({
      reachable: false,
      httpStatus: null
    });
  });
});
