import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RUNTIME_METHODS } from "../../packages/protocol/src/index.js";

type JsonSchema = Record<string, any>;

async function schema(name: string): Promise<JsonSchema> {
  const url = new URL(`../../schemas/runtime/${name}`, import.meta.url);
  return JSON.parse(await readFile(fileURLToPath(url), "utf8")) as JsonSchema;
}

describe("canonical runtime JSON Schemas", () => {
  it("keeps envelope composition explicit and closed", async () => {
    const envelope = await schema("envelope.schema.json");

    expect(envelope.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(envelope.oneOf).toEqual([
      { $ref: "request.schema.json" },
      { $ref: "success-response.schema.json" },
      { $ref: "error-response.schema.json" }
    ]);
  });

  it("matches the canonical method set and closes every request envelope and params object", async () => {
    const request = await schema("request.schema.json");
    const variants = request.oneOf as JsonSchema[];

    expect(variants.map((variant) => variant.properties.method.const)).toEqual(RUNTIME_METHODS);
    for (const variant of variants) {
      expect(variant.additionalProperties).toBe(false);
      expect(variant.properties.params.additionalProperties).toBe(false);
    }
  });

  it("includes the complete workspace lifecycle skeleton method set", () => {
    expect(RUNTIME_METHODS).toEqual(
      expect.arrayContaining([
        "workspace.register",
        "workspace.restrict_policy",
        "workspace.activate",
        "workspace.begin_close",
        "workspace.cancel_executions",
        "workspace.unregister"
      ])
    );
  });

  it("locks inheritEnv to false and closes shared policy/identity definitions", async () => {
    const request = await schema("request.schema.json");
    const policy = request.$defs.runtimePolicy as JsonSchema;
    const identity = request.$defs.persistentFilesystemIdentity as JsonSchema;

    expect(policy.additionalProperties).toBe(false);
    expect(policy.properties.inheritEnv).toEqual({ const: false });
    expect(identity.additionalProperties).toBe(false);
  });

  it("requires a closed literal-or-semantic traversal scope for private tree/search requests", async () => {
    const request = await schema("request.schema.json");
    const variants = request.oneOf as JsonSchema[];
    const byMethod = new Map(
      variants.map((variant) => [variant.properties.method.const as string, variant])
    );

    for (const method of ["file.tree", "file.search"] as const) {
      const params = byMethod.get(method)?.properties.params as JsonSchema | undefined;
      expect(params?.required).toContain("scope");
      expect(params?.properties.scope).toEqual({ enum: ["literal", "semantic"] });
    }
  });

  it("defines closed bounded local Git mutation variants without raw argv", async () => {
    expect(RUNTIME_METHODS).toContain("git.local_mutation");
    const request = await schema("request.schema.json");
    const variants = request.oneOf as JsonSchema[];
    const mutation = variants.find(
      (variant) => variant.properties.method.const === "git.local_mutation"
    );
    expect(mutation).toBeDefined();
    const params = mutation?.properties.params as JsonSchema;
    expect(params.oneOf).toHaveLength(5);
    const operations = (params.oneOf as JsonSchema[]).map(
      (variant) => variant.properties.operation.const
    );
    expect(operations).toEqual([
      "stage",
      "commit",
      "branch_create",
      "branch_switch",
      "branch_delete"
    ]);
    for (const variant of params.oneOf as JsonSchema[]) {
      expect(variant.additionalProperties).toBe(false);
      expect(variant.properties).not.toHaveProperty("argv");
    }
    const stage = (params.oneOf as JsonSchema[])[0];
    expect(stage.properties.paths.maxItems).toBe(128);
    expect(stage.properties.paths.items.maxLength).toBe(4096);
    const commit = (params.oneOf as JsonSchema[])[1];
    expect(commit.properties.message.maxLength).toBe(4096);
    for (const branch of (params.oneOf as JsonSchema[]).slice(2)) {
      expect(branch.properties.name.maxLength).toBe(255);
    }
  });

  it("defines closed bounded remote Git variants without URLs, force, or raw argv", async () => {
    expect(RUNTIME_METHODS).toContain("git.remote_mutation");
    const request = await schema("request.schema.json");
    const variants = request.oneOf as JsonSchema[];
    const mutation = variants.find(
      (variant) => variant.properties.method.const === "git.remote_mutation"
    );
    expect(mutation).toBeDefined();
    const params = mutation?.properties.params as JsonSchema;
    expect(params.oneOf).toHaveLength(3);
    expect((params.oneOf as JsonSchema[]).map((variant) => variant.properties.operation.const)).toEqual([
      "fetch",
      "pull",
      "push"
    ]);
    for (const variant of params.oneOf as JsonSchema[]) {
      expect(variant.additionalProperties).toBe(false);
      expect(variant.properties.remote.maxLength).toBe(128);
      expect(variant.properties.ref.maxLength).toBe(255);
      for (const forbidden of ["argv", "url", "force", "rebase", "headers", "credential"] ) {
        expect(variant.properties).not.toHaveProperty(forbidden);
      }
    }
  });

  it("closes success and error response envelopes", async () => {
    const success = await schema("success-response.schema.json");
    const error = await schema("error-response.schema.json");

    expect(success.additionalProperties).toBe(false);
    expect(error.additionalProperties).toBe(false);
    expect(error.properties.error.additionalProperties).toBe(false);
  });
});
