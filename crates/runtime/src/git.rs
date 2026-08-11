use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fmt;
use std::io::Read;
use std::os::fd::OwnedFd;
use std::sync::{Mutex, mpsc};
use std::thread;

use kodegpt_sandbox::{
    BubblewrapProvider, SandboxError, SandboxLaunchSpec, SandboxNetworkMode, WorkspaceAccess,
    resolve_trusted_executable,
};
use kodegpt_workspace_io::{PathIdentityKind, PathIdentityResult, path_identity_beneath};
use serde::Serialize;

use crate::execution::{ExecutionKind, ExecutionRegistry};
use crate::spool::{RawSpoolError, RawSpoolMetadata, RawSpoolStore};

const PREVIEW_MAX_BYTES: usize = 64 * 1024;
const CAPTURE_CHUNK_BYTES: usize = 16 * 1024;
const GIT_CHECKPOINT_MAX_RECORDS: usize = 10_000;
const GIT_CHECKPOINT_STATUS_MAX_BYTES: usize = 4 * 1024 * 1024;
const GIT_CHECKPOINT_MAX_HASHED_BYTES: u64 = 64 * 1024 * 1024;
const STAGED_PATCH_HEADER: &[u8] = b"=== KODEGPT STAGED DIFF ===\n";
const WORKTREE_PATCH_HEADER: &[u8] = b"\n=== KODEGPT WORKTREE DIFF ===\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitOperation {
    Status,
    Diff,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInspectionResult {
    pub schema_version: u32,
    pub exit_code: i32,
    pub stdout_preview: String,
    pub stderr_preview: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub source_truncated: bool,
    pub bytes_spooled: u64,
    pub artifact: RawSpoolMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GitCheckpointRecordType {
    Ordinary,
    Rename,
    Unmerged,
    Untracked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckpointRecord {
    pub record_type: GitCheckpointRecordType,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_oid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_oid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage1_oid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage2_oid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage3_oid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_identity: Option<PathIdentityResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckpointResult {
    pub schema_version: u32,
    pub records: Vec<GitCheckpointRecord>,
    pub truncated: bool,
}

#[derive(Debug)]
pub enum GitInspectionError {
    Sandbox(SandboxError),
    Spool(RawSpoolError),
    RegistryUnavailable,
    CaptureFailed,
    UnsafeRepositoryConfig,
    InvalidCheckpointStatus,
    CommandFailed,
    CheckpointIdentityUnavailable,
    WaitFailed(std::io::Error),
}

impl fmt::Display for GitInspectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sandbox(error) => write!(formatter, "Git sandbox failed: {error}"),
            Self::Spool(error) => write!(formatter, "Git spool failed: {error}"),
            Self::RegistryUnavailable => formatter.write_str("Git execution registry unavailable"),
            Self::CaptureFailed => formatter.write_str("Git output capture failed"),
            Self::UnsafeRepositoryConfig => {
                formatter.write_str("Git repository helper configuration could not be neutralized")
            }
            Self::InvalidCheckpointStatus => {
                formatter.write_str("Git checkpoint status is invalid")
            }
            Self::CommandFailed => formatter.write_str("Git command failed"),
            Self::CheckpointIdentityUnavailable => {
                formatter.write_str("Git checkpoint path identity is unavailable")
            }
            Self::WaitFailed(error) => write!(formatter, "Git wait failed: {error}"),
        }
    }
}

impl std::error::Error for GitInspectionError {}

impl From<SandboxError> for GitInspectionError {
    fn from(error: SandboxError) -> Self {
        Self::Sandbox(error)
    }
}

impl From<RawSpoolError> for GitInspectionError {
    fn from(error: RawSpoolError) -> Self {
        Self::Spool(error)
    }
}

pub fn run_git_inspection(
    workspace_root: &OwnedFd,
    workspace_capability: &str,
    request_id: &str,
    operation_id: &str,
    operation: GitOperation,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
) -> Result<GitInspectionResult, GitInspectionError> {
    let provider = BubblewrapProvider::discover()?;
    let program = resolve_trusted_executable("git").map_err(SandboxError::from)?;
    let filter_overrides = discover_filter_overrides(
        workspace_root,
        workspace_capability,
        request_id,
        operation_id,
        &provider,
        &program,
        spool,
        executions,
    )?;
    let command = run_git_command(
        workspace_root,
        workspace_capability,
        request_id,
        operation_id,
        &provider,
        &program,
        hardened_git_args(operation, &filter_overrides),
        spool,
        executions,
    )?;

    Ok(GitInspectionResult {
        schema_version: 1,
        exit_code: command.exit_code,
        stdout_preview: String::from_utf8_lossy(&command.stdout_preview).into_owned(),
        stderr_preview: String::from_utf8_lossy(&command.stderr_preview).into_owned(),
        stdout_truncated: command.stdout_truncated,
        stderr_truncated: command.stderr_truncated,
        source_truncated: command.artifact.source_truncated,
        bytes_spooled: command.artifact.bytes_written,
        artifact: command.artifact,
    })
}

pub fn run_git_checkpoint(
    workspace_root: &OwnedFd,
    workspace_capability: &str,
    request_id: &str,
    operation_id: &str,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
) -> Result<GitCheckpointResult, GitInspectionError> {
    let provider = BubblewrapProvider::discover()?;
    let program = resolve_trusted_executable("git").map_err(SandboxError::from)?;
    let filter_overrides = discover_filter_overrides(
        workspace_root,
        workspace_capability,
        request_id,
        operation_id,
        &provider,
        &program,
        spool,
        executions,
    )?;
    let command = run_git_command_with_stdout_limit(
        workspace_root,
        workspace_capability,
        request_id,
        operation_id,
        &provider,
        &program,
        checkpoint_status_args(&filter_overrides),
        GIT_CHECKPOINT_STATUS_MAX_BYTES,
        spool,
        executions,
    )?;
    if command.exit_code != 0 {
        return Err(GitInspectionError::CommandFailed);
    }

    let (mut records, mut truncated) =
        parse_checkpoint_status(&command.stdout_preview, command.stdout_truncated)?;
    truncated |= attach_current_identities(workspace_root, &mut records)?;

    Ok(GitCheckpointResult {
        schema_version: 1,
        records,
        truncated,
    })
}

pub fn run_git_checkpoint_patch(
    workspace_root: &OwnedFd,
    workspace_capability: &str,
    request_id: &str,
    operation_id: &str,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
) -> Result<GitInspectionResult, GitInspectionError> {
    let provider = BubblewrapProvider::discover()?;
    let program = resolve_trusted_executable("git").map_err(SandboxError::from)?;
    let filter_overrides = discover_filter_overrides(
        workspace_root,
        workspace_capability,
        request_id,
        operation_id,
        &provider,
        &program,
        spool,
        executions,
    )?;

    let staged_spec = hardened_git_spec(
        program.clone(),
        checkpoint_patch_args(true, &filter_overrides),
    );
    let mut staged_child = provider.spawn(workspace_root, &staged_spec)?;
    let staged_execution_id =
        register_git_execution(executions, workspace_capability, &mut staged_child)?;
    let mut writer = match spool.create(
        request_id,
        operation_id,
        &staged_execution_id,
        "application/vnd.kodegpt.execution-stream",
    ) {
        Ok(writer) => writer,
        Err(error) => {
            terminate_untracked_child(&mut staged_child);
            remove_execution(executions, &staged_execution_id);
            return Err(error.into());
        }
    };

    writer.write_source(STAGED_PATCH_HEADER)?;
    let staged_capture = match capture_child(&mut staged_child, &mut writer, PREVIEW_MAX_BYTES) {
        Ok(capture) => capture,
        Err(error) => {
            terminate_untracked_child(&mut staged_child);
            remove_execution(executions, &staged_execution_id);
            return Err(error);
        }
    };
    remove_execution(executions, &staged_execution_id);
    if staged_capture.exit_code != 0 {
        return Err(GitInspectionError::CaptureFailed);
    }

    writer.write_source(WORKTREE_PATCH_HEADER)?;
    let worktree_spec = hardened_git_spec(
        program.clone(),
        checkpoint_patch_args(false, &filter_overrides),
    );
    let mut worktree_child = provider.spawn(workspace_root, &worktree_spec)?;
    let worktree_execution_id =
        register_git_execution(executions, workspace_capability, &mut worktree_child)?;
    let worktree_capture = match capture_child(&mut worktree_child, &mut writer, PREVIEW_MAX_BYTES)
    {
        Ok(capture) => capture,
        Err(error) => {
            terminate_untracked_child(&mut worktree_child);
            remove_execution(executions, &worktree_execution_id);
            return Err(error);
        }
    };
    remove_execution(executions, &worktree_execution_id);
    if worktree_capture.exit_code != 0 {
        return Err(GitInspectionError::CaptureFailed);
    }

    let mut stdout_preview = Vec::new();
    let mut stdout_truncated = false;
    append_preview(
        &mut stdout_preview,
        &mut stdout_truncated,
        STAGED_PATCH_HEADER,
        PREVIEW_MAX_BYTES,
    );
    append_preview(
        &mut stdout_preview,
        &mut stdout_truncated,
        &staged_capture.stdout_preview,
        PREVIEW_MAX_BYTES,
    );
    if staged_capture.stdout_truncated {
        stdout_truncated = true;
    }
    append_preview(
        &mut stdout_preview,
        &mut stdout_truncated,
        WORKTREE_PATCH_HEADER,
        PREVIEW_MAX_BYTES,
    );
    append_preview(
        &mut stdout_preview,
        &mut stdout_truncated,
        &worktree_capture.stdout_preview,
        PREVIEW_MAX_BYTES,
    );
    if worktree_capture.stdout_truncated {
        stdout_truncated = true;
    }

    let mut stderr_preview = Vec::new();
    let mut stderr_truncated = false;
    append_preview(
        &mut stderr_preview,
        &mut stderr_truncated,
        &staged_capture.stderr_preview,
        PREVIEW_MAX_BYTES,
    );
    append_preview(
        &mut stderr_preview,
        &mut stderr_truncated,
        &worktree_capture.stderr_preview,
        PREVIEW_MAX_BYTES,
    );
    stderr_truncated |= staged_capture.stderr_truncated || worktree_capture.stderr_truncated;

    let artifact = writer.finish()?;
    Ok(GitInspectionResult {
        schema_version: 1,
        exit_code: 0,
        stdout_preview: String::from_utf8_lossy(&stdout_preview).into_owned(),
        stderr_preview: String::from_utf8_lossy(&stderr_preview).into_owned(),
        stdout_truncated,
        stderr_truncated,
        source_truncated: artifact.source_truncated,
        bytes_spooled: artifact.bytes_written,
        artifact,
    })
}

fn register_git_execution(
    executions: &Mutex<ExecutionRegistry>,
    workspace_capability: &str,
    child: &mut kodegpt_sandbox::SandboxChild,
) -> Result<String, GitInspectionError> {
    let process_group = child.process_group();
    match executions.lock() {
        Ok(mut registry) => Ok(registry
            .register(
                workspace_capability.to_owned(),
                process_group,
                ExecutionKind::Git,
            )
            .execution_id),
        Err(_) => {
            terminate_untracked_child(child);
            Err(GitInspectionError::RegistryUnavailable)
        }
    }
}

fn checkpoint_patch_args(staged: bool, filter_overrides: &[OsString]) -> Vec<OsString> {
    let mut args = base_git_args();
    args.extend(filter_overrides.iter().cloned());
    args.push(OsString::from("diff"));
    if staged {
        args.push(OsString::from("--cached"));
    }
    args.extend(
        ["--no-ext-diff", "--no-textconv", "--ignore-submodules=all"]
            .into_iter()
            .map(OsString::from),
    );
    args
}

fn checkpoint_status_args(filter_overrides: &[OsString]) -> Vec<OsString> {
    let mut args = base_git_args();
    args.extend(filter_overrides.iter().cloned());
    args.extend(
        [
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=all",
        ]
        .into_iter()
        .map(OsString::from),
    );
    args
}

fn parse_checkpoint_status(
    bytes: &[u8],
    source_truncated: bool,
) -> Result<(Vec<GitCheckpointRecord>, bool), GitInspectionError> {
    let mut fields = bytes.split(|byte| *byte == 0).collect::<Vec<_>>();
    let complete_terminated = bytes.is_empty() || bytes.ends_with(&[0]);
    if complete_terminated && fields.last().is_some_and(|field| field.is_empty()) {
        fields.pop();
    } else if source_truncated && !fields.is_empty() {
        fields.pop();
    } else if !complete_terminated && !bytes.is_empty() {
        return Err(GitInspectionError::InvalidCheckpointStatus);
    }

    let mut records = Vec::new();
    let mut index = 0usize;
    let mut truncated = source_truncated;
    while index < fields.len() {
        if records.len() >= GIT_CHECKPOINT_MAX_RECORDS {
            truncated = true;
            break;
        }
        let field = std::str::from_utf8(fields[index])
            .map_err(|_| GitInspectionError::InvalidCheckpointStatus)?;
        index += 1;
        if field.starts_with("# ") || field.starts_with("! ") {
            continue;
        }
        if let Some(path) = field.strip_prefix("? ") {
            if path.is_empty() {
                return Err(GitInspectionError::InvalidCheckpointStatus);
            }
            records.push(GitCheckpointRecord {
                record_type: GitCheckpointRecordType::Untracked,
                path: path.to_owned(),
                original_path: None,
                index_status: None,
                worktree_status: Some("?".to_owned()),
                head_mode: None,
                index_mode: None,
                worktree_mode: None,
                head_oid: None,
                index_oid: None,
                stage1_oid: None,
                stage2_oid: None,
                stage3_oid: None,
                current_identity: None,
            });
            continue;
        }

        if field.starts_with("1 ") {
            records.push(parse_ordinary_record(field)?);
            continue;
        }
        if field.starts_with("2 ") {
            let mut record = parse_rename_record(field)?;
            let Some(original) = fields.get(index) else {
                if source_truncated {
                    truncated = true;
                    break;
                }
                return Err(GitInspectionError::InvalidCheckpointStatus);
            };
            index += 1;
            record.original_path = Some(
                std::str::from_utf8(original)
                    .map_err(|_| GitInspectionError::InvalidCheckpointStatus)?
                    .to_owned(),
            );
            records.push(record);
            continue;
        }
        if field.starts_with("u ") {
            records.push(parse_unmerged_record(field)?);
            continue;
        }
        return Err(GitInspectionError::InvalidCheckpointStatus);
    }
    Ok((records, truncated))
}

fn parse_ordinary_record(field: &str) -> Result<GitCheckpointRecord, GitInspectionError> {
    let parts = field.splitn(9, ' ').collect::<Vec<_>>();
    if parts.len() != 9 || parts[0] != "1" || parts[8].is_empty() {
        return Err(GitInspectionError::InvalidCheckpointStatus);
    }
    let (index_status, worktree_status) = parse_xy(parts[1])?;
    Ok(GitCheckpointRecord {
        record_type: GitCheckpointRecordType::Ordinary,
        path: parts[8].to_owned(),
        original_path: None,
        index_status,
        worktree_status,
        head_mode: Some(parts[3].to_owned()),
        index_mode: Some(parts[4].to_owned()),
        worktree_mode: Some(parts[5].to_owned()),
        head_oid: Some(parts[6].to_owned()),
        index_oid: Some(parts[7].to_owned()),
        stage1_oid: None,
        stage2_oid: None,
        stage3_oid: None,
        current_identity: None,
    })
}

fn parse_rename_record(field: &str) -> Result<GitCheckpointRecord, GitInspectionError> {
    let parts = field.splitn(10, ' ').collect::<Vec<_>>();
    if parts.len() != 10 || parts[0] != "2" || parts[9].is_empty() {
        return Err(GitInspectionError::InvalidCheckpointStatus);
    }
    let (index_status, worktree_status) = parse_xy(parts[1])?;
    if !(parts[8].starts_with('R') || parts[8].starts_with('C')) {
        return Err(GitInspectionError::InvalidCheckpointStatus);
    }
    Ok(GitCheckpointRecord {
        record_type: GitCheckpointRecordType::Rename,
        path: parts[9].to_owned(),
        original_path: None,
        index_status,
        worktree_status,
        head_mode: Some(parts[3].to_owned()),
        index_mode: Some(parts[4].to_owned()),
        worktree_mode: Some(parts[5].to_owned()),
        head_oid: Some(parts[6].to_owned()),
        index_oid: Some(parts[7].to_owned()),
        stage1_oid: None,
        stage2_oid: None,
        stage3_oid: None,
        current_identity: None,
    })
}

fn parse_unmerged_record(field: &str) -> Result<GitCheckpointRecord, GitInspectionError> {
    let parts = field.splitn(11, ' ').collect::<Vec<_>>();
    if parts.len() != 11 || parts[0] != "u" || parts[10].is_empty() {
        return Err(GitInspectionError::InvalidCheckpointStatus);
    }
    let (index_status, worktree_status) = parse_xy(parts[1])?;
    Ok(GitCheckpointRecord {
        record_type: GitCheckpointRecordType::Unmerged,
        path: parts[10].to_owned(),
        original_path: None,
        index_status,
        worktree_status,
        head_mode: Some(parts[3].to_owned()),
        index_mode: Some(parts[4].to_owned()),
        worktree_mode: Some(parts[6].to_owned()),
        head_oid: None,
        index_oid: None,
        stage1_oid: Some(parts[7].to_owned()),
        stage2_oid: Some(parts[8].to_owned()),
        stage3_oid: Some(parts[9].to_owned()),
        current_identity: None,
    })
}

fn parse_xy(value: &str) -> Result<(Option<String>, Option<String>), GitInspectionError> {
    let bytes = value.as_bytes();
    if bytes.len() != 2 || !bytes.iter().all(|byte| byte.is_ascii_graphic()) {
        return Err(GitInspectionError::InvalidCheckpointStatus);
    }
    Ok((normalize_status(bytes[0]), normalize_status(bytes[1])))
}

fn normalize_status(value: u8) -> Option<String> {
    (value != b'.').then(|| (value as char).to_string())
}

fn attach_current_identities(
    workspace_root: &OwnedFd,
    records: &mut [GitCheckpointRecord],
) -> Result<bool, GitInspectionError> {
    let mut hashed_bytes = 0u64;
    let mut truncated = false;
    for record in records {
        if !record_needs_current_identity(record) {
            continue;
        }
        let path = std::path::Path::new(&record.path);
        let mut metadata = path_identity_beneath(workspace_root, path, false)
            .map_err(|_| GitInspectionError::CheckpointIdentityUnavailable)?;
        if !metadata.exists {
            record.current_identity = Some(metadata);
            truncated = true;
            continue;
        }
        if !matches!(
            metadata.kind,
            Some(PathIdentityKind::File | PathIdentityKind::Symlink)
        ) {
            record.current_identity = Some(metadata);
            truncated = true;
            continue;
        }
        let size = metadata.size_bytes.unwrap_or(0);
        if hashed_bytes.saturating_add(size) > GIT_CHECKPOINT_MAX_HASHED_BYTES {
            metadata.hash_truncated = true;
            record.current_identity = Some(metadata);
            truncated = true;
            continue;
        }
        let identity = path_identity_beneath(workspace_root, path, true)
            .map_err(|_| GitInspectionError::CheckpointIdentityUnavailable)?;
        if identity.hash_truncated {
            truncated = true;
        } else {
            hashed_bytes = hashed_bytes.saturating_add(identity.size_bytes.unwrap_or(0));
        }
        record.current_identity = Some(identity);
    }
    Ok(truncated)
}

fn record_needs_current_identity(record: &GitCheckpointRecord) -> bool {
    if record.record_type == GitCheckpointRecordType::Untracked {
        return true;
    }
    record
        .worktree_status
        .as_deref()
        .is_some_and(|status| status != "D")
}

fn run_git_command(
    workspace_root: &OwnedFd,
    workspace_capability: &str,
    request_id: &str,
    operation_id: &str,
    provider: &BubblewrapProvider,
    program: &kodegpt_sandbox::TrustedExecutable,
    args: Vec<OsString>,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
) -> Result<GitCommandResult, GitInspectionError> {
    run_git_command_with_stdout_limit(
        workspace_root,
        workspace_capability,
        request_id,
        operation_id,
        provider,
        program,
        args,
        PREVIEW_MAX_BYTES,
        spool,
        executions,
    )
}

fn run_git_command_with_stdout_limit(
    workspace_root: &OwnedFd,
    workspace_capability: &str,
    request_id: &str,
    operation_id: &str,
    provider: &BubblewrapProvider,
    program: &kodegpt_sandbox::TrustedExecutable,
    args: Vec<OsString>,
    stdout_limit: usize,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
) -> Result<GitCommandResult, GitInspectionError> {
    let spec = hardened_git_spec(program.clone(), args);
    let mut child = provider.spawn(workspace_root, &spec)?;
    let process_group = child.process_group();
    let execution_id = match executions.lock() {
        Ok(mut registry) => {
            registry
                .register(
                    workspace_capability.to_owned(),
                    process_group,
                    ExecutionKind::Git,
                )
                .execution_id
        }
        Err(_) => {
            terminate_untracked_child(&mut child);
            return Err(GitInspectionError::RegistryUnavailable);
        }
    };

    let mut writer = match spool.create(
        request_id,
        operation_id,
        &execution_id,
        "application/vnd.kodegpt.execution-stream",
    ) {
        Ok(writer) => writer,
        Err(error) => {
            terminate_untracked_child(&mut child);
            remove_execution(executions, &execution_id);
            return Err(error.into());
        }
    };

    let capture = capture_child(&mut child, &mut writer, stdout_limit);
    let status = match capture {
        Ok(status) => status,
        Err(error) => {
            terminate_untracked_child(&mut child);
            remove_execution(executions, &execution_id);
            return Err(error);
        }
    };
    remove_execution(executions, &execution_id);
    let artifact = writer.finish()?;

    Ok(GitCommandResult {
        exit_code: status.exit_code,
        stdout_preview: status.stdout_preview,
        stderr_preview: status.stderr_preview,
        stdout_truncated: status.stdout_truncated,
        stderr_truncated: status.stderr_truncated,
        artifact,
    })
}

fn hardened_git_spec(
    program: kodegpt_sandbox::TrustedExecutable,
    args: Vec<OsString>,
) -> SandboxLaunchSpec {
    let mut spec = SandboxLaunchSpec::new(program);
    spec.args = args;
    spec.env = BTreeMap::from([
        ("GIT_OPTIONAL_LOCKS".to_owned(), "0".to_owned()),
        ("GIT_CONFIG_NOSYSTEM".to_owned(), "1".to_owned()),
        ("GIT_CONFIG_GLOBAL".to_owned(), "/dev/null".to_owned()),
        ("GIT_ATTR_NOSYSTEM".to_owned(), "1".to_owned()),
        ("GIT_PAGER".to_owned(), "cat".to_owned()),
        ("GIT_TERMINAL_PROMPT".to_owned(), "0".to_owned()),
        ("LC_ALL".to_owned(), "C".to_owned()),
    ]);
    spec.network = SandboxNetworkMode::Deny;
    spec.workspace_access = WorkspaceAccess::ReadOnly;
    spec
}

fn base_git_args() -> Vec<OsString> {
    [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        "-c",
        "diff.external=",
        "-c",
        "diff.autoRefreshIndex=false",
        "-c",
        "protocol.file.allow=never",
    ]
    .into_iter()
    .map(OsString::from)
    .collect()
}

fn hardened_git_args(operation: GitOperation, filter_overrides: &[OsString]) -> Vec<OsString> {
    let mut args = base_git_args();
    args.extend(filter_overrides.iter().cloned());
    match operation {
        GitOperation::Status => {
            args.extend(
                [
                    "status",
                    "--porcelain=v1",
                    "--untracked-files=all",
                    "--ignore-submodules=all",
                ]
                .into_iter()
                .map(OsString::from),
            );
        }
        GitOperation::Diff => {
            args.extend(
                [
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--ignore-submodules=all",
                ]
                .into_iter()
                .map(OsString::from),
            );
        }
    }
    args
}

fn filter_probe_args() -> Vec<OsString> {
    let mut args = base_git_args();
    args.extend(
        [
            "config",
            "--local",
            "--includes",
            "--null",
            "--name-only",
            "--get-regexp",
            "^filter\\.",
        ]
        .into_iter()
        .map(OsString::from),
    );
    args
}

fn discover_filter_overrides(
    workspace_root: &OwnedFd,
    workspace_capability: &str,
    request_id: &str,
    operation_id: &str,
    provider: &BubblewrapProvider,
    program: &kodegpt_sandbox::TrustedExecutable,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
) -> Result<Vec<OsString>, GitInspectionError> {
    let probe = run_git_command(
        workspace_root,
        workspace_capability,
        request_id,
        operation_id,
        provider,
        program,
        filter_probe_args(),
        spool,
        executions,
    )?;
    if probe.exit_code == 1 && probe.stdout_preview.is_empty() {
        return Ok(Vec::new());
    }
    if probe.exit_code != 0
        || probe.stdout_truncated
        || probe.stderr_truncated
        || probe.artifact.source_truncated
    {
        return Err(GitInspectionError::UnsafeRepositoryConfig);
    }
    filter_overrides(&probe.stdout_preview)
}

fn filter_overrides(config_keys: &[u8]) -> Result<Vec<OsString>, GitInspectionError> {
    let mut drivers = BTreeSet::new();
    for raw_key in config_keys
        .split(|byte| *byte == 0)
        .filter(|key| !key.is_empty())
    {
        let key =
            std::str::from_utf8(raw_key).map_err(|_| GitInspectionError::UnsafeRepositoryConfig)?;
        let Some(rest) = key.strip_prefix("filter.") else {
            continue;
        };
        let Some((driver, property)) = rest.rsplit_once('.') else {
            return Err(GitInspectionError::UnsafeRepositoryConfig);
        };
        if !matches!(property, "clean" | "smudge" | "process" | "required") {
            continue;
        }
        if driver.is_empty()
            || driver.len() > 128
            || !driver
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        {
            return Err(GitInspectionError::UnsafeRepositoryConfig);
        }
        drivers.insert(driver.to_owned());
    }

    let mut args = Vec::new();
    for driver in drivers {
        for (property, value) in [
            ("clean", ""),
            ("smudge", ""),
            ("process", ""),
            ("required", "false"),
        ] {
            args.push(OsString::from("-c"));
            args.push(OsString::from(format!(
                "filter.{driver}.{property}={value}"
            )));
        }
    }
    Ok(args)
}

#[derive(Debug)]
struct GitCommandResult {
    exit_code: i32,
    stdout_preview: Vec<u8>,
    stderr_preview: Vec<u8>,
    stdout_truncated: bool,
    stderr_truncated: bool,
    artifact: RawSpoolMetadata,
}

#[derive(Debug)]
struct CaptureResult {
    exit_code: i32,
    stdout_preview: Vec<u8>,
    stderr_preview: Vec<u8>,
    stdout_truncated: bool,
    stderr_truncated: bool,
}

#[derive(Debug, Clone, Copy)]
enum StreamKind {
    Stdout,
    Stderr,
}

enum StreamMessage {
    Data(StreamKind, Vec<u8>),
    Done(Result<(), std::io::Error>),
}

fn capture_child(
    child: &mut kodegpt_sandbox::SandboxChild,
    writer: &mut crate::spool::RawSpoolWriter,
    stdout_limit: usize,
) -> Result<CaptureResult, GitInspectionError> {
    let stdout = child
        .child_mut()
        .stdout
        .take()
        .ok_or(GitInspectionError::CaptureFailed)?;
    let stderr = child
        .child_mut()
        .stderr
        .take()
        .ok_or(GitInspectionError::CaptureFailed)?;
    let (sender, receiver) = mpsc::sync_channel::<StreamMessage>(8);
    let stdout_reader = spawn_reader(stdout, StreamKind::Stdout, sender.clone());
    let stderr_reader = spawn_reader(stderr, StreamKind::Stderr, sender);

    let mut stdout_preview = Vec::new();
    let mut stderr_preview = Vec::new();
    let mut stdout_truncated = false;
    let mut stderr_truncated = false;
    let mut completed = 0;
    let mut read_failed = false;

    while completed < 2 {
        match receiver.recv() {
            Ok(StreamMessage::Data(kind, bytes)) => {
                writer.write_source(&bytes)?;
                match kind {
                    StreamKind::Stdout => append_preview(
                        &mut stdout_preview,
                        &mut stdout_truncated,
                        &bytes,
                        stdout_limit,
                    ),
                    StreamKind::Stderr => append_preview(
                        &mut stderr_preview,
                        &mut stderr_truncated,
                        &bytes,
                        PREVIEW_MAX_BYTES,
                    ),
                }
            }
            Ok(StreamMessage::Done(result)) => {
                completed += 1;
                if result.is_err() {
                    read_failed = true;
                }
            }
            Err(_) => {
                read_failed = true;
                break;
            }
        }
    }

    let stdout_joined = stdout_reader.join().is_ok();
    let stderr_joined = stderr_reader.join().is_ok();
    if read_failed || !stdout_joined || !stderr_joined {
        return Err(GitInspectionError::CaptureFailed);
    }
    let status = child
        .child_mut()
        .wait()
        .map_err(GitInspectionError::WaitFailed)?;

    Ok(CaptureResult {
        exit_code: status.code().unwrap_or(1),
        stdout_preview,
        stderr_preview,
        stdout_truncated,
        stderr_truncated,
    })
}

fn spawn_reader<R: Read + Send + 'static>(
    mut reader: R,
    kind: StreamKind,
    sender: mpsc::SyncSender<StreamMessage>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let result = (|| -> Result<(), std::io::Error> {
            let mut buffer = vec![0_u8; CAPTURE_CHUNK_BYTES];
            loop {
                let read = reader.read(&mut buffer)?;
                if read == 0 {
                    return Ok(());
                }
                if sender
                    .send(StreamMessage::Data(kind, buffer[..read].to_vec()))
                    .is_err()
                {
                    return Ok(());
                }
            }
        })();
        let _ = sender.send(StreamMessage::Done(result));
    })
}

fn append_preview(target: &mut Vec<u8>, truncated: &mut bool, source: &[u8], limit: usize) {
    let remaining = limit.saturating_sub(target.len());
    let accepted = remaining.min(source.len());
    target.extend_from_slice(&source[..accepted]);
    if accepted < source.len() {
        *truncated = true;
    }
}

fn remove_execution(executions: &Mutex<ExecutionRegistry>, execution_id: &str) {
    if let Ok(mut registry) = executions.lock() {
        registry.remove(execution_id);
    }
}

fn terminate_untracked_child(child: &mut kodegpt_sandbox::SandboxChild) {
    let _ = child.child_mut().kill();
    let _ = child.child_mut().wait();
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};
    use std::os::fd::OwnedFd;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::Command as TestCommand;
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::audit::AuditSink;
    use crate::execution::ExecutionRegistry;
    use crate::spool::RawSpoolStore;

    use super::{
        GitCheckpointRecordType, GitOperation, parse_checkpoint_status, run_git_checkpoint,
        run_git_checkpoint_patch, run_git_inspection,
    };

    fn temporary_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "kodegpt-git-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temporary root");
        root
    }

    fn git(root: &Path, args: &[&str]) {
        let status = TestCommand::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .env_clear()
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("HOME", "/tmp")
            .status()
            .expect("test git available");
        assert!(status.success(), "test git command failed: {args:?}");
    }

    fn fingerprint(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        fn visit(base: &Path, current: &Path, records: &mut Vec<(PathBuf, Vec<u8>)>) {
            let mut entries = fs::read_dir(current)
                .expect("fingerprint read dir")
                .map(|entry| entry.expect("entry"))
                .collect::<Vec<_>>();
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                let path = entry.path();
                let metadata = fs::symlink_metadata(&path).expect("metadata");
                if metadata.is_dir() {
                    visit(base, &path, records);
                } else if metadata.is_file() {
                    records.push((
                        path.strip_prefix(base).expect("relative").to_path_buf(),
                        fs::read(&path).expect("file read"),
                    ));
                }
            }
        }
        let mut records = Vec::new();
        visit(root, root, &mut records);
        records
    }

    #[test]
    fn porcelain_v2_z_parser_preserves_weird_paths_and_record_types() {
        let oid_a = "1".repeat(40);
        let oid_b = "2".repeat(40);
        let oid_c = "3".repeat(40);
        let status = format!(
            "1 M. N... 100644 100644 100644 {oid_a} {oid_b} café -> \"quoted\"\tname.txt\0\
             2 R. N... 100644 100644 100644 {oid_a} {oid_b} R100 renamed -> \"tab\t文.txt\0original name.txt\0\
             u UU N... 100644 100644 100644 100644 {oid_a} {oid_b} {oid_c} conflict file.txt\0\
             ? untracked -> \"x\t文.txt\0"
        );

        let (records, truncated) =
            parse_checkpoint_status(status.as_bytes(), false).expect("porcelain v2 parses");
        assert!(!truncated);
        assert_eq!(records.len(), 4);
        assert_eq!(records[0].record_type, GitCheckpointRecordType::Ordinary);
        assert_eq!(records[0].path, "café -> \"quoted\"\tname.txt");
        assert_eq!(records[0].index_status.as_deref(), Some("M"));
        assert_eq!(records[0].worktree_status, None);
        assert_eq!(records[1].record_type, GitCheckpointRecordType::Rename);
        assert_eq!(records[1].path, "renamed -> \"tab\t文.txt");
        assert_eq!(
            records[1].original_path.as_deref(),
            Some("original name.txt")
        );
        assert_eq!(records[2].record_type, GitCheckpointRecordType::Unmerged);
        assert_eq!(records[2].path, "conflict file.txt");
        assert_eq!(records[2].stage1_oid.as_deref(), Some(oid_a.as_str()));
        assert_eq!(records[2].stage2_oid.as_deref(), Some(oid_b.as_str()));
        assert_eq!(records[2].stage3_oid.as_deref(), Some(oid_c.as_str()));
        assert_eq!(records[3].record_type, GitCheckpointRecordType::Untracked);
        assert_eq!(records[3].path, "untracked -> \"x\t文.txt");
    }

    #[test]
    fn git_checkpoint_captures_index_worktree_and_untracked_content_identity() {
        let workspace = temporary_root("checkpoint");
        let state = temporary_root("checkpoint-state");
        git(&workspace, &["init", "-q"]);
        fs::write(workspace.join("tracked.txt"), "base\n").expect("tracked fixture");
        git(&workspace, &["add", "tracked.txt"]);
        git(
            &workspace,
            &[
                "-c",
                "user.name=KodeGPT Test",
                "-c",
                "user.email=kodegpt@example.invalid",
                "commit",
                "-q",
                "-m",
                "fixture",
            ],
        );
        fs::write(workspace.join("tracked.txt"), "worktree\n").expect("worktree change");
        fs::write(workspace.join("staged.txt"), "staged\n").expect("staged change");
        git(&workspace, &["add", "staged.txt"]);
        fs::write(workspace.join("untracked.txt"), "untracked\n").expect("untracked change");

        let root_fd = OwnedFd::from(File::open(&workspace).expect("workspace root fd"));
        let audit = Arc::new(AuditSink::open(&state));
        let spool = RawSpoolStore::open(&state, audit).expect("spool store");
        let executions = Mutex::new(ExecutionRegistry::default());
        let checkpoint = run_git_checkpoint(
            &root_fd,
            "kc_git_checkpoint",
            "req_git_checkpoint",
            "op_git_checkpoint",
            &spool,
            &executions,
        )
        .expect("checkpoint succeeds");

        assert!(!checkpoint.truncated);
        let tracked = checkpoint
            .records
            .iter()
            .find(|record| record.path == "tracked.txt")
            .expect("tracked record");
        assert_eq!(tracked.worktree_status.as_deref(), Some("M"));
        assert!(
            tracked
                .current_identity
                .as_ref()
                .and_then(|identity| identity.sha256.as_ref())
                .is_some()
        );
        let staged = checkpoint
            .records
            .iter()
            .find(|record| record.path == "staged.txt")
            .expect("staged record");
        assert_eq!(staged.index_status.as_deref(), Some("A"));
        assert!(staged.index_oid.as_ref().is_some_and(|oid| oid.len() >= 40));
        assert!(staged.current_identity.is_none());
        let untracked = checkpoint
            .records
            .iter()
            .find(|record| record.path == "untracked.txt")
            .expect("untracked record");
        assert_eq!(untracked.record_type, GitCheckpointRecordType::Untracked);
        assert!(
            untracked
                .current_identity
                .as_ref()
                .and_then(|identity| identity.sha256.as_ref())
                .is_some()
        );

        let patch = run_git_checkpoint_patch(
            &root_fd,
            "kc_git_checkpoint",
            "req_git_checkpoint_patch",
            "op_git_checkpoint_patch",
            &spool,
            &executions,
        )
        .expect("checkpoint patch succeeds");
        assert_eq!(patch.exit_code, 0);
        assert!(patch.stdout_preview.contains("=== KODEGPT STAGED DIFF ==="));
        assert!(patch.stdout_preview.contains("staged.txt"));
        assert!(
            patch
                .stdout_preview
                .contains("=== KODEGPT WORKTREE DIFF ===")
        );
        assert!(patch.stdout_preview.contains("tracked.txt"));
        assert!(patch.artifact.bytes_written > patch.stdout_preview.len() as u64 / 2);

        fs::remove_dir_all(workspace).expect("workspace cleanup");
        fs::remove_dir_all(state).expect("state cleanup");
    }

    #[test]
    fn git_status_and_diff_ignore_repo_helpers_and_leave_repository_unchanged() {
        let workspace = temporary_root("workspace");
        let state = temporary_root("state");
        git(&workspace, &["init", "-q"]);
        fs::write(workspace.join("tracked.txt"), "before\n").expect("tracked fixture");
        fs::write(workspace.join("tracked.flt"), "filter-before\n").expect("filter fixture");
        fs::write(
            workspace.join(".gitattributes"),
            "*.txt diff=evil\n*.flt filter=evilfilter\n",
        )
        .expect("attributes fixture");
        git(
            &workspace,
            &["add", "tracked.txt", "tracked.flt", ".gitattributes"],
        );
        git(
            &workspace,
            &[
                "-c",
                "user.name=KodeGPT Test",
                "-c",
                "user.email=kodegpt@example.invalid",
                "commit",
                "-q",
                "-m",
                "fixture",
            ],
        );
        let helper = workspace.join("evil-helper.sh");
        fs::write(
            &helper,
            "#!/bin/sh\necho HELPER_EXECUTED >&2\nprintf 'HELPER_EXECUTED\\n'\nexit 97\n",
        )
        .expect("helper fixture");
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o755)).expect("helper executable");
        git(
            &workspace,
            &["config", "core.fsmonitor", "/workspace/evil-helper.sh"],
        );
        git(
            &workspace,
            &["config", "diff.external", "/workspace/evil-helper.sh"],
        );
        git(
            &workspace,
            &["config", "diff.evil.textconv", "/workspace/evil-helper.sh"],
        );
        git(
            &workspace,
            &[
                "config",
                "filter.evilfilter.clean",
                "/workspace/evil-helper.sh",
            ],
        );
        git(
            &workspace,
            &["config", "filter.evilfilter.required", "true"],
        );
        fs::write(workspace.join("tracked.txt"), "after\n").expect("working tree modification");
        fs::write(workspace.join("tracked.flt"), "filter-after\n")
            .expect("filtered working tree modification");

        let before_repository = fingerprint(&workspace);
        let root_fd = OwnedFd::from(File::open(&workspace).expect("workspace root fd"));
        let audit = Arc::new(AuditSink::open(&state));
        let spool = RawSpoolStore::open(&state, audit).expect("spool store");
        let executions = Mutex::new(ExecutionRegistry::default());

        let status = run_git_inspection(
            &root_fd,
            "kc_git_fixture",
            "req_git_status_fixture",
            "op_git_status_fixture",
            GitOperation::Status,
            &spool,
            &executions,
        )
        .expect("hardened status");
        assert_eq!(status.exit_code, 0, "{}", status.stderr_preview);
        assert!(status.stdout_preview.contains("tracked.txt"));
        assert!(!status.stdout_preview.contains("HELPER_EXECUTED"));
        assert!(!status.stderr_preview.contains("HELPER_EXECUTED"));

        let diff = run_git_inspection(
            &root_fd,
            "kc_git_fixture",
            "req_git_diff_fixture",
            "op_git_diff_fixture",
            GitOperation::Diff,
            &spool,
            &executions,
        )
        .expect("hardened diff");
        assert_eq!(diff.exit_code, 0, "{}", diff.stderr_preview);
        assert!(diff.stdout_preview.contains("-before"));
        assert!(diff.stdout_preview.contains("+after"));
        assert!(!diff.stdout_preview.contains("HELPER_EXECUTED"));
        assert!(!diff.stderr_preview.contains("HELPER_EXECUTED"));
        assert_eq!(fingerprint(&workspace), before_repository);
        assert!(
            executions
                .lock()
                .expect("registry")
                .ids_for_workspace("kc_git_fixture")
                .is_empty()
        );

        fs::remove_dir_all(workspace).expect("workspace cleanup");
        fs::remove_dir_all(state).expect("state cleanup");
    }
}
