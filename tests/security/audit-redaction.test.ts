import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditReader } from "../../packages/audit/src/audit-reader.js";
import { KernelClient } from "../../packages/core/src/kernel-client.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FEATURE_TARGET = join(REPOSITORY_ROOT, "target", "task18-feature");
const FEATURE_RUNTIME = join(FEATURE_TARGET, "debug", "kodegpt-runtime");
const temporaryRoots: string[] = [];

function buildRuntime(): void {
  const result = spawnSync(
    "cargo",
    [
      "build",
      "-p",
      "kodegpt-runtime",
      "--features",
      "runtime-test-methods",
      "--target-dir",
      FEATURE_TARGET
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function runtimeWrapper(root: string, variables: Record<string, string>): Promise<string> {
  const path = join(root, "runtime-wrapper.sh");
  const exports = Object.entries(variables)
    .map(([name, value]) => `export ${name}=${shellQuote(value)}`)
    .join("\n");
  await writeFile(path, `#!/bin/sh\n${exports}\nexec ${shellQuote(FEATURE_RUNTIME)}\n`, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

beforeAll(() => buildRuntime(), 60_000);

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("audit end-to-end redaction", () => {
  it("never persists connector, environment, or argv secrets and exposes only public correlation IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "kodegpt-audit-redaction-"));
    temporaryRoots.push(root);
    const connectorToken = ["connector", "token", "fixture", "971"].join("-");
    const environmentSecret = ["environment", "secret", "fixture", "883"].join("-");
    const argvMarker = ["SUPER", "SECRET", "MARKER", "123"].join("_");
    const runtimePath = await runtimeWrapper(root, {
      KODEGPT_CONNECTOR_TOKEN: connectorToken,
      KODEGPT_ENV_SECRET_FIXTURE: environmentSecret
    });
    const client = await KernelClient.start({
      runtimePath,
      stateRoot: root,
      enableTestMethods: true
    });

    try {
      await expect(
        client.request(
          "process.run",
          {
            capabilityId: "kc_missing_private",
            logicalExecutable: "python3",
            argv: [argvMarker],
            cwd: ".",
            env: { KODEGPT_ENV_SECRET_FIXTURE: environmentSecret },
            background: false
          },
          "req_audit_redaction"
        )
      ).rejects.toBeDefined();
    } finally {
      await client.stop();
    }

    const serialized = await readFile(join(root, "logs/security/audit.jsonl"), "utf8");
    for (const secret of [connectorToken, environmentSecret, argvMarker]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("req_audit_redaction");
    expect(serialized).toContain("process_run");

    const diagnostics = await new AuditReader(root).readRecentAuditEvents(20);
    const correlated = diagnostics.filter((event) => event.requestId === "req_audit_redaction");
    expect(correlated).toHaveLength(2);
    expect(correlated.every((event) => event.operationId.startsWith("op_"))).toBe(true);
    const publicJson = JSON.stringify(correlated);
    expect(publicJson).not.toContain("kc_missing_private");
    expect(publicJson).not.toContain("ex_");
  });
});
