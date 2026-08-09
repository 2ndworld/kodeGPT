import { describe, expect, it } from "vitest";

import {
  HttpTrustError,
  createHttpTrustConfig,
  enforceHttpRequestTrust
} from "./http-trust.js";

const config = createHttpTrustConfig({
  allowedHosts: ["127.0.0.1:43121", "localhost:43121"],
  allowedOriginHosts: ["127.0.0.1:43121", "localhost:43121"],
  publicUrl: "https://kodegpt.example.test/connector",
  maxRequestBodyBytes: 1024
});

describe("HTTP trust guard", () => {
  it("derives one normalized trust source including the optional public URL host", () => {
    expect(config.allowedHosts).toEqual([
      "127.0.0.1:43121",
      "kodegpt.example.test",
      "localhost:43121"
    ]);
    expect(config.allowedOriginHosts).toEqual([
      "127.0.0.1:43121",
      "kodegpt.example.test",
      "localhost:43121"
    ]);
    expect(config.publicUrl).toBe("https://kodegpt.example.test/connector");
  });

  it.each([
    [
      "missing host",
      { host: undefined, origin: undefined, contentType: "application/json", contentLength: "2" },
      "HTTP_HOST_REQUIRED",
      400
    ],
    [
      "untrusted host",
      { host: "evil.example.test", origin: undefined, contentType: "application/json", contentLength: "2" },
      "HTTP_HOST_REJECTED",
      421
    ],
    [
      "untrusted origin",
      {
        host: "localhost:43121",
        origin: "https://evil.example.test",
        contentType: "application/json",
        contentLength: "2"
      },
      "HTTP_ORIGIN_REJECTED",
      403
    ],
    [
      "non json content type",
      { host: "localhost:43121", origin: undefined, contentType: "text/plain", contentLength: "2" },
      "HTTP_CONTENT_TYPE_UNSUPPORTED",
      415
    ],
    [
      "oversized declared body",
      {
        host: "localhost:43121",
        origin: undefined,
        contentType: "application/json",
        contentLength: "1025"
      },
      "HTTP_BODY_TOO_LARGE",
      413
    ]
  ])("rejects %s before downstream dispatch", (_label, request, code, status) => {
    expect(() => enforceHttpRequestTrust(config, { ...request, actualBodyBytes: 2 })).toThrowError(
      expect.objectContaining<Partial<HttpTrustError>>({ code, status })
    );
  });

  it("rejects non-canonical numeric aliases of otherwise allowed authorities", () => {
    for (const host of ["2130706433:43121", "127.1:43121"]) {
      expect(() =>
        enforceHttpRequestTrust(config, {
          host,
          origin: undefined,
          contentType: "application/json",
          contentLength: "2",
          actualBodyBytes: 2
        })
      ).toThrowError(expect.objectContaining({ code: "HTTP_HOST_REJECTED", status: 421 }));
    }

    expect(() =>
      enforceHttpRequestTrust(config, {
        host: "localhost:43121",
        origin: "http://2130706433:43121",
        contentType: "application/json",
        contentLength: "2",
        actualBodyBytes: 2
      })
    ).toThrowError(expect.objectContaining({ code: "HTTP_ORIGIN_REJECTED", status: 403 }));
  });

  it("accepts trusted host/origin, JSON with parameters, and bounded body length", () => {
    expect(() =>
      enforceHttpRequestTrust(config, {
        host: "LOCALHOST:43121",
        origin: "https://kodegpt.example.test",
        contentType: "Application/JSON; charset=utf-8",
        contentLength: "12",
        actualBodyBytes: 12
      })
    ).not.toThrow();
  });

  it("rejects malformed length and actual bytes above the configured ceiling", () => {
    expect(() =>
      enforceHttpRequestTrust(config, {
        host: "localhost:43121",
        origin: undefined,
        contentType: "application/json",
        contentLength: "not-a-number",
        actualBodyBytes: 0
      })
    ).toThrowError(expect.objectContaining({ code: "HTTP_CONTENT_LENGTH_INVALID", status: 400 }));

    expect(() =>
      enforceHttpRequestTrust(config, {
        host: "localhost:43121",
        origin: undefined,
        contentType: "application/json",
        contentLength: undefined,
        actualBodyBytes: 1025
      })
    ).toThrowError(expect.objectContaining({ code: "HTTP_BODY_TOO_LARGE", status: 413 }));
  });
});
