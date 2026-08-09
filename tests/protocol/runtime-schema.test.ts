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

  it("locks inheritEnv to false and closes shared policy/identity definitions", async () => {
    const request = await schema("request.schema.json");
    const policy = request.$defs.runtimePolicy as JsonSchema;
    const identity = request.$defs.persistentFilesystemIdentity as JsonSchema;

    expect(policy.additionalProperties).toBe(false);
    expect(policy.properties.inheritEnv).toEqual({ const: false });
    expect(identity.additionalProperties).toBe(false);
  });

  it("closes success and error response envelopes", async () => {
    const success = await schema("success-response.schema.json");
    const error = await schema("error-response.schema.json");

    expect(success.additionalProperties).toBe(false);
    expect(error.additionalProperties).toBe(false);
    expect(error.properties.error.additionalProperties).toBe(false);
  });
});
