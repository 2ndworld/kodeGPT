import { BlockList, isIP } from "node:net";

import { CapabilityError } from "../errors.js";

const DENIED_PROVIDER_ADDRESSES = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) {
  DENIED_PROVIDER_ADDRESSES.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8]
] as const) {
  DENIED_PROVIDER_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

export interface ProviderResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export function assertProviderInternetAddressAllowed(input: ProviderResolvedAddress): void {
  const actualFamily = isIP(input.address);
  if (actualFamily !== input.family) {
    throw denied("Provider DNS returned an invalid address");
  }
  if (input.family === 6 && input.address.toLowerCase().startsWith("::ffff:")) {
    throw denied("Provider DNS resolved to a denied IPv4-mapped IPv6 address");
  }
  const type = input.family === 4 ? "ipv4" : "ipv6";
  if (DENIED_PROVIDER_ADDRESSES.check(input.address, type)) {
    throw denied("Provider DNS resolved to a denied address class");
  }
}

export function selectProviderInternetAddress(
  addresses: readonly ProviderResolvedAddress[]
): ProviderResolvedAddress {
  if (addresses.length === 0) throw denied("Provider DNS returned no addresses");
  for (const address of addresses) {
    assertProviderInternetAddressAllowed(address);
  }
  const selected = addresses.find((answer) => answer.family === 4) ?? addresses[0];
  if (selected === undefined) throw denied("Provider DNS returned no usable address");
  return selected;
}

function denied(message: string): CapabilityError {
  return new CapabilityError("PROVIDER_NETWORK_DENIED", message);
}
