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
use crate::path_identity::{PathIdentityError, PathIdentityResult, path_identity_beneath};
use crate::profile::{ProjectProfileReadError, read_project_profile};
use crate::read::{
    ReadFileResult, SEARCH_MAX_SNIPPET_BYTES, SearchResult, TreeResult, WorkspaceReadError,
    read_file_beneath, search_utf8_beneath, tree_beneath,
};
use crate::write::{
    EditFileResult, PatchFileAction, PatchFileCommitResult, WorkspaceWriteError, WriteFileResult,
    commit_patch_file_beneath, edit_file_exact_beneath, write_file_atomic_beneath,
};

static NEXT_CAPABILITY_ID: AtomicU64 = AtomicU64::new(1);

type MountInfoReader = Box<dyn Fn() -> Result<Vec<MountInfoEntry>, MountInfoError> + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkspacePhase {
    Opening,
    Ready,
    Closing,
}

#[allow(dead_code)]
struct WorkspaceSecurityContext<P> {
    capability_id: String,
    canonical_display_root: std::path::PathBuf,
    root_fd: OwnedFd,
    persistent_identity: FilesystemIdentity,
    backing_tree_identity: BackingTreeIdentity,
    ceiling: P,
    effective_policy: P,
    phase: WorkspacePhase,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceRegistration {
    pub capability_id: String,
}

#[derive(Debug)]
pub enum WorkspaceRegistryError {
    RootInvalid,
    IdentityChanged,
    MountTopologyUnavailable,
    RootOverlap,
    PolicyEscalation,
    WorkspaceNotReady,
    FilesystemBoundaryUnavailable,
    ProjectProfileReadFailed,
    FileAccessDenied,
    FileNotFound,
    FileInvalidUtf8,
    FileLimitExceeded,
    FileReadFailed,
    FileWriteConflict,
    FileWriteFailed,
    PatchPreconditionFailed,
    PatchTargetExists,
    CapabilityNotFound,
}

impl fmt::Display for WorkspaceRegistryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RootInvalid => formatter.write_str("workspace root is invalid"),
            Self::IdentityChanged => formatter.write_str("workspace filesystem identity changed"),
            Self::MountTopologyUnavailable => {
                formatter.write_str("workspace mount topology is unavailable")
            }
            Self::RootOverlap => formatter.write_str("workspace root overlaps an existing root"),
            Self::PolicyEscalation => {
                formatter.write_str("workspace policy restriction would escalate authority")
            }
            Self::WorkspaceNotReady => {
                formatter.write_str("workspace is not in the required lifecycle phase")
            }
            Self::FilesystemBoundaryUnavailable => {
                formatter.write_str("filesystem boundary semantics are unavailable")
            }
            Self::ProjectProfileReadFailed => {
                formatter.write_str("project profile could not be read safely")
            }
            Self::FileAccessDenied => formatter.write_str("workspace file access was denied"),
            Self::FileNotFound => formatter.write_str("workspace file path was not found"),
            Self::FileInvalidUtf8 => formatter.write_str("workspace file is not valid UTF-8"),
            Self::FileLimitExceeded => {
                formatter.write_str("workspace file operation limit was exceeded")
            }
            Self::FileReadFailed => formatter.write_str("workspace file operation failed"),
            Self::FileWriteConflict => {
                formatter.write_str("workspace file edit conflicted with expected replacements")
            }
            Self::FileWriteFailed => formatter.write_str("workspace file mutation failed"),
            Self::PatchPreconditionFailed => formatter.write_str("workspace patch precondition failed"),
            Self::PatchTargetExists => formatter.write_str("workspace patch create target already exists"),
            Self::CapabilityNotFound => formatter.write_str("workspace capability was not found"),
        }
    }
}

impl std::error::Error for WorkspaceRegistryError {}

pub struct WorkspaceRegistry<P> {
    contexts: HashMap<String, WorkspaceSecurityContext<P>>,
    mountinfo_reader: MountInfoReader,
}

impl<P> WorkspaceRegistry<P> {
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

    #[cfg(test)]
    fn len(&self) -> usize {
        self.contexts.len()
    }

    pub fn register(
        &mut self,
        root_path: &Path,
        expected_identity: &FilesystemIdentity,
        ceiling: P,
    ) -> Result<WorkspaceRegistration, WorkspaceRegistryError>
    where
        P: Clone,
    {
        let inspected = inspect_root(root_path).map_err(|_| WorkspaceRegistryError::RootInvalid)?;
        if inspected.identity != *expected_identity {
            return Err(WorkspaceRegistryError::IdentityChanged);
        }

        let mountinfo = (self.mountinfo_reader)()
            .map_err(|_| WorkspaceRegistryError::MountTopologyUnavailable)?;
        let backing_tree_identity = backing_tree_for_path(&mountinfo, &inspected.canonical_root)
            .map_err(|_| WorkspaceRegistryError::MountTopologyUnavailable)?;

        let root_file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&inspected.canonical_root)
            .map_err(|_| WorkspaceRegistryError::RootInvalid)?;
        let root_metadata = root_file
            .metadata()
            .map_err(|_| WorkspaceRegistryError::RootInvalid)?;
        if !root_metadata.is_dir() {
            return Err(WorkspaceRegistryError::RootInvalid);
        }
        let fd_identity = filesystem_identity(&root_metadata);
        if fd_identity != inspected.identity || fd_identity != *expected_identity {
            return Err(WorkspaceRegistryError::IdentityChanged);
        }
        if backing_tree_identity.device_major != fd_identity.device_major
            || backing_tree_identity.device_minor != fd_identity.device_minor
        {
            return Err(WorkspaceRegistryError::MountTopologyUnavailable);
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
            return Err(WorkspaceRegistryError::RootOverlap);
        }

        let capability_id = next_capability_id();
        let effective_policy = ceiling.clone();
        let root_fd = OwnedFd::from(root_file);
        self.contexts.insert(
            capability_id.clone(),
            WorkspaceSecurityContext {
                capability_id: capability_id.clone(),
                canonical_display_root: inspected.canonical_root,
                root_fd,
                persistent_identity: fd_identity,
                backing_tree_identity,
                ceiling,
                effective_policy,
                phase: WorkspacePhase::Opening,
            },
        );

        Ok(WorkspaceRegistration { capability_id })
    }

    pub fn read_project_profile(
        &self,
        capability_id: &str,
    ) -> Result<Option<String>, WorkspaceRegistryError> {
        let context = self
            .contexts
            .get(capability_id)
            .ok_or(WorkspaceRegistryError::CapabilityNotFound)?;
        if context.phase != WorkspacePhase::Opening {
            return Err(WorkspaceRegistryError::WorkspaceNotReady);
        }
        read_project_profile(&context.root_fd).map_err(|error| match error {
            ProjectProfileReadError::BoundaryUnavailable => {
                WorkspaceRegistryError::FilesystemBoundaryUnavailable
            }
            ProjectProfileReadError::Unsafe
            | ProjectProfileReadError::TooLarge
            | ProjectProfileReadError::InvalidUtf8
            | ProjectProfileReadError::Io(_) => WorkspaceRegistryError::ProjectProfileReadFailed,
        })
    }

    pub fn restrict_policy_with<E, F>(
        &mut self,
        capability_id: &str,
        restriction: P,
        resolve: F,
    ) -> Result<(), WorkspaceRegistryError>
    where
        F: FnOnce(&P, &P) -> Result<P, E>,
    {
        let context = self
            .contexts
            .get_mut(capability_id)
            .ok_or(WorkspaceRegistryError::CapabilityNotFound)?;
        if context.phase != WorkspacePhase::Opening {
            return Err(WorkspaceRegistryError::WorkspaceNotReady);
        }
        let next = resolve(&context.effective_policy, &restriction)
            .map_err(|_| WorkspaceRegistryError::PolicyEscalation)?;
        context.effective_policy = next;
        Ok(())
    }

    pub fn activate(&mut self, capability_id: &str) -> Result<(), WorkspaceRegistryError> {
        let context = self
            .contexts
            .get_mut(capability_id)
            .ok_or(WorkspaceRegistryError::CapabilityNotFound)?;
        if context.phase != WorkspacePhase::Opening {
            return Err(WorkspaceRegistryError::WorkspaceNotReady);
        }
        context.phase = WorkspacePhase::Ready;
        Ok(())
    }

    pub fn read_file(
        &self,
        capability_id: &str,
        relative_path: &Path,
        offset: u64,
        max_bytes: u64,
    ) -> Result<ReadFileResult, WorkspaceRegistryError> {
        let context = self.ready_context(capability_id)?;
        read_file_beneath(&context.root_fd, relative_path, offset, max_bytes)
            .map_err(map_workspace_read_error)
    }

    pub fn tree(
        &self,
        capability_id: &str,
        relative_path: &Path,
        max_entries: usize,
    ) -> Result<TreeResult, WorkspaceRegistryError> {
        let context = self.ready_context(capability_id)?;
        tree_beneath(&context.root_fd, relative_path, max_entries).map_err(map_workspace_read_error)
    }

    pub fn search(
        &self,
        capability_id: &str,
        relative_path: &Path,
        query: &str,
        max_matches: usize,
    ) -> Result<SearchResult, WorkspaceRegistryError> {
        let context = self.ready_context(capability_id)?;
        search_utf8_beneath(
            &context.root_fd,
            relative_path,
            query,
            max_matches,
            SEARCH_MAX_SNIPPET_BYTES,
        )
        .map_err(map_workspace_read_error)
    }

    pub fn path_identity(
        &self,
        capability_id: &str,
        relative_path: &Path,
        include_sha256: bool,
    ) -> Result<PathIdentityResult, WorkspaceRegistryError> {
        let context = self.ready_context(capability_id)?;
        let root_fd = context
            .root_fd
            .try_clone()
            .map_err(|_| WorkspaceRegistryError::FileReadFailed)?;
        path_identity_beneath(&root_fd, relative_path, include_sha256).map_err(map_path_identity_error)
    }

    pub fn write_file_with_policy<F>(
        &self,
        capability_id: &str,
        relative_path: &Path,
        contents: &[u8],
        authorize: F,
    ) -> Result<WriteFileResult, WorkspaceRegistryError>
    where
        F: FnOnce(&P) -> bool,
    {
        let context = self.ready_context(capability_id)?;
        if !authorize(&context.effective_policy) {
            return Err(WorkspaceRegistryError::FileAccessDenied);
        }
        write_file_atomic_beneath(&context.root_fd, relative_path, contents)
            .map_err(map_workspace_write_error)
    }

    pub fn edit_file_with_policy<F>(
        &self,
        capability_id: &str,
        relative_path: &Path,
        old_text: &str,
        new_text: &str,
        expected_replacements: u64,
        authorize: F,
    ) -> Result<EditFileResult, WorkspaceRegistryError>
    where
        F: FnOnce(&P) -> bool,
    {
        let context = self.ready_context(capability_id)?;
        if !authorize(&context.effective_policy) {
            return Err(WorkspaceRegistryError::FileAccessDenied);
        }
        edit_file_exact_beneath(
            &context.root_fd,
            relative_path,
            old_text,
            new_text,
            expected_replacements,
        )
        .map_err(map_workspace_write_error)
    }

    pub fn commit_patch_file_with_policy<F>(
        &self,
        capability_id: &str,
        relative_path: &Path,
        action: PatchFileAction,
        expected_sha256: Option<&str>,
        content: Option<&[u8]>,
        authorize: F,
    ) -> Result<PatchFileCommitResult, WorkspaceRegistryError>
    where
        F: FnOnce(&P) -> bool,
    {
        let context = self.ready_context(capability_id)?;
        if !authorize(&context.effective_policy) {
            return Err(WorkspaceRegistryError::FileAccessDenied);
        }
        commit_patch_file_beneath(
            &context.root_fd,
            relative_path,
            action,
            expected_sha256,
            content,
        )
        .map_err(map_workspace_write_error)
    }

    pub fn require_ready(&self, capability_id: &str) -> Result<(), WorkspaceRegistryError> {
        self.ready_context(capability_id).map(|_| ())
    }

    pub fn duplicate_ready_root_fd(
        &self,
        capability_id: &str,
    ) -> Result<OwnedFd, WorkspaceRegistryError> {
        let context = self.ready_context(capability_id)?;
        context
            .root_fd
            .try_clone()
            .map_err(|_| WorkspaceRegistryError::FileReadFailed)
    }

    pub fn clone_ready_policy(&self, capability_id: &str) -> Result<P, WorkspaceRegistryError>
    where
        P: Clone,
    {
        self.ready_context(capability_id)
            .map(|context| context.effective_policy.clone())
    }

    fn ready_context(
        &self,
        capability_id: &str,
    ) -> Result<&WorkspaceSecurityContext<P>, WorkspaceRegistryError> {
        let context = self
            .contexts
            .get(capability_id)
            .ok_or(WorkspaceRegistryError::CapabilityNotFound)?;
        if context.phase != WorkspacePhase::Ready {
            return Err(WorkspaceRegistryError::WorkspaceNotReady);
        }
        Ok(context)
    }

    pub fn begin_close(&mut self, capability_id: &str) -> Result<(), WorkspaceRegistryError> {
        let context = self
            .contexts
            .get_mut(capability_id)
            .ok_or(WorkspaceRegistryError::CapabilityNotFound)?;
        match context.phase {
            WorkspacePhase::Opening => Err(WorkspaceRegistryError::WorkspaceNotReady),
            WorkspacePhase::Ready => {
                context.phase = WorkspacePhase::Closing;
                Ok(())
            }
            WorkspacePhase::Closing => Ok(()),
        }
    }

    pub fn cancel_executions(&mut self, capability_id: &str) -> Result<(), WorkspaceRegistryError> {
        let context = self
            .contexts
            .get(capability_id)
            .ok_or(WorkspaceRegistryError::CapabilityNotFound)?;
        if context.phase != WorkspacePhase::Closing {
            return Err(WorkspaceRegistryError::WorkspaceNotReady);
        }
        Ok(())
    }

    pub fn unregister(&mut self, capability_id: &str) -> Result<(), WorkspaceRegistryError> {
        let context = self
            .contexts
            .get(capability_id)
            .ok_or(WorkspaceRegistryError::CapabilityNotFound)?;
        if context.phase == WorkspacePhase::Ready {
            return Err(WorkspaceRegistryError::WorkspaceNotReady);
        }
        self.contexts.remove(capability_id);
        Ok(())
    }

    #[cfg(test)]
    fn retained_fd_identity(&self, capability_id: &str) -> Option<FilesystemIdentity> {
        let context = self.contexts.get(capability_id)?;
        let cloned = context.root_fd.try_clone().ok()?;
        let file = fs::File::from(cloned);
        let metadata = file.metadata().ok()?;
        Some(filesystem_identity(&metadata))
    }
}

impl<P> Default for WorkspaceRegistry<P> {
    fn default() -> Self {
        Self::new()
    }
}

fn map_workspace_read_error(error: WorkspaceReadError) -> WorkspaceRegistryError {
    match error {
        WorkspaceReadError::InvalidPath | WorkspaceReadError::BoundaryViolation => {
            WorkspaceRegistryError::FileAccessDenied
        }
        WorkspaceReadError::BoundaryUnavailable => {
            WorkspaceRegistryError::FilesystemBoundaryUnavailable
        }
        WorkspaceReadError::NotFound => WorkspaceRegistryError::FileNotFound,
        WorkspaceReadError::InvalidUtf8 => WorkspaceRegistryError::FileInvalidUtf8,
        WorkspaceReadError::LimitExceeded => WorkspaceRegistryError::FileLimitExceeded,
        WorkspaceReadError::NotRegularFile | WorkspaceReadError::Io(_) => {
            WorkspaceRegistryError::FileReadFailed
        }
    }
}

fn map_path_identity_error(error: PathIdentityError) -> WorkspaceRegistryError {
    match error {
        PathIdentityError::InvalidPath | PathIdentityError::BoundaryViolation => {
            WorkspaceRegistryError::FileAccessDenied
        }
        PathIdentityError::BoundaryUnavailable => {
            WorkspaceRegistryError::FilesystemBoundaryUnavailable
        }
        PathIdentityError::ChangedDuringInspection | PathIdentityError::Io(_) => {
            WorkspaceRegistryError::FileReadFailed
        }
    }
}

fn map_workspace_write_error(error: WorkspaceWriteError) -> WorkspaceRegistryError {
    match error {
        WorkspaceWriteError::InvalidPath | WorkspaceWriteError::BoundaryViolation => {
            WorkspaceRegistryError::FileAccessDenied
        }
        WorkspaceWriteError::BoundaryUnavailable => {
            WorkspaceRegistryError::FilesystemBoundaryUnavailable
        }
        WorkspaceWriteError::NotFound => WorkspaceRegistryError::FileNotFound,
        WorkspaceWriteError::InvalidUtf8 => WorkspaceRegistryError::FileInvalidUtf8,
        WorkspaceWriteError::Conflict => WorkspaceRegistryError::FileWriteConflict,
        WorkspaceWriteError::PreconditionFailed => WorkspaceRegistryError::PatchPreconditionFailed,
        WorkspaceWriteError::TargetExists => WorkspaceRegistryError::PatchTargetExists,
        WorkspaceWriteError::NotRegularFile | WorkspaceWriteError::Io(_) => {
            WorkspaceRegistryError::FileWriteFailed
        }
    }
}

fn roots_overlap(
    existing_visible: &Path,
    existing_backing: &BackingTreeIdentity,
    existing_identity: &FilesystemIdentity,
    candidate_visible: &Path,
    candidate_backing: &BackingTreeIdentity,
    candidate_identity: &FilesystemIdentity,
) -> bool {
    if path_overlap(existing_visible, candidate_visible) {
        return true;
    }

    if existing_backing.device_major == candidate_backing.device_major
        && existing_backing.device_minor == candidate_backing.device_minor
        && path_overlap(&existing_backing.path, &candidate_backing.path)
    {
        return true;
    }

    existing_identity == candidate_identity
}

fn path_overlap(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}

fn next_capability_id() -> String {
    let sequence = NEXT_CAPABILITY_ID.fetch_add(1, Ordering::Relaxed);
    format!("kc_{}_{}", std::process::id(), sequence)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{WorkspaceRegistry, WorkspaceRegistryError, roots_overlap};
    use crate::identity::{FilesystemIdentity, filesystem_identity, inspect_root};
    use crate::mountinfo::{BackingTreeIdentity, MountInfoError, parse_mountinfo};

    fn temporary_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "kodegpt-registry-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temporary root created");
        root
    }

    fn mount_line(
        id: u64,
        identity: &FilesystemIdentity,
        root: &str,
        mount_point: &Path,
    ) -> String {
        format!(
            "{id} 1 {}:{} {root} {} rw,relatime - ext4 /dev/test rw\n",
            identity.device_major,
            identity.device_minor,
            mount_point.display()
        )
    }

    fn registry_with_mountinfo(text: String) -> WorkspaceRegistry<()> {
        WorkspaceRegistry::with_mountinfo_reader(move || parse_mountinfo(&text))
    }

    #[test]
    fn registry_rejects_distinct_visible_bind_aliases_with_same_backing_tree() {
        let left = temporary_root("bind-left");
        let right = temporary_root("bind-right");
        let left_identity = inspect_root(&left).expect("left inspected").identity;
        let right_identity = inspect_root(&right).expect("right inspected").identity;
        let mountinfo = format!(
            "{}{}",
            mount_line(101, &left_identity, "/srv/shared", &left),
            mount_line(102, &right_identity, "/srv/shared", &right)
        );
        let mut registry = registry_with_mountinfo(mountinfo);

        registry
            .register(&left, &left_identity, ())
            .expect("first root registers");
        let error = registry
            .register(&right, &right_identity, ())
            .expect_err("backing alias must be rejected");

        assert!(matches!(error, WorkspaceRegistryError::RootOverlap));
        assert_eq!(registry.len(), 1);
        fs::remove_dir_all(left).expect("left removed");
        fs::remove_dir_all(right).expect("right removed");
    }

    #[test]
    fn registry_rejects_backing_ancestor_and_descendant_in_both_orders() {
        let parent_visible = temporary_root("backing-parent");
        let child_visible = temporary_root("backing-child");
        let parent_identity = inspect_root(&parent_visible)
            .expect("parent inspected")
            .identity;
        let child_identity = inspect_root(&child_visible)
            .expect("child inspected")
            .identity;
        let mountinfo = format!(
            "{}{}",
            mount_line(201, &parent_identity, "/srv/repos", &parent_visible),
            mount_line(202, &child_identity, "/srv/repos/project", &child_visible)
        );

        let mut parent_first = registry_with_mountinfo(mountinfo.clone());
        parent_first
            .register(&parent_visible, &parent_identity, ())
            .expect("parent registers");
        assert!(matches!(
            parent_first.register(&child_visible, &child_identity, ()),
            Err(WorkspaceRegistryError::RootOverlap)
        ));

        let mut child_first = registry_with_mountinfo(mountinfo);
        child_first
            .register(&child_visible, &child_identity, ())
            .expect("child registers");
        assert!(matches!(
            child_first.register(&parent_visible, &parent_identity, ()),
            Err(WorkspaceRegistryError::RootOverlap)
        ));

        fs::remove_dir_all(parent_visible).expect("parent removed");
        fs::remove_dir_all(child_visible).expect("child removed");
    }

    #[test]
    fn exact_device_inode_alias_is_an_overlap_dimension() {
        let identity = FilesystemIdentity {
            device_major: 8,
            device_minor: 1,
            inode: "12345".to_owned(),
        };
        let existing_backing = BackingTreeIdentity {
            device_major: 8,
            device_minor: 1,
            path: PathBuf::from("/backing/left"),
        };
        let candidate_backing = BackingTreeIdentity {
            device_major: 8,
            device_minor: 1,
            path: PathBuf::from("/backing/right"),
        };

        assert!(roots_overlap(
            Path::new("/visible/left"),
            &existing_backing,
            &identity,
            Path::new("/visible/right"),
            &candidate_backing,
            &identity,
        ));
    }

    #[test]
    fn registry_fails_closed_when_mount_topology_is_unavailable_or_malformed() {
        let root = temporary_root("mount-failure");
        let identity = inspect_root(&root).expect("root inspected").identity;

        let mut unavailable = WorkspaceRegistry::with_mountinfo_reader(|| {
            Err(MountInfoError::Io(io::Error::new(
                io::ErrorKind::NotFound,
                "mountinfo unavailable",
            )))
        });
        assert!(matches!(
            unavailable.register(&root, &identity, ()),
            Err(WorkspaceRegistryError::MountTopologyUnavailable)
        ));
        assert_eq!(unavailable.len(), 0);

        let mut malformed = WorkspaceRegistry::with_mountinfo_reader(|| parse_mountinfo("invalid"));
        assert!(matches!(
            malformed.register(&root, &identity, ()),
            Err(WorkspaceRegistryError::MountTopologyUnavailable)
        ));
        assert_eq!(malformed.len(), 0);

        fs::remove_dir_all(root).expect("root removed");
    }

    #[test]
    fn registry_enforces_opening_ready_closing_phase_transitions() {
        let root = temporary_root("phase-transitions");
        let identity = inspect_root(&root).expect("root inspected").identity;
        let mountinfo = mount_line(250, &identity, "/srv/phases", &root);
        let mut registry = registry_with_mountinfo(mountinfo);
        let registration = registry
            .register(&root, &identity, ())
            .expect("root registers");
        let capability_id = registration.capability_id;

        assert!(matches!(
            registry.require_ready(&capability_id),
            Err(WorkspaceRegistryError::WorkspaceNotReady)
        ));
        assert!(matches!(
            registry.duplicate_ready_root_fd(&capability_id),
            Err(WorkspaceRegistryError::WorkspaceNotReady)
        ));
        registry
            .restrict_policy_with(&capability_id, (), |_, _| Ok::<(), ()>(()))
            .expect("opening policy restriction accepted");
        registry
            .activate(&capability_id)
            .expect("workspace activates");
        registry
            .require_ready(&capability_id)
            .expect("ready accepted");
        let duplicated = registry
            .duplicate_ready_root_fd(&capability_id)
            .expect("ready root fd duplicates");
        let duplicated_file = fs::File::from(duplicated);
        assert_eq!(
            filesystem_identity(&duplicated_file.metadata().expect("duplicated metadata")),
            identity
        );
        assert!(matches!(
            registry.restrict_policy_with(&capability_id, (), |_, _| Ok::<(), ()>(())),
            Err(WorkspaceRegistryError::WorkspaceNotReady)
        ));
        assert!(matches!(
            registry.unregister(&capability_id),
            Err(WorkspaceRegistryError::WorkspaceNotReady)
        ));

        registry.begin_close(&capability_id).expect("close begins");
        registry
            .begin_close(&capability_id)
            .expect("begin close is idempotent while closing");
        assert!(matches!(
            registry.require_ready(&capability_id),
            Err(WorkspaceRegistryError::WorkspaceNotReady)
        ));
        assert!(matches!(
            registry.duplicate_ready_root_fd(&capability_id),
            Err(WorkspaceRegistryError::WorkspaceNotReady)
        ));
        registry
            .cancel_executions(&capability_id)
            .expect("closing cancellation accepted");
        registry
            .unregister(&capability_id)
            .expect("closing unregisters");
        assert_eq!(registry.len(), 0);

        fs::remove_dir_all(root).expect("root removed");
    }

    #[test]
    fn registry_retains_root_fd_and_revalidates_identity_after_open() {
        let root = temporary_root("retained-fd");
        let displaced = root.with_extension("original");
        let identity = inspect_root(&root).expect("root inspected").identity;
        let mountinfo = mount_line(301, &identity, "/srv/retained", &root);
        let mut registry = registry_with_mountinfo(mountinfo);

        let registration = registry
            .register(&root, &identity, ())
            .expect("root registers");
        fs::rename(&root, &displaced).expect("registered root displaced");
        fs::create_dir(&root).expect("replacement root created");

        assert_eq!(
            registry
                .retained_fd_identity(&registration.capability_id)
                .expect("retained fd identity"),
            identity
        );
        assert_ne!(
            inspect_root(&root).expect("replacement inspected").identity,
            identity
        );

        fs::remove_dir_all(root).expect("replacement removed");
        fs::remove_dir_all(displaced).expect("original removed");
    }
}
