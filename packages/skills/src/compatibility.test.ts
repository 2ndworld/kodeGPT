import { describe, expect, it } from "vitest";

import {
  analyzeSkillCompatibility,
  type ParsedSkillDocument,
  type SkillCompatibilityReport
} from "./index.js";

function skill(overrides: Partial<ParsedSkillDocument> = {}): ParsedSkillDocument {
  return {
    name: "portable",
    description: "Portable workflow",
    unknownMetadataKeys: [],
    instructions: "Follow the instructions carefully.",
    ...overrides
  };
}

function expectSortedUnique(values: string[]): void {
  expect(values).toEqual([...new Set(values)].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
}

describe("analyzeSkillCompatibility", () => {
  it("classifies a pure native workflow as NATIVE without granting permissions", () => {
    const report = analyzeSkillCompatibility(
      skill({
        instructions: "Use `code.search` to locate the target, `file.read` to inspect it, then `verify.run`."
      })
    );

    expect(report).toEqual<SkillCompatibilityReport>({
      classification: "NATIVE",
      requiredCapabilities: ["code.search", "file.read", "verify.run"],
      missingCapabilities: [],
      requiredProviders: [],
      reasons: ["NATIVE_REQUIREMENTS_SATISFIED"],
      analysisBasis: "static"
    });
  });

  it("classifies an unmodeled external CLI workflow as PARTIAL", () => {
    const report = analyzeSkillCompatibility(
      skill({ instructions: "Inspect the project, then run `terraform plan` and review the output." })
    );

    expect(report.classification).toBe("PARTIAL");
    expect(report.missingCapabilities).toEqual(["external-cli:terraform"]);
    expect(report.reasons).toContain("EXTERNAL_CLI_REQUIRED:terraform");
    expect(report.analysisBasis).toBe("static");
  });

  it("classifies declared provider requirements as PROVIDER_REQUIRED", () => {
    const report = analyzeSkillCompatibility(
      skill({
        metadata: {
          kodegpt: {
            requires: {
              capabilities: ["file.read"]
            },
            providers: ["figma"]
          }
        }
      })
    );

    expect(report.classification).toBe("PROVIDER_REQUIRED");
    expect(report.requiredCapabilities).toEqual(["file.read"]);
    expect(report.missingCapabilities).toEqual([]);
    expect(report.requiredProviders).toEqual(["figma"]);
    expect(report.reasons).toContain("PROVIDER_REQUIRED:figma");
    expect(report.analysisBasis).toBe("declared");
  });

  it("classifies Codex execution and subagent-session semantics as UNSUPPORTED", () => {
    const report = analyzeSkillCompatibility(
      skill({
        instructions: "Run `codex exec --full-auto` and then continue the work in a dedicated subagent session."
      })
    );

    expect(report.classification).toBe("UNSUPPORTED");
    expect(report.missingCapabilities).toEqual(["codex.exec", "subagent.session"]);
    expect(report.reasons).toContain("CODEX_EXEC_UNSUPPORTED");
    expect(report.reasons).toContain("SUBAGENT_SESSION_UNSUPPORTED");
    expect(report.analysisBasis).toBe("static");
  });

  it("treats any explicit Codex command requirement as unsupported", () => {
    const report = analyzeSkillCompatibility(
      skill({ instructions: "Use `codex review` to inspect the change before finishing." })
    );

    expect(report.classification).toBe("UNSUPPORTED");
    expect(report.missingCapabilities).toContain("codex.runtime");
    expect(report.reasons).toContain("CODEX_RUNTIME_UNSUPPORTED");
  });

  it("treats malformed declared KodeGPT requirements conservatively", () => {
    const report = analyzeSkillCompatibility(
      skill({ metadata: { kodegpt: { requires: { capabilities: "code.search" } } } })
    );

    expect(report.classification).toBe("PARTIAL");
    expect(report.missingCapabilities).toContain("declared.requirements");
    expect(report.reasons).toContain("DECLARED_REQUIREMENTS_INVALID");
    expect(report.analysisBasis).toBe("declared");
  });

  it("treats unknown declared capabilities conservatively and keeps report arrays deterministic", () => {
    const report = analyzeSkillCompatibility(
      skill({
        metadata: {
          kodegpt: {
            requires: {
              capabilities: ["vendor.magic", "code.search", "vendor.magic", "file.read"],
              providers: ["zeta", "alpha", "alpha"]
            }
          }
        }
      })
    );

    expect(report.classification).toBe("PROVIDER_REQUIRED");
    expect(report.requiredCapabilities).toEqual(["code.search", "file.read", "vendor.magic"]);
    expect(report.missingCapabilities).toEqual(["vendor.magic"]);
    expect(report.requiredProviders).toEqual(["alpha", "zeta"]);
    expect(report.reasons).toContain("MISSING_CAPABILITY:vendor.magic");
    for (const values of [
      report.requiredCapabilities,
      report.missingCapabilities,
      report.requiredProviders,
      report.reasons
    ]) {
      expectSortedUnique(values);
    }
  });
});
