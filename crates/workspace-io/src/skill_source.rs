use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::os::fd::OwnedFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::identity::{FilesystemIdentity, filesystem_identity, inspect_root};
use crate::mountinfo::{
    BackingTreeIdentity, MountInfoEntry, MountInfoError, backing_tree_for_path,
    read_current_mountinfo,
};
use crate::read::{
    ReadFileResult, TreeResult, WorkspaceReadError, read_file_beneath_no_follow,
    tree_beneath_no_symlinks_with_hard_cap,
};
use crate::registry::roots_overlap;

pub const SKILL_SOURCE_TREE_MAX_ENTRIES: usize = 20_000;

static NEXT_SKILL_SOURCE_CAPABILITY_ID: AtomicU64 = AtomicU64::new(1);

type MountInfoReader = Box<dyn Fn() -> Result<Vec<MountInfoEntry>, MountInfoError> + Send + Sync>;

struct SkillSourceContext {
    canonical_display_root: std::path::PathBuf,
    root_fd: OwnedFd,
    persistent_identity: FilesystemIdentity,
    backing_tree_identity: BackingTreeIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillSourceRegistration {
    pub capability_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillSourceRegistryError {
    RootInvalid,
    IdentityChanged,
    MountTopologyUnavailable,
    RootOverlap,
    StateOverlap,
    FilesystemBoundaryUnavailable,
    AccessDenied,
    NotFound,
    InvalidUtf8,
    LimitExceeded,
    ReadFailed,
    CapabilityNotFound,
}

impl fmt::Display for SkillSourceRegistryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RootInvalid => formatter.write_str("skill source root is invalid"),
            Self::IdentityChanged => {
                formatter.write_str("skill source filesystem identity changed")
            }
            Self::MountTopologyUnavailable => {
                formatter.write_str("skill source mount topology is unavailable")
            }
            Self::RootOverlap => {
                formatter.write_str("skill source root overlaps an existing source")
            }
            Self::StateOverlap => formatter.write_str("skill source root overlaps protected state"),
            Self::FilesystemBoundaryUnavailable => {
                formatter.write_str("skill source filesystem boundary semantics are unavailable")
            }
            Self::AccessDenied => formatter.write_str("skill source access was denied"),
            Self::NotFound => formatter.write_str("skill source path was not found"),
            Self::InvalidUtf8 => formatter.write_str("skill source resource is not valid UTF-8"),
            Self::LimitExceeded => formatter.write_str("skill source operation limit was exceeded"),
            Self::ReadFailed => formatter.write_str("skill source read failed"),
            Self::CapabilityNotFound => {
                formatter.write_str("skill source capability was not found")
            }
        }
    }
}

impl std::error::Error for SkillSourceRegistryError {}

pub struct SkillSourceRegistry {
    contexts: HashMap<String, SkillSourceContext>,
    mountinfo_reader: MountInfoReader,
}

impl Default for SkillSourceRegistry {
    fn default() -> Self {
        Self::new()
    }
}

pub fn inspect_skill_source_root(
    root_path: &Path,
    protected_root: &Path,
) -> Result<crate::identity::InspectedRoot, SkillSourceRegistryError> {
    let mountinfo =
        read_current_mountinfo().map_err(|_| SkillSourceRegistryError::MountTopologyUnavailable)?;
    inspect_skill_source_root_with_mountinfo(root_path, protected_root, &mountinfo)
}

fn inspect_skill_source_root_with_mountinfo(
    root_path: &Path,
    protected_root: &Path,
    mountinfo: &[MountInfoEntry],
) -> Result<crate::identity::InspectedRoot, SkillSourceRegistryError> {
    let inspected = inspect_root(root_path).map_err(|_| SkillSourceRegistryError::RootInvalid)?;
    let protected = inspect_root(protected_root)
        .map_err(|_| SkillSourceRegistryError::MountTopologyUnavailable)?;
    let backing = backing_tree_for_path(mountinfo, &inspected.canonical_root)
        .map_err(|_| SkillSourceRegistryError::MountTopologyUnavailable)?;
    let protected_backing = backing_tree_for_path(mountinfo, &protected.canonical_root)
        .map_err(|_| SkillSourceRegistryError::MountTopologyUnavailable)?;

    if roots_overlap(
        &protected.canonical_root,
        &protected_backing,
        &protected.identity,
        &inspected.canonical_root,
        &backing,
        &inspected.identity,
    ) {
        return Err(SkillSourceRegistryError::StateOverlap);
    }

    Ok(inspected)
}

impl SkillSourceRegistry {
    pub fn new() -> Self {
        Self {
            contexts: HashMap::new(),
            mountinfo_reader: Box::new(read_current_mountinfo),
        }
    }

    #[cfg(test)]
    fn with_mountinfo_reader<F>(reader: F) -> Self
    where
        F: Fn() -> Result<Vec<MountInfoEntry>, MountInfoError> + Send + Sync + 'static,
    {
        Self {
            contexts: HashMap::new(),
            mountinfo_reader: Box::new(reader),
        }
    }

    pub fn register(
        &mut self,
        root_path: &Path,
        expected_identity: &FilesystemIdentity,
    ) -> Result<SkillSourceRegistration, SkillSourceRegistryError> {
        let inspected =
            inspect_root(root_path).map_err(|_| SkillSourceRegistryError::RootInvalid)?;
        if inspected.identity != *expected_identity {
            return Err(SkillSourceRegistryError::IdentityChanged);
        }

        let mountinfo = (self.mountinfo_reader)()
            .map_err(|_| SkillSourceRegistryError::MountTopologyUnavailable)?;
        let backing_tree_identity = backing_tree_for_path(&mountinfo, &inspected.canonical_root)
            .map_err(|_| SkillSourceRegistryError::MountTopologyUnavailable)?;

        let root_file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&inspected.canonical_root)
            .map_err(|_| SkillSourceRegistryError::RootInvalid)?;
        let root_metadata = root_file
            .metadata()
            .map_err(|_| SkillSourceRegistryError::RootInvalid)?;
        if !root_metadata.is_dir() {
            return Err(SkillSourceRegistryError::RootInvalid);
        }
        let fd_identity = filesystem_identity(&root_metadata);
        if fd_identity != inspected.identity || fd_identity != *expected_identity {
            return Err(SkillSourceRegistryError::IdentityChanged);
        }
        if backing_tree_identity.device_major != fd_identity.device_major
            || backing_tree_identity.device_minor != fd_identity.device_minor
        {
            return Err(SkillSourceRegistryError::MountTopologyUnavailable);
        }

        if self.contexts.values().any(|existing| {
            roots_overlap(
                &existing.canonical_display_root,
                &existing.backing_tree_identity,
                &existing.persistent_identity,
                &inspected.canonical_root,
                &backing_tree_identity,
                &fd_identity,
            )
        }) {
            return Err(SkillSourceRegistryError::RootOverlap);
        }

        let capability_id = next_capability_id();
        self.contexts.insert(
            capability_id.clone(),
            SkillSourceContext {
                canonical_display_root: inspected.canonical_root,
                root_fd: OwnedFd::from(root_file),
                persistent_identity: fd_identity,
                backing_tree_identity,
            },
        );

        Ok(SkillSourceRegistration { capability_id })
    }

    pub fn tree(
        &self,
        capability_id: &str,
        relative_path: &Path,
        max_entries: usize,
    ) -> Result<TreeResult, SkillSourceRegistryError> {
        let context = self
            .contexts
            .get(capability_id)
            .ok_or(SkillSourceRegistryError::CapabilityNotFound)?;
        tree_beneath_no_symlinks_with_hard_cap(
            &context.root_fd,
            relative_path,
            max_entries,
            SKILL_SOURCE_TREE_MAX_ENTRIES,
        )
        .map_err(map_read_error)
    }

    pub fn read_file(
        &self,
        capability_id: &str,
        relative_path: &Path,
        offset: u64,
        max_bytes: u64,
    ) -> Result<ReadFileResult, SkillSourceRegistryError> {
        let context = self
            .contexts
            .get(capability_id)
            .ok_or(SkillSourceRegistryError::CapabilityNotFound)?;
        read_file_beneath_no_follow(&context.root_fd, relative_path, offset, max_bytes)
            .map_err(map_read_error)
    }

    pub fn unregister(&mut self, capability_id: &str) -> Result<(), SkillSourceRegistryError> {
        self.contexts
            .remove(capability_id)
            .map(|_| ())
            .ok_or(SkillSourceRegistryError::CapabilityNotFound)
    }
}

fn map_read_error(error: WorkspaceReadError) -> SkillSourceRegistryError {
    match error {
        WorkspaceReadError::InvalidPath | WorkspaceReadError::BoundaryViolation => {
            SkillSourceRegistryError::AccessDenied
        }
        WorkspaceReadError::BoundaryUnavailable => {
            SkillSourceRegistryError::FilesystemBoundaryUnavailable
        }
        WorkspaceReadError::NotFound => SkillSourceRegistryError::NotFound,
        WorkspaceReadError::InvalidUtf8 => SkillSourceRegistryError::InvalidUtf8,
        WorkspaceReadError::LimitExceeded => SkillSourceRegistryError::LimitExceeded,
        WorkspaceReadError::NotRegularFile | WorkspaceReadError::Io(_) => {
            SkillSourceRegistryError::ReadFailed
        }
    }
}

fn next_capability_id() -> String {
    let sequence = NEXT_SKILL_SOURCE_CAPABILITY_ID.fetch_add(1, Ordering::Relaxed);
    format!("sc_{}_{}", std::process::id(), sequence)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        SkillSourceRegistry, SkillSourceRegistryError, inspect_skill_source_root_with_mountinfo,
    };
    use crate::identity::inspect_root;
    use crate::mountinfo::{MountInfoEntry, MountInfoError};

    fn temporary_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "kodegpt-skill-source-unit-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temporary source created");
        root
    }

    #[test]
    fn mount_topology_failure_is_fail_closed() {
        let root = temporary_root("mount-failure");
        let identity = inspect_root(&root).expect("root inspected").identity;
        let mut registry =
            SkillSourceRegistry::with_mountinfo_reader(|| Err(MountInfoError::Malformed));

        assert!(matches!(
            registry.register(&root, &identity),
            Err(SkillSourceRegistryError::MountTopologyUnavailable)
        ));
        fs::remove_dir_all(root).expect("fixture removed");
    }

    #[test]
    fn distinct_visible_roots_with_same_backing_tree_are_rejected() {
        let first = temporary_root("backing-first");
        let second = temporary_root("backing-second");
        let first_identity = inspect_root(&first).expect("first inspected").identity;
        let second_identity = inspect_root(&second).expect("second inspected").identity;
        assert_eq!(first_identity.device_major, second_identity.device_major);
        assert_eq!(first_identity.device_minor, second_identity.device_minor);
        let entries = vec![
            MountInfoEntry {
                device_major: first_identity.device_major,
                device_minor: first_identity.device_minor,
                root: PathBuf::from("/shared-backing"),
                mount_point: first.clone(),
            },
            MountInfoEntry {
                device_major: second_identity.device_major,
                device_minor: second_identity.device_minor,
                root: PathBuf::from("/shared-backing"),
                mount_point: second.clone(),
            },
        ];
        let mut registry = SkillSourceRegistry::with_mountinfo_reader(move || Ok(entries.clone()));

        registry
            .register(&first, &first_identity)
            .expect("first registration succeeds");
        assert!(matches!(
            registry.register(&second, &second_identity),
            Err(SkillSourceRegistryError::RootOverlap)
        ));
        fs::remove_dir_all(first).expect("first removed");
        fs::remove_dir_all(second).expect("second removed");
    }

    #[test]
    fn distinct_visible_source_and_state_aliases_are_rejected_by_backing_tree() {
        let source = temporary_root("state-alias-source");
        let state = temporary_root("state-alias-state");
        let source_identity = inspect_root(&source).expect("source inspected").identity;
        let state_identity = inspect_root(&state).expect("state inspected").identity;
        assert_eq!(source_identity.device_major, state_identity.device_major);
        assert_eq!(source_identity.device_minor, state_identity.device_minor);
        let entries = vec![
            MountInfoEntry {
                device_major: source_identity.device_major,
                device_minor: source_identity.device_minor,
                root: PathBuf::from("/shared-state-backing"),
                mount_point: source.clone(),
            },
            MountInfoEntry {
                device_major: state_identity.device_major,
                device_minor: state_identity.device_minor,
                root: PathBuf::from("/shared-state-backing"),
                mount_point: state.clone(),
            },
        ];

        assert!(matches!(
            inspect_skill_source_root_with_mountinfo(&source, &state, &entries),
            Err(SkillSourceRegistryError::StateOverlap)
        ));
        fs::remove_dir_all(source).expect("source removed");
        fs::remove_dir_all(state).expect("state removed");
    }
}
