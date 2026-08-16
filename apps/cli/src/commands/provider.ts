import type {
  ProviderAddInput,
  ProviderOperatorService,
  ProviderRegistryRecord
} from "@kodegpt/capabilities";

export interface ProviderCommandDependencies {
  service: Pick<
    ProviderOperatorService,
    "add" | "remove" | "enable" | "disable" | "reapprove" | "list" | "inspect"
  >;
}

const PROVIDER_ID = /^prv_[0-9a-f]{32}$/;

export async function runProviderCommand(
  args: string[],
  dependencies: ProviderCommandDependencies
): Promise<string> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "add":
      return addProvider(rest, dependencies);
    case "remove":
      return removeProvider(rest, dependencies);
    case "enable":
      return mutateProvider("enable", rest, dependencies);
    case "disable":
      return mutateProvider("disable", rest, dependencies);
    case "reapprove":
      return mutateProvider("reapprove", rest, dependencies);
    case "list":
      return listProviders(rest, dependencies);
    case "inspect":
      return inspectProvider(rest, dependencies);
    default:
      throw new Error("unknown provider command; expected add, remove, enable, disable, reapprove, list, or inspect");
  }
}

async function addProvider(args: string[], dependencies: ProviderCommandDependencies): Promise<string> {
  const parsed = parseAddOptions(args);
  const record = await dependencies.service.add(parsed);
  return `added ${record.providerInstanceId} adapter=${record.adapterId} enabled=${record.enabled}`;
}

async function removeProvider(args: string[], dependencies: ProviderCommandDependencies): Promise<string> {
  const id = parseSingleProviderId(args, "remove");
  if (!await dependencies.service.remove(id)) {
    throw new Error(`provider not found: ${id}`);
  }
  return `removed ${id}`;
}

async function mutateProvider(
  command: "enable" | "disable" | "reapprove",
  args: string[],
  dependencies: ProviderCommandDependencies
): Promise<string> {
  const id = parseSingleProviderId(args, command);
  const record = await dependencies.service[command](id);
  return `${command}d ${record.providerInstanceId} enabled=${record.enabled}`;
}

async function listProviders(args: string[], dependencies: ProviderCommandDependencies): Promise<string> {
  const json = parseJsonOnly(args, "provider list");
  const records = await dependencies.service.list();
  if (json) return JSON.stringify(records);
  if (records.length === 0) return "no admitted providers";
  return records.map(formatProviderHuman).join("\n");
}

async function inspectProvider(args: string[], dependencies: ProviderCommandDependencies): Promise<string> {
  const id = args[0];
  if (id === undefined) throw new Error("provider inspect requires a provider instance id");
  assertProviderId(id);
  const json = parseJsonOnly(args.slice(1), "provider inspect");
  const record = await dependencies.service.inspect(id);
  return json ? JSON.stringify(record) : formatProviderHuman(record);
}

function parseAddOptions(args: string[]): ProviderAddInput {
  let adapterId: string | undefined;
  let operatorName: string | undefined;
  let config: Record<string, unknown> = {};
  let helperPath: string | undefined;
  let helperSha256: string | undefined;

  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (option === undefined || !option.startsWith("--")) {
      throw new Error("provider add accepts only named options");
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    switch (option) {
      case "--adapter":
        adapterId = value;
        break;
      case "--name":
        operatorName = value;
        break;
      case "--config":
        config = parseConfig(value);
        break;
      case "--helper-path":
        helperPath = value;
        break;
      case "--helper-sha256":
        helperSha256 = value;
        break;
      default:
        throw new Error(`unsupported provider add option: ${option}`);
    }
  }

  if (adapterId === undefined || adapterId.length === 0) {
    throw new Error("provider add requires --adapter <adapter-id>");
  }
  if (operatorName === undefined || operatorName.length === 0) {
    throw new Error("provider add requires --name <display-name>");
  }
  if ((helperPath === undefined) !== (helperSha256 === undefined)) {
    throw new Error("provider add helper identity requires both --helper-path and --helper-sha256");
  }
  if (helperSha256 !== undefined && !/^[0-9a-f]{64}$/.test(helperSha256)) {
    throw new Error("provider add --helper-sha256 must be 64 lowercase hex characters");
  }

  return {
    adapterId,
    operatorName,
    credentialBroker: helperPath === undefined
      ? { kind: "none" }
      : { kind: "external-helper", helperPath, helperSha256: helperSha256! },
    nonSecretAdapterConfig: config
  };
}

function parseConfig(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("provider add --config must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("provider add --config must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseSingleProviderId(args: string[], command: string): string {
  if (args.length !== 1) throw new Error(`provider ${command} requires exactly one provider instance id`);
  const id = args[0]!;
  assertProviderId(id);
  return id;
}

function assertProviderId(value: string): void {
  if (!PROVIDER_ID.test(value)) {
    throw new Error("provider instance id must match prv_<32 lowercase hex>");
  }
}

function parseJsonOnly(args: string[], command: string): boolean {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === "--json") return true;
  throw new Error(`${command} accepts only --json`);
}

function formatProviderHuman(record: ProviderRegistryRecord): string {
  return [
    record.providerInstanceId,
    record.enabled ? "enabled" : "disabled",
    record.adapterId,
    record.operatorName,
    `credential=${record.credentialBroker.kind}`
  ].join("\t");
}
