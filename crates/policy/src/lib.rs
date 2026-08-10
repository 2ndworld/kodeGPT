#![forbid(unsafe_code)]

use std::collections::HashSet;
use std::fmt;

use kodegpt_protocol::{NetworkMode, ProfileName, RuntimePolicy};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyError {
    Escalation,
}

impl fmt::Display for PolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Escalation => formatter.write_str("policy restriction would escalate authority"),
        }
    }
}

impl std::error::Error for PolicyError {}

pub fn restrict_policy(
    current: &RuntimePolicy,
    restriction: &RuntimePolicy,
) -> Result<RuntimePolicy, PolicyError> {
    if profile_rank(&restriction.name) > profile_rank(&current.name)
        || (!current.allow_write && restriction.allow_write)
        || (!current.allow_process && restriction.allow_process)
        || network_rank(&restriction.network) > network_rank(&current.network)
        || !is_subset(
            &restriction.allowed_executable_names,
            &current.allowed_executable_names,
        )
        || !is_subset(&restriction.env_allowlist, &current.env_allowlist)
    {
        return Err(PolicyError::Escalation);
    }

    Ok(restriction.clone())
}

fn profile_rank(name: &ProfileName) -> u8 {
    match name {
        ProfileName::Observe => 0,
        ProfileName::Develop => 1,
        ProfileName::Trusted => 2,
    }
}

fn network_rank(mode: &NetworkMode) -> u8 {
    match mode {
        NetworkMode::Deny => 0,
        NetworkMode::Localhost => 1,
        NetworkMode::Allowlist => 2,
        NetworkMode::Unrestricted => 3,
    }
}

fn is_subset(candidate: &[String], current: &[String]) -> bool {
    let current: HashSet<&str> = current.iter().map(String::as_str).collect();
    candidate
        .iter()
        .all(|value| current.contains(value.as_str()))
}

#[cfg(test)]
mod tests {
    use kodegpt_protocol::{InheritEnvDisabled, NetworkMode, ProfileName, RuntimePolicy};

    use super::{PolicyError, restrict_policy};

    fn policy(
        name: ProfileName,
        allow_write: bool,
        allow_process: bool,
        network: NetworkMode,
        executables: &[&str],
        env: &[&str],
    ) -> RuntimePolicy {
        RuntimePolicy {
            name,
            allow_write,
            allow_process,
            network,
            allowed_executable_names: executables
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
            inherit_env: InheritEnvDisabled,
            env_allowlist: env.iter().map(|value| (*value).to_owned()).collect(),
        }
    }

    #[test]
    fn observe_ceiling_rejects_trusted_write_process_escalation() {
        let observe = policy(
            ProfileName::Observe,
            false,
            false,
            NetworkMode::Deny,
            &[],
            &[],
        );
        let trusted = policy(
            ProfileName::Trusted,
            true,
            true,
            NetworkMode::Unrestricted,
            &["python3"],
            &[],
        );

        assert!(matches!(
            restrict_policy(&observe, &trusted),
            Err(PolicyError::Escalation)
        ));
    }

    #[test]
    fn narrowed_develop_policy_cannot_later_widen() {
        let develop = policy(
            ProfileName::Develop,
            true,
            true,
            NetworkMode::Deny,
            &["node", "python3"],
            &["LANG"],
        );
        let narrowed = policy(
            ProfileName::Develop,
            false,
            true,
            NetworkMode::Deny,
            &["python3"],
            &["LANG"],
        );
        let effective = restrict_policy(&develop, &narrowed).expect("narrowing accepted");
        let widen = policy(
            ProfileName::Develop,
            true,
            true,
            NetworkMode::Deny,
            &["python3"],
            &["LANG"],
        );

        assert_eq!(effective, narrowed);
        assert!(matches!(
            restrict_policy(&effective, &widen),
            Err(PolicyError::Escalation)
        ));
    }

    #[test]
    fn network_and_allowlists_may_only_narrow() {
        let current = policy(
            ProfileName::Trusted,
            true,
            true,
            NetworkMode::Unrestricted,
            &["node", "python3"],
            &["LANG", "TERM"],
        );
        let narrowed = policy(
            ProfileName::Develop,
            true,
            true,
            NetworkMode::Localhost,
            &["python3"],
            &["LANG"],
        );
        assert!(restrict_policy(&current, &narrowed).is_ok());

        let widened_exec = policy(
            ProfileName::Develop,
            true,
            true,
            NetworkMode::Localhost,
            &["python3", "cargo"],
            &["LANG"],
        );
        assert!(matches!(
            restrict_policy(&narrowed, &widened_exec),
            Err(PolicyError::Escalation)
        ));
    }
}
