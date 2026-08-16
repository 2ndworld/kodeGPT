import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { CapabilityError } from "../errors.js";
import type {
  ProviderAdapterManifest,
  ProviderCredentialBrokerDescriptor
} from "./contracts.js";

export interface ProviderImplementationIdentity {
  implementationFingerprint: string;
  helperIdentity: null | { canonicalPath: string; sha256: string };
}

export async function resolveProviderImplementationIdentity(input: {
  manifest: ProviderAdapterManifest;
  credentialBroker: ProviderCredentialBrokerDescriptor;
  workspaceRoots: readonly string[];
}): Promise<ProviderImplementationIdentity> {
  if (!/^[0-9a-f]{64}$/.test(input.manifest.implementationDigest)) {
    throw invalid("Provider manifest implementation digest must be lowercase SHA-256");
  }

  const workspaceRoots = input.workspaceRoots.map((root) => {
    if (!isAbsolute(root)) throw invalid("Provider workspace roots must be absolute");
    return resolve(root);
  });

  let helperIdentity: ProviderImplementationIdentity["helperIdentity"] = null;
  if (input.credentialBroker.kind === "external-helper") {
    helperIdentity = await resolveHelperIdentity(
      input.credentialBroker.helperPath,
      input.credentialBroker.helperSha256,
      workspaceRoots
    );
  }

  const canonicalIdentity = {
    adapterId: input.manifest.adapterId,
    adapterContractVersion: input.manifest.adapterContractVersion,
    implementationDigest: input.manifest.implementationDigest,
    helperSha256: helperIdentity?.sha256 ?? null
  };

  return {
    implementationFingerprint: createHash("sha256")
      .update(JSON.stringify(canonicalIdentity), "utf8")
      .digest("hex"),
    helperIdentity
  };
}

export async function revalidateProviderHelperIdentity(input: {
  canonicalPath: string;
  expectedSha256: string;
  workspaceRoots: readonly string[];
}): Promise<{ canonicalPath: string; sha256: string }> {
  const identity = await resolveHelperIdentity(
    input.canonicalPath,
    input.expectedSha256,
    input.workspaceRoots
  );
  if (identity.canonicalPath !== input.canonicalPath) {
    throw new CapabilityError(
      "PROVIDER_IDENTITY_CHANGED",
      "Provider credential helper canonical path changed"
    );
  }
  return identity;
}

async function resolveHelperIdentity(
  helperPath: string,
  expectedSha256: string,
  workspaceRoots: readonly string[]
): Promise<{ canonicalPath: string; sha256: string }> {
  if (!isAbsolute(helperPath)) throw invalid("Provider credential helper path must be absolute");
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw invalid("Provider credential helper pin must be lowercase SHA-256");
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(helperPath);
  } catch {
    throw invalid("Provider credential helper path cannot be resolved");
  }
  if (!isAbsolute(canonicalPath)) throw invalid("Provider credential helper canonical path must be absolute");

  for (const workspaceRoot of workspaceRoots) {
    if (!isAbsolute(workspaceRoot)) throw invalid("Provider workspace roots must be absolute");
    const canonicalWorkspaceRoot = await canonicalizeExistingOrLexical(workspaceRoot);
    if (isWithin(canonicalWorkspaceRoot, canonicalPath)) {
      throw invalid("Provider credential helper must be outside workspace roots");
    }
  }

  try {
    const metadata = await stat(canonicalPath);
    if (!metadata.isFile()) throw invalid("Provider credential helper must be a regular file");
    await access(canonicalPath, fsConstants.X_OK);
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw invalid("Provider credential helper must be an executable regular file");
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(canonicalPath);
  } catch {
    throw invalid("Provider credential helper cannot be read for identity verification");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expectedSha256) {
    throw new CapabilityError(
      "PROVIDER_IDENTITY_CHANGED",
      "Provider credential helper identity changed"
    );
  }
  return { canonicalPath, sha256 };
}

async function canonicalizeExistingOrLexical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function invalid(message: string): CapabilityError {
  return new CapabilityError("PROVIDER_INPUT_INVALID", message);
}
