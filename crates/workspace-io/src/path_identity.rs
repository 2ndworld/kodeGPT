use std::fmt;
use std::fs::File;
use std::io::Read;
use std::os::fd::OwnedFd;
use std::path::Path;

use rustix::fs::{FileType, OFlags, fstat, readlinkat};
use rustix::io::Errno;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::openat::{OpenatBoundaryError, open_existing_beneath, open_parent_beneath};

pub const PATH_IDENTITY_MAX_HASH_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PathIdentityKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathIdentityResult {
    pub schema_version: u32,
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<PathIdentityKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    pub hash_truncated: bool,
}

impl PathIdentityResult {
    fn missing() -> Self {
        Self {
            schema_version: 1,
            exists: false,
            kind: None,
            size_bytes: None,
            sha256: None,
            hash_truncated: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathIdentityError {
    InvalidPath,
    BoundaryUnavailable,
    BoundaryViolation,
    ChangedDuringInspection,
    Io(Errno),
}

impl fmt::Display for PathIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath => formatter.write_str("workspace path is invalid"),
            Self::BoundaryUnavailable => formatter.write_str("filesystem boundary is unavailable"),
            Self::BoundaryViolation => formatter.write_str("workspace filesystem boundary denied access"),
            Self::ChangedDuringInspection => formatter.write_str("workspace path changed during inspection"),
            Self::Io(error) => write!(formatter, "workspace path identity failed: {error}"),
        }
    }
}

impl std::error::Error for PathIdentityError {}

pub fn path_identity_beneath(
    root_fd: &OwnedFd,
    relative_path: &Path,
    include_sha256: bool,
) -> Result<PathIdentityResult, PathIdentityError> {
    let metadata_fd = match open_existing_beneath(
        root_fd,
        relative_path,
        OFlags::PATH | OFlags::NOFOLLOW,
    ) {
        Ok(fd) => fd,
        Err(OpenatBoundaryError::NotFound) => return Ok(PathIdentityResult::missing()),
        Err(error) => return Err(map_boundary_error(error)),
    };
    let stat = fstat(&metadata_fd).map_err(PathIdentityError::Io)?;
    let kind = kind_from_mode(stat.st_mode);
    let size_bytes = nonnegative_size(stat.st_size)?;

    if !include_sha256 {
        return Ok(PathIdentityResult {
            schema_version: 1,
            exists: true,
            kind: Some(kind),
            size_bytes: Some(size_bytes),
            sha256: None,
            hash_truncated: false,
        });
    }

    match kind {
        PathIdentityKind::File => hash_regular_file(root_fd, relative_path),
        PathIdentityKind::Symlink => {
            let parent = open_parent_beneath(root_fd, relative_path).map_err(map_boundary_error)?;
            let target = readlinkat(parent.parent_fd(), parent.leaf_name(), Vec::new())
                .map_err(PathIdentityError::Io)?;
            let target_bytes = target.as_bytes();
            let hash_truncated = target_bytes.len() as u64 > PATH_IDENTITY_MAX_HASH_BYTES;
            Ok(PathIdentityResult {
                schema_version: 1,
                exists: true,
                kind: Some(PathIdentityKind::Symlink),
                size_bytes: Some(size_bytes),
                sha256: (!hash_truncated).then(|| sha256_hex(target_bytes)),
                hash_truncated,
            })
        }
        PathIdentityKind::Directory | PathIdentityKind::Other => Ok(PathIdentityResult {
            schema_version: 1,
            exists: true,
            kind: Some(kind),
            size_bytes: Some(size_bytes),
            sha256: None,
            hash_truncated: false,
        }),
    }
}

fn hash_regular_file(
    root_fd: &OwnedFd,
    relative_path: &Path,
) -> Result<PathIdentityResult, PathIdentityError> {
    let fd = open_existing_beneath(
        root_fd,
        relative_path,
        OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW,
    )
    .map_err(map_boundary_error)?;
    let stat = fstat(&fd).map_err(PathIdentityError::Io)?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(PathIdentityError::ChangedDuringInspection);
    }
    let size_bytes = nonnegative_size(stat.st_size)?;
    if size_bytes > PATH_IDENTITY_MAX_HASH_BYTES {
        return Ok(PathIdentityResult {
            schema_version: 1,
            exists: true,
            kind: Some(PathIdentityKind::File),
            size_bytes: Some(size_bytes),
            sha256: None,
            hash_truncated: true,
        });
    }

    let mut file = File::from(fd);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let read = file.read(&mut buffer).map_err(io_error)?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        if total > PATH_IDENTITY_MAX_HASH_BYTES {
            return Ok(PathIdentityResult {
                schema_version: 1,
                exists: true,
                kind: Some(PathIdentityKind::File),
                size_bytes: Some(total),
                sha256: None,
                hash_truncated: true,
            });
        }
        hasher.update(&buffer[..read]);
    }

    Ok(PathIdentityResult {
        schema_version: 1,
        exists: true,
        kind: Some(PathIdentityKind::File),
        size_bytes: Some(total),
        sha256: Some(format!("{:x}", hasher.finalize())),
        hash_truncated: false,
    })
}

fn kind_from_mode(mode: u32) -> PathIdentityKind {
    match FileType::from_raw_mode(mode) {
        FileType::RegularFile => PathIdentityKind::File,
        FileType::Directory => PathIdentityKind::Directory,
        FileType::Symlink => PathIdentityKind::Symlink,
        _ => PathIdentityKind::Other,
    }
}

fn nonnegative_size(size: i64) -> Result<u64, PathIdentityError> {
    u64::try_from(size).map_err(|_| PathIdentityError::ChangedDuringInspection)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn map_boundary_error(error: OpenatBoundaryError) -> PathIdentityError {
    match error {
        OpenatBoundaryError::InvalidRelativePath => PathIdentityError::InvalidPath,
        OpenatBoundaryError::BoundaryUnavailable => PathIdentityError::BoundaryUnavailable,
        OpenatBoundaryError::BoundaryViolation => PathIdentityError::BoundaryViolation,
        OpenatBoundaryError::NotFound => PathIdentityError::ChangedDuringInspection,
        OpenatBoundaryError::Os(error) => PathIdentityError::Io(error),
    }
}

fn io_error(error: std::io::Error) -> PathIdentityError {
    error
        .raw_os_error()
        .map(|code| PathIdentityError::Io(Errno::from_raw_os_error(code)))
        .unwrap_or(PathIdentityError::Io(Errno::IO))
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};
    use std::os::fd::OwnedFd;
    use std::os::unix::fs::symlink;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{PATH_IDENTITY_MAX_HASH_BYTES, PathIdentityError, PathIdentityKind, path_identity_beneath};

    fn temporary_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "kodegpt-path-identity-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temporary root created");
        root
    }

    fn root_fd(path: &Path) -> OwnedFd {
        File::open(path).expect("root directory opens").into()
    }

    #[test]
    fn path_identity_reports_regular_missing_directory_and_hash() {
        let root = temporary_root("basic");
        fs::write(root.join("file.txt"), b"hello identity\n").expect("file written");
        fs::create_dir(root.join("dir")).expect("directory created");
        let fd = root_fd(&root);

        let metadata = path_identity_beneath(&fd, Path::new("file.txt"), false)
            .expect("metadata identity succeeds");
        assert!(metadata.exists);
        assert_eq!(metadata.kind, Some(PathIdentityKind::File));
        assert_eq!(metadata.size_bytes, Some(15));
        assert_eq!(metadata.sha256, None);
        assert!(!metadata.hash_truncated);

        let hashed = path_identity_beneath(&fd, Path::new("file.txt"), true)
            .expect("hashed identity succeeds");
        assert_eq!(
            hashed.sha256.as_deref(),
            Some("5b4681ab889e2e40814e61140105a0e76d759306fb136f777cc0bd10237050ce")
        );
        assert!(!hashed.hash_truncated);

        let directory = path_identity_beneath(&fd, Path::new("dir"), true)
            .expect("directory identity succeeds");
        assert!(directory.exists);
        assert_eq!(directory.kind, Some(PathIdentityKind::Directory));
        assert_eq!(directory.sha256, None);
        assert!(!directory.hash_truncated);

        let missing = path_identity_beneath(&fd, Path::new("missing.txt"), true)
            .expect("missing identity succeeds");
        assert!(!missing.exists);
        assert_eq!(missing.kind, None);
        assert_eq!(missing.size_bytes, None);
        assert_eq!(missing.sha256, None);
        assert!(!missing.hash_truncated);

        fs::remove_dir_all(root).expect("root removed");
    }

    #[test]
    fn path_identity_hashes_symlink_target_bytes_without_following() {
        let root = temporary_root("symlink");
        let outside = temporary_root("outside");
        fs::write(outside.join("secret.txt"), b"outside secret").expect("outside file written");
        symlink(outside.join("secret.txt"), root.join("link")).expect("symlink created");
        let fd = root_fd(&root);

        let identity = path_identity_beneath(&fd, Path::new("link"), true)
            .expect("symlink identity succeeds");
        assert_eq!(identity.kind, Some(PathIdentityKind::Symlink));
        let expected_target = outside.join("secret.txt");
        let expected = sha256_hex(expected_target.as_os_str().as_encoded_bytes());
        assert_eq!(identity.sha256.as_deref(), Some(expected.as_str()));
        assert_ne!(identity.sha256.as_deref(), Some(sha256_hex(b"outside secret").as_str()));

        fs::remove_dir_all(root).expect("root removed");
        fs::remove_dir_all(outside).expect("outside removed");
    }

    #[test]
    fn path_identity_rejects_escape_and_refuses_oversized_hash() {
        let root = temporary_root("bounds");
        let oversized = File::create(root.join("oversized.bin")).expect("oversized file created");
        oversized
            .set_len(PATH_IDENTITY_MAX_HASH_BYTES + 1)
            .expect("oversized file sized");
        let fd = root_fd(&root);

        let identity = path_identity_beneath(&fd, Path::new("oversized.bin"), true)
            .expect("oversized identity succeeds");
        assert_eq!(identity.kind, Some(PathIdentityKind::File));
        assert_eq!(identity.sha256, None);
        assert!(identity.hash_truncated);

        assert!(matches!(
            path_identity_beneath(&fd, Path::new("../escape"), false),
            Err(PathIdentityError::InvalidPath)
        ));
        assert!(matches!(
            path_identity_beneath(&fd, Path::new("/absolute"), false),
            Err(PathIdentityError::InvalidPath)
        ));

        fs::remove_dir_all(root).expect("root removed");
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(bytes))
    }
}
