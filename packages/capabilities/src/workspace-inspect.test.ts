import { describe, expect, it } from "vitest";

import type {
  CapabilityExecutionAdapter,
  CapabilityTreeEntry,
  CapabilityWorkspaceAdapter
} from "./adapters.js";
import { NativeCapabilityService } from "./native-capability-service.js";

function makeWorkspaceAdapter(
  entries: CapabilityTreeEntry[],
  options: {
    files?: Record<string, string>;
    onTree?: (path: string | undefined) => void;
  } = {}
): CapabilityWorkspaceAdapter {
  const files = options.files ?? {};
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected adapter call");
  };

  return {
    info: (workspaceId) => ({
      id: workspaceId,
      canonicalRoot: "/home/private/workspace",
      effectivePolicy: {}
    }),
    readFile: async (_workspaceId, path) => ({
      contents: files[path] ?? "",
      bytesRead: Buffer.byteLength(files[path] ?? "", "utf8"),
      eof: true
    }),
    tree: async (_workspaceId, path) => {
      options.onTree?.(path);
      return entries;
    },
    search: unexpected,
    gitStatus: unexpected,
    gitDiff: unexpected,
    commitPatchFile: unexpected
  };
}

function makeService(workspace: CapabilityWorkspaceAdapter): NativeCapabilityService {
  const execution: CapabilityExecutionAdapter = {
    run: async () => {
      throw new Error("unexpected execution call");
    }
  };
  return new NativeCapabilityService({ workspace, execution });
}

describe("workspace.inspect", () => {
  it("detects a pnpm workspace from Node manifest evidence", async () => {
    const service = makeService(
      makeWorkspaceAdapter([
        { path: "package.json", kind: "file" },
        { path: "pnpm-workspace.yaml", kind: "file" },
        { path: "apps/web", kind: "directory" },
        { path: "apps/web/src/main.ts", kind: "file" },
        { path: "packages/shared", kind: "directory" },
        { path: "packages/shared/src/index.ts", kind: "file" }
      ])
    );

    const result = await service.inspectWorkspace({ workspaceId: "ws_node" });

    expect(result.projectTypes).toEqual(["node-pnpm"]);
    expect(result.languages).toContainEqual({ name: "TypeScript", fileCount: 2 });
    expect(result.areas).toContainEqual({ path: "apps/web", kind: "app" });
    expect(result.areas).toContainEqual({ path: "packages/shared", kind: "package" });
  });

  it("detects a Cargo workspace from Rust manifest evidence", async () => {
    const service = makeService(
      makeWorkspaceAdapter([
        { path: "Cargo.toml", kind: "file" },
        { path: "crates/core", kind: "directory" },
        { path: "crates/core/src/lib.rs", kind: "file" }
      ])
    );

    const result = await service.inspectWorkspace({ workspaceId: "ws_rust" });

    expect(result.projectTypes).toEqual(["rust-cargo"]);
    expect(result.languages).toContainEqual({ name: "Rust", fileCount: 1 });
    expect(result.areas).toContainEqual({ path: "crates/core", kind: "crate" });
  });

  it("detects mixed pnpm and Cargo projects only from explicit tree evidence", async () => {
    const service = makeService(
      makeWorkspaceAdapter([
        { path: "packages/core/src/index.ts", kind: "file" },
        { path: "Cargo.toml", kind: "file" },
        { path: "crates/runtime", kind: "directory" },
        { path: "package.json", kind: "file" },
        { path: "packages/core", kind: "directory" },
        { path: "pnpm-workspace.yaml", kind: "file" },
        { path: "crates/runtime/src/main.rs", kind: "file" },
        { path: "apps/cli/src/main.ts", kind: "file" },
        { path: "apps/cli", kind: "directory" }
      ])
    );

    const result = await service.inspectWorkspace({ workspaceId: "ws_1" });

    expect(result.schemaVersion).toBe(1);
    expect(result.workspaceId).toBe("ws_1");
    expect(result.root).toBe(".");
    expect(result.projectTypes).toEqual(["node-pnpm", "rust-cargo"]);
    expect(result.languages).toContainEqual({ name: "TypeScript", fileCount: 2 });
    expect(result.languages).toContainEqual({ name: "Rust", fileCount: 1 });
    expect(result.areas).toContainEqual({ path: "apps/cli", kind: "app" });
    expect(result.areas).toContainEqual({ path: "packages/core", kind: "package" });
    expect(result.areas).toContainEqual({ path: "crates/runtime", kind: "crate" });
    expect(result.entrypoints).toContainEqual({ path: "package.json", kind: "node-manifest" });
    expect(result.entrypoints).toContainEqual({ path: "Cargo.toml", kind: "cargo-manifest" });
    expect(result.manifests).toContainEqual({ path: "pnpm-workspace.yaml", kind: "pnpm-workspace" });
    expect(JSON.stringify(result)).not.toContain("/home/private/workspace");
  });

  it("keeps unknown projects generic instead of guessing architecture", async () => {
    const service = makeService(
      makeWorkspaceAdapter([
        { path: "src", kind: "directory" },
        { path: "src/main.xyz", kind: "file" },
        { path: "notes.txt", kind: "file" }
      ])
    );

    const result = await service.inspectWorkspace({ workspaceId: "ws_unknown" });

    expect(result.projectTypes).toEqual([]);
    expect(result.areas).toContainEqual({ path: "src", kind: "other" });
    expect(result.languages).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("sorts evidence lexically so repeated inspection is deterministic", async () => {
    const service = makeService(
      makeWorkspaceAdapter([
        { path: "z.ts", kind: "file" },
        { path: "tests/unit", kind: "directory" },
        { path: "a.rs", kind: "file" },
        { path: "docs/guide", kind: "directory" },
        { path: "vitest.config.ts", kind: "file" },
        { path: "tsconfig.json", kind: "file" }
      ])
    );

    const first = await service.inspectWorkspace({ workspaceId: "ws_order" });
    const second = await service.inspectWorkspace({ workspaceId: "ws_order" });

    expect(second).toEqual(first);
    expect(first.languages.map(({ name }) => name)).toEqual(["JSON", "Rust", "TypeScript"]);
    expect(first.areas.map(({ path }) => path)).toEqual([
      "docs/guide",
      "tests/unit",
      "tsconfig.json",
      "vitest.config.ts"
    ]);
    expect(first.entrypoints.map(({ path }) => path)).toEqual(["tsconfig.json", "vitest.config.ts"]);
  });

  it("applies maxEntries after lexical ordering and reports truncation", async () => {
    const service = makeService(
      makeWorkspaceAdapter([
        { path: "c.rs", kind: "file" },
        { path: "a.ts", kind: "file" },
        { path: "b.ts", kind: "file" }
      ])
    );

    const result = await service.inspectWorkspace({ workspaceId: "ws_bound", maxEntries: 2 });

    expect(result.languages).toEqual([{ name: "TypeScript", fileCount: 2 }]);
    expect(result.truncated).toBe(true);
    expect(result.warnings).toContain("INSPECT_MAX_ENTRIES_REACHED");
  });

  it("passes the requested workspace-relative path to the trusted workspace adapter", async () => {
    let requestedPath: string | undefined;
    const service = makeService(
      makeWorkspaceAdapter([{ path: "packages/core/package.json", kind: "file" }], {
        onTree: (path) => {
          requestedPath = path;
        }
      })
    );

    const result = await service.inspectWorkspace({
      workspaceId: "ws_scoped",
      path: "packages/core"
    });

    expect(requestedPath).toBe("packages/core");
    expect(result.root).toBe("packages/core");
  });
});
