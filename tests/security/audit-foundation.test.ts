import { spawnSync } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { KernelClient, KernelRpcError } from "../../packages/core/src/kernel-client.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FEATURE_TARGET = join(REPOSITORY_ROOT, "target", "task4-feature");
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

async function stateRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function runtimeWrapper(root: string, variables: Record<string, string>): Promise<string> {
  const path = join(root, "audit-runtime-wrapper.sh");
  const exports = Object.entries(variables)
    .map(([name, value]) => `export ${name}=${shellQuote(value)}`)
    .join("\n");
  await writeFile(path, `#!/bin/sh\n${exports}\nexec ${shellQuote(FEATURE_RUNTIME)}\n`, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function expectAuditUnavailable(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(KernelRpcError);
  await expect(promise).rejects.toMatchObject({ message: "AUDIT_UNAVAILABLE" });
}

beforeAll(() => buildRuntime(), 60_000);

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable fail-closed audit foundation", () => {
  it("keeps diagnostics available but blocks OS effects when audit initialization is unavailable", async () => {
    const root = await stateRoot("kodegpt-audit-unavailable-");
    await writeFile(join(root, "logs"), "directory collision");
    const marker = join(root, "must-not-exist.marker");
    const client = await KernelClient.start({
      runtimePath: FEATURE_RUNTIME,
      stateRoot: root,
      enableTestMethods: true
    });

    try {
      expect((await client.hello()).auditHealthy).toBe(false);
      await expectAuditUnavailable(
        client.request("test.audit_effect", { markerPath: marker }, "req_audit_unavailable")
      );
      expect(await exists(marker)).toBe(false);
    } finally {
      await client.stop();
    }
  });

  it("persists the allow decision before the effect and prevents the marker on injected decision failure", async () => {
    const root = await stateRoot("kodegpt-audit-decision-");
    const runtimePath = await runtimeWrapper(root, {
      KODEGPT_RUNTIME_TEST_AUDIT_FAIL_DECISION: "1"
    });
    const marker = join(root, "decision.marker");
    const client = await KernelClient.start({
      runtimePath,
      stateRoot: root,
      enableTestMethods: true
    });

    try {
      await expectAuditUnavailable(
        client.request("test.audit_effect", { markerPath: marker }, "req_audit_decision")
      );
      expect(await exists(marker)).toBe(false);
      expect((await client.hello()).auditHealthy).toBe(false);
    } finally {
      await client.stop();
    }
  });

  it("poisons future effects after an injected outcome persistence failure", async () => {
    const root = await stateRoot("kodegpt-audit-outcome-");
    const runtimePath = await runtimeWrapper(root, {
      KODEGPT_RUNTIME_TEST_AUDIT_FAIL_OUTCOME: "1"
    });
    const firstMarker = join(root, "first.marker");
    const secondMarker = join(root, "second.marker");
    const client = await KernelClient.start({
      runtimePath,
      stateRoot: root,
      enableTestMethods: true
    });

    try {
      await expectAuditUnavailable(
        client.request("test.audit_effect", { markerPath: firstMarker }, "req_audit_outcome_1")
      );
      expect(await exists(firstMarker)).toBe(true);

      await expectAuditUnavailable(
        client.request("test.audit_effect", { markerPath: secondMarker }, "req_audit_outcome_2")
      );
      expect(await exists(secondMarker)).toBe(false);
      expect((await client.hello()).auditHealthy).toBe(false);
    } finally {
      await client.stop();
    }
  });

  it("rejects a pre-existing marker symlink without touching its target", async () => {
    const root = await stateRoot("kodegpt-audit-symlink-");
    const target = join(root, "target.txt");
    const marker = join(root, "marker.link");
    await writeFile(target, "original");
    await symlink(target, marker);
    const client = await KernelClient.start({
      runtimePath: FEATURE_RUNTIME,
      stateRoot: root,
      enableTestMethods: true
    });

    try {
      await expect(
        client.request("test.audit_effect", { markerPath: marker }, "req_audit_symlink")
      ).rejects.toMatchObject({ message: "TEST_EFFECT_FAILED" });
      expect(await readFile(target, "utf8")).toBe("original");
    } finally {
      await client.stop();
    }
  });

  it("never serializes secret params and creates the audit file with mode 0600", async () => {
    const root = await stateRoot("kodegpt-audit-secret-");
    const marker = join(root, "secret.marker");
    const secret = ["SUPER", "_SECRET", "_MARKER", "_123"].join("");
    const client = await KernelClient.start({
      runtimePath: FEATURE_RUNTIME,
      stateRoot: root,
      enableTestMethods: true
    });

    try {
      await expect(
        client.request(
          "test.audit_effect",
          { markerPath: marker, secret },
          "req_audit_secret"
        )
      ).resolves.toEqual({ created: true });
      expect(await exists(marker)).toBe(true);
      expect((await client.hello()).auditHealthy).toBe(true);
    } finally {
      await client.stop();
    }

    const auditPath = join(root, "logs", "security", "audit.jsonl");
    const serialized = await readFile(auditPath, "utf8");
    expect(serialized.match(new RegExp(secret, "g")) ?? []).toHaveLength(0);
    expect(serialized.trim().split("\n")).toHaveLength(2);
    expect((await stat(auditPath)).mode & 0o777).toBe(0o600);
  });

  it("locks the audit record schema to typed non-secret fields", async () => {
    const schemaPath = join(REPOSITORY_ROOT, "schemas", "runtime", "audit.schema.json");
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as Record<string, any>;

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(
      expect.arrayContaining([
        "schemaVersion",
        "timestampUnixMs",
        "phase",
        "requestId",
        "operationId",
        "action"
      ])
    );
    expect(schema.properties).not.toHaveProperty("env");
    expect(schema.properties).not.toHaveProperty("stdout");
    expect(schema.properties).not.toHaveProperty("stderr");
    expect(schema.properties).not.toHaveProperty("argv");
    expect(schema.properties).not.toHaveProperty("content");
  });
});
