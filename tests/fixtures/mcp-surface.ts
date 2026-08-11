export const EXPECTED_MCP_SURFACE_TOOLS = [
  { name: "artifact.read", required: ["uri"] },
  { name: "code.search", required: ["workspaceId", "query"] },
  { name: "console.state", required: [] },
  { name: "extension.list", required: [] },
  {
    name: "file.edit",
    required: ["workspaceId", "path", "oldText", "newText", "expectedReplacements"]
  },
  { name: "file.read", required: ["workspaceId", "path"] },
  { name: "file.search", required: ["workspaceId", "query"] },
  { name: "file.tree", required: ["workspaceId"] },
  { name: "file.write", required: ["workspaceId", "path", "content"] },
  { name: "git.changes", required: ["workspaceId"] },
  { name: "git.diff", required: ["workspaceId"] },
  { name: "git.status", required: ["workspaceId"] },
  { name: "process.cancel", required: ["workspaceId", "operationId"] },
  { name: "process.run", required: ["workspaceId", "logicalExecutable", "argv"] },
  { name: "process.status", required: ["workspaceId", "operationId"] },
  { name: "profile.current", required: ["workspaceId"] },
  { name: "profile.inspect", required: ["name"] },
  { name: "system.capabilities", required: [] },
  { name: "system.health", required: [] },
  { name: "verify.list", required: ["workspaceId"] },
  { name: "verify.run", required: ["workspaceId", "recipeId"] },
  { name: "workspace.close", required: ["workspaceId"] },
  { name: "workspace.info", required: ["workspaceId"] },
  { name: "workspace.inspect", required: ["workspaceId"] },
  { name: "workspace.list", required: [] },
  { name: "workspace.open", required: ["rootPath"] }
] as const;

export const EXPECTED_MCP_TOOL_NAMES = EXPECTED_MCP_SURFACE_TOOLS.map(({ name }) => name);

export const EXPECTED_MCP_REQUIRED_BY_NAME = Object.fromEntries(
  EXPECTED_MCP_SURFACE_TOOLS.map(({ name, required }) => [name, [...required]])
) as Record<string, string[]>;
