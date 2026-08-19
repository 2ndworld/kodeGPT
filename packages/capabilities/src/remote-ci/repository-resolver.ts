import type {
  RemoteCiRepositoryInspectionAdapter,
  RemoteCiWorkspaceSelectionAdapter
} from "../adapters.js";
import { CapabilityError } from "../errors.js";
import { resolveGitHubRepositoryIdentity } from "../github-repository-identity.js";

export interface ResolvedCiRepository {
  workspaceId: string;
  provider: "github";
  owner: string;
  name: string;
  fullName: string;
  selectedRemote: string;
  headOid: string;
  branch: string | null;
}

export interface RemoteCiRepositoryResolverDependencies {
  selections: RemoteCiWorkspaceSelectionAdapter;
  repository: RemoteCiRepositoryInspectionAdapter;
}

export class RemoteCiRepositoryResolver {
  readonly #selections: RemoteCiWorkspaceSelectionAdapter;
  readonly #repository: RemoteCiRepositoryInspectionAdapter;

  constructor(dependencies: RemoteCiRepositoryResolverDependencies) {
    this.#selections = dependencies.selections;
    this.#repository = dependencies.repository;
  }

  async resolveRepository(input: { workspaceId?: string }): Promise<ResolvedCiRepository> {
    const workspaceId = input.workspaceId ?? (await this.#selectSoleReadyWorkspace());
    const inspection = await this.#repository.inspect(workspaceId);
    const identity = resolveGitHubRepositoryIdentity(inspection.remotes);

    return {
      workspaceId,
      provider: "github",
      owner: identity.owner,
      name: identity.name,
      fullName: identity.fullName,
      selectedRemote: identity.selectedRemote,
      headOid: inspection.headOid,
      branch: inspection.branch
    };
  }

  async #selectSoleReadyWorkspace(): Promise<string> {
    const ready = await this.#selections.listReady();
    if (ready.length === 0) {
      throw new CapabilityError("WORKSPACE_NOT_READY", "No READY workspace is available");
    }
    if (ready.length !== 1) {
      throw new CapabilityError(
        "CI_WORKSPACE_AMBIGUOUS",
        "Multiple READY workspaces are available; workspaceId is required"
      );
    }
    return ready[0]!.id;
  }
}
