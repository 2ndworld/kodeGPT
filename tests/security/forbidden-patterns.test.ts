import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(REPOSITORY_ROOT, "scripts", "forbidden-patterns.mjs");
const roots: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kodegpt-forbidden-"));
  roots.push(root);
  await mkdir(join(root, "packages/mcp-server/src"), { recursive: true });
  await mkdir(join(root, "packages/core/src"), { recursive: true });
  await mkdir(join(root, "packages/capabilities/src"), { recursive: true });
  await mkdir(join(root, "crates/sandbox/src"), { recursive: true });
  await writeFile(join(root, "packages/mcp-server/src/server.ts"), "export const server = true;\n");
  await writeFile(join(root, "packages/core/src/runtime.ts"), "export const runtime = true;\n");
  await writeFile(join(root, "crates/sandbox/src/bubblewrap.rs"), "pub fn safe() {}\n");
  return root;
}

function scan(root: string) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("forbidden product-code patterns", () => {
  it("passes a minimal safe product tree", async () => {
    const root = await fixtureRoot();
    const result = scan(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("forbidden-pattern scan ok");
  });

  it.each([
    [
      "v1 MCP SDK import",
      "packages/mcp-server/src/server.ts",
      'import { Server } from "@modelcontextprotocol/sdk/server/index.js";\n',
      "mcp-v1-sdk"
    ],
    [
      "public shell.run",
      "packages/mcp-server/src/server.ts",
      'server.registerTool("shell.run", {} as any, async () => ({}));\n',
      "public-shell-run"
    ],
    [
      "Node exec process fallback",
      "packages/core/src/runtime.ts",
      'import { exec } from "node:child_process"; exec("echo unsafe");\n',
      "node-exec-fallback"
    ],
    [
      "host-path Bubblewrap bind",
      "crates/sandbox/src/bubblewrap.rs",
      'command.arg("--ro-bind").arg(host_path).arg("/workspace");\n',
      "host-path-bwrap-bind"
    ],
    ...[
      "github.request",
      "github.graphql",
      "github.rest",
      "gh.run",
      "ci.logs.raw",
      "ci.jobs.list",
      "ci.steps.list",
      "ci.rerun",
      "ci.cancel",
      "ci.dispatch",
      "provider.list",
      "provider.tools",
      "provider.invoke",
      "skill.run"
    ].map((name) => [
      `forbidden Remote-CI surface ${name}`,
      "packages/mcp-server/src/server.ts",
      `export const forbidden = ${JSON.stringify(name)};\n`,
      "remote-ci-forbidden-surface"
    ]),
    [
      "gh api semantic execution",
      "packages/core/src/runtime.ts",
      'export const command = "gh api /repos/example/project/actions/runs";\n',
      "remote-ci-gh-api"
    ],
    [
      "generic provider request surface",
      "packages/core/src/runtime.ts",
      'export const command = "provider.request";\n',
      "provider-forbidden-surface"
    ],
    [
      "generic provider GraphQL surface",
      "packages/core/src/runtime.ts",
      'export const command = "provider.graphql";\n',
      "provider-forbidden-surface"
    ],
    [
      "remote provider mutation surface",
      "packages/core/src/runtime.ts",
      'export const command = "provider.write";\n',
      "provider-forbidden-surface"
    ],
    [
      "raw provider URL authority",
      "packages/core/src/runtime.ts",
      'export const providerUrl = "https://caller.invalid";\n',
      "provider-raw-authority"
    ],
    [
      "raw provider method/header/argv authority",
      "packages/core/src/runtime.ts",
      'export const providerMethod = "POST", providerHeaders = {}, providerArgv = [];\n',
      "provider-raw-authority"
    ],
    [
      "generic provider request dispatcher",
      "packages/core/src/runtime.ts",
      'export function genericProviderRequest() { return null; }\n',
      "provider-generic-dispatch"
    ],
    [
      "provider agent/process proxy",
      "packages/core/src/runtime.ts",
      'export class ProviderProcessProxy {}\n',
      "provider-process-proxy"
    ]
  ])("rejects %s", async (_label, path, contents, rule) => {
    const root = await fixtureRoot();
    await writeFile(join(root, path), contents);
    const result = scan(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(rule);
  });

  it("allows reviewed typed CI mutation ids in the authoritative public action catalog only", async () => {
    const root = await fixtureRoot();
    await writeFile(
      join(root, "packages/capabilities/src/public-actions.ts"),
      'export const actions = ["ci.rerun", "ci.cancel", "ci.dispatch"];\n'
    );
    expect(scan(root).status).toBe(0);

    await writeFile(
      join(root, "packages/capabilities/src/unreviewed.ts"),
      'export const actions = ["ci.rerun"];\n'
    );
    const result = scan(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("remote-ci-forbidden-surface");
  });

  it("ignores negative assertions in tests rather than treating them as product behavior", async () => {
    const root = await fixtureRoot();
    await writeFile(
      join(root, "packages/mcp-server/src/server.test.ts"),
      'expect(source).not.toContain("@modelcontextprotocol/sdk");\n'
    );
    const result = scan(root);
    expect(result.status, result.stderr).toBe(0);
  });

  it("ignores test-only Rust test RPC strings but rejects an unguarded production route", async () => {
    const root = await fixtureRoot();
    await mkdir(join(root, "crates/runtime/src"), { recursive: true });
    const dispatcher = join(root, "crates/runtime/src/dispatcher.rs");
    await writeFile(
      dispatcher,
      '#[cfg(test)]\nmod tests {\n    fn fixture(method: &str) {\n        match method {\n            "test.echo_after" => {},\n            _ => {}\n        }\n    }\n}\n'
    );
    expect(scan(root).status).toBe(0);

    await writeFile(
      dispatcher,
      'fn dispatch(method: &str) {\n    match method {\n        "test.sleep" => {},\n        _ => {}\n    }\n}\n'
    );
    const result = scan(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("production-test-rpc");
  });
});
