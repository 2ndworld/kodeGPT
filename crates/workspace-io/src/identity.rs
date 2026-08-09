use std::fmt;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilesystemIdentity {
    pub device_major: u32,
    pub device_minor: u32,
    pub inode: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectedRoot {
    pub canonical_root: PathBuf,
    pub identity: FilesystemIdentity,
}

#[derive(Debug)]
pub enum InspectRootError {
    RelativePath,
    Io(std::io::Error),
    NotDirectory,
}

impl fmt::Display for InspectRootError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RelativePath => formatter.write_str("workspace root must be absolute"),
            Self::Io(error) => write!(formatter, "workspace root inspection failed: {error}"),
            Self::NotDirectory => formatter.write_str("workspace root is not a directory"),
        }
    }
}

impl std::error::Error for InspectRootError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::RelativePath | Self::NotDirectory => None,
        }
    }
}

pub fn inspect_root(path: &Path) -> Result<InspectedRoot, InspectRootError> {
    if !path.is_absolute() {
        return Err(InspectRootError::RelativePath);
    }

    let canonical_root = fs::canonicalize(path).map_err(InspectRootError::Io)?;
    let metadata = fs::metadata(&canonical_root).map_err(InspectRootError::Io)?;
    if !metadata.is_dir() {
        return Err(InspectRootError::NotDirectory);
    }

    let identity = filesystem_identity(&metadata);

    Ok(InspectedRoot {
        canonical_root,
        identity,
    })
}

pub(crate) fn filesystem_identity(metadata: &fs::Metadata) -> FilesystemIdentity {
    let device = metadata.dev();
    FilesystemIdentity {
        device_major: libc::major(device) as u32,
        device_minor: libc::minor(device) as u32,
        inode: metadata.ino().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::inspect_root;

    fn temporary_root(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "kodegpt-identity-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temporary directory created");
        root
    }

    #[test]
    fn inspect_root_returns_canonical_directory_identity() {
        let root = temporary_root("canonical");
        let inspected = inspect_root(&root).expect("root inspected");

        assert_eq!(inspected.canonical_root, fs::canonicalize(&root).unwrap());
        assert!(!inspected.identity.inode.is_empty());

        fs::remove_dir_all(root).expect("temporary root removed");
    }

    #[test]
    fn persistent_identity_changes_when_same_path_is_replaced_while_original_inode_is_retained() {
        let root = temporary_root("replacement");
        let before = inspect_root(&root).expect("initial identity").identity;
        let retained_root = fs::File::open(&root).expect("original directory fd retained");

        fs::remove_dir_all(&root).expect("initial root removed");
        fs::create_dir(&root).expect("replacement root created");
        let after = inspect_root(&root).expect("replacement identity").identity;

        assert_ne!(before, after);
        drop(retained_root);
        fs::remove_dir_all(root).expect("temporary root removed");
    }

    #[test]
    fn inspect_root_rejects_non_directory_paths() {
        let root = temporary_root("file");
        let file = root.join("not-a-directory");
        fs::write(&file, b"x").expect("fixture written");

        assert!(inspect_root(&file).is_err());
        fs::remove_dir_all(root).expect("temporary root removed");
    }
}
