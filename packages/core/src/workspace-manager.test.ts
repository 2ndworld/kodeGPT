import { describe, expect, it } from "vitest";

import { ProfileEscalationError, getProfilePreset } from "@kodegpt/profiles";
import type { PersistentFilesystemIdentity, TrustedWorkspaceEntry } from "@kodegpt/trust";

import {
  WorkspaceCloseIncompleteError,
  WorkspaceManager,
  WorkspaceNotFoundError,
  WorkspaceNotReadyError,
  type KernelTransport,
  type TrustResolver
} from "./workspace-manager.js";

const IDENTITY: PersistentFilesystemIdentity = {
  deviceMajor: 8,
  deviceMinor: 1,
  inode: "12345"
};

const TRUSTED_DEVELOP: TrustedWorkspaceEntry = {
  id: "trust_fixture",
  canonicalRoot: "/workspace",
  identity: IDENTITY,
  profileCeiling: "develop",
  trustedAt: "2026-08-09T00:00:00.000Z"
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeTrust implements TrustResolver {
  constructor(private readonly entry: TrustedWorkspaceEntry = TRUSTED_DEVELOP) {}

  async requireTrusted(
    canonicalRoot: string,
    actualIdentity: PersistentFilesystemIdentity
  ): Promise<TrustedWorkspaceEntry> {
    expect(canonicalRoot).toBe(this.entry.canonicalRoot);
    expect(actualIdentity).toEqual(this.entry.identity);
    return this.entry;
  }
}

class FakeKernel implements KernelTransport {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  profileRead: Promise<{ contents: string | null }> = Promise.resolve({ contents: null });
  activateResult: unknown = { ok: true };
  cancel: Promise<{ ok: true }> = Promise.resolve({ ok: true });

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    switch (method) {
      case "system.inspect_root":
        return {
          canonicalRoot: "/workspace",
          identity: IDENTITY
        } as T;
      case "workspace.register":
        return { capabilityId: "kc_fixture" } as T;
      case "workspace.read_project_profile":
        return (await this.profileRead) as T;
      case "workspace.cancel_executions":
        return (await this.cancel) as T;
      case "workspace.activate":
        return this.activateResult as T;
      case "file.read":
        return { contents: "file contents", bytesRead: 13, eof: true } as T;
      case "file.write":
        return { bytesWritten: 7, created: true } as T;
      case "file.edit":
        return { bytesWritten: 11, replacements: 2 } as T;
      case "file.tree":
        return {
          entries: [
            { path: "src", kind: "directory" },
            { path: "src/index.ts", kind: "file" }
          ]
        } as T;
      case "file.search":
        return {
          matches: [{ path: "src/index.ts", line: 2, lineText: "const needle = true;" }]
        } as T;
      case "workspace.restrict_policy":
      case "workspace.begin_close":
      case "workspace.unregister":
        return { ok: true } as T;
      default:
        throw new Error(`unexpected method: ${method}`);
    }
  }
}

describe("WorkspaceManager", () => {
  it("opens through OPENING, applies project narrowing, then publishes a READY workspace", async () => {
    const kernel = new FakeKernel();
    kernel.profileRead = Promise.resolve({
      contents: JSON.stringify({
        ...getProfilePreset("develop"),
        allowWrite: false
      })
    });
    const manager = new WorkspaceManager({
      kernel,
      trust: new FakeTrust(),
      idFactory: () => "ws_fixture"
    });

    const opened = await manager.openWorkspace("/workspace");

    expect(opened.id).toBe("ws_fixture");
    expect(opened.canonicalRoot).toBe("/workspace");
    expect(opened.effectivePolicy.allowWrite).toBe(false);
    expect(manager.requireReady("ws_fixture")).toEqual(opened);
    expect(kernel.calls.map((call) => call.method)).toEqual([
      "system.inspect_root",
      "workspace.register",
      "workspace.read_project_profile",
      "workspace.restrict_policy",
      "workspace.activate"
    ]);
    expect(kernel.calls[3]?.params.restriction).toMatchObject({ allowWrite: false });
  });

  it("lists only public READY workspace snapshots without private runtime capabilities", async () => {
    const kernel = new FakeKernel();
    const manager = new WorkspaceManager({
      kernel,
      trust: new FakeTrust(),
      idFactory: () => "ws_list"
    });

    expect(manager.listWorkspaces()).toEqual([]);
    await manager.openWorkspace("/workspace");
    const listed = manager.listWorkspaces();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe("ws_list");
    expect(JSON.stringify(listed)).not.toContain("kc_fixture");
  });

  it("routes READY public workspace file operations through the private runtime capability", async () => {
    const kernel = new FakeKernel();
    const manager = new WorkspaceManager({
      kernel,
      trust: new FakeTrust(),
      idFactory: () => "ws_files"
    });

    const opened = await manager.openWorkspace("/workspace");
    const read = await manager.readFile("ws_files", "inside.txt", { offset: 2, maxBytes: 64 });
    const write = await manager.writeFile("ws_files", "created.txt", "created");
    const edit = await manager.editFile("ws_files", "inside.txt", "old", "new", 2);
    const tree = await manager.tree("ws_files", ".");
    const matches = await manager.search("ws_files", "needle", ".");

    expect(read).toEqual({ contents: "file contents", bytesRead: 13, eof: true });
    expect(write).toEqual({ bytesWritten: 7, created: true });
    expect(edit).toEqual({ bytesWritten: 11, replacements: 2 });
    expect(tree).toEqual([
      { path: "src", kind: "directory" },
      { path: "src/index.ts", kind: "file" }
    ]);
    expect(matches).toEqual([
      { path: "src/index.ts", line: 2, lineText: "const needle = true;" }
    ]);
    expect(JSON.stringify(opened)).not.toContain("kc_fixture");
    expect(kernel.calls.slice(-5)).toEqual([
      {
        method: "file.read",
        params: { capabilityId: "kc_fixture", path: "inside.txt", offset: 2, maxBytes: 64 }
      },
      {
        method: "file.write",
        params: { capabilityId: "kc_fixture", path: "created.txt", content: "created" }
      },
      {
        method: "file.edit",
        params: {
          capabilityId: "kc_fixture",
          path: "inside.txt",
          oldText: "old",
          newText: "new",
          expectedReplacements: 2
        }
      },
      { method: "file.tree", params: { capabilityId: "kc_fixture", path: "." } },
      {
        method: "file.search",
        params: { capabilityId: "kc_fixture", path: ".", query: "needle" }
      }
    ]);
  });

  it("does not publish READY when workspace.activate returns a malformed acknowledgement", async () => {
    const kernel = new FakeKernel();
    kernel.activateResult = { ok: false };
    const manager = new WorkspaceManager({
      kernel,
      trust: new FakeTrust(),
      idFactory: () => "ws_bad_activate"
    });

    await expect(manager.openWorkspace("/workspace")).rejects.toMatchObject({
      code: "RUNTIME_PROTOCOL_INVALID"
    });
    expect(kernel.calls.map((call) => call.method)).toEqual([
      "system.inspect_root",
      "workspace.register",
      "workspace.read_project_profile",
      "workspace.restrict_policy",
      "workspace.activate",
      "workspace.unregister"
    ]);
    expect(() => manager.requireReady("ws_bad_activate")).toThrowError(WorkspaceNotFoundError);
  });

  it("rejects project escalation above the trusted ceiling and unregisters the private capability", async () => {
    const kernel = new FakeKernel();
    kernel.profileRead = Promise.resolve({
      contents: JSON.stringify(getProfilePreset("trusted"))
    });
    const manager = new WorkspaceManager({
      kernel,
      trust: new FakeTrust({
        ...TRUSTED_DEVELOP,
        profileCeiling: "observe"
      }),
      idFactory: () => "ws_escalation"
    });

    await expect(manager.openWorkspace("/workspace")).rejects.toBeInstanceOf(
      ProfileEscalationError
    );
    expect(kernel.calls.map((call) => call.method)).toEqual([
      "system.inspect_root",
      "workspace.register",
      "workspace.read_project_profile",
      "workspace.unregister"
    ]);
    expect(() => manager.requireReady("ws_escalation")).toThrowError(WorkspaceNotFoundError);
  });

  it("rejects public lookup while OPENING and CLOSING", async () => {
    const kernel = new FakeKernel();
    const read = deferred<{ contents: string | null }>();
    kernel.profileRead = read.promise;
    const manager = new WorkspaceManager({
      kernel,
      trust: new FakeTrust(),
      idFactory: () => "ws_lifecycle"
    });

    const opening = manager.openWorkspace("/workspace");
    await Promise.resolve();
    await Promise.resolve();
    expect(() => manager.requireReady("ws_lifecycle")).toThrowError(WorkspaceNotReadyError);

    read.resolve({ contents: null });
    await opening;

    const cancel = deferred<{ ok: true }>();
    kernel.cancel = cancel.promise;
    const closing = manager.closeWorkspace("ws_lifecycle");
    await Promise.resolve();
    expect(() => manager.requireReady("ws_lifecycle")).toThrowError(WorkspaceNotReadyError);
    await expect(manager.closeWorkspace("ws_lifecycle")).rejects.toBeInstanceOf(
      WorkspaceNotReadyError
    );
    cancel.resolve({ ok: true });
    await closing;
  });

  it("fails close on timeout, stays non-ready, and can safely retry the bounded close", async () => {
    const kernel = new FakeKernel();
    const manager = new WorkspaceManager({
      kernel,
      trust: new FakeTrust(),
      idFactory: () => "ws_timeout",
      closeTimeoutMs: 20
    });
    await manager.openWorkspace("/workspace");
    kernel.cancel = new Promise(() => undefined);

    await expect(manager.closeWorkspace("ws_timeout")).rejects.toBeInstanceOf(
      WorkspaceCloseIncompleteError
    );
    expect(() => manager.requireReady("ws_timeout")).toThrowError(WorkspaceNotReadyError);

    kernel.cancel = Promise.resolve({ ok: true });
    await expect(manager.closeWorkspace("ws_timeout")).resolves.toBeUndefined();
    expect(() => manager.requireReady("ws_timeout")).toThrowError(WorkspaceNotFoundError);
  });
});
