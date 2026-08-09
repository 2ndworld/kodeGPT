import { profilePolicySchema, type NetworkMode, type ProfileName, type ProfilePolicy } from "./schema.js";

const PROFILE_RANK: Readonly<Record<ProfileName, number>> = {
  observe: 0,
  develop: 1,
  trusted: 2
};

const NETWORK_RANK: Readonly<Record<NetworkMode, number>> = {
  deny: 0,
  localhost: 1,
  allowlist: 2,
  unrestricted: 3
};

export class ProfileEscalationError extends Error {
  readonly code = "PROFILE_ESCALATION";

  constructor(message = "Project profile may only narrow the current workspace policy") {
    super(message);
    this.name = "ProfileEscalationError";
  }
}

export function resolveProfile(current: ProfilePolicy, restriction: ProfilePolicy): ProfilePolicy {
  const parsedCurrent = profilePolicySchema.parse(current);
  const parsedRestriction = profilePolicySchema.parse(restriction);

  if (PROFILE_RANK[parsedRestriction.name] > PROFILE_RANK[parsedCurrent.name]) {
    throw new ProfileEscalationError("Project profile name exceeds the current ceiling");
  }
  if (!parsedCurrent.allowWrite && parsedRestriction.allowWrite) {
    throw new ProfileEscalationError("Project profile cannot enable writes");
  }
  if (!parsedCurrent.allowProcess && parsedRestriction.allowProcess) {
    throw new ProfileEscalationError("Project profile cannot enable processes");
  }
  if (NETWORK_RANK[parsedRestriction.network] > NETWORK_RANK[parsedCurrent.network]) {
    throw new ProfileEscalationError("Project profile cannot broaden network access");
  }
  assertSubset(
    parsedRestriction.allowedExecutableNames,
    parsedCurrent.allowedExecutableNames,
    "Project profile cannot add executable names"
  );
  assertSubset(
    parsedRestriction.envAllowlist,
    parsedCurrent.envAllowlist,
    "Project profile cannot add environment variables"
  );

  return {
    ...parsedRestriction,
    allowedExecutableNames: [...new Set(parsedRestriction.allowedExecutableNames)].sort(),
    envAllowlist: [...new Set(parsedRestriction.envAllowlist)].sort()
  };
}

function assertSubset(candidate: readonly string[], ceiling: readonly string[], message: string): void {
  const allowed = new Set(ceiling);
  if (candidate.some((value) => !allowed.has(value))) {
    throw new ProfileEscalationError(message);
  }
}
