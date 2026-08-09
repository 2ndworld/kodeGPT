export {
  KernelClient,
  KernelRpcError,
  RuntimeUnavailableError
} from "./kernel-client.js";
export type { KernelHello } from "./kernel-client.js";

export {
  ProjectProfileInvalidError,
  WorkspaceCloseIncompleteError,
  WorkspaceManager,
  WorkspaceManagerError,
  WorkspaceNotFoundError,
  WorkspaceNotReadyError
} from "./workspace-manager.js";
export type {
  OpenWorkspace,
  WorkspaceFileReadResult,
  WorkspaceSearchMatch,
  WorkspaceTreeEntry,
  WorkspaceTreeEntryKind
} from "./workspace-manager.js";
