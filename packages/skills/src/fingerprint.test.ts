import { describe, expect, it } from "vitest";

import {
  fingerprintSkillBundle,
  fingerprintSkillDescriptor,
  type SkillBundleFingerprintRecord
} from "./index.js";

function bytes(text: string): Uint8Array {
  return Buffer.from(text, "utf8");
}

function record(path: string, content: string): SkillBundleFingerprintRecord {
  const data = bytes(content);
  return {
    path,
    bytes: data.byteLength,
    sha256: fingerprintSkillDescriptor(data)
  };
}

describe("skill fingerprints", () => {
  it("fingerprints the exact descriptor bytes", () => {
    const left = fingerprintSkillDescriptor(bytes("same text\n"));
    const same = fingerprintSkillDescriptor(bytes("same text\n"));
    const newlineChanged = fingerprintSkillDescriptor(bytes("same text\r\n"));

    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(same).toBe(left);
    expect(newlineChanged).not.toBe(left);
  });

  it("uses a versioned canonical record stream that is invariant to input record order", () => {
    const records = [record("SKILL.md", "descriptor"), record("references/guide.md", "guide")];
    expect(fingerprintSkillBundle(records)).toBe(fingerprintSkillBundle([...records].reverse()));
  });

  it("changes when a relative path, byte count, or content digest changes", () => {
    const base = [record("SKILL.md", "descriptor"), record("assets/data.bin", "payload")];
    const baseFingerprint = fingerprintSkillBundle(base);

    expect(
      fingerprintSkillBundle([
        base[0]!,
        { ...base[1]!, path: "assets/renamed.bin" }
      ])
    ).not.toBe(baseFingerprint);
    expect(
      fingerprintSkillBundle([
        base[0]!,
        { ...base[1]!, bytes: base[1]!.bytes + 1 }
      ])
    ).not.toBe(baseFingerprint);
    expect(
      fingerprintSkillBundle([
        base[0]!,
        { ...base[1]!, sha256: "f".repeat(64) }
      ])
    ).not.toBe(baseFingerprint);
  });

  it("rejects duplicate/non-canonical paths and malformed record metadata", () => {
    for (const records of [
      [record("SKILL.md", "a"), record("SKILL.md", "b")],
      [record("../escape", "a")],
      [{ ...record("SKILL.md", "a"), bytes: -1 }],
      [{ ...record("SKILL.md", "a"), sha256: "NOT-A-DIGEST" }]
    ]) {
      expect(() => fingerprintSkillBundle(records)).toThrowError(
        expect.objectContaining({ code: "SKILL_BUNDLE_INVALID" })
      );
    }
  });
});
