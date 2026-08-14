import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ServiceReleaseRecord {
  releaseId: string;
  packageVersion: string;
  runtimePackage: "@kodegpt/runtime-linux-x64";
  cliSha256: string;
  runtimeSha256: string;
  releaseRoot: string;
  cliPath: string;
  runtimePath: string;
  nodePath: string;
  zrokPath: string;
  reservedName: string;
  port: number;
}

export interface ServiceMetadataV1 {
  schemaVersion: 1;
  unitName: "kodegpt.service";
  activeReleaseId?: string;
  stagedReleaseId?: string;
  rollbackReleaseId?: string;
  releases: Record<string, ServiceReleaseRecord>;
}

export function emptyServiceMetadata(): ServiceMetadataV1 {
  return {
    schemaVersion: 1,
    unitName: "kodegpt.service",
    releases: {}
  };
}

export class ServiceMetadataStore {
  readonly path: string;

  constructor(readonly stateRoot: string) {
    this.path = join(stateRoot, "service.json");
  }

  async read(): Promise<ServiceMetadataV1> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyServiceMetadata();
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new Error("service metadata is not valid JSON", { cause: error });
    }
    return parseMetadata(value);
  }

  async write(metadata: ServiceMetadataV1): Promise<void> {
    const validated = parseMetadata(metadata);
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    const temporary = join(this.stateRoot, `.service.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async stageRelease(release: ServiceReleaseRecord): Promise<ServiceMetadataV1> {
    const parsedRelease = parseRelease(release);
    const current = await this.read();
    const next: ServiceMetadataV1 = {
      ...current,
      stagedReleaseId: parsedRelease.releaseId,
      releases: {
        ...current.releases,
        [parsedRelease.releaseId]: parsedRelease
      }
    };
    await this.write(next);
    return next;
  }

  async promoteStagedRelease(): Promise<ServiceMetadataV1> {
    const current = await this.read();
    const stagedReleaseId = current.stagedReleaseId;
    if (stagedReleaseId === undefined) throw new Error("service metadata has no staged release to promote");
    if (current.releases[stagedReleaseId] === undefined) {
      throw new Error("stagedReleaseId references a missing release");
    }

    const next: ServiceMetadataV1 = {
      schemaVersion: 1,
      unitName: "kodegpt.service",
      activeReleaseId: stagedReleaseId,
      releases: current.releases,
      ...(current.activeReleaseId !== undefined && current.activeReleaseId !== stagedReleaseId
        ? { rollbackReleaseId: current.activeReleaseId }
        : current.rollbackReleaseId !== undefined
          ? { rollbackReleaseId: current.rollbackReleaseId }
          : {})
    };
    await this.write(next);
    return next;
  }

  async delete(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

function parseMetadata(value: unknown): ServiceMetadataV1 {
  if (!isRecord(value)) throw new Error("service metadata must be an object");
  if (value.schemaVersion !== 1) throw new Error("unsupported service metadata schema");
  if (value.unitName !== "kodegpt.service") throw new Error("invalid service metadata unit name");
  if (!isRecord(value.releases)) throw new Error("service metadata releases must be an object");

  const releases: Record<string, ServiceReleaseRecord> = {};
  for (const [releaseId, rawRelease] of Object.entries(value.releases)) {
    const parsed = parseRelease(rawRelease);
    if (parsed.releaseId !== releaseId) throw new Error("service metadata release key does not match releaseId");
    releases[releaseId] = parsed;
  }

  const activeReleaseId = optionalReleaseId(value.activeReleaseId, "activeReleaseId");
  const stagedReleaseId = optionalReleaseId(value.stagedReleaseId, "stagedReleaseId");
  const rollbackReleaseId = optionalReleaseId(value.rollbackReleaseId, "rollbackReleaseId");
  for (const [field, releaseId] of [
    ["activeReleaseId", activeReleaseId],
    ["stagedReleaseId", stagedReleaseId],
    ["rollbackReleaseId", rollbackReleaseId]
  ] as const) {
    if (releaseId !== undefined && releases[releaseId] === undefined) {
      throw new Error(`${field} references a missing release`);
    }
  }

  return {
    schemaVersion: 1,
    unitName: "kodegpt.service",
    releases,
    ...(activeReleaseId === undefined ? {} : { activeReleaseId }),
    ...(stagedReleaseId === undefined ? {} : { stagedReleaseId }),
    ...(rollbackReleaseId === undefined ? {} : { rollbackReleaseId })
  };
}

function parseRelease(value: unknown): ServiceReleaseRecord {
  if (!isRecord(value)) throw new Error("service release metadata must be an object");
  const releaseId = requiredString(value.releaseId, "releaseId");
  if (!/^rel_[a-f0-9]{32}$/.test(releaseId)) throw new Error("invalid service releaseId");
  const cliSha256 = requiredString(value.cliSha256, "cliSha256");
  const runtimeSha256 = requiredString(value.runtimeSha256, "runtimeSha256");
  if (!/^[a-f0-9]{64}$/.test(cliSha256) || !/^[a-f0-9]{64}$/.test(runtimeSha256)) {
    throw new Error("invalid service release digest");
  }
  if (value.runtimePackage !== "@kodegpt/runtime-linux-x64") {
    throw new Error("invalid service runtime package identity");
  }
  if (!Number.isSafeInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65_535) {
    throw new Error("invalid service release port");
  }

  return {
    releaseId,
    packageVersion: requiredString(value.packageVersion, "packageVersion"),
    runtimePackage: "@kodegpt/runtime-linux-x64",
    cliSha256,
    runtimeSha256,
    releaseRoot: requiredString(value.releaseRoot, "releaseRoot"),
    cliPath: requiredString(value.cliPath, "cliPath"),
    runtimePath: requiredString(value.runtimePath, "runtimePath"),
    nodePath: requiredString(value.nodePath, "nodePath"),
    zrokPath: requiredString(value.zrokPath, "zrokPath"),
    reservedName: requiredString(value.reservedName, "reservedName"),
    port: value.port as number
  };
}

function optionalReleaseId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const releaseId = requiredString(value, field);
  if (!/^rel_[a-f0-9]{32}$/.test(releaseId)) throw new Error(`invalid ${field}`);
  return releaseId;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid service metadata ${field}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
