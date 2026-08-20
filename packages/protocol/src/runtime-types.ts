import { z } from "zod";

export const RUNTIME_METHODS = [
  "runtime.hello",
  "system.inspect_root",
  "trust.audit",
  "workspace.checkpoint_audit",
  "ci.audit",
  "provider.audit",
  "workspace.register",
  "workspace.read_project_profile",
  "workspace.restrict_policy",
  "workspace.activate",
  "workspace.begin_close",
  "workspace.cancel_executions",
  "workspace.unregister",
  "file.read",
  "file.tree",
  "file.search",
  "file.identity",
  "file.write",
  "file.edit",
  "file.commit_patch_file",
  "git.repository_identity",
  "git.status",
  "git.checkpoint",
  "git.checkpoint_patch",
  "git.diff",
  "git.local_mutation",
  "git.worktree_mutation",
  "git.remote_mutation",
  "git.log",
  "git.show",
  "git.range",
  "git.diff_history",
  "process.inspect_executable",
  "process.run",
  "verify.run",
  "process.status",
  "process.cancel",
  "artifact.read",
  "skill_source.inspect_root",
  "skill_source.register",
  "skill_source.tree",
  "skill_source.read",
  "skill_source.unregister"
] as const;

export type RuntimeMethod = (typeof RUNTIME_METHODS)[number];

export const persistentFilesystemIdentitySchema = z
  .object({
    deviceMajor: z.number().int().nonnegative(),
    deviceMinor: z.number().int().nonnegative(),
    inode: z.string().min(1)
  })
  .strict();

export const runtimePolicySchema = z
  .object({
    name: z.enum(["observe", "develop", "trusted"]),
    allowWrite: z.boolean(),
    allowProcess: z.boolean(),
    allowDynamicExecutables: z.boolean(),
    network: z.enum(["deny", "localhost", "allowlist", "unrestricted"]),
    allowedExecutableNames: z.array(z.string().min(1)),
    inheritEnv: z.literal(false),
    envAllowlist: z.array(z.string())
  })
  .strict();

const runtimeHelloParamsSchema = z.object({}).strict();

const systemInspectRootParamsSchema = z
  .object({
    path: z.string().min(1)
  })
  .strict();

const trustAuditParamsSchema = z
  .object({
    operationId: z.string().regex(/^op_[A-Za-z0-9_-]{1,93}$/),
    action: z.enum(["trust", "profile_update", "untrust"]),
    phase: z.enum(["decision", "success", "failed"])
  })
  .strict();

const workspaceCheckpointAuditParamsSchema = z
  .object({
    operationId: z.string().regex(/^op_[A-Za-z0-9_-]{1,93}$/),
    action: z.enum(["upsert", "clear"]),
    phase: z.enum(["decision", "success", "failed"])
  })
  .strict();

const ciAuditParamsSchema = z
  .object({
    capabilityId: z.string().min(1),
    operationId: z.string().regex(/^op_[A-Za-z0-9_-]{1,93}$/),
    ciCapability: z.enum(["ci.repository", "ci.status", "ci.runs", "ci.run", "ci.failure"]),
    phase: z.enum(["decision", "success", "failed"]),
    provider: z.literal("github"),
    repository: z
      .string()
      .min(3)
      .max(201)
      .refine((value) => value.split("/").length === 2 && value.split("/").every((part) => part.length >= 1 && part.length <= 100 && !/[\u0000-\u001f\u007f:@]/.test(part))),
    credentialSource: z.literal("gh").optional(),
    runId: z.string().regex(/^[0-9]{1,32}$/).optional(),
    jobId: z.string().regex(/^[0-9]{1,32}$/).optional(),
    errorCode: z
      .enum([
        "CI_WORKSPACE_AMBIGUOUS",
        "CI_AUDIT_UNAVAILABLE",
        "CI_AUTH_REQUIRED",
        "CI_AUTH_FAILED",
        "CI_REPOSITORY_UNAVAILABLE",
        "CI_REPOSITORY_MISMATCH",
        "CI_REMOTE_UNSUPPORTED",
        "CI_NOT_FOUND",
        "CI_PERMISSION_DENIED",
        "CI_RATE_LIMITED",
        "CI_PROVIDER_UNAVAILABLE",
        "CI_RESPONSE_INVALID",
        "CI_RESPONSE_LIMIT_EXCEEDED",
        "CI_LOG_UNAVAILABLE",
        "CI_LOG_LIMIT_EXCEEDED"
      ])
      .optional(),
    truncated: z.boolean().optional(),
    durationMs: z.number().int().nonnegative().safe().optional()
  })
  .strict();

const providerErrorCodeSchema = z.enum([
  "PROVIDER_INPUT_INVALID",
  "PROVIDER_STATE_INVALID",
  "PROVIDER_NOT_ADMITTED",
  "PROVIDER_DISABLED",
  "PROVIDER_IDENTITY_CHANGED",
  "PROVIDER_CREDENTIAL_UNAVAILABLE",
  "PROVIDER_CREDENTIAL_REJECTED",
  "PROVIDER_NETWORK_DENIED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_CANCELLED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_RESPONSE_INVALID",
  "PROVIDER_OUTPUT_LIMIT_EXCEEDED",
  "PROVIDER_TOOL_UNAVAILABLE",
  "PROVIDER_INVENTORY_CHANGED",
  "PROVIDER_REQUEST_FAILED",
  "PROVIDER_AUDIT_UNAVAILABLE"
]);

const providerAuthorityIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/);

const providerAuditParamsSchema = z
  .object({
    operationId: z.string().regex(/^op_[A-Za-z0-9_-]{1,93}$/),
    operation: z.enum(["add", "remove", "enable", "disable", "reapprove", "execute", "inventory"]),
    phase: z.enum(["decision", "success", "failed"]),
    providerInstanceId: z.string().regex(/^prv_[0-9a-f]{32}$/),
    adapterId: providerAuthorityIdSchema,
    semanticCapabilityId: providerAuthorityIdSchema.optional(),
    errorCode: providerErrorCodeSchema.optional(),
    inventoryChanged: z.boolean().optional(),
    truncated: z.boolean().optional(),
    durationMs: z.number().int().nonnegative().max(86_400_000).safe().optional()
  })
  .strict();

const workspaceRegisterParamsSchema = z
  .object({
    rootPath: z.string().min(1),
    expectedIdentity: persistentFilesystemIdentitySchema,
    ceiling: runtimePolicySchema
  })
  .strict();

const workspaceRestrictPolicyParamsSchema = z
  .object({
    capabilityId: z.string().min(1),
    restriction: runtimePolicySchema
  })
  .strict();

const workspaceActivateParamsSchema = z
  .object({
    capabilityId: z.string().min(1)
  })
  .strict();

const workspaceCapabilityParamsSchema = z
  .object({
    capabilityId: z.string().min(1)
  })
  .strict();

const fileReadParamsSchema = z
  .object({
    capabilityId: z.string().min(1),
    path: z.string(),
    offset: z.number().int().nonnegative(),
    maxBytes: z.number().int().nonnegative()
  })
  .strict();

const workspaceTraversalScopeSchema = z.enum(["literal", "semantic"]);

const fileTreeParamsSchema = z
  .object({
    capabilityId: z.string().min(1),
    path: z.string(),
    maxEntries: z.number().int().positive().max(10_000).safe(),
    scope: workspaceTraversalScopeSchema
  })
  .strict();

const fileSearchParamsSchema = z
  .object({
    capabilityId: z.string().min(1),
    path: z.string(),
    query: z.string().min(1),
    maxMatches: z.number().int().positive().max(500).safe(),
    scope: workspaceTraversalScopeSchema
  })
  .strict();

const fileIdentityParamsSchema = z
  .object({
    capabilityId: z.string().min(1),
    path: z.string().min(1),
    includeSha256: z.boolean()
  })
  .strict();

const fileWriteParamsSchema = z
  .object({
    capabilityId: z.string().min(1),
    path: z.string().min(1),
    content: z.string()
  })
  .strict();

const fileEditParamsSchema = z
  .object({
    capabilityId: z.string().min(1),
    path: z.string().min(1),
    oldText: z.string().min(1),
    newText: z.string(),
    expectedReplacements: z.number().int().nonnegative()
  })
  .strict();

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const fileCommitPatchParamsSchema = z.discriminatedUnion("action", [
  z
    .object({
      capabilityId: z.string().min(1),
      path: z.string().min(1),
      action: z.literal("create"),
      expectedSha256: z.null(),
      content: z.string()
    })
    .strict(),
  z
    .object({
      capabilityId: z.string().min(1),
      path: z.string().min(1),
      action: z.literal("update"),
      expectedSha256: sha256Schema,
      content: z.string()
    })
    .strict(),
  z
    .object({
      capabilityId: z.string().min(1),
      path: z.string().min(1),
      action: z.literal("delete"),
      expectedSha256: sha256Schema,
      content: z.null()
    })
    .strict()
]);

const gitInspectionParamsSchema = z
  .object({
    capabilityId: z.string().min(1)
  })
  .strict();

const gitLocalMutationParamsSchema = z.discriminatedUnion("operation", [
  z
    .object({
      capabilityId: z.string().min(1),
      operation: z.literal("stage"),
      paths: z.array(z.string().min(1).max(4096)).min(1).max(128)
    })
    .strict(),
  z
    .object({
      capabilityId: z.string().min(1),
      operation: z.literal("commit"),
      message: z.string().min(1).max(4096).refine((value) => !value.includes("\0"))
    })
    .strict(),
  ...(["branch_create", "branch_switch", "branch_delete"] as const).map((operation) =>
    z
      .object({
        capabilityId: z.string().min(1),
        operation: z.literal(operation),
        name: z.string().min(1).max(255).refine((value) => !value.includes("\0"))
      })
      .strict()
  )
]);

const gitWorktreeMutationParamsSchema = z.discriminatedUnion("operation", [
  z
    .object({
      capabilityId: z.string().min(1),
      operation: z.literal("create"),
      name: z.string().min(1).max(64),
      branch: z.string().min(1).max(255)
    })
    .strict(),
  z
    .object({
      capabilityId: z.string().min(1),
      operation: z.literal("remove"),
      name: z.string().min(1).max(64)
    })
    .strict()
]);

const gitRemoteCredentialSchema = z.object({
  kind: z.literal("github_token"),
  token: z.string().min(1).max(4096).refine((value) => !/[\0\r\n]/.test(value))
}).strict();

const gitRemoteMutationBase = {
  capabilityId: z.string().min(1),
  remote: z.string().min(1).max(128).refine((value) => !value.includes("\0")),
  ref: z.string().min(1).max(255).refine((value) => !value.includes("\0")),
  credential: gitRemoteCredentialSchema.optional()
};

const gitRemoteMutationParamsSchema = z.discriminatedUnion("operation", [
  z.object({ ...gitRemoteMutationBase, operation: z.literal("fetch") }).strict(),
  z.object({ ...gitRemoteMutationBase, operation: z.literal("pull") }).strict(),
  z.object({ ...gitRemoteMutationBase, operation: z.literal("push") }).strict()
]);

const gitRevisionSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("head") }).strict(),
  z.object({ kind: z.literal("oid"), oid: z.string() }).strict(),
  z.object({ kind: z.literal("branch"), name: z.string() }).strict(),
  z.object({ kind: z.literal("tag"), name: z.string() }).strict()
]);

const gitLogParamsSchema = z
  .object({
    capabilityId: z.string().min(1),
    revision: gitRevisionSpecSchema,
    path: z.string().optional(),
    limit: z.number().int().nonnegative().max(0xffff).safe()
  })
  .strict();

const gitShowParamsSchema = z
  .object({
    capabilityId: z.string().min(1),
    revision: gitRevisionSpecSchema,
    path: z.string().optional(),
    includePatch: z.boolean(),
    maxPatchBytes: z.number().int().nonnegative().max(0xffff_ffff).safe()
  })
  .strict();

const gitRangeParamsSchema = z
  .object({
    capabilityId: z.string().min(1),
    baseRevision: gitRevisionSpecSchema,
    headRevision: gitRevisionSpecSchema,
    mode: z.enum(["direct", "symmetric"]),
    limit: z.number().int().nonnegative().max(0xffff).safe()
  })
  .strict();

const gitDiffHistoryParamsSchema = z
  .object({
    capabilityId: z.string().min(1),
    baseRevision: gitRevisionSpecSchema,
    headRevision: gitRevisionSpecSchema,
    path: z.string().optional(),
    maxPatchBytes: z.number().int().nonnegative().max(0xffff_ffff).safe()
  })
  .strict();

const processInspectExecutableParamsSchema = z
  .object({
    capabilityId: z.string().min(1),
    logicalExecutable: z.string().min(1)
  })
  .strict();

const processRunParamsSchema = z
  .object({
    capabilityId: z.string().min(1),
    logicalExecutable: z.string().min(1),
    argv: z.array(z.string()),
    cwd: z.string(),
    env: z.record(z.string(), z.string()),
    background: z.boolean()
  })
  .strict();

const verifyRunParamsSchema = z
  .object({
    capabilityId: z.string().min(1),
    recipeId: z.string().min(1),
    logicalExecutable: z.string().min(1),
    argv: z.array(z.string()),
    cwd: z.string(),
    background: z.boolean()
  })
  .strict();

const processOperationParamsSchema = z
  .object({
    capabilityId: z.string().min(1),
    operationId: z.string().min(1)
  })
  .strict();

const artifactReadParamsSchema = z
  .object({
    artifactId: z.string().regex(/^ka_[A-Za-z0-9_-]{1,93}$/),
    offset: z.number().int().nonnegative().safe(),
    maxBytes: z.number().int().positive().max(1024 * 1024).safe()
  })
  .strict();

const skillSourceInspectRootParamsSchema = z
  .object({
    path: z.string().min(1)
  })
  .strict();

const skillSourceRegisterParamsSchema = z
  .object({
    rootPath: z.string().min(1),
    expectedIdentity: persistentFilesystemIdentitySchema
  })
  .strict();

const skillSourceTreeParamsSchema = z
  .object({
    sourceCapabilityId: z.string().min(1),
    path: z.string(),
    maxEntries: z.number().int().positive().max(20_000).safe()
  })
  .strict();

const skillSourceReadParamsSchema = z
  .object({
    sourceCapabilityId: z.string().min(1),
    path: z.string(),
    offset: z.number().int().nonnegative().safe(),
    maxBytes: z.number().int().positive().max(1024 * 1024).safe(),
    encoding: z.literal("base64").optional()
  })
  .strict();

const skillSourceCapabilityParamsSchema = z
  .object({
    sourceCapabilityId: z.string().min(1)
  })
  .strict();

function requestSchema<M extends RuntimeMethod, P extends z.ZodType>(method: M, params: P) {
  return z
    .object({
      jsonrpc: z.literal("2.0"),
      id: z.string().min(1),
      method: z.literal(method),
      params
    })
    .strict();
}

export const runtimeRequestSchema = z.discriminatedUnion("method", [
  requestSchema("runtime.hello", runtimeHelloParamsSchema),
  requestSchema("system.inspect_root", systemInspectRootParamsSchema),
  requestSchema("trust.audit", trustAuditParamsSchema),
  requestSchema("workspace.checkpoint_audit", workspaceCheckpointAuditParamsSchema),
  requestSchema("ci.audit", ciAuditParamsSchema),
  requestSchema("provider.audit", providerAuditParamsSchema),
  requestSchema("workspace.register", workspaceRegisterParamsSchema),
  requestSchema("workspace.read_project_profile", workspaceCapabilityParamsSchema),
  requestSchema("workspace.restrict_policy", workspaceRestrictPolicyParamsSchema),
  requestSchema("workspace.activate", workspaceActivateParamsSchema),
  requestSchema("workspace.begin_close", workspaceCapabilityParamsSchema),
  requestSchema("workspace.cancel_executions", workspaceCapabilityParamsSchema),
  requestSchema("workspace.unregister", workspaceCapabilityParamsSchema),
  requestSchema("file.read", fileReadParamsSchema),
  requestSchema("file.tree", fileTreeParamsSchema),
  requestSchema("file.search", fileSearchParamsSchema),
  requestSchema("file.identity", fileIdentityParamsSchema),
  requestSchema("file.write", fileWriteParamsSchema),
  requestSchema("file.edit", fileEditParamsSchema),
  requestSchema("file.commit_patch_file", fileCommitPatchParamsSchema),
  requestSchema("git.repository_identity", gitInspectionParamsSchema),
  requestSchema("git.status", gitInspectionParamsSchema),
  requestSchema("git.checkpoint", gitInspectionParamsSchema),
  requestSchema("git.checkpoint_patch", gitInspectionParamsSchema),
  requestSchema("git.diff", gitInspectionParamsSchema),
  requestSchema("git.local_mutation", gitLocalMutationParamsSchema),
  requestSchema("git.worktree_mutation", gitWorktreeMutationParamsSchema),
  requestSchema("git.remote_mutation", gitRemoteMutationParamsSchema),
  requestSchema("git.log", gitLogParamsSchema),
  requestSchema("git.show", gitShowParamsSchema),
  requestSchema("git.range", gitRangeParamsSchema),
  requestSchema("git.diff_history", gitDiffHistoryParamsSchema),
  requestSchema("process.inspect_executable", processInspectExecutableParamsSchema),
  requestSchema("process.run", processRunParamsSchema),
  requestSchema("verify.run", verifyRunParamsSchema),
  requestSchema("process.status", processOperationParamsSchema),
  requestSchema("process.cancel", processOperationParamsSchema),
  requestSchema("artifact.read", artifactReadParamsSchema),
  requestSchema("skill_source.inspect_root", skillSourceInspectRootParamsSchema),
  requestSchema("skill_source.register", skillSourceRegisterParamsSchema),
  requestSchema("skill_source.tree", skillSourceTreeParamsSchema),
  requestSchema("skill_source.read", skillSourceReadParamsSchema),
  requestSchema("skill_source.unregister", skillSourceCapabilityParamsSchema)
]);

export type RuntimeRequest = z.infer<typeof runtimeRequestSchema>;
export type PersistentFilesystemIdentity = z.infer<typeof persistentFilesystemIdentitySchema>;
export type RuntimePolicy = z.infer<typeof runtimePolicySchema>;

export interface RuntimeSuccessResponse<T> {
  jsonrpc: "2.0";
  id: string;
  result: T;
}

export interface RuntimeRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RuntimeErrorResponse {
  jsonrpc: "2.0";
  id: string | null;
  error: RuntimeRpcError;
}

export type RuntimeResponse<T> = RuntimeSuccessResponse<T> | RuntimeErrorResponse;

export function parseRuntimeRequest(value: unknown): RuntimeRequest {
  return runtimeRequestSchema.parse(value);
}
