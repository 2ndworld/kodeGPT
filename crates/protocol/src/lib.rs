#![forbid(unsafe_code)]

mod frame;
mod types;

pub use frame::{FrameError, MAX_FRAME_BYTES, read_frame, write_frame};
pub use types::{
    ArtifactReadParams, FileCommitPatchParams, FileEditParams, FileIdentityParams, FileReadParams,
    FileSearchParams, FileTreeParams, FileWriteParams, GitDiffHistoryParams, GitDiffParams,
    GitLocalMutationParams, GitLogParams, GitRangeMode, GitRangeParams, GitRevisionSpec,
    GitShowParams, GitStatusParams, InheritEnvDisabled, JsonRpcVersion, NetworkMode,
    PersistentFilesystemIdentity, ProcessInspectExecutableParams, ProcessOperationParams,
    ProcessRunParams, ProfileName, RuntimeErrorResponse, RuntimeHelloParams, RuntimePolicy,
    RuntimeRequest, RuntimeResponse, RuntimeRpcError, RuntimeSuccessResponse,
    SkillSourceCapabilityParams, SkillSourceInspectRootParams, SkillSourceReadEncoding,
    SkillSourceReadParams, SkillSourceRegisterParams, SkillSourceTreeParams,
    SystemInspectRootParams, TrustAuditAction, TrustAuditParams, TrustAuditPhase, VerifyRunParams,
    WorkspaceActivateParams, WorkspaceCapabilityParams, WorkspaceRegisterParams,
    WorkspaceRestrictPolicyParams, WorkspaceTraversalScope,
};
