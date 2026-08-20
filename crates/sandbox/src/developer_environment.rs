use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

use crate::executable::{
    ExecutableRootIdentity, TrustedExecutable, TrustedExecutableError, inspect_explicit_root,
    resolve_explicit_root_executable, resolve_trusted_executable,
};

const REGISTRY_RELATIVE_PATH: &str = "developer-environments/registry.json";
const REGISTRY_MAX_BYTES: u64 = 1024 * 1024;
const REGISTRY_SCHEMA_VERSION: u64 = 1;
const MAX_ENTRIES: usize = 32;
const MAX_EXECUTABLE_DIRS: usize = 4;
const MAX_LABEL_BYTES: usize = 120;

#[derive(Debug)]
pub enum DeveloperEnvironmentError {
    RegistryInvalid,
    SchemaUnsupported,
    LimitExceeded,
    RootNotFound,
    RootUntrusted,
    RootChanged,
    Executable(TrustedExecutableError),
    Io(std::io::Error),
}

impl fmt::Display for DeveloperEnvironmentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RegistryInvalid => formatter.write_str("DEV_ENV_REGISTRY_INVALID"),
            Self::SchemaUnsupported => formatter.write_str("DEV_ENV_SCHEMA_UNSUPPORTED"),
            Self::LimitExceeded => formatter.write_str("DEV_ENV_LIMIT_EXCEEDED"),
            Self::RootNotFound => formatter.write_str("DEV_ENV_ROOT_NOT_FOUND"),
            Self::RootUntrusted => formatter.write_str("DEV_ENV_ROOT_UNTRUSTED"),
            Self::RootChanged => formatter.write_str("DEV_ENV_ROOT_CHANGED"),
            Self::Executable(error) => write!(formatter, "{error}"),
            Self::Io(error) => write!(formatter, "developer environment I/O failed: {error}"),
        }
    }
}

impl std::error::Error for DeveloperEnvironmentError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Executable(error) => Some(error),
            Self::Io(error) => Some(error),
            Self::RegistryInvalid
            | Self::SchemaUnsupported
            | Self::LimitExceeded
            | Self::RootNotFound
            | Self::RootUntrusted
            | Self::RootChanged => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct DeveloperEnvironmentRegistry {
    entries: Vec<ValidatedDeveloperEnvironmentEntry>,
}

#[derive(Debug, Clone)]
struct ValidatedDeveloperEnvironmentEntry {
    canonical_root: PathBuf,
    executable_dirs: Vec<PathBuf>,
    identity: PersistentFilesystemIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PersistentFilesystemIdentity {
    device_major: u64,
    device_minor: u64,
    inode: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistryDocument {
    schema_version: u64,
    entries: Vec<RegistryEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistryEntry {
    id: String,
    label: String,
    source: RegistrySource,
    canonical_root: PathBuf,
    executable_dirs: Vec<String>,
    identity: RegistryFilesystemIdentity,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum RegistrySource {
    Bootstrap,
    Operator,
    SyncedShell,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistryFilesystemIdentity {
    device_major: u64,
    device_minor: u64,
    inode: String,
}

impl DeveloperEnvironmentRegistry {
    pub fn load(state_root: &Path) -> Result<Self, DeveloperEnvironmentError> {
        let registry_path = state_root.join(REGISTRY_RELATIVE_PATH);
        let metadata = match fs::symlink_metadata(&registry_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self {
                    entries: Vec::new(),
                });
            }
            Err(error) => return Err(DeveloperEnvironmentError::Io(error)),
        };
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(DeveloperEnvironmentError::RegistryInvalid);
        }
        if metadata.len() > REGISTRY_MAX_BYTES {
            return Err(DeveloperEnvironmentError::LimitExceeded);
        }

        let bytes = fs::read(&registry_path).map_err(DeveloperEnvironmentError::Io)?;
        let document: RegistryDocument = serde_json::from_slice(&bytes)
            .map_err(|_| DeveloperEnvironmentError::RegistryInvalid)?;
        if document.schema_version != REGISTRY_SCHEMA_VERSION {
            return Err(DeveloperEnvironmentError::SchemaUnsupported);
        }
        if document.entries.len() > MAX_ENTRIES {
            return Err(DeveloperEnvironmentError::LimitExceeded);
        }

        let mut ids = HashSet::new();
        let mut roots = HashSet::new();
        let mut entries = Vec::with_capacity(document.entries.len());
        for entry in document.entries {
            if !valid_id(&entry.id)
                || entry.label.is_empty()
                || entry.label.as_bytes().len() > MAX_LABEL_BYTES
                || entry.label.contains('\0')
                || !ids.insert(entry.id)
                || entry.executable_dirs.is_empty()
                || entry.executable_dirs.len() > MAX_EXECUTABLE_DIRS
            {
                return Err(DeveloperEnvironmentError::RegistryInvalid);
            }
            let _ = entry.source;
            if !entry.canonical_root.is_absolute() || !roots.insert(entry.canonical_root.clone()) {
                return Err(DeveloperEnvironmentError::RegistryInvalid);
            }
            let inode = entry
                .identity
                .inode
                .parse::<u64>()
                .map_err(|_| DeveloperEnvironmentError::RegistryInvalid)?;
            let identity = PersistentFilesystemIdentity {
                device_major: entry.identity.device_major,
                device_minor: entry.identity.device_minor,
                inode,
            };
            let executable_dirs = entry
                .executable_dirs
                .iter()
                .map(|value| normalize_executable_dir(value))
                .collect::<Result<Vec<_>, _>>()?;
            let validated = ValidatedDeveloperEnvironmentEntry {
                canonical_root: entry.canonical_root,
                executable_dirs,
                identity,
            };
            revalidate_entry(&validated)?;
            entries.push(validated);
        }

        Ok(Self { entries })
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn resolve_registered(
        &self,
        name: &str,
    ) -> Result<TrustedExecutable, TrustedExecutableError> {
        let mut last_error = TrustedExecutableError::NotFound;
        for entry in &self.entries {
            revalidate_entry(entry).map_err(map_registry_validation_to_executable)?;
            for executable_dir in &entry.executable_dirs {
                let relative = if executable_dir == Path::new(".") {
                    PathBuf::from(name)
                } else {
                    executable_dir.join(name)
                };
                let relative = relative
                    .to_str()
                    .ok_or(TrustedExecutableError::UntrustedLocation)?;
                match resolve_explicit_root_executable(&entry.canonical_root, relative, name) {
                    Ok(executable) => return Ok(executable),
                    Err(TrustedExecutableError::NotFound) => {
                        last_error = TrustedExecutableError::NotFound;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        Err(last_error)
    }
}

pub fn resolve_dynamic_executable(
    state_root: &Path,
    name: &str,
) -> Result<TrustedExecutable, DeveloperEnvironmentError> {
    if matches!(name, "bash" | "sh") {
        return resolve_trusted_executable(name).map_err(DeveloperEnvironmentError::Executable);
    }

    let registry = DeveloperEnvironmentRegistry::load(state_root)?;
    match registry.resolve_registered(name) {
        Ok(executable) => Ok(executable),
        Err(TrustedExecutableError::NotFound) => {
            resolve_trusted_executable(name).map_err(DeveloperEnvironmentError::Executable)
        }
        Err(error) => Err(DeveloperEnvironmentError::Executable(error)),
    }
}

fn revalidate_entry(
    entry: &ValidatedDeveloperEnvironmentEntry,
) -> Result<ExecutableRootIdentity, DeveloperEnvironmentError> {
    let root = inspect_explicit_root(&entry.canonical_root).map_err(map_root_error)?;
    if root.canonical_path != entry.canonical_root
        || device_major(root.device) != entry.identity.device_major
        || device_minor(root.device) != entry.identity.device_minor
        || root.inode != entry.identity.inode
    {
        return Err(DeveloperEnvironmentError::RootChanged);
    }

    for executable_dir in &entry.executable_dirs {
        let directory = if executable_dir == Path::new(".") {
            entry.canonical_root.clone()
        } else {
            entry.canonical_root.join(executable_dir)
        };
        let inspected = inspect_explicit_root(&directory).map_err(map_root_error)?;
        if !inspected.canonical_path.starts_with(&entry.canonical_root) {
            return Err(DeveloperEnvironmentError::RootUntrusted);
        }
    }
    Ok(root)
}

fn normalize_executable_dir(value: &str) -> Result<PathBuf, DeveloperEnvironmentError> {
    if value.is_empty() || value.len() > 4096 || value.contains('\0') {
        return Err(DeveloperEnvironmentError::RegistryInvalid);
    }
    if value == "." {
        return Ok(PathBuf::from("."));
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(DeveloperEnvironmentError::RegistryInvalid);
    }
    let normalized = path
        .components()
        .map(|component| component.as_os_str())
        .collect::<PathBuf>();
    if normalized.as_os_str().is_empty() || normalized != path {
        return Err(DeveloperEnvironmentError::RegistryInvalid);
    }
    Ok(normalized)
}

fn valid_id(value: &str) -> bool {
    value.len() == 37
        && value.starts_with("denv_")
        && value[5..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn map_root_error(error: TrustedExecutableError) -> DeveloperEnvironmentError {
    match error {
        TrustedExecutableError::Io(error) if error.kind() == std::io::ErrorKind::NotFound => {
            DeveloperEnvironmentError::RootNotFound
        }
        TrustedExecutableError::IdentityChanged => DeveloperEnvironmentError::RootChanged,
        TrustedExecutableError::UntrustedLocation
        | TrustedExecutableError::OwnerMismatch
        | TrustedExecutableError::OwnerNotRoot
        | TrustedExecutableError::SetIdForbidden
        | TrustedExecutableError::WritableByGroupOrWorld
        | TrustedExecutableError::NotRegularFile => DeveloperEnvironmentError::RootUntrusted,
        other => DeveloperEnvironmentError::Executable(other),
    }
}

fn map_registry_validation_to_executable(
    error: DeveloperEnvironmentError,
) -> TrustedExecutableError {
    match error {
        DeveloperEnvironmentError::Executable(error) => error,
        DeveloperEnvironmentError::RootNotFound => TrustedExecutableError::NotFound,
        DeveloperEnvironmentError::RootChanged => TrustedExecutableError::IdentityChanged,
        DeveloperEnvironmentError::RootUntrusted
        | DeveloperEnvironmentError::RegistryInvalid
        | DeveloperEnvironmentError::SchemaUnsupported
        | DeveloperEnvironmentError::LimitExceeded => TrustedExecutableError::UntrustedLocation,
        DeveloperEnvironmentError::Io(error) => TrustedExecutableError::Io(error),
    }
}

fn device_major(device: u64) -> u64 {
    ((device & 0x0000_0000_000f_ff00) >> 8) | ((device & 0xffff_f000_0000_0000) >> 32)
}

fn device_minor(device: u64) -> u64 {
    (device & 0xff) | ((device & 0x0000_0fff_fff0_0000) >> 12)
}
