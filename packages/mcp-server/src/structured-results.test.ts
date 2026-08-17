import {
  CapabilityError,
  CiFailureInputSchema,
  CiFailureResultSchema,
  CiRepositoryInputSchema,
  CiRepositoryResultSchema,
  CiRunInputSchema,
  CiRunResultSchema,
  CiRunsInputSchema,
  CiRunsResultSchema,
  CiStatusInputSchema,
  CiStatusResultSchema,
  CodeSearchInputSchema,
  CodeSearchResultSchema,
  ContextBuildInputSchema,
  ContextBuildResultSchema,
  FilePatchInputSchema,
  FilePatchResultSchema,
  GitChangesInputSchema,
  GitChangesResultSchema,
  GitHubIssueInspectInputSchema,
  GitHubIssueInspectResultSchema,
  GitHubIssueListInputSchema,
  GitHubIssueListResultSchema,
  GitHubPrInspectInputSchema,
  GitHubPrInspectResultSchema,
  GitHubPrListInputSchema,
  GitHubPrListResultSchema,
  GitHubRepositoryInspectInputSchema,
  GitHubRepositoryInspectResultSchema,
  GitStageInputSchema,
  GitCommitInputSchema,
  GitBranchInputSchema,
  GitLocalMutationResultSchema,
  GitRemoteInputSchema,
  GitRemoteMutationResultSchema,
  GitLogInputSchema,
  GitLogResultSchema,
  GitShowInputSchema,
  GitShowResultSchema,
  GitRangeInputSchema,
  GitRangeResultSchema,
  GitDiffHistoryInputSchema,
  GitDiffHistoryResultSchema,
  VerifyListInputSchema,
  VerifyListResultSchema,
  VerifyRunInputSchema,
  VerifyRunResultSchema,
  WorkspaceInspectInputSchema,
  WorkspaceInspectResultSchema,
  type CodeSearchResult,
  type ContextBuildResult,
  type FilePatchResult,
  type GitChangesResult,
  type GitLocalMutationResult,
  type GitRemoteMutationResult,
  type VerifyListResult,
  type VerifyRunResult,
  type WorkspaceInspectResult
} from "@kodegpt/capabilities";
import type { McpServer } from "@modelcontextprotocol/server";
import { ConsoleStateStore } from "@kodegpt/dev-console";
import { describe, expect, it } from "vitest";
import type { OpenWorkspace } from "../../core/src/index.js";
import {
  LOCAL_GIT_MUTATION_TOOL_ANNOTATIONS,
  MUTATING_FILE_TOOL_ANNOTATIONS,
  PROCESS_RUN_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
  REMOTE_CI_READ_ONLY_TOOL_ANNOTATIONS,
  REMOTE_GIT_FETCH_TOOL_ANNOTATIONS,
  REMOTE_GIT_MUTATION_TOOL_ANNOTATIONS,
  WORKSPACE_LIFECYCLE_TOOL_ANNOTATIONS
} from "./annotations.js";
import type { KodegptToolContext, WorkspaceToolContext } from "./tool-context.js";
import { registerKodegptTools } from "./tools.js";

type CapturedHandler = (...args: never[]) => Promise<unknown>;

const typedWorkspaceListResult: OpenWorkspace[] = [
  {
    id: "ws_1",
    canonicalRoot: "/workspace",
    effectivePolicy: {
      name: "observe",
      allowWrite: false,
      allowProcess: false,
      network: "deny",
      allowedExecutableNames: [],
      inheritEnv: false,
      envAllowlist: []
    }
  }
];

const typedWorkspaceListContext: Pick<WorkspaceToolContext, "list"> = {
  list: async () => typedWorkspaceListResult
};
void typedWorkspaceListContext;

const typedWorkspaceInspectResult: WorkspaceInspectResult = {
  schemaVersion: 1,
  workspaceId: "ws_1",
  root: ".",
  projectTypes: ["node-pnpm", "rust-cargo"],
  languages: [
    { name: "Rust", fileCount: 1 },
    { name: "TypeScript", fileCount: 2 }
  ],
  entrypoints: [{ path: "package.json", kind: "node-manifest" }],
  areas: [{ path: "packages/core", kind: "package" }],
  manifests: [{ path: "package.json", kind: "node-package" }],
  symbols: [],
  relationships: [],
  warnings: [],
  truncated: false
};

const typedCodeSearchResult: CodeSearchResult = {
  schemaVersion: 1,
  mode: "definition",
  precision: "heuristic",
  matches: [
    {
      path: "src/main.ts",
      line: 1,
      column: 10,
      kind: "definition",
      preview: "function needle() {}"
    }
  ],
  truncated: false,
  truncationReasons: []
};

const typedGitChangesResult: GitChangesResult = {
  schemaVersion: 1,
  workspaceId: "ws_1",
  clean: false,
  changedPaths: [{ path: "src/main.ts", worktreeStatus: "M" }],
  summary: { changedFiles: 1 },
  patchPreview: "=== KODEGPT STAGED DIFF ===\n\n=== KODEGPT WORKTREE DIFF ===\n",
  patchArtifact: { uri: "artifact://ka_git_changes_fixture", bytes: 64 },
  patchCoverage: { staged: true, worktree: true, untracked: false },
  truncated: false,
  fingerprint: "a".repeat(64)
};

const typedGitMutationResult: GitLocalMutationResult = {
  schemaVersion: 1,
  operation: "stage",
  exitCode: 0,
  stdoutPreview: "",
  stderrPreview: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  sourceTruncated: false,
  bytesSpooled: 0,
  artifact: {
    schemaVersion: 1,
    uri: "artifact://ka_git_mutation_fixture",
    mediaType: "application/vnd.kodegpt.execution-stream",
    sizeBytes: 0,
    sourceTruncated: false
  }
};

const typedGitRemoteMutationResult: GitRemoteMutationResult = {
  ...typedGitMutationResult,
  operation: "fetch",
  artifact: {
    ...typedGitMutationResult.artifact,
    uri: "artifact://ka_git_remote_fixture"
  }
};

const typedVerifyListResult: VerifyListResult = {
  schemaVersion: 1,
  workspaceId: "ws_1",
  recipes: [
    {
      id: "package:test",
      label: "Package test",
      category: "test",
      logicalExecutable: "pnpm",
      argv: ["run", "test"],
      cwd: ".",
      source: "package-script",
      allowed: true
    }
  ]
};

const typedVerifyRunResult: VerifyRunResult = {
  schemaVersion: 1,
  workspaceId: "ws_1",
  recipe: typedVerifyListResult.recipes[0]!,
  operation: {
    schemaVersion: 1,
    operationId: "op_verify",
    state: "completed",
    exitCode: 0,
    stdoutPreview: "ok\n",
    stderrPreview: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    sourceTruncated: false,
    bytesSpooled: 3,
    artifact: {
      schemaVersion: 1,
      uri: "artifact://ka_verify",
      mediaType: "text/plain",
      sizeBytes: 3,
      sourceTruncated: false
    }
  }
};

const typedFilePatchResult: FilePatchResult = {
  schemaVersion: 1,
  workspaceId: "ws_1",
  mode: "check",
  files: [
    {
      path: "src/main.ts",
      action: "update",
      expectedSha256: "a".repeat(64),
      resultingSha256: "b".repeat(64),
      bytes: 12,
      committed: false
    }
  ],
  committedPaths: []
};

const typedContextBuildResult: ContextBuildResult = {
  schemaVersion: 1,
  intent: "review",
  target: "src/main.ts",
  workspace: typedWorkspaceInspectResult,
  git: typedGitChangesResult,
  selectedFiles: [
    {
      path: "src/main.ts",
      reason: "exact-target",
      content: "export const value = 1;\n",
      truncated: false
    }
  ],
  relevantMatches: typedCodeSearchResult.matches,
  verifications: typedVerifyListResult.recipes,
  warnings: [],
  totalBytes: 24,
  truncated: false
};

function makeContext(): KodegptToolContext {
  return {
    workspace: {
      list: async () => typedWorkspaceListResult,
      open: async () => typedWorkspaceListResult[0],
      trust: async () => ({
        id: "trust_fixture",
        canonicalRoot: "/workspace",
        profileCeiling: "trusted",
        trustedAt: "2026-08-15T00:00:00.000Z"
      }),
      untrust: async ({ trustId }) => ({ trustId, removed: true }),
      close: async () => ({ ok: true }),
      info: async () => typedWorkspaceListResult[0],
      inspect: async () => typedWorkspaceInspectResult,
      readFile: async () => ({ contents: "", bytesRead: 0, eof: true }),
      writeFile: async () => ({ bytesWritten: 0, created: true }),
      editFile: async () => ({ bytesWritten: 0, replacements: 0 }),
      search: async () => [],
      tree: async () => []
    },
    trust: {
      list: async () => []
    },
    git: {
      status: async () => ({} as never),
      diff: async () => ({} as never),
      changes: async () => typedGitChangesResult,
      stage: async () => typedGitMutationResult,
      commit: async () => ({ ...typedGitMutationResult, operation: "commit" as const }),
      branchCreate: async () => ({ ...typedGitMutationResult, operation: "branch_create" as const }),
      branchSwitch: async () => ({ ...typedGitMutationResult, operation: "branch_switch" as const }),
      branchDelete: async () => ({ ...typedGitMutationResult, operation: "branch_delete" as const }),
      fetch: async () => typedGitRemoteMutationResult,
      pull: async () => ({ ...typedGitRemoteMutationResult, operation: "pull" as const }),
      push: async () => ({ ...typedGitRemoteMutationResult, operation: "push" as const }),
      log: async () => ({ schemaVersion: 1, resolvedOid: "1".repeat(40), commits: [], returnedCount: 0, truncated: false, truncationReasons: [] }),
      show: async () => ({ schemaVersion: 1, commit: { oid: "1".repeat(40), shortOid: "1".repeat(12), parents: [], authorName: "A", authorTime: 1, committerTime: 1, subject: "s", body: "", messageTruncated: false, encodingLossy: false }, changedPaths: [], summary: { filesChanged: 0, insertions: 0, deletions: 0, binaryFiles: 0 }, patch: null, truncated: false, truncationReasons: [] }),
      range: async () => ({ schemaVersion: 1, baseOid: "1".repeat(40), headOid: "2".repeat(40), isAncestor: false, mergeBaseOid: null, ahead: { value: 0, exact: true }, behind: { value: 0, exact: true }, commits: [], returnedCount: 0, truncated: false, truncationReasons: [] }),
      diffHistory: async () => ({ schemaVersion: 1, baseOid: "1".repeat(40), headOid: "2".repeat(40), changedPaths: [], summary: { filesChanged: 0, insertions: 0, deletions: 0, binaryFiles: 0 }, patch: "", truncated: false, truncationReasons: [] })
    },
    process: {
      run: async () => ({} as never),
      status: async () => ({} as never),
      cancel: async () => ({} as never)
    },
    artifact: {
      read: async () => ({} as never)
    },
    extension: {
      list: async () => []
    },
    profile: {
      current: async () => ({} as never),
      inspect: async () => ({})
    },
    system: {
      capabilities: async () => ({}),
      health: async () => ({ ok: true })
    },
    code: {
      search: async () => typedCodeSearchResult
    },
    file: {
      patch: async () => typedFilePatchResult
    },
    verify: {
      list: async () => typedVerifyListResult,
      run: async () => typedVerifyRunResult
    },
    context: {
      build: async () => typedContextBuildResult
    },
    ci: {
      repository: async () => ({} as never),
      status: async () => ({} as never),
      runs: async () => ({} as never),
      run: async () => ({} as never),
      failure: async () => ({} as never)
    },
    skill: {
      list: async () => ({ schemaVersion: 1, skills: [], truncated: false, truncationReasons: [] }),
      inspect: async () => ({} as never),
      load: async () => ({} as never)
    }
  };
}

describe("structured MCP tool results", () => {
  it("registers exactly five bounded Remote-CI tools with strict open-world read-only schemas", async () => {
    const handlers = new Map<string, CapturedHandler>();
    const definitions = new Map<string, Record<string, unknown>>();
    const context = makeContext();
    const repositoryResult = {
      schemaVersion: 1 as const,
      workspaceId: "ws_1",
      provider: "github" as const,
      repository: { owner: "2ndworld", name: "kodeGPT", fullName: "2ndworld/kodeGPT" },
      selectedRemote: "origin",
      defaultBranch: "main",
      currentRevision: { oid: "1".repeat(40), branch: "main" },
      available: true,
      authState: "AVAILABLE" as const,
      credentialSource: "gh" as const,
      truncated: false,
      truncationReasons: []
    };
    context.ci.repository = async () => repositoryResult;
    const server = {
      registerTool(name: string, definition: Record<string, unknown>, handler: CapturedHandler) {
        definitions.set(name, definition);
        handlers.set(name, handler);
      }
    } as unknown as McpServer;

    registerKodegptTools(server, context);

    const specs = [
      ["ci.repository", CiRepositoryInputSchema, CiRepositoryResultSchema],
      ["ci.status", CiStatusInputSchema, CiStatusResultSchema],
      ["ci.runs", CiRunsInputSchema, CiRunsResultSchema],
      ["ci.run", CiRunInputSchema, CiRunResultSchema],
      ["ci.failure", CiFailureInputSchema, CiFailureResultSchema]
    ] as const;
    for (const [name, inputSchema, outputSchema] of specs) {
      const definition = definitions.get(name);
      expect(definition?.inputSchema).toBe(inputSchema);
      expect(definition?.outputSchema).toBe(outputSchema);
      expect(definition?.annotations).toEqual(REMOTE_CI_READ_ONLY_TOOL_ANNOTATIONS);
      const required = name === "ci.run" || name === "ci.failure" ? { runId: "123" } : {};
      for (const [field, value] of [
        ["repository", "other/repo"],
        ["provider", "github"],
        ["url", "https://example.invalid"],
        ["endpoint", "https://example.invalid"],
        ["host", "example.invalid"],
        ["token", "secret"],
        ["credential", "secret"],
        ["headers", { authorization: "secret" }],
        ["method", "POST"]
      ] as const) {
        expect(inputSchema.safeParse({ ...required, [field]: value }).success).toBe(false);
      }
    }

    const result = (await handlers.get("ci.repository")!({} as never)) as { structuredContent?: unknown };
    expect(result.structuredContent).toEqual(repositoryResult);
  });

  it("registers exactly five typed GitHub reads with closed schemas and normalized structured results", async () => {
    const handlers = new Map<string, CapturedHandler>();
    const definitions = new Map<string, Record<string, unknown>>();
    const repositoryResult = {
      repository: "2ndworld/kodeGPT",
      name: "kodeGPT",
      owner: "2ndworld",
      description: "KodeGPT",
      private: false,
      defaultBranch: "main",
      archived: false,
      fork: false,
      htmlUrl: "https://github.com/2ndworld/kodeGPT",
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-17T00:00:00Z",
      pushedAt: "2026-08-17T00:00:00Z"
    };
    const prInspectResult = {
      repository: "2ndworld/kodeGPT",
      number: 20,
      title: "Skill Capability Resolution v2",
      state: "closed" as const,
      authorLogin: "2ndworld",
      baseBranch: "main",
      headBranch: "feat/skill-capability-resolution-v2",
      merged: true,
      draft: false,
      htmlUrl: "https://github.com/2ndworld/kodeGPT/pull/20",
      createdAt: "2026-08-17T00:00:00Z",
      updatedAt: "2026-08-17T01:00:00Z",
      closedAt: "2026-08-17T01:00:00Z",
      mergedAt: "2026-08-17T01:00:00Z"
    };
    const prListResult = {
      repository: "2ndworld/kodeGPT",
      items: [{
        number: 20,
        title: "Skill Capability Resolution v2",
        state: "closed" as const,
        authorLogin: "2ndworld",
        baseBranch: "main",
        headBranch: "feat/skill-capability-resolution-v2",
        draft: false,
        htmlUrl: "https://github.com/2ndworld/kodeGPT/pull/20",
        createdAt: "2026-08-17T00:00:00Z",
        updatedAt: "2026-08-17T01:00:00Z"
      }]
    };
    const issueItem = {
      number: 1,
      title: "Example issue",
      state: "open" as const,
      authorLogin: "2ndworld",
      htmlUrl: "https://github.com/2ndworld/kodeGPT/issues/1",
      createdAt: "2026-08-17T00:00:00Z",
      updatedAt: "2026-08-17T01:00:00Z",
      closedAt: null,
      commentsCount: 1,
      labels: ["bug"],
      assigneeLogins: ["2ndworld"]
    };
    const issueInspectResult = { repository: "2ndworld/kodeGPT", ...issueItem };
    const issueListResult = { repository: "2ndworld/kodeGPT", items: [issueItem] };
    const context = Object.assign(makeContext(), {
      github: {
        repositoryInspect: async () => repositoryResult,
        prInspect: async () => prInspectResult,
        prList: async () => prListResult,
        issueInspect: async () => issueInspectResult,
        issueList: async () => issueListResult
      }
    }) as KodegptToolContext;
    const server = {
      registerTool(name: string, definition: Record<string, unknown>, handler: CapturedHandler) {
        definitions.set(name, definition);
        handlers.set(name, handler);
      }
    } as unknown as McpServer;

    registerKodegptTools(server, context);

    const specs = [
      ["github.repository.inspect", GitHubRepositoryInspectInputSchema, GitHubRepositoryInspectResultSchema, { repository: "2ndworld/kodeGPT" }, repositoryResult],
      ["github.pr.inspect", GitHubPrInspectInputSchema, GitHubPrInspectResultSchema, { repository: "2ndworld/kodeGPT", number: 20 }, prInspectResult],
      ["github.pr.list", GitHubPrListInputSchema, GitHubPrListResultSchema, { repository: "2ndworld/kodeGPT", state: "closed", limit: 5 }, prListResult],
      ["github.issue.inspect", GitHubIssueInspectInputSchema, GitHubIssueInspectResultSchema, { repository: "2ndworld/kodeGPT", number: 1 }, issueInspectResult],
      ["github.issue.list", GitHubIssueListInputSchema, GitHubIssueListResultSchema, { repository: "2ndworld/kodeGPT", state: "open", limit: 5 }, issueListResult]
    ] as const;
    expect([...definitions.keys()].filter((name) => name.startsWith("github."))).toEqual(specs.map(([name]) => name));

    for (const [name, inputSchema, outputSchema, input, expected] of specs) {
      const definition = definitions.get(name);
      expect(definition?.inputSchema).toBe(inputSchema);
      expect(definition?.outputSchema).toBe(outputSchema);
      expect(definition?.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      });
      for (const [field, value] of [
        ["providerId", "github.read.v1"],
        ["providerInstanceId", "prv_secret"],
        ["workspaceId", "ws_1"],
        ["endpoint", "/user"],
        ["method", "POST"],
        ["headers", { authorization: "secret" }],
        ["token", "secret"],
        ["credential", "secret"]
      ] as const) {
        expect(inputSchema.safeParse({ ...input, [field]: value }).success).toBe(false);
      }
      const result = (await handlers.get(name)!(input as never)) as { structuredContent?: unknown };
      expect(result.structuredContent).toEqual(expected);
      const serialized = JSON.stringify(result.structuredContent);
      expect(serialized).not.toContain("providerInstanceId");
      expect(serialized).not.toContain("semanticCapabilityId");
      expect(serialized).not.toContain("authorization");
    }
  });

  it("registers the small trust control plane without caller-supplied filesystem identity", async () => {
    const handlers = new Map<string, CapturedHandler>();
    const definitions = new Map<string, Record<string, unknown>>();
    const trusted = {
      id: "trust_fixture",
      canonicalRoot: "/workspace",
      profileCeiling: "trusted" as const,
      trustedAt: "2026-08-15T00:00:00.000Z"
    };
    type TrustAwareContext = KodegptToolContext & {
      trust: { list(): Promise<Array<typeof trusted>> };
      workspace: KodegptToolContext["workspace"] & {
        trust(input: { rootPath: string; profile?: "observe" | "develop" | "trusted" }): Promise<typeof trusted>;
        untrust(input: { trustId: string }): Promise<{ trustId: string; removed: boolean }>;
      };
    };
    const context = makeContext() as TrustAwareContext;
    context.trust = { list: async () => [trusted] };
    context.workspace.trust = async ({ rootPath, profile }) => {
      expect({ rootPath, profile }).toEqual({ rootPath: "/workspace", profile: "trusted" });
      return trusted;
    };
    context.workspace.untrust = async ({ trustId }) => ({ trustId, removed: true });
    const server = {
      registerTool(name: string, definition: Record<string, unknown>, handler: CapturedHandler) {
        definitions.set(name, definition);
        handlers.set(name, handler);
      }
    } as unknown as McpServer;

    registerKodegptTools(server, context);

    expect(Object.keys((definitions.get("trust.list")?.inputSchema ?? {}) as object)).toEqual([]);
    expect(definitions.get("trust.list")?.annotations).toEqual(READ_ONLY_TOOL_ANNOTATIONS);
    expect(Object.keys((definitions.get("workspace.trust")?.inputSchema ?? {}) as object).sort()).toEqual([
      "profile",
      "rootPath"
    ]);
    expect(definitions.get("workspace.trust")?.annotations).toEqual(
      WORKSPACE_LIFECYCLE_TOOL_ANNOTATIONS
    );
    expect(Object.keys((definitions.get("workspace.untrust")?.inputSchema ?? {}) as object)).toEqual([
      "trustId"
    ]);
    expect(definitions.get("workspace.untrust")?.annotations).toEqual(
      WORKSPACE_LIFECYCLE_TOOL_ANNOTATIONS
    );
    const schemaText = JSON.stringify([
      definitions.get("trust.list")?.inputSchema,
      definitions.get("workspace.trust")?.inputSchema,
      definitions.get("workspace.untrust")?.inputSchema
    ]);
    for (const forbidden of ["deviceMajor", "deviceMinor", "inode", "identity", "policy", "grant"]) {
      expect(schemaText).not.toContain(forbidden);
    }

    const listResult = (await handlers.get("trust.list")!()) as { structuredContent?: unknown };
    expect(listResult.structuredContent).toEqual([trusted]);
    const trustResult = (await handlers.get("workspace.trust")!({
      rootPath: "/workspace",
      profile: "trusted"
    } as never)) as { structuredContent?: unknown };
    expect(trustResult.structuredContent).toEqual(trusted);
    const untrustResult = (await handlers.get("workspace.untrust")!({
      trustId: "trust_fixture"
    } as never)) as { structuredContent?: unknown };
    expect(untrustResult.structuredContent).toEqual({ trustId: "trust_fixture", removed: true });
  });

  it("registers trusted local Git mutations with closed schemas, mutating annotations, and structured results", async () => {
    const handlers = new Map<string, CapturedHandler>();
    const definitions = new Map<string, Record<string, unknown>>();
    const server = {
      registerTool(name: string, definition: Record<string, unknown>, handler: CapturedHandler) {
        definitions.set(name, definition);
        handlers.set(name, handler);
      }
    } as unknown as McpServer;

    registerKodegptTools(server, makeContext());
    const expected = [
      ["git.stage", GitStageInputSchema, "stage", { workspaceId: "ws_1", paths: ["src/main.ts"] }],
      ["git.commit", GitCommitInputSchema, "commit", { workspaceId: "ws_1", message: "bounded" }],
      ["git.branchCreate", GitBranchInputSchema, "branch_create", { workspaceId: "ws_1", name: "feature/a" }],
      ["git.branchSwitch", GitBranchInputSchema, "branch_switch", { workspaceId: "ws_1", name: "feature/a" }],
      ["git.branchDelete", GitBranchInputSchema, "branch_delete", { workspaceId: "ws_1", name: "feature/a" }]
    ] as const;

    for (const [name, inputSchema, operation, input] of expected) {
      const definition = definitions.get(name);
      expect(definition?.inputSchema).toBe(inputSchema);
      expect(definition?.outputSchema).toBe(GitLocalMutationResultSchema);
      expect(definition?.annotations).toEqual(LOCAL_GIT_MUTATION_TOOL_ANNOTATIONS);
      const schemaText = JSON.stringify(inputSchema);
      for (const forbidden of ["argv", "command", "gitArgs", "shell", "rootPath", "hostPath"]) {
        expect(schemaText).not.toContain(forbidden);
      }
      const result = (await handlers.get(name)!(input as never)) as { structuredContent?: unknown };
      expect(result.structuredContent).toMatchObject({ schemaVersion: 1, operation });
      expect(JSON.stringify(result.structuredContent)).not.toContain("capabilityId");
    }
  });

  it("registers trusted remote Git with bounded schemas, network annotations, and structured results", async () => {
    const handlers = new Map<string, CapturedHandler>();
    const definitions = new Map<string, Record<string, unknown>>();
    const server = {
      registerTool(name: string, definition: Record<string, unknown>, handler: CapturedHandler) {
        definitions.set(name, definition);
        handlers.set(name, handler);
      }
    } as unknown as McpServer;

    registerKodegptTools(server, makeContext());
    const expected = [
      ["git.fetch", "fetch", REMOTE_GIT_FETCH_TOOL_ANNOTATIONS],
      ["git.pull", "pull", REMOTE_GIT_MUTATION_TOOL_ANNOTATIONS],
      ["git.push", "push", REMOTE_GIT_MUTATION_TOOL_ANNOTATIONS]
    ] as const;

    for (const [name, operation, annotations] of expected) {
      const definition = definitions.get(name);
      expect(definition?.inputSchema).toBe(GitRemoteInputSchema);
      expect(definition?.outputSchema).toBe(GitRemoteMutationResultSchema);
      expect(definition?.annotations).toEqual(annotations);
      const schemaText = JSON.stringify(definition?.inputSchema);
      for (const forbidden of ["argv", "command", "gitArgs", "refspec", "url", "credential", "header", "rootPath", "hostPath"]) {
        expect(schemaText.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
      const result = (await handlers.get(name)!({ workspaceId: "ws_1", ref: "main" } as never)) as {
        structuredContent?: unknown;
      };
      expect(result.structuredContent).toMatchObject({ schemaVersion: 1, operation });
      expect(JSON.stringify(result.structuredContent)).not.toContain("capabilityId");
    }
  });

  it("registers Git history with closed schemas and read-only annotations", () => {
    const definitions = new Map<string, Record<string, unknown>>();
    const server = {
      registerTool(name: string, definition: Record<string, unknown>, _handler: CapturedHandler) {
        definitions.set(name, definition);
      }
    } as unknown as McpServer;

    registerKodegptTools(server, makeContext());
    const expected = [
      ["git.log", GitLogInputSchema, GitLogResultSchema],
      ["git.show", GitShowInputSchema, GitShowResultSchema],
      ["git.range", GitRangeInputSchema, GitRangeResultSchema],
      ["git.diffHistory", GitDiffHistoryInputSchema, GitDiffHistoryResultSchema]
    ] as const;
    for (const [name, inputSchema, outputSchema] of expected) {
      const definition = definitions.get(name);
      expect(definition?.inputSchema).toBe(inputSchema);
      expect(definition?.outputSchema).toBe(outputSchema);
      expect(definition?.annotations).toEqual(READ_ONLY_TOOL_ANNOTATIONS);
      const schemaText = JSON.stringify(inputSchema);
      for (const forbidden of ["argv", "command", "gitArgs", "revisionExpression", "network", "rootPath", "hostPath"]) {
        expect(schemaText).not.toContain(forbidden);
      }
    }
  });
  it("keeps workspace.list structured content identical to its text fallback", async () => {
    const handlers = new Map<string, CapturedHandler>();
    const server = {
      registerTool(name: string, _definition: unknown, handler: CapturedHandler) {
        handlers.set(name, handler);
      }
    } as unknown as McpServer;

    registerKodegptTools(server, makeContext());
    const handler = handlers.get("workspace.list");
    expect(handler).toBeDefined();

    const result = (await handler!()) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
    };

    expect(result.structuredContent).toEqual(typedWorkspaceListResult);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it("keeps workspace.inspect schemas, annotations, and structured fallback aligned", async () => {
    const handlers = new Map<string, CapturedHandler>();
    const definitions = new Map<string, Record<string, unknown>>();
    const server = {
      registerTool(name: string, definition: Record<string, unknown>, handler: CapturedHandler) {
        definitions.set(name, definition);
        handlers.set(name, handler);
      }
    } as unknown as McpServer;

    registerKodegptTools(server, makeContext());
    const handler = handlers.get("workspace.inspect");
    const definition = definitions.get("workspace.inspect");
    expect(handler).toBeDefined();
    expect(definition?.inputSchema).toBe(WorkspaceInspectInputSchema);
    expect(definition?.outputSchema).toBe(WorkspaceInspectResultSchema);
    expect(definition?.annotations).toEqual(READ_ONLY_TOOL_ANNOTATIONS);

    const result = (await handler!({ workspaceId: "ws_1" } as never)) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
    };

    expect(result.structuredContent).toEqual(typedWorkspaceInspectResult);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it("keeps code.search schemas, annotations, and structured fallback aligned", async () => {
    const handlers = new Map<string, CapturedHandler>();
    const definitions = new Map<string, Record<string, unknown>>();
    const server = {
      registerTool(name: string, definition: Record<string, unknown>, handler: CapturedHandler) {
        definitions.set(name, definition);
        handlers.set(name, handler);
      }
    } as unknown as McpServer;

    registerKodegptTools(server, makeContext());
    const handler = handlers.get("code.search");
    const definition = definitions.get("code.search");
    expect(handler).toBeDefined();
    expect(definition?.inputSchema).toBe(CodeSearchInputSchema);
    expect(definition?.outputSchema).toBe(CodeSearchResultSchema);
    expect(definition?.annotations).toEqual(READ_ONLY_TOOL_ANNOTATIONS);

    const result = (await handler!({
      workspaceId: "ws_1",
      query: "needle",
      mode: "definition"
    } as never)) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
    };

    expect(result.structuredContent).toEqual(typedCodeSearchResult);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it("keeps context.build schemas, read-only annotations, and structured fallback aligned", async () => {
    const handlers = new Map<string, CapturedHandler>();
    const definitions = new Map<string, Record<string, unknown>>();
    const server = {
      registerTool(name: string, definition: Record<string, unknown>, handler: CapturedHandler) {
        definitions.set(name, definition);
        handlers.set(name, handler);
      }
    } as unknown as McpServer;

    registerKodegptTools(server, makeContext());
    const handler = handlers.get("context.build");
    const definition = definitions.get("context.build");
    expect(handler).toBeDefined();
    expect(definition?.inputSchema).toBe(ContextBuildInputSchema);
    expect(definition?.outputSchema).toBe(ContextBuildResultSchema);
    expect(definition?.annotations).toEqual(READ_ONLY_TOOL_ANNOTATIONS);

    const result = (await handler!({
      workspaceId: "ws_1",
      intent: "review",
      target: "src/main.ts"
    } as never)) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
    };
    expect(result.structuredContent).toEqual(typedContextBuildResult);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it("keeps file.patch schemas, mutating annotations, and structured fallback aligned", async () => {
    const handlers = new Map<string, CapturedHandler>();
    const definitions = new Map<string, Record<string, unknown>>();
    const server = {
      registerTool(name: string, definition: Record<string, unknown>, handler: CapturedHandler) {
        definitions.set(name, definition);
        handlers.set(name, handler);
      }
    } as unknown as McpServer;

    registerKodegptTools(server, makeContext());
    const handler = handlers.get("file.patch");
    const definition = definitions.get("file.patch");
    expect(handler).toBeDefined();
    expect(definition?.inputSchema).toBe(FilePatchInputSchema);
    expect(definition?.outputSchema).toBe(FilePatchResultSchema);
    expect(definition?.annotations).toEqual(MUTATING_FILE_TOOL_ANNOTATIONS);

    const result = (await handler!({
      workspaceId: "ws_1",
      patch: "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+new\n"
    } as never)) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
    };
    expect(result.structuredContent).toEqual(typedFilePatchResult);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it("keeps git.changes schemas, annotations, and structured fallback aligned", async () => {
    const handlers = new Map<string, CapturedHandler>();
    const definitions = new Map<string, Record<string, unknown>>();
    const server = {
      registerTool(name: string, definition: Record<string, unknown>, handler: CapturedHandler) {
        definitions.set(name, definition);
        handlers.set(name, handler);
      }
    } as unknown as McpServer;

    registerKodegptTools(server, makeContext());
    const handler = handlers.get("git.changes");
    const definition = definitions.get("git.changes");
    expect(handler).toBeDefined();
    expect(definition?.inputSchema).toBe(GitChangesInputSchema);
    expect(definition?.outputSchema).toBe(GitChangesResultSchema);
    expect(definition?.annotations).toEqual(READ_ONLY_TOOL_ANNOTATIONS);

    const result = (await handler!({ workspaceId: "ws_1" } as never)) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
    };

    expect(result.structuredContent).toEqual(typedGitChangesResult);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it("keeps verify.list schemas, read-only annotations, and structured fallback aligned", async () => {
    const handlers = new Map<string, CapturedHandler>();
    const definitions = new Map<string, Record<string, unknown>>();
    const server = {
      registerTool(name: string, definition: Record<string, unknown>, handler: CapturedHandler) {
        definitions.set(name, definition);
        handlers.set(name, handler);
      }
    } as unknown as McpServer;

    registerKodegptTools(server, makeContext());
    const handler = handlers.get("verify.list");
    const definition = definitions.get("verify.list");
    expect(handler).toBeDefined();
    expect(definition?.inputSchema).toBe(VerifyListInputSchema);
    expect(definition?.outputSchema).toBe(VerifyListResultSchema);
    expect(definition?.annotations).toEqual(READ_ONLY_TOOL_ANNOTATIONS);

    const result = (await handler!({ workspaceId: "ws_1" } as never)) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
    };
    expect(result.structuredContent).toEqual(typedVerifyListResult);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it("keeps verify.run schemas, process annotations, and structured fallback aligned", async () => {
    const handlers = new Map<string, CapturedHandler>();
    const definitions = new Map<string, Record<string, unknown>>();
    const server = {
      registerTool(name: string, definition: Record<string, unknown>, handler: CapturedHandler) {
        definitions.set(name, definition);
        handlers.set(name, handler);
      }
    } as unknown as McpServer;

    const consoleState = new ConsoleStateStore();
    registerKodegptTools(server, makeContext(), consoleState);
    const handler = handlers.get("verify.run");
    const definition = definitions.get("verify.run");
    expect(handler).toBeDefined();
    expect(definition?.inputSchema).toBe(VerifyRunInputSchema);
    expect(definition?.outputSchema).toBe(VerifyRunResultSchema);
    expect(definition?.annotations).toEqual(PROCESS_RUN_TOOL_ANNOTATIONS);

    const result = (await handler!({ workspaceId: "ws_1", recipeId: "package:test" } as never)) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: unknown;
    };
    expect(result.structuredContent).toEqual(typedVerifyRunResult);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    expect(
      consoleState.snapshot({ workspaces: typedWorkspaceListResult, health: { ok: true } }).processes
        .operations
    ).toContainEqual(typedVerifyRunResult.operation);
  });

  it("preserves only safe partial-commit details at the MCP boundary", async () => {
    const handlers = new Map<string, CapturedHandler>();
    const server = {
      registerTool(name: string, _definition: Record<string, unknown>, handler: CapturedHandler) {
        handlers.set(name, handler);
      }
    } as unknown as McpServer;
    const context = makeContext();
    context.file.patch = async () => {
      throw new CapabilityError(
        "PATCH_COMMIT_INCOMPLETE",
        "Patch commit stopped before all files were committed",
        { committedPaths: ["a.txt"], failedPath: "b.txt" }
      );
    };

    registerKodegptTools(server, context);
    const handler = handlers.get("file.patch");
    await expect(
      handler!({ workspaceId: "ws_1", patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n" } as never)
    ).rejects.toThrow(
      'PATCH_COMMIT_INCOMPLETE: Patch commit stopped before all files were committed {"committedPaths":["a.txt"],"failedPath":"b.txt"}'
    );
  });

  it("redacts unknown native capability errors at the MCP boundary", async () => {
    const handlers = new Map<string, CapturedHandler>();
    const server = {
      registerTool(name: string, _definition: Record<string, unknown>, handler: CapturedHandler) {
        handlers.set(name, handler);
      }
    } as unknown as McpServer;
    const context = makeContext();
    context.code.search = async () => {
      throw new Error("ENOENT /home/sauron/private-secret");
    };

    registerKodegptTools(server, context);
    const handler = handlers.get("code.search");
    expect(handler).toBeDefined();

    await expect(
      handler!({ workspaceId: "ws_1", query: "needle", mode: "text" } as never)
    ).rejects.toThrow("CAPABILITY_INTERNAL: Native capability failed");

    try {
      await handler!({ workspaceId: "ws_1", query: "needle", mode: "text" } as never);
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).not.toContain("/home/");
      expect(message).not.toContain("ENOENT");
      expect(message).not.toContain("private-secret");
    }
  });
});
