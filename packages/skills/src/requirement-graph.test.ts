import { describe, expect, it } from "vitest";

import { analyzeSkillCompatibility } from "./compatibility.js";
import type { ParsedSkillDocument } from "./contracts.js";
import { buildSkillRequirementGraph } from "./requirement-graph.js";

function skill(overrides: Partial<ParsedSkillDocument> = {}): ParsedSkillDocument {
  return {
    name: "workflow",
    description: "Workflow",
    unknownMetadataKeys: [],
    instructions: "Follow the workflow.",
    ...overrides
  };
}

describe("buildSkillRequirementGraph", () => {
  it("keeps conditional stage support independent from core compatibility", () => {
    const document = skill({
      metadata: {
        kodegpt: {
          requires: { actions: ["context.build"] },
          stages: [{ id: "visual", actions: ["future.visual"] }]
        }
      }
    });
    const compatibility = analyzeSkillCompatibility(document);
    const graph = buildSkillRequirementGraph(document, compatibility);

    expect(compatibility.classification).toBe("NATIVE");
    expect(graph.core.classification).toBe("NATIVE");
    expect(graph.stages.find((stage) => stage.id === "visual")?.classification).toBe("PARTIAL");
    expect(graph.stages.find((stage) => stage.id === "visual")?.missingActions).toEqual([
      "future.visual"
    ]);
  });

  it("infers exact public action references not declared in metadata into core", () => {
    const document = skill({
      instructions: "On resume, inspect `workspace.info`, then continue with the current repository state."
    });
    const graph = buildSkillRequirementGraph(document, analyzeSkillCompatibility(document));

    expect(graph.core.inferredActions).toContain("workspace.info");
    expect(graph.core.actions).toContainEqual({
      id: "workspace.info",
      known: true,
      source: "static"
    });
  });

  it("does not move declared stage actions into inferred core", () => {
    const document = skill({
      metadata: {
        kodegpt: {
          requires: { actions: ["context.build"] },
          stages: [
            {
              id: "visual",
              actions: ["visual.captureMatrix", "visual.compare"]
            }
          ]
        }
      },
      instructions:
        "Build context with `context.build`; when UI evidence is relevant use `visual.captureMatrix` and `visual.compare`."
    });
    const graph = buildSkillRequirementGraph(document, analyzeSkillCompatibility(document));

    expect(graph.core.inferredActions).not.toContain("visual.captureMatrix");
    expect(graph.core.inferredActions).not.toContain("visual.compare");
    expect(graph.stages.find((stage) => stage.id === "visual")?.actions.map((action) => action.id)).toEqual([
      "visual.captureMatrix",
      "visual.compare"
    ]);
  });

  it("reports unknown declared core actions as missing instead of crashing", () => {
    const document = skill({
      metadata: { kodegpt: { requires: { actions: ["future.unknown", "context.build"] } } }
    });
    const graph = buildSkillRequirementGraph(document, analyzeSkillCompatibility(document));

    expect(graph.core.classification).toBe("PARTIAL");
    expect(graph.core.missingActions).toEqual(["future.unknown"]);
    expect(graph.core.actions).toContainEqual({
      id: "future.unknown",
      known: false,
      source: "declared"
    });
  });

  it("classifies stage providers independently and preserves known non-native public actions", () => {
    const document = skill({
      metadata: {
        kodegpt: {
          stages: [
            {
              id: "browser",
              actions: ["browser.inspect"],
              providers: ["browser-provider"]
            }
          ]
        }
      }
    });
    const graph = buildSkillRequirementGraph(document, analyzeSkillCompatibility(document));
    const stage = graph.stages[0];

    expect(stage?.classification).toBe("PROVIDER_REQUIRED");
    expect(stage?.missingActions).toEqual([]);
    expect(stage?.actions).toContainEqual({
      id: "browser.inspect",
      known: true,
      source: "declared"
    });
  });

  it("returns deterministic frozen evidence and declared+static analysis basis", () => {
    const document = skill({
      metadata: { kodegpt: { requires: { actions: ["file.read"] } } },
      instructions: "Use `file.read` and then inspect `git.status`."
    });
    const graph = buildSkillRequirementGraph(document, analyzeSkillCompatibility(document));

    expect(graph.analysisBasis).toBe("declared+static");
    expect(graph.truncated).toBe(false);
    expect(graph.truncationReasons).toEqual([]);
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.core)).toBe(true);
    expect(Object.isFrozen(graph.core.actions)).toBe(true);
    expect(Object.isFrozen(graph.stages)).toBe(true);
  });
});
