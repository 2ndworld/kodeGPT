import { describe, expect, it } from "vitest";

import type { SkillSourceReadBytesResult, SkillSourceTreeResult, WorkspaceSkillSourceAuthority } from "./contracts.js";
import { WorkspaceSkillSourceProvider } from "./workspace-source.js";

function authority(): WorkspaceSkillSourceAuthority & { probes: string[]; trees: string[]; reads: string[] } {
  const probes: string[] = [];
  const trees: string[] = [];
  const reads: string[] = [];
  return {
    probes, trees, reads,
    listReady: async () => [
      { workspaceId: "ws_1", trustId: "trust_1" },
      { workspaceId: "ws_2", trustId: "trust_2" }
    ],
    pathIdentity: async (workspaceId, path) => {
      probes.push(`${workspaceId}:${path}`);
      if (path === ".codex/skills") return { exists: true, kind: "symlink" };
      return path === "skills" || path === ".agents/skills"
        ? { exists: true, kind: "directory" }
        : { exists: false };
    },
    tree: async (workspaceId, path, maxEntries): Promise<SkillSourceTreeResult> => {
      trees.push(`${workspaceId}:${path}:${maxEntries}`);
      const root = path.startsWith(".agents/skills") ? ".agents/skills" : "skills";
      return { entries: [
        { path: `${root}/demo`, kind: "directory", sizeBytes: 0 },
        { path: `${root}/demo/SKILL.md`, kind: "file", sizeBytes: 10 }
      ], truncated: false };
    },
    readBytes: async (workspaceId, path, offset, maxBytes): Promise<SkillSourceReadBytesResult> => {
      reads.push(`${workspaceId}:${path}:${offset}:${maxBytes}`);
      return { bytes: Uint8Array.from([1, 2, 3]), bytesRead: 3, eof: true };
    }
  };
}

describe("WorkspaceSkillSourceProvider", () => {
  it("discovers only conventional real directories with deterministic source IDs", async () => {
    const a = authority();
    const sources = await new WorkspaceSkillSourceProvider(a).listSources("ws_1");
    expect(a.probes).toEqual(["ws_1:skills", "ws_1:.agents/skills", "ws_1:.codex/skills"]);
    expect(sources.map((source) => source.label)).toEqual([
      "Workspace skills: skills", "Workspace skills: .agents/skills"
    ]);
    expect(sources.every((source) => /^ss_[a-f0-9]{32}$/.test(source.sourceId))).toBe(true);
    expect((await new WorkspaceSkillSourceProvider(authority()).listSources("ws_1")).map((s) => s.sourceId))
      .toEqual(sources.map((s) => s.sourceId));
    expect((await new WorkspaceSkillSourceProvider(authority()).listSources("ws_2")).map((s) => s.sourceId))
      .not.toEqual(sources.map((s) => s.sourceId));
  });

  it("normalizes workspace tree paths and reads bytes through the bound source", async () => {
    const a = authority();
    const provider = new WorkspaceSkillSourceProvider(a);
    const [source] = await provider.listSources("ws_1");
    const tree = await provider.tree({ workspaceId: "ws_1", sourceId: source!.sourceId, path: "." });
    expect(a.trees).toEqual(["ws_1:skills:20000"]);
    expect(tree.entries.map((entry) => entry.path)).toEqual(["demo", "demo/SKILL.md"]);
    await expect(provider.readBytes({ workspaceId: "ws_1", sourceId: source!.sourceId, path: "demo/SKILL.md", offset: 0, maxBytes: 64 }))
      .resolves.toEqual({ bytes: Uint8Array.from([1, 2, 3]), bytesRead: 3, eof: true });
    expect(a.reads).toEqual(["ws_1:skills/demo/SKILL.md:0:64"]);
  });

  it("requires matching READY workspace scope", async () => {
    const provider = new WorkspaceSkillSourceProvider(authority());
    const [source] = await provider.listSources("ws_1");
    await expect(provider.listReadyWorkspaceIds()).resolves.toEqual(["ws_1", "ws_2"]);
    await expect(provider.readBytes({ workspaceId: "ws_2", sourceId: source!.sourceId, path: "demo/SKILL.md", offset: 0, maxBytes: 64 }))
      .rejects.toMatchObject({ code: "SKILL_WORKSPACE_MISMATCH" });
    await expect(provider.listSources("ws_missing")).rejects.toMatchObject({ code: "SKILL_WORKSPACE_MISMATCH" });
  });

  it("skips non-directory conventional roots and rejects tree entries outside the bound source root", async () => {
    const a = authority();
    a.pathIdentity = async (workspaceId, path) => {
      a.probes.push(`${workspaceId}:${path}`);
      if (path === "skills") return { exists: true, kind: "directory" };
      if (path === ".agents/skills") return { exists: true, kind: "other" };
      if (path === ".codex/skills") return { exists: true, kind: "symlink" };
      return { exists: false };
    };
    a.tree = async () => ({
      entries: [{ path: "outside/SKILL.md", kind: "file", sizeBytes: 10 }],
      truncated: false
    });

    const provider = new WorkspaceSkillSourceProvider(a);
    const sources = await provider.listSources("ws_1");
    expect(sources.map((source) => source.label)).toEqual(["Workspace skills: skills"]);
    await expect(provider.tree({ workspaceId: "ws_1", sourceId: sources[0]!.sourceId, path: "." }))
      .rejects.toMatchObject({ code: "SKILL_SOURCE_BOUNDARY_VIOLATION" });
  });

  it("fails closed for non-canonical source-relative paths", async () => {
    const provider = new WorkspaceSkillSourceProvider(authority());
    const [source] = await provider.listSources("ws_1");
    await expect(provider.tree({ workspaceId: "ws_1", sourceId: source!.sourceId, path: "../outside" }))
      .rejects.toMatchObject({ code: "SKILL_SOURCE_BOUNDARY_VIOLATION" });
  });
});
