use std::fs::{self, File};
use std::os::fd::OwnedFd;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use kodegpt_protocol::{
    InheritEnvDisabled, NetworkMode, ProcessRunParams, ProfileName, RuntimePolicy,
};

use crate::audit::{AuditAction, AuditContext, AuditSink};
use crate::execution::ExecutionRegistry;
use crate::process::{ProcessError, ProcessManager, PublicProcessPhase};
use crate::spool::RawSpoolStore;

fn temporary_root(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "kodegpt-process-{label}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&root).expect("temporary root");
    root
}

fn policy(allow_write: bool, network: NetworkMode) -> RuntimePolicy {
    RuntimePolicy {
        name: ProfileName::Develop,
        allow_write,
        allow_process: true,
        network,
        allowed_executable_names: vec!["sh".to_owned()],
        inherit_env: InheritEnvDisabled,
        env_allowlist: vec!["VISIBLE".to_owned()],
    }
}

fn params(argv: &[&str], cwd: &str, background: bool) -> ProcessRunParams {
    ProcessRunParams {
        capability_id: "kc_process_fixture".to_owned(),
        logical_executable: "sh".to_owned(),
        argv: argv.iter().map(|value| (*value).to_owned()).collect(),
        cwd: cwd.to_owned(),
        env: Default::default(),
        background,
    }
}

fn context(operation_id: &str) -> AuditContext {
    AuditContext {
        request_id: format!("req_{operation_id}"),
        operation_id: operation_id.to_owned(),
        capability_id: Some("kc_process_fixture".to_owned()),
        action: AuditAction::ProcessRun,
    }
}

fn manager(state: &PathBuf) -> ProcessManager {
    let audit = Arc::new(AuditSink::open(state));
    let spool = Arc::new(RawSpoolStore::open(state, Arc::clone(&audit)).expect("spool"));
    ProcessManager::new(
        Arc::new(Mutex::new(ExecutionRegistry::default())),
        spool,
        audit,
    )
}

#[test]
fn process_policy_denials_happen_before_execution() {
    let workspace = temporary_root("policy-workspace");
    let state = temporary_root("policy-state");
    let root_fd = OwnedFd::from(File::open(&workspace).expect("workspace fd"));
    let manager = manager(&state);

    let mut observe = policy(false, NetworkMode::Deny);
    observe.name = ProfileName::Observe;
    assert!(matches!(
        manager.run(
            "op_observe_deny".to_owned(),
            root_fd.try_clone().expect("clone root"),
            observe,
            params(&["-c", "exit 0"], ".", false),
            context("op_observe_deny"),
        ),
        Err(ProcessError::PolicyDenied)
    ));

    let mut unknown = params(&["-c", "exit 0"], ".", false);
    unknown.logical_executable = "definitely-not-allowed".to_owned();
    assert!(matches!(
        manager.run(
            "op_unknown_deny".to_owned(),
            root_fd.try_clone().expect("clone root"),
            policy(false, NetworkMode::Deny),
            unknown,
            context("op_unknown_deny"),
        ),
        Err(ProcessError::ExecutableDenied)
    ));

    assert!(matches!(
        manager.run(
            "op_cwd_deny".to_owned(),
            root_fd.try_clone().expect("clone root"),
            policy(false, NetworkMode::Deny),
            params(&["-c", "exit 0"], "../outside", false),
            context("op_cwd_deny"),
        ),
        Err(ProcessError::InvalidCwd)
    ));

    let mut env_denied = params(&["-c", "exit 0"], ".", false);
    env_denied
        .env
        .insert("NOT_ALLOWED".to_owned(), "secret".to_owned());
    assert!(matches!(
        manager.run(
            "op_env_deny".to_owned(),
            root_fd,
            policy(false, NetworkMode::Deny),
            env_denied,
            context("op_env_deny"),
        ),
        Err(ProcessError::EnvironmentDenied)
    ));

    fs::remove_dir_all(workspace).expect("workspace cleanup");
    fs::remove_dir_all(state).expect("state cleanup");
}

#[test]
fn process_uses_fixed_environment_nondefault_cwd_and_policy_derived_mount_mode() {
    let workspace = temporary_root("sandbox-workspace");
    let state = temporary_root("sandbox-state");
    fs::create_dir_all(workspace.join("nested")).expect("nested cwd");
    fs::write(workspace.join("sh"), "#!/bin/sh\nprintf SHADOW_EXECUTED\n")
        .expect("shadow binary fixture");
    let root_fd = OwnedFd::from(File::open(&workspace).expect("workspace fd"));
    let manager = manager(&state);

    let mut env_params = params(
        &["-c", "printf '%s|%s|%s' \"$PWD\" \"$HOME\" \"${HOST_SECRET-unset}\""],
        "nested",
        false,
    );
    env_params
        .env
        .insert("VISIBLE".to_owned(), "present".to_owned());
    let environment = manager
        .run(
            "op_environment".to_owned(),
            root_fd.try_clone().expect("clone root"),
            policy(false, NetworkMode::Deny),
            env_params,
            context("op_environment"),
        )
        .expect("environment command");
    assert_eq!(environment.state, PublicProcessPhase::Exited);
    assert_eq!(environment.exit_code, Some(0));
    let stdout = environment.stdout_preview.expect("stdout preview");
    assert!(stdout.contains("/workspace/nested|/home/kodegpt|unset"));
    assert!(!stdout.contains("SHADOW_EXECUTED"));

    let readonly = manager
        .run(
            "op_readonly".to_owned(),
            root_fd.try_clone().expect("clone root"),
            policy(false, NetworkMode::Deny),
            params(&["-c", "printf blocked > blocked.txt"], ".", false),
            context("op_readonly"),
        )
        .expect("readonly command returns terminal status");
    assert_ne!(readonly.exit_code, Some(0));
    assert!(!workspace.join("blocked.txt").exists());

    let writable = manager
        .run(
            "op_writable".to_owned(),
            root_fd,
            policy(true, NetworkMode::Deny),
            params(&["-c", "printf allowed > created.txt"], ".", false),
            context("op_writable"),
        )
        .expect("writable command");
    assert_eq!(writable.exit_code, Some(0));
    assert_eq!(
        fs::read_to_string(workspace.join("created.txt")).expect("created content"),
        "allowed"
    );

    fs::remove_dir_all(workspace).expect("workspace cleanup");
    fs::remove_dir_all(state).expect("state cleanup");
}

#[test]
fn background_cancel_terminates_the_full_process_group() {
    let workspace = temporary_root("cancel-workspace");
    let state = temporary_root("cancel-state");
    let root_fd = OwnedFd::from(File::open(&workspace).expect("workspace fd"));
    let manager = manager(&state);

    let started = manager
        .run(
            "op_cancel_tree".to_owned(),
            root_fd,
            policy(true, NetworkMode::Deny),
            params(
                &[
                    "-c",
                    "(sleep 2; printf escaped > escaped.txt) & wait",
                ],
                ".",
                true,
            ),
            context("op_cancel_tree"),
        )
        .expect("background process starts");
    assert_eq!(started.state, PublicProcessPhase::Running);

    let cancelled = manager
        .cancel("kc_process_fixture", "op_cancel_tree")
        .expect("process group cancellation");
    assert_eq!(cancelled.state, PublicProcessPhase::Cancelled);
    thread::sleep(Duration::from_millis(2300));
    assert!(
        !workspace.join("escaped.txt").exists(),
        "descendant process must not survive cancellation"
    );

    fs::remove_dir_all(workspace).expect("workspace cleanup");
    fs::remove_dir_all(state).expect("state cleanup");
}

#[test]
fn unsupported_network_modes_fail_closed() {
    let workspace = temporary_root("network-workspace");
    let state = temporary_root("network-state");
    let root_fd = OwnedFd::from(File::open(&workspace).expect("workspace fd"));
    let manager = manager(&state);

    for (index, network) in [NetworkMode::Localhost, NetworkMode::Allowlist]
        .into_iter()
        .enumerate()
    {
        let result = manager.run(
            format!("op_network_{index}"),
            root_fd.try_clone().expect("clone root"),
            policy(false, network),
            params(&["-c", "exit 0"], ".", false),
            context(&format!("op_network_{index}")),
        );
        assert!(matches!(result, Err(ProcessError::Sandbox(_))));
    }

    fs::remove_dir_all(workspace).expect("workspace cleanup");
    fs::remove_dir_all(state).expect("state cleanup");
}
