#![forbid(unsafe_code)]

mod identity;
mod mountinfo;
mod openat;
mod path_identity;
mod profile;
mod read;
mod registry;
mod semantic_scope;
mod skill_source;
mod write;

pub use identity::{FilesystemIdentity, InspectRootError, InspectedRoot, inspect_root};
pub use openat::{
    OpenatBoundaryError, OpenedParent, ensure_root_child_directory_no_symlinks,
    open_directory_beneath, open_directory_beneath_no_symlinks, open_existing_beneath,
    open_parent_beneath, probe_filesystem_boundary,
};
pub use path_identity::{
    PATH_IDENTITY_MAX_HASH_BYTES, PathIdentityError, PathIdentityKind, PathIdentityResult,
    path_identity_beneath,
};
pub use read::{
    INLINE_READ_MAX_BYTES, ReadBytesResult, ReadFileResult, SEARCH_MAX_MATCHES,
    SEARCH_MAX_SNIPPET_BYTES, SearchMatch, SearchResult, TREE_DEFAULT_MAX_ENTRIES,
    TREE_MAX_ENTRIES, TreeEntry, TreeEntryKind, TreeResult, WorkspaceReadError, read_bytes_beneath,
    read_file_beneath, search_utf8_beneath, search_utf8_beneath_scoped, tree_beneath,
    tree_beneath_scoped,
};
pub use registry::{
    ReadyWorkspaceRoot, WorkspaceRegistration, WorkspaceRegistry, WorkspaceRegistryError,
};
pub use semantic_scope::TraversalScope;
pub use skill_source::{
    SKILL_SOURCE_TREE_MAX_ENTRIES, SkillSourceRegistration, SkillSourceRegistry,
    SkillSourceRegistryError, inspect_skill_source_root,
};
pub use write::{
    EditFileResult, PatchFileAction, PatchFileCommitResult, WorkspaceWriteError, WriteFileResult,
    commit_patch_file_beneath, edit_file_exact_beneath, write_file_atomic_beneath,
};
