import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

export const RUNTIME_PACKAGE_LINUX_X64 = "@kodegpt/runtime-linux-x64" as const;

export class RuntimeResolutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeResolutionError";
    this.code = code;
  }
}

export async function resolveRuntimePath(options: {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  resolvePackageJson?: (specifier: string) => string;
} = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;

  const override = env.KODEGPT_RUNTIME_PATH;
  if (override !== undefined) {
    if (env.NODE_ENV !== "test" && env.NODE_ENV !== "development") {
      throw new RuntimeResolutionError(
        "RUNTIME_OVERRIDE_FORBIDDEN",
        "KODEGPT_RUNTIME_PATH is supported only in development and tests"
      );
    }
    await requireExecutable(override);
    return override;
  }

  if (platform !== "linux" || arch !== "x64") {
    throw new RuntimeResolutionError(
      "RUNTIME_PLATFORM_UNSUPPORTED",
      `KodeGPT v0.1 has no packaged runtime for ${platform}/${arch}`
    );
  }

  const resolvePackageJson = options.resolvePackageJson ?? defaultResolvePackageJson;
  let packageJson: string;
  try {
    packageJson = resolvePackageJson(`${RUNTIME_PACKAGE_LINUX_X64}/package.json`);
  } catch (error) {
    throw new RuntimeResolutionError(
      "RUNTIME_PACKAGE_MISSING",
      `${RUNTIME_PACKAGE_LINUX_X64} is not installed with the CLI`,
      { cause: error }
    );
  }
  const executable = join(dirname(packageJson), "bin", "kodegpt-runtime");
  await requireExecutable(executable);
  return executable;
}

function defaultResolvePackageJson(specifier: string): string {
  return createRequire(import.meta.url).resolve(specifier);
}

async function requireExecutable(path: string): Promise<void> {
  try {
    await access(path, constants.R_OK | constants.X_OK);
  } catch (error) {
    throw new RuntimeResolutionError(
      "RUNTIME_EXECUTABLE_UNAVAILABLE",
      "KodeGPT runtime executable is unavailable or not executable",
      { cause: error }
    );
  }
}
