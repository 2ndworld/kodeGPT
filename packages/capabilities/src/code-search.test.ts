import { describe, expect, it } from "vitest";

import type {
  CapabilitySearchMatch,
  CapabilityTreeEntry,
  CodeSearchAdapter,
  WorkspaceInspectionAdapter
} from "./adapters.js";
import type { CodeSearchTruncationReason } from "./contracts.js";
import { NativeCapabilityService } from "./native-capability-service.js";
import { createTestCapabilityDependencies } from "./test-support.js";

function service(options: {
  tree?: CapabilityTreeEntry[];
  treeTruncated?: boolean;
  search?: CapabilitySearchMatch[];
  searchTruncated?: boolean;
  searchTruncationReasons?: CodeSearchTruncationReason[];
  onTree?: (scope: "literal" | "semantic" | undefined) => void;
  onSearch?: (scope: "literal" | "semantic" | undefined) => void;
}): NativeCapabilityService {
  const workspaceInspection: WorkspaceInspectionAdapter = {
    readFile: async () => ({ contents: "", bytesRead: 0, eof: true }),
    tree: async (_workspaceId, _path, _maxEntries, scope) => {
      options.onTree?.(scope);
      return {
        entries: options.tree ?? [],
        truncated: options.treeTruncated ?? false
      };
    }
  };
  const codeSearch: CodeSearchAdapter = {
    search: async (_workspaceId, _query, _path, _maxMatches, scope) => {
      options.onSearch?.(scope);
      return {
        matches: options.search ?? [],
        truncated: options.searchTruncated ?? false,
        truncationReasons: options.searchTruncationReasons ?? []
      };
    }
  };
  return new NativeCapabilityService(
    createTestCapabilityDependencies({
      workspace: {
        inspection: workspaceInspection,
        search: codeSearch
      }
    })
  );
}

describe("code.search", () => {
  it("uses lexical search for text mode with exact precision", async () => {
    const capability = service({
      search: [
        { path: "src/main.ts", line: 3, lineText: "const value = needle + 1;" },
        { path: "src/other.ts", line: 8, lineText: "needle();" }
      ]
    });

    const result = await capability.searchCode({
      workspaceId: "ws_text",
      query: "needle",
      mode: "text"
    });

    expect(result).toEqual({
      schemaVersion: 1,
      mode: "text",
      precision: "exact",
      matches: [
        {
          path: "src/main.ts",
          line: 3,
          column: 15,
          kind: "text",
          preview: "const value = needle + 1;"
        },
        {
          path: "src/other.ts",
          line: 8,
          column: 1,
          kind: "text",
          preview: "needle();"
        }
      ],
      truncated: false,
      truncationReasons: []
    });
  });

  it("filters path mode case-sensitively and reports configured truncation", async () => {
    const capability = service({
      tree: [
        { path: "src/Foo.ts", kind: "file" },
        { path: "src/foo.ts", kind: "file" },
        { path: "src/foo.test.ts", kind: "file" }
      ]
    });

    const result = await capability.searchCode({
      workspaceId: "ws_path",
      query: "foo",
      mode: "path",
      maxResults: 1
    });

    expect(result).toEqual({
      schemaVersion: 1,
      mode: "path",
      precision: "lexical",
      matches: [{ path: "src/foo.test.ts", kind: "path" }],
      truncated: true,
      truncationReasons: ["MATCH_LIMIT"]
    });
  });

  it("uses semantic traversal for both path and lexical search modes", async () => {
    const treeScopes: Array<"literal" | "semantic" | undefined> = [];
    const searchScopes: Array<"literal" | "semantic" | undefined> = [];
    const capability = service({
      tree: [{ path: "src/needle.ts", kind: "file" }],
      search: [{ path: "src/needle.ts", line: 1, lineText: "needle" }],
      onTree: (scope) => treeScopes.push(scope),
      onSearch: (scope) => searchScopes.push(scope)
    });

    await capability.searchCode({ workspaceId: "ws_scope", query: "needle", mode: "path" });
    await capability.searchCode({ workspaceId: "ws_scope", query: "needle", mode: "text" });

    expect(treeScopes).toEqual(["semantic"]);
    expect(searchScopes).toEqual(["semantic"]);
  });

  it("keeps symbol mode heuristic and matches whole identifiers only", async () => {
    const capability = service({
      search: [
        { path: "src/main.ts", line: 1, lineText: "function foo() {}" },
        { path: "src/main.ts", line: 2, lineText: "foo();" },
        { path: "src/main.ts", line: 3, lineText: "foobar();" }
      ]
    });

    const result = await capability.searchCode({
      workspaceId: "ws_symbol",
      query: "foo",
      mode: "symbol"
    });

    expect(result.precision).toBe("heuristic");
    expect(result.matches).toEqual([
      { path: "src/main.ts", line: 1, column: 10, kind: "symbol", preview: "function foo() {}" },
      { path: "src/main.ts", line: 2, column: 1, kind: "symbol", preview: "foo();" }
    ]);
    expect(result.truncated).toBe(false);
  });

  it.each([
    ["function foo() {}", "foo"],
    ["export function foo() {}", "foo"],
    ["class Foo {}", "Foo"],
    ["const foo = () => 1", "foo"],
    ["fn foo() {}", "foo"],
    ["struct Foo {}", "Foo"],
    ["trait Foo {}", "Foo"]
  ])("recognizes definition heuristic %s", async (lineText, query) => {
    const capability = service({
      search: [{ path: "src/definition.txt", line: 4, lineText }]
    });

    const result = await capability.searchCode({
      workspaceId: "ws_definition",
      query,
      mode: "definition"
    });

    expect(result.precision).toBe("heuristic");
    expect(result.matches).toEqual([
      {
        path: "src/definition.txt",
        line: 4,
        column: lineText.indexOf(query) + 1,
        kind: "definition",
        preview: lineText
      }
    ]);
  });

  it("excludes recognized definition lines from reference mode", async () => {
    const capability = service({
      search: [
        { path: "src/main.ts", line: 1, lineText: "function foo() {}" },
        { path: "src/main.ts", line: 4, lineText: "foo();" },
        { path: "src/main.ts", line: 8, lineText: "const value = foo();" }
      ]
    });

    const result = await capability.searchCode({
      workspaceId: "ws_reference",
      query: "foo",
      mode: "reference"
    });

    expect(result.precision).toBe("heuristic");
    expect(result.matches).toEqual([
      { path: "src/main.ts", line: 4, column: 1, kind: "reference", preview: "foo();" },
      {
        path: "src/main.ts",
        line: 8,
        column: 15,
        kind: "reference",
        preview: "const value = foo();"
      }
    ]);
  });

  it("propagates low-level truncation even when fewer classified matches survive", async () => {
    const capability = service({
      search: [{ path: "src/main.ts", line: 1, lineText: "foo();" }],
      searchTruncated: true,
      searchTruncationReasons: ["FILE_SIZE_LIMIT"]
    });

    const result = await capability.searchCode({
      workspaceId: "ws_truncated",
      query: "foo",
      mode: "definition",
      maxResults: 50
    });

    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.truncationReasons).toEqual(["FILE_SIZE_LIMIT"]);
  });

  it("reports tree truncation separately in path mode", async () => {
    const capability = service({
      tree: [{ path: "src/foo.ts", kind: "file" }],
      treeTruncated: true
    });

    await expect(
      capability.searchCode({ workspaceId: "ws_path_tree", query: "foo", mode: "path" })
    ).resolves.toMatchObject({
      truncated: true,
      truncationReasons: ["TREE_LIMIT"]
    });
  });

  it("uses stable capability errors for invalid input and result limits", async () => {
    const capability = service({});

    await expect(capability.searchCode({ workspaceId: "", query: "needle" })).rejects.toMatchObject({
      code: "CAPABILITY_INPUT_INVALID"
    });
    await expect(
      capability.searchCode({ workspaceId: "ws_limit", query: "needle", maxResults: 501 })
    ).rejects.toMatchObject({ code: "CAPABILITY_LIMIT_EXCEEDED" });
  });
});
