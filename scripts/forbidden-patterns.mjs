import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PRODUCT_ROOTS = ["apps", "packages", "crates"];
const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".rs", ".json", ".toml"]);

const violations = [];
const root = parseRoot(process.argv.slice(2));

for (const productRoot of PRODUCT_ROOTS) {
  const absolute = join(root, productRoot);
  if (!(await exists(absolute))) continue;
  for (const file of await walk(absolute)) {
    const repoPath = normalize(relative(root, file));
    if (!isAuthoredProductFile(repoPath)) continue;
    const source = await readFile(file, "utf8");
    scanFile(repoPath, source);
  }
}

await scanRepositoryConfiguration();

if (violations.length > 0) {
  for (const violation of violations) {
    process.stderr.write(`${violation.rule}: ${violation.path}${violation.detail ? ` — ${violation.detail}` : ""}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write("forbidden-pattern scan ok\n");
}

function scanFile(path, source) {
  if (path.startsWith("packages/mcp-server/src/")) {
    forbid(path, source, "mcp-v1-sdk", /@modelcontextprotocol\/sdk/);
    forbid(path, source, "mcp-session-id", /Mcp-Session-Id|mcp-session-id/i);
    forbid(path, source, "public-shell-run", /["']shell\.run["']/);
    forbid(path, source, "capability-id-output", /\bcapabilityId\b/);
    forbid(path, source, "ext-apps-server", /@modelcontextprotocol\/ext-apps\/server/);
    forbid(path, source, "deprecated-app-registration", /\b(?:registerAppTool|registerAppResource)\b/);
    forbid(path, source, "flat-ui-resource-uri", /["']ui\/resourceUri["']/);
    forbid(path, source, "server-legacy", /legacy\s*:\s*["'](?!reject["'])[^"']+["']/);
    if (/io\.modelcontextprotocol\/ui/.test(source) && /\binitialize\b/.test(source)) {
      add("initialize-time-apps-state", path, "Apps support must be derived from the current request");
    }
  }

  if (path.startsWith("packages/extensions/src/")) {
    forbid(path, source, "dynamic-extension-execution", /\bimport\s*\(|\beval\s*\(|\bnew\s+Function\b/);
  }

  if (path.startsWith("packages/") || path.startsWith("apps/")) {
    if (
      /from\s+["']node:child_process["']/.test(source) &&
      /\b(?:exec|execFile)\b/.test(source)
    ) {
      add("node-exec-fallback", path, "user process execution must remain behind the Rust kernel");
    }
  }

  if (path === "crates/sandbox/src/bubblewrap.rs") {
    for (const line of source.split("\n")) {
      if (/["']--(?:ro-)?bind["']/.test(line) && /\/workspace|workspace|host_path|root_path/.test(line)) {
        add("host-path-bwrap-bind", path, "workspace authority must use --bind-fd/--ro-bind-fd");
      }
    }
  }

  if (
    path === "crates/workspace-io/src/openat.rs" ||
    path === "crates/workspace-io/src/read.rs" ||
    path === "crates/workspace-io/src/write.rs"
  ) {
    forbid(path, source, "canonicalize-then-open", /\bcanonicalize\s*\(/);
  }

  if (path === "crates/runtime/src/dispatcher.rs") {
    scanRuntimeTestRoutes(path, source);
  }

  if (path === "crates/runtime/Cargo.toml") {
    const defaultFeatureMatch = /^default\s*=\s*\[([^\]]*)\]/m.exec(source);
    if (defaultFeatureMatch?.[1]?.includes("runtime-test-methods")) {
      add("production-test-rpc", path, "runtime-test-methods must never be a default feature");
    }
  }
}

function scanRuntimeTestRoutes(path, source) {
  const authoredProduction = source.split("#[cfg(test)]\nmod tests {", 1)[0] ?? source;
  const lines = authoredProduction.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!/^"test\.[A-Za-z0-9_.-]+"/.test(line)) continue;
    const context = lines.slice(Math.max(0, index - 3), index).join("\n");
    if (!/#\[cfg\(feature\s*=\s*"runtime-test-methods"\)\]/.test(context)) {
      add("production-test-rpc", path, `unguarded test RPC route near line ${index + 1}`);
    }
  }
}

async function scanRepositoryConfiguration() {
  for (const deprecated of [
    "vitest.workspace.ts",
    "vitest.workspace.js",
    "vitest.workspace.mjs",
    "vitest.workspace.cjs"
  ]) {
    if (await exists(join(root, deprecated))) {
      add("deprecated-vitest-workspace", deprecated, "use Vitest projects configuration instead");
    }
  }
}

function forbid(path, source, rule, pattern) {
  if (pattern.test(source)) add(rule, path);
}

function add(rule, path, detail = "") {
  violations.push({ rule, path, detail });
}

async function walk(directory) {
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "target" || entry.name === "dist" || entry.name === "bin") {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await walk(path)));
    } else if (entry.isFile()) {
      result.push(path);
    }
  }
  return result;
}

function isAuthoredProductFile(path) {
  if (!TEXT_EXTENSIONS.has(extname(path))) return false;
  if (/(^|\/)tests?(\/|$)/.test(path)) return false;
  if (/\.(?:test|spec)\.[^.]+$/.test(path)) return false;
  if (path === "packages/dev-console/src/generated-html.ts") return false;
  return true;
}

function parseRoot(args) {
  if (args.length === 0) return DEFAULT_ROOT;
  if (args.length !== 2 || args[0] !== "--root" || !args[1]) {
    throw new Error("usage: node scripts/forbidden-patterns.mjs [--root <repository-root>]");
  }
  return resolve(args[1]);
}

function normalize(path) {
  return path.replaceAll("\\", "/");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
