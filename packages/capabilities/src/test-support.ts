import type { NativeCapabilityDependencies } from "./native-capability-service.js";

export interface TestCapabilityDependencyOverrides {
  workspace?: Partial<NativeCapabilityDependencies["workspace"]>;
  git?: NativeCapabilityDependencies["git"];
  patch?: Partial<NativeCapabilityDependencies["patch"]>;
  verification?: Partial<NativeCapabilityDependencies["verification"]>;
}

function unexpected(name: string): never {
  throw new Error(`Unexpected test capability adapter invocation: ${name}`);
}

export function createTestCapabilityDependencies(
  overrides: TestCapabilityDependencyOverrides = {}
): NativeCapabilityDependencies {
  const defaults: NativeCapabilityDependencies = {
    workspace: {
      inspection: {
        readFile: async () => unexpected("workspace.inspection.readFile"),
        tree: async () => unexpected("workspace.inspection.tree")
      },
      search: {
        search: async () => unexpected("workspace.search.search")
      }
    },
    git: {
      checkpoint: async () => unexpected("git.checkpoint"),
      checkpointPatch: async () => unexpected("git.checkpointPatch")
    },
    patch: {
      workspace: {
        readFile: async () => unexpected("patch.workspace.readFile"),
        pathIdentity: async () => unexpected("patch.workspace.pathIdentity")
      },
      commit: {
        commitPatchFile: async () => unexpected("patch.commit.commitPatchFile")
      }
    },
    verification: {
      workspace: {
        readFile: async () => unexpected("verification.workspace.readFile"),
        tree: async () => unexpected("verification.workspace.tree"),
        pathIdentity: async () => unexpected("verification.workspace.pathIdentity"),
        effectivePolicy: () => unexpected("verification.workspace.effectivePolicy")
      },
      availability: {
        inspectExecutable: async () => unexpected("verification.availability.inspectExecutable")
      },
      execution: {
        run: async () => unexpected("verification.execution.run")
      }
    }
  };

  return {
    workspace: {
      ...defaults.workspace,
      ...overrides.workspace
    },
    git: overrides.git ?? defaults.git,
    patch: {
      ...defaults.patch,
      ...overrides.patch
    },
    verification: {
      ...defaults.verification,
      ...overrides.verification
    }
  };
}
