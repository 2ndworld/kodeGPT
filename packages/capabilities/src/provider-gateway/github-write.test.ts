import { describe, expect, it } from "vitest";

import { ProviderAdapterRegistry } from "./adapter-registry.js";
import {
  GITHUB_WRITE_PROVIDER_ADAPTER_ID,
  GITHUB_WRITE_PROVIDER_MANIFEST,
  GitHubPrCreateInputSchema,
  GitHubPrCreateResultSchema,
  GitHubPrMergeInputSchema,
  GitHubPrMergeResultSchema
} from "./github-write.js";
import { parseProviderSemanticOutput } from "./output.js";

const REPOSITORY = "2ndworld/kodeGPT";
const OID = "a".repeat(40);

function operation(id: "pr.create" | "pr.merge") {
  const found = GITHUB_WRITE_PROVIDER_MANIFEST.operations.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing operation ${id}`);
  return found;
}

function mapping(id: "github.pr.create" | "github.pr.merge") {
  const found = GITHUB_WRITE_PROVIDER_MANIFEST.mappings.find((item) => item.semanticCapabilityId === id);
  if (found === undefined) throw new Error(`missing mapping ${id}`);
  return found;
}

function rawCreatedPr() {
  return {
    number: 23,
    title: "feat: bounded write",
    state: "open",
    user: { login: "2ndworld" },
    base: { ref: "main", repo: { full_name: REPOSITORY } },
    head: { ref: "feat/bounded-write" },
    draft: false,
    html_url: "https://github.com/2ndworld/kodeGPT/pull/23",
    created_at: "2026-08-17T06:30:00Z",
    updated_at: "2026-08-17T06:30:00Z"
  };
}

describe("github.write.v1", () => {
  it("defines a separate static mutation adapter with exactly create and merge", () => {
    expect(GITHUB_WRITE_PROVIDER_ADAPTER_ID).toBe("github.write.v1");
    expect(GITHUB_WRITE_PROVIDER_MANIFEST.adapterId).toBe("github.write.v1");
    expect(GITHUB_WRITE_PROVIDER_MANIFEST.inventoryMode).toBe("STATIC");
    expect(GITHUB_WRITE_PROVIDER_MANIFEST.networkPolicy).toEqual({
      kind: "internet",
      origins: ["https://api.github.com"],
      redirect: null
    });
    expect(GITHUB_WRITE_PROVIDER_MANIFEST.operations.map(({ id }) => id)).toEqual(["pr.create", "pr.merge"]);
    expect(GITHUB_WRITE_PROVIDER_MANIFEST.mappings.map(({ semanticCapabilityId }) => semanticCapabilityId)).toEqual([
      "github.pr.create",
      "github.pr.merge"
    ]);
    for (const item of GITHUB_WRITE_PROVIDER_MANIFEST.mappings) {
      expect(item.effect).toBe("REMOTE_MUTATION");
      expect(item.retry).toBe("none");
      expect(item.maxProviderRequests).toBe(1);
      expect(item.workspaceBinding).toBe("NONE");
    }
    expect(() => new ProviderAdapterRegistry([GITHUB_WRITE_PROVIDER_MANIFEST])).not.toThrow();
  });

  it("keeps PR create input strict and bounded", () => {
    const input = {
      repository: REPOSITORY,
      title: "feat: bounded write",
      headBranch: "feat/bounded-write",
      baseBranch: "main",
      body: "line 1\r\nline 2"
    };
    expect(GitHubPrCreateInputSchema.parse(input)).toEqual(input);
    expect(() => GitHubPrCreateInputSchema.parse({ ...input, title: "" })).toThrow();
    expect(() => GitHubPrCreateInputSchema.parse({ ...input, body: "x".repeat(16 * 1024 + 1) })).toThrow();
    expect(() => GitHubPrCreateInputSchema.parse({ ...input, headBranch: "bad\nbranch" })).toThrow();
    expect(() => GitHubPrCreateInputSchema.parse({ ...input, draft: true })).toThrow();
    expect(() => GitHubPrCreateInputSchema.parse({ ...input, providerInstanceId: "prv_no" })).toThrow();
    expect(() => GitHubPrCreateInputSchema.parse({ ...input, token: "secret" })).toThrow();
  });

  it("encodes PR create as one fixed POST body", () => {
    const input = GitHubPrCreateInputSchema.parse({
      repository: REPOSITORY,
      title: "feat: bounded write",
      headBranch: "feat/bounded-write",
      baseBranch: "main",
      body: "line 1\r\nline 2"
    });
    const create = operation("pr.create");
    expect(create.method).toBe("POST");
    expect(create.origin).toBe("https://api.github.com");
    expect(create.pathTemplate).toBe("/repos/{owner}/{repo}/pulls");
    expect(create.allowedQueryKeys).toEqual([]);
    expect(create.encodeRequest(input)).toEqual({
      pathParameters: { owner: "2ndworld", repo: "kodeGPT" },
      body: {
        title: "feat: bounded write",
        head: "feat/bounded-write",
        base: "main",
        body: "line 1\nline 2"
      }
    });
  });

  it("maps PR create output to the strict normalized public shape", () => {
    const input = GitHubPrCreateInputSchema.parse({
      repository: REPOSITORY,
      title: "feat: bounded write",
      headBranch: "feat/bounded-write",
      baseBranch: "main"
    });
    const value = parseProviderSemanticOutput(
      Buffer.from(JSON.stringify(rawCreatedPr())),
      GitHubPrCreateResultSchema,
      { semanticInput: input, mapOutput: mapping("github.pr.create").mapOutput }
    );
    expect(value).toEqual({
      repository: REPOSITORY,
      number: 23,
      title: "feat: bounded write",
      state: "open",
      authorLogin: "2ndworld",
      baseBranch: "main",
      headBranch: "feat/bounded-write",
      draft: false,
      htmlUrl: "https://github.com/2ndworld/kodeGPT/pull/23",
      createdAt: "2026-08-17T06:30:00Z",
      updatedAt: "2026-08-17T06:30:00Z"
    });
  });

  it("requires an exact lowercase full expected head OID for merge", () => {
    const input = { repository: REPOSITORY, number: 23, expectedHeadOid: OID };
    expect(GitHubPrMergeInputSchema.parse(input)).toEqual(input);
    expect(() => GitHubPrMergeInputSchema.parse({ repository: REPOSITORY, number: 23 })).toThrow();
    expect(() => GitHubPrMergeInputSchema.parse({ ...input, expectedHeadOid: "abc123" })).toThrow();
    expect(() => GitHubPrMergeInputSchema.parse({ ...input, expectedHeadOid: "A".repeat(40) })).toThrow();
    expect(() => GitHubPrMergeInputSchema.parse({ ...input, mergeMethod: "squash" })).toThrow();
    expect(() => GitHubPrMergeInputSchema.parse({ ...input, deleteBranch: true })).toThrow();
    expect(() => GitHubPrMergeInputSchema.parse({ ...input, endpoint: "https://evil.invalid" })).toThrow();
  });

  it("encodes guarded merge as one fixed PUT using the exact expected head OID", () => {
    const input = GitHubPrMergeInputSchema.parse({ repository: REPOSITORY, number: 23, expectedHeadOid: OID });
    const merge = operation("pr.merge");
    expect(merge.method).toBe("PUT");
    expect(merge.origin).toBe("https://api.github.com");
    expect(merge.pathTemplate).toBe("/repos/{owner}/{repo}/pulls/{number}/merge");
    expect(merge.allowedQueryKeys).toEqual([]);
    expect(merge.encodeRequest(input)).toEqual({
      pathParameters: { owner: "2ndworld", repo: "kodeGPT", number: "23" },
      body: { sha: OID, merge_method: "merge" }
    });
  });

  it("accepts only merged=true with a normalized merge commit OID", () => {
    const input = GitHubPrMergeInputSchema.parse({ repository: REPOSITORY, number: 23, expectedHeadOid: OID });
    const mapOutput = mapping("github.pr.merge").mapOutput;
    const value = parseProviderSemanticOutput(
      Buffer.from(JSON.stringify({ sha: "b".repeat(40), merged: true, message: "Pull Request successfully merged" })),
      GitHubPrMergeResultSchema,
      { semanticInput: input, mapOutput }
    );
    expect(value).toEqual({ repository: REPOSITORY, number: 23, merged: true, mergeCommitOid: "b".repeat(40) });

    expect(() => parseProviderSemanticOutput(
      Buffer.from(JSON.stringify({ sha: null, merged: false, message: "Head branch was modified" })),
      GitHubPrMergeResultSchema,
      { semanticInput: input, mapOutput }
    )).toThrow();
  });
});
