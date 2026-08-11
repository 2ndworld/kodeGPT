use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fmt;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rustix::fs::{AtFlags, FileType, OFlags, RawDir, fstat, statat};
use rustix::io::Errno;
use serde::Serialize;

use crate::openat::{OpenatBoundaryError, open_directory_beneath, open_existing_beneath};

pub const INLINE_READ_MAX_BYTES: u64 = 1024 * 1024;
pub const TREE_DEFAULT_MAX_ENTRIES: usize = 2_000;
pub const TREE_MAX_ENTRIES: usize = 10_000;
pub const SEARCH_TREE_MAX_ENTRIES: usize = TREE_MAX_ENTRIES;
pub const SEARCH_MAX_MATCHES: usize = 500;
pub const SEARCH_MAX_SNIPPET_BYTES: usize = 256 * 1024;
pub const SEARCH_MAX_SCANNED_BYTES: u64 = 64 * 1024 * 1024;
const SEARCH_FILE_MAX_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceReadError {
    InvalidPath,
    BoundaryUnavailable,
    BoundaryViolation,
    NotFound,
    NotRegularFile,
    InvalidUtf8,
    LimitExceeded,
    Io(Errno),
}

impl fmt::Display for WorkspaceReadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath => formatter.write_str("workspace path is invalid"),
            Self::BoundaryUnavailable => {
                formatter.write_str("required filesystem boundary semantics are unavailable")
            }
            Self::BoundaryViolation => {
                formatter.write_str("workspace filesystem boundary denied access")
            }
            Self::NotFound => formatter.write_str("workspace path was not found"),
            Self::NotRegularFile => formatter.write_str("workspace path is not a regular file"),
            Self::InvalidUtf8 => formatter.write_str("workspace file contents are not valid UTF-8"),
            Self::LimitExceeded => formatter.write_str("workspace read limit was exceeded"),
            Self::Io(error) => write!(formatter, "workspace file operation failed: {error}"),
        }
    }
}

impl std::error::Error for WorkspaceReadError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileResult {
    pub contents: String,
    pub bytes_read: u64,
    pub eof: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TreeEntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TreeEntry {
    pub path: String,
    pub kind: TreeEntryKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeResult {
    pub entries: Vec<TreeEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: u64,
    pub line_text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SearchTruncationReason {
    TreeLimit,
    FileSizeLimit,
    ScanByteLimit,
    MatchLimit,
    SnippetByteLimit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
    pub truncation_reasons: Vec<SearchTruncationReason>,
}

pub fn read_file_beneath(
    root_fd: &OwnedFd,
    relative_path: &Path,
    offset: u64,
    max_bytes: u64,
) -> Result<ReadFileResult, WorkspaceReadError> {
    if max_bytes > INLINE_READ_MAX_BYTES {
        return Err(WorkspaceReadError::LimitExceeded);
    }
    let fd = open_existing_beneath(root_fd, relative_path, OFlags::RDONLY | OFlags::NONBLOCK)
        .map_err(map_boundary_error)?;
    let stat = fstat(&fd).map_err(WorkspaceReadError::Io)?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(WorkspaceReadError::NotRegularFile);
    }

    let mut file = File::from(fd);
    file.seek(SeekFrom::Start(offset)).map_err(io_error)?;
    let mut bytes = Vec::with_capacity(max_bytes.saturating_add(1) as usize);
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    let eof = bytes.len() as u64 <= max_bytes;
    if !eof {
        bytes.truncate(max_bytes as usize);
    }
    let bytes_read = bytes.len() as u64;
    let contents = String::from_utf8(bytes).map_err(|_| WorkspaceReadError::InvalidUtf8)?;
    Ok(ReadFileResult {
        contents,
        bytes_read,
        eof,
    })
}

pub fn tree_beneath(
    root_fd: &OwnedFd,
    relative_path: &Path,
    max_entries: usize,
) -> Result<TreeResult, WorkspaceReadError> {
    if max_entries == 0 || max_entries > TREE_MAX_ENTRIES {
        return Err(WorkspaceReadError::LimitExceeded);
    }
    let (start_fd, start_prefix) = open_directory_start(root_fd, relative_path)?;
    let start_fd = Arc::new(start_fd);
    let mut pending = BTreeMap::new();
    enqueue_directory_entries(&mut pending, start_fd, &start_prefix, max_entries + 1)?;
    let mut entries = Vec::with_capacity(max_entries.min(pending.len()));

    while entries.len() < max_entries {
        let Some((relative, candidate)) = pending.pop_first() else {
            break;
        };
        entries.push(TreeEntry {
            path: relative.to_string_lossy().into_owned(),
            kind: candidate.kind,
        });
        if candidate.kind == TreeEntryKind::Directory {
            match open_directory_beneath(candidate.parent_fd.as_ref(), Path::new(&candidate.name)) {
                Ok(child_fd) => {
                    let frontier_limit = max_entries.saturating_sub(entries.len()) + 1;
                    enqueue_directory_entries(
                        &mut pending,
                        Arc::new(child_fd),
                        &relative,
                        frontier_limit,
                    )?;
                }
                Err(OpenatBoundaryError::BoundaryViolation | OpenatBoundaryError::NotFound) => {}
                Err(error) => return Err(map_boundary_error(error)),
            }
        }
    }

    Ok(TreeResult {
        entries,
        truncated: !pending.is_empty(),
    })
}

pub fn search_utf8_beneath(
    root_fd: &OwnedFd,
    relative_path: &Path,
    query: &str,
    max_matches: usize,
    max_snippet_bytes: usize,
) -> Result<SearchResult, WorkspaceReadError> {
    if query.is_empty()
        || max_matches == 0
        || max_matches > SEARCH_MAX_MATCHES
        || max_snippet_bytes == 0
        || max_snippet_bytes > SEARCH_MAX_SNIPPET_BYTES
    {
        return Err(WorkspaceReadError::LimitExceeded);
    }
    let tree = tree_beneath(root_fd, relative_path, SEARCH_TREE_MAX_ENTRIES)?;
    let mut matches = Vec::new();
    let mut snippet_bytes = 0usize;
    let mut scanned_bytes = 0u64;
    let mut reasons = BTreeSet::new();
    if tree.truncated {
        reasons.insert(SearchTruncationReason::TreeLimit);
    }

    'files: for entry in tree
        .entries
        .into_iter()
        .filter(|entry| entry.kind == TreeEntryKind::File)
    {
        let path = Path::new(&entry.path);
        let fd = match open_existing_beneath(
            root_fd,
            path,
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW,
        ) {
            Ok(fd) => fd,
            Err(OpenatBoundaryError::BoundaryViolation | OpenatBoundaryError::NotFound) => continue,
            Err(error) => return Err(map_boundary_error(error)),
        };
        let stat = fstat(&fd).map_err(WorkspaceReadError::Io)?;
        if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile || stat.st_size < 0 {
            continue;
        }
        let file_bytes = stat.st_size as u64;
        if file_bytes > SEARCH_FILE_MAX_BYTES {
            reasons.insert(SearchTruncationReason::FileSizeLimit);
            continue;
        }
        if scanned_bytes.saturating_add(file_bytes) > SEARCH_MAX_SCANNED_BYTES {
            reasons.insert(SearchTruncationReason::ScanByteLimit);
            break 'files;
        }
        scanned_bytes = scanned_bytes.saturating_add(file_bytes);

        let mut bytes = Vec::with_capacity(file_bytes as usize);
        File::from(fd).read_to_end(&mut bytes).map_err(io_error)?;
        if bytes.contains(&0) {
            continue;
        }
        let text = match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => continue,
        };
        for (index, line) in text.lines().enumerate() {
            if !line.contains(query) {
                continue;
            }
            let match_limit = matches.len() >= max_matches;
            let snippet_limit = snippet_bytes.saturating_add(line.len()) > max_snippet_bytes;
            if match_limit || snippet_limit {
                if match_limit {
                    reasons.insert(SearchTruncationReason::MatchLimit);
                }
                if snippet_limit {
                    reasons.insert(SearchTruncationReason::SnippetByteLimit);
                }
                break 'files;
            }
            snippet_bytes += line.len();
            matches.push(SearchMatch {
                path: entry.path.clone(),
                line: (index + 1) as u64,
                line_text: line.to_owned(),
            });
        }
    }

    let truncation_reasons = reasons.into_iter().collect::<Vec<_>>();
    Ok(SearchResult {
        matches,
        truncated: !truncation_reasons.is_empty(),
        truncation_reasons,
    })
}

struct TreeCandidate {
    parent_fd: Arc<OwnedFd>,
    name: OsString,
    kind: TreeEntryKind,
}

fn enqueue_directory_entries(
    pending: &mut BTreeMap<PathBuf, TreeCandidate>,
    directory_fd: Arc<OwnedFd>,
    prefix: &Path,
    frontier_limit: usize,
) -> Result<(), WorkspaceReadError> {
    visit_directory_entries(directory_fd.as_ref(), |name, kind| {
        let relative = if prefix.as_os_str().is_empty() {
            PathBuf::from(&name)
        } else {
            prefix.join(&name)
        };
        pending.insert(
            relative,
            TreeCandidate {
                parent_fd: Arc::clone(&directory_fd),
                name,
                kind,
            },
        );
        if pending.len() > frontier_limit {
            pending.pop_last();
        }
    })
}

fn open_directory_start(
    root_fd: &OwnedFd,
    relative_path: &Path,
) -> Result<(OwnedFd, PathBuf), WorkspaceReadError> {
    let fd = open_directory_beneath(root_fd, relative_path).map_err(map_boundary_error)?;
    let prefix = if relative_path == Path::new(".") {
        PathBuf::new()
    } else {
        relative_path.to_path_buf()
    };
    Ok((fd, prefix))
}

fn visit_directory_entries(
    directory_fd: &OwnedFd,
    mut visit: impl FnMut(OsString, TreeEntryKind),
) -> Result<(), WorkspaceReadError> {
    let mut buffer: Vec<u8> = Vec::with_capacity(8 * 1024);

    'read: loop {
        let grow_buffer = {
            let mut directory = RawDir::new(directory_fd, buffer.spare_capacity_mut());
            loop {
                match directory.next() {
                    Some(Ok(entry)) => {
                        let name_bytes = entry.file_name().to_bytes();
                        if name_bytes == b"." || name_bytes == b".." {
                            continue;
                        }
                        let name = OsString::from_vec(name_bytes.to_vec());
                        let kind = entry_kind(directory_fd, &name, entry.file_type())?;
                        visit(name, kind);
                    }
                    Some(Err(Errno::INVAL)) => break true,
                    Some(Err(error)) => return Err(WorkspaceReadError::Io(error)),
                    None => break 'read,
                }
            }
        };

        if grow_buffer {
            let current = buffer.capacity();
            if current >= INLINE_READ_MAX_BYTES as usize {
                return Err(WorkspaceReadError::LimitExceeded);
            }
            let target = current
                .saturating_mul(2)
                .min(INLINE_READ_MAX_BYTES as usize);
            buffer.reserve(target.saturating_sub(current));
        }
    }

    Ok(())
}

fn entry_kind(
    directory_fd: &OwnedFd,
    name: &OsString,
    reported: FileType,
) -> Result<TreeEntryKind, WorkspaceReadError> {
    let file_type = if reported == FileType::Unknown {
        let stat = statat(directory_fd, name, AtFlags::SYMLINK_NOFOLLOW).map_err(|error| {
            if error == Errno::NOENT {
                WorkspaceReadError::NotFound
            } else {
                WorkspaceReadError::Io(error)
            }
        })?;
        FileType::from_raw_mode(stat.st_mode)
    } else {
        reported
    };

    Ok(match file_type {
        FileType::RegularFile => TreeEntryKind::File,
        FileType::Directory => TreeEntryKind::Directory,
        FileType::Symlink => TreeEntryKind::Symlink,
        _ => TreeEntryKind::Other,
    })
}

fn map_boundary_error(error: OpenatBoundaryError) -> WorkspaceReadError {
    match error {
        OpenatBoundaryError::InvalidRelativePath => WorkspaceReadError::InvalidPath,
        OpenatBoundaryError::BoundaryUnavailable => WorkspaceReadError::BoundaryUnavailable,
        OpenatBoundaryError::BoundaryViolation => WorkspaceReadError::BoundaryViolation,
        OpenatBoundaryError::NotFound => WorkspaceReadError::NotFound,
        OpenatBoundaryError::Os(error) => WorkspaceReadError::Io(error),
    }
}

fn io_error(error: std::io::Error) -> WorkspaceReadError {
    error
        .raw_os_error()
        .map(|code| WorkspaceReadError::Io(Errno::from_raw_os_error(code)))
        .unwrap_or(WorkspaceReadError::Io(Errno::IO))
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};
    use std::os::fd::OwnedFd;
    use std::os::unix::fs::symlink;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        INLINE_READ_MAX_BYTES, SEARCH_FILE_MAX_BYTES, SEARCH_MAX_MATCHES,
        SEARCH_MAX_SCANNED_BYTES, SEARCH_MAX_SNIPPET_BYTES, SEARCH_TREE_MAX_ENTRIES,
        TREE_MAX_ENTRIES, SearchTruncationReason, TreeEntryKind, WorkspaceReadError,
        read_file_beneath, search_utf8_beneath, tree_beneath,
    };

    fn temporary_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "kodegpt-read-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temporary root created");
        root
    }

    fn root_fd(path: &Path) -> OwnedFd {
        File::open(path).expect("root directory opens").into()
    }

    #[test]
    fn file_read_is_fd_relative_bounded_and_rejects_escape_paths() {
        let root = temporary_root("file");
        let outside = temporary_root("outside");
        fs::write(root.join("inside.txt"), "alpha\nbeta\n").expect("inside file written");
        fs::write(outside.join("secret.txt"), "outside-secret").expect("outside file written");
        symlink(outside.join("secret.txt"), root.join("outside-link"))
            .expect("outside symlink created");
        let fd = root_fd(&root);

        let result =
            read_file_beneath(&fd, Path::new("inside.txt"), 6, 4).expect("inside read succeeds");
        assert_eq!(result.contents, "beta");
        assert_eq!(result.bytes_read, 4);
        assert!(!result.eof);

        let tail =
            read_file_beneath(&fd, Path::new("inside.txt"), 6, 64).expect("tail read succeeds");
        assert_eq!(tail.contents, "beta\n");
        assert!(tail.eof);

        assert!(matches!(
            read_file_beneath(&fd, Path::new("../secret.txt"), 0, 16),
            Err(WorkspaceReadError::InvalidPath | WorkspaceReadError::BoundaryViolation)
        ));
        assert!(matches!(
            read_file_beneath(&fd, Path::new("outside-link"), 0, 16),
            Err(WorkspaceReadError::BoundaryViolation)
        ));
        assert!(matches!(
            read_file_beneath(&fd, Path::new("inside.txt"), 0, INLINE_READ_MAX_BYTES + 1),
            Err(WorkspaceReadError::LimitExceeded)
        ));

        let slash_fd = root_fd(Path::new("/"));
        assert!(matches!(
            read_file_beneath(&slash_fd, Path::new("proc/version"), 0, 64),
            Err(WorkspaceReadError::BoundaryViolation)
        ));

        fs::remove_dir_all(root).expect("root removed");
        fs::remove_dir_all(outside).expect("outside removed");
    }

    #[test]
    fn tree_lists_symlink_without_descending_and_is_deterministic() {
        let root = temporary_root("tree");
        let outside = temporary_root("tree-outside");
        fs::create_dir_all(root.join("dir")).expect("dir created");
        fs::write(root.join("z.txt"), "z").expect("z written");
        fs::write(root.join("dir/a.txt"), "a").expect("a written");
        fs::write(outside.join("secret.txt"), "secret").expect("secret written");
        symlink(&outside, root.join("escape-dir")).expect("escape directory symlink created");
        let fd = root_fd(&root);

        let result = tree_beneath(&fd, Path::new("."), TREE_MAX_ENTRIES).expect("tree succeeds");
        let paths = result
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(paths, vec!["dir", "dir/a.txt", "escape-dir", "z.txt"]);
        assert_eq!(result.entries[2].kind, TreeEntryKind::Symlink);
        assert!(!result.truncated);
        assert!(!paths.iter().any(|path| path.contains("secret.txt")));

        fs::remove_dir_all(root).expect("root removed");
        fs::remove_dir_all(outside).expect("outside removed");
    }

    #[test]
    fn repeated_tree_calls_do_not_consume_the_retained_root_directory_offset() {
        let root = temporary_root("tree-repeat");
        fs::write(root.join("a.txt"), "a").expect("file written");
        let fd = root_fd(&root);

        let first =
            tree_beneath(&fd, Path::new("."), TREE_MAX_ENTRIES).expect("first tree succeeds");
        let second =
            tree_beneath(&fd, Path::new("."), TREE_MAX_ENTRIES).expect("second tree succeeds");
        assert_eq!(first, second);
        assert_eq!(second.entries.len(), 1);
        assert!(!second.truncated);

        fs::remove_dir_all(root).expect("root removed");
    }

    #[test]
    fn tree_reports_exact_limit_without_truncation() {
        let root = temporary_root("tree-exact-limit");
        for index in (0..2_000).rev() {
            fs::write(root.join(format!("f{index:04}.txt")), "x").expect("fixture file written");
        }
        let fd = root_fd(&root);

        let result = tree_beneath(&fd, Path::new("."), 2_000).expect("bounded tree succeeds");
        assert_eq!(result.entries.len(), 2_000);
        assert!(!result.truncated);
        assert_eq!(result.entries.first().expect("first entry").path, "f0000.txt");
        assert_eq!(result.entries.last().expect("last entry").path, "f1999.txt");

        fs::remove_dir_all(root).expect("root removed");
    }

    #[test]
    fn tree_reports_truncation_when_an_additional_entry_exists() {
        let root = temporary_root("tree-truncated");
        for index in (0..2_001).rev() {
            fs::write(root.join(format!("f{index:04}.txt")), "x").expect("fixture file written");
        }
        let fd = root_fd(&root);

        let result = tree_beneath(&fd, Path::new("."), 2_000).expect("bounded tree succeeds");
        assert_eq!(result.entries.len(), 2_000);
        assert!(result.truncated);
        assert_eq!(result.entries.first().expect("first entry").path, "f0000.txt");
        assert_eq!(result.entries.last().expect("last entry").path, "f1999.txt");

        fs::remove_dir_all(root).expect("root removed");
    }

    #[test]
    fn tree_supports_explicit_limits_above_the_default_up_to_the_hard_cap() {
        let root = temporary_root("tree-expanded-limit");
        for index in (0..2_001).rev() {
            fs::write(root.join(format!("f{index:04}.txt")), "x").expect("fixture file written");
        }
        let fd = root_fd(&root);

        let result = tree_beneath(&fd, Path::new("."), 10_000).expect("expanded tree succeeds");
        assert_eq!(result.entries.len(), 2_001);
        assert!(!result.truncated);
        assert!(matches!(
            tree_beneath(&fd, Path::new("."), 10_001),
            Err(WorkspaceReadError::LimitExceeded)
        ));

        fs::remove_dir_all(root).expect("root removed");
    }

    #[test]
    fn search_enforces_the_aggregate_snippet_ceiling() {
        let root = temporary_root("search-snippet-ceiling");
        let line = format!("needle {}", "x".repeat(2048));
        let contents = std::iter::repeat_n(line, SEARCH_MAX_MATCHES)
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(root.join("large.txt"), contents).expect("large search fixture written");
        let fd = root_fd(&root);

        let result = search_utf8_beneath(
            &fd,
            Path::new("."),
            "needle",
            SEARCH_MAX_MATCHES,
            SEARCH_MAX_SNIPPET_BYTES,
        )
        .expect("bounded search succeeds");
        let snippets = result
            .matches
            .iter()
            .map(|item| item.line_text.len())
            .sum::<usize>();
        assert!(!result.matches.is_empty());
        assert!(result.matches.len() < SEARCH_MAX_MATCHES);
        assert!(snippets <= SEARCH_MAX_SNIPPET_BYTES);
        assert!(result.truncated);
        assert_eq!(
            result.truncation_reasons,
            vec![SearchTruncationReason::SnippetByteLimit]
        );

        fs::remove_dir_all(root).expect("root removed");
    }

    #[test]
    fn lexical_search_marks_oversized_candidate_as_incomplete() {
        let root = temporary_root("search-oversized");
        let mut contents = vec![b'a'; SEARCH_FILE_MAX_BYTES as usize + 1];
        let needle = b"needle";
        let start = contents.len() - needle.len();
        contents[start..].copy_from_slice(needle);
        fs::write(root.join("large.txt"), contents).expect("oversized fixture written");
        let fd = root_fd(&root);

        let result = search_utf8_beneath(
            &fd,
            Path::new("."),
            "needle",
            SEARCH_MAX_MATCHES,
            SEARCH_MAX_SNIPPET_BYTES,
        )
        .expect("bounded search succeeds");

        assert!(result.matches.is_empty());
        assert!(result.truncated);
        assert_eq!(
            result.truncation_reasons,
            vec![SearchTruncationReason::FileSizeLimit]
        );

        fs::remove_dir_all(root).expect("root removed");
    }

    #[test]
    fn lexical_search_stops_at_aggregate_scan_budget() {
        let root = temporary_root("search-scan-budget");
        let file_bytes = SEARCH_FILE_MAX_BYTES;
        let files_within_budget = SEARCH_MAX_SCANNED_BYTES / file_bytes;
        for index in 0..=files_within_budget {
            let file = File::create(root.join(format!("f{index:03}.txt")))
                .expect("sparse scan fixture created");
            file.set_len(file_bytes).expect("sparse scan fixture sized");
        }
        let fd = root_fd(&root);

        let result = search_utf8_beneath(
            &fd,
            Path::new("."),
            "needle",
            SEARCH_MAX_MATCHES,
            SEARCH_MAX_SNIPPET_BYTES,
        )
        .expect("bounded search succeeds");

        assert!(result.matches.is_empty());
        assert!(result.truncated);
        assert_eq!(
            result.truncation_reasons,
            vec![SearchTruncationReason::ScanByteLimit]
        );

        fs::remove_dir_all(root).expect("root removed");
    }

    #[test]
    fn lexical_search_skips_binary_and_enforces_global_ceilings() {
        let root = temporary_root("search");
        fs::create_dir_all(root.join("src")).expect("src created");
        fs::write(root.join("src/a.txt"), "needle one\nno match\nneedle two\n")
            .expect("text written");
        fs::write(root.join("src/b.bin"), b"needle\0binary").expect("binary written");
        for index in 0..(SEARCH_MAX_MATCHES + 20) {
            fs::write(root.join(format!("src/m{index:03}.txt")), "needle\n")
                .expect("match file written");
        }
        let fd = root_fd(&root);

        let result = search_utf8_beneath(
            &fd,
            Path::new("src"),
            "needle",
            SEARCH_MAX_MATCHES,
            SEARCH_MAX_SNIPPET_BYTES,
        )
        .expect("search succeeds");
        assert_eq!(result.matches.len(), SEARCH_MAX_MATCHES);
        assert!(result.truncated);
        assert_eq!(
            result.truncation_reasons,
            vec![SearchTruncationReason::MatchLimit]
        );
        assert!(
            result
                .matches
                .iter()
                .all(|item| !item.path.ends_with("b.bin"))
        );
        assert!(
            result
                .matches
                .iter()
                .map(|item| item.line_text.len())
                .sum::<usize>()
                <= SEARCH_MAX_SNIPPET_BYTES
        );

        fs::remove_dir_all(root).expect("root removed");
    }

    #[test]
    fn lexical_search_reports_exact_match_limit_without_truncation() {
        let root = temporary_root("search-exact-limit");
        fs::write(root.join("exact.txt"), "needle one\nneedle two\nneedle three\n")
            .expect("exact search fixture written");
        let fd = root_fd(&root);

        let result = search_utf8_beneath(
            &fd,
            Path::new("."),
            "needle",
            3,
            SEARCH_MAX_SNIPPET_BYTES,
        )
        .expect("exact bounded search succeeds");

        assert_eq!(result.matches.len(), 3);
        assert!(!result.truncated);
        assert!(result.truncation_reasons.is_empty());

        assert!(matches!(
            search_utf8_beneath(
                &fd,
                Path::new("."),
                "needle",
                SEARCH_MAX_MATCHES + 1,
                SEARCH_MAX_SNIPPET_BYTES,
            ),
            Err(WorkspaceReadError::LimitExceeded)
        ));

        fs::remove_dir_all(root).expect("root removed");
    }

    #[test]
    fn lexical_search_propagates_underlying_tree_truncation() {
        let root = temporary_root("search-tree-truncation");
        for index in 0..(SEARCH_TREE_MAX_ENTRIES + 1) {
            fs::write(root.join(format!("f{index:05}.txt")), "no match\n")
                .expect("tree truncation fixture written");
        }
        let fd = root_fd(&root);

        let result = search_utf8_beneath(
            &fd,
            Path::new("."),
            "needle",
            SEARCH_MAX_MATCHES,
            SEARCH_MAX_SNIPPET_BYTES,
        )
        .expect("bounded search succeeds");

        assert!(result.matches.is_empty());
        assert!(result.truncated);
        assert_eq!(
            result.truncation_reasons,
            vec![SearchTruncationReason::TreeLimit]
        );

        fs::remove_dir_all(root).expect("root removed");
    }
}
