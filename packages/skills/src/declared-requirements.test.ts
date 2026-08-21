import { describe, expect, it } from "vitest";

import { readKodegptDeclaredRequirements } from "./declared-requirements.js";

describe("readKodegptDeclaredRequirements", () => {
  it("parses core actions, capabilities, providers, unsupported semantics, and bounded stages", () => {
    expect(
      readKodegptDeclaredRequirements({
        kodegpt: {
          requires: {
            capabilities: ["process.run", "process.run"],
            providers: ["github"],
            actions: ["context.build", "verify.run"]
          },
          providers: ["legacy-provider"],
          unsupported: ["subagent.session"],
          stages: [
            {
              id: "visual",
              description: "Gather responsive visual evidence.",
              actions: ["visual.captureMatrix", "visual.compare"],
              capabilities: ["process.run"],
              providers: ["browser"]
            }
          ]
        }
      })
    ).toEqual({
      present: true,
      valid: true,
      actions: ["context.build", "verify.run"],
      capabilities: ["process.run"],
      providers: ["github", "legacy-provider"],
      unsupported: ["subagent.session"],
      stages: [
        {
          id: "visual",
          description: "Gather responsive visual evidence.",
          actions: ["visual.captureMatrix", "visual.compare"],
          capabilities: ["process.run"],
          providers: ["browser"]
        }
      ]
    });
  });

  it("preserves the no-declaration result", () => {
    expect(readKodegptDeclaredRequirements(undefined)).toEqual({
      present: false,
      valid: true,
      actions: [],
      capabilities: [],
      providers: [],
      unsupported: [],
      stages: []
    });
  });

  it("marks malformed declarations invalid without throwing", () => {
    for (const metadata of [
      { kodegpt: "invalid" },
      { kodegpt: { requires: { actions: "context.build" } } },
      { kodegpt: { stages: "visual" } },
      { kodegpt: { stages: [{ id: "Bad Stage", actions: [] }] } },
      { kodegpt: { stages: [{ id: "visual", actions: "visual.compare" }] } }
    ]) {
      expect(readKodegptDeclaredRequirements(metadata).valid).toBe(false);
    }
  });

  it("rejects duplicate stage ids", () => {
    const result = readKodegptDeclaredRequirements({
      kodegpt: {
        stages: [
          { id: "visual", actions: [] },
          { id: "visual", actions: [] }
        ]
      }
    });
    expect(result.valid).toBe(false);
  });

  it("enforces stage and requirement bounds", () => {
    expect(
      readKodegptDeclaredRequirements({
        kodegpt: { stages: Array.from({ length: 17 }, (_, index) => ({ id: `stage-${index}` })) }
      }).valid
    ).toBe(false);
    expect(
      readKodegptDeclaredRequirements({
        kodegpt: { requires: { actions: Array.from({ length: 33 }, (_, index) => `action.${index}`) } }
      }).valid
    ).toBe(false);
    expect(
      readKodegptDeclaredRequirements({
        kodegpt: {
          stages: [
            {
              id: "many-actions",
              actions: Array.from({ length: 33 }, (_, index) => `action.${index}`)
            }
          ]
        }
      }).valid
    ).toBe(false);
    expect(
      readKodegptDeclaredRequirements({
        kodegpt: {
          stages: [
            {
              id: "many-capabilities",
              capabilities: Array.from({ length: 17 }, (_, index) => `cap.${index}`)
            }
          ]
        }
      }).valid
    ).toBe(false);
    expect(
      readKodegptDeclaredRequirements({
        kodegpt: {
          stages: [
            {
              id: "many-providers",
              providers: Array.from({ length: 9 }, (_, index) => `provider-${index}`)
            }
          ]
        }
      }).valid
    ).toBe(false);
  });

  it("rejects overlong stage ids and descriptions", () => {
    expect(
      readKodegptDeclaredRequirements({
        kodegpt: { stages: [{ id: "a".repeat(65) }] }
      }).valid
    ).toBe(false);
    expect(
      readKodegptDeclaredRequirements({
        kodegpt: { stages: [{ id: "visual", description: "x".repeat(1025) }] }
      }).valid
    ).toBe(false);
  });
});
