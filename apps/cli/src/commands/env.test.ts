import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DeveloperEnvironmentStore } from "@kodegpt/core";

import { runEnvCommand } from "./env.js";

const roots: string[] = [];

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `kodegpt-cli-env-${label}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local-only developer environment CLI", () => {
  it("adds with bin by default, lists, diagnoses, and removes without a runtime dependency", async () => {
    const stateRoot = await temporaryRoot("state");
    const toolRoot = await temporaryRoot("tool");
    const bin = join(toolRoot, "bin");
    await mkdir(bin, { mode: 0o755 });
    const executable = join(bin, "fixture-tool");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(executable, 0o755);

    const store = new DeveloperEnvironmentStore(stateRoot);
    const dependencies = {
      store,
      trustedWorkspaceRoots: [],
      pathValue: "/usr/bin:/bin"
    };

    const added = await runEnvCommand(["add", toolRoot], dependencies);
    expect(added).toMatch(/^added denv_[a-f0-9]{32}\t/);
    expect(added).toContain("exec=bin");

    const listed = await runEnvCommand(["list"], dependencies);
    expect(listed).toContain(toolRoot);
    expect(listed).toContain("available");
    expect(listed).toContain("exec=bin");

    const diagnosed = await runEnvCommand(["doctor", "fixture-tool"], dependencies);
    expect(diagnosed).toContain("fixture-tool");
    expect(diagnosed).toContain("available");
    expect(diagnosed).not.toContain("executed");

    const [entry] = await store.list();
    expect(entry).toBeDefined();
    const removed = await runEnvCommand(["remove", entry!.id], dependencies);
    expect(removed).toBe(`removed ${entry!.id}`);
    expect(await runEnvCommand(["list"], dependencies)).toBe("no developer environments");
  });

  it("syncs the provided PATH snapshot once and stores each safe candidate as dot", async () => {
    const stateRoot = await temporaryRoot("sync-state");
    const first = await temporaryRoot("sync-first");
    const second = await temporaryRoot("sync-second");
    const store = new DeveloperEnvironmentStore(stateRoot);

    const output = await runEnvCommand(["sync"], {
      store,
      trustedWorkspaceRoots: [],
      pathValue: [first, "/usr/bin", second].join(":")
    });
    expect(output).toBe("synced 2 developer environments");
    expect((await store.list()).map((entry) => entry.executableDirs)).toEqual([["."], ["."]]);
  });

  it("supports an explicit relative executable directory and rejects ambiguous arguments", async () => {
    const stateRoot = await temporaryRoot("explicit-state");
    const toolRoot = await temporaryRoot("explicit-tool");
    await mkdir(join(toolRoot, "tools"), { mode: 0o755 });
    const store = new DeveloperEnvironmentStore(stateRoot);
    const dependencies = { store, trustedWorkspaceRoots: [], pathValue: "" };

    await runEnvCommand(["add", toolRoot, "--exec-dir", "tools"], dependencies);
    expect((await store.list())[0]?.executableDirs).toEqual(["tools"]);

    await expect(runEnvCommand(["add"], dependencies)).rejects.toThrow(/root/i);
    await expect(runEnvCommand(["add", toolRoot, "--wat", "tools"], dependencies)).rejects.toThrow(/exec-dir/i);
    await expect(runEnvCommand(["sync", "extra"], dependencies)).rejects.toThrow(/arguments/i);
    await expect(runEnvCommand(["list", "extra"], dependencies)).rejects.toThrow(/arguments/i);
    await expect(runEnvCommand(["remove"], dependencies)).rejects.toThrow(/id/i);
    await expect(runEnvCommand(["doctor", "a", "b"], dependencies)).rejects.toThrow(/executable/i);
    await expect(runEnvCommand(["wat"], dependencies)).rejects.toThrow(/sync, add, list, remove, doctor/i);
  });

  it("passes trusted workspace roots into add and sync authority checks", async () => {
    const stateRoot = await temporaryRoot("workspace-state");
    const workspace = await temporaryRoot("workspace");
    const toolRoot = join(workspace, "toolchain");
    await mkdir(join(toolRoot, "bin"), { recursive: true, mode: 0o755 });
    const store = new DeveloperEnvironmentStore(stateRoot);
    const dependencies = {
      store,
      trustedWorkspaceRoots: [workspace],
      pathValue: join(toolRoot, "bin")
    };

    await expect(runEnvCommand(["add", toolRoot], dependencies)).rejects.toMatchObject({
      code: "DEV_ENV_ROOT_INSIDE_WORKSPACE"
    });
    expect(await runEnvCommand(["sync"], dependencies)).toBe("synced 0 developer environments");
  });
});
