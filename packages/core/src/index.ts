export {
  KernelClient,
  KernelRpcError,
  RuntimeUnavailableError
} from "./kernel-client.js";
export type { KernelHello } from "./kernel-client.js";

export {
  DEVELOPER_ENVIRONMENT_SCHEMA_VERSION,
  MAX_DEVELOPER_ENVIRONMENTS,
  MAX_DEVELOPER_EXECUTABLE_DIRS,
  MAX_DEVELOPER_ENVIRONMENT_LABEL_BYTES,
  DeveloperEnvironmentError,
  DeveloperEnvironmentStore
} from "./developer-environment-store.js";
export type {
  DeveloperEnvironmentDiagnostic,
  DeveloperEnvironmentDiagnosticStatus,
  DeveloperEnvironmentEntry,
  DeveloperEnvironmentErrorCode,
  DeveloperEnvironmentSource,
  DeveloperExecutableDiagnosticStatus
} from "./developer-environment-store.js";

export {
  WORKSPACE_CHECKPOINT_MAX_BYTES,
  WORKSPACE_CHECKPOINT_SCHEMA_VERSION,
  WorkspaceCheckpointError,
  WorkspaceCheckpointStore
} from "./workspace-checkpoint-store.js";
export type {
  WorkspaceCheckpoint,
  WorkspaceCheckpointBody,
  WorkspaceCheckpointErrorCode,
  WorkspaceCheckpointEvidenceKind,
  WorkspaceCheckpointStatus
} from "./workspace-checkpoint-store.js";

export { ExecutionManager } from "./execution-manager.js";
export type { ProcessRunInput } from "./execution-manager.js";

export {
  DEFAULT_PREVIEW_WAIT_MS,
  MAX_PREVIEW_SESSIONS,
  MAX_PREVIEW_WAIT_MS,
  NodeLoopbackPreviewProbe,
  PreviewManager,
  PreviewManagerError
} from "./preview-manager.js";
export type {
  PreviewLookupInput,
  PreviewProbe,
  PreviewProbeResult,
  PreviewProcessAdapter,
  PreviewStartInput,
  PreviewStatusResult
} from "./preview-manager.js";

export {
  BROWSER_CONSOLE_MAX_ENTRIES,
  BROWSER_ENTRY_MAX_BYTES,
  BROWSER_EVIDENCE_MAX_BYTES,
  BROWSER_NETWORK_FAILURE_MAX_ENTRIES,
  BROWSER_SCREENSHOT_MAX_BYTES,
  BROWSER_TARGET_MAX_BYTES,
  BROWSER_TYPE_MAX_BYTES,
  DEFAULT_BROWSER_VIEWPORT,
  MAX_BROWSER_SESSIONS,
  BrowserManager,
  BrowserManagerError
} from "./browser-manager.js";
export type {
  BrowserActionResult,
  BrowserArtifactMetadata,
  BrowserArtifactWriter,
  BrowserClickInput,
  BrowserConsoleEntry,
  BrowserConsoleEvent,
  BrowserConsoleResult,
  BrowserDriver,
  BrowserDriverInspectResult,
  BrowserDriverOpenInput,
  BrowserDriverSession,
  BrowserInspectResult,
  BrowserManagerErrorCode,
  BrowserNetworkMode,
  BrowserNetworkFailureEntry,
  BrowserNetworkFailureEvent,
  BrowserNetworkFailuresResult,
  BrowserOpenPreviewInput,
  BrowserOpenResult,
  BrowserPreviewInput,
  BrowserScreenshotInput,
  BrowserScreenshotResult,
  BrowserSetViewportInput,
  BrowserTarget,
  BrowserTypeInput,
  BrowserViewport,
  BrowserWorkspaceAuthority,
  PreviewBrowserAdapter
} from "./browser-manager.js";

export {
  PlaywrightBrowserDriver,
  isAllowedPreviewDocumentUrl,
  isAllowedPreviewRequest
} from "./playwright-browser-driver.js";

export {
  VISUAL_ARTIFACT_MAX_BYTES,
  VISUAL_MAX_PIXELS,
  compareVisualPixels,
  decodeVisualPng
} from "./visual-png.js";
export type {
  DecodedVisualPng,
  VisualDimensions,
  VisualPixelComparison
} from "./visual-png.js";

export {
  VISUAL_ARTIFACT_READ_CHUNK_BYTES,
  VISUAL_VIEWPORT_MATRIX,
  VisualVerificationError,
  VisualVerificationManager
} from "./visual-verification.js";
export type {
  VisualArtifactReadResult,
  VisualArtifactReader,
  VisualBrowserAdapter,
  VisualCaptureEntry,
  VisualCaptureMatrixResult,
  VisualCompareInput,
  VisualCompareResult,
  VisualPreviewInput,
  VisualVerificationErrorCode,
  VisualViewportName
} from "./visual-verification.js";

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
  TrustedWorkspaceSummary,
  WorkspaceCheckpointMutationInput,
  WorkspaceCheckpointMutationResult,
  WorkspaceInfo,
  WorkspaceFileReadBytesResult,
  WorkspaceFileReadResult,
  WorkspaceFileWritePrecondition,
  WorkspaceSearchMatch,
  WorkspaceSearchResult,
  WorkspaceTreeEntry,
  WorkspaceTreeEntryKind
} from "./workspace-manager.js";
