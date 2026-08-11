import { describe, expect, it } from "vitest";

import type { CapabilityTreeEntry, WorkspaceInspectionAdapter } from "./adapters.js";
import { NativeCapabilityService } from "./native-capability-service.js";

function makeWorkspaceAdapter(
  entries: CapabilityTreeEntry[],
  options: {
    files?: Record<string, string>;
    treeTruncated?: boolean;
    onTree?: (path: string | undefined, maxEntries: number) => void;
    onRead?: (path: string, maxBytes: number | undefined) => void;
  } = {}
): WorkspaceInspectionAdapter {
  const files = options.files ?? {};

  return {
    readFile: async (_workspaceId, path, readOptions) => {
      options.onRead?.(path, readOptions?.maxBytes);
      return {
        contents: files[path] ?? "",
        bytesRead: Buffer.byteLength(files[path] ?? "", "utf8"),
        eof: true
      };
    },
    tree: async (_workspaceId, path, maxEntries) => {
      options.onTree?.(path, maxEntries);
      return { entries, truncated: options.treeTruncated ?? false };
    }
  };
}

function makeService(workspaceInspection: WorkspaceInspectionAdapter): NativeCapabilityService {
  return new NativeCapabilityService({
    workspaceInspection,
    codeSearch: {
      search: async () => ({ matches: [], truncated: false })
    }
  });
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

  it("classifies only manifests at the inspection root", async () => {
    const node = makeService(
      makeWorkspaceAdapter([
        { path: "package.json", kind: "file" },
        { path: "pnpm-workspace.yaml", kind: "file" },
        { path: "examples/rust-demo/Cargo.toml", kind: "file" }
      ])
    );
    const rust = makeService(
      makeWorkspaceAdapter([
        { path: "Cargo.toml", kind: "file" },
        { path: "examples/node/package.json", kind: "file" }
      ])
    );

    expect((await node.inspectWorkspace({ workspaceId: "ws_node_root" })).projectTypes).toEqual([
      "node-pnpm"
    ]);
    expect((await rust.inspectWorkspace({ workspaceId: "ws_rust_root" })).projectTypes).toEqual([
      "rust-cargo"
    ]);
  });

  it("uses the scoped inspection root as project evidence", async () => {
    const service = makeService(
      makeWorkspaceAdapter([{ path: "examples/rust-demo/Cargo.toml", kind: "file" }])
    );

    const result = await service.inspectWorkspace({
      workspaceId: "ws_scoped_rust",
      path: "examples/rust-demo"
    });

    expect(result.projectTypes).toEqual(["rust-cargo"]);
    expect(result.manifests).toContainEqual({
      path: "examples/rust-demo/Cargo.toml",
      kind: "cargo-manifest"
    });
  });

  it("uses bounded root manifest reads to add explicit workspace member areas", async () => {
    const reads: Array<{ path: string; maxBytes: number | undefined }> = [];
    const service = makeService(
      makeWorkspaceAdapter(
        [
          { path: "package.json", kind: "file" },
          { path: "services/api", kind: "directory" },
          { path: "libs/shared", kind: "directory" },
          { path: "vendor/ignored", kind: "directory" }
        ],
        {
          files: {
            "package.json": JSON.stringify({ workspaces: ["services/*", "libs/*"] })
          },
          onRead: (path, maxBytes) => reads.push({ path, maxBytes })
        }
      )
    );

    const result = await service.inspectWorkspace({ workspaceId: "ws_members" });

    expect(result.areas).toEqual(
      expect.arrayContaining([
        { path: "services/api", kind: "package" },
        { path: "libs/shared", kind: "package" }
      ])
    );
    expect(result.areas).not.toContainEqual({ path: "vendor/ignored", kind: "package" });
    expect(reads).toEqual([{ path: "package.json", maxBytes: 64 * 1024 }]);
  });

  it("passes the requested workspace-relative path and bound to the trusted workspace adapter", async () => {
    let requestedPath: string | undefined;
    let requestedMaxEntries: number | undefined;
    const service = makeService(
      makeWorkspaceAdapter([{ path: "packages/core/package.json", kind: "file" }], {
        onTree: (path, maxEntries) => {
          requestedPath = path;
          requestedMaxEntries = maxEntries;
        }
      })
    );

    const result = await service.inspectWorkspace({
      workspaceId: "ws_scoped",
      path: "packages/core",
      maxEntries: 321
    });

    expect(requestedPath).toBe("packages/core");
    expect(requestedMaxEntries).toBe(321);
    expect(result.root).toBe("packages/core");
  });
});
