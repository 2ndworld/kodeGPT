use std::ffi::OsString;
use std::fmt;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStringExt;
use std::path::Path;

use getrandom::fill as fill_random;
use rustix::fs::{
    AtFlags, FileType, Mode, OFlags, RenameFlags, fchmod, fstat, fsync, openat, renameat,
    renameat_with, statat, unlinkat,
};
use rustix::io::Errno;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::openat::{OpenatBoundaryError, open_existing_beneath, open_parent_beneath};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceWriteError {
    InvalidPath,
    BoundaryUnavailable,
    BoundaryViolation,
    NotFound,
    NotRegularFile,
    InvalidUtf8,
    Conflict,
    PreconditionFailed,
    TargetExists,
    Io(Errno),
}

impl fmt::Display for WorkspaceWriteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath => formatter.write_str("workspace mutation path is invalid"),
            Self::BoundaryUnavailable => {
                formatter.write_str("required filesystem boundary semantics are unavailable")
            }
            Self::BoundaryViolation => {
                formatter.write_str("workspace mutation crossed the retained filesystem boundary")
            }
            Self::NotFound => formatter.write_str("workspace mutation target was not found"),
            Self::NotRegularFile => {
                formatter.write_str("workspace mutation target is not a regular file")
            }
            Self::InvalidUtf8 => formatter.write_str("workspace edit target is not valid UTF-8"),
            Self::Conflict => formatter.write_str("workspace edit replacement count conflict"),
            Self::PreconditionFailed => formatter.write_str("workspace patch precondition failed"),
            Self::TargetExists => {
                formatter.write_str("workspace patch create target already exists")
            }
            Self::Io(error) => write!(formatter, "workspace mutation failed: {error}"),
        }
    }
}

impl std::error::Error for WorkspaceWriteError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileResult {
    pub bytes_written: u64,
    pub created: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditFileResult {
    pub bytes_written: u64,
    pub replacements: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PatchFileAction {
    Create,
    Update,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchFileCommitResult {
    pub schema_version: u32,
    pub action: PatchFileAction,
    pub bytes_written: u64,
    pub sha256: Option<String>,
}

pub fn write_file_atomic_beneath(
    root_fd: &OwnedFd,
    relative_path: &Path,
    contents: &[u8],
) -> Result<WriteFileResult, WorkspaceWriteError> {
    let parent = open_parent_beneath(root_fd, relative_path).map_err(map_boundary_error)?;
    let (created, mode) = destination_mode(parent.parent_fd(), parent.leaf_name())?;
    let (temp_name, temp_fd) = create_random_temp(parent.parent_fd(), mode)?;
    let mut cleanup = true;

    let result = (|| {
        let mut file = File::from(temp_fd);
        file.write_all(contents).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        drop(file);

        revalidate_destination(parent.parent_fd(), parent.leaf_name(), created)?;
        renameat(
            parent.parent_fd(),
            temp_name.as_os_str(),
            parent.parent_fd(),
            parent.leaf_name(),
        )
        .map_err(WorkspaceWriteError::Io)?;
        cleanup = false;
        fsync(parent.parent_fd()).map_err(WorkspaceWriteError::Io)?;
        Ok(WriteFileResult {
            bytes_written: contents.len() as u64,
            created,
        })
    })();

    if cleanup {
        let _ = unlinkat(parent.parent_fd(), temp_name.as_os_str(), AtFlags::empty());
    }
    result
}

pub fn edit_file_exact_beneath(
    root_fd: &OwnedFd,
    relative_path: &Path,
    old_text: &str,
    new_text: &str,
    expected_replacements: u64,
) -> Result<EditFileResult, WorkspaceWriteError> {
    if old_text.is_empty() {
        return Err(WorkspaceWriteError::Conflict);
    }
    let fd = open_existing_beneath(
        root_fd,
        relative_path,
        OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW,
    )
    .map_err(map_boundary_error)?;
    let stat = fstat(&fd).map_err(WorkspaceWriteError::Io)?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(WorkspaceWriteError::NotRegularFile);
    }

    let mut bytes = Vec::new();
    File::from(fd).read_to_end(&mut bytes).map_err(io_error)?;
    let text = String::from_utf8(bytes).map_err(|_| WorkspaceWriteError::InvalidUtf8)?;
    let replacements = text.matches(old_text).count() as u64;
    if replacements != expected_replacements {
        return Err(WorkspaceWriteError::Conflict);
    }
    let next = text.replace(old_text, new_text);
    let result = write_file_atomic_beneath(root_fd, relative_path, next.as_bytes())?;
    Ok(EditFileResult {
        bytes_written: result.bytes_written,
        replacements,
    })
}

pub fn commit_patch_file_beneath(
    root_fd: &OwnedFd,
    relative_path: &Path,
    action: PatchFileAction,
    expected_sha256: Option<&str>,
    content: Option<&[u8]>,
) -> Result<PatchFileCommitResult, WorkspaceWriteError> {
    match action {
        PatchFileAction::Create => {
            if expected_sha256.is_some() || content.is_none() {
                return Err(WorkspaceWriteError::PreconditionFailed);
            }
            commit_patch_create(
                root_fd,
                relative_path,
                content.expect("validated create content"),
            )
        }
        PatchFileAction::Update => {
            let expected = expected_sha256.ok_or(WorkspaceWriteError::PreconditionFailed)?;
            let content = content.ok_or(WorkspaceWriteError::PreconditionFailed)?;
            if !is_sha256_hex(expected) {
                return Err(WorkspaceWriteError::PreconditionFailed);
            }
            commit_patch_update(root_fd, relative_path, expected, content)
        }
        PatchFileAction::Delete => {
            let expected = expected_sha256.ok_or(WorkspaceWriteError::PreconditionFailed)?;
            if content.is_some() || !is_sha256_hex(expected) {
                return Err(WorkspaceWriteError::PreconditionFailed);
            }
            commit_patch_delete(root_fd, relative_path, expected)
        }
    }
}

fn commit_patch_create(
    root_fd: &OwnedFd,
    relative_path: &Path,
    contents: &[u8],
) -> Result<PatchFileCommitResult, WorkspaceWriteError> {
    let parent = open_parent_beneath(root_fd, relative_path).map_err(map_boundary_error)?;
    let (temp_name, temp_fd) = create_random_temp(parent.parent_fd(), Mode::RUSR | Mode::WUSR)?;
    let mut cleanup = true;
    let result = (|| {
        let mut file = File::from(temp_fd);
        file.write_all(contents).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        drop(file);
        match renameat_with(
            parent.parent_fd(),
            temp_name.as_os_str(),
            parent.parent_fd(),
            parent.leaf_name(),
            RenameFlags::NOREPLACE,
        ) {
            Ok(()) => {}
            Err(Errno::EXIST) => return Err(WorkspaceWriteError::TargetExists),
            Err(error) => return Err(WorkspaceWriteError::Io(error)),
        }
        cleanup = false;
        fsync(parent.parent_fd()).map_err(WorkspaceWriteError::Io)?;
        Ok(PatchFileCommitResult {
            schema_version: 1,
            action: PatchFileAction::Create,
            bytes_written: contents.len() as u64,
            sha256: Some(sha256_hex(contents)),
        })
    })();
    if cleanup {
        let _ = unlinkat(parent.parent_fd(), temp_name.as_os_str(), AtFlags::empty());
    }
    result
}

fn commit_patch_update(
    root_fd: &OwnedFd,
    relative_path: &Path,
    expected_sha256: &str,
    contents: &[u8],
) -> Result<PatchFileCommitResult, WorkspaceWriteError> {
    let parent = open_parent_beneath(root_fd, relative_path).map_err(map_boundary_error)?;
    verify_patch_target(parent.parent_fd(), parent.leaf_name(), expected_sha256)?;
    let (temp_name, temp_fd) = create_random_temp(parent.parent_fd(), Mode::RUSR | Mode::WUSR)?;
    let mut cleanup = true;
    let result = (|| {
        let mut file = File::from(temp_fd);
        file.write_all(contents).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;

        let mode = verify_patch_target(parent.parent_fd(), parent.leaf_name(), expected_sha256)?;
        fchmod(&file, mode).map_err(WorkspaceWriteError::Io)?;
        file.sync_all().map_err(io_error)?;
        drop(file);

        renameat(
            parent.parent_fd(),
            temp_name.as_os_str(),
            parent.parent_fd(),
            parent.leaf_name(),
        )
        .map_err(WorkspaceWriteError::Io)?;
        cleanup = false;
        fsync(parent.parent_fd()).map_err(WorkspaceWriteError::Io)?;
        Ok(PatchFileCommitResult {
            schema_version: 1,
            action: PatchFileAction::Update,
            bytes_written: contents.len() as u64,
            sha256: Some(sha256_hex(contents)),
        })
    })();
    if cleanup {
        let _ = unlinkat(parent.parent_fd(), temp_name.as_os_str(), AtFlags::empty());
    }
    result
}

fn commit_patch_delete(
    root_fd: &OwnedFd,
    relative_path: &Path,
    expected_sha256: &str,
) -> Result<PatchFileCommitResult, WorkspaceWriteError> {
    let parent = open_parent_beneath(root_fd, relative_path).map_err(map_boundary_error)?;
    verify_patch_target(parent.parent_fd(), parent.leaf_name(), expected_sha256)?;
    unlinkat(parent.parent_fd(), parent.leaf_name(), AtFlags::empty()).map_err(
        |error| match error {
            Errno::NOENT => WorkspaceWriteError::PreconditionFailed,
            error => WorkspaceWriteError::Io(error),
        },
    )?;
    fsync(parent.parent_fd()).map_err(WorkspaceWriteError::Io)?;
    Ok(PatchFileCommitResult {
        schema_version: 1,
        action: PatchFileAction::Delete,
        bytes_written: 0,
        sha256: None,
    })
}

fn verify_patch_target(
    parent_fd: std::os::fd::BorrowedFd<'_>,
    leaf_name: &std::ffi::OsStr,
    expected_sha256: &str,
) -> Result<Mode, WorkspaceWriteError> {
    let fd = openat(
        parent_fd,
        leaf_name,
        OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| match error {
        Errno::NOENT => WorkspaceWriteError::NotFound,
        Errno::LOOP => WorkspaceWriteError::BoundaryViolation,
        error => WorkspaceWriteError::Io(error),
    })?;
    let opened_stat = fstat(&fd).map_err(WorkspaceWriteError::Io)?;
    if FileType::from_raw_mode(opened_stat.st_mode) != FileType::RegularFile {
        return Err(WorkspaceWriteError::NotRegularFile);
    }
    let mut bytes = Vec::new();
    File::from(fd).read_to_end(&mut bytes).map_err(io_error)?;
    std::str::from_utf8(&bytes).map_err(|_| WorkspaceWriteError::InvalidUtf8)?;
    if sha256_hex(&bytes) != expected_sha256 {
        return Err(WorkspaceWriteError::PreconditionFailed);
    }

    let current_stat =
        statat(parent_fd, leaf_name, AtFlags::SYMLINK_NOFOLLOW).map_err(|error| {
            if error == Errno::NOENT {
                WorkspaceWriteError::PreconditionFailed
            } else {
                WorkspaceWriteError::Io(error)
            }
        })?;
    if FileType::from_raw_mode(current_stat.st_mode) != FileType::RegularFile
        || current_stat.st_dev != opened_stat.st_dev
        || current_stat.st_ino != opened_stat.st_ino
    {
        return Err(WorkspaceWriteError::PreconditionFailed);
    }
    Ok(Mode::from_bits_truncate(
        (current_stat.st_mode & 0o777) as _,
    ))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn destination_mode(
    parent_fd: std::os::fd::BorrowedFd<'_>,
    leaf_name: &std::ffi::OsStr,
) -> Result<(bool, Mode), WorkspaceWriteError> {
    match statat(parent_fd, leaf_name, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) => {
            if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
                return Err(WorkspaceWriteError::BoundaryViolation);
            }
            Ok((false, Mode::from_bits_truncate((stat.st_mode & 0o777) as _)))
        }
        Err(Errno::NOENT) => Ok((true, Mode::RUSR | Mode::WUSR)),
        Err(error) => Err(WorkspaceWriteError::Io(error)),
    }
}

fn revalidate_destination(
    parent_fd: std::os::fd::BorrowedFd<'_>,
    leaf_name: &std::ffi::OsStr,
    created: bool,
) -> Result<(), WorkspaceWriteError> {
    match statat(parent_fd, leaf_name, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) => {
            if created || FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
                return Err(WorkspaceWriteError::BoundaryViolation);
            }
            Ok(())
        }
        Err(Errno::NOENT) if created => Ok(()),
        Err(Errno::NOENT) => Err(WorkspaceWriteError::NotFound),
        Err(error) => Err(WorkspaceWriteError::Io(error)),
    }
}

fn create_random_temp(
    parent_fd: std::os::fd::BorrowedFd<'_>,
    mode: Mode,
) -> Result<(OsString, OwnedFd), WorkspaceWriteError> {
    for _ in 0..16 {
        let mut random = [0u8; 16];
        fill_random(&mut random).map_err(|_| WorkspaceWriteError::Io(Errno::IO))?;
        let mut bytes = b".kodegpt-tmp-".to_vec();
        for byte in random {
            bytes.extend_from_slice(format!("{byte:02x}").as_bytes());
        }
        let name = OsString::from_vec(bytes);
        match openat(
            parent_fd,
            name.as_os_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR,
        ) {
            Ok(fd) => {
                fchmod(&fd, mode).map_err(WorkspaceWriteError::Io)?;
                return Ok((name, fd));
            }
            Err(Errno::EXIST) => continue,
            Err(error) => return Err(WorkspaceWriteError::Io(error)),
        }
    }
    Err(WorkspaceWriteError::Io(Errno::EXIST))
}

fn map_boundary_error(error: OpenatBoundaryError) -> WorkspaceWriteError {
    match error {
        OpenatBoundaryError::InvalidRelativePath => WorkspaceWriteError::InvalidPath,
        OpenatBoundaryError::BoundaryUnavailable => WorkspaceWriteError::BoundaryUnavailable,
        OpenatBoundaryError::BoundaryViolation => WorkspaceWriteError::BoundaryViolation,
        OpenatBoundaryError::NotFound => WorkspaceWriteError::NotFound,
        OpenatBoundaryError::Os(error) => WorkspaceWriteError::Io(error),
    }
}

fn io_error(error: std::io::Error) -> WorkspaceWriteError {
    error
        .raw_os_error()
        .map(|code| WorkspaceWriteError::Io(Errno::from_raw_os_error(code)))
        .unwrap_or(WorkspaceWriteError::Io(Errno::IO))
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};
    use std::os::fd::OwnedFd;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    use sha2::{Digest, Sha256};

    use super::{
        PatchFileAction, WorkspaceWriteError, commit_patch_file_beneath, edit_file_exact_beneath,
        write_file_atomic_beneath,
    };

    fn temporary_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "kodegpt-write-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temporary root created");
        root
    }

    fn root_fd(path: &Path) -> OwnedFd {
        File::open(path).expect("root directory opens").into()
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    #[test]
    fn conditional_patch_create_is_no_clobber_and_returns_new_digest() {
        let root = temporary_root("patch-create");
        let fd = root_fd(&root);

        let created = commit_patch_file_beneath(
            &fd,
            Path::new("created.txt"),
            PatchFileAction::Create,
            None,
            Some(b"created\n"),
        )
        .expect("create succeeds");
        assert_eq!(created.action, PatchFileAction::Create);
        assert_eq!(created.bytes_written, 8);
        assert_eq!(
            created.sha256.as_deref(),
            Some(sha256_hex(b"created\n").as_str())
        );
        assert_eq!(fs::read(root.join("created.txt")).unwrap(), b"created\n");

        let conflict = commit_patch_file_beneath(
            &fd,
            Path::new("created.txt"),
            PatchFileAction::Create,
            None,
            Some(b"clobber\n"),
        );
        assert!(matches!(conflict, Err(WorkspaceWriteError::TargetExists)));
        assert_eq!(fs::read(root.join("created.txt")).unwrap(), b"created\n");

        fs::remove_dir_all(root).expect("root removed");
    }

    #[test]
    fn conditional_patch_update_requires_matching_digest_and_preserves_stale_content() {
        let root = temporary_root("patch-update");
        fs::write(root.join("target.txt"), b"before\n").expect("source written");
        let fd = root_fd(&root);
        let before_digest = sha256_hex(b"before\n");

        let updated = commit_patch_file_beneath(
            &fd,
            Path::new("target.txt"),
            PatchFileAction::Update,
            Some(&before_digest),
            Some(b"after\n"),
        )
        .expect("matching update succeeds");
        assert_eq!(updated.bytes_written, 6);
        assert_eq!(
            updated.sha256.as_deref(),
            Some(sha256_hex(b"after\n").as_str())
        );
        assert_eq!(fs::read(root.join("target.txt")).unwrap(), b"after\n");

        let stale = commit_patch_file_beneath(
            &fd,
            Path::new("target.txt"),
            PatchFileAction::Update,
            Some(&before_digest),
            Some(b"must-not-write\n"),
        );
        assert!(matches!(
            stale,
            Err(WorkspaceWriteError::PreconditionFailed)
        ));
        assert_eq!(fs::read(root.join("target.txt")).unwrap(), b"after\n");

        fs::remove_dir_all(root).expect("root removed");
    }

    #[test]
    fn conditional_patch_delete_requires_matching_digest_and_preserves_stale_target() {
        let root = temporary_root("patch-delete");
        fs::write(root.join("target.txt"), b"delete-me\n").expect("source written");
        let fd = root_fd(&root);
        let digest = sha256_hex(b"delete-me\n");

        let stale = commit_patch_file_beneath(
            &fd,
            Path::new("target.txt"),
            PatchFileAction::Delete,
            Some(&"0".repeat(64)),
            None,
        );
        assert!(matches!(
            stale,
            Err(WorkspaceWriteError::PreconditionFailed)
        ));
        assert_eq!(fs::read(root.join("target.txt")).unwrap(), b"delete-me\n");

        let deleted = commit_patch_file_beneath(
            &fd,
            Path::new("target.txt"),
            PatchFileAction::Delete,
            Some(&digest),
            None,
        )
        .expect("matching delete succeeds");
        assert_eq!(deleted.action, PatchFileAction::Delete);
        assert_eq!(deleted.bytes_written, 0);
        assert_eq!(deleted.sha256, None);
        assert!(!root.join("target.txt").exists());

        fs::remove_dir_all(root).expect("root removed");
    }

    #[test]
    fn conditional_patch_reuses_retained_root_boundary_for_traversal_and_symlink_escape() {
        let root = temporary_root("patch-boundary");
        let outside = temporary_root("patch-outside");
        fs::write(outside.join("secret.txt"), b"outside\n").expect("outside written");
        symlink(outside.join("secret.txt"), root.join("link.txt")).expect("symlink created");
        let fd = root_fd(&root);

        let traversal = commit_patch_file_beneath(
            &fd,
            Path::new("../escape.txt"),
            PatchFileAction::Create,
            None,
            Some(b"escape\n"),
        );
        assert!(matches!(
            traversal,
            Err(WorkspaceWriteError::InvalidPath | WorkspaceWriteError::BoundaryViolation)
        ));

        let symlink_update = commit_patch_file_beneath(
            &fd,
            Path::new("link.txt"),
            PatchFileAction::Update,
            Some(&sha256_hex(b"outside\n")),
            Some(b"overwrite\n"),
        );
        assert!(matches!(
            symlink_update,
            Err(WorkspaceWriteError::BoundaryViolation | WorkspaceWriteError::NotRegularFile)
        ));
        assert_eq!(fs::read(outside.join("secret.txt")).unwrap(), b"outside\n");

        fs::remove_dir_all(root).expect("root removed");
        fs::remove_dir_all(outside).expect("outside removed");
    }

    #[test]
    fn atomic_write_creates_and_replaces_regular_files_beneath_retained_root() {
        let root = temporary_root("normal");
        fs::create_dir(root.join("nested")).expect("nested directory created");
        fs::write(root.join("nested/existing.txt"), "old").expect("existing file written");
        fs::set_permissions(
            root.join("nested/existing.txt"),
            fs::Permissions::from_mode(0o754),
        )
        .expect("existing mode set");
        let fd = root_fd(&root);

        let created = write_file_atomic_beneath(&fd, Path::new("nested/new.txt"), b"new contents")
            .expect("new file created");
        assert!(created.created);
        assert_eq!(created.bytes_written, 12);
        assert_eq!(
            fs::read(root.join("nested/new.txt")).unwrap(),
            b"new contents"
        );
        assert_eq!(
            fs::metadata(root.join("nested/new.txt"))
                .expect("new metadata")
                .permissions()
                .mode()
                & 0o7777,
            0o600
        );

        let replaced =
            write_file_atomic_beneath(&fd, Path::new("nested/existing.txt"), b"replacement")
                .expect("existing file replaced");
        assert!(!replaced.created);
        assert_eq!(
            fs::read(root.join("nested/existing.txt")).unwrap(),
            b"replacement"
        );
        assert_eq!(
            fs::metadata(root.join("nested/existing.txt"))
                .expect("replacement metadata")
                .permissions()
                .mode()
                & 0o7777,
            0o754
        );

        fs::remove_dir_all(root).expect("root removed");
    }

    #[test]
    fn write_rejects_traversal_and_outside_symlinks_without_touching_outside_data() {
        let root = temporary_root("boundary");
        let outside = temporary_root("outside");
        fs::write(outside.join("secret.txt"), "outside-secret").expect("outside secret written");
        symlink(outside.join("secret.txt"), root.join("leaf-link")).expect("leaf symlink created");
        symlink(&outside, root.join("parent-link")).expect("parent symlink created");
        let fd = root_fd(&root);

        assert!(matches!(
            write_file_atomic_beneath(&fd, Path::new("../escape.txt"), b"escape"),
            Err(WorkspaceWriteError::InvalidPath | WorkspaceWriteError::BoundaryViolation)
        ));
        assert!(matches!(
            write_file_atomic_beneath(&fd, Path::new("leaf-link"), b"overwrite"),
            Err(WorkspaceWriteError::BoundaryViolation)
        ));
        assert!(matches!(
            write_file_atomic_beneath(&fd, Path::new("parent-link/secret.txt"), b"overwrite"),
            Err(WorkspaceWriteError::BoundaryViolation)
        ));
        assert_eq!(
            fs::read_to_string(outside.join("secret.txt")).unwrap(),
            "outside-secret"
        );

        fs::remove_dir_all(root).expect("root removed");
        fs::remove_dir_all(outside).expect("outside removed");
    }

    #[test]
    fn exact_text_edit_conflicts_without_writing_and_replaces_exact_count_when_matched() {
        let root = temporary_root("edit");
        fs::write(root.join("file.txt"), "alpha beta alpha\n").expect("source written");
        let fd = root_fd(&root);

        assert!(matches!(
            edit_file_exact_beneath(&fd, Path::new("file.txt"), "alpha", "omega", 1),
            Err(WorkspaceWriteError::Conflict)
        ));
        assert_eq!(
            fs::read_to_string(root.join("file.txt")).unwrap(),
            "alpha beta alpha\n"
        );

        let result = edit_file_exact_beneath(&fd, Path::new("file.txt"), "alpha", "omega", 2)
            .expect("edit succeeds");
        assert_eq!(result.replacements, 2);
        assert_eq!(
            fs::read_to_string(root.join("file.txt")).unwrap(),
            "omega beta omega\n"
        );

        fs::remove_dir_all(root).expect("root removed");
    }

    #[test]
    fn symlink_swap_race_never_modifies_outside_target() {
        let root = temporary_root("race-root");
        let outside = temporary_root("race-outside");
        fs::write(root.join("target.txt"), "inside").expect("inside target written");
        fs::write(outside.join("secret.txt"), "outside-secret").expect("outside target written");
        symlink(outside.join("secret.txt"), root.join("alternate"))
            .expect("alternate symlink created");
        let fd = root_fd(&root);
        let barrier = Arc::new(Barrier::new(2));
        let racer_root = root.clone();
        let racer_barrier = Arc::clone(&barrier);
        let racer = thread::spawn(move || {
            racer_barrier.wait();
            for _ in 0..2_000 {
                let swap = racer_root.join("swap");
                if fs::rename(racer_root.join("target.txt"), &swap).is_err() {
                    continue;
                }
                if fs::rename(racer_root.join("alternate"), racer_root.join("target.txt")).is_err()
                {
                    let _ = fs::rename(&swap, racer_root.join("target.txt"));
                    continue;
                }
                if fs::rename(&swap, racer_root.join("alternate")).is_err() {
                    break;
                }
            }
        });

        barrier.wait();
        for index in 0..4_000 {
            let contents = format!("inside-{index}");
            match write_file_atomic_beneath(&fd, Path::new("target.txt"), contents.as_bytes()) {
                Ok(_)
                | Err(WorkspaceWriteError::BoundaryViolation | WorkspaceWriteError::NotFound) => {}
                Err(error) => panic!("unexpected race write error: {error}"),
            }
        }
        racer.join().expect("racer joins");
        assert_eq!(
            fs::read_to_string(outside.join("secret.txt")).unwrap(),
            "outside-secret"
        );

        fs::remove_dir_all(root).expect("root removed");
        fs::remove_dir_all(outside).expect("outside removed");
    }
}
