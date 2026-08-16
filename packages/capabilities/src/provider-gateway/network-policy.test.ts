import { describe, expect, it } from "vitest";

import { assertProviderInternetAddressAllowed } from "./network-policy.js";

describe("provider Internet address policy", () => {
  it.each([
    ["0.0.0.0", 4],
    ["10.1.2.3", 4],
    ["100.64.0.1", 4],
    ["127.0.0.1", 4],
    ["169.254.1.1", 4],
    ["172.16.0.1", 4],
    ["192.168.1.1", 4],
    ["224.0.0.1", 4],
    ["255.255.255.255", 4],
    ["::", 6],
    ["::1", 6],
    ["fc00::1", 6],
    ["fd12::1", 6],
    ["fe80::1", 6],
    ["ff02::1", 6],
    ["::ffff:127.0.0.1", 6]
  ] as const)("rejects non-public address %s", (address, family) => {
    expect(() => assertProviderInternetAddressAllowed({ address, family })).toThrowError(/denied/i);
  });

  it.each([
    ["8.8.8.8", 4],
    ["203.0.113.10", 4],
    ["1.1.1.1", 4],
    ["2001:4860:4860::8888", 6],
    ["2001:db8::10", 6]
  ] as const)("allows an address outside the denied Internet classes: %s", (address, family) => {
    expect(() => assertProviderInternetAddressAllowed({ address, family })).not.toThrow();
  });

  it("rejects invalid family/address combinations", () => {
    expect(() => assertProviderInternetAddressAllowed({ address: "not-an-ip", family: 4 })).toThrow();
    expect(() => assertProviderInternetAddressAllowed({ address: "8.8.8.8", family: 6 })).toThrow();
  });
});
