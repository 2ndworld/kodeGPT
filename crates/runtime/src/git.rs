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
use serde::Serialize;

use crate::execution::{ExecutionKind, ExecutionRegistry};
use crate::spool::{RawSpoolError, RawSpoolMetadata, RawSpoolStore};

const PREVIEW_MAX_BYTES: usize = 64 * 1024;
const CAPTURE_CHUNK_BYTES: usize = 16 * 1024;

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

#[derive(Debug)]
pub enum GitInspectionError {
    Sandbox(SandboxError),
    Spool(RawSpoolError),
    RegistryUnavailable,
    CaptureFailed,
    UnsafeRepositoryConfig,
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

    let capture = capture_child(&mut child, &mut writer);
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
                    StreamKind::Stdout => {
                        append_preview(&mut stdout_preview, &mut stdout_truncated, &bytes)
                    }
                    StreamKind::Stderr => {
                        append_preview(&mut stderr_preview, &mut stderr_truncated, &bytes)
                    }
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

fn append_preview(target: &mut Vec<u8>, truncated: &mut bool, source: &[u8]) {
    let remaining = PREVIEW_MAX_BYTES.saturating_sub(target.len());
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

    use super::{GitOperation, run_git_inspection};

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
