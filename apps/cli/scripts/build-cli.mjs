import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const workspaceRoot = join(appRoot, "..", "..");
const binDir = join(appRoot, "bin");
const tmpOut = join(binDir, "kodegpt.mjs.tmp");
const finalOut = join(binDir, "kodegpt.mjs");
const cliProvenancePath = join(binDir, "kodegpt.provenance.json");
const runtimePackageRoot = join(workspaceRoot, "packages", "runtime-linux-x64");
const runtimePath = join(runtimePackageRoot, "bin", "kodegpt-runtime");
const runtimeProvenancePath = join(runtimePackageRoot, "provenance.json");

const sourceRevision = capture("git", ["rev-parse", "HEAD"]);
if (!/^[a-f0-9]{40}$/.test(sourceRevision)) {
  throw new Error(`unexpected Git HEAD revision: ${sourceRevision}`);
}
const sourceDirty = capture("git", ["status", "--porcelain", "--untracked-files=all"]).length > 0;

run("cargo", ["build", "--release", "-p", "kodegpt-runtime"]);
run(process.execPath, [join(workspaceRoot, "scripts", "stage-runtime.mjs")]);

await mkdir(binDir, { recursive: true });
await build({
  entryPoints: [join(appRoot, "src", "main.ts")],
  outfile: tmpOut,
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node22"],
  packages: "bundle",
  external: [
    "@kodegpt/runtime-linux-x64",
    "@kodegpt/runtime-linux-x64/package.json",
    "playwright-core",
    "playwright-core/*",
    "yaml"
  ],
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __kodegptCreateRequire } from "node:module";',
      'import { dirname as __kodegptDirname } from "node:path";',
      'import { fileURLToPath as __kodegptFileURLToPath } from "node:url";',
      "const require = __kodegptCreateRequire(import.meta.url);",
      "const __filename = __kodegptFileURLToPath(import.meta.url);",
      "const __dirname = __kodegptDirname(__filename);"
    ].join("\n")
  },
  legalComments: "none"
});
await chmod(tmpOut, 0o755);
await rename(tmpOut, finalOut);

const cliSha256 = await sha256(finalOut);
const runtimeSha256 = await sha256(runtimePath);
const provenance = {
  schemaVersion: 1,
  pairId: derivePairId(cliSha256, runtimeSha256),
  sourceRevision,
  sourceDirty,
  runtimePackage: "@kodegpt/runtime-linux-x64",
  cliSha256,
  runtimeSha256
};
await writeJsonAtomic(cliProvenancePath, provenance);
await writeJsonAtomic(runtimeProvenancePath, provenance);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    env: process.env,
    encoding: "utf8",
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function derivePairId(cliSha256, runtimeSha256) {
  return `pair_${createHash("sha256")
    .update(cliSha256)
    .update("\0")
    .update(runtimeSha256)
    .digest("hex")
    .slice(0, 32)}`;
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
