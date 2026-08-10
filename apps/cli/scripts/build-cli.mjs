import { chmod, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const binDir = join(root, "bin");
const tmpOut = join(binDir, "kodegpt.mjs.tmp");
const finalOut = join(binDir, "kodegpt.mjs");

await mkdir(binDir, { recursive: true });
await build({
  entryPoints: [join(root, "src", "main.ts")],
  outfile: tmpOut,
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node22"],
  packages: "bundle",
  external: ["@kodegpt/runtime-linux-x64", "@kodegpt/runtime-linux-x64/package.json"],
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none"
});
await chmod(tmpOut, 0o755);
await rename(tmpOut, finalOut);
