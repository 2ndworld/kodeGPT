import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import type { SkillBundleFingerprintRecord } from "./contracts.js";
import { SkillError } from "./errors.js";

const BUNDLE_FINGERPRINT_VERSION = "kodegpt-skill-bundle:v1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function fingerprintSkillDescriptor(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fingerprintSkillBundle(records: readonly SkillBundleFingerprintRecord[]): string {
  const validated = records.map(validateRecord).sort((left, right) => compareUtf8(left.path, right.path));
  for (let index = 1; index < validated.length; index += 1) {
    if (validated[index - 1]!.path === validated[index]!.path) {
      throw bundleInvalid();
    }
  }

  const hash = createHash("sha256");
  hash.update(`${BUNDLE_FINGERPRINT_VERSION}\n`, "utf8");
  for (const record of validated) {
    hash.update(
      `${JSON.stringify({
        path: record.path,
        type: "file",
        bytes: record.bytes,
        sha256: record.sha256
      })}\n`,
      "utf8"
    );
  }
  return hash.digest("hex");
}

function validateRecord(record: SkillBundleFingerprintRecord): SkillBundleFingerprintRecord {
  if (
    !isCanonicalRelativePath(record.path) ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes < 0 ||
    !SHA256_PATTERN.test(record.sha256)
  ) {
    throw bundleInvalid();
  }
  return { ...record };
}

function isCanonicalRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes("\0") || isAbsolute(value)) {
    return false;
  }
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function bundleInvalid(): SkillError {
  return new SkillError("SKILL_BUNDLE_INVALID", "Skill bundle is invalid");
}
