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

fn commit_object_args(oid: &str) -> Vec<String> {
    vec!["cat-file".to_owned(), "commit".to_owned(), oid.to_owned()]
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
    parse_commit_object(oid, &output.stdout)
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
    run_hardened_git_command(
        &prepared.provider,
        &prepared.program,
        root_fd,
        capability_id,
        request_id,
        operation_id,
        history_command_args(prepared, suffix),
        strict_history_budget(stdout_source_bytes),
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
        GitHistoryError, GitHistoryTruncationReason, ValidatedHistoryPath, ValidatedRevision,
        commit_object_args, log_walk_args, parse_commit_object, prepare_history_git,
        read_commit_summary, resolve_revision, revision_probe_suffixes, run_git_log,
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
