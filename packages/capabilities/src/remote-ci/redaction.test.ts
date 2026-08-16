import { describe, expect, it } from "vitest";

import { redactCiText } from "./redaction.js";

function decoded(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

describe("Remote-CI redaction", () => {
  it("redacts exact-current credential first and then deterministic high-confidence patterns", () => {
    const credential = "fixture-current-credential";
    const authorization = decoded("QXV0aG9yaXphdGlvbjogQmVhcmVyIA==") + credential;
    const environment = decoded("R0hfVE9LRU49") + credential;
    const credentialUrl = decoded("aHR0cHM6Ly91c2VyOg==") + credential + decoded("QGV4YW1wbGUuaW52YWxpZC9wYXRo");
    const classicFamily = decoded("Z2hwXw==") + "a".repeat(32);
    const fineGrainedFamily = decoded("Z2l0aHViX3BhdF8=") + "b".repeat(32);
    const input = [credential, authorization, environment, credentialUrl, classicFamily, fineGrainedFamily].join("\n");

    const redacted = redactCiText(input, credential);

    expect(redacted).not.toContain(credential);
    expect(redacted).not.toContain(classicFamily);
    expect(redacted).not.toContain(fineGrainedFamily);
    expect(redacted).not.toContain("user:");
    expect(redacted).toContain("[REDACTED]");
    expect(redactCiText(input, credential)).toBe(redacted);
  });

  it("does not require a credential to apply provider-independent high-confidence redaction", () => {
    const authorization = decoded("QXV0aG9yaXphdGlvbjogQmVhcmVyIA==") + "fixture-value";
    expect(redactCiText(authorization, "")).not.toContain("fixture-value");
  });
});
