import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConnectorCredentialStore } from "../../packages/auth/src/index.js";
import { KernelClient } from "../../packages/core/src/kernel-client.js";
import {
  SkillCatalog,
  SkillPinStore,
  SkillSourceManager,
  SkillSourceStore,
  createSkillSourceRuntimeAdapter
} from "../../packages/skills/src/index.js";
import { startKodegpt } from "../../apps/cli/src/commands/start.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TARGET = join(REPOSITORY_ROOT, "target", "task10-skill-interoperability");
const RUNTIME = join(TARGET, "debug", "kodegpt-runtime");
const PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const PORT = 43_139;
const temporaryRoots: string[] = [];

function buildRuntime(): void {
  const result = spawnSync(
    "cargo",
    ["build", "-p", "kodegpt-runtime", "--target-dir", TARGET],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function skillDocument(name: string, description: string, instructions: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${instructions}`;
}

async function withLocalCatalog<T>(
  stateRoot: string,
  operation: (resources: {
    sourceStore: SkillSourceStore;
    sourceManager: SkillSourceManager;
    pinStore: SkillPinStore;
    catalog: SkillCatalog;
  }) => Promise<T>
): Promise<T> {
  const kernel = await KernelClient.start({ runtimePath: RUNTIME, stateRoot });
  const sourceStore = new SkillSourceStore(stateRoot);
  const sourceManager = new SkillSourceManager(
    sourceStore,
    createSkillSourceRuntimeAdapter(kernel)
  );
  const pinStore = new SkillPinStore(stateRoot);
  const catalog = new SkillCatalog(sourceManager, { pins: pinStore });
  try {
    return await operation({ sourceStore, sourceManager, pinStore, catalog });
  } finally {
    let firstError: unknown;
    try {
      await sourceManager.close();
    } catch (error) {
      firstError = error;
    }
    try {
      await kernel.stop();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError !== undefined) throw firstError;
  }
}

function requestMeta() {
  return {
    [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
    [CLIENT_CAPABILITIES_META_KEY]: {}
  };
}

async function rawMcpRequest(
  port: number,
  token: string,
  method: string,
  params: Record<string, unknown>,
  id: string,
  name?: string
): Promise<Record<string, any>> {
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "mcp-protocol-version": PROTOCOL_VERSION,
          "mcp-method": method,
          ...(name === undefined ? {} : { "mcp-name": name })
        }
      },
      (incoming) => {
        let responseBody = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => {
          responseBody += chunk;
        });
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body: responseBody }));
      }
    );
    request.once("error", reject);
    request.end(body);
  });
  expect(response.status, response.body).toBe(200);
  return JSON.parse(response.body) as Record<string, any>;
}

async function callTool(
  port: number,
  token: string,
  name: string,
  argumentsValue: Record<string, unknown>,
  id: string
): Promise<Record<string, any>> {
  const payload = await rawMcpRequest(
    port,
    token,
    "tools/call",
    { name, arguments: argumentsValue, _meta: requestMeta() },
    id,
    name
  );
  expect(payload.error).toBeUndefined();
  expect(payload.result?.isError).not.toBe(true);
  return payload.result as Record<string, any>;
}

function textJson(result: Record<string, any>): any {
  const content = result.content as Array<Record<string, unknown>>;
  expect(content?.[0]).toMatchObject({ type: "text" });
  return JSON.parse(String(content[0]?.text ?? "null"));
}

async function expectToolError(
  port: number,
  token: string,
  name: string,
  argumentsValue: Record<string, unknown>,
  id: string,
  code: string
): Promise<void> {
  const payload = await rawMcpRequest(
    port,
    token,
    "tools/call",
    { name, arguments: argumentsValue, _meta: requestMeta() },
    id,
    name
  );
  const serialized = JSON.stringify(payload);
  expect(payload.error !== undefined || payload.result?.isError === true).toBe(true);
  expect(serialized).toContain(code);
}

beforeAll(() => buildRuntime(), 60_000);

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("hybrid skill interoperability release fixtures", () => {
  it("serves live skills through MCP, pins locally, and preserves immutable snapshots across mutation and deletion", async () => {
    const stateRoot = await tempRoot("kodegpt-task10-state-");
    const sourceRoot = await tempRoot("kodegpt-task10-source-");
    const executionMarker = join(sourceRoot, "portable", "script-was-executed");

    for (const name of ["portable", "volatile", "provider-skill"]) {
      await mkdir(join(sourceRoot, name), { recursive: true });
    }
    await mkdir(join(sourceRoot, "portable", "references"), { recursive: true });
    await mkdir(join(sourceRoot, "portable", "assets"), { recursive: true });
    await mkdir(join(sourceRoot, "portable", "scripts"), { recursive: true });
    await writeFile(
      join(sourceRoot, "portable", "SKILL.md"),
      skillDocument("portable", "Portable release skill", "Follow the portable instructions.\n")
    );
    await writeFile(join(sourceRoot, "portable", "references", "guide.md"), "release guide\n");
    await writeFile(join(sourceRoot, "portable", "assets", "binary.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
    await writeFile(
      join(sourceRoot, "portable", "scripts", "helper.sh"),
      "#!/bin/sh\necho executed > script-was-executed\n"
    );
    await writeFile(
      join(sourceRoot, "volatile", "SKILL.md"),
      skillDocument("volatile", "Volatile release skill", "Original volatile instructions.\n")
    );
    const providerCommand = ["codex", "exec", "--full-auto"].join(" ");
    await writeFile(
      join(sourceRoot, "provider-skill", "SKILL.md"),
      skillDocument(
        "provider-skill",
        "Provider-bound release skill",
        `Run \`${providerCommand}\` and continue in a dedicated subagent session.\n`
      )
    );

    const admitted = await withLocalCatalog(stateRoot, ({ sourceManager }) =>
      sourceManager.addSource(sourceRoot, "release-fixture")
    );
    expect(admitted.sourceId).toMatch(/^ss_[a-f0-9]{32}$/);

    const credential = await new ConnectorCredentialStore(stateRoot).rotate();
    let portableId = "";
    let portableFingerprint = "";
    let volatileId = "";
    let volatileFingerprint = "";

    const first = await startKodegpt({ runtimePath: RUNTIME, stateRoot, port: PORT });
    try {
      const listed = textJson(
        await callTool(PORT, credential.token, "skill.list", {}, "req_skill_list_live")
      );
      expect(listed.skills).toHaveLength(3);
      const portable = listed.skills.find((skill: any) => skill.name === "portable");
      const volatile = listed.skills.find((skill: any) => skill.name === "volatile");
      const provider = listed.skills.find((skill: any) => skill.name === "provider-skill");
      expect(portable).toBeDefined();
      expect(volatile).toBeDefined();
      expect(provider?.compatibility?.classification).toBe("UNSUPPORTED");
      portableId = portable.skillId;
      volatileId = volatile.skillId;

      const inspected = textJson(
        await callTool(
          PORT,
          credential.token,
          "skill.inspect",
          { skillId: portableId },
          "req_skill_inspect_live"
        )
      );
      portableFingerprint = inspected.skill.fingerprint;
      expect(portableFingerprint).toMatch(/^[a-f0-9]{64}$/);
      const serializedInspection = JSON.stringify(inspected);
      expect(serializedInspection).not.toContain(sourceRoot);
      expect(serializedInspection).not.toContain(stateRoot);
      expect(serializedInspection).not.toContain("canonicalRoot");
      expect(serializedInspection).not.toContain("sourceCapabilityId");

      const volatileInspected = textJson(
        await callTool(
          PORT,
          credential.token,
          "skill.inspect",
          { skillId: volatileId },
          "req_skill_inspect_volatile"
        )
      );
      volatileFingerprint = volatileInspected.skill.fingerprint;

      const loaded = textJson(
        await callTool(
          PORT,
          credential.token,
          "skill.load",
          {
            skillId: portableId,
            fingerprint: portableFingerprint,
            resources: ["references/guide.md", "scripts/helper.sh"]
          },
          "req_skill_load_live"
        )
      );
      expect(loaded.instructions).toContain("Follow the portable instructions.");
      expect(loaded.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "references/guide.md", contents: "release guide\n" }),
          expect.objectContaining({
            path: "scripts/helper.sh",
            contents: "#!/bin/sh\necho executed > script-was-executed\n"
          })
        ])
      );
      await expect(access(executionMarker)).rejects.toThrow();

      await expectToolError(
        PORT,
        credential.token,
        "skill.load",
        {
          skillId: portableId,
          fingerprint: portableFingerprint,
          resources: ["assets/binary.bin"]
        },
        "req_skill_binary_rejected",
        "SKILL_RESOURCE_UNSUPPORTED"
      );
    } finally {
      await first.close();
    }

    const pinned = await withLocalCatalog(stateRoot, ({ catalog }) =>
      catalog.pin({ skillId: portableId, expectedBundleFingerprint: portableFingerprint })
    );
    expect(pinned.fingerprint).toBe(portableFingerprint);

    await writeFile(
      join(sourceRoot, "portable", "SKILL.md"),
      skillDocument("portable", "Portable release skill", "Changed live instructions.\n")
    );
    await writeFile(
      join(sourceRoot, "volatile", "SKILL.md"),
      skillDocument("volatile", "Volatile release skill", "Changed volatile instructions.\n")
    );

    const second = await startKodegpt({ runtimePath: RUNTIME, stateRoot, port: PORT });
    try {
      const pinnedLoad = textJson(
        await callTool(
          PORT,
          credential.token,
          "skill.load",
          { skillId: portableId, fingerprint: portableFingerprint },
          "req_skill_load_pinned_after_mutation"
        )
      );
      expect(pinnedLoad.pinned).toBe(true);
      expect(pinnedLoad.instructions).toContain("Follow the portable instructions.");
      expect(pinnedLoad.instructions).not.toContain("Changed live instructions.");

      const current = textJson(
        await callTool(
          PORT,
          credential.token,
          "skill.inspect",
          { skillId: portableId },
          "req_skill_inspect_changed_live"
        )
      );
      expect(current.skill.fingerprint).not.toBe(portableFingerprint);

      await expectToolError(
        PORT,
        credential.token,
        "skill.inspect",
        { skillId: volatileId, fingerprint: volatileFingerprint },
        "req_skill_stale_live_fingerprint",
        "SKILL_FINGERPRINT_MISMATCH"
      );
    } finally {
      await second.close();
    }

    await rm(sourceRoot, { recursive: true, force: true });
    const third = await startKodegpt({ runtimePath: RUNTIME, stateRoot, port: PORT });
    try {
      const pinnedAfterDeletion = textJson(
        await callTool(
          PORT,
          credential.token,
          "skill.load",
          { skillId: portableId, fingerprint: portableFingerprint },
          "req_skill_load_pinned_after_delete"
        )
      );
      expect(pinnedAfterDeletion).toMatchObject({
        skillId: portableId,
        fingerprint: portableFingerprint,
        availability: "pinned",
        pinned: true
      });
      expect(pinnedAfterDeletion.instructions).toContain("Follow the portable instructions.");
    } finally {
      await third.close();
    }
  }, 30_000);

  it("rejects state overlap and source identity replacement through the real Rust source authority", async () => {
    const stateRoot = await tempRoot("kodegpt-task10-boundary-state-");
    const insideState = join(stateRoot, "external-looking-skills");
    await mkdir(insideState, { recursive: true });

    await expect(
      withLocalCatalog(stateRoot, ({ sourceManager }) =>
        sourceManager.addSource(insideState, "must-reject")
      )
    ).rejects.toMatchObject({
      name: "SkillError",
      code: "SKILL_SOURCE_STATE_OVERLAP"
    });

    const sourceRoot = await tempRoot("kodegpt-task10-identity-source-");
    await mkdir(join(sourceRoot, "identity-skill"), { recursive: true });
    await writeFile(
      join(sourceRoot, "identity-skill", "SKILL.md"),
      skillDocument("identity-skill", "Identity fixture", "Original identity instructions.\n")
    );
    const identityPin = await withLocalCatalog(stateRoot, async ({ sourceManager, catalog }) => {
      await sourceManager.addSource(sourceRoot, "identity-fixture");
      const listed = await catalog.list();
      expect(listed.skills).toHaveLength(1);
      return catalog.pin({ skillId: listed.skills[0]!.skillId });
    });

    const replacedRoot = `${sourceRoot}-old`;
    await rename(sourceRoot, replacedRoot);
    temporaryRoots.push(replacedRoot);
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(join(sourceRoot, "identity-skill"), { recursive: true });
    await writeFile(
      join(sourceRoot, "identity-skill", "SKILL.md"),
      skillDocument("identity-skill", "Identity fixture", "Replacement content must not be trusted.\n")
    );

    await expect(
      withLocalCatalog(stateRoot, ({ catalog }) =>
        catalog.loadRaw({ skillId: identityPin.skillId, fingerprint: identityPin.fingerprint })
      )
    ).rejects.toMatchObject({
      name: "SkillError",
      code: "SKILL_SOURCE_IDENTITY_CHANGED"
    });
  }, 20_000);

  it("rejects escaping symlink resources without following them", async () => {
    const stateRoot = await tempRoot("kodegpt-task10-symlink-state-");
    const sourceRoot = await tempRoot("kodegpt-task10-symlink-source-");
    const outsideRoot = await tempRoot("kodegpt-task10-symlink-outside-");
    await mkdir(join(sourceRoot, "symlink-skill", "references"), { recursive: true });
    await writeFile(
      join(sourceRoot, "symlink-skill", "SKILL.md"),
      skillDocument("symlink-skill", "Symlink fixture", "Do not follow resource symlinks.\n")
    );
    await writeFile(join(outsideRoot, "secret.md"), "outside secret\n");
    await symlink(
      join(outsideRoot, "secret.md"),
      join(sourceRoot, "symlink-skill", "references", "escape.md")
    );

    await withLocalCatalog(stateRoot, async ({ sourceManager, catalog }) => {
      await sourceManager.addSource(sourceRoot, "symlink-fixture");
      await expect(catalog.list()).rejects.toMatchObject({
        name: "SkillError",
        code: "SKILL_RESOURCE_UNSUPPORTED"
      });
    });
  }, 20_000);
});
