import { describe, expect, it } from "vitest";

import type { GitHistoryAdapter } from "./adapters.js";
import {
  MAX_GIT_HISTORY_RESPONSE_BYTES,
  type GitDiffHistoryResult,
  type GitLogResult,
  type GitRangeResult,
  type GitShowResult
} from "./contracts.js";
import { CapabilityError } from "./errors.js";
import { gitDiffHistory, gitLog, gitRange, gitShow } from "./git-history.js";
import { NativeCapabilityService } from "./native-capability-service.js";
import {
  GitLogInputSchema,
  GitRevisionSchema,
  GitShowInputSchema
} from "./schemas.js";
import { createTestCapabilityDependencies } from "./test-support.js";

const OID = "1".repeat(40);
const OID2 = "2".repeat(40);

function emptyLog(): GitLogResult {
  return {
    schemaVersion: 1,
    resolvedOid: OID,
    commits: [],
    returnedCount: 0,
    truncated: false,
    truncationReasons: []
  };
}

function emptyShow(): GitShowResult {
  return {
    schemaVersion: 1,
    commit: {
      oid: OID,
      shortOid: OID.slice(0, 12),
      parents: [],
      authorName: "A",
      authorTime: 1,
      committerTime: 1,
      subject: "subject",
      body: "",
      messageTruncated: false,
      encodingLossy: false
    },
    changedPaths: [],
    summary: { filesChanged: 0, insertions: 0, deletions: 0, binaryFiles: 0 },
    patch: null,
    truncated: false,
    truncationReasons: []
  };
}

function emptyRange(): GitRangeResult {
  return {
    schemaVersion: 1,
    baseOid: OID,
    headOid: OID2,
    isAncestor: false,
    mergeBaseOid: null,
    ahead: { value: 0, exact: true },
    behind: { value: 0, exact: true },
    commits: [],
    returnedCount: 0,
    truncated: false,
    truncationReasons: []
  };
}

function emptyDiff(): GitDiffHistoryResult {
  return {
    schemaVersion: 1,
    baseOid: OID,
    headOid: OID2,
    changedPaths: [],
    summary: { filesChanged: 0, insertions: 0, deletions: 0, binaryFiles: 0 },
    patch: "",
    truncated: false,
    truncationReasons: []
  };
}

function fakeAdapter(overrides: Partial<GitHistoryAdapter> = {}): GitHistoryAdapter {
  return {
    log: async () => emptyLog(),
    show: async () => emptyShow(),
    range: async () => emptyRange(),
    diffHistory: async () => emptyDiff(),
    ...overrides
  };
}

describe("Git history capabilities", () => {
  it("enforces closed revision grammar and bounded public inputs", () => {
    expect(GitLogInputSchema.parse({ workspaceId: "ws_x" })).toEqual({ workspaceId: "ws_x" });
    expect(() => GitLogInputSchema.parse({ workspaceId: "ws_x", limit: 101 })).toThrow();
    expect(() => GitRevisionSchema.parse({ kind: "oid", oid: "abc123" })).toThrow();
    expect(() => GitRevisionSchema.parse({ kind: "head", raw: "--all" })).toThrow();
    expect(() => GitShowInputSchema.parse({ workspaceId: "ws_x", maxPatchBytes: 262145 })).toThrow();
    expect(() => GitLogInputSchema.parse({ workspaceId: "ws_x", path: "é".repeat(3000) })).toThrow();
  });

  it("applies defaults before calling the adapter and native service delegates through gitHistory", async () => {
    let seen: unknown;
    const adapter = fakeAdapter({
      log: async (input) => {
        seen = input;
        return emptyLog();
      }
    });

    await gitLog(adapter, { workspaceId: "ws_x" });
    expect(seen).toEqual({ workspaceId: "ws_x", revision: { kind: "head" }, limit: 20 });

    const service = new NativeCapabilityService(createTestCapabilityDependencies({ gitHistory: adapter }));
    await service.gitLog({ workspaceId: "ws_x" });
    expect(seen).toEqual({ workspaceId: "ws_x", revision: { kind: "head" }, limit: 20 });
  });

  it("preserves stable history error codes and redacts unknown adapter errors", async () => {
    const stable = fakeAdapter({
      log: async () => {
        throw { code: "REVISION_NOT_FOUND", message: "raw stderr secret" };
      }
    });
    await expect(gitLog(stable, { workspaceId: "ws_x" })).rejects.toEqual(
      expect.objectContaining<Partial<CapabilityError>>({ code: "REVISION_NOT_FOUND", message: "Git history operation failed" })
    );

    const unknown = fakeAdapter({ log: async () => { throw new Error("/home/private secret"); } });
    await expect(gitLog(unknown, { workspaceId: "ws_x" })).rejects.toEqual(
      expect.objectContaining<Partial<CapabilityError>>({ code: "CAPABILITY_INTERNAL", message: "Native capability failed" })
    );
  });

  it("trims optional show body then patch to the public response budget and marks RESPONSE_LIMIT", async () => {
    const result = emptyShow();
    result.commit.body = "b".repeat(16 * 1024);
    result.patch = "p".repeat(256 * 1024);
    result.changedPaths = Array.from({ length: 75 }, (_, index) => ({
      path: `src/${index}-${"x".repeat(3300)}.txt`,
      status: "modified" as const,
      insertions: 1,
      deletions: 1,
      binary: false
    }));
    result.summary = { filesChanged: 75, insertions: 75, deletions: 75, binaryFiles: 0 };

    const bounded = await gitShow(fakeAdapter({ show: async () => result }), {
      workspaceId: "ws_x",
      includePatch: true
    });

    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(MAX_GIT_HISTORY_RESPONSE_BYTES);
    expect(bounded.truncated).toBe(true);
    expect(bounded.truncationReasons).toContain("RESPONSE_LIMIT");
    expect(bounded.commit.messageTruncated).toBe(true);
    expect(bounded.commit.body.length).toBeLessThan(result.commit.body.length);
    expect(bounded.patch).toBe(result.patch);
  });

  it("throws OUTPUT_LIMIT_EXCEEDED when fixed metadata alone exceeds the public response budget", async () => {
    const result = emptyDiff();
    result.changedPaths = Array.from({ length: 500 }, (_, index) => ({
      path: `src/${index}-${"x".repeat(4000)}.txt`,
      status: "modified" as const,
      insertions: 1,
      deletions: 1,
      binary: false
    }));
    result.summary = { filesChanged: 500, insertions: 500, deletions: 500, binaryFiles: 0 };
    result.patch = "p".repeat(256 * 1024);

    await expect(gitDiffHistory(fakeAdapter({ diffHistory: async () => result }), {
      workspaceId: "ws_x",
      baseRevision: { kind: "oid", oid: OID },
      headRevision: { kind: "oid", oid: OID2 }
    })).rejects.toMatchObject({ code: "OUTPUT_LIMIT_EXCEEDED" });
  });

  it("delegates all four native methods with structured inputs", async () => {
    const calls: string[] = [];
    const adapter = fakeAdapter({
      log: async () => { calls.push("log"); return emptyLog(); },
      show: async () => { calls.push("show"); return emptyShow(); },
      range: async () => { calls.push("range"); return emptyRange(); },
      diffHistory: async () => { calls.push("diffHistory"); return emptyDiff(); }
    });
    const service = new NativeCapabilityService(createTestCapabilityDependencies({ gitHistory: adapter }));
    await service.gitLog({ workspaceId: "ws_x" });
    await service.gitShow({ workspaceId: "ws_x" });
    await service.gitRange({ workspaceId: "ws_x", baseRevision: { kind: "oid", oid: OID }, headRevision: { kind: "oid", oid: OID2 } });
    await service.gitDiffHistory({ workspaceId: "ws_x", baseRevision: { kind: "oid", oid: OID }, headRevision: { kind: "oid", oid: OID2 } });
    expect(calls).toEqual(["log", "show", "range", "diffHistory"]);
  });
});
