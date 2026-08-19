import { describe, expect, it, vi } from "vitest";

import type { GitRemoteAuthorityAdapter, GitRemoteMutationAdapter } from "./adapters.js";
import { gitFetch, gitPull, gitPush } from "./git-remote.js";
import { GitRemoteInputSchema, GitRemoteMutationResultSchema } from "./schemas.js";

const RESULT = {
  schemaVersion: 1 as const,
  operation: "fetch" as const,
  exitCode: 0,
  stdoutPreview: "",
  stderrPreview: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  sourceTruncated: false,
  bytesSpooled: 0,
  artifact: {
    schemaVersion: 1 as const,
    uri: "artifact://ka_git_remote_fixture" as const,
    mediaType: "application/vnd.kodegpt.execution-stream",
    sizeBytes: 0,
    sourceTruncated: false
  }
};

function mutationAdapter(): GitRemoteMutationAdapter {
  return {
    fetch: vi.fn(async () => RESULT),
    pull: vi.fn(async () => ({ ...RESULT, operation: "pull" as const })),
    push: vi.fn(async () => ({ ...RESULT, operation: "push" as const }))
  };
}

describe("trusted remote Git capability", () => {
  it("rejects URL-like remotes and refspec-like refs before adapter execution", () => {
    expect(() =>
      GitRemoteInputSchema.parse({ workspaceId: "ws", remote: "https://secret@example.invalid/repo.git", ref: "main" })
    ).toThrow();
    expect(() => GitRemoteInputSchema.parse({ workspaceId: "ws", remote: "origin/path", ref: "main" })).toThrow();
    expect(() => GitRemoteInputSchema.parse({ workspaceId: "ws", remote: "origin", ref: "main:evil" })).toThrow();
    expect(() => GitRemoteInputSchema.parse({ workspaceId: "ws", remote: "origin", ref: "-force" })).toThrow();
    expect(() => GitRemoteMutationResultSchema.parse({ ...RESULT, capabilityId: "kc_secret" })).toThrow();
  });

  it("requires effective trusted write authority with unrestricted network", async () => {
    for (const policy of [
      { name: "develop", allowWrite: true, network: "unrestricted" },
      { name: "trusted", allowWrite: false, network: "unrestricted" },
      { name: "trusted", allowWrite: true, network: "deny" },
      { name: "trusted", allowWrite: true, network: "localhost" }
    ]) {
      const authority: GitRemoteAuthorityAdapter = { effectivePolicy: () => policy };
      const mutation = mutationAdapter();
      await expect(gitFetch(authority, mutation, { workspaceId: "ws", ref: "main" })).rejects.toMatchObject({
        code: "GIT_REMOTE_POLICY_DENIED"
      });
      expect(mutation.fetch).not.toHaveBeenCalled();
    }
  });

  it("routes fetch, pull, and push with origin as the default remote", async () => {
    const authority: GitRemoteAuthorityAdapter = {
      effectivePolicy: () => ({ name: "trusted", allowWrite: true, network: "unrestricted" })
    };
    const mutation = mutationAdapter();

    await expect(gitFetch(authority, mutation, { workspaceId: "ws", ref: "main" })).resolves.toMatchObject({
      operation: "fetch"
    });
    await expect(
      gitPull(authority, mutation, { workspaceId: "ws", remote: "upstream", ref: "feature/a" })
    ).resolves.toMatchObject({ operation: "pull" });
    await expect(gitPush(authority, mutation, { workspaceId: "ws", ref: "main" })).resolves.toMatchObject({
      operation: "push"
    });

    expect(mutation.fetch).toHaveBeenCalledWith("ws", "origin", "main");
    expect(mutation.pull).toHaveBeenCalledWith("ws", "upstream", "feature/a");
    expect(mutation.push).toHaveBeenCalledWith("ws", "origin", "main");
  });

  it("acquires a private credential after policy admission and forwards it only to the mutation adapter", async () => {
    const authority: GitRemoteAuthorityAdapter = {
      effectivePolicy: () => ({ name: "trusted", allowWrite: true, network: "unrestricted" })
    };
    const mutation = mutationAdapter();
    const credentials = {
      acquire: vi.fn(async () => ({ kind: "github_token" as const, token: "[REDACTED_SECRET]" }))
    };

    await expect(
      (gitPush as unknown as (...args: unknown[]) => Promise<unknown>)(
        authority,
        mutation,
        { workspaceId: "ws", ref: "main" },
        credentials
      )
    ).resolves.toMatchObject({ operation: "push" });

    expect(credentials.acquire).toHaveBeenCalledWith("push");
    expect(mutation.push).toHaveBeenCalledWith(
      "ws",
      "origin",
      "main",
      { kind: "github_token", token: "[REDACTED_SECRET]" }
    );
  });

  it("does not acquire credentials when remote Git policy is denied", async () => {
    const authority: GitRemoteAuthorityAdapter = {
      effectivePolicy: () => ({ name: "develop", allowWrite: true, network: "unrestricted" })
    };
    const mutation = mutationAdapter();
    const credentials = { acquire: vi.fn(async () => ({ kind: "github_token" as const, token: "[REDACTED_SECRET]" })) };

    await expect(
      (gitFetch as unknown as (...args: unknown[]) => Promise<unknown>)(
        authority,
        mutation,
        { workspaceId: "ws", ref: "main" },
        credentials
      )
    ).rejects.toMatchObject({ code: "GIT_REMOTE_POLICY_DENIED" });
    expect(credentials.acquire).not.toHaveBeenCalled();
  });

  it("normalizes private credential-source failures without forwarding raw helper evidence", async () => {
    const authority: GitRemoteAuthorityAdapter = {
      effectivePolicy: () => ({ name: "trusted", allowWrite: true, network: "unrestricted" })
    };
    const mutation = mutationAdapter();
    const credentials = {
      acquire: vi.fn(async () => {
        throw { code: "PROVIDER_CREDENTIAL_REJECTED", message: "fixture helper failure details" };
      })
    };

    await expect(
      (gitPush as unknown as (...args: unknown[]) => Promise<unknown>)(
        authority,
        mutation,
        { workspaceId: "ws", ref: "main" },
        credentials
      )
    ).rejects.toMatchObject({
      code: "GIT_REMOTE_UNAVAILABLE",
      message: "Remote Git credential is unavailable"
    });
    expect(mutation.push).not.toHaveBeenCalled();
  });

  it("normalizes runtime errors without forwarding secret transport messages", async () => {
    const authority: GitRemoteAuthorityAdapter = {
      effectivePolicy: () => ({ name: "trusted", allowWrite: true, network: "unrestricted" })
    };
    const mutation = mutationAdapter();
    mutation.push = vi.fn(async () => {
      throw { code: "GIT_REMOTE_FAILED", message: "https://token@example.invalid/private.git" };
    });

    await expect(gitPush(authority, mutation, { workspaceId: "ws", ref: "main" })).rejects.toMatchObject({
      code: "GIT_REMOTE_FAILED",
      message: "Remote Git mutation failed"
    });
  });
});
