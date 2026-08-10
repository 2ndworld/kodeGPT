use std::collections::HashSet;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::Serialize;

use crate::audit::{
    AuditAction, AuditContext, AuditDecision, AuditOutcome, AuditReason, AuditSink,
};

pub const RAW_SPOOL_SOURCE_CAP_BYTES: u64 = 64 * 1024 * 1024;
pub const ARTIFACT_READ_MAX_BYTES: u64 = 1024 * 1024;
pub const ARTIFACT_AGGREGATE_CAP_BYTES: u64 = 1024 * 1024 * 1024;
pub const ARTIFACT_TTL: Duration = Duration::from_secs(24 * 60 * 60);

static NEXT_ARTIFACT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
pub enum RawSpoolError {
    AuditUnavailable,
    DuplicateExecution,
    InvalidExecutionId,
    InvalidArtifactId,
    InvalidMediaType,
    ArtifactNotFound,
    ArtifactNotRegular,
    ReadLimitExceeded,
    QuotaExceeded,
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
            Self::InvalidArtifactId => formatter.write_str("raw spool artifact id is invalid"),
            Self::InvalidMediaType => formatter.write_str("raw spool media type is invalid"),
            Self::ArtifactNotFound => formatter.write_str("raw spool artifact was not found"),
            Self::ArtifactNotRegular => {
                formatter.write_str("raw spool artifact is not a regular file")
            }
            Self::ReadLimitExceeded => {
                formatter.write_str("raw spool read exceeds the bounded read limit")
            }
            Self::QuotaExceeded => formatter.write_str("raw spool aggregate quota is exhausted"),
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReadResult {
    pub schema_version: u32,
    pub data_base64: String,
    pub bytes_read: u64,
    pub next_offset: u64,
    pub eof: bool,
}

#[derive(Debug)]
pub struct RawSpoolStore {
    raw_root: PathBuf,
    audit: Arc<AuditSink>,
    issued_executions: Mutex<HashSet<String>>,
    active_artifacts: Arc<Mutex<HashSet<String>>>,
    maintenance: Mutex<()>,
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
            active_artifacts: Arc::new(Mutex::new(HashSet::new())),
            maintenance: Mutex::new(()),
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
        let _maintenance = self
            .maintenance
            .lock()
            .map_err(|_| RawSpoolError::SynchronizationFailed)?;
        self.enforce_retention(request_id, operation_id)?;

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
        let path = self.raw_root.join(&artifact_id);
        let active_inserted = self
            .active_artifacts
            .lock()
            .map_err(|_| RawSpoolError::SynchronizationFailed)
            .map(|mut active| active.insert(artifact_id.clone()));
        if active_inserted.is_err() {
            let _ = fs::remove_file(&path);
            let _ = self.audit.outcome(&audit_context, AuditOutcome::Failed);
            return Err(RawSpoolError::SynchronizationFailed);
        }

        if self
            .audit
            .outcome(&audit_context, AuditOutcome::Success)
            .is_err()
        {
            if let Ok(mut active) = self.active_artifacts.lock() {
                active.remove(&artifact_id);
            }
            let _ = fs::remove_file(&path);
            return Err(RawSpoolError::AuditUnavailable);
        }
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
            active_artifacts: Arc::clone(&self.active_artifacts),
        })
    }

    pub fn read(
        &self,
        request_id: &str,
        operation_id: &str,
        artifact_id: &str,
        offset: u64,
        max_bytes: u64,
    ) -> Result<ArtifactReadResult, RawSpoolError> {
        validate_artifact_id(artifact_id)?;
        if max_bytes == 0 || max_bytes > ARTIFACT_READ_MAX_BYTES {
            return Err(RawSpoolError::ReadLimitExceeded);
        }
        let context = AuditContext {
            request_id: request_id.to_owned(),
            operation_id: operation_id.to_owned(),
            capability_id: None,
            action: AuditAction::ArtifactRead,
        };
        self.audit
            .decision(
                &context,
                AuditDecision::Allow,
                AuditReason::RequestValidated,
            )
            .map_err(|_| RawSpoolError::AuditUnavailable)?;

        let result = self.read_inner(artifact_id, offset, max_bytes);
        let outcome = if result.is_ok() {
            AuditOutcome::Success
        } else {
            AuditOutcome::Failed
        };
        self.audit
            .outcome(&context, outcome)
            .map_err(|_| RawSpoolError::AuditUnavailable)?;
        result
    }

    fn read_inner(
        &self,
        artifact_id: &str,
        offset: u64,
        max_bytes: u64,
    ) -> Result<ArtifactReadResult, RawSpoolError> {
        let path = self.raw_root.join(artifact_id);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(RawSpoolError::ArtifactNotFound);
            }
            Err(error) => return Err(RawSpoolError::Io(error)),
        };
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(RawSpoolError::ArtifactNotRegular);
        }
        let mut file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(RawSpoolError::ArtifactNotFound);
            }
            Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
                return Err(RawSpoolError::ArtifactNotRegular);
            }
            Err(error) => return Err(RawSpoolError::Io(error)),
        };
        file.seek(SeekFrom::Start(offset))?;
        let mut buffer = vec![0_u8; max_bytes as usize];
        let bytes_read = file.read(&mut buffer)?;
        buffer.truncate(bytes_read);
        let next_offset = offset.saturating_add(bytes_read as u64);
        let eof = next_offset >= file.metadata()?.len();
        Ok(ArtifactReadResult {
            schema_version: 1,
            data_base64: base64::engine::general_purpose::STANDARD.encode(buffer),
            bytes_read: bytes_read as u64,
            next_offset,
            eof,
        })
    }

    fn enforce_retention(&self, request_id: &str, operation_id: &str) -> Result<(), RawSpoolError> {
        let context = AuditContext {
            request_id: request_id.to_owned(),
            operation_id: operation_id.to_owned(),
            capability_id: None,
            action: AuditAction::ArtifactCleanup,
        };
        self.audit
            .decision(
                &context,
                AuditDecision::Allow,
                AuditReason::RequestValidated,
            )
            .map_err(|_| RawSpoolError::AuditUnavailable)?;
        let result = self.enforce_retention_inner();
        let outcome = if result.is_ok() {
            AuditOutcome::Success
        } else {
            AuditOutcome::Failed
        };
        self.audit
            .outcome(&context, outcome)
            .map_err(|_| RawSpoolError::AuditUnavailable)?;
        result
    }

    fn enforce_retention_inner(&self) -> Result<(), RawSpoolError> {
        let active = self
            .active_artifacts
            .lock()
            .map_err(|_| RawSpoolError::SynchronizationFailed)?
            .clone();
        let now = SystemTime::now();
        let mut completed = Vec::new();
        let mut completed_bytes = 0_u64;
        for entry in fs::read_dir(&self.raw_root)? {
            let entry = entry?;
            let name = match entry.file_name().to_str() {
                Some(name) if validate_artifact_id(name).is_ok() => name.to_owned(),
                _ => continue,
            };
            let metadata = fs::symlink_metadata(entry.path())?;
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                continue;
            }
            let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
            if !active.contains(&name)
                && now.duration_since(modified).unwrap_or_default() >= ARTIFACT_TTL
            {
                fs::remove_file(entry.path())?;
                continue;
            }
            if !active.contains(&name) {
                completed_bytes = completed_bytes.saturating_add(metadata.len());
                completed.push((modified, name, entry.path(), metadata.len()));
            }
        }

        let active_reservation = (active.len() as u64).saturating_mul(RAW_SPOOL_SOURCE_CAP_BYTES);
        let target_before_new =
            ARTIFACT_AGGREGATE_CAP_BYTES.saturating_sub(RAW_SPOOL_SOURCE_CAP_BYTES);
        completed.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
        let mut projected = completed_bytes.saturating_add(active_reservation);
        for (_, _, path, bytes) in completed {
            if projected <= target_before_new {
                break;
            }
            fs::remove_file(path)?;
            projected = projected.saturating_sub(bytes);
        }
        if projected > target_before_new {
            return Err(RawSpoolError::QuotaExceeded);
        }
        Ok(())
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
    active_artifacts: Arc<Mutex<HashSet<String>>>,
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

    pub fn metadata(&self) -> RawSpoolMetadata {
        self.metadata.clone()
    }

    pub fn finish(self) -> Result<RawSpoolMetadata, RawSpoolError> {
        self.file.sync_all()?;
        Ok(self.metadata.clone())
    }
}

impl Drop for RawSpoolWriter {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active_artifacts.lock() {
            active.remove(&self.metadata.artifact_id);
        }
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

fn validate_artifact_id(artifact_id: &str) -> Result<(), RawSpoolError> {
    let Some(suffix) = artifact_id.strip_prefix("ka_") else {
        return Err(RawSpoolError::InvalidArtifactId);
    };
    if suffix.is_empty()
        || artifact_id.len() > 96
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(RawSpoolError::InvalidArtifactId);
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
    use std::fs::{self, FileTimes, OpenOptions};
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use base64::Engine as _;
    use serde_json::Value;

    use super::{
        ARTIFACT_READ_MAX_BYTES, ARTIFACT_TTL, RAW_SPOOL_SOURCE_CAP_BYTES, RawSpoolError,
        RawSpoolStore,
    };
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
    fn bounded_reads_use_offsets_reject_symlinks_and_audit_without_content() {
        let root = temporary_root("read");
        let store = store(&root);
        let mut writer = store
            .create("req_read_create", "op_read_create", "ex_read", "text/plain")
            .expect("spool writer created");
        writer.write_source(b"abcdef").expect("source written");
        let metadata = writer.finish().expect("spool finished");

        let first = store
            .read("req_read_1", "op_read_1", &metadata.artifact_id, 2, 2)
            .expect("bounded read");
        assert_eq!(first.bytes_read, 2);
        assert_eq!(first.next_offset, 4);
        assert!(!first.eof);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(first.data_base64)
                .expect("base64"),
            b"cd"
        );
        let second = store
            .read("req_read_2", "op_read_2", &metadata.artifact_id, 4, 2)
            .expect("tail read");
        assert_eq!(second.next_offset, 6);
        assert!(second.eof);
        assert!(matches!(
            store.read(
                "req_read_limit",
                "op_read_limit",
                &metadata.artifact_id,
                0,
                ARTIFACT_READ_MAX_BYTES + 1,
            ),
            Err(RawSpoolError::ReadLimitExceeded)
        ));

        let link = root.join("artifacts/raw/ka_symlink_fixture");
        symlink("/etc/passwd", &link).expect("symlink fixture");
        assert!(matches!(
            store.read(
                "req_read_symlink",
                "op_read_symlink",
                "ka_symlink_fixture",
                0,
                16,
            ),
            Err(RawSpoolError::ArtifactNotRegular)
        ));
        let audit = fs::read_to_string(root.join("logs/security/audit.jsonl")).expect("audit");
        assert!(audit.contains("artifact_read"));
        assert!(!audit.contains("abcdef"));
        assert!(!audit.contains("/etc/passwd"));
        fs::remove_dir_all(root).expect("temporary root removed");
    }

    #[test]
    fn retention_expires_completed_artifacts_and_never_deletes_active_writers() {
        let root = temporary_root("retention");
        let store = store(&root);
        let mut old_writer = store
            .create("req_old", "op_old", "ex_old", "text/plain")
            .expect("old writer");
        old_writer.write_source(b"old").expect("old content");
        let old = old_writer.finish().expect("old finished");
        let old_path = root.join("artifacts/raw").join(&old.artifact_id);
        let old_file = OpenOptions::new()
            .write(true)
            .open(&old_path)
            .expect("old artifact open");
        let expired = SystemTime::now() - ARTIFACT_TTL - Duration::from_secs(1);
        old_file
            .set_times(FileTimes::new().set_modified(expired))
            .expect("old timestamp set");
        drop(old_file);

        let active = store
            .create("req_active", "op_active", "ex_active", "text/plain")
            .expect("active writer");
        let active_path = root
            .join("artifacts/raw")
            .join(active.metadata().artifact_id);
        assert!(
            !old_path.exists(),
            "expired completed artifact must be cleaned"
        );
        assert!(active_path.exists(), "active writer must never be deleted");

        let mut writers = vec![active];
        for index in 0..15 {
            writers.push(
                store
                    .create(
                        &format!("req_quota_{index}"),
                        &format!("op_quota_{index}"),
                        &format!("ex_quota_{index}"),
                        "text/plain",
                    )
                    .expect("active reservation within aggregate quota"),
            );
        }
        assert!(matches!(
            store.create(
                "req_quota_over",
                "op_quota_over",
                "ex_quota_over",
                "text/plain",
            ),
            Err(RawSpoolError::QuotaExceeded)
        ));
        assert!(
            active_path.exists(),
            "quota cleanup must not delete active writer"
        );
        writers.pop();
        store
            .create(
                "req_quota_recover",
                "op_quota_recover",
                "ex_quota_recover",
                "text/plain",
            )
            .expect("released reservation permits another writer");
        drop(writers);

        let audit = fs::read_to_string(root.join("logs/security/audit.jsonl")).expect("audit");
        assert!(audit.contains("artifact_cleanup"));
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
