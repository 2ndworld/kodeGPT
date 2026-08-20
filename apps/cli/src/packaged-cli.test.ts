import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

const cliRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliPath = join(cliRoot, "bin", "kodegpt.mjs");
const buildScript = join(cliRoot, "scripts", "build-cli.mjs");
const runtimePath = join(repoRoot, "packages", "runtime-linux-x64", "bin", "kodegpt-runtime");
const temporaryRoots: string[] = [];

beforeAll(() => {
  const built = spawnSync(process.execPath, [buildScript], {
    cwd: cliRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
  expect(built.error).toBeUndefined();
  expect(built.status, built.stderr).toBe(0);

  if (!existsSync(runtimePath)) {
    const cargoBuild = spawnSync("cargo", ["build", "--release", "-p", "kodegpt-runtime"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024
    });
    expect(cargoBuild.error).toBeUndefined();
    expect(cargoBuild.status, cargoBuild.stderr).toBe(0);

    const staged = spawnSync(process.execPath, [join(repoRoot, "scripts", "stage-runtime.mjs")], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    });
    expect(staged.error).toBeUndefined();
    expect(staged.status, staged.stderr).toBe(0);
  }
}, 120_000);

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runSkillCli(args: string[], stateRoot: string) {
  return spawnSync(process.execPath, [cliPath, ...args, "--state-root", stateRoot], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_ENV: "test",
      KODEGPT_RUNTIME_PATH: runtimePath
    }
  });
}

function runStateOnlySkillCli(args: string[], stateRoot: string) {
  return spawnSync(process.execPath, [cliPath, ...args, "--state-root", stateRoot], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_ENV: "test",
      KODEGPT_RUNTIME_PATH: "/definitely/not/a/runtime"
    }
  });
}

describe("packaged CLI skill surface", () => {
  it("starts successfully and includes the local skill command forms in help", () => {
    const result = spawnSync(process.execPath, [cliPath, "--help"], {
      cwd: cliRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("kodegpt skill source list [--state-root <path>]");
    expect(result.stdout).toContain("kodegpt skill source add <absolute-path> [--kind agent-skills]");
    expect(result.stdout).toContain("kodegpt skill source remove <source-id>");
    expect(result.stdout).toContain("kodegpt skill pin <skill-id> [--fingerprint <sha256>]");
    expect(result.stdout).toContain("kodegpt skill unpin <skill-id> [--fingerprint <sha256>]");
    expect(result.stdout).toContain("kodegpt provider add --adapter <adapter-id> --name <display-name>");
    expect(result.stdout).toContain("kodegpt provider remove <provider-id>");
    expect(result.stdout).toContain("kodegpt provider enable <provider-id>");
    expect(result.stdout).toContain("kodegpt provider disable <provider-id>");
    expect(result.stdout).toContain("kodegpt provider reapprove <provider-id>");
    expect(result.stdout).toContain("kodegpt provider list [--json] [--state-root <path>]");
    expect(result.stdout).toContain("kodegpt provider inspect <provider-id> [--json]");
    expect(result.stdout).not.toContain("kodegpt provider invoke");
    expect(result.stdout).toContain("kodegpt env sync [--state-root <path>]");
    expect(result.stdout).toContain("kodegpt env add <root> [--exec-dir <relative>] [--state-root <path>]");
    expect(result.stdout).toContain("kodegpt env list [--state-root <path>]");
    expect(result.stdout).toContain("kodegpt env remove <environment-id> [--state-root <path>]");
    expect(result.stdout).toContain("kodegpt env doctor [executable] [--state-root <path>]");
    expect(result.stdout).toContain("kodegpt service install --name <namespace:name>");
    expect(result.stdout).toContain("kodegpt service start [--state-root <path>]");
    expect(result.stdout).toContain("kodegpt service stop [--state-root <path>]");
    expect(result.stdout).toContain("kodegpt service restart [--state-root <path>]");
    expect(result.stdout).toContain("kodegpt service status [--json] [--state-root <path>]");
    expect(result.stdout).toContain("kodegpt service uninstall [--state-root <path>]");
    expect(result.stdout).not.toContain("kodegpt service run");
  });

  it("dispatches service arguments through the local-only parser", () => {
    const result = spawnSync(process.execPath, [cliPath, "service", "wat"], {
      cwd: cliRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown service command: wat");
  });

  it("lists empty developer environment state without starting or requiring the runtime", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "kodegpt-packaged-env-state-"));
    temporaryRoots.push(stateRoot);

    const result = runStateOnlySkillCli(["env", "list"], stateRoot);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("no developer environments");
  });

  it("lists empty local provider state without starting or requiring the runtime", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "kodegpt-packaged-provider-state-"));
    temporaryRoots.push(stateRoot);

    const result = runStateOnlySkillCli(["provider", "list"], stateRoot);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("no admitted providers");
  });

  it("fails closed on unknown production provider adapters without requiring the runtime", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "kodegpt-packaged-provider-state-"));
    temporaryRoots.push(stateRoot);

    const result = runStateOnlySkillCli([
      "provider", "add", "--adapter", "test.unregistered.v1", "--name", "Unregistered"
    ], stateRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown compiled provider adapter: test.unregistered.v1");
  });

  it("lists empty local skill state without starting or requiring the runtime", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "kodegpt-packaged-skill-state-"));
    temporaryRoots.push(stateRoot);

    const result = spawnSync(
      process.execPath,
      [cliPath, "skill", "source", "list", "--state-root", stateRoot],
      {
        cwd: cliRoot,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, KODEGPT_RUNTIME_PATH: "/definitely/not/a/runtime" }
      }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("no skill sources");
  });

  it("runs source add/list, pin/unpin, and source remove through the packaged local CLI", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "kodegpt-packaged-skill-state-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "kodegpt-packaged-skill-source-"));
    temporaryRoots.push(stateRoot, sourceRoot);
    const skillRoot = join(sourceRoot, "portable");
    await mkdir(skillRoot, { mode: 0o700 });
    await writeFile(
      join(skillRoot, "SKILL.md"),
      "---\nname: portable\ndescription: Portable workflow\n---\nUse `file.read` to inspect the target.\n",
      "utf8"
    );

    const added = runSkillCli(["skill", "source", "add", sourceRoot], stateRoot);
    expect(added.status, added.stderr).toBe(0);
    const sourceMatch = /^added\s+(ss_[a-f0-9]{32})\s+agent-skills\s+/m.exec(added.stdout);
    expect(sourceMatch).not.toBeNull();
    const sourceId = sourceMatch![1]!;

    const listed = runSkillCli(["skill", "source", "list"], stateRoot);
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(sourceId);
    expect(listed.stdout).toContain(sourceRoot);

    const skillDigest = createHash("sha256").update(`${sourceId}\0portable`, "utf8").digest("hex");
    const skillId = `sk_${skillDigest}`;
    const stalePin = runSkillCli(
      ["skill", "pin", skillId, "--fingerprint", "0".repeat(64)],
      stateRoot
    );
    expect(stalePin.status).toBe(1);
    expect(stalePin.stdout).toBe("");

    const pinned = runSkillCli(["skill", "pin", skillId], stateRoot);
    expect(pinned.status, pinned.stderr).toBe(0);
    const pinMatch = new RegExp(`^pinned ${skillId} ([a-f0-9]{64})$`, "m").exec(pinned.stdout);
    expect(pinMatch).not.toBeNull();
    const fingerprint = pinMatch![1]!;

    const unpinned = runStateOnlySkillCli(["skill", "unpin", skillId], stateRoot);
    expect(unpinned.status, unpinned.stderr).toBe(0);
    expect(unpinned.stdout.trim()).toBe(`unpinned ${skillId} ${fingerprint}`);

    const removed = runStateOnlySkillCli(["skill", "source", "remove", sourceId], stateRoot);
    expect(removed.status, removed.stderr).toBe(0);
    expect(removed.stdout.trim()).toBe(`removed ${sourceId}`);

    const finalList = runSkillCli(["skill", "source", "list"], stateRoot);
    expect(finalList.status, finalList.stderr).toBe(0);
    expect(finalList.stdout.trim()).toBe("no skill sources");
  }, 15_000);
});
