import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getServiceStatus,
  installService,
  restartService,
  startService,
  stopService,
  uninstallService,
  type ServiceOperatorDependencies
} from "../../apps/cli/src/commands/service.js";
import { ServiceMetadataStore, type ServiceReleaseRecord } from "../../apps/cli/src/service/metadata.js";
import { ServiceRuntimeStatusStore, type ServiceRuntimeStatusV1 } from "../../apps/cli/src/service/runtime-status.js";
import type { SystemdUserManager, UserServiceState } from "../../apps/cli/src/service/systemd.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI_ROOT = join(REPOSITORY_ROOT, "apps", "cli");
const CLI_PATH = join(CLI_ROOT, "bin", "kodegpt.mjs");
const RUNTIME_PATH = join(REPOSITORY_ROOT, "packages", "runtime-linux-x64", "bin", "kodegpt-runtime");
const roots: string[] = [];

beforeAll(() => {
  const build = spawnSync(process.execPath, [join(CLI_ROOT, "scripts", "build-cli.mjs")], {
    cwd: CLI_ROOT,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
  expect(build.error).toBeUndefined();
  expect(build.status, build.stderr).toBe(0);

  const runtime = spawnSync("test", ["-x", RUNTIME_PATH], { cwd: REPOSITORY_ROOT });
  if (runtime.status !== 0) {
    const cargo = spawnSync("cargo", ["build", "--release", "-p", "kodegpt-runtime"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024
    });
    expect(cargo.status, cargo.stderr).toBe(0);
    const stage = spawnSync(process.execPath, [join(REPOSITORY_ROOT, "scripts", "stage-runtime.mjs")], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    });
    expect(stage.status, stage.stderr).toBe(0);
  }
}, 120_000);

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("packaged CLI local service integration", () => {
  it("installs a worktree-independent staged release, reports sanitized status, and uninstalls safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "kodegpt-cli-service-"));
    roots.push(root);
    const home = join(root, "home");
    const stateRoot = join(root, "state");
    const fakeBin = join(root, "bin");
    const managerLog = join(root, "manager.log");
    await mkdir(home, { recursive: true });
    await mkdir(stateRoot, { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    const sentinel = join(stateRoot, "audit-sentinel.jsonl");
    await writeFile(sentinel, "keep", "utf8");
    await writeFakeSystemctl(join(fakeBin, "systemctl"), managerLog);
    await writeExecutable(
      join(fakeBin, "loginctl"),
      `#!/usr/bin/env node\nprocess.stdout.write("no\\n");\n`
    );
    await writeExecutable(join(fakeBin, "zrok2"), `#!/usr/bin/env node\nprocess.exit(0);\n`);

    const install = runCli(
      ["service", "install", "--name", "public:kodegpt-dev", "--state-root", stateRoot],
      home,
      fakeBin
    );
    expect(install.status, install.stderr).toBe(0);
    expect(install.stdout).toMatch(/staged=rel_[a-f0-9]{32}/);

    const unitPath = join(home, ".config", "systemd", "user", "kodegpt.service");
    const serviceDataRoot = join(home, ".local", "share", "kodegpt", "service");
    const metadata = JSON.parse(await readFile(join(stateRoot, "service.json"), "utf8")) as {
      stagedReleaseId: string;
      releases: Record<string, { releaseRoot: string; cliPath: string; runtimePath: string }>;
    };
    const staged = metadata.releases[metadata.stagedReleaseId];
    expect(staged).toBeDefined();
    expect(staged!.releaseRoot.startsWith(serviceDataRoot)).toBe(true);
    expect(staged!.releaseRoot).not.toContain(".worktrees");
    expect(staged!.cliPath).not.toContain(REPOSITORY_ROOT);
    expect(staged!.runtimePath).not.toContain(REPOSITORY_ROOT);
    await expect(access(staged!.cliPath)).resolves.toBeUndefined();
    await expect(access(staged!.runtimePath)).resolves.toBeUndefined();
    const unit = await readFile(unitPath, "utf8");
    expect(unit).toContain(staged!.cliPath.replaceAll("%", "%%"));
    expect(unit).not.toContain(REPOSITORY_ROOT);
    expect((await stat(unitPath)).mode & 0o777).toBe(0o600);

    const statusResult = runCli(
      ["service", "status", "--json", "--state-root", stateRoot],
      home,
      fakeBin
    );
    expect(statusResult.status, statusResult.stderr).toBe(0);
    const status = JSON.parse(statusResult.stdout) as Record<string, unknown>;
    expect(status).toMatchObject({
      installed: true,
      state: "stopped",
      enabled: true,
      stagedReleaseId: metadata.stagedReleaseId,
      listenerReady: false,
      managedExposure: true,
      reservedName: "public:kodegpt-dev",
      localPort: 43_121,
      linger: "disabled"
    });
    expect(status).not.toHaveProperty("stateRoot");
    expect(JSON.stringify(status)).not.toMatch(/connectorToken|connectorVerifier|credentialMaterial|rawZrok/i);

    const uninstall = runCli(
      ["service", "uninstall", "--state-root", stateRoot],
      home,
      fakeBin
    );
    expect(uninstall.status, uninstall.stderr).toBe(0);
    await expect(access(unitPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(serviceDataRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep");

    const calls = (await readFile(managerLog, "utf8")).trim().split("\n");
    expect(calls).toContain("--user daemon-reload");
    expect(calls).toContain("--user enable kodegpt.service");
    expect(calls).toContain("--user show kodegpt.service --property=LoadState --property=ActiveState --property=SubState --property=UnitFileState --property=MainPID --property=Result --no-pager");
    expect(calls).toContain("--user stop kodegpt.service");
    expect(calls).toContain("--user disable kodegpt.service");
  });

  it("runs the complete fake-manager lifecycle through staged cutover", async () => {
    const root = await mkdtemp(join(tmpdir(), "kodegpt-service-lifecycle-integration-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const serviceDataRoot = join(root, "service-data");
    const unitPath = join(root, "systemd", "kodegpt.service");
    await mkdir(stateRoot, { recursive: true });
    const metadataStore = new ServiceMetadataStore(stateRoot);
    const runtimeStatusStore = new ServiceRuntimeStatusStore(stateRoot);
    const releaseA = integrationRelease(serviceDataRoot, "a");
    const releaseB = integrationRelease(serviceDataRoot, "b");
    let prepared = releaseA;
    let managerState: UserServiceState = {
      loadState: "loaded",
      activeState: "inactive",
      subState: "dead",
      unitFileState: "enabled"
    };
    const calls: string[] = [];
    const manager: SystemdUserManager = {
      daemonReload: async () => void calls.push("daemon-reload"),
      enable: async () => void calls.push("enable"),
      disable: async () => void calls.push("disable"),
      resetFailed: async () => void calls.push("reset-failed"),
      start: async () => {
        calls.push("start");
        managerState = { ...managerState, activeState: "active", subState: "running", mainPid: 5001 };
      },
      restart: async () => {
        calls.push("restart");
        managerState = { ...managerState, activeState: "active", subState: "running", mainPid: 5002 };
      },
      stop: async () => {
        calls.push("stop");
        managerState = { ...managerState, activeState: "inactive", subState: "dead", mainPid: undefined };
      },
      show: async () => managerState,
      linger: async () => "disabled"
    };
    const dependencies: ServiceOperatorDependencies = {
      metadataStore,
      runtimeStatusStore,
      manager,
      serviceDataRoot,
      unitPath,
      prepareRelease: async () => prepared,
      waitForReady: async (releaseId) => {
        const ready: ServiceRuntimeStatusV1 = {
          schemaVersion: 1,
          releaseId,
          pid: managerState.mainPid!,
          ready: true,
          localPort: 43_121,
          runtimeVersion: "0.1",
          protocolVersion: "2026-07-28",
          surfaceVersion: "0.4",
          reservedName: "public:kodegpt-dev",
          publicUrl: "https://kodegpt.example.invalid/mcp"
        };
        await runtimeStatusStore.write(ready);
        return ready;
      }
    };

    await installService(
      { command: "install", stateRoot, name: "public:kodegpt-dev", port: 43_121 },
      dependencies
    );
    await startService({ command: "start", stateRoot }, dependencies);
    expect(await getServiceStatus(dependencies)).toMatchObject({
      state: "running",
      activeReleaseId: releaseA.releaseId,
      listenerReady: true
    });

    prepared = releaseB;
    calls.splice(0);
    await installService(
      { command: "install", stateRoot, name: "public:kodegpt-dev", port: 43_121 },
      dependencies
    );
    expect(calls).toEqual(["enable"]);
    expect(await readFile(unitPath, "utf8")).toContain(releaseA.releaseId);
    expect(await readFile(unitPath, "utf8")).not.toContain(releaseB.releaseId);
    calls.splice(0);
    await restartService({ command: "restart", stateRoot }, dependencies);
    expect((await metadataStore.read())).toMatchObject({
      activeReleaseId: releaseB.releaseId,
      rollbackReleaseId: releaseA.releaseId
    });
    expect(calls).toEqual(["daemon-reload", "reset-failed", "restart"]);

    await stopService({ command: "stop", stateRoot }, dependencies);
    expect((await getServiceStatus(dependencies)).state).toBe("stopped");
    await uninstallService({ command: "uninstall", stateRoot }, dependencies);
    await expect(access(unitPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(metadataStore.path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function integrationRelease(serviceDataRoot: string, marker: "a" | "b"): ServiceReleaseRecord {
  const releaseId = `rel_${marker.repeat(32)}`;
  const releaseRoot = join(serviceDataRoot, "releases", releaseId);
  return {
    releaseId,
    packageVersion: "0.1.0",
    runtimePackage: "@kodegpt/runtime-linux-x64",
    cliSha256: (marker === "a" ? "1" : "3").repeat(64),
    runtimeSha256: (marker === "a" ? "2" : "4").repeat(64),
    releaseRoot,
    cliPath: join(releaseRoot, "bin", "kodegpt.mjs"),
    runtimePath: join(releaseRoot, "node_modules", "@kodegpt", "runtime-linux-x64", "bin", "kodegpt-runtime"),
    nodePath: "/usr/bin/node",
    zrokPath: "/usr/local/bin/zrok2",
    reservedName: "public:kodegpt-dev",
    port: 43_121
  };
}

function runCli(args: string[], home: string, fakeBin: string) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: CLI_ROOT,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      HOME: home,
      USER: "kodegpt-test",
      LOGNAME: "kodegpt-test",
      PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      NODE_ENV: "test",
      KODEGPT_RUNTIME_PATH: RUNTIME_PATH
    }
  });
}

async function writeFakeSystemctl(path: string, logPath: string): Promise<void> {
  await writeExecutable(
    path,
    `#!/usr/bin/env node\n` +
      `const fs = require("node:fs");\n` +
      `const args = process.argv.slice(2);\n` +
      `fs.appendFileSync(${JSON.stringify(logPath)}, args.join(" ") + "\\n");\n` +
      `if (args[1] === "show") {\n` +
      `  process.stdout.write("LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nUnitFileState=enabled\\nMainPID=0\\nResult=success\\n");\n` +
      `}\n`
  );
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, "utf8");
  await chmod(path, 0o755);
}
