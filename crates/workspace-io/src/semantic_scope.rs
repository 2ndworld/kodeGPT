use std::ffi::OsStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TraversalScope {
    Literal,
    Semantic,
}

const SEMANTIC_EXCLUDED_DIRECTORIES: &[&str] = &[
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
    ".code-review-graph",
];

pub(crate) fn include_directory(scope: TraversalScope, name: &OsStr) -> bool {
    match scope {
        TraversalScope::Literal => true,
        TraversalScope::Semantic => !SEMANTIC_EXCLUDED_DIRECTORIES
            .iter()
            .any(|excluded| name == OsStr::new(excluded)),
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;

    use super::{TraversalScope, include_directory};

    #[test]
    fn semantic_scope_uses_a_fixed_exclusion_set_not_a_dotfile_rule() {
        assert!(!include_directory(TraversalScope::Semantic, OsStr::new(".git")));
        assert!(!include_directory(
            TraversalScope::Semantic,
            OsStr::new("node_modules")
        ));
        assert!(include_directory(
            TraversalScope::Semantic,
            OsStr::new(".github")
        ));
        assert!(include_directory(
            TraversalScope::Semantic,
            OsStr::new(".cargo")
        ));
        assert!(include_directory(
            TraversalScope::Literal,
            OsStr::new("node_modules")
        ));
    }
}
