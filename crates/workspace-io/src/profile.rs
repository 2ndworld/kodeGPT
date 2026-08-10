use std::fmt;
use std::fs::File;
use std::io::Read;
use std::os::fd::OwnedFd;
use std::path::Path;

use rustix::fs::{FileType, OFlags, fstat};

use crate::openat::{OpenatBoundaryError, open_existing_beneath};

const PROJECT_PROFILE_PATH: &str = ".kodegpt/profile.json";
const PROJECT_PROFILE_MAX_BYTES: u64 = 64 * 1024;

#[derive(Debug)]
pub(crate) enum ProjectProfileReadError {
    BoundaryUnavailable,
    Unsafe,
    TooLarge,
    InvalidUtf8,
    Io(std::io::Error),
}

impl fmt::Display for ProjectProfileReadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BoundaryUnavailable => formatter.write_str("openat2 boundary is unavailable"),
            Self::Unsafe => formatter
                .write_str("project profile is not safely readable beneath the workspace root"),
            Self::TooLarge => formatter.write_str("project profile exceeds the 64 KiB limit"),
            Self::InvalidUtf8 => formatter.write_str("project profile must be UTF-8"),
            Self::Io(error) => write!(formatter, "project profile read failed: {error}"),
        }
    }
}

impl std::error::Error for ProjectProfileReadError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::BoundaryUnavailable | Self::Unsafe | Self::TooLarge | Self::InvalidUtf8 => None,
        }
    }
}

pub(crate) fn read_project_profile(
    root_fd: &OwnedFd,
) -> Result<Option<String>, ProjectProfileReadError> {
    let fd = match open_existing_beneath(
        root_fd,
        Path::new(PROJECT_PROFILE_PATH),
        OFlags::RDONLY | OFlags::NONBLOCK,
    ) {
        Ok(fd) => fd,
        Err(OpenatBoundaryError::NotFound) => return Ok(None),
        Err(OpenatBoundaryError::BoundaryUnavailable) => {
            return Err(ProjectProfileReadError::BoundaryUnavailable);
        }
        Err(
            OpenatBoundaryError::InvalidRelativePath
            | OpenatBoundaryError::BoundaryViolation
            | OpenatBoundaryError::Os(_),
        ) => return Err(ProjectProfileReadError::Unsafe),
    };

    let stat = fstat(&fd).map_err(|_| ProjectProfileReadError::Unsafe)?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(ProjectProfileReadError::Unsafe);
    }
    if stat.st_size < 0 || stat.st_size as u64 > PROJECT_PROFILE_MAX_BYTES {
        return Err(ProjectProfileReadError::TooLarge);
    }

    let file = File::from(fd);
    let mut bytes =
        Vec::with_capacity((stat.st_size as usize).min(PROJECT_PROFILE_MAX_BYTES as usize));
    file.take(PROJECT_PROFILE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(ProjectProfileReadError::Io)?;
    if bytes.len() as u64 > PROJECT_PROFILE_MAX_BYTES {
        return Err(ProjectProfileReadError::TooLarge);
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| ProjectProfileReadError::InvalidUtf8)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{ProjectProfileReadError, read_project_profile};

    fn temporary_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "kodegpt-profile-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temporary root created");
        root
    }

    #[test]
    fn reads_only_the_hard_coded_profile_beneath_a_retained_root_fd() {
        let root = temporary_root("inside");
        fs::create_dir(root.join(".kodegpt")).expect("profile directory created");
        fs::write(root.join(".kodegpt/profile.json"), "{\"name\":\"observe\"}")
            .expect("profile written");
        let root_fd = fs::File::open(&root).expect("root fd opened").into();

        assert_eq!(
            read_project_profile(&root_fd).expect("profile read"),
            Some("{\"name\":\"observe\"}".to_owned())
        );
        fs::remove_dir_all(root).expect("temporary root removed");
    }

    #[test]
    fn missing_profile_is_none_but_outside_symlink_is_rejected() {
        let root = temporary_root("symlink-root");
        let outside = temporary_root("symlink-outside");
        let root_fd = fs::File::open(&root).expect("root fd opened").into();
        assert_eq!(
            read_project_profile(&root_fd).expect("missing profile allowed"),
            None
        );

        fs::create_dir(root.join(".kodegpt")).expect("profile directory created");
        fs::write(outside.join("profile.json"), "{}").expect("outside profile written");
        symlink(
            outside.join("profile.json"),
            root.join(".kodegpt/profile.json"),
        )
        .expect("outside symlink created");
        assert!(matches!(
            read_project_profile(&root_fd),
            Err(ProjectProfileReadError::Unsafe)
        ));

        fs::remove_dir_all(root).expect("root removed");
        fs::remove_dir_all(outside).expect("outside removed");
    }
}
