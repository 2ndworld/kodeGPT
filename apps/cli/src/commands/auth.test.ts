import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConnectorCredentialStore } from "@kodegpt/auth";
import { afterEach, describe, expect, it } from "vitest";

import { runAuthCommand } from "./auth.js";

const roots: string[] = [];

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kodegpt-cli-auth-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("auth CLI command", () => {
  it("reports unconfigured status", async () => {
    const store = {
      status: async () => ({ configured: false } as const),
      rotate: async () => {
        throw new Error("not used");
      }
    };
    await expect(runAuthCommand(["status"], { store })).resolves.toBe(
      "connector credential not configured"
    );
  });

  it("reveals only the newly rotated value while later status remains non-sensitive", async () => {
    const store = new ConnectorCredentialStore(await stateRoot());
    const rotated = await runAuthCommand(["rotate"], { store });
    expect(rotated).toMatch(/^connector credential rotated kgc_/);
    const issuedValue = rotated.split(" ").at(-1);
    expect(issuedValue).toBeDefined();

    const status = await runAuthCommand(["status"], { store });
    expect(status).toContain("connector credential configured id=");
    expect(status).toContain("rotatedAt=");
    expect(status).not.toContain(issuedValue ?? "unreachable");
    expect(status).not.toContain("verifier");
  });

  it("rejects unknown subcommands and extra arguments", async () => {
    const store = new ConnectorCredentialStore(await stateRoot());
    await expect(runAuthCommand([], { store })).rejects.toThrow(/status, rotate/);
    await expect(runAuthCommand(["status", "extra"], { store })).rejects.toThrow(/no arguments/);
    await expect(runAuthCommand(["rotate", "extra"], { store })).rejects.toThrow(/no arguments/);
  });
});
