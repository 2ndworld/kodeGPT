use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::fmt;
use std::io::Read;
use std::os::fd::OwnedFd;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::Duration;

use kodegpt_protocol::{NetworkMode, ProfileName, RuntimePolicy};
use kodegpt_sandbox::{
    BubblewrapProvider, SandboxError, SandboxLaunchSpec, SandboxNetworkMode, WorkspaceAccess,
    resolve_trusted_executable,
};
use kodegpt_workspace_io::open_directory_beneath;
use serde::Serialize;

use crate::execution::{ExecutionKind, ExecutionRegistry};
use crate::spool::{RawSpoolError, RawSpoolMetadata, RawSpoolStore, RawSpoolWriter};

const PREVIEW_MAX_BYTES: usize = 64 * 1024;
const CAPTURE_CHUNK_BYTES: usize = 16 * 1024;
const CANCEL_GRACE_STEPS: usize = 50;
const CANCEL_GRACE_STEP: Duration = Duration::from_millis(20);

static NEXT_OPERATION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcessState {
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessOperationView {
    pub schema_version: u32,
    pub operation_id: String,
    pub state: ProcessState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub stdout_preview: String,
    pub stderr_preview: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub source_truncated: bool,
    pub bytes_spooled: u64,
    pub artifact: RawSpoolMetadata,
}

#[derive(Debug, Clone)]
struct ProcessOperationRecord {
    operation_id: String,
    workspace_capability: String,
    execution_id: String,
    process_group: i32,
    state: ProcessState,
    exit_code: Option<i32>,
    stdout_preview: String,
    stderr_preview: String,
    stdout_truncated: bool,
    stderr_truncated: bool,
    source_truncated: bool,
    bytes_spooled: u64,
    artifact: RawSpoolMetadata,
    cancel_requested: bool,
}

impl ProcessOperationRecord {
    fn view(&self) -> ProcessOperationView {
        ProcessOperationView {
            schema_version: 1,
            operation_id: self.operation_id.clone(),
            state: self.state.clone(),
            exit_code: self.exit_code,
            stdout_preview: self.stdout_preview.clone(),
            stderr_preview: self.stderr_preview.clone(),
            stdout_truncated: self.stdout_truncated,
            stderr_truncated: self.stderr_truncated,
            source_truncated: self.source_truncated,
            bytes_spooled: self.bytes_spooled,
            artifact: self.artifact.clone(),
        }
    }
}

#[derive(Debug, Default)]
pub struct ProcessOperationRegistry {
    records: Mutex<HashMap<String, ProcessOperationRecord>>,
}

impl ProcessOperationRegistry {
    pub fn status(
        &self,
        workspace_capability: &str,
        operation_id: &str,
    ) -> Result<ProcessOperationView, ProcessError> {
        let records = self
            .records
            .lock()
            .map_err(|_| ProcessError::RegistryUnavailable)?;
        let record = records
            .get(operation_id)
            .ok_or(ProcessError::OperationNotFound)?;
        if record.workspace_capability != workspace_capability {
            return Err(ProcessError::OperationNotFound);
        }
        Ok(record.view())
    }

    pub fn cancel(
        &self,
        workspace_capability: &str,
        operation_id: &str,
    ) -> Result<ProcessOperationView, ProcessError> {
        let process_group = {
            let mut records = self
                .records
                .lock()
                .map_err(|_| ProcessError::RegistryUnavailable)?;
            let record = records
                .get_mut(operation_id)
                .ok_or(ProcessError::OperationNotFound)?;
            if record.workspace_capability != workspace_capability {
                return Err(ProcessError::OperationNotFound);
            }
            if record.state != ProcessState::Running {
                return Ok(record.view());
            }
            record.cancel_requested = true;
            record.process_group
        };

        kill_process_group(process_group, libc::SIGTERM)?;
        for _ in 0..CANCEL_GRACE_STEPS {
            thread::sleep(CANCEL_GRACE_STEP);
            let status = self.status(workspace_capability, operation_id)?;
            if status.state != ProcessState::Running {
                return Ok(status);
            }
        }
        kill_process_group(process_group, libc::SIGKILL)?;
        for _ in 0..CANCEL_GRACE_STEPS {
            thread::sleep(CANCEL_GRACE_STEP);
            let status = self.status(workspace_capability, operation_id)?;
            if status.state != ProcessState::Running {
                return Ok(status);
            }
        }
        self.status(workspace_capability, operation_id)
    }

    pub fn cancel_workspace(&self, workspace_capability: &str) -> Result<(), ProcessError> {
        let operation_ids = self
            .records
            .lock()
            .map_err(|_| ProcessError::RegistryUnavailable)?
            .values()
            .filter(|record| {
                record.workspace_capability == workspace_capability
                    && record.state == ProcessState::Running
            })
            .map(|record| record.operation_id.clone())
            .collect::<Vec<_>>();
        for operation_id in operation_ids {
            self.cancel(workspace_capability, &operation_id)?;
        }
        Ok(())
    }
}

#[derive(Debug)]
pub enum ProcessError {
    PolicyDenied,
    ExecutableDenied,
    EnvironmentDenied,
    InvalidCwd,
    OperationNotFound,
    RegistryUnavailable,
    CaptureFailed,
    CancellationFailed(std::io::Error),
    Sandbox(SandboxError),
    Spool(RawSpoolError),
    WaitFailed(std::io::Error),
}

impl fmt::Display for ProcessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PolicyDenied => formatter.write_str("process execution is denied by policy"),
            Self::ExecutableDenied => formatter.write_str("logical executable is denied by policy"),
            Self::EnvironmentDenied => {
                formatter.write_str("process environment is denied by policy")
            }
            Self::InvalidCwd => {
                formatter.write_str("process cwd is outside the retained workspace root")
            }
            Self::OperationNotFound => formatter.write_str("process operation was not found"),
            Self::RegistryUnavailable => formatter.write_str("process registry is unavailable"),
            Self::CaptureFailed => formatter.write_str("process output capture failed"),
            Self::CancellationFailed(error) => {
                write!(formatter, "process cancellation failed: {error}")
            }
            Self::Sandbox(error) => write!(formatter, "process sandbox failed: {error}"),
            Self::Spool(error) => write!(formatter, "process spool failed: {error}"),
            Self::WaitFailed(error) => write!(formatter, "process wait failed: {error}"),
        }
    }
}

impl std::error::Error for ProcessError {}

impl From<SandboxError> for ProcessError {
    fn from(error: SandboxError) -> Self {
        Self::Sandbox(error)
    }
}

impl From<RawSpoolError> for ProcessError {
    fn from(error: RawSpoolError) -> Self {
        Self::Spool(error)
    }
}

#[derive(Debug)]
pub struct ProcessLaunchRequest {
    pub logical_executable: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub background: bool,
}

pub fn next_process_operation_id() -> String {
    let sequence = NEXT_OPERATION_ID.fetch_add(1, Ordering::Relaxed);
    format!("op_{sequence:016x}")
}

pub fn run_process(
    workspace_root: OwnedFd,
    workspace_capability: String,
    request_id: String,
    operation_id: String,
    policy: RuntimePolicy,
    request: ProcessLaunchRequest,
    spool: Arc<RawSpoolStore>,
    executions: Arc<Mutex<ExecutionRegistry>>,
    operations: Arc<ProcessOperationRegistry>,
) -> Result<ProcessOperationView, ProcessError> {
    validate_policy(&policy, &request)?;
    let child_cwd = validate_cwd(&workspace_root, &request.cwd)?;
    let provider = BubblewrapProvider::discover()?;
    let program =
        resolve_trusted_executable(&request.logical_executable).map_err(SandboxError::from)?;
    let mut spec = SandboxLaunchSpec::new(program);
    spec.args = request.argv.into_iter().map(OsString::from).collect();
    spec.env = request.env;
    spec.cwd = child_cwd;
    spec.network = network_mode(&policy.network);
    spec.workspace_access = if policy.allow_write && policy.name != ProfileName::Observe {
        WorkspaceAccess::ReadWrite
    } else {
        WorkspaceAccess::ReadOnly
    };

    let mut child = provider.spawn(&workspace_root, &spec)?;
    let process_group = child.process_group();
    let execution_id = match executions.lock() {
        Ok(mut registry) => {
            registry
                .register(
                    workspace_capability.clone(),
                    process_group,
                    ExecutionKind::Process,
                )
                .execution_id
        }
        Err(_) => {
            terminate_child(&mut child);
            return Err(ProcessError::RegistryUnavailable);
        }
    };
    let mut writer = match spool.create(
        &request_id,
        &operation_id,
        &execution_id,
        "application/vnd.kodegpt.execution-stream",
    ) {
        Ok(writer) => writer,
        Err(error) => {
            terminate_child(&mut child);
            remove_execution(&executions, &execution_id);
            return Err(error.into());
        }
    };
    let initial_artifact = writer.metadata();

    {
        let mut records = match operations.records.lock() {
            Ok(records) => records,
            Err(_) => {
                terminate_child(&mut child);
                remove_execution(&executions, &execution_id);
                return Err(ProcessError::RegistryUnavailable);
            }
        };
        records.insert(
            operation_id.clone(),
            ProcessOperationRecord {
                operation_id: operation_id.clone(),
                workspace_capability: workspace_capability.clone(),
                execution_id: execution_id.clone(),
                process_group,
                state: ProcessState::Running,
                exit_code: None,
                stdout_preview: String::new(),
                stderr_preview: String::new(),
                stdout_truncated: false,
                stderr_truncated: false,
                source_truncated: false,
                bytes_spooled: 0,
                artifact: initial_artifact,
                cancel_requested: false,
            },
        );
    }

    let operation_for_worker = operation_id.clone();
    let operations_for_worker = Arc::clone(&operations);
    let executions_for_worker = Arc::clone(&executions);
    let worker = move || {
        let captured = capture_child(&mut child, &mut writer);
        let finished = match captured {
            Ok(capture) => writer.finish().map(|artifact| (capture, artifact)),
            Err(error) => Err(match error {
                ProcessError::Spool(error) => error,
                _ => {
                    terminate_child(&mut child);
                    remove_execution(&executions_for_worker, &execution_id);
                    mark_failed(&operations_for_worker, &operation_for_worker);
                    return;
                }
            }),
        };
        remove_execution(&executions_for_worker, &execution_id);
        match finished {
            Ok((capture, artifact)) => complete_operation(
                &operations_for_worker,
                &operation_for_worker,
                capture,
                artifact,
            ),
            Err(_) => mark_failed(&operations_for_worker, &operation_for_worker),
        }
    };

    if request.background {
        thread::spawn(worker);
        operations.status(&workspace_capability, &operation_id)
    } else {
        worker();
        operations.status(&workspace_capability, &operation_id)
    }
}

fn validate_policy(
    policy: &RuntimePolicy,
    request: &ProcessLaunchRequest,
) -> Result<(), ProcessError> {
    if !policy.allow_process || policy.name == ProfileName::Observe {
        return Err(ProcessError::PolicyDenied);
    }
    if !policy
        .allowed_executable_names
        .iter()
        .any(|name| name == &request.logical_executable)
    {
        return Err(ProcessError::ExecutableDenied);
    }
    if request.env.keys().any(|key| {
        !policy.env_allowlist.iter().any(|allowed| allowed == key)
            || matches!(key.as_str(), "HOME" | "PATH" | "TMPDIR" | "PWD")
            || key.contains('=')
            || key.contains('\0')
    }) || request.env.values().any(|value| value.contains('\0'))
    {
        return Err(ProcessError::EnvironmentDenied);
    }
    Ok(())
}

fn validate_cwd(workspace_root: &OwnedFd, cwd: &str) -> Result<PathBuf, ProcessError> {
    let relative = if cwd.is_empty() {
        Path::new(".")
    } else {
        Path::new(cwd)
    };
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(ProcessError::InvalidCwd);
    }
    open_directory_beneath(workspace_root, relative).map_err(|_| ProcessError::InvalidCwd)?;
    let mut child = PathBuf::from("/workspace");
    if relative != Path::new(".") {
        child.push(relative);
    }
    Ok(child)
}

fn network_mode(mode: &NetworkMode) -> SandboxNetworkMode {
    match mode {
        NetworkMode::Deny => SandboxNetworkMode::Deny,
        NetworkMode::Localhost => SandboxNetworkMode::Localhost,
        NetworkMode::Allowlist => SandboxNetworkMode::Allowlist,
        NetworkMode::Unrestricted => SandboxNetworkMode::Unrestricted,
    }
}

fn kill_process_group(process_group: i32, signal: i32) -> Result<(), ProcessError> {
    if process_group <= 0 {
        return Err(ProcessError::CancellationFailed(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid process group",
        )));
    }

    // Bubblewrap's status channel gives the host PID of the sandbox command. With --new-session
    // that PID becomes the sandbox process-group/session leader. Signal the whole group first and
    // the leader as a fallback for the narrow startup window before setsid(2) completes.
    let group_result = unsafe { libc::kill(-process_group, signal) };
    let group_error = if group_result == 0 {
        None
    } else {
        Some(std::io::Error::last_os_error())
    };
    let leader_result = unsafe { libc::kill(process_group, signal) };
    let leader_error = if leader_result == 0 {
        None
    } else {
        Some(std::io::Error::last_os_error())
    };
    if group_result == 0 || leader_result == 0 {
        return Ok(());
    }
    if group_error
        .as_ref()
        .is_some_and(|error| error.raw_os_error() == Some(libc::ESRCH))
        && leader_error
            .as_ref()
            .is_some_and(|error| error.raw_os_error() == Some(libc::ESRCH))
    {
        return Ok(());
    }
    Err(ProcessError::CancellationFailed(
        leader_error
            .or(group_error)
            .expect("failed kill has an OS error"),
    ))
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
) -> Result<CaptureResult, ProcessError> {
    let stdout = child
        .child_mut()
        .stdout
        .take()
        .ok_or(ProcessError::CaptureFailed)?;
    let stderr = child
        .child_mut()
        .stderr
        .take()
        .ok_or(ProcessError::CaptureFailed)?;
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

    if stdout_reader.join().is_err() || stderr_reader.join().is_err() || read_failed {
        return Err(ProcessError::CaptureFailed);
    }
    let status = child.child_mut().wait().map_err(ProcessError::WaitFailed)?;
    Ok(CaptureResult {
        exit_code: status.code().unwrap_or(128),
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

fn complete_operation(
    operations: &ProcessOperationRegistry,
    operation_id: &str,
    capture: CaptureResult,
    artifact: RawSpoolMetadata,
) {
    if let Ok(mut records) = operations.records.lock()
        && let Some(record) = records.get_mut(operation_id)
    {
        record.exit_code = Some(capture.exit_code);
        record.stdout_preview = String::from_utf8_lossy(&capture.stdout_preview).into_owned();
        record.stderr_preview = String::from_utf8_lossy(&capture.stderr_preview).into_owned();
        record.stdout_truncated = capture.stdout_truncated;
        record.stderr_truncated = capture.stderr_truncated;
        record.source_truncated = artifact.source_truncated;
        record.bytes_spooled = artifact.bytes_written;
        record.artifact = artifact;
        record.state = if record.cancel_requested {
            ProcessState::Cancelled
        } else if capture.exit_code == 0 {
            ProcessState::Completed
        } else {
            ProcessState::Failed
        };
        record.process_group = 0;
        record.execution_id.clear();
    }
}

fn mark_failed(operations: &ProcessOperationRegistry, operation_id: &str) {
    if let Ok(mut records) = operations.records.lock()
        && let Some(record) = records.get_mut(operation_id)
    {
        record.state = if record.cancel_requested {
            ProcessState::Cancelled
        } else {
            ProcessState::Failed
        };
        record.process_group = 0;
        record.execution_id.clear();
    }
}

fn remove_execution(executions: &Mutex<ExecutionRegistry>, execution_id: &str) {
    if let Ok(mut registry) = executions.lock() {
        registry.remove(execution_id);
    }
}

fn terminate_child(child: &mut kodegpt_sandbox::SandboxChild) {
    let _ = kill_process_group(child.process_group(), libc::SIGKILL);
    let _ = child.child_mut().wait();
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};
    use std::os::fd::OwnedFd;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use kodegpt_protocol::{InheritEnvDisabled, NetworkMode, ProfileName, RuntimePolicy};

    use crate::audit::AuditSink;
    use crate::execution::ExecutionRegistry;
    use crate::spool::RawSpoolStore;

    use super::{
        ProcessError, ProcessLaunchRequest, ProcessOperationRegistry, ProcessState,
        next_process_operation_id, run_process, validate_cwd, validate_policy,
    };

    fn temporary_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "kodegpt-process-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temporary root");
        root
    }

    fn policy(allow_write: bool) -> RuntimePolicy {
        RuntimePolicy {
            name: ProfileName::Develop,
            allow_write,
            allow_process: true,
            network: NetworkMode::Deny,
            allowed_executable_names: vec!["python3".to_owned()],
            inherit_env: InheritEnvDisabled,
            env_allowlist: vec!["LANG".to_owned()],
        }
    }

    fn run_python(
        workspace: &PathBuf,
        state: &PathBuf,
        policy: RuntimePolicy,
        argv: Vec<String>,
        background: bool,
    ) -> (Arc<ProcessOperationRegistry>, super::ProcessOperationView) {
        let root_fd = OwnedFd::from(File::open(workspace).expect("workspace root fd"));
        let audit = Arc::new(AuditSink::open(state));
        let spool = Arc::new(RawSpoolStore::open(state, audit).expect("spool store"));
        let executions = Arc::new(Mutex::new(ExecutionRegistry::default()));
        let operations = Arc::new(ProcessOperationRegistry::default());
        let view = run_process(
            root_fd,
            "kc_process_fixture".to_owned(),
            "req_process_fixture".to_owned(),
            super::next_process_operation_id(),
            policy,
            ProcessLaunchRequest {
                logical_executable: "python3".to_owned(),
                argv,
                cwd: ".".to_owned(),
                env: BTreeMap::new(),
                background,
            },
            spool,
            executions,
            Arc::clone(&operations),
        )
        .expect("process runs");
        (operations, view)
    }

    use std::collections::BTreeMap;

    #[test]
    fn policy_denies_observe_unknown_executable_and_non_allowlisted_environment() {
        let request = ProcessLaunchRequest {
            logical_executable: "python3".to_owned(),
            argv: vec![],
            cwd: ".".to_owned(),
            env: BTreeMap::new(),
            background: false,
        };

        let mut observe = policy(false);
        observe.name = ProfileName::Observe;
        assert!(matches!(
            validate_policy(&observe, &request),
            Err(ProcessError::PolicyDenied)
        ));

        let mut unknown = request;
        unknown.logical_executable = "sh".to_owned();
        assert!(matches!(
            validate_policy(&policy(false), &unknown),
            Err(ProcessError::ExecutableDenied)
        ));

        let mut environment = ProcessLaunchRequest {
            logical_executable: "python3".to_owned(),
            argv: vec![],
            cwd: ".".to_owned(),
            env: BTreeMap::from([("PATH".to_owned(), "/workspace/bin".to_owned())]),
            background: false,
        };
        let mut environment_policy = policy(false);
        environment_policy.env_allowlist.push("PATH".to_owned());
        assert!(matches!(
            validate_policy(&environment_policy, &environment),
            Err(ProcessError::EnvironmentDenied)
        ));

        environment.env = BTreeMap::from([("SECRET".to_owned(), "host".to_owned())]);
        assert!(matches!(
            validate_policy(&environment_policy, &environment),
            Err(ProcessError::EnvironmentDenied)
        ));
    }

    #[test]
    fn cwd_is_resolved_beneath_retained_root_without_parent_or_absolute_traversal() {
        let workspace = temporary_root("cwd-workspace");
        fs::create_dir_all(workspace.join("nested")).expect("nested fixture");
        let root_fd = OwnedFd::from(File::open(&workspace).expect("workspace root fd"));

        assert_eq!(
            validate_cwd(&root_fd, ".").expect("root cwd"),
            PathBuf::from("/workspace")
        );
        assert_eq!(
            validate_cwd(&root_fd, "nested").expect("nested cwd"),
            PathBuf::from("/workspace/nested")
        );
        for denied in ["../", "nested/../", "/tmp", "./../escape"] {
            assert!(matches!(
                validate_cwd(&root_fd, denied),
                Err(ProcessError::InvalidCwd)
            ));
        }

        fs::remove_dir_all(workspace).expect("workspace cleanup");
    }

    #[test]
    fn public_operation_id_is_fixed_width_opaque_and_pid_free_by_construction() {
        let first = next_process_operation_id();
        let second = next_process_operation_id();
        assert!(first.starts_with("op_"));
        assert_eq!(first.len(), 19);
        assert!(
            first[3..]
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        );
        assert_ne!(first, second);
    }

    #[test]
    fn read_only_policy_reads_workspace_but_cannot_create_and_isolates_host_paths() {
        let workspace = temporary_root("ro-workspace");
        let state = temporary_root("ro-state");
        let other = temporary_root("ro-other");
        fs::write(workspace.join("input.txt"), "visible\n").expect("input fixture");
        fs::write(other.join("secret.txt"), "hidden\n").expect("other fixture");
        let host_home = std::env::var("HOME").unwrap_or_else(|_| "/home/sauron".to_owned());
        let script = format!(
            "import os, pathlib; assert pathlib.Path('input.txt').read_text() == 'visible\\n'; denied=False\ntry:\n pathlib.Path('created.txt').write_text('no')\nexcept OSError:\n denied=True\nassert denied; assert not os.path.exists({host_home:?}); assert not os.path.exists({state:?}); assert not os.path.exists({other:?}); print('isolated')"
        );
        let (_, view) = run_python(
            &workspace,
            &state,
            policy(false),
            vec!["-c".to_owned(), script],
            false,
        );
        assert_eq!(
            view.state,
            ProcessState::Completed,
            "{}",
            view.stderr_preview
        );
        assert!(view.stdout_preview.contains("isolated"));
        assert!(!workspace.join("created.txt").exists());
        fs::remove_dir_all(workspace).expect("workspace cleanup");
        fs::remove_dir_all(state).expect("state cleanup");
        fs::remove_dir_all(other).expect("other cleanup");
    }

    #[test]
    fn background_operation_can_be_cancelled_as_a_process_group() {
        let workspace = temporary_root("cancel-workspace");
        let state = temporary_root("cancel-state");
        let (operations, view) = run_python(
            &workspace,
            &state,
            policy(true),
            vec![
                "-c".to_owned(),
                "import subprocess,time; subprocess.Popen(['python3','-c','import time; time.sleep(30)']); time.sleep(30)".to_owned(),
            ],
            true,
        );
        assert_eq!(view.state, ProcessState::Running);
        let cancelled = operations
            .cancel("kc_process_fixture", &view.operation_id)
            .expect("operation cancels");
        assert_eq!(cancelled.state, ProcessState::Cancelled);
        fs::remove_dir_all(workspace).expect("workspace cleanup");
        fs::remove_dir_all(state).expect("state cleanup");
    }

    #[test]
    fn poisoned_operation_registry_kills_spawned_child_before_returning_error() {
        let workspace = temporary_root("poison-workspace");
        let state = temporary_root("poison-state");
        let marker = workspace.join("must-not-exist.txt");
        let root_fd = OwnedFd::from(File::open(&workspace).expect("workspace root fd"));
        let audit = Arc::new(AuditSink::open(&state));
        let spool = Arc::new(RawSpoolStore::open(&state, audit).expect("spool store"));
        let executions = Arc::new(Mutex::new(ExecutionRegistry::default()));
        let operations = Arc::new(ProcessOperationRegistry::default());
        let poisoned = Arc::clone(&operations);
        let _ = thread::spawn(move || {
            let _guard = poisoned.records.lock().expect("operation registry lock");
            panic!("poison operation registry");
        })
        .join();

        let result = run_process(
            root_fd,
            "kc_process_fixture".to_owned(),
            "req_process_poison".to_owned(),
            next_process_operation_id(),
            policy(true),
            ProcessLaunchRequest {
                logical_executable: "python3".to_owned(),
                argv: vec![
                    "-c".to_owned(),
                    "import pathlib,time; time.sleep(0.25); pathlib.Path('must-not-exist.txt').write_text('leaked')".to_owned(),
                ],
                cwd: ".".to_owned(),
                env: BTreeMap::new(),
                background: false,
            },
            spool,
            Arc::clone(&executions),
            operations,
        );
        assert!(matches!(result, Err(ProcessError::RegistryUnavailable)));
        thread::sleep(Duration::from_millis(500));
        assert!(!marker.exists(), "spawned child survived registry failure");
        assert!(
            executions
                .lock()
                .expect("execution registry lock")
                .ids_for_workspace("kc_process_fixture")
                .is_empty()
        );

        fs::remove_dir_all(workspace).expect("workspace cleanup");
        fs::remove_dir_all(state).expect("state cleanup");
    }
}
