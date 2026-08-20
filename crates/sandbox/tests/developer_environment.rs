use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use kodegpt_sandbox::{
    DeveloperEnvironmentError, DeveloperEnvironmentRegistry, resolve_dynamic_executable,
};
use serde_json::{Value, json};

fn temporary_root(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "kodegpt-developer-environment-{label}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&root).expect("temporary root");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).expect("safe root permissions");
    root
}

fn device_identity(path: &Path) -> Value {
    let metadata = fs::metadata(path).expect("root metadata");
    let device = metadata.dev();
    let major = ((device & 0x0000_0000_000f_ff00) >> 8) | ((device & 0xffff_f000_0000_0000) >> 32);
    let minor = (device & 0xff) | ((device & 0x0000_0fff_fff0_0000) >> 12);
    json!({
        "deviceMajor": major,
        "deviceMinor": minor,
        "inode": metadata.ino().to_string()
    })
}

fn executable(path: &Path, contents: &str) {
    fs::write(path, contents).expect("fixture executable written");
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("fixture executable mode");
}

fn entry(id: usize, root: &Path, executable_dirs: Value) -> Value {
    json!({
        "id": format!("denv_{id:032x}"),
        "label": format!("fixture-{id}"),
        "source": "operator",
        "canonicalRoot": fs::canonicalize(root).expect("canonical root"),
        "executableDirs": executable_dirs,
        "identity": device_identity(root)
    })
}

fn write_registry(state_root: &Path, entries: Vec<Value>) {
    let directory = state_root.join("developer-environments");
    fs::create_dir_all(&directory).expect("registry directory");
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .expect("registry directory mode");
    let path = directory.join("registry.json");
    fs::write(
        &path,
        serde_json::to_vec_pretty(&json!({"schemaVersion": 1, "entries": entries}))
            .expect("registry JSON"),
    )
    .expect("registry written");
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).expect("registry mode");
}

#[test]
fn loads_a_valid_schema_v1_registry_and_resolves_a_generic_executable() {
    let state_root = temporary_root("valid-state");
    let toolchain = temporary_root("valid-toolchain");
    let bin = toolchain.join("bin");
    fs::create_dir_all(&bin).expect("bin");
    executable(&bin.join("fixture-tool"), "#!/bin/sh\nexit 0\n");
    write_registry(&state_root, vec![entry(1, &toolchain, json!(["bin"]))]);

    let registry = DeveloperEnvironmentRegistry::load(&state_root).expect("registry loads");
    assert_eq!(registry.len(), 1);
    let resolved = registry
        .resolve_registered("fixture-tool")
        .expect("generic registered executable resolves");
    assert_eq!(
        resolved.canonical_path(),
        fs::canonicalize(bin.join("fixture-tool")).expect("canonical fixture")
    );

    fs::remove_dir_all(state_root).expect("state cleanup");
    fs::remove_dir_all(toolchain).expect("toolchain cleanup");
}

#[test]
fn rejects_unknown_schema_unknown_fields_and_registry_limits() {
    let state_root = temporary_root("invalid-state");
    let directory = state_root.join("developer-environments");
    fs::create_dir_all(&directory).expect("registry directory");
    let path = directory.join("registry.json");

    fs::write(&path, br#"{"schemaVersion":2,"entries":[]}"#).expect("future registry");
    assert!(matches!(
        DeveloperEnvironmentRegistry::load(&state_root),
        Err(DeveloperEnvironmentError::SchemaUnsupported)
    ));

    fs::write(
        &path,
        br#"{"schemaVersion":1,"entries":[],"unexpected":true}"#,
    )
    .expect("unknown-field registry");
    assert!(matches!(
        DeveloperEnvironmentRegistry::load(&state_root),
        Err(DeveloperEnvironmentError::RegistryInvalid)
    ));

    let toolchain = temporary_root("limit-toolchain");
    let entries = (0..33)
        .map(|index| entry(index + 1, &toolchain, json!(["."])))
        .collect::<Vec<_>>();
    write_registry(&state_root, entries);
    assert!(matches!(
        DeveloperEnvironmentRegistry::load(&state_root),
        Err(DeveloperEnvironmentError::LimitExceeded)
    ));

    fs::remove_dir_all(state_root).expect("state cleanup");
    fs::remove_dir_all(toolchain).expect("toolchain cleanup");
}

#[test]
fn rejects_executable_directories_with_path_separator() {
    let state_root = temporary_root("path-separator-state");
    let toolchain = temporary_root("path-separator-toolchain");
    let bad_dir = toolchain.join("bin:alt");
    fs::create_dir_all(&bad_dir).expect("unsafe PATH directory fixture");
    write_registry(&state_root, vec![entry(1, &toolchain, json!(["bin:alt"]))]);

    assert!(matches!(
        DeveloperEnvironmentRegistry::load(&state_root),
        Err(DeveloperEnvironmentError::RegistryInvalid)
    ));

    fs::remove_dir_all(state_root).expect("state cleanup");
    fs::remove_dir_all(toolchain).expect("toolchain cleanup");
}

#[test]
fn rejects_relative_directory_escape_and_root_identity_drift() {
    let state_root = temporary_root("boundary-state");
    let toolchain = temporary_root("boundary-toolchain");
    write_registry(
        &state_root,
        vec![entry(1, &toolchain, json!(["../outside"]))],
    );
    assert!(matches!(
        DeveloperEnvironmentRegistry::load(&state_root),
        Err(DeveloperEnvironmentError::RegistryInvalid)
    ));

    let mut changed = entry(1, &toolchain, json!(["."]));
    changed["identity"]["inode"] = json!("999999999999");
    write_registry(&state_root, vec![changed]);
    assert!(matches!(
        DeveloperEnvironmentRegistry::load(&state_root),
        Err(DeveloperEnvironmentError::RootChanged)
    ));

    fs::remove_dir_all(state_root).expect("state cleanup");
    fs::remove_dir_all(toolchain).expect("toolchain cleanup");
}

#[test]
fn rejects_registered_executable_symlink_escape() {
    let state_root = temporary_root("symlink-state");
    let toolchain = temporary_root("symlink-toolchain");
    let outside = temporary_root("symlink-outside");
    let bin = toolchain.join("bin");
    fs::create_dir_all(&bin).expect("bin");
    let outside_tool = outside.join("fixture-tool");
    executable(&outside_tool, "#!/bin/sh\nexit 0\n");
    symlink(&outside_tool, bin.join("fixture-tool")).expect("escape symlink");
    write_registry(&state_root, vec![entry(1, &toolchain, json!(["bin"]))]);

    let registry = DeveloperEnvironmentRegistry::load(&state_root).expect("registry loads");
    assert!(registry.resolve_registered("fixture-tool").is_err());

    fs::remove_dir_all(state_root).expect("state cleanup");
    fs::remove_dir_all(toolchain).expect("toolchain cleanup");
    fs::remove_dir_all(outside).expect("outside cleanup");
}

#[test]
fn dynamic_resolution_prefers_registered_developer_tool_but_keeps_shell_system_only() {
    let state_root = temporary_root("precedence-state");
    let toolchain = temporary_root("precedence-toolchain");
    let bin = toolchain.join("bin");
    fs::create_dir_all(&bin).expect("bin");
    executable(&bin.join("python3"), "#!/bin/sh\nexit 0\n");
    executable(&bin.join("sh"), "#!/bin/sh\nexit 0\n");
    write_registry(&state_root, vec![entry(1, &toolchain, json!(["bin"]))]);

    let python = resolve_dynamic_executable(&state_root, "python3")
        .expect("registered developer executable wins over system fallback");
    assert_eq!(
        python.canonical_path(),
        fs::canonicalize(bin.join("python3")).expect("canonical registered python")
    );

    let shell = resolve_dynamic_executable(&state_root, "sh").expect("system shell resolves");
    assert!(!shell.canonical_path().starts_with(&toolchain));

    fs::remove_dir_all(state_root).expect("state cleanup");
    fs::remove_dir_all(toolchain).expect("toolchain cleanup");
}
