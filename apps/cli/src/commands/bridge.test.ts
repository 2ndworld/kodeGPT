import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { bridgeKodegpt, parseBridgeArguments } from "./bridge.js";

const roots: string[] = [];

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kodegpt-cli-bridge-unit-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bridge command unit tests", () => {
  it("parses bridge arguments correctly", () => {
    const parsed = parseBridgeArguments([
      "--runtime",
      "/path/to/runtime",
      "--state-root",
      "/path/to/state"
    ]);
    expect(parsed).toEqual({
      runtimePath: "/path/to/runtime",
      stateRoot: "/path/to/state"
    });
  });

  it("rejects missing --runtime option", () => {
    expect(() => parseBridgeArguments(["--state-root", "/path/to/state"])).toThrow(
      "bridge requires --runtime <path>"
    );
  });

  it("rejects unknown options", () => {
    expect(() =>
      parseBridgeArguments(["--runtime", "/path/to/runtime", "--invalid", "val"])
    ).toThrow("Unknown bridge option: --invalid");
  });

  it("instantiates and closes stdio bridge with mock dependencies", async () => {
    const root = await stateRoot();
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    let kernelStopped = false;
    const effectivePolicy = {
      name: "observe" as const,
      allowWrite: false,
      allowProcess: false,
      network: "deny" as const,
      allowedExecutableNames: [],
      inheritEnv: false as const,
      envAllowlist: []
    };
    const readyWorkspace = {
      id: "ws_1",
      canonicalRoot: "/tmp",
      effectivePolicy
    };
    const processResult = {
      schemaVersion: 1 as const,
      operationId: "op_1",
      state: "completed" as const,
      exitCode: 0,
      stdoutPreview: "",
      stderrPreview: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      sourceTruncated: false,
      bytesSpooled: 0,
      artifact: {
        schemaVersion: 1 as const,
        uri: "artifact://ka_1" as const,
        mediaType: "text/plain",
        sizeBytes: 0,
        sourceTruncated: false
      }
    };

    const dependencies = {
      prepareStateRoot: async () => {},
      prepareAudit: async () => {},
      prepareExtensionRegistry: async () => ({ listEnabled: () => [] }),
      startKernel: async () => ({
        request: async <T>() => ({}) as T,
        hello: async () => ({
          runtimeVersion: "0.1.0",
          auditHealthy: true as const,
          filesystemBoundaryAvailable: true as const,
          testMethods: false
        }),
        stop: async () => {
          kernelStopped = true;
        }
      }),
      prepareSkillCatalog: async () => ({
        list: async () => ({
          schemaVersion: 1 as const,
          skills: [],
          truncated: false,
          truncationReasons: []
        }),
        inspect: async () => {
          throw new Error("not used");
        },
        load: async () => {
          throw new Error("not used");
        },
        close: async () => undefined
      }),
      createTrustProfile: () => ({
        trust: {},
        inspectProfile: () => ({ name: "observe" })
      }),
      createManagers: () => ({
        workspaceManager: {
          listWorkspaces: () => [],
          openWorkspace: async () => readyWorkspace,
          closeWorkspace: async () => undefined,
          requireReady: () => readyWorkspace,
          readFile: async () => ({ contents: "", bytesRead: 0, eof: true }),
          pathIdentity: async () => ({
            schemaVersion: 1 as const,
            exists: false,
            hashTruncated: false
          }),
          commitPatchFile: async (input: { action: "create" | "update" | "delete"; content: string | null }) => ({
            schemaVersion: 1 as const,
            action: input.action,
            bytesWritten: input.content === null ? 0 : Buffer.byteLength(input.content),
            sha256: input.content === null ? null : "a".repeat(64)
          }),
          writeFile: async () => ({ bytesWritten: 0, created: true }),
          editFile: async () => ({ bytesWritten: 0, replacements: 0 }),
          search: async () => [],
          searchBounded: async () => ({ matches: [], truncated: false, truncationReasons: [] }),
          tree: async () => [],
          treeBounded: async () => ({ entries: [], truncated: false }),
          gitStatus: async () => ({
            schemaVersion: 1 as const,
            exitCode: 0,
            stdoutPreview: "",
            stderrPreview: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            sourceTruncated: false,
            bytesSpooled: 0,
            artifact: processResult.artifact
          }),
          gitCheckpoint: async () => ({ schemaVersion: 1 as const, records: [], truncated: false }),
          gitCheckpointPatch: async () => ({
            schemaVersion: 1 as const,
            exitCode: 0,
            stdoutPreview: "",
            stderrPreview: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            sourceTruncated: false,
            bytesSpooled: 0,
            artifact: processResult.artifact
          }),
          gitDiff: async () => ({
            schemaVersion: 1 as const,
            exitCode: 0,
            stdoutPreview: "",
            stderrPreview: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            sourceTruncated: false,
            bytesSpooled: 0,
            artifact: processResult.artifact
          }),
          runProcess: async () => processResult,
          inspectExecutable: async () => ({
            schemaVersion: 1 as const,
            executableAvailable: true,
            sandboxAvailable: true
          }),
          runVerificationProcess: async () => processResult,
          processStatus: async () => processResult,
          processCancel: async () => ({ ...processResult, state: "cancelled" as const })
        }
      })
    };

    const bridged = await bridgeKodegpt(
      {
        runtimePath: "/tmp/mock-runtime",
        stateRoot: root,
        streams: { stdin, stdout }
      },
      dependencies
    );

    await bridged.close();
    expect(kernelStopped).toBe(true);
  });
});
