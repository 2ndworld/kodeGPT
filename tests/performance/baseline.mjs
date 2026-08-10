import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { cpus, hostname, platform, release, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { request as httpRequest } from "node:http";

export const DEFAULT_WARMUPS = 5;
export const DEFAULT_ITERATIONS = 30;

const PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const REPOSITORY_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const RUNTIME = join(REPOSITORY_ROOT, "target", "debug", "kodegpt-runtime");
const CLI = join(REPOSITORY_ROOT, "apps", "cli", "bin", "kodegpt.mjs");

export function summarizeDurations(values) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new TypeError("durations must contain at least one non-negative finite number");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return {
    iterations: sorted.length,
    medianMs: roundMillis(median),
    p95Ms: roundMillis(sorted[p95Index] ?? 0),
    minMs: roundMillis(sorted[0] ?? 0),
    maxMs: roundMillis(sorted.at(-1) ?? 0)
  };
}

async function main() {
  const temporaryRoot = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "kodegpt-baseline-"));
  const stateRoot = join(temporaryRoot, "state");
  const workspace = join(temporaryRoot, "workspace");
  let serverProcess;
  let rawRuntime;

  try {
    run("cargo", ["build", "-p", "kodegpt-runtime"]);
    run("pnpm", ["--filter", "kodegpt", "build"]);
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    await mkdir(join(workspace, "bench"), { recursive: true });
    await writeFile(join(workspace, "bench", "small.txt"), "baseline hello\n");
    run("git", ["init", "-q"], workspace);
    run("git", ["add", "bench/small.txt"], workspace);

    rawRuntime = await RawRuntimeClient.start(RUNTIME, stateRoot);
    const helloSamples = await benchmark({
      warmups: DEFAULT_WARMUPS,
      iterations: DEFAULT_ITERATIONS,
      operation: () => rawRuntime.request("runtime.hello", {})
    });
    const hello = await rawRuntime.request("runtime.hello", {});
    const inspected = await rawRuntime.request("system.inspect_root", { path: workspace });
    await rawRuntime.stop();
    rawRuntime = undefined;

    await seedTrustStore(stateRoot, inspected);
    const rotated = capture(process.execPath, [CLI, "auth", "rotate", "--state-root", stateRoot], {
      ...process.env,
      NODE_ENV: "development",
      KODEGPT_RUNTIME_PATH: RUNTIME
    }).trim();
    const token = rotated.split(/\s+/).at(-1);
    if (!token || token.length < 16) throw new Error("benchmark connector token was not issued");

    const port = await availablePort();
    serverProcess = spawn(process.execPath, [CLI, "start", "--state-root", stateRoot, "--port", String(port)], {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        NODE_ENV: "development",
        KODEGPT_RUNTIME_PATH: RUNTIME
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    await waitForListening(serverProcess, port);

    const openSamples = await benchmark({
      warmups: DEFAULT_WARMUPS,
      iterations: DEFAULT_ITERATIONS,
      operation: () => callTool(port, token, "workspace.open", { rootPath: workspace }),
      cleanup: async (result) => {
        const opened = textJson(result);
        await callTool(port, token, "workspace.close", { workspaceId: opened.id });
      }
    });

    const opened = textJson(await callTool(port, token, "workspace.open", { rootPath: workspace }));
    const workspaceId = opened.id;
    if (typeof workspaceId !== "string" || !workspaceId.startsWith("ws_")) {
      throw new Error("benchmark workspace did not open");
    }

    const infoSamples = await benchmark({
      warmups: DEFAULT_WARMUPS,
      iterations: DEFAULT_ITERATIONS,
      operation: () => callTool(port, token, "workspace.info", { workspaceId })
    });
    const readSamples = await benchmark({
      warmups: DEFAULT_WARMUPS,
      iterations: DEFAULT_ITERATIONS,
      operation: () => callTool(port, token, "file.read", { workspaceId, path: "bench/small.txt" })
    });
    const treeSamples = await benchmark({
      warmups: DEFAULT_WARMUPS,
      iterations: DEFAULT_ITERATIONS,
      operation: () => callTool(port, token, "file.tree", { workspaceId, path: "bench" })
    });
    const gitStatusSamples = await benchmark({
      warmups: DEFAULT_WARMUPS,
      iterations: DEFAULT_ITERATIONS,
      operation: () => callTool(port, token, "git.status", { workspaceId })
    });
    const processSamples = await benchmark({
      warmups: DEFAULT_WARMUPS,
      iterations: DEFAULT_ITERATIONS,
      operation: async () => {
        const result = await callTool(port, token, "process.run", {
          workspaceId,
          logicalExecutable: "python3",
          argv: ["-c", "pass"],
          background: false
        });
        const value = textJson(result);
        if (value.state !== "completed" || value.exitCode !== 0) {
          throw new Error("benchmark process did not complete successfully");
        }
        return result;
      }
    });
    const consoleSamples = await benchmark({
      warmups: DEFAULT_WARMUPS,
      iterations: DEFAULT_ITERATIONS,
      operation: () => callTool(port, token, "console.state", {})
    });

    await callTool(port, token, "workspace.close", { workspaceId });

    const cpuList = cpus();
    const result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      contract: {
        warmups: DEFAULT_WARMUPS,
        measuredIterations: DEFAULT_ITERATIONS,
        thresholdPolicy: "record-only"
      },
      machine: {
        hostname: hostname(),
        platform: platform(),
        osRelease: release(),
        arch: process.arch,
        cpuModel: cpuList[0]?.model ?? "unknown",
        cpuCount: cpuList.length,
        totalMemoryBytes: totalmem(),
        nodeVersion: process.version
      },
      runtime: {
        kodegptRuntimeVersion: hello.runtimeVersion,
        protocolVersion: PROTOCOL_VERSION,
        bubblewrapVersion: capture("/usr/local/bin/bwrap", ["--version"]).trim(),
        gitHead: capture("git", ["rev-parse", "HEAD"]).trim()
      },
      measurements: {
        helloIpc: summarizeDurations(helloSamples),
        consoleState: summarizeDurations(consoleSamples),
        workspaceOpen: summarizeDurations(openSamples),
        workspaceInfo: summarizeDurations(infoSamples),
        smallFileRead: summarizeDurations(readSamples),
        smallTree: summarizeDurations(treeSamples),
        gitStatus: summarizeDurations(gitStatusSamples),
        trivialProcess: summarizeDurations(processSamples)
      }
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    if (rawRuntime) await rawRuntime.stop().catch(() => undefined);
    if (serverProcess && serverProcess.exitCode === null) {
      serverProcess.kill("SIGTERM");
      await waitForExit(serverProcess).catch(() => undefined);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function benchmark({ warmups, iterations, operation, cleanup = async () => undefined }) {
  for (let index = 0; index < warmups; index += 1) {
    const result = await operation();
    await cleanup(result);
  }
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const result = await operation();
    samples.push(performance.now() - started);
    await cleanup(result);
  }
  return samples;
}

async function seedTrustStore(stateRoot, inspected) {
  if (
    !inspected ||
    typeof inspected.canonicalRoot !== "string" ||
    !inspected.identity ||
    typeof inspected.identity.deviceMajor !== "number" ||
    typeof inspected.identity.deviceMinor !== "number" ||
    typeof inspected.identity.inode !== "string"
  ) {
    throw new Error("runtime returned invalid workspace identity for benchmark");
  }
  const trustDirectory = join(stateRoot, "trust");
  await mkdir(trustDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(trustDirectory, "workspaces.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          id: `trust_${randomUUID().replaceAll("-", "")}`,
          canonicalRoot: inspected.canonicalRoot,
          identity: inspected.identity,
          profileCeiling: "trusted",
          trustedAt: new Date().toISOString()
        }
      ]
    })}\n`,
    { mode: 0o600 }
  );
}

async function callTool(port, token, name, args) {
  const payload = await mcpRequest(port, token, "tools/call", {
    name,
    arguments: args,
    _meta: requestMeta()
  }, name);
  if (payload.error) throw new Error(`MCP tool failed: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

async function mcpRequest(port, token, method, params, name) {
  const id = `bench_${randomUUID().replaceAll("-", "")}`;
  const text = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const response = await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(text),
          "mcp-protocol-version": PROTOCOL_VERSION,
          "mcp-method": method,
          ...(name ? { "mcp-name": name } : {})
        }
      },
      (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => {
          body += chunk;
        });
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body }));
      }
    );
    request.once("error", reject);
    request.end(text);
  });
  if (response.status !== 200) {
    throw new Error(`MCP HTTP ${response.status}: ${response.body}`);
  }
  return JSON.parse(response.body);
}

function requestMeta() {
  return {
    [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
    [CLIENT_CAPABILITIES_META_KEY]: {}
  };
}

function textJson(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("tool result has no text fallback");
  return JSON.parse(text);
}

class RawRuntimeClient {
  constructor(child) {
    this.child = child;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    child.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    child.once("exit", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("runtime exited"));
      this.pending.clear();
    });
  }

  static async start(runtimePath, stateRoot) {
    const child = spawn(runtimePath, [], {
      env: { KODEGPT_STATE_ROOT: stateRoot },
      stdio: ["pipe", "pipe", "pipe"]
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return new RawRuntimeClient(child);
  }

  request(method, params) {
    const id = `req_bench_${randomUUID().replaceAll("-", "")}`;
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8");
    const frame = Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
      body
    ]);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(frame, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  drain() {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /^Content-Length: (\d+)$/.exec(header);
      if (!match) throw new Error("invalid runtime frame header");
      const length = Number(match[1]);
      const frameEnd = headerEnd + 4 + length;
      if (this.buffer.length < frameEnd) return;
      const body = this.buffer.subarray(headerEnd + 4, frameEnd).toString("utf8");
      this.buffer = this.buffer.subarray(frameEnd);
      const response = JSON.parse(body);
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      if (response.error) pending.reject(new Error(JSON.stringify(response.error)));
      else pending.resolve(response.result);
    }
  }

  async stop() {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    await waitForExit(this.child);
  }
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("could not allocate benchmark port"));
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForListening(child, port) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (stdout.includes(`http://127.0.0.1:${port}`)) return;
    if (child.exitCode !== null) throw new Error(`benchmark server exited early\n${stdout}\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for benchmark server\n${stdout}\n${stderr}`);
}

async function waitForExit(child) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
}

function run(command, args, cwd = REPOSITORY_ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

function capture(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function roundMillis(value) {
  return Math.round(value * 1000) / 1000;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
