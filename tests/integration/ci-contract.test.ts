import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const CI_PATH = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const PACKAGE_PATH = fileURLToPath(new URL("../../package.json", import.meta.url));
const VITEST_CONFIG_PATH = fileURLToPath(new URL("../../vitest.config.ts", import.meta.url));

describe("release CI contract", () => {
  it("pins modern Node-24 actions and the exact toolchain floors", async () => {
    const source = await readFile(CI_PATH, "utf8");
    expect(source).toContain("actions/checkout@v6");
    expect(source).toContain("actions/setup-node@v6");
    expect(source).toContain("node-version: 24");
    expect(source).toContain("corepack prepare pnpm@10.15.0 --activate");
    expect(source).toContain("Harden trusted Node toolchain root");
    expect(source).toContain("sudo chown \"$(id -u):$(id -g)\" \"$node_root\"");
    expect(source).toContain("chmod 0755 \"$node_root\"");
    expect(source).toContain("chmod 0755 \"$pnpm_target\"");
    expect(source).toContain("chmod 0755 \"$node_target\"");
    expect(source).toContain("stat -c '%u:%g:%a' \"$node_root\"");
    expect(source).toContain("rustup toolchain install stable --profile minimal");
    expect(source).toContain("1b80120ef26a28e065e67f89bfef873f13bdd317");
    expect(source).toContain("bubblewrap 0.11.2");
    expect(source).toContain("apparmor-profiles");
    expect(source).toContain("/etc/apparmor.d/bwrap-userns-restrict");
    expect(source).toContain("apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict");
    expect(source).toContain("/usr/bin/bwrap");
    expect(source).toContain("stat -c '%u:%g:%a' /usr/bin/bwrap");
    expect(source).not.toMatch(/apparmor_restrict_unprivileged_userns\s*=\s*0/);
    expect(source).not.toMatch(/sysctl[^\n]*apparmor_restrict_unprivileged_userns[^\n]*0/);
    expect(source).not.toContain("flags=(complain)");
    expect(source).not.toContain("flags=(unconfined)");
    expect(source).not.toMatch(/profile\s+kodegpt_unpriv_bwrap[^{]*\{[^}]*\bcapability,/);
    expect(source).toContain("sudo aa-status");
    expect(source).toContain("profiles are in enforce mode");
    expect(source).toContain("kodegpt_bwrap");
    expect(source).toContain("kodegpt_unpriv_bwrap");
    expect(source).toContain("! unshare -Ur true");
    expect(source).not.toContain("/usr/local/bin/bwrap");
    expect(source).not.toContain("actions/checkout@v4");
    expect(source).not.toContain("actions/setup-node@v4");
    expect(source).not.toContain("pnpm/action-setup");
  });

  it("runs the complete deterministic gate sequence with explicit sandbox probes", async () => {
    const source = await readFile(CI_PATH, "utf8");
    const commands = [
      "pnpm install --frozen-lockfile",
      "cargo fmt --all -- --check",
      "pnpm run typecheck",
      "pnpm test",
      "cargo test -p kodegpt-sandbox",
      "pnpm test:rust",
      "pnpm test:protocol",
      "pnpm test:integration",
      "pnpm test:security",
      "pnpm test:isolation",
      "pnpm test:acceptance",
      "pnpm verify:forbidden",
      "pnpm verify:package"
    ];
    let previous = -1;
    for (const command of commands) {
      const index = source.indexOf(command);
      expect(index, `${command} is missing from CI`).toBeGreaterThan(previous);
      previous = index;
    }
  });

  it("keeps Cargo-heavy tests deterministic on cold runners", async () => {
    const [packageSource, vitestSource] = await Promise.all([
      readFile(PACKAGE_PATH, "utf8"),
      readFile(VITEST_CONFIG_PATH, "utf8")
    ]);
    expect(packageSource).toContain('"test": "vitest run --no-file-parallelism"');
    expect(vitestSource).toMatch(
      /projects:\s*\[[\s\S]*?extends:\s*true[\s\S]*?name:\s*"root-tests"/
    );
    expect(vitestSource).toMatch(/name:\s*"root-tests"[\s\S]*?fileParallelism:\s*false/);
  });
});
