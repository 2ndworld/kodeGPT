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
  externalCliRequirements?: readonly {
    requirement: string;
    executable: string;
    status: "available" | "not-allowed" | "not-installed" | "sandbox-unavailable";
    capability: "process.run";
  }[];
  truncated: boolean;
  truncationReasons: readonly string[];
}

type Planner = (skill: ParsedSkillDocument, compatibility: SkillCompatibilityReport) => TestPlan;
type Resolver = (
  plan: TestPlan,
  context: {
    workspaceId: string;
    allowProcess: boolean;
    allowDynamicExecutables: boolean;
    allowedExecutableNames: readonly string[];
    inspectExecutable(executable: string): Promise<{ executableAvailable: boolean; sandboxAvailable: boolean }>;
  }
) => Promise<TestPlan>;

function planner(): Planner | undefined {
  return (skills as Record<string, unknown>).buildSkillCapabilityPlan as Planner | undefined;
}

function resolver(): Resolver | undefined {
  return (skills as Record<string, unknown>).resolveSkillCapabilityPlan as Resolver | undefined;
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

  it("maps Remote-CI semantics to advisory native capabilities without execution authority", () => {
    const document = skill({
      instructions: "Resolve the ci repository, check ci status, list ci runs, inspect a ci run, then explain the ci failure."
    });

    const plan = planFor(document);

    expect(plan.classification).toBe("NATIVE");
    expect(plan.nativeCapabilities.filter((capability) => capability.startsWith("ci."))).toEqual([
      "ci.failure",
      "ci.repository",
      "ci.run",
      "ci.runs",
      "ci.status"
    ]);
    const serializedGuidance = JSON.stringify(plan.guidance);
    for (const forbidden of ["gh api", "provider.invoke", "skill.run"]) {
      expect(serializedGuidance).not.toContain(forbidden);
    }
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

  it("keeps provider requirements advisory and strips provider authority metadata", () => {
    const document = skill({
      metadata: {
        kodegpt: {
          requires: { providers: ["github"] },
          providerInstanceId: "prv_0123456789abcdef0123456789abcdef",
          credentialBroker: { kind: "external-helper", helperPath: "/private/helper" },
          mapping: { operationId: "raw.invoke" },
          invoke: true
        }
      }
    });

    const plan = planFor(document);

    expect(plan.classification).toBe("PROVIDER_REQUIRED");
    expect(plan.externalRequirements).toEqual(["provider:github"]);
    const serialized = JSON.stringify(plan);
    for (const forbidden of [
      "providerInstanceId",
      "credentialBroker",
      "helperPath",
      "mapping",
      "raw.invoke",
      '"invoke"'
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
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

describe("resolveSkillCapabilityPlan", () => {
  function externalCliPlan(extra: Partial<ParsedSkillDocument> = {}): TestPlan {
    return planFor(
      skill({
        instructions: "Run `npx skills add example` to continue.",
        ...extra
      })
    );
  }

  it("promotes a fully available external CLI requirement to effective NATIVE readiness", async () => {
    const resolve = resolver();
    expect(resolve).toBeTypeOf("function");

    const resolved = await resolve!(externalCliPlan(), {
      workspaceId: "ws_1",
      allowProcess: true,
      allowDynamicExecutables: false,
      allowedExecutableNames: ["npx"],
      inspectExecutable: async (executable) => {
        expect(executable).toBe("npx");
        return { executableAvailable: true, sandboxAvailable: true };
      }
    });

    expect(resolved.classification).toBe("NATIVE");
    expect(resolved.missingCapabilities).not.toContain("external-cli:npx");
    expect(resolved.externalCliRequirements).toEqual([
      {
        requirement: "external-cli:npx",
        executable: "npx",
        status: "available",
        capability: "process.run"
      }
    ]);
    expect(resolved.nativeCapabilities).toContain("process.run");
    expect(resolved.guidance).toContainEqual(
      expect.objectContaining({ capability: "process.run" })
    );
  });

  it("reports process policy denial without probing the executable", async () => {
    const resolve = resolver();
    expect(resolve).toBeTypeOf("function");
    let probes = 0;

    const resolved = await resolve!(externalCliPlan(), {
      workspaceId: "ws_1",
      allowProcess: false,
      allowDynamicExecutables: false,
      allowedExecutableNames: ["npx"],
      inspectExecutable: async () => {
        probes += 1;
        return { executableAvailable: true, sandboxAvailable: true };
      }
    });

    expect(probes).toBe(0);
    expect(resolved.classification).toBe("PARTIAL");
    expect(resolved.missingCapabilities).toContain("external-cli:npx");
    expect(resolved.externalCliRequirements?.[0]?.status).toBe("not-allowed");
  });

  it("resolves an unlisted external CLI through dynamic executable authority", async () => {
    const resolve = resolver();
    expect(resolve).toBeTypeOf("function");
    const plan: TestPlan = {
      schemaVersion: 1,
      classification: "PARTIAL",
      nativeCapabilities: [],
      missingCapabilities: ["external-cli:uv"],
      externalRequirements: [],
      blockedSemantics: [],
      guidance: [],
      truncated: false,
      truncationReasons: []
    };
    let probes = 0;

    const resolved = await resolve!(plan, {
      workspaceId: "ws_dynamic",
      allowProcess: true,
      allowDynamicExecutables: true,
      allowedExecutableNames: ["node"],
      inspectExecutable: async (executable) => {
        probes += 1;
        expect(executable).toBe("uv");
        return { executableAvailable: true, sandboxAvailable: true };
      }
    });

    expect(probes).toBe(1);
    expect(resolved.classification).toBe("NATIVE");
    expect(resolved.missingCapabilities).toEqual([]);
    expect(resolved.nativeCapabilities).toContain("process.run");
    expect(resolved.externalCliRequirements).toEqual([
      {
        requirement: "external-cli:uv",
        executable: "uv",
        status: "available",
        capability: "process.run"
      }
    ]);
  });

  it("reports executable allowlist denial without probing the executable", async () => {
    const resolve = resolver();
    expect(resolve).toBeTypeOf("function");
    let probes = 0;

    const resolved = await resolve!(externalCliPlan(), {
      workspaceId: "ws_1",
      allowProcess: true,
      allowDynamicExecutables: false,
      allowedExecutableNames: ["node"],
      inspectExecutable: async () => {
        probes += 1;
        return { executableAvailable: true, sandboxAvailable: true };
      }
    });

    expect(probes).toBe(0);
    expect(resolved.externalCliRequirements?.[0]?.status).toBe("not-allowed");
  });

  it("distinguishes not-installed from sandbox-unavailable", async () => {
    const resolve = resolver();
    expect(resolve).toBeTypeOf("function");

    const notInstalled = await resolve!(externalCliPlan(), {
      workspaceId: "ws_1",
      allowProcess: true,
      allowDynamicExecutables: false,
      allowedExecutableNames: ["npx"],
      inspectExecutable: async () => ({ executableAvailable: false, sandboxAvailable: true })
    });
    expect(notInstalled.externalCliRequirements?.[0]?.status).toBe("not-installed");

    const noSandbox = await resolve!(externalCliPlan(), {
      workspaceId: "ws_1",
      allowProcess: true,
      allowDynamicExecutables: false,
      allowedExecutableNames: ["npx"],
      inspectExecutable: async () => ({ executableAvailable: true, sandboxAvailable: false })
    });
    expect(noSandbox.externalCliRequirements?.[0]?.status).toBe("sandbox-unavailable");
  });

  it("keeps unrelated missing capabilities and PARTIAL classification", async () => {
    const resolve = resolver();
    expect(resolve).toBeTypeOf("function");
    const plan = planFor(
      skill({
        metadata: { kodegpt: { requires: { capabilities: ["example.missing"] } } },
        instructions: "Run `npx skills add example` to continue."
      })
    );

    const resolved = await resolve!(plan, {
      workspaceId: "ws_1",
      allowProcess: true,
      allowDynamicExecutables: false,
      allowedExecutableNames: ["npx"],
      inspectExecutable: async () => ({ executableAvailable: true, sandboxAvailable: true })
    });

    expect(resolved.classification).toBe("PARTIAL");
    expect(resolved.missingCapabilities).toEqual(["example.missing"]);
  });

  it("never promotes a truncated missing-capability plan to NATIVE", async () => {
    const resolve = resolver();
    expect(resolve).toBeTypeOf("function");
    const truncatedPlan: TestPlan = {
      schemaVersion: 1,
      classification: "PARTIAL",
      nativeCapabilities: [],
      missingCapabilities: ["external-cli:npx"],
      externalRequirements: [],
      blockedSemantics: [],
      guidance: [],
      truncated: true,
      truncationReasons: ["MISSING_CAPABILITIES"]
    };

    const resolved = await resolve!(truncatedPlan, {
      workspaceId: "ws_1",
      allowProcess: true,
      allowDynamicExecutables: false,
      allowedExecutableNames: ["npx"],
      inspectExecutable: async () => ({ executableAvailable: true, sandboxAvailable: true })
    });

    expect(resolved.missingCapabilities).toEqual([]);
    expect(resolved.classification).toBe("PARTIAL");
    expect(resolved.truncated).toBe(true);
    expect(resolved.truncationReasons).toContain("MISSING_CAPABILITIES");
  });

  it("never promotes provider-required or unsupported plans", async () => {
    const resolve = resolver();
    expect(resolve).toBeTypeOf("function");
    const context = {
      workspaceId: "ws_1",
      allowProcess: true,
      allowDynamicExecutables: false,
      allowedExecutableNames: ["npx"],
      inspectExecutable: async () => ({ executableAvailable: true, sandboxAvailable: true })
    };

    const providerPlan = planFor(
      skill({
        metadata: { kodegpt: { requires: { providers: ["figma"] } } },
        instructions: "Run `npx skills add example` to continue."
      })
    );
    expect((await resolve!(providerPlan, context)).classification).toBe("PROVIDER_REQUIRED");

    const unsupportedPlan = planFor(
      skill({ instructions: "Run `npx skills add example`, then `codex exec --full-auto`." })
    );
    expect((await resolve!(unsupportedPlan, context)).classification).toBe("UNSUPPORTED");
  });

  it("returns deterministic immutable external CLI resolution evidence", async () => {
    const resolve = resolver();
    expect(resolve).toBeTypeOf("function");
    const context = {
      workspaceId: "ws_1",
      allowProcess: true,
      allowDynamicExecutables: false,
      allowedExecutableNames: ["npx"],
      inspectExecutable: async () => ({ executableAvailable: true, sandboxAvailable: true })
    };

    const first = await resolve!(externalCliPlan(), context);
    const second = await resolve!(externalCliPlan(), context);

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.externalCliRequirements)).toBe(true);
    expect(first.externalCliRequirements?.every((entry) => Object.isFrozen(entry))).toBe(true);
  });
});
