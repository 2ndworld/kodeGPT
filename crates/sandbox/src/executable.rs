use std::fmt;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::PROCESS_SPAWN_LOCK;

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
}

#[derive(Debug)]
pub enum TrustedExecutableError {
    InvalidName,
    NotFound,
    UntrustedLocation,
    NotRegularFile,
    OwnerNotRoot,
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

    pub fn revalidate(&self) -> Result<(), TrustedExecutableError> {
        if !canonical_location_is_trusted(&self.identity.canonical_path) {
            return Err(TrustedExecutableError::IdentityChanged);
        }
        let current = inspect_trusted_path(&self.identity.canonical_path)?;
        if current != self.identity {
            return Err(TrustedExecutableError::IdentityChanged);
        }
        Ok(())
    }
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

        return Ok(TrustedExecutable { identity });
    }

    Err(last_error)
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

fn trusted_directory_chain_is_safe(path: &Path) -> bool {
    let Ok(canonical) = fs::canonicalize(path) else {
        return false;
    };
    canonical.ancestors().all(|ancestor| {
        let Ok(metadata) = fs::metadata(ancestor) else {
            return false;
        };
        metadata.is_dir() && metadata.uid() == 0 && metadata.mode() & 0o022 == 0
    })
}

fn inspect_trusted_path(path: &Path) -> Result<ExecutableIdentity, TrustedExecutableError> {
    let metadata = fs::metadata(path)?;
    let file_type = metadata.file_type();
    if !file_type.is_file() || file_type.is_dir() || file_type.is_symlink() {
        return Err(TrustedExecutableError::NotRegularFile);
    }
    if metadata.uid() != 0 {
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
    use super::{
        parse_bubblewrap_version, read_version, resolve_bubblewrap, resolve_trusted_executable,
        ExecutableVersion, BUBBLEWRAP_MINIMUM_VERSION,
    };

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
        assert!(std::fs::symlink_metadata("/usr/bin/sh")
            .expect("system sh metadata")
            .file_type()
            .is_symlink());
        let executable = resolve_trusted_executable("sh").expect("trusted logical executable");
        executable
            .revalidate()
            .expect("trusted logical executable remains stable");
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
