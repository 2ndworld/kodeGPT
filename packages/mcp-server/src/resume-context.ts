import type {
  CiRepositoryResult,
  CiRunInput,
  CiRunResult,
  ContextBuildResult,
  GitHubPrInspectInput,
  GitHubPrInspectResult,
  GitRangeInput,
  GitRangeResult
} from "@kodegpt/capabilities";
import type {
  PreviewLookupInput,
  PreviewStatusResult,
  WorkspaceCheckpointEvidenceKind,
  WorkspaceCheckpointSourceStateRef,
  WorkspaceInfo
} from "../../core/src/index.js";

export type ResumeRelation = "fresh" | "stale" | "superseded" | "unverifiable";

export type ResumeReason =
  | "SOURCE_STATE_MATCH"
  | "WORKTREE_CHANGED"
  | "HEAD_ADVANCED"
  | "HEAD_REWOUND"
  | "HEAD_DIVERGED"
  | "LEGACY_SOURCE_STATE_UNKNOWN"
  | "GIT_ANCESTRY_UNAVAILABLE";

export interface ResumeCheckpointSynthesis {
  relation: ResumeRelation;
  reasons: ResumeReason[];
  currentSourceState?: WorkspaceCheckpointSourceStateRef;
  capturedSourceState?: WorkspaceCheckpointSourceStateRef;
}

export type ResumeEvidenceAvailability =
  | "observed"
  | "missing"
  | "unavailable"
  | "invalid"
  | "informational";

export interface ResumeEvidenceObservation {
  kind: WorkspaceCheckpointEvidenceKind;
  ref: string;
  availability: ResumeEvidenceAvailability;
  state?: string;
  relation?: "fresh" | "stale" | "unverifiable";
  reasons?: string[];
  summary?: string;
}

export type ResumeSynthesis =
  | {
      schemaVersion: 1;
      checkpointPresent: false;
      milestones: [];
      evidence: [];
      warnings: string[];
    }
  | {
      schemaVersion: 1;
      checkpointPresent: true;
      checkpoint: NonNullable<WorkspaceInfo["checkpoint"]>;
      checkpointState: ResumeCheckpointSynthesis;
      milestones: NonNullable<WorkspaceInfo["continuity"]>["milestones"];
      evidence: ResumeEvidenceObservation[];
      warnings: string[];
    };

export interface ResumeAncestryAdapter {
  gitRange(input: GitRangeInput): Promise<GitRangeResult>;
}

export interface ResumeContextAdapter extends ResumeAncestryAdapter {
  workspaceInfo(workspaceId: string): Promise<WorkspaceInfo>;
  processStatus(
    workspaceId: string,
    operationId: string
  ): Promise<{ state: string }>;
  previewInspect(input: PreviewLookupInput): Promise<PreviewStatusResult>;
  repository(workspaceId: string): Promise<CiRepositoryResult>;
  prInspect(input: GitHubPrInspectInput): Promise<GitHubPrInspectResult>;
  ciRun(input: CiRunInput): Promise<CiRunResult>;
  artifactProbe(uri: string): Promise<void>;
}

export async function reconcileCheckpointSourceState(
  adapter: ResumeAncestryAdapter,
  workspaceId: string,
  captured: WorkspaceCheckpointSourceStateRef | undefined,
  current: WorkspaceCheckpointSourceStateRef
): Promise<ResumeCheckpointSynthesis> {
  if (captured === undefined) {
    return {
      relation: "unverifiable",
      reasons: ["LEGACY_SOURCE_STATE_UNKNOWN"],
      currentSourceState: { ...current }
    };
  }

  const shared = {
    capturedSourceState: { ...captured },
    currentSourceState: { ...current }
  };

  if (captured.headOid === current.headOid) {
    if (captured.changesFingerprint === current.changesFingerprint) {
      return { relation: "fresh", reasons: ["SOURCE_STATE_MATCH"], ...shared };
    }
    return { relation: "stale", reasons: ["WORKTREE_CHANGED"], ...shared };
  }

  try {
    const forward = await adapter.gitRange({
      workspaceId,
      baseRevision: { kind: "oid", oid: captured.headOid },
      headRevision: { kind: "oid", oid: current.headOid },
      mode: "direct"
    });
    if (forward.isAncestor) {
      return { relation: "stale", reasons: ["HEAD_ADVANCED"], ...shared };
    }

    const reverse = await adapter.gitRange({
      workspaceId,
      baseRevision: { kind: "oid", oid: current.headOid },
      headRevision: { kind: "oid", oid: captured.headOid },
      mode: "direct"
    });
    if (reverse.isAncestor) {
      return { relation: "superseded", reasons: ["HEAD_REWOUND"], ...shared };
    }
    return { relation: "superseded", reasons: ["HEAD_DIVERGED"], ...shared };
  } catch {
    return { relation: "unverifiable", reasons: ["GIT_ANCESTRY_UNAVAILABLE"], ...shared };
  }
}

export async function composeResumeSynthesis(
  adapter: ResumeContextAdapter,
  workspaceId: string,
  base: ContextBuildResult
): Promise<ResumeSynthesis> {
  const info = await adapter.workspaceInfo(workspaceId);
  const checkpoint = info.checkpoint;
  if (checkpoint === undefined) {
    return {
      schemaVersion: 1,
      checkpointPresent: false,
      milestones: [],
      evidence: [],
      warnings: []
    };
  }

  const currentSourceState = base.git?.sourceState;
  const capturedSourceState = info.continuity?.capturedSourceState;
  const warnings: string[] = [];
  const checkpointState =
    currentSourceState === undefined
      ? {
          relation: "unverifiable" as const,
          reasons: ["GIT_ANCESTRY_UNAVAILABLE" as const],
          ...(capturedSourceState === undefined
            ? {}
            : { capturedSourceState: { ...capturedSourceState } })
        }
      : await reconcileCheckpointSourceState(
          adapter,
          workspaceId,
          capturedSourceState,
          currentSourceState
        );
  if (currentSourceState === undefined) {
    warnings.push("resume-current-source-state-unavailable");
  }

  let repositoryPromise: Promise<CiRepositoryResult> | undefined;
  const getRepository = () => {
    repositoryPromise ??= adapter.repository(workspaceId);
    return repositoryPromise;
  };
  const evidence: ResumeEvidenceObservation[] = [];
  for (const reference of checkpoint.evidenceRefs) {
    evidence.push(
      await reconcileEvidenceReference(
        adapter,
        getRepository,
        workspaceId,
        reference,
        currentSourceState
      )
    );
  }

  return {
    schemaVersion: 1,
    checkpointPresent: true,
    checkpoint,
    checkpointState,
    milestones: info.continuity?.milestones ?? [],
    evidence,
    warnings
  };
}

async function reconcileEvidenceReference(
  adapter: ResumeContextAdapter,
  getRepository: () => Promise<CiRepositoryResult>,
  workspaceId: string,
  reference: NonNullable<WorkspaceInfo["checkpoint"]>["evidenceRefs"][number],
  currentSourceState: WorkspaceCheckpointSourceStateRef | undefined
): Promise<ResumeEvidenceObservation> {
  const base = {
    kind: reference.kind,
    ref: reference.ref,
    ...(reference.summary === undefined ? {} : { summary: reference.summary })
  };

  switch (reference.kind) {
    case "note":
      return { ...base, availability: "informational" };
    case "git":
      return FULL_GIT_OID_PATTERN.test(reference.ref)
        ? { ...base, availability: "informational" }
        : { ...base, availability: "invalid" };
    case "process": {
      if (!PROCESS_ID_PATTERN.test(reference.ref)) return { ...base, availability: "invalid" };
      try {
        const operation = await adapter.processStatus(workspaceId, reference.ref);
        return {
          ...base,
          availability: "observed",
          state: operation.state,
          relation: "unverifiable",
          reasons: ["PROCESS_SOURCE_STATE_UNAVAILABLE"]
        };
      } catch (error) {
        return { ...base, availability: classifyReadFailure(error) };
      }
    }
    case "preview": {
      if (!PREVIEW_ID_PATTERN.test(reference.ref)) return { ...base, availability: "invalid" };
      try {
        const preview = await adapter.previewInspect({ workspaceId, previewId: reference.ref });
        const sourceRelation = compareEvidenceSourceState(preview.sourceState, currentSourceState);
        return {
          ...base,
          availability: "observed",
          state: preview.processState,
          relation: sourceRelation.relation,
          reasons: sourceRelation.reasons
        };
      } catch (error) {
        return { ...base, availability: classifyReadFailure(error) };
      }
    }
    case "pr": {
      const number = parseCanonicalDecimalNumber(reference.ref);
      if (number === undefined) return { ...base, availability: "invalid" };
      try {
        const repository = await getRepository();
        const pullRequest = await adapter.prInspect({
          repository: repository.repository.fullName,
          number
        });
        return {
          ...base,
          availability: "observed",
          state: pullRequest.merged ? "merged" : pullRequest.state
        };
      } catch (error) {
        return { ...base, availability: classifyReadFailure(error) };
      }
    }
    case "ci": {
      if (!CANONICAL_DECIMAL_PATTERN.test(reference.ref)) {
        return { ...base, availability: "invalid" };
      }
      try {
        const result = await adapter.ciRun({ workspaceId, runId: reference.ref });
        const status = result.run.status;
        const conclusion = result.run.conclusion;
        const relation = compareHeadOid(result.run.headOid, currentSourceState);
        return {
          ...base,
          availability: "observed",
          state: `${status}/${conclusion ?? "PENDING"}`,
          relation
        };
      } catch (error) {
        return { ...base, availability: classifyReadFailure(error) };
      }
    }
    case "artifact": {
      if (!ARTIFACT_URI_PATTERN.test(reference.ref)) return { ...base, availability: "invalid" };
      try {
        await adapter.artifactProbe(reference.ref);
        return { ...base, availability: "observed" };
      } catch (error) {
        return { ...base, availability: classifyReadFailure(error) };
      }
    }
  }
}

const PROCESS_ID_PATTERN = /^op_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PREVIEW_ID_PATTERN = /^pv_[a-f0-9]{32}$/;
const FULL_GIT_OID_PATTERN = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const ARTIFACT_URI_PATTERN = /^artifact:\/\/\S+$/;
const CANONICAL_DECIMAL_PATTERN = /^[1-9][0-9]*$/;

function parseCanonicalDecimalNumber(value: string): number | undefined {
  if (!CANONICAL_DECIMAL_PATTERN.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function classifyReadFailure(error: unknown): "missing" | "unavailable" {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("missing") || message.includes("not found") || message.includes("expired")
    ? "missing"
    : "unavailable";
}

function compareEvidenceSourceState(
  evidence: WorkspaceCheckpointSourceStateRef,
  current: WorkspaceCheckpointSourceStateRef | undefined
): { relation: "fresh" | "stale" | "unverifiable"; reasons: string[] } {
  if (current === undefined) {
    return { relation: "unverifiable", reasons: ["CURRENT_SOURCE_STATE_UNAVAILABLE"] };
  }
  if (
    evidence.headOid === current.headOid &&
    evidence.changesFingerprint === current.changesFingerprint
  ) {
    return { relation: "fresh", reasons: ["SOURCE_STATE_MATCH"] };
  }
  return { relation: "stale", reasons: ["SOURCE_STATE_MISMATCH"] };
}

function compareHeadOid(
  headOid: string,
  current: WorkspaceCheckpointSourceStateRef | undefined
): "fresh" | "stale" | "unverifiable" {
  if (current === undefined) return "unverifiable";
  return headOid === current.headOid ? "fresh" : "stale";
}
