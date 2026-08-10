#![forbid(unsafe_code)]

use std::sync::Mutex;

// Workspace bind descriptors must temporarily be inheritable for Bubblewrap's --bind-fd surface.
// Serialize every process spawn performed by this crate so no concurrent child can inherit one.
pub(crate) static PROCESS_SPAWN_LOCK: Mutex<()> = Mutex::new(());

mod bubblewrap;
mod capabilities;
mod executable;

pub use bubblewrap::{
    BubblewrapProvider, SandboxChild, SandboxError, SandboxLaunchSpec, SandboxNetworkMode,
    WorkspaceAccess,
};
pub use capabilities::{SandboxCapabilities, SandboxEnforcement, probe_sandbox_capabilities};
pub use executable::{
    BUBBLEWRAP_MINIMUM_VERSION, ExecutableIdentity, ExecutableVersion, TrustedExecutable,
    TrustedExecutableError, resolve_bubblewrap, resolve_trusted_executable,
};
