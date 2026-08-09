#![forbid(unsafe_code)]

mod identity;

pub use identity::{FilesystemIdentity, InspectRootError, InspectedRoot, inspect_root};
