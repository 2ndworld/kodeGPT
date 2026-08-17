import type { ProfileName, ProfilePolicy } from "./schema.js";

export function getProfilePreset(name: ProfileName): ProfilePolicy {
  switch (name) {
    case "observe":
      return {
        name: "observe",
        allowWrite: false,
        allowProcess: false,
        network: "deny",
        allowedExecutableNames: [],
        inheritEnv: false,
        envAllowlist: []
      };
    case "develop":
      return {
        name: "develop",
        allowWrite: true,
        allowProcess: true,
        network: "deny",
        allowedExecutableNames: ["cargo", "node", "python3", "rustc"],
        inheritEnv: false,
        envAllowlist: ["CI", "LANG", "LC_ALL", "TERM"]
      };
    case "trusted":
      return {
        name: "trusted",
        allowWrite: true,
        allowProcess: true,
        network: "unrestricted",
        allowedExecutableNames: [
          "bash",
          "cargo",
          "node",
          "npm",
          "npx",
          "pnpm",
          "python3",
          "rustc",
          "sh"
        ],
        inheritEnv: false,
        envAllowlist: ["CI", "LANG", "LC_ALL", "TERM"]
      };
  }
}
