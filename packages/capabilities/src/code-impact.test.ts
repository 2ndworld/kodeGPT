import { describe, expect, it } from "vitest";

import type {
  CapabilitySearchMatch,
  CapabilityTreeEntry,
  CodeSearchAdapter,
  WorkspaceInspectionAdapter
} from "./adapters.js";
import { NativeCapabilityService } from "./native-capability-service.js";
import { createTestCapabilityDependencies } from "./test-support.js";

function impactService(files: Record<string, string>, extraEntries: CapabilityTreeEntry[] = []) {
  const fileEntries = Object.keys(files).map((path) => ({ path, kind: "file" as const }));
  const workspace: WorkspaceInspectionAdapter = {
    async readFile(_workspaceId, path, options) {
      const contents = files[path] ?? "";
      const bytes = Buffer.from(contents);
      const maxBytes = options?.maxBytes ?? Number.MAX_SAFE_INTEGER;
      const retained = bytes.subarray(0, maxBytes).toString("utf8");
      return {
        contents: retained,
        bytesRead: Buffer.byteLength(retained),
        eof: bytes.byteLength <= maxBytes
      };
    },
    async tree() {
      return { entries: [...extraEntries, ...fileEntries], truncated: false };
    }
  };
  const search: CodeSearchAdapter = {
    async search(_workspaceId, query, path, maxMatches) {
      const matches: CapabilitySearchMatch[] = [];
      for (const [filePath, contents] of Object.entries(files).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      )) {
        if (path !== undefined && !filePath.startsWith(path)) continue;
        contents.split("\n").forEach((lineText, index) => {
          if (lineText.includes(query)) matches.push({ path: filePath, line: index + 1, lineText });
        });
      }
      return {
        matches: matches.slice(0, maxMatches),
        truncated: matches.length > maxMatches,
        truncationReasons: matches.length > maxMatches ? ["MATCH_LIMIT"] : []
      };
    }
  };
  return new NativeCapabilityService(
    createTestCapabilityDependencies({ workspace: { inspection: workspace, search } })
  );
}

describe("code.impact", () => {
  it("derives deterministic file dependents, related tests, and affected areas from existing repository evidence", async () => {
    const capability = impactService(
      {
        "packages/core/src/helper.ts": "export function helper() {}\n",
        "packages/app/src/use.ts": 'import { helper } from "../../core/src/helper.js";\nhelper();\n',
        "packages/core/src/helper.test.ts": 'import { helper } from "./helper.js";\nhelper();\n'
      },
      [
        { path: "packages/core", kind: "directory" },
        { path: "packages/app", kind: "directory" }
      ]
    );

    const result = await capability.impactCode({
      workspaceId: "ws_file",
      target: "packages/core/src/helper.ts",
      kind: "file"
    });

    expect(result).toEqual({
      schemaVersion: 1,
      target: {
        kind: "file",
        value: "packages/core/src/helper.ts",
        resolvedPaths: ["packages/core/src/helper.ts"]
      },
      dependents: [
        { path: "packages/app/src/use.ts", relationship: "imports" },
        { path: "packages/core/src/helper.test.ts", relationship: "imports" }
      ],
      relatedTests: ["packages/core/src/helper.test.ts"],
      affectedAreas: ["packages/app", "packages/core"],
      truncated: false,
      truncationReasons: []
    });
  });

  it("derives symbol references and related tests with bounded deterministic output", async () => {
    const capability = impactService(
      {
        "packages/core/src/helper.ts": "export function helper() {}\n",
        "packages/app/src/use.ts": 'import { helper } from "../../core/src/helper.js";\nhelper();\n',
        "packages/core/src/helper.test.ts": 'import { helper } from "./helper.js";\nhelper();\n'
      },
      [
        { path: "packages/core", kind: "directory" },
        { path: "packages/app", kind: "directory" }
      ]
    );

    const result = await capability.impactCode({
      workspaceId: "ws_symbol",
      target: "helper",
      kind: "symbol"
    });

    expect(result.target).toEqual({
      kind: "symbol",
      value: "helper",
      resolvedPaths: ["packages/core/src/helper.ts"]
    });
    expect(result.dependents).toEqual([
      { path: "packages/app/src/use.ts", relationship: "reference", line: 1 },
      { path: "packages/app/src/use.ts", relationship: "reference", line: 2 },
      { path: "packages/core/src/helper.test.ts", relationship: "reference", line: 1 },
      { path: "packages/core/src/helper.test.ts", relationship: "reference", line: 2 }
    ]);
    expect(result.relatedTests).toEqual(["packages/core/src/helper.test.ts"]);
    expect(result.affectedAreas).toEqual(["packages/app", "packages/core"]);
    expect(result.truncated).toBe(false);
  });

  it("reports stable section and upstream truncation reasons", async () => {
    const files = Object.fromEntries([
      ["packages/core/src/helper.ts", "export function helper() {}\n"],
      ...Array.from({ length: 201 }, (_, index) => [
        `packages/app${index}/src/use.ts`,
        `import { helper } from "../../core/src/helper.js";\nhelper();\n`
      ])
    ]);
    const capability = impactService(
      files,
      Array.from({ length: 5 }, (_, index) => ({
        path: index === 4 ? "packages/core" : `packages/app${index}`,
        kind: "directory" as const
      }))
    );

    const result = await capability.impactCode({
      workspaceId: "ws_limit",
      target: "helper",
      kind: "symbol",
      maxResults: 2
    });

    expect(result.dependents).toHaveLength(2);
    expect(result.affectedAreas).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.truncationReasons).toEqual(["DEPENDENT_LIMIT", "AREA_LIMIT", "SEARCH_LIMIT"]);
  });
});
