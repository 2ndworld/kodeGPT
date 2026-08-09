#![forbid(unsafe_code)]

mod identity;
mod mountinfo;
mod openat;
mod profile;
mod registry;

pub use identity::{FilesystemIdentity, InspectRootError, InspectedRoot, inspect_root};
pub use openat::{
    OpenatBoundaryError, OpenedParent, open_existing_beneath, open_parent_beneath,
    probe_filesystem_boundary,
};
pub use registry::{WorkspaceRegistration, WorkspaceRegistry, WorkspaceRegistryError};
