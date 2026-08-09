use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use kodegpt_workspace_io::inspect_root;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::task::JoinSet;

use crate::audit::{
    AuditAction, AuditContext, AuditDecision, AuditOutcome, AuditReason, AuditSink,
};
use crate::rpc::{error_response, parse_request, success_response};

#[cfg(feature = "runtime-test-methods")]
use std::io::Write as _;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SystemInspectRootParams {
    path: String,
}

#[cfg(feature = "runtime-test-methods")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SleepParams {
    delay_ms: u64,
}

#[cfg(feature = "runtime-test-methods")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EchoAfterParams {
    value: Value,
    delay_ms: u64,
}

#[cfg(feature = "runtime-test-methods")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuditEffectParams {
    marker_path: String,
    #[serde(default, rename = "secret")]
    _secret: Option<String>,
}

pub async fn run_dispatcher(
    mut requests: mpsc::UnboundedReceiver<Value>,
    responses: mpsc::UnboundedSender<Value>,
    test_methods_enabled: bool,
    audit: Arc<AuditSink>,
) {
    let mut tasks = JoinSet::new();

    while let Some(value) = requests.recv().await {
        let response_tx = responses.clone();
        let audit = Arc::clone(&audit);
        tasks.spawn(async move {
            let response = dispatch_one(value, test_methods_enabled, audit).await;
            let _ = response_tx.send(response);
        });
    }

    while tasks.join_next().await.is_some() {}
}

async fn dispatch_one(
    value: Value,
    test_methods_enabled: bool,
    audit: Arc<AuditSink>,
) -> Value {
    let request = match parse_request(value) {
        Ok(request) => request,
        Err(response) => return response,
    };

    match request.method.as_str() {
        "runtime.hello" => {
            if request.params.as_object().is_none_or(|params| !params.is_empty()) {
                return error_response(Some(request.id), -32602, "INVALID_PARAMS");
            }

            success_response(
                request.id,
                json!({
                    "runtimeVersion": "0.1",
                    "testMethods": cfg!(feature = "runtime-test-methods") && test_methods_enabled,
                    "auditHealthy": audit.is_healthy()
                }),
            )
        }
        "system.inspect_root" => {
            let params = match serde_json::from_value::<SystemInspectRootParams>(request.params) {
                Ok(params) => params,
                Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            let operation_suffix = request.id.strip_prefix("req_").unwrap_or("redacted");
            let audit_context = AuditContext {
                request_id: request.id.clone(),
                operation_id: format!("op_{operation_suffix}"),
                capability_id: None,
                action: AuditAction::InspectRoot,
            };

            if audit
                .decision(
                    &audit_context,
                    AuditDecision::Allow,
                    AuditReason::RequestValidated,
                )
                .is_err()
            {
                return error_response(Some(request.id), -32010, "AUDIT_UNAVAILABLE");
            }

            let inspected = match inspect_root(&PathBuf::from(params.path)) {
                Ok(inspected) => inspected,
                Err(_) => {
                    return audited_failure(
                        &audit,
                        &audit_context,
                        request.id,
                        -32020,
                        "WORKSPACE_ROOT_INVALID",
                    );
                }
            };
            let canonical_state_root = match fs::canonicalize(audit.state_root()) {
                Ok(path) => path,
                Err(_) => {
                    return audited_failure(
                        &audit,
                        &audit_context,
                        request.id,
                        -32010,
                        "AUDIT_UNAVAILABLE",
                    );
                }
            };

            if inspected.canonical_root.starts_with(&canonical_state_root)
                || canonical_state_root.starts_with(&inspected.canonical_root)
            {
                return audited_failure(
                    &audit,
                    &audit_context,
                    request.id,
                    -32021,
                    "WORKSPACE_STATE_OVERLAP",
                );
            }

            if audit
                .outcome(&audit_context, AuditOutcome::Success)
                .is_err()
            {
                return error_response(Some(request.id), -32010, "AUDIT_UNAVAILABLE");
            }

            success_response(
                request.id,
                json!({
                    "canonicalRoot": inspected.canonical_root.to_string_lossy(),
                    "identity": inspected.identity
                }),
            )
        }
        #[cfg(feature = "runtime-test-methods")]
        "test.sleep" if test_methods_enabled => {
            let params = match serde_json::from_value::<SleepParams>(request.params) {
                Ok(params) => params,
                Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            tokio::time::sleep(std::time::Duration::from_millis(params.delay_ms)).await;
            success_response(request.id, json!({ "sleptMs": params.delay_ms }))
        }
        #[cfg(feature = "runtime-test-methods")]
        "test.echo_after" if test_methods_enabled => {
            let params = match serde_json::from_value::<EchoAfterParams>(request.params) {
                Ok(params) => params,
                Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            tokio::time::sleep(std::time::Duration::from_millis(params.delay_ms)).await;
            success_response(request.id, json!({ "value": params.value }))
        }
        #[cfg(feature = "runtime-test-methods")]
        "test.audit_effect" if test_methods_enabled => {
            let params = match serde_json::from_value::<AuditEffectParams>(request.params) {
                Ok(params) => params,
                Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            let marker_path = PathBuf::from(&params.marker_path);
            if marker_path.parent() != Some(audit.state_root()) || marker_path.file_name().is_none() {
                return error_response(Some(request.id), -32602, "INVALID_PARAMS");
            }

            let operation_suffix = request.id.strip_prefix("req_").unwrap_or("redacted");
            let audit_context = AuditContext {
                request_id: request.id.clone(),
                operation_id: format!("op_{operation_suffix}"),
                capability_id: None,
                action: AuditAction::TestEffect,
            };

            if audit
                .decision(
                    &audit_context,
                    AuditDecision::Allow,
                    AuditReason::TestAuthorized,
                )
                .is_err()
            {
                return error_response(Some(request.id), -32010, "AUDIT_UNAVAILABLE");
            }

            let effect_result = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&marker_path)
                .and_then(|mut file| {
                    file.write_all(b"effect")?;
                    file.sync_all()
                });
            if effect_result.is_err() {
                let _ = audit.outcome(&audit_context, AuditOutcome::Failed);
                return error_response(Some(request.id), -32011, "TEST_EFFECT_FAILED");
            }

            if audit
                .outcome(&audit_context, AuditOutcome::Success)
                .is_err()
            {
                return error_response(Some(request.id), -32010, "AUDIT_UNAVAILABLE");
            }

            success_response(request.id, json!({ "created": true }))
        }
        _ => error_response(Some(request.id), -32601, "METHOD_NOT_FOUND"),
    }
}

fn audited_failure(
    audit: &AuditSink,
    context: &AuditContext,
    request_id: String,
    code: i64,
    message: &str,
) -> Value {
    if audit.outcome(context, AuditOutcome::Failed).is_err() {
        return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
    }
    error_response(Some(request_id), code, message)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;
    #[cfg(feature = "runtime-test-methods")]
    use std::time::Instant;

    use serde_json::{Value, json};
    use tokio::sync::mpsc;

    use super::run_dispatcher;
    use crate::audit::AuditSink;

    fn audit_sink(label: &str) -> (Arc<AuditSink>, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "kodegpt-dispatcher-{label}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let sink = Arc::new(AuditSink::open(&root));
        (sink, root)
    }

    fn request(id: &str, method: &str, params: Value) -> Value {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        })
    }

    #[cfg(feature = "runtime-test-methods")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dispatcher_keeps_runtime_hello_responsive_while_sleep_is_pending() {
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let (audit, audit_root) = audit_sink("concurrency");
        let dispatcher = tokio::spawn(run_dispatcher(request_rx, response_tx, true, audit));

        request_tx
            .send(request("req_sleep", "test.sleep", json!({ "delayMs": 500 })))
            .expect("sleep request accepted");
        let started = Instant::now();
        request_tx
            .send(request("req_hello", "runtime.hello", json!({})))
            .expect("hello request accepted");

        let first = tokio::time::timeout(Duration::from_millis(200), response_rx.recv())
            .await
            .expect("hello must complete within 200 ms")
            .expect("response channel open");
        assert_eq!(first["id"], "req_hello");
        assert!(started.elapsed() < Duration::from_millis(200));

        let second = tokio::time::timeout(Duration::from_millis(700), response_rx.recv())
            .await
            .expect("sleep eventually completes")
            .expect("response channel open");
        assert_eq!(second["id"], "req_sleep");

        drop(request_tx);
        dispatcher.await.expect("dispatcher task joins");
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[cfg(feature = "runtime-test-methods")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dispatcher_correlates_out_of_order_test_responses_by_id() {
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let (audit, audit_root) = audit_sink("correlation");
        let dispatcher = tokio::spawn(run_dispatcher(request_rx, response_tx, true, audit));

        for (id, value, delay_ms) in [
            ("req_a", "A", 120_u64),
            ("req_b", "B", 10_u64),
            ("req_c", "C", 60_u64),
        ] {
            request_tx
                .send(request(
                    id,
                    "test.echo_after",
                    json!({ "value": value, "delayMs": delay_ms }),
                ))
                .expect("request accepted");
        }

        let mut seen = Vec::new();
        for _ in 0..3 {
            let response = tokio::time::timeout(Duration::from_millis(300), response_rx.recv())
                .await
                .expect("response arrives")
                .expect("response channel open");
            seen.push((
                response["id"].as_str().expect("id string").to_owned(),
                response["result"]["value"]
                    .as_str()
                    .expect("echo value")
                    .to_owned(),
            ));
        }

        assert_eq!(
            seen,
            vec![
                ("req_b".to_owned(), "B".to_owned()),
                ("req_c".to_owned(), "C".to_owned()),
                ("req_a".to_owned(), "A".to_owned()),
            ]
        );

        drop(request_tx);
        dispatcher.await.expect("dispatcher task joins");
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    async fn inspect_root_once(audit: Arc<AuditSink>, path: &PathBuf, id: &str) -> Value {
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(request_rx, response_tx, false, audit));
        request_tx
            .send(request(
                id,
                "system.inspect_root",
                json!({ "path": path.to_string_lossy() }),
            ))
            .expect("inspect request accepted");
        drop(request_tx);

        let response = tokio::time::timeout(Duration::from_millis(500), response_rx.recv())
            .await
            .expect("inspect response arrives")
            .expect("response channel open");
        dispatcher.await.expect("dispatcher task joins");
        response
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn inspect_root_returns_identity_without_capability_and_is_audited() {
        let (audit, audit_root) = audit_sink("inspect-valid");
        let workspace = audit_root.with_extension("workspace");
        fs::create_dir_all(&workspace).expect("workspace created");

        let response = inspect_root_once(Arc::clone(&audit), &workspace, "req_inspect_valid").await;
        assert_eq!(response["id"], "req_inspect_valid");
        assert_eq!(response["result"]["canonicalRoot"], fs::canonicalize(&workspace).unwrap().to_string_lossy().as_ref());
        assert!(response["result"]["identity"]["inode"].as_str().is_some());
        assert!(response["result"].get("capabilityId").is_none());

        let audit_text = fs::read_to_string(audit.path()).expect("audit readable");
        assert_eq!(audit_text.lines().count(), 2);
        assert!(audit_text.contains("inspect_root"));

        fs::remove_dir_all(workspace).expect("workspace removed");
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn inspect_root_rejects_equal_ancestor_and_descendant_state_overlap() {
        let (audit, audit_root) = audit_sink("inspect-overlap");
        let descendant = audit_root.join("workspace-child");
        fs::create_dir_all(&descendant).expect("descendant fixture created");
        let ancestor = audit_root
            .parent()
            .expect("temporary root has parent")
            .to_path_buf();

        for (id, path) in [
            ("req_inspect_equal", audit_root.clone()),
            ("req_inspect_descendant", descendant),
            ("req_inspect_ancestor", ancestor),
        ] {
            let response = inspect_root_once(Arc::clone(&audit), &path, id).await;
            assert_eq!(response["error"]["message"], "WORKSPACE_STATE_OVERLAP");
        }
        assert_eq!(fs::read_to_string(audit.path()).unwrap().lines().count(), 6);

        fs::remove_dir_all(audit_root).expect("audit root removed");
    }
}
