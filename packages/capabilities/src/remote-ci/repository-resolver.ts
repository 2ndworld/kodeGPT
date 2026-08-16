import type {
  RemoteCiRepositoryInspectionAdapter,
  RemoteCiWorkspaceSelectionAdapter
} from "../adapters.js";
import { CapabilityError } from "../errors.js";

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
    const selected = selectRemote(inspection.remotes);
    const identity = parseGitHubRemote(selected.fetchUrl);

    return {
      workspaceId,
      provider: "github",
      owner: identity.owner,
      name: identity.name,
      fullName: `${identity.owner}/${identity.name}`,
      selectedRemote: selected.name,
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

function selectRemote(remotes: Array<{ name: string; fetchUrl: string }>): {
  name: string;
  fetchUrl: string;
} {
  const origin = remotes.find((remote) => remote.name === "origin");
  if (origin !== undefined) return origin;

  const sorted = [...remotes].sort((left, right) =>
    Buffer.from(left.name, "utf8").compare(Buffer.from(right.name, "utf8"))
  );
  if (sorted.length !== 1) {
    throw new CapabilityError(
      "CI_REPOSITORY_UNAVAILABLE",
      sorted.length === 0
        ? "Trusted workspace has no usable Git fetch remote"
        : "Trusted workspace has ambiguous Git fetch remotes"
    );
  }
  return sorted[0]!;
}

function parseGitHubRemote(fetchUrl: string): { owner: string; name: string } {
  if (fetchUrl.length === 0 || fetchUrl.length > 8192 || hasControl(fetchUrl)) {
    throw unsupportedRemote();
  }

  if (fetchUrl.startsWith("https://") || fetchUrl.startsWith("ssh://")) {
    return parseUrlRemote(fetchUrl);
  }

  const scp = /^git@github\.com:([^/:]+)\/([^/:]+)$/.exec(fetchUrl);
  if (scp === null) throw unsupportedRemote();
  return normalizeRepositoryParts(scp[1]!, scp[2]!);
}

function parseUrlRemote(fetchUrl: string): { owner: string; name: string } {
  let url: URL;
  try {
    url = new URL(fetchUrl);
  } catch {
    throw unsupportedRemote();
  }

  if (
    url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.password !== ""
  ) {
    throw unsupportedRemote();
  }

  if (url.protocol === "https:") {
    if (url.username !== "") throw unsupportedRemote();
  } else if (url.protocol === "ssh:") {
    if (url.username !== "git") throw unsupportedRemote();
  } else {
    throw unsupportedRemote();
  }

  if (url.pathname.includes("%")) throw unsupportedRemote();
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  if (parts.length !== 2) throw unsupportedRemote();
  return normalizeRepositoryParts(parts[0]!, parts[1]!);
}

function normalizeRepositoryParts(owner: string, rawName: string): { owner: string; name: string } {
  const name = rawName.endsWith(".git") ? rawName.slice(0, -4) : rawName;
  if (
    owner.length === 0 ||
    owner.length > 100 ||
    name.length === 0 ||
    name.length > 100 ||
    owner === "." ||
    owner === ".." ||
    name === "." ||
    name === ".." ||
    hasControl(owner) ||
    hasControl(name) ||
    owner.includes("@") ||
    owner.includes(":") ||
    name.includes("@") ||
    name.includes(":")
  ) {
    throw unsupportedRemote();
  }
  return { owner, name };
}

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function unsupportedRemote(): CapabilityError {
  return new CapabilityError(
    "CI_REMOTE_UNSUPPORTED",
    "Trusted workspace Git remote is not a supported github.com repository"
  );
}
