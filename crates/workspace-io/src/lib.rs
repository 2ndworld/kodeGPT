#![forbid(unsafe_code)]

mod identity;
mod mountinfo;
mod profile;
mod registry;

pub use identity::{FilesystemIdentity, InspectRootError, InspectedRoot, inspect_root};
pub use registry::{WorkspaceRegistration, WorkspaceRegistry, WorkspaceRegistryError};
