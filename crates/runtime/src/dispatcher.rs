use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use kodegpt_protocol::{
    GitDiffParams, GitStatusParams, ProcessOperationParams, ProcessRunParams, RuntimePolicy,
    WorkspaceCapabilityParams, WorkspaceRegisterParams, WorkspaceRestrictPolicyParams,
};
use kodegpt_workspace_io::{WorkspaceRegistry, WorkspaceRegistryError, probe_filesystem_boundary};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::task::JoinSet;

use crate::audit::{
    AuditAction, AuditContext, AuditDecision, AuditOutcome, AuditReason, AuditSink,
};
use crate::execution::ExecutionRegistry;
use crate::git::{GitOperation, run_git_inspection};
use crate::process::{ProcessError, ProcessManager};
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MirrorPhase {
    Opening,
    Ready,
    Transitioning,
    Closing,
}

#[derive(Debug, Clone)]
struct PolicyMirrorEntry {
    policy: RuntimePolicy,
    phase: MirrorPhase,
}

#[derive(Debug, Default)]
struct PolicyMirror {
    entries: Mutex<HashMap<String, PolicyMirrorEntry>>,
}

impl PolicyMirror {
    fn insert_opening(&self, capability_id: String, policy: RuntimePolicy) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(
                capability_id,
                PolicyMirrorEntry {
                    policy,
                    phase: MirrorPhase::Opening,
                },
            );
        }
    }

    fn restrict(&self, capability_id: &str, policy: RuntimePolicy) {
        if let Ok(mut entries) = self.entries.lock()
            && let Some(entry) = entries.get_mut(capability_id)
        {
            entry.policy = policy;
        }
    }

    fn activate(&self, capability_id: &str) {
        if let Ok(mut entries) = self.entries.lock()
            && let Some(entry) = entries.get_mut(capability_id)
        {
            entry.phase = MirrorPhase::Ready;
        }
    }

    fn begin_close_transition(&self, capability_id: &str) -> Option<PolicyMirrorEntry> {
        let mut entries = self.entries.lock().ok()?;
        let entry = entries.get_mut(capability_id)?;
        if entry.phase != MirrorPhase::Ready {
            return None;
        }
        let previous = entry.clone();
        entry.phase = MirrorPhase::Transitioning;
        Some(previous)
    }

    fn close(&self, capability_id: &str) {
        if let Ok(mut entries) = self.entries.lock()
            && let Some(entry) = entries.get_mut(capability_id)
        {
            entry.phase = MirrorPhase::Closing;
        }
    }

    fn restore(&self, capability_id: &str, previous: PolicyMirrorEntry) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(capability_id.to_owned(), previous);
        }
    }

    fn remove(&self, capability_id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(capability_id);
        }
    }

    fn ready_policy(&self, capability_id: &str) -> Option<RuntimePolicy> {
        let entries = self.entries.lock().ok()?;
        let entry = entries.get(capability_id)?;
        (entry.phase == MirrorPhase::Ready).then(|| entry.policy.clone())
    }
}

struct BeginCloseTransition {
    capability_id: String,
    previous: PolicyMirrorEntry,
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
    let policy_mirror = Arc::new(PolicyMirror::default());
    let raw_spool = RawSpoolStore::open(audit.state_root(), Arc::clone(&audit))
        .ok()
        .map(Arc::new);
    let process_manager = raw_spool.as_ref().map(|spool| {
        Arc::new(ProcessManager::new(
            Arc::clone(&execution_registry),
            Arc::clone(spool),
            Arc::clone(&audit),
        ))
    });

    while let Some(value) = requests.recv().await {
        let method = value.get("method").and_then(Value::as_str).map(str::to_owned);
        let begin_close_transition = if method.as_deref() == Some("workspace.begin_close") {
            capability_param(&value).and_then(|capability_id| {
                policy_mirror
                    .begin_close_transition(&capability_id)
                    .map(|previous| BeginCloseTransition {
                        capability_id,
                        previous,
                    })
            })
        } else {
            None
        };

        let response_tx = responses.clone();
        let audit = Arc::clone(&audit);
        let workspace_registry = Arc::clone(&workspace_registry);
        let execution_registry = Arc::clone(&execution_registry);
        let policy_mirror = Arc::clone(&policy_mirror);
        let raw_spool = raw_spool.as_ref().map(Arc::clone);
        let process_manager = process_manager.as_ref().map(Arc::clone);
        tasks.spawn(async move {
            let response = match method.as_deref() {
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
                Some("process.run" | "process.status" | "process.cancel") => {
                    dispatch_process_request(
                        value,
                        audit,
                        workspace_registry,
                        policy_mirror,
                        process_manager,
                    )
                    .await
                }
                Some("workspace.cancel_executions") => {
                    dispatch_workspace_cancel_executions(
                        value,
                        audit,
                        workspace_registry,
                        process_manager,
                    )
                    .await
                }
                _ => {
                    dispatch_workspace_request(
                        value,
                        test_methods_enabled,
                        audit,
                        workspace_registry,
                        policy_mirror,
                        filesystem_boundary_available,
                        begin_close_transition,
                    )
                    .await
                }
            };
            let _ = response_tx.send(response);
        });
    }

    while tasks.join_next().await.is_some() {}
}

async fn dispatch_workspace_request(
    value: Value,
    test_methods_enabled: bool,
    audit: Arc<AuditSink>,
    workspace_registry: Arc<Mutex<WorkspaceRegistry<RuntimePolicy>>>,
    policy_mirror: Arc<PolicyMirror>,
    filesystem_boundary_available: bool,
    begin_close_transition: Option<BeginCloseTransition>,
) -> Value {
    let request_copy = value.clone();
    let response = workspace_authority::dispatch_shared(
        value,
        test_methods_enabled,
        audit,
        workspace_registry,
        filesystem_boundary_available,
    )
    .await;

    if response_succeeded(&response) {
        match request_copy.get("method").and_then(Value::as_str) {
            Some("workspace.register") => {
                if let (Ok(params), Some(capability_id)) = (
                    request_params::<WorkspaceRegisterParams>(&request_copy),
                    response
                        .get("result")
                        .and_then(|result| result.get("capabilityId"))
                        .and_then(Value::as_str),
                ) {
                    policy_mirror.insert_opening(capability_id.to_owned(), params.ceiling);
                }
            }
            Some("workspace.restrict_policy") => {
                if let Ok(params) = request_params::<WorkspaceRestrictPolicyParams>(&request_copy) {
                    policy_mirror.restrict(&params.capability_id, params.restriction);
                }
            }
            Some("workspace.activate") => {
                if let Some(capability_id) = capability_param(&request_copy) {
                    policy_mirror.activate(&capability_id);
                }
            }
            Some("workspace.begin_close") => {
                if let Some(capability_id) = capability_param(&request_copy) {
                    policy_mirror.close(&capability_id);
                }
            }
            Some("workspace.unregister") => {
                if let Some(capability_id) = capability_param(&request_copy) {
                    policy_mirror.remove(&capability_id);
                }
            }
            _ => {}
        }
    } else if let Some(transition) = begin_close_transition {
        policy_mirror.restore(&transition.capability_id, transition.previous);
    }

    response
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

async fn dispatch_process_request(
    value: Value,
    audit: Arc<AuditSink>,
    workspace_registry: Arc<Mutex<WorkspaceRegistry<RuntimePolicy>>>,
    policy_mirror: Arc<PolicyMirror>,
    process_manager: Option<Arc<ProcessManager>>,
) -> Value {
    let request = match parse_request(value) {
        Ok(request) => request,
        Err(response) => return response,
    };

    match request.method.as_str() {
        "process.run" => {
            let params = match serde_json::from_value::<ProcessRunParams>(request.params) {
                Ok(params)
                    if !params.capability_id.is_empty() && !params.logical_executable.is_empty() =>
                {
                    params
                }
                Ok(_) | Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            let operation_id = ProcessManager::next_operation_id();
            let context = AuditContext {
                request_id: request.id.clone(),
                operation_id: operation_id.clone(),
                capability_id: Some(params.capability_id.clone()),
                action: AuditAction::ProcessRun,
            };
            if audit
                .decision(
                    &context,
                    AuditDecision::Allow,
                    AuditReason::RequestValidated,
                )
                .is_err()
            {
                return error_response(Some(request.id), -32010, "AUDIT_UNAVAILABLE");
            }

            let Some(policy) = policy_mirror.ready_policy(&params.capability_id) else {
                return audited_failure(
                    &audit,
                    &context,
                    request.id,
                    -32040,
                    "PROCESS_POLICY_DENIED",
                );
            };
            let root_fd = match workspace_registry.lock() {
                Ok(registry) => match registry.duplicate_ready_root_fd(&params.capability_id) {
                    Ok(root_fd) => root_fd,
                    Err(error) => {
                        let (code, message) = workspace_registry_error_contract(&error);
                        return audited_failure(&audit, &context, request.id, code, message);
                    }
                },
                Err(_) => {
                    return audited_failure(
                        &audit,
                        &context,
                        request.id,
                        -32026,
                        "WORKSPACE_REGISTRY_UNAVAILABLE",
                    );
                }
            };
            let Some(manager) = process_manager else {
                return audited_failure(
                    &audit,
                    &context,
                    request.id,
                    -32046,
                    "PROCESS_UNAVAILABLE",
                );
            };
            let worker_context = context.clone();
  let result = tokio::task::spawn_blocking(move || {
      manager.run(operation_id, root_fd, policy, params, worker_context)
  })
  .await;
            match result {
                Ok(Ok(status)) => {
                    if !audit.is_healthy() {
                        error_response(Some(request.id), -32010, "AUDIT_UNAVAILABLE")
                    } else {
                        success_response(request.id, json!(status))
                    }
                }
                Ok(Err(error)) => {
                    let (code, message) = process_error_contract(&error);
                    audited_failure(&audit, &context, request.id, code, message)
                }
                Err(_) => audited_failure(
                    &audit,
                    &context,
                    request.id,
                    -32045,
                    "PROCESS_EXECUTION_FAILED",
                ),
            }
        }
        "process.status" | "process.cancel" => {
            let params = match serde_json::from_value::<ProcessOperationParams>(request.params) {
                Ok(params)
                    if !params.capability_id.is_empty()
                        && valid_operation_id(&params.operation_id) =>
                {
                    params
                }
                Ok(_) | Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            let action = if request.method == "process.status" {
                AuditAction::ProcessStatus
            } else {
                AuditAction::ProcessCancel
            };
            let context = AuditContext {
                request_id: request.id.clone(),
                operation_id: params.operation_id.clone(),
                capability_id: Some(params.capability_id.clone()),
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
                return error_response(Some(request.id), -32010, "AUDIT_UNAVAILABLE");
            }
            let Some(manager) = process_manager else {
                return audited_failure(
                    &audit,
                    &context,
                    request.id,
                    -32046,
                    "PROCESS_UNAVAILABLE",
                );
            };
            let method = request.method;
            let capability_id = params.capability_id;
            let operation_id = params.operation_id;
            let result = tokio::task::spawn_blocking(move || {
                if method == "process.status" {
                    manager.status(&capability_id, &operation_id)
                } else {
                    manager.cancel(&capability_id, &operation_id)
                }
            })
            .await;
            match result {
                Ok(Ok(status)) => {
                    if audit.outcome(&context, AuditOutcome::Success).is_err() {
                        error_response(Some(request.id), -32010, "AUDIT_UNAVAILABLE")
                    } else {
                        success_response(request.id, json!(status))
                    }
                }
                Ok(Err(error)) => {
                    let (code, message) = process_error_contract(&error);
                    audited_failure(&audit, &context, request.id, code, message)
                }
                Err(_) => audited_failure(
                    &audit,
                    &context,
                    request.id,
                    -32045,
                    "PROCESS_EXECUTION_FAILED",
                ),
            }
        }
        _ => error_response(Some(request.id), -32601, "METHOD_NOT_FOUND"),
    }
}

async fn dispatch_workspace_cancel_executions(
    value: Value,
    audit: Arc<AuditSink>,
    workspace_registry: Arc<Mutex<WorkspaceRegistry<RuntimePolicy>>>,
    process_manager: Option<Arc<ProcessManager>>,
) -> Value {
    let request = match parse_request(value) {
        Ok(request) => request,
        Err(response) => return response,
    };
    let params = match serde_json::from_value::<WorkspaceCapabilityParams>(request.params) {
        Ok(params) if !params.capability_id.is_empty() => params,
        Ok(_) | Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
    };
    let operation_suffix = request.id.strip_prefix("req_").unwrap_or("redacted");
    let context = AuditContext {
        request_id: request.id.clone(),
        operation_id: format!("op_{operation_suffix}"),
        capability_id: Some(params.capability_id.clone()),
        action: AuditAction::WorkspaceCancelExecutions,
    };
    if audit
        .decision(
            &context,
            AuditDecision::Allow,
            AuditReason::RequestValidated,
        )
        .is_err()
    {
        return error_response(Some(request.id), -32010, "AUDIT_UNAVAILABLE");
    }

    let validation = match workspace_registry.lock() {
        Ok(mut registry) => registry.cancel_executions(&params.capability_id),
        Err(_) => {
            return audited_failure(
                &audit,
                &context,
                request.id,
                -32026,
                "WORKSPACE_REGISTRY_UNAVAILABLE",
            );
        }
    };
    if let Err(error) = validation {
        let (code, message) = workspace_registry_error_contract(&error);
        return audited_failure(&audit, &context, request.id, code, message);
    }
    let Some(manager) = process_manager else {
        return audited_failure(
            &audit,
            &context,
            request.id,
            -32046,
            "PROCESS_UNAVAILABLE",
        );
    };
    let capability_id = params.capability_id;
    let result = tokio::task::spawn_blocking(move || manager.cancel_workspace(&capability_id)).await;
    match result {
        Ok(Ok(())) => {
            if audit.outcome(&context, AuditOutcome::Success).is_err() {
                error_response(Some(request.id), -32010, "AUDIT_UNAVAILABLE")
            } else {
                success_response(request.id, json!({ "ok": true }))
            }
        }
        Ok(Err(error)) => {
            let (code, message) = process_error_contract(&error);
            audited_failure(&audit, &context, request.id, code, message)
        }
        Err(_) => audited_failure(
            &audit,
            &context,
            request.id,
            -32044,
            "PROCESS_CANCELLATION_FAILED",
        ),
    }
}

fn capability_param(value: &Value) -> Option<String> {
    value
        .get("params")?
        .get("capabilityId")?
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn request_params<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, serde_json::Error> {
    serde_json::from_value(value.get("params").cloned().unwrap_or(Value::Null))
}

fn response_succeeded(response: &Value) -> bool {
    response.get("result").is_some() && response.get("error").is_none()
}

fn valid_operation_id(value: &str) -> bool {
    value.len() <= 96
        && value.starts_with("op_")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn process_error_contract(error: &ProcessError) -> (i64, &'static str) {
    match error {
        ProcessError::PolicyDenied
        | ProcessError::ExecutableDenied
        | ProcessError::EnvironmentDenied
        | ProcessError::ReservedEnvironment
        | ProcessError::InvalidCwd => (-32040, "PROCESS_POLICY_DENIED"),
        ProcessError::Sandbox(_) => (-32041, "PROCESS_SANDBOX_UNAVAILABLE"),
        ProcessError::Spool(_) => (-32042, "PROCESS_SPOOL_FAILED"),
        ProcessError::OperationNotFound | ProcessError::OperationScopeMismatch => {
            (-32043, "PROCESS_OPERATION_NOT_FOUND")
        }
        ProcessError::CancellationFailed | ProcessError::CancellationTimeout => {
            (-32044, "PROCESS_CANCELLATION_FAILED")
        }
        ProcessError::CaptureFailed | ProcessError::WaitFailed(_) => {
            (-32045, "PROCESS_EXECUTION_FAILED")
        }
        ProcessError::RegistryUnavailable => (-32046, "PROCESS_UNAVAILABLE"),
    }
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
