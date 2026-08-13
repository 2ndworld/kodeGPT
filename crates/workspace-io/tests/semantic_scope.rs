use std::fs::{self, File};
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use kodegpt_workspace_io::{
    SEARCH_MAX_MATCHES, SEARCH_MAX_SNIPPET_BYTES, TraversalScope, search_utf8_beneath_scoped,
    tree_beneath_scoped,
};

fn temporary_root(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "kodegpt-semantic-scope-{label}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&root).expect("temporary root created");
    root
}

fn root_fd(path: &Path) -> OwnedFd {
    File::open(path).expect("root directory opens").into()
}

fn write_fixture(root: &Path, path: &str, contents: impl AsRef<[u8]>) {
    let full = root.join(path);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).expect("fixture parent created");
    }
    fs::write(full, contents).expect("fixture written");
}

#[test]
fn semantic_tree_excludes_noise_before_budget_but_explicit_root_opts_in() {
    let root = temporary_root("tree");
    write_fixture(&root, "src/app.ts", "export const app = true;\n");
    write_fixture(&root, "frontend/package.json", "{}\n");
    write_fixture(&root, ".github/workflows/ci.yml", "name: ci\n");
    write_fixture(&root, ".cargo/config.toml", "[build]\n");
    write_fixture(&root, ".git/objects/aa/object", "object\n");
    write_fixture(&root, ".worktrees/feature/frontend/package.json", "{}\n");
    write_fixture(&root, "node_modules/pkg/package.json", "{}\n");
    write_fixture(&root, "target/debug/generated.rs", "fn generated() {}\n");
    write_fixture(&root, "dist/app.js", "generated\n");
    write_fixture(
        &root,
        "vendor/lib/source.ts",
        "export const vendored = true;\n",
    );
    write_fixture(&root, ".cache/value.txt", "cached\n");
    let fd = root_fd(&root);

    let literal = tree_beneath_scoped(&fd, Path::new("."), 100, TraversalScope::Literal)
        .expect("literal tree succeeds");
    let literal_paths = literal
        .entries
        .iter()
        .map(|entry| entry.path.as_str())
        .collect::<Vec<_>>();
    assert!(
        literal_paths
            .iter()
            .any(|path| path.starts_with("node_modules/"))
    );
    assert!(
        literal_paths
            .iter()
            .any(|path| path.starts_with(".worktrees/"))
    );

    let semantic = tree_beneath_scoped(&fd, Path::new("."), 100, TraversalScope::Semantic)
        .expect("semantic tree succeeds");
    let semantic_paths = semantic
        .entries
        .iter()
        .map(|entry| entry.path.as_str())
        .collect::<Vec<_>>();
    assert!(semantic_paths.contains(&"src"));
    assert!(semantic_paths.contains(&"src/app.ts"));
    assert!(semantic_paths.contains(&"frontend/package.json"));
    assert!(semantic_paths.contains(&".github/workflows/ci.yml"));
    assert!(semantic_paths.contains(&".cargo/config.toml"));
    for excluded in [
        ".git",
        ".worktrees",
        "node_modules",
        "target",
        "dist",
        "vendor",
        ".cache",
    ] {
        assert!(
            !semantic_paths
                .iter()
                .any(|path| *path == excluded || path.starts_with(&format!("{excluded}/"))),
            "semantic tree unexpectedly included {excluded}"
        );
    }

    let opted_in = tree_beneath_scoped(
        &fd,
        Path::new("node_modules/pkg"),
        100,
        TraversalScope::Semantic,
    )
    .expect("explicit excluded semantic root succeeds");
    assert!(
        opted_in
            .entries
            .iter()
            .any(|entry| entry.path == "node_modules/pkg/package.json")
    );

    fs::remove_dir_all(root).expect("temporary root removed");
}

#[test]
fn semantic_search_skips_excluded_candidates_and_their_truncation_pressure() {
    let root = temporary_root("search");
    write_fixture(&root, "src/main.ts", "const marker = 'needle';\n");
    write_fixture(
        &root,
        "node_modules/pkg/index.ts",
        "const dep = 'needle';\n",
    );
    write_fixture(
        &root,
        ".worktrees/feature/src/main.ts",
        "const old = 'needle';\n",
    );
    write_fixture(
        &root,
        "target/generated/huge.txt",
        vec![b'x'; 1024 * 1024 + 1],
    );
    let fd = root_fd(&root);

    let semantic = search_utf8_beneath_scoped(
        &fd,
        Path::new("."),
        "needle",
        SEARCH_MAX_MATCHES,
        SEARCH_MAX_SNIPPET_BYTES,
        TraversalScope::Semantic,
    )
    .expect("semantic search succeeds");
    assert_eq!(semantic.matches.len(), 1);
    assert_eq!(semantic.matches[0].path, "src/main.ts");
    assert!(!semantic.truncated);
    assert!(semantic.truncation_reasons.is_empty());

    let opted_in = search_utf8_beneath_scoped(
        &fd,
        Path::new("node_modules/pkg"),
        "needle",
        SEARCH_MAX_MATCHES,
        SEARCH_MAX_SNIPPET_BYTES,
        TraversalScope::Semantic,
    )
    .expect("explicit dependency search succeeds");
    assert_eq!(opted_in.matches.len(), 1);
    assert_eq!(opted_in.matches[0].path, "node_modules/pkg/index.ts");

    fs::remove_dir_all(root).expect("temporary root removed");
}
