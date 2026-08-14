use std::collections::BTreeMap;
use std::ffi::OsString;
use std::os::fd::OwnedFd;
use std::sync::Mutex;
use std::time::Duration;

use kodegpt_protocol::GitRevisionSpec;
use kodegpt_sandbox::{BubblewrapProvider, TrustedExecutable, resolve_trusted_executable};
use serde::Serialize;

use crate::execution::ExecutionRegistry;
use crate::git::{
    GitCommandBudget, GitInspectionError, GitOverflowPolicy, base_git_args, filter_overrides,
    filter_probe_args, run_hardened_git_command,
};
use crate::spool::RawSpoolStore;

const MAX_REF_BYTES: usize = 128;
const MAX_HISTORY_PATH_BYTES: usize = 4096;
const RESOLUTION_STDOUT_MAX_BYTES: usize = 8 * 1024;
const HISTORY_STDERR_MAX_BYTES: usize = 16 * 1024;
const COMMIT_OBJECT_MAX_BYTES: usize = 64 * 1024;
const OID_WALK_MAX_BYTES: usize = 32 * 1024;
const CHANGED_PATH_STREAM_MAX_BYTES: usize = 512 * 1024;
const MESSAGE_BODY_MAX_BYTES: usize = 16 * 1024;
const PATCH_CAPTURE_SLACK_BYTES: usize = 16 * 1024;
pub(crate) const GIT_PATCH_HARD_MAX_BYTES: u32 = 256 * 1024;
const AUTHOR_NAME_MAX_BYTES: usize = 256;
const SUBJECT_MAX_BYTES: usize = 512;
pub(crate) const GIT_HISTORY_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const GIT_LOG_DEFAULT_LIMIT: u16 = 20;
pub(crate) const GIT_LOG_MAX_LIMIT: u16 = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GitHistoryError {
    NotAGitRepository,
    RevisionInvalid,
    RevisionNotFound,
    ObjectTypeUnsupported,
    PathInvalid,
    OutputLimitExceeded,
    Timeout,
    GitUnavailable,
    GitReadFailed,
}

struct PreparedHistoryGit {
    provider: BubblewrapProvider,
    program: TrustedExecutable,
    filter_overrides: Vec<OsString>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ValidatedRevision {
    Head,
    Oid(String),
    LocalBranch(String),
    LocalTag(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ValidatedHistoryPath(String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommitSummary {
    pub oid: String,
    pub short_oid: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_time: i64,
    pub committer_time: i64,
    pub subject: String,
    pub encoding_lossy: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum GitHistoryTruncationReason {
    CommitLimit,
    MessageLimit,
    PatchLimit,
    PathLimit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitLogResult {
    pub schema_version: u32,
    pub resolved_oid: String,
    pub commits: Vec<GitCommitSummary>,
    pub returned_count: usize,
    pub truncated: bool,
    pub truncation_reasons: Vec<GitHistoryTruncationReason>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum GitChangedPathStatus {
    Added,
    Modified,
    Deleted,
    TypeChanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitHistoricalChangedPath {
    pub path: String,
    pub status: GitChangedPathStatus,
    pub insertions: Option<u64>,
    pub deletions: Option<u64>,
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitHistoricalStatSummary {
    pub files_changed: u64,
    pub insertions: u64,
    pub deletions: u64,
    pub binary_files: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommitDetail {
    pub oid: String,
    pub short_oid: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_time: i64,
    pub committer_time: i64,
    pub subject: String,
    pub body: String,
    pub message_truncated: bool,
    pub encoding_lossy: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommitInspectResult {
    pub schema_version: u32,
    pub commit: GitCommitDetail,
    pub changed_paths: Vec<GitHistoricalChangedPath>,
    pub summary: GitHistoricalStatSummary,
    pub patch: Option<String>,
    pub truncated: bool,
    pub truncation_reasons: Vec<GitHistoryTruncationReason>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ChangedPathParseResult {
    paths: Vec<GitHistoricalChangedPath>,
    summary: GitHistoricalStatSummary,
    path_limit_reached: bool,
}

fn parse_changed_paths(
    name_status: &[u8],
    numstat: &[u8],
) -> Result<ChangedPathParseResult, GitHistoryError> {
    let status_tokens = nul_tokens(name_status)?;
    if status_tokens.len() % 2 != 0 {
        return Err(GitHistoryError::GitReadFailed);
    }

    let mut statuses = Vec::with_capacity(status_tokens.len() / 2);
    for pair in status_tokens.chunks_exact(2) {
        let status = match pair[0] {
            b"A" => GitChangedPathStatus::Added,
            b"M" => GitChangedPathStatus::Modified,
            b"D" => GitChangedPathStatus::Deleted,
            b"T" => GitChangedPathStatus::TypeChanged,
            _ => return Err(GitHistoryError::GitReadFailed),
        };
        let path = parse_git_reported_path(pair[1])?;
        statuses.push((path, status));
    }

    let mut stats = BTreeMap::new();
    for record in nul_tokens(numstat)? {
        let mut fields = record.splitn(3, |byte| *byte == b'\t');
        let insertions = fields.next().ok_or(GitHistoryError::GitReadFailed)?;
        let deletions = fields.next().ok_or(GitHistoryError::GitReadFailed)?;
        let path_bytes = fields.next().ok_or(GitHistoryError::GitReadFailed)?;
        if fields.next().is_some() {
            return Err(GitHistoryError::GitReadFailed);
        }
        let path = parse_git_reported_path(path_bytes)?;
        let (insertions, deletions, binary) = match (insertions, deletions) {
            (b"-", b"-") => (None, None, true),
            (b"-", _) | (_, b"-") => return Err(GitHistoryError::GitReadFailed),
            (insertions, deletions) => (
                Some(parse_decimal_u64(insertions)?),
                Some(parse_decimal_u64(deletions)?),
                false,
            ),
        };
        if stats
            .insert(path, (insertions, deletions, binary))
            .is_some()
        {
            return Err(GitHistoryError::GitReadFailed);
        }
    }

    if statuses.len() != stats.len() {
        return Err(GitHistoryError::GitReadFailed);
    }
    let summary = GitHistoricalStatSummary {
        files_changed: stats.len() as u64,
        insertions: stats.values().filter_map(|(value, _, _)| *value).sum(),
        deletions: stats.values().filter_map(|(_, value, _)| *value).sum(),
        binary_files: stats.values().filter(|(_, _, binary)| *binary).count() as u64,
    };
    let path_limit_reached = statuses.len() > 500;
    let mut paths = Vec::with_capacity(statuses.len().min(500));
    for (path, status) in statuses.into_iter().take(500) {
        let Some((insertions, deletions, binary)) = stats.remove(&path) else {
            return Err(GitHistoryError::GitReadFailed);
        };
        paths.push(GitHistoricalChangedPath {
            path,
            status,
            insertions,
            deletions,
            binary,
        });
    }
    if !path_limit_reached && !stats.is_empty() {
        return Err(GitHistoryError::GitReadFailed);
    }

    Ok(ChangedPathParseResult {
        paths,
        summary,
        path_limit_reached,
    })
}

fn nul_tokens(input: &[u8]) -> Result<Vec<&[u8]>, GitHistoryError> {
    if input.is_empty() {
        return Ok(Vec::new());
    }
    if !input.ends_with(&[0]) {
        return Err(GitHistoryError::GitReadFailed);
    }
    Ok(input[..input.len() - 1].split(|byte| *byte == 0).collect())
}

fn parse_git_reported_path(path: &[u8]) -> Result<String, GitHistoryError> {
    let path = std::str::from_utf8(path).map_err(|_| GitHistoryError::GitReadFailed)?;
    match validate_history_path(Some(path.to_owned())) {
        Ok(Some(ValidatedHistoryPath(path))) => Ok(path),
        Ok(None) | Err(_) => Err(GitHistoryError::GitReadFailed),
    }
}

fn parse_decimal_u64(value: &[u8]) -> Result<u64, GitHistoryError> {
    if value.is_empty() || !value.iter().all(u8::is_ascii_digit) {
        return Err(GitHistoryError::GitReadFailed);
    }
    std::str::from_utf8(value)
        .map_err(|_| GitHistoryError::GitReadFailed)?
        .parse::<u64>()
        .map_err(|_| GitHistoryError::GitReadFailed)
}

fn append_history_path(args: &mut Vec<String>, path: Option<&ValidatedHistoryPath>) {
    if let Some(path) = path {
        args.push("--".to_owned());
        args.push(path.0.clone());
    }
}

fn name_status_args(oid: &str, path: Option<&ValidatedHistoryPath>) -> Vec<String> {
    let mut args = vec![
        "--literal-pathspecs".to_owned(),
        "diff-tree".to_owned(),
        "--root".to_owned(),
        "--no-commit-id".to_owned(),
        "-r".to_owned(),
        "--name-status".to_owned(),
        "-z".to_owned(),
        "--no-renames".to_owned(),
        oid.to_owned(),
    ];
    append_history_path(&mut args, path);
    args
}

fn numstat_args(oid: &str, path: Option<&ValidatedHistoryPath>) -> Vec<String> {
    let mut args = vec![
        "--literal-pathspecs".to_owned(),
        "diff-tree".to_owned(),
        "--root".to_owned(),
        "--no-commit-id".to_owned(),
        "-r".to_owned(),
        "--numstat".to_owned(),
        "-z".to_owned(),
        "--no-renames".to_owned(),
        oid.to_owned(),
    ];
    append_history_path(&mut args, path);
    args
}

fn patch_args(oid: &str, path: Option<&ValidatedHistoryPath>) -> Vec<String> {
    let mut args = vec![
        "--literal-pathspecs".to_owned(),
        "show".to_owned(),
        "--format=".to_owned(),
        "--no-ext-diff".to_owned(),
        "--no-textconv".to_owned(),
        "--no-renames".to_owned(),
        "--ignore-submodules=all".to_owned(),
        oid.to_owned(),
    ];
    append_history_path(&mut args, path);
    args
}

fn commit_object_args(oid: &str) -> Vec<String> {
    vec!["cat-file".to_owned(), "commit".to_owned(), oid.to_owned()]
}

fn read_commit_object(
    prepared: &PreparedHistoryGit,
    root_fd: &OwnedFd,
    capability_id: &str,
    request_id: &str,
    operation_id: &str,
    oid: &str,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
) -> Result<Vec<u8>, GitHistoryError> {
    if !valid_full_oid(oid) {
        return Err(GitHistoryError::GitReadFailed);
    }
    let output = run_history_command(
        prepared,
        root_fd,
        capability_id,
        request_id,
        operation_id,
        commit_object_args(oid),
        COMMIT_OBJECT_MAX_BYTES,
        spool,
        executions,
    )?;
    if output.exit_code != 0 {
        return Err(GitHistoryError::GitReadFailed);
    }
    if output.stdout_truncated || output.source_truncated {
        return Err(GitHistoryError::OutputLimitExceeded);
    }
    Ok(output.stdout)
}

fn read_commit_summary(
    prepared: &PreparedHistoryGit,
    root_fd: &OwnedFd,
    capability_id: &str,
    request_id: &str,
    operation_id: &str,
    oid: &str,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
) -> Result<GitCommitSummary, GitHistoryError> {
    let raw = read_commit_object(
        prepared,
        root_fd,
        capability_id,
        request_id,
        operation_id,
        oid,
        spool,
        executions,
    )?;
    parse_commit_object(oid, &raw)
}

fn read_commit_detail(
    prepared: &PreparedHistoryGit,
    root_fd: &OwnedFd,
    capability_id: &str,
    request_id: &str,
    operation_id: &str,
    oid: &str,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
) -> Result<GitCommitDetail, GitHistoryError> {
    let raw = read_commit_object(
        prepared,
        root_fd,
        capability_id,
        request_id,
        operation_id,
        oid,
        spool,
        executions,
    )?;
    parse_commit_detail(oid, &raw)
}

fn parse_commit_detail(oid: &str, raw: &[u8]) -> Result<GitCommitDetail, GitHistoryError> {
    let summary = parse_commit_object(oid, raw)?;
    let header_end = raw
        .windows(2)
        .position(|window| window == b"\n\n")
        .ok_or(GitHistoryError::GitReadFailed)?;
    let message = &raw[header_end + 2..];
    let body_start = message
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|index| index + 1)
        .unwrap_or(message.len());
    let mut body = &message[body_start..];
    if body.starts_with(b"\n") {
        body = &body[1..];
    }
    let body_lossy_len = String::from_utf8_lossy(body).len();
    let message_truncated =
        body.len() > MESSAGE_BODY_MAX_BYTES || body_lossy_len > MESSAGE_BODY_MAX_BYTES;
    let (body, body_lossy) = bounded_lossy_utf8(body, MESSAGE_BODY_MAX_BYTES);

    Ok(GitCommitDetail {
        oid: summary.oid,
        short_oid: summary.short_oid,
        parents: summary.parents,
        author_name: summary.author_name,
        author_time: summary.author_time,
        committer_time: summary.committer_time,
        subject: summary.subject,
        body,
        message_truncated,
        encoding_lossy: summary.encoding_lossy || body_lossy,
    })
}

fn parse_commit_object(oid: &str, raw: &[u8]) -> Result<GitCommitSummary, GitHistoryError> {
    if !valid_full_oid(oid) {
        return Err(GitHistoryError::GitReadFailed);
    }

    let Some(header_end) = raw.windows(2).position(|window| window == b"\n\n") else {
        return if raw.len() > COMMIT_OBJECT_MAX_BYTES {
            Err(GitHistoryError::OutputLimitExceeded)
        } else {
            Err(GitHistoryError::GitReadFailed)
        };
    };
    if header_end.saturating_add(2) > COMMIT_OBJECT_MAX_BYTES {
        return Err(GitHistoryError::OutputLimitExceeded);
    }

    let mut tree_seen = false;
    let mut parents = Vec::new();
    let mut author: Option<(&[u8], i64)> = None;
    let mut committer_time = None;
    let mut continuation_allowed = false;

    for line in raw[..header_end].split(|byte| *byte == b'\n') {
        if line.starts_with(b" ") {
            if !continuation_allowed {
                return Err(GitHistoryError::GitReadFailed);
            }
            continue;
        }
        continuation_allowed = false;

        if let Some(value) = line.strip_prefix(b"tree ") {
            if tree_seen || !valid_oid_bytes(value) {
                return Err(GitHistoryError::GitReadFailed);
            }
            tree_seen = true;
            continue;
        }
        if let Some(value) = line.strip_prefix(b"parent ") {
            if !valid_oid_bytes(value) {
                return Err(GitHistoryError::GitReadFailed);
            }
            parents.push(
                std::str::from_utf8(value)
                    .map_err(|_| GitHistoryError::GitReadFailed)?
                    .to_owned(),
            );
            continue;
        }
        if let Some(value) = line.strip_prefix(b"author ") {
            if author.is_some() {
                return Err(GitHistoryError::GitReadFailed);
            }
            let (name, timestamp) = parse_identity(value)?;
            author = Some((name, timestamp));
            continue;
        }
        if let Some(value) = line.strip_prefix(b"committer ") {
            if committer_time.is_some() {
                return Err(GitHistoryError::GitReadFailed);
            }
            let (_, timestamp) = parse_identity(value)?;
            committer_time = Some(timestamp);
            continue;
        }

        if line.is_empty() || !line.contains(&b' ') {
            return Err(GitHistoryError::GitReadFailed);
        }
        continuation_allowed = true;
    }

    let (author_name_bytes, author_time) = author.ok_or(GitHistoryError::GitReadFailed)?;
    let committer_time = committer_time.ok_or(GitHistoryError::GitReadFailed)?;
    if !tree_seen {
        return Err(GitHistoryError::GitReadFailed);
    }

    let message = &raw[header_end + 2..];
    let subject_bytes = message
        .split(|byte| *byte == b'\n')
        .next()
        .unwrap_or_default();
    let (author_name, author_lossy) = bounded_lossy_utf8(author_name_bytes, AUTHOR_NAME_MAX_BYTES);
    let (subject, subject_lossy) = bounded_lossy_utf8(subject_bytes, SUBJECT_MAX_BYTES);

    Ok(GitCommitSummary {
        oid: oid.to_owned(),
        short_oid: oid[..12].to_owned(),
        parents,
        author_name,
        author_time,
        committer_time,
        subject,
        encoding_lossy: author_lossy || subject_lossy,
    })
}

fn parse_identity(value: &[u8]) -> Result<(&[u8], i64), GitHistoryError> {
    let timezone_space = value
        .iter()
        .rposition(|byte| *byte == b' ')
        .ok_or(GitHistoryError::GitReadFailed)?;
    let timezone = &value[timezone_space + 1..];
    if timezone.len() != 5
        || !matches!(timezone[0], b'+' | b'-')
        || !timezone[1..].iter().all(u8::is_ascii_digit)
    {
        return Err(GitHistoryError::GitReadFailed);
    }

    let before_timezone = &value[..timezone_space];
    let timestamp_space = before_timezone
        .iter()
        .rposition(|byte| *byte == b' ')
        .ok_or(GitHistoryError::GitReadFailed)?;
    let timestamp = std::str::from_utf8(&before_timezone[timestamp_space + 1..])
        .map_err(|_| GitHistoryError::GitReadFailed)?
        .parse::<i64>()
        .map_err(|_| GitHistoryError::GitReadFailed)?;

    let identity = &before_timezone[..timestamp_space];
    let email_start = identity
        .windows(2)
        .rposition(|window| window == b" <")
        .ok_or(GitHistoryError::GitReadFailed)?;
    if !identity.ends_with(b">") || email_start + 3 > identity.len() {
        return Err(GitHistoryError::GitReadFailed);
    }
    let name = &identity[..email_start];
    let email = &identity[email_start + 2..identity.len() - 1];
    if name.is_empty() || email.is_empty() {
        return Err(GitHistoryError::GitReadFailed);
    }
    Ok((name, timestamp))
}

fn valid_oid_bytes(oid: &[u8]) -> bool {
    matches!(oid.len(), 40 | 64)
        && oid
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn bounded_lossy_utf8(source: &[u8], max_bytes: usize) -> (String, bool) {
    let lossy = std::str::from_utf8(source).is_err();
    let converted = String::from_utf8_lossy(source);
    let mut end = converted.len().min(max_bytes);
    while end > 0 && !converted.is_char_boundary(end) {
        end -= 1;
    }
    (converted[..end].to_owned(), lossy)
}

fn strict_history_budget(stdout_source_bytes: usize) -> GitCommandBudget {
    GitCommandBudget {
        wall_timeout: Some(GIT_HISTORY_TIMEOUT),
        stdout_source_bytes,
        stderr_source_bytes: HISTORY_STDERR_MAX_BYTES,
        preview_bytes: stdout_source_bytes,
        overflow_policy: GitOverflowPolicy::Fail,
    }
}

fn map_git_inspection_error(error: GitInspectionError) -> GitHistoryError {
    match error {
        GitInspectionError::Timeout => GitHistoryError::Timeout,
        GitInspectionError::OutputLimitExceeded => GitHistoryError::OutputLimitExceeded,
        GitInspectionError::Sandbox(_) => GitHistoryError::GitUnavailable,
        GitInspectionError::Spool(_)
        | GitInspectionError::RegistryUnavailable
        | GitInspectionError::CaptureFailed
        | GitInspectionError::UnsafeRepositoryConfig
        | GitInspectionError::InvalidCheckpointStatus
        | GitInspectionError::CommandFailed
        | GitInspectionError::CheckpointIdentityUnavailable
        | GitInspectionError::WaitFailed(_) => GitHistoryError::GitReadFailed,
    }
}

fn prepare_history_git(
    root_fd: &OwnedFd,
    capability_id: &str,
    request_id: &str,
    operation_id: &str,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
) -> Result<PreparedHistoryGit, GitHistoryError> {
    let provider = BubblewrapProvider::discover().map_err(|_| GitHistoryError::GitUnavailable)?;
    let program = resolve_trusted_executable("git").map_err(|_| GitHistoryError::GitUnavailable)?;

    let mut preflight_args = base_git_args();
    preflight_args.extend(["rev-parse", "--git-dir"].into_iter().map(OsString::from));
    let preflight = run_hardened_git_command(
        &provider,
        &program,
        root_fd,
        capability_id,
        request_id,
        operation_id,
        preflight_args,
        strict_history_budget(RESOLUTION_STDOUT_MAX_BYTES),
        spool,
        executions,
        true,
    )
    .map_err(map_git_inspection_error)?;
    if preflight.exit_code != 0 {
        return Err(GitHistoryError::NotAGitRepository);
    }
    if preflight.stdout_truncated || preflight.source_truncated {
        return Err(GitHistoryError::OutputLimitExceeded);
    }

    let filter_probe = run_hardened_git_command(
        &provider,
        &program,
        root_fd,
        capability_id,
        request_id,
        operation_id,
        filter_probe_args(),
        strict_history_budget(RESOLUTION_STDOUT_MAX_BYTES),
        spool,
        executions,
        true,
    )
    .map_err(map_git_inspection_error)?;
    let filter_overrides = if filter_probe.exit_code == 1 && filter_probe.stdout.is_empty() {
        Vec::new()
    } else if filter_probe.exit_code != 0
        || filter_probe.stdout_truncated
        || filter_probe.stderr_truncated
        || filter_probe.source_truncated
    {
        return Err(GitHistoryError::GitReadFailed);
    } else {
        filter_overrides(&filter_probe.stdout).map_err(map_git_inspection_error)?
    };

    Ok(PreparedHistoryGit {
        provider,
        program,
        filter_overrides,
    })
}

fn revision_candidate(revision: &ValidatedRevision) -> String {
    match revision {
        ValidatedRevision::Head => "HEAD".to_owned(),
        ValidatedRevision::Oid(oid) => oid.clone(),
        ValidatedRevision::LocalBranch(name) => format!("refs/heads/{name}"),
        ValidatedRevision::LocalTag(name) => format!("refs/tags/{name}"),
    }
}

fn revision_probe_suffixes(candidate: &str) -> (Vec<String>, Vec<String>) {
    (
        vec![
            "rev-parse".to_owned(),
            "--verify".to_owned(),
            "--end-of-options".to_owned(),
            format!("{candidate}^{{object}}"),
        ],
        vec![
            "rev-parse".to_owned(),
            "--verify".to_owned(),
            "--end-of-options".to_owned(),
            format!("{candidate}^{{commit}}"),
        ],
    )
}

fn history_command_args(prepared: &PreparedHistoryGit, suffix: Vec<String>) -> Vec<OsString> {
    let mut args = base_git_args();
    args.extend(prepared.filter_overrides.iter().cloned());
    args.extend(suffix.into_iter().map(OsString::from));
    args
}

fn run_history_command(
    prepared: &PreparedHistoryGit,
    root_fd: &OwnedFd,
    capability_id: &str,
    request_id: &str,
    operation_id: &str,
    suffix: Vec<String>,
    stdout_source_bytes: usize,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
) -> Result<crate::git::GitCommandOutput, GitHistoryError> {
    run_history_command_with_budget(
        prepared,
        root_fd,
        capability_id,
        request_id,
        operation_id,
        suffix,
        strict_history_budget(stdout_source_bytes),
        spool,
        executions,
    )
}

#[allow(clippy::too_many_arguments)]
fn run_history_command_with_budget(
    prepared: &PreparedHistoryGit,
    root_fd: &OwnedFd,
    capability_id: &str,
    request_id: &str,
    operation_id: &str,
    suffix: Vec<String>,
    budget: GitCommandBudget,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
) -> Result<crate::git::GitCommandOutput, GitHistoryError> {
    run_hardened_git_command(
        &prepared.provider,
        &prepared.program,
        root_fd,
        capability_id,
        request_id,
        operation_id,
        history_command_args(prepared, suffix),
        budget,
        spool,
        executions,
        true,
    )
    .map_err(map_git_inspection_error)
}

fn parse_resolved_oid(stdout: &[u8]) -> Result<String, GitHistoryError> {
    let text = std::str::from_utf8(stdout).map_err(|_| GitHistoryError::GitReadFailed)?;
    let oid = text.strip_suffix('\n').unwrap_or(text);
    if oid.contains('\n') || !valid_full_oid(oid) {
        return Err(GitHistoryError::GitReadFailed);
    }
    Ok(oid.to_owned())
}

fn resolve_revision(
    prepared: &PreparedHistoryGit,
    root_fd: &OwnedFd,
    capability_id: &str,
    request_id: &str,
    operation_id: &str,
    revision: ValidatedRevision,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
) -> Result<String, GitHistoryError> {
    let candidate = revision_candidate(&revision);
    let (object_probe, commit_probe) = revision_probe_suffixes(&candidate);

    let object = run_history_command(
        prepared,
        root_fd,
        capability_id,
        request_id,
        operation_id,
        object_probe,
        RESOLUTION_STDOUT_MAX_BYTES,
        spool,
        executions,
    )?;
    if object.exit_code != 0 {
        return Err(GitHistoryError::RevisionNotFound);
    }
    if object.stdout_truncated || object.source_truncated {
        return Err(GitHistoryError::OutputLimitExceeded);
    }
    parse_resolved_oid(&object.stdout)?;

    let commit = run_history_command(
        prepared,
        root_fd,
        capability_id,
        request_id,
        operation_id,
        commit_probe,
        RESOLUTION_STDOUT_MAX_BYTES,
        spool,
        executions,
    )?;
    if commit.exit_code != 0 {
        return Err(GitHistoryError::ObjectTypeUnsupported);
    }
    if commit.stdout_truncated || commit.source_truncated {
        return Err(GitHistoryError::OutputLimitExceeded);
    }
    parse_resolved_oid(&commit.stdout)
}

fn log_walk_args(
    resolved_oid: &str,
    path: Option<&ValidatedHistoryPath>,
    limit: u16,
) -> Vec<String> {
    let mut args = vec![
        "--literal-pathspecs".to_owned(),
        "rev-list".to_owned(),
        "--topo-order".to_owned(),
        format!("--max-count={}", u32::from(limit) + 1),
        resolved_oid.to_owned(),
    ];
    if let Some(path) = path {
        args.push("--".to_owned());
        args.push(path.0.clone());
    }
    args
}

fn parse_oid_walk(stdout: &[u8]) -> Result<Vec<String>, GitHistoryError> {
    if stdout.is_empty() {
        return Ok(Vec::new());
    }
    let text = std::str::from_utf8(stdout).map_err(|_| GitHistoryError::GitReadFailed)?;
    let mut oids = Vec::new();
    for line in text.lines() {
        if !valid_full_oid(line) {
            return Err(GitHistoryError::GitReadFailed);
        }
        oids.push(line.to_owned());
    }
    Ok(oids)
}

pub(crate) fn run_git_log(
    root_fd: &OwnedFd,
    capability_id: &str,
    request_id: &str,
    operation_id: &str,
    revision: ValidatedRevision,
    path: Option<ValidatedHistoryPath>,
    limit: u16,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
) -> Result<GitLogResult, GitHistoryError> {
    if limit == 0 || limit > GIT_LOG_MAX_LIMIT {
        return Err(GitHistoryError::GitReadFailed);
    }

    let prepared = prepare_history_git(
        root_fd,
        capability_id,
        request_id,
        operation_id,
        spool,
        executions,
    )?;
    let resolved_oid = resolve_revision(
        &prepared,
        root_fd,
        capability_id,
        request_id,
        operation_id,
        revision,
        spool,
        executions,
    )?;
    let walk = run_history_command(
        &prepared,
        root_fd,
        capability_id,
        request_id,
        operation_id,
        log_walk_args(&resolved_oid, path.as_ref(), limit),
        OID_WALK_MAX_BYTES,
        spool,
        executions,
    )?;
    if walk.exit_code != 0 {
        return Err(GitHistoryError::GitReadFailed);
    }
    if walk.stdout_truncated || walk.source_truncated {
        return Err(GitHistoryError::OutputLimitExceeded);
    }

    let mut oids = parse_oid_walk(&walk.stdout)?;
    if oids.len() > usize::from(limit) + 1 {
        return Err(GitHistoryError::GitReadFailed);
    }
    let truncated = oids.len() > usize::from(limit);
    if truncated {
        oids.truncate(usize::from(limit));
    }

    let mut commits = Vec::with_capacity(oids.len());
    for oid in &oids {
        commits.push(read_commit_summary(
            &prepared,
            root_fd,
            capability_id,
            request_id,
            operation_id,
            oid,
            spool,
            executions,
        )?);
    }
    let truncation_reasons = if truncated {
        vec![GitHistoryTruncationReason::CommitLimit]
    } else {
        Vec::new()
    };

    Ok(GitLogResult {
        schema_version: 1,
        resolved_oid,
        returned_count: commits.len(),
        commits,
        truncated: !truncation_reasons.is_empty(),
        truncation_reasons,
    })
}

fn bounded_utf8_prefix(bytes: &[u8], max_bytes: usize) -> Result<String, GitHistoryError> {
    let end = bytes.len().min(max_bytes);
    match std::str::from_utf8(&bytes[..end]) {
        Ok(text) => Ok(text.to_owned()),
        Err(error) if error.error_len().is_none() => {
            let valid_up_to = error.valid_up_to();
            std::str::from_utf8(&bytes[..valid_up_to])
                .map(str::to_owned)
                .map_err(|_| GitHistoryError::GitReadFailed)
        }
        Err(_) => Err(GitHistoryError::GitReadFailed),
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run_git_show(
    root_fd: &OwnedFd,
    capability_id: &str,
    request_id: &str,
    operation_id: &str,
    revision: ValidatedRevision,
    path: Option<ValidatedHistoryPath>,
    include_patch: bool,
    max_patch_bytes: u32,
    spool: &RawSpoolStore,
    executions: &Mutex<ExecutionRegistry>,
) -> Result<GitCommitInspectResult, GitHistoryError> {
    if max_patch_bytes == 0 || max_patch_bytes > GIT_PATCH_HARD_MAX_BYTES {
        return Err(GitHistoryError::GitReadFailed);
    }

    let prepared = prepare_history_git(
        root_fd,
        capability_id,
        request_id,
        operation_id,
        spool,
        executions,
    )?;
    let resolved_oid = resolve_revision(
        &prepared,
        root_fd,
        capability_id,
        request_id,
        operation_id,
        revision,
        spool,
        executions,
    )?;
    let commit = read_commit_detail(
        &prepared,
        root_fd,
        capability_id,
        request_id,
        operation_id,
        &resolved_oid,
        spool,
        executions,
    )?;

    let name_status = run_history_command(
        &prepared,
        root_fd,
        capability_id,
        request_id,
        operation_id,
        name_status_args(&resolved_oid, path.as_ref()),
        CHANGED_PATH_STREAM_MAX_BYTES,
        spool,
        executions,
    )?;
    let numstat = run_history_command(
        &prepared,
        root_fd,
        capability_id,
        request_id,
        operation_id,
        numstat_args(&resolved_oid, path.as_ref()),
        CHANGED_PATH_STREAM_MAX_BYTES,
        spool,
        executions,
    )?;
    for output in [&name_status, &numstat] {
        if output.exit_code != 0 {
            return Err(GitHistoryError::GitReadFailed);
        }
        if output.stdout_truncated || output.source_truncated {
            return Err(GitHistoryError::OutputLimitExceeded);
        }
    }
    let changed = parse_changed_paths(&name_status.stdout, &numstat.stdout)?;

    let mut truncation_reasons = Vec::new();
    if commit.message_truncated {
        truncation_reasons.push(GitHistoryTruncationReason::MessageLimit);
    }
    if changed.path_limit_reached {
        truncation_reasons.push(GitHistoryTruncationReason::PathLimit);
    }

    let patch = if include_patch {
        let requested = max_patch_bytes as usize;
        let source_cap = requested.saturating_add(PATCH_CAPTURE_SLACK_BYTES);
        let output = run_history_command_with_budget(
            &prepared,
            root_fd,
            capability_id,
            request_id,
            operation_id,
            patch_args(&resolved_oid, path.as_ref()),
            GitCommandBudget {
                wall_timeout: Some(GIT_HISTORY_TIMEOUT),
                stdout_source_bytes: source_cap,
                stderr_source_bytes: HISTORY_STDERR_MAX_BYTES,
                preview_bytes: source_cap,
                overflow_policy: GitOverflowPolicy::Truncate,
            },
            spool,
            executions,
        )?;
        if output.exit_code != 0 && !output.source_truncated {
            return Err(GitHistoryError::GitReadFailed);
        }
        let patch_limited =
            output.source_truncated || output.stdout_truncated || output.stdout.len() > requested;
        if patch_limited {
            truncation_reasons.push(GitHistoryTruncationReason::PatchLimit);
        }
        Some(bounded_utf8_prefix(&output.stdout, requested)?)
    } else {
        None
    };

    Ok(GitCommitInspectResult {
        schema_version: 1,
        commit,
        changed_paths: changed.paths,
        summary: changed.summary,
        patch,
        truncated: !truncation_reasons.is_empty(),
        truncation_reasons,
    })
}

pub(crate) fn validate_revision(
    spec: GitRevisionSpec,
) -> Result<ValidatedRevision, GitHistoryError> {
    match spec {
        GitRevisionSpec::Head => Ok(ValidatedRevision::Head),
        GitRevisionSpec::Oid { oid } if valid_full_oid(&oid) => Ok(ValidatedRevision::Oid(oid)),
        GitRevisionSpec::Oid { .. } => Err(GitHistoryError::RevisionInvalid),
        GitRevisionSpec::Branch { name } if valid_local_ref_name(&name) => {
            Ok(ValidatedRevision::LocalBranch(name))
        }
        GitRevisionSpec::Branch { .. } => Err(GitHistoryError::RevisionInvalid),
        GitRevisionSpec::Tag { name } if valid_local_ref_name(&name) => {
            Ok(ValidatedRevision::LocalTag(name))
        }
        GitRevisionSpec::Tag { .. } => Err(GitHistoryError::RevisionInvalid),
    }
}

pub(crate) fn validate_history_path(
    path: Option<String>,
) -> Result<Option<ValidatedHistoryPath>, GitHistoryError> {
    let Some(path) = path else {
        return Ok(None);
    };

    let bytes = path.as_bytes();
    if path.is_empty()
        || bytes.len() > MAX_HISTORY_PATH_BYTES
        || path.starts_with('/')
        || path.starts_with(':')
        || bytes.iter().any(|byte| *byte <= 0x1f || *byte == 0x7f)
        || path
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
    {
        return Err(GitHistoryError::PathInvalid);
    }

    Ok(Some(ValidatedHistoryPath(path)))
}

fn valid_full_oid(oid: &str) -> bool {
    matches!(oid.len(), 40 | 64)
        && oid
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn valid_local_ref_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_REF_BYTES
        && !name.starts_with("refs/")
        && !name.contains("..")
        && !name.contains("@{")
        && name.split('/').all(valid_ref_component)
}

fn valid_ref_component(component: &str) -> bool {
    let bytes = component.as_bytes();
    !bytes.is_empty()
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && !component.ends_with(".lock")
        && !component.ends_with('.')
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};
    use std::os::fd::OwnedFd;
    use std::path::{Path, PathBuf};
    use std::process::Command as TestCommand;
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    use kodegpt_protocol::GitRevisionSpec;

    use crate::audit::AuditSink;
    use crate::execution::ExecutionRegistry;
    use crate::spool::RawSpoolStore;

    use super::{
        GitChangedPathStatus, GitHistoryError, GitHistoryTruncationReason, ValidatedHistoryPath,
        ValidatedRevision, commit_object_args, log_walk_args, name_status_args, numstat_args,
        parse_changed_paths, parse_commit_object, patch_args, prepare_history_git,
        read_commit_summary, resolve_revision, revision_probe_suffixes, run_git_log, run_git_show,
        validate_history_path, validate_revision,
    };

    fn temporary_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "kodegpt-git-history-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temporary root");
        root
    }

    fn git(root: &Path, args: &[&str]) -> String {
        let output = TestCommand::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .env_clear()
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("HOME", "/tmp")
            .output()
            .expect("test git available");
        assert!(
            output.status.success(),
            "test git command failed: {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .expect("git fixture output utf8")
            .trim()
            .to_owned()
    }

    fn commit_fixture(root: &Path) -> String {
        git(root, &["init", "-q"]);
        fs::write(root.join("tracked.txt"), "fixture\n").expect("fixture file");
        git(root, &["add", "tracked.txt"]);
        git(
            root,
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
        git(root, &["rev-parse", "HEAD"])
    }

    fn deterministic_commit(
        root: &Path,
        relative_path: &str,
        content: &str,
        message: &str,
        timestamp: i64,
    ) {
        let path = root.join(relative_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("fixture parent");
        }
        fs::write(&path, content).expect("fixture content");
        git(root, &["add", relative_path]);

        let raw_date = format!("{timestamp} +0000");
        let status = TestCommand::new("git")
            .arg("-C")
            .arg(root)
            .args([
                "-c",
                "user.name=KodeGPT Test",
                "-c",
                "user.email=kodegpt@example.invalid",
                "commit",
                "-q",
                "-m",
                message,
            ])
            .env_clear()
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("HOME", "/tmp")
            .env("GIT_AUTHOR_DATE", &raw_date)
            .env("GIT_COMMITTER_DATE", &raw_date)
            .status()
            .expect("deterministic commit");
        assert!(status.success(), "deterministic fixture commit failed");
    }

    fn deterministic_commit_with_message_file(
        root: &Path,
        relative_path: &str,
        content: &str,
        message: &str,
        timestamp: i64,
    ) -> String {
        let path = root.join(relative_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("fixture parent");
        }
        fs::write(&path, content).expect("fixture content");
        git(root, &["add", relative_path]);
        let message_path = root.join(".git/kodegpt-test-message.txt");
        fs::write(&message_path, message).expect("message fixture");
        let raw_date = format!("{timestamp} +0000");
        let status = TestCommand::new("git")
            .arg("-C")
            .arg(root)
            .args([
                "-c",
                "user.name=KodeGPT Test",
                "-c",
                "user.email=kodegpt@example.invalid",
                "commit",
                "-q",
                "-F",
                ".git/kodegpt-test-message.txt",
            ])
            .env_clear()
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("HOME", "/tmp")
            .env("GIT_AUTHOR_DATE", &raw_date)
            .env("GIT_COMMITTER_DATE", &raw_date)
            .status()
            .expect("deterministic commit with message file");
        assert!(status.success(), "deterministic fixture commit failed");
        fs::remove_file(message_path).expect("message fixture removed");
        git(root, &["rev-parse", "HEAD"])
    }

    #[test]
    fn preflight_and_revision_resolution_are_local_and_typed() {
        let plain = temporary_root("plain");
        let plain_state = temporary_root("plain-state");
        let plain_fd = OwnedFd::from(File::open(&plain).expect("plain root fd"));
        let plain_audit = Arc::new(AuditSink::open(&plain_state));
        let plain_spool = RawSpoolStore::open(&plain_state, plain_audit).expect("plain spool");
        let plain_executions = Mutex::new(ExecutionRegistry::default());
        assert!(matches!(
            prepare_history_git(
                &plain_fd,
                "kc_plain",
                "req_plain",
                "op_plain",
                &plain_spool,
                &plain_executions,
            ),
            Err(GitHistoryError::NotAGitRepository)
        ));

        let repo = temporary_root("resolver");
        let state = temporary_root("resolver-state");
        let head_oid = commit_fixture(&repo);
        git(&repo, &["branch", "feature-test"]);
        git(&repo, &["tag", "vtest"]);
        fs::write(repo.join("blob.bin"), b"blob fixture\n").expect("blob fixture");
        let blob_oid = git(&repo, &["hash-object", "-w", "blob.bin"]);

        let root_fd = OwnedFd::from(File::open(&repo).expect("repo root fd"));
        let audit = Arc::new(AuditSink::open(&state));
        let spool = RawSpoolStore::open(&state, audit).expect("spool store");
        let executions = Mutex::new(ExecutionRegistry::default());
        let prepared = prepare_history_git(
            &root_fd,
            "kc_resolver",
            "req_resolver",
            "op_resolver",
            &spool,
            &executions,
        )
        .expect("git repository preflight");

        for revision in [
            ValidatedRevision::Head,
            ValidatedRevision::LocalBranch("feature-test".into()),
            ValidatedRevision::LocalTag("vtest".into()),
        ] {
            assert_eq!(
                resolve_revision(
                    &prepared,
                    &root_fd,
                    "kc_resolver",
                    "req_resolver",
                    "op_resolver",
                    revision,
                    &spool,
                    &executions,
                ),
                Ok(head_oid.clone())
            );
        }

        assert!(matches!(
            resolve_revision(
                &prepared,
                &root_fd,
                "kc_resolver",
                "req_missing",
                "op_missing",
                ValidatedRevision::Oid("0".repeat(40)),
                &spool,
                &executions,
            ),
            Err(GitHistoryError::RevisionNotFound)
        ));
        assert!(matches!(
            resolve_revision(
                &prepared,
                &root_fd,
                "kc_resolver",
                "req_blob",
                "op_blob",
                ValidatedRevision::Oid(blob_oid),
                &spool,
                &executions,
            ),
            Err(GitHistoryError::ObjectTypeUnsupported)
        ));

        let (object_probe, commit_probe) = revision_probe_suffixes("refs/heads/feature-test");
        assert_eq!(
            object_probe,
            vec![
                "rev-parse",
                "--verify",
                "--end-of-options",
                "refs/heads/feature-test^{object}",
            ]
        );
        assert_eq!(
            commit_probe,
            vec![
                "rev-parse",
                "--verify",
                "--end-of-options",
                "refs/heads/feature-test^{commit}",
            ]
        );
        assert_eq!(
            validate_revision(GitRevisionSpec::Branch {
                name: "HEAD~2".into()
            }),
            Err(GitHistoryError::RevisionInvalid)
        );
        assert!(
            executions
                .lock()
                .expect("registry")
                .ids_for_workspace("kc_resolver")
                .is_empty()
        );

        fs::remove_dir_all(plain).expect("plain cleanup");
        fs::remove_dir_all(plain_state).expect("plain state cleanup");
        fs::remove_dir_all(repo).expect("repo cleanup");
        fs::remove_dir_all(state).expect("state cleanup");
    }

    fn commit_object_fixture(
        parents: &[String],
        author_name: &[u8],
        author_time: &str,
        committer_time: &str,
        message: &[u8],
    ) -> Vec<u8> {
        let mut raw = Vec::new();
        raw.extend_from_slice(format!("tree {}\n", "1".repeat(40)).as_bytes());
        for parent in parents {
            raw.extend_from_slice(format!("parent {parent}\n").as_bytes());
        }
        raw.extend_from_slice(b"author ");
        raw.extend_from_slice(author_name);
        raw.extend_from_slice(
            format!(" <author@example.invalid> {author_time} +0000\n").as_bytes(),
        );
        raw.extend_from_slice(
            format!("committer Committer <committer@example.invalid> {committer_time} +0000\n\n")
                .as_bytes(),
        );
        raw.extend_from_slice(message);
        raw
    }

    #[test]
    fn show_bounds_message_patch_and_uses_fixed_commands() {
        let repo = temporary_root("show-bounds");
        let state = temporary_root("show-bounds-state");
        git(&repo, &["init", "-q"]);
        deterministic_commit(&repo, "large.txt", "base\n", "base", 1_700_001_000);

        let large_content = (0..4_000)
            .map(|index| format!("line-{index:04}-{}\n", "x".repeat(90)))
            .collect::<String>();
        let large_body = "b".repeat(20 * 1024 + 777);
        let message = format!("show subject\n\n{large_body}\n");
        let oid = deterministic_commit_with_message_file(
            &repo,
            "large.txt",
            &large_content,
            &message,
            1_700_001_001,
        );

        let root_fd = OwnedFd::from(File::open(&repo).expect("repo root fd"));
        let audit = Arc::new(AuditSink::open(&state));
        let spool = RawSpoolStore::open(&state, audit).expect("spool store");
        let executions = Mutex::new(ExecutionRegistry::default());

        let result = run_git_show(
            &root_fd,
            "kc_show_bounds",
            "req_show_bounds",
            "op_show_bounds",
            ValidatedRevision::Head,
            None,
            true,
            65_536,
            &spool,
            &executions,
        )
        .expect("bounded show");
        assert_eq!(result.commit.oid, oid);
        assert_eq!(result.commit.subject, "show subject");
        assert_eq!(result.commit.body.as_bytes().len(), 16 * 1024);
        assert!(result.commit.message_truncated);
        assert_eq!(result.changed_paths.len(), 1);
        assert_eq!(result.changed_paths[0].path, "large.txt");
        let patch = result.patch.as_deref().expect("patch included");
        assert!(patch.as_bytes().len() <= 65_536);
        assert!(result.truncated);
        assert!(
            result
                .truncation_reasons
                .contains(&GitHistoryTruncationReason::MessageLimit)
        );
        assert!(
            result
                .truncation_reasons
                .contains(&GitHistoryTruncationReason::PatchLimit)
        );

        let no_patch = run_git_show(
            &root_fd,
            "kc_show_bounds",
            "req_show_no_patch",
            "op_show_no_patch",
            ValidatedRevision::Head,
            None,
            false,
            65_536,
            &spool,
            &executions,
        )
        .expect("show without patch");
        assert_eq!(no_patch.patch, None);
        assert!(
            !no_patch
                .truncation_reasons
                .contains(&GitHistoryTruncationReason::PatchLimit)
        );

        assert_eq!(
            name_status_args(&oid, None),
            vec![
                "--literal-pathspecs",
                "diff-tree",
                "--root",
                "--no-commit-id",
                "-r",
                "--name-status",
                "-z",
                "--no-renames",
                oid.as_str(),
            ]
        );
        assert_eq!(
            numstat_args(&oid, None),
            vec![
                "--literal-pathspecs",
                "diff-tree",
                "--root",
                "--no-commit-id",
                "-r",
                "--numstat",
                "-z",
                "--no-renames",
                oid.as_str(),
            ]
        );
        let patch_command = patch_args(&oid, None);
        assert_eq!(
            patch_command,
            vec![
                "--literal-pathspecs",
                "show",
                "--format=",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "--ignore-submodules=all",
                oid.as_str(),
            ]
        );
        assert!(!patch_command.iter().any(|arg| arg == "--binary"));
        assert!(
            executions
                .lock()
                .expect("registry")
                .ids_for_workspace("kc_show_bounds")
                .is_empty()
        );

        fs::remove_dir_all(repo).expect("repo cleanup");
        fs::remove_dir_all(state).expect("state cleanup");
    }

    #[test]
    fn show_changed_path_parser_is_bounded_binary_aware_and_path_safe() {
        let name_status = b"A\0added.txt\0M\0modified.txt\0D\0deleted.txt\0T\0type.txt\0D\0old-name.txt\0A\0new-name.txt\0A\0binary.bin\0";
        let numstat = [
            b"2\t0\tadded.txt\0".as_slice(),
            b"3\t1\tmodified.txt\0".as_slice(),
            b"0\t4\tdeleted.txt\0".as_slice(),
            b"0\t0\ttype.txt\0".as_slice(),
            b"0\t1\told-name.txt\0".as_slice(),
            b"1\t0\tnew-name.txt\0".as_slice(),
            b"-\t-\tbinary.bin\0".as_slice(),
        ]
        .concat();
        let parsed = parse_changed_paths(name_status, &numstat).expect("valid changed paths");
        assert!(!parsed.path_limit_reached);
        assert_eq!(parsed.paths.len(), 7);
        assert_eq!(parsed.paths[0].status, GitChangedPathStatus::Added);
        assert_eq!(parsed.paths[1].status, GitChangedPathStatus::Modified);
        assert_eq!(parsed.paths[2].status, GitChangedPathStatus::Deleted);
        assert_eq!(parsed.paths[3].status, GitChangedPathStatus::TypeChanged);
        assert_eq!(parsed.paths[4].status, GitChangedPathStatus::Deleted);
        assert_eq!(parsed.paths[5].status, GitChangedPathStatus::Added);
        assert_eq!(parsed.paths[6].path, "binary.bin");
        assert!(parsed.paths[6].binary);
        assert_eq!(parsed.paths[6].insertions, None);
        assert_eq!(parsed.paths[6].deletions, None);
        assert_eq!(parsed.paths[1].insertions, Some(3));
        assert_eq!(parsed.paths[1].deletions, Some(1));

        let mut many_status = Vec::new();
        let mut many_numstat = Vec::new();
        for index in 0..501 {
            let path = format!("src/{index:03}.txt");
            many_status.extend_from_slice(b"A\0");
            many_status.extend_from_slice(path.as_bytes());
            many_status.push(0);
            many_numstat.extend_from_slice(b"1\t0\t");
            many_numstat.extend_from_slice(path.as_bytes());
            many_numstat.push(0);
        }
        let many = parse_changed_paths(&many_status, &many_numstat).expect("bounded paths");
        assert_eq!(many.paths.len(), 500);
        assert_eq!(many.paths.first().expect("first path").path, "src/000.txt");
        assert_eq!(many.paths.last().expect("last path").path, "src/499.txt");
        assert!(many.path_limit_reached);

        for hostile in ["/etc/passwd", "../x", "src/../x"] {
            let mut status = b"M\0".to_vec();
            status.extend_from_slice(hostile.as_bytes());
            status.push(0);
            let mut stats = b"1\t1\t".to_vec();
            stats.extend_from_slice(hostile.as_bytes());
            stats.push(0);
            assert_eq!(
                parse_changed_paths(&status, &stats),
                Err(GitHistoryError::GitReadFailed)
            );
        }
    }

    #[test]
    fn bounded_log_walk_uses_limit_sentinel_and_literal_path_filter() {
        let repo = temporary_root("log-walk");
        let state = temporary_root("log-walk-state");
        git(&repo, &["init", "-q"]);
        deterministic_commit(&repo, "src/a.rs", "a1\n", "commit-1", 1_700_000_001);
        deterministic_commit(&repo, "src/b.rs", "b2\n", "commit-2", 1_700_000_002);
        deterministic_commit(&repo, "src/b.rs", "b3\n", "commit-3", 1_700_000_003);
        deterministic_commit(&repo, "src/a.rs", "a4\n", "commit-4", 1_700_000_004);
        deterministic_commit(&repo, "src/b.rs", "b5\n", "commit-5", 1_700_000_005);
        deterministic_commit(&repo, "src/b.rs", "b6\n", "commit-6", 1_700_000_006);

        let root_fd = OwnedFd::from(File::open(&repo).expect("repo root fd"));
        let audit = Arc::new(AuditSink::open(&state));
        let spool = RawSpoolStore::open(&state, audit).expect("spool store");
        let executions = Mutex::new(ExecutionRegistry::default());

        let limited = run_git_log(
            &root_fd,
            "kc_log_walk",
            "req_log_five",
            "op_log_five",
            ValidatedRevision::Head,
            None,
            5,
            &spool,
            &executions,
        )
        .expect("bounded log five");
        assert_eq!(limited.commits.len(), 5);
        assert_eq!(limited.returned_count, 5);
        assert!(limited.truncated);
        assert_eq!(
            limited.truncation_reasons,
            vec![GitHistoryTruncationReason::CommitLimit]
        );

        let complete = run_git_log(
            &root_fd,
            "kc_log_walk",
            "req_log_six",
            "op_log_six",
            ValidatedRevision::Head,
            None,
            6,
            &spool,
            &executions,
        )
        .expect("bounded log six");
        assert_eq!(complete.commits.len(), 6);
        assert_eq!(complete.returned_count, 6);
        assert!(!complete.truncated);
        assert!(complete.truncation_reasons.is_empty());

        let path = ValidatedHistoryPath("src/a.rs".into());
        let path_filtered = run_git_log(
            &root_fd,
            "kc_log_walk",
            "req_log_path",
            "op_log_path",
            ValidatedRevision::Head,
            Some(path.clone()),
            6,
            &spool,
            &executions,
        )
        .expect("path filtered log");
        assert_eq!(path_filtered.commits.len(), 2);
        assert_eq!(
            path_filtered
                .commits
                .iter()
                .map(|commit| commit.subject.as_str())
                .collect::<Vec<_>>(),
            vec!["commit-4", "commit-1"]
        );
        assert!(!path_filtered.truncated);

        let resolved = "f".repeat(40);
        assert_eq!(
            log_walk_args(&resolved, Some(&path), 5),
            vec![
                "--literal-pathspecs",
                "rev-list",
                "--topo-order",
                "--max-count=6",
                resolved.as_str(),
                "--",
                "src/a.rs",
            ]
        );
        assert!(
            executions
                .lock()
                .expect("registry")
                .ids_for_workspace("kc_log_walk")
                .is_empty()
        );

        fs::remove_dir_all(repo).expect("repo cleanup");
        fs::remove_dir_all(state).expect("state cleanup");
    }

    #[test]
    fn bounded_commit_read_uses_fixed_cat_file_command() {
        let repo = temporary_root("commit-read");
        let state = temporary_root("commit-read-state");
        let oid = commit_fixture(&repo);
        let root_fd = OwnedFd::from(File::open(&repo).expect("repo root fd"));
        let audit = Arc::new(AuditSink::open(&state));
        let spool = RawSpoolStore::open(&state, audit).expect("spool store");
        let executions = Mutex::new(ExecutionRegistry::default());
        let prepared = prepare_history_git(
            &root_fd,
            "kc_commit_read",
            "req_commit_read",
            "op_commit_read",
            &spool,
            &executions,
        )
        .expect("history git prepared");

        assert_eq!(
            commit_object_args(&oid),
            vec!["cat-file", "commit", oid.as_str()]
        );
        let summary = read_commit_summary(
            &prepared,
            &root_fd,
            "kc_commit_read",
            "req_commit_read",
            "op_commit_read",
            &oid,
            &spool,
            &executions,
        )
        .expect("commit summary");
        assert_eq!(summary.oid, oid);
        assert_eq!(summary.subject, "fixture");
        assert!(
            executions
                .lock()
                .expect("registry")
                .ids_for_workspace("kc_commit_read")
                .is_empty()
        );

        fs::remove_dir_all(repo).expect("repo cleanup");
        fs::remove_dir_all(state).expect("state cleanup");
    }

    #[test]
    fn commit_object_parser_preserves_bounded_metadata_and_parent_order() {
        let oid = "f".repeat(40);
        let parent_a = "a".repeat(40);
        let parent_b = "b".repeat(40);

        for parents in [
            vec![],
            vec![parent_a.clone()],
            vec![parent_a.clone(), parent_b.clone()],
        ] {
            let raw = commit_object_fixture(
                &parents,
                b"KodeGPT Author",
                "1700000000",
                "1700000100",
                b"subject line\nbody must not appear in summary\n",
            );
            let summary = parse_commit_object(&oid, &raw).expect("valid commit object");

            assert_eq!(summary.oid, oid);
            assert_eq!(summary.short_oid, "ffffffffffff");
            assert_eq!(summary.parents, parents);
            assert_eq!(summary.author_name, "KodeGPT Author");
            assert_eq!(summary.author_time, 1_700_000_000);
            assert_eq!(summary.committer_time, 1_700_000_100);
            assert_eq!(summary.subject, "subject line");
            assert!(!summary.subject.contains("body must not appear"));
            assert!(!summary.encoding_lossy);
        }

        let long_subject = format!("{}\nbody", "é".repeat(300));
        let long_author = "a".repeat(300);
        let raw = commit_object_fixture(
            &[],
            long_author.as_bytes(),
            "1700000000",
            "1700000100",
            long_subject.as_bytes(),
        );
        let summary = parse_commit_object(&oid, &raw).expect("bounded text fields");
        assert_eq!(summary.author_name.as_bytes().len(), 256);
        assert_eq!(summary.subject.as_bytes().len(), 512);
        assert_eq!(summary.subject, "é".repeat(256));
        assert!(!summary.encoding_lossy);
    }

    #[test]
    fn commit_object_parser_is_strict_about_headers_oids_and_timestamps() {
        let oid = "f".repeat(40);
        let valid = commit_object_fixture(&[], b"Author", "1700000000", "1700000100", b"subject\n");

        for invalid_oid in ["f".repeat(39), "F".repeat(40)] {
            assert_eq!(
                parse_commit_object(&invalid_oid, &valid),
                Err(GitHistoryError::GitReadFailed)
            );
        }

        for invalid_parent in ["a".repeat(39), "A".repeat(40)] {
            let raw = commit_object_fixture(
                &[invalid_parent],
                b"Author",
                "1700000000",
                "1700000100",
                b"subject\n",
            );
            assert_eq!(
                parse_commit_object(&oid, &raw),
                Err(GitHistoryError::GitReadFailed)
            );
        }

        let missing_author = valid
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.starts_with(b"author "))
            .fold(Vec::new(), |mut rebuilt, line| {
                rebuilt.extend_from_slice(line);
                rebuilt.push(b'\n');
                rebuilt
            });
        assert_eq!(
            parse_commit_object(&oid, &missing_author),
            Err(GitHistoryError::GitReadFailed)
        );

        let invalid_committer = commit_object_fixture(
            &[],
            b"Author",
            "1700000000",
            "not-a-timestamp",
            b"subject\n",
        );
        assert_eq!(
            parse_commit_object(&oid, &invalid_committer),
            Err(GitHistoryError::GitReadFailed)
        );

        let missing_separator = vec![b'x'; 64 * 1024 + 1];
        assert_eq!(
            parse_commit_object(&oid, &missing_separator),
            Err(GitHistoryError::OutputLimitExceeded)
        );
    }

    #[test]
    fn commit_object_parser_handles_invalid_utf8_deterministically() {
        let oid = "f".repeat(40);
        let raw = commit_object_fixture(
            &[],
            b"Author\xffName",
            "1700000000",
            "1700000100",
            b"subject\xffline\nbody\n",
        );

        let first = parse_commit_object(&oid, &raw).expect("lossy commit object");
        let second = parse_commit_object(&oid, &raw).expect("lossy commit object repeat");
        assert_eq!(first, second);
        assert!(first.encoding_lossy);
        assert!(first.author_name.contains('\u{fffd}'));
        assert!(first.subject.contains('\u{fffd}'));
    }

    #[test]
    fn revision_and_path_grammar_is_closed() {
        let accepted_revisions = [
            (GitRevisionSpec::Head, ValidatedRevision::Head),
            (
                GitRevisionSpec::Oid {
                    oid: "0123456789abcdef0123456789abcdef01234567".into(),
                },
                ValidatedRevision::Oid("0123456789abcdef0123456789abcdef01234567".into()),
            ),
            (
                GitRevisionSpec::Oid {
                    oid: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
                },
                ValidatedRevision::Oid(
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
                ),
            ),
            (
                GitRevisionSpec::Branch {
                    name: "feat/history-v1".into(),
                },
                ValidatedRevision::LocalBranch("feat/history-v1".into()),
            ),
            (
                GitRevisionSpec::Tag {
                    name: "v0.1".into(),
                },
                ValidatedRevision::LocalTag("v0.1".into()),
            ),
        ];

        for (input, expected) in accepted_revisions {
            assert_eq!(validate_revision(input), Ok(expected));
        }

        let rejected_revisions = [
            GitRevisionSpec::Branch {
                name: "--all".into(),
            },
            GitRevisionSpec::Branch {
                name: "--glob=refs/*".into(),
            },
            GitRevisionSpec::Branch {
                name: "HEAD~3".into(),
            },
            GitRevisionSpec::Branch {
                name: "HEAD^".into(),
            },
            GitRevisionSpec::Branch {
                name: "HEAD@{1}".into(),
            },
            GitRevisionSpec::Branch {
                name: ":/fix".into(),
            },
            GitRevisionSpec::Oid {
                oid: "0123456".into(),
            },
            GitRevisionSpec::Oid {
                oid: "ABCDEF0123456789ABCDEF0123456789ABCDEF01".into(),
            },
            GitRevisionSpec::Branch {
                name: "refs/heads/main".into(),
            },
            GitRevisionSpec::Branch {
                name: "feat//x".into(),
            },
            GitRevisionSpec::Branch {
                name: "feat/../x".into(),
            },
            GitRevisionSpec::Branch {
                name: "feat/.hidden".into(),
            },
            GitRevisionSpec::Branch {
                name: "feat/x.lock".into(),
            },
            GitRevisionSpec::Branch {
                name: "feat/x.".into(),
            },
            GitRevisionSpec::Branch {
                name: "foo@{bar".into(),
            },
        ];

        for input in rejected_revisions {
            assert_eq!(
                validate_revision(input),
                Err(GitHistoryError::RevisionInvalid)
            );
        }

        for path in ["src/main.rs", "docs/a b.md", "src/日本語.rs"] {
            let validated = validate_history_path(Some(path.into()))
                .expect("valid history path")
                .expect("present history path");
            assert_eq!(validated, ValidatedHistoryPath(path.into()));
        }
        assert_eq!(validate_history_path(None), Ok(None));

        let oversized = format!("src/{}", "é".repeat(2049));
        for path in [
            "/etc/passwd".to_owned(),
            ".".to_owned(),
            "..".to_owned(),
            "src/../secret".to_owned(),
            "src//file".to_owned(),
            ":!secret".to_owned(),
            "src/line\nbreak".to_owned(),
            "src/\0file".to_owned(),
            oversized,
        ] {
            assert_eq!(
                validate_history_path(Some(path)),
                Err(GitHistoryError::PathInvalid)
            );
        }
    }
}
