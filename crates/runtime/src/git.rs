use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fmt;
use std::io::Read;
use std::os::fd::OwnedFd;
use std::path::{Component, Path};
use std::sync::{Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use kodegpt_sandbox::{
    BubblewrapProvider, SandboxError, SandboxLaunchSpec, SandboxNetworkMode, TrustedExecutable,
    WorkspaceAccess, resolve_trusted_executable,
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
const GIT_MUTATION_MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const GIT_MUTATION_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_REPOSITORY_IDENTITY_TIMEOUT: Duration = Duration::from_secs(5);
const GIT_REPOSITORY_IDENTITY_MAX_REMOTES: usize = 32;
const GIT_REPOSITORY_IDENTITY_MAX_OUTPUT_BYTES: usize = 64 * 1024;
const STAGED_PATCH_HEADER: &[u8] = b"=== KODEGPT STAGED DIFF ===\n";
const WORKTREE_PATCH_HEADER: &[u8] = b"\n=== KODEGPT WORKTREE DIFF ===\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitOperation {
    Status,
    Diff,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitLocalMutation {
    Stage { paths: Vec<String> },
    Commit { message: String },
    BranchCreate { name: String },
    BranchSwitch { name: String },
    BranchDelete { name: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitRemoteMutation {
    Fetch { remote: String, r#ref: String },
    Pull { remote: String, r#ref: String },
    Push { remote: String, r#ref: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLocalMutationResult {
    pub schema_version: u32,
    pub operation: &'static str,
    pub exit_code: i32,
    pub stdout_preview: String,
    pub stderr_preview: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub source_truncated: bool,
    pub bytes_spooled: u64,
    pub artifact: RawSpoolMetadata,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GitOverflowPolicy {
    LegacySpool,
    Fail,
    Truncate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct GitCommandBudget {
    pub wall_timeout: Option<Duration>,
    pub stdout_source_bytes: usize,
    pub stderr_source_bytes: usize,
    pub preview_bytes: usize,
    pub overflow_policy: GitOverflowPolicy,
}

#[derive(Debug)]
pub(crate) struct GitCommandOutput {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr_preview: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub source_truncated: bool,
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
#[serde(rename_all = "camelCase")]
pub struct GitRemoteIdentity {
    pub name: String,
    pub fetch_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryIdentityResult {
    pub schema_version: u32,
    pub head_oid: String,
    pub branch: Option<String>,
    pub remotes: Vec<GitRemoteIdentity>,
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
    InvalidMutationInput,
    CommandFailed,
    CheckpointIdentityUnavailable,
    RepositoryIdentityInvalid,
    RepositoryIdentityLimitExceeded,
    Timeout,
    OutputLimitExceeded,
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
            Self::InvalidMutationInput => formatter.write_str("Git mutation input is invalid"),
            Self::CommandFailed => formatter.write_str("Git command failed"),
            Self::CheckpointIdentityUnavailable => {
                formatter.write_str("Git checkpoint path identity is unavailable")
            }
            Self::RepositoryIdentityInvalid => {
                formatter.write_str("Git repository identity is invalid")
            }
            Self::RepositoryIdentityLimitExceeded => {
                formatter.write_str("Git repository identity remote limit exceeded")
            }
            Self::Timeout => formatter.write_str("Git command timed out"),
            Self::OutputLimitExceeded => formatter.write_str("Git command output limit exceeded"),
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

pub fn run_git_repository_identity(
    workspace_root: &OwnedFd,
    workspace_capability: &str,
    request_id: &str,
    operation_id: &str,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
) -> Result<GitRepositoryIdentityResult, GitInspectionError> {
    let provider = BubblewrapProvider::discover()?;
    let program = resolve_trusted_executable("git").map_err(SandboxError::from)?;
    let budget = GitCommandBudget {
        wall_timeout: Some(GIT_REPOSITORY_IDENTITY_TIMEOUT),
        stdout_source_bytes: GIT_REPOSITORY_IDENTITY_MAX_OUTPUT_BYTES,
        stderr_source_bytes: PREVIEW_MAX_BYTES,
        preview_bytes: GIT_REPOSITORY_IDENTITY_MAX_OUTPUT_BYTES,
        overflow_policy: GitOverflowPolicy::Fail,
    };

    let head = run_hardened_git_command(
        &provider,
        &program,
        workspace_root,
        workspace_capability,
        request_id,
        operation_id,
        vec!["rev-parse".into(), "--verify".into(), "HEAD".into()],
        budget,
        spool,
        executions,
        false,
    )?;
    if head.exit_code != 0 {
        return Err(GitInspectionError::CommandFailed);
    }
    let head_oid = parse_repository_head_oid(&head.stdout)?;

    let branch_output = run_hardened_git_command(
        &provider,
        &program,
        workspace_root,
        workspace_capability,
        request_id,
        operation_id,
        vec![
            "symbolic-ref".into(),
            "--quiet".into(),
            "--short".into(),
            "HEAD".into(),
        ],
        budget,
        spool,
        executions,
        false,
    )?;
    let branch = match branch_output.exit_code {
        0 => Some(parse_repository_branch(&branch_output.stdout)?),
        1 if branch_output.stdout.is_empty() => None,
        _ => return Err(GitInspectionError::CommandFailed),
    };

    let remote_output = run_hardened_git_command(
        &provider,
        &program,
        workspace_root,
        workspace_capability,
        request_id,
        operation_id,
        vec![
            "config".into(),
            "--null".into(),
            "--get-regexp".into(),
            r"^remote\..*\.url$".into(),
        ],
        budget,
        spool,
        executions,
        false,
    )?;
    let mut remotes = match remote_output.exit_code {
        0 => parse_repository_remotes(&remote_output.stdout)?,
        1 if remote_output.stdout.is_empty() => Vec::new(),
        _ => return Err(GitInspectionError::CommandFailed),
    };
    remotes.sort_by(|left, right| left.name.as_bytes().cmp(right.name.as_bytes()));
    if remotes.len() > GIT_REPOSITORY_IDENTITY_MAX_REMOTES {
        return Err(GitInspectionError::RepositoryIdentityLimitExceeded);
    }

    Ok(GitRepositoryIdentityResult {
        schema_version: 1,
        head_oid,
        branch,
        remotes,
    })
}

fn parse_repository_head_oid(bytes: &[u8]) -> Result<String, GitInspectionError> {
    let value = std::str::from_utf8(bytes)
        .map_err(|_| GitInspectionError::RepositoryIdentityInvalid)?
        .trim_end_matches(['\r', '\n']);
    if !matches!(value.len(), 40 | 64)
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(GitInspectionError::RepositoryIdentityInvalid);
    }
    Ok(value.to_owned())
}

fn parse_repository_branch(bytes: &[u8]) -> Result<String, GitInspectionError> {
    let value = std::str::from_utf8(bytes)
        .map_err(|_| GitInspectionError::RepositoryIdentityInvalid)?
        .trim_end_matches(['\r', '\n']);
    if value.is_empty()
        || value.len() > 1024
        || value
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
    {
        return Err(GitInspectionError::RepositoryIdentityInvalid);
    }
    Ok(value.to_owned())
}

fn parse_repository_remotes(bytes: &[u8]) -> Result<Vec<GitRemoteIdentity>, GitInspectionError> {
    let mut remotes = BTreeMap::<String, String>::new();
    for record in bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let separator = record
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or(GitInspectionError::RepositoryIdentityInvalid)?;
        let key = std::str::from_utf8(&record[..separator])
            .map_err(|_| GitInspectionError::RepositoryIdentityInvalid)?;
        let fetch_url = std::str::from_utf8(&record[separator + 1..])
            .map_err(|_| GitInspectionError::RepositoryIdentityInvalid)?;
        let name = key
            .strip_prefix("remote.")
            .and_then(|value| value.strip_suffix(".url"))
            .ok_or(GitInspectionError::RepositoryIdentityInvalid)?;
        if name.is_empty()
            || name.len() > 128
            || name.bytes().any(|byte| byte.is_ascii_control())
            || fetch_url.is_empty()
            || fetch_url.len() > 8192
            || fetch_url.bytes().any(|byte| byte.is_ascii_control())
            || remotes
                .insert(name.to_owned(), fetch_url.to_owned())
                .is_some()
        {
            return Err(GitInspectionError::RepositoryIdentityInvalid);
        }
        if remotes.len() > GIT_REPOSITORY_IDENTITY_MAX_REMOTES {
            return Err(GitInspectionError::RepositoryIdentityLimitExceeded);
        }
    }
    Ok(remotes
        .into_iter()
        .map(|(name, fetch_url)| GitRemoteIdentity { name, fetch_url })
        .collect())
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

pub fn run_git_local_mutation(
    workspace_root: &OwnedFd,
    workspace_capability: &str,
    request_id: &str,
    operation_id: &str,
    mutation: GitLocalMutation,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
) -> Result<GitLocalMutationResult, GitInspectionError> {
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
    let (operation, args) = local_mutation_args(mutation, &filter_overrides)?;
    let budgeted = run_git_command_with_budget(
        &provider,
        &program,
        workspace_root,
        workspace_capability,
        request_id,
        operation_id,
        args,
        GitCommandBudget {
            wall_timeout: Some(GIT_MUTATION_TIMEOUT),
            stdout_source_bytes: GIT_MUTATION_MAX_OUTPUT_BYTES,
            stderr_source_bytes: GIT_MUTATION_MAX_OUTPUT_BYTES,
            preview_bytes: PREVIEW_MAX_BYTES,
            overflow_policy: GitOverflowPolicy::Truncate,
        },
        spool,
        executions,
        false,
        WorkspaceAccess::ReadWrite,
        SandboxNetworkMode::Deny,
    )?;

    Ok(GitLocalMutationResult {
        schema_version: 1,
        operation,
        exit_code: budgeted.output.exit_code,
        stdout_preview: String::from_utf8_lossy(&budgeted.output.stdout).into_owned(),
        stderr_preview: String::from_utf8_lossy(&budgeted.output.stderr_preview).into_owned(),
        stdout_truncated: budgeted.output.stdout_truncated,
        stderr_truncated: budgeted.output.stderr_truncated,
        source_truncated: budgeted.output.source_truncated || budgeted.artifact.source_truncated,
        bytes_spooled: budgeted.artifact.bytes_written,
        artifact: budgeted.artifact,
    })
}

pub fn run_git_remote_mutation(
    workspace_root: &OwnedFd,
    workspace_capability: &str,
    request_id: &str,
    operation_id: &str,
    mutation: GitRemoteMutation,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
) -> Result<GitLocalMutationResult, GitInspectionError> {
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

    match mutation {
        GitRemoteMutation::Fetch { remote, r#ref } => {
            validate_remote_mutation_input(&remote, &r#ref)?;
            run_remote_mutation_command(
                workspace_root,
                workspace_capability,
                request_id,
                operation_id,
                "fetch",
                remote_fetch_args(&remote, &r#ref, &filter_overrides),
                &provider,
                &program,
                spool,
                executions,
            )
        }
        GitRemoteMutation::Pull { remote, r#ref } => {
            validate_remote_mutation_input(&remote, &r#ref)?;
            let fetch_operation_id = format!("{operation_id}-fetch");
            let fetch = run_remote_mutation_command(
                workspace_root,
                workspace_capability,
                request_id,
                &fetch_operation_id,
                "pull",
                remote_fetch_args(&remote, &r#ref, &filter_overrides),
                &provider,
                &program,
                spool,
                executions,
            )?;
            if fetch.exit_code != 0 {
                return Ok(fetch);
            }
            run_remote_mutation_command(
                workspace_root,
                workspace_capability,
                request_id,
                operation_id,
                "pull",
                remote_pull_merge_args(&remote, &r#ref, &filter_overrides),
                &provider,
                &program,
                spool,
                executions,
            )
        }
        GitRemoteMutation::Push { remote, r#ref } => {
            validate_remote_mutation_input(&remote, &r#ref)?;
            run_remote_mutation_command(
                workspace_root,
                workspace_capability,
                request_id,
                operation_id,
                "push",
                remote_push_args(&remote, &r#ref, &filter_overrides),
                &provider,
                &program,
                spool,
                executions,
            )
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_remote_mutation_command(
    workspace_root: &OwnedFd,
    workspace_capability: &str,
    request_id: &str,
    operation_id: &str,
    operation: &'static str,
    args: Vec<OsString>,
    provider: &BubblewrapProvider,
    program: &TrustedExecutable,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
) -> Result<GitLocalMutationResult, GitInspectionError> {
    let budgeted = run_git_command_with_budget(
        provider,
        program,
        workspace_root,
        workspace_capability,
        request_id,
        operation_id,
        args,
        GitCommandBudget {
            wall_timeout: Some(GIT_MUTATION_TIMEOUT),
            stdout_source_bytes: GIT_MUTATION_MAX_OUTPUT_BYTES,
            stderr_source_bytes: GIT_MUTATION_MAX_OUTPUT_BYTES,
            preview_bytes: PREVIEW_MAX_BYTES,
            overflow_policy: GitOverflowPolicy::Truncate,
        },
        spool,
        executions,
        false,
        WorkspaceAccess::ReadWrite,
        SandboxNetworkMode::Unrestricted,
    )?;

    Ok(GitLocalMutationResult {
        schema_version: 1,
        operation,
        exit_code: budgeted.output.exit_code,
        stdout_preview: String::from_utf8_lossy(&budgeted.output.stdout).into_owned(),
        stderr_preview: String::from_utf8_lossy(&budgeted.output.stderr_preview).into_owned(),
        stdout_truncated: budgeted.output.stdout_truncated,
        stderr_truncated: budgeted.output.stderr_truncated,
        source_truncated: budgeted.output.source_truncated || budgeted.artifact.source_truncated,
        bytes_spooled: budgeted.artifact.bytes_written,
        artifact: budgeted.artifact,
    })
}

pub(crate) fn validate_remote_mutation_input(
    remote: &str,
    r#ref: &str,
) -> Result<(), GitInspectionError> {
    if !valid_remote_name(remote) || !valid_branch_name(r#ref) {
        return Err(GitInspectionError::InvalidMutationInput);
    }
    Ok(())
}

fn valid_remote_name(remote: &str) -> bool {
    if remote.is_empty() || remote.len() > 128 {
        return false;
    }
    let mut bytes = remote.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn remote_git_args(filter_overrides: &[OsString]) -> Vec<OsString> {
    let mut args = base_git_args();
    args.extend(filter_overrides.iter().cloned());
    args.extend(
        ["-c", "protocol.file.allow=always"]
            .into_iter()
            .map(OsString::from),
    );
    args
}

fn remote_fetch_args(remote: &str, r#ref: &str, filter_overrides: &[OsString]) -> Vec<OsString> {
    let mut args = remote_git_args(filter_overrides);
    args.extend(["fetch", "--no-tags"].into_iter().map(OsString::from));
    args.push(OsString::from(remote));
    args.push(OsString::from(format!(
        "{ref_name}:refs/remotes/{remote}/{ref_name}",
        ref_name = r#ref
    )));
    args
}

fn remote_pull_merge_args(
    remote: &str,
    r#ref: &str,
    filter_overrides: &[OsString],
) -> Vec<OsString> {
    let mut args = remote_git_args(filter_overrides);
    args.extend(["merge", "--ff-only"].into_iter().map(OsString::from));
    args.push(OsString::from(format!(
        "refs/remotes/{remote}/{ref_name}",
        ref_name = r#ref
    )));
    args
}

fn remote_push_args(remote: &str, r#ref: &str, filter_overrides: &[OsString]) -> Vec<OsString> {
    let mut args = remote_git_args(filter_overrides);
    args.push(OsString::from("push"));
    args.push(OsString::from(remote));
    args.push(OsString::from(format!(
        "refs/heads/{ref_name}:refs/heads/{ref_name}",
        ref_name = r#ref
    )));
    args
}

fn local_mutation_args(
    mutation: GitLocalMutation,
    filter_overrides: &[OsString],
) -> Result<(&'static str, Vec<OsString>), GitInspectionError> {
    let mut args = base_git_args();
    args.extend(filter_overrides.iter().cloned());
    let operation = match mutation {
        GitLocalMutation::Stage { paths } => {
            if paths.is_empty()
                || paths.len() > 128
                || paths.iter().any(|path| !valid_stage_path(path))
            {
                return Err(GitInspectionError::InvalidMutationInput);
            }
            args.push(OsString::from("add"));
            args.push(OsString::from("--"));
            args.extend(paths.into_iter().map(OsString::from));
            "stage"
        }
        GitLocalMutation::Commit { message } => {
            if message.is_empty() || message.len() > 4096 || message.contains('\0') {
                return Err(GitInspectionError::InvalidMutationInput);
            }
            args.extend(
                [
                    "-c",
                    "commit.gpgSign=false",
                    "commit",
                    "--no-verify",
                    "--no-gpg-sign",
                    "-m",
                ]
                .into_iter()
                .map(OsString::from),
            );
            args.push(OsString::from(message));
            "commit"
        }
        GitLocalMutation::BranchCreate { name } => {
            if !valid_branch_name(&name) {
                return Err(GitInspectionError::InvalidMutationInput);
            }
            args.extend(["branch", "--"].into_iter().map(OsString::from));
            args.push(OsString::from(name));
            "branch_create"
        }
        GitLocalMutation::BranchSwitch { name } => {
            if !valid_branch_name(&name) {
                return Err(GitInspectionError::InvalidMutationInput);
            }
            args.extend(["switch", "--"].into_iter().map(OsString::from));
            args.push(OsString::from(name));
            "branch_switch"
        }
        GitLocalMutation::BranchDelete { name } => {
            if !valid_branch_name(&name) {
                return Err(GitInspectionError::InvalidMutationInput);
            }
            args.extend(["branch", "-d", "--"].into_iter().map(OsString::from));
            args.push(OsString::from(name));
            "branch_delete"
        }
    };
    Ok((operation, args))
}

fn valid_stage_path(path: &str) -> bool {
    if path.is_empty() || path.len() > 4096 || path.contains('\0') || Path::new(path).is_absolute()
    {
        return false;
    }
    let mut saw_normal = false;
    for component in Path::new(path).components() {
        match component {
            Component::Normal(_) => saw_normal = true,
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => {
                return false;
            }
        }
    }
    saw_normal
}

fn valid_branch_name(name: &str) -> bool {
    if name.is_empty()
        || name.len() > 255
        || name == "@"
        || name.starts_with('-')
        || name.starts_with('.')
        || name.starts_with('/')
        || name.ends_with('.')
        || name.ends_with('/')
        || name.contains("..")
        || name.contains("//")
        || name.contains("@{")
        || name.contains('\\')
        || name.bytes().any(|byte| {
            byte <= 0x20 || byte == 0x7f || matches!(byte, b'~' | b'^' | b':' | b'?' | b'*' | b'[')
        })
    {
        return false;
    }
    name.split('/').all(|component| {
        !component.is_empty() && !component.starts_with('.') && !component.ends_with(".lock")
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
    program: &TrustedExecutable,
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
    program: &TrustedExecutable,
    args: Vec<OsString>,
    stdout_limit: usize,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
) -> Result<GitCommandResult, GitInspectionError> {
    let budgeted = run_git_command_with_budget(
        provider,
        program,
        workspace_root,
        workspace_capability,
        request_id,
        operation_id,
        args,
        GitCommandBudget {
            wall_timeout: None,
            stdout_source_bytes: usize::MAX,
            stderr_source_bytes: usize::MAX,
            preview_bytes: stdout_limit,
            overflow_policy: GitOverflowPolicy::LegacySpool,
        },
        spool,
        executions,
        false,
        WorkspaceAccess::ReadOnly,
        SandboxNetworkMode::Deny,
    )?;

    Ok(GitCommandResult {
        exit_code: budgeted.output.exit_code,
        stdout_preview: budgeted.output.stdout,
        stderr_preview: budgeted.output.stderr_preview,
        stdout_truncated: budgeted.output.stdout_truncated,
        stderr_truncated: budgeted.output.stderr_truncated,
        artifact: budgeted.artifact,
    })
}

pub(crate) fn run_hardened_git_command(
    provider: &BubblewrapProvider,
    program: &TrustedExecutable,
    workspace_root: &OwnedFd,
    workspace_capability: &str,
    request_id: &str,
    operation_id: &str,
    args: Vec<OsString>,
    budget: GitCommandBudget,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
    history_no_lazy_fetch: bool,
) -> Result<GitCommandOutput, GitInspectionError> {
    Ok(run_git_command_with_budget(
        provider,
        program,
        workspace_root,
        workspace_capability,
        request_id,
        operation_id,
        args,
        budget,
        spool,
        executions,
        history_no_lazy_fetch,
        WorkspaceAccess::ReadOnly,
        SandboxNetworkMode::Deny,
    )?
    .output)
}

#[derive(Debug)]
struct BudgetedGitCommandResult {
    output: GitCommandOutput,
    artifact: RawSpoolMetadata,
}

#[allow(clippy::too_many_arguments)]
fn run_git_command_with_budget(
    provider: &BubblewrapProvider,
    program: &TrustedExecutable,
    workspace_root: &OwnedFd,
    workspace_capability: &str,
    request_id: &str,
    operation_id: &str,
    args: Vec<OsString>,
    budget: GitCommandBudget,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
    history_no_lazy_fetch: bool,
    workspace_access: WorkspaceAccess,
    network: SandboxNetworkMode,
) -> Result<BudgetedGitCommandResult, GitInspectionError> {
    let mut spec = hardened_git_spec_with_access(
        program.clone(),
        args,
        history_no_lazy_fetch,
        workspace_access,
    );
    spec.network = network;
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

    let capture = capture_child_with_budget(&mut child, &mut writer, budget);
    let status = match capture {
        Ok(status) => status,
        Err(error) => {
            if !matches!(
                error,
                GitInspectionError::Timeout | GitInspectionError::OutputLimitExceeded
            ) {
                terminate_untracked_child(&mut child);
            }
            remove_execution(executions, &execution_id);
            return Err(error);
        }
    };
    remove_execution(executions, &execution_id);
    let artifact = writer.finish()?;

    Ok(BudgetedGitCommandResult {
        output: GitCommandOutput {
            exit_code: status.exit_code,
            stdout: status.stdout_preview,
            stderr_preview: status.stderr_preview,
            stdout_truncated: status.stdout_truncated,
            stderr_truncated: status.stderr_truncated,
            source_truncated: status.source_truncated || artifact.source_truncated,
        },
        artifact,
    })
}

fn hardened_git_spec(program: TrustedExecutable, args: Vec<OsString>) -> SandboxLaunchSpec {
    hardened_git_spec_with_options(program, args, false)
}

fn hardened_git_spec_with_options(
    program: TrustedExecutable,
    args: Vec<OsString>,
    history_no_lazy_fetch: bool,
) -> SandboxLaunchSpec {
    hardened_git_spec_with_access(
        program,
        args,
        history_no_lazy_fetch,
        WorkspaceAccess::ReadOnly,
    )
}

fn hardened_git_spec_with_access(
    program: TrustedExecutable,
    args: Vec<OsString>,
    history_no_lazy_fetch: bool,
    workspace_access: WorkspaceAccess,
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
    if history_no_lazy_fetch {
        spec.env
            .insert("GIT_NO_LAZY_FETCH".to_owned(), "1".to_owned());
    }
    spec.network = SandboxNetworkMode::Deny;
    spec.workspace_access = workspace_access;
    spec
}

pub(crate) fn base_git_args() -> Vec<OsString> {
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

pub(crate) fn filter_probe_args() -> Vec<OsString> {
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

pub(crate) fn filter_overrides(config_keys: &[u8]) -> Result<Vec<OsString>, GitInspectionError> {
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
    source_truncated: bool,
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
    capture_child_with_budget(
        child,
        writer,
        GitCommandBudget {
            wall_timeout: None,
            stdout_source_bytes: usize::MAX,
            stderr_source_bytes: usize::MAX,
            preview_bytes: stdout_limit,
            overflow_policy: GitOverflowPolicy::LegacySpool,
        },
    )
}

fn capture_child_with_budget(
    child: &mut kodegpt_sandbox::SandboxChild,
    writer: &mut crate::spool::RawSpoolWriter,
    budget: GitCommandBudget,
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

    let deadline = budget
        .wall_timeout
        .map(|wall_timeout| Instant::now() + wall_timeout);
    let mut stdout_preview = Vec::new();
    let mut stderr_preview = Vec::new();
    let mut stdout_truncated = false;
    let mut stderr_truncated = false;
    let mut source_truncated = false;
    let mut stdout_source_bytes = 0usize;
    let mut stderr_source_bytes = 0usize;
    let mut completed = 0;
    let mut read_failed = false;

    while completed < 2 {
        let message = match deadline {
            Some(deadline) => {
                let now = Instant::now();
                if now >= deadline {
                    abort_capture(child, receiver, stdout_reader, stderr_reader);
                    return Err(GitInspectionError::Timeout);
                }
                match receiver.recv_timeout(deadline.saturating_duration_since(now)) {
                    Ok(message) => message,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        abort_capture(child, receiver, stdout_reader, stderr_reader);
                        return Err(GitInspectionError::Timeout);
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        read_failed = true;
                        break;
                    }
                }
            }
            None => match receiver.recv() {
                Ok(message) => message,
                Err(_) => {
                    read_failed = true;
                    break;
                }
            },
        };

        match message {
            StreamMessage::Data(kind, bytes) => {
                let (seen, configured_limit) = match kind {
                    StreamKind::Stdout => (&mut stdout_source_bytes, budget.stdout_source_bytes),
                    StreamKind::Stderr => (&mut stderr_source_bytes, budget.stderr_source_bytes),
                };
                let source_limit = match budget.overflow_policy {
                    GitOverflowPolicy::LegacySpool => usize::MAX,
                    GitOverflowPolicy::Fail | GitOverflowPolicy::Truncate => configured_limit,
                };
                let remaining = source_limit.saturating_sub(*seen);
                let accepted = remaining.min(bytes.len());
                *seen = seen.saturating_add(accepted);

                if accepted > 0 {
                    let accepted_bytes = &bytes[..accepted];
                    writer.write_source(accepted_bytes)?;
                    match kind {
                        StreamKind::Stdout => append_preview(
                            &mut stdout_preview,
                            &mut stdout_truncated,
                            accepted_bytes,
                            budget.preview_bytes,
                        ),
                        StreamKind::Stderr => append_preview(
                            &mut stderr_preview,
                            &mut stderr_truncated,
                            accepted_bytes,
                            budget.preview_bytes.min(PREVIEW_MAX_BYTES),
                        ),
                    }
                }

                if accepted < bytes.len() {
                    source_truncated = true;
                    match kind {
                        StreamKind::Stdout => stdout_truncated = true,
                        StreamKind::Stderr => stderr_truncated = true,
                    }
                    abort_capture(child, receiver, stdout_reader, stderr_reader);
                    return match budget.overflow_policy {
                        GitOverflowPolicy::Fail => Err(GitInspectionError::OutputLimitExceeded),
                        GitOverflowPolicy::Truncate => Ok(CaptureResult {
                            exit_code: 1,
                            stdout_preview,
                            stderr_preview,
                            stdout_truncated,
                            stderr_truncated,
                            source_truncated,
                        }),
                        GitOverflowPolicy::LegacySpool => {
                            unreachable!("legacy spool is unbounded here")
                        }
                    };
                }
            }
            StreamMessage::Done(result) => {
                completed += 1;
                if result.is_err() {
                    read_failed = true;
                }
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
        source_truncated,
    })
}

fn abort_capture(
    child: &mut kodegpt_sandbox::SandboxChild,
    receiver: mpsc::Receiver<StreamMessage>,
    stdout_reader: thread::JoinHandle<()>,
    stderr_reader: thread::JoinHandle<()>,
) {
    drop(receiver);
    terminate_process_group_and_reap(child);
    let _ = stdout_reader.join();
    let _ = stderr_reader.join();
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
    terminate_process_group_and_reap(child);
}

fn terminate_process_group_and_reap(child: &mut kodegpt_sandbox::SandboxChild) {
    let process_group = child.process_group();
    if process_group > 0 {
        unsafe {
            libc::kill(-process_group, libc::SIGKILL);
            libc::kill(process_group, libc::SIGKILL);
        }
    } else {
        let _ = child.child_mut().kill();
    }
    let _ = child.child_mut().wait();
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs::{self, File};
    use std::os::fd::OwnedFd;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::Command as TestCommand;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use kodegpt_sandbox::{BubblewrapProvider, resolve_trusted_executable};

    use crate::audit::AuditSink;
    use crate::execution::ExecutionRegistry;
    use crate::spool::RawSpoolStore;

    use super::{
        GitCheckpointRecordType, GitCommandBudget, GitInspectionError, GitLocalMutation,
        GitOperation, GitOverflowPolicy, GitRemoteMutation, hardened_git_args, hardened_git_spec,
        hardened_git_spec_with_options, parse_checkpoint_status, run_git_checkpoint,
        run_git_checkpoint_patch, run_git_inspection, run_git_local_mutation,
        run_git_remote_mutation, run_git_repository_identity, run_hardened_git_command,
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

    fn git_stdout(root: &Path, args: &[&str]) -> String {
        let output = TestCommand::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .env_clear()
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("HOME", "/tmp")
            .output()
            .expect("test git available");
        assert!(output.status.success(), "test git command failed: {args:?}");
        String::from_utf8(output.stdout).expect("git stdout utf8")
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
    fn git_repository_identity_reads_head_branch_and_sorted_remotes() {
        let workspace = temporary_root("repository-identity");
        let state = temporary_root("repository-identity-state");
        git(&workspace, &["init"]);
        git(
            &workspace,
            &["config", "user.email", "test@example.invalid"],
        );
        git(&workspace, &["config", "user.name", "KodeGPT Test"]);
        fs::write(workspace.join("tracked.txt"), b"base\n").expect("tracked file");
        git(&workspace, &["add", "tracked.txt"]);
        git(&workspace, &["commit", "-m", "base"]);
        git(
            &workspace,
            &[
                "remote",
                "add",
                "upstream",
                "https://github.com/example/upstream.git",
            ],
        );
        git(
            &workspace,
            &[
                "remote",
                "add",
                "origin",
                "git@github.com:example/repository.git",
            ],
        );

        let expected_head = git_stdout(&workspace, &["rev-parse", "--verify", "HEAD"])
            .trim()
            .to_owned();
        let expected_branch =
            git_stdout(&workspace, &["symbolic-ref", "--quiet", "--short", "HEAD"])
                .trim()
                .to_owned();
        let root_fd = OwnedFd::from(File::open(&workspace).expect("workspace root fd"));
        let audit = Arc::new(AuditSink::open(&state));
        let spool = RawSpoolStore::open(&state, audit).expect("spool store");
        let executions = Mutex::new(ExecutionRegistry::default());

        let result = run_git_repository_identity(
            &root_fd,
            "kc_repo_identity",
            "req_repo_identity",
            "op_repo_identity",
            &spool,
            &executions,
        )
        .expect("repository identity");

        assert_eq!(result.head_oid, expected_head);
        assert_eq!(result.branch.as_deref(), Some(expected_branch.as_str()));
        assert_eq!(
            result
                .remotes
                .iter()
                .map(|remote| (remote.name.as_str(), remote.fetch_url.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("origin", "git@github.com:example/repository.git"),
                ("upstream", "https://github.com/example/upstream.git")
            ]
        );
        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(state);
    }

    #[test]
    fn git_repository_identity_rejects_more_than_thirty_two_remotes() {
        let workspace = temporary_root("repository-identity-limit");
        let state = temporary_root("repository-identity-limit-state");
        git(&workspace, &["init"]);
        git(
            &workspace,
            &["config", "user.email", "test@example.invalid"],
        );
        git(&workspace, &["config", "user.name", "KodeGPT Test"]);
        fs::write(workspace.join("tracked.txt"), b"base\n").expect("tracked file");
        git(&workspace, &["add", "tracked.txt"]);
        git(&workspace, &["commit", "-m", "base"]);
        for index in 0..33 {
            let name = format!("remote{index:02}");
            let url = format!("https://github.com/example/repository-{index:02}.git");
            git(&workspace, &["remote", "add", &name, &url]);
        }
        let root_fd = OwnedFd::from(File::open(&workspace).expect("workspace root fd"));
        let audit = Arc::new(AuditSink::open(&state));
        let spool = RawSpoolStore::open(&state, audit).expect("spool store");
        let executions = Mutex::new(ExecutionRegistry::default());

        let error = run_git_repository_identity(
            &root_fd,
            "kc_repo_identity_limit",
            "req_repo_identity_limit",
            "op_repo_identity_limit",
            &spool,
            &executions,
        )
        .expect_err("remote observation limit must fail closed");
        assert!(matches!(
            error,
            GitInspectionError::RepositoryIdentityLimitExceeded
        ));
        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(state);
    }

    #[test]
    fn history_lazy_fetch_env_is_additive_and_current_git_spec_is_unchanged() {
        let program = resolve_trusted_executable("git").expect("trusted git");
        let args = hardened_git_args(GitOperation::Status, &[]);
        let current = hardened_git_spec(program.clone(), args.clone());
        let history = hardened_git_spec_with_options(program, args, true);

        assert_eq!(
            current.env,
            BTreeMap::from([
                ("GIT_OPTIONAL_LOCKS".to_owned(), "0".to_owned()),
                ("GIT_CONFIG_NOSYSTEM".to_owned(), "1".to_owned()),
                ("GIT_CONFIG_GLOBAL".to_owned(), "/dev/null".to_owned()),
                ("GIT_ATTR_NOSYSTEM".to_owned(), "1".to_owned()),
                ("GIT_PAGER".to_owned(), "cat".to_owned()),
                ("GIT_TERMINAL_PROMPT".to_owned(), "0".to_owned()),
                ("LC_ALL".to_owned(), "C".to_owned()),
            ])
        );
        assert!(!current.env.contains_key("GIT_NO_LAZY_FETCH"));
        assert_eq!(history.args, current.args);

        let mut expected_history_env = current.env.clone();
        expected_history_env.insert("GIT_NO_LAZY_FETCH".to_owned(), "1".to_owned());
        assert_eq!(history.env, expected_history_env);
    }

    #[test]
    fn hardened_git_runner_times_out_and_reaps_process_group() {
        let workspace = temporary_root("timeout");
        let state = temporary_root("timeout-state");
        let root_fd = OwnedFd::from(File::open(&workspace).expect("workspace root fd"));
        let audit = Arc::new(AuditSink::open(&state));
        let spool = RawSpoolStore::open(&state, audit).expect("spool store");
        let executions = Arc::new(Mutex::new(ExecutionRegistry::default()));
        let provider = BubblewrapProvider::discover().expect("bubblewrap available");
        let program = resolve_trusted_executable("python3").expect("trusted python3");
        let budget = GitCommandBudget {
            wall_timeout: Some(Duration::from_millis(50)),
            stdout_source_bytes: 64 * 1024,
            stderr_source_bytes: 64 * 1024,
            preview_bytes: 64 * 1024,
            overflow_policy: GitOverflowPolicy::Fail,
        };

        thread::scope(|scope| {
            let worker_executions = Arc::clone(&executions);
            let handle = scope.spawn(move || {
                run_hardened_git_command(
                    &provider,
                    &program,
                    &root_fd,
                    "kc_git_timeout",
                    "req_git_timeout",
                    "op_git_timeout",
                    vec![
                        "-c".into(),
                        "import os,time; print(os.getpid(), flush=True); time.sleep(30)".into(),
                    ],
                    budget,
                    &spool,
                    &worker_executions,
                    false,
                )
            });

            let observation_deadline = Instant::now() + Duration::from_secs(1);
            let process_group = loop {
                let observed_process_group = {
                    let registry = executions.lock().expect("registry");
                    registry
                        .ids_for_workspace("kc_git_timeout")
                        .first()
                        .and_then(|execution_id| registry.get(execution_id))
                        .map(|record| record.process_group)
                };
                if let Some(process_group) = observed_process_group {
                    break process_group;
                }
                assert!(
                    Instant::now() < observation_deadline,
                    "execution was never registered"
                );
                thread::sleep(Duration::from_millis(1));
            };

            let result = handle.join().expect("timeout worker joins");
            assert!(matches!(result, Err(GitInspectionError::Timeout)));
            assert!(
                executions
                    .lock()
                    .expect("registry")
                    .ids_for_workspace("kc_git_timeout")
                    .is_empty()
            );

            let group_exists = unsafe { libc::kill(-process_group, 0) };
            assert_eq!(group_exists, -1);
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
        });

        fs::remove_dir_all(workspace).expect("workspace cleanup");
        fs::remove_dir_all(state).expect("state cleanup");
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

    #[test]
    fn local_git_mutation_runs_fixed_workflow_and_rejects_unsafe_inputs() {
        let workspace = temporary_root("local-mutation");
        let state = temporary_root("local-mutation-state");
        git(&workspace, &["init", "-b", "main"]);
        git(&workspace, &["config", "user.name", "KodeGPT Test"]);
        git(
            &workspace,
            &["config", "user.email", "kodegpt@example.invalid"],
        );
        fs::write(workspace.join("tracked.txt"), "first\n").expect("tracked file");

        let root_fd = OwnedFd::from(File::open(&workspace).expect("workspace root fd"));
        let audit = Arc::new(AuditSink::open(&state));
        let spool = RawSpoolStore::open(&state, audit).expect("spool store");
        let executions = Mutex::new(ExecutionRegistry::default());

        let stage = run_git_local_mutation(
            &root_fd,
            "kc_git_mutation",
            "req_git_stage",
            "op_git_stage",
            GitLocalMutation::Stage {
                paths: vec!["tracked.txt".to_owned()],
            },
            &spool,
            &executions,
        )
        .expect("stage mutation");
        assert_eq!(stage.exit_code, 0, "{}", stage.stderr_preview);

        let commit = run_git_local_mutation(
            &root_fd,
            "kc_git_mutation",
            "req_git_commit",
            "op_git_commit",
            GitLocalMutation::Commit {
                message: "initial commit".to_owned(),
            },
            &spool,
            &executions,
        )
        .expect("commit mutation");
        assert_eq!(commit.exit_code, 0, "{}", commit.stderr_preview);
        assert!(workspace.join(".git/refs/heads/main").exists());

        for (request_id, operation_id, mutation) in [
            (
                "req_git_branch_create",
                "op_git_branch_create",
                GitLocalMutation::BranchCreate {
                    name: "feature".to_owned(),
                },
            ),
            (
                "req_git_branch_switch_feature",
                "op_git_branch_switch_feature",
                GitLocalMutation::BranchSwitch {
                    name: "feature".to_owned(),
                },
            ),
            (
                "req_git_branch_switch_main",
                "op_git_branch_switch_main",
                GitLocalMutation::BranchSwitch {
                    name: "main".to_owned(),
                },
            ),
            (
                "req_git_branch_delete",
                "op_git_branch_delete",
                GitLocalMutation::BranchDelete {
                    name: "feature".to_owned(),
                },
            ),
        ] {
            let result = run_git_local_mutation(
                &root_fd,
                "kc_git_mutation",
                request_id,
                operation_id,
                mutation,
                &spool,
                &executions,
            )
            .expect("branch mutation");
            assert_eq!(result.exit_code, 0, "{}", result.stderr_preview);
        }
        assert!(!workspace.join(".git/refs/heads/feature").exists());

        for mutation in [
            GitLocalMutation::Stage {
                paths: vec!["../outside".to_owned()],
            },
            GitLocalMutation::BranchCreate {
                name: "-danger".to_owned(),
            },
            GitLocalMutation::BranchSwitch {
                name: "bad..name".to_owned(),
            },
        ] {
            assert!(matches!(
                run_git_local_mutation(
                    &root_fd,
                    "kc_git_mutation",
                    "req_git_invalid_mutation",
                    "op_git_invalid_mutation",
                    mutation,
                    &spool,
                    &executions,
                ),
                Err(GitInspectionError::InvalidMutationInput)
            ));
        }
        assert!(
            executions
                .lock()
                .expect("registry")
                .ids_for_workspace("kc_git_mutation")
                .is_empty()
        );

        fs::remove_dir_all(workspace).expect("workspace cleanup");
        fs::remove_dir_all(state).expect("state cleanup");
    }

    #[test]
    fn remote_git_mutation_fetches_pulls_and_pushes_against_workspace_local_bare_remote() {
        let workspace = temporary_root("remote-mutation");
        let state = temporary_root("remote-mutation-state");
        git(&workspace, &["init", "-b", "main"]);
        git(&workspace, &["config", "user.name", "KodeGPT Test"]);
        git(
            &workspace,
            &["config", "user.email", "kodegpt@example.invalid"],
        );
        fs::write(workspace.join("tracked.txt"), "base\n").expect("tracked file");
        git(&workspace, &["add", "tracked.txt"]);
        git(&workspace, &["commit", "-m", "base"]);
        git(&workspace, &["init", "--bare", "remote.git"]);
        git(&workspace, &["remote", "add", "origin", "remote.git"]);
        git(&workspace, &["push", "origin", "main"]);
        git(
            &workspace,
            &[
                "--git-dir",
                "remote.git",
                "symbolic-ref",
                "HEAD",
                "refs/heads/main",
            ],
        );

        git(&workspace, &["clone", "remote.git", "seed"]);
        let seed = workspace.join("seed");
        git(&seed, &["config", "user.name", "KodeGPT Seed"]);
        git(&seed, &["config", "user.email", "seed@example.invalid"]);
        fs::write(seed.join("remote.txt"), "remote\n").expect("seed file");
        git(&seed, &["add", "remote.txt"]);
        git(&seed, &["commit", "-m", "remote update"]);
        git(&seed, &["push", "origin", "main"]);
        git(&seed, &["branch", "feature"]);
        git(&seed, &["push", "origin", "feature"]);

        let root_fd = OwnedFd::from(File::open(&workspace).expect("workspace root fd"));
        let audit = Arc::new(AuditSink::open(&state));
        let spool = RawSpoolStore::open(&state, audit).expect("spool store");
        let executions = Mutex::new(ExecutionRegistry::default());

        let fetch = run_git_remote_mutation(
            &root_fd,
            "kc_git_remote",
            "req_git_fetch",
            "op_git_fetch",
            GitRemoteMutation::Fetch {
                remote: "origin".to_owned(),
                r#ref: "feature".to_owned(),
            },
            &spool,
            &executions,
        )
        .expect("fetch mutation");
        assert_eq!(fetch.exit_code, 0);
        assert!(workspace.join(".git/refs/remotes/origin/feature").exists());
        assert!(!workspace.join("remote.txt").exists());

        let pull = run_git_remote_mutation(
            &root_fd,
            "kc_git_remote",
            "req_git_pull",
            "op_git_pull",
            GitRemoteMutation::Pull {
                remote: "origin".to_owned(),
                r#ref: "main".to_owned(),
            },
            &spool,
            &executions,
        )
        .expect("pull mutation");
        assert_eq!(pull.exit_code, 0);
        assert_eq!(
            fs::read_to_string(workspace.join("remote.txt")).expect("pulled file"),
            "remote\n"
        );

        fs::write(workspace.join("local.txt"), "local\n").expect("local file");
        git(&workspace, &["add", "local.txt"]);
        git(&workspace, &["commit", "-m", "local update"]);
        let local_head = git_stdout(&workspace, &["rev-parse", "HEAD"]);
        let push = run_git_remote_mutation(
            &root_fd,
            "kc_git_remote",
            "req_git_push",
            "op_git_push",
            GitRemoteMutation::Push {
                remote: "origin".to_owned(),
                r#ref: "main".to_owned(),
            },
            &spool,
            &executions,
        )
        .expect("push mutation");
        assert_eq!(push.exit_code, 0);
        assert_eq!(
            git_stdout(
                &workspace,
                &["--git-dir", "remote.git", "rev-parse", "refs/heads/main"]
            ),
            local_head
        );

        for mutation in [
            GitRemoteMutation::Fetch {
                remote: "https://secret@example.invalid/repo.git".to_owned(),
                r#ref: "main".to_owned(),
            },
            GitRemoteMutation::Push {
                remote: "origin".to_owned(),
                r#ref: "main:evil".to_owned(),
            },
        ] {
            assert!(matches!(
                run_git_remote_mutation(
                    &root_fd,
                    "kc_git_remote",
                    "req_git_remote_invalid",
                    "op_git_remote_invalid",
                    mutation,
                    &spool,
                    &executions,
                ),
                Err(GitInspectionError::InvalidMutationInput)
            ));
        }

        fs::remove_dir_all(workspace).expect("workspace cleanup");
        fs::remove_dir_all(state).expect("state cleanup");
    }
}
