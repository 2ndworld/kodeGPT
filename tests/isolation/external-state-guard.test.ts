import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

function runGuard(manifestPath: string) {
  return spawnSync(
    process.execPath,
    [join(process.cwd(), "tests/isolation/external-state-guard.mjs"), manifestPath],
    { encoding: "utf8" }
  );
}

describe("external-state guard", () => {
  test("detects a nested file byte change without a name change", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "kodegpt-guard-tree-"));
    const nested = join(fixtureRoot, "a", "b");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "payload.txt"), "before", "utf8");

    const manifestPath = join(fixtureRoot, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ entries: [{ type: "tree", path: fixtureRoot }] }),
      "utf8"
    );

    const before = runGuard(manifestPath);
    expect(before.status, before.stderr).toBe(0);

    await writeFile(join(nested, "payload.txt"), "after!", "utf8");

    const after = runGuard(manifestPath);
    expect(after.status, after.stderr).toBe(0);
    expect(JSON.parse(after.stdout).entries[0].fingerprint).not.toBe(
      JSON.parse(before.stdout).entries[0].fingerprint
    );
  });

  test("detects bytes changing in a protected file", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "kodegpt-guard-file-"));
    const protectedPath = join(fixtureRoot, "protected.txt");
    const manifestPath = join(fixtureRoot, "manifest.json");
    await writeFile(protectedPath, "alpha", "utf8");
    await writeFile(
      manifestPath,
      JSON.stringify({ entries: [{ type: "file", path: protectedPath }] }),
      "utf8"
    );

    const before = runGuard(manifestPath);
    expect(before.status, before.stderr).toBe(0);

    await writeFile(protectedPath, "omega", "utf8");

    const after = runGuard(manifestPath);
    expect(after.status, after.stderr).toBe(0);
    expect(JSON.parse(after.stdout).entries[0].fingerprint).not.toBe(
      JSON.parse(before.stdout).entries[0].fingerprint
    );
  });

  test("passively fingerprints a Linux TCP listener", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "kodegpt-guard-listener-"));
    const manifestPath = join(fixtureRoot, "manifest.json");
    const server = createServer();

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP address");
    }

    await writeFile(
      manifestPath,
      JSON.stringify({ entries: [{ type: "tcp_listener", port: address.port }] }),
      "utf8"
    );

    try {
      const listening = runGuard(manifestPath);
      expect(listening.status, listening.stderr).toBe(0);
      expect(JSON.parse(listening.stdout).entries[0].listening).toBe(true);

      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });

      const closed = runGuard(manifestPath);
      expect(closed.status, closed.stderr).toBe(0);
      expect(JSON.parse(closed.stdout).entries[0].listening).toBe(false);
      expect(JSON.parse(closed.stdout).entries[0].fingerprint).not.toBe(
        JSON.parse(listening.stdout).entries[0].fingerprint
      );
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });
});
