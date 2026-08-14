import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ServiceMetadataStore, type ServiceReleaseRecord } from "../service/metadata.js";
import { ServiceRuntimeStatusStore } from "../service/runtime-status.js";
import type { SystemdUserManager } from "../service/systemd.js";
import { installService, type ServiceOperatorDependencies } from "./service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("service install release identity collision", () => {
  it("rejects conflicting metadata before mutating the staged unit", async () => {
    const root = await mkdtemp(join(tmpdir(), "kodegpt-service-install-collision-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const serviceDataRoot = join(root, "service-data");
    const unitPath = join(root, "systemd", "kodegpt.service");
    const releaseId = `rel_${"a".repeat(32)}`;
    const releaseRoot = join(serviceDataRoot, "releases", releaseId);
    const release: ServiceReleaseRecord = {
      releaseId,
      packageVersion: "0.1.0",
      runtimePackage: "@kodegpt/runtime-linux-x64",
      cliSha256: "1".repeat(64),
      runtimeSha256: "2".repeat(64),
      releaseRoot,
      cliPath: join(releaseRoot, "bin", "kodegpt.mjs"),
      runtimePath: join(releaseRoot, "node_modules", "@kodegpt", "runtime-linux-x64", "bin", "kodegpt-runtime"),
      nodePath: "/usr/bin/node",
      zrokPath: "/usr/local/bin/zrok2",
      reservedName: "public:kodegpt-dev",
      port: 43_121
    };
    let prepared = release;
    const manager: SystemdUserManager = {
      daemonReload: async () => undefined,
      enable: async () => undefined,
      disable: async () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      restart: async () => undefined,
      resetFailed: async () => undefined,
      show: async () => ({
        loadState: "loaded",
        activeState: "inactive",
        subState: "dead",
        unitFileState: "enabled"
      }),
      linger: async () => "disabled"
    };
    const metadataStore = new ServiceMetadataStore(stateRoot);
    const dependencies: ServiceOperatorDependencies = {
      metadataStore,
      runtimeStatusStore: new ServiceRuntimeStatusStore(stateRoot),
      manager,
      serviceDataRoot,
      unitPath,
      prepareRelease: async () => prepared,
      waitForReady: async () => {
        throw new Error("not used");
      }
    };

    await installService(
      {
        command: "install",
        stateRoot,
        name: release.reservedName,
        port: release.port
      },
      dependencies
    );
    const originalUnit = await readFile(unitPath, "utf8");

    prepared = { ...release, port: 43_122 };
    await expect(
      installService(
        {
          command: "install",
          stateRoot,
          name: release.reservedName,
          port: 43_122
        },
        dependencies
      )
    ).rejects.toThrow(/release identity already exists with different metadata/);

    expect(await readFile(unitPath, "utf8")).toBe(originalUnit);
    const metadata = await metadataStore.read();
    expect(metadata.stagedReleaseId).toBe(release.releaseId);
    expect(metadata.releases[release.releaseId]).toEqual(release);
  });
});
