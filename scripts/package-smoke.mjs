import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "kodegpt-package-smoke-"));
const releaseDir = join(temporary, "release");
const home = join(temporary, "home");
const prefix = join(temporary, "prefix");
const stateRoot = join(home, ".kodegpt");
let child;

try {
  await mkdir(releaseDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(prefix, { recursive: true });

  run("pnpm", ["--filter", "kodegpt", "build"]);
  run("pnpm", ["exec", "vitest", "run", "tests/integration/packaged-runtime.test.ts"]);

  const cliSource = join(root, "apps/cli/bin/kodegpt.mjs");
  const runtimeSource = join(root, "packages/runtime-linux-x64/bin/kodegpt-runtime");
  const cliSha = await sha256(cliSource);
  const runtimeSha = await sha256(runtimeSource);
  const sourceCliProvenance = JSON.parse(await readFile(join(root, "apps/cli/bin/kodegpt.provenance.json"), "utf8"));
  const sourceRuntimeProvenance = JSON.parse(
    await readFile(join(root, "packages/runtime-linux-x64/provenance.json"), "utf8")
  );
  assertProvenancePair("source", sourceCliProvenance, sourceRuntimeProvenance, cliSha, runtimeSha);

  run("pnpm", ["--filter", "@kodegpt/runtime-linux-x64", "pack", "--pack-destination", releaseDir]);
  run("pnpm", ["--filter", "kodegpt", "pack", "--pack-destination", releaseDir]);
  const tarballs = (await readdir(releaseDir)).filter((file) => file.endsWith(".tgz")).sort();
  if (tarballs.length !== 2) throw new Error(`expected two tarballs, found ${tarballs.length}`);
  const runtimeTarball = tarballs.find((file) => file.includes("runtime-linux-x64"));
  const cliTarball = tarballs.find((file) => !file.includes("runtime-linux-x64"));
  if (!runtimeTarball || !cliTarball) throw new Error("could not identify packed runtime/CLI tarballs");

  const cliManifest = JSON.parse(
    capture("tar", ["-xOf", join(releaseDir, cliTarball), "package/package.json"])
  );
  if (JSON.stringify(cliManifest).includes("workspace:")) {
    throw new Error("packed CLI contains unresolved workspace:* dependency");
  }

  const runtimeExtracted = join(temporary, "runtime-extracted");
  const cliExtracted = join(temporary, "cli-extracted");
  await mkdir(runtimeExtracted, { recursive: true });
  await mkdir(cliExtracted, { recursive: true });
  run("tar", ["-xzf", join(releaseDir, runtimeTarball), "-C", runtimeExtracted]);
  run("tar", ["-xzf", join(releaseDir, cliTarball), "-C", cliExtracted]);
  const packedRuntimePath = join(runtimeExtracted, "package/bin/kodegpt-runtime");
  const packedCliPath = join(cliExtracted, "package/bin/kodegpt.mjs");
  const packedRuntimeSha = await sha256(packedRuntimePath);
  const packedCliSha = await sha256(packedCliPath);
  if (runtimeSha !== packedRuntimeSha) {
    throw new Error("platform package runtime checksum does not match staged release binary");
  }
  if (cliSha !== packedCliSha) {
    throw new Error("CLI package checksum does not match built CLI bundle");
  }
  const packedCliProvenance = JSON.parse(
    await readFile(join(cliExtracted, "package/bin/kodegpt.provenance.json"), "utf8")
  );
  const packedRuntimeProvenance = JSON.parse(
    await readFile(join(runtimeExtracted, "package/provenance.json"), "utf8")
  );
  assertProvenancePair("packed", packedCliProvenance, packedRuntimeProvenance, packedCliSha, packedRuntimeSha);
  if (
    JSON.stringify(sourceCliProvenance) !== JSON.stringify(packedCliProvenance) ||
    JSON.stringify(sourceRuntimeProvenance) !== JSON.stringify(packedRuntimeProvenance)
  ) {
    throw new Error("packed artifact provenance differs from source build provenance");
  }

  const checksums = [];
  for (const file of tarballs) {
    const digest = await sha256(join(releaseDir, file));
    checksums.push(`${digest}  ${file}`);
    if ((await sha256(join(releaseDir, file))) !== digest) throw new Error(`checksum verification failed for ${file}`);
  }
  checksums.push(`${runtimeSha}  kodegpt-runtime`);
  await writeFile(join(releaseDir, "SHA256SUMS"), `${checksums.join("\n")}\n`);

  const cleanEnv = {
    HOME: home,
    PATH: cleanInstallPath(process.env.PATH),
    npm_config_cache: join(temporary, "npm-cache")
  };
  run("npm", ["install", "--prefix", prefix, "--ignore-scripts", join(releaseDir, runtimeTarball), join(releaseDir, cliTarball)], cleanEnv);
  const installedRuntime = join(prefix, "node_modules/@kodegpt/runtime-linux-x64/bin/kodegpt-runtime");
  const installedRuntimeStat = await stat(installedRuntime).catch((error) => {
    throw new Error(`installed runtime is missing: ${error instanceof Error ? error.message : String(error)}`);
  });
  if ((installedRuntimeStat.mode & 0o111) === 0) {
    throw new Error(`installed runtime is not executable; mode=${(installedRuntimeStat.mode & 0o777).toString(8)}`);
  }
  const cli = join(prefix, "node_modules/.bin/kodegpt");
  const doctor = JSON.parse(capture(cli, ["doctor", "--json"], cleanEnv));
  if (doctor.ok !== true || doctor.runtimePackage !== "@kodegpt/runtime-linux-x64") {
    throw new Error("packaged doctor did not resolve package-owned runtime");
  }

  const rotated = capture(cli, ["auth", "rotate", "--state-root", stateRoot], cleanEnv).trim();
  const token = rotated.split(/\s+/).at(-1);
  if (!token || token.length < 16) throw new Error("packaged auth rotate did not produce a connector credential");

  const port = await availablePort();
  child = spawn(cli, ["start", "--state-root", stateRoot, "--port", String(port)], {
    env: cleanEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForListening(child, port);

  const discover = await mcpPost(port, token, "server/discover", undefined, "req_pack_discover");
  if (discover.status !== 200 || !discover.body.includes("2026-07-28")) {
    throw new Error(`packaged server/discover failed: ${discover.status} ${discover.body}`);
  }
  const health = await mcpPost(port, token, "tools/call", "system.health", "req_pack_health");
  if (health.status !== 200 || !health.body.includes("auditHealthy")) {
    throw new Error(`packaged system.health failed: ${health.status} ${health.body}`);
  }

  child.kill("SIGTERM");
  const exitCode = await waitForExit(child);
  child = undefined;
  if (exitCode !== 0) throw new Error(`packaged kodegpt did not shut down cleanly: ${exitCode}`);

  const fakeBin = join(temporary, "service-bin");
  const managerLog = join(temporary, "service-manager.log");
  await mkdir(fakeBin, { recursive: true });
  await writeExecutable(
    join(fakeBin, "systemctl"),
    `#!/usr/bin/env node\n` +
      `const fs = require("node:fs");\n` +
      `const args = process.argv.slice(2);\n` +
      `fs.appendFileSync(${JSON.stringify(managerLog)}, args.join(" ") + "\\n");\n` +
      `if (args[1] === "show") process.stdout.write("LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nUnitFileState=enabled\\nMainPID=0\\nResult=success\\n");\n`
  );
  await writeExecutable(join(fakeBin, "loginctl"), `#!/usr/bin/env node\nprocess.stdout.write("no\\n");\n`);
  await writeExecutable(join(fakeBin, "zrok2"), `#!/usr/bin/env node\nprocess.exit(0);\n`);
  const serviceEnv = { ...cleanEnv, PATH: `${fakeBin}:${cleanEnv.PATH}` };
  const serviceInstall = capture(
    cli,
    ["service", "install", "--name", "public:kodegpt-dev", "--state-root", stateRoot],
    serviceEnv
  ).trim();
  if (!/staged=rel_[a-f0-9]{32}/.test(serviceInstall)) {
    throw new Error(`packaged service install did not report a staged release: ${serviceInstall}`);
  }
  const serviceMetadataPath = join(stateRoot, "service.json");
  const serviceMetadata = JSON.parse(await readFile(serviceMetadataPath, "utf8"));
  const stagedRelease = serviceMetadata.releases?.[serviceMetadata.stagedReleaseId];
  if (!stagedRelease) throw new Error("packaged service install did not persist staged release metadata");
  const serviceDataRoot = join(home, ".local/share/kodegpt/service");
  if (!stagedRelease.releaseRoot.startsWith(serviceDataRoot) || stagedRelease.releaseRoot.includes(root)) {
    throw new Error("packaged service release still depends on the source checkout");
  }
  if ((await sha256(stagedRelease.runtimePath)) !== runtimeSha) {
    throw new Error("installed service runtime checksum does not match packaged runtime");
  }
  const serviceUnitPath = join(home, ".config/systemd/user/kodegpt.service");
  const serviceUnit = await readFile(serviceUnitPath, "utf8");
  if (serviceUnit.includes(root) || serviceUnit.includes(prefix)) {
    throw new Error("service unit references a transient source or package-install path");
  }
  const serviceStatus = JSON.parse(capture(
    cli,
    ["service", "status", "--json", "--state-root", stateRoot],
    serviceEnv
  ));
  if (
    serviceStatus.installed !== true ||
    serviceStatus.state !== "stopped" ||
    serviceStatus.stagedReleaseId !== serviceMetadata.stagedReleaseId ||
    serviceStatus.reservedName !== "public:kodegpt-dev"
  ) {
    throw new Error(`packaged service status mismatch: ${JSON.stringify(serviceStatus)}`);
  }
  capture(cli, ["service", "uninstall", "--state-root", stateRoot], serviceEnv);
  await assertMissing(serviceDataRoot, "packaged service uninstall left the service data root behind");
  await assertMissing(serviceMetadataPath, "packaged service uninstall left service metadata behind");
  await assertMissing(serviceUnitPath, "packaged service uninstall left the user unit behind");

  const cleanRuntimeBytes = await readFile(installedRuntime);
  await writeFile(installedRuntime, Buffer.concat([cleanRuntimeBytes, Buffer.from("\n# provenance tamper\n")]));
  const rejectedInstall = spawnSync(
    cli,
    ["service", "install", "--name", "public:kodegpt-dev", "--state-root", stateRoot],
    {
      cwd: root,
      env: serviceEnv,
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 16 * 1024 * 1024
    }
  );
  if (rejectedInstall.error) throw rejectedInstall.error;
  if (rejectedInstall.status === 0) {
    throw new Error("tampered packaged runtime was accepted by service install");
  }
  const rejectionOutput = `${rejectedInstall.stdout}\n${rejectedInstall.stderr}`;
  if (!/service artifact provenance/i.test(rejectionOutput)) {
    throw new Error(`tampered service install did not fail on provenance: ${rejectionOutput}`);
  }
  await assertMissing(serviceDataRoot, "rejected service install created service release data");
  await assertMissing(serviceMetadataPath, "rejected service install staged service metadata");
  await assertMissing(serviceUnitPath, "rejected service install created a user unit");

  process.stdout.write(`package smoke ok\nrelease=${releaseDir}\n${checksums.join("\n")}\n`);
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  await rm(temporary, { recursive: true, force: true });
}

async function writeExecutable(path, contents) {
  await writeFile(path, contents, "utf8");
  await chmod(path, 0o755);
}

async function assertMissing(path, message) {
  await stat(path).then(
    () => { throw new Error(message); },
    (error) => {
      if (error?.code !== "ENOENT") throw error;
    }
  );
}

function assertProvenancePair(label, cliProvenance, runtimeProvenance, cliSha256, runtimeSha256) {
  if (JSON.stringify(cliProvenance) !== JSON.stringify(runtimeProvenance)) {
    throw new Error(`${label} CLI/runtime provenance manifests differ`);
  }
  if (
    cliProvenance.schemaVersion !== 1 ||
    cliProvenance.runtimePackage !== "@kodegpt/runtime-linux-x64" ||
    typeof cliProvenance.sourceDirty !== "boolean" ||
    typeof cliProvenance.sourceRevision !== "string" ||
    !/^[a-f0-9]{40}$/.test(cliProvenance.sourceRevision)
  ) {
    throw new Error(`${label} artifact provenance metadata is invalid`);
  }
  if (cliProvenance.cliSha256 !== cliSha256 || cliProvenance.runtimeSha256 !== runtimeSha256) {
    throw new Error(`${label} artifact provenance digest does not match artifact bytes`);
  }
  if (cliProvenance.pairId !== derivePairId(cliSha256, runtimeSha256)) {
    throw new Error(`${label} artifact provenance pair identity mismatch`);
  }
}

function derivePairId(cliSha256, runtimeSha256) {
  return `pair_${createHash("sha256")
    .update(cliSha256)
    .update("\0")
    .update(runtimeSha256)
    .digest("hex")
    .slice(0, 32)}`;
}

function cleanInstallPath(value) {
  if (!value) return "/usr/local/bin:/usr/bin:/bin";
  return value
    .split(":")
    .filter((entry) => entry.length > 0)
    .filter((entry) => !(entry.startsWith(`${root}/`) && entry.includes("/node_modules/")))
    .join(":");
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", stdio: "pipe", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

function capture(command, args, env = process.env) {
  return run(command, args, env).stdout;
}

async function sha256(path) {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("failed to allocate loopback port"));
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForListening(processHandle, port) {
  let stdout = "";
  let stderr = "";
  processHandle.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  processHandle.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (stdout.includes(`http://127.0.0.1:${port}`)) return;
    if (processHandle.exitCode !== null) throw new Error(`packaged start exited early\n${stdout}\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for packaged start\n${stdout}\n${stderr}`);
}

async function waitForExit(processHandle) {
  if (processHandle.exitCode !== null) return processHandle.exitCode;
  return new Promise((resolve) => processHandle.once("exit", (code) => resolve(code ?? 1)));
}

async function mcpPost(port, token, method, toolName, id) {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {}
  };
  const body = method === "server/discover"
    ? { jsonrpc: "2.0", id, method, params: { _meta: meta } }
    : { jsonrpc: "2.0", id, method, params: { name: toolName, arguments: {}, _meta: meta } };
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(text),
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(toolName ? { "mcp-name": toolName } : {})
      }
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: responseBody }));
    });
    request.once("error", reject);
    request.end(text);
  });
}
