use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs::{self, File};
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::bubblewrap::{
    BubblewrapProvider, SandboxError, SandboxLaunchSpec, SandboxNetworkMode, WorkspaceAccess,
};
use crate::executable::resolve_trusted_executable;

const EXPECTED_CAPABILITY_ZERO: &str = "0000000000000000";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxEnforcement {
    Enforced,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxCapabilities {
    enforcement: SandboxEnforcement,
    unrestricted_network: bool,
    deny_network: bool,
    localhost_network: bool,
    allowlist_network: bool,
}

impl SandboxCapabilities {
    pub fn unavailable() -> Self {
        Self {
            enforcement: SandboxEnforcement::Unavailable,
            unrestricted_network: false,
            deny_network: false,
            localhost_network: false,
            allowlist_network: false,
        }
    }

    pub fn enforcement(&self) -> SandboxEnforcement {
        self.enforcement
    }

    pub fn unrestricted_network(&self) -> bool {
        self.unrestricted_network
    }

    pub fn deny_network(&self) -> bool {
        self.deny_network
    }

    pub fn localhost_network(&self) -> bool {
        self.localhost_network
    }

    pub fn allowlist_network(&self) -> bool {
        self.allowlist_network
    }
}

pub fn probe_sandbox_capabilities(
    provider: &BubblewrapProvider,
) -> Result<SandboxCapabilities, SandboxError> {
    let fixture = ProbeFixture::create()?;
    fixture.probe_root_fd_drift(provider)?;
    fixture.probe_read_only_and_writable_mounts(provider)?;
    fixture.probe_isolation_invariants(provider)?;
    fixture.probe_clean_environment(provider)?;
    fixture.probe_network_modes(provider)?;

    Ok(SandboxCapabilities {
        enforcement: SandboxEnforcement::Enforced,
        unrestricted_network: true,
        deny_network: true,
        localhost_network: false,
        allowlist_network: false,
    })
}

fn trusted_spec(name: &str) -> Result<SandboxLaunchSpec, SandboxError> {
    Ok(SandboxLaunchSpec::new(resolve_trusted_executable(name)?))
}

struct ProbeFixture {
    base: PathBuf,
    moved_path: PathBuf,
    other_workspace: PathBuf,
    host_home: PathBuf,
    state_root: PathBuf,
    root_fd: OwnedFd,
}

impl ProbeFixture {
    fn create() -> Result<Self, SandboxError> {
        for required in [
            "/usr/bin/sh",
            "/usr/bin/env",
            "/usr/bin/grep",
            "/usr/bin/unshare",
            "/usr/bin/readlink",
        ] {
            if !Path::new(required).is_file() {
                return Err(SandboxError::SandboxUnavailable(
                    "required functional-probe executable is unavailable".to_owned(),
                ));
            }
        }

        let base = unique_probe_root();
        let original_path = base.join("workspace-a");
        let moved_path = base.join("workspace-a-opened");
        let other_workspace = base.join("workspace-b");
        let host_home = base.join("host-home");
        let state_root = base.join("kodegpt-state");
        fs::create_dir_all(&original_path)?;
        fs::create_dir_all(&other_workspace)?;
        fs::create_dir_all(&host_home)?;
        fs::create_dir_all(&state_root)?;
        fs::write(original_path.join("original-marker"), b"ORIGINAL_FD_TREE\n")?;
        fs::write(
            other_workspace.join("other-secret"),
            b"OTHER_WORKSPACE_SECRET\n",
        )?;
        fs::write(host_home.join("home-secret"), b"HOST_HOME_SECRET\n")?;
        fs::write(state_root.join("state-secret"), b"KODEGPT_STATE_SECRET\n")?;

        let root_fd = OwnedFd::from(File::open(&original_path)?);
        fs::rename(&original_path, &moved_path)?;
        fs::create_dir_all(&original_path)?;
        fs::write(
            original_path.join("replacement-marker"),
            b"REPLACEMENT_TREE\n",
        )?;

        Ok(Self {
            base,
            moved_path,
            other_workspace,
            host_home,
            state_root,
            root_fd,
        })
    }

    fn probe_root_fd_drift(&self, provider: &BubblewrapProvider) -> Result<(), SandboxError> {
        let mut spec = trusted_spec("sh")?;
        spec.network = SandboxNetworkMode::Unrestricted;
        spec.args = vec![
            OsString::from("-c"),
            OsString::from(
                "test -r /workspace/original-marker && test ! -e /workspace/replacement-marker && cat /workspace/original-marker",
            ),
        ];
        let output = provider.run_capture(&self.root_fd, &spec)?;
        require_success(output.status.success(), &output.stderr)?;
        if output.stdout != b"ORIGINAL_FD_TREE\n" {
            return Err(SandboxError::SandboxUnavailable(
                "root-fd drift probe observed the replacement tree".to_owned(),
            ));
        }
        Ok(())
    }

    fn probe_read_only_and_writable_mounts(
        &self,
        provider: &BubblewrapProvider,
    ) -> Result<(), SandboxError> {
        let mut read_only = trusted_spec("sh")?;
        read_only.network = SandboxNetworkMode::Unrestricted;
        read_only.args = vec![
            OsString::from("-c"),
            OsString::from(
                "set -eu; ! touch /workspace/read-only-must-fail 2>/dev/null; for fd in /proc/self/fd/*; do case \"$fd\" in */0|*/1|*/2) continue ;; esac; if [ -d \"$fd\" ] && touch \"$fd/read-only-fd-bypass\" 2>/dev/null; then exit 42; fi; done",
            ),
        ];
        let output = provider.run_capture(&self.root_fd, &read_only)?;
        require_success(output.status.success(), &output.stderr)?;
        if self.moved_path.join("read-only-must-fail").exists()
            || self.moved_path.join("read-only-fd-bypass").exists()
        {
            return Err(SandboxError::SandboxUnavailable(
                "read-only workspace authority remained writable through a child-visible path or fd"
                    .to_owned(),
            ));
        }

        let mut writable = trusted_spec("sh")?;
        writable.network = SandboxNetworkMode::Unrestricted;
        writable.workspace_access = WorkspaceAccess::ReadWrite;
        writable.args = vec![
            OsString::from("-c"),
            OsString::from("printf 'WRITE_OK\\n' > /workspace/write-probe"),
        ];
        let output = provider.run_capture(&self.root_fd, &writable)?;
        require_success(output.status.success(), &output.stderr)?;
        if fs::read(self.moved_path.join("write-probe"))? != b"WRITE_OK\n" {
            return Err(SandboxError::SandboxUnavailable(
                "writable workspace bind did not target retained root fd".to_owned(),
            ));
        }
        Ok(())
    }

    fn probe_isolation_invariants(
        &self,
        provider: &BubblewrapProvider,
    ) -> Result<(), SandboxError> {
        let mut spec = trusted_spec("sh")?;
        spec.network = SandboxNetworkMode::Unrestricted;
        spec.env = BTreeMap::from([
            (
                "KODEGPT_PROBE_HOST_HOME".to_owned(),
                self.host_home.to_string_lossy().into_owned(),
            ),
            (
                "KODEGPT_PROBE_OTHER_WORKSPACE".to_owned(),
                self.other_workspace.to_string_lossy().into_owned(),
            ),
            (
                "KODEGPT_PROBE_STATE_ROOT".to_owned(),
                self.state_root.to_string_lossy().into_owned(),
            ),
            (
                "KODEGPT_PROBE_HOST_PID".to_owned(),
                std::process::id().to_string(),
            ),
        ]);
        spec.args = vec![
            OsString::from("-c"),
            OsString::from(format!(
                "set -eu; \
                 test ! -e \"$KODEGPT_PROBE_HOST_HOME/home-secret\"; \
                 test ! -e \"$KODEGPT_PROBE_OTHER_WORKSPACE/other-secret\"; \
                 test ! -e \"$KODEGPT_PROBE_STATE_ROOT/state-secret\"; \
                 test ! -e \"/proc/$KODEGPT_PROBE_HOST_PID\"; \
                 grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status; \
                 grep -Eq '^CapInh:[[:space:]]+{zero}$' /proc/self/status; \
                 grep -Eq '^CapPrm:[[:space:]]+{zero}$' /proc/self/status; \
                 grep -Eq '^CapEff:[[:space:]]+{zero}$' /proc/self/status; \
                 grep -Eq '^CapBnd:[[:space:]]+{zero}$' /proc/self/status; \
                 grep -Eq '^CapAmb:[[:space:]]+{zero}$' /proc/self/status; \
                 ! /usr/bin/unshare --user /usr/bin/true >/dev/null 2>&1",
                zero = EXPECTED_CAPABILITY_ZERO
            )),
        ];
        let output = provider.run_capture(&self.root_fd, &spec)?;
        require_success(output.status.success(), &output.stderr)
    }

    fn probe_clean_environment(&self, provider: &BubblewrapProvider) -> Result<(), SandboxError> {
        let mut spec = trusted_spec("env")?;
        spec.network = SandboxNetworkMode::Unrestricted;
        let output = provider.run_capture(&self.root_fd, &spec)?;
        require_success(output.status.success(), &output.stderr)?;
        let env = std::str::from_utf8(&output.stdout).map_err(|_| {
            SandboxError::SandboxUnavailable("environment probe returned invalid UTF-8".to_owned())
        })?;
        let actual = env.lines().collect::<BTreeSet<_>>();
        let expected = BTreeSet::from([
            "HOME=/home/kodegpt",
            "PATH=/usr/local/bin:/usr/bin:/bin",
            "PWD=/workspace",
            "TMPDIR=/tmp",
        ]);
        if actual != expected {
            return Err(SandboxError::SandboxUnavailable(
                "clearenv probe observed inherited or unexpected environment".to_owned(),
            ));
        }
        Ok(())
    }

    fn probe_network_modes(&self, provider: &BubblewrapProvider) -> Result<(), SandboxError> {
        let host_network = fs::read_link("/proc/self/ns/net")?;

        let mut unrestricted = trusted_spec("readlink")?;
        unrestricted.network = SandboxNetworkMode::Unrestricted;
        unrestricted.args = vec![OsString::from("/proc/self/ns/net")];
        let output = provider.run_capture(&self.root_fd, &unrestricted)?;
        require_success(output.status.success(), &output.stderr)?;
        let child_network = String::from_utf8(output.stdout).map_err(|_| {
            SandboxError::SandboxUnavailable("network probe returned invalid UTF-8".to_owned())
        })?;
        if child_network.trim() != host_network.to_string_lossy() {
            return Err(SandboxError::SandboxUnavailable(
                "unrestricted network mode did not share the host network namespace".to_owned(),
            ));
        }

        let mut denied = trusted_spec("readlink")?;
        denied.network = SandboxNetworkMode::Deny;
        denied.args = vec![OsString::from("/proc/self/ns/net")];
        let output = provider.run_capture(&self.root_fd, &denied)?;
        require_success(output.status.success(), &output.stderr)?;
        let denied_network = String::from_utf8(output.stdout).map_err(|_| {
            SandboxError::SandboxUnavailable("network probe returned invalid UTF-8".to_owned())
        })?;
        if denied_network.trim() == host_network.to_string_lossy() {
            return Err(SandboxError::SandboxUnavailable(
                "deny network mode retained the host network namespace".to_owned(),
            ));
        }

        for unsupported in [SandboxNetworkMode::Localhost, SandboxNetworkMode::Allowlist] {
            let mut spec = trusted_spec("env")?;
            spec.network = unsupported;
            if !matches!(
                provider.run_capture(&self.root_fd, &spec),
                Err(SandboxError::NetworkPolicyUnavailable)
            ) {
                return Err(SandboxError::SandboxUnavailable(
                    "unsupported network mode did not fail closed".to_owned(),
                ));
            }
        }
        Ok(())
    }
}

impl Drop for ProbeFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn unique_probe_root() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "kodegpt-sandbox-probe-{}-{nonce}",
        std::process::id()
    ))
}

fn require_success(success: bool, stderr: &[u8]) -> Result<(), SandboxError> {
    if success {
        return Ok(());
    }
    let diagnostic = String::from_utf8_lossy(stderr);
    let reason = diagnostic.lines().next().unwrap_or("sandbox child failed");
    Err(SandboxError::SandboxUnavailable(reason.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::{probe_sandbox_capabilities, SandboxEnforcement};
    use crate::BubblewrapProvider;

    #[test]
    fn functional_probes_are_required_before_sandbox_is_enforced() {
        let provider = BubblewrapProvider::discover().expect("trusted Bubblewrap prerequisite");
        let capabilities = probe_sandbox_capabilities(&provider)
            .expect("all Bubblewrap functional isolation probes must pass");
        assert_eq!(capabilities.enforcement(), SandboxEnforcement::Enforced);
        assert!(capabilities.unrestricted_network());
        assert!(capabilities.deny_network());
        assert!(!capabilities.localhost_network());
        assert!(!capabilities.allowlist_network());
    }
}
