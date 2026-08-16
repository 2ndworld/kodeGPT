use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use kodegpt_protocol::{
    ArtifactReadParams, FileCommitPatchParams, FileEditParams, FileIdentityParams, FileReadParams,
    FileSearchParams, FileTreeParams, FileWriteParams, GitDiffHistoryParams, GitDiffParams,
    GitLocalMutationParams, GitLogParams, GitRangeParams, GitRemoteMutationParams,
    GitRepositoryIdentityParams, GitShowParams, GitStatusParams, NetworkMode,
    PersistentFilesystemIdentity as ProtocolFilesystemIdentity,
    ProcessInspectExecutableParams, ProcessOperationParams, ProcessRunParams, ProfileName,
    RuntimePolicy, SkillSourceCapabilityParams, SkillSourceInspectRootParams,
    SkillSourceReadEncoding, SkillSourceReadParams, SkillSourceRegisterParams,
    SkillSourceTreeParams, TrustAuditAction, TrustAuditParams, TrustAuditPhase, VerifyRunParams,
    WorkspaceActivateParams, WorkspaceCapabilityParams, WorkspaceRegisterParams,
    WorkspaceRestrictPolicyParams, WorkspaceTraversalScope as ProtocolTraversalScope,
};
use kodegpt_sandbox::{BubblewrapProvider, resolve_trusted_executable};
use kodegpt_workspace_io::{
    FilesystemIdentity, PatchFileAction, SEARCH_MAX_MATCHES, SKILL_SOURCE_TREE_MAX_ENTRIES,
    SkillSourceRegistry, SkillSourceRegistryError, TREE_MAX_ENTRIES, TraversalScope,
    WorkspaceRegistry, WorkspaceRegistryError, inspect_root, inspect_skill_source_root,
    probe_filesystem_boundary,
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
    GitInspectionError, GitLocalMutation, GitOperation, GitRemoteMutation, run_git_checkpoint,
    run_git_checkpoint_patch, run_git_inspection, run_git_local_mutation, run_git_remote_mutation,
    run_git_repository_identity, validate_remote_mutation_input,
};
use crate::git_history::{
    GIT_LOG_MAX_LIMIT, GIT_PATCH_HARD_MAX_BYTES, GIT_RANGE_MAX_LIMIT, GitHistoryError,
    ValidatedHistoryPath, ValidatedRevision, run_git_history_diff, run_git_log, run_git_range,
    run_git_show, validate_history_path, validate_revision,
};
use crate::process::{
    ProcessError, ProcessLaunchRequest, ProcessOperationRegistry, next_process_operation_id,
    run_process,
};
use crate::rpc::{error_response, error_response_with_data_code, parse_request, success_response};
use crate::spool::{RawSpoolError, RawSpoolStore};

#[cfg(feature = "runtime-test-methods")]
use std::io::Write as _;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SystemInspectRootParams {
    path: String,
}

fn valid_audit_operation_id(value: &str) -> bool {
    value.strip_prefix("op_").is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix.len() <= 93
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    })
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
    let skill_source_registry = Arc::new(Mutex::new(SkillSourceRegistry::new()));
    let execution_registry = Arc::new(Mutex::new(ExecutionRegistry::default()));
    let process_operations = Arc::new(ProcessOperationRegistry::default());
    let raw_spool = RawSpoolStore::open(audit.state_root(), Arc::clone(&audit))
        .ok()
        .map(Arc::new);

    while let Some(value) = requests.recv().await {
        let response_tx = responses.clone();
        let audit = Arc::clone(&audit);
        let workspace_registry = Arc::clone(&workspace_registry);
        let skill_source_registry = Arc::clone(&skill_source_registry);
        let execution_registry = Arc::clone(&execution_registry);
        let process_operations = Arc::clone(&process_operations);
        let raw_spool = raw_spool.as_ref().map(Arc::clone);
        tasks.spawn(async move {
            let response = dispatch_one(
                value,
                test_methods_enabled,
                audit,
                workspace_registry,
                skill_source_registry,
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
    skill_source_registry: Arc<Mutex<SkillSourceRegistry>>,
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
        "trust.audit" => {
            let params = match serde_json::from_value::<TrustAuditParams>(request.params) {
                Ok(params) if valid_audit_operation_id(&params.operation_id) => params,
                _ => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            let action = match params.action {
                TrustAuditAction::Trust => AuditAction::WorkspaceTrust,
                TrustAuditAction::ProfileUpdate => AuditAction::WorkspaceTrustProfileUpdate,
                TrustAuditAction::Untrust => AuditAction::WorkspaceUntrust,
            };
            let audit_context = AuditContext {
                request_id: request.id.clone(),
                operation_id: params.operation_id,
                capability_id: None,
                action,
            };
            let recorded = match params.phase {
                TrustAuditPhase::Decision => audit.decision(
                    &audit_context,
                    AuditDecision::Allow,
                    AuditReason::RequestValidated,
                ),
                TrustAuditPhase::Success => audit.outcome(&audit_context, AuditOutcome::Success),
                TrustAuditPhase::Failed => audit.outcome(&audit_context, AuditOutcome::Failed),
            };
            if recorded.is_err() {
                return error_response(Some(request.id), -32010, "AUDIT_UNAVAILABLE");
            }
            success_response(request.id, json!({ "ok": true }))
        }
        "skill_source.inspect_root" => {
            let params =
                match serde_json::from_value::<SkillSourceInspectRootParams>(request.params) {
                    Ok(params) => params,
                    Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
                };
            let operation_suffix = request.id.strip_prefix("req_").unwrap_or("redacted");
            let audit_context = AuditContext {
                request_id: request.id.clone(),
                operation_id: format!("op_{operation_suffix}"),
                capability_id: None,
                action: AuditAction::SkillSourceInspectRoot,
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
            if !filesystem_boundary_available {
                return audited_skill_source_failure(
                    &audit,
                    &audit_context,
                    request.id,
                    -32106,
                    "SKILL_SOURCE_UNAVAILABLE",
                );
            }

            let inspected =
                match inspect_skill_source_root(&PathBuf::from(params.path), audit.state_root()) {
                    Ok(inspected) => inspected,
                    Err(error) => {
                        let (code, message) = skill_source_registry_error_contract(&error);
                        return audited_skill_source_failure(
                            &audit,
                            &audit_context,
                            request.id,
                            code,
                            message,
                        );
                    }
                };
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
        "skill_source.register" => {
            let params = match serde_json::from_value::<SkillSourceRegisterParams>(request.params) {
                Ok(params) => params,
                Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            let root_path = PathBuf::from(params.root_path);
            let state_root = audit.state_root().to_path_buf();
            let expected_identity = filesystem_identity_from_protocol(params.expected_identity);
            audited_skill_source_operation(
                &audit,
                &skill_source_registry,
                request.id,
                None,
                AuditAction::SkillSourceRegister,
                move |registry| {
                    if !filesystem_boundary_available {
                        return Err(SkillSourceRegistryError::FilesystemBoundaryUnavailable);
                    }
                    inspect_skill_source_root(&root_path, &state_root)?;
                    let registration = registry.register(&root_path, &expected_identity)?;
                    Ok(json!({ "sourceCapabilityId": registration.capability_id }))
                },
            )
        }
        "skill_source.tree" => {
            let params = match serde_json::from_value::<SkillSourceTreeParams>(request.params) {
                Ok(params)
                    if params.max_entries > 0
                        && params.max_entries <= SKILL_SOURCE_TREE_MAX_ENTRIES =>
                {
                    params
                }
                Ok(_) | Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
            };
            let capability_id = params.source_capability_id;
            let audit_capability_id = capability_id.clone();
            let path = PathBuf::from(params.path);
            audited_skill_source_operation(
                &audit,
                &skill_source_registry,
                request.id,
                Some(audit_capability_id),
                AuditAction::SkillSourceTree,
                move |registry| {
                    let result = registry.tree(&capability_id, &path, params.max_entries)?;
                    Ok(json!(result))
                },
            )
        }
        "skill_source.read" => {
            let params = match serde_json::from_value::<SkillSourceReadParams>(request.params) {
                Ok(params) if params.max_bytes > 0 && params.max_bytes <= 1024 * 1024 => params,
                Ok(_) | Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
            };
            let capability_id = params.source_capability_id;
            let audit_capability_id = capability_id.clone();
            let path = PathBuf::from(params.path);
            audited_skill_source_operation(
                &audit,
                &skill_source_registry,
                request.id,
                Some(audit_capability_id),
                AuditAction::SkillSourceRead,
                move |registry| match params.encoding {
                    Some(SkillSourceReadEncoding::Base64) => {
                        let result = registry.read_bytes(
                            &capability_id,
                            &path,
                            params.offset,
                            params.max_bytes,
                        )?;
                        Ok(json!({
                            "contentBase64": BASE64_STANDARD.encode(result.bytes),
                            "bytesRead": result.bytes_read,
                            "eof": result.eof
                        }))
                    }
                    None => {
                        let result = registry.read_file(
                            &capability_id,
                            &path,
                            params.offset,
                            params.max_bytes,
                        )?;
                        Ok(json!(result))
                    }
                },
            )
        }
        "skill_source.unregister" => {
            let params = match serde_json::from_value::<SkillSourceCapabilityParams>(request.params)
            {
                Ok(params) => params,
                Err(_) => return error_response(Some(request.id), -32602, "INVALID_PARAMS"),
            };
            let capability_id = params.source_capability_id;
            let audit_capability_id = capability_id.clone();
            audited_skill_source_operation(
                &audit,
                &skill_source_registry,
                request.id,
                Some(audit_capability_id),
                AuditAction::SkillSourceUnregister,
                move |registry| {
                    registry.unregister(&capability_id)?;
                    Ok(json!({ "ok": true }))
                },
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
            let scope = match params.scope {
                ProtocolTraversalScope::Literal => TraversalScope::Literal,
                ProtocolTraversalScope::Semantic => TraversalScope::Semantic,
            };
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
                    let result = registry.tree(&capability_id, &path, max_entries, scope)?;
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
            let scope = match params.scope {
                ProtocolTraversalScope::Literal => TraversalScope::Literal,
                ProtocolTraversalScope::Semantic => TraversalScope::Semantic,
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
                    let result =
                        registry.search(&capability_id, &path, &query, max_matches, scope)?;
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
        "git.repository_identity" => {
            let params = match serde_json::from_value::<GitRepositoryIdentityParams>(request.params) {
                Ok(params) if !params.capability_id.is_empty() => params,
                Ok(_) | Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
            };
            dispatch_git_repository_identity(
                &audit,
                &workspace_registry,
                &execution_registry,
                raw_spool,
                request.id,
                params.capability_id,
            )
            .await
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
        "git.local_mutation" => {
            let params = match serde_json::from_value::<GitLocalMutationParams>(request.params) {
                Ok(params) => params,
                Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
            };
            let (capability_id, mutation, action) = match params {
                GitLocalMutationParams::Stage {
                    capability_id,
                    paths,
                } => (
                    capability_id,
                    GitLocalMutation::Stage { paths },
                    AuditAction::GitStage,
                ),
                GitLocalMutationParams::Commit {
                    capability_id,
                    message,
                } => (
                    capability_id,
                    GitLocalMutation::Commit { message },
                    AuditAction::GitCommit,
                ),
                GitLocalMutationParams::BranchCreate {
                    capability_id,
                    name,
                } => (
                    capability_id,
                    GitLocalMutation::BranchCreate { name },
                    AuditAction::GitBranchCreate,
                ),
                GitLocalMutationParams::BranchSwitch {
                    capability_id,
                    name,
                } => (
                    capability_id,
                    GitLocalMutation::BranchSwitch { name },
                    AuditAction::GitBranchSwitch,
                ),
                GitLocalMutationParams::BranchDelete {
                    capability_id,
                    name,
                } => (
                    capability_id,
                    GitLocalMutation::BranchDelete { name },
                    AuditAction::GitBranchDelete,
                ),
            };
            if capability_id.is_empty() {
                return error_response(Some(request.id), -32602, "INVALID_PARAMS");
            }
            dispatch_git_local_mutation(
                &audit,
                &workspace_registry,
                &execution_registry,
                raw_spool,
                request.id,
                capability_id,
                mutation,
                action,
            )
            .await
        }
        "git.remote_mutation" => {
            let params = match serde_json::from_value::<GitRemoteMutationParams>(request.params) {
                Ok(params) => params,
                Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
            };
            let (capability_id, mutation, action) = match params {
                GitRemoteMutationParams::Fetch {
                    capability_id,
                    remote,
                    r#ref,
                } => (
                    capability_id,
                    GitRemoteMutation::Fetch { remote, r#ref },
                    AuditAction::GitFetch,
                ),
                GitRemoteMutationParams::Pull {
                    capability_id,
                    remote,
                    r#ref,
                } => (
                    capability_id,
                    GitRemoteMutation::Pull { remote, r#ref },
                    AuditAction::GitPull,
                ),
                GitRemoteMutationParams::Push {
                    capability_id,
                    remote,
                    r#ref,
                } => (
                    capability_id,
                    GitRemoteMutation::Push { remote, r#ref },
                    AuditAction::GitPush,
                ),
            };
            if capability_id.is_empty() {
                return error_response(Some(request.id), -32602, "INVALID_PARAMS");
            }
            dispatch_git_remote_mutation(
                &audit,
                &workspace_registry,
                &execution_registry,
                raw_spool,
                request.id,
                capability_id,
                mutation,
                action,
            )
            .await
        }
        "git.log" => {
            let params = match serde_json::from_value::<GitLogParams>(request.params) {
                Ok(params)
                    if !params.capability_id.is_empty()
                        && (1..=GIT_LOG_MAX_LIMIT).contains(&params.limit) =>
                {
                    params
                }
                Ok(_) | Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
            };
            let revision = match validate_revision(params.revision) {
                Ok(revision) => revision,
                Err(error) => {
                    let (code, message) = git_history_error_contract(&error);
                    return error_response(Some(request.id), code, message);
                }
            };
            let path = match validate_history_path(params.path) {
                Ok(path) => path,
                Err(error) => {
                    let (code, message) = git_history_error_contract(&error);
                    return error_response(Some(request.id), code, message);
                }
            };
            dispatch_git_log(
                &audit,
                &workspace_registry,
                &execution_registry,
                raw_spool,
                request.id,
                params.capability_id,
                revision,
                path,
                params.limit,
            )
            .await
        }
        "git.show" => {
            let params = match serde_json::from_value::<GitShowParams>(request.params) {
                Ok(params)
                    if !params.capability_id.is_empty()
                        && (1..=GIT_PATCH_HARD_MAX_BYTES).contains(&params.max_patch_bytes) =>
                {
                    params
                }
                Ok(_) | Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
            };
            let revision = match validate_revision(params.revision) {
                Ok(revision) => revision,
                Err(error) => {
                    let (code, message) = git_history_error_contract(&error);
                    return error_response(Some(request.id), code, message);
                }
            };
            let path = match validate_history_path(params.path) {
                Ok(path) => path,
                Err(error) => {
                    let (code, message) = git_history_error_contract(&error);
                    return error_response(Some(request.id), code, message);
                }
            };
            dispatch_git_show(
                &audit,
                &workspace_registry,
                &execution_registry,
                raw_spool,
                request.id,
                params.capability_id,
                revision,
                path,
                params.include_patch,
                params.max_patch_bytes,
            )
            .await
        }
        "git.range" => {
            let params = match serde_json::from_value::<GitRangeParams>(request.params) {
                Ok(params)
                    if !params.capability_id.is_empty()
                        && (1..=GIT_RANGE_MAX_LIMIT).contains(&params.limit) =>
                {
                    params
                }
                Ok(_) | Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
            };
            let base_revision = match validate_revision(params.base_revision) {
                Ok(revision) => revision,
                Err(error) => {
                    let (code, message) = git_history_error_contract(&error);
                    return error_response(Some(request.id), code, message);
                }
            };
            let head_revision = match validate_revision(params.head_revision) {
                Ok(revision) => revision,
                Err(error) => {
                    let (code, message) = git_history_error_contract(&error);
                    return error_response(Some(request.id), code, message);
                }
            };
            dispatch_git_range(
                &audit,
                &workspace_registry,
                &execution_registry,
                raw_spool,
                request.id,
                params.capability_id,
                base_revision,
                head_revision,
                params.mode,
                params.limit,
            )
            .await
        }
        "git.diff_history" => {
            let params = match serde_json::from_value::<GitDiffHistoryParams>(request.params) {
                Ok(params)
                    if !params.capability_id.is_empty()
                        && (1..=GIT_PATCH_HARD_MAX_BYTES).contains(&params.max_patch_bytes) =>
                {
                    params
                }
                Ok(_) | Err(_) => {
                    return error_response(Some(request.id), -32602, "INVALID_PARAMS");
                }
            };
            let base_revision = match validate_revision(params.base_revision) {
                Ok(revision) => revision,
                Err(error) => {
                    let (code, message) = git_history_error_contract(&error);
                    return error_response(Some(request.id), code, message);
                }
            };
            let head_revision = match validate_revision(params.head_revision) {
                Ok(revision) => revision,
                Err(error) => {
                    let (code, message) = git_history_error_contract(&error);
                    return error_response(Some(request.id), code, message);
                }
            };
            let path = match validate_history_path(params.path) {
                Ok(path) => path,
                Err(error) => {
                    let (code, message) = git_history_error_contract(&error);
                    return error_response(Some(request.id), code, message);
                }
            };
            dispatch_git_history_diff(
                &audit,
                &workspace_registry,
                &execution_registry,
                raw_spool,
                request.id,
                params.capability_id,
                base_revision,
                head_revision,
                path,
                params.max_patch_bytes,
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

fn audited_skill_source_operation<F>(
    audit: &AuditSink,
    registry: &Arc<Mutex<SkillSourceRegistry>>,
    request_id: String,
    capability_id: Option<String>,
    action: AuditAction,
    operation: F,
) -> Value
where
    F: FnOnce(&mut SkillSourceRegistry) -> Result<Value, SkillSourceRegistryError>,
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
            return audited_skill_source_failure(
                audit,
                &context,
                request_id,
                -32109,
                "SKILL_SOURCE_UNAVAILABLE",
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
            let (code, message) = skill_source_registry_error_contract(&error);
            audited_skill_source_failure(audit, &context, request_id, code, message)
        }
    }
}

async fn dispatch_git_repository_identity(
    audit: &Arc<AuditSink>,
    registry: &Arc<Mutex<WorkspaceRegistry<RuntimePolicy>>>,
    executions: &Arc<Mutex<ExecutionRegistry>>,
    raw_spool: Option<Arc<RawSpoolStore>>,
    request_id: String,
    capability_id: String,
) -> Value {
    let operation_suffix = request_id.strip_prefix("req_").unwrap_or("redacted");
    let operation_id = format!("op_{operation_suffix}");
    let context = AuditContext {
        request_id: request_id.clone(),
        operation_id: operation_id.clone(),
        capability_id: Some(capability_id.clone()),
        action: AuditAction::GitRepositoryIdentity,
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
            "GIT_REPOSITORY_IDENTITY_UNAVAILABLE",
        );
    };
    let executions = Arc::clone(executions);
    let capability_for_run = capability_id.clone();
    let request_for_run = request_id.clone();
    let operation_for_run = operation_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        run_git_repository_identity(
            &root_fd,
            &capability_for_run,
            &request_for_run,
            &operation_for_run,
            &raw_spool,
            &executions,
        )
    })
    .await;
    let result = match result {
        Ok(Ok(result)) => result,
        Ok(Err(GitInspectionError::RepositoryIdentityInvalid))
        | Ok(Err(GitInspectionError::RepositoryIdentityLimitExceeded)) => {
            return audited_failure(
                audit,
                &context,
                request_id,
                -32064,
                "GIT_REPOSITORY_IDENTITY_INVALID",
            );
        }
        Ok(Err(_)) | Err(_) => {
            return audited_failure(
                audit,
                &context,
                request_id,
                -32065,
                "GIT_REPOSITORY_IDENTITY_UNAVAILABLE",
            );
        }
    };
    if audit.outcome(&context, AuditOutcome::Success).is_err() {
        return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
    }
    success_response(request_id, json!(result))
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

#[allow(clippy::too_many_arguments)]
async fn dispatch_git_local_mutation(
    audit: &Arc<AuditSink>,
    registry: &Arc<Mutex<WorkspaceRegistry<RuntimePolicy>>>,
    executions: &Arc<Mutex<ExecutionRegistry>>,
    raw_spool: Option<Arc<RawSpoolStore>>,
    request_id: String,
    capability_id: String,
    mutation: GitLocalMutation,
    action: AuditAction,
) -> Value {
    let policy = match registry.lock() {
        Ok(registry) => match registry.clone_ready_policy(&capability_id) {
            Ok(policy) => policy,
            Err(error) => {
                let (code, message) = workspace_registry_error_contract(&error);
                return error_response(Some(request_id), code, message);
            }
        },
        Err(_) => {
            return error_response(Some(request_id), -32026, "WORKSPACE_REGISTRY_UNAVAILABLE");
        }
    };
    if policy.name != ProfileName::Trusted || !policy.allow_write {
        return error_response(Some(request_id), -32059, "GIT_POLICY_DENIED");
    }

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
            -32061,
            "GIT_MUTATION_UNAVAILABLE",
        );
    };

    let executions = Arc::clone(executions);
    let capability_for_run = capability_id.clone();
    let request_for_run = request_id.clone();
    let operation_for_run = operation_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        run_git_local_mutation(
            &root_fd,
            &capability_for_run,
            &request_for_run,
            &operation_for_run,
            mutation,
            &raw_spool,
            &executions,
        )
    })
    .await;

    let result = match result {
        Ok(Ok(result)) => result,
        Ok(Err(GitInspectionError::InvalidMutationInput)) => {
            return audited_failure(
                audit,
                &context,
                request_id,
                -32060,
                "GIT_MUTATION_INPUT_INVALID",
            );
        }
        Ok(Err(_)) | Err(_) => {
            return audited_failure(audit, &context, request_id, -32061, "GIT_MUTATION_FAILED");
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

#[allow(clippy::too_many_arguments)]
async fn dispatch_git_remote_mutation(
    audit: &Arc<AuditSink>,
    registry: &Arc<Mutex<WorkspaceRegistry<RuntimePolicy>>>,
    executions: &Arc<Mutex<ExecutionRegistry>>,
    raw_spool: Option<Arc<RawSpoolStore>>,
    request_id: String,
    capability_id: String,
    mutation: GitRemoteMutation,
    action: AuditAction,
) -> Value {
    let policy = match registry.lock() {
        Ok(registry) => match registry.clone_ready_policy(&capability_id) {
            Ok(policy) => policy,
            Err(error) => {
                let (code, message) = workspace_registry_error_contract(&error);
                return error_response(Some(request_id), code, message);
            }
        },
        Err(_) => {
            return error_response(Some(request_id), -32026, "WORKSPACE_REGISTRY_UNAVAILABLE");
        }
    };
    if policy.name != ProfileName::Trusted
        || !policy.allow_write
        || policy.network != NetworkMode::Unrestricted
    {
        return error_response(Some(request_id), -32062, "GIT_REMOTE_POLICY_DENIED");
    }

    let (remote, ref_name) = match &mutation {
        GitRemoteMutation::Fetch { remote, r#ref }
        | GitRemoteMutation::Pull { remote, r#ref }
        | GitRemoteMutation::Push { remote, r#ref } => (remote.as_str(), r#ref.as_str()),
    };
    if validate_remote_mutation_input(remote, ref_name).is_err() {
        return error_response(Some(request_id), -32063, "GIT_REMOTE_INPUT_INVALID");
    }
    let remote = remote.to_owned();
    let ref_name = ref_name.to_owned();

    let operation_suffix = request_id.strip_prefix("req_").unwrap_or("redacted");
    let operation_id = format!("op_{operation_suffix}");
    let context = AuditContext {
        request_id: request_id.clone(),
        operation_id: operation_id.clone(),
        capability_id: Some(capability_id.clone()),
        action,
    };
    if audit
        .decision_with_git_remote(
            &context,
            AuditDecision::Allow,
            AuditReason::RequestValidated,
            &remote,
            &ref_name,
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
                return audited_git_remote_failure(
                    audit, &context, request_id, code, message, &remote, &ref_name,
                );
            }
        },
        Err(_) => {
            return audited_git_remote_failure(
                audit,
                &context,
                request_id,
                -32026,
                "WORKSPACE_REGISTRY_UNAVAILABLE",
                &remote,
                &ref_name,
            );
        }
    };
    let Some(raw_spool) = raw_spool else {
        return audited_git_remote_failure(
            audit,
            &context,
            request_id,
            -32064,
            "GIT_REMOTE_UNAVAILABLE",
            &remote,
            &ref_name,
        );
    };

    let executions = Arc::clone(executions);
    let capability_for_run = capability_id.clone();
    let request_for_run = request_id.clone();
    let operation_for_run = operation_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        run_git_remote_mutation(
            &root_fd,
            &capability_for_run,
            &request_for_run,
            &operation_for_run,
            mutation,
            &raw_spool,
            &executions,
        )
    })
    .await;

    let result = match result {
        Ok(Ok(result)) => result,
        Ok(Err(GitInspectionError::InvalidMutationInput)) => {
            return audited_git_remote_failure(
                audit,
                &context,
                request_id,
                -32063,
                "GIT_REMOTE_INPUT_INVALID",
                &remote,
                &ref_name,
            );
        }
        Ok(Err(_)) | Err(_) => {
            return audited_git_remote_failure(
                audit,
                &context,
                request_id,
                -32065,
                "GIT_REMOTE_FAILED",
                &remote,
                &ref_name,
            );
        }
    };
    let outcome = if result.exit_code == 0 {
        AuditOutcome::Success
    } else {
        AuditOutcome::Failed
    };
    if audit
        .outcome_with_git_remote(&context, outcome, &remote, &ref_name)
        .is_err()
    {
        return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
    }
    success_response(request_id, json!(result))
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_git_log(
    audit: &Arc<AuditSink>,
    registry: &Arc<Mutex<WorkspaceRegistry<RuntimePolicy>>>,
    executions: &Arc<Mutex<ExecutionRegistry>>,
    raw_spool: Option<Arc<RawSpoolStore>>,
    request_id: String,
    capability_id: String,
    revision: ValidatedRevision,
    path: Option<ValidatedHistoryPath>,
    limit: u16,
) -> Value {
    let operation_suffix = request_id.strip_prefix("req_").unwrap_or("redacted");
    let operation_id = format!("op_{operation_suffix}");
    let context = AuditContext {
        request_id: request_id.clone(),
        operation_id: operation_id.clone(),
        capability_id: Some(capability_id.clone()),
        action: AuditAction::GitHistoryList,
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
        let (code, message) = git_history_error_contract(&GitHistoryError::GitUnavailable);
        return audited_failure(audit, &context, request_id, code, message);
    };

    let executions = Arc::clone(executions);
    let capability_for_run = capability_id.clone();
    let request_for_run = request_id.clone();
    let operation_for_run = operation_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        run_git_log(
            &root_fd,
            &capability_for_run,
            &request_for_run,
            &operation_for_run,
            revision,
            path,
            limit,
            &raw_spool,
            &executions,
        )
    })
    .await;

    match result {
        Ok(Ok(result)) => {
            if audit.outcome(&context, AuditOutcome::Success).is_err() {
                return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
            }
            success_response(request_id, json!(result))
        }
        Ok(Err(error)) => {
            let (code, message) = git_history_error_contract(&error);
            audited_failure(audit, &context, request_id, code, message)
        }
        Err(_) => {
            let (code, message) = git_history_error_contract(&GitHistoryError::GitReadFailed);
            audited_failure(audit, &context, request_id, code, message)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_git_show(
    audit: &Arc<AuditSink>,
    registry: &Arc<Mutex<WorkspaceRegistry<RuntimePolicy>>>,
    executions: &Arc<Mutex<ExecutionRegistry>>,
    raw_spool: Option<Arc<RawSpoolStore>>,
    request_id: String,
    capability_id: String,
    revision: ValidatedRevision,
    path: Option<ValidatedHistoryPath>,
    include_patch: bool,
    max_patch_bytes: u32,
) -> Value {
    let operation_suffix = request_id.strip_prefix("req_").unwrap_or("redacted");
    let operation_id = format!("op_{operation_suffix}");
    let context = AuditContext {
        request_id: request_id.clone(),
        operation_id: operation_id.clone(),
        capability_id: Some(capability_id.clone()),
        action: AuditAction::GitCommitInspect,
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
        let (code, message) = git_history_error_contract(&GitHistoryError::GitUnavailable);
        return audited_failure(audit, &context, request_id, code, message);
    };

    let executions = Arc::clone(executions);
    let capability_for_run = capability_id.clone();
    let request_for_run = request_id.clone();
    let operation_for_run = operation_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        run_git_show(
            &root_fd,
            &capability_for_run,
            &request_for_run,
            &operation_for_run,
            revision,
            path,
            include_patch,
            max_patch_bytes,
            &raw_spool,
            &executions,
        )
    })
    .await;

    match result {
        Ok(Ok(result)) => {
            if audit.outcome(&context, AuditOutcome::Success).is_err() {
                return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
            }
            success_response(request_id, json!(result))
        }
        Ok(Err(error)) => {
            let (code, message) = git_history_error_contract(&error);
            audited_failure(audit, &context, request_id, code, message)
        }
        Err(_) => {
            let (code, message) = git_history_error_contract(&GitHistoryError::GitReadFailed);
            audited_failure(audit, &context, request_id, code, message)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_git_range(
    audit: &Arc<AuditSink>,
    registry: &Arc<Mutex<WorkspaceRegistry<RuntimePolicy>>>,
    executions: &Arc<Mutex<ExecutionRegistry>>,
    raw_spool: Option<Arc<RawSpoolStore>>,
    request_id: String,
    capability_id: String,
    base_revision: ValidatedRevision,
    head_revision: ValidatedRevision,
    mode: kodegpt_protocol::GitRangeMode,
    limit: u16,
) -> Value {
    let operation_suffix = request_id.strip_prefix("req_").unwrap_or("redacted");
    let operation_id = format!("op_{operation_suffix}");
    let context = AuditContext {
        request_id: request_id.clone(),
        operation_id: operation_id.clone(),
        capability_id: Some(capability_id.clone()),
        action: AuditAction::GitHistoryRange,
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
        let (code, message) = git_history_error_contract(&GitHistoryError::GitUnavailable);
        return audited_failure(audit, &context, request_id, code, message);
    };

    let executions = Arc::clone(executions);
    let capability_for_run = capability_id.clone();
    let request_for_run = request_id.clone();
    let operation_for_run = operation_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        run_git_range(
            &root_fd,
            &capability_for_run,
            &request_for_run,
            &operation_for_run,
            base_revision,
            head_revision,
            mode,
            limit,
            &raw_spool,
            &executions,
        )
    })
    .await;

    match result {
        Ok(Ok(result)) => {
            if audit.outcome(&context, AuditOutcome::Success).is_err() {
                return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
            }
            success_response(request_id, json!(result))
        }
        Ok(Err(error)) => {
            let (code, message) = git_history_error_contract(&error);
            audited_failure(audit, &context, request_id, code, message)
        }
        Err(_) => {
            let (code, message) = git_history_error_contract(&GitHistoryError::GitReadFailed);
            audited_failure(audit, &context, request_id, code, message)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_git_history_diff(
    audit: &Arc<AuditSink>,
    registry: &Arc<Mutex<WorkspaceRegistry<RuntimePolicy>>>,
    executions: &Arc<Mutex<ExecutionRegistry>>,
    raw_spool: Option<Arc<RawSpoolStore>>,
    request_id: String,
    capability_id: String,
    base_revision: ValidatedRevision,
    head_revision: ValidatedRevision,
    path: Option<ValidatedHistoryPath>,
    max_patch_bytes: u32,
) -> Value {
    let operation_suffix = request_id.strip_prefix("req_").unwrap_or("redacted");
    let operation_id = format!("op_{operation_suffix}");
    let context = AuditContext {
        request_id: request_id.clone(),
        operation_id: operation_id.clone(),
        capability_id: Some(capability_id.clone()),
        action: AuditAction::GitHistoryDiff,
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
        let (code, message) = git_history_error_contract(&GitHistoryError::GitUnavailable);
        return audited_failure(audit, &context, request_id, code, message);
    };

    let executions = Arc::clone(executions);
    let capability_for_run = capability_id.clone();
    let request_for_run = request_id.clone();
    let operation_for_run = operation_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        run_git_history_diff(
            &root_fd,
            &capability_for_run,
            &request_for_run,
            &operation_for_run,
            base_revision,
            head_revision,
            path,
            max_patch_bytes,
            &raw_spool,
            &executions,
        )
    })
    .await;

    match result {
        Ok(Ok(result)) => {
            if audit.outcome(&context, AuditOutcome::Success).is_err() {
                return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
            }
            success_response(request_id, json!(result))
        }
        Ok(Err(error)) => {
            let (code, message) = git_history_error_contract(&error);
            audited_failure(audit, &context, request_id, code, message)
        }
        Err(_) => {
            let (code, message) = git_history_error_contract(&GitHistoryError::GitReadFailed);
            audited_failure(audit, &context, request_id, code, message)
        }
    }
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

fn git_history_error_contract(error: &GitHistoryError) -> (i64, &'static str) {
    match error {
        GitHistoryError::NotAGitRepository => (-32050, "NOT_A_GIT_REPOSITORY"),
        GitHistoryError::RevisionInvalid => (-32051, "REVISION_INVALID"),
        GitHistoryError::RevisionNotFound => (-32052, "REVISION_NOT_FOUND"),
        GitHistoryError::ObjectTypeUnsupported => (-32053, "OBJECT_TYPE_UNSUPPORTED"),
        GitHistoryError::PathInvalid => (-32054, "PATH_INVALID"),
        GitHistoryError::OutputLimitExceeded => (-32055, "OUTPUT_LIMIT_EXCEEDED"),
        GitHistoryError::Timeout => (-32056, "PROCESS_TIMEOUT"),
        GitHistoryError::GitUnavailable => (-32057, "GIT_UNAVAILABLE"),
        GitHistoryError::GitReadFailed => (-32058, "GIT_READ_FAILED"),
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

fn skill_source_registry_error_contract(error: &SkillSourceRegistryError) -> (i64, &'static str) {
    match error {
        SkillSourceRegistryError::RootInvalid | SkillSourceRegistryError::RootOverlap => {
            (-32100, "SKILL_SOURCE_INVALID")
        }
        SkillSourceRegistryError::IdentityChanged => (-32101, "SKILL_SOURCE_IDENTITY_CHANGED"),
        SkillSourceRegistryError::StateOverlap => (-32102, "SKILL_SOURCE_STATE_OVERLAP"),
        SkillSourceRegistryError::AccessDenied => (-32103, "SKILL_SOURCE_BOUNDARY_VIOLATION"),
        SkillSourceRegistryError::LimitExceeded => (-32104, "SKILL_SOURCE_LIMIT_EXCEEDED"),
        SkillSourceRegistryError::InvalidUtf8 => (-32105, "SKILL_RESOURCE_UNSUPPORTED"),
        SkillSourceRegistryError::MountTopologyUnavailable
        | SkillSourceRegistryError::FilesystemBoundaryUnavailable
        | SkillSourceRegistryError::NotFound
        | SkillSourceRegistryError::ReadFailed
        | SkillSourceRegistryError::CapabilityNotFound => (-32106, "SKILL_SOURCE_UNAVAILABLE"),
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

#[allow(clippy::too_many_arguments)]
fn audited_git_remote_failure(
    audit: &AuditSink,
    context: &AuditContext,
    request_id: String,
    code: i64,
    message: &str,
    remote: &str,
    ref_name: &str,
) -> Value {
    if audit
        .outcome_with_git_remote(context, AuditOutcome::Failed, remote, ref_name)
        .is_err()
    {
        return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
    }
    error_response(Some(request_id), code, message)
}

fn audited_skill_source_failure(
    audit: &AuditSink,
    context: &AuditContext,
    request_id: String,
    code: i64,
    message: &str,
) -> Value {
    if audit.outcome(context, AuditOutcome::Failed).is_err() {
        return error_response(Some(request_id), -32010, "AUDIT_UNAVAILABLE");
    }
    error_response_with_data_code(Some(request_id), code, message, message)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command as TestCommand;
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

    fn test_git(root: &Path, args: &[&str]) -> String {
        let output = TestCommand::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .env_clear()
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("HOME", "/tmp")
            .output()
            .expect("test git available");
        assert!(
            output.status.success(),
            "test git command failed: {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .expect("test git output utf8")
            .trim()
            .to_owned()
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

    async fn trust_audit_once(
        audit: Arc<AuditSink>,
        id: &str,
        operation_id: &str,
        action: &str,
        phase: &str,
    ) -> Value {
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(request_rx, response_tx, false, audit));
        request_tx
            .send(request(
                id,
                "trust.audit",
                json!({
                    "operationId": operation_id,
                    "action": action,
                    "phase": phase
                }),
            ))
            .expect("trust audit request accepted");
        drop(request_tx);

        let response = tokio::time::timeout(Duration::from_millis(500), response_rx.recv())
            .await
            .expect("trust audit response arrives")
            .expect("response channel open");
        dispatcher.await.expect("dispatcher task joins");
        response
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn trust_audit_routes_control_plane_records_through_the_single_rust_sink() {
        let (audit, audit_root) = audit_sink("trust-control-plane");

        let decision = trust_audit_once(
            Arc::clone(&audit),
            "req_trust_decision",
            "op_trust_control_plane",
            "profile_update",
            "decision",
        )
        .await;
        assert_eq!(decision["result"]["ok"], true);

        let outcome = trust_audit_once(
            Arc::clone(&audit),
            "req_trust_success",
            "op_trust_control_plane",
            "profile_update",
            "success",
        )
        .await;
        assert_eq!(outcome["result"]["ok"], true);

        let audit_text = fs::read_to_string(audit.path()).expect("audit readable");
        assert_eq!(audit_text.lines().count(), 2);
        assert!(audit_text.contains("workspace_trust_profile_update"));
        assert!(audit_text.contains("op_trust_control_plane"));
        assert!(!audit_text.contains("rootPath"));
        assert!(!audit_text.contains("deviceMajor"));
        assert!(!audit_text.contains("inode"));

        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn trust_audit_fails_closed_when_the_single_rust_sink_is_unavailable() {
        let audit_root = std::env::temp_dir().join(format!(
            "kodegpt-dispatcher-trust-audit-fault-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&audit_root);
        let audit = Arc::new(AuditSink::open_with_faults(
            &audit_root,
            AuditFaults {
                fail_next_decision: true,
                fail_next_outcome: false,
            },
        ));

        let response = trust_audit_once(
            Arc::clone(&audit),
            "req_trust_fault",
            "op_trust_fault",
            "trust",
            "decision",
        )
        .await;

        assert_eq!(response["error"]["message"], "AUDIT_UNAVAILABLE");
        assert!(!audit.is_healthy());
        fs::remove_dir_all(audit_root).expect("audit root removed");
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

    fn trusted_policy() -> Value {
        json!({
            "name": "trusted",
            "allowWrite": true,
            "allowProcess": true,
            "network": "unrestricted",
            "allowedExecutableNames": ["git", "node", "python3"],
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
        tokio::time::timeout(Duration::from_secs(5), response_rx.recv())
            .await
            .unwrap_or_else(|_| panic!("workspace response arrives for {method} ({id})"))
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
    async fn local_git_mutation_requires_ready_trusted_policy_and_audits_success() {
        let (audit, audit_root) = audit_sink("git-local-mutation-policy");
        let develop_workspace = audit_root.with_extension("git-develop-workspace");
        let trusted_workspace = audit_root.with_extension("git-trusted-workspace");
        for workspace in [&develop_workspace, &trusted_workspace] {
            fs::create_dir_all(workspace).expect("workspace created");
            test_git(workspace, &["init", "-b", "main"]);
            test_git(workspace, &["config", "user.name", "KodeGPT Test"]);
            test_git(
                workspace,
                &["config", "user.email", "kodegpt@example.invalid"],
            );
            fs::write(workspace.join("tracked.txt"), "content\n").expect("tracked file");
        }

        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
        ));
        let develop_capability = register_ready_workspace(
            &request_tx,
            &mut response_rx,
            &develop_workspace,
            develop_policy(true),
            "git_local_develop",
        )
        .await;
        let trusted_capability = register_ready_workspace(
            &request_tx,
            &mut response_rx,
            &trusted_workspace,
            trusted_policy(),
            "git_local_trusted",
        )
        .await;

        let denied = next_response(
            &request_tx,
            &mut response_rx,
            "req_git_local_develop_denied",
            "git.local_mutation",
            json!({
                "capabilityId": develop_capability,
                "operation": "stage",
                "paths": ["tracked.txt"]
            }),
        )
        .await;
        assert_eq!(denied["error"]["message"], "GIT_POLICY_DENIED");
        assert!(test_git(&develop_workspace, &["diff", "--cached", "--name-only"]).is_empty());

        let staged = next_response(
            &request_tx,
            &mut response_rx,
            "req_git_local_trusted_stage",
            "git.local_mutation",
            json!({
                "capabilityId": trusted_capability,
                "operation": "stage",
                "paths": ["tracked.txt"]
            }),
        )
        .await;
        assert_eq!(staged["result"]["schemaVersion"], 1);
        assert_eq!(staged["result"]["operation"], "stage");
        assert_eq!(staged["result"]["exitCode"], 0);
        assert_eq!(
            test_git(&trusted_workspace, &["diff", "--cached", "--name-only"]).trim(),
            "tracked.txt"
        );

        let committed = next_response(
            &request_tx,
            &mut response_rx,
            "req_git_local_trusted_commit",
            "git.local_mutation",
            json!({
                "capabilityId": trusted_capability,
                "operation": "commit",
                "message": "top-secret-commit-message"
            }),
        )
        .await;
        assert_eq!(committed["result"]["operation"], "commit");
        assert_eq!(committed["result"]["exitCode"], 0);

        let branch_created = next_response(
            &request_tx,
            &mut response_rx,
            "req_git_local_trusted_branch_create",
            "git.local_mutation",
            json!({
                "capabilityId": trusted_capability,
                "operation": "branch_create",
                "name": "secret-target-branch"
            }),
        )
        .await;
        assert_eq!(branch_created["result"]["operation"], "branch_create");
        assert_eq!(branch_created["result"]["exitCode"], 0);

        let audit_text = fs::read_to_string(audit.path()).expect("audit log");
        assert!(audit_text.contains("git_stage"));
        assert!(audit_text.contains("git_commit"));
        assert!(audit_text.contains("git_branch_create"));
        assert!(audit_text.contains(&trusted_capability));
        assert!(audit_text.contains("success"));
        assert!(!audit_text.contains("tracked.txt"));
        assert!(!audit_text.contains("top-secret-commit-message"));
        assert!(!audit_text.contains("secret-target-branch"));

        drop(request_tx);
        dispatcher.await.expect("dispatcher joins");
        fs::remove_dir_all(develop_workspace).expect("develop workspace cleanup");
        fs::remove_dir_all(trusted_workspace).expect("trusted workspace cleanup");
        fs::remove_dir_all(audit_root).expect("audit root cleanup");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn remote_git_mutation_requires_trusted_write_and_unrestricted_network() {
        let (audit, audit_root) = audit_sink("git-remote-mutation-policy");
        let denied_workspace = audit_root.with_extension("git-remote-denied-workspace");
        let trusted_workspace = audit_root.with_extension("git-remote-trusted-workspace");
        for workspace in [&denied_workspace, &trusted_workspace] {
            fs::create_dir_all(workspace).expect("workspace created");
            test_git(workspace, &["init", "-b", "main"]);
            test_git(workspace, &["config", "user.name", "KodeGPT Test"]);
            test_git(
                workspace,
                &["config", "user.email", "kodegpt@example.invalid"],
            );
            fs::write(workspace.join("tracked.txt"), "content\n").expect("tracked file");
            test_git(workspace, &["add", "tracked.txt"]);
            test_git(workspace, &["commit", "-m", "base"]);
            test_git(workspace, &["init", "--bare", "remote.git"]);
            test_git(workspace, &["remote", "add", "origin", "remote.git"]);
        }

        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
        ));
        let mut narrowed_policy = trusted_policy();
        narrowed_policy["network"] = json!("deny");
        let denied_capability = register_ready_workspace(
            &request_tx,
            &mut response_rx,
            &denied_workspace,
            narrowed_policy,
            "git_remote_denied",
        )
        .await;
        let trusted_capability = register_ready_workspace(
            &request_tx,
            &mut response_rx,
            &trusted_workspace,
            trusted_policy(),
            "git_remote_trusted",
        )
        .await;

        let denied = next_response(
            &request_tx,
            &mut response_rx,
            "req_git_remote_denied",
            "git.remote_mutation",
            json!({
                "capabilityId": denied_capability,
                "operation": "push",
                "remote": "origin",
                "ref": "main"
            }),
        )
        .await;
        assert_eq!(denied["error"]["message"], "GIT_REMOTE_POLICY_DENIED");
        assert!(!denied_workspace.join("remote.git/refs/heads/main").exists());

        let pushed = next_response(
            &request_tx,
            &mut response_rx,
            "req_git_remote_push",
            "git.remote_mutation",
            json!({
                "capabilityId": trusted_capability,
                "operation": "push",
                "remote": "origin",
                "ref": "main"
            }),
        )
        .await;
        assert_eq!(pushed["result"]["schemaVersion"], 1);
        assert_eq!(pushed["result"]["operation"], "push");
        assert_eq!(pushed["result"]["exitCode"], 0);
        assert!(
            !test_git(
                &trusted_workspace,
                &["--git-dir", "remote.git", "rev-parse", "refs/heads/main"]
            )
            .trim()
            .is_empty()
        );

        let invalid = next_response(
            &request_tx,
            &mut response_rx,
            "req_git_remote_invalid_url",
            "git.remote_mutation",
            json!({
                "capabilityId": trusted_capability,
                "operation": "fetch",
                "remote": "https://transport-secret@example.invalid/repo.git",
                "ref": "main"
            }),
        )
        .await;
        assert_eq!(invalid["error"]["message"], "GIT_REMOTE_INPUT_INVALID");

        let audit_text = fs::read_to_string(audit.path()).expect("audit log");
        assert!(audit_text.contains("git_push"));
        assert!(audit_text.contains("\"remote\":\"origin\""));
        assert!(audit_text.contains("\"ref\":\"main\""));
        assert!(!audit_text.contains("transport-secret"));
        assert!(!audit_text.contains("example.invalid/repo.git"));

        drop(request_tx);
        dispatcher.await.expect("dispatcher joins");
        fs::remove_dir_all(denied_workspace).expect("denied workspace cleanup");
        fs::remove_dir_all(trusted_workspace).expect("trusted workspace cleanup");
        fs::remove_dir_all(audit_root).expect("audit root cleanup");
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
    async fn git_log_audit_precedes_workspace_access_and_records_one_top_level_pair() {
        let (failing_audit, failing_root) = audit_sink("git-log-audit-fail");
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&failing_audit),
        ));
        failing_audit.inject_faults(AuditFaults {
            fail_next_decision: true,
            fail_next_outcome: false,
        });

        let response = next_response(
            &request_tx,
            &mut response_rx,
            "req_git_log_audit_fail",
            "git.log",
            json!({
                "capabilityId": "kc_intentionally_missing",
                "revision": { "kind": "head" },
                "limit": 1
            }),
        )
        .await;
        assert_eq!(response["error"]["message"], "AUDIT_UNAVAILABLE");
        drop(request_tx);
        dispatcher.await.expect("failing dispatcher joins");
        let failing_audit_text = fs::read_to_string(failing_audit.path()).unwrap_or_default();
        assert!(
            failing_audit_text
                .lines()
                .filter(|line| line.contains("req_git_log_audit_fail"))
                .all(|line| !line.contains("artifact_spool_create"))
        );
        fs::remove_dir_all(failing_root).expect("failing audit root removed");

        let (audit, audit_root) = audit_sink("git-log-audit-success");
        let workspace = audit_root.with_extension("git-log-workspace");
        fs::create_dir_all(&workspace).expect("workspace created");
        test_git(&workspace, &["init", "-q"]);
        fs::write(workspace.join("tracked.txt"), "history fixture\n").expect("history file");
        test_git(&workspace, &["add", "tracked.txt"]);
        test_git(
            &workspace,
            &[
                "-c",
                "user.name=KodeGPT Test",
                "-c",
                "user.email=kodegpt@example.invalid",
                "commit",
                "-q",
                "-m",
                "history fixture",
            ],
        );

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
            "git_log_success",
        )
        .await;
        let response = next_response(
            &request_tx,
            &mut response_rx,
            "req_git_log_success",
            "git.log",
            json!({
                "capabilityId": capability_id,
                "revision": { "kind": "head" },
                "limit": 1
            }),
        )
        .await;
        assert_eq!(response["result"]["returnedCount"], 1);
        assert_eq!(
            response["result"]["commits"][0]["subject"],
            "history fixture"
        );

        drop(request_tx);
        dispatcher.await.expect("success dispatcher joins");
        let audit_text = fs::read_to_string(audit.path()).expect("audit readable");
        let top_level = audit_text
            .lines()
            .filter(|line| {
                line.contains("req_git_log_success")
                    && line.contains("\"action\":\"git_history_list\"")
            })
            .collect::<Vec<_>>();
        assert_eq!(top_level.len(), 2);
        assert_eq!(
            top_level
                .iter()
                .filter(|line| line.contains("\"phase\":\"decision\""))
                .count(),
            1
        );
        assert_eq!(
            top_level
                .iter()
                .filter(|line| line.contains("\"phase\":\"outcome\""))
                .count(),
            1
        );

        fs::remove_dir_all(workspace).expect("workspace removed");
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn git_diff_history_validates_bounds_and_audits_before_workspace_access() {
        let (audit, audit_root) = audit_sink("git-diff-history-validation");
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
        ));
        for (request_id, max_patch_bytes) in [
            ("req_git_diff_history_zero", 0_u32),
            ("req_git_diff_history_over", 262_145_u32),
        ] {
            let response = next_response(
                &request_tx,
                &mut response_rx,
                request_id,
                "git.diff_history",
                json!({
                    "capabilityId": "kc_intentionally_missing",
                    "baseRevision": { "kind": "head" },
                    "headRevision": { "kind": "head" },
                    "maxPatchBytes": max_patch_bytes
                }),
            )
            .await;
            assert_eq!(response["error"]["message"], "INVALID_PARAMS");
        }
        drop(request_tx);
        dispatcher.await.expect("validation dispatcher joins");
        let audit_text = fs::read_to_string(audit.path()).unwrap_or_default();
        assert!(!audit_text.contains("req_git_diff_history_zero"));
        assert!(!audit_text.contains("req_git_diff_history_over"));
        fs::remove_dir_all(audit_root).expect("validation audit root removed");

        let (failing_audit, failing_root) = audit_sink("git-diff-history-audit-fail");
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&failing_audit),
        ));
        failing_audit.inject_faults(AuditFaults {
            fail_next_decision: true,
            fail_next_outcome: false,
        });
        let response = next_response(
            &request_tx,
            &mut response_rx,
            "req_git_diff_history_audit_fail",
            "git.diff_history",
            json!({
                "capabilityId": "kc_intentionally_missing",
                "baseRevision": { "kind": "head" },
                "headRevision": { "kind": "head" },
                "maxPatchBytes": 65536
            }),
        )
        .await;
        assert_eq!(response["error"]["message"], "AUDIT_UNAVAILABLE");
        drop(request_tx);
        dispatcher.await.expect("audit-fail dispatcher joins");
        fs::remove_dir_all(failing_root).expect("audit-fail root removed");

        let (audit, audit_root) = audit_sink("git-diff-history-success");
        let workspace = audit_root.with_extension("git-diff-history-workspace");
        fs::create_dir_all(&workspace).expect("workspace created");
        test_git(&workspace, &["init", "-q"]);
        fs::write(workspace.join("tracked.txt"), "base\n").expect("base file");
        test_git(&workspace, &["add", "tracked.txt"]);
        test_git(
            &workspace,
            &[
                "-c",
                "user.name=KodeGPT Test",
                "-c",
                "user.email=kodegpt@example.invalid",
                "commit",
                "-q",
                "-m",
                "diff history base",
            ],
        );
        test_git(&workspace, &["tag", "diff-history-base"]);
        fs::write(workspace.join("tracked.txt"), "head\n").expect("head file");
        test_git(&workspace, &["add", "tracked.txt"]);
        test_git(
            &workspace,
            &[
                "-c",
                "user.name=KodeGPT Test",
                "-c",
                "user.email=kodegpt@example.invalid",
                "commit",
                "-q",
                "-m",
                "diff history head",
            ],
        );

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
            "git_diff_history_success",
        )
        .await;
        let response = next_response(
            &request_tx,
            &mut response_rx,
            "req_git_diff_history_success",
            "git.diff_history",
            json!({
                "capabilityId": capability_id,
                "baseRevision": { "kind": "tag", "name": "diff-history-base" },
                "headRevision": { "kind": "head" },
                "maxPatchBytes": 65536
            }),
        )
        .await;
        assert_eq!(response["result"]["changedPaths"][0]["path"], "tracked.txt");
        assert!(
            response["result"]["patch"]
                .as_str()
                .expect("patch string")
                .contains("+head")
        );

        drop(request_tx);
        dispatcher.await.expect("success dispatcher joins");
        let audit_text = fs::read_to_string(audit.path()).expect("audit readable");
        let top_level = audit_text
            .lines()
            .filter(|line| {
                line.contains("req_git_diff_history_success")
                    && line.contains("\"action\":\"git_history_diff\"")
            })
            .collect::<Vec<_>>();
        assert_eq!(top_level.len(), 2);
        assert_eq!(
            top_level
                .iter()
                .filter(|line| line.contains("\"phase\":\"decision\""))
                .count(),
            1
        );
        assert_eq!(
            top_level
                .iter()
                .filter(|line| line.contains("\"phase\":\"outcome\""))
                .count(),
            1
        );
        fs::remove_dir_all(workspace).expect("workspace removed");
        fs::remove_dir_all(audit_root).expect("success audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn git_range_validates_limit_and_audits_before_workspace_access() {
        let (audit, audit_root) = audit_sink("git-range-validation");
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
        ));
        for (request_id, limit) in [
            ("req_git_range_zero", 0_u16),
            ("req_git_range_over", 101_u16),
        ] {
            let response = next_response(
                &request_tx,
                &mut response_rx,
                request_id,
                "git.range",
                json!({
                    "capabilityId": "kc_intentionally_missing",
                    "baseRevision": { "kind": "head" },
                    "headRevision": { "kind": "head" },
                    "mode": "direct",
                    "limit": limit
                }),
            )
            .await;
            assert_eq!(response["error"]["message"], "INVALID_PARAMS");
        }
        drop(request_tx);
        dispatcher.await.expect("validation dispatcher joins");
        let audit_text = fs::read_to_string(audit.path()).unwrap_or_default();
        assert!(!audit_text.contains("req_git_range_zero"));
        assert!(!audit_text.contains("req_git_range_over"));
        fs::remove_dir_all(audit_root).expect("validation audit root removed");

        let (failing_audit, failing_root) = audit_sink("git-range-audit-fail");
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&failing_audit),
        ));
        failing_audit.inject_faults(AuditFaults {
            fail_next_decision: true,
            fail_next_outcome: false,
        });
        let response = next_response(
            &request_tx,
            &mut response_rx,
            "req_git_range_audit_fail",
            "git.range",
            json!({
                "capabilityId": "kc_intentionally_missing",
                "baseRevision": { "kind": "head" },
                "headRevision": { "kind": "head" },
                "mode": "direct",
                "limit": 50
            }),
        )
        .await;
        assert_eq!(response["error"]["message"], "AUDIT_UNAVAILABLE");
        drop(request_tx);
        dispatcher.await.expect("audit-fail dispatcher joins");
        fs::remove_dir_all(failing_root).expect("audit-fail root removed");

        let (audit, audit_root) = audit_sink("git-range-success");
        let workspace = audit_root.with_extension("git-range-workspace");
        fs::create_dir_all(&workspace).expect("workspace created");
        test_git(&workspace, &["init", "-q"]);
        fs::write(workspace.join("tracked.txt"), "base\n").expect("base file");
        test_git(&workspace, &["add", "tracked.txt"]);
        test_git(
            &workspace,
            &[
                "-c",
                "user.name=KodeGPT Test",
                "-c",
                "user.email=kodegpt@example.invalid",
                "commit",
                "-q",
                "-m",
                "range base",
            ],
        );
        test_git(&workspace, &["tag", "range-base"]);
        fs::write(workspace.join("tracked.txt"), "head\n").expect("head file");
        test_git(&workspace, &["add", "tracked.txt"]);
        test_git(
            &workspace,
            &[
                "-c",
                "user.name=KodeGPT Test",
                "-c",
                "user.email=kodegpt@example.invalid",
                "commit",
                "-q",
                "-m",
                "range head",
            ],
        );

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
            "git_range_success",
        )
        .await;
        let response = next_response(
            &request_tx,
            &mut response_rx,
            "req_git_range_success",
            "git.range",
            json!({
                "capabilityId": capability_id,
                "baseRevision": { "kind": "tag", "name": "range-base" },
                "headRevision": { "kind": "head" },
                "mode": "direct",
                "limit": 50
            }),
        )
        .await;
        assert_eq!(response["result"]["ahead"]["value"], 1);
        assert_eq!(response["result"]["behind"]["value"], 0);
        assert_eq!(response["result"]["returnedCount"], 1);

        drop(request_tx);
        dispatcher.await.expect("success dispatcher joins");
        let audit_text = fs::read_to_string(audit.path()).expect("audit readable");
        let top_level = audit_text
            .lines()
            .filter(|line| {
                line.contains("req_git_range_success")
                    && line.contains("\"action\":\"git_history_range\"")
            })
            .collect::<Vec<_>>();
        assert_eq!(top_level.len(), 2);
        fs::remove_dir_all(workspace).expect("workspace removed");
        fs::remove_dir_all(audit_root).expect("success audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn git_show_rejects_patch_bounds_before_audit_or_workspace_access() {
        let (audit, audit_root) = audit_sink("git-show-patch-bounds");
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
        ));

        for (request_id, max_patch_bytes) in [
            ("req_git_show_patch_zero", 0_u32),
            ("req_git_show_patch_over", 262_145_u32),
        ] {
            let response = next_response(
                &request_tx,
                &mut response_rx,
                request_id,
                "git.show",
                json!({
                    "capabilityId": "kc_intentionally_missing",
                    "revision": { "kind": "head" },
                    "includePatch": true,
                    "maxPatchBytes": max_patch_bytes
                }),
            )
            .await;
            assert_eq!(response["error"]["message"], "INVALID_PARAMS");
        }

        drop(request_tx);
        dispatcher.await.expect("dispatcher joins");
        let audit_text = fs::read_to_string(audit.path()).unwrap_or_default();
        assert!(!audit_text.contains("req_git_show_patch_zero"));
        assert!(!audit_text.contains("req_git_show_patch_over"));
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn git_show_audit_precedes_workspace_access_and_records_one_top_level_pair() {
        let (failing_audit, failing_root) = audit_sink("git-show-audit-fail");
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&failing_audit),
        ));
        failing_audit.inject_faults(AuditFaults {
            fail_next_decision: true,
            fail_next_outcome: false,
        });
        let response = next_response(
            &request_tx,
            &mut response_rx,
            "req_git_show_audit_fail",
            "git.show",
            json!({
                "capabilityId": "kc_intentionally_missing",
                "revision": { "kind": "head" },
                "includePatch": false,
                "maxPatchBytes": 65536
            }),
        )
        .await;
        assert_eq!(response["error"]["message"], "AUDIT_UNAVAILABLE");
        drop(request_tx);
        dispatcher.await.expect("failing dispatcher joins");
        fs::remove_dir_all(failing_root).expect("failing audit root removed");

        let (audit, audit_root) = audit_sink("git-show-audit-success");
        let workspace = audit_root.with_extension("git-show-workspace");
        fs::create_dir_all(&workspace).expect("workspace created");
        test_git(&workspace, &["init", "-q"]);
        fs::write(workspace.join("tracked.txt"), "show fixture\n").expect("show file");
        test_git(&workspace, &["add", "tracked.txt"]);
        test_git(
            &workspace,
            &[
                "-c",
                "user.name=KodeGPT Test",
                "-c",
                "user.email=kodegpt@example.invalid",
                "commit",
                "-q",
                "-m",
                "show fixture",
            ],
        );

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
            "git_show_success",
        )
        .await;
        let response = next_response(
            &request_tx,
            &mut response_rx,
            "req_git_show_success",
            "git.show",
            json!({
                "capabilityId": capability_id,
                "revision": { "kind": "head" },
                "includePatch": false,
                "maxPatchBytes": 65536
            }),
        )
        .await;
        assert_eq!(response["result"]["commit"]["subject"], "show fixture");
        assert_eq!(response["result"]["patch"], Value::Null);

        drop(request_tx);
        dispatcher.await.expect("success dispatcher joins");
        let audit_text = fs::read_to_string(audit.path()).expect("audit readable");
        let top_level = audit_text
            .lines()
            .filter(|line| {
                line.contains("req_git_show_success")
                    && line.contains("\"action\":\"git_commit_inspect\"")
            })
            .collect::<Vec<_>>();
        assert_eq!(top_level.len(), 2);
        assert_eq!(
            top_level
                .iter()
                .filter(|line| line.contains("\"phase\":\"decision\""))
                .count(),
            1
        );
        assert_eq!(
            top_level
                .iter()
                .filter(|line| line.contains("\"phase\":\"outcome\""))
                .count(),
            1
        );

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
    async fn skill_source_inspect_root_rejects_equal_ancestor_and_descendant_state_overlap() {
        let (audit, audit_root) = audit_sink("skill-source-inspect-overlap");
        let descendant = audit_root.join("skills-child");
        fs::create_dir_all(&descendant).expect("descendant fixture created");
        let ancestor = audit_root
            .parent()
            .expect("temporary root has parent")
            .to_path_buf();
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
        ));

        for (id, path) in [
            ("req_skill_source_equal", audit_root.clone()),
            ("req_skill_source_descendant", descendant),
            ("req_skill_source_ancestor", ancestor),
        ] {
            let response = next_response(
                &request_tx,
                &mut response_rx,
                id,
                "skill_source.inspect_root",
                json!({ "path": path.to_string_lossy() }),
            )
            .await;
            assert_eq!(response["error"]["message"], "SKILL_SOURCE_STATE_OVERLAP");
        }

        drop(request_tx);
        dispatcher.await.expect("dispatcher joins");
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn skill_source_inspect_root_returns_identity_and_is_audited_without_capability() {
        let (audit, audit_root) = audit_sink("skill-source-inspect-success");
        let source = audit_root.with_extension("skill-source-inspect-success-source");
        fs::create_dir_all(&source).expect("source created");
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
            "req_skill_source_inspect_success",
            "skill_source.inspect_root",
            json!({ "path": source.to_string_lossy() }),
        )
        .await;
        assert_eq!(
            response["result"]["canonicalRoot"],
            source.to_string_lossy().as_ref()
        );
        assert!(response["result"]["identity"]["inode"].as_str().is_some());
        assert!(response["result"].get("sourceCapabilityId").is_none());

        let audit_text = fs::read_to_string(audit.path()).expect("audit readable");
        assert!(audit_text.contains("skill_source_inspect_root"));
        assert!(!audit_text.contains(source.to_string_lossy().as_ref()));

        drop(request_tx);
        dispatcher.await.expect("dispatcher joins");
        fs::remove_dir_all(source).expect("source removed");
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn skill_source_inspect_root_fails_when_filesystem_boundary_is_unavailable() {
        let (audit, audit_root) = audit_sink("skill-source-boundary-unavailable");
        let source = audit_root.with_extension("skill-source-boundary-source");
        fs::create_dir_all(&source).expect("source created");
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher_with_boundary_status(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
            false,
        ));

        let response = next_response(
            &request_tx,
            &mut response_rx,
            "req_skill_source_boundary_unavailable",
            "skill_source.inspect_root",
            json!({ "path": source.to_string_lossy() }),
        )
        .await;
        assert_eq!(response["error"]["message"], "SKILL_SOURCE_UNAVAILABLE");

        drop(request_tx);
        dispatcher.await.expect("dispatcher joins");
        fs::remove_dir_all(source).expect("source removed");
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn skill_source_register_tree_read_and_unregister_use_private_retained_capability() {
        let (audit, audit_root) = audit_sink("skill-source-lifecycle");
        let source = audit_root.with_extension("skill-source");
        fs::create_dir_all(&source).expect("source created");
        fs::write(source.join("SKILL.md"), "source instructions").expect("source written");
        let identity = kodegpt_workspace_io::inspect_root(&source)
            .expect("source inspected")
            .identity;
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
        ));

        let registration = next_response(
            &request_tx,
            &mut response_rx,
            "req_skill_source_register",
            "skill_source.register",
            json!({
                "rootPath": source.to_string_lossy(),
                "expectedIdentity": identity
            }),
        )
        .await;
        let capability_id = registration["result"]["sourceCapabilityId"]
            .as_str()
            .expect("private source capability returned")
            .to_owned();
        assert!(capability_id.starts_with("sc_"));
        assert!(registration["result"].get("canonicalRoot").is_none());
        assert!(
            !registration
                .to_string()
                .contains(source.to_string_lossy().as_ref())
        );

        let tree = next_response(
            &request_tx,
            &mut response_rx,
            "req_skill_source_tree",
            "skill_source.tree",
            json!({
                "sourceCapabilityId": capability_id,
                "path": ".",
                "maxEntries": 20_000
            }),
        )
        .await;
        assert_eq!(tree["result"]["entries"][0]["path"], "SKILL.md");
        assert_eq!(tree["result"]["entries"][0]["sizeBytes"], 19);

        let read = next_response(
            &request_tx,
            &mut response_rx,
            "req_skill_source_read",
            "skill_source.read",
            json!({
                "sourceCapabilityId": capability_id,
                "path": "SKILL.md",
                "offset": 0,
                "maxBytes": 256
            }),
        )
        .await;
        assert_eq!(read["result"]["contents"], "source instructions");

        let unregistered = next_response(
            &request_tx,
            &mut response_rx,
            "req_skill_source_unregister",
            "skill_source.unregister",
            json!({ "sourceCapabilityId": capability_id }),
        )
        .await;
        assert_eq!(unregistered["result"]["ok"], true);

        let after = next_response(
            &request_tx,
            &mut response_rx,
            "req_skill_source_after_unregister",
            "skill_source.read",
            json!({
                "sourceCapabilityId": capability_id,
                "path": "SKILL.md",
                "offset": 0,
                "maxBytes": 256
            }),
        )
        .await;
        assert_eq!(after["error"]["message"], "SKILL_SOURCE_UNAVAILABLE");
        assert_eq!(after["error"]["data"]["code"], "SKILL_SOURCE_UNAVAILABLE");

        let audit_text = fs::read_to_string(audit.path()).expect("audit readable");
        for action in [
            "skill_source_register",
            "skill_source_tree",
            "skill_source_read",
            "skill_source_unregister",
        ] {
            assert!(audit_text.contains(action), "missing audit action {action}");
        }
        assert!(audit_text.contains(&capability_id));
        assert!(!audit_text.contains("source instructions"));
        assert!(!audit_text.contains(source.to_string_lossy().as_ref()));

        drop(request_tx);
        dispatcher.await.expect("dispatcher joins");
        fs::remove_dir_all(source).expect("source removed");
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn workspace_and_skill_source_capability_ids_are_not_interchangeable() {
        let (audit, audit_root) = audit_sink("skill-source-id-isolation");
        let workspace = audit_root.with_extension("id-workspace");
        let source = audit_root.with_extension("id-source");
        fs::create_dir_all(&workspace).expect("workspace created");
        fs::create_dir_all(&source).expect("source created");
        fs::write(workspace.join("workspace.txt"), "workspace").expect("workspace file written");
        fs::write(source.join("SKILL.md"), "source").expect("source file written");

        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
        ));
        let workspace_capability_id = register_ready_workspace(
            &request_tx,
            &mut response_rx,
            &workspace,
            observe_policy(),
            "skill_source_id_isolation",
        )
        .await;
        let source_identity = kodegpt_workspace_io::inspect_root(&source)
            .expect("source inspected")
            .identity;
        let source_registration = next_response(
            &request_tx,
            &mut response_rx,
            "req_skill_source_id_register",
            "skill_source.register",
            json!({
                "rootPath": source.to_string_lossy(),
                "expectedIdentity": source_identity
            }),
        )
        .await;
        let source_capability_id = source_registration["result"]["sourceCapabilityId"]
            .as_str()
            .expect("source capability returned")
            .to_owned();

        let workspace_read_with_source_id = next_response(
            &request_tx,
            &mut response_rx,
            "req_workspace_read_with_source_id",
            "file.read",
            json!({
                "capabilityId": source_capability_id,
                "path": "SKILL.md",
                "offset": 0,
                "maxBytes": 64
            }),
        )
        .await;
        assert_eq!(
            workspace_read_with_source_id["error"]["message"],
            "WORKSPACE_CAPABILITY_NOT_FOUND"
        );

        let workspace_write_with_source_id = next_response(
            &request_tx,
            &mut response_rx,
            "req_workspace_write_with_source_id",
            "file.write",
            json!({
                "capabilityId": source_capability_id,
                "path": "forbidden.txt",
                "content": "must not write"
            }),
        )
        .await;
        assert_eq!(
            workspace_write_with_source_id["error"]["message"],
            "WORKSPACE_CAPABILITY_NOT_FOUND"
        );
        assert!(!source.join("forbidden.txt").exists());

        let process_with_source_id = next_response(
            &request_tx,
            &mut response_rx,
            "req_process_with_source_id",
            "process.run",
            json!({
                "capabilityId": source_capability_id,
                "logicalExecutable": "node",
                "argv": ["--version"],
                "cwd": ".",
                "env": {},
                "background": false
            }),
        )
        .await;
        assert_eq!(
            process_with_source_id["error"]["message"],
            "WORKSPACE_CAPABILITY_NOT_FOUND"
        );

        let source_read_with_workspace_id = next_response(
            &request_tx,
            &mut response_rx,
            "req_source_read_with_workspace_id",
            "skill_source.read",
            json!({
                "sourceCapabilityId": workspace_capability_id,
                "path": "workspace.txt",
                "offset": 0,
                "maxBytes": 64
            }),
        )
        .await;
        assert_eq!(
            source_read_with_workspace_id["error"]["message"],
            "SKILL_SOURCE_UNAVAILABLE"
        );

        drop(request_tx);
        dispatcher.await.expect("dispatcher joins");
        fs::remove_dir_all(workspace).expect("workspace removed");
        fs::remove_dir_all(source).expect("source removed");
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn skill_source_base64_read_preserves_binary_bytes_without_content_in_audit() {
        let (audit, audit_root) = audit_sink("skill-source-base64-read");
        let source = audit_root.with_extension("skill-source-base64-source");
        fs::create_dir_all(source.join("assets")).expect("source assets created");
        fs::write(source.join("assets/binary.bin"), [0_u8, 255, 1, 128])
            .expect("binary source written");
        let identity = kodegpt_workspace_io::inspect_root(&source)
            .expect("source inspected")
            .identity;
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
        ));

        let registration = next_response(
            &request_tx,
            &mut response_rx,
            "req_skill_source_base64_register",
            "skill_source.register",
            json!({
                "rootPath": source.to_string_lossy(),
                "expectedIdentity": identity
            }),
        )
        .await;
        let source_capability_id = registration["result"]["sourceCapabilityId"]
            .as_str()
            .expect("source capability returned")
            .to_owned();

        let read = next_response(
            &request_tx,
            &mut response_rx,
            "req_skill_source_base64_read",
            "skill_source.read",
            json!({
                "sourceCapabilityId": source_capability_id,
                "path": "assets/binary.bin",
                "offset": 0,
                "maxBytes": 64,
                "encoding": "base64"
            }),
        )
        .await;
        assert_eq!(read["result"]["contentBase64"], "AP8BgA==");
        assert_eq!(read["result"]["bytesRead"], 4);
        assert_eq!(read["result"]["eof"], true);
        assert!(read["result"].get("contents").is_none());

        let audit_text = fs::read_to_string(audit.path()).expect("audit readable");
        assert!(!audit_text.contains("AP8BgA=="));
        assert!(!audit_text.contains("binary.bin"));

        drop(request_tx);
        dispatcher.await.expect("dispatcher joins");
        fs::remove_dir_all(source).expect("source removed");
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn skill_source_runtime_rejects_tree_and_read_limits_above_hard_caps() {
        let (audit, audit_root) = audit_sink("skill-source-hard-caps");
        let (request_tx, request_rx) = mpsc::unbounded_channel();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(run_dispatcher(
            request_rx,
            response_tx,
            false,
            Arc::clone(&audit),
        ));

        let tree = next_response(
            &request_tx,
            &mut response_rx,
            "req_skill_source_tree_over_limit",
            "skill_source.tree",
            json!({
                "sourceCapabilityId": "sc_fake",
                "path": ".",
                "maxEntries": 20_001
            }),
        )
        .await;
        assert_eq!(tree["error"]["message"], "INVALID_PARAMS");

        let read = next_response(
            &request_tx,
            &mut response_rx,
            "req_skill_source_read_over_limit",
            "skill_source.read",
            json!({
                "sourceCapabilityId": "sc_fake",
                "path": "SKILL.md",
                "offset": 0,
                "maxBytes": 1024 * 1024 + 1
            }),
        )
        .await;
        assert_eq!(read["error"]["message"], "INVALID_PARAMS");

        drop(request_tx);
        dispatcher.await.expect("dispatcher joins");
        fs::remove_dir_all(audit_root).expect("audit root removed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn skill_source_registration_stops_before_root_inspection_when_audit_decision_fails() {
        let audit_root = std::env::temp_dir().join(format!(
            "kodegpt-dispatcher-skill-source-audit-order-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&audit_root);
        let missing_source = audit_root.with_extension("missing-skill-source");
        let _ = fs::remove_dir_all(&missing_source);
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
            "req_skill_source_audit_order",
            "skill_source.register",
            json!({
                "rootPath": missing_source.to_string_lossy(),
                "expectedIdentity": {
                    "deviceMajor": 0,
                    "deviceMinor": 0,
                    "inode": "0"
                }
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
            json!({ "capabilityId": capability_id, "path": ".", "maxEntries": 2_000, "scope": "literal" }),
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
            json!({ "capabilityId": capability_id, "path": ".", "query": "needle", "maxMatches": 100, "scope": "literal" }),
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
