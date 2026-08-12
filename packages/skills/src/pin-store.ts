import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { z } from "zod";

import {
  MAX_RESOURCES_PER_SKILL,
  SKILL_BUNDLE_MAX_BYTES,
  SKILL_MD_MAX_BYTES,
  SKILL_STATE_SCHEMA_VERSION,
  type SkillPinInput,
  type SkillPinnedFileRecord,
  type SkillPinnedManifest,
  type SkillPinnedRawLoad,
  type SkillRawResource
} from "./contracts.js";
import { SkillError } from "./errors.js";
import { fingerprintSkillBundle, fingerprintSkillDescriptor } from "./fingerprint.js";

const SKILL_ID_PATTERN = /^sk_[a-f0-9]{64}$/;
const SOURCE_ID_PATTERN = /^ss_[a-f0-9]{32}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const pinnedFileSchema = z
  .object({
    path: z.string().min(1),
    bytes: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(SHA256_PATTERN)
  })
  .strict();

const pinnedManifestSchema = z
  .object({
    schemaVersion: z.literal(SKILL_STATE_SCHEMA_VERSION),
    skillId: z.string().regex(SKILL_ID_PATTERN),
    name: z.string().min(1),
    description: z.string().min(1),
    fingerprint: z.string().regex(SHA256_PATTERN),
    provenance: z
      .object({
        sourceId: z.string().regex(SOURCE_ID_PATTERN),
        sourceKind: z.literal("agent-skills"),
        sourceRelativePath: z.string().min(1),
        pinnedAt: z.string().min(1)
      })
      .strict(),
    files: z.array(pinnedFileSchema).min(1).max(MAX_RESOURCES_PER_SKILL + 1)
  })
  .strict();

export interface SkillPinStoreOptions {
  now?: () => Date;
}

export class SkillPinStore {
  readonly #root: string;
  readonly #now: () => Date;

  constructor(stateRoot: string, options: SkillPinStoreOptions = {}) {
    this.#root = join(stateRoot, "skills", "pinned");
    this.#now = options.now ?? (() => new Date());
  }

  get root(): string {
    return this.#root;
  }

  async pin(input: SkillPinInput): Promise<SkillPinnedManifest> {
    const validated = validatePinInput(input, this.#now());
    const finalRoot = this.#snapshotRoot(validated.manifest.skillId, validated.manifest.fingerprint);
    const existing = await this.#existingManifest(finalRoot);
    if (existing !== undefined) {
      const loaded = await this.load(existing.skillId, existing.fingerprint);
      requireSamePin(loaded, validated);
      return cloneManifest(loaded.manifest);
    }

    const skillRoot = dirname(finalRoot);
    await ensurePrivateDirectory(this.#root);
    await ensurePrivateDirectory(skillRoot);
    await syncDirectory(this.#root);

    const temporaryRoot = join(
      skillRoot,
      `.pin-${validated.manifest.fingerprint}.${process.pid}.${randomUUID().replaceAll("-", "")}.tmp`
    );

    try {
      await mkdir(temporaryRoot, { mode: 0o700 });
      await chmod(temporaryRoot, 0o700);
      await writePrivateFile(join(temporaryRoot, "SKILL.md"), validated.skillDocument);
      for (const resource of validated.resources) {
        const destination = join(temporaryRoot, "resources", ...resource.path.split("/"));
        await ensurePrivateDirectory(dirname(destination));
        await writePrivateFile(destination, resource.bytes);
      }
      await writePrivateFile(
        join(temporaryRoot, "manifest.json"),
        Buffer.from(`${JSON.stringify(validated.manifest, null, 2)}\n`, "utf8")
      );
      await syncDirectoryTree(temporaryRoot);

      const racedExisting = await this.#existingManifest(finalRoot);
      if (racedExisting !== undefined) {
        await rm(temporaryRoot, { recursive: true, force: true });
        const loaded = await this.load(racedExisting.skillId, racedExisting.fingerprint);
        requireSamePin(loaded, validated);
        return cloneManifest(loaded.manifest);
      }

      try {
        await rename(temporaryRoot, finalRoot);
      } catch (error) {
        if (isAlreadyExistsError(error)) {
          await rm(temporaryRoot, { recursive: true, force: true });
          const loaded = await this.load(validated.manifest.skillId, validated.manifest.fingerprint);
          requireSamePin(loaded, validated);
          return cloneManifest(loaded.manifest);
        }
        throw error;
      }
      await chmod(finalRoot, 0o700);
      await syncDirectory(skillRoot);
      return cloneManifest(validated.manifest);
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof SkillError) throw error;
      throw pinInvalid();
    }
  }

  async list(): Promise<SkillPinnedManifest[]> {
    let skillEntries: Dirent<string>[];
    try {
      skillEntries = await readdir(this.#root, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      if (isMissingError(error)) return [];
      throw pinInvalid();
    }

    const manifests: SkillPinnedManifest[] = [];
    for (const skillEntry of skillEntries.sort((left, right) => compareUtf8(left.name, right.name))) {
      if (!skillEntry.isDirectory() || !SKILL_ID_PATTERN.test(skillEntry.name)) {
        throw pinInvalid();
      }
      const skillRoot = join(this.#root, skillEntry.name);
      let fingerprintEntries: Dirent<string>[];
      try {
        fingerprintEntries = await readdir(skillRoot, { withFileTypes: true, encoding: "utf8" });
      } catch {
        throw pinInvalid();
      }
      for (const fingerprintEntry of fingerprintEntries.sort((left, right) =>
        compareUtf8(left.name, right.name)
      )) {
        if (fingerprintEntry.name.startsWith(".pin-") && fingerprintEntry.name.endsWith(".tmp")) {
          if (!fingerprintEntry.isDirectory()) throw pinInvalid();
          continue;
        }
        if (!fingerprintEntry.isDirectory() || !SHA256_PATTERN.test(fingerprintEntry.name)) {
          throw pinInvalid();
        }
        manifests.push(
          await this.#readManifest(join(skillRoot, fingerprintEntry.name), {
            skillId: skillEntry.name,
            fingerprint: fingerprintEntry.name
          })
        );
      }
    }
    return manifests.map(cloneManifest);
  }

  async load(skillId: string, fingerprint: string): Promise<SkillPinnedRawLoad> {
    validateLookup(skillId, fingerprint);
    const snapshotRoot = this.#snapshotRoot(skillId, fingerprint);
    await requireDirectory(dirname(snapshotRoot), true);
    await requireDirectory(snapshotRoot, true);
    const manifest = await this.#readManifest(snapshotRoot, { skillId, fingerprint });
    await assertSnapshotTopology(snapshotRoot, manifest);

    const skillRecord = manifest.files.find((file) => file.path === "SKILL.md");
    if (skillRecord === undefined) throw pinInvalid();
    const skillDocument = await readAndVerifyFile(join(snapshotRoot, "SKILL.md"), skillRecord);

    const resources: SkillRawResource[] = [];
    for (const file of manifest.files) {
      if (file.path === "SKILL.md") continue;
      const bytes = await readAndVerifyFile(
        join(snapshotRoot, "resources", ...file.path.split("/")),
        file
      );
      resources.push({ path: file.path, bytes, sha256: file.sha256 });
    }

    const computed = fingerprintSkillBundle(
      manifest.files.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 }))
    );
    if (computed !== manifest.fingerprint) throw pinInvalid();

    return {
      manifest: cloneManifest(manifest),
      skillDocument: skillDocument.slice(),
      resources: resources.map(cloneResource)
    };
  }

  async unpin(skillId: string, fingerprint: string): Promise<boolean> {
    validateLookup(skillId, fingerprint);
    const snapshotRoot = this.#snapshotRoot(skillId, fingerprint);
    let snapshotInfo;
    try {
      snapshotInfo = await lstat(snapshotRoot);
    } catch (error) {
      if (isMissingError(error)) return false;
      throw pinInvalid();
    }
    if (!snapshotInfo.isDirectory() || snapshotInfo.isSymbolicLink()) throw pinInvalid();

    try {
      await rm(snapshotRoot, { recursive: true, force: false });
    } catch {
      throw pinInvalid();
    }
    const skillRoot = dirname(snapshotRoot);
    try {
      const remaining = await readdir(skillRoot);
      if (remaining.length === 0) {
        await rmdir(skillRoot);
      } else {
        await syncDirectory(skillRoot);
      }
    } catch (error) {
      if (!isMissingError(error)) throw pinInvalid();
    }
    await syncDirectory(this.#root);
    return true;
  }

  #snapshotRoot(skillId: string, fingerprint: string): string {
    return join(this.#root, skillId, fingerprint);
  }

  async #existingManifest(snapshotRoot: string): Promise<SkillPinnedManifest | undefined> {
    let info;
    try {
      info = await lstat(snapshotRoot);
    } catch (error) {
      if (isMissingError(error)) return undefined;
      throw pinInvalid();
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw pinInvalid();
    const skillId = snapshotRoot.split("/").at(-2);
    const fingerprint = snapshotRoot.split("/").at(-1);
    if (skillId === undefined || fingerprint === undefined) throw pinInvalid();
    return this.#readManifest(snapshotRoot, { skillId, fingerprint });
  }

  async #readManifest(
    snapshotRoot: string,
    expected: { skillId: string; fingerprint: string }
  ): Promise<SkillPinnedManifest> {
    const manifestPath = join(snapshotRoot, "manifest.json");
    await requireRegularFile(manifestPath);
    let text: string;
    try {
      text = await readFile(manifestPath, "utf8");
    } catch {
      throw pinInvalid();
    }

    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw pinInvalid();
    }
    if (isRecord(value) && "schemaVersion" in value && value.schemaVersion !== SKILL_STATE_SCHEMA_VERSION) {
      throw new SkillError("SKILL_PIN_SCHEMA_UNSUPPORTED", "Pinned skill schema version is unsupported");
    }
    const parsed = pinnedManifestSchema.safeParse(value);
    if (!parsed.success) throw pinInvalid();
    validateManifest(parsed.data);
    if (parsed.data.skillId !== expected.skillId || parsed.data.fingerprint !== expected.fingerprint) {
      throw pinInvalid();
    }
    return cloneManifest(parsed.data);
  }
}

interface ValidatedPinInput {
  manifest: SkillPinnedManifest;
  skillDocument: Uint8Array;
  resources: SkillRawResource[];
}

function validatePinInput(input: SkillPinInput, now: Date): ValidatedPinInput {
  if (
    !SKILL_ID_PATTERN.test(input.descriptor.skillId) ||
    !SOURCE_ID_PATTERN.test(input.descriptor.sourceId) ||
    input.descriptor.sourceKind !== "agent-skills" ||
    !SHA256_PATTERN.test(input.descriptor.descriptorFingerprint) ||
    !SHA256_PATTERN.test(input.fingerprint) ||
    !isCanonicalRelativePath(input.sourceRelativePath) ||
    input.skillDocument.byteLength > SKILL_MD_MAX_BYTES ||
    input.resources.length > MAX_RESOURCES_PER_SKILL
  ) {
    throw pinInvalid();
  }

  const skillSha256 = fingerprintSkillDescriptor(input.skillDocument);
  if (skillSha256 !== input.descriptor.descriptorFingerprint) throw pinInvalid();

  const seen = new Set<string>(["SKILL.md"]);
  const resources: SkillRawResource[] = [];
  const records: SkillPinnedFileRecord[] = [
    { path: "SKILL.md", bytes: input.skillDocument.byteLength, sha256: skillSha256 }
  ];
  let totalBytes = input.skillDocument.byteLength;
  for (const resource of input.resources) {
    if (
      !isCanonicalRelativePath(resource.path) ||
      resource.path === "SKILL.md" ||
      seen.has(resource.path) ||
      !SHA256_PATTERN.test(resource.sha256)
    ) {
      throw pinInvalid();
    }
    const sha256 = fingerprintSkillDescriptor(resource.bytes);
    if (sha256 !== resource.sha256) throw pinInvalid();
    totalBytes += resource.bytes.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > SKILL_BUNDLE_MAX_BYTES) throw pinInvalid();
    seen.add(resource.path);
    records.push({ path: resource.path, bytes: resource.bytes.byteLength, sha256 });
    resources.push(cloneResource(resource));
  }
  records.sort((left, right) => compareUtf8(left.path, right.path));
  resources.sort((left, right) => compareUtf8(left.path, right.path));
  const computedFingerprint = fingerprintSkillBundle(records);
  if (computedFingerprint !== input.fingerprint) throw pinInvalid();

  const pinnedAt = now.toISOString();
  const manifest: SkillPinnedManifest = {
    schemaVersion: SKILL_STATE_SCHEMA_VERSION,
    skillId: input.descriptor.skillId,
    name: input.descriptor.name,
    description: input.descriptor.description,
    fingerprint: input.fingerprint,
    provenance: {
      sourceId: input.descriptor.sourceId,
      sourceKind: "agent-skills",
      sourceRelativePath: input.sourceRelativePath,
      pinnedAt
    },
    files: records.map((record) => ({ ...record }))
  };
  validateManifest(manifest);
  return {
    manifest,
    skillDocument: input.skillDocument.slice(),
    resources
  };
}

function validateManifest(manifest: SkillPinnedManifest): void {
  if (!pinnedManifestSchema.safeParse(manifest).success) throw pinInvalid();
  if (!isCanonicalRelativePath(manifest.provenance.sourceRelativePath)) throw pinInvalid();
  if (!Number.isFinite(Date.parse(manifest.provenance.pinnedAt))) throw pinInvalid();
  const derivedSkillId = `sk_${fingerprintSkillDescriptor(
    Buffer.from(`${manifest.provenance.sourceId}\0${manifest.name}`, "utf8")
  )}`;
  if (manifest.skillId !== derivedSkillId) throw pinInvalid();
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of manifest.files) {
    if (!isCanonicalRelativePath(file.path) || seen.has(file.path)) throw pinInvalid();
    seen.add(file.path);
    totalBytes += file.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > SKILL_BUNDLE_MAX_BYTES) throw pinInvalid();
  }
  if (!seen.has("SKILL.md")) throw pinInvalid();
  const sorted = [...manifest.files].sort((left, right) => compareUtf8(left.path, right.path));
  if (sorted.some((file, index) => file.path !== manifest.files[index]!.path)) throw pinInvalid();
}

function requireSamePin(existing: SkillPinnedRawLoad, expected: ValidatedPinInput): void {
  if (
    existing.manifest.skillId !== expected.manifest.skillId ||
    existing.manifest.name !== expected.manifest.name ||
    existing.manifest.description !== expected.manifest.description ||
    existing.manifest.fingerprint !== expected.manifest.fingerprint ||
    existing.manifest.provenance.sourceId !== expected.manifest.provenance.sourceId ||
    existing.manifest.provenance.sourceKind !== expected.manifest.provenance.sourceKind ||
    existing.manifest.provenance.sourceRelativePath !== expected.manifest.provenance.sourceRelativePath ||
    fingerprintSkillDescriptor(existing.skillDocument) !==
      fingerprintSkillDescriptor(expected.skillDocument)
  ) {
    throw pinInvalid();
  }
  if (existing.resources.length !== expected.resources.length) throw pinInvalid();
  for (let index = 0; index < existing.resources.length; index += 1) {
    const left = existing.resources[index]!;
    const right = expected.resources[index]!;
    if (left.path !== right.path || left.sha256 !== right.sha256) throw pinInvalid();
  }
}

async function readAndVerifyFile(path: string, record: SkillPinnedFileRecord): Promise<Uint8Array> {
  await requireRegularFile(path);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch {
    throw pinInvalid();
  }
  if (bytes.byteLength !== record.bytes || fingerprintSkillDescriptor(bytes) !== record.sha256) {
    throw pinInvalid();
  }
  return bytes;
}

async function assertSnapshotTopology(snapshotRoot: string, manifest: SkillPinnedManifest): Promise<void> {
  const expectedFiles = new Set<string>(["manifest.json", "SKILL.md"]);
  const expectedDirectories = new Set<string>();
  for (const file of manifest.files) {
    if (file.path === "SKILL.md") continue;
    const parts = ["resources", ...file.path.split("/")];
    expectedFiles.add(parts.join("/"));
    for (let index = 1; index < parts.length; index += 1) {
      expectedDirectories.add(parts.slice(0, index).join("/"));
    }
  }

  const actualFiles = new Set<string>();
  const actualDirectories = new Set<string>();
  const visit = async (absoluteRoot: string, relativeRoot: string): Promise<void> => {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(absoluteRoot, { withFileTypes: true, encoding: "utf8" });
    } catch {
      throw pinInvalid();
    }
    for (const entry of entries) {
      const relativePath = relativeRoot.length === 0 ? entry.name : `${relativeRoot}/${entry.name}`;
      const absolutePath = join(absoluteRoot, entry.name);
      if (entry.isDirectory()) {
        if (!expectedDirectories.has(relativePath)) throw pinInvalid();
        actualDirectories.add(relativePath);
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile() || !expectedFiles.has(relativePath)) throw pinInvalid();
      actualFiles.add(relativePath);
    }
  };

  await visit(snapshotRoot, "");
  if (actualFiles.size !== expectedFiles.size || actualDirectories.size !== expectedDirectories.size) {
    throw pinInvalid();
  }
  for (const path of expectedFiles) if (!actualFiles.has(path)) throw pinInvalid();
  for (const path of expectedDirectories) if (!actualDirectories.has(path)) throw pinInvalid();
}

async function requireDirectory(path: string, missingIsNotFound = false): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (missingIsNotFound && isMissingError(error)) {
      throw new SkillError("SKILL_NOT_FOUND", "Pinned skill snapshot was not found");
    }
    throw pinInvalid();
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw pinInvalid();
}

async function requireRegularFile(path: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw pinInvalid();
  }
  if (!info.isFile() || info.isSymbolicLink()) throw pinInvalid();
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  } catch {
    throw pinInvalid();
  }
}

async function writePrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

async function syncDirectoryTree(path: string): Promise<void> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(path, { withFileTypes: true, encoding: "utf8" });
  } catch {
    throw pinInvalid();
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await syncDirectoryTree(join(path, entry.name));
      continue;
    }
    if (!entry.isFile()) throw pinInvalid();
  }
  await syncDirectory(path);
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch {
    throw pinInvalid();
  }
  try {
    await handle.sync();
  } catch {
    throw pinInvalid();
  } finally {
    try {
      await handle.close();
    } catch {
      throw pinInvalid();
    }
  }
}

function validateLookup(skillId: string, fingerprint: string): void {
  if (!SKILL_ID_PATTERN.test(skillId) || !SHA256_PATTERN.test(fingerprint)) throw pinInvalid();
}

function isCanonicalRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes("\0") || isAbsolute(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function cloneManifest(manifest: SkillPinnedManifest): SkillPinnedManifest {
  return {
    ...manifest,
    provenance: { ...manifest.provenance },
    files: manifest.files.map((file) => ({ ...file }))
  };
}

function cloneResource(resource: SkillRawResource): SkillRawResource {
  return { path: resource.path, bytes: resource.bytes.slice(), sha256: resource.sha256 };
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function pinInvalid(): SkillError {
  return new SkillError("SKILL_PIN_INVALID", "Pinned skill snapshot is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}
