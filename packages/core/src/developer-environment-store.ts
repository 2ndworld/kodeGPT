import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { PersistentFilesystemIdentity } from "@kodegpt/protocol";

export const DEVELOPER_ENVIRONMENT_SCHEMA_VERSION = 1 as const;
export const MAX_DEVELOPER_ENVIRONMENTS = 32;
export const MAX_DEVELOPER_EXECUTABLE_DIRS = 4;
export const MAX_DEVELOPER_ENVIRONMENT_LABEL_BYTES = 120;

export type DeveloperEnvironmentSource = "bootstrap" | "operator" | "synced-shell";

export interface DeveloperEnvironmentEntry {
  id: string;
  label: string;
  source: DeveloperEnvironmentSource;
  canonicalRoot: string;
  executableDirs: string[];
  identity: PersistentFilesystemIdentity;
}

export type DeveloperEnvironmentDiagnosticStatus =
  | "available"
  | "missing"
  | "changed"
  | "unsafe";

export type DeveloperExecutableDiagnosticStatus = "available" | "absent" | "unavailable";

export interface DeveloperEnvironmentDiagnostic {
  entry: DeveloperEnvironmentEntry;
  status: DeveloperEnvironmentDiagnosticStatus;
  mountAvailable: boolean;
  executable?: {
    name: string;
    status: DeveloperExecutableDiagnosticStatus;
  };
}

interface DeveloperEnvironmentDocument {
  schemaVersion: typeof DEVELOPER_ENVIRONMENT_SCHEMA_VERSION;
  entries: DeveloperEnvironmentEntry[];
}

interface InspectedDeveloperEnvironment {
  canonicalRoot: string;
  identity: PersistentFilesystemIdentity;
}

export type DeveloperEnvironmentErrorCode =
  | "DEV_ENV_REGISTRY_INVALID"
  | "DEV_ENV_SCHEMA_UNSUPPORTED"
  | "DEV_ENV_LIMIT_EXCEEDED"
  | "DEV_ENV_ROOT_NOT_FOUND"
  | "DEV_ENV_ROOT_UNTRUSTED"
  | "DEV_ENV_ROOT_INSIDE_STATE"
  | "DEV_ENV_ROOT_INSIDE_WORKSPACE"
  | "DEV_ENV_ROOT_CHANGED"
  | "DEV_ENV_ROOT_CONFLICT";

export class DeveloperEnvironmentError extends Error {
  readonly code: DeveloperEnvironmentErrorCode;

  constructor(code: DeveloperEnvironmentErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeveloperEnvironmentError";
    this.code = code;
  }
}

export class DeveloperEnvironmentStore {
  readonly #stateRoot: string;
  readonly #path: string;

  constructor(stateRoot: string) {
    if (stateRoot.length === 0) throw new TypeError("Developer environment state root must not be empty");
    this.#stateRoot = resolve(stateRoot);
    this.#path = join(this.#stateRoot, "developer-environments", "registry.json");
  }

  get path(): string {
    return this.#path;
  }

  async list(): Promise<DeveloperEnvironmentEntry[]> {
    const document = await this.#readDocument();
    const entries: DeveloperEnvironmentEntry[] = [];
    for (const entry of document.entries) {
      await this.#revalidateEntry(entry);
      entries.push(cloneEntry(entry));
    }
    return entries;
  }

  async diagnose(executable?: string): Promise<DeveloperEnvironmentDiagnostic[]> {
    if (executable !== undefined && !isSimpleLogicalExecutableName(executable)) {
      throw new DeveloperEnvironmentError(
        "DEV_ENV_REGISTRY_INVALID",
        "Developer executable diagnosis requires a simple logical executable name"
      );
    }

    const document = await this.#readDocument();
    const diagnostics: DeveloperEnvironmentDiagnostic[] = [];
    for (const entry of document.entries) {
      let status: DeveloperEnvironmentDiagnosticStatus = "available";
      try {
        await this.#revalidateEntry(entry);
      } catch (error) {
        if (!(error instanceof DeveloperEnvironmentError)) throw error;
        status = diagnosticStatusForError(error);
      }

      const mountAvailable = status === "available" && (await canOpenDirectory(entry.canonicalRoot));
      const executableDiagnostic = executable === undefined
        ? undefined
        : {
            name: executable,
            status:
              status === "available"
                ? await this.#diagnoseExecutable(entry, executable)
                : ("unavailable" as const)
          };
      diagnostics.push({
        entry: cloneEntry(entry),
        status,
        mountAvailable,
        ...(executableDiagnostic === undefined ? {} : { executable: executableDiagnostic })
      });
    }
    return diagnostics;
  }

  async add(input: {
    root: string;
    executableDirs: string[];
    label: string;
    source: DeveloperEnvironmentSource;
    trustedWorkspaceRoots: string[];
  }): Promise<DeveloperEnvironmentEntry> {
    validateLabel(input.label);
    validateSource(input.source);
    const executableDirs = validateExecutableDirs(input.executableDirs);
    const document = await this.#readDocument();
    if (document.entries.length >= MAX_DEVELOPER_ENVIRONMENTS) {
      throw new DeveloperEnvironmentError(
        "DEV_ENV_LIMIT_EXCEEDED",
        `Developer environment registry is limited to ${MAX_DEVELOPER_ENVIRONMENTS} entries`
      );
    }

    const inspected = await this.#inspectCandidate(
      input.root,
      executableDirs,
      input.trustedWorkspaceRoots
    );
    if (document.entries.some((entry) => entry.canonicalRoot === inspected.canonicalRoot)) {
      throw new DeveloperEnvironmentError(
        "DEV_ENV_ROOT_CONFLICT",
        "Developer environment root is already registered"
      );
    }

    const entry: DeveloperEnvironmentEntry = {
      id: `denv_${randomUUID().replaceAll("-", "")}`,
      label: input.label,
      source: input.source,
      canonicalRoot: inspected.canonicalRoot,
      executableDirs,
      identity: inspected.identity
    };
    document.entries.push(entry);
    await this.#writeDocument(document);
    return cloneEntry(entry);
  }

  async syncPath(
    pathValue: string,
    trustedWorkspaceRoots: string[]
  ): Promise<DeveloperEnvironmentEntry[]> {
    const document = await this.#readDocument();
    const knownRoots = new Set(document.entries.map((entry) => entry.canonicalRoot));
    const synced: DeveloperEnvironmentEntry[] = [];
    const seenCandidates = new Set<string>();

    for (const rawCandidate of pathValue.split(delimiter)) {
      if (rawCandidate.length === 0) continue;
      const candidate = resolve(rawCandidate);
      if (SYSTEM_EXECUTABLE_DIRS.has(candidate)) continue;

      let inspected: InspectedDeveloperEnvironment;
      try {
        inspected = await this.#inspectCandidate(candidate, ["."], trustedWorkspaceRoots);
      } catch (error) {
        if (error instanceof DeveloperEnvironmentError) continue;
        throw error;
      }
      if (seenCandidates.has(inspected.canonicalRoot) || knownRoots.has(inspected.canonicalRoot)) {
        continue;
      }
      if (document.entries.length >= MAX_DEVELOPER_ENVIRONMENTS) {
        throw new DeveloperEnvironmentError(
          "DEV_ENV_LIMIT_EXCEEDED",
          `Developer environment registry is limited to ${MAX_DEVELOPER_ENVIRONMENTS} entries`
        );
      }

      seenCandidates.add(inspected.canonicalRoot);
      knownRoots.add(inspected.canonicalRoot);
      const entry: DeveloperEnvironmentEntry = {
        id: `denv_${randomUUID().replaceAll("-", "")}`,
        label: `PATH entry ${document.entries.length + 1}`,
        source: "synced-shell",
        canonicalRoot: inspected.canonicalRoot,
        executableDirs: ["."],
        identity: inspected.identity
      };
      document.entries.push(entry);
      synced.push(cloneEntry(entry));
    }

    if (synced.length > 0) await this.#writeDocument(document);
    return synced;
  }

  async remove(id: string): Promise<boolean> {
    if (!/^denv_[a-f0-9]{32}$/.test(id)) {
      throw new DeveloperEnvironmentError("DEV_ENV_REGISTRY_INVALID", "Invalid developer environment id");
    }
    const document = await this.#readDocument();
    const next = document.entries.filter((entry) => entry.id !== id);
    if (next.length === document.entries.length) return false;
    document.entries = next;
    await this.#writeDocument(document);
    return true;
  }

  async ensureBootstrap(input: {
    nodeRoot?: string;
    rustRoot?: string;
    trustedWorkspaceRoots: string[];
  }): Promise<void> {
    const document = await this.#readDocument();
    let changed = false;

    for (const candidate of [
      input.nodeRoot === undefined
        ? undefined
        : { label: "Node runtime", root: input.nodeRoot, executableDirs: ["bin"] },
      input.rustRoot === undefined
        ? undefined
        : { label: "Rust stable toolchain", root: input.rustRoot, executableDirs: ["bin"] }
    ]) {
      if (candidate === undefined) continue;

      let inspected: InspectedDeveloperEnvironment;
      try {
        inspected = await this.#inspectCandidate(
          candidate.root,
          candidate.executableDirs,
          input.trustedWorkspaceRoots
        );
      } catch (error) {
        if (error instanceof DeveloperEnvironmentError) continue;
        throw error;
      }

      const sameRoot = document.entries.find(
        (entry) => entry.canonicalRoot === inspected.canonicalRoot
      );
      if (sameRoot !== undefined && sameRoot.source !== "bootstrap") continue;

      const existingIndex = document.entries.findIndex(
        (entry) => entry.source === "bootstrap" && entry.label === candidate.label
      );
      const existing = existingIndex >= 0 ? document.entries[existingIndex] : undefined;
      const next: DeveloperEnvironmentEntry = {
        id: existing?.id ?? `denv_${randomUUID().replaceAll("-", "")}`,
        label: candidate.label,
        source: "bootstrap",
        canonicalRoot: inspected.canonicalRoot,
        executableDirs: candidate.executableDirs,
        identity: inspected.identity
      };

      if (existingIndex >= 0) {
        if (!sameEntry(document.entries[existingIndex]!, next)) {
          document.entries[existingIndex] = next;
          changed = true;
        }
      } else {
        if (document.entries.length >= MAX_DEVELOPER_ENVIRONMENTS) {
          throw new DeveloperEnvironmentError(
            "DEV_ENV_LIMIT_EXCEEDED",
            `Developer environment registry is limited to ${MAX_DEVELOPER_ENVIRONMENTS} entries`
          );
        }
        document.entries.push(next);
        changed = true;
      }
    }

    if (changed) await this.#writeDocument(document);
  }

  async #inspectCandidate(
    root: string,
    executableDirs: string[],
    trustedWorkspaceRoots: string[]
  ): Promise<{ canonicalRoot: string; identity: PersistentFilesystemIdentity }> {
    if (root.length === 0 || root.includes("\0")) {
      throw new DeveloperEnvironmentError("DEV_ENV_ROOT_UNTRUSTED", "Developer environment root is invalid");
    }
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DeveloperEnvironmentError(
          "DEV_ENV_ROOT_NOT_FOUND",
          "Developer environment root was not found",
          { cause: error }
        );
      }
      throw new DeveloperEnvironmentError(
        "DEV_ENV_ROOT_UNTRUSTED",
        "Developer environment root could not be inspected",
        { cause: error }
      );
    }

    const canonicalStateRoot = await this.#canonicalStateRoot();
    if (pathsOverlap(canonicalRoot, canonicalStateRoot)) {
      throw new DeveloperEnvironmentError(
        "DEV_ENV_ROOT_INSIDE_STATE",
        "Developer environment root overlaps KodeGPT private state"
      );
    }
    for (const workspaceRoot of trustedWorkspaceRoots) {
      const canonicalWorkspace = await canonicalizeExistingOrResolve(workspaceRoot);
      if (pathsOverlap(canonicalRoot, canonicalWorkspace)) {
        throw new DeveloperEnvironmentError(
          "DEV_ENV_ROOT_INSIDE_WORKSPACE",
          "Developer environment root overlaps a trusted workspace"
        );
      }
    }

    const metadata = await safeBigIntStat(canonicalRoot);
    if (!metadata.isDirectory() || !explicitRootModeIsSafe(metadata.mode, metadata.uid, metadata.gid)) {
      throw new DeveloperEnvironmentError(
        "DEV_ENV_ROOT_UNTRUSTED",
        "Developer environment root permissions are unsafe"
      );
    }

    for (const executableDir of executableDirs) {
      const candidate = executableDir === "." ? canonicalRoot : join(canonicalRoot, executableDir);
      let canonicalDirectory: string;
      try {
        canonicalDirectory = await realpath(candidate);
      } catch (error) {
        throw new DeveloperEnvironmentError(
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "DEV_ENV_ROOT_NOT_FOUND"
            : "DEV_ENV_ROOT_UNTRUSTED",
          "Developer executable directory could not be inspected",
          { cause: error }
        );
      }
      if (!isBeneathOrEqual(canonicalDirectory, canonicalRoot)) {
        throw new DeveloperEnvironmentError(
          "DEV_ENV_ROOT_UNTRUSTED",
          "Developer executable directory escapes its registered root"
        );
      }
      const dirMetadata = await safeBigIntStat(canonicalDirectory);
      if (
        !dirMetadata.isDirectory() ||
        !explicitRootModeIsSafe(dirMetadata.mode, dirMetadata.uid, dirMetadata.gid)
      ) {
        throw new DeveloperEnvironmentError(
          "DEV_ENV_ROOT_UNTRUSTED",
          "Developer executable directory permissions are unsafe"
        );
      }
    }

    return {
      canonicalRoot,
      identity: filesystemIdentity(metadata.dev, metadata.ino)
    };
  }

  async #revalidateEntry(entry: DeveloperEnvironmentEntry): Promise<void> {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(entry.canonicalRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DeveloperEnvironmentError(
          "DEV_ENV_ROOT_NOT_FOUND",
          "Registered developer environment root is missing",
          { cause: error }
        );
      }
      throw error;
    }
    const metadata = await safeBigIntStat(canonicalRoot);
    if (!metadata.isDirectory() || !explicitRootModeIsSafe(metadata.mode, metadata.uid, metadata.gid)) {
      throw new DeveloperEnvironmentError(
        "DEV_ENV_ROOT_UNTRUSTED",
        "Registered developer environment root is no longer safe"
      );
    }
    const identity = filesystemIdentity(metadata.dev, metadata.ino);
    if (canonicalRoot !== entry.canonicalRoot || !sameIdentity(identity, entry.identity)) {
      throw new DeveloperEnvironmentError(
        "DEV_ENV_ROOT_CHANGED",
        "Registered developer environment root identity changed"
      );
    }
  }

  async #diagnoseExecutable(
    entry: DeveloperEnvironmentEntry,
    executable: string
  ): Promise<DeveloperExecutableDiagnosticStatus> {
    const rootMetadata = await safeBigIntStat(entry.canonicalRoot);
    let unsafeCandidate = false;
    for (const executableDir of entry.executableDirs) {
      const candidate = executableDir === "."
        ? join(entry.canonicalRoot, executable)
        : join(entry.canonicalRoot, executableDir, executable);
      let canonical: string;
      try {
        canonical = await realpath(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        unsafeCandidate = true;
        continue;
      }
      if (!isBeneathOrEqual(canonical, entry.canonicalRoot) || canonical === entry.canonicalRoot) {
        unsafeCandidate = true;
        continue;
      }
      const metadata = await safeBigIntStat(canonical);
      const mode = Number(metadata.mode & 0o7777n);
      const ownerAllowed = metadata.uid === rootMetadata.uid || metadata.uid === 0n;
      if (
        !metadata.isFile() ||
        !ownerAllowed ||
        (mode & 0o6000) !== 0 ||
        (mode & 0o022) !== 0 ||
        (mode & 0o111) === 0
      ) {
        unsafeCandidate = true;
        continue;
      }
      return "available";
    }
    return unsafeCandidate ? "unavailable" : "absent";
  }

  async #canonicalStateRoot(): Promise<string> {
    await mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
    return realpath(this.#stateRoot);
  }

  async #readDocument(): Promise<DeveloperEnvironmentDocument> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: DEVELOPER_ENVIRONMENT_SCHEMA_VERSION, entries: [] };
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      throw new DeveloperEnvironmentError(
        "DEV_ENV_REGISTRY_INVALID",
        "Developer environment registry is invalid JSON",
        { cause: error }
      );
    }
    return parseDocument(value);
  }

  async #writeDocument(document: DeveloperEnvironmentDocument): Promise<void> {
    if (document.entries.length > MAX_DEVELOPER_ENVIRONMENTS) {
      throw new DeveloperEnvironmentError(
        "DEV_ENV_LIMIT_EXCEEDED",
        `Developer environment registry is limited to ${MAX_DEVELOPER_ENVIRONMENTS} entries`
      );
    }
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);

    const temporaryPath = join(
      directory,
      `.registry.json.${process.pid}.${randomUUID().replaceAll("-", "")}.tmp`
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.#path);
      await chmod(this.#path, 0o600);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

const SYSTEM_EXECUTABLE_DIRS = new Set(["/usr/local/bin", "/usr/bin", "/bin"]);

function parseDocument(value: unknown): DeveloperEnvironmentDocument {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "entries"])) {
    throw new DeveloperEnvironmentError(
      "DEV_ENV_REGISTRY_INVALID",
      "Developer environment registry must be a closed object"
    );
  }
  if (value.schemaVersion !== DEVELOPER_ENVIRONMENT_SCHEMA_VERSION) {
    throw new DeveloperEnvironmentError(
      "DEV_ENV_SCHEMA_UNSUPPORTED",
      `Unsupported developer environment schema version: ${String(value.schemaVersion)}`
    );
  }
  if (!Array.isArray(value.entries)) {
    throw new DeveloperEnvironmentError(
      "DEV_ENV_REGISTRY_INVALID",
      "Developer environment registry entries must be an array"
    );
  }
  if (value.entries.length > MAX_DEVELOPER_ENVIRONMENTS) {
    throw new DeveloperEnvironmentError(
      "DEV_ENV_LIMIT_EXCEEDED",
      `Developer environment registry is limited to ${MAX_DEVELOPER_ENVIRONMENTS} entries`
    );
  }
  const entries = value.entries.map(parseEntry);
  const ids = new Set<string>();
  const roots = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id) || roots.has(entry.canonicalRoot)) {
      throw new DeveloperEnvironmentError(
        "DEV_ENV_REGISTRY_INVALID",
        "Developer environment registry contains duplicate identity or root"
      );
    }
    ids.add(entry.id);
    roots.add(entry.canonicalRoot);
  }
  return { schemaVersion: DEVELOPER_ENVIRONMENT_SCHEMA_VERSION, entries };
}

function parseEntry(value: unknown): DeveloperEnvironmentEntry {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["id", "label", "source", "canonicalRoot", "executableDirs", "identity"])
  ) {
    throw new DeveloperEnvironmentError(
      "DEV_ENV_REGISTRY_INVALID",
      "Developer environment entry must be a closed object"
    );
  }
  if (typeof value.id !== "string" || !/^denv_[a-f0-9]{32}$/.test(value.id)) {
    throw new DeveloperEnvironmentError("DEV_ENV_REGISTRY_INVALID", "Invalid developer environment id");
  }
  if (typeof value.label !== "string") {
    throw new DeveloperEnvironmentError("DEV_ENV_REGISTRY_INVALID", "Invalid developer environment label");
  }
  validateLabel(value.label);
  if (typeof value.source !== "string") {
    throw new DeveloperEnvironmentError("DEV_ENV_REGISTRY_INVALID", "Invalid developer environment source");
  }
  validateSource(value.source);
  if (typeof value.canonicalRoot !== "string" || !isAbsolute(value.canonicalRoot) || value.canonicalRoot.includes("\0")) {
    throw new DeveloperEnvironmentError("DEV_ENV_REGISTRY_INVALID", "Invalid developer environment root");
  }
  if (!Array.isArray(value.executableDirs) || !value.executableDirs.every((item) => typeof item === "string")) {
    throw new DeveloperEnvironmentError("DEV_ENV_REGISTRY_INVALID", "Invalid developer executable directories");
  }
  const executableDirs = validateExecutableDirs(value.executableDirs as string[]);
  const identity = parseIdentity(value.identity);
  return {
    id: value.id,
    label: value.label,
    source: value.source,
    canonicalRoot: value.canonicalRoot,
    executableDirs,
    identity
  };
}

function validateLabel(label: string): void {
  const bytes = Buffer.byteLength(label, "utf8");
  if (bytes < 1 || bytes > MAX_DEVELOPER_ENVIRONMENT_LABEL_BYTES || label.includes("\0")) {
    throw new DeveloperEnvironmentError("DEV_ENV_REGISTRY_INVALID", "Invalid developer environment label");
  }
}

function validateSource(value: string): asserts value is DeveloperEnvironmentSource {
  if (value !== "bootstrap" && value !== "operator" && value !== "synced-shell") {
    throw new DeveloperEnvironmentError("DEV_ENV_REGISTRY_INVALID", "Invalid developer environment source");
  }
}

function validateExecutableDirs(values: string[]): string[] {
  if (values.length < 1 || values.length > MAX_DEVELOPER_EXECUTABLE_DIRS) {
    throw new DeveloperEnvironmentError(
      "DEV_ENV_LIMIT_EXCEEDED",
      `Developer environment executable directories are limited to ${MAX_DEVELOPER_EXECUTABLE_DIRS}`
    );
  }
  const normalized: string[] = [];
  for (const value of values) {
    if (
      value.length === 0 ||
      value.length > 4096 ||
      value.includes("\0") ||
      value.includes(delimiter) ||
      isAbsolute(value) ||
      value.split(/[\\/]/).some((component) => component === "..")
    ) {
      throw new DeveloperEnvironmentError(
        "DEV_ENV_REGISTRY_INVALID",
        "Developer executable directory must remain relative to its registered root"
      );
    }
    const candidate = value === "." ? "." : value.replace(/^\.\//, "").replace(/\/$/, "");
    if (candidate.length === 0 || normalized.includes(candidate)) {
      throw new DeveloperEnvironmentError(
        "DEV_ENV_REGISTRY_INVALID",
        "Developer executable directories must be unique normalized paths"
      );
    }
    normalized.push(candidate);
  }
  return normalized;
}

function parseIdentity(value: unknown): PersistentFilesystemIdentity {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["deviceMajor", "deviceMinor", "inode"]) ||
    !Number.isSafeInteger(value.deviceMajor) ||
    (value.deviceMajor as number) < 0 ||
    !Number.isSafeInteger(value.deviceMinor) ||
    (value.deviceMinor as number) < 0 ||
    typeof value.inode !== "string" ||
    !/^\d+$/.test(value.inode)
  ) {
    throw new DeveloperEnvironmentError(
      "DEV_ENV_REGISTRY_INVALID",
      "Invalid developer environment filesystem identity"
    );
  }
  return {
    deviceMajor: value.deviceMajor as number,
    deviceMinor: value.deviceMinor as number,
    inode: value.inode
  };
}

function filesystemIdentity(device: bigint, inode: bigint): PersistentFilesystemIdentity {
  const major = Number(
    ((device & 0x00000000000fff00n) >> 8n) | ((device & 0xfffff00000000000n) >> 32n)
  );
  const minor = Number(
    (device & 0x00000000000000ffn) | ((device & 0x00000ffffff00000n) >> 12n)
  );
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    throw new DeveloperEnvironmentError(
      "DEV_ENV_ROOT_UNTRUSTED",
      "Developer environment device identity is outside the supported range"
    );
  }
  return { deviceMajor: major, deviceMinor: minor, inode: inode.toString(10) };
}

async function safeBigIntStat(path: string) {
  try {
    return await stat(path, { bigint: true });
  } catch (error) {
    throw new DeveloperEnvironmentError(
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "DEV_ENV_ROOT_NOT_FOUND"
        : "DEV_ENV_ROOT_UNTRUSTED",
      "Developer environment filesystem metadata is unavailable",
      { cause: error }
    );
  }
}

function explicitRootModeIsSafe(mode: bigint, uid: bigint, gid: bigint): boolean {
  const bits = Number(mode & 0o7777n);
  return (bits & 0o6000) === 0 && (bits & 0o002) === 0 && !((bits & 0o020) !== 0 && gid !== uid);
}

function diagnosticStatusForError(
  error: DeveloperEnvironmentError
): DeveloperEnvironmentDiagnosticStatus {
  switch (error.code) {
    case "DEV_ENV_ROOT_NOT_FOUND":
      return "missing";
    case "DEV_ENV_ROOT_CHANGED":
      return "changed";
    case "DEV_ENV_ROOT_UNTRUSTED":
      return "unsafe";
    default:
      throw error;
  }
}

async function canOpenDirectory(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    return (await handle.stat()).isDirectory();
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isSimpleLogicalExecutableName(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\0") &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return isBeneathOrEqual(left, right) || isBeneathOrEqual(right, left);
}

function isBeneathOrEqual(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function canonicalizeExistingOrResolve(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(path);
    throw error;
  }
}

function sameIdentity(
  left: PersistentFilesystemIdentity,
  right: PersistentFilesystemIdentity
): boolean {
  return (
    left.deviceMajor === right.deviceMajor &&
    left.deviceMinor === right.deviceMinor &&
    left.inode === right.inode
  );
}

function sameEntry(left: DeveloperEnvironmentEntry, right: DeveloperEnvironmentEntry): boolean {
  return (
    left.id === right.id &&
    left.label === right.label &&
    left.source === right.source &&
    left.canonicalRoot === right.canonicalRoot &&
    left.executableDirs.length === right.executableDirs.length &&
    left.executableDirs.every((value, index) => value === right.executableDirs[index]) &&
    sameIdentity(left.identity, right.identity)
  );
}

function cloneEntry(entry: DeveloperEnvironmentEntry): DeveloperEnvironmentEntry {
  return {
    ...entry,
    executableDirs: [...entry.executableDirs],
    identity: { ...entry.identity }
  };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return expected.length === actual.length && expected.every((key, index) => key === actual[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
