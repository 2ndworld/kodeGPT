import { z } from "zod";

export const RUNTIME_METHODS = [
  "runtime.hello",
  "system.inspect_root",
  "trust.audit",
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
  "git.status",
  "git.checkpoint",
  "git.checkpoint_patch",
  "git.diff",
  "git.local_mutation",
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

const gitRemoteMutationBase = {
  capabilityId: z.string().min(1),
  remote: z.string().min(1).max(128).refine((value) => !value.includes("\0")),
  ref: z.string().min(1).max(255).refine((value) => !value.includes("\0"))
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
  requestSchema("git.status", gitInspectionParamsSchema),
  requestSchema("git.checkpoint", gitInspectionParamsSchema),
  requestSchema("git.checkpoint_patch", gitInspectionParamsSchema),
  requestSchema("git.diff", gitInspectionParamsSchema),
  requestSchema("git.local_mutation", gitLocalMutationParamsSchema),
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
