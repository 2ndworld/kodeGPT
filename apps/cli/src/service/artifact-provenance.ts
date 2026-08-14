import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { RUNTIME_PACKAGE_LINUX_X64 } from "../runtime-resolver.js";

export interface ArtifactPairProvenanceV1 {
  schemaVersion: 1;
  pairId: string;
  sourceRevision: string;
  sourceDirty: boolean;
  runtimePackage: typeof RUNTIME_PACKAGE_LINUX_X64;
  cliSha256: string;
  runtimeSha256: string;
}

export interface VerifyArtifactPairInput {
  cliPath: string;
  runtimePackageRoot: string;
}

const PROVENANCE_KEYS = [
  "schemaVersion",
  "pairId",
  "sourceRevision",
  "sourceDirty",
  "runtimePackage",
  "cliSha256",
  "runtimeSha256"
].sort();

export async function verifyArtifactPair(
  input: VerifyArtifactPairInput
): Promise<ArtifactPairProvenanceV1> {
  const cliProvenancePath = join(dirname(input.cliPath), "kodegpt.provenance.json");
  const runtimeProvenancePath = join(input.runtimePackageRoot, "provenance.json");
  const runtimePath = join(input.runtimePackageRoot, "bin", "kodegpt-runtime");

  let cliProvenance: ArtifactPairProvenanceV1;
  let runtimeProvenance: ArtifactPairProvenanceV1;
  try {
    cliProvenance = parseArtifactPairProvenance(JSON.parse(await readFile(cliProvenancePath, "utf8")));
    runtimeProvenance = parseArtifactPairProvenance(JSON.parse(await readFile(runtimeProvenancePath, "utf8")));
  } catch (error) {
    throw provenanceError("manifest is missing or invalid", error);
  }

  if (!sameProvenance(cliProvenance, runtimeProvenance)) {
    throw provenanceError("CLI and runtime manifests do not match");
  }

  let cliSha256: string;
  let runtimeSha256: string;
  try {
    [cliSha256, runtimeSha256] = await Promise.all([sha256(input.cliPath), sha256(runtimePath)]);
  } catch (error) {
    throw provenanceError("artifact bytes could not be read", error);
  }

  if (
    cliProvenance.cliSha256 !== cliSha256 ||
    cliProvenance.runtimeSha256 !== runtimeSha256
  ) {
    throw provenanceError("artifact digest mismatch");
  }
  if (cliProvenance.pairId !== deriveArtifactPairId(cliSha256, runtimeSha256)) {
    throw provenanceError("pair identity mismatch");
  }

  return cliProvenance;
}

export function deriveArtifactPairId(cliSha256: string, runtimeSha256: string): string {
  return `pair_${createHash("sha256")
    .update(cliSha256)
    .update("\0")
    .update(runtimeSha256)
    .digest("hex")
    .slice(0, 32)}`;
}

function parseArtifactPairProvenance(value: unknown): ArtifactPairProvenanceV1 {
  if (!isRecord(value)) throw new Error("manifest must be an object");
  const keys = Object.keys(value).sort();
  if (keys.length !== PROVENANCE_KEYS.length || keys.some((key, index) => key !== PROVENANCE_KEYS[index])) {
    throw new Error("manifest fields do not match schema");
  }
  if (value.schemaVersion !== 1) throw new Error("unsupported manifest schema");
  if (typeof value.pairId !== "string" || !/^pair_[a-f0-9]{32}$/.test(value.pairId)) {
    throw new Error("invalid pair identity");
  }
  if (typeof value.sourceRevision !== "string" || !/^[a-f0-9]{40}$/.test(value.sourceRevision)) {
    throw new Error("invalid source revision");
  }
  if (typeof value.sourceDirty !== "boolean") throw new Error("invalid source dirty marker");
  if (value.runtimePackage !== RUNTIME_PACKAGE_LINUX_X64) throw new Error("invalid runtime package identity");
  if (typeof value.cliSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.cliSha256)) {
    throw new Error("invalid CLI digest");
  }
  if (typeof value.runtimeSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.runtimeSha256)) {
    throw new Error("invalid runtime digest");
  }
  return {
    schemaVersion: 1,
    pairId: value.pairId,
    sourceRevision: value.sourceRevision,
    sourceDirty: value.sourceDirty,
    runtimePackage: RUNTIME_PACKAGE_LINUX_X64,
    cliSha256: value.cliSha256,
    runtimeSha256: value.runtimeSha256
  };
}

function sameProvenance(a: ArtifactPairProvenanceV1, b: ArtifactPairProvenanceV1): boolean {
  return a.schemaVersion === b.schemaVersion &&
    a.pairId === b.pairId &&
    a.sourceRevision === b.sourceRevision &&
    a.sourceDirty === b.sourceDirty &&
    a.runtimePackage === b.runtimePackage &&
    a.cliSha256 === b.cliSha256 &&
    a.runtimeSha256 === b.runtimeSha256;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function provenanceError(message: string, cause?: unknown): Error {
  return cause === undefined
    ? new Error(`service artifact provenance ${message}`)
    : new Error(`service artifact provenance ${message}`, { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
