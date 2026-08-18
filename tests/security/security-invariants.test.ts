import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  KernelClient,
  RuntimeUnavailableError
} from "../../packages/core/src/kernel-client.js";
import {
  PRODUCTION_PROVIDER_MANIFESTS,
  PROVIDER_CREDENTIAL_TIMEOUT_MS,
  PROVIDER_MAX_REQUESTS,
  PROVIDER_NETWORK_ATTEMPT_TIMEOUT_MS,
  PROVIDER_OPERATION_TIMEOUT_MS
} from "../../packages/capabilities/src/index.js";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  REMOTE_GITHUB_CREATE_TOOL_ANNOTATIONS,
  REMOTE_GITHUB_MERGE_TOOL_ANNOTATIONS,
  REMOTE_GITHUB_READ_ONLY_TOOL_ANNOTATIONS
} from "../../packages/mcp-server/src/annotations.js";
import { listSurfaceTools } from "../../packages/mcp-server/src/server.js";
import {
  analyzeSkillCompatibility,
  buildSkillCapabilityPlan,
  type ParsedSkillDocument
} from "../../packages/skills/src/index.js";
import { MCP_SURFACE_VERSION } from "../../packages/mcp-server/src/surface-version.js";
import { registerKodegptTools } from "../../packages/mcp-server/src/tools.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TARGET = join(REPOSITORY_ROOT, "target", "task22-security");
const RUNTIME = join(TARGET, "debug", "kodegpt-runtime");
const temporaryRoots: string[] = [];

function buildRuntime(): void {
  const result = spawnSync(
    "cargo",
    ["build", "-p", "kodegpt-runtime", "--target-dir", TARGET],
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

async function waitUntilDead(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`runtime pid ${pid} did not exit`);
}

beforeAll(() => buildRuntime(), 60_000);

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("full security acceptance invariants", () => {
  it("blocks new file.read and process.run requests after the kernel dies", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "kodegpt-task22-kernel-death-"));
    temporaryRoots.push(stateRoot);
    const wrapper = join(stateRoot, "runtime-wrapper.sh");
    const pidFile = join(stateRoot, "runtime.pid");
    await writeFile(
      wrapper,
      `#!/bin/sh\nprintf '%s\\n' "$$" > ${shellQuote(pidFile)}\nexec ${shellQuote(RUNTIME)}\n`,
      { mode: 0o755 }
    );
    await chmod(wrapper, 0o755);

    const client = await KernelClient.start({ runtimePath: wrapper, stateRoot });
    try {
      await expect(client.hello()).resolves.toMatchObject({ testMethods: false });
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
      process.kill(pid, "SIGKILL");
      await waitUntilDead(pid);

      for (const [method, params, requestId] of [
        ["file.read", { capabilityId: "kc_dead", path: "README.md", offset: 0, maxBytes: 1 }, "req_dead_file"],
        [
          "process.run",
          {
            capabilityId: "kc_dead",
            logicalExecutable: "python3",
            argv: [],
            cwd: ".",
            env: {},
            background: false
          },
          "req_dead_process"
        ]
      ] as const) {
        await expect(client.request(method, params, requestId)).rejects.toBeInstanceOf(
          RuntimeUnavailableError
        );
        await expect(client.request(method, params, `${requestId}_again`)).rejects.toMatchObject({
          code: "RUNTIME_UNAVAILABLE"
        });
      }
    } finally {
      await client.stop();
    }
  }, 15_000);

  it("has no TypeScript filesystem or user-process fallback behind workspace/process facades", async () => {
    const [workspaceManager, executionManager] = await Promise.all([
      readFile(join(REPOSITORY_ROOT, "packages/core/src/workspace-manager.ts"), "utf8"),
      readFile(join(REPOSITORY_ROOT, "packages/core/src/execution-manager.ts"), "utf8")
    ]);
    const facadeSource = `${workspaceManager}\n${executionManager}`;

    expect(facadeSource).not.toContain('from "node:fs');
    expect(facadeSource).not.toContain('from "node:child_process');
    expect(facadeSource).not.toMatch(/\b(?:spawn|exec|execFile|fork)\s*\(/);
    expect(facadeSource).toContain("kernel.request");
  });

  it("keeps skill capability planning advisory and free of authority-bearing execution state", () => {
    const skill: ParsedSkillDocument = {
      name: "provider-advisory",
      description: "Advisory provider workflow",
      unknownMetadataKeys: [],
      instructions: "Run tests before using the declared provider.",
      metadata: {
        kodegpt: {
          requires: {
            providers: ["figma"]
          }
        }
      }
    };
    const compatibility = analyzeSkillCompatibility(skill);
    const plan = buildSkillCapabilityPlan(skill, compatibility);

    expect(plan.classification).toBe("PROVIDER_REQUIRED");
    expect(plan.externalRequirements).toEqual(["provider:figma"]);
    expect(plan.nativeCapabilities).toContain("verify.run");
    const serialized = JSON.stringify(plan);
    for (const forbidden of [
      "workspaceId",
      "sourceCapabilityId",
      "canonicalRoot",
      "stateRoot",
      "credential",
      "operationId",
      "argv",
      "process.env",
      "provider.invoke",
      "skill.run"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("ships only the intended typed trust, Git, bounded GitHub, and preview surface with no generic authority", () => {
    expect(MCP_SURFACE_VERSION).toBe("0.11");
    const names = listSurfaceTools().map(({ name }) => name);
    expect(names).toHaveLength(65);
    expect(names.some((name) => name.startsWith("provider."))).toBe(false);
    expect(PRODUCTION_PROVIDER_MANIFESTS.map(({ adapterId }) => adapterId)).toEqual([
      "github.read.v1",
      "github.write.v1"
    ]);
    expect(PROVIDER_CREDENTIAL_TIMEOUT_MS).toBe(5_000);
    expect(PROVIDER_NETWORK_ATTEMPT_TIMEOUT_MS).toBe(10_000);
    expect(PROVIDER_OPERATION_TIMEOUT_MS).toBe(30_000);
    expect(PROVIDER_MAX_REQUESTS).toBe(8);
    for (const required of [
      "workspace.inspect",
      "ci.repository",
      "ci.status",
      "ci.runs",
      "ci.run",
      "ci.failure",
      "code.search",
      "git.changes",
      "git.stage",
      "git.commit",
      "git.branchCreate",
      "git.branchSwitch",
      "git.branchDelete",
      "git.fetch",
      "git.pull",
      "git.push",
      "github.repository.inspect",
      "github.pr.create",
      "github.pr.inspect",
      "github.pr.list",
      "github.pr.merge",
      "github.issue.inspect",
      "github.issue.list",
      "preview.start",
      "preview.inspect",
      "preview.stop",
      "verify.list",
      "verify.run",
      "file.patch",
      "context.build",
      "trust.list",
      "workspace.trust",
      "workspace.untrust",
      "skill.list",
      "skill.inspect",
      "skill.load"
    ]) {
      expect(names).toContain(required);
    }
    expect(names.filter((name) => name.includes("trust"))).toEqual([
      "trust.list",
      "workspace.trust",
      "workspace.untrust"
    ]);
    for (const forbidden of [
      "policy.get",
      "policy.set",
      "policy.grant",
      "policy.revoke",
      "profile.set",
      "grant.add",
      "grant.remove",
      "shell.run",
      "codex.run",
      "codex.exec",
      "skill.run",
      "skill.pin",
      "skill.unpin",
      "skill.source.add",
      "skill.source.remove",
      "provider.list",
      "provider.tools",
      "provider.invoke",
      "http.request",
      "browser.open",
      "browser.navigate",
      "desktop.control",
      "github.issue.create",
      "github.issue.update",
      "github.issue.comment",
      "github.pr.update",
      "github.label.create",
      "github.label.update",
      "github.label.delete",
      "git.run",
      "git.exec",
      "git.command",
      "git.reset",
      "git.rebase"
    ]) {
      expect(names).not.toContain(forbidden);
    }

    const registrations = new Map<string, { annotations?: unknown }>();
    registerKodegptTools(
      {
        registerTool(name: string, config: { annotations?: unknown }) {
          registrations.set(name, config);
        },
        registerResource() {}
      } as never,
      {} as never
    );
    for (const name of ["skill.list", "skill.inspect", "skill.load"]) {
      expect(registrations.get(name)?.annotations).toEqual(READ_ONLY_TOOL_ANNOTATIONS);
    }
    for (const name of [
      "github.repository.inspect",
      "github.pr.inspect",
      "github.pr.list",
      "github.issue.inspect",
      "github.issue.list"
    ]) {
      expect(registrations.get(name)?.annotations).toEqual(REMOTE_GITHUB_READ_ONLY_TOOL_ANNOTATIONS);
    }
    expect(registrations.get("github.pr.create")?.annotations).toEqual(REMOTE_GITHUB_CREATE_TOOL_ANNOTATIONS);
    expect(registrations.get("github.pr.merge")?.annotations).toEqual(REMOTE_GITHUB_MERGE_TOOL_ANNOTATIONS);
  });
});
