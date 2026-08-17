import { describe, expect, it } from "vitest";

import type { CapabilityTreeEntry, WorkspaceInspectionAdapter } from "./adapters.js";
import { analyzeRepository } from "./repository-analysis.js";

function adapter(
  files: Record<string, string>,
  options: { fail?: Set<string>; onRead?: (maxBytes: number) => void } = {}
): WorkspaceInspectionAdapter {
  return {
    async readFile(_workspaceId, path, readOptions) {
      if (options.fail?.has(path)) throw new Error("unreadable");
      const contents = files[path] ?? "";
      const maxBytes = readOptions?.maxBytes ?? Number.MAX_SAFE_INTEGER;
      options.onRead?.(maxBytes);
      const encoded = Buffer.from(contents);
      const chunk = encoded.subarray(0, maxBytes).toString("utf8");
      return { contents: chunk, bytesRead: Buffer.byteLength(chunk), eof: encoded.byteLength <= maxBytes };
    },
    async tree() {
      return { entries: [], truncated: false };
    }
  };
}

function entries(paths: string[]): CapabilityTreeEntry[] {
  return paths.map((path) => ({ path, kind: "file" as const }));
}

describe("repository analysis", () => {
  it("extracts bounded TypeScript and Rust symbols and relationships", async () => {
    const files = {
      "src/index.ts": 'export function start() {}\nimport { helper } from "./helper.js";\n',
      "src/helper.ts": "export const helper = 1;\n",
      "src/helper.test.ts": 'import { helper } from "./helper.js";\n',
      "src/lib.rs": "pub mod worker;\npub struct Engine;\n",
      "src/worker.rs": "pub fn run() {}\n"
    };

    const result = await analyzeRepository(adapter(files), "ws_1", entries(Object.keys(files)));

    expect(result.symbols).toEqual(
      expect.arrayContaining([
        { name: "start", kind: "function", path: "src/index.ts", line: 1, exported: true },
        { name: "helper", kind: "variable", path: "src/helper.ts", line: 1, exported: true },
        { name: "worker", kind: "module", path: "src/lib.rs", line: 1, exported: true },
        { name: "Engine", kind: "struct", path: "src/lib.rs", line: 2, exported: true },
        { name: "run", kind: "function", path: "src/worker.rs", line: 1, exported: true }
      ])
    );
    expect(result.relationships).toEqual(
      expect.arrayContaining([
        { from: "src/index.ts", to: "src/helper.ts", kind: "imports" },
        { from: "src/helper.test.ts", to: "src/helper.ts", kind: "imports" },
        { from: "src/helper.test.ts", to: "src/helper.ts", kind: "tests" },
        { from: "src/lib.rs", to: "src/worker.rs", kind: "module" }
      ])
    );
    expect(result.warnings).toEqual([]);
  });

  it("omits unresolved imports and de-duplicates deterministic relationships", async () => {
    const files = {
      "src/a.ts": 'import "./missing.js";\nimport { b } from "./b.js";\nexport { b } from "./b.js";\n',
      "src/b.ts": "export const b = 1;\n"
    };

    const result = await analyzeRepository(adapter(files), "ws_1", entries(Object.keys(files).reverse()));

    expect(result.relationships).toEqual([{ from: "src/a.ts", to: "src/b.ts", kind: "imports" }]);
    expect(result.symbols.map(({ path, name }) => `${path}:${name}`)).toEqual(["src/b.ts:b"]);
  });

  it("warns and skips unreadable or oversized source files", async () => {
    const files = {
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "x".repeat(128 * 1024 + 1)
    };
    const result = await analyzeRepository(
      adapter(files, { fail: new Set(["src/a.ts"]) }),
      "ws_1",
      entries(Object.keys(files))
    );

    expect(result.symbols).toEqual([]);
    expect(result.relationships).toEqual([]);
    expect(result.warnings).toEqual(["INSPECT_ANALYSIS_FILE_SKIPPED"]);
  });

  it("bounds source file analysis", async () => {
    const paths = Array.from({ length: 257 }, (_, index) => `src/f${String(index).padStart(3, "0")}.ts`);
    const files = Object.fromEntries(paths.map((path, index) => [path, `export const value${index} = ${index};\n`]));

    const result = await analyzeRepository(adapter(files), "ws_1", entries(paths));

    expect(result.symbols).toHaveLength(256);
    expect(result.warnings).toContain("INSPECT_ANALYSIS_FILE_LIMIT_REACHED");
  });

  it("bounds total source bytes requested from the workspace adapter", async () => {
    const paths = Array.from({ length: 33 }, (_, index) => `src/f${String(index).padStart(2, "0")}.ts`);
    const files = Object.fromEntries(paths.map((path) => [path, " ".repeat(128 * 1024)]));
    let requestedBytes = 0;

    const result = await analyzeRepository(
      adapter(files, { onRead: (maxBytes) => (requestedBytes += maxBytes) }),
      "ws_1",
      entries(paths)
    );

    expect(requestedBytes).toBe(4 * 1024 * 1024);
    expect(result.warnings).toContain("INSPECT_ANALYSIS_BYTE_LIMIT_REACHED");
  });

  it("bounds returned symbols", async () => {
    const body = Array.from({ length: 1001 }, (_, index) => `export const value${index} = ${index};`).join("\n");
    const result = await analyzeRepository(adapter({ "src/many.ts": body }), "ws_1", entries(["src/many.ts"]));

    expect(result.symbols).toHaveLength(1000);
    expect(result.warnings).toContain("INSPECT_SYMBOL_LIMIT_REACHED");
  });

  it("bounds returned relationships", async () => {
    const targetPaths = Array.from({ length: 1001 }, (_, index) => `src/z${String(index).padStart(4, "0")}.ts`);
    const body = targetPaths.map((path) => `import "./${path.slice(4, -3)}.js";`).join("\n");
    const files = { "src/a.ts": body, ...Object.fromEntries(targetPaths.map((path) => [path, ""])) };

    const result = await analyzeRepository(adapter(files), "ws_1", entries(Object.keys(files)));

    expect(result.relationships).toHaveLength(1000);
    expect(result.warnings).toContain("INSPECT_RELATIONSHIP_LIMIT_REACHED");
  });
});
