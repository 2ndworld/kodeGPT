use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

pub const DEFAULT_AUDIT_ROTATION_BYTES: u64 = 10 * 1024 * 1024;
pub const DEFAULT_AUDIT_ROTATIONS: usize = 5;

#[derive(Debug, Clone, Copy)]
pub enum AuditAction {
    InspectRoot,
    WorkspaceRegister,
    WorkspaceReadProjectProfile,
    WorkspaceRestrictPolicy,
    WorkspaceActivate,
    WorkspaceBeginClose,
    WorkspaceCancelExecutions,
    WorkspaceUnregister,
    FileRead,
    FileTree,
    FileSearch,
    FileIdentity,
    FileWrite,
    FileEdit,
    FileCommitPatchFile,
    GitStatus,
    GitCheckpoint,
    GitCheckpointPatch,
    GitDiff,
    ProcessInspectExecutable,
    VerifyRun,
    ProcessRun,
    ProcessStatus,
    ProcessCancel,
    ArtifactSpoolCreate,
    ArtifactRead,
    ArtifactCleanup,
    SkillSourceInspectRoot,
    SkillSourceRegister,
    SkillSourceTree,
    SkillSourceRead,
    SkillSourceUnregister,
    TestEffect,
}

#[derive(Debug, Clone, Copy)]
pub enum AuditDecision {
    Allow,
}

#[derive(Debug, Clone, Copy)]
pub enum AuditReason {
    RequestValidated,
    TestAuthorized,
}

#[derive(Debug, Clone, Copy)]
pub enum AuditOutcome {
    Success,
    Failed,
}

#[derive(Debug, Clone)]
pub struct AuditContext {
    pub request_id: String,
    pub operation_id: String,
    pub capability_id: Option<String>,
    pub action: AuditAction,
}

#[derive(Debug, Clone, Copy)]
pub struct AuditSinkConfig {
    pub rotation_bytes: u64,
    pub retained_rotations: usize,
}

impl Default for AuditSinkConfig {
    fn default() -> Self {
        Self {
            rotation_bytes: DEFAULT_AUDIT_ROTATION_BYTES,
            retained_rotations: DEFAULT_AUDIT_ROTATIONS,
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct AuditFaults {
    pub fail_next_decision: bool,
    pub fail_next_outcome: bool,
}

#[derive(Debug)]
pub struct AuditError {
    message: String,
}

impl AuditError {
    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for AuditError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for AuditError {}

#[derive(Debug)]
struct AuditState {
    file: Option<File>,
    bytes_written: u64,
    healthy: bool,
    faults: AuditFaults,
}

#[derive(Debug)]
pub struct AuditSink {
    state_root: PathBuf,
    path: PathBuf,
    config: AuditSinkConfig,
    state: Mutex<AuditState>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditRecord {
    schema_version: u32,
    timestamp_unix_ms: u128,
    phase: &'static str,
    request_id: String,
    operation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    capability_id: Option<String>,
    action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    decision: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<&'static str>,
}

impl AuditSink {
    pub fn open(state_root: &Path) -> Self {
        Self::open_internal(
            state_root,
            AuditSinkConfig::default(),
            AuditFaults::default(),
        )
    }

    #[cfg(any(test, feature = "runtime-test-methods"))]
    pub fn open_with_faults(state_root: &Path, faults: AuditFaults) -> Self {
        Self::open_internal(state_root, AuditSinkConfig::default(), faults)
    }

    #[cfg(test)]
    pub fn open_with_config(state_root: &Path, config: AuditSinkConfig) -> Self {
        Self::open_internal(state_root, config, AuditFaults::default())
    }

    fn open_internal(state_root: &Path, config: AuditSinkConfig, faults: AuditFaults) -> Self {
        let directory = state_root.join("logs/security");
        let path = directory.join("audit.jsonl");
        let opened = initialize_file(&directory, &path);
        let (file, bytes_written, healthy) = match opened {
            Ok((file, bytes_written)) => (Some(file), bytes_written, true),
            Err(_) => (None, 0, false),
        };

        Self {
            state_root: state_root.to_path_buf(),
            path,
            config,
            state: Mutex::new(AuditState {
                file,
                bytes_written,
                healthy,
                faults,
            }),
        }
    }

    pub fn state_root(&self) -> &Path {
        &self.state_root
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn is_healthy(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.healthy)
            .unwrap_or(false)
    }

    #[cfg(test)]
    pub fn inject_faults(&self, faults: AuditFaults) {
        if let Ok(mut state) = self.state.lock() {
            state.faults = faults;
        }
    }

    pub fn decision(
        &self,
        context: &AuditContext,
        decision: AuditDecision,
        reason: AuditReason,
    ) -> Result<(), AuditError> {
        let record = AuditRecord::decision(context, decision, reason);
        self.append(record, AuditPhase::Decision)
    }

    pub fn outcome(&self, context: &AuditContext, outcome: AuditOutcome) -> Result<(), AuditError> {
        let record = AuditRecord::outcome(context, outcome);
        self.append(record, AuditPhase::Outcome)
    }

    fn append(&self, record: AuditRecord, phase: AuditPhase) -> Result<(), AuditError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| AuditError::unavailable("AUDIT_UNAVAILABLE"))?;
        if !state.healthy {
            return Err(AuditError::unavailable("AUDIT_UNAVAILABLE"));
        }

        #[cfg(any(test, feature = "runtime-test-methods"))]
        {
            let injected = match phase {
                AuditPhase::Decision if state.faults.fail_next_decision => {
                    state.faults.fail_next_decision = false;
                    true
                }
                AuditPhase::Outcome if state.faults.fail_next_outcome => {
                    state.faults.fail_next_outcome = false;
                    true
                }
                _ => false,
            };
            if injected {
                state.healthy = false;
                return Err(AuditError::unavailable("AUDIT_UNAVAILABLE"));
            }
        }

        let mut line = match serde_json::to_vec(&record) {
            Ok(line) => line,
            Err(_) => {
                state.healthy = false;
                return Err(AuditError::unavailable("AUDIT_UNAVAILABLE"));
            }
        };
        line.push(b'\n');

        if state.bytes_written > 0
            && state.bytes_written.saturating_add(line.len() as u64) > self.config.rotation_bytes
        {
            if let Err(error) = self.rotate_locked(&mut state) {
                state.healthy = false;
                return Err(error);
            }
        }

        let write_result = (|| -> Result<(), std::io::Error> {
            let file = state
                .file
                .as_mut()
                .ok_or_else(|| std::io::Error::other("audit file unavailable"))?;
            file.write_all(&line)?;
            file.flush()?;
            file.sync_data()?;
            Ok(())
        })();

        if write_result.is_err() {
            state.healthy = false;
            return Err(AuditError::unavailable("AUDIT_UNAVAILABLE"));
        }
        state.bytes_written = state.bytes_written.saturating_add(line.len() as u64);
        Ok(())
    }

    fn rotate_locked(&self, state: &mut AuditState) -> Result<(), AuditError> {
        if let Some(file) = state.file.take() {
            file.sync_all()
                .map_err(|_| AuditError::unavailable("AUDIT_UNAVAILABLE"))?;
        }

        if self.config.retained_rotations > 0 {
            let oldest = rotated_path(&self.path, self.config.retained_rotations);
            if oldest.exists() {
                fs::remove_file(&oldest)
                    .map_err(|_| AuditError::unavailable("AUDIT_UNAVAILABLE"))?;
            }

            for index in (1..self.config.retained_rotations).rev() {
                let source = rotated_path(&self.path, index);
                if source.exists() {
                    fs::rename(&source, rotated_path(&self.path, index + 1))
                        .map_err(|_| AuditError::unavailable("AUDIT_UNAVAILABLE"))?;
                }
            }

            if self.path.exists() {
                fs::rename(&self.path, rotated_path(&self.path, 1))
                    .map_err(|_| AuditError::unavailable("AUDIT_UNAVAILABLE"))?;
            }
        } else if self.path.exists() {
            fs::remove_file(&self.path)
                .map_err(|_| AuditError::unavailable("AUDIT_UNAVAILABLE"))?;
        }

        let (file, bytes_written) = open_audit_file(&self.path)
            .map_err(|_| AuditError::unavailable("AUDIT_UNAVAILABLE"))?;
        sync_directory(
            self.path
                .parent()
                .ok_or_else(|| AuditError::unavailable("AUDIT_UNAVAILABLE"))?,
        )
        .map_err(|_| AuditError::unavailable("AUDIT_UNAVAILABLE"))?;
        state.file = Some(file);
        state.bytes_written = bytes_written;
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum AuditPhase {
    Decision,
    Outcome,
}

impl AuditRecord {
    fn decision(context: &AuditContext, decision: AuditDecision, reason: AuditReason) -> Self {
        Self::base(
            context,
            "decision",
            Some(decision.as_str()),
            Some(reason.as_str()),
            None,
        )
    }

    fn outcome(context: &AuditContext, outcome: AuditOutcome) -> Self {
        Self::base(context, "outcome", None, None, Some(outcome.as_str()))
    }

    fn base(
        context: &AuditContext,
        phase: &'static str,
        decision: Option<&'static str>,
        reason: Option<&'static str>,
        outcome: Option<&'static str>,
    ) -> Self {
        Self {
            schema_version: 1,
            timestamp_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or_default(),
            phase,
            request_id: sanitize_id(&context.request_id, "req_"),
            operation_id: sanitize_id(&context.operation_id, "op_"),
            capability_id: context.capability_id.as_deref().map(sanitize_capability_id),
            action: context.action.as_str(),
            decision,
            reason,
            outcome,
        }
    }
}

impl AuditAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::InspectRoot => "inspect_root",
            Self::WorkspaceRegister => "workspace_register",
            Self::WorkspaceReadProjectProfile => "workspace_read_project_profile",
            Self::WorkspaceRestrictPolicy => "workspace_restrict_policy",
            Self::WorkspaceActivate => "workspace_activate",
            Self::WorkspaceBeginClose => "workspace_begin_close",
            Self::WorkspaceCancelExecutions => "workspace_cancel_executions",
            Self::WorkspaceUnregister => "workspace_unregister",
            Self::FileRead => "file_read",
            Self::FileTree => "file_tree",
            Self::FileSearch => "file_search",
            Self::FileIdentity => "file_identity",
            Self::FileWrite => "file_write",
            Self::FileEdit => "file_edit",
            Self::FileCommitPatchFile => "file_commit_patch_file",
            Self::GitStatus => "git_status",
            Self::GitCheckpoint => "git_checkpoint",
            Self::GitCheckpointPatch => "git_checkpoint_patch",
            Self::GitDiff => "git_diff",
            Self::ProcessInspectExecutable => "process_inspect_executable",
            Self::VerifyRun => "verify_run",
            Self::ProcessRun => "process_run",
            Self::ProcessStatus => "process_status",
            Self::ProcessCancel => "process_cancel",
            Self::ArtifactSpoolCreate => "artifact_spool_create",
            Self::ArtifactRead => "artifact_read",
            Self::ArtifactCleanup => "artifact_cleanup",
            Self::SkillSourceInspectRoot => "skill_source_inspect_root",
            Self::SkillSourceRegister => "skill_source_register",
            Self::SkillSourceTree => "skill_source_tree",
            Self::SkillSourceRead => "skill_source_read",
            Self::SkillSourceUnregister => "skill_source_unregister",
            Self::TestEffect => "test_effect",
        }
    }
}

impl AuditDecision {
    fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
        }
    }
}

impl AuditReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::RequestValidated => "request_validated",
            Self::TestAuthorized => "test_authorized",
        }
    }
}

impl AuditOutcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Failed => "failed",
        }
    }
}

fn initialize_file(directory: &Path, path: &Path) -> Result<(File, u64), std::io::Error> {
    fs::create_dir_all(directory)?;
    let (file, bytes_written) = open_audit_file(path)?;
    file.sync_all()?;
    sync_directory(directory)?;
    Ok((file, bytes_written))
}

fn open_audit_file(path: &Path) -> Result<(File, u64), std::io::Error> {
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .read(true)
        .mode(0o600)
        .open(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    let bytes_written = file.metadata()?.len();
    Ok((file, bytes_written))
}

fn sync_directory(directory: &Path) -> Result<(), std::io::Error> {
    File::open(directory)?.sync_all()
}

fn rotated_path(path: &Path, index: usize) -> PathBuf {
    path.with_extension(format!("jsonl.{index}"))
}

fn sanitize_capability_id(value: &str) -> String {
    if value.starts_with("sc_") {
        sanitize_id(value, "sc_")
    } else {
        sanitize_id(value, "kc_")
    }
}

fn sanitize_id(value: &str, prefix: &str) -> String {
    let valid = value.len() <= 96
        && value.starts_with(prefix)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'));
    if valid {
        value.to_owned()
    } else {
        format!("{prefix}redacted")
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::Value;

    use super::{
        AuditAction, AuditContext, AuditDecision, AuditFaults, AuditOutcome, AuditReason,
        AuditSink, AuditSinkConfig, DEFAULT_AUDIT_ROTATION_BYTES, DEFAULT_AUDIT_ROTATIONS,
    };

    fn temporary_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "kodegpt-audit-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temporary root created");
        root
    }

    fn context(index: usize) -> AuditContext {
        AuditContext {
            request_id: format!("req_audit_{index}"),
            operation_id: format!("op_audit_{index}"),
            capability_id: None,
            action: AuditAction::TestEffect,
        }
    }

    fn parse_lines(path: &Path) -> Vec<Value> {
        fs::read_to_string(path)
            .expect("audit readable")
            .lines()
            .map(|line| serde_json::from_str(line).expect("every audit line is valid JSON"))
            .collect()
    }

    #[test]
    fn audit_concurrent_jsonl_integrity_is_serialized_and_exact() {
        let root = temporary_root("concurrent");
        let sink = Arc::new(AuditSink::open(&root));
        assert!(sink.is_healthy());
        assert_eq!(sink.state_root(), root.as_path());

        let mut workers = Vec::new();
        for index in 0..100 {
            let sink = Arc::clone(&sink);
            workers.push(thread::spawn(move || {
                sink.decision(
                    &context(index),
                    AuditDecision::Allow,
                    AuditReason::TestAuthorized,
                )
                .expect("decision append succeeds");
            }));
        }
        for worker in workers {
            worker.join().expect("audit worker joins");
        }

        let lines = parse_lines(sink.path());
        assert_eq!(lines.len(), 100);
        assert!(lines.iter().all(|record| record["phase"] == "decision"));
        assert_eq!(
            fs::metadata(sink.path())
                .expect("audit metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        fs::remove_dir_all(root).expect("temporary root removed");
    }

    #[test]
    fn audit_decision_failure_poisoning_is_fail_closed() {
        let root = temporary_root("decision-failure");
        let sink = AuditSink::open_with_faults(
            &root,
            AuditFaults {
                fail_next_decision: true,
                fail_next_outcome: false,
            },
        );

        assert!(
            sink.decision(
                &context(1),
                AuditDecision::Allow,
                AuditReason::TestAuthorized,
            )
            .is_err()
        );
        assert!(!sink.is_healthy());
        assert!(
            sink.decision(
                &context(2),
                AuditDecision::Allow,
                AuditReason::TestAuthorized,
            )
            .is_err()
        );
        fs::remove_dir_all(root).expect("temporary root removed");
    }

    #[test]
    fn audit_outcome_failure_poisoning_blocks_future_decisions() {
        assert_eq!(AuditOutcome::Failed.as_str(), "failed");
        let root = temporary_root("outcome-failure");
        let sink = AuditSink::open_with_faults(
            &root,
            AuditFaults {
                fail_next_decision: false,
                fail_next_outcome: true,
            },
        );

        sink.decision(
            &context(1),
            AuditDecision::Allow,
            AuditReason::TestAuthorized,
        )
        .expect("decision persists");
        assert!(sink.outcome(&context(1), AuditOutcome::Success).is_err());
        assert!(!sink.is_healthy());
        assert!(
            sink.decision(
                &context(2),
                AuditDecision::Allow,
                AuditReason::TestAuthorized,
            )
            .is_err()
        );
        fs::remove_dir_all(root).expect("temporary root removed");
    }

    #[test]
    fn audit_default_rotation_contract_and_bounded_rotation_are_enforced() {
        assert_eq!(DEFAULT_AUDIT_ROTATION_BYTES, 10 * 1024 * 1024);
        assert_eq!(DEFAULT_AUDIT_ROTATIONS, 5);

        let root = temporary_root("rotation");
        let sink = AuditSink::open_with_config(
            &root,
            AuditSinkConfig {
                rotation_bytes: 512,
                retained_rotations: 2,
            },
        );

        for index in 0..40 {
            sink.decision(
                &context(index),
                AuditDecision::Allow,
                AuditReason::TestAuthorized,
            )
            .expect("decision persists");
        }

        assert!(sink.path().exists());
        assert!(sink.path().with_extension("jsonl.1").exists());
        assert!(sink.path().with_extension("jsonl.2").exists());
        assert!(!sink.path().with_extension("jsonl.3").exists());
        fs::remove_dir_all(root).expect("temporary root removed");
    }

    #[test]
    fn audit_preserves_valid_skill_source_capability_ids() {
        let root = temporary_root("skill-source-capability");
        let sink = AuditSink::open(&root);
        let context = AuditContext {
            request_id: "req_skill_source_capability".to_owned(),
            operation_id: "op_skill_source_capability".to_owned(),
            capability_id: Some("sc_safe_123".to_owned()),
            action: AuditAction::SkillSourceRead,
        };

        sink.decision(
            &context,
            AuditDecision::Allow,
            AuditReason::RequestValidated,
        )
        .expect("decision persists");

        let serialized = fs::read_to_string(sink.path()).expect("audit readable");
        let record: Value = serde_json::from_str(serialized.trim()).expect("audit record json");
        assert_eq!(record["capabilityId"], "sc_safe_123");
        fs::remove_dir_all(root).expect("temporary root removed");
    }

    #[test]
    fn audit_sanitizes_invalid_identifier_payloads_instead_of_serializing_them() {
        let root = temporary_root("redaction");
        let sink = AuditSink::open(&root);
        let secret = ["SUPER", "_SECRET", "_MARKER", "_123"].concat();
        let context = AuditContext {
            request_id: secret.clone(),
            operation_id: secret.clone(),
            capability_id: Some(secret.clone()),
            action: AuditAction::TestEffect,
        };

        sink.decision(&context, AuditDecision::Allow, AuditReason::TestAuthorized)
            .expect("decision persists");

        let serialized = fs::read_to_string(sink.path()).expect("audit readable");
        assert_eq!(serialized.matches(&secret).count(), 0);
        fs::remove_dir_all(root).expect("temporary root removed");
    }
}
