use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

static NEXT_EXECUTION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutionKind {
    Process,
    Git,
    Probe,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionRecord {
    pub execution_id: String,
    pub workspace_capability: String,
    pub started_at: SystemTime,
    pub process_group: i32,
    pub kind: ExecutionKind,
}

#[derive(Debug, Default)]
pub struct ExecutionRegistry {
    records: HashMap<String, ExecutionRecord>,
}

impl ExecutionRegistry {
    pub fn register(
        &mut self,
        workspace_capability: String,
        process_group: i32,
        kind: ExecutionKind,
    ) -> ExecutionRecord {
        let execution_id = next_execution_id();
        let record = ExecutionRecord {
            execution_id: execution_id.clone(),
            workspace_capability,
            started_at: SystemTime::now(),
            process_group,
            kind,
        };
        self.records.insert(execution_id, record.clone());
        record
    }

    pub fn get(&self, execution_id: &str) -> Option<&ExecutionRecord> {
        self.records.get(execution_id)
    }

    pub fn remove(&mut self, execution_id: &str) -> Option<ExecutionRecord> {
        self.records.remove(execution_id)
    }

    pub fn ids_for_workspace(&self, workspace_capability: &str) -> Vec<String> {
        let mut ids = self
            .records
            .values()
            .filter(|record| record.workspace_capability == workspace_capability)
            .map(|record| record.execution_id.clone())
            .collect::<Vec<_>>();
        ids.sort();
        ids
    }
}

fn next_execution_id() -> String {
    let sequence = NEXT_EXECUTION_ID.fetch_add(1, Ordering::Relaxed);
    format!("ex_{}_{}", std::process::id(), sequence)
}

#[cfg(test)]
mod tests {
    use super::{ExecutionKind, ExecutionRegistry};

    #[test]
    fn registry_uses_private_opaque_execution_ids_and_workspace_indexing() {
        let mut registry = ExecutionRegistry::default();
        let first = registry.register("kc_a".to_owned(), 123, ExecutionKind::Process);
        let second = registry.register("kc_a".to_owned(), 124, ExecutionKind::Git);
        let third = registry.register("kc_b".to_owned(), 125, ExecutionKind::Probe);

        assert!(first.execution_id.starts_with("ex_"));
        assert!(!first.execution_id.contains('/'));
        assert!(!first.execution_id.contains(".."));
        assert_eq!(first.process_group, 123);
        assert_eq!(registry.ids_for_workspace("kc_a").len(), 2);
        assert_eq!(registry.ids_for_workspace("kc_b"), vec![third.execution_id]);
        assert_eq!(registry.get(&second.execution_id), Some(&second));
        assert_eq!(registry.remove(&first.execution_id), Some(first));
    }
}
