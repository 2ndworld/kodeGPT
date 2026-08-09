import { describe, expect, test } from "vitest";

describe("state versioning", () => {
  test("rejects unknown schema version 2", async () => {
    const modulePath = "./state-version.js";
    let stateVersion: { assertStateVersion(value: { schemaVersion?: unknown }): void };

    try {
      stateVersion = await import(modulePath);
    } catch {
      throw new Error("state-version implementation is missing");
    }

    expect(() => stateVersion.assertStateVersion({ schemaVersion: 2 })).toThrow(
      "UNSUPPORTED_STATE_SCHEMA:2"
    );
  });
});
