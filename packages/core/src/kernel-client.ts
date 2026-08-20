import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { FrameDecoder, encodeFrame } from "@kodegpt/protocol";

import { DeveloperEnvironmentStore } from "./developer-environment-store.js";

export interface KernelHello {
  runtimeVersion: string;
  testMethods: boolean;
  auditHealthy: boolean;
  filesystemBoundaryAvailable: boolean;
}

export class RuntimeUnavailableError extends Error {
  readonly code = "RUNTIME_UNAVAILABLE";

  constructor(message = "KodeGPT runtime is unavailable") {
    super(message);
    this.name = "RuntimeUnavailableError";
  }
}

export class KernelRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "KernelRpcError";
    this.code = code;
    this.data = data;
  }
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type ClientState = "running" | "stopping" | "unavailable" | "closed";

function stableRustToolchainRoot(): string | undefined {
  if (process.platform !== "linux") return undefined;
  const target =
    process.arch === "x64"
      ? "x86_64-unknown-linux-gnu"
      : process.arch === "arm64"
        ? "aarch64-unknown-linux-gnu"
        : undefined;
  return target === undefined
    ? undefined
    : join(homedir(), ".rustup", "toolchains", `stable-${target}`);
}

export class KernelClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #decoder = new FrameDecoder();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #exitPromise: Promise<void>;
  readonly unexpectedTermination: Promise<never>;
  readonly #rejectUnexpectedTermination: (error: RuntimeUnavailableError) => void;
  #state: ClientState = "running";
  #stderrBytes = 0;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    this.#exitPromise = new Promise((resolve) => {
      child.once("exit", () => resolve());
    });
    let rejectUnexpected!: (error: RuntimeUnavailableError) => void;
    this.unexpectedTermination = new Promise<never>((_resolve, reject) => {
      rejectUnexpected = reject;
    });
    this.#rejectUnexpectedTermination = rejectUnexpected;
    void this.unexpectedTermination.catch(() => undefined);

    child.stdout.on("data", (chunk: Buffer) => {
      if (this.#state === "closed") {
        return;
      }
      try {
        for (const response of this.#decoder.push(chunk)) {
          this.#handleResponse(response);
        }
      } catch (error) {
        this.#poison(
          new RuntimeUnavailableError(
            `KodeGPT runtime emitted invalid protocol output: ${error instanceof Error ? error.message : String(error)}`
          )
        );
        child.kill("SIGKILL");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrBytes = Math.min(64 * 1024, this.#stderrBytes + chunk.byteLength);
    });

    child.once("error", (error) => {
      this.#poison(new RuntimeUnavailableError(`KodeGPT runtime process error: ${error.message}`));
    });

    child.once("exit", (code, signal) => {
      try {
        this.#decoder.finish();
      } catch (error) {
        this.#poison(
          new RuntimeUnavailableError(
            `KodeGPT runtime closed with an incomplete protocol frame: ${error instanceof Error ? error.message : String(error)}`
          )
        );
        return;
      }

      if (this.#state !== "closed") {
        const detail = signal !== null ? `signal ${signal}` : `exit code ${String(code)}`;
        this.#poison(new RuntimeUnavailableError(`KodeGPT runtime exited (${detail})`));
      }
    });
  }

  static async start(options: {
    runtimePath: string;
    stateRoot: string;
    enableTestMethods?: boolean;
  }): Promise<KernelClient> {
    const rustToolchainRoot = stableRustToolchainRoot();
    await new DeveloperEnvironmentStore(options.stateRoot).ensureBootstrap({
      nodeRoot: dirname(dirname(process.execPath)),
      ...(rustToolchainRoot === undefined ? {} : { rustRoot: rustToolchainRoot }),
      trustedWorkspaceRoots: []
    });

    const environment: NodeJS.ProcessEnv = {
      KODEGPT_STATE_ROOT: options.stateRoot,
      KODEGPT_HOST_COREPACK_HOME: join(homedir(), ".cache", "node", "corepack")
    };
    if (options.enableTestMethods === true) {
      environment.KODEGPT_RUNTIME_TEST_METHODS = "1";
    }

    const child = spawn(options.runtimePath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: environment,
      windowsHide: true
    });
    const client = new KernelClient(child);

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onStartError);
        resolve();
      };
      const onStartError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(new RuntimeUnavailableError(`Failed to start KodeGPT runtime: ${error.message}`));
      };
      child.once("spawn", onSpawn);
      child.once("error", onStartError);
    });

    return client;
  }

  async hello(): Promise<KernelHello> {
    const result = await this.request<unknown>("runtime.hello", {});
    if (
      !isRecord(result) ||
      typeof result.runtimeVersion !== "string" ||
      typeof result.testMethods !== "boolean" ||
      typeof result.auditHealthy !== "boolean" ||
      typeof result.filesystemBoundaryAvailable !== "boolean"
    ) {
      this.#poison(new RuntimeUnavailableError("KodeGPT runtime returned an invalid hello payload"));
      this.#child.kill("SIGKILL");
      throw new RuntimeUnavailableError("KodeGPT runtime returned an invalid hello payload");
    }

    return {
      runtimeVersion: result.runtimeVersion,
      testMethods: result.testMethods,
      auditHealthy: result.auditHealthy,
      filesystemBoundaryAvailable: result.filesystemBoundaryAvailable
    };
  }

  request<T>(
    method: string,
    params: Record<string, unknown>,
    requestId = `req_${randomUUID().replaceAll("-", "")}`
  ): Promise<T> {
    if (this.#state !== "running") {
      return Promise.reject(new RuntimeUnavailableError());
    }
    if (this.#pending.has(requestId)) {
      return Promise.reject(new Error(`Duplicate runtime request id: ${requestId}`));
    }

    let frame: Uint8Array;
    try {
      frame = encodeFrame({
        jsonrpc: "2.0",
        id: requestId,
        method,
        params
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }

    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject
      };
      this.#pending.set(requestId, pending);

      this.#child.stdin.write(frame, (error) => {
        if (error === null || error === undefined) {
          return;
        }
        if (this.#pending.get(requestId) !== pending) {
          return;
        }

        this.#pending.delete(requestId);
        const unavailable = new RuntimeUnavailableError(`Failed to write to KodeGPT runtime: ${error.message}`);
        reject(unavailable);
        this.#poison(unavailable);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.#state === "closed") {
      return;
    }
    if (this.#state === "unavailable") {
      await this.#exitPromise;
      this.#state = "closed";
      return;
    }

    if (this.#state === "running") {
      this.#state = "stopping";
      this.#child.stdin.end();
      const killTimer = setTimeout(() => {
        if (this.#child.exitCode === null && this.#child.signalCode === null) {
          this.#child.kill("SIGKILL");
        }
      }, 2000);
      try {
        await this.#exitPromise;
      } finally {
        clearTimeout(killTimer);
      }
    }

    this.#state = "closed";
  }

  #handleResponse(value: unknown): void {
    if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.id !== "string") {
      throw new Error("invalid JSON-RPC response envelope");
    }

    const pending = this.#pending.get(value.id);
    if (pending === undefined) {
      throw new Error(`unexpected runtime response id: ${value.id}`);
    }
    this.#pending.delete(value.id);

    const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
    const hasError = Object.prototype.hasOwnProperty.call(value, "error");
    if (hasResult === hasError) {
      pending.reject(new RuntimeUnavailableError("KodeGPT runtime returned an ambiguous response"));
      throw new Error("ambiguous JSON-RPC response");
    }

    if (hasResult) {
      pending.resolve(value.result);
      return;
    }

    if (!isRecord(value.error) || typeof value.error.code !== "number" || typeof value.error.message !== "string") {
      pending.reject(new RuntimeUnavailableError("KodeGPT runtime returned an invalid error response"));
      throw new Error("invalid JSON-RPC error response");
    }

    pending.reject(new KernelRpcError(value.error.code, value.error.message, value.error.data));
  }

  #poison(error: RuntimeUnavailableError): void {
    if (this.#state === "closed") {
      return;
    }
    const unexpected = this.#state === "running";
    this.#state = "unavailable";
    if (unexpected) this.#rejectUnexpectedTermination(error);
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
