use std::collections::HashSet;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::audit::{
    AuditAction, AuditContext, AuditDecision, AuditOutcome, AuditReason, AuditSink,
};

pub const RAW_SPOOL_SOURCE_CAP_BYTES: u64 = 64 * 1024 * 1024;

static NEXT_ARTIFACT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
pub enum RawSpoolError {
    AuditUnavailable,
    DuplicateExecution,
    InvalidExecutionId,
    InvalidMediaType,
    SynchronizationFailed,
    Io(std::io::Error),
}

impl fmt::Display for RawSpoolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AuditUnavailable => formatter.write_str("AUDIT_UNAVAILABLE"),
            Self::DuplicateExecution => {
                formatter.write_str("raw spool already exists for execution")
            }
            Self::InvalidExecutionId => formatter.write_str("raw spool execution id is invalid"),
            Self::InvalidMediaType => formatter.write_str("raw spool media type is invalid"),
            Self::SynchronizationFailed => formatter.write_str("raw spool synchronization failed"),
            Self::Io(error) => write!(formatter, "raw spool I/O failed: {error}"),
        }
    }
}

impl std::error::Error for RawSpoolError {}

impl From<std::io::Error> for RawSpoolError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawSpoolMetadata {
    pub schema_version: u32,
    pub artifact_id: String,
    pub media_type: String,
    pub bytes_written: u64,
    pub source_truncated: bool,
}

#[derive(Debug)]
pub struct RawSpoolStore {
    raw_root: PathBuf,
    audit: Arc<AuditSink>,
    issued_executions: Mutex<HashSet<String>>,
}

impl RawSpoolStore {
    pub fn open(state_root: &Path, audit: Arc<AuditSink>) -> Result<Self, RawSpoolError> {
        let artifacts_root = state_root.join("artifacts");
        let raw_root = artifacts_root.join("raw");
        create_protected_directory(&artifacts_root)?;
        create_protected_directory(&raw_root)?;
        Ok(Self {
            raw_root,
            audit,
            issued_executions: Mutex::new(HashSet::new()),
        })
    }

    pub fn create(
        &self,
        request_id: &str,
        operation_id: &str,
        execution_id: &str,
        media_type: &str,
    ) -> Result<RawSpoolWriter, RawSpoolError> {
        validate_execution_id(execution_id)?;
        validate_media_type(media_type)?;

        let mut issued = self
            .issued_executions
            .lock()
            .map_err(|_| RawSpoolError::SynchronizationFailed)?;
        if issued.contains(execution_id) {
            return Err(RawSpoolError::DuplicateExecution);
        }

        let audit_context = AuditContext {
            request_id: request_id.to_owned(),
            operation_id: operation_id.to_owned(),
            capability_id: None,
            action: AuditAction::ArtifactSpoolCreate,
        };
        self.audit
            .decision(
                &audit_context,
                AuditDecision::Allow,
                AuditReason::RequestValidated,
            )
            .map_err(|_| RawSpoolError::AuditUnavailable)?;

        let (artifact_id, file) = match self.create_file() {
            Ok(opened) => opened,
            Err(error) => {
                self.audit
                    .outcome(&audit_context, AuditOutcome::Failed)
                    .map_err(|_| RawSpoolError::AuditUnavailable)?;
                return Err(error);
            }
        };

        self.audit
            .outcome(&audit_context, AuditOutcome::Success)
            .map_err(|_| RawSpoolError::AuditUnavailable)?;
        issued.insert(execution_id.to_owned());

        Ok(RawSpoolWriter {
            file,
            metadata: RawSpoolMetadata {
                schema_version: 1,
                artifact_id,
                media_type: media_type.to_owned(),
                bytes_written: 0,
                source_truncated: false,
            },
        })
    }

    fn create_file(&self) -> Result<(String, File), RawSpoolError> {
        for _ in 0..8 {
            let artifact_id = next_artifact_id();
            let path = self.raw_root.join(&artifact_id);
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)
            {
                Ok(file) => {
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
                    return Ok((artifact_id, file));
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(RawSpoolError::Io(error)),
            }
        }
        Err(RawSpoolError::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "raw spool artifact id collision",
        )))
    }
}

#[derive(Debug)]
pub struct RawSpoolWriter {
    file: File,
    metadata: RawSpoolMetadata,
}

impl RawSpoolWriter {
    pub fn write_source(&mut self, source: &[u8]) -> Result<usize, RawSpoolError> {
        let remaining = RAW_SPOOL_SOURCE_CAP_BYTES.saturating_sub(self.metadata.bytes_written);
        let accepted = remaining.min(source.len() as u64) as usize;
        if accepted < source.len() {
            self.metadata.source_truncated = true;
        }
        if accepted == 0 {
            return Ok(0);
        }
        self.file.write_all(&source[..accepted])?;
        self.metadata.bytes_written += accepted as u64;
        Ok(accepted)
    }

    pub fn bytes_written(&self) -> u64 {
        self.metadata.bytes_written
    }

    pub fn finish(self) -> Result<RawSpoolMetadata, RawSpoolError> {
        self.file.sync_all()?;
        Ok(self.metadata)
    }
}

fn create_protected_directory(path: &Path) -> Result<(), RawSpoolError> {
    fs::create_dir_all(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn validate_execution_id(execution_id: &str) -> Result<(), RawSpoolError> {
    let Some(suffix) = execution_id.strip_prefix("ex_") else {
        return Err(RawSpoolError::InvalidExecutionId);
    };
    if suffix.is_empty()
        || execution_id.len() > 96
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(RawSpoolError::InvalidExecutionId);
    }
    Ok(())
}

fn validate_media_type(media_type: &str) -> Result<(), RawSpoolError> {
    if media_type.is_empty()
        || media_type.len() > 255
        || !media_type.is_ascii()
        || media_type.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(RawSpoolError::InvalidMediaType);
    }
    Ok(())
}

fn next_artifact_id() -> String {
    let sequence = NEXT_ARTIFACT_ID.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("ka_{timestamp:x}_{sequence:x}")
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::Value;

    use super::{RAW_SPOOL_SOURCE_CAP_BYTES, RawSpoolError, RawSpoolStore};
    use crate::audit::{AuditFaults, AuditSink};

    fn temporary_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let root = std::env::temp_dir().join(format!(
            "kodegpt-spool-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temporary root created");
        root
    }

    fn store(root: &Path) -> RawSpoolStore {
        RawSpoolStore::open(root, Arc::new(AuditSink::open(root))).expect("spool store opens")
    }

    #[test]
    fn opaque_metadata_never_serializes_the_raw_host_path() {
        let root = temporary_root("opaque");
        let store = store(&root);
        let mut writer = store
            .create(
                "req_spool_opaque",
                "op_spool_opaque",
                "ex_private",
                "text/plain",
            )
            .expect("spool writer created");
        writer.write_source(b"hello\n").expect("source written");
        let metadata = writer.finish().expect("spool finished");

        assert!(metadata.artifact_id.starts_with("ka_"));
        assert!(!metadata.artifact_id.contains('/'));
        assert!(!metadata.artifact_id.contains(".."));
        let serialized = serde_json::to_value(&metadata).expect("metadata serializes");
        let object = serialized.as_object().expect("metadata object");
        assert_eq!(object.get("schemaVersion"), Some(&Value::from(1)));
        assert_eq!(object.get("mediaType"), Some(&Value::from("text/plain")));
        assert_eq!(object.get("bytesWritten"), Some(&Value::from(6)));
        assert_eq!(object.get("sourceTruncated"), Some(&Value::from(false)));
        assert!(!object.contains_key("path"));
        assert!(!object.contains_key("rawPath"));
        assert!(
            !serialized
                .to_string()
                .contains(root.to_string_lossy().as_ref())
        );

        let spool_root = root.join("artifacts/raw");
        assert_eq!(
            fs::metadata(&spool_root)
                .expect("spool root metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        let spool_file = spool_root.join(&metadata.artifact_id);
        assert_eq!(
            fs::metadata(&spool_file)
                .expect("spool file metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(fs::read(spool_file).expect("spool contents"), b"hello\n");

        fs::remove_dir_all(root).expect("temporary root removed");
    }

    #[test]
    fn combined_source_cap_is_exact_and_truncation_is_deterministic() {
        let root = temporary_root("cap");
        let store = store(&root);
        let mut writer = store
            .create(
                "req_spool_cap",
                "op_spool_cap",
                "ex_cap",
                "application/octet-stream",
            )
            .expect("spool writer created");
        let chunk = vec![b'x'; 1024 * 1024];
        for _ in 0..64 {
            assert_eq!(
                writer.write_source(&chunk).expect("chunk written"),
                chunk.len()
            );
        }
        assert_eq!(writer.bytes_written(), RAW_SPOOL_SOURCE_CAP_BYTES);
        assert_eq!(
            writer.write_source(b"overflow").expect("overflow handled"),
            0
        );
        let metadata = writer.finish().expect("spool finished");
        assert_eq!(metadata.bytes_written, RAW_SPOOL_SOURCE_CAP_BYTES);
        assert!(metadata.source_truncated);
        assert_eq!(
            fs::metadata(root.join("artifacts/raw").join(&metadata.artifact_id))
                .expect("spool metadata")
                .len(),
            RAW_SPOOL_SOURCE_CAP_BYTES
        );
        assert!(matches!(
            store.create("req_spool_cap_2", "op_spool_cap_2", "ex_cap", "text/plain"),
            Err(RawSpoolError::DuplicateExecution)
        ));

        fs::remove_dir_all(root).expect("temporary root removed");
    }

    #[test]
    fn creation_is_audited_without_output_bytes_and_failure_gets_failed_outcome() {
        let root = temporary_root("audit");
        let audit = Arc::new(AuditSink::open(&root));
        let store = RawSpoolStore::open(&root, Arc::clone(&audit)).expect("spool store opens");
        let secret = b"RAW_OUTPUT_MUST_NOT_ENTER_AUDIT";
        let mut writer = store
            .create(
                "req_spool_audit",
                "op_spool_audit",
                "ex_audit",
                "text/plain",
            )
            .expect("spool writer created");
        writer.write_source(secret).expect("secret spooled");
        writer.finish().expect("spool finished");

        let audit_path = root.join("logs/security/audit.jsonl");
        let success_audit = fs::read_to_string(&audit_path).expect("audit readable");
        assert!(success_audit.contains("artifact_spool_create"));
        assert!(!success_audit.contains(std::str::from_utf8(secret).expect("secret utf8")));

        let raw_root = root.join("artifacts/raw");
        fs::remove_dir_all(&raw_root).expect("raw root removed");
        fs::write(&raw_root, b"not-a-directory").expect("raw root sabotaged");
        assert!(
            store
                .create("req_spool_fail", "op_spool_fail", "ex_fail", "text/plain")
                .is_err()
        );
        let failed_audit = fs::read_to_string(&audit_path).expect("audit readable after failure");
        let failed_lines = failed_audit
            .lines()
            .filter(|line| line.contains("op_spool_fail"))
            .collect::<Vec<_>>();
        assert_eq!(failed_lines.len(), 2);
        assert!(failed_lines[0].contains("\"phase\":\"decision\""));
        assert!(failed_lines[1].contains("\"outcome\":\"failed\""));
        assert!(!failed_audit.contains(std::str::from_utf8(secret).expect("secret utf8")));

        fs::remove_file(raw_root).expect("sabotage removed");
        fs::remove_dir_all(root).expect("temporary root removed");
    }

    #[test]
    fn audit_decision_failure_blocks_artifact_creation() {
        let root = temporary_root("audit-decision-fail");
        let audit = Arc::new(AuditSink::open_with_faults(
            &root,
            AuditFaults {
                fail_next_decision: true,
                ..AuditFaults::default()
            },
        ));
        let store = RawSpoolStore::open(&root, audit).expect("spool store opens");

        assert!(matches!(
            store.create(
                "req_spool_audit_fail",
                "op_spool_audit_fail",
                "ex_audit_fail",
                "text/plain",
            ),
            Err(RawSpoolError::AuditUnavailable)
        ));
        assert_eq!(
            fs::read_dir(root.join("artifacts/raw"))
                .expect("raw root readable")
                .count(),
            0
        );

        fs::remove_dir_all(root).expect("temporary root removed");
    }

    #[test]
    fn runtime_artifact_schema_is_closed_and_has_no_host_path_field() {
        let schema_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../schemas/runtime/artifact.schema.json");
        let schema: Value = serde_json::from_slice(&fs::read(schema_path).expect("schema exists"))
            .expect("schema parses");
        assert_eq!(schema["additionalProperties"], Value::Bool(false));
        let properties = schema["properties"].as_object().expect("schema properties");
        for required in [
            "schemaVersion",
            "artifactId",
            "mediaType",
            "bytesWritten",
            "sourceTruncated",
        ] {
            assert!(properties.contains_key(required), "missing {required}");
        }
        assert!(!properties.contains_key("path"));
        assert!(!properties.contains_key("rawPath"));
        assert!(!properties.contains_key("hostPath"));
    }
}
