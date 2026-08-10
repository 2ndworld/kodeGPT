use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::fmt;
use std::io::Read;
use std::os::fd::OwnedFd;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use kodegpt_protocol::{NetworkMode, ProcessRunParams, ProfileName, RuntimePolicy};
use kodegpt_sandbox::{
    resolve_trusted_executable, BubblewrapProvider, SandboxError, SandboxLaunchSpec,
    SandboxNetworkMode, WorkspaceAccess,
};
use kodegpt_workspace_io::open_directory_beneath;
use rustix::io::Errno;
use rustix::process::{kill_process_group, Pid, Signal};
use serde::Serialize;

use crate::audit::{AuditContext, AuditOutcome, AuditSink};
use crate::execution::{ExecutionKind, ExecutionRegistry};
use crate::spool::{RawSpoolError, RawSpoolMetadata, RawSpoolStore, RawSpoolWriter};

const PROCESS_PREVIEW_MAX_BYTES: usize = 64 * 1024;
const CAPTURE_CHUNK_BYTES: usize = 16 * 1024;
const CANCEL_GRACE: Duration = Duration::from_millis(500);
const CANCEL_KILL_WAIT: Duration = Duration::from_secs(2);
const RESERVED_ENV: [&str; 4] = ["HOME", "PATH", "TMPDIR", "PWD"];

static NEXT_OPERATION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PublicProcessPhase {
    Running,
    Exited,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicProcessStatus {
    pub schema_version: u32,
    pub operation_id: String,
    pub state: PublicProcessPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout_truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact: Option<RawSpoolMetadata>,
}

#[derive(Debug)]
pub enum ProcessError {
    PolicyDenied,
    ExecutableDenied,
    EnvironmentDenied,
    ReservedEnvironment,
    InvalidCwd,
    Sandbox(SandboxError),
    Spool(RawSpoolError),
    RegistryUnavailable,
    OperationNotFound,
    OperationScopeMismatch,
    CancellationFailed,
    CancellationTimeout,
    CaptureFailed,
    WaitFailed(std::io::Error),
}

impl fmt::Display for ProcessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PolicyDenied => formatter.write_str("process execution denied by effective policy"),
            Self::ExecutableDenied => formatter.write_str("logical executable denied by effective policy"),
            Self::EnvironmentDenied => formatter.write_str("process environment key denied by effective policy"),
            Self::ReservedEnvironment => formatter.write_str("process environment attempts to override a reserved value"),
            Self::InvalidCwd => formatter.write_str("process cwd must resolve beneath the retained workspace root"),
            Self::Sandbox(error) => write!(formatter, "process sandbox failed: {error}"),
            Self::Spool(error) => write!(formatter, "process spool failed: {error}"),
            Self::RegistryUnavailable => formatter.write_str("process execution registry unavailable"),
            Self::OperationNotFound => formatter.write_str("process operation was not found"),
            Self::OperationScopeMismatch => formatter.write_str("process operation does not belong to the workspace"),
            Self::CancellationFailed => formatter.write_str("process cancellation signal failed"),
            Self::CancellationTimeout => formatter.write_str("process cancellation did not reach a terminal state"),
            Self::CaptureFailed => formatter.write_str("process output capture failed"),
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
struct OperationState {
    phase: PublicProcessPhase,
    exit_code: Option<i32>,
    stdout_preview: Option<String>,
    stderr_preview: Option<String>,
    stdout_truncated: Option<bool>,
    stderr_truncated: Option<bool>,
    artifact: Option<RawSpoolMetadata>,
}

impl OperationState {
    fn running() -> Self {
        Self {
            phase: PublicProcessPhase::Running,
            exit_code: None,
            stdout_preview: None,
            stderr_preview: None,
            stdout_truncated: None,
            stderr_truncated: None,
            artifact: None,
        }
    }

    fn is_terminal(&self) -> bool {
        self.phase != PublicProcessPhase::Running
    }
}

#[derive(Debug)]
struct ProcessOperation {
    operation_id: String,
    workspace_capability: String,
    process_group: i32,
    cancel_requested: AtomicBool,
    state: Mutex<OperationState>,
    changed: Condvar,
}

impl ProcessOperation {
    fn public_status(&self) -> Result<PublicProcessStatus, ProcessError> {
        let state = self.state.lock().map_err(|_| ProcessError::RegistryUnavailable)?;
        Ok(PublicProcessStatus {
            schema_version: 1,
            operation_id: self.operation_id.clone(),
            state: state.phase,
            exit_code: state.exit_code,
            stdout_preview: state.stdout_preview.clone(),
            stderr_preview: state.stderr_preview.clone(),
            stdout_truncated: state.stdout_truncated,
            stderr_truncated: state.stderr_truncated,
            artifact: state.artifact.clone(),
        })
    }
}

pub struct ProcessManager {
    operations: Mutex<HashMap<String, Arc<ProcessOperation>>>,
    executions: Arc<Mutex<ExecutionRegistry>>,
    spool: Arc<RawSpoolStore>,
    audit: Arc<AuditSink>,
}

impl ProcessManager {
    pub fn new(
        executions: Arc<Mutex<ExecutionRegistry>>,
        spool: Arc<RawSpoolStore>,
        audit: Arc<AuditSink>,
    ) -> Self {
        Self {
            operations: Mutex::new(HashMap::new()),
            executions,
            spool,
            audit,
        }
    }

    pub fn next_operation_id() -> String {
        let sequence = NEXT_OPERATION_ID.fetch_add(1, Ordering::Relaxed);
        format!("op_{}_{}", std::process::id(), sequence)
    }

    pub fn run(
        &self,
        operation_id: String,
        root_fd: OwnedFd,
        policy: RuntimePolicy,
        params: ProcessRunParams,
        audit_context: AuditContext,
    ) -> Result<PublicProcessStatus, ProcessError> {
        let spec = build_process_spec(&root_fd, &policy, &params)?;
        let provider = BubblewrapProvider::discover()?;
        let mut child = provider.spawn(&root_fd, &spec)?;
        let process_group = child.process_group();
        let execution_id = match self.executions.lock() {
            Ok(mut registry) => {
                registry
                    .register(
                        params.capability_id.clone(),
                        process_group,
                        ExecutionKind::Process,
                    )
                    .execution_id
            }
            Err(_) => {
                terminate_untracked_child(&mut child);
                return Err(ProcessError::RegistryUnavailable);
            }
        };

        let writer = match self.spool.create(
            &audit_context.request_id,
            &operation_id,
            &execution_id,
            "application/vnd.kodegpt.execution-stream",
        ) {
            Ok(writer) => writer,
            Err(error) => {
                terminate_untracked_child(&mut child);
                remove_execution(&self.executions, &execution_id);
                return Err(error.into());
            }
        };

        let operation = Arc::new(ProcessOperation {
            operation_id: operation_id.clone(),
            workspace_capability: params.capability_id.clone(),
            process_group,
            cancel_requested: AtomicBool::new(false),
            state: Mutex::new(OperationState::running()),
            changed: Condvar::new(),
        });
        {
            let mut operations = self
                .operations
                .lock()
                .map_err(|_| ProcessError::RegistryUnavailable)?;
            if operations.contains_key(&operation_id) {
                terminate_untracked_child(&mut child);
                remove_execution(&self.executions, &execution_id);
                return Err(ProcessError::RegistryUnavailable);
            }
            operations.insert(operation_id.clone(), Arc::clone(&operation));
        }

        let executions = Arc::clone(&self.executions);
        let audit = Arc::clone(&self.audit);
        let worker_operation = Arc::clone(&operation);
        thread::Builder::new()
            .name(format!("kodegpt-process-{operation_id}"))
            .spawn(move || {
                run_capture_worker(
                    child,
                    writer,
                    worker_operation,
                    executions,
                    execution_id,
                    audit,
                    audit_context,
                );
            })
            .map_err(|_| ProcessError::CaptureFailed)?;

        if params.background {
            operation.public_status()
        } else {
            wait_terminal(&operation, None)
        }
    }

    pub fn status(
        &self,
        capability_id: &str,
        operation_id: &str,
    ) -> Result<PublicProcessStatus, ProcessError> {
        self.operation_for_workspace(capability_id, operation_id)?
            .public_status()
    }

    pub fn cancel(
        &self,
        capability_id: &str,
        operation_id: &str,
    ) -> Result<PublicProcessStatus, ProcessError> {
        let operation = self.operation_for_workspace(capability_id, operation_id)?;
        let current = operation.public_status()?;
        if current.state != PublicProcessPhase::Running {
            return Ok(current);
        }

        operation.cancel_requested.store(true, Ordering::Release);
        signal_group(operation.process_group, Signal::TERM)?;
        if let Ok(status) = wait_terminal(&operation, Some(CANCEL_GRACE)) {
            return Ok(status);
        }
        signal_group(operation.process_group, Signal::KILL)?;
        wait_terminal(&operation, Some(CANCEL_KILL_WAIT))
    }

    pub fn cancel_workspace(&self, capability_id: &str) -> Result<(), ProcessError> {
        let operation_ids = {
            let operations = self
                .operations
                .lock()
                .map_err(|_| ProcessError::RegistryUnavailable)?;
            operations
                .values()
                .filter(|operation| operation.workspace_capability == capability_id)
                .map(|operation| operation.operation_id.clone())
                .collect::<Vec<_>>()
        };
        for operation_id in operation_ids {
            let _ = self.cancel(capability_id, &operation_id)?;
        }
        Ok(())
    }

    fn operation_for_workspace(
        &self,
        capability_id: &str,
        operation_id: &str,
    ) -> Result<Arc<ProcessOperation>, ProcessError> {
        let operations = self
            .operations
            .lock()
            .map_err(|_| ProcessError::RegistryUnavailable)?;
        let operation = operations
            .get(operation_id)
            .ok_or(ProcessError::OperationNotFound)?;
        if operation.workspace_capability != capability_id {
            return Err(ProcessError::OperationScopeMismatch);
        }
        Ok(Arc::clone(operation))
    }
}

fn build_process_spec(
    root_fd: &OwnedFd,
    policy: &RuntimePolicy,
    params: &ProcessRunParams,
) -> Result<SandboxLaunchSpec, ProcessError> {
    if !policy.allow_process || policy.name == ProfileName::Observe {
        return Err(ProcessError::PolicyDenied);
    }
    if !policy
        .allowed_executable_names
        .iter()
        .any(|name| name == &params.logical_executable)
    {
        return Err(ProcessError::ExecutableDenied);
    }

    let cwd = if params.cwd.is_empty() { "." } else { params.cwd.as_str() };
    open_directory_beneath(root_fd, Path::new(cwd)).map_err(|_| ProcessError::InvalidCwd)?;
    let child_cwd = child_cwd(cwd)?;

    let mut env = BTreeMap::new();
    for (name, value) in &params.env {
        if RESERVED_ENV.contains(&name.as_str()) {
            return Err(ProcessError::ReservedEnvironment);
        }
        if !policy.env_allowlist.iter().any(|allowed| allowed == name) {
            return Err(ProcessError::EnvironmentDenied);
        }
        env.insert(name.clone(), value.clone());
    }

    let program = resolve_trusted_executable(&params.logical_executable).map_err(SandboxError::from)?;
    let mut spec = SandboxLaunchSpec::new(program);
    spec.args = params.argv.iter().map(OsString::from).collect();
    spec.env = env;
    spec.cwd = child_cwd;
    spec.network = match policy.network {
        NetworkMode::Deny => SandboxNetworkMode::Deny,
        NetworkMode::Localhost => SandboxNetworkMode::Localhost,
        NetworkMode::Allowlist => SandboxNetworkMode::Allowlist,
        NetworkMode::Unrestricted => SandboxNetworkMode::Unrestricted,
    };
    spec.workspace_access = if policy.allow_write {
        WorkspaceAccess::ReadWrite
    } else {
        WorkspaceAccess::ReadOnly
    };
    Ok(spec)
}

fn child_cwd(cwd: &str) -> Result<PathBuf, ProcessError> {
    if cwd == "." {
        return Ok(PathBuf::from("/workspace"));
    }
    let path = Path::new(cwd);
    if path.is_absolute() {
        return Err(ProcessError::InvalidCwd);
    }
    let mut translated = PathBuf::from("/workspace");
    let mut has_normal = false;
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                has_normal = true;
                translated.push(value);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(ProcessError::InvalidCwd);
            }
        }
    }
    if !has_normal {
        return Err(ProcessError::InvalidCwd);
    }
    Ok(translated)
}

fn signal_group(process_group: i32, signal: Signal) -> Result<(), ProcessError> {
    let process_group = Pid::from_raw(process_group).ok_or(ProcessError::CancellationFailed)?;
    match kill_process_group(process_group, signal) {
        Ok(()) | Err(Errno::SRCH) => Ok(()),
        Err(_) => Err(ProcessError::CancellationFailed),
    }
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

fn run_capture_worker(
    mut child: kodegpt_sandbox::SandboxChild,
    mut writer: RawSpoolWriter,
    operation: Arc<ProcessOperation>,
    executions: Arc<Mutex<ExecutionRegistry>>,
    execution_id: String,
    audit: Arc<AuditSink>,
    audit_context: AuditContext,
) {
    let result = capture_and_wait(&mut child, &mut writer);
    let artifact = writer.finish();
    remove_execution(&executions, &execution_id);

    let (phase, exit_code, stdout, stderr, stdout_truncated, stderr_truncated, audit_outcome) =
        match (result, artifact) {
            (Ok(capture), Ok(artifact)) => {
                let cancelled = operation.cancel_requested.load(Ordering::Acquire);
                let phase = if cancelled {
                    PublicProcessPhase::Cancelled
                } else {
                    PublicProcessPhase::Exited
                };
                let audit_outcome = if capture.exit_code == 0 && !cancelled {
                    AuditOutcome::Success
                } else if cancelled {
                    AuditOutcome::Success
                } else {
                    AuditOutcome::Failed
                };
                (
                    phase,
                    Some(capture.exit_code),
                    Some(String::from_utf8_lossy(&capture.stdout_preview).into_owned()),
                    Some(String::from_utf8_lossy(&capture.stderr_preview).into_owned()),
                    Some(capture.stdout_truncated),
                    Some(capture.stderr_truncated),
                    (Some(artifact), audit_outcome),
                )
            }
            _ => (
                PublicProcessPhase::Failed,
                None,
                None,
                None,
                None,
                None,
                (None, AuditOutcome::Failed),
            ),
        };

    let (artifact, audit_outcome) = audit_outcome;
    let audit_ok = audit.outcome(&audit_context, audit_outcome).is_ok();
    if let Ok(mut state) = operation.state.lock() {
        state.phase = if audit_ok { phase } else { PublicProcessPhase::Failed };
        state.exit_code = exit_code;
        state.stdout_preview = stdout;
        state.stderr_preview = stderr;
        state.stdout_truncated = stdout_truncated;
        state.stderr_truncated = stderr_truncated;
        state.artifact = artifact;
        operation.changed.notify_all();
    }
}

struct CaptureResult {
    exit_code: i32,
    stdout_preview: Vec<u8>,
    stderr_preview: Vec<u8>,
    stdout_truncated: bool,
    stderr_truncated: bool,
}

fn capture_and_wait(
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
                let marker = match kind {
                    StreamKind::Stdout => b"[stdout]".as_slice(),
                    StreamKind::Stderr => b"[stderr]".as_slice(),
                };
                writer.write_source(marker)?;
                writer.write_source(&(bytes.len() as u32).to_be_bytes())?;
                writer.write_source(&bytes)?;
                match kind {
                    StreamKind::Stdout => append_preview(
                        &mut stdout_preview,
                        &mut stdout_truncated,
                        &bytes,
                    ),
                    StreamKind::Stderr => append_preview(
                        &mut stderr_preview,
                        &mut stderr_truncated,
                        &bytes,
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
        return Err(ProcessError::CaptureFailed);
    }
    let status = child
        .child_mut()
        .wait()
        .map_err(ProcessError::WaitFailed)?;
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
    let remaining = PROCESS_PREVIEW_MAX_BYTES.saturating_sub(target.len());
    let accepted = remaining.min(source.len());
    target.extend_from_slice(&source[..accepted]);
    if accepted < source.len() {
        *truncated = true;
    }
}

fn wait_terminal(
    operation: &Arc<ProcessOperation>,
    timeout: Option<Duration>,
) -> Result<PublicProcessStatus, ProcessError> {
    let mut state = operation
        .state
        .lock()
        .map_err(|_| ProcessError::RegistryUnavailable)?;
    let deadline = timeout.map(|duration| Instant::now() + duration);
    while !state.is_terminal() {
        state = if let Some(deadline) = deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(ProcessError::CancellationTimeout);
            }
            let (next, wait) = operation
                .changed
                .wait_timeout(state, remaining)
                .map_err(|_| ProcessError::RegistryUnavailable)?;
            if wait.timed_out() && !next.is_terminal() {
                return Err(ProcessError::CancellationTimeout);
            }
            next
        } else {
            operation
                .changed
                .wait(state)
                .map_err(|_| ProcessError::RegistryUnavailable)?
        };
    }
    Ok(PublicProcessStatus {
        schema_version: 1,
        operation_id: operation.operation_id.clone(),
        state: state.phase,
        exit_code: state.exit_code,
        stdout_preview: state.stdout_preview.clone(),
        stderr_preview: state.stderr_preview.clone(),
        stdout_truncated: state.stdout_truncated,
        stderr_truncated: state.stderr_truncated,
        artifact: state.artifact.clone(),
    })
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
