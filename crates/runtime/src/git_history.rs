use kodegpt_protocol::GitRevisionSpec;

const MAX_REF_BYTES: usize = 128;
const MAX_HISTORY_PATH_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GitHistoryError {
    RevisionInvalid,
    PathInvalid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ValidatedRevision {
    Head,
    Oid(String),
    LocalBranch(String),
    LocalTag(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ValidatedHistoryPath(String);

pub(crate) fn validate_revision(
    spec: GitRevisionSpec,
) -> Result<ValidatedRevision, GitHistoryError> {
    match spec {
        GitRevisionSpec::Head => Ok(ValidatedRevision::Head),
        GitRevisionSpec::Oid { oid } if valid_full_oid(&oid) => Ok(ValidatedRevision::Oid(oid)),
        GitRevisionSpec::Oid { .. } => Err(GitHistoryError::RevisionInvalid),
        GitRevisionSpec::Branch { name } if valid_local_ref_name(&name) => {
            Ok(ValidatedRevision::LocalBranch(name))
        }
        GitRevisionSpec::Branch { .. } => Err(GitHistoryError::RevisionInvalid),
        GitRevisionSpec::Tag { name } if valid_local_ref_name(&name) => {
            Ok(ValidatedRevision::LocalTag(name))
        }
        GitRevisionSpec::Tag { .. } => Err(GitHistoryError::RevisionInvalid),
    }
}

pub(crate) fn validate_history_path(
    path: Option<String>,
) -> Result<Option<ValidatedHistoryPath>, GitHistoryError> {
    let Some(path) = path else {
        return Ok(None);
    };

    let bytes = path.as_bytes();
    if path.is_empty()
        || bytes.len() > MAX_HISTORY_PATH_BYTES
        || path.starts_with('/')
        || path.starts_with(':')
        || bytes.iter().any(|byte| *byte <= 0x1f || *byte == 0x7f)
        || path
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
    {
        return Err(GitHistoryError::PathInvalid);
    }

    Ok(Some(ValidatedHistoryPath(path)))
}

fn valid_full_oid(oid: &str) -> bool {
    matches!(oid.len(), 40 | 64)
        && oid
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn valid_local_ref_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_REF_BYTES
        && !name.starts_with("refs/")
        && !name.contains("..")
        && !name.contains("@{")
        && name.split('/').all(valid_ref_component)
}

fn valid_ref_component(component: &str) -> bool {
    let bytes = component.as_bytes();
    !bytes.is_empty()
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && !component.ends_with(".lock")
        && !component.ends_with('.')
}

#[cfg(test)]
mod tests {
    use super::{
        GitHistoryError, ValidatedHistoryPath, ValidatedRevision, validate_history_path,
        validate_revision,
    };
    use kodegpt_protocol::GitRevisionSpec;

    #[test]
    fn revision_and_path_grammar_is_closed() {
        let accepted_revisions = [
            (GitRevisionSpec::Head, ValidatedRevision::Head),
            (
                GitRevisionSpec::Oid {
                    oid: "0123456789abcdef0123456789abcdef01234567".into(),
                },
                ValidatedRevision::Oid("0123456789abcdef0123456789abcdef01234567".into()),
            ),
            (
                GitRevisionSpec::Oid {
                    oid: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
                },
                ValidatedRevision::Oid(
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
                ),
            ),
            (
                GitRevisionSpec::Branch {
                    name: "feat/history-v1".into(),
                },
                ValidatedRevision::LocalBranch("feat/history-v1".into()),
            ),
            (
                GitRevisionSpec::Tag {
                    name: "v0.1".into(),
                },
                ValidatedRevision::LocalTag("v0.1".into()),
            ),
        ];

        for (input, expected) in accepted_revisions {
            assert_eq!(validate_revision(input), Ok(expected));
        }

        let rejected_revisions = [
            GitRevisionSpec::Branch {
                name: "--all".into(),
            },
            GitRevisionSpec::Branch {
                name: "--glob=refs/*".into(),
            },
            GitRevisionSpec::Branch {
                name: "HEAD~3".into(),
            },
            GitRevisionSpec::Branch {
                name: "HEAD^".into(),
            },
            GitRevisionSpec::Branch {
                name: "HEAD@{1}".into(),
            },
            GitRevisionSpec::Branch {
                name: ":/fix".into(),
            },
            GitRevisionSpec::Oid {
                oid: "0123456".into(),
            },
            GitRevisionSpec::Oid {
                oid: "ABCDEF0123456789ABCDEF0123456789ABCDEF01".into(),
            },
            GitRevisionSpec::Branch {
                name: "refs/heads/main".into(),
            },
            GitRevisionSpec::Branch {
                name: "feat//x".into(),
            },
            GitRevisionSpec::Branch {
                name: "feat/../x".into(),
            },
            GitRevisionSpec::Branch {
                name: "feat/.hidden".into(),
            },
            GitRevisionSpec::Branch {
                name: "feat/x.lock".into(),
            },
            GitRevisionSpec::Branch {
                name: "feat/x.".into(),
            },
            GitRevisionSpec::Branch {
                name: "foo@{bar".into(),
            },
        ];

        for input in rejected_revisions {
            assert_eq!(
                validate_revision(input),
                Err(GitHistoryError::RevisionInvalid)
            );
        }

        for path in ["src/main.rs", "docs/a b.md", "src/日本語.rs"] {
            let validated = validate_history_path(Some(path.into()))
                .expect("valid history path")
                .expect("present history path");
            assert_eq!(validated, ValidatedHistoryPath(path.into()));
        }
        assert_eq!(validate_history_path(None), Ok(None));

        let oversized = format!("src/{}", "é".repeat(2049));
        for path in [
            "/etc/passwd".to_owned(),
            ".".to_owned(),
            "..".to_owned(),
            "src/../secret".to_owned(),
            "src//file".to_owned(),
            ":!secret".to_owned(),
            "src/line\nbreak".to_owned(),
            "src/\0file".to_owned(),
            oversized,
        ] {
            assert_eq!(
                validate_history_path(Some(path)),
                Err(GitHistoryError::PathInvalid)
            );
        }
    }
}
