import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { CapabilityError } from "../errors.js";
import {
  PROVIDER_CREDENTIAL_TIMEOUT_MS,
  PROVIDER_MAX_HELPER_STDERR_BYTES,
  PROVIDER_MAX_HELPER_STDOUT_BYTES,
  type ProviderAdapterManifest,
  type ProviderRegistryRecord
} from "./contracts.js";
import { revalidateProviderHelperIdentity } from "./identity.js";

export interface ProviderCredential {
  readonly value: string;
  readonly kind: "bearer" | "opaque";
}

export interface ProviderCredentialBroker {
  acquire(input: {
    provider: ProviderRegistryRecord;
    manifest: ProviderAdapterManifest;
    signal: AbortSignal;
  }): Promise<ProviderCredential | null>;
}

export interface DefaultProviderCredentialBrokerOptions {
  workspaceRoots: () => readonly string[];
  timeoutMs?: number;
}

export class DefaultProviderCredentialBroker implements ProviderCredentialBroker {
  readonly #workspaceRoots: () => readonly string[];
  readonly #timeoutMs: number;

  constructor(options: DefaultProviderCredentialBrokerOptions) {
    this.#workspaceRoots = options.workspaceRoots;
    const requested = options.timeoutMs ?? PROVIDER_CREDENTIAL_TIMEOUT_MS;
    this.#timeoutMs = Math.max(1, Math.min(requested, PROVIDER_CREDENTIAL_TIMEOUT_MS));
  }

  async acquire(input: {
    provider: ProviderRegistryRecord;
    manifest: ProviderAdapterManifest;
    signal: AbortSignal;
  }): Promise<ProviderCredential | null> {
    if (input.signal.aborted) throw cancelled();

    if (input.manifest.credentialBroker.kind === "none") {
      if (input.provider.credentialBroker.kind !== "none") {
        throw stateInvalid("Provider credential broker state does not match compiled adapter policy");
      }
      return null;
    }
    if (input.provider.credentialBroker.kind !== "external-helper") {
      throw stateInvalid("Provider credential broker state does not match compiled adapter policy");
    }

    let identity: { canonicalPath: string; sha256: string };
    try {
      identity = await revalidateProviderHelperIdentity({
        canonicalPath: input.provider.credentialBroker.helperPath,
        expectedSha256: input.provider.credentialBroker.helperSha256,
        workspaceRoots: this.#workspaceRoots()
      });
    } catch (error) {
      if (error instanceof CapabilityError && error.code === "PROVIDER_IDENTITY_CHANGED") throw error;
      if (error instanceof CapabilityError && error.code === "PROVIDER_INPUT_INVALID") {
        throw unavailable("Provider credential helper is unavailable");
      }
      throw error;
    }

    return runCredentialHelper({
      executable: identity.canonicalPath,
      argv: input.manifest.credentialBroker.argv,
      environment: input.manifest.credentialBroker.environment,
      credentialKind: input.manifest.credentialBroker.credentialKind,
      timeoutMs: this.#timeoutMs,
      signal: input.signal
    });
  }
}

async function runCredentialHelper(input: {
  executable: string;
  argv: readonly string[];
  environment: Readonly<Record<string, string>>;
  credentialKind: "bearer" | "opaque";
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<ProviderCredential> {
  if (input.signal.aborted) throw cancelled();

  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(input.executable, [...input.argv], {
      shell: false,
      env: { ...input.environment },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      windowsHide: true
    });
  } catch {
    throw unavailable("Provider credential helper is unavailable");
  }

  return await new Promise<ProviderCredential>((resolve, reject) => {
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalError: CapabilityError | null = null;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
    };

    const finishReject = (error: CapabilityError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const finishResolve = (credential: ProviderCredential) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(credential);
    };

    const failAndKill = (error: CapabilityError) => {
      if (terminalError === null) terminalError = error;
      killProcessTree(child);
    };

    const onStdout = (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > PROVIDER_MAX_HELPER_STDOUT_BYTES) {
        failAndKill(rejected("Provider credential helper output exceeded its bound"));
        return;
      }
      stdout.push(Buffer.from(chunk));
    };

    const onStderr = (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > PROVIDER_MAX_HELPER_STDERR_BYTES) {
        failAndKill(rejected("Provider credential helper error output exceeded its bound"));
      }
    };

    const onAbort = () => failAndKill(cancelled());
    const onError = () => {
      if (terminalError === null) terminalError = unavailable("Provider credential helper is unavailable");
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (terminalError !== null) {
        finishReject(terminalError);
        return;
      }
      if (code !== 0 || signal !== null) {
        finishReject(unavailable("Provider credential helper did not provide a usable credential"));
        return;
      }
      try {
        finishResolve({
          kind: input.credentialKind,
          value: decodeSingleLineCredential(Buffer.concat(stdout, stdoutBytes))
        });
      } catch (error) {
        finishReject(error instanceof CapabilityError ? error : rejected("Provider credential helper output was rejected"));
      }
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    input.signal.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      failAndKill(new CapabilityError("PROVIDER_TIMEOUT", "Provider credential helper timed out"));
    }, input.timeoutMs);
    timer.unref();

    if (input.signal.aborted) onAbort();
  });
}

function decodeSingleLineCredential(bytes: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw rejected("Provider credential helper output was not valid UTF-8");
  }
  if (text.endsWith("\r\n")) text = text.slice(0, -2);
  else if (text.endsWith("\n")) text = text.slice(0, -1);

  if (text.length === 0) throw unavailable("Provider credential helper returned no credential");
  if (text.includes("\n") || text.includes("\r") || text.includes("\0")) {
    throw rejected("Provider credential helper output must be one line");
  }
  return text;
}

function killProcessTree(child: ChildProcessByStdio<null, Readable, Readable>): void {
  const pid = child.pid;
  if (pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Fall through to direct child kill if the process group already disappeared.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Best-effort only; close/error will settle the operation.
  }
}

function unavailable(message: string): CapabilityError {
  return new CapabilityError("PROVIDER_CREDENTIAL_UNAVAILABLE", message);
}

function rejected(message: string): CapabilityError {
  return new CapabilityError("PROVIDER_CREDENTIAL_REJECTED", message);
}

function cancelled(): CapabilityError {
  return new CapabilityError("PROVIDER_CANCELLED", "Provider credential acquisition was cancelled");
}

function stateInvalid(message: string): CapabilityError {
  return new CapabilityError("PROVIDER_STATE_INVALID", message);
}
