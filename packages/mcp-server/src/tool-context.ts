export type JsonObject = Record<string, unknown>;

export interface WorkspaceToolContext {
  list(): Promise<unknown> | unknown;
  open(input: { rootPath: string }): Promise<unknown> | unknown;
  close(input: { workspaceId: string }): Promise<unknown> | unknown;
  info(input: { workspaceId: string }): Promise<unknown> | unknown;
  readFile(input: {
    workspaceId: string;
    path: string;
    offset?: number;
    maxBytes?: number;
  }): Promise<unknown> | unknown;
  writeFile(input: {
    workspaceId: string;
    path: string;
    content: string;
  }): Promise<unknown> | unknown;
  editFile(input: {
    workspaceId: string;
    path: string;
    oldText: string;
    newText: string;
    expectedReplacements: number;
  }): Promise<unknown> | unknown;
  search(input: {
    workspaceId: string;
    query: string;
    path?: string;
  }): Promise<unknown> | unknown;
  tree(input: { workspaceId: string; path?: string }): Promise<unknown> | unknown;
}

export interface GitToolContext {
  status(input: { workspaceId: string }): Promise<unknown> | unknown;
  diff(input: { workspaceId: string }): Promise<unknown> | unknown;
}

export interface ProcessToolContext {
  run(input: {
    workspaceId: string;
    logicalExecutable: string;
    argv: string[];
    cwd?: string;
    env?: Record<string, string>;
    background?: boolean;
  }): Promise<unknown> | unknown;
  status(input: { workspaceId: string; operationId: string }): Promise<unknown> | unknown;
  cancel(input: { workspaceId: string; operationId: string }): Promise<unknown> | unknown;
}

export interface ArtifactToolContext {
  read(input: { uri: string; offset?: number; maxBytes?: number }): Promise<unknown> | unknown;
}

export interface ExtensionToolContext {
  list(input: { limit?: number }): Promise<unknown> | unknown;
}

export interface ProfileToolContext {
  current(input: { workspaceId: string }): Promise<unknown> | unknown;
  inspect(input: { name: "observe" | "develop" | "trusted" }): Promise<unknown> | unknown;
}

export interface SystemToolContext {
  capabilities(): Promise<unknown> | unknown;
  health(): Promise<unknown> | unknown;
}

export interface KodegptToolContext {
  workspace: WorkspaceToolContext;
  git: GitToolContext;
  process: ProcessToolContext;
  artifact: ArtifactToolContext;
  extension: ExtensionToolContext;
  profile: ProfileToolContext;
  system: SystemToolContext;
}

export interface WorkspaceManagerToolAdapter {
  listWorkspaces(): unknown;
  openWorkspace(rootPath: string): Promise<unknown> | unknown;
  closeWorkspace(workspaceId: string): Promise<unknown> | unknown;
  requireReady(workspaceId: string): { effectivePolicy: unknown };
  readFile(
    workspaceId: string,
    path: string,
    options?: { offset?: number; maxBytes?: number }
  ): Promise<unknown> | unknown;
  writeFile(workspaceId: string, path: string, content: string): Promise<unknown> | unknown;
  editFile(
    workspaceId: string,
    path: string,
    oldText: string,
    newText: string,
    expectedReplacements: number
  ): Promise<unknown> | unknown;
  gitStatus(workspaceId: string): Promise<unknown> | unknown;
  gitDiff(workspaceId: string): Promise<unknown> | unknown;
  search(workspaceId: string, query: string, path?: string): Promise<unknown> | unknown;
  tree(workspaceId: string, path?: string): Promise<unknown> | unknown;
}

export interface ExecutionManagerToolAdapter {
  run(input: {
    workspaceId: string;
    logicalExecutable: string;
    argv: string[];
    cwd?: string;
    env?: Record<string, string>;
    background?: boolean;
  }): Promise<unknown> | unknown;
  status(workspaceId: string, operationId: string): Promise<unknown> | unknown;
  cancel(workspaceId: string, operationId: string): Promise<unknown> | unknown;
}

export interface ArtifactStoreToolAdapter {
  read(uri: string, options?: { offset?: number; maxBytes?: number }): Promise<unknown> | unknown;
}

export interface ExtensionRegistryToolAdapter {
  listEnabled(limit?: number): Promise<unknown> | unknown;
}

export function createKodegptToolContext(options: {
  workspaceManager: WorkspaceManagerToolAdapter;
  executionManager: ExecutionManagerToolAdapter;
  artifactStore: ArtifactStoreToolAdapter;
  extensionRegistry: ExtensionRegistryToolAdapter;
  inspectProfile(name: "observe" | "develop" | "trusted"): unknown;
  capabilities(): Promise<unknown> | unknown;
  health(): Promise<unknown> | unknown;
}): KodegptToolContext {
  return {
    workspace: {
      list: () => options.workspaceManager.listWorkspaces(),
      open: ({ rootPath }) => options.workspaceManager.openWorkspace(rootPath),
      close: async ({ workspaceId }) => {
        await options.workspaceManager.closeWorkspace(workspaceId);
        return { ok: true };
      },
      info: ({ workspaceId }) => options.workspaceManager.requireReady(workspaceId),
      readFile: ({ workspaceId, path, offset, maxBytes }) =>
        options.workspaceManager.readFile(workspaceId, path, { offset, maxBytes }),
      writeFile: ({ workspaceId, path, content }) =>
        options.workspaceManager.writeFile(workspaceId, path, content),
      editFile: ({ workspaceId, path, oldText, newText, expectedReplacements }) =>
        options.workspaceManager.editFile(
          workspaceId,
          path,
          oldText,
          newText,
          expectedReplacements
        ),
      search: ({ workspaceId, query, path }) =>
        options.workspaceManager.search(workspaceId, query, path),
      tree: ({ workspaceId, path }) => options.workspaceManager.tree(workspaceId, path)
    },
    git: {
      status: ({ workspaceId }) => options.workspaceManager.gitStatus(workspaceId),
      diff: ({ workspaceId }) => options.workspaceManager.gitDiff(workspaceId)
    },
    process: {
      run: (input) => options.executionManager.run(input),
      status: ({ workspaceId, operationId }) =>
        options.executionManager.status(workspaceId, operationId),
      cancel: ({ workspaceId, operationId }) =>
        options.executionManager.cancel(workspaceId, operationId)
    },
    artifact: {
      read: ({ uri, offset, maxBytes }) => options.artifactStore.read(uri, { offset, maxBytes })
    },
    extension: {
      list: ({ limit }) => options.extensionRegistry.listEnabled(limit)
    },
    profile: {
      current: ({ workspaceId }) => ({
        workspaceId,
        effectivePolicy: options.workspaceManager.requireReady(workspaceId).effectivePolicy
      }),
      inspect: ({ name }) => options.inspectProfile(name)
    },
    system: {
      capabilities: () => options.capabilities(),
      health: () => options.health()
    }
  };
}
