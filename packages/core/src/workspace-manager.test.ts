import { describe, expect, it } from "vitest";

import { ProfileEscalationError, getProfilePreset } from "@kodegpt/profiles";
import type { PersistentFilesystemIdentity, TrustedWorkspaceEntry } from "@kodegpt/trust";

import { KernelRpcError } from "./kernel-client.js";
import {
  WorkspaceCloseIncompleteError,
  WorkspaceManager,
  WorkspaceManagerError,
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
  readonly trustCalls: Array<{
    canonicalRoot: string;
    identity: PersistentFilesystemIdentity;
    profileCeiling: "observe" | "develop" | "trusted";
  }> = [];
  readonly untrustCalls: string[] = [];
  beforeTrust: (() => void) | undefined;
  beforeUntrust: (() => void) | undefined;
  requireTrustedCalls = 0;
  requireTrustedGate: Promise<void> | undefined;
  private entry: TrustedWorkspaceEntry | undefined;

  constructor(entry: TrustedWorkspaceEntry | null = TRUSTED_DEVELOP) {
    this.entry = entry ?? undefined;
  }

  async trust(input: {
    canonicalRoot: string;
    identity: PersistentFilesystemIdentity;
    profileCeiling: "observe" | "develop" | "trusted";
  }): Promise<TrustedWorkspaceEntry> {
    this.beforeTrust?.();
    this.trustCalls.push({ ...input, identity: { ...input.identity } });
    this.entry = {
      ...(this.entry ?? TRUSTED_DEVELOP),
      canonicalRoot: input.canonicalRoot,
      identity: { ...input.identity },
      profileCeiling: input.profileCeiling
    };
    return this.entry;
  }

  async list(): Promise<TrustedWorkspaceEntry[]> {
    return this.entry === undefined ? [] : [this.entry];
  }

  async untrust(id: string): Promise<boolean> {
    this.beforeUntrust?.();
    this.untrustCalls.push(id);
    if (this.entry?.id !== id) return false;
    this.entry = undefined;
    return true;
  }

  async requireTrusted(
    canonicalRoot: string,
    actualIdentity: PersistentFilesystemIdentity
  ): Promise<TrustedWorkspaceEntry> {
    const entry = this.entry;
    if (entry === undefined) throw new Error("workspace is not trusted");
    this.requireTrustedCalls += 1;
    expect(canonicalRoot).toBe(entry.canonicalRoot);
    expect(actualIdentity).toEqual(entry.identity);
    await this.requireTrustedGate;
    return entry;
  }
}

class FakeKernel implements KernelTransport {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  inspectRootError: unknown;
  trustAuditErrorPhase: "decision" | "success" | "failed" | undefined;
  profileRead: Promise<{ contents: string | null }> = Promise.resolve({ contents: null });
  activateResult: unknown = { ok: true };
  cancel: Promise<{ ok: true }> = Promise.resolve({ ok: true });
  searchResult: unknown = {
    matches: [{ path: "src/index.ts", line: 2, lineText: "const needle = true;" }],
    truncated: false,
    truncationReasons: []
  };
  patchCommitResult: unknown = {
    schemaVersion: 1,
    action: "update",
    bytesWritten: 6,
    sha256: "7b9a72466d3960eb2aacccfc848939453490db0678bd4725def3f789b891c919"
  };
  gitHistoryResult: unknown = {
    schemaVersion: 1,
    resolvedOid: "1".repeat(40),
    commits: [],
    returnedCount: 0,
    truncated: false,
    truncationReasons: []
  };
  gitHistoryError: unknown;

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    switch (method) {
      case "system.inspect_root":
        if (this.inspectRootError !== undefined) throw this.inspectRootError;
        return {
          canonicalRoot: "/workspace",
          identity: IDENTITY
        } as T;
      case "trust.audit":
        if (params.phase === this.trustAuditErrorPhase) throw new Error("trust audit failed");
        return { ok: true } as T;
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
      case "file.identity":
        return {
          schemaVersion: 1,
          exists: true,
          kind: "file",
          sizeBytes: 13,
          sha256: "a".repeat(64),
          hashTruncated: false
        } as T;
      case "file.write":
        return { bytesWritten: 7, created: true } as T;
      case "file.edit":
        return { bytesWritten: 11, replacements: 2 } as T;
      case "file.commit_patch_file":
        return this.patchCommitResult as T;
      case "git.status":
        return {
          schemaVersion: 1,
          exitCode: 0,
          stdoutPreview: " M tracked.txt\n",
          stderrPreview: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          sourceTruncated: false,
          bytesSpooled: 15,
          artifact: {
            schemaVersion: 1,
            artifactId: "ka_status_fixture",
            mediaType: "application/vnd.kodegpt.execution-stream",
            bytesWritten: 15,
            sourceTruncated: false
          }
        } as T;
      case "git.checkpoint":
        return {
          schemaVersion: 1,
          records: [
            {
              recordType: "ordinary",
              path: "tracked.txt",
              worktreeStatus: "M",
              headMode: "100644",
              indexMode: "100644",
              worktreeMode: "100644",
              headOid: "1".repeat(40),
              indexOid: "1".repeat(40),
              currentIdentity: {
                schemaVersion: 1,
                exists: true,
                kind: "file",
                sizeBytes: 9,
                sha256: "b".repeat(64),
                hashTruncated: false
              }
            }
          ],
          truncated: false
        } as T;
      case "git.checkpoint_patch":
        return {
          schemaVersion: 1,
          exitCode: 0,
          stdoutPreview: "=== KODEGPT STAGED DIFF ===\n=== KODEGPT WORKTREE DIFF ===\n",
          stderrPreview: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          sourceTruncated: false,
          bytesSpooled: 58,
          artifact: {
            schemaVersion: 1,
            artifactId: "ka_checkpoint_patch_fixture",
            mediaType: "application/vnd.kodegpt.execution-stream",
            bytesWritten: 58,
            sourceTruncated: false
          }
        } as T;
      case "git.local_mutation":
        return {
          schemaVersion: 1,
          operation: params.operation,
          exitCode: 0,
          stdoutPreview: "",
          stderrPreview: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          sourceTruncated: false,
          bytesSpooled: 0,
          artifact: {
            schemaVersion: 1,
            artifactId: "ka_git_mutation_fixture",
            mediaType: "application/vnd.kodegpt.execution-stream",
            bytesWritten: 0,
            sourceTruncated: false
          }
        } as T;
      case "git.remote_mutation":
        return {
          schemaVersion: 1,
          operation: params.operation,
          exitCode: 0,
          stdoutPreview: "",
          stderrPreview: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          sourceTruncated: false,
          bytesSpooled: 0,
          artifact: {
            schemaVersion: 1,
            artifactId: "ka_git_remote_fixture",
            mediaType: "application/vnd.kodegpt.execution-stream",
            bytesWritten: 0,
            sourceTruncated: false
          }
        } as T;
      case "git.diff":
        return {
          schemaVersion: 1,
          exitCode: 0,
          stdoutPreview: "diff --git a/tracked.txt b/tracked.txt\n",
          stderrPreview: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          sourceTruncated: false,
          bytesSpooled: 40,
          artifact: {
            schemaVersion: 1,
            artifactId: "ka_diff_fixture",
            mediaType: "application/vnd.kodegpt.execution-stream",
            bytesWritten: 40,
            sourceTruncated: false
          }
        } as T;
      case "git.log":
      case "git.show":
      case "git.range":
      case "git.diff_history":
        if (this.gitHistoryError !== undefined) throw this.gitHistoryError;
        return this.gitHistoryResult as T;
      case "process.inspect_executable":
        return { schemaVersion: 1, executableAvailable: true, sandboxAvailable: true } as T;
      case "verify.run":
        return {
          schemaVersion: 1,
          operationId: "op_verify_fixture",
          state: "completed",
          exitCode: 0,
          stdoutPreview: "verify ok\n",
          stderrPreview: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          sourceTruncated: false,
          bytesSpooled: 10,
          artifact: {
            schemaVersion: 1,
            artifactId: "ka_verify_fixture",
            mediaType: "application/vnd.kodegpt.execution-stream",
            bytesWritten: 10,
            sourceTruncated: false
          }
        } as T;
      case "file.tree":
        return {
          entries: [
            { path: "src", kind: "directory" },
            { path: "src/index.ts", kind: "file" }
          ],
          truncated: false
        } as T;
      case "file.search":
        return this.searchResult as T;
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
  it("trusts a workspace by inspected path without caller-supplied filesystem identity", async () => {
    const kernel = new FakeKernel();
    const trust = new FakeTrust(null);
    const manager = new WorkspaceManager({
      kernel,
      trust,
      idFactory: () => "ws_trust_control",
      auditOperationIdFactory: () => "op_trust_control"
    });

    const trusted = await manager.trustWorkspace("/requested-workspace", "trusted");

    expect(kernel.calls).toEqual([
      {
        method: "system.inspect_root",
        params: { path: "/requested-workspace" }
      },
      {
        method: "trust.audit",
        params: { operationId: "op_trust_control", action: "trust", phase: "decision" }
      },
      {
        method: "trust.audit",
        params: { operationId: "op_trust_control", action: "trust", phase: "success" }
      }
    ]);
    expect(trust.trustCalls).toEqual([
      {
        canonicalRoot: "/workspace",
        identity: IDENTITY,
        profileCeiling: "trusted"
      }
    ]);
    expect(trusted).toEqual({
      id: "trust_fixture",
      canonicalRoot: "/workspace",
      profileCeiling: "trusted",
      trustedAt: "2026-08-09T00:00:00.000Z"
    });
    expect(trusted).not.toHaveProperty("identity");
  });

  it("defaults trust to observe and exposes one safe durable record after profile update by re-trust", async () => {
    const kernel = new FakeKernel();
    const trust = new FakeTrust(null);
    const operationIds = ["op_trust_create", "op_trust_update"];
    const manager = new WorkspaceManager({
      kernel,
      trust,
      idFactory: () => "ws_trust_update",
      auditOperationIdFactory: () => operationIds.shift() ?? "op_trust_unexpected"
    });

    const first = await manager.trustWorkspace("/requested-workspace");
    const second = await manager.trustWorkspace("/requested-workspace", "trusted");
    const listed = await manager.listTrustedWorkspaces();

    expect(first.id).toBe("trust_fixture");
    expect(first.profileCeiling).toBe("observe");
    expect(second.id).toBe(first.id);
    expect(second.profileCeiling).toBe("trusted");
    expect(trust.trustCalls.map((call) => call.profileCeiling)).toEqual(["observe", "trusted"]);
    expect(
      kernel.calls.filter((call) => call.method === "trust.audit").map((call) => call.params)
    ).toEqual([
      { operationId: "op_trust_create", action: "trust", phase: "decision" },
      { operationId: "op_trust_create", action: "trust", phase: "success" },
      { operationId: "op_trust_update", action: "profile_update", phase: "decision" },
      { operationId: "op_trust_update", action: "profile_update", phase: "success" }
    ]);
    expect(listed).toEqual([
      {
        id: "trust_fixture",
        canonicalRoot: "/workspace",
        profileCeiling: "trusted",
        trustedAt: "2026-08-09T00:00:00.000Z"
      }
    ]);
    expect(JSON.stringify(listed)).not.toContain("deviceMajor");
    expect(JSON.stringify(listed)).not.toContain("inode");
  });

  it("does not mutate trust when local root inspection fails", async () => {
    const kernel = new FakeKernel();
    kernel.inspectRootError = new Error("root inspection failed");
    const trust = new FakeTrust();
    const manager = new WorkspaceManager({
      kernel,
      trust,
      idFactory: () => "ws_trust_invalid_root"
    });

    await expect(manager.trustWorkspace("/missing-workspace", "trusted")).rejects.toThrow(
      "root inspection failed"
    );
    expect(trust.trustCalls).toEqual([]);
    expect(kernel.calls.map((call) => call.method)).toEqual(["system.inspect_root"]);
  });

  it("fails closed before trust mutation when the Rust audit decision cannot be recorded", async () => {
    const kernel = new FakeKernel();
    kernel.trustAuditErrorPhase = "decision";
    const trust = new FakeTrust(null);
    const manager = new WorkspaceManager({
      kernel,
      trust,
      idFactory: () => "ws_trust_audit_fail",
      auditOperationIdFactory: () => "op_trust_audit_fail"
    });

    await expect(manager.trustWorkspace("/requested-workspace", "trusted")).rejects.toThrow(
      "trust audit failed"
    );
    expect(trust.trustCalls).toEqual([]);
    expect(kernel.calls.map((call) => call.method)).toEqual(["system.inspect_root", "trust.audit"]);
  });

  it("records a failed audit outcome when durable trust mutation fails after decision", async () => {
    const kernel = new FakeKernel();
    const trust = new FakeTrust(null);
    trust.beforeTrust = () => {
      throw new Error("trust store failed");
    };
    const manager = new WorkspaceManager({
      kernel,
      trust,
      idFactory: () => "ws_trust_store_fail",
      auditOperationIdFactory: () => "op_trust_store_fail"
    });

    await expect(manager.trustWorkspace("/requested-workspace", "trusted")).rejects.toThrow(
      "trust store failed"
    );
    expect(kernel.calls.filter((call) => call.method === "trust.audit").map((call) => call.params)).toEqual([
      { operationId: "op_trust_store_fail", action: "trust", phase: "decision" },
      { operationId: "op_trust_store_fail", action: "trust", phase: "failed" }
    ]);
    expect(trust.trustCalls).toEqual([]);
  });

  it("does not emit a false failed outcome when success auditing fails after durable trust mutation", async () => {
    const kernel = new FakeKernel();
    kernel.trustAuditErrorPhase = "success";
    const trust = new FakeTrust(null);
    const manager = new WorkspaceManager({
      kernel,
      trust,
      idFactory: () => "ws_trust_success_audit_fail",
      auditOperationIdFactory: () => "op_trust_success_audit_fail"
    });

    await expect(manager.trustWorkspace("/requested-workspace", "trusted")).rejects.toThrow(
      "trust audit failed"
    );
    expect(trust.trustCalls).toHaveLength(1);
    expect(kernel.calls.filter((call) => call.method === "trust.audit").map((call) => call.params)).toEqual([
      { operationId: "op_trust_success_audit_fail", action: "trust", phase: "decision" },
      { operationId: "op_trust_success_audit_fail", action: "trust", phase: "success" }
    ]);
  });

  it("does not let repository-controlled project profile loading mutate durable trust", async () => {
    const kernel = new FakeKernel();
    kernel.profileRead = Promise.resolve({
      contents: JSON.stringify({
        ...getProfilePreset("develop"),
        allowWrite: false
      })
    });
    const trust = new FakeTrust();
    const manager = new WorkspaceManager({
      kernel,
      trust,
      idFactory: () => "ws_repo_content_no_authority"
    });

    await manager.openWorkspace("/workspace");

    expect(trust.trustCalls).toEqual([]);
    expect(trust.untrustCalls).toEqual([]);
  });

  it("untrusts a closed workspace without invoking runtime lifecycle operations", async () => {
    const kernel = new FakeKernel();
    const trust = new FakeTrust();
    const manager = new WorkspaceManager({
      kernel,
      trust,
      idFactory: () => "ws_untrust_closed",
      auditOperationIdFactory: () => "op_untrust_closed"
    });

    await expect(manager.untrustWorkspace("trust_fixture")).resolves.toBe(true);

    expect(kernel.calls).toEqual([
      {
        method: "trust.audit",
        params: { operationId: "op_untrust_closed", action: "untrust", phase: "decision" }
      },
      {
        method: "trust.audit",
        params: { operationId: "op_untrust_closed", action: "untrust", phase: "success" }
      }
    ]);
    expect(trust.untrustCalls).toEqual(["trust_fixture"]);
    await expect(manager.listTrustedWorkspaces()).resolves.toEqual([]);
  });

  it("closes and cancels an active workspace before removing its durable trust", async () => {
    const kernel = new FakeKernel();
    const trust = new FakeTrust();
    const manager = new WorkspaceManager({
      kernel,
      trust,
      idFactory: () => "ws_untrust_active",
      auditOperationIdFactory: () => "op_untrust_active"
    });
    await manager.openWorkspace("/workspace");
    kernel.calls.length = 0;
    trust.beforeUntrust = () => expect(manager.listWorkspaces()).toEqual([]);

    await expect(manager.untrustWorkspace("trust_fixture")).resolves.toBe(true);

    expect(kernel.calls).toEqual([
      {
        method: "trust.audit",
        params: { operationId: "op_untrust_active", action: "untrust", phase: "decision" }
      },
      { method: "workspace.begin_close", params: { capabilityId: "kc_fixture" } },
      { method: "workspace.cancel_executions", params: { capabilityId: "kc_fixture" } },
      { method: "workspace.unregister", params: { capabilityId: "kc_fixture" } },
      {
        method: "trust.audit",
        params: { operationId: "op_untrust_active", action: "untrust", phase: "success" }
      }
    ]);
    expect(manager.listWorkspaces()).toEqual([]);
    expect(trust.untrustCalls).toEqual(["trust_fixture"]);
  });

  it("fails closed instead of removing trust while a matching workspace is still opening", async () => {
    const kernel = new FakeKernel();
    const profileRead = deferred<{ contents: string | null }>();
    kernel.profileRead = profileRead.promise;
    const trust = new FakeTrust();
    const manager = new WorkspaceManager({
      kernel,
      trust,
      idFactory: () => "ws_untrust_opening"
    });

    const opening = manager.openWorkspace("/workspace");
    while (!kernel.calls.some((call) => call.method === "workspace.read_project_profile")) {
      await Promise.resolve();
    }

    await expect(manager.untrustWorkspace("trust_fixture")).rejects.toBeInstanceOf(
      WorkspaceNotReadyError
    );
    expect(trust.untrustCalls).toEqual([]);

    profileRead.resolve({ contents: null });
    await opening;
    await expect(manager.untrustWorkspace("trust_fixture")).resolves.toBe(true);
    expect(trust.untrustCalls).toEqual(["trust_fixture"]);
  });

  it("fails closed before trust binding completes while a matching canonical root is opening", async () => {
    const kernel = new FakeKernel();
    const trustGate = deferred<void>();
    const trust = new FakeTrust();
    trust.requireTrustedGate = trustGate.promise;
    const manager = new WorkspaceManager({
      kernel,
      trust,
      idFactory: () => "ws_untrust_prebinding"
    });

    const opening = manager.openWorkspace("/workspace");
    while (trust.requireTrustedCalls === 0) {
      await Promise.resolve();
    }

    await expect(manager.untrustWorkspace("trust_fixture")).rejects.toBeInstanceOf(
      WorkspaceNotReadyError
    );
    expect(trust.untrustCalls).toEqual([]);

    trustGate.resolve();
    await opening;
    await expect(manager.untrustWorkspace("trust_fixture")).resolves.toBe(true);
    expect(trust.untrustCalls).toEqual(["trust_fixture"]);
  });

  it("fails closed instead of removing trust while a matching workspace close is already in flight", async () => {
    const kernel = new FakeKernel();
    const cancel = deferred<{ ok: true }>();
    kernel.cancel = cancel.promise;
    const trust = new FakeTrust();
    const manager = new WorkspaceManager({
      kernel,
      trust,
      idFactory: () => "ws_untrust_closing"
    });
    await manager.openWorkspace("/workspace");
    kernel.calls.length = 0;

    const closing = manager.closeWorkspace("ws_untrust_closing");
    while (!kernel.calls.some((call) => call.method === "workspace.cancel_executions")) {
      await Promise.resolve();
    }

    await expect(manager.untrustWorkspace("trust_fixture")).rejects.toBeInstanceOf(
      WorkspaceNotReadyError
    );
    expect(trust.untrustCalls).toEqual([]);

    cancel.resolve({ ok: true });
    await closing;
    await expect(manager.untrustWorkspace("trust_fixture")).resolves.toBe(true);
    expect(trust.untrustCalls).toEqual(["trust_fixture"]);
  });

  it("routes structured Git history requests through the private READY capability", async () => {
    const kernel = new FakeKernel();
    const manager = new WorkspaceManager({
      kernel,
      trust: new FakeTrust(),
      idFactory: () => "ws_history"
    });

    await manager.openWorkspace("/workspace");
    await manager.gitLog({
      workspaceId: "ws_history",
      revision: { kind: "branch", name: "feat/history" },
      path: "src/index.ts",
      limit: 20
    });

    expect(kernel.calls.at(-1)).toEqual({
      method: "git.log",
      params: {
        capabilityId: "kc_fixture",
        revision: { kind: "branch", name: "feat/history" },
        path: "src/index.ts",
        limit: 20
      }
    });
    expect(kernel.calls.at(-1)?.params).not.toHaveProperty("workspaceId");
    expect(kernel.calls.at(-1)?.params).not.toHaveProperty("argv");
  });

  it("rejects malformed Git history runtime payloads and preserves stable safe error codes", async () => {
    const kernel = new FakeKernel();
    const manager = new WorkspaceManager({
      kernel,
      trust: new FakeTrust(),
      idFactory: () => "ws_history_invalid"
    });
    await manager.openWorkspace("/workspace");

    const validCommit = {
      oid: "2".repeat(40),
      shortOid: "2".repeat(12),
      parents: ["3".repeat(40)],
      authorName: "A",
      authorTime: 1,
      committerTime: 2,
      subject: "subject",
      encodingLossy: false
    };
    for (const payload of [
      { schemaVersion: 1, resolvedOid: "A".repeat(40), commits: [], returnedCount: 0, truncated: false, truncationReasons: [] },
      { schemaVersion: 1, resolvedOid: "1".repeat(40), commits: [{ ...validCommit, shortOid: "deadbeefdead" }], returnedCount: 1, truncated: false, truncationReasons: [] },
      { schemaVersion: 1, resolvedOid: "1".repeat(40), commits: new Array(101).fill(validCommit), returnedCount: 101, truncated: true, truncationReasons: ["COMMIT_LIMIT"] },
      { schemaVersion: 1, resolvedOid: "1".repeat(40), commits: [], returnedCount: 0, truncated: false, truncationReasons: ["COMMIT_LIMIT"] },
      { schemaVersion: 1, resolvedOid: "1".repeat(40), commits: [], returnedCount: 0, truncated: false, truncationReasons: [], capabilityId: "kc_leak" },
      { schemaVersion: 1, resolvedOid: "1".repeat(40), commits: [], returnedCount: 0, truncated: false, truncationReasons: [], unexpected: true }
    ]) {
      kernel.gitHistoryResult = payload;
      await expect(manager.gitLog({ workspaceId: "ws_history_invalid", revision: { kind: "head" }, limit: 20 }))
        .rejects.toMatchObject({ code: "RUNTIME_PROTOCOL_INVALID" });
    }

    kernel.gitHistoryResult = {
      schemaVersion: 1,
      commit: {
        oid: "1".repeat(40),
        shortOid: "1".repeat(12),
        parents: [],
        authorName: "A",
        authorTime: 1,
        committerTime: 1,
        subject: "subject",
        body: "",
        messageTruncated: false,
        encodingLossy: false
      },
      changedPaths: [{ path: "/etc/passwd", status: "modified", insertions: 1, deletions: 1, binary: false }],
      summary: { filesChanged: 1, insertions: 1, deletions: 1, binaryFiles: 0 },
      patch: null,
      truncated: false,
      truncationReasons: []
    };
    await expect(manager.gitShow({ workspaceId: "ws_history_invalid", revision: { kind: "head" }, includePatch: false, maxPatchBytes: 65536 }))
      .rejects.toMatchObject({ code: "RUNTIME_PROTOCOL_INVALID" });

    kernel.gitHistoryError = new KernelRpcError(-32000, "REVISION_NOT_FOUND", { stderr: "secret" });
    await expect(manager.gitLog({ workspaceId: "ws_history_invalid", revision: { kind: "head" }, limit: 20 }))
      .rejects.toEqual(expect.objectContaining<Partial<WorkspaceManagerError>>({ code: "REVISION_NOT_FOUND" }));
  });
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
    const identity = await manager.pathIdentity("ws_files", "inside.txt", { includeSha256: true });
    const write = await manager.writeFile("ws_files", "created.txt", "created");
    const edit = await manager.editFile("ws_files", "inside.txt", "old", "new", 2);
    const gitStatus = await manager.gitStatus("ws_files");
    const gitCheckpoint = await manager.gitCheckpoint("ws_files");
    const gitCheckpointPatch = await manager.gitCheckpointPatch("ws_files");
    const gitDiff = await manager.gitDiff("ws_files");
    const tree = await manager.tree("ws_files", ".");
    const boundedTree = await manager.treeBounded("ws_files", ".", 10_000);
    const semanticTree = await manager.treeBounded("ws_files", ".", 10_000, "semantic");
    const matches = await manager.search("ws_files", "needle", ".");
    const boundedMatches = await manager.searchBounded("ws_files", "needle", ".", 500);
    const semanticMatches = await manager.searchBounded("ws_files", "needle", ".", 500, "semantic");

    expect(read).toEqual({ contents: "file contents", bytesRead: 13, eof: true });
    expect(identity).toEqual({
      schemaVersion: 1,
      exists: true,
      kind: "file",
      sizeBytes: 13,
      sha256: "a".repeat(64),
      hashTruncated: false
    });
    expect(write).toEqual({ bytesWritten: 7, created: true });
    expect(edit).toEqual({ bytesWritten: 11, replacements: 2 });
    expect(gitStatus).toEqual({
      schemaVersion: 1,
      exitCode: 0,
      stdoutPreview: " M tracked.txt\n",
      stderrPreview: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      sourceTruncated: false,
      bytesSpooled: 15,
      artifact: {
        schemaVersion: 1,
        uri: "artifact://ka_status_fixture",
        mediaType: "application/vnd.kodegpt.execution-stream",
        sizeBytes: 15,
        sourceTruncated: false
      }
    });
    expect(gitCheckpoint).toEqual({
      schemaVersion: 1,
      records: [
        {
          recordType: "ordinary",
          path: "tracked.txt",
          worktreeStatus: "M",
          headMode: "100644",
          indexMode: "100644",
          worktreeMode: "100644",
          headOid: "1".repeat(40),
          indexOid: "1".repeat(40),
          currentIdentity: {
            schemaVersion: 1,
            exists: true,
            kind: "file",
            sizeBytes: 9,
            sha256: "b".repeat(64),
            hashTruncated: false
          }
        }
      ],
      truncated: false
    });
    expect(gitCheckpointPatch.stdoutPreview).toContain("KODEGPT STAGED DIFF");
    expect(gitCheckpointPatch.artifact.uri).toBe("artifact://ka_checkpoint_patch_fixture");
    expect(gitDiff).toEqual({
      schemaVersion: 1,
      exitCode: 0,
      stdoutPreview: "diff --git a/tracked.txt b/tracked.txt\n",
      stderrPreview: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      sourceTruncated: false,
      bytesSpooled: 40,
      artifact: {
        schemaVersion: 1,
        uri: "artifact://ka_diff_fixture",
        mediaType: "application/vnd.kodegpt.execution-stream",
        sizeBytes: 40,
        sourceTruncated: false
      }
    });
    expect(JSON.stringify({ gitStatus, gitDiff })).toContain("artifact://ka_");
    expect(JSON.stringify({ gitStatus, gitDiff })).not.toContain("artifactId");
    expect(JSON.stringify({ gitStatus, gitDiff })).not.toContain("/home/");
    expect(tree).toEqual([
      { path: "src", kind: "directory" },
      { path: "src/index.ts", kind: "file" }
    ]);
    expect(boundedTree).toEqual({
      entries: [
        { path: "src", kind: "directory" },
        { path: "src/index.ts", kind: "file" }
      ],
      truncated: false
    });
    expect(semanticTree).toEqual(boundedTree);
    expect(matches).toEqual([
      { path: "src/index.ts", line: 2, lineText: "const needle = true;" }
    ]);
    expect(boundedMatches).toEqual({
      matches: [{ path: "src/index.ts", line: 2, lineText: "const needle = true;" }],
      truncated: false,
      truncationReasons: []
    });
    expect(semanticMatches).toEqual(boundedMatches);
    expect(JSON.stringify(opened)).not.toContain("kc_fixture");
    expect(kernel.calls.slice(-14)).toEqual([
      {
        method: "file.read",
        params: { capabilityId: "kc_fixture", path: "inside.txt", offset: 2, maxBytes: 64 }
      },
      {
        method: "file.identity",
        params: { capabilityId: "kc_fixture", path: "inside.txt", includeSha256: true }
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
      { method: "git.status", params: { capabilityId: "kc_fixture" } },
      { method: "git.checkpoint", params: { capabilityId: "kc_fixture" } },
      { method: "git.checkpoint_patch", params: { capabilityId: "kc_fixture" } },
      { method: "git.diff", params: { capabilityId: "kc_fixture" } },
      {
        method: "file.tree",
        params: { capabilityId: "kc_fixture", path: ".", maxEntries: 2_000, scope: "literal" }
      },
      {
        method: "file.tree",
        params: { capabilityId: "kc_fixture", path: ".", maxEntries: 10_000, scope: "literal" }
      },
      {
        method: "file.tree",
        params: { capabilityId: "kc_fixture", path: ".", maxEntries: 10_000, scope: "semantic" }
      },
      {
        method: "file.search",
        params: {
          capabilityId: "kc_fixture",
          path: ".",
          query: "needle",
          maxMatches: 200,
          scope: "literal"
        }
      },
      {
        method: "file.search",
        params: {
          capabilityId: "kc_fixture",
          path: ".",
          query: "needle",
          maxMatches: 500,
          scope: "literal"
        }
      },
      {
        method: "file.search",
        params: {
          capabilityId: "kc_fixture",
          path: ".",
          query: "needle",
          maxMatches: 500,
          scope: "semantic"
        }
      }
    ]);
  });

  it("routes typed local Git mutations through the private runtime capability", async () => {
    const kernel = new FakeKernel();
    const manager = new WorkspaceManager({
      kernel,
      trust: new FakeTrust(),
      idFactory: () => "ws_git_mutation"
    });
    await manager.openWorkspace("/workspace");

    const stage = await manager.gitStage("ws_git_mutation", ["src/a.ts", "src/b.ts"]);
    const commit = await manager.gitCommit("ws_git_mutation", "bounded message");
    const branchCreate = await manager.gitBranchCreate("ws_git_mutation", "feature/test");
    const branchSwitch = await manager.gitBranchSwitch("ws_git_mutation", "feature/test");
    const branchDelete = await manager.gitBranchDelete("ws_git_mutation", "feature/test");

    expect([stage, commit, branchCreate, branchSwitch, branchDelete].map((result) => result.operation)).toEqual([
      "stage",
      "commit",
      "branch_create",
      "branch_switch",
      "branch_delete"
    ]);
    expect(kernel.calls.slice(-5)).toEqual([
      {
        method: "git.local_mutation",
        params: {
          capabilityId: "kc_fixture",
          operation: "stage",
          paths: ["src/a.ts", "src/b.ts"]
        }
      },
      {
        method: "git.local_mutation",
        params: { capabilityId: "kc_fixture", operation: "commit", message: "bounded message" }
      },
      {
        method: "git.local_mutation",
        params: { capabilityId: "kc_fixture", operation: "branch_create", name: "feature/test" }
      },
      {
        method: "git.local_mutation",
        params: { capabilityId: "kc_fixture", operation: "branch_switch", name: "feature/test" }
      },
      {
        method: "git.local_mutation",
        params: { capabilityId: "kc_fixture", operation: "branch_delete", name: "feature/test" }
      }
    ]);
    expect(JSON.stringify(stage)).toContain("artifact://ka_git_mutation_fixture");
    expect(JSON.stringify(stage)).not.toContain("artifactId");
  });

  it("routes typed remote Git mutations through the private runtime capability", async () => {
    const kernel = new FakeKernel();
    const manager = new WorkspaceManager({
      kernel,
      trust: new FakeTrust(),
      idFactory: () => "ws_git_remote"
    });
    await manager.openWorkspace("/workspace");

    const fetch = await manager.gitFetch("ws_git_remote", "origin", "main");
    const pull = await manager.gitPull("ws_git_remote", "upstream", "feature/a");
    const push = await manager.gitPush("ws_git_remote", "origin", "main");

    expect([fetch.operation, pull.operation, push.operation]).toEqual(["fetch", "pull", "push"]);
    expect(kernel.calls.slice(-3)).toEqual([
      {
        method: "git.remote_mutation",
        params: { capabilityId: "kc_fixture", operation: "fetch", remote: "origin", ref: "main" }
      },
      {
        method: "git.remote_mutation",
        params: { capabilityId: "kc_fixture", operation: "pull", remote: "upstream", ref: "feature/a" }
      },
      {
        method: "git.remote_mutation",
        params: { capabilityId: "kc_fixture", operation: "push", remote: "origin", ref: "main" }
      }
    ]);
    expect(JSON.stringify(fetch)).toContain("artifact://ka_git_remote_fixture");
    expect(JSON.stringify(fetch)).not.toContain("artifactId");
  });

  it("routes conditional patch commits through the private runtime capability and rejects leaked fields", async () => {
    const kernel = new FakeKernel();
    const manager = new WorkspaceManager({
      kernel,
      trust: new FakeTrust(),
      idFactory: () => "ws_patch_commit"
    });
    await manager.openWorkspace("/workspace");

    const committed = await manager.commitPatchFile({
      workspaceId: "ws_patch_commit",
      path: "src/example.txt",
      action: "update",
      expectedSha256: "9160d4be34c8695bd172a76c7c7966587ea5a4d991ad22c87b2b91af54aa9ebb",
      content: "after\n"
    });
    expect(committed).toEqual({
      schemaVersion: 1,
      action: "update",
      bytesWritten: 6,
      sha256: "7b9a72466d3960eb2aacccfc848939453490db0678bd4725def3f789b891c919"
    });
    expect(kernel.calls.at(-1)).toEqual({
      method: "file.commit_patch_file",
      params: {
        capabilityId: "kc_fixture",
        path: "src/example.txt",
        action: "update",
        expectedSha256: "9160d4be34c8695bd172a76c7c7966587ea5a4d991ad22c87b2b91af54aa9ebb",
        content: "after\n"
      }
    });

    kernel.patchCommitResult = {
      ...kernel.patchCommitResult as Record<string, unknown>,
      hostPath: "/home/sauron/secret"
    };
    await expect(
      manager.commitPatchFile({
        workspaceId: "ws_patch_commit",
        path: "src/example.txt",
        action: "delete",
        expectedSha256: "7b9a72466d3960eb2aacccfc848939453490db0678bd4725def3f789b891c919",
        content: null
      })
    ).rejects.toMatchObject({ code: "RUNTIME_PROTOCOL_INVALID" });
  });

  it("routes verification availability and semantic execution through closed internal runtime methods", async () => {
    const kernel = new FakeKernel();
    const manager = new WorkspaceManager({
      kernel,
      trust: new FakeTrust(),
      idFactory: () => "ws_verify_runtime"
    });
    await manager.openWorkspace("/workspace");

    const availability = await manager.inspectExecutable("ws_verify_runtime", "cargo");
    const operation = await manager.runVerificationProcess({
      workspaceId: "ws_verify_runtime",
      recipeId: "cargo:test",
      logicalExecutable: "cargo",
      argv: ["test", "--workspace"],
      cwd: ".",
      background: true
    });

    expect(availability).toEqual({
      schemaVersion: 1,
      executableAvailable: true,
      sandboxAvailable: true
    });
    expect(operation).toMatchObject({
      schemaVersion: 1,
      operationId: "op_verify_fixture",
      state: "completed"
    });
    expect(kernel.calls.slice(-2)).toEqual([
      {
        method: "process.inspect_executable",
        params: { capabilityId: "kc_fixture", logicalExecutable: "cargo" }
      },
      {
        method: "verify.run",
        params: {
          capabilityId: "kc_fixture",
          recipeId: "cargo:test",
          logicalExecutable: "cargo",
          argv: ["test", "--workspace"],
          cwd: ".",
          background: true
        }
      }
    ]);
    expect(JSON.stringify({ availability, operation })).not.toContain("/home/");
  });

  it("propagates closed search truncation reasons and rejects inconsistent runtime payloads", async () => {
    const kernel = new FakeKernel();
    const manager = new WorkspaceManager({
      kernel,
      trust: new FakeTrust(),
      idFactory: () => "ws_search_contract"
    });
    await manager.openWorkspace("/workspace");

    kernel.searchResult = {
      matches: [],
      truncated: true,
      truncationReasons: ["FILE_SIZE_LIMIT"]
    };
    await expect(
      manager.searchBounded("ws_search_contract", "needle", ".", 10)
    ).resolves.toEqual({
      matches: [],
      truncated: true,
      truncationReasons: ["FILE_SIZE_LIMIT"]
    });

    kernel.searchResult = {
      matches: [],
      truncated: false,
      truncationReasons: ["TREE_LIMIT"]
    };
    await expect(
      manager.searchBounded("ws_search_contract", "needle", ".", 10)
    ).rejects.toMatchObject({ code: "RUNTIME_PROTOCOL_INVALID" });

    kernel.searchResult = {
      matches: [],
      truncated: true,
      truncationReasons: ["UNKNOWN_REASON"]
    };
    await expect(
      manager.searchBounded("ws_search_contract", "needle", ".", 10)
    ).rejects.toMatchObject({ code: "RUNTIME_PROTOCOL_INVALID" });
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
