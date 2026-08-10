import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SNAPSHOT_SCHEMA_VERSION = 1;
const LISTEN_TCP_STATE = "0A";

async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  switch (command) {
    case "capture":
      await captureCommand(rest);
      return;
    case "compare":
      await compareCommand(rest);
      return;
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(helpText());
      return;
    default:
      throw new Error(`unknown host compatibility checklist command: ${String(command)}`);
  }
}

async function captureCommand(args) {
  const options = parseNamedOptions(args, ["--pranikah-root", "--output"]);
  const inputRoot = requiredAbsolutePath(options, "--pranikah-root");
  const output = requiredAbsolutePath(options, "--output");
  const repositoryRoot = await canonicalRepositoryRoot(inputRoot);
  assertOutputOutsideRepository(repositoryRoot, output);

  const snapshot = await captureSnapshot(repositoryRoot);
  await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  process.stdout.write(`guard captured ${output}\n`);
}

async function compareCommand(args) {
  const options = parseNamedOptions(args, ["--before", "--after"]);
  const beforePath = requiredAbsolutePath(options, "--before");
  const afterPath = requiredAbsolutePath(options, "--after");
  const [before, after] = await Promise.all([
    readSnapshot(beforePath),
    readSnapshot(afterPath)
  ]);

  const fields = [
    "repositoryRoot",
    "head",
    "statusDigest",
    "trackedStateDigest",
    "listenerDigest",
    "listenerCount"
  ];
  const changed = fields.filter((field) => before[field] !== after[field]);
  if (changed.length > 0) {
    throw new Error(`guard changed: ${changed.join(", ")}`);
  }
  process.stdout.write("guard unchanged\n");
}

async function captureSnapshot(repositoryRoot) {
  const head = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(head)) {
    throw new Error("protected repository HEAD is unavailable or invalid");
  }

  const status = gitBuffer(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "-z"
  ]);
  const trackedIndex = gitBuffer(repositoryRoot, ["ls-files", "--stage", "-z"]);
  const trackedDiff = gitBuffer(repositoryRoot, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "HEAD",
    "--"
  ]);
  const listenerState = await tcpListenerState();

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    repositoryRoot,
    head,
    statusDigest: sha256(status),
    trackedStateDigest: sha256(Buffer.concat([trackedIndex, Buffer.from([0]), trackedDiff])),
    listenerDigest: sha256(Buffer.from(listenerState.lines.join("\n"), "utf8")),
    listenerCount: listenerState.lines.length
  };
}

async function readSnapshot(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`guard snapshot could not be read: ${path}`, { cause: error });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    parsed.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
    typeof parsed.repositoryRoot !== "string" ||
    typeof parsed.head !== "string" ||
    typeof parsed.statusDigest !== "string" ||
    typeof parsed.trackedStateDigest !== "string" ||
    typeof parsed.listenerDigest !== "string" ||
    !Number.isSafeInteger(parsed.listenerCount) ||
    parsed.listenerCount < 0
  ) {
    throw new Error(`guard snapshot schema is invalid: ${path}`);
  }
  return parsed;
}

async function canonicalRepositoryRoot(inputRoot) {
  const canonicalInput = await realpath(inputRoot);
  await access(canonicalInput, constants.R_OK | constants.X_OK);
  const root = git(canonicalInput, ["rev-parse", "--show-toplevel"]).trim();
  if (root.length === 0) {
    throw new Error("protected path is not inside a Git repository");
  }
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== canonicalInput) {
    throw new Error("--pranikah-root must name the repository root exactly");
  }
  return canonicalRoot;
}

function assertOutputOutsideRepository(repositoryRoot, outputPath) {
  const absoluteOutput = resolve(outputPath);
  const relation = relative(repositoryRoot, absoluteOutput);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    throw new Error("guard output must stay outside the protected repository");
  }
}

async function tcpListenerState() {
  const tables = await Promise.all([
    readProcTcp("/proc/net/tcp", "tcp4"),
    readProcTcp("/proc/net/tcp6", "tcp6")
  ]);
  const lines = tables.flat().sort();
  return { lines };
}

async function readProcTcp(path, family) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const result = [];
  for (const line of source.split("\n").slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4 || columns[3] !== LISTEN_TCP_STATE) continue;
    const local = columns[1];
    if (typeof local === "string" && local.length > 0) {
      result.push(`${family}:${local.toUpperCase()}`);
    }
  }
  return result;
}

function git(repositoryRoot, args) {
  return gitBuffer(repositoryRoot, args).toString("utf8");
}

function gitBuffer(repositoryRoot, args) {
  const result = spawnSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0"
    }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`passive git probe failed: git ${args.join(" ")}`);
  }
  return result.stdout;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseNamedOptions(args, allowed) {
  const allowedSet = new Set(allowed);
  const result = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowedSet.has(flag) || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid checklist option near ${String(flag)}`);
    }
    if (result.has(flag)) {
      throw new Error(`duplicate checklist option: ${flag}`);
    }
    result.set(flag, value);
  }
  return result;
}

function requiredAbsolutePath(options, flag) {
  const value = options.get(flag);
  if (value === undefined) throw new Error(`${flag} is required`);
  if (!isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
  return value;
}

function helpText() {
  return [
    "KodeGPT passive host/isolation checklist",
    "  capture --pranikah-root <absolute-repo-root> --output <absolute-json-outside-repo>",
    "  compare --before <absolute-json> --after <absolute-json>",
    "",
    "The capture command is read-only with respect to the protected repository.",
    "It stores only digests/metadata and passive TCP listener state in the output file.",
    ""
  ].join("\n");
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
