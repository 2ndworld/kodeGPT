use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use kodegpt_workspace_io::{
    SkillSourceRegistry, SkillSourceRegistryError, TREE_MAX_ENTRIES, inspect_root,
};

fn temporary_root(label: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "kodegpt-skill-source-{label}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&root).expect("temporary source created");
    root
}

#[test]
fn retained_source_registration_reads_original_root_after_visible_path_replacement() {
    let root = temporary_root("retained");
    fs::write(root.join("SKILL.md"), "original").expect("fixture written");
    let identity = inspect_root(&root).expect("root inspected").identity;
    let mut registry = SkillSourceRegistry::new();
    let registration = registry
        .register(&root, &identity)
        .expect("source registered");

    let moved = root.with_extension("original");
    fs::rename(&root, &moved).expect("original root moved");
    fs::create_dir(&root).expect("replacement root created");
    fs::write(root.join("SKILL.md"), "replacement").expect("replacement written");

    let read = registry
        .read_file(&registration.capability_id, Path::new("SKILL.md"), 0, 64)
        .expect("retained source read");
    assert_eq!(read.contents, "original");

    fs::remove_dir_all(root).expect("replacement removed");
    fs::remove_dir_all(moved).expect("original removed");
}

#[test]
fn source_registration_rejects_identity_mismatch_and_overlapping_registered_roots() {
    let root = temporary_root("identity-overlap");
    let child = root.join("child");
    fs::create_dir(&child).expect("child created");
    let identity = inspect_root(&root).expect("root inspected").identity;
    let child_identity = inspect_root(&child).expect("child inspected").identity;
    let mut registry = SkillSourceRegistry::new();

    let mut wrong = identity.clone();
    wrong.inode.push('9');
    assert!(matches!(
        registry.register(&root, &wrong),
        Err(SkillSourceRegistryError::IdentityChanged)
    ));

    registry
        .register(&root, &identity)
        .expect("root registered");
    assert!(matches!(
        registry.register(&child, &child_identity),
        Err(SkillSourceRegistryError::RootOverlap)
    ));

    fs::remove_dir_all(root).expect("fixture removed");
}

#[test]
fn source_reads_reject_traversal_and_symlinks_even_when_symlink_target_is_inside_source() {
    let root = temporary_root("boundaries");
    fs::write(root.join("target.md"), "inside").expect("target written");
    fs::create_dir(root.join("real-skill")).expect("real skill directory created");
    fs::write(root.join("real-skill/SKILL.md"), "nested inside").expect("nested target written");
    symlink("target.md", root.join("link.md")).expect("file symlink created");
    symlink("real-skill", root.join("alias-skill")).expect("directory symlink created");
    let identity = inspect_root(&root).expect("root inspected").identity;
    let mut registry = SkillSourceRegistry::new();
    let registration = registry
        .register(&root, &identity)
        .expect("source registered");

    assert!(matches!(
        registry.read_file(&registration.capability_id, Path::new("../outside"), 0, 64),
        Err(SkillSourceRegistryError::AccessDenied)
    ));
    assert!(matches!(
        registry.read_file(&registration.capability_id, Path::new("link.md"), 0, 64),
        Err(SkillSourceRegistryError::AccessDenied)
    ));
    assert!(matches!(
        registry.read_file(
            &registration.capability_id,
            Path::new("alias-skill/SKILL.md"),
            0,
            64
        ),
        Err(SkillSourceRegistryError::AccessDenied)
    ));
    let alias_tree = registry.tree(&registration.capability_id, Path::new("alias-skill"), 64);
    assert!(
        matches!(alias_tree, Err(SkillSourceRegistryError::AccessDenied)),
        "unexpected alias tree result: {alias_tree:?}"
    );

    fs::remove_dir_all(root).expect("fixture removed");
}

#[test]
fn source_tree_supports_its_20000_entry_request_cap_without_changing_workspace_cap() {
    let root = temporary_root("tree-cap");
    fs::write(root.join("SKILL.md"), "bounded").expect("fixture written");
    let identity = inspect_root(&root).expect("root inspected").identity;
    let mut registry = SkillSourceRegistry::new();
    let registration = registry
        .register(&root, &identity)
        .expect("source registered");

    assert_eq!(TREE_MAX_ENTRIES, 10_000);
    let tree = registry
        .tree(&registration.capability_id, Path::new("."), 20_000)
        .expect("skill source accepts independent 20k cap");
    assert_eq!(tree.entries.len(), 1);
    assert_eq!(tree.entries[0].size_bytes, Some(7));
    assert!(!tree.truncated);

    fs::remove_dir_all(root).expect("fixture removed");
}

#[test]
fn unregister_invalidates_source_capability() {
    let root = temporary_root("unregister");
    fs::write(root.join("SKILL.md"), "gone").expect("fixture written");
    let identity = inspect_root(&root).expect("root inspected").identity;
    let mut registry = SkillSourceRegistry::new();
    let registration = registry
        .register(&root, &identity)
        .expect("source registered");

    registry
        .unregister(&registration.capability_id)
        .expect("source unregistered");
    assert!(matches!(
        registry.read_file(&registration.capability_id, Path::new("SKILL.md"), 0, 64),
        Err(SkillSourceRegistryError::CapabilityNotFound)
    ));

    fs::remove_dir_all(root).expect("fixture removed");
}
