import type {
  ConnectorCredentialStatus,
  IssuedConnectorCredential
} from "@kodegpt/auth";

export interface AuthCommandCredentialStore {
  status(): Promise<ConnectorCredentialStatus>;
  rotate(): Promise<IssuedConnectorCredential>;
}

export interface AuthCommandDependencies {
  store: AuthCommandCredentialStore;
}

export async function runAuthCommand(
  args: string[],
  dependencies: AuthCommandDependencies
): Promise<string> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "status":
      return authStatus(rest, dependencies.store);
    case "rotate":
      return rotateCredential(rest, dependencies.store);
    default:
      throw new Error("auth command must be one of: status, rotate");
  }
}

async function authStatus(
  args: string[],
  store: AuthCommandCredentialStore
): Promise<string> {
  if (args.length !== 0) {
    throw new Error("auth status accepts no arguments");
  }
  const status = await store.status();
  if (!status.configured) {
    return "connector credential not configured";
  }
  return [
    "connector credential configured",
    `id=${status.id}`,
    `createdAt=${status.createdAt}`,
    `rotatedAt=${status.rotatedAt}`
  ].join(" ");
}

async function rotateCredential(
  args: string[],
  store: AuthCommandCredentialStore
): Promise<string> {
  if (args.length !== 0) {
    throw new Error("auth rotate accepts no arguments");
  }
  const issued = await store.rotate();
  return ["connector credential rotated", issued.token].join(" ");
}
