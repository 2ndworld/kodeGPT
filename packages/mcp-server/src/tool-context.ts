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
  search(workspaceId: string, query: string, path?: string): Promise<unknown> | unknown;
  tree(workspaceId: string, path?: string): Promise<unknown> | unknown;
}

export function createKodegptToolContext(options: {
  workspaceManager: WorkspaceManagerToolAdapter;
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
