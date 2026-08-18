import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative } from "node:path";

import type {
  RemoteCiCredentialCommandInput,
  RemoteCiCredentialCommandResult,
  RemoteCiCredentialCommandRunner
} from "../adapters.js";
import { CapabilityError } from "../errors.js";

const GH_COMMAND_TIMEOUT_MS = 5_000;
const GH_COMMAND_MAX_BYTES = 16 * 1024;
const CHILD_PATH = "/usr/local/bin:/usr/bin:/bin";

export interface GitHubCredential {
  source: "gh";
  token: string;
}

export interface GitHubCredentialProvider {
  getCredential(input: { workspaceRoot: string }): Promise<GitHubCredential>;
}

export class NodeRemoteCiCredentialCommandRunner implements RemoteCiCredentialCommandRunner {
  async run(input: RemoteCiCredentialCommandInput): Promise<RemoteCiCredentialCommandResult> {
    return await new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      let stdoutOverflow = false;
      let stderrOverflow = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const child = spawn(input.executable, [...input.argv], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: input.env.HOME ?? "/",
        env: { ...input.env }
      });

      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          stdoutOverflow,
          stderrOverflow,
          timedOut
        });
      };

      const append = (
        chunk: Buffer,
        limit: number,
        current: number,
        target: Buffer[]
      ): { bytes: number; overflow: boolean } => {
        const remaining = Math.max(0, limit - current);
        if (remaining > 0) target.push(chunk.subarray(0, remaining));
        return { bytes: current + chunk.length, overflow: chunk.length > remaining };
      };

      child.stdout.on("data", (value: Buffer) => {
        const next = append(value, input.maxStdoutBytes, stdoutBytes, stdoutChunks);
        stdoutBytes = next.bytes;
        if (next.overflow) {
          stdoutOverflow = true;
          child.kill("SIGKILL");
        }
      });
      child.stderr.on("data", (value: Buffer) => {
        const next = append(value, input.maxStderrBytes, stderrBytes, stderrChunks);
        stderrBytes = next.bytes;
        if (next.overflow) {
          stderrOverflow = true;
          child.kill("SIGKILL");
        }
      });
      child.once("error", () => finish(null));
      child.once("close", (code) => finish(code));

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, input.timeoutMs);
      timer.unref();
    });
  }
}

export class GitHubGhCredentialProvider implements GitHubCredentialProvider {
  readonly #runner: RemoteCiCredentialCommandRunner;
  readonly #environment: Readonly<Record<string, string | undefined>>;

  constructor(options?: {
    runner?: RemoteCiCredentialCommandRunner;
    environment?: Readonly<Record<string, string | undefined>>;
  }) {
    this.#runner = options?.runner ?? new NodeRemoteCiCredentialCommandRunner();
    this.#environment = options?.environment ?? process.env;
  }

  async getCredential(input: { workspaceRoot: string }): Promise<GitHubCredential> {
    const workspaceRoot = await canonicalPath(input.workspaceRoot, "CI_AUTH_FAILED");
    const executable = await this.#resolveGh(workspaceRoot);
    const result = await this.#runner.run({
      executable,
      argv: ["auth", "token", "--hostname", "github.com"],
      env: cleanChildEnvironment(this.#environment),
      timeoutMs: GH_COMMAND_TIMEOUT_MS,
      maxStdoutBytes: GH_COMMAND_MAX_BYTES,
      maxStderrBytes: GH_COMMAND_MAX_BYTES
    });

    if (
      result.timedOut ||
      result.stdoutOverflow ||
      result.stderrOverflow ||
      result.exitCode === null
    ) {
      throw new CapabilityError("CI_AUTH_FAILED", "GitHub credential bootstrap failed");
    }
    if (result.exitCode !== 0) {
      throw authenticationRequired("GitHub authentication is required");
    }

    const token = result.stdout.trim();
    if (token.length === 0) {
      throw authenticationRequired("GitHub authentication is required");
    }
    if (
      Buffer.byteLength(token, "utf8") > GH_COMMAND_MAX_BYTES ||
      token.includes("\u0000") ||
      token.includes("\n") ||
      token.includes("\r")
    ) {
      throw new CapabilityError("CI_AUTH_FAILED", "GitHub credential bootstrap failed");
    }
    return { source: "gh", token };
  }

  async #resolveGh(workspaceRoot: string): Promise<string> {
    const pathValue = this.#environment.PATH ?? "";
    for (const entry of pathValue.split(delimiter)) {
      if (entry.length === 0 || !isAbsolute(entry)) continue;
      const candidate = join(entry, "gh");
      let canonical: string;
      try {
        canonical = await realpath(candidate);
        const metadata = await stat(canonical);
        if (!metadata.isFile()) continue;
        await access(canonical, fsConstants.X_OK);
      } catch {
        continue;
      }
      if (isPathInside(workspaceRoot, canonical)) {
        throw new CapabilityError(
          "CI_AUTH_FAILED",
          "GitHub credential executable is not trusted"
        );
      }
      return canonical;
    }
    throw authenticationRequired("GitHub CLI authentication is not available");
  }
}

function authenticationRequired(message: string): CapabilityError {
  return new CapabilityError("CI_AUTH_REQUIRED", message, {
    reason: "AUTHENTICATION_REQUIRED",
    retryable: false,
    suggestedAction: "authenticate"
  });
}

function cleanChildEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string>> {
  const home = environment.HOME;
  return {
    HOME: home !== undefined && isAbsolute(home) ? home : homedir(),
    PATH: CHILD_PATH
  };
}

async function canonicalPath(path: string, errorCode: "CI_AUTH_FAILED"): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new CapabilityError(errorCode, "GitHub credential bootstrap failed");
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
