import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import process from "node:process";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function entryType(stat) {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  if (stat.isSymbolicLink()) return "symlink";
  return "other";
}

async function fingerprintTree(root) {
  const records = [];

  async function visit(path) {
    const stat = await lstat(path);
    const type = entryType(stat);
    const record = {
      path: path === root ? "." : relative(root, path),
      type,
      mode: stat.mode & 0o7777,
      size: stat.size
    };

    if (type === "file") {
      record.sha256 = sha256(await readFile(path));
    } else if (type === "symlink") {
      record.target = await readlink(path);
    }

    records.push(record);

    if (type === "directory") {
      const children = await readdir(path);
      children.sort((a, b) => a.localeCompare(b));
      for (const child of children) {
        await visit(join(path, child));
      }
    }
  }

  await visit(root);
  records.sort((a, b) => a.path.localeCompare(b.path));
  return {
    fingerprint: sha256(JSON.stringify(records)),
    entryCount: records.length
  };
}

async function fingerprintFile(path) {
  const stat = await lstat(path);
  const type = entryType(stat);
  const record = {
    type,
    mode: stat.mode & 0o7777,
    size: stat.size
  };

  if (type === "file") {
    record.sha256 = sha256(await readFile(path));
  } else if (type === "symlink") {
    record.target = await readlink(path);
  }

  return {
    fingerprint: sha256(JSON.stringify(record))
  };
}

async function readTcpListeners(procPath, family, port) {
  let text;
  try {
    text = await readFile(procPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const expectedPort = port.toString(16).toUpperCase().padStart(4, "0");
  const rows = [];

  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== "0A") continue;

    const [localAddress, localPort] = fields[1].split(":");
    if (localPort !== expectedPort) continue;

    rows.push({
      family,
      localAddress,
      port,
      inode: fields[9]
    });
  }

  return rows;
}

async function fingerprintTcpListener(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`INVALID_TCP_LISTENER_PORT:${String(port)}`);
  }

  const rows = [
    ...(await readTcpListeners("/proc/net/tcp", "ipv4", port)),
    ...(await readTcpListeners("/proc/net/tcp6", "ipv6", port))
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  return {
    fingerprint: sha256(JSON.stringify(rows)),
    listening: rows.length > 0
  };
}

async function fingerprintEntry(entry) {
  if (entry?.type === "tree" && typeof entry.path === "string") {
    return {
      type: "tree",
      path: entry.path,
      ...(await fingerprintTree(entry.path))
    };
  }

  if (entry?.type === "file" && typeof entry.path === "string") {
    return {
      type: "file",
      path: entry.path,
      ...(await fingerprintFile(entry.path))
    };
  }

  if (entry?.type === "tcp_listener") {
    return {
      type: "tcp_listener",
      port: entry.port,
      ...(await fingerprintTcpListener(entry.port))
    };
  }

  throw new Error(`UNSUPPORTED_GUARD_ENTRY:${String(entry?.type)}`);
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    throw new Error(`USAGE:${basename(process.argv[1])} <manifest.json>`);
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Array.isArray(manifest.entries)) {
    throw new Error("INVALID_GUARD_MANIFEST:entries");
  }

  const entries = [];
  for (const entry of manifest.entries) {
    entries.push(await fingerprintEntry(entry));
  }

  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, entries })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
