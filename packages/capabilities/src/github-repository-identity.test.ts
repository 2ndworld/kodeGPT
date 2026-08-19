import { describe, expect, it } from "vitest";

import { CapabilityError } from "./errors.js";
import { resolveGitHubRepositoryIdentity } from "./github-repository-identity.js";

const gitRemote = (name: string, fetchUrl: string) => ({ name, fetchUrl });

describe("resolveGitHubRepositoryIdentity", () => {
  it("prefers origin and normalizes a supported GitHub scp remote", () => {
    expect(resolveGitHubRepositoryIdentity([
      gitRemote("backup", "https://github.com/other/repo.git"),
      gitRemote("origin", "git@github.com:2ndworld/kodeGPT.git")
    ])).toEqual({
      owner: "2ndworld",
      name: "kodeGPT",
      fullName: "2ndworld/kodeGPT",
      selectedRemote: "origin"
    });
  });

  it("accepts the reviewed HTTPS and ssh URL forms", () => {
    expect(resolveGitHubRepositoryIdentity([
      gitRemote("upstream", "https://github.com/2ndworld/kodeGPT.git")
    ]).fullName).toBe("2ndworld/kodeGPT");
    expect(resolveGitHubRepositoryIdentity([
      gitRemote("upstream", "ssh://git@github.com/2ndworld/kodeGPT.git")
    ]).fullName).toBe("2ndworld/kodeGPT");
  });

  it("fails closed when no usable Git remote exists", () => {
    expect(() => resolveGitHubRepositoryIdentity([])).toThrow(
      new CapabilityError("CI_REPOSITORY_UNAVAILABLE", "Trusted workspace has no usable Git fetch remote")
    );
  });

  it("fails closed instead of choosing among multiple fallback remotes", () => {
    expect(() => resolveGitHubRepositoryIdentity([
      gitRemote("one", "git@github.com:2ndworld/one.git"),
      gitRemote("two", "git@github.com:2ndworld/two.git")
    ])).toThrow(
      new CapabilityError("CI_REPOSITORY_UNAVAILABLE", "Trusted workspace has ambiguous Git fetch remotes")
    );
  });

  it("rejects credential-bearing and non-GitHub remotes", () => {
    for (const fetchUrl of [
      "https://user@github.com/2ndworld/kodeGPT.git",
      "https://example.com/2ndworld/kodeGPT.git",
      "ssh://git@github.com:2222/2ndworld/kodeGPT.git"
    ]) {
      expect(() => resolveGitHubRepositoryIdentity([gitRemote("origin", fetchUrl)])).toThrow(
        new CapabilityError("CI_REMOTE_UNSUPPORTED", "Trusted workspace Git remote is not a supported github.com repository")
      );
    }
  });
});
