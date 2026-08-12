use std::fs;
use std::io::Cursor;
use std::path::PathBuf;

use kodegpt_protocol::{MAX_FRAME_BYTES, RuntimeRequest, read_frame, write_frame};
use serde_json::{Value, json};

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/runtime")
        .join(name);
    serde_json::from_str(&fs::read_to_string(path).expect("fixture readable"))
        .expect("fixture JSON valid")
}

#[test]
fn writes_exact_utf8_content_length_and_round_trips() {
    let value = json!({"text": "🙂 café"});
    let mut encoded = Vec::new();
    write_frame(&mut encoded, &value).expect("frame encodes");

    let body = serde_json::to_vec(&value).expect("json encodes");
    let expected_header = format!("Content-Length: {}\r\n\r\n", body.len());
    assert!(encoded.starts_with(expected_header.as_bytes()));

    let mut cursor = Cursor::new(encoded);
    assert_eq!(read_frame(&mut cursor).expect("frame decodes"), Some(value));
    assert_eq!(read_frame(&mut cursor).expect("clean eof"), None);
}

#[test]
fn rejects_oversized_declared_length_before_body_allocation() {
    let bytes = format!("Content-Length: {}\r\n\r\n", MAX_FRAME_BYTES + 1).into_bytes();
    let mut cursor = Cursor::new(bytes);

    assert!(read_frame(&mut cursor).is_err());
}

#[test]
fn rejects_duplicate_or_non_decimal_content_length() {
    for frame in [
        b"Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}".as_slice(),
        b"Content-Length: 2.0\r\n\r\n{}".as_slice(),
        b"content-length: 2\r\n\r\n{}".as_slice(),
    ] {
        let mut cursor = Cursor::new(frame);
        assert!(read_frame(&mut cursor).is_err());
    }
}

#[test]
fn rejects_truncated_body_and_malformed_json() {
    let mut truncated = Cursor::new(b"Content-Length: 10\r\n\r\n{}".as_slice());
    assert!(read_frame(&mut truncated).is_err());

    let mut malformed = Cursor::new(b"Content-Length: 1\r\n\r\n{".as_slice());
    assert!(read_frame(&mut malformed).is_err());
}

#[test]
fn shared_runtime_request_fixtures_deserialize_into_closed_types() {
    for name in [
        "runtime.hello.json",
        "system.inspect_root.json",
        "workspace.register.json",
        "workspace.read_project_profile.json",
        "workspace.restrict_policy.json",
        "workspace.activate.json",
        "workspace.begin_close.json",
        "workspace.cancel_executions.json",
        "workspace.unregister.json",
        "file.read.json",
        "file.tree.json",
        "file.search.json",
        "file.identity.json",
        "file.commit_patch_file.json",
        "git.checkpoint.json",
        "git.checkpoint_patch.json",
        "process.inspect_executable.json",
        "process.run.json",
        "verify.run.json",
        "process.status.json",
        "process.cancel.json",
        "artifact.read.json",
        "skill_source.inspect_root.json",
        "skill_source.register.json",
        "skill_source.tree.json",
        "skill_source.read.json",
        "skill_source.unregister.json",
    ] {
        let value = fixture(name);
        serde_json::from_value::<RuntimeRequest>(value)
            .unwrap_or_else(|error| panic!("{name} must deserialize: {error}"));
    }
}

#[test]
fn security_sensitive_params_reject_unknown_fields() {
    let mut value = fixture("file.read.json");
    value["params"]["unexpectedPrivilege"] = json!(true);

    let error =
        serde_json::from_value::<RuntimeRequest>(value).expect_err("unknown field rejected");
    assert!(error.to_string().contains("unknown field"));
}

#[test]
fn skill_source_params_reject_unknown_fields() {
    let mut value = fixture("skill_source.register.json");
    value["params"]["allowWrite"] = json!(true);

    let error = serde_json::from_value::<RuntimeRequest>(value)
        .expect_err("skill source privilege field rejected");
    assert!(error.to_string().contains("unknown field"));
}

#[test]
fn patch_commit_params_reject_cross_field_action_mismatches() {
    let base = fixture("file.commit_patch_file.json");

    let mut create_with_digest = base.clone();
    create_with_digest["params"]["action"] = json!("create");
    create_with_digest["params"]["expectedSha256"] = json!("a".repeat(64));
    serde_json::from_value::<RuntimeRequest>(create_with_digest)
        .expect_err("create digest must be null");

    let mut delete_with_content = base;
    delete_with_content["params"]["action"] = json!("delete");
    delete_with_content["params"]["content"] = json!("must-not-be-accepted");
    serde_json::from_value::<RuntimeRequest>(delete_with_content)
        .expect_err("delete content must be null");
}

#[test]
fn request_envelopes_reject_unknown_top_level_fields() {
    let mut value = fixture("runtime.hello.json");
    value["sessionId"] = json!("legacy");

    let error =
        serde_json::from_value::<RuntimeRequest>(value).expect_err("unknown field rejected");
    assert!(error.to_string().contains("unknown field"));
}

#[test]
fn policy_rejects_inherit_env_true() {
    let mut value = fixture("workspace.register.json");
    value["params"]["ceiling"]["inheritEnv"] = json!(true);

    serde_json::from_value::<RuntimeRequest>(value).expect_err("inheritEnv=true must be rejected");
}
