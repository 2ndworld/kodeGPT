import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuditReader } from "./audit-reader.js";

const roots: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = join(tmpdir(), `kodegpt-audit-reader-${process.pid}-${Date.now()}-${roots.length}`);
  roots.push(root);
  await mkdir(join(root, "logs/security"), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AuditReader", () => {
  it("reads only the fixed audit path and strips private capabilities/unknown fields", async () => {
    const root = await fixtureRoot();
    const secretMarker = ["SUPER", "SECRET", "MARKER", "123"].join("_");
    await writeFile(
      join(root, "logs/security/audit.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        timestampUnixMs: 1,
        phase: "decision",
        requestId: "req_fixture",
        operationId: "op_fixture",
        capabilityId: "kc_private",
        action: "process_run",
        decision: "allow",
        reason: "request_validated",
        [secretMarker]: "must-not-be-exposed"
      })}\n`
    );

    const reader = new AuditReader(root);
    const events = await reader.readRecentAuditEvents(20);

    expect(events).toEqual([
      {
        schemaVersion: 1,
        timestampUnixMs: 1,
        phase: "decision",
        requestId: "req_fixture",
        operationId: "op_fixture",
        action: "process_run",
        decision: "allow",
        reason: "request_validated"
      }
    ]);
    expect(JSON.stringify(events)).not.toContain("kc_private");
    expect(JSON.stringify(events)).not.toContain(secretMarker);
  });

  it("clamps reads to 1..200 recent events", async () => {
    const root = await fixtureRoot();
    const lines = Array.from({ length: 205 }, (_, index) =>
      JSON.stringify({
        schemaVersion: 1,
        timestampUnixMs: index,
        phase: "outcome",
        requestId: `req_${index}`,
        operationId: `op_${index}`,
        action: "file_read",
        outcome: "success"
      })
    );
    await writeFile(join(root, "logs/security/audit.jsonl"), `${lines.join("\n")}\n`);
    const reader = new AuditReader(root);

    const maximum = await reader.readRecentAuditEvents(999);
    expect(maximum).toHaveLength(200);
    expect(maximum[0]?.requestId).toBe("req_5");
    expect(maximum.at(-1)?.requestId).toBe("req_204");

    const minimum = await reader.readRecentAuditEvents(0);
    expect(minimum).toHaveLength(1);
    expect(minimum[0]?.requestId).toBe("req_204");
  });
});
