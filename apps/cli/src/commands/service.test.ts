import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ServiceMetadataStore, type ServiceReleaseRecord } from "../service/metadata.js";
import type { SystemdUserManager } from "../service/systemd.js";
import {
  installService,
  parseServiceArguments,
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

async function serviceFixture(): Promise<{
  stateRoot: string;
  serviceDataRoot: string;
  unitPath: string;
  metadataStore: ServiceMetadataStore;
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
    manager,
    serviceDataRoot,
    unitPath,
    prepareRelease: async () => release
  };
  return {
    stateRoot,
    serviceDataRoot,
    unitPath,
    metadataStore,
    release,
    managerCalls,
    dependencies
  };
}
