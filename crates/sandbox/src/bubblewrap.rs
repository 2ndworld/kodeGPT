use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io::{BufRead, BufReader};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::Duration;

use rustix::io::{FdFlags, fcntl_setfd};

use crate::PROCESS_SPAWN_LOCK;
use crate::executable::{
    ExplicitExecutableMount, SANDBOX_MARKER_ENV, TrustedExecutable, TrustedExecutableError,
    open_explicit_directory_from_env, resolve_bubblewrap,
};
use crate::git_metadata::{LinkedWorktreeGitMetadata, open_linked_worktree_git_metadata};

const CHILD_COREPACK_HOME: &str = "/opt/kodegpt-corepack";
const CHILD_HOME: &str = "/home/kodegpt";
const CHILD_CARGO_HOME: &str = "/home/kodegpt/.cargo";
const CHILD_TOOL_ROOT: &str = "/opt/kodegpt-toolchain";
const CHILD_WORKSPACE: &str = "/workspace";
const FIXED_PATH: &str = "/usr/local/bin:/usr/bin:/bin";
const RUNTIME_SYSTEM_PATHS: [&str; 5] = ["/usr", "/bin", "/lib", "/lib64", "/etc"];
const RESOLVER_RUNTIME_DIRECTORY: &str = "/run/systemd/resolve";
const RESERVED_ENV: [&str; 6] = [
    "COREPACK_HOME",
    "HOME",
    "PATH",
    "TMPDIR",
    "PWD",
    SANDBOX_MARKER_ENV,
];

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitMetadataAccess {
    None,
    ReadOnly,
    ReadWrite,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxLaunchSpec {
    pub program: TrustedExecutable,
    pub auxiliary_programs: Vec<TrustedExecutable>,
    pub args: Vec<OsString>,
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
    pub network: SandboxNetworkMode,
    pub workspace_access: WorkspaceAccess,
    pub git_metadata_access: GitMetadataAccess,
    pub require_git_metadata: bool,
    pub cargo_home: Option<PathBuf>,
}

impl SandboxLaunchSpec {
    pub fn new(program: TrustedExecutable) -> Self {
        Self {
            program,
            auxiliary_programs: Vec::new(),
            args: Vec::new(),
            env: BTreeMap::new(),
            cwd: PathBuf::from(CHILD_WORKSPACE),
            network: SandboxNetworkMode::Deny,
            workspace_access: WorkspaceAccess::ReadOnly,
            git_metadata_access: GitMetadataAccess::None,
            require_git_metadata: true,
            cargo_home: None,
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
    _status_reader: UnixStream,
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
        let linked_git_metadata = match spec.git_metadata_access {
            GitMetadataAccess::None => None,
            GitMetadataAccess::ReadOnly | GitMetadataAccess::ReadWrite => {
                match open_linked_worktree_git_metadata(workspace_root) {
                    Ok(metadata) => metadata,
                    Err(_) if !spec.require_git_metadata => None,
                    Err(error) => {
                        return Err(SandboxError::SandboxUnavailable(format!(
                            "linked worktree Git metadata rejected: {error}"
                        )));
                    }
                }
            }
        };
        if let Some(metadata) = &linked_git_metadata {
            fcntl_setfd(&metadata.common_dir_fd, FdFlags::empty())
                .map_err(|error| std::io::Error::from_raw_os_error(error.raw_os_error()))?;
        }

        let mut explicit_mounts = Vec::new();
        for program in std::iter::once(&spec.program).chain(spec.auxiliary_programs.iter()) {
            let Some(mount) = program.open_explicit_mount()? else {
                continue;
            };
            if explicit_mounts
                .iter()
                .any(|existing: &ExplicitExecutableMount| {
                    existing.root_canonical_path == mount.root_canonical_path
                })
            {
                continue;
            }
            fcntl_setfd(&mount.root_fd, FdFlags::empty())
                .map_err(|error| std::io::Error::from_raw_os_error(error.raw_os_error()))?;
            explicit_mounts.push(mount);
        }
        let corepack_mount = if std::iter::once(&spec.program)
            .chain(spec.auxiliary_programs.iter())
            .any(TrustedExecutable::uses_node_toolchain)
        {
            open_explicit_directory_from_env("KODEGPT_HOST_COREPACK_HOME")?
        } else {
            None
        };
        if let Some(root_fd) = &corepack_mount {
            fcntl_setfd(root_fd, FdFlags::empty())
                .map_err(|error| std::io::Error::from_raw_os_error(error.raw_os_error()))?;
        }
        let resolver_mount = if spec.network == SandboxNetworkMode::Unrestricted {
            let resolved_resolv_conf = fs::canonicalize("/etc/resolv.conf")?;
            resolver_runtime_directory(&resolved_resolv_conf)
                .map(fs::File::open)
                .transpose()?
                .map(OwnedFd::from)
        } else {
            None
        };
        if let Some(root_fd) = &resolver_mount {
            fcntl_setfd(root_fd, FdFlags::empty())
                .map_err(|error| std::io::Error::from_raw_os_error(error.raw_os_error()))?;
        }
        let cargo_home_mount = spec
            .cargo_home
            .as_ref()
            .map(fs::File::open)
            .transpose()?
            .map(OwnedFd::from);
        if let Some(root_fd) = &cargo_home_mount {
            fcntl_setfd(root_fd, FdFlags::empty())
                .map_err(|error| std::io::Error::from_raw_os_error(error.raw_os_error()))?;
        }
        let (status_reader, status_writer) = UnixStream::pair()?;
        status_reader.set_read_timeout(Some(Duration::from_secs(3)))?;
        fcntl_setfd(&status_writer, FdFlags::empty())
            .map_err(|error| std::io::Error::from_raw_os_error(error.raw_os_error()))?;

        let mut command = self.build_command(
            inherited_workspace_fd.as_raw_fd(),
            Some(status_writer.as_raw_fd()),
            linked_git_metadata.as_ref(),
            &explicit_mounts,
            corepack_mount.as_ref().map(AsRawFd::as_raw_fd),
            resolver_mount.as_ref().map(AsRawFd::as_raw_fd),
            cargo_home_mount.as_ref().map(AsRawFd::as_raw_fd),
            spec,
        )?;
        self.executable.revalidate()?;
        spec.program.revalidate()?;
        for auxiliary in &spec.auxiliary_programs {
            auxiliary.revalidate()?;
        }
        let mut child = command.spawn()?;
        drop(status_writer);
        drop(inherited_workspace_fd);
        let process_group = match read_child_pid(&status_reader) {
            Ok(process_group) => process_group,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        Ok(SandboxChild {
            child,
            process_group,
            _status_reader: status_reader,
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
        status_fd: Option<i32>,
        linked_git_metadata: Option<&LinkedWorktreeGitMetadata>,
        explicit_mounts: &[ExplicitExecutableMount],
        corepack_fd: Option<i32>,
        resolver_fd: Option<i32>,
        cargo_home_fd: Option<i32>,
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

        if let Some(status_fd) = status_fd {
            command.arg("--json-status-fd").arg(status_fd.to_string());
        }

        if spec.network == SandboxNetworkMode::Deny {
            command.arg("--unshare-net");
        }

        for system_path in RUNTIME_SYSTEM_PATHS {
            if fs::metadata(system_path).is_ok() {
                command.args(["--ro-bind", system_path, system_path]);
            }
        }
        if let Some(resolver_fd) = resolver_fd {
            command.args([
                "--dir",
                "/run",
                "--dir",
                "/run/systemd",
                "--ro-bind-fd",
                &resolver_fd.to_string(),
                RESOLVER_RUNTIME_DIRECTORY,
            ]);
        }

        command.args([
            "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--chmod", "01777", "/tmp",
            "--dir", "/home", "--dir", CHILD_HOME, "--chmod", "0700", CHILD_HOME,
        ]);
        if let Some(cargo_home_fd) = cargo_home_fd {
            command.args([
                "--dir",
                CHILD_CARGO_HOME,
                "--bind-fd",
                &cargo_home_fd.to_string(),
                CHILD_CARGO_HOME,
            ]);
        }

        if let Some(metadata) = linked_git_metadata {
            if !git_metadata_target_is_allowed(&metadata.common_dir_path) {
                return Err(SandboxError::SandboxUnavailable(
                    "linked worktree Git metadata target collides with sandbox-owned paths"
                        .to_owned(),
                ));
            }
            append_parent_directories(&mut command, &metadata.common_dir_path);
            let bind_flag = match spec.git_metadata_access {
                GitMetadataAccess::None => {
                    return Err(SandboxError::SandboxUnavailable(
                        "linked worktree Git metadata was resolved without admission".to_owned(),
                    ));
                }
                GitMetadataAccess::ReadOnly => "--ro-bind-fd",
                GitMetadataAccess::ReadWrite => "--bind-fd",
            };
            command
                .arg(bind_flag)
                .arg(metadata.common_dir_fd.as_raw_fd().to_string())
                .arg(&metadata.common_dir_path);
        }

        if !explicit_mounts.is_empty() {
            command.args(["--dir", "/opt"]);
        }
        for (index, mount) in explicit_mounts.iter().enumerate() {
            command.args([
                "--ro-bind-fd",
                &mount.root_fd.as_raw_fd().to_string(),
                &child_tool_root(index),
            ]);
        }
        if let Some(corepack_fd) = corepack_fd {
            command.args([
                "--dir",
                "/opt",
                "--ro-bind-fd",
                &corepack_fd.to_string(),
                CHILD_COREPACK_HOME,
            ]);
        }

        match spec.workspace_access {
            WorkspaceAccess::ReadOnly => {
                command.args(["--ro-bind-fd", &workspace_fd.to_string(), CHILD_WORKSPACE]);
            }
            WorkspaceAccess::ReadWrite => {
                command.args(["--bind-fd", &workspace_fd.to_string(), CHILD_WORKSPACE]);
            }
        }

        let child_path = if explicit_mounts.is_empty() {
            FIXED_PATH.to_owned()
        } else {
            explicit_mounts
                .iter()
                .enumerate()
                .map(|(index, _)| format!("{}/bin", child_tool_root(index)))
                .chain(std::iter::once(FIXED_PATH.to_owned()))
                .collect::<Vec<_>>()
                .join(":")
        };
        command.args([
            "--setenv",
            "HOME",
            CHILD_HOME,
            "--setenv",
            "PATH",
            &child_path,
            "--setenv",
            "TMPDIR",
            "/tmp",
            "--setenv",
            SANDBOX_MARKER_ENV,
            "1",
        ]);
        if corepack_fd.is_some() {
            command.args(["--setenv", "COREPACK_HOME", CHILD_COREPACK_HOME]);
        }
        for (name, value) in &spec.env {
            command.args(["--setenv", name, value]);
        }

        command.arg("--chdir").arg(&spec.cwd);
        let child_program = explicit_mounts
            .first()
            .filter(|mount| {
                spec.program
                    .canonical_path()
                    .starts_with(&mount.root_canonical_path)
            })
            .map(|mount| Path::new(&child_tool_root(0)).join(&mount.relative_program))
            .unwrap_or_else(|| spec.program.canonical_path().to_path_buf());
        command.arg("--").arg(child_program).args(&spec.args);
        Ok(command)
    }
}

fn resolver_runtime_directory(resolved_resolv_conf: &Path) -> Option<&'static Path> {
    if resolved_resolv_conf.starts_with(RESOLVER_RUNTIME_DIRECTORY) {
        Some(Path::new(RESOLVER_RUNTIME_DIRECTORY))
    } else {
        None
    }
}

fn child_tool_root(index: usize) -> String {
    if index == 0 {
        CHILD_TOOL_ROOT.to_owned()
    } else {
        format!("{CHILD_TOOL_ROOT}-{index}")
    }
}

fn git_metadata_target_is_allowed(path: &Path) -> bool {
    let reserved = [
        Path::new(CHILD_WORKSPACE),
        Path::new(CHILD_HOME),
        Path::new("/proc"),
        Path::new("/dev"),
        Path::new("/sys"),
        Path::new("/usr"),
        Path::new("/bin"),
        Path::new("/lib"),
        Path::new("/lib64"),
        Path::new("/etc"),
        Path::new("/run"),
        Path::new("/opt"),
    ];
    path.is_absolute() && !reserved.iter().any(|root| path.starts_with(root))
}

fn append_parent_directories(command: &mut Command, target: &Path) {
    let mut parents = target
        .parent()
        .into_iter()
        .flat_map(Path::ancestors)
        .filter(|path| *path != Path::new("/"))
        .collect::<Vec<_>>();
    parents.reverse();
    for parent in parents {
        if parent == Path::new("/home") || parent == Path::new("/tmp") {
            continue;
        }
        command.arg("--dir").arg(parent);
    }
}

fn read_child_pid(status_reader: &UnixStream) -> Result<i32, SandboxError> {
    let mut reader = BufReader::new(status_reader.try_clone()?);
    let mut total_bytes = 0_usize;
    for _ in 0..8 {
        let mut line = String::new();
        let bytes = reader.read_line(&mut line)?;
        if bytes == 0 {
            break;
        }
        total_bytes = total_bytes.saturating_add(bytes);
        if total_bytes > 64 * 1024 {
            break;
        }
        let value: serde_json::Value = serde_json::from_str(&line).map_err(|_| {
            SandboxError::SandboxUnavailable("invalid Bubblewrap status channel".to_owned())
        })?;
        if let Some(pid) = value.get("child-pid").and_then(serde_json::Value::as_i64)
            && pid > 0
            && pid <= i32::MAX as i64
        {
            return Ok(pid as i32);
        }
    }
    Err(SandboxError::SandboxUnavailable(
        "Bubblewrap did not publish a host child PID".to_owned(),
    ))
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
    use std::fs::{self, File};
    use std::os::fd::OwnedFd;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        BubblewrapProvider, GitMetadataAccess, SandboxError, SandboxLaunchSpec, SandboxNetworkMode,
        WorkspaceAccess, cwd_is_beneath_workspace,
    };
    use crate::executable::SANDBOX_MARKER_ENV;
    use crate::resolve_trusted_executable;

    fn temporary_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "kodegpt-bubblewrap-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temporary root");
        root
    }

    fn git(root: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .env_clear()
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("HOME", "/tmp")
            .status()
            .expect("test git available");
        assert!(status.success(), "test git command failed: {args:?}");
    }

    #[test]
    fn linked_worktree_git_metadata_is_available_inside_sandbox() {
        let repository = temporary_root("linked-git-repository");
        git(&repository, &["init", "-b", "main"]);
        git(&repository, &["config", "user.name", "KodeGPT Test"]);
        git(
            &repository,
            &["config", "user.email", "kodegpt@example.invalid"],
        );
        fs::write(repository.join("tracked.txt"), "base\n").expect("tracked fixture");
        git(&repository, &["add", "tracked.txt"]);
        git(&repository, &["commit", "-m", "base"]);

        let worktree = repository.join(".worktrees").join("feature");
        git(
            &repository,
            &[
                "worktree",
                "add",
                "-b",
                "feature",
                worktree.to_str().expect("utf8 worktree path"),
            ],
        );

        let workspace_fd = OwnedFd::from(File::open(&worktree).expect("worktree root fd"));
        let mut spec = SandboxLaunchSpec::new(
            resolve_trusted_executable("git").expect("trusted git executable"),
        );
        spec.args = vec!["status".into(), "--short".into()];
        spec.git_metadata_access = GitMetadataAccess::ReadOnly;
        spec.require_git_metadata = false;
        let provider = BubblewrapProvider::discover().expect("trusted Bubblewrap prerequisite");
        let output = provider
            .run_capture(&workspace_fd, &spec)
            .expect("linked worktree sandbox execution");

        assert!(
            output.status.success(),
            "linked worktree Git failed:\nstdout={}\nstderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );

        let mut source_probe = SandboxLaunchSpec::new(
            resolve_trusted_executable("test").expect("trusted test executable"),
        );
        source_probe.args = vec!["-e".into(), repository.join("tracked.txt").into_os_string()];
        source_probe.git_metadata_access = GitMetadataAccess::ReadOnly;
        let source_probe_output = provider
            .run_capture(&workspace_fd, &source_probe)
            .expect("canonical source isolation probe");
        assert!(
            !source_probe_output.status.success(),
            "canonical checkout source must remain outside the sandbox"
        );

        let metadata_probe = repository.join(".git/kodegpt-metadata-write-probe");
        let mut metadata_write_probe = SandboxLaunchSpec::new(
            resolve_trusted_executable("touch").expect("trusted touch executable"),
        );
        metadata_write_probe.args = vec![metadata_probe.clone().into_os_string()];
        metadata_write_probe.workspace_access = WorkspaceAccess::ReadWrite;
        metadata_write_probe.git_metadata_access = GitMetadataAccess::ReadOnly;
        let metadata_write_output = provider
            .run_capture(&workspace_fd, &metadata_write_probe)
            .expect("metadata write isolation probe");
        assert!(
            !metadata_write_output.status.success(),
            "source write authority must not imply external Git metadata write authority"
        );
        assert!(!metadata_probe.exists());

        git(
            &repository,
            &[
                "worktree",
                "remove",
                "--force",
                worktree.to_str().expect("utf8 worktree path"),
            ],
        );
        fs::remove_dir_all(repository).expect("repository cleanup");
    }

    #[test]
    fn systemd_resolved_target_requires_only_the_systemd_resolver_runtime_directory() {
        assert_eq!(
            super::resolver_runtime_directory(Path::new("/run/systemd/resolve/stub-resolv.conf",)),
            Some(Path::new("/run/systemd/resolve"))
        );
        assert_eq!(
            super::resolver_runtime_directory(Path::new("/etc/static-resolv.conf")),
            None
        );
    }

    #[test]
    fn unrestricted_network_mounts_only_the_required_resolver_runtime_directory() {
        let provider = BubblewrapProvider::discover().expect("trusted Bubblewrap prerequisite");
        let mut spec = SandboxLaunchSpec::new(
            resolve_trusted_executable("env").expect("trusted env executable"),
        );
        spec.network = SandboxNetworkMode::Unrestricted;
        let command = provider
            .build_command(3, None, None, &[], None, Some(9), None, &spec)
            .expect("unrestricted command construction");
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert!(args.windows(2).any(|window| window == ["--dir", "/run"]));
        assert!(
            args.windows(2)
                .any(|window| window == ["--dir", "/run/systemd"])
        );
        assert!(
            args.windows(3)
                .any(|window| window == ["--ro-bind-fd", "9", "/run/systemd/resolve"])
        );
        assert!(
            args.windows(3)
                .any(|window| window == ["--setenv", "KODEGPT_SANDBOX", "1"])
        );
        assert!(!args.windows(3).any(|window| {
            matches!(window, [flag, source, target] if flag == "--ro-bind" && source == "/run" && target == "/run")
        }));
    }

    #[test]
    fn explicit_node_root_is_materialized_read_only_for_sandbox_execution() {
        let tool_root = temporary_root("node-root");
        let bin = tool_root.join("bin");
        fs::create_dir_all(&bin).expect("node bin");
        let node = bin.join("node");
        fs::write(&node, b"#!/bin/sh\nprintf 'kodegpt-node-smoke\\n'\n").expect("node fixture");
        let mut permissions = fs::metadata(&node).expect("node metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&node, permissions).expect("node executable mode");
        let workspace = temporary_root("workspace");

        let output = Command::new(std::env::current_exe().expect("current test executable"))
            .args([
                "--ignored",
                "--exact",
                "bubblewrap::tests::explicit_node_root_sandbox_subprocess_helper",
            ])
            .env("KODEGPT_HOST_NODE_ROOT", &tool_root)
            .env(
                "KODEGPT_HOST_COREPACK_HOME",
                tool_root.join("missing-corepack"),
            )
            .env("KODEGPT_TEST_WORKSPACE", &workspace)
            .output()
            .expect("nested sandbox test runs");

        assert!(
            output.status.success(),
            "nested sandbox failed:\nstdout={}\nstderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        fs::remove_dir_all(tool_root).expect("tool root cleanup");
        fs::remove_dir_all(workspace).expect("workspace cleanup");
    }

    #[test]
    #[ignore = "invoked by explicit_node_root_is_materialized_read_only_for_sandbox_execution"]
    fn explicit_node_root_sandbox_subprocess_helper() {
        let workspace = PathBuf::from(
            std::env::var_os("KODEGPT_TEST_WORKSPACE").expect("workspace fixture env"),
        );
        let workspace_fd = OwnedFd::from(File::open(&workspace).expect("workspace root fd"));
        let program = resolve_trusted_executable("node").expect("explicit node root resolves");
        let spec = SandboxLaunchSpec::new(program);
        let provider = BubblewrapProvider::discover().expect("trusted Bubblewrap prerequisite");
        let output = provider
            .run_capture(&workspace_fd, &spec)
            .expect("explicit node sandbox execution");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            "kodegpt-node-smoke\n"
        );
    }

    #[test]
    fn explicit_node_root_runs_pnpm_through_only_the_sanitized_toolchain_path() {
        let tool_root = temporary_root("pnpm-root");
        let bin = tool_root.join("bin");
        let lib = tool_root.join("lib");
        fs::create_dir_all(&bin).expect("tool bin");
        fs::create_dir_all(&lib).expect("tool lib");
        let node = bin.join("node");
        fs::write(&node, b"#!/bin/sh\nprintf 'kodegpt-pnpm-smoke\\n'\n").expect("node fixture");
        let mut node_permissions = fs::metadata(&node).expect("node metadata").permissions();
        node_permissions.set_mode(0o755);
        fs::set_permissions(&node, node_permissions).expect("node executable mode");
        let pnpm_target = lib.join("pnpm.js");
        fs::write(&pnpm_target, b"#!/usr/bin/env node\n").expect("pnpm fixture");
        let mut pnpm_permissions = fs::metadata(&pnpm_target)
            .expect("pnpm metadata")
            .permissions();
        pnpm_permissions.set_mode(0o755);
        fs::set_permissions(&pnpm_target, pnpm_permissions).expect("pnpm executable mode");
        symlink("../lib/pnpm.js", bin.join("pnpm")).expect("pnpm symlink");
        let workspace = temporary_root("pnpm-workspace");

        let output = Command::new(std::env::current_exe().expect("current test executable"))
            .args([
                "--ignored",
                "--exact",
                "bubblewrap::tests::explicit_pnpm_sandbox_subprocess_helper",
            ])
            .env("KODEGPT_HOST_NODE_ROOT", &tool_root)
            .env("KODEGPT_TEST_WORKSPACE", &workspace)
            .output()
            .expect("nested pnpm sandbox test runs");

        assert!(
            output.status.success(),
            "nested pnpm sandbox failed:\nstdout={}\nstderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        fs::remove_dir_all(tool_root).expect("tool root cleanup");
        fs::remove_dir_all(workspace).expect("workspace cleanup");
    }

    #[test]
    #[ignore = "invoked by explicit_node_root_runs_pnpm_through_only_the_sanitized_toolchain_path"]
    fn explicit_pnpm_sandbox_subprocess_helper() {
        let workspace = PathBuf::from(
            std::env::var_os("KODEGPT_TEST_WORKSPACE").expect("workspace fixture env"),
        );
        let workspace_fd = OwnedFd::from(File::open(&workspace).expect("workspace root fd"));
        let program = resolve_trusted_executable("pnpm").expect("explicit pnpm root resolves");
        let spec = SandboxLaunchSpec::new(program);
        let provider = BubblewrapProvider::discover().expect("trusted Bubblewrap prerequisite");
        let output = provider
            .run_capture(&workspace_fd, &spec)
            .expect("explicit pnpm sandbox execution");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            "kodegpt-pnpm-smoke\n"
        );
    }

    #[test]
    fn explicit_rust_toolchain_root_runs_cargo_without_rustup_shims_or_host_path() {
        let tool_root = temporary_root("cargo-root");
        let bin = tool_root.join("bin");
        fs::create_dir_all(&bin).expect("cargo bin");
        let cargo = bin.join("cargo");
        fs::write(&cargo, b"#!/bin/sh\nprintf 'kodegpt-cargo-smoke\\n'\n").expect("cargo fixture");
        let mut permissions = fs::metadata(&cargo).expect("cargo metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&cargo, permissions).expect("cargo executable mode");
        let workspace = temporary_root("cargo-workspace");

        let output = Command::new(std::env::current_exe().expect("current test executable"))
            .args([
                "--ignored",
                "--exact",
                "bubblewrap::tests::explicit_cargo_sandbox_subprocess_helper",
            ])
            .env("KODEGPT_HOST_RUST_TOOLCHAIN_ROOT", &tool_root)
            .env("KODEGPT_TEST_WORKSPACE", &workspace)
            .output()
            .expect("nested cargo sandbox test runs");

        assert!(
            output.status.success(),
            "nested cargo sandbox failed:\nstdout={}\nstderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        fs::remove_dir_all(tool_root).expect("tool root cleanup");
        fs::remove_dir_all(workspace).expect("workspace cleanup");
    }

    #[test]
    #[ignore = "invoked by explicit_rust_toolchain_root_runs_cargo_without_rustup_shims_or_host_path"]
    fn explicit_cargo_sandbox_subprocess_helper() {
        let workspace = PathBuf::from(
            std::env::var_os("KODEGPT_TEST_WORKSPACE").expect("workspace fixture env"),
        );
        let workspace_fd = OwnedFd::from(File::open(&workspace).expect("workspace root fd"));
        let program = resolve_trusted_executable("cargo").expect("explicit cargo root resolves");
        let spec = SandboxLaunchSpec::new(program);
        let provider = BubblewrapProvider::discover().expect("trusted Bubblewrap prerequisite");
        let output = provider
            .run_capture(&workspace_fd, &spec)
            .expect("explicit cargo sandbox execution");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            "kodegpt-cargo-smoke\n"
        );
    }

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
        for reserved in ["HOME", "PATH", "TMPDIR", "PWD", SANDBOX_MARKER_ENV] {
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
                provider.build_command(3, None, None, &[], None, None, None, &spec),
                Err(SandboxError::NetworkPolicyUnavailable)
            ));
        }
        assert_eq!(spec.workspace_access, WorkspaceAccess::ReadOnly);
    }
}
