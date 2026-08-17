import { describe, expect, it } from "vitest";

import {
  ProfileEscalationError,
  getProfilePreset,
  profilePolicySchema,
  resolveProfile
} from "./index.js";

describe("monotonic project profile resolution", () => {
  it("exposes bash and sh only through the built-in trusted preset", () => {
    const trusted = getProfilePreset("trusted");
    const develop = getProfilePreset("develop");
    const observe = getProfilePreset("observe");

    expect(trusted.allowedExecutableNames).toEqual(expect.arrayContaining(["bash", "sh"]));
    for (const shell of ["bash", "sh"]) {
      expect(develop.allowedExecutableNames).not.toContain(shell);
      expect(observe.allowedExecutableNames).not.toContain(shell);
    }
  });

  it("rejects a trusted/write/process request above an observe ceiling", () => {
    const ceiling = getProfilePreset("observe");
    const requested = profilePolicySchema.parse({
      name: "trusted",
      allowWrite: true,
      allowProcess: true,
      network: "unrestricted",
      allowedExecutableNames: ["python3"],
      inheritEnv: false,
      envAllowlist: []
    });

    expect(() => resolveProfile(ceiling, requested)).toThrowError(ProfileEscalationError);
  });

  it("accepts a develop restriction that disables writes and cannot later widen", () => {
    const ceiling = getProfilePreset("develop");
    const narrowed = resolveProfile(ceiling, {
      ...ceiling,
      allowWrite: false
    });

    expect(narrowed.allowWrite).toBe(false);
    expect(() =>
      resolveProfile(narrowed, {
        ...narrowed,
        allowWrite: true
      })
    ).toThrowError(ProfileEscalationError);
  });

  it("rejects inheritEnv=true and unknown policy fields", () => {
    expect(() =>
      profilePolicySchema.parse({
        ...getProfilePreset("observe"),
        inheritEnv: true
      })
    ).toThrow();
    expect(() =>
      profilePolicySchema.parse({
        ...getProfilePreset("observe"),
        shell: "/bin/sh"
      })
    ).toThrow();
  });

  it("requires executable and environment allowlists to narrow by subset", () => {
    const ceiling = getProfilePreset("develop");
    const narrowed = resolveProfile(ceiling, {
      ...ceiling,
      allowedExecutableNames: ["python3"],
      envAllowlist: ["LANG"]
    });

    expect(narrowed.allowedExecutableNames).toEqual(["python3"]);
    expect(narrowed.envAllowlist).toEqual(["LANG"]);
    expect(() =>
      resolveProfile(narrowed, {
        ...narrowed,
        allowedExecutableNames: ["python3", "node"]
      })
    ).toThrowError(ProfileEscalationError);
  });
});
