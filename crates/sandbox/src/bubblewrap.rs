use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::os::fd::{AsRawFd, OwnedFd};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};

use rustix::io::{fcntl_setfd, FdFlags};

use crate::executable::{resolve_bubblewrap, TrustedExecutable, TrustedExecutableError};
use crate::PROCESS_SPAWN_LOCK;

const CHILD_HOME: &str = "/home/kodegpt";
const CHILD_WORKSPACE: &str = "/workspace";
const FIXED_PATH: &str = "/usr/local/bin:/usr/bin:/bin";
const RUNTIME_SYSTEM_PATHS: [&str; 5] = ["/usr", "/bin", "/lib", "/lib64", "/etc"];
const RESERVED_ENV: [&str; 4] = ["HOME", "PATH", "TMPDIR", "PWD"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxNetworkMode {
    Unrestricted,
    Deny,
    Localhost,
    Allowlist,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceAccess {
    ReadOnly,
    ReadWrite,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxLaunchSpec {
    pub program: TrustedExecutable,
    pub args: Vec<OsString>,
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
    pub network: SandboxNetworkMode,
    pub workspace_access: WorkspaceAccess,
}

impl SandboxLaunchSpec {
    pub fn new(program: TrustedExecutable) -> Self {
        Self {
            program,
            args: Vec::new(),
            env: BTreeMap::new(),
            cwd: PathBuf::from(CHILD_WORKSPACE),
            network: SandboxNetworkMode::Deny,
            workspace_access: WorkspaceAccess::ReadOnly,
        }
    }
}

#[derive(Debug)]
pub enum SandboxError {
    TrustedExecutable(TrustedExecutableError),
    Io(std::io::Error),
    InvalidCwd,
    ReservedEnvironment,
    NetworkPolicyUnavailable,
    SandboxUnavailable(String),
}

impl fmt::Display for SandboxError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TrustedExecutable(error) => write!(formatter, "{error}"),
            Self::Io(error) => write!(formatter, "sandbox I/O failed: {error}"),
            Self::InvalidCwd => formatter.write_str("sandbox cwd must remain beneath /workspace"),
            Self::ReservedEnvironment => {
                formatter.write_str("sandbox environment attempts to override a reserved value")
            }
            Self::NetworkPolicyUnavailable => formatter.write_str("NETWORK_POLICY_UNAVAILABLE"),
            Self::SandboxUnavailable(reason) => write!(formatter, "SANDBOX_UNAVAILABLE: {reason}"),
        }
    }
}

impl std::error::Error for SandboxError {}

impl From<std::io::Error> for SandboxError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<TrustedExecutableError> for SandboxError {
    fn from(error: TrustedExecutableError) -> Self {
        Self::TrustedExecutable(error)
    }
}

pub struct SandboxChild {
    child: Child,
    process_group: i32,
}

impl SandboxChild {
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn process_group(&self) -> i32 {
        self.process_group
    }

    pub fn child_mut(&mut self) -> &mut Child {
        &mut self.child
    }

    pub fn wait_with_output(self) -> Result<Output, std::io::Error> {
        self.child.wait_with_output()
    }
}

#[derive(Debug, Clone)]
pub struct BubblewrapProvider {
    executable: TrustedExecutable,
}

impl BubblewrapProvider {
    pub fn discover() -> Result<Self, SandboxError> {
        Ok(Self {
            executable: resolve_bubblewrap()?,
        })
    }

    pub fn executable(&self) -> &TrustedExecutable {
        &self.executable
    }

    pub fn spawn(
        &self,
        workspace_root: &OwnedFd,
        spec: &SandboxLaunchSpec,
    ) -> Result<SandboxChild, SandboxError> {
        validate_spec(spec)?;
        let _spawn_guard = PROCESS_SPAWN_LOCK.lock().map_err(|_| {
            SandboxError::SandboxUnavailable("sandbox spawn serialization failed".to_owned())
        })?;
        let inherited_workspace_fd = workspace_root.try_clone()?;
        fcntl_setfd(&inherited_workspace_fd, FdFlags::empty())
            .map_err(|error| std::io::Error::from_raw_os_error(error.raw_os_error()))?;

        let mut command = self.build_command(inherited_workspace_fd.as_raw_fd(), spec)?;
        self.executable.revalidate()?;
        spec.program.revalidate()?;
        let child = command.spawn()?;
        // --new-session performs setsid() inside Bubblewrap; do not pre-create a process group,
        // because a process-group leader cannot become a session leader. On successful setup the
        // spawned Bubblewrap PID is the session/process-group leader for later cancellation.
        let process_group = child.id() as i32;
        drop(inherited_workspace_fd);
        Ok(SandboxChild {
            child,
            process_group,
        })
    }

    pub fn run_capture(
        &self,
        workspace_root: &OwnedFd,
        spec: &SandboxLaunchSpec,
    ) -> Result<Output, SandboxError> {
        self.spawn(workspace_root, spec)?
            .wait_with_output()
            .map_err(SandboxError::Io)
    }

    fn build_command(
        &self,
        workspace_fd: i32,
        spec: &SandboxLaunchSpec,
    ) -> Result<Command, SandboxError> {
        if matches!(
            spec.network,
            SandboxNetworkMode::Localhost | SandboxNetworkMode::Allowlist
        ) {
            return Err(SandboxError::NetworkPolicyUnavailable);
        }

        let mut command = Command::new(self.executable.canonical_path());
        command
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .args([
                "--unshare-user",
                "--unshare-pid",
                "--unshare-ipc",
                "--unshare-uts",
                "--disable-userns",
                "--assert-userns-disabled",
                "--new-session",
                "--die-with-parent",
                "--clearenv",
                "--uid",
                "0",
                "--gid",
                "0",
                "--cap-drop",
                "ALL",
            ]);

        if spec.network == SandboxNetworkMode::Deny {
            command.arg("--unshare-net");
        }

        for system_path in RUNTIME_SYSTEM_PATHS {
            if fs::metadata(system_path).is_ok() {
                command.args(["--ro-bind", system_path, system_path]);
            }
        }

        command.args([
            "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--chmod", "01777", "/tmp",
            "--dir", "/home", "--dir", CHILD_HOME, "--chmod", "0700", CHILD_HOME,
        ]);

        match spec.workspace_access {
            WorkspaceAccess::ReadOnly => {
                command.args(["--ro-bind-fd", &workspace_fd.to_string(), CHILD_WORKSPACE]);
            }
            WorkspaceAccess::ReadWrite => {
                command.args(["--bind-fd", &workspace_fd.to_string(), CHILD_WORKSPACE]);
            }
        }

        command.args([
            "--setenv", "HOME", CHILD_HOME, "--setenv", "PATH", FIXED_PATH, "--setenv", "TMPDIR",
            "/tmp",
        ]);
        for (name, value) in &spec.env {
            command.args(["--setenv", name, value]);
        }

        command.arg("--chdir").arg(&spec.cwd);
        command
            .arg("--")
            .arg(spec.program.canonical_path())
            .args(&spec.args);
        Ok(command)
    }
}

fn validate_spec(spec: &SandboxLaunchSpec) -> Result<(), SandboxError> {
    if !cwd_is_beneath_workspace(&spec.cwd) {
        return Err(SandboxError::InvalidCwd);
    }
    if spec.env.keys().any(|name| {
        RESERVED_ENV.contains(&name.as_str()) || name.contains('=') || name.contains('\0')
    }) {
        return Err(SandboxError::ReservedEnvironment);
    }
    if spec.env.values().any(|value| value.contains('\0')) {
        return Err(SandboxError::ReservedEnvironment);
    }
    Ok(())
}

fn cwd_is_beneath_workspace(cwd: &Path) -> bool {
    if !cwd.is_absolute() || !cwd.starts_with(CHILD_WORKSPACE) {
        return false;
    }
    !cwd.components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use super::{
        cwd_is_beneath_workspace, BubblewrapProvider, SandboxError, SandboxLaunchSpec,
        SandboxNetworkMode, WorkspaceAccess,
    };
    use crate::resolve_trusted_executable;

    #[test]
    fn child_cwd_must_stay_in_workspace_surface() {
        assert!(cwd_is_beneath_workspace(
            PathBuf::from("/workspace/src").as_path()
        ));
        assert!(!cwd_is_beneath_workspace(
            PathBuf::from("/workspace/../tmp").as_path()
        ));
        assert!(!cwd_is_beneath_workspace(PathBuf::from("/tmp").as_path()));
    }

    #[test]
    fn reserved_environment_and_unsupported_network_modes_fail_closed() {
        let mut spec = SandboxLaunchSpec::new(
            resolve_trusted_executable("env").expect("trusted env executable"),
        );
        for reserved in ["HOME", "PATH", "TMPDIR", "PWD"] {
            spec.env = BTreeMap::from([(reserved.to_owned(), "/host".to_owned())]);
            assert!(
                matches!(
                    super::validate_spec(&spec),
                    Err(SandboxError::ReservedEnvironment)
                ),
                "reserved environment key must fail closed: {reserved}"
            );
        }

        spec.env.clear();
        let provider = BubblewrapProvider::discover().expect("trusted Bubblewrap prerequisite");
        for network in [SandboxNetworkMode::Localhost, SandboxNetworkMode::Allowlist] {
            spec.network = network;
            assert!(matches!(
                provider.build_command(3, &spec),
                Err(SandboxError::NetworkPolicyUnavailable)
            ));
        }
        assert_eq!(spec.workspace_access, WorkspaceAccess::ReadOnly);
    }
}
