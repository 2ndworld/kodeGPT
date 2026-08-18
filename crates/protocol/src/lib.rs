#![forbid(unsafe_code)]

mod frame;
mod types;

pub use frame::{FrameError, MAX_FRAME_BYTES, read_frame, write_frame};
pub use types::{
    ArtifactReadParams, CiAuditParams, CiAuditPhase, CiCapability, CiCredentialSource, CiErrorCode,
    CiProvider, FileCommitPatchParams, FileEditParams, FileIdentityParams, FileReadParams,
    FileSearchParams, FileTreeParams, FileWriteParams, FileWritePrecondition, GitDiffHistoryParams,
    GitDiffParams, GitLocalMutationParams, GitLogParams, GitRangeMode, GitRangeParams,
    GitRemoteMutationParams, GitRepositoryIdentityParams, GitRevisionSpec, GitShowParams,
    GitStatusParams, InheritEnvDisabled, JsonRpcVersion, NetworkMode, PersistentFilesystemIdentity,
    ProcessInspectExecutableParams, ProcessOperationParams, ProcessRunParams, ProfileName,
    ProviderAuditOperation, ProviderAuditParams, ProviderAuditPhase, ProviderErrorCode,
    RuntimeErrorResponse, RuntimeHelloParams, RuntimePolicy, RuntimeRequest, RuntimeResponse,
    RuntimeRpcError, RuntimeSuccessResponse, SkillSourceCapabilityParams,
    SkillSourceInspectRootParams, SkillSourceReadEncoding, SkillSourceReadParams,
    SkillSourceRegisterParams, SkillSourceTreeParams, SystemInspectRootParams, TrustAuditAction,
    TrustAuditParams, TrustAuditPhase, VerifyRunParams, WorkspaceActivateParams,
    WorkspaceCapabilityParams, WorkspaceRegisterParams, WorkspaceRestrictPolicyParams,
    WorkspaceTraversalScope,
};
