use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs::File;
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use std::path::{Component, Path};

use rustix::fs::{Mode, OFlags, ResolveFlags, openat2};
use rustix::io::Errno;

const REQUIRED_RESOLVE_FLAGS: ResolveFlags = ResolveFlags::BENEATH
    .union(ResolveFlags::NO_MAGICLINKS)
    .union(ResolveFlags::NO_XDEV);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenatBoundaryError {
    InvalidRelativePath,
    BoundaryUnavailable,
    BoundaryViolation,
    NotFound,
    Os(Errno),
}

impl fmt::Display for OpenatBoundaryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRelativePath => formatter
                .write_str("path must be a non-empty relative path beneath the retained root"),
            Self::BoundaryUnavailable => formatter
                .write_str("required openat2 filesystem boundary semantics are unavailable"),
            Self::BoundaryViolation => {
                formatter.write_str("path resolution crossed the retained filesystem boundary")
            }
            Self::NotFound => formatter.write_str("path was not found beneath the retained root"),
            Self::Os(error) => write!(formatter, "openat2 failed: {error}"),
        }
    }
}

impl std::error::Error for OpenatBoundaryError {}

pub struct OpenedParent {
    parent_fd: OwnedFd,
    leaf_name: OsString,
}

impl OpenedParent {
    pub fn parent_fd(&self) -> BorrowedFd<'_> {
        self.parent_fd.as_fd()
    }

    pub fn leaf_name(&self) -> &OsStr {
        &self.leaf_name
    }
}

pub fn open_existing_beneath(
    root_fd: &OwnedFd,
    relative_path: &Path,
    flags: OFlags,
) -> Result<OwnedFd, OpenatBoundaryError> {
    validate_relative_path(relative_path)?;
    if flags.intersects(OFlags::CREATE | OFlags::TRUNC) {
        return Err(OpenatBoundaryError::InvalidRelativePath);
    }

    openat2(
        root_fd,
        relative_path,
        flags | OFlags::CLOEXEC,
        Mode::empty(),
        REQUIRED_RESOLVE_FLAGS,
    )
    .map_err(map_openat_error)
}

pub fn open_directory_beneath(
    root_fd: &OwnedFd,
    relative_path: &Path,
) -> Result<OwnedFd, OpenatBoundaryError> {
    if relative_path == Path::new(".") {
        return openat2(
            root_fd,
            relative_path,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
            REQUIRED_RESOLVE_FLAGS,
        )
        .map_err(map_openat_error);
    }

    open_existing_beneath(
        root_fd,
        relative_path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW,
    )
}

pub fn open_parent_beneath(
    root_fd: &OwnedFd,
    relative_path: &Path,
) -> Result<OpenedParent, OpenatBoundaryError> {
    validate_relative_path(relative_path)?;
    let leaf_name = relative_path
        .file_name()
        .ok_or(OpenatBoundaryError::InvalidRelativePath)?;
    if leaf_name.is_empty() || leaf_name == OsStr::new(".") || leaf_name == OsStr::new("..") {
        return Err(OpenatBoundaryError::InvalidRelativePath);
    }
    let parent_path = relative_path.parent().unwrap_or_else(|| Path::new(""));
    let parent_path = if parent_path.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent_path
    };

    let parent_fd = openat2(
        root_fd,
        parent_path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
        REQUIRED_RESOLVE_FLAGS,
    )
    .map_err(map_openat_error)?;

    Ok(OpenedParent {
        parent_fd,
        leaf_name: leaf_name.to_owned(),
    })
}

pub fn probe_filesystem_boundary() -> Result<(), OpenatBoundaryError> {
    let root: OwnedFd = File::open("/")
        .map_err(|error| {
            error
                .raw_os_error()
                .map(|code| OpenatBoundaryError::Os(Errno::from_raw_os_error(code)))
                .unwrap_or(OpenatBoundaryError::BoundaryUnavailable)
        })?
        .into();

    match openat2(
        &root,
        "proc/version",
        OFlags::RDONLY | OFlags::CLOEXEC,
        Mode::empty(),
        REQUIRED_RESOLVE_FLAGS,
    ) {
        Err(Errno::XDEV) => Ok(()),
        Err(Errno::NOSYS | Errno::INVAL) => Err(OpenatBoundaryError::BoundaryUnavailable),
        Ok(fd) => {
            drop(fd);
            Err(OpenatBoundaryError::BoundaryUnavailable)
        }
        Err(_) => Err(OpenatBoundaryError::BoundaryUnavailable),
    }
}

fn validate_relative_path(path: &Path) -> Result<(), OpenatBoundaryError> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(OpenatBoundaryError::InvalidRelativePath);
    }
    let mut has_normal = false;
    for component in path.components() {
        match component {
            Component::Normal(_) => has_normal = true,
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(OpenatBoundaryError::InvalidRelativePath);
            }
        }
    }
    if !has_normal {
        return Err(OpenatBoundaryError::InvalidRelativePath);
    }
    Ok(())
}

fn map_openat_error(error: Errno) -> OpenatBoundaryError {
    match error {
        Errno::NOENT => OpenatBoundaryError::NotFound,
        Errno::NOSYS | Errno::INVAL => OpenatBoundaryError::BoundaryUnavailable,
        Errno::XDEV | Errno::LOOP | Errno::AGAIN => OpenatBoundaryError::BoundaryViolation,
        other => OpenatBoundaryError::Os(other),
    }
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};
    use std::io::Read;
    use std::os::fd::{AsRawFd, OwnedFd};
    use std::os::unix::fs::symlink;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    use rustix::fs::OFlags;

    use super::{
        OpenatBoundaryError, open_existing_beneath, open_parent_beneath, probe_filesystem_boundary,
    };

    fn temporary_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "kodegpt-openat-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temporary root created");
        root
    }

    fn root_fd(path: &Path) -> OwnedFd {
        File::open(path).expect("root directory opens").into()
    }

    fn read_fd(fd: OwnedFd) -> String {
        let mut file = File::from(fd);
        let mut text = String::new();
        file.read_to_string(&mut text).expect("opened fd readable");
        text
    }

    #[test]
    fn existing_open_rejects_parent_absolute_outside_symlink_magic_link_and_nested_mount() {
        let root = temporary_root("escapes");
        let outside = temporary_root("outside");
        fs::write(root.join("inside.txt"), "inside").expect("inside file written");
        fs::write(outside.join("secret.txt"), "outside-secret").expect("outside file written");
        symlink(outside.join("secret.txt"), root.join("outside-link"))
            .expect("outside symlink created");
        let fd = root_fd(&root);

        assert_eq!(
            read_fd(
                open_existing_beneath(&fd, Path::new("inside.txt"), OFlags::RDONLY)
                    .expect("inside file opens")
            ),
            "inside"
        );
        assert!(matches!(
            open_existing_beneath(&fd, Path::new("../secret.txt"), OFlags::RDONLY),
            Err(OpenatBoundaryError::InvalidRelativePath)
                | Err(OpenatBoundaryError::BoundaryViolation)
        ));
        assert!(matches!(
            open_existing_beneath(&fd, Path::new("/etc/passwd"), OFlags::RDONLY),
            Err(OpenatBoundaryError::InvalidRelativePath)
                | Err(OpenatBoundaryError::BoundaryViolation)
        ));
        assert!(matches!(
            open_existing_beneath(&fd, Path::new("outside-link"), OFlags::RDONLY),
            Err(OpenatBoundaryError::BoundaryViolation)
        ));

        let proc_fd = root_fd(Path::new("/proc"));
        let external = File::open(outside.join("secret.txt")).expect("outside file opens");
        let magic = PathBuf::from(format!("self/fd/{}", external.as_raw_fd()));
        assert!(matches!(
            open_existing_beneath(&proc_fd, &magic, OFlags::RDONLY),
            Err(OpenatBoundaryError::BoundaryViolation)
        ));

        let slash_fd = root_fd(Path::new("/"));
        assert!(matches!(
            open_existing_beneath(&slash_fd, Path::new("proc/version"), OFlags::RDONLY),
            Err(OpenatBoundaryError::BoundaryViolation)
        ));

        fs::remove_dir_all(root).expect("root removed");
        fs::remove_dir_all(outside).expect("outside removed");
    }

    #[test]
    fn parent_open_returns_retained_parent_and_leaf_but_rejects_escape_paths() {
        let root = temporary_root("parent");
        let outside = temporary_root("parent-outside");
        fs::create_dir_all(root.join("nested")).expect("nested created");
        fs::create_dir_all(outside.join("nested")).expect("outside nested created");
        symlink(outside.join("nested"), root.join("outside-parent"))
            .expect("outside parent symlink created");
        let fd = root_fd(&root);

        let parent = open_parent_beneath(&fd, Path::new("nested/file.txt"))
            .expect("parent opens beneath root");
        assert_eq!(parent.leaf_name(), "file.txt");
        let marker = rustix::fs::openat(
            parent.parent_fd(),
            "marker.txt",
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC,
            rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
        )
        .expect("parent fd is the nested directory");
        drop(marker);
        assert!(root.join("nested/marker.txt").is_file());

        assert!(open_parent_beneath(&fd, Path::new("../escape.txt")).is_err());
        assert!(open_parent_beneath(&fd, Path::new("/tmp/escape.txt")).is_err());
        assert!(open_parent_beneath(&fd, Path::new(".")).is_err());
        assert!(matches!(
            open_parent_beneath(&fd, Path::new("outside-parent/file.txt")),
            Err(OpenatBoundaryError::BoundaryViolation)
        ));

        let slash_fd = root_fd(Path::new("/"));
        assert!(matches!(
            open_parent_beneath(&slash_fd, Path::new("proc/file.txt")),
            Err(OpenatBoundaryError::BoundaryViolation)
        ));

        fs::remove_dir_all(root).expect("root removed");
        fs::remove_dir_all(outside).expect("outside removed");
    }

    #[test]
    fn filesystem_boundary_probe_confirms_required_host_semantics() {
        assert_eq!(probe_filesystem_boundary(), Ok(()));
    }

    #[test]
    fn symlink_swap_race_never_opens_outside_target() {
        let root = temporary_root("race-root");
        let outside = temporary_root("race-outside");
        fs::write(outside.join("secret.txt"), "outside-secret").expect("outside secret written");
        fs::write(root.join("target"), "inside").expect("inside target written");
        symlink(outside.join("secret.txt"), root.join("alternate"))
            .expect("alternate outside symlink created");
        let fd = root_fd(&root);
        let barrier = Arc::new(Barrier::new(2));
        let racer_root = root.clone();
        let racer_barrier = Arc::clone(&barrier);
        let racer = thread::spawn(move || {
            racer_barrier.wait();
            for _ in 0..2_000 {
                let swap = racer_root.join("swap");
                if fs::rename(racer_root.join("target"), &swap).is_err() {
                    continue;
                }
                if fs::rename(racer_root.join("alternate"), racer_root.join("target")).is_err() {
                    let _ = fs::rename(&swap, racer_root.join("target"));
                    continue;
                }
                if fs::rename(&swap, racer_root.join("alternate")).is_err() {
                    break;
                }
            }
        });

        barrier.wait();
        for _ in 0..4_000 {
            match open_existing_beneath(&fd, Path::new("target"), OFlags::RDONLY) {
                Ok(opened) => assert_eq!(read_fd(opened), "inside"),
                Err(OpenatBoundaryError::BoundaryViolation | OpenatBoundaryError::NotFound) => {}
                Err(error) => panic!("unexpected race open error: {error}"),
            }
        }
        racer.join().expect("racer joins");

        fs::remove_dir_all(root).expect("root removed");
        fs::remove_dir_all(outside).expect("outside removed");
    }
}
