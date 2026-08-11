use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use kodegpt_protocol::{
    ArtifactReadParams, FileCommitPatchParams, FileEditParams, FileIdentityParams, FileReadParams,
    FileSearchParams, FileTreeParams, FileWriteParams, GitDiffParams, GitStatusParams,
    PersistentFilesystemIdentity as ProtocolFilesystemIdentity, ProcessInspectExecutableParams,
    ProcessOperationParams, ProcessRunParams, ProfileName, RuntimePolicy, VerifyRunParams,
    WorkspaceActivateParams, WorkspaceCapabilityParams, WorkspaceRegisterParams,
    WorkspaceRestrictPolicyParams,
};
use kodegpt_sandbox::{BubblewrapProvider, resolve_trusted_executable};
use kodegpt_workspace_io::{
    FilesystemIdentity, PatchFileAction, SEARCH_MAX_MATCHES, TREE_MAX_ENTRIES, WorkspaceRegistry,
    WorkspaceRegistryError, inspect_root, probe_filesystem_boundary,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::task::JoinSet;

use crate::audit::{
    AuditAction, AuditContext, AuditDecision, AuditOutcome, AuditReason, AuditSink,
};
use crate::execution::ExecutionRegistry;
use crate::git::{
    GitInspectionError, GitOperation, run_git_checkpoint, run_git_checkpoint_patch,
    run_git_inspection,
};
use crate::process::{
    ProcessError, ProcessLaunchRequest, ProcessOperationRegistry, next_process_operation_id,
    run_process,
};
use crate::rpc::{error_response, parse_request, success_response};
use crate::spool::{RawSpoolError, RawSpoolStore};

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
    let process_operations = Arc::new(ProcessOperationRegistry::default());
    let raw_spool = RawSpoolStore::open(audit.state_root(), Arc::clone(&audit))
        .ok()
        .map(Arc::new);

    while let Some(value) = requests.recv().await {
        let response_tx = responses.clone();
        let audit = Arc::clone(&audit);
        let workspace_registry = Arc::clone(&workspace_registry);
        let execution_registry = Arc::clone(&execution_registry);
        let process_operations = Arc::clone(&process_operations);
        let raw_spool = raw_spool.as_ref().map(Arc::clone);
        tasks.spawn(async move {
            let response = dispatch_one(
                value,
                test_methods_enabled,
                audit,
                workspace_registry,
                execution_registry,
                process_operations,
                raw_spool,
                filesystem_boundary_available,
            )
            .await;
            let _ = response_tx.send(response);
        });
    }

    while tasks.join_next().await.is_some() {}
}

async fn dispatch_one(
    value: Value,
    test_methods_enabled: bool,
    audit: Arc<AuditSink>,
    workspace_registry: Arc<Mutex<WorkspaceRegistry<RuntimePolicy>>>,
    execution_registry: Arc<Mutex<ExecutionRegistry>>,
    process_operations: Arc<ProcessOperationRegistry>,
    raw_spool: Option<Arc<RawSpoolStore>>,
    filesystem_boundary_available: bool,
) -> Value {
    let request = match parse_request(value) {
        Ok(request) => request,
        Err(response) => return response,
    };

    match request.method.as_str() {
        "runtime.hello" => {
            if request
                .params
                .as_object()
                .is_none_or(|params| !params.is_empty())
            {
                return error_response(Some(request.id), -32602, "INVALID_PARAMS");
            }

            success_response(
                request.id,
                json!({
                    "runtimeVersion": "0.1",
                    "testMethods": cfg!(feature = "runtime-test-methods") && test_methods_enabled,
                    "auditHealthy": audit.is_healthy(),
                    "filesystemBoundaryAvailable": filesystem_boundary_available
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
        "workspace.register" => {
            let params = match serde_json::from_value::<WorkspaceRegisterParams>(request.params) {
                Ok(params) => params,
                Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            let root_path = PathBuf::from(params.root_path);
            let expected_identity = filesystem_identity_from_protocol(params.expected_identity);
            let ceiling = params.ceiling;
            audited_workspace_operation(
                &audit,
                &workspace_registry,
                request.id,
                None,
                AuditAction::WorkspaceRegister,
                move |registry| {
                    if !filesystem_boundary_available {
                        return Err(WorkspaceRegistryError::FilesystemBoundaryUnavailable);
                    }
                    let registration =
                        registry.register(&root_path, &expected_identity, ceiling)?;
                    Ok(json!({ "capabilityId": registration.capability_id }))
                },
            )
        }
        "workspace.read_project_profile" => {
            let params = match serde_json::from_value::<WorkspaceCapabilityParams>(request.params) {
                Ok(params) => params,
                Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            let capability_id = params.capability_id;
            let audit_capability_id = capability_id.clone();
            audited_workspace_operation(
                &audit,
                &workspace_registry,
                request.id,
                Some(audit_capability_id),
                AuditAction::WorkspaceReadProjectProfile,
                move |registry| {
                    let contents = registry.read_project_profile(&capability_id)?;
                    Ok(json!({ "contents": contents }))
                },
            )
        }
        "workspace.restrict_policy" => {
            let params =
                match serde_json::from_value::<WorkspaceRestrictPolicyParams>(request.params) {
                    Ok(params) => params,
                    Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
                };
            let capability_id = params.capability_id;
            let audit_capability_id = capability_id.clone();
            let restriction = params.restriction;
            audited_workspace_operation(
                &audit,
                &workspace_registry,
                request.id,
                Some(audit_capability_id),
                AuditAction::WorkspaceRestrictPolicy,
                move |registry| {
                    registry.restrict_policy_with(
                        &capability_id,
                        restriction,
                        kodegpt_policy::restrict_policy,
                    )?;
                    Ok(json!({ "ok": true }))
                },
            )
        }
        "workspace.activate" => {
            let params = match serde_json::from_value::<WorkspaceActivateParams>(request.params) {
                Ok(params) => params,
                Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            let capability_id = params.capability_id;
            let audit_capability_id = capability_id.clone();
            audited_workspace_operation(
                &audit,
                &workspace_registry,
                request.id,
                Some(audit_capability_id),
                AuditAction::WorkspaceActivate,
                move |registry| {
                    registry.activate(&capability_id)?;
                    Ok(json!({ "ok": true }))
                },
            )
        }
        "workspace.begin_close" => {
            let params = match serde_json::from_value::<WorkspaceCapabilityParams>(request.params) {
                Ok(params) => params,
                Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            let capability_id = params.capability_id;
            let audit_capability_id = capability_id.clone();
            audited_workspace_operation(
                &audit,
                &workspace_registry,
                request.id,
                Some(audit_capability_id),
                AuditAction::WorkspaceBeginClose,
                move |registry| {
                    registry.begin_close(&capability_id)?;
                    Ok(json!({ "ok": true }))
                },
            )
        }
        "workspace.cancel_executions" => {
            let params = match serde_json::from_value::<WorkspaceCapabilityParams>(request.params) {
                Ok(params) => params,
                Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            dispatch_workspace_cancel_executions(
                &audit,
                &workspace_registry,
                &process_operations,
                request.id,
                params.capability_id,
            )
            .await
        }
        "workspace.unregister" => {
            let params = match serde_json::from_value::<WorkspaceCapabilityParams>(request.params) {
                Ok(params) => params,
                Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            let capability_id = params.capability_id;
            let audit_capability_id = capability_id.clone();
            audited_workspace_operation(
                &audit,
                &workspace_registry,
                request.id,
                Some(audit_capability_id),
                AuditAction::WorkspaceUnregister,
                move |registry| {
                    registry.unregister(&capability_id)?;
                    Ok(json!({ "ok": true }))
                },
            )
        }
        "file.read" => {
            let params = match serde_json::from_value::<FileReadParams>(request.params) {
                Ok(params) => params,
                Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            let capability_id = params.capability_id;
            let audit_capability_id = capability_id.clone();
            let path = PathBuf::from(params.path);
            audited_workspace_operation(
                &audit,
                &workspace_registry,
                request.id,
                Some(audit_capability_id),
                AuditAction::FileRead,
                move |registry| {
                    let result = registry.read_file(
                        &capability_id,
                        &path,
                        params.offset,
                        params.max_bytes,
                    )?;
                    Ok(json!(result))
                },
            )
        }
        "file.tree" => {
            let params = match serde_json::from_value::<FileTreeParams>(request.params) {
                Ok(params) if params.max_entries > 0 && params.max_entries <= TREE_MAX_ENTRIES => {
                    params
                }
                Ok(_) | Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
            };
            let max_entries = params.max_entries;
            let capability_id = params.capability_id;
            let audit_capability_id = capability_id.clone();
            let path = PathBuf::from(params.path);
            audited_workspace_operation(
                &audit,
                &workspace_registry,
                request.id,
                Some(audit_capability_id),
                AuditAction::FileTree,
                move |registry| {
                    let result = registry.tree(&capability_id, &path, max_entries)?;
                    Ok(json!(result))
                },
            )
        }
        "file.search" => {
            let params = match serde_json::from_value::<FileSearchParams>(request.params) {
                Ok(params)
                    if !params.query.is_empty()
                        && params.max_matches > 0
                        && params.max_matches <= SEARCH_MAX_MATCHES =>
                {
                    params
                }
                Ok(_) | Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
            };
            let capability_id = params.capability_id;
            let audit_capability_id = capability_id.clone();
            let path = PathBuf::from(params.path);
            let query = params.query;
            let max_matches = params.max_matches;
            audited_workspace_operation(
                &audit,
                &workspace_registry,
                request.id,
                Some(audit_capability_id),
                AuditAction::FileSearch,
                move |registry| {
                    let result = registry.search(&capability_id, &path, &query, max_matches)?;
                    Ok(json!(result))
                },
            )
        }
        "file.identity" => {
            let params = match serde_json::from_value::<FileIdentityParams>(request.params) {
                Ok(params) if !params.capability_id.is_empty() && !params.path.is_empty() => params,
                Ok(_) | Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
            };
            let capability_id = params.capability_id;
            let audit_capability_id = capability_id.clone();
            let path = PathBuf::from(params.path);
            let include_sha256 = params.include_sha256;
            audited_workspace_operation(
                &audit,
                &workspace_registry,
                request.id,
                Some(audit_capability_id),
                AuditAction::FileIdentity,
                move |registry| {
                    let result = registry.path_identity(&capability_id, &path, include_sha256)?;
                    Ok(json!(result))
                },
            )
        }
        "file.write" => {
            let params = match serde_json::from_value::<FileWriteParams>(request.params) {
                Ok(params) if !params.path.is_empty() => params,
                Ok(_) | Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
            };
            let capability_id = params.capability_id;
            let audit_capability_id = capability_id.clone();
            let path = PathBuf::from(params.path);
            let content = params.content;
            audited_workspace_operation(
                &audit,
                &workspace_registry,
                request.id,
                Some(audit_capability_id),
                AuditAction::FileWrite,
                move |registry| {
                    let result = registry.write_file_with_policy(
                        &capability_id,
                        &path,
                        content.as_bytes(),
                        mutation_allowed,
                    )?;
                    Ok(json!(result))
                },
            )
        }
        "file.edit" => {
            let params = match serde_json::from_value::<FileEditParams>(request.params) {
                Ok(params) if !params.path.is_empty() && !params.old_text.is_empty() => params,
                Ok(_) | Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
            };
            let capability_id = params.capability_id;
            let audit_capability_id = capability_id.clone();
            let path = PathBuf::from(params.path);
            let old_text = params.old_text;
            let new_text = params.new_text;
            let expected_replacements = params.expected_replacements;
            audited_workspace_operation(
                &audit,
                &workspace_registry,
                request.id,
                Some(audit_capability_id),
                AuditAction::FileEdit,
                move |registry| {
                    let result = registry.edit_file_with_policy(
                        &capability_id,
                        &path,
                        &old_text,
                        &new_text,
                        expected_replacements,
                        mutation_allowed,
                    )?;
                    Ok(json!(result))
                },
            )
        }
        "file.commit_patch_file" => {
            let parsed = match serde_json::from_value::<FileCommitPatchParams>(request.params) {
                Ok(params) => params,
                Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            let (capability_id, path, action, expected_sha256, content) = match parsed {
                FileCommitPatchParams::Create {
                    capability_id,
                    path,
                    expected_sha256: (),
                    content,
                } if !capability_id.is_empty() && !path.is_empty() => (
                    capability_id,
                    PathBuf::from(path),
                    PatchFileAction::Create,
                    None,
                    Some(content),
                ),
                FileCommitPatchParams::Update {
                    capability_id,
                    path,
                    expected_sha256,
                    content,
                } if !capability_id.is_empty()
                    && !path.is_empty()
                    && valid_sha256_hex(&expected_sha256) =>
                {
                    (
                        capability_id,
                        PathBuf::from(path),
                        PatchFileAction::Update,
                        Some(expected_sha256),
                        Some(content),
                    )
                }
                FileCommitPatchParams::Delete {
                    capability_id,
                    path,
                    expected_sha256,
                    content: (),
                } if !capability_id.is_empty()
                    && !path.is_empty()
                    && valid_sha256_hex(&expected_sha256) =>
                {
                    (
                        capability_id,
                        PathBuf::from(path),
                        PatchFileAction::Delete,
                        Some(expected_sha256),
                        None,
                    )
                }
                _ => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            let audit_capability_id = capability_id.clone();
            audited_workspace_operation(
                &audit,
                &workspace_registry,
                request.id,
                Some(audit_capability_id),
                AuditAction::FileCommitPatchFile,
                move |registry| {
                    let result = registry.commit_patch_file_with_policy(
                        &capability_id,
                        &path,
                        action,
                        expected_sha256.as_deref(),
                        content.as_deref().map(str::as_bytes),
                        mutation_allowed,
                    )?;
                    Ok(json!(result))
                },
            )
        }
        "git.status" => {
            let params = match serde_json::from_value::<GitStatusParams>(request.params) {
                Ok(params) if !params.capability_id.is_empty() => params,
                Ok(_) | Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
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
        "git.checkpoint" => {
            let params = match serde_json::from_value::<GitStatusParams>(request.params) {
                Ok(params) if !params.capability_id.is_empty() => params,
                Ok(_) | Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
            };
            dispatch_git_checkpoint(
                &audit,
                &workspace_registry,
                &execution_registry,
                raw_spool,
                request.id,
                params.capability_id,
                false,
                AuditAction::GitCheckpoint,
            )
            .await
        }
        "git.checkpoint_patch" => {
            let params = match serde_json::from_value::<GitStatusParams>(request.params) {
                Ok(params) if !params.capability_id.is_empty() => params,
                Ok(_) | Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
            };
            dispatch_git_checkpoint(
                &audit,
                &workspace_registry,
                &execution_registry,
                raw_spool,
                request.id,
                params.capability_id,
                true,
                AuditAction::GitCheckpointPatch,
            )
            .await
        }
        "git.diff" => {
            let params = match serde_json::from_value::<GitDiffParams>(request.params) {
                Ok(params) if !params.capability_id.is_empty() => params,
                Ok(_) | Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
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
        "process.inspect_executable" => {
            let params =
                match serde_json::from_value::<ProcessInspectExecutableParams>(request.params) {
                    Ok(params)
                        if !params.capability_id.is_empty()
                            && valid_logical_executable_name(&params.logical_executable) =>
                    {
                        params
                    }
                    Ok(_) | Err(_) => {
                        return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                    }
                };
            dispatch_process_inspect_executable(&audit, &workspace_registry, request.id, params)
                .await
        }
        "process.run" => {
            let params = match serde_json::from_value::<ProcessRunParams>(request.params) {
                Ok(params)
                    if !params.capability_id.is_empty()
                        && !params.logical_executable.is_empty()
                        && !params.argv.iter().any(|arg| arg.contains('\0')) =>
                {
                    params
                }
                Ok(_) | Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
            };
            dispatch_process_run(
                &audit,
                &workspace_registry,
                &execution_registry,
                &process_operations,
                raw_spool,
                request.id,
                params,
            )
            .await
        }
        "verify.run" => {
            let params = match serde_json::from_value::<VerifyRunParams>(request.params) {
                Ok(params)
                    if !params.capability_id.is_empty()
                        && !params.recipe_id.is_empty()
                        && valid_logical_executable_name(&params.logical_executable)
                        && !params.argv.iter().any(|arg| arg.contains('\0')) =>
                {
                    params
                }
                Ok(_) | Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
            };
            dispatch_verify_run(
                &audit,
                &workspace_registry,
                &execution_registry,
                &process_operations,
                raw_spool,
                request.id,
                params,
            )
            .await
        }
        "process.status" => {
            let params = match serde_json::from_value::<ProcessOperationParams>(request.params) {
                Ok(params)
                    if !params.capability_id.is_empty()
                        && params.operation_id.starts_with("op_") =>
                {
                    params
                }
                Ok(_) | Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
            };
            dispatch_process_operation(
                &audit,
                &workspace_registry,
                &process_operations,
                request.id,
                params,
                AuditAction::ProcessStatus,
                false,
            )
            .await
        }
        "process.cancel" => {
            let params = match serde_json::from_value::<ProcessOperationParams>(request.params) {
                Ok(params)
                    if !params.capability_id.is_empty()
                        && params.operation_id.starts_with("op_") =>
                {
                    params
                }
                Ok(_) | Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
            };
            dispatch_process_operation(
                &audit,
                &workspace_registry,
                &process_operations,
                request.id,
                params,
                AuditAction::ProcessCancel,
                true,
            )
            .await
        }
        "artifact.read" => {
            let params = match serde_json::from_value::<ArtifactReadParams>(request.params) {
                Ok(params)
                    if params.artifact_id.starts_with("ka_")
                        && params.max_bytes > 0
                        && params.max_bytes <= 1024 * 1024 =>
                {
                    params
                }
                Ok(_) | Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
            };
            dispatch_artifact_read(raw_spool, request.id, params).await
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
            if marker_path.parent() != Some(audit.state_root()) || marker_path.file_name().is_none()
            {
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

fn filesystem_identity_from_protocol(identity: ProtocolFilesystemIdentity) -> FilesystemIdentity {
    FilesystemIdentity {
        device_major: identity.device_major,
        device_minor: identity.device_minor,
        inode: identity.inode,
    }
}

fn audited_workspace_operation<F>(
    audit: &AuditSink,
    registry: &Arc<Mutex<WorkspaceRegistry<RuntimePolicy>>>,
    request_id: String,
    capability_id: Option<String>,
    action: AuditAction,
    operation: F,
) -> Value
where
    F: FnOnce(&mut WorkspaceRegistry<RuntimePolicy>) -> Result<Value, WorkspaceRegistryError>,
{
    let operation_suffix = request_id.strip_prefix("req_").unwrap_or("redacted");
    let context = AuditContext {
        request_id: request_id.clone(),
        operation_id: format!("op_{operation_suffix}"),
        capability_id,
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

    let result = match registry.lock() {
        Ok(mut registry) => operation(&mut registry),
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

    match result {
        Ok(result) => {
            if audit.outcome(&context, AuditOutcome::Success).is_err() {
                return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
            }
            success_response(request_id, result)
        }
        Err(error) => {
            let (code, message) = workspace_registry_error_contract(&error);
            audited_failure(audit, &context, request_id, code, message)
        }
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
            return audited_failure(audit, &context, request_id, -32039, "GIT_INSPECTION_FAILED");
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

async fn dispatch_git_checkpoint(
    audit: &Arc<AuditSink>,
    registry: &Arc<Mutex<WorkspaceRegistry<RuntimePolicy>>>,
    executions: &Arc<Mutex<ExecutionRegistry>>,
    raw_spool: Option<Arc<RawSpoolStore>>,
    request_id: String,
    capability_id: String,
    patch: bool,
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
        if patch {
            run_git_checkpoint_patch(
                &root_fd,
                &capability_for_run,
                &request_for_run,
                &operation_for_run,
                &raw_spool,
                &executions,
            )
            .map(|result| json!(result))
        } else {
            run_git_checkpoint(
                &root_fd,
                &capability_for_run,
                &request_for_run,
                &operation_for_run,
                &raw_spool,
                &executions,
            )
            .map(|result| json!(result))
        }
    })
    .await;

    let result = match result {
        Ok(Ok(result)) => result,
        Ok(Err(GitInspectionError::InvalidCheckpointStatus)) if !patch => {
            return audited_failure(audit, &context, request_id, -32049, "GIT_STATUS_INVALID");
        }
        Ok(Err(_)) | Err(_) => {
            return audited_failure(audit, &context, request_id, -32039, "GIT_INSPECTION_FAILED");
        }
    };
    if audit.outcome(&context, AuditOutcome::Success).is_err() {
        return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
    }
    success_response(request_id, result)
}

async fn dispatch_workspace_cancel_executions(
    audit: &Arc<AuditSink>,
    registry: &Arc<Mutex<WorkspaceRegistry<RuntimePolicy>>>,
    operations: &Arc<ProcessOperationRegistry>,
    request_id: String,
    capability_id: String,
) -> Value {
    let operation_suffix = request_id.strip_prefix("req_").unwrap_or("redacted");
    let context = AuditContext {
        request_id: request_id.clone(),
        operation_id: format!("op_{operation_suffix}"),
        capability_id: Some(capability_id.clone()),
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
        return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
    }

    let registry_result = match registry.lock() {
        Ok(mut registry) => registry.cancel_executions(&capability_id),
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
    if let Err(error) = registry_result {
        let (code, message) = workspace_registry_error_contract(&error);
        return audited_failure(audit, &context, request_id, code, message);
    }

    let operations = Arc::clone(operations);
    let capability_for_cancel = capability_id.clone();
    let cancelled =
        tokio::task::spawn_blocking(move || operations.cancel_workspace(&capability_for_cancel))
            .await;
    match cancelled {
        Ok(Ok(())) => {
            if audit.outcome(&context, AuditOutcome::Success).is_err() {
                return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
            }
            success_response(request_id, json!({ "ok": true }))
        }
        Ok(Err(error)) => {
            let (code, message) = process_error_contract(&error);
            audited_failure(audit, &context, request_id, code, message)
        }
        Err(_) => audited_failure(
            audit,
            &context,
            request_id,
            -32045,
            "PROCESS_REGISTRY_UNAVAILABLE",
        ),
    }
}

fn valid_logical_executable_name(name: &str) -> bool {
    !name.is_empty()
        && !matches!(name, "." | "..")
        && !name.contains('/')
        && !name.contains('\0')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

async fn dispatch_process_inspect_executable(
    audit: &Arc<AuditSink>,
    registry: &Arc<Mutex<WorkspaceRegistry<RuntimePolicy>>>,
    request_id: String,
    params: ProcessInspectExecutableParams,
) -> Value {
    let capability_id = params.capability_id.clone();
    let registry_ready = match registry.lock() {
        Ok(registry) => registry.clone_ready_policy(&capability_id),
        Err(_) => {
            return error_response(Some(request_id), -32026, "WORKSPACE_REGISTRY_UNAVAILABLE");
        }
    };
    if let Err(error) = registry_ready {
        let (code, message) = workspace_registry_error_contract(&error);
        return error_response(Some(request_id), code, message);
    }

    let operation_suffix = request_id.strip_prefix("req_").unwrap_or("redacted");
    let context = AuditContext {
        request_id: request_id.clone(),
        operation_id: format!("op_{operation_suffix}"),
        capability_id: Some(capability_id),
        action: AuditAction::ProcessInspectExecutable,
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

    let executable_available = resolve_trusted_executable(&params.logical_executable).is_ok();
    let sandbox_available = BubblewrapProvider::discover().is_ok();
    if audit.outcome(&context, AuditOutcome::Success).is_err() {
        return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
    }
    success_response(
        request_id,
        json!({
            "schemaVersion": 1,
            "executableAvailable": executable_available,
            "sandboxAvailable": sandbox_available
        }),
    )
}

async fn dispatch_verify_run(
    audit: &Arc<AuditSink>,
    registry: &Arc<Mutex<WorkspaceRegistry<RuntimePolicy>>>,
    executions: &Arc<Mutex<ExecutionRegistry>>,
    operations: &Arc<ProcessOperationRegistry>,
    raw_spool: Option<Arc<RawSpoolStore>>,
    request_id: String,
    params: VerifyRunParams,
) -> Value {
    let operation_id = next_process_operation_id();
    let semantic_context = AuditContext {
        request_id: request_id.clone(),
        operation_id: operation_id.clone(),
        capability_id: Some(params.capability_id.clone()),
        action: AuditAction::VerifyRun,
    };
    if audit
        .decision(
            &semantic_context,
            AuditDecision::Allow,
            AuditReason::RequestValidated,
        )
        .is_err()
    {
        return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
    }

    let process_params = ProcessRunParams {
        capability_id: params.capability_id,
        logical_executable: params.logical_executable,
        argv: params.argv,
        cwd: params.cwd,
        env: Default::default(),
        background: params.background,
    };
    let response = dispatch_process_run_with_operation_id(
        audit,
        registry,
        executions,
        operations,
        raw_spool,
        request_id.clone(),
        process_params,
        operation_id,
    )
    .await;
    let semantic_outcome = if response.get("result").is_some() {
        AuditOutcome::Success
    } else {
        AuditOutcome::Failed
    };
    if audit.outcome(&semantic_context, semantic_outcome).is_err() {
        return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
    }
    response
}

async fn dispatch_process_run(
    audit: &Arc<AuditSink>,
    registry: &Arc<Mutex<WorkspaceRegistry<RuntimePolicy>>>,
    executions: &Arc<Mutex<ExecutionRegistry>>,
    operations: &Arc<ProcessOperationRegistry>,
    raw_spool: Option<Arc<RawSpoolStore>>,
    request_id: String,
    params: ProcessRunParams,
) -> Value {
    let operation_id = next_process_operation_id();
    dispatch_process_run_with_operation_id(
        audit,
        registry,
        executions,
        operations,
        raw_spool,
        request_id,
        params,
        operation_id,
    )
    .await
}

async fn dispatch_process_run_with_operation_id(
    audit: &Arc<AuditSink>,
    registry: &Arc<Mutex<WorkspaceRegistry<RuntimePolicy>>>,
    executions: &Arc<Mutex<ExecutionRegistry>>,
    operations: &Arc<ProcessOperationRegistry>,
    raw_spool: Option<Arc<RawSpoolStore>>,
    request_id: String,
    params: ProcessRunParams,
    operation_id: String,
) -> Value {
    let capability_id = params.capability_id.clone();
    let context = AuditContext {
        request_id: request_id.clone(),
        operation_id: operation_id.clone(),
        capability_id: Some(capability_id.clone()),
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
        return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
    }

    let (root_fd, policy) = match registry.lock() {
        Ok(registry) => {
            let policy = match registry.clone_ready_policy(&capability_id) {
                Ok(policy) => policy,
                Err(error) => {
                    let (code, message) = workspace_registry_error_contract(&error);
                    return audited_failure(audit, &context, request_id, code, message);
                }
            };
            if !policy.allow_process || policy.name == ProfileName::Observe {
                return audited_failure(
                    audit,
                    &context,
                    request_id,
                    -32040,
                    "PROCESS_POLICY_DENIED",
                );
            }
            let root_fd = match registry.duplicate_ready_root_fd(&capability_id) {
                Ok(root_fd) => root_fd,
                Err(error) => {
                    let (code, message) = workspace_registry_error_contract(&error);
                    return audited_failure(audit, &context, request_id, code, message);
                }
            };
            (root_fd, policy)
        }
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
            -32048,
            "PROCESS_EXECUTION_UNAVAILABLE",
        );
    };

    let launch = ProcessLaunchRequest {
        logical_executable: params.logical_executable,
        argv: params.argv,
        cwd: params.cwd,
        env: params.env,
        background: params.background,
    };
    let executions = Arc::clone(executions);
    let operations = Arc::clone(operations);
    let capability_for_run = capability_id.clone();
    let request_for_run = request_id.clone();
    let operation_for_run = operation_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        run_process(
            root_fd,
            capability_for_run,
            request_for_run,
            operation_for_run,
            policy,
            launch,
            raw_spool,
            executions,
            operations,
        )
    })
    .await;

    match result {
        Ok(Ok(view)) => {
            if audit.outcome(&context, AuditOutcome::Success).is_err() {
                return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
            }
            success_response(request_id, json!(view))
        }
        Ok(Err(error)) => {
            let (code, message) = process_error_contract(&error);
            audited_failure(audit, &context, request_id, code, message)
        }
        Err(_) => audited_failure(
            audit,
            &context,
            request_id,
            -32048,
            "PROCESS_EXECUTION_FAILED",
        ),
    }
}

async fn dispatch_process_operation(
    audit: &Arc<AuditSink>,
    registry: &Arc<Mutex<WorkspaceRegistry<RuntimePolicy>>>,
    operations: &Arc<ProcessOperationRegistry>,
    request_id: String,
    params: ProcessOperationParams,
    action: AuditAction,
    cancel: bool,
) -> Value {
    let context = AuditContext {
        request_id: request_id.clone(),
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
        return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
    }

    match registry.lock() {
        Ok(registry) => {
            if let Err(error) = registry.require_ready(&params.capability_id) {
                let (code, message) = workspace_registry_error_contract(&error);
                return audited_failure(audit, &context, request_id, code, message);
            }
        }
        Err(_) => {
            return audited_failure(
                audit,
                &context,
                request_id,
                -32026,
                "WORKSPACE_REGISTRY_UNAVAILABLE",
            );
        }
    }

    let operation_result = if cancel {
        let operations = Arc::clone(operations);
        let capability_id = params.capability_id.clone();
        let operation_id = params.operation_id.clone();
        match tokio::task::spawn_blocking(move || operations.cancel(&capability_id, &operation_id))
            .await
        {
            Ok(result) => result,
            Err(_) => Err(ProcessError::RegistryUnavailable),
        }
    } else {
        operations.status(&params.capability_id, &params.operation_id)
    };

    match operation_result {
        Ok(view) => {
            if audit.outcome(&context, AuditOutcome::Success).is_err() {
                return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
            }
            success_response(request_id, json!(view))
        }
        Err(error) => {
            let (code, message) = process_error_contract(&error);
            audited_failure(audit, &context, request_id, code, message)
        }
    }
}

async fn dispatch_artifact_read(
    spool: Option<Arc<RawSpoolStore>>,
    request_id: String,
    params: ArtifactReadParams,
) -> Value {
    let Some(spool) = spool else {
        return error_response(Some(request_id), -32050, "ARTIFACT_STORE_UNAVAILABLE");
    };
    let operation_id = next_process_operation_id();
    let artifact_id = params.artifact_id;
    let request_for_read = request_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        spool.read(
            &request_for_read,
            &operation_id,
            &artifact_id,
            params.offset,
            params.max_bytes,
        )
    })
    .await;

    match result {
        Ok(Ok(read)) => success_response(request_id, json!(read)),
        Ok(Err(error)) => {
            let (code, message) = artifact_error_contract(&error);
            error_response(Some(request_id), code, message)
        }
        Err(_) => error_response(Some(request_id), -32050, "ARTIFACT_STORE_UNAVAILABLE"),
    }
}

fn artifact_error_contract(error: &RawSpoolError) -> (i64, &'static str) {
    match error {
        RawSpoolError::AuditUnavailable => (-32010, "AUDIT_UNAVAILABLE"),
        RawSpoolError::InvalidArtifactId => (-32051, "ARTIFACT_ID_INVALID"),
        RawSpoolError::ArtifactNotFound => (-32052, "ARTIFACT_NOT_FOUND"),
        RawSpoolError::ArtifactNotRegular => (-32053, "ARTIFACT_UNSAFE"),
        RawSpoolError::ReadLimitExceeded => (-32054, "ARTIFACT_READ_LIMIT_EXCEEDED"),
        RawSpoolError::QuotaExceeded => (-32055, "ARTIFACT_QUOTA_EXCEEDED"),
        RawSpoolError::SynchronizationFailed | RawSpoolError::Io(_) => {
            (-32050, "ARTIFACT_STORE_UNAVAILABLE")
        }
        RawSpoolError::DuplicateExecution
        | RawSpoolError::InvalidExecutionId
        | RawSpoolError::InvalidMediaType => (-32056, "ARTIFACT_STORE_INVALID_STATE"),
    }
}

fn process_error_contract(error: &ProcessError) -> (i64, &'static str) {
    match error {
        ProcessError::PolicyDenied => (-32040, "PROCESS_POLICY_DENIED"),
        ProcessError::ExecutableDenied => (-32041, "PROCESS_EXECUTABLE_DENIED"),
        ProcessError::EnvironmentDenied => (-32042, "PROCESS_ENVIRONMENT_DENIED"),
        ProcessError::InvalidCwd => (-32043, "PROCESS_CWD_INVALID"),
        ProcessError::OperationNotFound => (-32044, "PROCESS_OPERATION_NOT_FOUND"),
        ProcessError::RegistryUnavailable => (-32045, "PROCESS_REGISTRY_UNAVAILABLE"),
        ProcessError::CancellationFailed(_) => (-32046, "PROCESS_CANCEL_FAILED"),
        ProcessError::Sandbox(_) => (-32047, "PROCESS_SANDBOX_UNAVAILABLE"),
        ProcessError::CaptureFailed | ProcessError::Spool(_) | ProcessError::WaitFailed(_) => {
            (-32048, "PROCESS_EXECUTION_FAILED")
        }
    }
}

fn mutation_allowed(policy: &RuntimePolicy) -> bool {
    policy.allow_write && policy.name != ProfileName::Observe
}

fn valid_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn workspace_registry_error_contract(error: &WorkspaceRegistryError) -> (i64, &'static str) {
    match error {
        WorkspaceRegistryError::RootInvalid => (-32020, "WORKSPACE_ROOT_INVALID"),
        WorkspaceRegistryError::IdentityChanged => (-32022, "WORKSPACE_IDENTITY_CHANGED"),
        WorkspaceRegistryError::MountTopologyUnavailable => (-32023, "MOUNT_TOPOLOGY_UNAVAILABLE"),
        WorkspaceRegistryError::RootOverlap => (-32024, "WORKSPACE_ROOT_OVERLAP"),
        WorkspaceRegistryError::PolicyEscalation => (-32027, "WORKSPACE_POLICY_ESCALATION"),
        WorkspaceRegistryError::WorkspaceNotReady => (-32028, "WORKSPACE_NOT_READY"),
        WorkspaceRegistryError::ProjectProfileReadFailed => {
            (-32029, "WORKSPACE_PROFILE_READ_FAILED")
        }
        WorkspaceRegistryError::FilesystemBoundaryUnavailable => {
            (-32030, "FILESYSTEM_BOUNDARY_UNAVAILABLE")
        }
        WorkspaceRegistryError::FileAccessDenied => (-32031, "FILE_ACCESS_DENIED"),
        WorkspaceRegistryError::FileNotFound => (-32032, "FILE_NOT_FOUND"),
        WorkspaceRegistryError::FileInvalidUtf8 => (-32033, "FILE_INVALID_UTF8"),
        WorkspaceRegistryError::FileLimitExceeded => (-32034, "FILE_LIMIT_EXCEEDED"),
        WorkspaceRegistryError::FileReadFailed => (-32035, "FILE_READ_FAILED"),
        WorkspaceRegistryError::FileWriteConflict => (-32036, "FILE_EDIT_CONFLICT"),
        WorkspaceRegistryError::FileWriteFailed => (-32037, "FILE_WRITE_FAILED"),
        WorkspaceRegistryError::PatchPreconditionFailed => (-32038, "PATCH_PRECONDITION_FAILED"),
        WorkspaceRegistryError::PatchTargetExists => (-32039, "PATCH_TARGET_EXISTS"),
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
    #[cfg(feature = "runtime-test-methods")]
    use std::time::Instant;

    use serde_json::{Value, json};
    use tokio::sync::mpsc;

    use super::{run_dispatcher, run_dispatcher_with_boundary_status};
    use crate::audit::{AuditFaults, AuditSink};

    fn audit_sink(label: &str) -> (Arc<AuditSink>, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("kodegpt-dispatcher-{label}-{}", std::process::id()));
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unavailable_filesystem_boundary_is_reported_and_blocks_registration() {
        let (audit, audit_root) = audit_sink("boundary-unavailable");
        let workspace = audit_root.with_extension("boundary-workspace");
        fs::create_dir_all(&workspace).expect("workspace created");
        let identity = kodegpt_workspace_io::inspect_root(&workspace)
            .expect("workspace inspected")
            .identity;
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher_with_boundary_status(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
            false,
        ));

        request_tx
            .send(request("req_boundary_hello", "runtime.hello", json!({})))
            .expect("hello accepted");
        let hello = tokio::time::timeout(Duration::from_secs(1), response_rx.recv())
            .await
            .expect("hello arrives")
            .expect("response channel open");
        assert_eq!(hello["result"]["filesystemBoundaryAvailable"], false);

        request_tx
            .send(request(
                "req_boundary_register",
                "workspace.register",
                json!({
                    "rootPath": workspace.to_string_lossy(),
                    "expectedIdentity": identity,
                    "ceiling": observe_policy()
                }),
            ))
            .expect("registration accepted for dispatch");
        let registration = tokio::time::timeout(Duration::from_secs(1), response_rx.recv())
            .await
            .expect("registration response arrives")
            .expect("response channel open");
        assert_eq!(
            registration["error"]["message"],
            "FILESYSTEM_BOUNDARY_UNAVAILABLE"
        );

        drop(request_tx);
        dispatcher.await.expect("dispatcher joins");
        fs::remove_dir_all(workspace).expect("workspace removed");
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[cfg(feature = "runtime-test-methods")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dispatcher_keeps_runtime_hello_responsive_while_sleep_is_pending() {
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let (audit, audit_root) = audit_sink("concurrency");
        let dispatcher = tokio::spawn(run_dispatcher(request_rx, response_tx, true, audit));

        request_tx
            .send(request(
                "req_sleep",
                "test.sleep",
                json!({ "delayMs": 500 }),
            ))
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
        assert_eq!(
            response["result"]["canonicalRoot"],
            fs::canonicalize(&workspace)
                .unwrap()
                .to_string_lossy()
                .as_ref()
        );
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

    fn observe_policy() -> Value {
        json!({
            "name": "observe",
            "allowWrite": false,
            "allowProcess": false,
            "network": "deny",
            "allowedExecutableNames": [],
            "inheritEnv": false,
            "envAllowlist": []
        })
    }

    fn develop_policy(allow_write: bool) -> Value {
        json!({
            "name": "develop",
            "allowWrite": allow_write,
            "allowProcess": true,
            "network": "deny",
            "allowedExecutableNames": ["node", "python3"],
            "inheritEnv": false,
            "envAllowlist": ["LANG"]
        })
    }

    async fn next_response(
        request_tx: &mpsc::UnboundedSender<Value>,
        response_rx: &mut mpsc::UnboundedReceiver<Value>,
        id: &str,
        method: &str,
        params: Value,
    ) -> Value {
        request_tx
            .send(request(id, method, params))
            .expect("workspace request accepted");
        tokio::time::timeout(Duration::from_secs(1), response_rx.recv())
            .await
            .expect("workspace response arrives")
            .expect("workspace response channel open")
    }

    async fn register_ready_workspace(
        request_tx: &mpsc::UnboundedSender<Value>,
        response_rx: &mut mpsc::UnboundedReceiver<Value>,
        workspace: &std::path::Path,
        policy: Value,
        id_prefix: &str,
    ) -> String {
        let identity = kodegpt_workspace_io::inspect_root(workspace)
            .expect("workspace inspected")
            .identity;
        let registered = next_response(
            request_tx,
            response_rx,
            &format!("req_{id_prefix}_register"),
            "workspace.register",
            json!({
                "rootPath": workspace.to_string_lossy(),
                "expectedIdentity": identity,
                "ceiling": policy.clone()
            }),
        )
        .await;
        let capability_id = registered["result"]["capabilityId"]
            .as_str()
            .expect("registration returns capability id")
            .to_owned();
        let restricted = next_response(
            request_tx,
            response_rx,
            &format!("req_{id_prefix}_restrict"),
            "workspace.restrict_policy",
            json!({ "capabilityId": capability_id, "restriction": policy }),
        )
        .await;
        assert_eq!(restricted["result"]["ok"], true);
        let activated = next_response(
            request_tx,
            response_rx,
            &format!("req_{id_prefix}_activate"),
            "workspace.activate",
            json!({ "capabilityId": capability_id }),
        )
        .await;
        assert_eq!(activated["result"]["ok"], true);
        capability_id
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn process_inspect_executable_reports_availability_without_host_paths() {
        let (audit, audit_root) = audit_sink("process-inspect-executable");
        let workspace = audit_root.with_extension("process-inspect-workspace");
        fs::create_dir_all(&workspace).expect("workspace created");
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
        ));
        let capability_id = register_ready_workspace(
            &request_tx,
            &mut response_rx,
            &workspace,
            develop_policy(false),
            "inspect_executable",
        )
        .await;

        let response = next_response(
            &request_tx,
            &mut response_rx,
            "req_process_inspect_executable",
            "process.inspect_executable",
            json!({
                "capabilityId": capability_id,
                "logicalExecutable": "kodegpt-definitely-missing-executable"
            }),
        )
        .await;
        assert_eq!(response["result"]["schemaVersion"], 1);
        assert_eq!(response["result"]["executableAvailable"], false);
        assert!(response["result"]["sandboxAvailable"].is_boolean());
        let serialized = response["result"].to_string();
        assert!(!serialized.contains("/usr/"));
        assert!(!serialized.contains("/home/"));
        assert!(!serialized.contains("canonicalPath"));

        drop(request_tx);
        dispatcher.await.expect("dispatcher joins");
        let audit_text = fs::read_to_string(audit.path()).expect("audit readable");
        assert!(audit_text.contains("process_inspect_executable"));
        fs::remove_dir_all(workspace).expect("workspace removed");
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn verify_run_wraps_the_existing_process_run_with_semantic_audit_order() {
        let (audit, audit_root) = audit_sink("verify-run-audit");
        let workspace = audit_root.with_extension("verify-run-workspace");
        fs::create_dir_all(&workspace).expect("workspace created");
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
        ));
        let capability_id = register_ready_workspace(
            &request_tx,
            &mut response_rx,
            &workspace,
            develop_policy(false),
            "verify_audit",
        )
        .await;

        let response = next_response(
            &request_tx,
            &mut response_rx,
            "req_verify_audit",
            "verify.run",
            json!({
                "capabilityId": capability_id,
                "recipeId": "package:test",
                "logicalExecutable": "python3",
                "argv": ["-c", "print('VERIFY_AUDIT_SECRET_OUTPUT')"],
                "cwd": ".",
                "background": false
            }),
        )
        .await;
        assert!(
            response.get("result").is_some(),
            "verify.run failed: {response}"
        );
        assert!(response["result"]["operationId"].as_str().is_some());

        drop(request_tx);
        dispatcher.await.expect("dispatcher joins");
        let audit_text = fs::read_to_string(audit.path()).expect("audit readable");
        let relevant = audit_text
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|record| record["requestId"] == "req_verify_audit")
            .filter(|record| record["action"] == "verify_run" || record["action"] == "process_run")
            .map(|record| {
                (
                    record["phase"].as_str().unwrap().to_owned(),
                    record["action"].as_str().unwrap().to_owned(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            relevant,
            vec![
                ("decision".to_owned(), "verify_run".to_owned()),
                ("decision".to_owned(), "process_run".to_owned()),
                ("outcome".to_owned(), "process_run".to_owned()),
                ("outcome".to_owned(), "verify_run".to_owned()),
            ]
        );
        assert!(!audit_text.contains("VERIFY_AUDIT_SECRET_OUTPUT"));
        assert!(!audit_text.contains("print('VERIFY_AUDIT_SECRET_OUTPUT')"));

        fs::remove_dir_all(workspace).expect("workspace removed");
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn verify_run_stops_before_process_dispatch_when_semantic_audit_decision_fails() {
        let (audit, audit_root) = audit_sink("verify-run-audit-fail");
        let workspace = audit_root.with_extension("verify-run-audit-fail-workspace");
        fs::create_dir_all(&workspace).expect("workspace created");
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
        ));
        let capability_id = register_ready_workspace(
            &request_tx,
            &mut response_rx,
            &workspace,
            develop_policy(false),
            "verify_audit_fail",
        )
        .await;
        audit.inject_faults(AuditFaults {
            fail_next_decision: true,
            fail_next_outcome: false,
        });

        let response = next_response(
            &request_tx,
            &mut response_rx,
            "req_verify_audit_fail",
            "verify.run",
            json!({
                "capabilityId": capability_id,
                "recipeId": "package:test",
                "logicalExecutable": "python3",
                "argv": ["-c", "print('must-not-run')"],
                "cwd": ".",
                "background": false
            }),
        )
        .await;
        assert_eq!(response["error"]["message"], "AUDIT_UNAVAILABLE");

        drop(request_tx);
        dispatcher.await.expect("dispatcher joins");
        let audit_text = fs::read_to_string(audit.path()).expect("audit readable");
        let request_records = audit_text
            .lines()
            .filter(|line| line.contains("req_verify_audit_fail"))
            .collect::<Vec<_>>();
        assert!(
            request_records
                .iter()
                .all(|line| !line.contains("process_run"))
        );
        fs::remove_dir_all(workspace).expect("workspace removed");
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn workspace_registration_stops_before_root_inspection_when_audit_decision_fails() {
        let audit_root = std::env::temp_dir().join(format!(
            "kodegpt-dispatcher-workspace-audit-order-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&audit_root);
        let missing_workspace = audit_root.with_extension("missing-workspace");
        let _ = fs::remove_dir_all(&missing_workspace);
        let audit = Arc::new(AuditSink::open_with_faults(
            &audit_root,
            AuditFaults {
                fail_next_decision: true,
                fail_next_outcome: false,
            },
        ));
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
        ));

        let response = next_response(
            &request_tx,
            &mut response_rx,
            "req_workspace_audit_order",
            "workspace.register",
            json!({
                "rootPath": missing_workspace.to_string_lossy(),
                "expectedIdentity": {
                    "deviceMajor": 0,
                    "deviceMinor": 0,
                    "inode": "0"
                },
                "ceiling": observe_policy()
            }),
        )
        .await;

        assert_eq!(response["error"]["message"], "AUDIT_UNAVAILABLE");
        assert!(!audit.is_healthy());
        drop(request_tx);
        dispatcher.await.expect("dispatcher task joins");
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn workspace_project_profile_read_uses_retained_root_fd_after_path_replacement() {
        let (audit, audit_root) = audit_sink("workspace-profile-read");
        let workspace = audit_root.with_extension("profile-workspace");
        let displaced = workspace.with_extension("profile-original");
        fs::create_dir_all(workspace.join(".kodegpt")).expect("profile directory created");
        fs::write(
            workspace.join(".kodegpt/profile.json"),
            r#"{"name":"observe","allowWrite":false}"#,
        )
        .expect("original profile written");
        let identity = kodegpt_workspace_io::inspect_root(&workspace)
            .expect("workspace inspected")
            .identity;
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
        ));

        let registered = next_response(
            &request_tx,
            &mut response_rx,
            "req_workspace_profile_register",
            "workspace.register",
            json!({
                "rootPath": workspace.to_string_lossy(),
                "expectedIdentity": identity,
                "ceiling": observe_policy()
            }),
        )
        .await;
        let capability_id = registered["result"]["capabilityId"]
            .as_str()
            .expect("registration returns capability")
            .to_owned();

        fs::rename(&workspace, &displaced).expect("registered pathname displaced");
        fs::create_dir_all(workspace.join(".kodegpt"))
            .expect("replacement profile directory created");
        fs::write(
            workspace.join(".kodegpt/profile.json"),
            r#"{"name":"trusted","allowWrite":true}"#,
        )
        .expect("replacement profile written");

        let response = next_response(
            &request_tx,
            &mut response_rx,
            "req_workspace_profile_read",
            "workspace.read_project_profile",
            json!({ "capabilityId": capability_id }),
        )
        .await;
        assert_eq!(
            response["result"]["contents"],
            r#"{"name":"observe","allowWrite":false}"#
        );

        let _ = next_response(
            &request_tx,
            &mut response_rx,
            "req_workspace_profile_unregister",
            "workspace.unregister",
            json!({ "capabilityId": capability_id }),
        )
        .await;
        drop(request_tx);
        dispatcher.await.expect("dispatcher task joins");
        let audit_text = fs::read_to_string(audit.path()).expect("audit readable");
        assert!(audit_text.contains("workspace_read_project_profile"));
        fs::remove_dir_all(workspace).expect("replacement removed");
        fs::remove_dir_all(displaced).expect("original removed");
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn file_operations_use_retained_root_fd_and_fail_before_io_when_audit_is_unavailable() {
        let (audit, audit_root) = audit_sink("workspace-file-read");
        let workspace = audit_root.with_extension("file-workspace");
        let displaced = workspace.with_extension("file-original");
        fs::create_dir_all(workspace.join("nested")).expect("workspace tree created");
        fs::write(workspace.join("inside.txt"), "original contents\n")
            .expect("original file written");
        fs::write(
            workspace.join("nested/needle.txt"),
            "alpha\nneedle here\nomega\n",
        )
        .expect("search file written");
        let identity = kodegpt_workspace_io::inspect_root(&workspace)
            .expect("workspace inspected")
            .identity;
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
        ));

        let registered = next_response(
            &request_tx,
            &mut response_rx,
            "req_file_register",
            "workspace.register",
            json!({
                "rootPath": workspace.to_string_lossy(),
                "expectedIdentity": identity,
                "ceiling": observe_policy()
            }),
        )
        .await;
        let capability_id = registered["result"]["capabilityId"]
            .as_str()
            .expect("registration returns capability")
            .to_owned();
        let activated = next_response(
            &request_tx,
            &mut response_rx,
            "req_file_activate",
            "workspace.activate",
            json!({ "capabilityId": capability_id }),
        )
        .await;
        assert_eq!(activated["result"]["ok"], true);

        fs::rename(&workspace, &displaced).expect("registered pathname displaced");
        fs::create_dir_all(workspace.join("nested")).expect("replacement tree created");
        fs::write(workspace.join("inside.txt"), "replacement contents\n")
            .expect("replacement file written");
        fs::write(workspace.join("nested/needle.txt"), "replacement needle\n")
            .expect("replacement search file written");

        let read = next_response(
            &request_tx,
            &mut response_rx,
            "req_file_read",
            "file.read",
            json!({
                "capabilityId": capability_id,
                "path": "inside.txt",
                "offset": 0,
                "maxBytes": 1024
            }),
        )
        .await;
        assert_eq!(read["result"]["contents"], "original contents\n");
        assert_eq!(read["result"]["eof"], true);

        let tree = next_response(
            &request_tx,
            &mut response_rx,
            "req_file_tree",
            "file.tree",
            json!({ "capabilityId": capability_id, "path": ".", "maxEntries": 2_000 }),
        )
        .await;
        let tree_entries = tree["result"]["entries"]
            .as_array()
            .expect("tree returns entries");
        assert_eq!(tree["result"]["truncated"], false);
        assert!(
            tree_entries
                .iter()
                .any(|entry| entry["path"] == "inside.txt")
        );
        assert!(
            tree_entries
                .iter()
                .any(|entry| entry["path"] == "nested/needle.txt")
        );

        let search = next_response(
            &request_tx,
            &mut response_rx,
            "req_file_search",
            "file.search",
            json!({ "capabilityId": capability_id, "path": ".", "query": "needle", "maxMatches": 100 }),
        )
        .await;
        assert_eq!(search["result"]["truncated"], false);
        assert_eq!(search["result"]["truncationReasons"], json!([]));
        let matches = search["result"]["matches"]
            .as_array()
            .expect("search returns matches");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["path"], "nested/needle.txt");
        assert_eq!(matches[0]["line"], 2);
        assert_eq!(matches[0]["lineText"], "needle here");

        let identity = next_response(
            &request_tx,
            &mut response_rx,
            "req_file_identity",
            "file.identity",
            json!({ "capabilityId": capability_id, "path": "inside.txt", "includeSha256": true }),
        )
        .await;
        assert_eq!(identity["result"]["exists"], true);
        assert_eq!(identity["result"]["kind"], "file");
        assert_eq!(identity["result"]["hashTruncated"], false);
        assert_eq!(
            identity["result"]["sha256"]
                .as_str()
                .expect("identity returns sha256")
                .len(),
            64
        );

        let audit_text = fs::read_to_string(audit.path()).expect("audit readable");
        assert!(audit_text.contains("file_read"));
        assert!(audit_text.contains("file_tree"));
        assert!(audit_text.contains("file_search"));
        assert!(audit_text.contains("file_identity"));

        audit.inject_faults(AuditFaults {
            fail_next_decision: true,
            fail_next_outcome: false,
        });
        let blocked = next_response(
            &request_tx,
            &mut response_rx,
            "req_file_audit_blocked",
            "file.read",
            json!({
                "capabilityId": capability_id,
                "path": "../must-not-resolve",
                "offset": 0,
                "maxBytes": 16
            }),
        )
        .await;
        assert_eq!(blocked["error"]["message"], "AUDIT_UNAVAILABLE");

        drop(request_tx);
        dispatcher.await.expect("dispatcher task joins");
        fs::remove_dir_all(workspace).expect("replacement removed");
        fs::remove_dir_all(displaced).expect("original removed");
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn workspace_policy_restriction_cannot_widen_after_narrowing() {
        let (audit, audit_root) = audit_sink("workspace-policy-monotonic");
        let workspace = audit_root.with_extension("policy-workspace");
        fs::create_dir_all(&workspace).expect("workspace created");
        let identity = kodegpt_workspace_io::inspect_root(&workspace)
            .expect("workspace inspected")
            .identity;
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
        ));

        let registered = next_response(
            &request_tx,
            &mut response_rx,
            "req_workspace_policy_register",
            "workspace.register",
            json!({
                "rootPath": workspace.to_string_lossy(),
                "expectedIdentity": identity,
                "ceiling": develop_policy(true)
            }),
        )
        .await;
        let capability_id = registered["result"]["capabilityId"]
            .as_str()
            .expect("registration returns capability")
            .to_owned();

        let narrowed = next_response(
            &request_tx,
            &mut response_rx,
            "req_workspace_policy_narrow",
            "workspace.restrict_policy",
            json!({
                "capabilityId": capability_id,
                "restriction": develop_policy(false)
            }),
        )
        .await;
        assert_eq!(narrowed["result"]["ok"], true);

        let widened = next_response(
            &request_tx,
            &mut response_rx,
            "req_workspace_policy_widen",
            "workspace.restrict_policy",
            json!({
                "capabilityId": capability_id,
                "restriction": develop_policy(true)
            }),
        )
        .await;
        assert_eq!(widened["error"]["message"], "WORKSPACE_POLICY_ESCALATION");

        let _ = next_response(
            &request_tx,
            &mut response_rx,
            "req_workspace_policy_unregister",
            "workspace.unregister",
            json!({ "capabilityId": capability_id }),
        )
        .await;
        drop(request_tx);
        dispatcher.await.expect("dispatcher task joins");
        fs::remove_dir_all(workspace).expect("workspace removed");
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn workspace_registration_rejects_overlap_and_supports_lifecycle_skeletons() {
        let (audit, audit_root) = audit_sink("workspace-lifecycle");
        let workspace = audit_root.with_extension("registered-workspace");
        fs::create_dir_all(&workspace).expect("workspace created");
        let identity = kodegpt_workspace_io::inspect_root(&workspace)
            .expect("workspace inspected")
            .identity;
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
        ));

        let registered = next_response(
            &request_tx,
            &mut response_rx,
            "req_workspace_register",
            "workspace.register",
            json!({
                "rootPath": workspace.to_string_lossy(),
                "expectedIdentity": identity,
                "ceiling": observe_policy()
            }),
        )
        .await;
        assert!(
            registered.get("result").is_some(),
            "registration failed: {registered}"
        );
        let capability_id = registered["result"]["capabilityId"]
            .as_str()
            .expect("registration returns capability id")
            .to_owned();
        assert!(capability_id.starts_with("kc_"));

        let overlap = next_response(
            &request_tx,
            &mut response_rx,
            "req_workspace_overlap",
            "workspace.register",
            json!({
                "rootPath": workspace.to_string_lossy(),
                "expectedIdentity": kodegpt_workspace_io::inspect_root(&workspace).unwrap().identity,
                "ceiling": observe_policy()
            }),
        )
        .await;
        assert_eq!(overlap["error"]["message"], "WORKSPACE_ROOT_OVERLAP");

        for (id, method, params) in [
            (
                "req_workspace_restrict",
                "workspace.restrict_policy",
                json!({ "capabilityId": capability_id, "restriction": observe_policy() }),
            ),
            (
                "req_workspace_activate",
                "workspace.activate",
                json!({ "capabilityId": capability_id }),
            ),
            (
                "req_workspace_begin_close",
                "workspace.begin_close",
                json!({ "capabilityId": capability_id }),
            ),
            (
                "req_workspace_cancel",
                "workspace.cancel_executions",
                json!({ "capabilityId": capability_id }),
            ),
            (
                "req_workspace_unregister",
                "workspace.unregister",
                json!({ "capabilityId": capability_id }),
            ),
        ] {
            let response = next_response(&request_tx, &mut response_rx, id, method, params).await;
            assert_eq!(response["result"]["ok"], true, "{method} must succeed");
        }

        let missing = next_response(
            &request_tx,
            &mut response_rx,
            "req_workspace_missing",
            "workspace.activate",
            json!({ "capabilityId": capability_id }),
        )
        .await;
        assert_eq!(
            missing["error"]["message"],
            "WORKSPACE_CAPABILITY_NOT_FOUND"
        );

        drop(request_tx);
        dispatcher.await.expect("dispatcher task joins");
        let audit_text = fs::read_to_string(audit.path()).expect("audit readable");
        assert!(audit_text.contains("workspace_register"));
        assert!(audit_text.contains("workspace_unregister"));

        fs::remove_dir_all(workspace).expect("workspace removed");
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn file_mutations_enforce_policy_boundaries_self_protection_and_audit_order() {
        use std::os::unix::fs::symlink;

        let (audit, audit_root) = audit_sink("file-mutation-security");
        let observe_workspace = audit_root.with_extension("observe-workspace");
        let denied_workspace = audit_root.with_extension("denied-workspace");
        let writable_workspace = audit_root.with_extension("writable-workspace");
        let other_workspace = audit_root.with_extension("other-workspace");
        for workspace in [
            &observe_workspace,
            &denied_workspace,
            &writable_workspace,
            &other_workspace,
        ] {
            fs::create_dir_all(workspace).expect("workspace created");
        }
        fs::write(writable_workspace.join("edit.txt"), "alpha beta alpha\n")
            .expect("edit fixture written");
        fs::write(other_workspace.join("secret.txt"), "other-secret")
            .expect("other workspace secret written");
        fs::write(audit_root.join("state-secret.txt"), "state-secret")
            .expect("state secret written");
        symlink(&other_workspace, writable_workspace.join("other-link"))
            .expect("other workspace symlink created");
        symlink(&audit_root, writable_workspace.join("state-link")).expect("state symlink created");

        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
        ));

        async fn register_ready(
            request_tx: &mpsc::UnboundedSender<Value>,
            response_rx: &mut mpsc::UnboundedReceiver<Value>,
            workspace: &std::path::Path,
            label: &str,
            policy: Value,
        ) -> String {
            let identity = kodegpt_workspace_io::inspect_root(workspace)
                .expect("workspace inspected")
                .identity;
            let registered = next_response(
                request_tx,
                response_rx,
                &format!("req_mutation_register_{label}"),
                "workspace.register",
                json!({
                    "rootPath": workspace.to_string_lossy(),
                    "expectedIdentity": identity,
                    "ceiling": policy
                }),
            )
            .await;
            let capability_id = registered["result"]["capabilityId"]
                .as_str()
                .expect("registration returns capability")
                .to_owned();
            let activated = next_response(
                request_tx,
                response_rx,
                &format!("req_mutation_activate_{label}"),
                "workspace.activate",
                json!({ "capabilityId": capability_id }),
            )
            .await;
            assert_eq!(activated["result"]["ok"], true);
            capability_id
        }

        let observe_cap = register_ready(
            &request_tx,
            &mut response_rx,
            &observe_workspace,
            "observe",
            json!({
                "name": "observe",
                "allowWrite": true,
                "allowProcess": false,
                "network": "deny",
                "allowedExecutableNames": [],
                "inheritEnv": false,
                "envAllowlist": []
            }),
        )
        .await;
        let denied_cap = register_ready(
            &request_tx,
            &mut response_rx,
            &denied_workspace,
            "denied",
            develop_policy(false),
        )
        .await;
        let writable_cap = register_ready(
            &request_tx,
            &mut response_rx,
            &writable_workspace,
            "writable",
            develop_policy(true),
        )
        .await;
        let _other_cap = register_ready(
            &request_tx,
            &mut response_rx,
            &other_workspace,
            "other",
            develop_policy(true),
        )
        .await;

        for (label, capability_id) in [
            ("observe", &observe_cap),
            ("allow-write-false", &denied_cap),
        ] {
            let denied = next_response(
                &request_tx,
                &mut response_rx,
                &format!("req_mutation_deny_{label}"),
                "file.write",
                json!({
                    "capabilityId": capability_id,
                    "path": "blocked.txt",
                    "content": "must-not-write"
                }),
            )
            .await;
            assert_eq!(denied["error"]["message"], "FILE_ACCESS_DENIED");
        }
        assert!(!observe_workspace.join("blocked.txt").exists());
        assert!(!denied_workspace.join("blocked.txt").exists());

        let created = next_response(
            &request_tx,
            &mut response_rx,
            "req_mutation_write",
            "file.write",
            json!({
                "capabilityId": writable_cap,
                "path": "created.txt",
                "content": "created safely"
            }),
        )
        .await;
        assert_eq!(created["result"]["created"], true);
        assert_eq!(
            fs::read_to_string(writable_workspace.join("created.txt")).unwrap(),
            "created safely"
        );

        for (label, path) in [
            ("traversal", "../escape.txt"),
            ("cross-workspace", "other-link/secret.txt"),
            ("state", "state-link/state-secret.txt"),
        ] {
            let denied = next_response(
                &request_tx,
                &mut response_rx,
                &format!("req_mutation_boundary_{label}"),
                "file.write",
                json!({
                    "capabilityId": writable_cap,
                    "path": path,
                    "content": "overwrite"
                }),
            )
            .await;
            assert_eq!(denied["error"]["message"], "FILE_ACCESS_DENIED");
        }
        assert_eq!(
            fs::read_to_string(other_workspace.join("secret.txt")).unwrap(),
            "other-secret"
        );
        assert_eq!(
            fs::read_to_string(audit_root.join("state-secret.txt")).unwrap(),
            "state-secret"
        );

        let conflict = next_response(
            &request_tx,
            &mut response_rx,
            "req_mutation_edit_conflict",
            "file.edit",
            json!({
                "capabilityId": writable_cap,
                "path": "edit.txt",
                "oldText": "alpha",
                "newText": "omega",
                "expectedReplacements": 1
            }),
        )
        .await;
        assert_eq!(conflict["error"]["message"], "FILE_EDIT_CONFLICT");
        assert_eq!(
            fs::read_to_string(writable_workspace.join("edit.txt")).unwrap(),
            "alpha beta alpha\n"
        );

        let edited = next_response(
            &request_tx,
            &mut response_rx,
            "req_mutation_edit",
            "file.edit",
            json!({
                "capabilityId": writable_cap,
                "path": "edit.txt",
                "oldText": "alpha",
                "newText": "omega",
                "expectedReplacements": 2
            }),
        )
        .await;
        assert_eq!(edited["result"]["replacements"], 2);
        assert_eq!(
            fs::read_to_string(writable_workspace.join("edit.txt")).unwrap(),
            "omega beta omega\n"
        );

        audit.inject_faults(AuditFaults {
            fail_next_decision: true,
            fail_next_outcome: false,
        });
        let audit_blocked = next_response(
            &request_tx,
            &mut response_rx,
            "req_mutation_audit_blocked",
            "file.write",
            json!({
                "capabilityId": writable_cap,
                "path": "audit-blocked.txt",
                "content": "must-not-exist"
            }),
        )
        .await;
        assert_eq!(audit_blocked["error"]["message"], "AUDIT_UNAVAILABLE");
        assert!(!writable_workspace.join("audit-blocked.txt").exists());

        drop(request_tx);
        dispatcher.await.expect("dispatcher task joins");
        let audit_text = fs::read_to_string(audit.path()).expect("audit readable");
        assert!(audit_text.contains("file_write"));
        assert!(audit_text.contains("file_edit"));
        for secret in [
            "must-not-write",
            "created safely",
            "overwrite",
            "alpha",
            "omega",
            "must-not-exist",
        ] {
            assert!(
                !audit_text.contains(secret),
                "audit must not record mutation content"
            );
        }
        for workspace in [
            observe_workspace,
            denied_workspace,
            writable_workspace,
            other_workspace,
        ] {
            fs::remove_dir_all(workspace).expect("workspace removed");
        }
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn conditional_patch_commit_enforces_policy_preconditions_and_audit_before_mutation() {
        let (audit, audit_root) = audit_sink("conditional-patch-commit");
        let writable_workspace = audit_root.with_extension("patch-writable-workspace");
        let denied_workspace = audit_root.with_extension("patch-denied-workspace");
        fs::create_dir_all(&writable_workspace).expect("writable workspace created");
        fs::create_dir_all(&denied_workspace).expect("denied workspace created");
        fs::write(writable_workspace.join("target.txt"), "before\n").expect("target written");

        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
        ));
        let writable_cap = register_ready_workspace(
            &request_tx,
            &mut response_rx,
            &writable_workspace,
            develop_policy(true),
            "patch_writable",
        )
        .await;
        let denied_cap = register_ready_workspace(
            &request_tx,
            &mut response_rx,
            &denied_workspace,
            develop_policy(false),
            "patch_denied",
        )
        .await;

        let updated = next_response(
            &request_tx,
            &mut response_rx,
            "req_patch_update",
            "file.commit_patch_file",
            json!({
                "capabilityId": writable_cap,
                "path": "target.txt",
                "action": "update",
                "expectedSha256": "9160d4be34c8695bd172a76c7c7966587ea5a4d991ad22c87b2b91af54aa9ebb",
                "content": "after\n"
            }),
        )
        .await;
        assert_eq!(updated["result"]["schemaVersion"], 1);
        assert_eq!(updated["result"]["action"], "update");
        assert_eq!(updated["result"]["bytesWritten"], 6);
        assert_eq!(
            updated["result"]["sha256"],
            "7b9a72466d3960eb2aacccfc848939453490db0678bd4725def3f789b891c919"
        );
        assert_eq!(
            fs::read_to_string(writable_workspace.join("target.txt")).unwrap(),
            "after\n"
        );

        let stale = next_response(
            &request_tx,
            &mut response_rx,
            "req_patch_stale",
            "file.commit_patch_file",
            json!({
                "capabilityId": writable_cap,
                "path": "target.txt",
                "action": "update",
                "expectedSha256": "9160d4be34c8695bd172a76c7c7966587ea5a4d991ad22c87b2b91af54aa9ebb",
                "content": "must-not-write\n"
            }),
        )
        .await;
        assert_eq!(stale["error"]["message"], "PATCH_PRECONDITION_FAILED");
        assert_eq!(
            fs::read_to_string(writable_workspace.join("target.txt")).unwrap(),
            "after\n"
        );

        let exists = next_response(
            &request_tx,
            &mut response_rx,
            "req_patch_exists",
            "file.commit_patch_file",
            json!({
                "capabilityId": writable_cap,
                "path": "target.txt",
                "action": "create",
                "expectedSha256": null,
                "content": "must-not-clobber\n"
            }),
        )
        .await;
        assert_eq!(exists["error"]["message"], "PATCH_TARGET_EXISTS");
        assert_eq!(
            fs::read_to_string(writable_workspace.join("target.txt")).unwrap(),
            "after\n"
        );

        let denied = next_response(
            &request_tx,
            &mut response_rx,
            "req_patch_denied",
            "file.commit_patch_file",
            json!({
                "capabilityId": denied_cap,
                "path": "blocked.txt",
                "action": "create",
                "expectedSha256": null,
                "content": "must-not-exist\n"
            }),
        )
        .await;
        assert_eq!(denied["error"]["message"], "FILE_ACCESS_DENIED");
        assert!(!denied_workspace.join("blocked.txt").exists());

        audit.inject_faults(AuditFaults {
            fail_next_decision: true,
            fail_next_outcome: false,
        });
        let audit_blocked = next_response(
            &request_tx,
            &mut response_rx,
            "req_patch_audit_blocked",
            "file.commit_patch_file",
            json!({
                "capabilityId": writable_cap,
                "path": "audit-blocked.txt",
                "action": "create",
                "expectedSha256": null,
                "content": "must-not-exist\n"
            }),
        )
        .await;
        assert_eq!(audit_blocked["error"]["message"], "AUDIT_UNAVAILABLE");
        assert!(!writable_workspace.join("audit-blocked.txt").exists());

        drop(request_tx);
        dispatcher.await.expect("dispatcher joins");
        let audit_text = fs::read_to_string(audit.path()).expect("audit readable");
        assert!(audit_text.contains("file_commit_patch_file"));
        for secret in [
            "after\\n",
            "must-not-write",
            "must-not-clobber",
            "must-not-exist",
        ] {
            assert!(!audit_text.contains(secret));
        }

        fs::remove_dir_all(writable_workspace).expect("writable workspace removed");
        fs::remove_dir_all(denied_workspace).expect("denied workspace removed");
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }
}
