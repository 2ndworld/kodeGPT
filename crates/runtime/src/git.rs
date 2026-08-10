use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fmt;
use std::io::Read;
use std::os::fd::OwnedFd;
use std::path::Path;
use std::sync::{mpsc, Mutex};
use std::thread;

use kodegpt_sandbox::{
    resolve_trusted_executable, BubblewrapProvider, SandboxError, SandboxLaunchSpec,
    SandboxNetworkMode, WorkspaceAccess,
};
use kodegpt_workspace_io::{read_file_beneath, WorkspaceReadError, INLINE_READ_MAX_BYTES};
use serde::Serialize;

use crate::execution::{ExecutionKind, ExecutionRegistry};
use crate::spool::{RawSpoolError, RawSpoolMetadata, RawSpoolStore, RawSpoolWriter};

const GIT_PREVIEW_MAX_BYTES: usize = 64 * 1024;
const CAPTURE_CHUNK_BYTES: usize = 16 * 1024;
const CHILD_GIT_DIR: &str = "/workspace/.git";
const CHILD_WORK_TREE: &str = "/workspace";

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
    pub artifact: RawSpoolMetadata,
}

#[derive(Debug)]
pub enum GitInspectionError {
    Sandbox(SandboxError),
    Spool(RawSpoolError),
    ConfigRead(WorkspaceReadError),
    UnsafeRepositoryConfig,
    RegistryUnavailable,
    CaptureFailed,
    WaitFailed(std::io::Error),
}

impl fmt::Display for GitInspectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sandbox(error) => write!(formatter, "Git sandbox failed: {error}"),
            Self::Spool(error) => write!(formatter, "Git spool failed: {error}"),
            Self::ConfigRead(error) => {
                write!(formatter, "Git repository config read failed: {error}")
            }
            Self::UnsafeRepositoryConfig => {
                formatter.write_str("Git repository config is unsafe for inspection")
            }
            Self::RegistryUnavailable => formatter.write_str("Git execution registry unavailable"),
            Self::CaptureFailed => formatter.write_str("Git output capture failed"),
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
    let filter_drivers = repository_filter_drivers(workspace_root)?;
    let mut spec = SandboxLaunchSpec::new(program);
    spec.args = hardened_git_args(operation, &filter_drivers);
    spec.env = BTreeMap::from([
        ("GIT_DIR".to_owned(), CHILD_GIT_DIR.to_owned()),
        ("GIT_WORK_TREE".to_owned(), CHILD_WORK_TREE.to_owned()),
        ("GIT_OPTIONAL_LOCKS".to_owned(), "0".to_owned()),
        ("GIT_CONFIG_NOSYSTEM".to_owned(), "1".to_owned()),
        ("GIT_CONFIG_GLOBAL".to_owned(), "/dev/null".to_owned()),
        ("GIT_PAGER".to_owned(), "cat".to_owned()),
        ("GIT_TERMINAL_PROMPT".to_owned(), "0".to_owned()),
        ("GIT_ATTR_NOSYSTEM".to_owned(), "1".to_owned()),
        ("LC_ALL".to_owned(), "C".to_owned()),
    ]);
    spec.network = SandboxNetworkMode::Deny;
    spec.workspace_access = WorkspaceAccess::ReadOnly;

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

    Ok(GitInspectionResult {
        schema_version: 1,
        exit_code: status.exit_code,
        stdout_preview: String::from_utf8_lossy(&status.stdout_preview).into_owned(),
        stderr_preview: String::from_utf8_lossy(&status.stderr_preview).into_owned(),
        stdout_truncated: status.stdout_truncated,
        stderr_truncated: status.stderr_truncated,
        artifact,
    })
}

fn repository_filter_drivers(root_fd: &OwnedFd) -> Result<Vec<String>, GitInspectionError> {
    let config = read_file_beneath(
        root_fd,
        Path::new(".git/config"),
        0,
        INLINE_READ_MAX_BYTES,
    )
    .map_err(GitInspectionError::ConfigRead)?;
    if !config.eof {
        return Err(GitInspectionError::UnsafeRepositoryConfig);
    }
    parse_filter_drivers(&config.contents)
}

fn parse_filter_drivers(config: &str) -> Result<Vec<String>, GitInspectionError> {
    let mut drivers = BTreeSet::new();
    let mut current_section = String::new();

    for raw_line in config.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }

        if line.starts_with('[') {
            let Some(end) = line.find(']') else {
                return Err(GitInspectionError::UnsafeRepositoryConfig);
            };
            let section = line[1..end].trim();
            let lower = section.to_ascii_lowercase();
            if lower == "include"
                || lower.starts_with("includeif ")
                || lower.starts_with("includeif\t")
            {
                return Err(GitInspectionError::UnsafeRepositoryConfig);
            }
            current_section = lower.clone();

            let driver = if lower.starts_with("filter ") || lower.starts_with("filter\t") {
                let rest = section[6..].trim();
                if rest.len() < 2 || !rest.starts_with('"') || !rest.ends_with('"') {
                    return Err(GitInspectionError::UnsafeRepositoryConfig);
                }
                Some(&rest[1..rest.len() - 1])
            } else if lower.starts_with("filter.") {
                Some(&section[7..])
            } else {
                None
            };

            if let Some(driver) = driver {
                if driver.is_empty()
                    || driver.len() > 128
                    || !driver.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
                    })
                {
                    return Err(GitInspectionError::UnsafeRepositoryConfig);
                }
                drivers.insert(driver.to_owned());
            }
            continue;
        }

        let key = line
            .split_once('=')
            .map(|(key, _)| key.trim())
            .unwrap_or_else(|| line.split_ascii_whitespace().next().unwrap_or_default());
        if (current_section == "core" && key.eq_ignore_ascii_case("worktree"))
            || (current_section == "extensions" && key.eq_ignore_ascii_case("worktreeconfig"))
        {
            return Err(GitInspectionError::UnsafeRepositoryConfig);
        }
    }
    Ok(drivers.into_iter().collect())
}

fn hardened_git_args(operation: GitOperation, filter_drivers: &[String]) -> Vec<OsString> {
    let mut args = [
        "--git-dir=/workspace/.git",
        "--work-tree=/workspace",
        "--no-optional-locks",
        "-c",
        "core.bare=false",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.attributesFile=/dev/null",
        "-c",
        "core.excludesFile=/dev/null",
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
    .collect::<Vec<_>>();

    for driver in filter_drivers {
        for key in ["clean", "smudge", "process"] {
            args.push(OsString::from("-c"));
            args.push(OsString::from(format!("filter.{driver}.{key}=")));
        }
        args.push(OsString::from("-c"));
        args.push(OsString::from(format!("filter.{driver}.required=false")));
    }

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
                ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all"]
                    .into_iter()
                    .map(OsString::from),
            );
        }
    }
    args
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
    writer: &mut RawSpoolWriter,
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
                let marker = match kind {
                    StreamKind::Stdout => b"[stdout]".as_slice(),
                    StreamKind::Stderr => b"[stderr]".as_slice(),
                };
                writer.write_source(marker)?;
                writer.write_source(&(bytes.len() as u32).to_be_bytes())?;
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
    let remaining = GIT_PREVIEW_MAX_BYTES.saturating_sub(target.len());
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

    use super::{parse_filter_drivers, run_git_inspection, GitInspectionError, GitOperation};

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
    fn repository_filter_config_is_neutralized_and_unsafe_indirection_fails_closed() {
        assert_eq!(
            parse_filter_drivers(
                "[filter \"zeta-1\"]\n clean = ./evil\n[filter.alpha]\n process = ./evil\n"
            )
            .expect("safe filter sections parsed"),
            vec!["alpha".to_owned(), "zeta-1".to_owned()]
        );
        for unsafe_config in [
            "[include]\n path = ./evil.cfg\n",
            "[includeIf \"gitdir:./\"]\n path = ./evil.cfg\n",
            "[core]\n worktree = /etc\n",
            "[extensions]\n worktreeConfig = true\n",
        ] {
            assert!(matches!(
                parse_filter_drivers(unsafe_config),
                Err(GitInspectionError::UnsafeRepositoryConfig)
            ));
        }
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
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o755))
            .expect("helper executable");
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
        fs::write(workspace.join("tracked.txt"), "after\n")
            .expect("working tree modification");
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
