#![forbid(unsafe_code)]

mod identity;
mod mountinfo;
mod openat;
mod path_identity;
mod profile;
mod read;
mod registry;
mod write;

pub use identity::{FilesystemIdentity, InspectRootError, InspectedRoot, inspect_root};
pub use openat::{
    OpenatBoundaryError, OpenedParent, open_directory_beneath, open_existing_beneath,
    open_parent_beneath, probe_filesystem_boundary,
};
pub use path_identity::{
    PATH_IDENTITY_MAX_HASH_BYTES, PathIdentityError, PathIdentityKind, PathIdentityResult,
    path_identity_beneath,
};
pub use read::{
    INLINE_READ_MAX_BYTES, ReadFileResult, SEARCH_MAX_MATCHES, SEARCH_MAX_SNIPPET_BYTES,
    SearchMatch, SearchResult, TREE_DEFAULT_MAX_ENTRIES, TREE_MAX_ENTRIES, TreeEntry,
    TreeEntryKind, TreeResult, WorkspaceReadError, read_file_beneath, search_utf8_beneath,
    tree_beneath,
};
pub use registry::{WorkspaceRegistration, WorkspaceRegistry, WorkspaceRegistryError};
pub use write::{
    EditFileResult, PatchFileAction, PatchFileCommitResult, WorkspaceWriteError, WriteFileResult,
    commit_patch_file_beneath, edit_file_exact_beneath, write_file_atomic_beneath,
};
