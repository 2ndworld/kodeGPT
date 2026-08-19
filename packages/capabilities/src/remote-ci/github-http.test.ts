import { describe, expect, it } from "vitest";

import { MAX_CI_PROVIDER_METADATA_BYTES } from "./contracts.js";
import { GitHubHttp } from "./github-http.js";

const FAKE_CREDENTIAL = "[REDACTED]";

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(responses: Response[]) {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const response = responses.shift();
    if (response === undefined) throw new Error("unexpected fetch");
    return response;
  };
  return { calls, fetchImpl };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ name: "CapabilityError", code });
}

describe("GitHubHttp", () => {
  it("uses only GET against api.github.com with fixed authenticated metadata headers", async () => {
    const fake = fakeFetch([
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    ]);
    const http = new GitHubHttp({ credential: FAKE_CREDENTIAL, fetchImpl: fake.fetchImpl });

    await expect(http.getJson<{ ok: boolean }>("/repos/owner/repository")).resolves.toEqual({ ok: true });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe("https://api.github.com/repos/owner/repository");
    expect(fake.calls[0]?.init.method).toBe("GET");
    expect(fake.calls[0]?.init.redirect).toBe("manual");
    const headers = new Headers(fake.calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${FAKE_CREDENTIAL}`);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("user-agent")).toBe("KodeGPT/0.1 Remote-CI");
    expect(headers.get("x-github-api-version")).toBeTruthy();
  });

  it("bounds metadata before JSON parsing and rejects malformed JSON", async () => {
    const oversized = JSON.stringify({ value: "x".repeat(MAX_CI_PROVIDER_METADATA_BYTES) });
    const fake = fakeFetch([
      new Response(oversized, { status: 200 }),
      new Response("{not-json", { status: 200 })
    ]);
    const http = new GitHubHttp({ credential: FAKE_CREDENTIAL, fetchImpl: fake.fetchImpl });

    await expectCode(http.getJson("/repos/owner/repository"), "CI_RESPONSE_LIMIT_EXCEEDED");
    await expectCode(http.getJson("/repos/owner/repository"), "CI_RESPONSE_INVALID");
  });

  it.each([
    [401, "CI_AUTH_FAILED"],
    [403, "CI_PERMISSION_DENIED"],
    [404, "CI_NOT_FOUND"],
    [500, "CI_PROVIDER_UNAVAILABLE"]
  ] as const)("maps HTTP %i to %s", async (status, code) => {
    const fake = fakeFetch([new Response("provider detail must not leak", { status })]);
    const http = new GitHubHttp({ credential: FAKE_CREDENTIAL, fetchImpl: fake.fetchImpl });
    await expectCode(http.getJson("/repos/owner/repository"), code);
  });

  it("marks HTTP 401 as requiring fresh authentication", async () => {
    const fake = fakeFetch([new Response("provider detail must not leak", { status: 401 })]);
    const http = new GitHubHttp({ credential: FAKE_CREDENTIAL, fetchImpl: fake.fetchImpl });
    await expect(http.getJson("/repos/owner/repository")).rejects.toMatchObject({
      code: "CI_AUTH_FAILED",
      details: {
        reason: "AUTHENTICATION_REQUIRED",
        retryable: false,
        suggestedAction: "authenticate"
      }
    });
  });

  it("maps rate limits to bounded safe details only", async () => {
    const fake = fakeFetch([
      new Response("rate detail", {
        status: 429,
        headers: {
          "retry-after": "30",
          "x-ratelimit-reset": "1786856400"
        }
      }),
      new Response("rate detail", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1786856400"
        }
      })
    ]);
    const http = new GitHubHttp({ credential: FAKE_CREDENTIAL, fetchImpl: fake.fetchImpl });

    await expect(http.getJson("/repos/owner/repository")).rejects.toMatchObject({
      code: "CI_RATE_LIMITED",
      details: {
        retryAfter: 30,
        resetAt: expect.stringMatching(/^2026-/),
        reason: "RATE_LIMITED",
        retryable: true,
        suggestedAction: "retry"
      }
    });
    await expect(http.getJson("/repos/owner/repository")).rejects.toMatchObject({
      code: "CI_RATE_LIMITED",
      details: {
        resetAt: expect.stringMatching(/^2026-/),
        reason: "RATE_LIMITED",
        retryable: true,
        suggestedAction: "retry"
      }
    });
  });

  it("rejects metadata redirects instead of forwarding credentials cross-origin", async () => {
    const fake = fakeFetch([
      new Response(null, { status: 302, headers: { location: "https://example.invalid/elsewhere" } })
    ]);
    const http = new GitHubHttp({ credential: FAKE_CREDENTIAL, fetchImpl: fake.fetchImpl });
    await expectCode(http.getJson("/repos/owner/repository"), "CI_RESPONSE_INVALID");
    expect(fake.calls).toHaveLength(1);
  });

  it("follows one validated log redirect without forwarding authorization", async () => {
    const fake = fakeFetch([
      new Response(null, {
        status: 302,
        headers: {
          location: "https://pipelines.actions.githubusercontent.com/0123456789abcdef/log.txt?sig=fixture"
        }
      }),
      new Response("failure evidence\n", { status: 200 })
    ]);
    const http = new GitHubHttp({ credential: FAKE_CREDENTIAL, fetchImpl: fake.fetchImpl });

    const result = await http.getJobLog("/repos/owner/repository/actions/jobs/123/logs", 512 * 1024);
    expect(new TextDecoder().decode(result.bytes)).toBe("failure evidence\n");
    expect(result.truncated).toBe(false);
    expect(fake.calls).toHaveLength(2);
    expect(new Headers(fake.calls[0]?.init.headers).has("authorization")).toBe(true);
    expect(new Headers(fake.calls[1]?.init.headers).has("authorization")).toBe(false);
    expect(fake.calls[1]?.init.method).toBe("GET");
    expect(fake.calls[1]?.init.redirect).toBe("manual");
  });

  it("rejects a second provider-issued log redirect", async () => {
    const fake = fakeFetch([
      new Response(null, {
        status: 302,
        headers: { location: "https://pipelines.actions.githubusercontent.com/first/log.txt?sig=fixture" }
      }),
      new Response(null, {
        status: 302,
        headers: { location: "https://pipelines.actions.githubusercontent.com/second/log.txt?sig=fixture" }
      })
    ]);
    const http = new GitHubHttp({ credential: FAKE_CREDENTIAL, fetchImpl: fake.fetchImpl });
    await expectCode(
      http.getJobLog("/repos/owner/repository/actions/jobs/123/logs", 512 * 1024),
      "CI_LOG_UNAVAILABLE"
    );
    expect(fake.calls).toHaveLength(2);
  });

  it.each([
    "http://pipelines.actions.githubusercontent.com/log.txt",
    "https://user@pipelines.actions.githubusercontent.com/log.txt",
    "https://example.invalid/log.txt"
  ])("rejects unsafe log redirect %s", async (location) => {
    const fake = fakeFetch([new Response(null, { status: 302, headers: { location } })]);
    const http = new GitHubHttp({ credential: FAKE_CREDENTIAL, fetchImpl: fake.fetchImpl });
    await expectCode(
      http.getJobLog("/repos/owner/repository/actions/jobs/123/logs", 512 * 1024),
      "CI_LOG_UNAVAILABLE"
    );
    expect(fake.calls).toHaveLength(1);
  });

  it("stops retaining streamed logs after scanMaxBytes and signals truncation", async () => {
    const fake = fakeFetch([
      new Response(null, {
        status: 302,
        headers: {
          location: "https://pipelines.actions.githubusercontent.com/fixture/log.txt?sig=fixture"
        }
      }),
      new Response("abcdef", { status: 200 })
    ]);
    const http = new GitHubHttp({ credential: FAKE_CREDENTIAL, fetchImpl: fake.fetchImpl });
    const result = await http.getJobLog("/repos/owner/repository/actions/jobs/123/logs", 4);
    expect(new TextDecoder().decode(result.bytes)).toBe("abcd");
    expect(result.truncated).toBe(true);
  });

  it("sends one authenticated mutation request and never retries an ambiguous outcome", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      throw new Error("connection reset after request write");
    };
    const http = new GitHubHttp({ credential: FAKE_CREDENTIAL, fetchImpl }) as GitHubHttp & {
      postMutation(path: string, expectedStatus: 200 | 201 | 202, body?: Record<string, unknown>): Promise<void>;
    };

    await expect(http.postMutation("/repos/owner/repository/actions/runs/123/rerun", 201)).rejects.toMatchObject({
      code: "CI_MUTATION_OUTCOME_UNKNOWN",
      details: {
        reason: "MUTATION_OUTCOME_UNKNOWN",
        retryable: false,
        suggestedAction: "refresh-state"
      }
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/owner/repository/actions/runs/123/rerun");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${FAKE_CREDENTIAL}`);
  });

  it("classifies the allowlisted GitHub Actions already-running 403 as a mutation state conflict without retrying", async () => {
    const providerBody = JSON.stringify({
      message: "This workflow is already running",
      documentation_url: "https://docs.github.com/rest/actions/workflow-runs#re-run-a-workflow",
      status: "403"
    });
    const fake = fakeFetch([new Response(providerBody, { status: 403 })]);
    const http = new GitHubHttp({ credential: FAKE_CREDENTIAL, fetchImpl: fake.fetchImpl });

    await expect(
      http.postMutation("/repos/owner/repository/actions/runs/123/rerun", 201)
    ).rejects.toMatchObject({
      code: "CI_MUTATION_STATE_CONFLICT",
      message: "GitHub mutation state changed; refresh current CI state before retrying",
      details: {
        reason: "STALE_EXPECTED_STATE",
        retryable: false,
        suggestedAction: "refresh-state"
      }
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("keeps mutation rate-limit 403 classification unchanged and single-attempt", async () => {
    const fake = fakeFetch([
      new Response(JSON.stringify({ message: "rate limit detail must not leak" }), {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1786856400"
        }
      })
    ]);
    const http = new GitHubHttp({ credential: FAKE_CREDENTIAL, fetchImpl: fake.fetchImpl });

    await expect(
      http.postMutation("/repos/owner/repository/actions/runs/123/rerun", 201)
    ).rejects.toMatchObject({
      code: "CI_RATE_LIMITED",
      message: "GitHub rate limit was reached",
      details: {
        reason: "RATE_LIMITED",
        retryable: true,
        suggestedAction: "retry"
      }
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("keeps unknown, malformed, and oversized mutation 403 bodies permission-denied and sanitized", async () => {
    const providerSecret = "provider-secret-must-not-leak";
    const fake = fakeFetch([
      new Response(JSON.stringify({ message: providerSecret }), { status: 403 }),
      new Response("{not-json", { status: 403 }),
      new Response(JSON.stringify({ message: "x".repeat(5000), secret: providerSecret }), { status: 403 })
    ]);
    const http = new GitHubHttp({ credential: FAKE_CREDENTIAL, fetchImpl: fake.fetchImpl });

    for (let index = 0; index < 3; index += 1) {
      const promise = http.postMutation("/repos/owner/repository/actions/runs/123/rerun", 201);
      await expect(promise).rejects.toMatchObject({
        code: "CI_PERMISSION_DENIED",
        message: "GitHub permission was denied"
      });
      await expect(promise).rejects.not.toMatchObject({ message: expect.stringContaining(providerSecret) });
    }
    expect(fake.calls).toHaveLength(3);
  });

  it("accepts only the expected definitive mutation status and sends bounded JSON when present", async () => {
    const fake = fakeFetch([new Response(JSON.stringify({ workflow_run_id: 1 }), { status: 200 })]);
    const http = new GitHubHttp({ credential: FAKE_CREDENTIAL, fetchImpl: fake.fetchImpl }) as GitHubHttp & {
      postMutation(path: string, expectedStatus: 200 | 201 | 202, body?: Record<string, unknown>): Promise<void>;
    };

    await expect(
      http.postMutation("/repos/owner/repository/actions/workflows/ci.yml/dispatches", 200, {
        ref: "main",
        inputs: { target: "smoke" }
      })
    ).resolves.toBeUndefined();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.init.body).toBe(JSON.stringify({ ref: "main", inputs: { target: "smoke" } }));
    expect(new Headers(fake.calls[0]?.init.headers).get("content-type")).toBe("application/json");
  });

  it("maps fetch failures to sanitized provider errors", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("network provider detail must not surface");
    };
    const http = new GitHubHttp({ credential: FAKE_CREDENTIAL, fetchImpl });
    await expect(http.getJson("/repos/owner/repository")).rejects.toMatchObject({
      code: "CI_PROVIDER_UNAVAILABLE",
      message: "GitHub provider is unavailable"
    });
  });

  it("rejects non-relative and control-bearing internal paths", async () => {
    const http = new GitHubHttp({ credential: FAKE_CREDENTIAL, fetchImpl: fakeFetch([]).fetchImpl });
    for (const path of ["https://example.invalid/api", "//example.invalid/api", "/repos/owner/repository\nextra"]) {
      await expectCode(http.getJson(path), "CI_RESPONSE_INVALID");
    }
  });
});
