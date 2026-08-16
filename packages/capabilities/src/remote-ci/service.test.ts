import { describe, expect, it } from "vitest";

import type {
  RemoteCiAdapter,
  RemoteCiAuditAdapter,
  RemoteCiAuditInput,
  RemoteCiRevisionAdapter,
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
const FAILED_STEP = {
  number: 2,
  name: "Run tests",
  status: "COMPLETED" as const,
  conclusion: "FAILURE" as const,
  startedAt: "2026-08-16T01:00:10.000Z",
  completedAt: "2026-08-16T01:00:20.000Z"
};
const FAILED_JOB = {
  id: "20",
  name: "test",
  status: "COMPLETED" as const,
  conclusion: "FAILURE" as const,
  startedAt: "2026-08-16T01:00:02.000Z",
  completedAt: "2026-08-16T01:00:50.000Z",
  url: "https://github.com/2ndworld/kodeGPT/runs/10/jobs/20",
  steps: [FAILED_STEP]
};

class Fixture {
  events: string[] = [];
  audits: RemoteCiAuditInput[] = [];
  auditFailurePhase: "decision" | "success" | "failed" | undefined;
  credentialError: Error | undefined;
  runsInput: Parameters<RemoteCiAdapter["runs"]>[0] | undefined;
  factoryCredentials: string[] = [];
  statusChecks: Awaited<ReturnType<RemoteCiAdapter["statusEvidence"]>>["checks"] = [];
  statusRuns: Awaited<ReturnType<RemoteCiAdapter["statusEvidence"]>>["runs"] = [];
  statusRequests = 3;
  statusPageLimited = false;
  statusSummaryLimitReached = false;
  statusInput: Parameters<RemoteCiAdapter["statusEvidence"]>[0] | undefined;
  revisionResult = { oid: "b".repeat(40), branch: "release" as string | null };
  revisionInput: { workspaceId: string; revision: unknown } | undefined;
  runsRequests = 1;
  runRequests = 2;
  runsLimitReached = false;
  runsPageLimited = false;
  runPageLimited = false;
  jobLimitReached = false;
  stepLimitReached = false;
  failureJobs: Awaited<ReturnType<RemoteCiAdapter["failureMetadata"]>>["jobs"] = [FAILED_JOB];
  failureAnnotations = [{
    path: "src/index.ts",
    startLine: 10,
    endLine: 10,
    startColumn: null,
    endColumn: null,
    level: "FAILURE" as const,
    message: "fixture assertion failed",
    title: "Failure"
  }];
  failureMetadataRequests = 3;
  failureAnnotationLimitReached = false;
  failurePageLimited = false;
  failureJobLimitReached = false;
  failureStepLimitReached = false;
  failureLogBytes = new TextEncoder().encode("error: fixture\nRun tests failed\n");
  failureLogTruncated = false;
  failureLogRequests = 2;
  selectedFailureJobId: string | undefined;
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

  revisions: RemoteCiRevisionAdapter = {
    resolve: async (workspaceId, revision) => {
      this.events.push("resolve-revision");
      this.revisionInput = { workspaceId, revision };
      return this.revisionResult;
    }
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
    statusEvidence: async (input) => {
      this.events.push("provider-status");
      this.statusInput = input;
      if (this.providerError !== undefined) throw this.providerError;
      return {
        checks: this.statusChecks,
        runs: this.statusRuns,
        providerPageLimited: this.statusPageLimited,
        summaryLimitReached: this.statusSummaryLimitReached,
        providerRequests: this.statusRequests
      };
    },
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
    failureMetadata: async (input) => {
      this.events.push("provider-failure-metadata");
      if (this.providerError !== undefined) throw this.providerError;
      const selectedJobId = input.selectJob(this.failureJobs);
      this.selectedFailureJobId = selectedJobId;
      return {
        run: { ...RUN, conclusion: "FAILURE" as const },
        jobs: this.failureJobs,
        selectedJobId,
        annotations: this.failureAnnotations,
        providerPageLimited: this.failurePageLimited,
        jobLimitReached: this.failureJobLimitReached,
        stepLimitReached: this.failureStepLimitReached,
        annotationLimitReached: this.failureAnnotationLimitReached,
        providerRequests: this.failureMetadataRequests
      };
    },
    failureLog: async () => {
      this.events.push("provider-failure-log");
      if (this.providerError !== undefined) throw this.providerError;
      return {
        bytes: this.failureLogBytes,
        truncated: this.failureLogTruncated,
        providerRequests: this.failureLogRequests
      };
    }
  };

  service() {
    return new RemoteCiService({
      resolver: this.resolver,
      roots: this.roots,
      revisions: this.revisions,
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

describe("RemoteCiService status", () => {
  it("uses the trusted local HEAD on the zero-argument fast path", async () => {
    const fixture = new Fixture();
    const result = await fixture.service().status({});

    expect(result).toMatchObject({
      workspaceId: "ws_1",
      provider: "github",
      repository: { fullName: "2ndworld/kodeGPT" },
      revision: { oid: OID, branch: "main" },
      state: "UNKNOWN",
      checks: [],
      runs: [],
      failures: [],
      truncated: false,
      truncationReasons: []
    });
    expect(fixture.statusInput).toEqual({
      repository: { owner: "2ndworld", name: "kodeGPT", fullName: "2ndworld/kodeGPT" },
      oid: OID
    });
    expect(fixture.revisionInput).toBeUndefined();
    expect(fixture.events).toEqual([
      "resolve-repository",
      "audit-decision",
      "credential",
      "provider-status",
      "audit-success"
    ]);
  });

  it("applies exact FAIL > PENDING > CANCELLED > UNKNOWN > PASS precedence", async () => {
    const fixture = new Fixture();
    fixture.statusChecks = [
      { id: "1", name: "pass", state: "PASS", conclusion: "SUCCESS", url: null },
      { id: "2", name: "unknown", state: "UNKNOWN", conclusion: null, url: null },
      { id: "3", name: "cancelled", state: "CANCELLED", conclusion: "CANCELLED", url: null },
      { id: "4", name: "pending", state: "PENDING", conclusion: null, url: null },
      { id: "5", name: "fail", state: "FAIL", conclusion: "FAILURE", url: null }
    ];
    await expect(fixture.service().status({})).resolves.toMatchObject({ state: "FAIL" });

    fixture.statusChecks = fixture.statusChecks.filter((check) => check.state !== "FAIL");
    await expect(fixture.service().status({})).resolves.toMatchObject({ state: "PENDING" });
    fixture.statusChecks = fixture.statusChecks.filter((check) => check.state !== "PENDING");
    await expect(fixture.service().status({})).resolves.toMatchObject({ state: "CANCELLED" });
    fixture.statusChecks = fixture.statusChecks.filter((check) => check.state !== "CANCELLED");
    await expect(fixture.service().status({})).resolves.toMatchObject({ state: "UNKNOWN" });
    fixture.statusChecks = fixture.statusChecks.filter((check) => check.state !== "UNKNOWN");
    await expect(fixture.service().status({})).resolves.toMatchObject({ state: "PASS" });
  });

  it("keeps failure/pending observations when the combined summary limit is exceeded", async () => {
    const fixture = new Fixture();
    fixture.statusChecks = Array.from({ length: 49 }, (_, index) => ({
      id: String(index + 1),
      name: `pass-${index + 1}`,
      state: "PASS" as const,
      conclusion: "SUCCESS" as const,
      url: null
    }));
    fixture.statusRuns = [
      { ...RUN, id: "100", status: "COMPLETED", conclusion: "FAILURE" },
      { ...RUN, id: "101", status: "IN_PROGRESS", conclusion: null },
      { ...RUN, id: "102", status: "COMPLETED", conclusion: "SUCCESS" }
    ];

    const result = await fixture.service().status({});
    expect(result.checks.length + result.runs.length).toBe(50);
    expect(result.runs.map((run) => run.id)).toContain("100");
    expect(result.runs.map((run) => run.id)).toContain("101");
    expect(result.state).toBe("FAIL");
    expect(result.truncationReasons).toEqual(["SUMMARY_LIMIT"]);
  });

  it("caps failure summaries at 20 with explicit SUMMARY_LIMIT", async () => {
    const fixture = new Fixture();
    fixture.statusRuns = Array.from({ length: 25 }, (_, index) => ({
      ...RUN,
      id: String(100 + index),
      conclusion: "FAILURE" as const
    }));

    const result = await fixture.service().status({});
    expect(result.failures).toHaveLength(20);
    expect(result.failures[0]).toMatchObject({ runId: "100", conclusion: "FAILURE" });
    expect(result.truncationReasons).toEqual(["SUMMARY_LIMIT"]);
  });

  it("resolves an explicit local revision without changing repository identity", async () => {
    const fixture = new Fixture();
    const result = await fixture.service().status({
      revision: { kind: "branch", name: "release" }
    });

    expect(fixture.revisionInput).toEqual({
      workspaceId: "ws_1",
      revision: { kind: "branch", name: "release" }
    });
    expect(fixture.statusInput?.oid).toBe("b".repeat(40));
    expect(result.revision).toEqual({ oid: "b".repeat(40), branch: "release" });
    expect(result.repository.fullName).toBe("2ndworld/kodeGPT");
    expect(fixture.events.slice(0, 3)).toEqual([
      "resolve-repository",
      "audit-decision",
      "resolve-revision"
    ]);
  });

  it("fails and audits when GitHub cannot observe the locally resolved commit", async () => {
    const fixture = new Fixture();
    fixture.providerError = new CapabilityError("CI_NOT_FOUND", "Commit is not observable");
    await expectCode(
      fixture.service().status({ revision: { kind: "oid", oid: "b".repeat(40) } }),
      "CI_NOT_FOUND"
    );
    expect(fixture.audits.at(-1)).toMatchObject({ phase: "failed", errorCode: "CI_NOT_FOUND" });
  });

  it("enforces the six-request ci.status provider budget", async () => {
    const fixture = new Fixture();
    fixture.statusRequests = 7;
    await expectCode(fixture.service().status({}), "CI_RESPONSE_INVALID");
    expect(fixture.audits.at(-1)).toMatchObject({
      phase: "failed",
      errorCode: "CI_RESPONSE_INVALID"
    });
  });
});

describe("RemoteCiService failure", () => {
  it("selects a failed job deterministically, redacts evidence, and audits the selected job", async () => {
    const fixture = new Fixture();
    fixture.failureJobs = [
      {
        ...FAILED_JOB,
        id: "20",
        steps: [{ ...FAILED_STEP, conclusion: "SUCCESS" as const }]
      },
      { ...FAILED_JOB, id: "21", name: "preferred-failure" },
      { ...FAILED_JOB, id: "22", name: "later-failure" }
    ];

    const result = await fixture.service().failure({ runId: "10" });

    expect(result).toMatchObject({
      runId: "10",
      job: { id: "21", name: "preferred-failure" },
      failedStep: { name: "Run tests", conclusion: "FAILURE" },
      reason: "STEP_FAILURE"
    });
    expect(result.annotations[0]?.message).not.toContain("fixture");
    expect(result.logExcerpt).not.toContain("fixture");
    expect(fixture.selectedFailureJobId).toBe("21");
    expect(fixture.audits.at(-1)).toMatchObject({
      phase: "success",
      runId: "10",
      jobId: "21"
    });
    expect(fixture.events).toEqual([
      "resolve-repository",
      "audit-decision",
      "credential",
      "provider-failure-metadata",
      "provider-failure-log",
      "audit-success"
    ]);
  });

  it("requires an explicit jobId to belong to the observed run", async () => {
    const fixture = new Fixture();
    await expectCode(fixture.service().failure({ runId: "10", jobId: "999" }), "CI_NOT_FOUND");
    expect(fixture.events).not.toContain("provider-failure-log");
    expect(fixture.audits.at(-1)).toMatchObject({
      phase: "failed",
      runId: "10",
      jobId: "999",
      errorCode: "CI_NOT_FOUND"
    });
  });

  it("returns CI_NOT_FOUND when the bounded observation contains no failed job", async () => {
    const fixture = new Fixture();
    fixture.failureJobs = [{
      ...FAILED_JOB,
      conclusion: "SUCCESS",
      steps: [{ ...FAILED_STEP, conclusion: "SUCCESS" }]
    }];
    await expectCode(fixture.service().failure({ runId: "10" }), "CI_NOT_FOUND");
    expect(fixture.events).not.toContain("provider-failure-log");
  });

  it("fails closed when the combined metadata/log request count exceeds five", async () => {
    const fixture = new Fixture();
    fixture.failureMetadataRequests = 3;
    fixture.failureLogRequests = 3;
    await expectCode(fixture.service().failure({ runId: "10" }), "CI_RESPONSE_INVALID");
    expect(fixture.audits.at(-1)).toMatchObject({
      phase: "failed",
      errorCode: "CI_RESPONSE_INVALID"
    });
  });

  it("rejects a log representation that cannot be decoded safely inside the scan budget", async () => {
    const fixture = new Fixture();
    fixture.failureLogBytes = Uint8Array.from([0xff, 0xfe, 0xfd]);
    await expectCode(fixture.service().failure({ runId: "10" }), "CI_LOG_LIMIT_EXCEEDED");
  });

  it("emits canonical hard-bound truncation reasons and a 64 KiB maximum excerpt", async () => {
    const fixture = new Fixture();
    fixture.failureJobLimitReached = true;
    fixture.failureStepLimitReached = true;
    fixture.failureAnnotationLimitReached = true;
    fixture.failurePageLimited = true;
    fixture.failureLogBytes = new TextEncoder().encode("error: " + "x".repeat(100 * 1024));
    fixture.failureLogTruncated = true;

    const result = await fixture.service().failure({ runId: "10" });

    expect(result.truncationReasons).toEqual([
      "JOB_LIMIT",
      "STEP_LIMIT",
      "ANNOTATION_LIMIT",
      "LOG_BYTE_LIMIT",
      "PROVIDER_PAGE_LIMIT"
    ]);
    expect(Buffer.byteLength(result.logExcerpt ?? "", "utf8")).toBeLessThanOrEqual(64 * 1024);
  });
});

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
