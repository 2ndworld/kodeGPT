use std::sync::{Arc, Mutex};

use kodegpt_protocol::{GitDiffParams, GitStatusParams, RuntimePolicy};
use kodegpt_workspace_io::{WorkspaceRegistry, WorkspaceRegistryError, probe_filesystem_boundary};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::task::JoinSet;

use crate::audit::{
    AuditAction, AuditContext, AuditDecision, AuditOutcome, AuditReason, AuditSink,
};
use crate::execution::ExecutionRegistry;
use crate::git::{GitOperation, run_git_inspection};
use crate::rpc::{error_response, parse_request, success_response};
use crate::spool::RawSpoolStore;

mod workspace_authority {
    include!("workspace_dispatcher.rs");

    pub(super) async fn dispatch_shared(
        value: serde_json::Value,
        test_methods_enabled: bool,
        audit: std::sync::Arc<crate::audit::AuditSink>,
        workspace_registry: std::sync::Arc<
            std::sync::Mutex<kodegpt_workspace_io::WorkspaceRegistry<kodegpt_protocol::RuntimePolicy>>,
        >,
        filesystem_boundary_available: bool,
    ) -> serde_json::Value {
        dispatch_one(
            value,
            test_methods_enabled,
            audit,
            workspace_registry,
            filesystem_boundary_available,
        )
        .await
    }
}

pub async fn run_dispatcher(
    requests: mpsc::UnboundedReceiver<Value>,
    responses: mpsc::UnboundedSender<Value>,
    test_methods_enabled: bool,
    audit: Arc<AuditSink>,
) {
    let filesystem_boundary_available = probe_filesystem_boundary().is_ok();
    run_dispatcher_with_boundary_status(
        requests,
        responses,
        test_methods_enabled,
        audit,
        filesystem_boundary_available,
    )
    .await;
}

async fn run_dispatcher_with_boundary_status(
    mut requests: mpsc::UnboundedReceiver<Value>,
    responses: mpsc::UnboundedSender<Value>,
    test_methods_enabled: bool,
    audit: Arc<AuditSink>,
    filesystem_boundary_available: bool,
) {
    let mut tasks = JoinSet::new();
    let workspace_registry = Arc::new(Mutex::new(WorkspaceRegistry::<RuntimePolicy>::new()));
    let execution_registry = Arc::new(Mutex::new(ExecutionRegistry::default()));
    let raw_spool = RawSpoolStore::open(audit.state_root(), Arc::clone(&audit))
        .ok()
        .map(Arc::new);

    while let Some(value) = requests.recv().await {
        let response_tx = responses.clone();
        let audit = Arc::clone(&audit);
        let workspace_registry = Arc::clone(&workspace_registry);
        let execution_registry = Arc::clone(&execution_registry);
        let raw_spool = raw_spool.as_ref().map(Arc::clone);
        tasks.spawn(async move {
            let response = match value.get("method").and_then(Value::as_str) {
                Some("git.status" | "git.diff") => {
                    dispatch_git_request(
                        value,
                        audit,
                        workspace_registry,
                        execution_registry,
                        raw_spool,
                    )
                    .await
                }
                _ => {
                    workspace_authority::dispatch_shared(
                        value,
                        test_methods_enabled,
                        audit,
                        workspace_registry,
                        filesystem_boundary_available,
                    )
                    .await
                }
            };
            let _ = response_tx.send(response);
        });
    }

    while tasks.join_next().await.is_some() {}
}

async fn dispatch_git_request(
    value: Value,
    audit: Arc<AuditSink>,
    workspace_registry: Arc<Mutex<WorkspaceRegistry<RuntimePolicy>>>,
    execution_registry: Arc<Mutex<ExecutionRegistry>>,
    raw_spool: Option<Arc<RawSpoolStore>>,
) -> Value {
    let request = match parse_request(value) {
        Ok(request) => request,
        Err(response) => return response,
    };

    match request.method.as_str() {
        "git.status" => {
            let params = match serde_json::from_value::<GitStatusParams>(request.params) {
                Ok(params) if !params.capability_id.is_empty() => params,
                Ok(_) | Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            dispatch_git_operation(
                &audit,
                &workspace_registry,
                &execution_registry,
                raw_spool,
                request.id,
                params.capability_id,
                GitOperation::Status,
                AuditAction::GitStatus,
            )
            .await
        }
        "git.diff" => {
            let params = match serde_json::from_value::<GitDiffParams>(request.params) {
                Ok(params) if !params.capability_id.is_empty() => params,
                Ok(_) | Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            dispatch_git_operation(
                &audit,
                &workspace_registry,
                &execution_registry,
                raw_spool,
                request.id,
                params.capability_id,
                GitOperation::Diff,
                AuditAction::GitDiff,
            )
            .await
        }
        _ => error_response(Some(request.id), -32601, "METHOD_NOT_FOUND"),
    }
}

async fn dispatch_git_operation(
    audit: &Arc<AuditSink>,
    registry: &Arc<Mutex<WorkspaceRegistry<RuntimePolicy>>>,
    executions: &Arc<Mutex<ExecutionRegistry>>,
    raw_spool: Option<Arc<RawSpoolStore>>,
    request_id: String,
    capability_id: String,
    operation: GitOperation,
    action: AuditAction,
) -> Value {
    let operation_suffix = request_id.strip_prefix("req_").unwrap_or("redacted");
    let operation_id = format!("op_{operation_suffix}");
    let context = AuditContext {
        request_id: request_id.clone(),
        operation_id: operation_id.clone(),
        capability_id: Some(capability_id.clone()),
        action,
    };

    if audit
        .decision(
            &context,
            AuditDecision::Allow,
            AuditReason::RequestValidated,
        )
        .is_err()
    {
        return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
    }

    let root_fd = match registry.lock() {
        Ok(registry) => match registry.duplicate_ready_root_fd(&capability_id) {
            Ok(root_fd) => root_fd,
            Err(error) => {
                let (code, message) = workspace_registry_error_contract(&error);
                return audited_failure(audit, &context, request_id, code, message);
            }
        },
        Err(_) => {
            return audited_failure(
                audit,
                &context,
                request_id,
                -32026,
                "WORKSPACE_REGISTRY_UNAVAILABLE",
            );
        }
    };

    let Some(raw_spool) = raw_spool else {
        return audited_failure(
            audit,
            &context,
            request_id,
            -32038,
            "GIT_INSPECTION_UNAVAILABLE",
        );
    };

    let executions = Arc::clone(executions);
    let capability_for_run = capability_id.clone();
    let request_for_run = request_id.clone();
    let operation_for_run = operation_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        run_git_inspection(
            &root_fd,
            &capability_for_run,
            &request_for_run,
            &operation_for_run,
            operation,
            &raw_spool,
            &executions,
        )
    })
    .await;

    let result = match result {
        Ok(Ok(result)) => result,
        Ok(Err(_)) | Err(_) => {
            return audited_failure(
                audit,
                &context,
                request_id,
                -32039,
                "GIT_INSPECTION_FAILED",
            );
        }
    };

    let outcome = if result.exit_code == 0 {
        AuditOutcome::Success
    } else {
        AuditOutcome::Failed
    };
    if audit.outcome(&context, outcome).is_err() {
        return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
    }
    success_response(request_id, json!(result))
}

fn workspace_registry_error_contract(error: &WorkspaceRegistryError) -> (i64, &'static str) {
    match error {
        WorkspaceRegistryError::RootInvalid => (-32020, "WORKSPACE_ROOT_INVALID"),
        WorkspaceRegistryError::IdentityChanged => (-32022, "WORKSPACE_IDENTITY_CHANGED"),
        WorkspaceRegistryError::MountTopologyUnavailable => (-32023, "MOUNT_TOPOLOGY_UNAVAILABLE"),
        WorkspaceRegistryError::RootOverlap => (-32024, "WORKSPACE_ROOT_OVERLAP"),
        WorkspaceRegistryError::PolicyEscalation => (-32027, "WORKSPACE_POLICY_ESCALATION"),
        WorkspaceRegistryError::WorkspaceNotReady => (-32028, "WORKSPACE_NOT_READY"),
        WorkspaceRegistryError::ProjectProfileReadFailed => (-32029, "WORKSPACE_PROFILE_READ_FAILED"),
        WorkspaceRegistryError::FilesystemBoundaryUnavailable => (-32030, "FILESYSTEM_BOUNDARY_UNAVAILABLE"),
        WorkspaceRegistryError::FileAccessDenied => (-32031, "FILE_ACCESS_DENIED"),
        WorkspaceRegistryError::FileNotFound => (-32032, "FILE_NOT_FOUND"),
        WorkspaceRegistryError::FileInvalidUtf8 => (-32033, "FILE_INVALID_UTF8"),
        WorkspaceRegistryError::FileLimitExceeded => (-32034, "FILE_LIMIT_EXCEEDED"),
        WorkspaceRegistryError::FileReadFailed => (-32035, "FILE_READ_FAILED"),
        WorkspaceRegistryError::FileWriteConflict => (-32036, "FILE_EDIT_CONFLICT"),
        WorkspaceRegistryError::FileWriteFailed => (-32037, "FILE_WRITE_FAILED"),
        WorkspaceRegistryError::CapabilityNotFound => (-32025, "WORKSPACE_CAPABILITY_NOT_FOUND"),
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

    use serde_json::{Value, json};
    use tokio::sync::mpsc;

    use super::run_dispatcher;
    use crate::audit::AuditSink;

    fn request(id: &str, method: &str, params: Value) -> Value {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        })
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn top_level_router_preserves_non_git_runtime_dispatch() {
        let state = std::env::temp_dir().join(format!(
            "kodegpt-dispatch-router-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&state);
        let audit = Arc::new(AuditSink::open(&state));
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(request_rx, response_tx, false, audit));

        request_tx
            .send(request("req_router_hello", "runtime.hello", json!({})))
            .expect("hello accepted");
        let response = tokio::time::timeout(Duration::from_secs(1), response_rx.recv())
            .await
            .expect("hello response arrives")
            .expect("response channel open");
        assert_eq!(response["id"], "req_router_hello");
        assert_eq!(response["result"]["runtimeVersion"], "0.1");

        drop(request_tx);
        dispatcher.await.expect("dispatcher joins");
        fs::remove_dir_all(PathBuf::from(state)).expect("state removed");
    }
}
