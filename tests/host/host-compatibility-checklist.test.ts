import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(REPOSITORY_ROOT, "scripts", "host-compatibility-checklist.mjs");
const roots: string[] = [];

function run(command: string, args: string[], cwd?: string) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
}

async function fixtureRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kodegpt-host-guard-"));
  roots.push(root);
  expect(run("git", ["init", "-q"], root).status).toBe(0);
  await writeFile(join(root, "tracked.txt"), "stable\n");
  expect(run("git", ["add", "tracked.txt"], root).status).toBe(0);
  expect(
    run(
      "git",
      ["-c", "user.name=KodeGPT Test", "-c", "user.email=kodegpt@example.invalid", "commit", "-qm", "fixture"],
      root
    ).status
  ).toBe(0);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("passive host compatibility guard", () => {
  it("captures and compares an unchanged repository without modifying its git state", async () => {
    const repository = await fixtureRepository();
    const before = join(tmpdir(), `kodegpt-host-before-${process.pid}-${Date.now()}.json`);
    const after = join(tmpdir(), `kodegpt-host-after-${process.pid}-${Date.now()}.json`);
    roots.push(before, after);
    const statusBefore = run("git", ["status", "--porcelain=v1", "--untracked-files=all"], repository).stdout;

    const first = run(process.execPath, [SCRIPT, "capture", "--pranikah-root", repository, "--output", before]);
    expect(first.status, first.stderr).toBe(0);
    const second = run(process.execPath, [SCRIPT, "capture", "--pranikah-root", repository, "--output", after]);
    expect(second.status, second.stderr).toBe(0);

    const snapBefore = JSON.parse(await readFile(before, "utf8")) as Record<string, unknown>;
    const snapAfter = JSON.parse(await readFile(after, "utf8")) as Record<string, unknown>;
    snapBefore.listenerDigest = snapAfter.listenerDigest;
    snapBefore.listenerCount = snapAfter.listenerCount;
    await writeFile(before, `${JSON.stringify(snapBefore, null, 2)}\n`);

    const compared = run(process.execPath, [SCRIPT, "compare", "--before", before, "--after", after]);
    expect(compared.status, compared.stderr).toBe(0);
    expect(compared.stdout).toContain("guard unchanged");

    const statusAfter = run("git", ["status", "--porcelain=v1", "--untracked-files=all"], repository).stdout;
    expect(statusAfter).toBe(statusBefore);
    const snapshot = JSON.parse(await readFile(before, "utf8")) as Record<string, unknown>;
    expect(snapshot).toMatchObject({ schemaVersion: 1, repositoryRoot: repository });
    expect(snapshot).not.toHaveProperty("trackedContents");
  });

  it("fails comparison when tracked repository content changes", async () => {
    const repository = await fixtureRepository();
    const before = join(tmpdir(), `kodegpt-host-change-before-${process.pid}-${Date.now()}.json`);
    const after = join(tmpdir(), `kodegpt-host-change-after-${process.pid}-${Date.now()}.json`);
    roots.push(before, after);

    expect(
      run(process.execPath, [SCRIPT, "capture", "--pranikah-root", repository, "--output", before]).status
    ).toBe(0);
    await writeFile(join(repository, "tracked.txt"), "changed\n");
    expect(
      run(process.execPath, [SCRIPT, "capture", "--pranikah-root", repository, "--output", after]).status
    ).toBe(0);

    const compared = run(process.execPath, [SCRIPT, "compare", "--before", before, "--after", after]);
    expect(compared.status).not.toBe(0);
    expect(compared.stderr).toContain("guard changed");
  });
});
