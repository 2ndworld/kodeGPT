import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function source(relativePath: string): Promise<string> {
  const url = new URL(`../../${relativePath}`, import.meta.url);
  return readFile(fileURLToPath(url), "utf8");
}

describe("sandbox boundary source regressions", () => {
  it("resolves Bubblewrap only from fixed trusted locations and revalidates identity", async () => {
    const executable = await source("crates/sandbox/src/executable.rs");

    expect(executable).toContain('"/usr/local/bin"');
    expect(executable).toContain('"/usr/bin"');
    expect(executable).toContain('"/bin"');
    expect(executable).toContain("pub fn resolve_trusted_executable");
    expect(executable).toContain("canonical_path");
    expect(executable).toContain("device");
    expect(executable).toContain("inode");
    expect(executable).toContain("mode");
    expect(executable).toContain("uid");
    expect(executable).toContain("revalidate");
    expect(executable).toContain("PROCESS_SPAWN_LOCK");
    expect(executable).not.toContain('std::env::var("PATH")');
    expect(executable).not.toContain("var_os(\"PATH\")");
  });

  it("locks hardened Bubblewrap flags and fd-backed workspace binding", async () => {
    const bubblewrap = await source("crates/sandbox/src/bubblewrap.rs");

    for (const required of [
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--disable-userns",
      "--assert-userns-disabled",
      "--new-session",
      "--die-with-parent",
      "--clearenv",
      "--cap-drop",
      "--bind-fd",
      "--ro-bind-fd",
      "--unshare-net"
    ]) {
      expect(bubblewrap).toContain(required);
    }

    expect(bubblewrap).not.toContain("--not-a-security-boundary");
    expect(bubblewrap).not.toContain(".process_group(0)");
    expect(bubblewrap).toContain("NETWORK_POLICY_UNAVAILABLE");
    expect(bubblewrap).toContain("PROCESS_SPAWN_LOCK");
    expect(bubblewrap).toContain("program: TrustedExecutable");
    expect(bubblewrap).toContain("spec.program.revalidate()");
    expect(bubblewrap).toContain("FdFlags::empty()");
    expect(bubblewrap).toContain("/workspace");
    expect(bubblewrap).toContain("/home/kodegpt");
  });

  it("makes ENFORCED sandbox capability probe-derived only", async () => {
    const capabilities = await source("crates/sandbox/src/capabilities.rs");

    expect(capabilities).not.toContain("pub enforcement:");
    expect(capabilities).toContain("pub fn enforcement(");
    expect(capabilities).toContain("probe_sandbox_capabilities");
  });

  it("keeps retained workspace descriptors private and execution identities opaque", async () => {
    const registry = await source("crates/workspace-io/src/registry.rs");
    const execution = await source("crates/runtime/src/execution.rs");

    expect(registry).toContain("duplicate_ready_root_fd");
    expect(execution).toContain('format!("ex_');
    expect(execution).toContain("workspace_capability");
    expect(execution).toContain("process_group");
    expect(execution).toContain("started_at");
    expect(execution).toContain("kind");
  });
});
