import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { ArtifactStore } from "@kodegpt/artifacts";
import { AuditReader, type PublicAuditEvent } from "@kodegpt/audit";
import {
  ConnectorBearerAuthenticator,
  ConnectorCredentialStore,
  createHttpTrustConfig,
  type HttpTrustConfig
} from "@kodegpt/auth";
import { NativeCapabilityService } from "@kodegpt/capabilities";
import {
  ExecutionManager,
  KernelClient,
  WorkspaceManager,
  type KernelHello
} from "@kodegpt/core";
import { ExtensionRegistry } from "@kodegpt/extensions";
import {
  MCP_SURFACE_VERSION,
  createKodegptNodeHandler,
  createKodegptToolContext,
  type BearerAuthenticator,
  type ExtensionRegistryToolAdapter,
  type KodegptToolContext,
  type WorkspaceManagerToolAdapter
} from "@kodegpt/mcp-server";
import { getProfilePreset } from "@kodegpt/profiles";
import { WorkspaceTrustStore } from "@kodegpt/trust";

export const MCP_PROTOCOL_VERSION = "2026-07-28" as const;
export const DEFAULT_MCP_PORT = 43_121;
export const DEFAULT_MCP_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const LOOPBACK_HOST = "127.0.0.1" as const;

type ProfileName = "observe" | "develop" | "trusted";

export interface StartKernel {
  request<T>(method: string, params: Record<string, unknown>, requestId?: string): Promise<T>;
  hello(): Promise<KernelHello>;
  stop(): Promise<void>;
}

export interface TrustProfileBundle {
  trust: unknown;
  inspectProfile(name: ProfileName): unknown;
}

export interface ManagerBundle {
  workspaceManager: WorkspaceManagerToolAdapter &
    Pick<
      WorkspaceManager,
      | "runProcess"
      | "processStatus"
      | "processCancel"
      | "treeBounded"
      | "searchBounded"
      | "gitCheckpoint"
      | "gitCheckpointPatch"
      | "pathIdentity"
      | "inspectExecutable"
      | "runVerificationProcess"
    >;
}

export interface McpNodeHandle {
  handler(request: IncomingMessage, response: ServerResponse): Promise<void>;
  close(): Promise<void>;
}

export interface BoundLoopbackServer {
  host: typeof LOOPBACK_HOST;
  port: number;
  close(): Promise<void>;
}

export interface StartDependencies extends ProductionServiceStackDependencies {
  createMcp(options: {
    toolContext: KodegptToolContext;
    httpTrust: HttpTrustConfig;
    bearerAuthenticator: BearerAuthenticator;
    queryCredentialCompatibility?: boolean;
  }): McpNodeHandle;
  bindLoopback(options: { mcp: McpNodeHandle; port: number }): Promise<BoundLoopbackServer>;
}

export interface StartKodegptOptions {
  runtimePath: string;
  stateRoot?: string;
  port?: number;
  publicUrl?: string;
  maxRequestBodyBytes?: number;
  queryCredentialCompatibility?: boolean;
  allowMissingConnectorCredential?: boolean;
}

export interface KodegptStartStatus {
  host: typeof LOOPBACK_HOST;
  port: number;
  protocolVersion: typeof MCP_PROTOCOL_VERSION;
  surfaceVersion: typeof MCP_SURFACE_VERSION;
  runtimeVersion: string;
  auditHealthy: true;
  filesystemBoundaryAvailable: true;
}

export interface StartedKodegpt {
  status: KodegptStartStatus;
  close(): Promise<void>;
}

export async function runStartCommand(
  args: string[],
  dependencies: StartDependencies = defaultStartDependencies
): Promise<StartedKodegpt> {
  return startKodegpt(parseStartArguments(args), dependencies);
}

export function formatKodegptStartStatus(status: KodegptStartStatus): string {
  return [
    `KodeGPT MCP listening on http://${status.host}:${status.port}`,
    `protocol=${status.protocolVersion}`,
    `surface=${status.surfaceVersion}`,
    `runtime=${status.runtimeVersion}`,
    `audit=${status.auditHealthy ? "healthy" : "unhealthy"}`,
    `filesystemBoundary=${status.filesystemBoundaryAvailable ? "available" : "unavailable"}`
  ].join(" ");
}

export interface ProductionServiceStackOptions {
  runtimePath: string;
  stateRoot?: string;
  allowMissingConnectorCredential?: boolean;
}

export interface ProductionServiceStackDependencies {
  prepareStateRoot(stateRoot: string): Promise<void>;
  prepareAudit(stateRoot: string): Promise<void>;
  prepareConnectorAuth?(
    stateRoot: string,
    options: { allowMissingCredential: boolean }
  ): Promise<BearerAuthenticator>;
  prepareExtensionRegistry(stateRoot: string): Promise<ExtensionRegistryToolAdapter>;
  startKernel(options: { runtimePath: string; stateRoot: string }): Promise<StartKernel>;
  createTrustProfile(stateRoot: string): TrustProfileBundle;
  createManagers(options: {
    kernel: StartKernel;
    trustProfile: TrustProfileBundle;
  }): ManagerBundle;
}

export interface ProductionServiceStack {
  stateRoot: string;
  kernel: StartKernel;
  hello: KernelHello;
  bearerAuthenticator?: BearerAuthenticator;
  toolContext: KodegptToolContext;
  extensionRegistry: ExtensionRegistryToolAdapter;
  close(): Promise<void>;
}

export async function createProductionServiceStack(
  options: ProductionServiceStackOptions,
  dependencies: ProductionServiceStackDependencies = defaultStartDependencies
): Promise<ProductionServiceStack> {
  if (options.runtimePath.length === 0) {
    throw new TypeError("runtimePath must not be empty");
  }
  const stateRoot = options.stateRoot ?? join(homedir(), ".kodegpt");

  let kernel: StartKernel | undefined;
  try {
    await dependencies.prepareStateRoot(stateRoot);
    await dependencies.prepareAudit(stateRoot);
    const bearerAuthenticator = dependencies.prepareConnectorAuth
      ? await dependencies.prepareConnectorAuth(stateRoot, {
          allowMissingCredential: options.allowMissingConnectorCredential ?? false
        })
      : undefined;
    const extensionRegistry = await dependencies.prepareExtensionRegistry(stateRoot);

    kernel = await dependencies.startKernel({ runtimePath: options.runtimePath, stateRoot });
    const hello = await kernel.hello();
    validateKernelCapabilities(hello);

    const trustProfile = dependencies.createTrustProfile(stateRoot);
    const managers = dependencies.createManagers({ kernel, trustProfile });
    const executionManager = new ExecutionManager(managers.workspaceManager);
    const artifactStore = new ArtifactStore(kernel);
    const auditReader = new AuditReader(stateRoot);
    const nativeCapabilities = new NativeCapabilityService({
      workspace: {
        inspection: {
          readFile: (workspaceId, path, readOptions) =>
            managers.workspaceManager.readFile(workspaceId, path, readOptions),
          tree: (workspaceId, path, maxEntries) =>
            managers.workspaceManager.treeBounded(workspaceId, path, maxEntries)
        },
        search: {
          search: (workspaceId, query, path, maxMatches) =>
            managers.workspaceManager.searchBounded(workspaceId, query, path, maxMatches)
        }
      },
      git: {
        checkpoint: async (workspaceId) => {
          const result = await managers.workspaceManager.gitCheckpoint(workspaceId);
          return {
            schemaVersion: 1,
            truncated: result.truncated,
            records: result.records.map((record) => ({
              ...record,
              ...(record.currentIdentity
                ? {
                    currentIdentity: {
                      exists: record.currentIdentity.exists,
                      ...(record.currentIdentity.kind ? { kind: record.currentIdentity.kind } : {}),
                      ...(record.currentIdentity.sizeBytes === undefined
                        ? {}
                        : { sizeBytes: record.currentIdentity.sizeBytes }),
                      ...(record.currentIdentity.sha256 ? { sha256: record.currentIdentity.sha256 } : {}),
                      hashTruncated: record.currentIdentity.hashTruncated
                    }
                  }
                : {})
            }))
          };
        },
        checkpointPatch: (workspaceId) => managers.workspaceManager.gitCheckpointPatch(workspaceId)
      },
      verification: {
        workspace: {
          readFile: (workspaceId, path, readOptions) =>
            managers.workspaceManager.readFile(workspaceId, path, readOptions),
          pathIdentity: async (workspaceId, path) => {
            const result = await managers.workspaceManager.pathIdentity(workspaceId, path, {
              includeSha256: false
            });
            return {
              exists: result.exists,
              ...(result.kind === undefined ? {} : { kind: result.kind }),
              ...(result.sizeBytes === undefined ? {} : { sizeBytes: result.sizeBytes }),
              hashTruncated: result.hashTruncated
            };
          },
          effectivePolicy: (workspaceId) => {
            const policy = managers.workspaceManager.requireReady(workspaceId).effectivePolicy;
            return {
              allowProcess: policy.allowProcess,
              allowedExecutableNames: [...policy.allowedExecutableNames]
            };
          }
        },
        availability: {
          inspectExecutable: (workspaceId, logicalExecutable) =>
            managers.workspaceManager.inspectExecutable(workspaceId, logicalExecutable)
        },
        execution: {
          run: (input) => managers.workspaceManager.runVerificationProcess(input)
        }
      }
    });
    const toolContext = createKodegptToolContext({
      workspaceManager: managers.workspaceManager,
      executionManager,
      artifactStore,
      nativeCapabilities,
      extensionRegistry,
      inspectProfile: trustProfile.inspectProfile,
      capabilities: async () => systemCapabilities(await kernel!.hello()),
      health: async () =>
        systemHealth(await kernel!.hello(), await auditReader.readRecentAuditEvents(20))
    });

    let closed = false;
    return {
      stateRoot,
      kernel,
      hello,
      bearerAuthenticator,
      toolContext,
      extensionRegistry,
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await kernel?.stop();
      }
    };
  } catch (error) {
    await kernel?.stop().catch(() => undefined);
    throw error;
  }
}

export async function startKodegpt(
  options: StartKodegptOptions,
  dependencies: StartDependencies = defaultStartDependencies
): Promise<StartedKodegpt> {
  const port = options.port ?? DEFAULT_MCP_PORT;
  const maxRequestBodyBytes =
    options.maxRequestBodyBytes ?? DEFAULT_MCP_MAX_REQUEST_BODY_BYTES;
  validatePort(port);
  if (
    options.allowMissingConnectorCredential &&
    (!(options.queryCredentialCompatibility ?? false) || options.publicUrl === undefined)
  ) {
    throw new Error(
      "Connector bootstrap requires explicit query credential compatibility and a public URL"
    );
  }

  const stack = await createProductionServiceStack(options, dependencies);
  let mcp: McpNodeHandle | undefined;
  let bound: BoundLoopbackServer | undefined;

  try {
    if (!stack.bearerAuthenticator) {
      throw new Error("Connector authenticator is missing for startKodegpt");
    }
    const authority = `${LOOPBACK_HOST}:${port}`;
    const httpTrust = createHttpTrustConfig({
      allowedHosts: [authority, `localhost:${port}`],
      allowedOriginHosts: [authority, `localhost:${port}`],
      ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
      maxRequestBodyBytes
    });

    mcp = dependencies.createMcp({
      toolContext: stack.toolContext,
      httpTrust,
      queryCredentialCompatibility: options.queryCredentialCompatibility ?? false,
      bearerAuthenticator: stack.bearerAuthenticator
    });
    bound = await dependencies.bindLoopback({ mcp, port });

    const status: KodegptStartStatus = {
      host: bound.host,
      port: bound.port,
      protocolVersion: MCP_PROTOCOL_VERSION,
      surfaceVersion: MCP_SURFACE_VERSION,
      runtimeVersion: stack.hello.runtimeVersion,
      auditHealthy: true,
      filesystemBoundaryAvailable: true
    };

    let closed = false;
    return {
      status,
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await closeRuntimeStack(bound, mcp, stack.kernel);
      }
    };
  } catch (error) {
    await closeRuntimeStack(bound, mcp, stack.kernel).catch(() => undefined);
    throw error;
  }
}

export const defaultStartDependencies: StartDependencies = {
  prepareStateRoot: async (stateRoot) => {
    await ensurePrivateDirectory(stateRoot);
  },
  prepareAudit: async (stateRoot) => {
    const logs = join(stateRoot, "logs");
    await ensurePrivateDirectory(logs);
    await ensurePrivateDirectory(join(logs, "security"));
  },
  prepareConnectorAuth: async (stateRoot, options) => {
    const store = new ConnectorCredentialStore(stateRoot);
    if (!options.allowMissingCredential && (await store.loadVerifier()) === undefined) {
      throw new Error("Connector credential is unavailable; rotate a connector credential first");
    }
    return new ConnectorBearerAuthenticator(store);
  },
  prepareExtensionRegistry: (stateRoot) => ExtensionRegistry.open(stateRoot),
  startKernel: (options) => KernelClient.start(options),
  createTrustProfile: (stateRoot) => ({
    trust: new WorkspaceTrustStore(stateRoot),
    inspectProfile: (name) => getProfilePreset(name)
  }),
  createManagers: ({ kernel, trustProfile }) => ({
    workspaceManager: new WorkspaceManager({
      kernel,
      trust: trustProfile.trust as WorkspaceTrustStore
    })
  }),
  createMcp: (options) => createKodegptNodeHandler(options),
  bindLoopback: ({ mcp, port }) => bindLoopback(mcp, port)
};

function validateKernelCapabilities(hello: KernelHello): void {
  if (!hello.auditHealthy) {
    throw new Error("KodeGPT audit sink is unhealthy; startup fails closed");
  }
  if (!hello.filesystemBoundaryAvailable) {
    throw new Error("KodeGPT filesystem boundary is unavailable; startup fails closed");
  }
  if (hello.testMethods) {
    throw new Error("KodeGPT runtime test methods are enabled; production startup is unavailable");
  }
}

function systemCapabilities(hello: KernelHello): Record<string, unknown> {
  return {
    runtimeVersion: hello.runtimeVersion,
    filesystemBoundaryAvailable: hello.filesystemBoundaryAvailable,
    mcpProtocolVersion: MCP_PROTOCOL_VERSION,
    mcpSurfaceVersion: MCP_SURFACE_VERSION
  };
}

function systemHealth(
  hello: KernelHello,
  recentAuditEvents: PublicAuditEvent[] = []
): Record<string, unknown> {
  return {
    ok: hello.auditHealthy && hello.filesystemBoundaryAvailable && !hello.testMethods,
    auditHealthy: hello.auditHealthy,
    filesystemBoundaryAvailable: hello.filesystemBoundaryAvailable,
    testMethods: hello.testMethods,
    diagnostics: {
      recentAuditEvents,
      recentAuditEventCount: recentAuditEvents.length
    }
  };
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`KodeGPT private state path is not a real directory: ${path}`);
  }
  await chmod(path, 0o700);
}

async function bindLoopback(mcp: McpNodeHandle, port: number): Promise<BoundLoopbackServer> {
  const server = createServer((request, response) => {
    void mcp.handler(request, response).catch(() => {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("content-type", "text/plain; charset=utf-8");
      }
      if (!response.writableEnded) {
        response.end("Internal Server Error");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, LOOPBACK_HOST);
  });

  return {
    host: LOOPBACK_HOST,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      })
  };
}

async function closeRuntimeStack(
  bound: BoundLoopbackServer | undefined,
  mcp: McpNodeHandle | undefined,
  kernel: StartKernel | undefined
): Promise<void> {
  let firstError: unknown;
  for (const close of [
    bound === undefined ? undefined : () => bound.close(),
    mcp === undefined ? undefined : () => mcp.close(),
    kernel === undefined ? undefined : () => kernel.stop()
  ]) {
    if (close === undefined) continue;
    try {
      await close();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

function parseStartArguments(args: string[]): StartKodegptOptions {
  let runtimePath: string | undefined;
  let stateRoot: string | undefined;
  let port: number | undefined;
  let publicUrl: string | undefined;
  let maxRequestBodyBytes: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !flag.startsWith("--")) {
      throw new Error("start accepts only named options");
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    index += 1;
    switch (flag) {
      case "--runtime":
        if (runtimePath !== undefined) throw new Error("--runtime may be specified only once");
        runtimePath = value;
        break;
      case "--state-root":
        if (stateRoot !== undefined) throw new Error("--state-root may be specified only once");
        stateRoot = value;
        break;
      case "--port":
        if (port !== undefined) throw new Error("--port may be specified only once");
        port = parseIntegerOption(flag, value);
        break;
      case "--public-url":
        if (publicUrl !== undefined) throw new Error("--public-url may be specified only once");
        publicUrl = value;
        break;
      case "--max-body-bytes":
        if (maxRequestBodyBytes !== undefined) {
          throw new Error("--max-body-bytes may be specified only once");
        }
        maxRequestBodyBytes = parseIntegerOption(flag, value);
        break;
      default:
        throw new Error(`Unknown start option: ${flag}`);
    }
  }

  if (runtimePath === undefined || runtimePath.length === 0) {
    throw new Error("start requires --runtime <path>");
  }
  return {
    runtimePath,
    ...(stateRoot === undefined ? {} : { stateRoot }),
    ...(port === undefined ? {} : { port }),
    ...(publicUrl === undefined ? {} : { publicUrl }),
    ...(maxRequestBodyBytes === undefined ? {} : { maxRequestBodyBytes })
  };
}

function parseIntegerOption(flag: string, value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${flag} requires a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${flag} requires a safe integer`);
  }
  return parsed;
}

function validatePort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("port must be an integer in the range 1..65535");
  }
}
