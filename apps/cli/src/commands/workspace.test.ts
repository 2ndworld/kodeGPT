import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceTrustStore } from "@kodegpt/trust";

import { runWorkspaceCommand } from "./workspace.js";

const roots: string[] = [];

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kodegpt-cli-workspace-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local-only workspace trust CLI", () => {
  it("trusts only after local runtime inspection, then lists and untrusts", async () => {
    const root = await stateRoot();
    const store = new WorkspaceTrustStore(root);
    const inspected: string[] = [];
    const inspectRoot = async (path: string) => {
      inspected.push(path);
      return {
        canonicalRoot: "/tmp/kodegpt-cli-workspace",
        identity: { deviceMajor: 8, deviceMinor: 1, inode: "4444" }
      };
    };

    const trusted = await runWorkspaceCommand(
      ["trust", "/tmp/kodegpt-cli-workspace", "--ceiling", "develop"],
      { store, inspectRoot }
    );
    expect(inspected).toEqual(["/tmp/kodegpt-cli-workspace"]);
    expect(trusted).toContain("trusted");

    const listed = await runWorkspaceCommand(["list"], { store, inspectRoot });
    expect(listed).toContain("/tmp/kodegpt-cli-workspace");

    const entry = (await store.list())[0];
    expect(entry).toBeDefined();
    const removed = await runWorkspaceCommand(["untrust", entry!.id], { store, inspectRoot });
    expect(removed).toContain("untrusted");
    expect(await store.list()).toEqual([]);
  });

  it("rejects invalid profile ceilings before mutating trust", async () => {
    const root = await stateRoot();
    const store = new WorkspaceTrustStore(root);
    const inspectRoot = async () => ({
      canonicalRoot: "/tmp/kodegpt-cli-invalid",
      identity: { deviceMajor: 8, deviceMinor: 1, inode: "5555" }
    });

    await expect(
      runWorkspaceCommand(["trust", "/tmp/kodegpt-cli-invalid", "--ceiling", "admin"], {
        store,
        inspectRoot
      })
    ).rejects.toThrow(/ceiling/i);
    expect(await store.list()).toEqual([]);
  });
});
