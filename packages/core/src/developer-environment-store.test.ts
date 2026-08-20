import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DeveloperEnvironmentError,
  DeveloperEnvironmentStore
} from "./developer-environment-store.js";

const roots: string[] = [];

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `kodegpt-dev-env-${label}-`));
  roots.push(root);
  return root;
}

async function safeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o755 });
  await chmod(path, 0o755);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DeveloperEnvironmentStore", () => {
  it("persists a closed schema-v1 private registry and round-trips entries", async () => {
    const stateRoot = await temporaryRoot("persist-state");
    const toolchain = await temporaryRoot("persist-toolchain");
    await safeDirectory(join(toolchain, "bin"));

    const store = new DeveloperEnvironmentStore(stateRoot);
    const added = await store.add({
      root: toolchain,
      executableDirs: ["bin"],
      label: "fixture toolchain",
      source: "operator",
      trustedWorkspaceRoots: []
    });

    expect(added.id).toMatch(/^denv_[a-f0-9]{32}$/);
    expect(added).toMatchObject({
      label: "fixture toolchain",
      source: "operator",
      canonicalRoot: toolchain,
      executableDirs: ["bin"]
    });
    expect(added.identity.inode).toMatch(/^\d+$/);
    expect(await new DeveloperEnvironmentStore(stateRoot).list()).toEqual([added]);

    const registryPath = join(stateRoot, "developer-environments", "registry.json");
    const document = JSON.parse(await readFile(registryPath, "utf8")) as Record<string, unknown>;
    expect(document).toMatchObject({ schemaVersion: 1, entries: [added] });
    expect((await stat(registryPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects roots overlapping KodeGPT state or a trusted workspace", async () => {
    const stateRoot = await temporaryRoot("overlap-state");
    const workspace = await temporaryRoot("overlap-workspace");
    const store = new DeveloperEnvironmentStore(stateRoot);

    await safeDirectory(join(stateRoot, "inside"));
    await safeDirectory(join(workspace, "toolchain"));

    await expect(
      store.add({
        root: join(stateRoot, "inside"),
        executableDirs: ["."],
        label: "inside state",
        source: "operator",
        trustedWorkspaceRoots: [workspace]
      })
    ).rejects.toMatchObject({ code: "DEV_ENV_ROOT_INSIDE_STATE" });

    await expect(
      store.add({
        root: join(workspace, "toolchain"),
        executableDirs: ["."],
        label: "inside workspace",
        source: "operator",
        trustedWorkspaceRoots: [workspace]
      })
    ).rejects.toMatchObject({ code: "DEV_ENV_ROOT_INSIDE_WORKSPACE" });
  });

  it("syncPath stores safe PATH directories themselves and skips invalid candidates", async () => {
    const stateRoot = await temporaryRoot("sync-state");
    const first = await temporaryRoot("sync-first");
    const second = await temporaryRoot("sync-second");
    const unsafe = await temporaryRoot("sync-unsafe");
    await chmod(unsafe, 0o777);

    const store = new DeveloperEnvironmentStore(stateRoot);
    const synced = await store.syncPath(
      [first, "/usr/bin", "/definitely/missing/kodegpt", unsafe, second, first].join(":"),
      []
    );

    expect(synced).toHaveLength(2);
    expect(synced.map((entry) => entry.canonicalRoot)).toEqual([first, second]);
    expect(synced.every((entry) => entry.source === "synced-shell")).toBe(true);
    expect(synced.every((entry) => entry.executableDirs.length === 1 && entry.executableDirs[0] === ".")).toBe(true);
  });

  it("keeps generated PATH labels within registry bounds even for long roots", async () => {
    const stateRoot = await temporaryRoot("long-label-state");
    const parent = await temporaryRoot("long-label-parent");
    const longRoot = join(parent, "x".repeat(110));
    await safeDirectory(longRoot);

    const store = new DeveloperEnvironmentStore(stateRoot);
    await store.syncPath(longRoot, []);

    const [entry] = await new DeveloperEnvironmentStore(stateRoot).list();
    expect(entry).toBeDefined();
    expect(Buffer.byteLength(entry!.label, "utf8")).toBeLessThanOrEqual(120);
  });

  it("rejects unsafe permissions and validates stored identity on read", async () => {
    const stateRoot = await temporaryRoot("identity-state");
    const unsafe = await temporaryRoot("identity-unsafe");
    await chmod(unsafe, 0o777);
    const store = new DeveloperEnvironmentStore(stateRoot);

    await expect(
      store.add({
        root: unsafe,
        executableDirs: ["."],
        label: "unsafe",
        source: "operator",
        trustedWorkspaceRoots: []
      })
    ).rejects.toBeInstanceOf(DeveloperEnvironmentError);

    const safe = await temporaryRoot("identity-safe");
    const added = await store.add({
      root: safe,
      executableDirs: ["."],
      label: "safe",
      source: "operator",
      trustedWorkspaceRoots: []
    });
    expect((await store.list())[0]?.identity).toEqual(added.identity);

    const registryPath = join(stateRoot, "developer-environments", "registry.json");
    const document = JSON.parse(await readFile(registryPath, "utf8")) as {
      schemaVersion: number;
      entries: Array<{ identity: { inode: string } }>;
    };
    document.entries[0]!.identity.inode = "999999999999";
    await writeFile(registryPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });

    await expect(store.list()).rejects.toMatchObject({ code: "DEV_ENV_ROOT_CHANGED" });
  });

  it("diagnoses entry health and executable availability without executing the tool", async () => {
    const stateRoot = await temporaryRoot("diagnose-state");
    const toolchain = await temporaryRoot("diagnose-toolchain");
    const bin = join(toolchain, "bin");
    await safeDirectory(bin);
    const executable = join(bin, "fixture-tool");
    await writeFile(executable, "#!/bin/sh\nexit 91\n", { mode: 0o755 });
    await chmod(executable, 0o755);

    const store = new DeveloperEnvironmentStore(stateRoot);
    await store.add({
      root: toolchain,
      executableDirs: ["bin"],
      label: "diagnostic fixture",
      source: "operator",
      trustedWorkspaceRoots: []
    });

    const [healthy] = await store.diagnose("fixture-tool");
    expect(healthy).toMatchObject({
      status: "available",
      mountAvailable: true,
      executable: { name: "fixture-tool", status: "available" }
    });

    await chmod(toolchain, 0o777);
    const [unsafe] = await store.diagnose("fixture-tool");
    expect(unsafe).toMatchObject({
      status: "unsafe",
      mountAvailable: false,
      executable: { name: "fixture-tool", status: "unavailable" }
    });
  });

  it("diagnose reports identity drift per entry instead of failing the whole registry", async () => {
    const stateRoot = await temporaryRoot("diagnose-drift-state");
    const toolchain = await temporaryRoot("diagnose-drift-toolchain");
    const store = new DeveloperEnvironmentStore(stateRoot);
    await store.add({
      root: toolchain,
      executableDirs: ["."],
      label: "drift fixture",
      source: "operator",
      trustedWorkspaceRoots: []
    });

    const registryPath = join(stateRoot, "developer-environments", "registry.json");
    const document = JSON.parse(await readFile(registryPath, "utf8")) as {
      schemaVersion: number;
      entries: Array<{ identity: { inode: string } }>;
    };
    document.entries[0]!.identity.inode = "999999999999";
    await writeFile(registryPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });

    const [diagnostic] = await store.diagnose();
    expect(diagnostic).toMatchObject({ status: "changed", mountAvailable: false });
  });

  it("rejects executable directories that cannot be represented safely in PATH", async () => {
    const stateRoot = await temporaryRoot("path-separator-state");
    const toolchain = await temporaryRoot("path-separator-toolchain");
    await safeDirectory(join(toolchain, "bin:alt"));
    const store = new DeveloperEnvironmentStore(stateRoot);

    await expect(
      store.add({
        root: toolchain,
        executableDirs: ["bin:alt"],
        label: "unsafe PATH entry",
        source: "operator",
        trustedWorkspaceRoots: []
      })
    ).rejects.toMatchObject({ code: "DEV_ENV_REGISTRY_INVALID" });
  });

  it("bounds registry entries and executable directories", async () => {
    const stateRoot = await temporaryRoot("bounds-state");
    const store = new DeveloperEnvironmentStore(stateRoot);
    const toolchain = await temporaryRoot("bounds-toolchain");

    await expect(
      store.add({
        root: toolchain,
        executableDirs: ["a", "b", "c", "d", "e"],
        label: "too many dirs",
        source: "operator",
        trustedWorkspaceRoots: []
      })
    ).rejects.toMatchObject({ code: "DEV_ENV_LIMIT_EXCEEDED" });

    for (let index = 0; index < 32; index += 1) {
      const root = await temporaryRoot(`bounds-${index}`);
      await store.add({
        root,
        executableDirs: ["."],
        label: `fixture-${index}`,
        source: "operator",
        trustedWorkspaceRoots: []
      });
    }
    const overflow = await temporaryRoot("bounds-overflow");
    await expect(
      store.add({
        root: overflow,
        executableDirs: ["."],
        label: "overflow",
        source: "operator",
        trustedWorkspaceRoots: []
      })
    ).rejects.toMatchObject({ code: "DEV_ENV_LIMIT_EXCEEDED" });
  });

  it("ensureBootstrap is idempotent and preserves operator entries", async () => {
    const stateRoot = await temporaryRoot("bootstrap-state");
    const nodeRoot = await temporaryRoot("bootstrap-node");
    const rustRoot = await temporaryRoot("bootstrap-rust");
    const operatorRoot = await temporaryRoot("bootstrap-operator");
    await safeDirectory(join(nodeRoot, "bin"));
    await safeDirectory(join(rustRoot, "bin"));

    const store = new DeveloperEnvironmentStore(stateRoot);
    const operator = await store.add({
      root: operatorRoot,
      executableDirs: ["."],
      label: "operator",
      source: "operator",
      trustedWorkspaceRoots: []
    });

    await store.ensureBootstrap({ nodeRoot, rustRoot, trustedWorkspaceRoots: [] });
    const once = await store.list();
    await store.ensureBootstrap({ nodeRoot, rustRoot, trustedWorkspaceRoots: [] });
    const twice = await store.list();

    expect(twice).toEqual(once);
    expect(twice).toContainEqual(operator);
    expect(twice.filter((entry) => entry.source === "bootstrap")).toHaveLength(2);
    expect(twice.map((entry) => entry.label)).toEqual([
      "operator",
      "Node runtime",
      "Rust stable toolchain"
    ]);
  });
});
