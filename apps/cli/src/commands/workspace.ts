import type {
  PersistentFilesystemIdentity,
  ProfileCeiling,
  WorkspaceTrustStore
} from "@kodegpt/trust";

export interface InspectedWorkspaceRoot {
  canonicalRoot: string;
  identity: PersistentFilesystemIdentity;
}

export interface WorkspaceCommandDependencies {
  store: WorkspaceTrustStore;
  inspectRoot: (path: string) => Promise<InspectedWorkspaceRoot>;
}

export async function runWorkspaceCommand(
  args: string[],
  dependencies: WorkspaceCommandDependencies
): Promise<string> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "trust":
      return trustWorkspace(rest, dependencies);
    case "untrust":
      return untrustWorkspace(rest, dependencies.store);
    case "list":
      return listWorkspaces(rest, dependencies.store);
    default:
      throw new Error("workspace command must be one of: trust, untrust, list");
  }
}

async function trustWorkspace(
  args: string[],
  dependencies: WorkspaceCommandDependencies
): Promise<string> {
  const path = args[0];
  if (path === undefined || path.length === 0) {
    throw new Error("workspace trust requires an absolute path");
  }

  const ceiling = parseCeiling(args.slice(1));
  const inspected = await dependencies.inspectRoot(path);
  const entry = await dependencies.store.trust({
    canonicalRoot: inspected.canonicalRoot,
    identity: inspected.identity,
    profileCeiling: ceiling
  });

  return `trusted ${entry.id} ${entry.canonicalRoot} ceiling=${entry.profileCeiling}`;
}

async function untrustWorkspace(args: string[], store: WorkspaceTrustStore): Promise<string> {
  const id = args[0];
  if (id === undefined || id.length === 0) {
    throw new Error("workspace untrust requires a trust id");
  }
  if (args.length !== 1) {
    throw new Error("workspace untrust accepts exactly one trust id");
  }

  if (!(await store.untrust(id))) {
    throw new Error(`workspace trust id not found: ${id}`);
  }
  return `untrusted ${id}`;
}

async function listWorkspaces(args: string[], store: WorkspaceTrustStore): Promise<string> {
  if (args.length !== 0) {
    throw new Error("workspace list accepts no arguments");
  }

  const entries = await store.list();
  if (entries.length === 0) {
    return "no trusted workspaces";
  }
  return entries
    .map(
      (entry) =>
        `${entry.id}\t${entry.profileCeiling}\t${entry.canonicalRoot}\t${entry.identity.deviceMajor}:${entry.identity.deviceMinor}:${entry.identity.inode}`
    )
    .join("\n");
}

function parseCeiling(args: string[]): ProfileCeiling {
  if (args.length === 0) {
    return "observe";
  }
  if (args.length !== 2 || args[0] !== "--ceiling") {
    throw new Error("workspace trust accepts only --ceiling <observe|develop|trusted>");
  }

  const value = args[1];
  if (value !== "observe" && value !== "develop" && value !== "trusted") {
    throw new Error(`invalid workspace profile ceiling: ${String(value)}`);
  }
  return value;
}
