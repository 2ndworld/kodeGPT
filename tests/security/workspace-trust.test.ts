import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runWorkspaceCommand } from "../../apps/cli/src/commands/workspace.js";
import { KernelClient } from "../../packages/core/src/kernel-client.js";
import {
  WorkspaceIdentityChangedError,
  WorkspaceTrustStore,
  type PersistentFilesystemIdentity
} from "../../packages/trust/src/index.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TARGET_DIR = join(REPOSITORY_ROOT, "target", "task5-runtime");
const RUNTIME_PATH = join(TARGET_DIR, "debug", "kodegpt-runtime");
const temporaryRoots: string[] = [];

interface InspectRootResult {
  canonicalRoot: string;
  identity: PersistentFilesystemIdentity;
}

function buildRuntime(): void {
  const result = spawnSync(
    "cargo",
    ["build", "-p", "kodegpt-runtime", "--target-dir", TARGET_DIR],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

beforeAll(() => buildRuntime(), 60_000);

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("trusted workspace persistent identity", () => {
  it("detects replacement of the same pathname using runtime device/inode identity", async () => {
    const stateRoot = await temporaryRoot("kodegpt-task5-state-");
    const workspaceParent = await temporaryRoot("kodegpt-task5-workspace-");
    const workspace = join(workspaceParent, "project");
    const displaced = join(workspaceParent, "project-old");
    await mkdir(workspace);

    const client = await KernelClient.start({ runtimePath: RUNTIME_PATH, stateRoot });
    const store = new WorkspaceTrustStore(stateRoot);
    const inspectRoot = (path: string) =>
      client.request<InspectRootResult>("system.inspect_root", { path });

    try {
      const trusted = await runWorkspaceCommand(
        ["trust", workspace, "--ceiling", "develop"],
        { store, inspectRoot }
      );
      expect(trusted).toContain("trusted");

      const initial = await inspectRoot(workspace);
      expect(initial).not.toHaveProperty("capabilityId");
      const entry = await store.requireTrusted(initial.canonicalRoot, initial.identity);
      expect(entry.profileCeiling).toBe("develop");

      await rename(workspace, displaced);
      await mkdir(workspace);
      const replacement = await inspectRoot(workspace);
      expect(replacement.canonicalRoot).toBe(initial.canonicalRoot);
      expect(replacement.identity).not.toEqual(initial.identity);

      await expect(
        store.requireTrusted(replacement.canonicalRoot, replacement.identity)
      ).rejects.toBeInstanceOf(WorkspaceIdentityChangedError);
      await expect(
        store.requireTrusted(replacement.canonicalRoot, replacement.identity)
      ).rejects.toMatchObject({ code: "WORKSPACE_IDENTITY_CHANGED" });
    } finally {
      await client.stop();
    }
  }, 15_000);
});
