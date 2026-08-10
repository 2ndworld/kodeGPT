import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = join(root, "apps/cli/bin/kodegpt.mjs");
const runtimePath = join(root, "packages/runtime-linux-x64/bin/kodegpt-runtime");
const temporaryRoots: string[] = [];

beforeAll(() => {
  if (!existsSync(runtimePath)) {
    const cargoBuild = spawnSync("cargo", ["build", "--release", "-p", "kodegpt-runtime"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024
    });
    expect(cargoBuild.error).toBeUndefined();
    expect(cargoBuild.status, cargoBuild.stderr).toBe(0);

    const stage = spawnSync(process.execPath, [join(root, "scripts/stage-runtime.mjs")], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    });
    expect(stage.error).toBeUndefined();
    expect(stage.status, stage.stderr).toBe(0);
  }

  const buildCli = spawnSync("pnpm", ["--filter", "kodegpt", "run", "build:cli"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
  expect(buildCli.error).toBeUndefined();
  expect(buildCli.status, buildCli.stderr).toBe(0);
}, 120_000);

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function startExposure(options: {
  stateRoot: string;
  fakeBinDir: string;
  argsPath: string;
  zrokStatePath: string;
  port: number;
}) {
  const child = spawn(
    process.execPath,
    [
      cliPath,
      "expose",
      "zrok",
      "--name",
      "public:kodegpt-dev",
      "--port",
      String(options.port),
      "--state-root",
      options.stateRoot
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: [options.fakeBinDir, process.env.PATH ?? ""].join(delimiter),
        KODEGPT_TEST_ZROK_ARGS: options.argsPath,
        KODEGPT_TEST_ZROK_STATE: options.zrokStatePath
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr
  };
}

async function stopExposure(child: ReturnType<typeof spawn>): Promise<number | null> {
  child.kill("SIGTERM");
  const [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  return code;
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("failed to allocate loopback test port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return port;
}

describe("CLI managed zrok exposure", () => {
  it("runs the packaged expose command with fake zrok2 and reuses credentials", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "kodegpt-cli-zrok-"));
    temporaryRoots.push(tempRoot);
    const stateRoot = join(tempRoot, "state");
    const fakeBinDir = join(tempRoot, "bin");
    const argsPath = join(tempRoot, "zrok-args.json");
    const zrokStatePath = join(tempRoot, "zrok-state.json");
    await mkdir(fakeBinDir, { recursive: true });
    const fakeZrokPath = join(fakeBinDir, "zrok2");
    await writeFile(
      fakeZrokPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const statePath = process.env.KODEGPT_TEST_ZROK_STATE;",
        "const argsPath = process.env.KODEGPT_TEST_ZROK_ARGS;",
        "if (!statePath || !argsPath) process.exit(3);",
        "if (args[0] === 'list' && args[1] === 'names') {",
        "  process.stdout.write(JSON.stringify([{name:'kodegpt-dev',namespaceName:'shares.example.test',namespaceToken:'public',reserved:true}]));",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'share' && args[1] === 'public') {",
        "  fs.writeFileSync(argsPath, JSON.stringify(args));",
        "  fs.writeFileSync(statePath, JSON.stringify({ready:true,target:args[2]}));",
        "  const stop = () => process.exit(0);",
        "  process.on('SIGTERM', stop);",
        "  process.on('SIGINT', stop);",
        "  setInterval(() => {}, 1000);",
        "  return;",
        "}",
        "if (args[0] === 'list' && args[1] === 'shares') {",
        "  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;",
        "  process.stdout.write(JSON.stringify({shares:state?.ready?[{target:state.target,shareMode:'public',backendMode:'proxy',frontendEndpoints:['kodegpt-dev.shares.example.test'],extraField:'raw-zrok-field-marker'}]:[]}));",
        "  process.exit(0);",
        "}",
        "process.exit(4);",
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(fakeZrokPath, 0o755);

    const port = await freeLoopbackPort();
    const first = await startExposure({ stateRoot, fakeBinDir, argsPath, zrokStatePath, port });
    await vi.waitFor(
      () => expect(first.stdout(), first.stderr()).toContain("KodeGPT exposure ready"),
      { timeout: 20_000 }
    );
    expect(first.stdout()).toContain("Public MCP endpoint: https://kodegpt-dev.shares.example.test/mcp");
    expect(first.stdout()).toContain("ChatGPT Server URL:");
    expect(first.stdout()).toContain(["kodegpt", "token="].join("_"));
    expect(first.stdout()).not.toContain("raw-zrok-field-marker");
    await vi.waitFor(() => expect(existsSync(argsPath)).toBe(true), { timeout: 5_000 });
    expect(JSON.parse(await readFile(argsPath, "utf8"))).toEqual([
      "share",
      "public",
      `http://127.0.0.1:${port}`,
      "--headless",
      "--force-local",
      "--backend-mode",
      "proxy",
      "-n",
      "public:kodegpt-dev"
    ]);
    expect(await stopExposure(first.child)).toBe(0);

    await rm(argsPath, { force: true });
    await rm(zrokStatePath, { force: true });
    const second = await startExposure({ stateRoot, fakeBinDir, argsPath, zrokStatePath, port });
    await vi.waitFor(
      () => expect(second.stdout(), second.stderr()).toContain("KodeGPT exposure ready"),
      { timeout: 20_000 }
    );
    expect(second.stdout()).toContain("existing connector credential");
    expect(second.stdout()).not.toContain(["kodegpt", "token="].join("_"));
    expect(await stopExposure(second.child)).toBe(0);

    const legacy = spawnSync(process.execPath, [cliPath, "expose", "ngrok"], {
      cwd: root,
      encoding: "utf8"
    });
    expect(legacy.status).not.toBe(0);
    expect(legacy.stderr).toContain("expose command requires provider: zrok");

    const help = spawnSync(process.execPath, [cliPath, "--help"], {
      cwd: root,
      encoding: "utf8"
    });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("kodegpt expose zrok --name");
    expect(help.stdout).not.toContain("kodegpt expose ngrok");
  }, 60_000);
});
