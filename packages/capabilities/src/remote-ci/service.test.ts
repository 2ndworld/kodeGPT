import { describe, expect, it } from "vitest";

import type {
  RemoteCiAdapter,
  RemoteCiAuditAdapter,
  RemoteCiAuditInput,
  RemoteCiWorkspaceRootAdapter
} from "../adapters.js";
import { CapabilityError } from "../errors.js";
import type { GitHubCredentialProvider } from "./credential-provider.js";
import type { ResolvedCiRepository } from "./repository-resolver.js";
import { RemoteCiService } from "./service.js";

const OID = "a".repeat(40);
const RESOLVED: ResolvedCiRepository = {
  workspaceId: "ws_1",
  provider: "github",
  owner: "2ndworld",
  name: "kodeGPT",
  fullName: "2ndworld/kodeGPT",
  selectedRemote: "origin",
  headOid: OID,
  branch: "main"
};
const RUN = {
  id: "10",
  name: "Build commit",
  workflow: "CI",
  status: "COMPLETED" as const,
  conclusion: "SUCCESS" as const,
  headOid: OID,
  ref: "main",
  event: "push",
  url: "https://github.com/2ndworld/kodeGPT/actions/runs/10",
  createdAt: "2026-08-16T01:00:00.000Z",
  startedAt: "2026-08-16T01:00:01.000Z",
  updatedAt: "2026-08-16T01:01:00.000Z"
};

class Fixture {
  events: string[] = [];
  audits: RemoteCiAuditInput[] = [];
  auditFailurePhase: "decision" | "success" | "failed" | undefined;
  credentialError: Error | undefined;
  runsInput: Parameters<RemoteCiAdapter["runs"]>[0] | undefined;
  factoryCredentials: string[] = [];
  runsRequests = 1;
  runRequests = 2;
  runsLimitReached = false;
  runsPageLimited = false;
  runPageLimited = false;
  jobLimitReached = false;
  stepLimitReached = false;
  providerError: Error | undefined;

  resolver = {
    resolveRepository: async (_input: { workspaceId?: string }) => {
      this.events.push("resolve-repository");
      return RESOLVED;
    }
  };

  roots: RemoteCiWorkspaceRootAdapter = {
    rootFor: async () => "/workspace"
  };

  credential: GitHubCredentialProvider = {
    getCredential: async () => {
      this.events.push("credential");
      if (this.credentialError !== undefined) throw this.credentialError;
      return { source: "gh", token: "fixture" };
    }
  };

  audit: RemoteCiAuditAdapter = {
    record: async (input) => {
      this.events.push(`audit-${input.phase}`);
      this.audits.push(input);
      if (this.auditFailurePhase === input.phase) throw new Error("audit unavailable");
    }
  };

  adapter: RemoteCiAdapter = {
    repository: async () => {
      this.events.push("provider-repository");
      if (this.providerError !== undefined) throw this.providerError;
      return { defaultBranch: "main", providerRequests: 1 };
    },
    statusEvidence: async () => ({
      checks: [],
      runs: [],
      providerPageLimited: false,
      summaryLimitReached: false,
      providerRequests: 2
    }),
    runs: async (input) => {
      this.events.push("provider-runs");
      this.runsInput = input;
      if (this.providerError !== undefined) throw this.providerError;
      return {
        items: [RUN],
        providerPageLimited: this.runsPageLimited,
        limitReached: this.runsLimitReached,
        providerRequests: this.runsRequests
      };
    },
    run: async () => {
      this.events.push("provider-run");
      if (this.providerError !== undefined) throw this.providerError;
      return {
        run: RUN,
        jobs: [],
        annotations: [],
        providerPageLimited: this.runPageLimited,
        jobLimitReached: this.jobLimitReached,
        stepLimitReached: this.stepLimitReached,
        providerRequests: this.runRequests
      };
    },
    failureMetadata: async () => ({
      run: RUN,
      jobs: [],
      annotations: [],
      providerPageLimited: false,
      jobLimitReached: false,
      stepLimitReached: false,
      providerRequests: 2
    }),
    failureLog: async () => ({ bytes: new Uint8Array(), truncated: false })
  };

  service() {
    return new RemoteCiService({
      resolver: this.resolver,
      roots: this.roots,
      credentialProvider: this.credential,
      adapterFactory: {
        create: (credential) => {
          this.factoryCredentials.push(credential.token);
          return this.adapter;
        }
      },
      audit: this.audit,
      operationIdFactory: () => "op_ci_test"
    });
  }
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ name: "CapabilityError", code });
}

describe("RemoteCiService repository/runs/run", () => {
  it("enforces decision-before-credential/network and outcome-before-return", async () => {
    const fixture = new Fixture();
    await fixture.service().runs({});
    expect(fixture.events).toEqual([
      "resolve-repository",
      "audit-decision",
      "credential",
      "provider-runs",
      "audit-success"
    ]);
    expect(fixture.factoryCredentials).toEqual(["fixture"]);
  });

  it("fails closed before credential/network when pre-network audit is unavailable", async () => {
    const fixture = new Fixture();
    fixture.auditFailurePhase = "decision";
    await expectCode(fixture.service().runs({}), "CI_AUDIT_UNAVAILABLE");
    expect(fixture.events).toEqual(["resolve-repository", "audit-decision"]);
  });

  it("discards an observed provider result when final audit is unavailable", async () => {
    const fixture = new Fixture();
    fixture.auditFailurePhase = "success";
    await expectCode(fixture.service().runs({}), "CI_AUDIT_UNAVAILABLE");
    expect(fixture.events).toEqual([
      "resolve-repository",
      "audit-decision",
      "credential",
      "provider-runs",
      "audit-success"
    ]);
  });

  it("returns missing authentication as a repository diagnostic without provider metadata access", async () => {
    const fixture = new Fixture();
    fixture.credentialError = new CapabilityError("CI_AUTH_REQUIRED", "GitHub authentication is required");
    const result = await fixture.service().repository({});
    expect(result).toMatchObject({
      workspaceId: "ws_1",
      provider: "github",
      repository: { owner: "2ndworld", name: "kodeGPT", fullName: "2ndworld/kodeGPT" },
      selectedRemote: "origin",
      defaultBranch: null,
      currentRevision: { oid: OID, branch: "main" },
      available: false,
      authState: "REQUIRED",
      credentialSource: null,
      truncated: false,
      truncationReasons: []
    });
    expect(fixture.events).toEqual([
      "resolve-repository",
      "audit-decision",
      "credential",
      "audit-success"
    ]);
    expect(fixture.factoryCredentials).toEqual([]);
  });

  it("applies ci.runs default=10 and emits explicit run/page truncation signals", async () => {
    const fixture = new Fixture();
    fixture.runsLimitReached = true;
    fixture.runsPageLimited = true;
    const result = await fixture.service().runs({});
    expect(fixture.runsInput?.limit).toBe(10);
    expect(result.truncated).toBe(true);
    expect(result.truncationReasons).toEqual(["RUN_LIMIT", "PROVIDER_PAGE_LIMIT"]);
    expect(fixture.audits.at(-1)).toMatchObject({ phase: "success", truncated: true });
  });

  it("maps run hard-bound signals and enforces the two-request budget", async () => {
    const fixture = new Fixture();
    fixture.runPageLimited = true;
    fixture.jobLimitReached = true;
    fixture.stepLimitReached = true;
    const result = await fixture.service().run({ runId: "10" });
    expect(result.truncationReasons).toEqual(["JOB_LIMIT", "STEP_LIMIT", "PROVIDER_PAGE_LIMIT"]);

    fixture.runRequests = 3;
    await expectCode(fixture.service().run({ runId: "10" }), "CI_RESPONSE_INVALID");
  });

  it("enforces the one-request ci.runs provider budget", async () => {
    const fixture = new Fixture();
    fixture.runsRequests = 2;
    await expectCode(fixture.service().runs({}), "CI_RESPONSE_INVALID");
    expect(fixture.audits.at(-1)).toMatchObject({
      phase: "failed",
      errorCode: "CI_RESPONSE_INVALID"
    });
  });

  it("records sanitized CI error codes before returning provider failures", async () => {
    const fixture = new Fixture();
    fixture.providerError = new CapabilityError("CI_RATE_LIMITED", "Rate limited", { retryAfter: 30 });
    await expectCode(fixture.service().runs({}), "CI_RATE_LIMITED");
    expect(fixture.audits.at(-1)).toMatchObject({ phase: "failed", errorCode: "CI_RATE_LIMITED" });
  });
});
