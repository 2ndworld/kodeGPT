use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InheritEnvDisabled;

impl Serialize for InheritEnvDisabled {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_bool(false)
    }
}

impl<'de> Deserialize<'de> for InheritEnvDisabled {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = bool::deserialize(deserializer)?;
        if value {
            return Err(D::Error::custom("inheritEnv must be false"));
        }
        Ok(Self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum JsonRpcVersion {
    #[serde(rename = "2.0")]
    V2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileName {
    Observe,
    Develop,
    Trusted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NetworkMode {
    Deny,
    Localhost,
    Allowlist,
    Unrestricted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersistentFilesystemIdentity {
    pub device_major: u32,
    pub device_minor: u32,
    pub inode: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimePolicy {
    pub name: ProfileName,
    pub allow_write: bool,
    pub allow_process: bool,
    pub allow_dynamic_executables: bool,
    pub network: NetworkMode,
    pub allowed_executable_names: Vec<String>,
    pub inherit_env: InheritEnvDisabled,
    pub env_allowlist: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeHelloParams {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SystemInspectRootParams {
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustAuditAction {
    Trust,
    ProfileUpdate,
    Untrust,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrustAuditPhase {
    Decision,
    Success,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustAuditParams {
    pub operation_id: String,
    pub action: TrustAuditAction,
    pub phase: TrustAuditPhase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceCheckpointAuditAction {
    Upsert,
    Clear,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceCheckpointAuditPhase {
    Decision,
    Success,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceCheckpointAuditParams {
    pub operation_id: String,
    pub action: WorkspaceCheckpointAuditAction,
    pub phase: WorkspaceCheckpointAuditPhase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CiCapability {
    #[serde(rename = "ci.repository")]
    Repository,
    #[serde(rename = "ci.status")]
    Status,
    #[serde(rename = "ci.runs")]
    Runs,
    #[serde(rename = "ci.run")]
    Run,
    #[serde(rename = "ci.failure")]
    Failure,
    #[serde(rename = "ci.rerun")]
    Rerun,
    #[serde(rename = "ci.cancel")]
    Cancel,
    #[serde(rename = "ci.dispatch")]
    Dispatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CiAuditPhase {
    Decision,
    Success,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CiProvider {
    Github,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CiCredentialSource {
    Gh,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CiErrorCode {
    #[serde(rename = "CI_WORKSPACE_AMBIGUOUS")]
    WorkspaceAmbiguous,
    #[serde(rename = "CI_AUDIT_UNAVAILABLE")]
    AuditUnavailable,
    #[serde(rename = "CI_AUTH_REQUIRED")]
    AuthRequired,
    #[serde(rename = "CI_AUTH_FAILED")]
    AuthFailed,
    #[serde(rename = "CI_REPOSITORY_UNAVAILABLE")]
    RepositoryUnavailable,
    #[serde(rename = "CI_REPOSITORY_MISMATCH")]
    RepositoryMismatch,
    #[serde(rename = "CI_REMOTE_UNSUPPORTED")]
    RemoteUnsupported,
    #[serde(rename = "CI_NOT_FOUND")]
    NotFound,
    #[serde(rename = "CI_PERMISSION_DENIED")]
    PermissionDenied,
    #[serde(rename = "CI_RATE_LIMITED")]
    RateLimited,
    #[serde(rename = "CI_PROVIDER_UNAVAILABLE")]
    ProviderUnavailable,
    #[serde(rename = "CI_RESPONSE_INVALID")]
    ResponseInvalid,
    #[serde(rename = "CI_RESPONSE_LIMIT_EXCEEDED")]
    ResponseLimitExceeded,
    #[serde(rename = "CI_LOG_UNAVAILABLE")]
    LogUnavailable,
    #[serde(rename = "CI_LOG_LIMIT_EXCEEDED")]
    LogLimitExceeded,
    #[serde(rename = "CI_MUTATION_OUTCOME_UNKNOWN")]
    MutationOutcomeUnknown,
    #[serde(rename = "CI_MUTATION_STATE_CONFLICT")]
    MutationStateConflict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CiAuditParams {
    pub capability_id: String,
    pub operation_id: String,
    pub ci_capability: CiCapability,
    pub phase: CiAuditPhase,
    pub provider: CiProvider,
    #[serde(deserialize_with = "deserialize_ci_repository")]
    pub repository: String,
    pub credential_source: Option<CiCredentialSource>,
    #[serde(default, deserialize_with = "deserialize_optional_ci_decimal_id")]
    pub run_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_ci_decimal_id")]
    pub job_id: Option<String>,
    pub error_code: Option<CiErrorCode>,
    pub truncated: Option<bool>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderAuditOperation {
    Add,
    Remove,
    Enable,
    Disable,
    Reapprove,
    Execute,
    Inventory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderAuditPhase {
    Decision,
    Success,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProviderErrorCode {
    #[serde(rename = "PROVIDER_INPUT_INVALID")]
    InputInvalid,
    #[serde(rename = "PROVIDER_STATE_INVALID")]
    StateInvalid,
    #[serde(rename = "PROVIDER_NOT_ADMITTED")]
    NotAdmitted,
    #[serde(rename = "PROVIDER_DISABLED")]
    Disabled,
    #[serde(rename = "PROVIDER_IDENTITY_CHANGED")]
    IdentityChanged,
    #[serde(rename = "PROVIDER_CREDENTIAL_UNAVAILABLE")]
    CredentialUnavailable,
    #[serde(rename = "PROVIDER_CREDENTIAL_REJECTED")]
    CredentialRejected,
    #[serde(rename = "PROVIDER_NETWORK_DENIED")]
    NetworkDenied,
    #[serde(rename = "PROVIDER_UNAVAILABLE")]
    Unavailable,
    #[serde(rename = "PROVIDER_TIMEOUT")]
    Timeout,
    #[serde(rename = "PROVIDER_CANCELLED")]
    Cancelled,
    #[serde(rename = "PROVIDER_RATE_LIMITED")]
    RateLimited,
    #[serde(rename = "PROVIDER_RESPONSE_INVALID")]
    ResponseInvalid,
    #[serde(rename = "PROVIDER_OUTPUT_LIMIT_EXCEEDED")]
    OutputLimitExceeded,
    #[serde(rename = "PROVIDER_TOOL_UNAVAILABLE")]
    ToolUnavailable,
    #[serde(rename = "PROVIDER_INVENTORY_CHANGED")]
    InventoryChanged,
    #[serde(rename = "PROVIDER_REQUEST_FAILED")]
    RequestFailed,
    #[serde(rename = "PROVIDER_AUDIT_UNAVAILABLE")]
    AuditUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderAuditParams {
    #[serde(deserialize_with = "deserialize_provider_operation_id")]
    pub operation_id: String,
    pub operation: ProviderAuditOperation,
    pub phase: ProviderAuditPhase,
    #[serde(deserialize_with = "deserialize_provider_instance_id")]
    pub provider_instance_id: String,
    #[serde(deserialize_with = "deserialize_provider_authority_id")]
    pub adapter_id: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_provider_authority_id"
    )]
    pub semantic_capability_id: Option<String>,
    pub error_code: Option<ProviderErrorCode>,
    pub inventory_changed: Option<bool>,
    pub truncated: Option<bool>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_provider_duration_ms"
    )]
    pub duration_ms: Option<u64>,
}

fn deserialize_provider_operation_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    let valid = value.strip_prefix("op_").is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix.len() <= 93
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    });
    if !valid {
        return Err(D::Error::custom("invalid provider operation id"));
    }
    Ok(value)
}

fn deserialize_provider_instance_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    let valid = value.strip_prefix("prv_").is_some_and(|suffix| {
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    });
    if !valid {
        return Err(D::Error::custom("invalid provider instance id"));
    }
    Ok(value)
}

fn valid_provider_authority_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            if index == 0 {
                byte.is_ascii_alphanumeric()
            } else {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'+' | b'-')
            }
        })
}

fn deserialize_provider_authority_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if !valid_provider_authority_id(&value) {
        return Err(D::Error::custom("invalid provider authority id"));
    }
    Ok(value)
}

fn deserialize_optional_provider_authority_id<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    if value
        .as_deref()
        .is_some_and(|candidate| !valid_provider_authority_id(candidate))
    {
        return Err(D::Error::custom("invalid provider authority id"));
    }
    Ok(value)
}

fn deserialize_optional_provider_duration_ms<'de, D>(
    deserializer: D,
) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<u64>::deserialize(deserializer)?;
    if value.is_some_and(|duration_ms| duration_ms > 86_400_000) {
        return Err(D::Error::custom("invalid provider audit duration"));
    }
    Ok(value)
}

fn deserialize_ci_repository<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.len() < 3 || value.len() > 201 || value.matches('/').count() != 1 {
        return Err(D::Error::custom("invalid CI repository"));
    }
    let mut parts = value.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    if owner.is_empty()
        || name.is_empty()
        || owner.len() > 100
        || name.len() > 100
        || owner.bytes().any(|byte| byte.is_ascii_control())
        || name.bytes().any(|byte| byte.is_ascii_control())
        || owner.contains(':')
        || name.contains(':')
        || owner.contains('@')
        || name.contains('@')
    {
        return Err(D::Error::custom("invalid CI repository"));
    }
    Ok(value)
}

fn deserialize_optional_ci_decimal_id<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    if let Some(candidate) = value.as_deref()
        && (candidate.is_empty()
            || candidate.len() > 32
            || !candidate.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err(D::Error::custom("invalid CI identifier"));
    }
    Ok(value)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRegisterParams {
    pub root_path: String,
    pub expected_identity: PersistentFilesystemIdentity,
    pub ceiling: RuntimePolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRestrictPolicyParams {
    pub capability_id: String,
    pub restriction: RuntimePolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceActivateParams {
    pub capability_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceCapabilityParams {
    pub capability_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileReadParams {
    pub capability_id: String,
    pub path: String,
    pub offset: u64,
    pub max_bytes: u64,
    #[serde(default)]
    pub encoding: Option<ReadEncoding>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReadEncoding {
    Base64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceTraversalScope {
    Literal,
    Semantic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileTreeParams {
    pub capability_id: String,
    pub path: String,
    pub max_entries: usize,
    pub scope: WorkspaceTraversalScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileSearchParams {
    pub capability_id: String,
    pub path: String,
    pub query: String,
    pub max_matches: usize,
    pub scope: WorkspaceTraversalScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileIdentityParams {
    pub capability_id: String,
    pub path: String,
    pub include_sha256: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum FileWritePrecondition {
    Missing {},
    Sha256 { value: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileWriteParams {
    pub capability_id: String,
    pub path: String,
    pub content: String,
    pub precondition: Option<FileWritePrecondition>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileEditParams {
    pub capability_id: String,
    pub path: String,
    pub old_text: String,
    pub new_text: String,
    pub expected_replacements: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FileCommitPatchParams {
    Create {
        capability_id: String,
        path: String,
        expected_sha256: (),
        content: String,
    },
    Update {
        capability_id: String,
        path: String,
        expected_sha256: String,
        content: String,
    },
    Delete {
        capability_id: String,
        path: String,
        expected_sha256: String,
        content: (),
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitStatusParams {
    pub capability_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitRepositoryIdentityParams {
    pub capability_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitDiffParams {
    pub capability_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GitLocalMutationParams {
    Stage {
        capability_id: String,
        paths: Vec<String>,
    },
    Commit {
        capability_id: String,
        message: String,
    },
    BranchCreate {
        capability_id: String,
        name: String,
    },
    BranchSwitch {
        capability_id: String,
        name: String,
    },
    BranchDelete {
        capability_id: String,
        name: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum GitRemoteCredential {
    GithubToken { token: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GitWorktreeMutationParams {
    Create {
        capability_id: String,
        name: String,
        branch: String,
    },
    Remove {
        capability_id: String,
        name: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GitRemoteMutationParams {
    Fetch {
        capability_id: String,
        remote: String,
        r#ref: String,
        credential: Option<GitRemoteCredential>,
    },
    Pull {
        capability_id: String,
        remote: String,
        r#ref: String,
        credential: Option<GitRemoteCredential>,
    },
    Push {
        capability_id: String,
        remote: String,
        r#ref: String,
        credential: Option<GitRemoteCredential>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum GitRevisionSpec {
    Head,
    Oid { oid: String },
    Branch { name: String },
    Tag { name: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitLogParams {
    pub capability_id: String,
    pub revision: GitRevisionSpec,
    pub path: Option<String>,
    pub limit: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitShowParams {
    pub capability_id: String,
    pub revision: GitRevisionSpec,
    pub path: Option<String>,
    pub include_patch: bool,
    pub max_patch_bytes: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitRangeMode {
    Direct,
    Symmetric,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitRangeParams {
    pub capability_id: String,
    pub base_revision: GitRevisionSpec,
    pub head_revision: GitRevisionSpec,
    pub mode: GitRangeMode,
    pub limit: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitDiffHistoryParams {
    pub capability_id: String,
    pub base_revision: GitRevisionSpec,
    pub head_revision: GitRevisionSpec,
    pub path: Option<String>,
    pub max_patch_bytes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessRunParams {
    pub capability_id: String,
    pub logical_executable: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub background: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessInspectExecutableParams {
    pub capability_id: String,
    pub logical_executable: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifyRunParams {
    pub capability_id: String,
    pub recipe_id: String,
    pub logical_executable: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub background: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessOperationParams {
    pub capability_id: String,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactReadParams {
    pub artifact_id: String,
    pub offset: u64,
    pub max_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkillSourceInspectRootParams {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillSourceRegisterParams {
    pub root_path: String,
    pub expected_identity: PersistentFilesystemIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillSourceTreeParams {
    pub source_capability_id: String,
    pub path: String,
    pub max_entries: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillSourceReadParams {
    pub source_capability_id: String,
    pub path: String,
    pub offset: u64,
    pub max_bytes: u64,
    #[serde(default)]
    pub encoding: Option<ReadEncoding>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillSourceCapabilityParams {
    pub source_capability_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "method", deny_unknown_fields)]
pub enum RuntimeRequest {
    #[serde(rename = "runtime.hello")]
    RuntimeHello {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: RuntimeHelloParams,
    },
    #[serde(rename = "system.inspect_root")]
    SystemInspectRoot {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: SystemInspectRootParams,
    },
    #[serde(rename = "trust.audit")]
    TrustAudit {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: TrustAuditParams,
    },
    #[serde(rename = "workspace.checkpoint_audit")]
    WorkspaceCheckpointAudit {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: WorkspaceCheckpointAuditParams,
    },
    #[serde(rename = "ci.audit")]
    CiAudit {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: CiAuditParams,
    },
    #[serde(rename = "provider.audit")]
    ProviderAudit {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: ProviderAuditParams,
    },
    #[serde(rename = "workspace.register")]
    WorkspaceRegister {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: WorkspaceRegisterParams,
    },
    #[serde(rename = "workspace.read_project_profile")]
    WorkspaceReadProjectProfile {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: WorkspaceCapabilityParams,
    },
    #[serde(rename = "workspace.restrict_policy")]
    WorkspaceRestrictPolicy {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: WorkspaceRestrictPolicyParams,
    },
    #[serde(rename = "workspace.activate")]
    WorkspaceActivate {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: WorkspaceActivateParams,
    },
    #[serde(rename = "workspace.begin_close")]
    WorkspaceBeginClose {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: WorkspaceCapabilityParams,
    },
    #[serde(rename = "workspace.cancel_executions")]
    WorkspaceCancelExecutions {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: WorkspaceCapabilityParams,
    },
    #[serde(rename = "workspace.unregister")]
    WorkspaceUnregister {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: WorkspaceCapabilityParams,
    },
    #[serde(rename = "file.read")]
    FileRead {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: FileReadParams,
    },
    #[serde(rename = "file.tree")]
    FileTree {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: FileTreeParams,
    },
    #[serde(rename = "file.search")]
    FileSearch {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: FileSearchParams,
    },
    #[serde(rename = "file.identity")]
    FileIdentity {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: FileIdentityParams,
    },
    #[serde(rename = "file.write")]
    FileWrite {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: FileWriteParams,
    },
    #[serde(rename = "file.edit")]
    FileEdit {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: FileEditParams,
    },
    #[serde(rename = "file.commit_patch_file")]
    FileCommitPatchFile {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: FileCommitPatchParams,
    },
    #[serde(rename = "git.status")]
    GitStatus {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: GitStatusParams,
    },
    #[serde(rename = "git.repository_identity")]
    GitRepositoryIdentity {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: GitRepositoryIdentityParams,
    },
    #[serde(rename = "git.checkpoint")]
    GitCheckpoint {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: GitStatusParams,
    },
    #[serde(rename = "git.checkpoint_patch")]
    GitCheckpointPatch {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: GitStatusParams,
    },
    #[serde(rename = "git.diff")]
    GitDiff {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: GitDiffParams,
    },
    #[serde(rename = "git.local_mutation")]
    GitLocalMutation {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: GitLocalMutationParams,
    },
    #[serde(rename = "git.worktree_mutation")]
    GitWorktreeMutation {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: GitWorktreeMutationParams,
    },
    #[serde(rename = "git.remote_mutation")]
    GitRemoteMutation {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: GitRemoteMutationParams,
    },
    #[serde(rename = "git.log")]
    GitLog {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: GitLogParams,
    },
    #[serde(rename = "git.show")]
    GitShow {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: GitShowParams,
    },
    #[serde(rename = "git.range")]
    GitRange {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: GitRangeParams,
    },
    #[serde(rename = "git.diff_history")]
    GitDiffHistory {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: GitDiffHistoryParams,
    },
    #[serde(rename = "process.inspect_executable")]
    ProcessInspectExecutable {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: ProcessInspectExecutableParams,
    },
    #[serde(rename = "process.run")]
    ProcessRun {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: ProcessRunParams,
    },
    #[serde(rename = "verify.run")]
    VerifyRun {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: VerifyRunParams,
    },
    #[serde(rename = "process.status")]
    ProcessStatus {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: ProcessOperationParams,
    },
    #[serde(rename = "process.cancel")]
    ProcessCancel {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: ProcessOperationParams,
    },
    #[serde(rename = "artifact.read")]
    ArtifactRead {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: ArtifactReadParams,
    },
    #[serde(rename = "skill_source.inspect_root")]
    SkillSourceInspectRoot {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: SkillSourceInspectRootParams,
    },
    #[serde(rename = "skill_source.register")]
    SkillSourceRegister {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: SkillSourceRegisterParams,
    },
    #[serde(rename = "skill_source.tree")]
    SkillSourceTree {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: SkillSourceTreeParams,
    },
    #[serde(rename = "skill_source.read")]
    SkillSourceRead {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: SkillSourceReadParams,
    },
    #[serde(rename = "skill_source.unregister")]
    SkillSourceUnregister {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: SkillSourceCapabilityParams,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeSuccessResponse<T> {
    pub jsonrpc: JsonRpcVersion,
    pub id: String,
    pub result: T,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeRpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeErrorResponse {
    pub jsonrpc: JsonRpcVersion,
    pub id: Option<String>,
    pub error: RuntimeRpcError,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RuntimeResponse<T> {
    Success(RuntimeSuccessResponse<T>),
    Error(RuntimeErrorResponse),
}
