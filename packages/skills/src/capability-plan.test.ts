import { describe, expect, it } from "vitest";

import {
  analyzeSkillCompatibility,
  type ParsedSkillDocument,
  type SkillCompatibilityReport
} from "./index.js";
import * as skills from "./index.js";

interface TestPlan {
  schemaVersion: 1;
  classification: "NATIVE" | "PARTIAL" | "PROVIDER_REQUIRED" | "UNSUPPORTED";
  nativeCapabilities: readonly string[];
  missingCapabilities: readonly string[];
  externalRequirements: readonly string[];
  blockedSemantics: readonly string[];
  guidance: readonly { capability: string; purpose: string }[];
  truncated: boolean;
  truncationReasons: readonly string[];
}

type Planner = (skill: ParsedSkillDocument, compatibility: SkillCompatibilityReport) => TestPlan;

function planner(): Planner | undefined {
  return (skills as Record<string, unknown>).buildSkillCapabilityPlan as Planner | undefined;
}

function skill(overrides: Partial<ParsedSkillDocument> = {}): ParsedSkillDocument {
  return {
    name: "portable",
    description: "Portable workflow",
    unknownMetadataKeys: [],
    instructions: "Follow the instructions carefully.",
    ...overrides
  };
}

function planFor(document: ParsedSkillDocument): TestPlan {
  const build = planner();
  expect(build).toBeTypeOf("function");
  return build!(document, analyzeSkillCompatibility(document));
}

function expectSortedUnique(values: readonly string[]): void {
  expect(values).toEqual(
    [...new Set(values)].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  );
}

describe("buildSkillCapabilityPlan", () => {
  it("maps native declared and semantic workflow evidence to existing native capabilities", () => {
    const document = skill({
      instructions:
        "Inspect workspace structure, search code for the target, read file context, review diff output, then run tests."
    });

    const plan = planFor(document);

    expect(plan).toMatchObject({
      schemaVersion: 1,
      classification: "NATIVE",
      missingCapabilities: [],
      externalRequirements: [],
      blockedSemantics: [],
      truncated: false,
      truncationReasons: []
    });
    expect(plan.nativeCapabilities).toEqual(
      expect.arrayContaining(["workspace.inspect", "code.search", "file.read", "git.diff", "verify.run"])
    );
    expect(plan.guidance.map((step) => step.capability)).toEqual(plan.nativeCapabilities);
  });

  it("preserves PARTIAL missing-capability findings", () => {
    const document = skill({
      metadata: { kodegpt: { requires: { capabilities: ["example.missing"] } } }
    });

    const plan = planFor(document);

    expect(plan.classification).toBe("PARTIAL");
    expect(plan.missingCapabilities).toContain("example.missing");
    expect(plan.blockedSemantics).toEqual([]);
  });

  it("preserves PROVIDER_REQUIRED as an external advisory requirement without invocation", () => {
    const document = skill({
      metadata: {
        kodegpt: {
          requires: {
            capabilities: ["file.read"],
            providers: ["figma"]
          }
        }
      }
    });

    const plan = planFor(document);

    expect(plan.classification).toBe("PROVIDER_REQUIRED");
    expect(plan.nativeCapabilities).toContain("file.read");
    expect(plan.externalRequirements).toEqual(["provider:figma"]);
    expect(plan.blockedSemantics).toEqual([]);
  });

  it("preserves unsupported Codex and subagent semantics as blocked advisory findings", () => {
    const document = skill({
      instructions: "Run `codex exec --full-auto` and continue in a dedicated subagent session."
    });

    const plan = planFor(document);

    expect(plan.classification).toBe("UNSUPPORTED");
    expect(plan.blockedSemantics).toEqual(expect.arrayContaining(["codex.exec", "subagent.session"]));
  });

  it("is deterministic, sorted, unique, and immutable", () => {
    const document = skill({
      instructions: "Review diff, search code, review diff, read file, then run tests."
    });
    const compatibility = analyzeSkillCompatibility(document);
    const build = planner();
    expect(build).toBeTypeOf("function");

    const first = build!(document, compatibility);
    const second = build!(document, compatibility);

    expect(first).toEqual(second);
    for (const values of [
      first.nativeCapabilities,
      first.missingCapabilities,
      first.externalRequirements,
      first.blockedSemantics,
      first.truncationReasons
    ]) {
      expectSortedUnique(values);
      expect(Object.isFrozen(values)).toBe(true);
    }
    expect(Object.isFrozen(first.guidance)).toBe(true);
    expect(first.guidance.every((step) => Object.isFrozen(step))).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("caps advisory finding arrays explicitly without changing the compatibility verdict", () => {
    const document = skill();
    const compatibility: SkillCompatibilityReport = {
      classification: "UNSUPPORTED",
      requiredCapabilities: [],
      missingCapabilities: Array.from({ length: 70 }, (_, index) => `missing.${index.toString().padStart(2, "0")}`),
      requiredProviders: Array.from({ length: 70 }, (_, index) => `provider-${index.toString().padStart(2, "0")}`),
      reasons: Array.from(
        { length: 70 },
        (_, index) => `DECLARED_UNSUPPORTED:block-${index.toString().padStart(2, "0")}`
      ),
      analysisBasis: "declared"
    };
    const build = planner();
    expect(build).toBeTypeOf("function");

    const plan = build!(document, compatibility);

    expect(plan.classification).toBe("UNSUPPORTED");
    expect(plan.missingCapabilities).toHaveLength(64);
    expect(plan.externalRequirements).toHaveLength(64);
    expect(plan.blockedSemantics).toHaveLength(64);
    expect(plan.truncated).toBe(true);
    expect(plan.truncationReasons).toEqual([
      "BLOCKED_SEMANTICS",
      "EXTERNAL_REQUIREMENTS",
      "MISSING_CAPABILITIES"
    ]);
  });
});
