use std::ffi::OsString;
use std::fmt;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStringExt;
use std::path::Path;

use getrandom::fill as fill_random;
use rustix::fs::{
    AtFlags, FileType, Mode, OFlags, fchmod, fstat, fsync, openat, renameat, statat, unlinkat,
};
use rustix::io::Errno;
use serde::Serialize;

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

    use super::{WorkspaceWriteError, edit_file_exact_beneath, write_file_atomic_beneath};

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
