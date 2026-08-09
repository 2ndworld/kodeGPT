use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::os::unix::ffi::OsStringExt;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MountInfoEntry {
    pub(crate) device_major: u32,
    pub(crate) device_minor: u32,
    pub(crate) root: PathBuf,
    pub(crate) mount_point: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BackingTreeIdentity {
    pub(crate) device_major: u32,
    pub(crate) device_minor: u32,
    pub(crate) path: PathBuf,
}

#[derive(Debug)]
pub(crate) enum MountInfoError {
    Io(std::io::Error),
    Malformed,
    NoCoveringMount,
}

impl fmt::Display for MountInfoError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "mount topology read failed: {error}"),
            Self::Malformed => formatter.write_str("mount topology is malformed"),
            Self::NoCoveringMount => formatter.write_str("mount topology has no covering mount"),
        }
    }
}

impl std::error::Error for MountInfoError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Malformed | Self::NoCoveringMount => None,
        }
    }
}

pub(crate) fn read_current_mountinfo() -> Result<Vec<MountInfoEntry>, MountInfoError> {
    let text = fs::read_to_string("/proc/self/mountinfo").map_err(MountInfoError::Io)?;
    parse_mountinfo(&text)
}

pub(crate) fn parse_mountinfo(text: &str) -> Result<Vec<MountInfoEntry>, MountInfoError> {
    if text.is_empty() {
        return Err(MountInfoError::Malformed);
    }

    let mut entries = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            return Err(MountInfoError::Malformed);
        }
        let fields: Vec<&str> = line.split_ascii_whitespace().collect();
        let separator = fields
            .iter()
            .position(|field| *field == "-")
            .ok_or(MountInfoError::Malformed)?;
        if separator < 6 || separator + 3 >= fields.len() {
            return Err(MountInfoError::Malformed);
        }

        fields[0]
            .parse::<u64>()
            .map_err(|_| MountInfoError::Malformed)?;
        fields[1]
            .parse::<u64>()
            .map_err(|_| MountInfoError::Malformed)?;
        let (device_major, device_minor) = parse_device(fields[2])?;
        let root = decode_mount_path(fields[3])?;
        let mount_point = decode_mount_path(fields[4])?;
        if !mount_point.is_absolute() {
            return Err(MountInfoError::Malformed);
        }
        let root = if root.is_absolute() {
            normalize_absolute(&root)?
        } else {
            root
        };

        entries.push(MountInfoEntry {
            device_major,
            device_minor,
            root,
            mount_point: normalize_absolute(&mount_point)?,
        });
    }

    if entries.is_empty() {
        return Err(MountInfoError::Malformed);
    }
    Ok(entries)
}

pub(crate) fn backing_tree_for_path(
    entries: &[MountInfoEntry],
    path: &Path,
) -> Result<BackingTreeIdentity, MountInfoError> {
    if !path.is_absolute() {
        return Err(MountInfoError::Malformed);
    }
    let path = normalize_absolute(path)?;
    let entry = entries
        .iter()
        .filter(|entry| path.starts_with(&entry.mount_point))
        .max_by_key(|entry| entry.mount_point.components().count())
        .ok_or(MountInfoError::NoCoveringMount)?;
    let relative = path
        .strip_prefix(&entry.mount_point)
        .map_err(|_| MountInfoError::NoCoveringMount)?;
    let backing_path = normalize_absolute(&entry.root.join(relative))?;

    Ok(BackingTreeIdentity {
        device_major: entry.device_major,
        device_minor: entry.device_minor,
        path: backing_path,
    })
}

fn parse_device(value: &str) -> Result<(u32, u32), MountInfoError> {
    let (major, minor) = value.split_once(':').ok_or(MountInfoError::Malformed)?;
    if major.is_empty() || minor.is_empty() || minor.contains(':') {
        return Err(MountInfoError::Malformed);
    }
    let major = major.parse::<u32>().map_err(|_| MountInfoError::Malformed)?;
    let minor = minor.parse::<u32>().map_err(|_| MountInfoError::Malformed)?;
    Ok((major, minor))
}

fn decode_mount_path(value: &str) -> Result<PathBuf, MountInfoError> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'\\' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        if index + 3 >= bytes.len() {
            return Err(MountInfoError::Malformed);
        }
        let digits = &bytes[index + 1..index + 4];
        if !digits.iter().all(|byte| matches!(byte, b'0'..=b'7')) {
            return Err(MountInfoError::Malformed);
        }
        let value = u16::from(digits[0] - b'0') * 64
            + u16::from(digits[1] - b'0') * 8
            + u16::from(digits[2] - b'0');
        let byte = u8::try_from(value).map_err(|_| MountInfoError::Malformed)?;
        decoded.push(byte);
        index += 4;
    }
    Ok(PathBuf::from(OsString::from_vec(decoded)))
}

fn normalize_absolute(path: &Path) -> Result<PathBuf, MountInfoError> {
    if !path.is_absolute() {
        return Err(MountInfoError::Malformed);
    }

    let mut normalized = PathBuf::from("/");
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::CurDir => {}
            Component::Normal(part) => normalized.push(part),
            Component::ParentDir => {
                if normalized == Path::new("/") || !normalized.pop() {
                    return Err(MountInfoError::Malformed);
                }
            }
            Component::Prefix(_) => return Err(MountInfoError::Malformed),
        }
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{backing_tree_for_path, parse_mountinfo};

    #[test]
    fn mountinfo_decodes_escaped_spaces_and_backslashes() {
        let entries = parse_mountinfo(
            "101 42 8:1 /projects\\040main /mnt/work\\040tree rw,relatime - ext4 /dev/sda1 rw\n\
             102 42 8:1 /source\\134tree /mnt/alias\\134name rw,relatime - ext4 /dev/sda1 rw\n",
        )
        .expect("mountinfo parses");

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].root, Path::new("/projects main"));
        assert_eq!(entries[0].mount_point, Path::new("/mnt/work tree"));
        assert_eq!(entries[1].root, Path::new("/source\\tree"));
        assert_eq!(entries[1].mount_point, Path::new("/mnt/alias\\name"));
    }

    #[test]
    fn bind_mounts_normalize_to_the_same_backing_tree() {
        let entries = parse_mountinfo(
            "201 42 8:1 /srv/repos /work/visible-a rw,relatime - ext4 /dev/sda1 rw\n\
             202 42 8:1 /srv/repos /work/visible-b rw,relatime - ext4 /dev/sda1 rw\n",
        )
        .expect("mountinfo parses");

        let left = backing_tree_for_path(&entries, Path::new("/work/visible-a/project"))
            .expect("left backing tree");
        let right = backing_tree_for_path(&entries, Path::new("/work/visible-b/project"))
            .expect("right backing tree");

        assert_eq!(left.device_major, 8);
        assert_eq!(left.device_minor, 1);
        assert_eq!(left.path, Path::new("/srv/repos/project"));
        assert_eq!(left, right);
    }

    #[test]
    fn mountinfo_rejects_out_of_range_octal_escape_without_panicking() {
        assert!(
            parse_mountinfo(
                "301 42 8:1 /bad\\777root /mnt/work rw,relatime - ext4 /dev/sda1 rw\n"
            )
            .is_err()
        );
    }

    #[test]
    fn opaque_filesystem_root_is_parseable_but_not_a_backing_path_authority() {
        let entries = parse_mountinfo(
            "2110 213 0:5 mnt:[4026532641] /run/snapd/ns/cups.mnt rw - nsfs nsfs rw\n",
        )
        .expect("valid nsfs mountinfo parses");

        assert_eq!(entries[0].root, Path::new("mnt:[4026532641]"));
        assert!(
            backing_tree_for_path(&entries, Path::new("/run/snapd/ns/cups.mnt")).is_err(),
            "opaque fs roots cannot be normalized into backing-tree paths"
        );
    }

    #[test]
    fn current_mountinfo_parses_and_matches_temp_directory_device() {
        use std::fs;
        use std::os::unix::fs::MetadataExt;

        let path = fs::canonicalize(std::env::temp_dir()).expect("temp dir canonicalizes");
        let entries = super::read_current_mountinfo().expect("current mountinfo parses");
        let backing = backing_tree_for_path(&entries, &path).expect("temp dir is covered");
        let device = fs::metadata(&path).expect("temp metadata").dev();

        assert_eq!(backing.device_major, libc::major(device) as u32);
        assert_eq!(backing.device_minor, libc::minor(device) as u32);
    }
}
