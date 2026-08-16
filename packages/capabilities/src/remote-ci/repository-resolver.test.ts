import { describe, expect, it } from "vitest";

import type {
  RemoteCiRepositoryInspection,
  RemoteCiRepositoryInspectionAdapter,
  RemoteCiWorkspaceSelectionAdapter
} from "../adapters.js";
import { CapabilityError } from "../errors.js";
import { RemoteCiRepositoryResolver } from "./repository-resolver.js";

const HEAD = "1".repeat(40);

function fixture(options?: {
  ready?: string[];
  inspection?: RemoteCiRepositoryInspection;
  inspectError?: Error;
}) {
  const ready = options?.ready ?? ["ws_1"];
  const inspection = options?.inspection ?? {
    headOid: HEAD,
    branch: "main",
    remotes: [{ name: "origin", fetchUrl: "git@github.com:2ndworld/kodeGPT.git" }]
  };
  const selections: RemoteCiWorkspaceSelectionAdapter = {
    listReady: async () => ready.map((id) => ({ id }))
  };
  const repository: RemoteCiRepositoryInspectionAdapter = {
    inspect: async () => {
      if (options?.inspectError !== undefined) throw options.inspectError;
      return inspection;
    }
  };
  return new RemoteCiRepositoryResolver({ selections, repository });
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ name: "CapabilityError", code });
}

describe("RemoteCiRepositoryResolver", () => {
  it.each([
    ["https://github.com/owner/repository.git", "owner/repository"],
    ["https://github.com/owner/repository", "owner/repository"],
    ["git@github.com:owner/repository.git", "owner/repository"],
    ["ssh://git@github.com/owner/repository.git", "owner/repository"]
  ])("accepts approved GitHub remote form %s", async (fetchUrl, fullName) => {
    const resolver = fixture({
      inspection: {
        headOid: HEAD,
        branch: "main",
        remotes: [{ name: "origin", fetchUrl }]
      }
    });
    await expect(resolver.resolveRepository({})).resolves.toMatchObject({
      workspaceId: "ws_1",
      provider: "github",
      fullName,
      selectedRemote: "origin",
      headOid: HEAD,
      branch: "main"
    });
  });

  it("auto-selects only a sole READY workspace", async () => {
    await expect(fixture({ ready: [] }).resolveRepository({})).rejects.toMatchObject({
      code: "WORKSPACE_NOT_READY"
    });
    await expectCode(fixture({ ready: ["ws_a", "ws_b"] }).resolveRepository({}), "CI_WORKSPACE_AMBIGUOUS");
    await expect(fixture({ ready: ["ws_only"] }).resolveRepository({})).resolves.toMatchObject({
      workspaceId: "ws_only"
    });
  });

  it("preserves explicit workspace readiness errors", async () => {
    const error = new CapabilityError("WORKSPACE_NOT_READY", "Workspace is not READY");
    await expect(fixture({ inspectError: error }).resolveRepository({ workspaceId: "ws_explicit" })).rejects.toBe(error);
  });

  it("prefers origin and only falls back when exactly one non-origin remote exists", async () => {
    const originPreferred = fixture({
      inspection: {
        headOid: HEAD,
        branch: null,
        remotes: [
          { name: "upstream", fetchUrl: "https://github.com/example/upstream.git" },
          { name: "origin", fetchUrl: "https://github.com/2ndworld/kodeGPT.git" }
        ]
      }
    });
    await expect(originPreferred.resolveRepository({})).resolves.toMatchObject({
      fullName: "2ndworld/kodeGPT",
      selectedRemote: "origin"
    });

    const soleFallback = fixture({
      inspection: {
        headOid: HEAD,
        branch: "main",
        remotes: [{ name: "upstream", fetchUrl: "https://github.com/example/upstream.git" }]
      }
    });
    await expect(soleFallback.resolveRepository({})).resolves.toMatchObject({
      fullName: "example/upstream",
      selectedRemote: "upstream"
    });
  });

  it("rejects missing or ambiguous fallback remotes", async () => {
    await expectCode(
      fixture({ inspection: { headOid: HEAD, branch: "main", remotes: [] } }).resolveRepository({}),
      "CI_REPOSITORY_UNAVAILABLE"
    );
    await expectCode(
      fixture({
        inspection: {
          headOid: HEAD,
          branch: "main",
          remotes: [
            { name: "a", fetchUrl: "https://github.com/a/a.git" },
            { name: "b", fetchUrl: "https://github.com/b/b.git" }
          ]
        }
      }).resolveRepository({}),
      "CI_REPOSITORY_UNAVAILABLE"
    );
  });

  it.each([
    "https://user@github.com/owner/repository.git",
    "https://github.example.com/owner/repository.git",
    "ssh://git@github.enterprise.invalid/owner/repository.git",
    "git@example.com:owner/repository.git"
  ])("rejects unsupported or credential-bearing remote %s", async (fetchUrl) => {
    await expectCode(
      fixture({
        inspection: {
          headOid: HEAD,
          branch: "main",
          remotes: [{ name: "origin", fetchUrl }]
        }
      }).resolveRepository({}),
      "CI_REMOTE_UNSUPPORTED"
    );
  });

  it("does not fall through when origin itself is unsupported", async () => {
    await expectCode(
      fixture({
        inspection: {
          headOid: HEAD,
          branch: "main",
          remotes: [
            { name: "origin", fetchUrl: "https://gitlab.com/owner/repository.git" },
            { name: "github", fetchUrl: "https://github.com/owner/repository.git" }
          ]
        }
      }).resolveRepository({}),
      "CI_REMOTE_UNSUPPORTED"
    );
  });

  it.each([
    "https://github.com/owner/repository/extra",
    "https://github.com/owner/.git",
    "git@github.com:owner/repository/extra.git"
  ])("rejects malformed repository identity %s", async (fetchUrl) => {
    await expectCode(
      fixture({
        inspection: {
          headOid: HEAD,
          branch: "main",
          remotes: [{ name: "origin", fetchUrl }]
        }
      }).resolveRepository({}),
      "CI_REMOTE_UNSUPPORTED"
    );
  });
});
