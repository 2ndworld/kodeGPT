import { createHash } from "node:crypto";

import { RuntimeUnavailableError } from "@kodegpt/core";
import { MCP_SURFACE_VERSION } from "@kodegpt/mcp-server";
import { describe, expect, it } from "vitest";

import {
  createProductionServiceStack,
  formatKodegptStartStatus,
  runStartCommand,
  startKodegpt,
  type StartDependencies
} from "./start.js";

function dependencies(
  events: string[],
  hello: {
    runtimeVersion: string;
    testMethods: boolean;
    auditHealthy: boolean;
    filesystemBoundaryAvailable: boolean;
  } = {
    runtimeVersion: "0.1.0",
    testMethods: false,
    auditHealthy: true,
    filesystemBoundaryAvailable: true
  }
): StartDependencies {
  const kernel = {
    request: async <T>(method: string) => {
      if (method === "provider.audit") {
        events.push("provider.audit");
        return { ok: true } as T;
      }
      return {} as T;
    },
    hello: async () => {
      events.push("kernel.hello");
      return hello;
    },
    stop: async () => {
      events.push("kernel.stop");
    }
  };
  const effectivePolicy = {
    name: "observe" as const,
    allowWrite: false,
    allowProcess: false,
    allowDynamicExecutables: false,
    network: "deny" as const,
    allowedExecutableNames: [],
    inheritEnv: false as const,
    envAllowlist: []
  };
  const readyWorkspace = {
    id: "ws_test",
    canonicalRoot: "/workspace",
    effectivePolicy
  };
  const artifact = {
    schemaVersion: 1 as const,
    uri: "artifact://ka_test" as const,
    mediaType: "application/vnd.kodegpt.execution-stream",
    sizeBytes: 0,
    sourceTruncated: false
  };
  const gitInspection = {
    schemaVersion: 1 as const,
    exitCode: 0,
    stdoutPreview: "",
    stderrPreview: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    sourceTruncated: false,
    bytesSpooled: 0,
    artifact
  };
  const completedProcess = {
    schemaVersion: 1 as const,
    operationId: "op_test",
    state: "completed" as const,
    exitCode: 0,
    stdoutPreview: "",
    stderrPreview: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    sourceTruncated: false,
    bytesSpooled: 0,
    artifact
  };
  const workspaceManager = {
    listWorkspaces: () => [],
    listTrustedWorkspaces: async () => [],
    trustWorkspace: async () => ({
      id: "trust_test",
      canonicalRoot: readyWorkspace.canonicalRoot,
      profileCeiling: "observe" as const,
      trustedAt: "2026-08-15T00:00:00.000Z"
    }),
    untrustWorkspace: async () => true,
    openWorkspace: async () => readyWorkspace,
    closeWorkspace: async () => undefined,
    requireReady: () => readyWorkspace,
    readFile: async () => ({ contents: "", bytesRead: 0, eof: true }),
    pathIdentity: async () => ({ schemaVersion: 1 as const, exists: false, hashTruncated: false }),
    commitPatchFile: async (input: { action: "create" | "update" | "delete"; content: string | null }) => ({
      schemaVersion: 1 as const,
      action: input.action,
      bytesWritten: input.content === null ? 0 : Buffer.byteLength(input.content),
      sha256: input.content === null ? null : "a".repeat(64)
    }),
    writeFile: async () => ({ bytesWritten: 0, created: true }),
    editFile: async () => ({ bytesWritten: 0, replacements: 0 }),
    gitStatus: async () => gitInspection,
    gitCheckpoint: async () => ({ schemaVersion: 1 as const, records: [], truncated: false }),
    gitCheckpointPatch: async () => gitInspection,
    gitLog: async () => ({ schemaVersion: 1 as const, resolvedOid: "1".repeat(40), commits: [], returnedCount: 0, truncated: false, truncationReasons: [] }),
    gitShow: async () => ({
      schemaVersion: 1 as const,
      commit: { oid: "1".repeat(40), shortOid: "1".repeat(12), parents: [], authorName: "A", authorTime: 1, committerTime: 1, subject: "s", body: "", messageTruncated: false, encodingLossy: false },
      changedPaths: [],
      summary: { filesChanged: 0, insertions: 0, deletions: 0, binaryFiles: 0 },
      patch: null,
      truncated: false,
      truncationReasons: []
    }),
    gitRange: async () => ({ schemaVersion: 1 as const, baseOid: "1".repeat(40), headOid: "2".repeat(40), isAncestor: false, mergeBaseOid: null, ahead: { value: 0, exact: true }, behind: { value: 0, exact: true }, commits: [], returnedCount: 0, truncated: false, truncationReasons: [] }),
    gitDiffHistory: async () => ({ schemaVersion: 1 as const, baseOid: "1".repeat(40), headOid: "2".repeat(40), changedPaths: [], summary: { filesChanged: 0, insertions: 0, deletions: 0, binaryFiles: 0 }, patch: "", truncated: false, truncationReasons: [] }),
    inspectGitRepositoryIdentity: async () => ({
      headOid: "a".repeat(40),
      branch: "main",
      remotes: [{ name: "origin", fetchUrl: "https://github.com/2ndworld/kodeGPT.git" }]
    }),
    auditRemoteCi: async () => undefined,
    gitDiff: async () => gitInspection,
    gitStage: async () => { throw new Error("unexpected gitStage"); },
    gitCommit: async () => { throw new Error("unexpected gitCommit"); },
    gitBranchCreate: async () => { throw new Error("unexpected gitBranchCreate"); },
    gitBranchSwitch: async () => { throw new Error("unexpected gitBranchSwitch"); },
    gitBranchDelete: async () => { throw new Error("unexpected gitBranchDelete"); },
    gitWorktreeCreate: async () => { throw new Error("unexpected gitWorktreeCreate"); },
    gitWorktreeRemove: async () => { throw new Error("unexpected gitWorktreeRemove"); },
    gitFetch: async () => { throw new Error("unexpected gitFetch"); },
    gitPull: async () => { throw new Error("unexpected gitPull"); },
    gitPush: async () => { throw new Error("unexpected gitPush"); },
    runProcess: async () => completedProcess,
    inspectExecutable: async () => ({
      schemaVersion: 1 as const,
      executableAvailable: true,
      sandboxAvailable: true
    }),
    runVerificationProcess: async () => completedProcess,
    processStatus: async () => completedProcess,
    processCancel: async () => ({ ...completedProcess, state: "cancelled" as const }),
    search: async () => [],
    searchBounded: async () => ({ matches: [], truncated: false, truncationReasons: [] }),
    tree: async () => [],
    treeBounded: async () => ({ entries: [], truncated: false })
  };

  return {
    prepareStateRoot: async () => {
      events.push("state-root");
    },
    prepareAudit: async () => {
      events.push("audit");
    },
    prepareConnectorAuth: async () => {
      events.push("connector-verifier");
      return { authenticate: async () => true };
    },
    prepareExtensionRegistry: async () => {
      events.push("extensions");
      return { listEnabled: () => [] };
    },
    startKernel: async () => {
      events.push("kernel.start");
      return kernel;
    },
    prepareSkillCatalog: async () => {
      events.push("skill.catalog");
      return {
        list: async () => ({
          schemaVersion: 1 as const,
          skills: [],
          truncated: false,
          truncationReasons: []
        }),
        inspect: async () => {
          throw new Error("not used");
        },
        load: async () => {
          throw new Error("not used");
        },
        close: async () => {
          events.push("skill.close");
        }
      };
    },
    createTrustProfile: () => {
      events.push("trust-profile");
      return {
        trust: {},
        inspectProfile: (name: "observe" | "develop" | "trusted") => ({ name })
      };
    },
    createManagers: () => {
      events.push("managers");
      return { workspaceManager };
    },
    createRemoteCi: () => ({
      repository: async () => { throw new Error("not used"); },
      status: async () => { throw new Error("not used"); },
      runs: async () => { throw new Error("not used"); },
      run: async () => { throw new Error("not used"); },
      failure: async () => { throw new Error("not used"); },
      rerun: async () => { throw new Error("not used"); },
      cancel: async () => { throw new Error("not used"); },
      dispatch: async () => { throw new Error("not used"); }
    }),
    createMcp: () => {
      events.push("mcp");
      return {
        handler: async () => undefined,
        close: async () => {
          events.push("mcp.close");
        }
      };
    },
    bindLoopback: async () => {
      events.push("bind");
      return {
        host: "127.0.0.1",
        port: 43121,
        close: async () => {
          events.push("bind.close");
        }
      };
    }
  };
}

describe("kodegpt start orchestration", () => {
  it("self-describes trusted execution features independently from workspace policy", async () => {
    const events: string[] = [];
    const stack = await createProductionServiceStack(
      { runtimePath: "/runtime", stateRoot: "/state" },
      dependencies(events)
    );
    try {
      const capabilities = await stack.toolContext.system.capabilities();
      expect(capabilities.execution).toEqual({
        processRun: true,
        explicitTrustedShell: true,
        dynamicExecutableResolution: true,
        developerEnvironmentRegistry: true,
        inheritsHostEnvironment: false
      });
      expect(capabilities.publicTools).toBeDefined();
    } finally {
      await stack.close();
    }
  });

  it("keeps Provider Gateway private and startup-idle while wiring only GitHub contexts", async () => {
    const events: string[] = [];
    const providerExecutions: Array<Record<string, unknown>> = [];
    const deps = dependencies(events);
    const originalCreateManagers = deps.createManagers;
    deps.createManagers = (options) => {
      const bundle = originalCreateManagers(options);
      const ready = bundle.workspaceManager.requireReady("ws_test");
      bundle.workspaceManager.listWorkspaces = () => [{
        ...ready,
        effectivePolicy: { ...ready.effectivePolicy, network: "unrestricted" as const }
      }];
      bundle.workspaceManager.inspectGitRepositoryIdentity = async () => ({
        headOid: "a".repeat(40),
        branch: "feat/typed-preview",
        remotes: [{ name: "origin", fetchUrl: "https://github.com/2ndworld/kodeGPT.git" }]
      });
      return bundle;
    };
    let providerInput: Parameters<NonNullable<StartDependencies["createProviderGateway"]>>[0] | undefined;
    deps.createProviderGateway = (input) => {
      events.push("provider-runtime");
      providerInput = input;
      return {
        operator: {
          list: async () => [
            {
              providerInstanceId: "prv_0123456789abcdef0123456789abcdef",
              adapterId: "github.read.v1",
              enabled: true
            },
            {
              providerInstanceId: "prv_abcdef0123456789abcdef0123456789",
              adapterId: "github.write.v1",
              enabled: true
            }
          ]
        },
        gateway: {
          execute: async (execution: Record<string, unknown>) => {
            providerExecutions.push(structuredClone(execution));
            return {
              semanticCapabilityId: execution.semanticCapabilityId,
              providerInstanceId: execution.providerInstanceId,
              value: execution.semanticCapabilityId === "github.pr.create"
                ? {
                    repository: "2ndworld/kodeGPT",
                    number: 23,
                    title: "feat: bounded write",
                    state: "open",
                    authorLogin: "2ndworld",
                    baseBranch: "main",
                    headBranch: "feat/bounded-write",
                    draft: false,
                    htmlUrl: "https://github.com/2ndworld/kodeGPT/pull/23",
                    createdAt: "2026-08-17T06:30:00Z",
                    updatedAt: "2026-08-17T06:30:00Z"
                  }
                : execution.semanticCapabilityId === "github.pr.merge"
                  ? {
                      repository: "2ndworld/kodeGPT",
                      number: 23,
                      merged: true,
                      mergeCommitOid: "b".repeat(40)
                    }
                  : {
                      repository: "2ndworld/kodeGPT",
                      name: "kodeGPT",
                      owner: "2ndworld",
                      description: "KodeGPT",
                      private: false,
                      defaultBranch: "main",
                      archived: false,
                      fork: false,
                      htmlUrl: "https://github.com/2ndworld/kodeGPT",
                      createdAt: "2026-08-01T00:00:00Z",
                      updatedAt: "2026-08-17T00:00:00Z",
                      pushedAt: "2026-08-17T00:00:00Z"
                    },
              truncated: false,
              truncationReasons: []
            };
          }
        },
        close: async () => {
          events.push("provider.close");
        }
      } as never;
    };

    const stack = await createProductionServiceStack(
      { runtimePath: "/runtime", stateRoot: "/state" },
      deps
    );
    try {
      expect(events).toContain("provider-runtime");
      expect(events).not.toContain("provider.audit");
      expect(providerExecutions).toEqual([]);
      expect(Object.keys(stack)).not.toContain("providerRuntime");
      expect(Object.keys(stack.toolContext)).not.toContain("provider");
      expect(Object.keys(stack.toolContext)).toContain("github");
      expect(providerInput!.manifests.map(({ adapterId }) => adapterId)).toEqual([
        "github.read.v1",
        "github.write.v1"
      ]);
      expect(providerInput!.workspaceRoots()).toEqual(["/workspace"]);
      await expect(providerInput!.workspaceAuthority.resolve("ws_test")).resolves.toEqual({
        workspaceId: "ws_test",
        network: "unrestricted"
      });
      await expect(stack.toolContext.github.repositoryInspect({ repository: "2ndworld/kodeGPT" })).resolves.toMatchObject({
        repository: "2ndworld/kodeGPT",
        defaultBranch: "main"
      });
      await expect(stack.toolContext.github.prCreate({
        repository: "2ndworld/kodeGPT",
        title: "feat: bounded write",
        headBranch: "feat/bounded-write",
        baseBranch: "main"
      })).resolves.toMatchObject({ repository: "2ndworld/kodeGPT", number: 23 });
      await expect(stack.toolContext.github.prMerge({
        repository: "2ndworld/kodeGPT",
        number: 23,
        expectedHeadOid: "a".repeat(40)
      })).resolves.toMatchObject({ repository: "2ndworld/kodeGPT", number: 23, merged: true });
      expect(providerExecutions).toEqual([
        {
          semanticCapabilityId: "github.repository.inspect",
          providerInstanceId: "prv_0123456789abcdef0123456789abcdef",
          input: { repository: "2ndworld/kodeGPT" }
        },
        {
          semanticCapabilityId: "github.pr.create",
          providerInstanceId: "prv_abcdef0123456789abcdef0123456789",
          input: {
            repository: "2ndworld/kodeGPT",
            title: "feat: bounded write",
            headBranch: "feat/bounded-write",
            baseBranch: "main"
          }
        },
        {
          semanticCapabilityId: "github.pr.merge",
          providerInstanceId: "prv_abcdef0123456789abcdef0123456789",
          input: {
            repository: "2ndworld/kodeGPT",
            number: 23,
            expectedHeadOid: "a".repeat(40)
          }
        }
      ]);
      await providerInput!.audit.record({
        operationId: "op_test",
        operation: "execute",
        phase: "decision",
        providerInstanceId: "prv_0123456789abcdef0123456789abcdef",
        adapterId: "test.fixture.read.v1",
        semanticCapabilityId: "test.fixture.record.read"
      });
      expect(events).toContain("provider.audit");
    } finally {
      await stack.close();
    }
    expect(events.slice(-3)).toEqual(["provider.close", "skill.close", "kernel.stop"]);
  });

  it("production-wires preview lifecycle through the existing execution manager", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const originalCreateManagers = deps.createManagers;
    const runInputs: unknown[] = [];
    deps.createManagers = (options) => {
      const managers = originalCreateManagers(options);
      const originalRun = managers.workspaceManager.runProcess;
      managers.workspaceManager.runProcess = async (input) => {
        runInputs.push(structuredClone(input));
        return originalRun(input);
      };
      return managers;
    };

    const stack = await createProductionServiceStack(
      { runtimePath: "/runtime", stateRoot: "/state" },
      deps
    );
    try {
      const result = await stack.toolContext.preview.start({
        workspaceId: "ws_test",
        logicalExecutable: "node",
        argv: ["server.mjs"],
        port: 3000,
        waitMs: 0
      });
      expect(runInputs).toEqual([
        {
          workspaceId: "ws_test",
          logicalExecutable: "node",
          argv: ["server.mjs"],
          background: true
        }
      ]);
      expect(result).toMatchObject({
        schemaVersion: 1,
        operationId: "op_test",
        url: "http://127.0.0.1:3000/",
        processState: "completed",
        exitCode: 0,
        reachable: false,
        httpStatus: null
      });
      expect(result.previewId).toMatch(/^pv_[a-f0-9]{32}$/);
      await stack.toolContext.workspace.close({ workspaceId: "ws_test" });
      await expect(
        stack.toolContext.preview.inspect({ workspaceId: "ws_test", previewId: result.previewId })
      ).rejects.toMatchObject({ code: "PREVIEW_NOT_FOUND" });
    } finally {
      await stack.close();
    }
  });

  it("production-wires visual verification through the existing preview browser manager", async () => {
    const events: string[] = [];
    const stack = await createProductionServiceStack(
      { runtimePath: "/runtime", stateRoot: "/state" },
      dependencies(events)
    );
    try {
      await expect(
        stack.toolContext.visual.captureMatrix({ workspaceId: "ws_test", previewId: "pv_missing" })
      ).rejects.toMatchObject({ code: "BROWSER_SESSION_NOT_FOUND" });
    } finally {
      await stack.close();
    }
  });

  it("production-wires Remote-CI without invoking provider work during startup", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    let remoteInvocations = 0;
    Object.assign(deps, {
      createRemoteCi: () => ({
        repository: async () => {
          remoteInvocations += 1;
          return {
            schemaVersion: 1 as const,
            workspaceId: "ws_test",
            provider: "github" as const,
            repository: { owner: "2ndworld", name: "kodeGPT", fullName: "2ndworld/kodeGPT" },
            selectedRemote: "origin",
            defaultBranch: "main",
            currentRevision: { oid: "a".repeat(40), branch: "main" },
            available: true,
            authState: "AVAILABLE" as const,
            credentialSource: "gh" as const,
            truncated: false,
            truncationReasons: []
          };
        },
        status: async () => { throw new Error("not used"); },
        runs: async () => { throw new Error("not used"); },
        run: async () => { throw new Error("not used"); },
        failure: async () => { throw new Error("not used"); }
      })
    });

    const stack = await createProductionServiceStack(
      { runtimePath: "/runtime", stateRoot: "/state" },
      deps
    );
    try {
      expect(remoteInvocations).toBe(0);
      const remoteCi = (stack as unknown as {
        remoteCi?: { repository(input: unknown): Promise<unknown> };
      }).remoteCi;
      expect(remoteCi).toBeDefined();
      await remoteCi!.repository({ workspaceId: "ws_test" });
      expect(remoteInvocations).toBe(1);
    } finally {
      await stack.close();
    }
  });

  it("starts in the locked fail-closed order and reports only safe status", async () => {
    const events: string[] = [];
    const started = await startKodegpt(
      { runtimePath: "/runtime", stateRoot: "/state", port: 43121 },
      dependencies(events)
    );

    expect(events).toEqual([
      "state-root",
      "audit",
      "connector-verifier",
      "extensions",
      "kernel.start",
      "kernel.hello",
      "skill.catalog",
      "trust-profile",
      "managers",
      "mcp",
      "bind"
    ]);
    expect(started.status).toEqual({
      host: "127.0.0.1",
      port: 43121,
      protocolVersion: "2026-07-28",
      surfaceVersion: MCP_SURFACE_VERSION,
      runtimeVersion: "0.1.0",
      auditHealthy: true,
      filesystemBoundaryAvailable: true
    });
    expect(JSON.stringify(started.status)).not.toMatch(/token|secret|verifier|kc_/i);

    await started.close();
    expect(events.slice(-4)).toEqual(["bind.close", "mcp.close", "skill.close", "kernel.stop"]);
  });

  it("terminates the foreground stack when the Rust runtime dies unexpectedly", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const originalStartKernel = deps.startKernel;
    let rejectRuntime!: (error: RuntimeUnavailableError) => void;
    deps.startKernel = async (options) => {
      const kernel = await originalStartKernel(options);
      const unexpectedTermination = new Promise<never>((_resolve, reject) => {
        rejectRuntime = reject;
      });
      void unexpectedTermination.catch(() => undefined);
      return { ...kernel, unexpectedTermination };
    };

    const started = await startKodegpt(
      { runtimePath: "/runtime", stateRoot: "/state", port: 43121 },
      deps
    );
    const failure = new RuntimeUnavailableError("runtime died in test");
    rejectRuntime(failure);

    await expect(started.termination!).rejects.toBe(failure);
    expect(events.slice(-4)).toEqual(["bind.close", "mcp.close", "skill.close", "kernel.stop"]);
  });

  it("production-wires git.changes through the existing workspace manager", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const originalCreateMcp = deps.createMcp;
    let toolContext: Parameters<StartDependencies["createMcp"]>[0]["toolContext"] | undefined;
    deps.createMcp = (options) => {
      toolContext = options.toolContext;
      return originalCreateMcp(options);
    };

    const started = await startKodegpt(
      { runtimePath: "/runtime", stateRoot: "/state", port: 43121 },
      deps
    );
    try {
      await expect(toolContext!.git.changes({ workspaceId: "ws_test" })).resolves.toMatchObject({
        schemaVersion: 1,
        workspaceId: "ws_test",
        clean: true,
        changedPaths: [],
        summary: { changedFiles: 0 },
        truncated: false,
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
      });
    } finally {
      await started.close();
    }
  });

  it("production-wires verification discovery through the existing workspace manager", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const originalCreateMcp = deps.createMcp;
    let toolContext: Parameters<StartDependencies["createMcp"]>[0]["toolContext"] | undefined;
    deps.createMcp = (options) => {
      toolContext = options.toolContext;
      return originalCreateMcp(options);
    };

    const started = await startKodegpt(
      { runtimePath: "/runtime", stateRoot: "/state", port: 43121 },
      deps
    );
    try {
      await expect(toolContext!.verify.list({ workspaceId: "ws_test" })).resolves.toEqual({
        schemaVersion: 1,
        workspaceId: "ws_test",
        recipes: []
      });
    } finally {
      await started.close();
    }
  });

  it("production-wires verification execution through the existing workspace manager", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const originalCreateManagers = deps.createManagers;
    const runInputs: unknown[] = [];
    deps.createManagers = (options) => {
      const managers = originalCreateManagers(options);
      const packageJson = JSON.stringify({
        packageManager: "pnpm@10.0.0",
        scripts: { test: "metadata only" }
      });
      Object.assign(managers.workspaceManager, {
        requireReady: () => ({
          id: "ws_test",
          canonicalRoot: "/workspace",
          effectivePolicy: {
            name: "trusted" as const,
            allowWrite: true,
            allowProcess: true,
            network: "unrestricted" as const,
            allowedExecutableNames: ["pnpm"],
            inheritEnv: false as const,
            envAllowlist: []
          }
        }),
        pathIdentity: async (_workspaceId: string, path: string) => ({
          schemaVersion: 1 as const,
          exists: path === "package.json" || path === "pnpm-lock.yaml",
          ...(path === "package.json" || path === "pnpm-lock.yaml"
            ? { kind: "file" as const, sizeBytes: 1 }
            : {}),
          hashTruncated: false
        }),
        treeBounded: async () => ({
          entries: [{ path: "package.json", kind: "file" as const }],
          truncated: false
        }),
        readFile: async () => ({ contents: packageJson, bytesRead: packageJson.length, eof: true }),
        inspectExecutable: async () => ({
          schemaVersion: 1 as const,
          executableAvailable: true,
          sandboxAvailable: true
        }),
        runVerificationProcess: async (input: unknown) => {
          runInputs.push(input);
          return {
            schemaVersion: 1 as const,
            operationId: "op_verify",
            state: "completed" as const,
            exitCode: 0,
            stdoutPreview: "verify-ok\n",
            stderrPreview: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            sourceTruncated: false,
            bytesSpooled: 10,
            artifact: {
              schemaVersion: 1 as const,
              uri: "artifact://ka_verify" as const,
              mediaType: "text/plain",
              sizeBytes: 10,
              sourceTruncated: false
            }
          };
        }
      });
      return managers;
    };

    const originalCreateMcp = deps.createMcp;
    let toolContext: Parameters<StartDependencies["createMcp"]>[0]["toolContext"] | undefined;
    deps.createMcp = (options) => {
      toolContext = options.toolContext;
      return originalCreateMcp(options);
    };

    const started = await startKodegpt(
      { runtimePath: "/runtime", stateRoot: "/state", port: 43121 },
      deps
    );
    try {
      const result = await toolContext!.verify.run({
        workspaceId: "ws_test",
        recipeId: "package:test",
        background: true
      });
      expect(runInputs).toEqual([
        {
          workspaceId: "ws_test",
          recipeId: "package:test",
          logicalExecutable: "pnpm",
          argv: ["run", "test"],
          cwd: ".",
          background: true
        }
      ]);
      expect(result).toMatchObject({
        schemaVersion: 1,
        workspaceId: "ws_test",
        recipe: { id: "package:test", allowed: true },
        operation: { operationId: "op_verify", state: "completed", exitCode: 0 }
      });
    } finally {
      await started.close();
    }
  });

  it("production-wires file.patch apply through the existing workspace manager commit authority", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const originalCreateManagers = deps.createManagers;
    const commitInputs: unknown[] = [];
    deps.createManagers = (options) => {
      const managers = originalCreateManagers(options);
      Object.assign(managers.workspaceManager, {
        pathIdentity: async () => ({
          schemaVersion: 1 as const,
          exists: true,
          kind: "file" as const,
          sizeBytes: 4,
          hashTruncated: false
        }),
        readFile: async () => ({ contents: "old\n", bytesRead: 4, eof: true }),
        commitPatchFile: async (input: { action: "create" | "update" | "delete"; content: string | null }) => {
          commitInputs.push(input);
          const sha256 =
            input.content === null
              ? null
              : createHash("sha256").update(input.content, "utf8").digest("hex");
          return {
            schemaVersion: 1 as const,
            action: input.action,
            bytesWritten: input.content === null ? 0 : Buffer.byteLength(input.content),
            sha256
          };
        }
      });
      return managers;
    };

    const originalCreateMcp = deps.createMcp;
    let toolContext: Parameters<StartDependencies["createMcp"]>[0]["toolContext"] | undefined;
    deps.createMcp = (options) => {
      toolContext = options.toolContext;
      return originalCreateMcp(options);
    };

    const started = await startKodegpt(
      { runtimePath: "/runtime", stateRoot: "/state", port: 43121 },
      deps
    );
    try {
      const result = await toolContext!.file.patch({
        workspaceId: "ws_test",
        patch: "--- a/target.txt\n+++ b/target.txt\n@@ -1 +1 @@\n-old\n+new\n",
        mode: "apply"
      });
      expect(commitInputs).toEqual([
        {
          workspaceId: "ws_test",
          path: "target.txt",
          action: "update",
          expectedSha256: createHash("sha256").update("old\n", "utf8").digest("hex"),
          content: "new\n"
        }
      ]);
      expect(result).toMatchObject({
        schemaVersion: 1,
        workspaceId: "ws_test",
        mode: "apply",
        committedPaths: ["target.txt"],
        files: [{ path: "target.txt", action: "update", committed: true }]
      });
    } finally {
      await started.close();
    }
  });

  it("production-wires context.build through the existing capability service and workspace manager", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const originalCreateManagers = deps.createManagers;
    deps.createManagers = (options) => {
      const managers = originalCreateManagers(options);
      Object.assign(managers.workspaceManager, {
        treeBounded: async () => ({ entries: [], truncated: false }),
        searchBounded: async () => ({ matches: [], truncated: false, truncationReasons: [] }),
        gitCheckpoint: async () => ({ schemaVersion: 1 as const, records: [], truncated: false }),
        pathIdentity: async () => ({ schemaVersion: 1 as const, exists: false, hashTruncated: false }),
        readFile: async (_workspaceId: string, path: string) => ({
          contents: path === "src/main.ts" ? "export const value = 1;\n" : "",
          bytesRead: path === "src/main.ts" ? 24 : 0,
          eof: true
        })
      });
      return managers;
    };

    const originalCreateMcp = deps.createMcp;
    let toolContext: Parameters<StartDependencies["createMcp"]>[0]["toolContext"] | undefined;
    deps.createMcp = (options) => {
      toolContext = options.toolContext;
      return originalCreateMcp(options);
    };

    const started = await startKodegpt(
      { runtimePath: "/runtime", stateRoot: "/state", port: 43121 },
      deps
    );
    try {
      const result = await toolContext!.context.build({
        workspaceId: "ws_test",
        intent: "understand",
        target: "src/main.ts",
        maxBytes: 64
      });
      expect(result).toMatchObject({
        schemaVersion: 1,
        intent: "understand",
        target: "src/main.ts",
        selectedFiles: [
          {
            path: "src/main.ts",
            reason: "exact-target",
            content: "export const value = 1;\n",
            truncated: false
          }
        ],
        totalBytes: 24,
        truncated: false
      });
    } finally {
      await started.close();
    }
  });

  it("rejects connector bootstrap unless it is paired with explicit public query compatibility", async () => {
    await expect(
      startKodegpt(
        {
          runtimePath: "/runtime",
          stateRoot: "/state",
          port: 43121,
          allowMissingConnectorCredential: true
        },
        dependencies([])
      )
    ).rejects.toThrow(/bootstrap/i);
  });

  it("keeps query credential compatibility disabled by default and programmatic-only", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    const originalCreateMcp = deps.createMcp;
    const captured: Array<Record<string, unknown>> = [];
    deps.createMcp = (options) => {
      captured.push(options as unknown as Record<string, unknown>);
      return originalCreateMcp(options);
    };

    const normal = await runStartCommand(
      ["--runtime", "/runtime", "--state-root", "/state", "--port", "43121"],
      deps
    );
    expect(captured.at(-1)?.queryCredentialCompatibility).toBe(false);
    await normal.close();

    const enabled = await startKodegpt(
      {
        runtimePath: "/runtime",
        stateRoot: "/state",
        port: 43121,
        queryCredentialCompatibility: true
      },
      deps
    );
    expect(captured.at(-1)?.queryCredentialCompatibility).toBe(true);
    expect(enabled.status.host).toBe("127.0.0.1");
    await enabled.close();
  });

  it("parses the start command module strictly and formats only safe status", async () => {
    const events: string[] = [];
    const started = await runStartCommand(
      ["--runtime", "/runtime", "--state-root", "/state", "--port", "43121"],
      dependencies(events)
    );
    const formatted = formatKodegptStartStatus(started.status);
    expect(formatted).toContain("http://127.0.0.1:43121");
    expect(formatted).toContain("protocol=2026-07-28");
    expect(formatted).not.toMatch(/token|secret|verifier|kc_/i);
    await started.close();

    await expect(runStartCommand([], dependencies([]))).rejects.toThrow(/--runtime/);
    await expect(
      runStartCommand(["--runtime", "/runtime", "--unknown", "x"], dependencies([]))
    ).rejects.toThrow(/Unknown start option/);
  });

  it.each([
    ["audit", { auditHealthy: false, filesystemBoundaryAvailable: true }],
    ["filesystem", { auditHealthy: true, filesystemBoundaryAvailable: false }]
  ])("fails closed when %s capability validation fails", async (_label, flags) => {
    const events: string[] = [];
    await expect(
      startKodegpt(
        { runtimePath: "/runtime", stateRoot: "/state", port: 43121 },
        dependencies(events, {
          runtimeVersion: "0.1.0",
          testMethods: false,
          ...flags
        })
      )
    ).rejects.toThrow(/unavailable|unhealthy/i);

    expect(events).toContain("kernel.stop");
    expect(events).not.toContain("trust-profile");
    expect(events).not.toContain("bind");
  });
});
