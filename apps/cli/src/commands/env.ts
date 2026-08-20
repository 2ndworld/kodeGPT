import type { DeveloperEnvironmentStore } from "@kodegpt/core";

export interface EnvCommandDependencies {
  store: DeveloperEnvironmentStore;
  trustedWorkspaceRoots: string[];
  pathValue: string;
}

export async function runEnvCommand(
  args: string[],
  dependencies: EnvCommandDependencies
): Promise<string> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "sync":
      return syncEnvironment(rest, dependencies);
    case "add":
      return addEnvironment(rest, dependencies);
    case "list":
      return listEnvironments(rest, dependencies.store);
    case "remove":
      return removeEnvironment(rest, dependencies.store);
    case "doctor":
      return doctorEnvironment(rest, dependencies.store);
    default:
      throw new Error("env command must be one of: sync, add, list, remove, doctor");
  }
}

async function syncEnvironment(
  args: string[],
  dependencies: EnvCommandDependencies
): Promise<string> {
  if (args.length !== 0) {
    throw new Error("env sync accepts no arguments");
  }
  const entries = await dependencies.store.syncPath(
    dependencies.pathValue,
    dependencies.trustedWorkspaceRoots
  );
  return `synced ${entries.length} developer environments`;
}

async function addEnvironment(
  args: string[],
  dependencies: EnvCommandDependencies
): Promise<string> {
  const root = args[0];
  if (root === undefined || root.length === 0) {
    throw new Error("env add requires a root path");
  }

  let executableDir = "bin";
  if (args.length > 1) {
    if (args.length !== 3 || args[1] !== "--exec-dir" || args[2] === undefined) {
      throw new Error("env add accepts only <root> [--exec-dir <relative>]");
    }
    executableDir = args[2];
  }

  const entry = await dependencies.store.add({
    root,
    executableDirs: [executableDir],
    label: "Operator environment",
    source: "operator",
    trustedWorkspaceRoots: dependencies.trustedWorkspaceRoots
  });
  return `added ${entry.id}\t${entry.canonicalRoot}\texec=${entry.executableDirs.join(",")}`;
}

async function listEnvironments(
  args: string[],
  store: DeveloperEnvironmentStore
): Promise<string> {
  if (args.length !== 0) {
    throw new Error("env list accepts no arguments");
  }
  const diagnostics = await store.diagnose();
  if (diagnostics.length === 0) {
    return "no developer environments";
  }
  return diagnostics.map(formatDiagnostic).join("\n");
}

async function removeEnvironment(
  args: string[],
  store: DeveloperEnvironmentStore
): Promise<string> {
  const id = args[0];
  if (id === undefined || id.length === 0) {
    throw new Error("env remove requires a developer environment id");
  }
  if (args.length !== 1) {
    throw new Error("env remove accepts exactly one developer environment id");
  }
  if (!(await store.remove(id))) {
    throw new Error(`developer environment id not found: ${id}`);
  }
  return `removed ${id}`;
}

async function doctorEnvironment(
  args: string[],
  store: DeveloperEnvironmentStore
): Promise<string> {
  if (args.length > 1) {
    throw new Error("env doctor accepts at most one executable name");
  }
  const executable = args[0];
  const diagnostics = await store.diagnose(executable);
  if (diagnostics.length === 0) {
    return executable === undefined
      ? "no developer environments"
      : `executable ${executable}: unavailable (no developer environments)`;
  }

  const rows = diagnostics.map(formatDiagnostic);
  if (executable !== undefined) {
    const available = diagnostics.some(
      (diagnostic) => diagnostic.executable?.status === "available"
    );
    rows.push(`executable ${executable}: ${available ? "available" : "unavailable"}`);
  }
  return rows.join("\n");
}

function formatDiagnostic(
  diagnostic: Awaited<ReturnType<DeveloperEnvironmentStore["diagnose"]>>[number]
): string {
  const executable = diagnostic.executable === undefined
    ? ""
    : `\texecutable=${diagnostic.executable.name}:${diagnostic.executable.status}`;
  return [
    diagnostic.entry.id,
    diagnostic.status,
    diagnostic.entry.source,
    diagnostic.entry.canonicalRoot,
    `exec=${diagnostic.entry.executableDirs.join(",")}`,
    `mount=${diagnostic.mountAvailable ? "ready" : "unavailable"}`
  ].join("\t") + executable;
}
