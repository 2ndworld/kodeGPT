use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InheritEnvDisabled;

impl Serialize for InheritEnvDisabled {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_bool(false)
    }
}

impl<'de> Deserialize<'de> for InheritEnvDisabled {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = bool::deserialize(deserializer)?;
        if value {
            return Err(D::Error::custom("inheritEnv must be false"));
        }
        Ok(Self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum JsonRpcVersion {
    #[serde(rename = "2.0")]
    V2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileName {
    Observe,
    Develop,
    Trusted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NetworkMode {
    Deny,
    Localhost,
    Allowlist,
    Unrestricted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersistentFilesystemIdentity {
    pub device_major: u32,
    pub device_minor: u32,
    pub inode: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimePolicy {
    pub name: ProfileName,
    pub allow_write: bool,
    pub allow_process: bool,
    pub network: NetworkMode,
    pub allowed_executable_names: Vec<String>,
    pub inherit_env: InheritEnvDisabled,
    pub env_allowlist: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeHelloParams {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SystemInspectRootParams {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRegisterParams {
    pub root_path: String,
    pub expected_identity: PersistentFilesystemIdentity,
    pub ceiling: RuntimePolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRestrictPolicyParams {
    pub capability_id: String,
    pub restriction: RuntimePolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceActivateParams {
    pub capability_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceCapabilityParams {
    pub capability_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileReadParams {
    pub capability_id: String,
    pub path: String,
    pub offset: u64,
    pub max_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessRunParams {
    pub capability_id: String,
    pub logical_executable: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub background: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "method", deny_unknown_fields)]
pub enum RuntimeRequest {
    #[serde(rename = "runtime.hello")]
    RuntimeHello {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: RuntimeHelloParams,
    },
    #[serde(rename = "system.inspect_root")]
    SystemInspectRoot {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: SystemInspectRootParams,
    },
    #[serde(rename = "workspace.register")]
    WorkspaceRegister {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: WorkspaceRegisterParams,
    },
    #[serde(rename = "workspace.read_project_profile")]
    WorkspaceReadProjectProfile {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: WorkspaceCapabilityParams,
    },
    #[serde(rename = "workspace.restrict_policy")]
    WorkspaceRestrictPolicy {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: WorkspaceRestrictPolicyParams,
    },
    #[serde(rename = "workspace.activate")]
    WorkspaceActivate {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: WorkspaceActivateParams,
    },
    #[serde(rename = "workspace.begin_close")]
    WorkspaceBeginClose {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: WorkspaceCapabilityParams,
    },
    #[serde(rename = "workspace.cancel_executions")]
    WorkspaceCancelExecutions {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: WorkspaceCapabilityParams,
    },
    #[serde(rename = "workspace.unregister")]
    WorkspaceUnregister {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: WorkspaceCapabilityParams,
    },
    #[serde(rename = "file.read")]
    FileRead {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: FileReadParams,
    },
    #[serde(rename = "process.run")]
    ProcessRun {
        jsonrpc: JsonRpcVersion,
        id: String,
        params: ProcessRunParams,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeSuccessResponse<T> {
    pub jsonrpc: JsonRpcVersion,
    pub id: String,
    pub result: T,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeRpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeErrorResponse {
    pub jsonrpc: JsonRpcVersion,
    pub id: Option<String>,
    pub error: RuntimeRpcError,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RuntimeResponse<T> {
    Success(RuntimeSuccessResponse<T>),
    Error(RuntimeErrorResponse),
}
