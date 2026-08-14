import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ServiceMetadataStore, type ServiceReleaseRecord } from "../service/metadata.js";
import {
  ServiceRuntimeStatusStore,
  type ServiceRuntimeStatusV1
} from "../service/runtime-status.js";
import type { SystemdUserManager } from "../service/systemd.js";
import {
  formatServiceStatus,
  getServiceStatus,
  installService,
  parseServiceArguments,
  restartService,
  runInstalledService,
  startService,
  stopService,
  uninstallService,
  type ServiceOperatorDependencies
} from "./service.js";

const serviceRoots: string[] = [];

afterEach(async () => {
  await Promise.all(serviceRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("service CLI contract", () => {
  it("parses install with the canonical state root and port defaults", () => {
    expect(
      parseServiceArguments(["install", "--name", "public:kodegpt-dev"], "/home/test")
    ).toEqual({
      command: "install",
      stateRoot: "/home/test/.kodegpt",
      name: "public:kodegpt-dev",
      port: 43_121
    });
  });

  it("parses status json without accepting install-only options", () => {
    expect(parseServiceArguments(["status", "--json"], "/home/test")).toEqual({
      command: "status",
      stateRoot: "/home/test/.kodegpt",
      json: true
    });
    expect(() =>
      parseServiceArguments(["status", "--name", "public:kodegpt-dev"], "/home/test")
    ).toThrow(/status accepts only --json and --state-root/);
  });

  it("requires a reserved zrok name for install and validates the existing name grammar", () => {
    expect(() => parseServiceArguments(["install"], "/home/test")).toThrow(/--name/);
    expect(() =>
      parseServiceArguments(["install", "--name", "public/not-valid"], "/home/test")
    ).toThrow(/invalid zrok reserved name selection/);
  });

  it("parses simple lifecycle commands with an optional state root", () => {
    for (const command of ["start", "stop", "restart", "uninstall"] as const) {
      expect(parseServiceArguments([command], "/home/test")).toEqual({
        command,
        stateRoot: "/home/test/.kodegpt"
      });
      expect(
        parseServiceArguments([command, "--state-root", "/tmp/kodegpt-state"], "/home/test")
      ).toEqual({ command, stateRoot: "/tmp/kodegpt-state" });
    }
  });

  it("parses the hidden systemd run entrypoint without exposing it in help", () => {
    expect(
      parseServiceArguments([
        "run",
        "--state-root",
        "/state",
        "--release-id",
        `rel_${"e".repeat(32)}`,
        "--name",
        "public:kodegpt-dev",
        "--port",
        "43121"
      ], "/home/test")
    ).toEqual({
      command: "run",
      stateRoot: "/state",
      releaseId: `rel_${"e".repeat(32)}`,
      name: "public:kodegpt-dev",
      port: 43_121
    });
  });

  it("rejects unknown service subcommands and duplicate options", () => {
    expect(() => parseServiceArguments([], "/home/test")).toThrow(/service requires/);
    expect(() => parseServiceArguments(["wat"], "/home/test")).toThrow(/unknown service command/);
    expect(() =>
      parseServiceArguments([
        "install",
        "--name",
        "public:kodegpt-dev",
        "--name",
        "public:kodegpt-other"
      ], "/home/test")
    ).toThrow(/--name may be specified only once/);
  });
});

describe("service install and uninstall orchestration", () => {
  it("stages and enables a release without starting or stopping the current service", async () => {
    const fixture = await serviceFixture();

    const output = await installService(
      {
        command: "install",
        stateRoot: fixture.stateRoot,
        name: "public:kodegpt-dev",
        port: 43_121
      },
      fixture.dependencies
    );

    const metadata = await fixture.metadataStore.read();
    expect(metadata.stagedReleaseId).toBe(fixture.release.releaseId);
    expect(metadata.activeReleaseId).toBeUndefined();
    expect(fixture.managerCalls).toEqual(["daemon-reload", "enable"]);
    expect(await readFile(fixture.unitPath, "utf8")).toContain(fixture.release.releaseId);
    expect((await stat(fixture.unitPath)).mode & 0o777).toBe(0o600);
    expect(output).toContain(`staged=${fixture.release.releaseId}`);
  });

  it("stages an upgrade without switching the loaded unit away from the active release", async () => {
    const fixture = await serviceFixture();
    await installService(
      {
        command: "install",
        stateRoot: fixture.stateRoot,
        name: "public:kodegpt-dev",
        port: 43_121
      },
      fixture.dependencies
    );
    await fixture.metadataStore.promoteStagedRelease();
    const activeUnit = await readFile(fixture.unitPath, "utf8");
    const releaseB = secondRelease(fixture.release);
    fixture.dependencies.prepareRelease = async () => releaseB;
    fixture.managerCalls.splice(0);

    await installService(
      {
        command: "install",
        stateRoot: fixture.stateRoot,
        name: "public:kodegpt-dev",
        port: 43_121
      },
      fixture.dependencies
    );

    const metadata = await fixture.metadataStore.read();
    expect(metadata.activeReleaseId).toBe(fixture.release.releaseId);
    expect(metadata.stagedReleaseId).toBe(releaseB.releaseId);
    expect(await readFile(fixture.unitPath, "utf8")).toBe(activeUnit);
    expect(activeUnit).toContain(fixture.release.releaseId);
    expect(activeUnit).not.toContain(releaseB.releaseId);
    expect(fixture.managerCalls).toEqual(["enable"]);
  });

  it("uninstalls only service-owned artifacts and preserves general state-root data", async () => {
    const fixture = await serviceFixture();
    const sentinel = join(fixture.stateRoot, "connector-credential.json");
    await writeFile(sentinel, "keep", "utf8");
    await installService(
      {
        command: "install",
        stateRoot: fixture.stateRoot,
        name: "public:kodegpt-dev",
        port: 43_121
      },
      fixture.dependencies
    );
    fixture.managerCalls.splice(0);

    const output = await uninstallService({ command: "uninstall", stateRoot: fixture.stateRoot }, fixture.dependencies);

    expect(fixture.managerCalls).toEqual(["stop", "disable", "daemon-reload"]);
    await expect(stat(fixture.unitPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.serviceDataRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.metadataStore.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep");
    expect(output).toBe("KodeGPT service uninstalled");
  });
});

describe("service start, stop, restart, and status", () => {
  it("promotes an initial staged release only after matching readiness", async () => {
    const fixture = await serviceFixture();
    await fixture.metadataStore.stageRelease(fixture.release);

    const output = await startService(
      { command: "start", stateRoot: fixture.stateRoot },
      fixture.dependencies
    );

    expect(fixture.managerCalls).toEqual([
      "reset-failed",
      "start",
      `wait:${fixture.release.releaseId}`
    ]);
    const metadata = await fixture.metadataStore.read();
    expect(metadata.activeReleaseId).toBe(fixture.release.releaseId);
    expect(metadata.stagedReleaseId).toBeUndefined();
    expect(output).toContain(`active=${fixture.release.releaseId}`);
  });

  it("activates a staged upgrade through start only at the explicit start boundary", async () => {
    const fixture = await serviceFixture();
    await installService(
      {
        command: "install",
        stateRoot: fixture.stateRoot,
        name: "public:kodegpt-dev",
        port: 43_121
      },
      fixture.dependencies
    );
    await fixture.metadataStore.promoteStagedRelease();
    const releaseB = secondRelease(fixture.release);
    fixture.dependencies.prepareRelease = async () => releaseB;
    await installService(
      {
        command: "install",
        stateRoot: fixture.stateRoot,
        name: "public:kodegpt-dev",
        port: 43_121
      },
      fixture.dependencies
    );
    expect(await readFile(fixture.unitPath, "utf8")).toContain(fixture.release.releaseId);
    fixture.managerCalls.splice(0);

    await startService({ command: "start", stateRoot: fixture.stateRoot }, fixture.dependencies);

    expect(fixture.managerCalls).toEqual([
      "daemon-reload",
      "reset-failed",
      "start",
      `wait:${releaseB.releaseId}`
    ]);
    expect(await readFile(fixture.unitPath, "utf8")).toContain(releaseB.releaseId);
    const metadata = await fixture.metadataStore.read();
    expect(metadata.activeReleaseId).toBe(releaseB.releaseId);
    expect(metadata.rollbackReleaseId).toBe(fixture.release.releaseId);
  });

  it("rolls back a staged start exactly once when candidate readiness fails", async () => {
    const fixture = await serviceFixture();
    await installService(
      {
        command: "install",
        stateRoot: fixture.stateRoot,
        name: "public:kodegpt-dev",
        port: 43_121
      },
      fixture.dependencies
    );
    await fixture.metadataStore.promoteStagedRelease();
    const releaseB = secondRelease(fixture.release);
    fixture.dependencies.prepareRelease = async () => releaseB;
    await installService(
      {
        command: "install",
        stateRoot: fixture.stateRoot,
        name: "public:kodegpt-dev",
        port: 43_121
      },
      fixture.dependencies
    );
    fixture.dependencies.waitForReady = async (releaseId) => {
      fixture.managerCalls.push(`wait:${releaseId}`);
      if (releaseId === releaseB.releaseId) throw new Error("staged start readiness failed");
      return readyFor(releaseId);
    };
    fixture.managerCalls.splice(0);

    await expect(
      startService({ command: "start", stateRoot: fixture.stateRoot }, fixture.dependencies)
    ).rejects.toThrow(/staged start readiness failed/);

    expect(fixture.managerCalls).toEqual([
      "daemon-reload",
      "reset-failed",
      "start",
      `wait:${releaseB.releaseId}`,
      "daemon-reload",
      "reset-failed",
      "restart",
      `wait:${fixture.release.releaseId}`
    ]);
    expect(await readFile(fixture.unitPath, "utf8")).toContain(fixture.release.releaseId);
    const metadata = await fixture.metadataStore.read();
    expect(metadata.activeReleaseId).toBe(fixture.release.releaseId);
    expect(metadata.stagedReleaseId).toBe(releaseB.releaseId);
  });

  it("stops through systemd without deleting general KodeGPT state", async () => {
    const fixture = await serviceFixture();
    const sentinel = join(fixture.stateRoot, "audit.jsonl");
    await writeFile(sentinel, "keep", "utf8");

    await expect(
      stopService({ command: "stop", stateRoot: fixture.stateRoot }, fixture.dependencies)
    ).resolves.toBe("KodeGPT service stopped");

    expect(fixture.managerCalls).toEqual(["stop"]);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep");
  });

  it("cuts over a staged release on restart and retains the previous release for rollback", async () => {
    const fixture = await serviceFixture();
    const releaseB = secondRelease(fixture.release);
    await fixture.metadataStore.stageRelease(fixture.release);
    await fixture.metadataStore.promoteStagedRelease();
    await fixture.metadataStore.stageRelease(releaseB);
    fixture.dependencies.waitForReady = async (releaseId) => {
      fixture.managerCalls.push(`wait:${releaseId}`);
      return readyFor(releaseId);
    };
    fixture.dependencies.cleanupReleases = async () => {
      fixture.managerCalls.push("cleanup");
    };

    const output = await restartService(
      { command: "restart", stateRoot: fixture.stateRoot },
      fixture.dependencies
    );

    expect(fixture.managerCalls).toEqual([
      "daemon-reload",
      "reset-failed",
      "restart",
      `wait:${releaseB.releaseId}`,
      "cleanup"
    ]);
    const metadata = await fixture.metadataStore.read();
    expect(metadata.activeReleaseId).toBe(releaseB.releaseId);
    expect(metadata.rollbackReleaseId).toBe(fixture.release.releaseId);
    expect(metadata.stagedReleaseId).toBeUndefined();
    expect(await readFile(fixture.unitPath, "utf8")).toContain(releaseB.releaseId);
    expect(output).toContain(`active=${releaseB.releaseId}`);
  });

  it("rolls back exactly once when a staged restart fails readiness", async () => {
    const fixture = await serviceFixture();
    const releaseB = secondRelease(fixture.release);
    await fixture.metadataStore.stageRelease(fixture.release);
    await fixture.metadataStore.promoteStagedRelease();
    await fixture.metadataStore.stageRelease(releaseB);
    fixture.dependencies.waitForReady = async (releaseId) => {
      fixture.managerCalls.push(`wait:${releaseId}`);
      if (releaseId === releaseB.releaseId) throw new Error("candidate readiness failed");
      return readyFor(releaseId);
    };

    await expect(
      restartService({ command: "restart", stateRoot: fixture.stateRoot }, fixture.dependencies)
    ).rejects.toThrow(/candidate readiness failed/);

    expect(fixture.managerCalls).toEqual([
      "daemon-reload",
      "reset-failed",
      "restart",
      `wait:${releaseB.releaseId}`,
      "daemon-reload",
      "reset-failed",
      "restart",
      `wait:${fixture.release.releaseId}`
    ]);
    const metadata = await fixture.metadataStore.read();
    expect(metadata.activeReleaseId).toBe(fixture.release.releaseId);
    expect(metadata.stagedReleaseId).toBe(releaseB.releaseId);
    expect(await readFile(fixture.unitPath, "utf8")).toContain(fixture.release.releaseId);
  });

  it("normalizes sanitized running status from manager, metadata, and runtime readiness", async () => {
    const fixture = await serviceFixture();
    await fixture.metadataStore.stageRelease(fixture.release);
    await fixture.metadataStore.promoteStagedRelease();
    await fixture.runtimeStatusStore.write(readyFor(fixture.release.releaseId));

    const status = await getServiceStatus(fixture.dependencies);

    expect(status).toMatchObject({
      installed: true,
      state: "running",
      enabled: true,
      packageVersion: "0.1.0",
      activeReleaseId: fixture.release.releaseId,
      runtimeVersion: "0.1",
      protocolVersion: "2026-07-28",
      surfaceVersion: "0.3",
      localPort: 43_121,
      managedExposure: true,
      reservedName: "public:kodegpt-dev",
      publicUrl: "https://kodegpt.example.invalid/mcp",
      linger: "disabled"
    });
    const human = formatServiceStatus(status, false);
    const json = formatServiceStatus(status, true);
    expect(human).toContain("state=running");
    expect(json).toContain('"surfaceVersion":"0.3"');
    for (const output of [human, json]) {
      expect(output).not.toContain("credential");
      expect(output).not.toContain("verifier");
      expect(output).not.toContain("rawZrok");
    }
  });
});

describe("installed service run entrypoint", () => {
  it("runs the exact installed release through existing managed zrok and writes sanitized readiness", async () => {
    const fixture = await serviceFixture();
    await fixture.metadataStore.stageRelease(fixture.release);
    const calls: Array<Record<string, unknown>> = [];
    let closed = 0;
    const never = new Promise<never>(() => undefined);

    const running = await runInstalledService(
      {
        command: "run",
        stateRoot: fixture.stateRoot,
        releaseId: fixture.release.releaseId,
        name: fixture.release.reservedName,
        port: fixture.release.port
      },
      {
        metadataStore: fixture.metadataStore,
        runtimeStatusStore: fixture.runtimeStatusStore,
        pid: 7788,
        exposeZrok: async (options) => {
          calls.push(options as unknown as Record<string, unknown>);
          return {
            status: {
              local: {
                host: "127.0.0.1",
                port: 43_121,
                protocolVersion: "2026-07-28",
                surfaceVersion: "0.3",
                runtimeVersion: "0.1",
                auditHealthy: true,
                filesystemBoundaryAvailable: true
              },
              publicUrl: "https://kodegpt.example.invalid/mcp",
              credentialCreated: false
            },
            termination: never,
            close: async () => {
              closed += 1;
            }
          };
        }
      }
    );

    expect(calls).toEqual([{
      runtimePath: fixture.release.runtimePath,
      stateRoot: fixture.stateRoot,
      name: fixture.release.reservedName,
      port: fixture.release.port,
      requireExistingConnectorCredential: true
    }]);
    expect(await fixture.runtimeStatusStore.read()).toEqual({
      schemaVersion: 1,
      releaseId: fixture.release.releaseId,
      pid: 7788,
      ready: true,
      localPort: 43_121,
      runtimeVersion: "0.1",
      protocolVersion: "2026-07-28",
      surfaceVersion: "0.3",
      reservedName: fixture.release.reservedName,
      publicUrl: "https://kodegpt.example.invalid/mcp"
    });

    await running.close();
    expect(closed).toBe(1);
    await expect(fixture.runtimeStatusStore.read()).resolves.toBeUndefined();
  });

  it("rejects unit arguments that do not match installed release metadata", async () => {
    const fixture = await serviceFixture();
    await fixture.metadataStore.stageRelease(fixture.release);

    await expect(
      runInstalledService(
        {
          command: "run",
          stateRoot: fixture.stateRoot,
          releaseId: fixture.release.releaseId,
          name: "public:other",
          port: fixture.release.port
        },
        {
          metadataStore: fixture.metadataStore,
          runtimeStatusStore: fixture.runtimeStatusStore,
          pid: 7788,
          exposeZrok: async () => {
            throw new Error("must not run");
          }
        }
      )
    ).rejects.toThrow(/service run arguments do not match installed release metadata/);
  });
});

async function serviceFixture(): Promise<{
  stateRoot: string;
  serviceDataRoot: string;
  unitPath: string;
  metadataStore: ServiceMetadataStore;
  runtimeStatusStore: ServiceRuntimeStatusStore;
  release: ServiceReleaseRecord;
  managerCalls: string[];
  dependencies: ServiceOperatorDependencies;
}> {
  const root = await mkdtemp(join(tmpdir(), "kodegpt-service-command-"));
  serviceRoots.push(root);
  const stateRoot = join(root, "state");
  const serviceDataRoot = join(root, "service-data");
  const unitPath = join(root, "systemd", "kodegpt.service");
  await mkdir(stateRoot, { recursive: true });
  await mkdir(serviceDataRoot, { recursive: true });
  await writeFile(join(serviceDataRoot, "owned.txt"), "service-owned", "utf8");
  const metadataStore = new ServiceMetadataStore(stateRoot);
  const runtimeStatusStore = new ServiceRuntimeStatusStore(stateRoot);
  const releaseId = `rel_${"c".repeat(32)}`;
  const releaseRoot = join(serviceDataRoot, "releases", releaseId);
  const release: ServiceReleaseRecord = {
    releaseId,
    packageVersion: "0.1.0",
    runtimePackage: "@kodegpt/runtime-linux-x64",
    cliSha256: "1".repeat(64),
    runtimeSha256: "2".repeat(64),
    releaseRoot,
    cliPath: join(releaseRoot, "bin", "kodegpt.mjs"),
    runtimePath: join(releaseRoot, "node_modules", "@kodegpt", "runtime-linux-x64", "bin", "kodegpt-runtime"),
    nodePath: "/usr/bin/node",
    zrokPath: "/usr/local/bin/zrok2",
    reservedName: "public:kodegpt-dev",
    port: 43_121
  };
  const managerCalls: string[] = [];
  const manager: SystemdUserManager = {
    daemonReload: async () => void managerCalls.push("daemon-reload"),
    enable: async () => void managerCalls.push("enable"),
    disable: async () => void managerCalls.push("disable"),
    start: async () => void managerCalls.push("start"),
    stop: async () => void managerCalls.push("stop"),
    restart: async () => void managerCalls.push("restart"),
    resetFailed: async () => void managerCalls.push("reset-failed"),
    show: async () => ({
      loadState: "loaded",
      activeState: "active",
      subState: "running",
      unitFileState: "enabled",
      mainPid: 99,
      result: "success"
    }),
    linger: async () => "disabled"
  };
  const dependencies: ServiceOperatorDependencies = {
    metadataStore,
    runtimeStatusStore,
    manager,
    serviceDataRoot,
    unitPath,
    prepareRelease: async () => release,
    waitForReady: async (releaseId) => {
      managerCalls.push(`wait:${releaseId}`);
      return readyFor(releaseId);
    }
  };
  return {
    stateRoot,
    serviceDataRoot,
    unitPath,
    metadataStore,
    runtimeStatusStore,
    release,
    managerCalls,
    dependencies
  };
}

function readyFor(releaseId: string): ServiceRuntimeStatusV1 {
  return {
    schemaVersion: 1,
    releaseId,
    pid: 99,
    ready: true,
    localPort: 43_121,
    runtimeVersion: "0.1",
    protocolVersion: "2026-07-28",
    surfaceVersion: "0.3",
    reservedName: "public:kodegpt-dev",
    publicUrl: "https://kodegpt.example.invalid/mcp"
  };
}

function secondRelease(first: ServiceReleaseRecord): ServiceReleaseRecord {
  const releaseId = `rel_${"d".repeat(32)}`;
  const releaseRoot = join(first.releaseRoot, "..", releaseId);
  return {
    ...first,
    releaseId,
    releaseRoot,
    cliPath: join(releaseRoot, "bin", "kodegpt.mjs"),
    runtimePath: join(releaseRoot, "node_modules", "@kodegpt", "runtime-linux-x64", "bin", "kodegpt-runtime"),
    cliSha256: "3".repeat(64),
    runtimeSha256: "4".repeat(64)
  };
}
