use std::fs;
use std::io::Cursor;
use std::path::PathBuf;

use kodegpt_protocol::{
    CiAuditParams, FileWriteParams, FileWritePrecondition, GitRepositoryIdentityParams,
    MAX_FRAME_BYTES, ProviderAuditParams, RuntimeRequest, read_frame, write_frame,
};
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
        "git.log.json",
        "git.show.json",
        "git.range.json",
        "git.diff_history.json",
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
        "skill_source.read_base64.json",
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
fn file_write_preconditions_are_optional_closed_and_typed() {
    let plain = serde_json::from_value::<FileWriteParams>(json!({
        "capabilityId": "kc_write",
        "path": "inside.txt",
        "content": "plain"
    }))
    .expect("plain file.write remains valid");
    assert!(plain.precondition.is_none());

    let missing = serde_json::from_value::<FileWriteParams>(json!({
        "capabilityId": "kc_write",
        "path": "inside.txt",
        "content": "guarded",
        "precondition": { "kind": "missing" }
    }))
    .expect("missing precondition deserializes");
    assert!(matches!(
        missing.precondition,
        Some(FileWritePrecondition::Missing {})
    ));

    let digest = serde_json::from_value::<FileWriteParams>(json!({
        "capabilityId": "kc_write",
        "path": "inside.txt",
        "content": "guarded",
        "precondition": { "kind": "sha256", "value": "a".repeat(64) }
    }))
    .expect("sha256 precondition deserializes");
    assert!(matches!(
        digest.precondition,
        Some(FileWritePrecondition::Sha256 { value }) if value == "a".repeat(64)
    ));

    let error = serde_json::from_value::<FileWriteParams>(json!({
        "capabilityId": "kc_write",
        "path": "inside.txt",
        "content": "guarded",
        "precondition": { "kind": "missing", "overwriteAnyway": true }
    }))
    .expect_err("unknown precondition field rejected");
    assert!(error.to_string().contains("unknown field"));
}

#[test]
fn git_worktree_mutation_params_are_closed_and_operation_typed() {
    let create = serde_json::from_value::<RuntimeRequest>(json!({
        "jsonrpc": "2.0",
        "id": "req_git_worktree_create",
        "method": "git.worktree_mutation",
        "params": {
            "operation": "create",
            "capabilityId": "kc_git_worktree",
            "name": "phase7",
            "branch": "feat/phase7"
        }
    }));
    assert!(create.is_ok(), "closed create variant must deserialize");

    let remove = serde_json::from_value::<RuntimeRequest>(json!({
        "jsonrpc": "2.0",
        "id": "req_git_worktree_remove",
        "method": "git.worktree_mutation",
        "params": {
            "operation": "remove",
            "capabilityId": "kc_git_worktree",
            "name": "phase7"
        }
    }));
    assert!(remove.is_ok(), "closed remove variant must deserialize");

    for params in [
        json!({
            "operation": "create",
            "capabilityId": "kc_git_worktree",
            "name": "phase7",
            "branch": "feat/phase7",
            "force": true
        }),
        json!({
            "operation": "remove",
            "capabilityId": "kc_git_worktree",
            "name": "phase7",
            "branch": "feat/phase7"
        }),
        json!({
            "operation": "create",
            "capabilityId": "kc_git_worktree",
            "name": "phase7"
        }),
    ] {
        let malformed = serde_json::from_value::<RuntimeRequest>(json!({
            "jsonrpc": "2.0",
            "id": "req_git_worktree_bad",
            "method": "git.worktree_mutation",
            "params": params
        }));
        assert!(
            malformed.is_err(),
            "malformed worktree mutation must fail closed"
        );
    }
}

#[test]
fn git_remote_credentials_are_optional_closed_and_typed() {
    let plain = serde_json::from_value::<RuntimeRequest>(json!({
        "jsonrpc": "2.0",
        "id": "req_git_plain",
        "method": "git.remote_mutation",
        "params": {
            "operation": "push",
            "capabilityId": "kc_git_remote",
            "remote": "origin",
            "ref": "main"
        }
    }));
    assert!(plain.is_ok(), "plain git.remote_mutation remains valid");

    let credentialed = serde_json::from_value::<RuntimeRequest>(json!({
        "jsonrpc": "2.0",
        "id": "req_git_credentialed",
        "method": "git.remote_mutation",
        "params": {
            "operation": "push",
            "capabilityId": "kc_git_remote",
            "remote": "origin",
            "ref": "main",
            "credential": { "kind": "github_token", "token": "[REDACTED_SECRET]" }
        }
    }));
    assert!(
        credentialed.is_ok(),
        "closed GitHub credential variant must deserialize"
    );

    let malformed = serde_json::from_value::<RuntimeRequest>(json!({
        "jsonrpc": "2.0",
        "id": "req_git_bad_credential",
        "method": "git.remote_mutation",
        "params": {
            "operation": "push",
            "capabilityId": "kc_git_remote",
            "remote": "origin",
            "ref": "main",
            "credential": {
                "kind": "github_token",
                "token": "[REDACTED_SECRET]",
                "unexpected": true
            }
        }
    }));
    let error = malformed.expect_err("unknown credential field rejected");
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
fn git_history_params_are_structured_and_reject_unknown_fields() {
    for name in [
        "git.log.json",
        "git.show.json",
        "git.range.json",
        "git.diff_history.json",
    ] {
        let value = fixture(name);
        serde_json::from_value::<RuntimeRequest>(value.clone())
            .unwrap_or_else(|error| panic!("{name} must deserialize: {error}"));

        let mut with_raw_argv = value;
        with_raw_argv["params"]["argv"] = json!(["--all"]);
        let error = serde_json::from_value::<RuntimeRequest>(with_raw_argv)
            .expect_err("raw git argv must be rejected");
        assert!(error.to_string().contains("unknown field"));
    }
}

#[test]
fn git_repository_identity_params_are_closed() {
    let params = json!({"capabilityId": "kc_repo_identity"});
    let parsed = serde_json::from_value::<GitRepositoryIdentityParams>(params)
        .expect("repository identity params deserialize");
    assert_eq!(parsed.capability_id, "kc_repo_identity");

    let with_raw_argv = json!({
        "capabilityId": "kc_repo_identity",
        "argv": ["config", "--list"]
    });
    let error = serde_json::from_value::<GitRepositoryIdentityParams>(with_raw_argv)
        .expect_err("raw git argv must be rejected");
    assert!(error.to_string().contains("unknown field"));
}

#[test]
fn ci_audit_params_are_closed_and_typed() {
    let valid = json!({
        "capabilityId": "kc_ci_audit",
        "operationId": "op_ci_audit_1",
        "ciCapability": "ci.status",
        "phase": "decision",
        "provider": "github",
        "repository": "2ndworld/kodeGPT",
        "credentialSource": "gh",
        "runId": "12345678901234567890",
        "jobId": "98765432109876543210",
        "errorCode": "CI_RATE_LIMITED",
        "truncated": true,
        "durationMs": 42
    });
    serde_json::from_value::<CiAuditParams>(valid).expect("valid CI audit params");

    for invalid in [
        json!({
            "capabilityId": "kc_ci_audit",
            "operationId": "op_ci_audit_1",
            "ciCapability": "ci.status",
            "phase": "decision",
            "provider": "github",
            "repository": "https://github.com/2ndworld/kodeGPT"
        }),
        json!({
            "capabilityId": "kc_ci_audit",
            "operationId": "op_ci_audit_1",
            "ciCapability": "ci.status",
            "phase": "decision",
            "provider": "github",
            "repository": "2ndworld/kodeGPT",
            "credentialSource": "other"
        }),
        json!({
            "capabilityId": "kc_ci_audit",
            "operationId": "op_ci_audit_1",
            "ciCapability": "ci.status",
            "phase": "decision",
            "provider": "github",
            "repository": "2ndworld/kodeGPT",
            "runId": "1e3"
        }),
        json!({
            "capabilityId": "kc_ci_audit",
            "operationId": "op_ci_audit_1",
            "ciCapability": "ci.status",
            "phase": "decision",
            "provider": "github",
            "repository": "2ndworld/kodeGPT",
            "secretMaterial": "forbidden"
        }),
    ] {
        serde_json::from_value::<CiAuditParams>(invalid)
            .expect_err("unsafe CI audit params must be rejected");
    }
}

#[test]
fn ci_audit_params_accept_bounded_mutation_capabilities() {
    for capability in ["ci.rerun", "ci.cancel", "ci.dispatch"] {
        for error_code in ["CI_MUTATION_OUTCOME_UNKNOWN", "CI_MUTATION_STATE_CONFLICT"] {
            let params = json!({
                "capabilityId": "kc_ci_mutation_audit",
                "operationId": "op_ci_mutation_audit",
                "ciCapability": capability,
                "phase": "failed",
                "provider": "github",
                "repository": "2ndworld/kodeGPT",
                "credentialSource": "gh",
                "runId": "32024673099",
                "errorCode": error_code
            });
            serde_json::from_value::<CiAuditParams>(params).unwrap_or_else(|error| {
                panic!("{capability} with {error_code} must be accepted by the Rust CI audit contract: {error}")
            });
        }
    }
}

#[test]
fn provider_audit_params_are_closed_global_and_typed() {
    let valid = json!({
        "operationId": "op_test",
        "operation": "execute",
        "phase": "failed",
        "providerInstanceId": "prv_0123456789abcdef0123456789abcdef",
        "adapterId": "fixture.read",
        "semanticCapabilityId": "test.fixture.record.read",
        "errorCode": "PROVIDER_TIMEOUT",
        "inventoryChanged": false,
        "truncated": true,
        "durationMs": 42
    });
    serde_json::from_value::<ProviderAuditParams>(valid).expect("valid provider audit params");

    for invalid in [
        json!({
            "operationId": "op_test",
            "operation": "execute",
            "phase": "decision",
            "providerInstanceId": "prv_0123456789abcdef0123456789abcdef",
            "adapterId": "fixture.read",
            "credential": "forbidden"
        }),
        json!({
            "operationId": "op_test",
            "operation": "execute",
            "phase": "decision",
            "providerInstanceId": "bad",
            "adapterId": "fixture.read"
        }),
        json!({
            "operationId": "op_test",
            "operation": "execute",
            "phase": "decision",
            "providerInstanceId": "prv_0123456789abcdef0123456789abcdef",
            "adapterId": "fixture.read",
            "errorCode": "UNKNOWN_PROVIDER_ERROR"
        }),
        json!({
            "operationId": "op_test",
            "operation": "execute",
            "phase": "decision",
            "providerInstanceId": "prv_0123456789abcdef0123456789abcdef",
            "adapterId": "fixture.read",
            "capabilityId": "must-not-be-accepted"
        }),
    ] {
        serde_json::from_value::<ProviderAuditParams>(invalid)
            .expect_err("unsafe provider audit params must be rejected");
    }
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
