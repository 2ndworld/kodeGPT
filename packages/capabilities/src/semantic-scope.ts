const SEMANTIC_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".worktrees",
  "node_modules",
  "vendor",
  "target",
  "dist",
  "build",
  "coverage",
  "out",
  "__pycache__",
  ".cache",
  ".vite",
  ".turbo",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "venv",
  ".VSCodeCounter",
  ".code-review-graph"
]);

export function isSemanticDiscoveryPath(path: string): boolean {
  return !path.split("/").some((segment) => SEMANTIC_EXCLUDED_DIRECTORIES.has(segment));
}
