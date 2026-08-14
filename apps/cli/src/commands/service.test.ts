import { describe, expect, it } from "vitest";

import { parseServiceArguments } from "./service.js";

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
