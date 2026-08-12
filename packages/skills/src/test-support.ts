import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PersistedSkillSourceIdentity, SkillSourceAdmissionInput } from "./contracts.js";

export async function createSkillTestStateRoot(label = "state"): Promise<string> {
  return mkdtemp(join(tmpdir(), `kodegpt-skills-${label}-`));
}

export async function removeSkillTestStateRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export function testSkillSourceIdentity(index: number): PersistedSkillSourceIdentity {
  return {
    deviceMajor: 8,
    deviceMinor: 1,
    inode: String(10_000 + index)
  };
}

export function testSkillSourceInput(index: number, label = `source-${index}`): SkillSourceAdmissionInput {
  return {
    label,
    kind: "agent-skills",
    canonicalRoot: `/tmp/kodegpt-skill-source-${index}`,
    identity: testSkillSourceIdentity(index)
  };
}
