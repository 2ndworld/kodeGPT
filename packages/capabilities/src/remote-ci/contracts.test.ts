import { describe, expect, it } from "vitest";
import { NATIVE_CAPABILITY_IDS } from "../contracts.js";
import { CapabilityError, toPublicCapabilityError } from "../errors.js";
import {
  CI_REQUEST_BUDGETS,
  CI_TRUNCATION_REASONS,
  MAX_CI_ANNOTATIONS,
  MAX_CI_JOB_STEPS,
  MAX_CI_PROVIDER_METADATA_BYTES,
  MAX_CI_RESPONSE_BYTES,
  MAX_CI_RUN_JOBS,
  MAX_CI_STATUS_FAILURE_SUMMARIES,
  MAX_CI_STATUS_SUMMARIES
} from "./contracts.js";
import * as remoteCiSchemas from "./schemas.js";
import {
  CiFailureInputSchema,
  CiRepositoryInputSchema,
  CiRunInputSchema,
  CiRunsInputSchema,
  CiStatusInputSchema,
  MAX_CI_RUNS_LIMIT
} from "./schemas.js";

describe("Remote-CI v1 public contracts", () => {
  it("adds exactly the eight approved native CI capability ids", () => {
    expect(NATIVE_CAPABILITY_IDS.filter((id) => id.startsWith("ci."))).toEqual([
      "ci.repository",
      "ci.status",
      "ci.runs",
      "ci.run",
      "ci.failure",
      "ci.rerun",
      "ci.cancel",
      "ci.dispatch"
    ]);
  });

  it("defines strict bounded typed schemas for rerun, cancel, and workflow dispatch only", () => {
    const schemas = remoteCiSchemas as unknown as Record<string, { parse(input: unknown): unknown } | undefined>;
    expect(schemas.CiRerunInputSchema).toBeDefined();
    expect(schemas.CiCancelInputSchema).toBeDefined();
    expect(schemas.CiDispatchInputSchema).toBeDefined();
    expect(schemas.CiMutationResultSchema).toBeDefined();

    expect(schemas.CiRerunInputSchema?.parse({ runId: "123", failedOnly: true })).toEqual({
      runId: "123",
      failedOnly: true
    });
    expect(schemas.CiCancelInputSchema?.parse({ runId: "123" })).toEqual({ runId: "123" });
    expect(schemas.CiDispatchInputSchema?.parse({
      workflow: "ci.yml",
      ref: "main",
      inputs: { target: "smoke" }
    })).toEqual({ workflow: "ci.yml", ref: "main", inputs: { target: "smoke" } });

    expect(() => schemas.CiRerunInputSchema?.parse({ runId: "123", method: "POST" })).toThrow();
    expect(() => schemas.CiCancelInputSchema?.parse({ runId: "123", url: "https://example.invalid" })).toThrow();
    expect(() => schemas.CiDispatchInputSchema?.parse({ workflow: "ci.yml", ref: "main", headers: {} })).toThrow();
  });

  it("rejects repository/provider/url/page override fields", () => {
    expect(() => CiStatusInputSchema.parse({ owner: "x" })).toThrow();
    expect(() => CiRunsInputSchema.parse({ repository: "y" })).toThrow();
    expect(() => CiRunInputSchema.parse({ runId: "1", provider: "github" })).toThrow();
    expect(() => CiFailureInputSchema.parse({ runId: "1", url: "https://example.invalid" })).toThrow();
    expect(() => CiRepositoryInputSchema.parse({ page: 2 })).toThrow();
  });

  it("uses decimal-string ids and a hard 50-run limit", () => {
    expect(CiRunInputSchema.parse({ runId: "90071992547409931234" }).runId).toBe("90071992547409931234");
    expect(() => CiRunInputSchema.parse({ runId: "1e3" })).toThrow();
    expect(() => CiRunInputSchema.parse({ runId: " 1" })).toThrow();
    expect(() => CiRunsInputSchema.parse({ limit: MAX_CI_RUNS_LIMIT + 1 })).toThrow();
  });

  it("freezes the approved bounds, budgets, and truncation vocabulary", () => {
    expect({
      MAX_CI_STATUS_SUMMARIES,
      MAX_CI_STATUS_FAILURE_SUMMARIES,
      MAX_CI_RUN_JOBS,
      MAX_CI_JOB_STEPS,
      MAX_CI_ANNOTATIONS,
      MAX_CI_RESPONSE_BYTES,
      MAX_CI_PROVIDER_METADATA_BYTES
    }).toEqual({
      MAX_CI_STATUS_SUMMARIES: 50,
      MAX_CI_STATUS_FAILURE_SUMMARIES: 20,
      MAX_CI_RUN_JOBS: 100,
      MAX_CI_JOB_STEPS: 100,
      MAX_CI_ANNOTATIONS: 100,
      MAX_CI_RESPONSE_BYTES: 512 * 1024,
      MAX_CI_PROVIDER_METADATA_BYTES: 1024 * 1024
    });
    expect(CI_REQUEST_BUDGETS).toEqual({
      repository: 1,
      status: 6,
      runs: 1,
      run: 2,
      failure: 5,
      rerun: 1,
      cancel: 1,
      dispatch: 1
    });
    expect(CI_TRUNCATION_REASONS).toEqual([
      "SUMMARY_LIMIT",
      "RUN_LIMIT",
      "JOB_LIMIT",
      "STEP_LIMIT",
      "ANNOTATION_LIMIT",
      "LOG_BYTE_LIMIT",
      "PROVIDER_PAGE_LIMIT",
      "RESPONSE_LIMIT"
    ]);
  });

  it("sanitizes CI rate-limit details as a closed safe shape", () => {
    expect(toPublicCapabilityError(new CapabilityError("CI_RATE_LIMITED", "Rate limited", {
      retryAfter: 30,
      resetAt: "2026-08-16T05:00:00.000Z"
    }))).toEqual({
      code: "CI_RATE_LIMITED",
      message: "Rate limited",
      details: { retryAfter: 30, resetAt: "2026-08-16T05:00:00.000Z" }
    });

    expect(toPublicCapabilityError(new CapabilityError("CI_RATE_LIMITED", "Rate limited", {
      retryAfter: -1,
      resetAt: "not-a-date"
    }))).toEqual({ code: "CI_RATE_LIMITED", message: "Rate limited" });
  });
});
