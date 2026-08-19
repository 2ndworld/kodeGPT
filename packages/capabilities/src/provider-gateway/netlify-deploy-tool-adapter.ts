import { z } from "zod";

import type { GitChangesInput } from "../contracts.js";
import { CapabilityError } from "../errors.js";
import {
  resolveGitHubRepositoryIdentity,
  type GitRepositoryRemote
} from "../github-repository-identity.js";
import type { ProviderRegistryRecord } from "./contracts.js";
import {
  NETLIFY_DEPLOY_PROVIDER_ADAPTER_ID,
  NetlifyDeployCreateInputSchema,
  NetlifyDeployCreateResultSchema,
  NetlifyDeployInspectInputSchema,
  NetlifyDeployInspectResultSchema,
  NetlifyDeployProviderConfigSchema,
  type NetlifyDeployProviderConfig
} from "./netlify-deploy.js";
import type { ProviderGatewayRuntime } from "./production.js";

const WORKSPACE_ID_MAX = 256;
const DEPLOYMENT_ID_MAX = 128;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SAFE_DEPLOYMENT_ID = /^[A-Za-z0-9_-]+$/;

export const DeployPreviewCreateInputSchema = z.object({
  workspaceId: z.string().min(1).max(WORKSPACE_ID_MAX)
}).strict();

export const DeployPreviewInspectInputSchema = z.object({
  workspaceId: z.string().min(1).max(WORKSPACE_ID_MAX),
  deploymentId: z.string().min(1).max(DEPLOYMENT_ID_MAX).regex(SAFE_DEPLOYMENT_ID)
}).strict();

export const DeployPreviewCreateResultSchema = NetlifyDeployCreateResultSchema;
export const DeployPreviewInspectResultSchema = NetlifyDeployInspectResultSchema;

export type DeployPreviewCreateInput = z.infer<typeof DeployPreviewCreateInputSchema>;
export type DeployPreviewInspectInput = z.infer<typeof DeployPreviewInspectInputSchema>;
export type DeployPreviewCreateResult = z.infer<typeof DeployPreviewCreateResultSchema>;
export type DeployPreviewInspectResult = z.infer<typeof DeployPreviewInspectResultSchema>;

export interface DeployPreviewRepositoryInspection {
  headOid: string;
  branch: string | null;
  remotes: readonly GitRepositoryRemote[];
}

export interface DeployPreviewToolAdapterDependencies {
  repository: {
    inspect(workspaceId: string): Promise<DeployPreviewRepositoryInspection>;
  };
  gitChanges(input: GitChangesInput): Promise<{ clean: boolean; truncated: boolean }>;
}

export interface DeployPreviewToolAdapter {
  create(input: DeployPreviewCreateInput): Promise<DeployPreviewCreateResult>;
  inspect(input: DeployPreviewInspectInput): Promise<DeployPreviewInspectResult>;
}

export function createDeployPreviewToolAdapter(
  runtime: Pick<ProviderGatewayRuntime, "operator" | "gateway">,
  dependencies: DeployPreviewToolAdapterDependencies
): DeployPreviewToolAdapter {
  return {
    async create(rawInput) {
      const input = DeployPreviewCreateInputSchema.parse(rawInput);
      const repository = await dependencies.repository.inspect(input.workspaceId);
      const identity = resolveGitHubRepositoryIdentity(repository.remotes);

      if (repository.branch === null) {
        throw new CapabilityError("CAPABILITY_SOURCE_INVALID", "Preview deployment requires an attached Git branch");
      }
      if (!GIT_OBJECT_ID.test(repository.headOid)) {
        throw new CapabilityError("CAPABILITY_SOURCE_INVALID", "Preview deployment requires an exact Git HEAD object ID");
      }

      const checkpoint = await dependencies.gitChanges({ workspaceId: input.workspaceId, includePatch: false });
      if (checkpoint.truncated) {
        throw new CapabilityError("CAPABILITY_SOURCE_INCOMPLETE", "Preview deployment Git checkpoint is truncated");
      }
      if (!checkpoint.clean) {
        throw new CapabilityError("CAPABILITY_SOURCE_INVALID", "Preview deployment requires a clean Git checkpoint");
      }

      const selected = await selectProvider(runtime);
      requireRepositoryMatch(identity.fullName, selected.config.repository);
      if (repository.branch === selected.config.productionBranch) {
        throw new CapabilityError("CAPABILITY_SOURCE_INVALID", "Preview deployment cannot target the admitted production branch");
      }

      const providerInput = NetlifyDeployCreateInputSchema.parse({
        siteId: selected.config.siteId,
        branch: repository.branch,
        expectedHeadOid: repository.headOid
      });
      const result = await runtime.gateway.execute({
        semanticCapabilityId: "netlify.deploy.preview.create",
        providerInstanceId: selected.record.providerInstanceId,
        workspaceId: input.workspaceId,
        input: providerInput
      });
      return DeployPreviewCreateResultSchema.parse(result.value);
    },

    async inspect(rawInput) {
      const input = DeployPreviewInspectInputSchema.parse(rawInput);
      const repository = await dependencies.repository.inspect(input.workspaceId);
      const identity = resolveGitHubRepositoryIdentity(repository.remotes);
      const selected = await selectProvider(runtime);
      requireRepositoryMatch(identity.fullName, selected.config.repository);

      const providerInput = NetlifyDeployInspectInputSchema.parse({
        siteId: selected.config.siteId,
        deploymentId: input.deploymentId
      });
      const result = await runtime.gateway.execute({
        semanticCapabilityId: "netlify.deploy.preview.inspect",
        providerInstanceId: selected.record.providerInstanceId,
        workspaceId: input.workspaceId,
        input: providerInput
      });
      return DeployPreviewInspectResultSchema.parse(result.value);
    }
  };
}

async function selectProvider(
  runtime: Pick<ProviderGatewayRuntime, "operator">
): Promise<{ record: ProviderRegistryRecord; config: NetlifyDeployProviderConfig }> {
  const matching = (await runtime.operator.list()).filter(
    (record) => record.adapterId === NETLIFY_DEPLOY_PROVIDER_ADAPTER_ID
  );
  if (matching.length === 0) {
    throw new CapabilityError("PROVIDER_NOT_ADMITTED", "Netlify deployment provider is not admitted");
  }

  const enabled = matching.filter((record) => record.enabled);
  if (enabled.length === 0) {
    throw new CapabilityError("PROVIDER_DISABLED", "Netlify deployment provider is disabled");
  }
  if (enabled.length !== 1) {
    throw new CapabilityError(
      "PROVIDER_STATE_INVALID",
      "Multiple enabled Netlify deployment providers are admitted"
    );
  }

  const record = enabled[0]!;
  const parsed = NetlifyDeployProviderConfigSchema.safeParse(record.nonSecretAdapterConfig);
  if (!parsed.success) {
    throw new CapabilityError("PROVIDER_STATE_INVALID", "Netlify deployment provider configuration is invalid");
  }
  return { record, config: parsed.data };
}

function requireRepositoryMatch(actual: string, admitted: string): void {
  if (actual.toLowerCase() !== admitted.toLowerCase()) {
    throw new CapabilityError(
      "CAPABILITY_SOURCE_INVALID",
      "Trusted workspace repository does not match admitted Netlify provider repository"
    );
  }
}
