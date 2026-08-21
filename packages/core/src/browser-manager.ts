import type {
  EvidenceSourceStateRef,
  PreviewLookupInput,
  PreviewStatusResult
} from "./preview-manager.js";

export const MAX_BROWSER_SESSIONS = 8;
export const BROWSER_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
export const BROWSER_EVIDENCE_MAX_BYTES = 32 * 1024;
export const BROWSER_CONSOLE_MAX_ENTRIES = 100;
export const BROWSER_NETWORK_FAILURE_MAX_ENTRIES = 100;
export const BROWSER_ENTRY_MAX_BYTES = 2 * 1024;
export const BROWSER_TYPE_MAX_BYTES = 16 * 1024;
export const BROWSER_TARGET_MAX_BYTES = 2 * 1024;
export const DEFAULT_BROWSER_VIEWPORT = Object.freeze({ width: 1280, height: 720 });

export type BrowserManagerErrorCode =
  | "BROWSER_PREVIEW_NOT_READY"
  | "BROWSER_SESSION_NOT_FOUND"
  | "BROWSER_LIMIT_REACHED"
  | "BROWSER_ORIGIN_INVALID"
  | "BROWSER_TARGET_INVALID"
  | "BROWSER_ACTION_FAILED"
  | "BROWSER_SCREENSHOT_TOO_LARGE"
  | "BROWSER_UNAVAILABLE";

export class BrowserManagerError extends Error {
  constructor(
    readonly code: BrowserManagerErrorCode,
    message: string
  ) {
    super(message);
    this.name = "BrowserManagerError";
  }
}

export interface BrowserViewport {
  width: number;
  height: number;
}

export type BrowserTarget =
  | { kind: "css"; selector: string }
  | { kind: "role"; role: string; name?: string };

export interface BrowserArtifactMetadata {
  schemaVersion: 1;
  uri: string;
  mediaType: string;
  sizeBytes: number;
  sourceTruncated: boolean;
}

export interface BrowserArtifactWriter {
  write(mediaType: string, bytes: Uint8Array): Promise<BrowserArtifactMetadata>;
}

export interface PreviewBrowserAdapter {
  inspect(input: PreviewLookupInput): Promise<PreviewStatusResult>;
}

export interface BrowserConsoleEvent {
  level: string;
  text: string;
}

export interface BrowserNetworkFailureEvent {
  method: string;
  url: string;
  resourceType: string;
  failureText: string;
}

export interface BrowserDriverInspectResult {
  title: string;
  url: string;
  bodyText: string;
  ariaSnapshot: string;
  viewport: BrowserViewport;
}

export interface BrowserDriverSession {
  inspect(): Promise<BrowserDriverInspectResult>;
  click(target: BrowserTarget): Promise<void>;
  type(target: BrowserTarget, text: string, submit: boolean): Promise<void>;
  setViewport(viewport: BrowserViewport): Promise<void>;
  screenshot(fullPage: boolean): Promise<Uint8Array>;
  close(): Promise<void>;
}

export type BrowserNetworkMode = "deny" | "localhost" | "allowlist" | "unrestricted";

export interface BrowserWorkspaceAuthority {
  networkMode(workspaceId: string): BrowserNetworkMode | Promise<BrowserNetworkMode>;
}

export interface BrowserDriverOpenInput {
  url: string;
  origin: string;
  viewport: BrowserViewport;
  networkMode(): BrowserNetworkMode | Promise<BrowserNetworkMode>;
  onConsole(event: BrowserConsoleEvent): void;
  onNetworkFailure(event: BrowserNetworkFailureEvent): void;
  onDisconnect(): void;
}

export interface BrowserDriver {
  open(input: BrowserDriverOpenInput): Promise<BrowserDriverSession>;
}

export interface BrowserPreviewInput {
  workspaceId: string;
  previewId: string;
}

export interface BrowserOpenPreviewInput extends BrowserPreviewInput {
  viewport?: BrowserViewport;
}

export interface BrowserClickInput extends BrowserPreviewInput {
  target: BrowserTarget;
}

export interface BrowserTypeInput extends BrowserPreviewInput {
  target: BrowserTarget;
  text: string;
  submit?: boolean;
}

export interface BrowserSetViewportInput extends BrowserPreviewInput {
  viewport: BrowserViewport;
}

export interface BrowserScreenshotInput extends BrowserPreviewInput {
  fullPage?: boolean;
}

export interface BrowserOpenResult {
  schemaVersion: 1;
  previewId: string;
  url: string;
  viewport: BrowserViewport;
  sourceState: EvidenceSourceStateRef;
}

export interface BrowserInspectResult extends BrowserOpenResult {
  title: string;
  bodyText: string;
  ariaSnapshot: string;
  truncated: boolean;
  truncationReasons: string[];
}

export interface BrowserConsoleEntry {
  level: string;
  text: string;
}

export interface BrowserNetworkFailureEntry {
  method: string;
  url: string;
  resourceType: string;
  failureText: string;
}

export interface BrowserConsoleResult {
  schemaVersion: 1;
  previewId: string;
  entries: BrowserConsoleEntry[];
  truncated: boolean;
  sourceState: EvidenceSourceStateRef;
}

export interface BrowserNetworkFailuresResult {
  schemaVersion: 1;
  previewId: string;
  entries: BrowserNetworkFailureEntry[];
  truncated: boolean;
  sourceState: EvidenceSourceStateRef;
}

export interface BrowserActionResult {
  schemaVersion: 1;
  previewId: string;
  ok: true;
  sourceState: EvidenceSourceStateRef;
}

export interface BrowserScreenshotResult {
  schemaVersion: 1;
  previewId: string;
  artifact: BrowserArtifactMetadata;
  viewport: BrowserViewport;
  sourceState: EvidenceSourceStateRef;
}

interface SessionRecord {
  workspaceId: string;
  previewId: string;
  url: string;
  origin: string;
  viewport: BrowserViewport;
  sourceState: EvidenceSourceStateRef;
  driver: BrowserDriverSession;
  consoleEntries: BrowserConsoleEntry[];
  consoleTruncated: boolean;
  networkFailures: BrowserNetworkFailureEntry[];
  networkTruncated: boolean;
}

function sessionKey(workspaceId: string, previewId: string): string {
  return `${workspaceId}\u0000${previewId}`;
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { value: value.slice(0, low), truncated: true };
}

function validateViewport(viewport: BrowserViewport | undefined): BrowserViewport {
  const candidate = viewport ?? DEFAULT_BROWSER_VIEWPORT;
  if (
    !Number.isInteger(candidate.width) ||
    !Number.isInteger(candidate.height) ||
    candidate.width < 320 ||
    candidate.width > 3840 ||
    candidate.height < 240 ||
    candidate.height > 2160
  ) {
    throw new BrowserManagerError("BROWSER_TARGET_INVALID", "browser viewport is invalid");
  }
  return { width: candidate.width, height: candidate.height };
}

function validateTarget(target: BrowserTarget): void {
  if (target.kind === "css") {
    if (
      target.selector.length === 0 ||
      Buffer.byteLength(target.selector, "utf8") > BROWSER_TARGET_MAX_BYTES
    ) {
      throw new BrowserManagerError("BROWSER_TARGET_INVALID", "browser target is invalid");
    }
    return;
  }
  if (
    target.kind !== "role" ||
    target.role.length === 0 ||
    Buffer.byteLength(target.role, "utf8") > 128 ||
    (target.name !== undefined && Buffer.byteLength(target.name, "utf8") > BROWSER_TARGET_MAX_BYTES)
  ) {
    throw new BrowserManagerError("BROWSER_TARGET_INVALID", "browser target is invalid");
  }
}

function parsePreviewOrigin(urlText: string): { url: string; origin: string } {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new BrowserManagerError("BROWSER_ORIGIN_INVALID", "preview browser origin is invalid");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
    throw new BrowserManagerError("BROWSER_ORIGIN_INVALID", "preview browser origin is invalid");
  }
  return { url: url.href, origin: url.origin };
}

function redactFailureUrl(urlText: string): string {
  try {
    const url = new URL(urlText);
    url.search = "";
    url.hash = "";
    return truncateUtf8(`${url.origin}${url.pathname}`, BROWSER_ENTRY_MAX_BYTES).value;
  } catch {
    return "invalid-url";
  }
}

export class BrowserManager {
  readonly #preview: PreviewBrowserAdapter;
  readonly #driver: BrowserDriver;
  readonly #artifacts: BrowserArtifactWriter;
  readonly #authority: BrowserWorkspaceAuthority | undefined;
  readonly #sessions = new Map<string, SessionRecord>();

  constructor(
    preview: PreviewBrowserAdapter,
    driver: BrowserDriver,
    artifacts: BrowserArtifactWriter,
    authority?: BrowserWorkspaceAuthority
  ) {
    this.#preview = preview;
    this.#driver = driver;
    this.#artifacts = artifacts;
    this.#authority = authority;
  }

  async openPreview(input: BrowserOpenPreviewInput): Promise<BrowserOpenResult> {
    const live = await this.#inspectLivePreview(input);
    const parsed = parsePreviewOrigin(live.url);
    const key = sessionKey(input.workspaceId, input.previewId);
    const existing = this.#sessions.get(key);
    if (existing) {
      if (existing.url !== parsed.url || existing.origin !== parsed.origin) {
        await this.releasePreview(input.workspaceId, input.previewId);
        throw new BrowserManagerError("BROWSER_PREVIEW_NOT_READY", "preview browser identity changed");
      }
      return this.#openResult(existing);
    }
    if (this.#sessions.size >= MAX_BROWSER_SESSIONS) {
      throw new BrowserManagerError("BROWSER_LIMIT_REACHED", "browser session limit reached");
    }
    const viewport = validateViewport(input.viewport);
    const networkMode = async (): Promise<BrowserNetworkMode> => {
      if (!this.#authority) return "deny";
      try {
        return await this.#authority.networkMode(input.workspaceId);
      } catch {
        return "deny";
      }
    };
    const consoleEntries: BrowserConsoleEntry[] = [];
    const networkFailures: BrowserNetworkFailureEntry[] = [];
    let consoleTruncated = false;
    let networkTruncated = false;
    let disconnected = false;
    let driverSession: BrowserDriverSession;
    try {
      driverSession = await this.#driver.open({
        url: parsed.url,
        origin: parsed.origin,
        viewport,
        networkMode,
        onConsole: (event) => {
          const entry = {
            level: truncateUtf8(event.level, 64).value,
            text: truncateUtf8(event.text, BROWSER_ENTRY_MAX_BYTES).value
          };
          if (consoleEntries.length >= BROWSER_CONSOLE_MAX_ENTRIES) {
            consoleEntries.shift();
            consoleTruncated = true;
          }
          consoleEntries.push(entry);
        },
        onNetworkFailure: (event) => {
          const entry = {
            method: truncateUtf8(event.method, 32).value,
            url: redactFailureUrl(event.url),
            resourceType: truncateUtf8(event.resourceType, 64).value,
            failureText: truncateUtf8(event.failureText, BROWSER_ENTRY_MAX_BYTES).value
          };
          if (networkFailures.length >= BROWSER_NETWORK_FAILURE_MAX_ENTRIES) {
            networkFailures.shift();
            networkTruncated = true;
          }
          networkFailures.push(entry);
        },
        onDisconnect: () => {
          disconnected = true;
          this.#sessions.delete(key);
        }
      });
    } catch (error) {
      if (error instanceof BrowserManagerError) throw error;
      throw new BrowserManagerError("BROWSER_UNAVAILABLE", `browser launch failed: ${String(error)}`);
    }
    if (disconnected) {
      await driverSession.close().catch(() => undefined);
      throw new BrowserManagerError("BROWSER_UNAVAILABLE", "browser disconnected during launch");
    }
    const record: SessionRecord = {
      workspaceId: input.workspaceId,
      previewId: input.previewId,
      url: parsed.url,
      origin: parsed.origin,
      viewport,
      sourceState: { ...live.sourceState },
      driver: driverSession,
      consoleEntries,
      get consoleTruncated() {
        return consoleTruncated;
      },
      set consoleTruncated(value: boolean) {
        consoleTruncated = value;
      },
      networkFailures,
      get networkTruncated() {
        return networkTruncated;
      },
      set networkTruncated(value: boolean) {
        networkTruncated = value;
      }
    };
    this.#sessions.set(key, record);
    return this.#openResult(record);
  }

  async inspect(input: BrowserPreviewInput): Promise<BrowserInspectResult> {
    const record = await this.#requireLiveSession(input);
    let evidence: BrowserDriverInspectResult;
    try {
      evidence = await record.driver.inspect();
    } catch (error) {
      throw new BrowserManagerError("BROWSER_ACTION_FAILED", `browser inspect failed: ${String(error)}`);
    }
    const currentOrigin = parsePreviewOrigin(evidence.url);
    if (currentOrigin.origin !== record.origin) {
      await this.releasePreview(input.workspaceId, input.previewId);
      throw new BrowserManagerError("BROWSER_ORIGIN_INVALID", "browser left preview origin");
    }
    const textEvidenceBudget = BROWSER_EVIDENCE_MAX_BYTES - BROWSER_ENTRY_MAX_BYTES * 2;
    const body = truncateUtf8(evidence.bodyText, Math.floor(textEvidenceBudget / 2));
    const aria = truncateUtf8(evidence.ariaSnapshot, Math.ceil(textEvidenceBudget / 2));
    const title = truncateUtf8(evidence.title, BROWSER_ENTRY_MAX_BYTES);
    const url = truncateUtf8(evidence.url, BROWSER_ENTRY_MAX_BYTES);
    const reasons = [
      ...(body.truncated ? ["bodyText"] : []),
      ...(aria.truncated ? ["ariaSnapshot"] : []),
      ...(title.truncated ? ["title"] : []),
      ...(url.truncated ? ["url"] : [])
    ];
    return {
      schemaVersion: 1,
      previewId: record.previewId,
      url: url.value,
      viewport: { ...evidence.viewport },
      title: title.value,
      bodyText: body.value,
      ariaSnapshot: aria.value,
      truncated: reasons.length > 0,
      truncationReasons: reasons,
      sourceState: { ...record.sourceState }
    };
  }

  async setViewport(input: BrowserSetViewportInput): Promise<BrowserOpenResult> {
    const viewport = validateViewport(input.viewport);
    const record = await this.#requireLiveSession(input);
    try {
      await record.driver.setViewport(viewport);
    } catch (error) {
      throw new BrowserManagerError("BROWSER_ACTION_FAILED", `browser viewport resize failed: ${String(error)}`);
    }
    record.viewport = { ...viewport };
    return this.#openResult(record);
  }

  async click(input: BrowserClickInput): Promise<BrowserActionResult> {
    validateTarget(input.target);
    const record = await this.#requireLiveSession(input);
    try {
      await record.driver.click(input.target);
    } catch (error) {
      throw new BrowserManagerError("BROWSER_ACTION_FAILED", `browser click failed: ${String(error)}`);
    }
    return {
      schemaVersion: 1,
      previewId: record.previewId,
      ok: true,
      sourceState: { ...record.sourceState }
    };
  }

  async type(input: BrowserTypeInput): Promise<BrowserActionResult> {
    validateTarget(input.target);
    if (Buffer.byteLength(input.text, "utf8") > BROWSER_TYPE_MAX_BYTES) {
      throw new BrowserManagerError("BROWSER_TARGET_INVALID", "browser type input is invalid");
    }
    const record = await this.#requireLiveSession(input);
    try {
      await record.driver.type(input.target, input.text, input.submit ?? false);
    } catch (error) {
      throw new BrowserManagerError("BROWSER_ACTION_FAILED", `browser type failed: ${String(error)}`);
    }
    return {
      schemaVersion: 1,
      previewId: record.previewId,
      ok: true,
      sourceState: { ...record.sourceState }
    };
  }

  async screenshot(input: BrowserScreenshotInput): Promise<BrowserScreenshotResult> {
    const record = await this.#requireLiveSession(input);
    let bytes: Uint8Array;
    try {
      bytes = await record.driver.screenshot(input.fullPage ?? false);
    } catch (error) {
      throw new BrowserManagerError("BROWSER_ACTION_FAILED", `browser screenshot failed: ${String(error)}`);
    }
    if (bytes.byteLength > BROWSER_SCREENSHOT_MAX_BYTES) {
      throw new BrowserManagerError(
        "BROWSER_SCREENSHOT_TOO_LARGE",
        "browser screenshot exceeds the bounded artifact limit"
      );
    }
    if (
      bytes.byteLength < 4 ||
      bytes[0] !== 137 ||
      bytes[1] !== 80 ||
      bytes[2] !== 78 ||
      bytes[3] !== 71
    ) {
      throw new BrowserManagerError("BROWSER_ACTION_FAILED", "browser screenshot is not PNG");
    }
    const artifact = await this.#artifacts.write("image/png", bytes);
    return {
      schemaVersion: 1,
      previewId: record.previewId,
      artifact,
      viewport: { ...record.viewport },
      sourceState: { ...record.sourceState }
    };
  }

  async console(input: BrowserPreviewInput): Promise<BrowserConsoleResult> {
    const record = await this.#requireLiveSession(input);
    return {
      schemaVersion: 1,
      previewId: record.previewId,
      entries: record.consoleEntries.map((entry) => ({ ...entry })),
      truncated: record.consoleTruncated,
      sourceState: { ...record.sourceState }
    };
  }

  async networkFailures(input: BrowserPreviewInput): Promise<BrowserNetworkFailuresResult> {
    const record = await this.#requireLiveSession(input);
    return {
      schemaVersion: 1,
      previewId: record.previewId,
      entries: record.networkFailures.map((entry) => ({ ...entry })),
      truncated: record.networkTruncated,
      sourceState: { ...record.sourceState }
    };
  }

  async releasePreview(workspaceId: string, previewId: string): Promise<void> {
    const key = sessionKey(workspaceId, previewId);
    const record = this.#sessions.get(key);
    if (!record) return;
    this.#sessions.delete(key);
    await record.driver.close().catch(() => undefined);
  }

  async releaseWorkspace(workspaceId: string): Promise<void> {
    const records = [...this.#sessions.values()].filter((record) => record.workspaceId === workspaceId);
    for (const record of records) {
      await this.releasePreview(record.workspaceId, record.previewId);
    }
  }

  async close(): Promise<void> {
    const records = [...this.#sessions.values()];
    for (const record of records) {
      await this.releasePreview(record.workspaceId, record.previewId);
    }
  }

  #openResult(record: SessionRecord): BrowserOpenResult {
    return {
      schemaVersion: 1,
      previewId: record.previewId,
      url: record.url,
      viewport: { ...record.viewport },
      sourceState: { ...record.sourceState }
    };
  }

  async #inspectLivePreview(input: BrowserPreviewInput): Promise<PreviewStatusResult> {
    let status: PreviewStatusResult;
    try {
      status = await this.#preview.inspect({
        workspaceId: input.workspaceId,
        previewId: input.previewId
      });
    } catch {
      throw new BrowserManagerError("BROWSER_PREVIEW_NOT_READY", "preview is not ready for browser evidence");
    }
    if (status.processState !== "running" || !status.reachable) {
      throw new BrowserManagerError("BROWSER_PREVIEW_NOT_READY", "preview is not ready for browser evidence");
    }
    return status;
  }

  async #requireLiveSession(input: BrowserPreviewInput): Promise<SessionRecord> {
    const key = sessionKey(input.workspaceId, input.previewId);
    const record = this.#sessions.get(key);
    if (!record) {
      throw new BrowserManagerError("BROWSER_SESSION_NOT_FOUND", "browser preview session was not found");
    }
    const live = await this.#inspectLivePreview(input);
    const parsed = parsePreviewOrigin(live.url);
    if (parsed.url !== record.url || parsed.origin !== record.origin) {
      await this.releasePreview(input.workspaceId, input.previewId);
      throw new BrowserManagerError("BROWSER_PREVIEW_NOT_READY", "preview browser identity changed");
    }
    return record;
  }
}
