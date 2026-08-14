import { createHash, randomUUID } from "node:crypto";
import { access, chmod, copyFile, cp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { RUNTIME_PACKAGE_LINUX_X64 } from "../runtime-resolver.js";
import { verifyArtifactPair } from "./artifact-provenance.js";
import type { ServiceMetadataV1, ServiceReleaseRecord } from "./metadata.js";

export interface MaterializeServiceReleaseInput {
  serviceDataRoot: string;
  cliPath: string;
  runtimePackageRoot: string;
  yamlPackageRoot: string;
  nodePath: string;
  zrokPath: string;
  reservedName: string;
  port: number;
  packageVersion: string;
}

export async function materializeServiceRelease(
  input: MaterializeServiceReleaseInput
): Promise<ServiceReleaseRecord> {
  const provenance = await verifyArtifactPair({
    cliPath: input.cliPath,
    runtimePackageRoot: input.runtimePackageRoot
  });
  const cliSha256 = provenance.cliSha256;
  const runtimeSha256 = provenance.runtimeSha256;
  const releaseId = releaseIdentity(input.packageVersion, cliSha256, runtimeSha256);
  const releasesRoot = join(input.serviceDataRoot, "releases");
  const releaseRoot = join(releasesRoot, releaseId);
  const record = serviceReleaseRecord(input, releaseId, releaseRoot, cliSha256, runtimeSha256);

  if (await exists(releaseRoot)) {
    try {
      await verifyServiceRelease(record);
    } catch (error) {
      throw new Error("existing service release failed verification", { cause: error });
    }
    return record;
  }

  await mkdir(releasesRoot, { recursive: true, mode: 0o700 });
  const temporaryRoot = join(releasesRoot, `.${releaseId}.${randomUUID()}.tmp`);
  try {
    const cliDestination = join(temporaryRoot, "bin", "kodegpt.mjs");
    const cliProvenanceDestination = join(temporaryRoot, "bin", "kodegpt.provenance.json");
    const runtimeDestinationRoot = join(
      temporaryRoot,
      "node_modules",
      "@kodegpt",
      "runtime-linux-x64"
    );
    const yamlDestinationRoot = join(temporaryRoot, "node_modules", "yaml");
    await mkdir(join(temporaryRoot, "bin"), { recursive: true, mode: 0o700 });
    await mkdir(join(temporaryRoot, "node_modules", "@kodegpt"), { recursive: true, mode: 0o700 });
    await copyFile(input.cliPath, cliDestination);
    await copyFile(join(dirname(input.cliPath), "kodegpt.provenance.json"), cliProvenanceDestination);
    await cp(input.runtimePackageRoot, runtimeDestinationRoot, { recursive: true, force: false });
    await cp(input.yamlPackageRoot, yamlDestinationRoot, { recursive: true, force: false });
    await chmod(cliDestination, 0o755);
    await chmod(join(runtimeDestinationRoot, "bin", "kodegpt-runtime"), 0o755);
    await rename(temporaryRoot, releaseRoot);
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    if (await exists(releaseRoot)) {
      try {
        await verifyServiceRelease(record);
        return record;
      } catch (verificationError) {
        throw new Error("existing service release failed verification", { cause: verificationError });
      }
    }
    throw error;
  }

  await verifyServiceRelease(record);
  return record;
}

export async function cleanupServiceReleases(
  serviceDataRoot: string,
  metadata: ServiceMetadataV1
): Promise<void> {
  const releasesRoot = resolve(serviceDataRoot, "releases");
  const retained = new Set(
    [metadata.activeReleaseId, metadata.stagedReleaseId, metadata.rollbackReleaseId].filter(
      (value): value is string => value !== undefined
    )
  );

  for (const releaseId of retained) {
    const record = metadata.releases[releaseId];
    if (record === undefined) throw new Error(`retained service release is missing metadata: ${releaseId}`);
    const expectedRoot = resolve(releasesRoot, releaseId);
    if (resolve(record.releaseRoot) !== expectedRoot) {
      throw new Error("release root escapes service-owned directory");
    }
  }

  let entries;
  try {
    entries = await readdir(releasesRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^rel_[a-f0-9]{32}$/.test(entry.name)) continue;
    if (retained.has(entry.name)) continue;
    await rm(join(releasesRoot, entry.name), { recursive: true, force: true });
  }
}

export async function verifyServiceRelease(record: ServiceReleaseRecord): Promise<void> {
  const cliSha256 = await sha256(record.cliPath);
  if (cliSha256 !== record.cliSha256) throw new Error("service release CLI digest mismatch");
  const runtimeSha256 = await sha256(record.runtimePath);
  if (runtimeSha256 !== record.runtimeSha256) throw new Error("service release runtime digest mismatch");

  const runtimePackageRoot = join(
    record.releaseRoot,
    "node_modules",
    "@kodegpt",
    "runtime-linux-x64"
  );
  const manifestPath = join(runtimePackageRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: unknown };
  if (manifest.name !== RUNTIME_PACKAGE_LINUX_X64) {
    throw new Error("service release runtime package identity mismatch");
  }
  await access(join(record.releaseRoot, "node_modules", "yaml", "package.json"));
  await verifyArtifactPair({ cliPath: record.cliPath, runtimePackageRoot });
}

function serviceReleaseRecord(
  input: MaterializeServiceReleaseInput,
  releaseId: string,
  releaseRoot: string,
  cliSha256: string,
  runtimeSha256: string
): ServiceReleaseRecord {
  return {
    releaseId,
    packageVersion: input.packageVersion,
    runtimePackage: RUNTIME_PACKAGE_LINUX_X64,
    cliSha256,
    runtimeSha256,
    releaseRoot,
    cliPath: join(releaseRoot, "bin", "kodegpt.mjs"),
    runtimePath: join(
      releaseRoot,
      "node_modules",
      "@kodegpt",
      "runtime-linux-x64",
      "bin",
      "kodegpt-runtime"
    ),
    nodePath: input.nodePath,
    zrokPath: input.zrokPath,
    reservedName: input.reservedName,
    port: input.port
  };
}

function releaseIdentity(packageVersion: string, cliSha256: string, runtimeSha256: string): string {
  const digest = createHash("sha256")
    .update(packageVersion)
    .update("\0")
    .update(cliSha256)
    .update("\0")
    .update(runtimeSha256)
    .digest("hex");
  return `rel_${digest.slice(0, 32)}`;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
