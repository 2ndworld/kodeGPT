use std::fmt;
use std::fs::{self, File};
use std::os::fd::OwnedFd;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use rustix::fs::{StatVfsMountFlags, statvfs};

use crate::PROCESS_SPAWN_LOCK;

pub(crate) const SANDBOX_MARKER_ENV: &str = "KODEGPT_SANDBOX";
const SANDBOX_MARKER_VALUE: &str = "1";
const TRUSTED_EXECUTABLE_DIRS: [&str; 3] = ["/usr/local/bin", "/usr/bin", "/bin"];

pub const BUBBLEWRAP_MINIMUM_VERSION: ExecutableVersion = ExecutableVersion {
    major: 0,
    minor: 11,
    patch: 2,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct ExecutableVersion {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutableIdentity {
    pub canonical_path: PathBuf,
    pub device: u64,
    pub inode: u64,
    pub mode: u32,
    pub uid: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedExecutable {
    identity: ExecutableIdentity,
    trust: ExecutableTrust,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ExecutableTrust {
    System,
    ExplicitRoot {
        root: ExecutableRootIdentity,
        toolchain: ExplicitToolchain,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExplicitToolchain {
    Generic,
    Node,
    Rust,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExecutableRootIdentity {
    pub(crate) canonical_path: PathBuf,
    pub(crate) device: u64,
    pub(crate) inode: u64,
    pub(crate) mode: u32,
    pub(crate) uid: u32,
    pub(crate) gid: u32,
}

pub(crate) struct ExplicitExecutableMount {
    pub(crate) root_fd: OwnedFd,
    pub(crate) root_canonical_path: PathBuf,
    pub(crate) relative_program: PathBuf,
}

#[derive(Debug)]
pub enum TrustedExecutableError {
    InvalidName,
    NotFound,
    UntrustedLocation,
    NotRegularFile,
    OwnerNotRoot,
    OwnerMismatch,
    SetIdForbidden,
    WritableByGroupOrWorld,
    VersionUnavailable,
    VersionTooOld,
    IdentityChanged,
    SpawnSynchronizationFailed,
    Io(std::io::Error),
}

impl fmt::Display for TrustedExecutableError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidName => formatter.write_str("trusted executable name is invalid"),
            Self::NotFound => formatter.write_str("trusted executable was not found"),
            Self::UntrustedLocation => {
                formatter.write_str("trusted executable resolved outside fixed trusted locations")
            }
            Self::NotRegularFile => formatter.write_str("trusted executable is not a regular file"),
            Self::OwnerNotRoot => formatter.write_str("trusted executable is not owned by uid 0"),
            Self::OwnerMismatch => {
                formatter.write_str("trusted executable owner does not match its explicit root")
            }
            Self::SetIdForbidden => {
                formatter.write_str("trusted executable must not be setuid or setgid")
            }
            Self::WritableByGroupOrWorld => {
                formatter.write_str("trusted executable must not be group/world writable")
            }
            Self::VersionUnavailable => {
                formatter.write_str("trusted executable version is unavailable")
            }
            Self::VersionTooOld => {
                formatter.write_str("trusted executable version is below the required floor")
            }
            Self::IdentityChanged => {
                formatter.write_str("trusted executable identity changed before spawn")
            }
            Self::SpawnSynchronizationFailed => {
                formatter.write_str("trusted executable spawn serialization failed")
            }
            Self::Io(error) => write!(formatter, "trusted executable I/O failed: {error}"),
        }
    }
}

impl std::error::Error for TrustedExecutableError {}

impl From<std::io::Error> for TrustedExecutableError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl TrustedExecutable {
    pub fn identity(&self) -> &ExecutableIdentity {
        &self.identity
    }

    pub fn canonical_path(&self) -> &Path {
        &self.identity.canonical_path
    }

    pub(crate) fn uses_node_toolchain(&self) -> bool {
        matches!(
            self.trust,
            ExecutableTrust::ExplicitRoot {
                toolchain: ExplicitToolchain::Node,
                ..
            }
        )
    }

    pub(crate) fn open_explicit_mount(
        &self,
    ) -> Result<Option<ExplicitExecutableMount>, TrustedExecutableError> {
        let ExecutableTrust::ExplicitRoot { root, .. } = &self.trust else {
            return Ok(None);
        };
        let root_file = File::open(&root.canonical_path)?;
        let metadata = root_file.metadata()?;
        if !metadata.is_dir()
            || metadata.dev() != root.device
            || metadata.ino() != root.inode
            || metadata.mode() != root.mode
            || metadata.uid() != root.uid
            || metadata.gid() != root.gid
        {
            return Err(TrustedExecutableError::IdentityChanged);
        }
        let relative_program = self
            .identity
            .canonical_path
            .strip_prefix(&root.canonical_path)
            .map_err(|_| TrustedExecutableError::IdentityChanged)?
            .to_path_buf();
        if relative_program.as_os_str().is_empty() {
            return Err(TrustedExecutableError::IdentityChanged);
        }
        Ok(Some(ExplicitExecutableMount {
            root_fd: OwnedFd::from(root_file),
            root_canonical_path: root.canonical_path.clone(),
            relative_program,
        }))
    }

    pub fn revalidate(&self) -> Result<(), TrustedExecutableError> {
        let current = match &self.trust {
            ExecutableTrust::System => {
                if !canonical_location_is_trusted(&self.identity.canonical_path) {
                    return Err(TrustedExecutableError::IdentityChanged);
                }
                inspect_trusted_path(&self.identity.canonical_path)?
            }
            ExecutableTrust::ExplicitRoot { root, .. } => {
                let current_root = inspect_explicit_root(&root.canonical_path)?;
                if &current_root != root
                    || !self
                        .identity
                        .canonical_path
                        .starts_with(&root.canonical_path)
                {
                    return Err(TrustedExecutableError::IdentityChanged);
                }
                inspect_explicit_executable(&self.identity.canonical_path, root.uid)?
            }
        };
        if current != self.identity {
            return Err(TrustedExecutableError::IdentityChanged);
        }
        Ok(())
    }
}

pub(crate) fn open_explicit_directory_from_env(
    name: &str,
) -> Result<Option<OwnedFd>, TrustedExecutableError> {
    let Some(path) = std::env::var_os(name) else {
        return Ok(None);
    };
    let root = match inspect_explicit_root(Path::new(&path)) {
        Ok(root) => root,
        Err(TrustedExecutableError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let root_file = File::open(&root.canonical_path)?;
    let metadata = root_file.metadata()?;
    if !metadata.is_dir()
        || metadata.dev() != root.device
        || metadata.ino() != root.inode
        || metadata.mode() != root.mode
        || metadata.uid() != root.uid
        || metadata.gid() != root.gid
    {
        return Err(TrustedExecutableError::IdentityChanged);
    }
    Ok(Some(OwnedFd::from(root_file)))
}

pub fn resolve_bubblewrap() -> Result<TrustedExecutable, TrustedExecutableError> {
    let executable = resolve_trusted_executable("bwrap")?;
    let version = read_version(executable.canonical_path())?;
    if version < BUBBLEWRAP_MINIMUM_VERSION {
        return Err(TrustedExecutableError::VersionTooOld);
    }
    Ok(executable)
}

pub fn resolve_trusted_executable(name: &str) -> Result<TrustedExecutable, TrustedExecutableError> {
    if name.is_empty()
        || matches!(name, "." | "..")
        || name.contains('/')
        || name.contains('\0')
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(TrustedExecutableError::InvalidName);
    }

    let mut last_error = TrustedExecutableError::NotFound;
    for trusted_dir in TRUSTED_EXECUTABLE_DIRS {
        let trusted_dir = Path::new(trusted_dir);
        if !trusted_directory_chain_is_safe(trusted_dir) {
            last_error = TrustedExecutableError::UntrustedLocation;
            continue;
        }
        let candidate = trusted_dir.join(name);
        if !candidate.exists() {
            continue;
        }

        let canonical = match fs::canonicalize(&candidate) {
            Ok(path) => path,
            Err(error) => {
                last_error = TrustedExecutableError::Io(error);
                continue;
            }
        };
        if !canonical_location_is_trusted(&canonical) {
            last_error = TrustedExecutableError::UntrustedLocation;
            continue;
        }

        let identity = match inspect_trusted_path(&canonical) {
            Ok(identity) => identity,
            Err(error) => {
                last_error = error;
                continue;
            }
        };

        return Ok(TrustedExecutable {
            identity,
            trust: ExecutableTrust::System,
        });
    }

    Err(last_error)
}

pub(crate) fn resolve_explicit_root_executable(
    root: &Path,
    relative_executable: &str,
    logical_name: &str,
) -> Result<TrustedExecutable, TrustedExecutableError> {
    let toolchain = match logical_name {
        "node" | "npm" | "npx" | "pnpm" => ExplicitToolchain::Node,
        "cargo" | "rustc" => ExplicitToolchain::Rust,
        _ => ExplicitToolchain::Generic,
    };
    let root_identity = inspect_explicit_root(root)?;
    let candidate = root_identity.canonical_path.join(relative_executable);
    let canonical = fs::canonicalize(&candidate).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            TrustedExecutableError::NotFound
        } else {
            TrustedExecutableError::Io(error)
        }
    })?;
    if canonical == root_identity.canonical_path
        || !canonical.starts_with(&root_identity.canonical_path)
    {
        return Err(TrustedExecutableError::UntrustedLocation);
    }
    let identity = inspect_explicit_executable(&canonical, root_identity.uid)?;
    Ok(TrustedExecutable {
        identity,
        trust: ExecutableTrust::ExplicitRoot {
            root: root_identity,
            toolchain,
        },
    })
}

fn canonical_location_is_trusted(canonical: &Path) -> bool {
    TRUSTED_EXECUTABLE_DIRS.iter().any(|trusted_dir| {
        let trusted_dir = Path::new(trusted_dir);
        trusted_directory_chain_is_safe(trusted_dir)
            && fs::canonicalize(trusted_dir)
                .ok()
                .is_some_and(|dir| canonical.parent() == Some(dir.as_path()))
    })
}

fn system_owner_is_trusted(
    uid: u32,
    overflow_uid: Option<u32>,
    sandbox_view: bool,
    read_only: bool,
) -> bool {
    uid == 0 || (sandbox_view && read_only && overflow_uid == Some(uid))
}

fn kernel_overflow_uid() -> Option<u32> {
    fs::read_to_string("/proc/sys/kernel/overflowuid")
        .ok()?
        .trim()
        .parse()
        .ok()
}

fn system_path_owner_is_trusted(path: &Path, uid: u32) -> bool {
    let sandbox_view =
        std::env::var_os(SANDBOX_MARKER_ENV).is_some_and(|value| value == SANDBOX_MARKER_VALUE);
    let read_only = statvfs(path)
        .ok()
        .is_some_and(|stat| stat.f_flag.contains(StatVfsMountFlags::RDONLY));
    system_owner_is_trusted(uid, kernel_overflow_uid(), sandbox_view, read_only)
}

fn trusted_directory_chain_is_safe(path: &Path) -> bool {
    let Ok(canonical) = fs::canonicalize(path) else {
        return false;
    };
    canonical.ancestors().all(|ancestor| {
        let Ok(metadata) = fs::metadata(ancestor) else {
            return false;
        };
        metadata.is_dir()
            && system_path_owner_is_trusted(ancestor, metadata.uid())
            && metadata.mode() & 0o022 == 0
    })
}

fn inspect_trusted_path(path: &Path) -> Result<ExecutableIdentity, TrustedExecutableError> {
    let metadata = fs::metadata(path)?;
    let file_type = metadata.file_type();
    if !file_type.is_file() || file_type.is_dir() || file_type.is_symlink() {
        return Err(TrustedExecutableError::NotRegularFile);
    }
    if !system_path_owner_is_trusted(path, metadata.uid()) {
        return Err(TrustedExecutableError::OwnerNotRoot);
    }

    let mode = metadata.mode();
    if mode & 0o6000 != 0 {
        return Err(TrustedExecutableError::SetIdForbidden);
    }
    if mode & 0o022 != 0 {
        return Err(TrustedExecutableError::WritableByGroupOrWorld);
    }

    Ok(ExecutableIdentity {
        canonical_path: fs::canonicalize(path)?,
        device: metadata.dev(),
        inode: metadata.ino(),
        mode,
        uid: metadata.uid(),
    })
}

pub(crate) fn inspect_explicit_root(
    path: &Path,
) -> Result<ExecutableRootIdentity, TrustedExecutableError> {
    let canonical_path = fs::canonicalize(path)?;
    let metadata = fs::metadata(&canonical_path)?;
    if !metadata.is_dir() {
        return Err(TrustedExecutableError::UntrustedLocation);
    }
    let mode = metadata.mode();
    if mode & 0o6000 != 0 {
        return Err(TrustedExecutableError::SetIdForbidden);
    }
    if mode & 0o002 != 0 || (mode & 0o020 != 0 && metadata.gid() != metadata.uid()) {
        return Err(TrustedExecutableError::WritableByGroupOrWorld);
    }
    Ok(ExecutableRootIdentity {
        canonical_path,
        device: metadata.dev(),
        inode: metadata.ino(),
        mode,
        uid: metadata.uid(),
        gid: metadata.gid(),
    })
}

fn inspect_explicit_executable(
    path: &Path,
    root_uid: u32,
) -> Result<ExecutableIdentity, TrustedExecutableError> {
    let metadata = fs::metadata(path)?;
    let file_type = metadata.file_type();
    if !file_type.is_file() || file_type.is_dir() || file_type.is_symlink() {
        return Err(TrustedExecutableError::NotRegularFile);
    }
    if metadata.uid() != root_uid && metadata.uid() != 0 {
        return Err(TrustedExecutableError::OwnerMismatch);
    }
    let mode = metadata.mode();
    if mode & 0o6000 != 0 {
        return Err(TrustedExecutableError::SetIdForbidden);
    }
    if mode & 0o022 != 0 {
        return Err(TrustedExecutableError::WritableByGroupOrWorld);
    }
    Ok(ExecutableIdentity {
        canonical_path: fs::canonicalize(path)?,
        device: metadata.dev(),
        inode: metadata.ino(),
        mode,
        uid: metadata.uid(),
    })
}

fn read_version(path: &Path) -> Result<ExecutableVersion, TrustedExecutableError> {
    let _spawn_guard = PROCESS_SPAWN_LOCK
        .lock()
        .map_err(|_| TrustedExecutableError::SpawnSynchronizationFailed)?;
    let output = Command::new(path)
        .arg("--version")
        .env_clear()
        .output()
        .map_err(TrustedExecutableError::Io)?;
    if !output.status.success() {
        return Err(TrustedExecutableError::VersionUnavailable);
    }
    let stdout = std::str::from_utf8(&output.stdout)
        .map_err(|_| TrustedExecutableError::VersionUnavailable)?;
    parse_bubblewrap_version(stdout).ok_or(TrustedExecutableError::VersionUnavailable)
}

fn parse_bubblewrap_version(value: &str) -> Option<ExecutableVersion> {
    let version = value.split_whitespace().last()?;
    let mut components = version.split('.');
    let major = components.next()?.parse().ok()?;
    let minor = components.next()?.parse().ok()?;
    let patch = components.next()?.parse().ok()?;
    if components.next().is_some() {
        return None;
    }
    Some(ExecutableVersion {
        major,
        minor,
        patch,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        BUBBLEWRAP_MINIMUM_VERSION, ExecutableVersion, TrustedExecutableError,
        parse_bubblewrap_version, read_version, resolve_bubblewrap,
        resolve_explicit_root_executable, resolve_trusted_executable,
    };

    fn temporary_root(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "kodegpt-sandbox-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temporary root");
        root
    }

    #[test]
    fn remapped_system_owner_is_trusted_only_for_read_only_kodegpt_sandbox_view() {
        assert!(super::system_owner_is_trusted(0, Some(65534), false, false));
        assert!(super::system_owner_is_trusted(
            65534,
            Some(65534),
            true,
            true
        ));
        assert!(!super::system_owner_is_trusted(
            65534,
            Some(65534),
            false,
            true
        ));
        assert!(!super::system_owner_is_trusted(
            65534,
            Some(65534),
            true,
            false
        ));
        assert!(!super::system_owner_is_trusted(
            1000,
            Some(65534),
            true,
            true
        ));
        assert!(!super::system_owner_is_trusted(65534, None, true, true));
    }

    #[test]
    fn parses_bubblewrap_version_triplet() {
        assert_eq!(
            parse_bubblewrap_version("bubblewrap 0.11.2\n"),
            Some(ExecutableVersion {
                major: 0,
                minor: 11,
                patch: 2,
            })
        );
        assert_eq!(parse_bubblewrap_version("bubblewrap nope"), None);
    }

    #[test]
    fn logical_executable_names_cannot_select_paths() {
        for name in ["", ".", "..", "/usr/bin/sh", "../sh", "sh/tool"] {
            assert!(matches!(
                resolve_trusted_executable(name),
                Err(super::TrustedExecutableError::InvalidName)
            ));
        }
    }

    #[test]
    fn trusted_logical_symlink_resolves_to_a_safe_canonical_target() {
        assert!(
            std::fs::symlink_metadata("/usr/bin/sh")
                .expect("system sh metadata")
                .file_type()
                .is_symlink()
        );
        let executable = resolve_trusted_executable("sh").expect("trusted logical executable");
        executable
            .revalidate()
            .expect("trusted logical executable remains stable");
    }

    #[test]
    fn explicit_node_root_resolves_without_environment_inheritance() {
        let root = temporary_root("node-root");
        let bin = root.join("bin");
        fs::create_dir_all(&bin).expect("node bin");
        let node = bin.join("node");
        fs::write(&node, b"#!/bin/sh\nexit 0\n").expect("node fixture");
        let mut permissions = fs::metadata(&node).expect("node metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&node, permissions).expect("node executable mode");

        let executable = resolve_explicit_root_executable(&root, "bin/node", "node")
            .expect("explicit node root resolves");
        assert_eq!(
            executable.canonical_path(),
            fs::canonicalize(&node).expect("canonical node").as_path()
        );
        assert!(executable.uses_node_toolchain());
        executable
            .revalidate()
            .expect("explicit node identity remains stable");
        fs::remove_dir_all(root).expect("temporary root cleanup");
    }

    #[test]
    fn explicit_toolchain_root_rejects_world_writable_directory() {
        let root = temporary_root("world-writable-root");
        let bin = root.join("bin");
        fs::create_dir_all(&bin).expect("tool bin");
        let node = bin.join("node");
        fs::write(&node, b"#!/bin/sh\nexit 0\n").expect("node fixture");
        let mut node_permissions = fs::metadata(&node).expect("node metadata").permissions();
        node_permissions.set_mode(0o755);
        fs::set_permissions(&node, node_permissions).expect("node executable mode");
        let mut root_permissions = fs::metadata(&root).expect("root metadata").permissions();
        root_permissions.set_mode(0o777);
        fs::set_permissions(&root, root_permissions).expect("world-writable root mode");

        assert!(matches!(
            resolve_explicit_root_executable(&root, "bin/node", "node"),
            Err(TrustedExecutableError::WritableByGroupOrWorld)
        ));
        fs::remove_dir_all(root).expect("temporary root cleanup");
    }

    #[test]
    fn explicit_toolchain_root_rejects_symlink_escape() {
        let root = temporary_root("symlink-root");
        let bin = root.join("bin");
        fs::create_dir_all(&bin).expect("tool bin");
        let outside = temporary_root("symlink-outside");
        let node = outside.join("node");
        fs::write(&node, b"#!/bin/sh\nexit 0\n").expect("outside node fixture");
        let mut permissions = fs::metadata(&node).expect("node metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&node, permissions).expect("node executable mode");
        std::os::unix::fs::symlink(&node, bin.join("node")).expect("escaping node symlink");

        assert!(matches!(
            resolve_explicit_root_executable(&root, "bin/node", "node"),
            Err(TrustedExecutableError::UntrustedLocation)
        ));
        fs::remove_dir_all(root).expect("temporary root cleanup");
        fs::remove_dir_all(outside).expect("outside cleanup");
    }

    #[test]
    fn current_host_has_trusted_bubblewrap_at_required_floor() {
        let executable = resolve_bubblewrap().expect("trusted Bubblewrap prerequisite");
        let version =
            read_version(executable.canonical_path()).expect("Bubblewrap version readable");
        assert!(version >= BUBBLEWRAP_MINIMUM_VERSION);
        assert_eq!(executable.identity().uid, 0);
        assert_eq!(executable.identity().mode & 0o6022, 0);
        executable
            .revalidate()
            .expect("trusted executable identity and parent trust remain stable");
    }
}
