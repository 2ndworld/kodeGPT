import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  RemoteCiCredentialCommandInput,
  RemoteCiCredentialCommandResult,
  RemoteCiCredentialCommandRunner
} from "../adapters.js";
import {
  GitHubGhCredentialProvider,
  NodeRemoteCiCredentialCommandRunner
} from "./credential-provider.js";

const FAKE_CREDENTIAL = "[REDACTED_SECRET]";

class FakeRunner implements RemoteCiCredentialCommandRunner {
  calls: RemoteCiCredentialCommandInput[] = [];
  result: RemoteCiCredentialCommandResult = {
    exitCode: 0,
    stdout: `${FAKE_CREDENTIAL}\n`,
    stderr: "",
    stdoutOverflow: false,
    stderrOverflow: false,
    timedOut: false
  };

  async run(input: RemoteCiCredentialCommandInput): Promise<RemoteCiCredentialCommandResult> {
    this.calls.push(input);
    return this.result;
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kodegpt-ci-credential-"));
  const workspace = join(root, "workspace");
  const bin = join(root, "bin");
  await mkdir(workspace);
  await mkdir(bin);
  const executable = join(bin, "gh");
  await writeFile(executable, "fixture\n");
  await chmod(executable, 0o755);
  const runner = new FakeRunner();
  const provider = new GitHubGhCredentialProvider({
    runner,
    environment: {
      PATH: bin,
      HOME: root
    }
  });
  return { root, workspace, bin, executable, runner, provider };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ name: "CapabilityError", code });
}

describe("NodeRemoteCiCredentialCommandRunner", () => {
  it("bounds subprocess output without using a shell", async () => {
    const runner = new NodeRemoteCiCredentialCommandRunner();
    const result = await runner.run({
      executable: process.execPath,
      argv: ["-e", "process.stdout.write('x'.repeat(1024))"],
      env: { HOME: tmpdir(), PATH: "/usr/local/bin:/usr/bin:/bin" },
      timeoutMs: 1_000,
      maxStdoutBytes: 64,
      maxStderrBytes: 64
    });
    expect(result.stdoutOverflow).toBe(true);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(64);
  });

  it("kills subprocesses that exceed the fixed timeout", async () => {
    const runner = new NodeRemoteCiCredentialCommandRunner();
    const result = await runner.run({
      executable: process.execPath,
      argv: ["-e", "setTimeout(() => {}, 10_000)"],
      env: { HOME: tmpdir(), PATH: "/usr/local/bin:/usr/bin:/bin" },
      timeoutMs: 25,
      maxStdoutBytes: 64,
      maxStderrBytes: 64
    });
    expect(result.timedOut).toBe(true);
  });
});

describe("GitHubGhCredentialProvider", () => {
  it("invokes only the fixed gh auth token command using an absolute executable", async () => {
    const value = await fixture();
    try {
      await expect(value.provider.getCredential({ workspaceRoot: value.workspace })).resolves.toEqual({
        source: "gh",
        token: FAKE_CREDENTIAL
      });
      expect(value.runner.calls).toHaveLength(1);
      expect(value.runner.calls[0]).toMatchObject({
        executable: value.executable,
        argv: ["auth", "token", "--hostname", "github.com"],
        timeoutMs: 5_000,
        maxStdoutBytes: 16 * 1024,
        maxStderrBytes: 16 * 1024
      });
      expect(value.runner.calls[0]?.env).toEqual({
        HOME: value.root,
        PATH: "/usr/local/bin:/usr/bin:/bin"
      });
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it("returns CI_AUTH_REQUIRED when gh is absent or not logged in", async () => {
    const value = await fixture();
    try {
      const absent = new GitHubGhCredentialProvider({
        runner: value.runner,
        environment: { PATH: join(value.root, "missing"), HOME: value.root }
      });
      await expectCode(absent.getCredential({ workspaceRoot: value.workspace }), "CI_AUTH_REQUIRED");

      value.runner.result = {
        ...value.runner.result,
        exitCode: 1,
        stdout: "",
        stderr: "login required"
      };
      await expectCode(value.provider.getCredential({ workspaceRoot: value.workspace }), "CI_AUTH_REQUIRED");
      await expect(value.provider.getCredential({ workspaceRoot: value.workspace })).rejects.not.toThrow(/login required/);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it("fails closed on bounded-output, timeout, and malformed credential failures", async () => {
    const value = await fixture();
    try {
      value.runner.result = { ...value.runner.result, stdoutOverflow: true };
      await expectCode(value.provider.getCredential({ workspaceRoot: value.workspace }), "CI_AUTH_FAILED");

      value.runner.result = {
        ...value.runner.result,
        stdoutOverflow: false,
        timedOut: true
      };
      await expectCode(value.provider.getCredential({ workspaceRoot: value.workspace }), "CI_AUTH_FAILED");

      value.runner.result = {
        ...value.runner.result,
        timedOut: false,
        stdout: "line-one\nline-two\n"
      };
      await expectCode(value.provider.getCredential({ workspaceRoot: value.workspace }), "CI_AUTH_FAILED");

      value.runner.result = {
        ...value.runner.result,
        stdout: "\u0000invalid\n"
      };
      await expectCode(value.provider.getCredential({ workspaceRoot: value.workspace }), "CI_AUTH_FAILED");
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it("rejects a gh executable whose canonical path is inside the workspace", async () => {
    const value = await fixture();
    try {
      const workspaceBin = join(value.workspace, "bin");
      await mkdir(workspaceBin);
      const workspaceGh = join(workspaceBin, "gh");
      await writeFile(workspaceGh, "fixture\n");
      await chmod(workspaceGh, 0o755);
      const provider = new GitHubGhCredentialProvider({
        runner: value.runner,
        environment: { PATH: workspaceBin, HOME: value.root }
      });
      await expectCode(provider.getCredential({ workspaceRoot: value.workspace }), "CI_AUTH_FAILED");
      expect(value.runner.calls).toHaveLength(0);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });
});
