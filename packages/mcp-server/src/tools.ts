import {
  CiCancelInputSchema,
  CiDispatchInputSchema,
  CiFailureInputSchema,
  CiFailureResultSchema,
  CiMutationResultSchema,
  CiRepositoryInputSchema,
  CiRerunInputSchema,
  CiRepositoryResultSchema,
  CiRunInputSchema,
  CiRunResultSchema,
  CiRunsInputSchema,
  CiRunsResultSchema,
  CiStatusInputSchema,
  CiStatusResultSchema,
  CodeImpactInputSchema,
  CodeImpactResultSchema,
  CodeSearchInputSchema,
  CodeSearchResultSchema,
  ContextBuildInputSchema,
  ContextBuildResultSchema,
  FilePatchInputSchema,
  FilePatchResultSchema,
  GitChangesInputSchema,
  GitChangesResultSchema,
  GitHubIssueInspectInputSchema,
  GitHubIssueInspectResultSchema,
  GitHubIssueListInputSchema,
  GitHubIssueListResultSchema,
  GitHubPrCreateInputSchema,
  GitHubPrCreateResultSchema,
  GitHubPrInspectInputSchema,
  GitHubPrInspectResultSchema,
  GitHubPrListInputSchema,
  GitHubPrListResultSchema,
  GitHubPrMergeInputSchema,
  GitHubPrMergeResultSchema,
  GitHubRepositoryInspectInputSchema,
  GitHubRepositoryInspectResultSchema,
  GitStageInputSchema,
  GitCommitInputSchema,
  GitBranchInputSchema,
  GitLocalMutationResultSchema,
  GitWorktreeCreateInputSchema,
  GitWorktreeCreateResultSchema,
  GitWorktreeRemoveInputSchema,
  GitWorktreeRemoveResultSchema,
  GitRemoteInputSchema,
  GitRemoteMutationResultSchema,
  GitLogInputSchema,
  GitLogResultSchema,
  GitShowInputSchema,
  GitShowResultSchema,
  SourceStateRefSchema,
  GitRangeInputSchema,
  GitRangeResultSchema,
  GitDiffHistoryInputSchema,
  GitDiffHistoryResultSchema,
  VerifyListInputSchema,
  VerifyListResultSchema,
  VerifyRunInputSchema,
  VerifyRunResultSchema,
  WorkspaceInspectInputSchema,
  WorkspaceInspectResultSchema,
  listPublicActionDescriptors,
  toPublicCapabilityError
} from "@kodegpt/capabilities";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  SKILL_TOOL_LIST_MAX,
  SKILL_TOOL_LOAD_MAX_BYTES,
  SKILL_TOOL_LOAD_RESOURCE_MAX
} from "@kodegpt/skills/contracts";
import { SkillError } from "@kodegpt/skills/errors";
import {
  ConsoleStateStore,
  DEV_CONSOLE_RESOURCE_URI
} from "@kodegpt/dev-console";
import { z } from "zod";

import {
  BROWSER_CAPTURE_TOOL_ANNOTATIONS,
  BROWSER_INTERACTION_TOOL_ANNOTATIONS,
  BROWSER_READ_ONLY_TOOL_ANNOTATIONS,
  BROWSER_SESSION_TOOL_ANNOTATIONS,
  LOCAL_GIT_MUTATION_TOOL_ANNOTATIONS,
  MUTATING_FILE_TOOL_ANNOTATIONS,
  PROCESS_CANCEL_TOOL_ANNOTATIONS,
  REMOTE_CI_CANCEL_TOOL_ANNOTATIONS,
  REMOTE_CI_MUTATION_TOOL_ANNOTATIONS,
  REMOTE_CI_READ_ONLY_TOOL_ANNOTATIONS,
  REMOTE_GITHUB_CREATE_TOOL_ANNOTATIONS,
  REMOTE_GITHUB_MERGE_TOOL_ANNOTATIONS,
  REMOTE_GITHUB_READ_ONLY_TOOL_ANNOTATIONS,
  REMOTE_GIT_FETCH_TOOL_ANNOTATIONS,
  REMOTE_GIT_MUTATION_TOOL_ANNOTATIONS,
  PROCESS_RUN_TOOL_ANNOTATIONS,
  READ_ONLY_TOOL_ANNOTATIONS,
  WORKSPACE_LIFECYCLE_TOOL_ANNOTATIONS
} from "./annotations.js";
import type { KodegptToolContext } from "./tool-context.js";

const VISUAL_ARTIFACT_URI_SCHEMA = z.string().regex(/^artifact:\/\/ka_[A-Za-z0-9_-]{1,93}$/);
const VISUAL_MAX_PIXELS = 3840 * 2160;
const VISUAL_ARTIFACT_SCHEMA = z
  .object({
    schemaVersion: z.literal(1),
    uri: VISUAL_ARTIFACT_URI_SCHEMA,
    mediaType: z.literal("image/png"),
    sizeBytes: z.number().int().nonnegative().max(5 * 1024 * 1024).safe(),
    sourceTruncated: z.boolean()
  })
  .strict();
const VISUAL_DIMENSIONS_SCHEMA = z
  .object({
    width: z.number().int().positive().max(VISUAL_MAX_PIXELS).safe(),
    height: z.number().int().positive().max(VISUAL_MAX_PIXELS).safe()
  })
  .strict()
  .refine(({ width, height }) => width * height <= VISUAL_MAX_PIXELS);

export const VisualCaptureMatrixResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    previewId: z.string().regex(/^pv_[a-f0-9]{32}$/),
    sourceState: SourceStateRefSchema,
    captures: z.tuple([
      z
        .object({
          name: z.literal("mobile"),
          viewport: z.object({ width: z.literal(390), height: z.literal(844) }).strict(),
          artifact: VISUAL_ARTIFACT_SCHEMA
        })
        .strict(),
      z
        .object({
          name: z.literal("tablet"),
          viewport: z.object({ width: z.literal(768), height: z.literal(1024) }).strict(),
          artifact: VISUAL_ARTIFACT_SCHEMA
        })
        .strict(),
      z
        .object({
          name: z.literal("desktop"),
          viewport: z.object({ width: z.literal(1440), height: z.literal(900) }).strict(),
          artifact: VISUAL_ARTIFACT_SCHEMA
        })
        .strict()
    ])
  })
  .strict();

export const VisualCompareResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    previewId: z.string().regex(/^pv_[a-f0-9]{32}$/),
    sourceState: SourceStateRefSchema,
    currentArtifact: VISUAL_ARTIFACT_SCHEMA,
    referenceArtifact: VISUAL_ARTIFACT_URI_SCHEMA,
    currentDimensions: VISUAL_DIMENSIONS_SCHEMA,
    referenceDimensions: VISUAL_DIMENSIONS_SCHEMA,
    dimensionsMatch: z.boolean(),
    changedPixels: z.number().int().nonnegative().max(VISUAL_MAX_PIXELS).safe(),
    totalPixels: z.number().int().positive().max(VISUAL_MAX_PIXELS).safe(),
    changedPixelRatio: z.number().finite().min(0).max(1),
    threshold: z.number().finite().min(0).max(1),
    passed: z.boolean()
  })
  .strict();

function boundedUtf8String(maxBytes: number) {
  return z.string().refine((value) => Buffer.byteLength(value, "utf8") <= maxBytes, {
    message: `must be at most ${maxBytes} UTF-8 bytes`
  });
}

const PREVIEW_ID_SCHEMA = z.string().regex(/^pv_[a-f0-9]{32}$/);
const PREVIEW_URL_SCHEMA = z.string().regex(/^http:\/\/127\.0\.0\.1:\d{1,5}\//);
const BROWSER_VIEWPORT_SCHEMA = z
  .object({
    width: z.number().int().min(320).max(3840),
    height: z.number().int().min(240).max(2160)
  })
  .strict();
const PREVIEW_STATUS_RESULT_SCHEMA = z
  .object({
    schemaVersion: z.literal(1),
    previewId: PREVIEW_ID_SCHEMA,
    operationId: z.string().startsWith("op_"),
    url: PREVIEW_URL_SCHEMA,
    processState: z.enum(["running", "completed", "failed", "cancelled"]),
    exitCode: z.number().int().optional(),
    reachable: z.boolean(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    sourceState: SourceStateRefSchema
  })
  .strict();
const BROWSER_OPEN_RESULT_SCHEMA = z
  .object({
    schemaVersion: z.literal(1),
    previewId: PREVIEW_ID_SCHEMA,
    url: PREVIEW_URL_SCHEMA,
    viewport: BROWSER_VIEWPORT_SCHEMA,
    sourceState: SourceStateRefSchema
  })
  .strict();
const BROWSER_INSPECT_RESULT_SCHEMA = BROWSER_OPEN_RESULT_SCHEMA.safeExtend({
  title: boundedUtf8String(2048),
  bodyText: boundedUtf8String(32 * 1024),
  ariaSnapshot: boundedUtf8String(32 * 1024),
  truncated: z.boolean(),
  truncationReasons: z.array(z.string())
});
const BROWSER_ACTION_RESULT_SCHEMA = z
  .object({
    schemaVersion: z.literal(1),
    previewId: PREVIEW_ID_SCHEMA,
    ok: z.literal(true),
    sourceState: SourceStateRefSchema
  })
  .strict();
const BROWSER_SCREENSHOT_RESULT_SCHEMA = z
  .object({
    schemaVersion: z.literal(1),
    previewId: PREVIEW_ID_SCHEMA,
    artifact: VISUAL_ARTIFACT_SCHEMA,
    viewport: BROWSER_VIEWPORT_SCHEMA,
    sourceState: SourceStateRefSchema
  })
  .strict();
const BROWSER_CONSOLE_RESULT_SCHEMA = z
  .object({
    schemaVersion: z.literal(1),
    previewId: PREVIEW_ID_SCHEMA,
    entries: z
      .array(z.object({ level: boundedUtf8String(64), text: boundedUtf8String(2048) }).strict())
      .max(100),
    truncated: z.boolean(),
    sourceState: SourceStateRefSchema
  })
  .strict();
const BROWSER_NETWORK_FAILURES_RESULT_SCHEMA = z
  .object({
    schemaVersion: z.literal(1),
    previewId: PREVIEW_ID_SCHEMA,
    entries: z
      .array(
        z
          .object({
            method: boundedUtf8String(32),
            url: boundedUtf8String(2048),
            resourceType: boundedUtf8String(64),
            failureText: boundedUtf8String(2048)
          })
          .strict()
      )
      .max(100),
    truncated: z.boolean(),
    sourceState: SourceStateRefSchema
  })
  .strict();

const WORKSPACE_CHECKPOINT_EVIDENCE_SCHEMA = z
  .object({
    kind: z.enum(["artifact", "process", "preview", "pr", "ci", "git", "note"]),
    ref: boundedUtf8String(512).refine((value) => value.length > 0),
    summary: boundedUtf8String(1024).optional()
  })
  .strict();
const WORKSPACE_CHECKPOINT_BASELINE_SCHEMA = z
  .object({
    branch: z.string().optional(),
    headOid: z.string().regex(/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/).optional()
  })
  .strict();
const WORKSPACE_CHECKPOINT_BODY_SHAPE = {
  objective: boundedUtf8String(2 * 1024).optional(),
  status: z.enum(["active", "blocked", "complete"]),
  baseline: WORKSPACE_CHECKPOINT_BASELINE_SCHEMA.optional(),
  nextActions: z.array(boundedUtf8String(512)).max(8),
  evidenceRefs: z.array(WORKSPACE_CHECKPOINT_EVIDENCE_SCHEMA).max(16),
  blocker: boundedUtf8String(2 * 1024).optional(),
  notes: boundedUtf8String(4 * 1024).optional()
} as const;

function enforceWorkspaceCheckpointStatus(
  value: {
    status: "active" | "blocked" | "complete";
    nextActions: string[];
    blocker?: string;
  },
  context: z.RefinementCtx
): void {
  if (value.status === "blocked") {
    if (value.blocker === undefined || value.blocker.trim().length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blocker"],
        message: "blocked checkpoint requires a non-empty blocker"
      });
    }
  } else if (value.blocker !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["blocker"],
      message: "only blocked checkpoints may include blocker"
    });
  }
  if (value.status === "complete" && value.nextActions.length !== 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nextActions"],
      message: "complete checkpoint must have no next actions"
    });
  }
}

export const WorkspaceCheckpointBodySchema = z
  .object(WORKSPACE_CHECKPOINT_BODY_SHAPE)
  .strict()
  .superRefine(enforceWorkspaceCheckpointStatus);

export const WorkspaceCheckpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().positive().safe(),
    ...WORKSPACE_CHECKPOINT_BODY_SHAPE,
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict()
  .superRefine(enforceWorkspaceCheckpointStatus);

const WORKSPACE_SOURCE_STATE_SCHEMA = z
  .object({
    headOid: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    changesFingerprint: z.string().regex(/^[0-9a-f]{64}$/)
  })
  .strict();

const WORKSPACE_MILESTONE_SCHEMA = z
  .object({
    revision: z.number().int().positive().safe(),
    status: z.enum(["active", "blocked", "complete"]),
    objective: z.string().max(512).optional(),
    sourceState: WORKSPACE_SOURCE_STATE_SCHEMA.optional(),
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict();

const WORKSPACE_CONTINUITY_SCHEMA = z
  .object({
    schemaVersion: z.literal(1),
    capturedSourceState: WORKSPACE_SOURCE_STATE_SCHEMA.optional(),
    milestones: z.array(WORKSPACE_MILESTONE_SCHEMA).max(8)
  })
  .strict();

const WORKSPACE_EFFECTIVE_POLICY_SCHEMA = z
  .object({
    name: z.enum(["observe", "develop", "trusted"]),
    allowWrite: z.boolean(),
    allowProcess: z.boolean(),
    allowDynamicExecutables: z.boolean(),
    network: z.enum(["deny", "localhost", "allowlist", "unrestricted"]),
    allowedExecutableNames: z.array(z.string()),
    inheritEnv: z.literal(false),
    envAllowlist: z.array(z.string())
  })
  .strict();

export const WorkspaceInfoResultSchema = z
  .object({
    id: z.string().min(1),
    canonicalRoot: z.string().min(1),
    effectivePolicy: WORKSPACE_EFFECTIVE_POLICY_SCHEMA,
    checkpoint: WorkspaceCheckpointSchema.optional(),
    continuity: WORKSPACE_CONTINUITY_SCHEMA.optional()
  })
  .strict();

export const WorkspaceCheckpointInputSchema = z
  .object({
    workspaceId: z.string().min(1),
    operation: z.enum(["upsert", "clear"]),
    expectedRevision: z.number().int().positive().safe().optional(),
    checkpoint: WorkspaceCheckpointBodySchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operation === "upsert") {
      if (value.checkpoint === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["checkpoint"],
          message: "upsert requires checkpoint"
        });
      }
      return;
    }
    if (value.expectedRevision === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedRevision"],
        message: "clear requires expectedRevision"
      });
    }
    if (value.checkpoint !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["checkpoint"],
        message: "clear forbids checkpoint"
      });
    }
  });

export const WorkspaceCheckpointResultSchema = z.discriminatedUnion("operation", [
  z
    .object({
      schemaVersion: z.literal(1),
      operation: z.literal("upsert"),
      checkpoint: WorkspaceCheckpointSchema
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      operation: z.literal("clear"),
      cleared: z.literal(true)
    })
    .strict()
]);

const RESUME_RELATION_SCHEMA = z.enum(["fresh", "stale", "superseded", "unverifiable"]);
const RESUME_REASON_SCHEMA = z.enum([
  "SOURCE_STATE_MATCH",
  "WORKTREE_CHANGED",
  "HEAD_ADVANCED",
  "HEAD_REWOUND",
  "HEAD_DIVERGED",
  "LEGACY_SOURCE_STATE_UNKNOWN",
  "GIT_ANCESTRY_UNAVAILABLE"
]);
const RESUME_CHECKPOINT_STATE_SCHEMA = z
  .object({
    relation: RESUME_RELATION_SCHEMA,
    reasons: z.array(RESUME_REASON_SCHEMA).min(1).max(2),
    currentSourceState: WORKSPACE_SOURCE_STATE_SCHEMA.optional(),
    capturedSourceState: WORKSPACE_SOURCE_STATE_SCHEMA.optional()
  })
  .strict();
const RESUME_EVIDENCE_SCHEMA = z
  .object({
    kind: z.enum(["artifact", "process", "preview", "pr", "ci", "git", "note"]),
    ref: z.string().min(1).max(512),
    availability: z.enum(["observed", "missing", "unavailable", "invalid", "informational"]),
    state: z.string().max(256).optional(),
    relation: z.enum(["fresh", "stale", "unverifiable"]).optional(),
    reasons: z.array(z.string().min(1).max(128)).max(8).optional(),
    summary: z.string().max(1024).optional()
  })
  .strict();
export const ResumeSynthesisSchema = z.discriminatedUnion("checkpointPresent", [
  z
    .object({
      schemaVersion: z.literal(1),
      checkpointPresent: z.literal(false),
      milestones: z.tuple([]),
      evidence: z.tuple([]),
      warnings: z.array(z.string().max(256)).max(32)
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      checkpointPresent: z.literal(true),
      checkpoint: WorkspaceCheckpointSchema,
      checkpointState: RESUME_CHECKPOINT_STATE_SCHEMA,
      milestones: z.array(WORKSPACE_MILESTONE_SCHEMA).max(8),
      evidence: z.array(RESUME_EVIDENCE_SCHEMA).max(16),
      warnings: z.array(z.string().max(256)).max(32)
    })
    .strict()
]);

const CONTEXT_BUILD_RESULT_OBJECT_SCHEMA = ContextBuildResultSchema as unknown as z.ZodObject<any>;
export const ContextBuildToolResultSchema = CONTEXT_BUILD_RESULT_OBJECT_SCHEMA
  .extend({ resume: ResumeSynthesisSchema.optional() })
  .superRefine((value, context) => {
    if (value.intent === "resume" && value.resume === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resume"],
        message: "resume intent requires resume synthesis"
      });
    }
    if (value.intent !== "resume" && value.resume !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resume"],
        message: "resume synthesis is only valid for resume intent"
      });
    }
  });

export function listSurfaceTools(): Array<{ name: string; required: string[] }> {
  return listPublicActionDescriptors().map(({ id, requiredInputs }) => ({
    name: id,
    required: [...requiredInputs]
  }));
}

export function registerKodegptTools(
  server: McpServer,
  context: KodegptToolContext,
  consoleState = new ConsoleStateStore()
): void {
  server.registerTool(
    "console.state",
    {
      description: "Return the normalized KodeGPT Dev Console state without synchronously refreshing Git.",
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      _meta: { ui: { resourceUri: DEV_CONSOLE_RESOURCE_URI } }
    },
    async (requestContext) => {
      const [workspaces, health] = await Promise.all([
        context.workspace.list(),
        context.system.health()
      ]);
      const state = consoleState.snapshot({
        workspaces,
        health
      });
      const structuredContent = {
        ...state,
        host: { uiSupported: currentRequestSupportsUi(requestContext) }
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent
      };
    }
  );

  server.registerTool(
    "artifact.read",
    {
      description: "Read a bounded chunk from a KodeGPT artifact URI without exposing its host spool path.",
      inputSchema: {
        uri: z.string().regex(/^artifact:\/\/ka_[A-Za-z0-9_-]{1,93}$/),
        offset: z.number().int().nonnegative().safe().optional(),
        maxBytes: z.number().int().positive().max(1024 * 1024).safe().optional()
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ uri, offset, maxBytes }) =>
      structuredToolResult(await context.artifact.read({ uri, offset, maxBytes }))
  );

  const browserPreviewFields = {
    workspaceId: z.string().min(1),
    previewId: z.string().regex(/^pv_[a-f0-9]{32}$/)
  };
  const browserTargetSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("css"), selector: z.string().min(1).max(2048) }).strict(),
    z
      .object({
        kind: z.literal("role"),
        role: z.string().min(1).max(128),
        name: z.string().max(2048).optional()
      })
      .strict()
  ]);

  server.registerTool(
    "browser.openPreview",
    {
      description: "Open one ephemeral browser session bound only to an existing live KodeGPT preview origin.",
      inputSchema: {
        ...browserPreviewFields,
        viewport: z
          .object({
            width: z.number().int().min(320).max(3840),
            height: z.number().int().min(240).max(2160)
          })
          .strict()
          .optional()
      },
      outputSchema: BROWSER_OPEN_RESULT_SCHEMA,
      annotations: BROWSER_SESSION_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, previewId, viewport }) =>
      browserToolResult(() => context.browser.openPreview({ workspaceId, previewId, viewport }))
  );

  server.registerTool(
    "browser.inspect",
    {
      description: "Inspect bounded title, body text, accessibility snapshot, URL, and viewport evidence for one preview browser session.",
      inputSchema: browserPreviewFields,
      outputSchema: BROWSER_INSPECT_RESULT_SCHEMA,
      annotations: BROWSER_READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, previewId }) =>
      browserToolResult(() => context.browser.inspect({ workspaceId, previewId }))
  );

  server.registerTool(
    "browser.click",
    {
      description: "Click one bounded CSS or role target inside an existing preview-scoped browser session.",
      inputSchema: { ...browserPreviewFields, target: browserTargetSchema },
      outputSchema: BROWSER_ACTION_RESULT_SCHEMA,
      annotations: BROWSER_INTERACTION_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, previewId, target }) =>
      browserToolResult(() => context.browser.click({ workspaceId, previewId, target }))
  );

  server.registerTool(
    "browser.type",
    {
      description: "Fill one bounded CSS or role target inside an existing preview-scoped browser session.",
      inputSchema: {
        ...browserPreviewFields,
        target: browserTargetSchema,
        text: z.string().max(16 * 1024),
        submit: z.boolean().optional()
      },
      outputSchema: BROWSER_ACTION_RESULT_SCHEMA,
      annotations: BROWSER_INTERACTION_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, previewId, target, text, submit }) =>
      browserToolResult(() => context.browser.type({ workspaceId, previewId, target, text, submit }))
  );

  server.registerTool(
    "browser.screenshot",
    {
      description: "Capture one bounded PNG screenshot from an existing preview browser session into the normal artifact spool.",
      inputSchema: { ...browserPreviewFields, fullPage: z.boolean().optional() },
      outputSchema: BROWSER_SCREENSHOT_RESULT_SCHEMA,
      annotations: BROWSER_CAPTURE_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, previewId, fullPage }) =>
      browserToolResult(() => context.browser.screenshot({ workspaceId, previewId, fullPage }))
  );

  server.registerTool(
    "browser.console",
    {
      description: "Read bounded normalized console evidence from one existing preview browser session.",
      inputSchema: browserPreviewFields,
      outputSchema: BROWSER_CONSOLE_RESULT_SCHEMA,
      annotations: BROWSER_READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, previewId }) =>
      browserToolResult(() => context.browser.console({ workspaceId, previewId }))
  );

  server.registerTool(
    "browser.networkFailures",
    {
      description: "Read bounded redacted failed-request evidence from one existing preview browser session.",
      inputSchema: browserPreviewFields,
      outputSchema: BROWSER_NETWORK_FAILURES_RESULT_SCHEMA,
      annotations: BROWSER_READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, previewId }) =>
      browserToolResult(() => context.browser.networkFailures({ workspaceId, previewId }))
  );

  server.registerTool(
    "visual.captureMatrix",
    {
      description: "Capture the fixed mobile, tablet, and desktop viewport matrix through one existing preview browser session.",
      inputSchema: browserPreviewFields,
      outputSchema: VisualCaptureMatrixResultSchema,
      annotations: BROWSER_CAPTURE_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, previewId }) =>
      visualToolResult(async () =>
        VisualCaptureMatrixResultSchema.parse(
          await context.visual.captureMatrix({ workspaceId, previewId })
        )
      )
  );

  server.registerTool(
    "visual.compare",
    {
      description: "Capture the current preview viewport and compare it deterministically with one explicit PNG artifact reference.",
      inputSchema: {
        ...browserPreviewFields,
        referenceArtifact: VISUAL_ARTIFACT_URI_SCHEMA,
        threshold: z.number().finite().min(0).max(1).optional()
      },
      outputSchema: VisualCompareResultSchema,
      annotations: BROWSER_CAPTURE_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, previewId, referenceArtifact, threshold }) =>
      visualToolResult(async () =>
        VisualCompareResultSchema.parse(
          await context.visual.compare({ workspaceId, previewId, referenceArtifact, threshold })
        )
      )
  );

  server.registerTool(
    "ci.repository",
    {
      description: "Resolve the trusted workspace GitHub repository and report bounded read-only CI availability.",
      inputSchema: CiRepositoryInputSchema,
      outputSchema: CiRepositoryResultSchema,
      annotations: REMOTE_CI_READ_ONLY_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => {
        const value = CiRepositoryResultSchema.parse(await context.ci.repository(input));
        consoleState.recordCi(value);
        return value;
      })
  );

  server.registerTool(
    "ci.status",
    {
      description: "Observe bounded GitHub CI status evidence for a trusted workspace revision, with an optional bounded wait for terminal evidence.",
      inputSchema: CiStatusInputSchema,
      outputSchema: CiStatusResultSchema,
      annotations: REMOTE_CI_READ_ONLY_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => {
        const value = CiStatusResultSchema.parse(await context.ci.status(input));
        consoleState.recordCi(value);
        return value;
      })
  );

  server.registerTool(
    "ci.runs",
    {
      description: "List one bounded page of normalized GitHub CI runs for the trusted workspace repository.",
      inputSchema: CiRunsInputSchema,
      outputSchema: CiRunsResultSchema,
      annotations: REMOTE_CI_READ_ONLY_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => CiRunsResultSchema.parse(await context.ci.runs(input)))
  );

  server.registerTool(
    "ci.run",
    {
      description: "Inspect one bounded normalized GitHub CI run with jobs, steps, and annotations.",
      inputSchema: CiRunInputSchema,
      outputSchema: CiRunResultSchema,
      annotations: REMOTE_CI_READ_ONLY_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => {
        const value = CiRunResultSchema.parse(await context.ci.run(input));
        consoleState.recordCi(value);
        return value;
      })
  );

  server.registerTool(
    "ci.failure",
    {
      description: "Extract bounded redacted failure evidence for one GitHub CI run without exposing raw log URLs.",
      inputSchema: CiFailureInputSchema,
      outputSchema: CiFailureResultSchema,
      annotations: REMOTE_CI_READ_ONLY_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => {
        const value = CiFailureResultSchema.parse(await context.ci.failure(input));
        consoleState.recordCi(value);
        return value;
      })
  );

  server.registerTool(
    "ci.rerun",
    {
      description: "Re-run one GitHub Actions workflow run through bounded typed CI mutation authority.",
      inputSchema: CiRerunInputSchema,
      outputSchema: CiMutationResultSchema,
      annotations: REMOTE_CI_MUTATION_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => CiMutationResultSchema.parse(await context.ci.rerun(input)))
  );

  server.registerTool(
    "ci.cancel",
    {
      description: "Cancel one GitHub Actions workflow run through bounded typed CI mutation authority.",
      inputSchema: CiCancelInputSchema,
      outputSchema: CiMutationResultSchema,
      annotations: REMOTE_CI_CANCEL_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => CiMutationResultSchema.parse(await context.ci.cancel(input)))
  );

  server.registerTool(
    "ci.dispatch",
    {
      description: "Dispatch one configured GitHub Actions workflow through bounded typed CI mutation authority.",
      inputSchema: CiDispatchInputSchema,
      outputSchema: CiMutationResultSchema,
      annotations: REMOTE_CI_MUTATION_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => CiMutationResultSchema.parse(await context.ci.dispatch(input)))
  );

  server.registerTool(
    "github.repository.inspect",
    {
      description: "Inspect one bounded normalized GitHub repository through the admitted read-only provider.",
      inputSchema: GitHubRepositoryInspectInputSchema,
      outputSchema: GitHubRepositoryInspectResultSchema,
      annotations: REMOTE_GITHUB_READ_ONLY_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () =>
        GitHubRepositoryInspectResultSchema.parse(await context.github.repositoryInspect(input))
      )
  );

  server.registerTool(
    "github.pr.create",
    {
      description: "Create one bounded GitHub pull request through the separately admitted write provider.",
      inputSchema: GitHubPrCreateInputSchema,
      outputSchema: GitHubPrCreateResultSchema,
      annotations: REMOTE_GITHUB_CREATE_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => {
        const value = GitHubPrCreateResultSchema.parse(await context.github.prCreate(input));
        consoleState.recordPullRequest(value);
        return value;
      })
  );

  server.registerTool(
    "github.pr.inspect",
    {
      description: "Inspect one bounded normalized GitHub pull request through the admitted read-only provider.",
      inputSchema: GitHubPrInspectInputSchema,
      outputSchema: GitHubPrInspectResultSchema,
      annotations: REMOTE_GITHUB_READ_ONLY_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => {
        const value = GitHubPrInspectResultSchema.parse(await context.github.prInspect(input));
        consoleState.recordPullRequest(value);
        return value;
      })
  );

  server.registerTool(
    "github.pr.list",
    {
      description: "List one bounded normalized page of GitHub pull requests through the admitted read-only provider.",
      inputSchema: GitHubPrListInputSchema,
      outputSchema: GitHubPrListResultSchema,
      annotations: REMOTE_GITHUB_READ_ONLY_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => GitHubPrListResultSchema.parse(await context.github.prList(input)))
  );

  server.registerTool(
    "github.pr.merge",
    {
      description: "Merge one GitHub pull request only when its head matches the exact expected object ID.",
      inputSchema: GitHubPrMergeInputSchema,
      outputSchema: GitHubPrMergeResultSchema,
      annotations: REMOTE_GITHUB_MERGE_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () =>
        GitHubPrMergeResultSchema.parse(await context.github.prMerge(input))
      )
  );

  server.registerTool(
    "github.issue.inspect",
    {
      description: "Inspect one bounded normalized GitHub issue through the admitted read-only provider.",
      inputSchema: GitHubIssueInspectInputSchema,
      outputSchema: GitHubIssueInspectResultSchema,
      annotations: REMOTE_GITHUB_READ_ONLY_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () =>
        GitHubIssueInspectResultSchema.parse(await context.github.issueInspect(input))
      )
  );

  server.registerTool(
    "github.issue.list",
    {
      description: "List one bounded normalized page of GitHub issues through the admitted read-only provider.",
      inputSchema: GitHubIssueListInputSchema,
      outputSchema: GitHubIssueListResultSchema,
      annotations: REMOTE_GITHUB_READ_ONLY_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => GitHubIssueListResultSchema.parse(await context.github.issueList(input)))
  );

  server.registerTool(
    "workspace.list",
    {
      description: "List workspaces currently known to this KodeGPT process.",
      inputSchema: {},
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async () => structuredToolResult(await context.workspace.list())
  );

  server.registerTool(
    "trust.list",
    {
      description: "List durable trusted workspace records without exposing filesystem identity.",
      inputSchema: {},
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async () => structuredToolResult(await context.trust.list())
  );

  server.registerTool(
    "workspace.open",
    {
      description: "Open a locally trusted workspace. This tool cannot establish workspace trust.",
      inputSchema: { rootPath: z.string().min(1) },
      annotations: WORKSPACE_LIFECYCLE_TOOL_ANNOTATIONS
    },
    async ({ rootPath }) => structuredToolResult(await context.workspace.open({ rootPath }))
  );

  server.registerTool(
    "workspace.trust",
    {
      description: "Trust a local workspace path using locally derived persistent filesystem identity.",
      inputSchema: {
        rootPath: z.string().min(1),
        profile: z.enum(["observe", "develop", "trusted"]).optional()
      },
      annotations: WORKSPACE_LIFECYCLE_TOOL_ANNOTATIONS
    },
    async ({ rootPath, profile }) =>
      structuredToolResult(await context.workspace.trust({ rootPath, profile }))
  );

  server.registerTool(
    "workspace.untrust",
    {
      description: "Remove durable workspace trust and revoke active workspace authority when open.",
      inputSchema: { trustId: z.string().min(1) },
      annotations: WORKSPACE_LIFECYCLE_TOOL_ANNOTATIONS
    },
    async ({ trustId }) => structuredToolResult(await context.workspace.untrust({ trustId }))
  );

  server.registerTool(
    "workspace.close",
    {
      description: "Close a READY workspace and release its private runtime capability.",
      inputSchema: { workspaceId: z.string().min(1) },
      annotations: WORKSPACE_LIFECYCLE_TOOL_ANNOTATIONS
    },
    async ({ workspaceId }) => structuredToolResult(await context.workspace.close({ workspaceId }))
  );

  server.registerTool(
    "workspace.checkpoint",
    {
      description: "Create, compare-and-swap update, or clear one bounded development continuity checkpoint for a READY workspace.",
      inputSchema: WorkspaceCheckpointInputSchema,
      outputSchema: WorkspaceCheckpointResultSchema,
      annotations: WORKSPACE_LIFECYCLE_TOOL_ANNOTATIONS
    },
    async (input) =>
      checkpointToolResult(async () => {
        const value = WorkspaceCheckpointResultSchema.parse(
          await context.workspace.checkpoint(
            input.operation === "upsert"
              ? {
                  workspaceId: input.workspaceId,
                  operation: "upsert",
                  ...(input.expectedRevision === undefined
                    ? {}
                    : { expectedRevision: input.expectedRevision }),
                  checkpoint: input.checkpoint!
                }
              : {
                  workspaceId: input.workspaceId,
                  operation: "clear",
                  expectedRevision: input.expectedRevision!
                }
          )
        );
        consoleState.recordCheckpointResult(input.workspaceId, value);
        return value;
      })
  );

  server.registerTool(
    "workspace.info",
    {
      description: "Inspect public information and optional development continuity checkpoint for a READY workspace.",
      inputSchema: { workspaceId: z.string().min(1) },
      outputSchema: WorkspaceInfoResultSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId }) => {
      const value = WorkspaceInfoResultSchema.parse(await context.workspace.info({ workspaceId }));
      consoleState.recordWorkspaceInfo(workspaceId, value);
      return structuredToolResult(value);
    }
  );

  server.registerTool(
    "workspace.inspect",
    {
      description: "Build a bounded deterministic evidence-based map of a READY workspace.",
      inputSchema: WorkspaceInspectInputSchema,
      outputSchema: WorkspaceInspectResultSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, path, maxEntries }) =>
      nativeCapabilityResult(async () =>
        WorkspaceInspectResultSchema.parse(
          await context.workspace.inspect({ workspaceId, path, maxEntries })
        )
      )
  );

  server.registerTool(
    "code.search",
    {
      description: "Run bounded structured text, path, symbol, definition, or reference search.",
      inputSchema: CodeSearchInputSchema,
      outputSchema: CodeSearchResultSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, query, mode, path, maxResults, contextLines }) =>
      nativeCapabilityResult(async () =>
        CodeSearchResultSchema.parse(
          await context.code.search({ workspaceId, query, mode, path, maxResults, contextLines })
        )
      )
  );

  server.registerTool(
    "code.impact",
    {
      description: "Find bounded repository dependents, references, related tests, and affected areas for a file or symbol.",
      inputSchema: CodeImpactInputSchema,
      outputSchema: CodeImpactResultSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, target, kind, path, maxResults }) =>
      nativeCapabilityResult(async () =>
        CodeImpactResultSchema.parse(
          await context.code.impact({ workspaceId, target, kind, path, maxResults })
        )
      )
  );

  server.registerTool(
    "context.build",
    {
      description: "Build a deterministic bounded context bundle from existing workspace capabilities.",
      inputSchema: ContextBuildInputSchema,
      outputSchema: ContextBuildToolResultSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, intent, target, focus, maxBytes }) =>
      nativeCapabilityResult(async () => {
        const value = ContextBuildToolResultSchema.parse(
          await context.context.build({ workspaceId, intent, target, focus, maxBytes })
        );
        consoleState.recordContextBuild(workspaceId, value);
        return value;
      })
  );

  server.registerTool(
    "file.edit",
    {
      description:
        "Replace exact UTF-8 text beneath a READY writable workspace when the expected replacement count matches.",
      inputSchema: {
        workspaceId: z.string().min(1),
        path: z.string().min(1),
        oldText: z.string().min(1),
        newText: z.string(),
        expectedReplacements: z.number().int().nonnegative().safe()
      },
      annotations: MUTATING_FILE_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, path, oldText, newText, expectedReplacements }) =>
      structuredToolResult(
        await context.workspace.editFile({
          workspaceId,
          path,
          oldText,
          newText,
          expectedReplacements
        })
      )
  );

  server.registerTool(
    "file.patch",
    {
      description:
        "Check or apply a bounded unified text patch with full preflight and conditional per-file commits.",
      inputSchema: FilePatchInputSchema,
      outputSchema: FilePatchResultSchema,
      annotations: MUTATING_FILE_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, patch, mode }) =>
      nativeCapabilityResult(async () =>
        FilePatchResultSchema.parse(await context.file.patch({ workspaceId, patch, mode }))
      )
  );

  server.registerTool(
    "file.read",
    {
      description: "Read bounded UTF-8 file content beneath a READY workspace retained root.",
      inputSchema: {
        workspaceId: z.string().min(1),
        path: z.string().min(1),
        offset: z.number().int().nonnegative().optional(),
        maxBytes: z.number().int().nonnegative().max(1024 * 1024).optional()
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, path, offset, maxBytes }) =>
      structuredToolResult(await context.workspace.readFile({ workspaceId, path, offset, maxBytes }))
  );

  server.registerTool(
    "file.tree",
    {
      description: "List the deterministic bounded tree beneath a READY workspace retained root.",
      inputSchema: {
        workspaceId: z.string().min(1),
        path: z.string().min(1).optional()
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, path }) =>
      structuredToolResult(await context.workspace.tree({ workspaceId, path }))
  );

  server.registerTool(
    "file.write",
    {
      description: "Atomically create or replace UTF-8 file content beneath a READY writable workspace, with optional missing-or-SHA-256 preconditions.",
      inputSchema: {
        workspaceId: z.string().min(1),
        path: z.string().min(1),
        content: z.string(),
        precondition: z
          .discriminatedUnion("kind", [
            z.object({ kind: z.literal("missing") }).strict(),
            z.object({ kind: z.literal("sha256"), value: z.string().regex(/^[0-9a-f]{64}$/) }).strict()
          ])
          .optional()
      },
      annotations: MUTATING_FILE_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, path, content, precondition }) =>
      structuredToolResult(await context.workspace.writeFile({ workspaceId, path, content, precondition }))
  );

  server.registerTool(
    "git.changes",
    {
      description: "Return a compact deterministic checkpoint of normalized Git changes.",
      inputSchema: GitChangesInputSchema,
      outputSchema: GitChangesResultSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, includePatch }) =>
      nativeCapabilityResult(async () => {
        const value = GitChangesResultSchema.parse(await context.git.changes({ workspaceId, includePatch }));
        consoleState.recordGitStatus(workspaceId, value);
        return value;
      })
  );

  server.registerTool(
    "git.log",
    {
      description: "List a bounded structured local Git commit history for a READY workspace.",
      inputSchema: GitLogInputSchema,
      outputSchema: GitLogResultSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => GitLogResultSchema.parse(await context.git.log(input)))
  );

  server.registerTool(
    "git.show",
    {
      description: "Inspect one bounded historical Git commit for a READY workspace.",
      inputSchema: GitShowInputSchema,
      outputSchema: GitShowResultSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => GitShowResultSchema.parse(await context.git.show(input)))
  );

  server.registerTool(
    "git.range",
    {
      description: "Inspect bounded ancestry and commit ranges between two structured Git revisions.",
      inputSchema: GitRangeInputSchema,
      outputSchema: GitRangeResultSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => GitRangeResultSchema.parse(await context.git.range(input)))
  );

  server.registerTool(
    "git.diffHistory",
    {
      description: "Inspect a bounded historical diff between two structured Git revisions.",
      inputSchema: GitDiffHistoryInputSchema,
      outputSchema: GitDiffHistoryResultSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () =>
        GitDiffHistoryResultSchema.parse(await context.git.diffHistory(input))
      )
  );

  server.registerTool(
    "git.stage",
    {
      description: "Stage bounded workspace-relative paths through the trusted local Git workflow.",
      inputSchema: GitStageInputSchema,
      outputSchema: GitLocalMutationResultSchema,
      annotations: LOCAL_GIT_MUTATION_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => GitLocalMutationResultSchema.parse(await context.git.stage(input)))
  );

  server.registerTool(
    "git.commit",
    {
      description: "Create a local Git commit with a bounded message through trusted workspace authority.",
      inputSchema: GitCommitInputSchema,
      outputSchema: GitLocalMutationResultSchema,
      annotations: LOCAL_GIT_MUTATION_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => GitLocalMutationResultSchema.parse(await context.git.commit(input)))
  );

  server.registerTool(
    "git.branchCreate",
    {
      description: "Create a validated local Git branch through trusted workspace authority.",
      inputSchema: GitBranchInputSchema,
      outputSchema: GitLocalMutationResultSchema,
      annotations: LOCAL_GIT_MUTATION_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => GitLocalMutationResultSchema.parse(await context.git.branchCreate(input)))
  );

  server.registerTool(
    "git.branchSwitch",
    {
      description: "Switch to a validated existing local Git branch through trusted workspace authority.",
      inputSchema: GitBranchInputSchema,
      outputSchema: GitLocalMutationResultSchema,
      annotations: LOCAL_GIT_MUTATION_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => GitLocalMutationResultSchema.parse(await context.git.branchSwitch(input)))
  );

  server.registerTool(
    "git.branchDelete",
    {
      description: "Safely delete a validated merged local Git branch without force deletion.",
      inputSchema: GitBranchInputSchema,
      outputSchema: GitLocalMutationResultSchema,
      annotations: LOCAL_GIT_MUTATION_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => GitLocalMutationResultSchema.parse(await context.git.branchDelete(input)))
  );

  server.registerTool(
    "git.worktreeCreate",
    {
      description: "Create a bounded linked worktree at .worktrees/<name> for an existing local branch.",
      inputSchema: GitWorktreeCreateInputSchema,
      outputSchema: GitWorktreeCreateResultSchema,
      annotations: LOCAL_GIT_MUTATION_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => GitWorktreeCreateResultSchema.parse(await context.git.worktreeCreate(input)))
  );

  server.registerTool(
    "git.worktreeRemove",
    {
      description: "Remove a clean bounded linked worktree from .worktrees/<name> without deleting its branch.",
      inputSchema: GitWorktreeRemoveInputSchema,
      outputSchema: GitWorktreeRemoveResultSchema,
      annotations: LOCAL_GIT_MUTATION_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => GitWorktreeRemoveResultSchema.parse(await context.git.worktreeRemove(input)))
  );

  server.registerTool(
    "git.fetch",
    {
      description: "Fetch a validated branch from a named remote into its bounded remote-tracking ref.",
      inputSchema: GitRemoteInputSchema,
      outputSchema: GitRemoteMutationResultSchema,
      annotations: REMOTE_GIT_FETCH_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => GitRemoteMutationResultSchema.parse(await context.git.fetch(input)))
  );

  server.registerTool(
    "git.pull",
    {
      description: "Fetch and fast-forward only from a validated remote branch in a trusted workspace.",
      inputSchema: GitRemoteInputSchema,
      outputSchema: GitRemoteMutationResultSchema,
      annotations: REMOTE_GIT_MUTATION_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => GitRemoteMutationResultSchema.parse(await context.git.pull(input)))
  );

  server.registerTool(
    "git.push",
    {
      description: "Push a validated local branch to the same branch on a named remote without force.",
      inputSchema: GitRemoteInputSchema,
      outputSchema: GitRemoteMutationResultSchema,
      annotations: REMOTE_GIT_MUTATION_TOOL_ANNOTATIONS
    },
    async (input) =>
      nativeCapabilityResult(async () => GitRemoteMutationResultSchema.parse(await context.git.push(input)))
  );

  server.registerTool(
    "git.diff",
    {
      description: "Inspect the current workspace diff through hardened read-only Git.",
      inputSchema: { workspaceId: z.string().min(1) },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId }) => structuredToolResult(await context.git.diff({ workspaceId }))
  );

  server.registerTool(
    "git.status",
    {
      description: "Inspect the current workspace status through hardened read-only Git.",
      inputSchema: { workspaceId: z.string().min(1) },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId }) => {
      const value = await context.git.status({ workspaceId });
      consoleState.recordGitStatus(workspaceId, value);
      return structuredToolResult(value);
    }
  );

  server.registerTool(
    "verify.list",
    {
      description: "List safe verification recipes discovered from workspace manifests and current policy.",
      inputSchema: VerifyListInputSchema,
      outputSchema: VerifyListResultSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, target }) =>
      nativeCapabilityResult(async () =>
        VerifyListResultSchema.parse(
          await context.verify.list({ workspaceId, ...(target === undefined ? {} : { target }) })
        )
      )
  );

  server.registerTool(
    "verify.run",
    {
      description: "Run a currently allowed verification recipe through the retained-root process sandbox.",
      inputSchema: VerifyRunInputSchema,
      outputSchema: VerifyRunResultSchema,
      annotations: PROCESS_RUN_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, recipeId, background }) =>
      nativeCapabilityResult(async () => {
        const value = VerifyRunResultSchema.parse(
          await context.verify.run({ workspaceId, recipeId, background })
        );
        consoleState.recordProcessOperation(value.operation, value.workspaceId);
        consoleState.recordVerification(value);
        return value;
      })
  );

  server.registerTool(
    "process.run",
    {
      description: "Run a policy-approved logical executable directly in the retained-root sandbox; KodeGPT does not implicitly wrap it in a shell. On profiles that admit bash or sh, callers may explicitly run bash -lc or sh -lc. Structured tools remain preferred when they match the operation.",
      inputSchema: {
        workspaceId: z.string().min(1),
        logicalExecutable: z.string().min(1),
        argv: z.array(z.string()),
        cwd: z.string().min(1).optional(),
        env: z.record(z.string(), z.string()).optional(),
        background: z.boolean().optional()
      },
      annotations: PROCESS_RUN_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, logicalExecutable, argv, cwd, env, background }) => {
      const value = await context.process.run({
        workspaceId,
        logicalExecutable,
        argv,
        cwd,
        env,
        background
      });
      consoleState.recordProcessOperation(value, workspaceId);
      return structuredToolResult(value);
    }
  );

  server.registerTool(
    "process.status",
    {
      description: "Inspect a process operation by its opaque operation ID, optionally waiting for a bounded state update.",
      inputSchema: {
        workspaceId: z.string().min(1),
        operationId: z.string().startsWith("op_"),
        waitMs: z.number().int().min(0).max(30_000).optional()
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, operationId, waitMs }) => {
      const value = await context.process.status({ workspaceId, operationId, waitMs });
      consoleState.recordProcessOperation(value, workspaceId);
      return structuredToolResult(value);
    }
  );

  server.registerTool(
    "process.cancel",
    {
      description: "Cancel a process operation tree by its opaque operation ID.",
      inputSchema: {
        workspaceId: z.string().min(1),
        operationId: z.string().startsWith("op_")
      },
      annotations: PROCESS_CANCEL_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, operationId }) => {
      const value = await context.process.cancel({ workspaceId, operationId });
      consoleState.recordProcessOperation(value, workspaceId);
      return structuredToolResult(value);
    }
  );

  server.registerTool(
    "preview.start",
    {
      description: "Start a bounded workspace preview through existing background process authority and bind it to fixed loopback HTTP readiness evidence.",
      inputSchema: {
        workspaceId: z.string().min(1),
        logicalExecutable: z.string().min(1),
        argv: z.array(z.string()),
        port: z.number().int().min(1024).max(65_535).safe(),
        cwd: z.string().min(1).optional(),
        env: z.record(z.string(), z.string()).optional(),
        requestPath: z
          .string()
          .min(1)
          .refine((value) => isPreviewRequestPath(value), "Invalid preview request path")
          .optional(),
        waitMs: z.number().int().nonnegative().max(10_000).safe().optional()
      },
      outputSchema: PREVIEW_STATUS_RESULT_SCHEMA,
      annotations: PROCESS_RUN_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, logicalExecutable, argv, port, cwd, env, requestPath, waitMs }) =>
      previewToolResult(async () => {
        const value = await context.preview.start({
          workspaceId,
          logicalExecutable,
          argv,
          port,
          cwd,
          env,
          requestPath,
          waitMs
        });
        consoleState.recordPreview(workspaceId, value);
        return value;
      })
  );

  server.registerTool(
    "preview.inspect",
    {
      description: "Inspect process and fixed-loopback readiness state for one KodeGPT-owned preview.",
      inputSchema: {
        workspaceId: z.string().min(1),
        previewId: z.string().regex(/^pv_[a-f0-9]{32}$/)
      },
      outputSchema: PREVIEW_STATUS_RESULT_SCHEMA,
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, previewId }) =>
      previewToolResult(async () => {
        const value = await context.preview.inspect({ workspaceId, previewId });
        consoleState.recordPreview(workspaceId, value);
        return value;
      })
  );

  server.registerTool(
    "preview.stop",
    {
      description: "Stop one KodeGPT-owned preview through existing process cancellation authority.",
      inputSchema: {
        workspaceId: z.string().min(1),
        previewId: z.string().regex(/^pv_[a-f0-9]{32}$/)
      },
      outputSchema: PREVIEW_STATUS_RESULT_SCHEMA,
      annotations: PROCESS_CANCEL_TOOL_ANNOTATIONS
    },
    async ({ workspaceId, previewId }) =>
      previewToolResult(async () => {
        const value = await context.preview.stop({ workspaceId, previewId });
        consoleState.recordPreview(workspaceId, value);
        return value;
      })
  );

  server.registerTool(
    "profile.current",
    {
      description: "Return the effective monotonic policy for a READY workspace.",
      inputSchema: { workspaceId: z.string().min(1) },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ workspaceId }) => structuredToolResult(await context.profile.current({ workspaceId }))
  );

  server.registerTool(
    "profile.inspect",
    {
      description: "Inspect a built-in KodeGPT profile preset without changing workspace policy.",
      inputSchema: { name: z.enum(["observe", "develop", "trusted"]) },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ name }) => structuredToolResult(await context.profile.inspect({ name }))
  );

  server.registerTool(
    "skill.list",
    {
      description: "List bounded registered/pinned skill metadata with static/source compatibility; with workspaceId, additionally discover conventional Agent Skills beneath that READY workspace; query applies deterministic local relevance ranking without executing skills.",
      inputSchema: {
        limit: z.number().int().positive().max(SKILL_TOOL_LIST_MAX).safe().optional(),
        sourceId: z.string().regex(/^ss_[a-f0-9]{32}$/).optional(),
        compatibility: z.enum(["NATIVE", "PARTIAL", "PROVIDER_REQUIRED", "UNSUPPORTED"]).optional(),
        pinned: z.boolean().optional(),
        workspaceId: z.string().min(1).optional(),
        query: z.string().min(1).max(512).optional()
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ limit, sourceId, compatibility, pinned, workspaceId, query }) =>
      skillToolResult(() =>
        context.skill.list({ limit, sourceId, compatibility, pinned, workspaceId, query })
      )
  );

  server.registerTool(
    "skill.inspect",
    {
      description: "Inspect bounded skill metadata/resources and an advisory capability plan; with workspaceId, resolve workspace-aware external-CLI readiness against effective policy/executable/sandbox state without executing commands.",
      inputSchema: {
        skillId: z.string().regex(/^sk_[a-f0-9]{64}$/),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        workspaceId: z.string().min(1).optional()
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ skillId, fingerprint, workspaceId }) =>
      skillToolResult(() => context.skill.inspect({ skillId, fingerprint, workspaceId }))
  );

  server.registerTool(
    "skill.load",
    {
      description: "Load a bounded skill instruction body and explicitly requested UTF-8 resources as data/text only; workspace-local skills require the matching workspaceId and returned resources are not executed.",
      inputSchema: {
        skillId: z.string().regex(/^sk_[a-f0-9]{64}$/),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        resources: z.array(z.string().min(1)).max(SKILL_TOOL_LOAD_RESOURCE_MAX).optional(),
        maxBytes: z.number().int().positive().max(SKILL_TOOL_LOAD_MAX_BYTES).safe().optional(),
        workspaceId: z.string().min(1).optional()
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async ({ skillId, fingerprint, resources, maxBytes, workspaceId }) =>
      skillToolResult(() =>
        context.skill.load({ skillId, fingerprint, resources, maxBytes, workspaceId })
      )
  );

  server.registerTool(
    "system.capabilities",
    {
      description: "Report KodeGPT runtime/boundary state and derived public MCP tool-family inventory; operator-only CLI and private internals are not enumerated.",
      inputSchema: {},
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async () => structuredToolResult(await context.system.capabilities())
  );

  server.registerTool(
    "system.discover",
    {
      description: "Deterministically find relevant KodeGPT actions, Agent Skills, and declared workflow stages for an intent without executing them.",
      inputSchema: {
        query: z.string().min(1).max(512),
        workspaceId: z.string().min(1).optional(),
        limit: z.number().int().positive().max(20).safe().optional()
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async (input) => structuredToolResult(await context.system.discover(input))
  );

  server.registerTool(
    "system.health",
    {
      description: "Report KodeGPT process health without mutating host state.",
      inputSchema: {},
      annotations: READ_ONLY_TOOL_ANNOTATIONS
    },
    async () => structuredToolResult(await context.system.health())
  );
}

async function checkpointToolResult<T>(operation: () => Promise<T> | T) {
  try {
    return structuredToolResult(await operation());
  } catch (error) {
    if (
      isRecord(error) &&
      typeof error.code === "string" &&
      error.code.startsWith("CHECKPOINT_")
    ) {
      throw new Error(`${error.code}: Workspace checkpoint request failed`);
    }
    throw error;
  }
}

async function previewToolResult<T>(operation: () => Promise<T> | T) {
  try {
    return structuredToolResult(await operation());
  } catch (error) {
    if (isRecord(error) && typeof error.code === "string") {
      if (
        error.code === "PREVIEW_NOT_FOUND" ||
        error.code === "PREVIEW_LIMIT_REACHED" ||
        error.code === "PREVIEW_ENDPOINT_IN_USE"
      ) {
        throw new Error(`${error.code}: Preview request failed`);
      }
    }
    throw error;
  }
}

async function browserToolResult<T>(operation: () => Promise<T> | T) {
  try {
    return structuredToolResult(await operation());
  } catch (error) {
    if (isRecord(error) && typeof error.code === "string" && error.code.startsWith("BROWSER_")) {
      throw new Error(`${error.code}: Browser request failed`);
    }
    throw error;
  }
}

async function visualToolResult<T>(operation: () => Promise<T> | T) {
  try {
    return structuredToolResult(await operation());
  } catch (error) {
    if (isRecord(error) && typeof error.code === "string") {
      if (error.code.startsWith("VISUAL_")) {
        throw new Error(`${error.code}: Visual verification failed`);
      }
      if (error.code.startsWith("BROWSER_")) {
        throw new Error(`${error.code}: Browser request failed`);
      }
      if (error.code.startsWith("ARTIFACT_")) {
        throw new Error(`${error.code}: Artifact request failed`);
      }
    }
    throw error;
  }
}

async function skillToolResult<T>(operation: () => Promise<T>) {
  try {
    return structuredToolResult(await operation());
  } catch (error) {
    if (error instanceof SkillError) {
      throw new Error(`${error.code}: Skill request failed`);
    }
    throw new Error("SKILL_SOURCE_UNAVAILABLE: Skill request failed");
  }
}

async function nativeCapabilityResult<T>(operation: () => Promise<T>) {
  try {
    return structuredToolResult(await operation());
  } catch (error) {
    const safe = toPublicCapabilityError(error);
    const details = safe.details === undefined ? "" : ` ${JSON.stringify(safe.details)}`;
    throw new Error(`${safe.code}: ${safe.message}${details}`);
  }
}

export function structuredToolResult<T>(value: T) {
  const structuredContent = value ?? null;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent)
      }
    ],
    structuredContent
  };
}

function currentRequestSupportsUi(requestContext: unknown): boolean {
  if (!isRecord(requestContext) || !isRecord(requestContext.mcpReq)) return false;
  const envelope = requestContext.mcpReq.envelope;
  if (!isRecord(envelope)) return false;
  const clientCapabilities = envelope["io.modelcontextprotocol/clientCapabilities"];
  if (!isRecord(clientCapabilities)) return false;
  const extensions = clientCapabilities.extensions;
  if (!isRecord(extensions)) return false;
  const ui = extensions["io.modelcontextprotocol/ui"];
  return isRecord(ui) && Array.isArray(ui.mimeTypes) && ui.mimeTypes.includes("text/html;profile=mcp-app");
}

function isPreviewRequestPath(value: string): boolean {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    Buffer.byteLength(value, "utf8") > 2048 ||
    value.includes("#") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(value, "http://127.0.0.1");
    return `${parsed.pathname}${parsed.search}` === value;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
