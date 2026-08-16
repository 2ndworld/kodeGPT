import { describe, expect, it } from "vitest";

import type { GitHubLogRead } from "./github-http.js";
import { GitHubRemoteCiAdapter } from "./github-adapter.js";

const OID = "a".repeat(40);
const REPOSITORY = { owner: "2ndworld", name: "kodeGPT", fullName: "2ndworld/kodeGPT" } as const;

class FakeHttp {
  responses: unknown[] = [];
  calls: Array<{ kind: "json" | "log"; path: string; query?: string; maxBytes?: number }> = [];
  logResult: GitHubLogRead = { bytes: new TextEncoder().encode("log"), truncated: false };

  async getJson<T>(path: string, query?: URLSearchParams): Promise<T> {
    this.calls.push({ kind: "json", path, ...(query === undefined ? {} : { query: query.toString() }) });
    const value = this.responses.shift();
    if (value === undefined) throw new Error("missing fake response");
    return value as T;
  }

  async getJobLog(path: string, maxBytes: number): Promise<GitHubLogRead> {
    this.calls.push({ kind: "log", path, maxBytes });
    return this.logResult;
  }
}

function runFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    name: "CI",
    display_title: "Build commit",
    status: "completed",
    conclusion: "success",
    head_sha: OID,
    head_branch: "main",
    event: "push",
    html_url: "https://github.com/2ndworld/kodeGPT/actions/runs/10",
    created_at: "2026-08-16T01:00:00Z",
    run_started_at: "2026-08-16T01:00:01Z",
    updated_at: "2026-08-16T01:01:00Z",
    ...overrides
  };
}

function jobFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 20,
    run_id: 10,
    name: "test",
    status: "completed",
    conclusion: "failure",
    started_at: "2026-08-16T01:00:02Z",
    completed_at: "2026-08-16T01:00:50Z",
    html_url: "https://github.com/2ndworld/kodeGPT/runs/10/jobs/20",
    steps: [
      {
        number: 1,
        name: "Run tests",
        status: "completed",
        conclusion: "failure",
        started_at: "2026-08-16T01:00:03Z",
        completed_at: "2026-08-16T01:00:49Z"
      }
    ],
    ...overrides
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ name: "CapabilityError", code });
}

describe("GitHubRemoteCiAdapter", () => {
  it("accepts case-only canonical repository equality and rejects a rename/mismatch", async () => {
    const http = new FakeHttp();
    http.responses.push({ full_name: "2NDWORLD/KODEGPT", default_branch: "main" });
    const adapter = new GitHubRemoteCiAdapter({ http });
    await expect(adapter.repository({ repository: REPOSITORY })).resolves.toEqual({
      defaultBranch: "main"
    });
    expect(http.calls[0]).toEqual({
      kind: "json",
      path: "/repos/2ndworld/kodeGPT"
    });

    http.responses.push({ full_name: "other/repository", default_branch: "main" });
    await expectCode(adapter.repository({ repository: REPOSITORY }), "CI_REPOSITORY_MISMATCH");
  });

  it("normalizes check and workflow-run evidence for one commit", async () => {
    const http = new FakeHttp();
    http.responses.push(
      {
        total_count: 2,
        check_runs: [
          {
            id: "90071992547409931234",
            name: "tests",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/2ndworld/kodeGPT/runs/111"
          },
          {
            id: 2,
            name: "future-status",
            status: "provider-new-state",
            conclusion: "provider-new-conclusion",
            html_url: "https://example.invalid/not-accepted"
          }
        ]
      },
      { total_count: 1, workflow_runs: [runFixture({ status: "queued", conclusion: null })] }
    );
    const adapter = new GitHubRemoteCiAdapter({ http });

    const result = await adapter.statusEvidence({ repository: REPOSITORY, oid: OID });
    expect(result.checks).toEqual([
      expect.objectContaining({ id: "90071992547409931234", state: "FAIL", conclusion: "FAILURE" }),
      expect.objectContaining({ id: "2", state: "UNKNOWN", conclusion: null, url: null })
    ]);
    expect(result.runs[0]).toMatchObject({ id: "10", status: "QUEUED", conclusion: null, headOid: OID });
    expect(result.providerPageLimited).toBe(false);
    expect(http.calls).toEqual([
      {
        kind: "json",
        path: `/repos/2ndworld/kodeGPT/commits/${OID}/check-runs`,
        query: "per_page=50"
      },
      {
        kind: "json",
        path: "/repos/2ndworld/kodeGPT/actions/runs",
        query: `head_sha=${OID}&per_page=50`
      }
    ]);
  });

  it("returns empty status evidence rather than PASS when the provider observes nothing", async () => {
    const http = new FakeHttp();
    http.responses.push({ total_count: 0, check_runs: [] }, { total_count: 0, workflow_runs: [] });
    const adapter = new GitHubRemoteCiAdapter({ http });
    await expect(adapter.statusEvidence({ repository: REPOSITORY, oid: OID })).resolves.toEqual({
      checks: [],
      runs: [],
      providerPageLimited: false,
      summaryLimitReached: false
    });
  });

  it("lists at most one bounded provider page and filters normalized runs", async () => {
    const http = new FakeHttp();
    http.responses.push({
      total_count: 60,
      workflow_runs: [
        runFixture(),
        runFixture({ id: 11, name: "Other", display_title: "Other", status: "in_progress", conclusion: null })
      ]
    });
    const adapter = new GitHubRemoteCiAdapter({ http });
    const result = await adapter.runs({
      repository: REPOSITORY,
      workflow: "CI",
      ref: "main",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      limit: 10
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: "10", workflow: "CI", status: "COMPLETED", conclusion: "SUCCESS" });
    expect(result.providerPageLimited).toBe(true);
    expect(http.calls).toEqual([
      {
        kind: "json",
        path: "/repos/2ndworld/kodeGPT/actions/runs",
        query: "branch=main&status=completed&per_page=50"
      }
    ]);
  });

  it("normalizes one run with jobs and steps using exactly two metadata reads", async () => {
    const http = new FakeHttp();
    http.responses.push(
      runFixture(),
      { total_count: 1, jobs: [jobFixture()] }
    );
    const adapter = new GitHubRemoteCiAdapter({ http });
    const result = await adapter.run({ repository: REPOSITORY, runId: "10" });

    expect(result.run).toMatchObject({ id: "10", workflow: "CI", status: "COMPLETED", conclusion: "SUCCESS" });
    expect(result.jobs[0]).toMatchObject({
      id: "20",
      name: "test",
      conclusion: "FAILURE",
      steps: [expect.objectContaining({ number: 1, name: "Run tests", conclusion: "FAILURE" })]
    });
    expect(result.annotations).toEqual([]);
    expect(result.providerPageLimited).toBe(false);
    expect(http.calls.map((call) => call.path)).toEqual([
      "/repos/2ndworld/kodeGPT/actions/runs/10",
      "/repos/2ndworld/kodeGPT/actions/runs/10/jobs"
    ]);
  });

  it("signals job and step hard bounds instead of silently dropping provider data", async () => {
    const http = new FakeHttp();
    const manySteps = Array.from({ length: 101 }, (_, index) => ({
      number: index + 1,
      name: `step-${index + 1}`,
      status: "completed",
      conclusion: "success",
      started_at: "2026-08-16T01:00:03Z",
      completed_at: "2026-08-16T01:00:04Z"
    }));
    const manyJobs = Array.from({ length: 101 }, (_, index) =>
      jobFixture({ id: index + 20, steps: index === 0 ? manySteps : [] })
    );
    http.responses.push(runFixture(), { total_count: 101, jobs: manyJobs });
    const adapter = new GitHubRemoteCiAdapter({ http });
    const result = await adapter.run({ repository: REPOSITORY, runId: "10" });

    expect(result.jobs).toHaveLength(100);
    expect(result.jobs[0]?.steps).toHaveLength(100);
    expect(result.jobLimitReached).toBe(true);
    expect(result.stepLimitReached).toBe(true);
    expect(result.providerPageLimited).toBe(false);
  });

  it("rejects provider job metadata that belongs to a different run", async () => {
    const http = new FakeHttp();
    http.responses.push(runFixture(), { total_count: 1, jobs: [jobFixture({ run_id: 999 })] });
    const adapter = new GitHubRemoteCiAdapter({ http });
    await expectCode(adapter.run({ repository: REPOSITORY, runId: "10" }), "CI_RESPONSE_INVALID");
  });

  it("rejects unsafe provider IDs instead of rounding them", async () => {
    const http = new FakeHttp();
    http.responses.push(runFixture({ id: Number.MAX_SAFE_INTEGER + 2 }));
    const adapter = new GitHubRemoteCiAdapter({ http });
    await expectCode(adapter.run({ repository: REPOSITORY, runId: "10" }), "CI_RESPONSE_INVALID");
  });

  it("uses only the fixed selected-job log endpoint", async () => {
    const http = new FakeHttp();
    http.logResult = { bytes: new TextEncoder().encode("bounded evidence"), truncated: true };
    const adapter = new GitHubRemoteCiAdapter({ http });
    await expect(
      adapter.failureLog({ repository: REPOSITORY, jobId: "20", scanMaxBytes: 512 * 1024 })
    ).resolves.toEqual(http.logResult);
    expect(http.calls).toEqual([
      {
        kind: "log",
        path: "/repos/2ndworld/kodeGPT/actions/jobs/20/logs",
        maxBytes: 512 * 1024
      }
    ]);
  });
});
