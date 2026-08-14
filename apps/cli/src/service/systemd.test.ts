import { describe, expect, it } from "vitest";

import type { ServiceReleaseRecord } from "./metadata.js";
import {
  buildServiceManagerEnvironment,
  createSystemdUserManager,
  renderKodegptUserUnit,
  type ServiceCommandRunner
} from "./systemd.js";

function release(overrides: Partial<ServiceReleaseRecord> = {}): ServiceReleaseRecord {
  const releaseId = `rel_${"a".repeat(32)}`;
  const releaseRoot = "/home/test user/.local/share/kodegpt/service/releases/release%25";
  return {
    releaseId,
    packageVersion: "0.1.0",
    runtimePackage: "@kodegpt/runtime-linux-x64",
    cliSha256: "1".repeat(64),
    runtimeSha256: "2".repeat(64),
    releaseRoot,
    cliPath: `${releaseRoot}/bin/kodegpt.mjs`,
    runtimePath: `${releaseRoot}/node_modules/@kodegpt/runtime-linux-x64/bin/kodegpt-runtime`,
    nodePath: "/opt/node 24/bin/node",
    zrokPath: "/opt/zrok%dev/bin/zrok2",
    reservedName: "public:kodegpt-dev",
    port: 43_121,
    ...overrides
  };
}

describe("systemd user service contract", () => {
  it("renders one secret-free bounded-restart foreground KodeGPT unit", () => {
    const unit = renderKodegptUserUnit(release(), "/home/test user/.kodegpt");

    expect(unit).toContain("Type=simple");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=5s");
    expect(unit).toContain("StartLimitIntervalSec=60");
    expect(unit).toContain("StartLimitBurst=5");
    expect(unit).toContain("KillSignal=SIGTERM");
    expect(unit).toContain("KillMode=mixed");
    expect(unit).not.toContain("KillMode=control-group");
    expect(unit).toContain("WorkingDirectory=/home/test\\x20user/.local/share/kodegpt/service/releases/release%%25");
    expect(unit).not.toContain('WorkingDirectory="');
    expect(unit).toContain("kodegpt.mjs\" \"service\" \"run\"");
    expect(unit).toContain("public:kodegpt-dev");
    expect(unit).toContain("43121");
    expect(unit).toContain("%25");
    expect(unit).toContain("%%dev");
    expect(unit).not.toContain("Restart=always");
    expect(unit).not.toContain(".worktrees");
    expect(unit).not.toContain("apps/cli");
    expect(unit).not.toContain("connector-token");
    expect(unit).not.toContain("connector-verifier");
    expect(unit).not.toContain("zrok-secret");
    expect(unit).not.toContain("bash");
    expect(unit).not.toContain("sh -c");
  });

  it("rejects line-breaking unit arguments instead of emitting a second directive", () => {
    expect(() =>
      renderKodegptUserUnit(release({ reservedName: "public:kodegpt-dev\nEnvironment=LEAK=1" }), "/home/test/.kodegpt")
    ).toThrow(/unsafe systemd unit argument/);
  });

  it("recovers a missing user-session bus environment from the current Linux uid", () => {
    expect(
      buildServiceManagerEnvironment(
        { HOME: "/home/test", PATH: "/usr/bin:/bin", USER: "test" },
        { uid: 1000, userBusAvailable: true }
      )
    ).toEqual({
      HOME: "/home/test",
      PATH: "/usr/bin:/bin",
      USER: "test",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus"
    });

    expect(
      buildServiceManagerEnvironment(
        {
          HOME: "/home/test",
          PATH: "/usr/bin:/bin",
          XDG_RUNTIME_DIR: "/custom/runtime",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/bus"
        },
        { uid: 1000, userBusAvailable: true }
      )
    ).toMatchObject({
      XDG_RUNTIME_DIR: "/custom/runtime",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/bus"
    });
  });

  it("uses direct argv for systemctl and normalizes show state", async () => {
    const calls: Array<{ executable: string; argv: string[] }> = [];
    const runner: ServiceCommandRunner = async (executable, argv) => {
      calls.push({ executable, argv });
      if (argv[1] === "show") {
        return {
          exitCode: 0,
          stdout: [
            "LoadState=loaded",
            "ActiveState=active",
            "SubState=running",
            "UnitFileState=enabled",
            "MainPID=4242",
            "Result=success"
          ].join("\n"),
          stderr: ""
        };
      }
      if (executable.endsWith("loginctl")) {
        return { exitCode: 0, stdout: "no\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const manager = createSystemdUserManager({
      systemctlPath: "/usr/bin/systemctl",
      loginctlPath: "/usr/bin/loginctl",
      userName: "test-user",
      runner
    });

    await manager.daemonReload();
    await manager.enable();
    await manager.start();
    await manager.stop();
    await manager.restart();
    await manager.resetFailed();
    expect(await manager.show()).toEqual({
      loadState: "loaded",
      activeState: "active",
      subState: "running",
      unitFileState: "enabled",
      mainPid: 4242,
      result: "success"
    });
    expect(await manager.linger()).toBe("disabled");

    expect(calls).toContainEqual({ executable: "/usr/bin/systemctl", argv: ["--user", "daemon-reload"] });
    expect(calls).toContainEqual({ executable: "/usr/bin/systemctl", argv: ["--user", "enable", "kodegpt.service"] });
    expect(calls).toContainEqual({ executable: "/usr/bin/systemctl", argv: ["--user", "start", "kodegpt.service"] });
    expect(calls).toContainEqual({ executable: "/usr/bin/loginctl", argv: ["show-user", "test-user", "-p", "Linger", "--value"] });
    expect(calls.every(({ argv }) => !argv.includes("sh") && !argv.includes("-c"))).toBe(true);
  });
});
