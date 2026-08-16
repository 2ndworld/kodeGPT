import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  FrameDecoder,
  RUNTIME_METHODS,
  encodeFrame,
  parseRuntimeRequest
} from "../../packages/protocol/src/index.js";

const FIXTURE_NAMES = [
  "runtime.hello.json",
  "system.inspect_root.json",
  "trust.audit.json",
  "workspace.register.json",
  "workspace.read_project_profile.json",
  "workspace.restrict_policy.json",
  "workspace.activate.json",
  "workspace.begin_close.json",
  "workspace.cancel_executions.json",
  "workspace.unregister.json",
  "file.read.json",
  "file.tree.json",
  "file.search.json",
  "file.identity.json",
  "file.write.json",
  "file.edit.json",
  "file.commit_patch_file.json",
  "git.status.json",
  "git.checkpoint.json",
  "git.checkpoint_patch.json",
  "git.diff.json",
  "git.local_mutation.json",
  "git.remote_mutation.json",
  "git.log.json",
  "git.show.json",
  "git.range.json",
  "git.diff_history.json",
  "process.inspect_executable.json",
  "process.run.json",
  "verify.run.json",
  "process.status.json",
  "process.cancel.json",
  "artifact.read.json",
  "skill_source.inspect_root.json",
  "skill_source.register.json",
  "skill_source.tree.json",
  "skill_source.read.json",
  "skill_source.read_base64.json",
  "skill_source.unregister.json"
] as const;

const EXPECTED_METHODS = [
  "runtime.hello",
  "system.inspect_root",
  "trust.audit",
  "ci.audit",
  "workspace.register",
  "workspace.read_project_profile",
  "workspace.restrict_policy",
  "workspace.activate",
  "workspace.begin_close",
  "workspace.cancel_executions",
  "workspace.unregister",
  "file.read",
  "file.tree",
  "file.search",
  "file.identity",
  "file.write",
  "file.edit",
  "file.commit_patch_file",
  "git.repository_identity",
  "git.status",
  "git.checkpoint",
  "git.checkpoint_patch",
  "git.diff",
  "git.local_mutation",
  "git.remote_mutation",
  "git.log",
  "git.show",
  "git.range",
  "git.diff_history",
  "process.inspect_executable",
  "process.run",
  "verify.run",
  "process.status",
  "process.cancel",
  "artifact.read",
  "skill_source.inspect_root",
  "skill_source.register",
  "skill_source.tree",
  "skill_source.read",
  "skill_source.unregister"
] as const;

async function fixture(name: (typeof FIXTURE_NAMES)[number]): Promise<unknown> {
  const url = new URL(`../fixtures/runtime/${name}`, import.meta.url);
  return JSON.parse(await readFile(fileURLToPath(url), "utf8")) as unknown;
}

describe("TypeScript/Rust runtime fixture parity", () => {
  it("locks the canonical internal method set without legacy MCP/session concepts", () => {
    expect(RUNTIME_METHODS).toEqual(EXPECTED_METHODS);

    const serialized = JSON.stringify(RUNTIME_METHODS);
    expect(serialized).not.toContain("initialize");
    expect(serialized).not.toContain("initialized");
    expect(serialized).not.toContain("Mcp-Session-Id");
    expect(serialized).not.toContain("sessionId");
  });

  it("locks structured git history request schemas without raw git arguments", async () => {
    const schemaUrl = new URL("../../schemas/runtime/request.schema.json", import.meta.url);
    const schema = JSON.parse(await readFile(fileURLToPath(schemaUrl), "utf8")) as {
      $defs?: { gitRevisionSpec?: unknown };
      oneOf?: Array<{ properties?: { method?: { const?: string } } }>;
    };
    const historyMethods = new Set(["git.log", "git.show", "git.range", "git.diff_history"]);
    const historySchemas = (schema.oneOf ?? []).filter((entry) => {
      const method = entry.properties?.method?.const;
      return typeof method === "string" && historyMethods.has(method);
    });

    expect(historySchemas).toHaveLength(4);
    const serialized = JSON.stringify(historySchemas);
    expect(serialized).toContain('"revision"');
    expect(serialized).toContain('"baseRevision"');
    expect(serialized).toContain('"headRevision"');
    expect(JSON.stringify(schema.$defs?.gitRevisionSpec)).toContain('"kind"');
    expect(serialized).not.toContain('"argv"');
    expect(serialized).not.toContain('"revisionExpression"');
    expect(serialized).not.toContain('"gitArgs"');
  });

  it("accepts every shared request fixture and round-trips it through exact framing", async () => {
    for (const name of FIXTURE_NAMES) {
      const value = await fixture(name);
      const request = parseRuntimeRequest(value);
      const decoder = new FrameDecoder();

      expect(decoder.push(encodeFrame(request))).toEqual([value]);
      expect(() => decoder.finish()).not.toThrow();
    }
  });

  it("round-trips TypeScript frames through the Rust codec with semantic parity", async () => {
    const values = await Promise.all(FIXTURE_NAMES.map((name) => fixture(name)));
    const input = Buffer.concat(
      values.map((value) => Buffer.from(encodeFrame(parseRuntimeRequest(value))))
    );
    const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

    const rust = spawnSync(
      "cargo",
      ["run", "--quiet", "-p", "kodegpt-protocol", "--example", "frame_roundtrip"],
      {
        cwd: repositoryRoot,
        input,
        maxBuffer: 16 * 1024 * 1024
      }
    );

    expect(rust.error).toBeUndefined();
    expect(rust.status, rust.stderr.toString("utf8")).toBe(0);

    const decoder = new FrameDecoder();
    expect(decoder.push(rust.stdout)).toEqual(values);
    expect(() => decoder.finish()).not.toThrow();
  }, 60_000);

  it("rejects unknown fields in security-sensitive params", async () => {
    const value = (await fixture("file.read.json")) as Record<string, unknown>;
    const params = value.params as Record<string, unknown>;
    params.unexpectedPrivilege = true;

    expect(() => parseRuntimeRequest(value)).toThrow();
  });

  it("rejects unknown top-level fields and unknown/legacy methods", async () => {
    const value = (await fixture("runtime.hello.json")) as Record<string, unknown>;
    value.sessionId = "legacy";
    expect(() => parseRuntimeRequest(value)).toThrow();

    expect(() =>
      parseRuntimeRequest({
        jsonrpc: "2.0",
        id: "req_legacy",
        method: "initialize",
        params: {}
      })
    ).toThrow();
  });
});
