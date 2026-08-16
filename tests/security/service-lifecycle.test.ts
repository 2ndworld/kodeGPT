import { describe, expect, it } from "vitest";

import { formatServiceStatus } from "../../apps/cli/src/commands/service.js";
import type { ServiceMetadataV1, ServiceReleaseRecord } from "../../apps/cli/src/service/metadata.js";
import { renderKodegptUserUnit } from "../../apps/cli/src/service/systemd.js";
import { listSurfaceTools } from "../../packages/mcp-server/src/server.js";

function release(): ServiceReleaseRecord {
  const releaseId = `rel_${"a".repeat(32)}`;
  const releaseRoot = `/home/test/.local/share/kodegpt/service/releases/${releaseId}`;
  return {
    releaseId,
    packageVersion: "0.1.0",
    runtimePackage: "@kodegpt/runtime-linux-x64",
    cliSha256: "1".repeat(64),
    runtimeSha256: "2".repeat(64),
    releaseRoot,
    cliPath: `${releaseRoot}/bin/kodegpt.mjs`,
    runtimePath: `${releaseRoot}/node_modules/@kodegpt/runtime-linux-x64/bin/kodegpt-runtime`,
    nodePath: "/usr/bin/node",
    zrokPath: "/usr/local/bin/zrok2",
    reservedName: "public:kodegpt-dev",
    port: 43_121
  };
}

describe("stable local service security boundaries", () => {
  it("keeps service lifecycle completely outside the MCP tool inventory", () => {
    const names = listSurfaceTools().map(({ name }) => name);
    for (const forbidden of [
      "service.install",
      "service.start",
      "service.stop",
      "service.restart",
      "service.status",
      "service.uninstall",
      "skill.run",
      "provider.list",
      "provider.tools",
      "provider.invoke",
      "shell.run"
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("renders a bounded user unit without credential-bearing configuration or shell execution", () => {
    const unit = renderKodegptUserUnit(release(), "/home/test/.kodegpt");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).not.toContain("--force-local");
    for (const forbidden of [
      "connectorToken",
      "connectorVerifier",
      "credentialMaterial",
      "zrokSecret",
      "Authorization=",
      "EnvironmentFile=",
      "bash -c",
      "sh -c",
      "Restart=always"
    ]) {
      expect(unit).not.toContain(forbidden);
    }
  });

  it("keeps persisted metadata and operator status limited to sanitized identity fields", () => {
    const item = release();
    const metadata: ServiceMetadataV1 = {
      schemaVersion: 1,
      unitName: "kodegpt.service",
      activeReleaseId: item.releaseId,
      releases: { [item.releaseId]: item }
    };
    const metadataJson = JSON.stringify(metadata);
    const status = formatServiceStatus({
      installed: true,
      state: "running",
      enabled: true,
      linger: "disabled",
      packageVersion: "0.1.0",
      activeReleaseId: item.releaseId,
      runtimeVersion: "0.1",
      protocolVersion: "2026-07-28",
      surfaceVersion: "0.4",
      localPort: 43_121,
      listenerReady: true,
      managedExposure: true,
      reservedName: item.reservedName,
      publicUrl: "https://kodegpt.example.invalid/mcp"
    }, true);

    for (const serialized of [metadataJson, status]) {
      for (const forbidden of [
        "connectorToken",
        "connectorVerifier",
        "credentialMaterial",
        "zrokSecret",
        "rawZrok",
        "process.env"
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  });
});
