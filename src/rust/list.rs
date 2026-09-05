//! Read-only worktree listing. Payload fields follow commands/list.ts and core/list.ts.
use crate::{Error, Result, config::Workspace, git};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub fn list(workspace: &Workspace) -> Result<Value> {
    list_mode(workspace, false)
}
pub fn ordinary(root: std::path::PathBuf) -> Result<Value> {
    list_mode(&Workspace { root, config: None }, true)
}
fn list_mode(workspace: &Workspace, ordinary: bool) -> Result<Value> {
    let records = git::worktrees(&workspace.root)?;
    if records.iter().any(|record| record.bare) {
        return Err(Error::new(
            "UNSUPPORTED_TOPOLOGY",
            "Bare worktree listing is not yet supported by the Rust port",
        ));
    }
    let mut payload = if ordinary {
        json!({})
    } else {
        workspace.metadata()
    };
    let mut rows = Vec::new();
    let mut lock_reasons = BTreeMap::new();
    if workspace.config.is_some() || ordinary {
        let raw = git::run(&workspace.root, &["worktree", "list", "--porcelain", "-z"])?;
        let mut path = "";
        for field in raw.split('\0') {
            if let Some(value) = field.strip_prefix("worktree ") {
                path = value;
            }
            if let Some(value) = field.strip_prefix("locked ") {
                lock_reasons.insert(path.to_owned(), value.to_owned());
            }
        }
    }
    for (index, record) in records.into_iter().enumerate() {
        let mut row = if workspace.config.is_none() && !ordinary {
            let mut row = json!({"branch":record.branch,"head":record.head,"path":record.path});
            if let Some(reason) = record.prune_reason {
                row["pruneReason"] = json!(reason);
            }
            row
        } else {
            // The source reports inaccessible/prunable worktrees as having no changes.
            let dirty = git::run(&record.path, &["status", "--porcelain"])
                .is_ok_and(|s| !s.trim().is_empty());
            json!({"branch":record.branch,"commit":record.head.chars().take(7).collect::<String>(),"hasChanges":dirty,"isMain":index==0,"locked":record.locked,"path":record.path})
        };
        if let Some(reason) = lock_reasons.get(&record.path.to_string_lossy().to_string()) {
            row["lockReason"] = json!(reason);
        }
        rows.push(row);
    }
    payload["worktrees"] = json!(rows);
    if workspace.config.is_none() && !ordinary {
        payload["repositoryPath"] = json!(workspace.root);
    }
    Ok(payload)
}
