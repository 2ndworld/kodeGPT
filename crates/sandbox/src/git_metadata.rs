use std::fmt;
use std::fs::{self, File};
use std::io::{Read, Take};
use std::os::fd::{AsRawFd, OwnedFd};
use std::path::{Component, Path, PathBuf};

use rustix::fs::{Mode, OFlags, open};

const METADATA_POINTER_MAX_BYTES: u64 = 16 * 1024;

#[derive(Debug)]
pub(crate) struct LinkedWorktreeGitMetadata {
    pub(crate) common_dir_fd: OwnedFd,
    pub(crate) common_dir_path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GitMetadataError {
    WorkspacePathUnavailable,
    InvalidDotGit,
    InvalidGitDir,
    InvalidCommonDir,
    InvalidBacklink,
    Io,
}

impl fmt::Display for GitMetadataError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WorkspacePathUnavailable => {
                formatter.write_str("retained workspace path is unavailable")
            }
            Self::InvalidDotGit => formatter.write_str("linked worktree .git pointer is invalid"),
            Self::InvalidGitDir => formatter.write_str("linked worktree gitdir is invalid"),
            Self::InvalidCommonDir => formatter.write_str("linked worktree commondir is invalid"),
            Self::InvalidBacklink => formatter.write_str("linked worktree backlink is invalid"),
            Self::Io => formatter.write_str("linked worktree Git metadata could not be opened"),
        }
    }
}

impl std::error::Error for GitMetadataError {}

pub(crate) fn open_linked_worktree_git_metadata(
    workspace_root: &OwnedFd,
) -> Result<Option<LinkedWorktreeGitMetadata>, GitMetadataError> {
    let workspace_path = retained_fd_path(workspace_root)?;
    let dot_git_path = workspace_path.join(".git");
    let dot_git_metadata = match fs::symlink_metadata(&dot_git_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(GitMetadataError::Io),
    };
    if dot_git_metadata.file_type().is_dir() {
        return Ok(None);
    }
    if !dot_git_metadata.file_type().is_file() {
        return Err(GitMetadataError::InvalidDotGit);
    }

    let dot_git = read_bounded_regular_file(&dot_git_path, GitMetadataError::InvalidDotGit)?;
    let git_dir = parse_gitdir_pointer(&dot_git)?;
    require_canonical_directory(&git_dir).map_err(|_| GitMetadataError::InvalidGitDir)?;

    let worktrees_dir = git_dir
        .parent()
        .filter(|path| path.file_name().is_some_and(|name| name == "worktrees"))
        .ok_or(GitMetadataError::InvalidGitDir)?;
    let common_dir = worktrees_dir
        .parent()
        .filter(|path| path.file_name().is_some_and(|name| name == ".git"))
        .ok_or(GitMetadataError::InvalidCommonDir)?;
    require_canonical_directory(common_dir).map_err(|_| GitMetadataError::InvalidCommonDir)?;

    let commondir = read_bounded_regular_file(
        &git_dir.join("commondir"),
        GitMetadataError::InvalidCommonDir,
    )?;
    if single_trimmed_line(&commondir) != Some("../..") {
        return Err(GitMetadataError::InvalidCommonDir);
    }

    let backlink =
        read_bounded_regular_file(&git_dir.join("gitdir"), GitMetadataError::InvalidBacklink)?;
    let backlink_path =
        PathBuf::from(single_trimmed_line(&backlink).ok_or(GitMetadataError::InvalidBacklink)?);
    if backlink_path != dot_git_path || !is_clean_absolute_path(&backlink_path) {
        return Err(GitMetadataError::InvalidBacklink);
    }

    let common_dir_fd = open_directory_no_symlink(common_dir)?;
    Ok(Some(LinkedWorktreeGitMetadata {
        common_dir_fd,
        common_dir_path: common_dir.to_path_buf(),
    }))
}

fn retained_fd_path(workspace_root: &OwnedFd) -> Result<PathBuf, GitMetadataError> {
    let path = fs::read_link(format!("/proc/self/fd/{}", workspace_root.as_raw_fd()))
        .map_err(|_| GitMetadataError::WorkspacePathUnavailable)?;
    if !is_clean_absolute_path(&path) || path.to_string_lossy().ends_with(" (deleted)") {
        return Err(GitMetadataError::WorkspacePathUnavailable);
    }
    let canonical =
        fs::canonicalize(&path).map_err(|_| GitMetadataError::WorkspacePathUnavailable)?;
    if canonical != path {
        return Err(GitMetadataError::WorkspacePathUnavailable);
    }
    Ok(path)
}

fn parse_gitdir_pointer(contents: &str) -> Result<PathBuf, GitMetadataError> {
    let line = single_trimmed_line(contents).ok_or(GitMetadataError::InvalidDotGit)?;
    let value = line
        .strip_prefix("gitdir: ")
        .ok_or(GitMetadataError::InvalidDotGit)?;
    let path = PathBuf::from(value);
    if !is_clean_absolute_path(&path) {
        return Err(GitMetadataError::InvalidGitDir);
    }
    Ok(path)
}

fn single_trimmed_line(contents: &str) -> Option<&str> {
    let trimmed = contents.trim_end_matches(['\r', '\n']);
    if trimmed.is_empty() || trimmed.contains(['\r', '\n']) || trimmed.contains('\0') {
        return None;
    }
    Some(trimmed)
}

fn is_clean_absolute_path(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
}

fn require_canonical_directory(path: &Path) -> Result<(), GitMetadataError> {
    if !is_clean_absolute_path(path) {
        return Err(GitMetadataError::Io);
    }
    let canonical = fs::canonicalize(path).map_err(|_| GitMetadataError::Io)?;
    if canonical != path {
        return Err(GitMetadataError::Io);
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| GitMetadataError::Io)?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(GitMetadataError::Io);
    }
    Ok(())
}

fn open_directory_no_symlink(path: &Path) -> Result<OwnedFd, GitMetadataError> {
    open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| GitMetadataError::Io)
}

fn read_bounded_regular_file(
    path: &Path,
    invalid_error: GitMetadataError,
) -> Result<String, GitMetadataError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| invalid_error)?;
    if !metadata.file_type().is_file() || metadata.len() > METADATA_POINTER_MAX_BYTES {
        return Err(invalid_error);
    }
    let fd = open(
        path,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| invalid_error)?;
    let file = File::from(fd);
    let mut contents = String::new();
    let mut limited: Take<File> = file.take(METADATA_POINTER_MAX_BYTES + 1);
    limited
        .read_to_string(&mut contents)
        .map_err(|_| invalid_error)?;
    if contents.len() as u64 > METADATA_POINTER_MAX_BYTES {
        return Err(invalid_error);
    }
    Ok(contents)
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};
    use std::os::fd::OwnedFd;
    use std::os::unix::fs::symlink;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{GitMetadataError, open_linked_worktree_git_metadata};

    fn temporary_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "kodegpt-git-metadata-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temporary root");
        root
    }

    fn git(root: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .env_clear()
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("HOME", "/tmp")
            .status()
            .expect("test git available");
        assert!(status.success(), "test git command failed: {args:?}");
    }

    fn committed_repository(label: &str) -> PathBuf {
        let repository = temporary_root(label);
        git(&repository, &["init", "-b", "main"]);
        git(&repository, &["config", "user.name", "KodeGPT Test"]);
        git(
            &repository,
            &["config", "user.email", "kodegpt@example.invalid"],
        );
        fs::write(repository.join("tracked.txt"), "base\n").expect("tracked fixture");
        git(&repository, &["add", "tracked.txt"]);
        git(&repository, &["commit", "-m", "base"]);
        repository
    }

    fn linked_worktree(repository: &Path, name: &str) -> PathBuf {
        let worktree = repository.join(".worktrees").join(name);
        git(
            repository,
            &[
                "worktree",
                "add",
                "-b",
                name,
                worktree.to_str().expect("utf8 worktree path"),
            ],
        );
        worktree
    }

    #[test]
    fn ordinary_repository_does_not_request_external_git_metadata() {
        let repository = committed_repository("ordinary");
        let root_fd = OwnedFd::from(File::open(&repository).expect("repository root fd"));

        assert!(
            open_linked_worktree_git_metadata(&root_fd)
                .expect("ordinary repository inspection")
                .is_none()
        );

        fs::remove_dir_all(repository).expect("repository cleanup");
    }

    #[test]
    fn valid_linked_worktree_resolves_only_its_common_git_metadata_directory() {
        let repository = committed_repository("valid-linked");
        let worktree = linked_worktree(&repository, "feature");
        let root_fd = OwnedFd::from(File::open(&worktree).expect("worktree root fd"));

        let metadata = open_linked_worktree_git_metadata(&root_fd)
            .expect("linked worktree metadata")
            .expect("linked worktree metadata mount");
        assert_eq!(metadata.common_dir_path, repository.join(".git"));

        drop(metadata);
        drop(root_fd);
        fs::remove_dir_all(repository).expect("repository cleanup");
    }

    #[test]
    fn dot_git_symlink_is_rejected() {
        let workspace = temporary_root("dot-git-symlink-workspace");
        let external = temporary_root("dot-git-symlink-external");
        fs::write(external.join("pointer"), "gitdir: /tmp/forged\n").expect("pointer fixture");
        symlink(external.join("pointer"), workspace.join(".git")).expect("dot git symlink");
        let root_fd = OwnedFd::from(File::open(&workspace).expect("workspace root fd"));

        assert!(matches!(
            open_linked_worktree_git_metadata(&root_fd),
            Err(GitMetadataError::InvalidDotGit)
        ));

        fs::remove_dir_all(workspace).expect("workspace cleanup");
        fs::remove_dir_all(external).expect("external cleanup");
    }

    #[test]
    fn gitdir_pointer_with_parent_traversal_is_rejected() {
        let workspace = temporary_root("pointer-traversal");
        fs::write(
            workspace.join(".git"),
            "gitdir: /tmp/kodegpt-forged/../escape/.git/worktrees/feature\n",
        )
        .expect("pointer fixture");
        let root_fd = OwnedFd::from(File::open(&workspace).expect("workspace root fd"));

        assert!(matches!(
            open_linked_worktree_git_metadata(&root_fd),
            Err(GitMetadataError::InvalidGitDir)
        ));

        fs::remove_dir_all(workspace).expect("workspace cleanup");
    }

    #[test]
    fn mismatched_repository_worktree_backlink_is_rejected() {
        let repository_a = committed_repository("mismatch-a");
        let repository_b = committed_repository("mismatch-b");
        let worktree_a = linked_worktree(&repository_a, "feature-a");
        let worktree_b = linked_worktree(&repository_b, "feature-b");
        let foreign_gitdir = fs::read_to_string(worktree_b.join(".git"))
            .expect("foreign git pointer")
            .trim()
            .strip_prefix("gitdir: ")
            .expect("gitdir prefix")
            .to_owned();
        fs::write(
            worktree_a.join(".git"),
            format!("gitdir: {foreign_gitdir}\n"),
        )
        .expect("replace git pointer");
        let root_fd = OwnedFd::from(File::open(&worktree_a).expect("worktree root fd"));

        assert!(matches!(
            open_linked_worktree_git_metadata(&root_fd),
            Err(GitMetadataError::InvalidBacklink)
        ));

        fs::remove_dir_all(repository_a).expect("repository a cleanup");
        fs::remove_dir_all(repository_b).expect("repository b cleanup");
    }

    #[test]
    fn stale_deleted_worktree_gitdir_is_rejected() {
        let repository = committed_repository("stale-linked");
        let worktree = linked_worktree(&repository, "feature");
        let gitdir = fs::read_to_string(worktree.join(".git"))
            .expect("git pointer")
            .trim()
            .strip_prefix("gitdir: ")
            .expect("gitdir prefix")
            .to_owned();
        fs::remove_dir_all(&gitdir).expect("remove linked gitdir");
        let root_fd = OwnedFd::from(File::open(&worktree).expect("worktree root fd"));

        assert!(matches!(
            open_linked_worktree_git_metadata(&root_fd),
            Err(GitMetadataError::InvalidGitDir)
        ));

        fs::remove_dir_all(repository).expect("repository cleanup");
    }
}
