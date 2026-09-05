//! Plan stale metadata across every repository before asking system Git to prune.
use crate::{Error, Result, config::Workspace, git};
use serde_json::{Value, json};
use std::{collections::BTreeSet, fs, path::PathBuf};
struct RepositoryPlan {
    name: String,
    path: PathBuf,
    stale: Vec<Value>,
}
fn unsupported(message: impl Into<String>) -> Error {
    Error::new("RUST_NOT_YET_PORTED", message)
}
fn preflight(name: String, path: PathBuf) -> Result<RepositoryPlan> {
    for ancestor in path.ancestors() {
        if fs::symlink_metadata(ancestor)?.file_type().is_symlink() {
            return Err(unsupported(
                "Prune through symlinked repository paths is not yet supported; no metadata changed",
            ));
        }
    }
    let canonical = fs::canonicalize(&path)?;
    let worktrees = git::worktrees(&path)?;
    let primary = worktrees
        .first()
        .ok_or_else(|| unsupported("Git returned no primary worktree"))?;
    if primary.bare || fs::canonicalize(&primary.path)? != canonical {
        return Err(unsupported(
            "Prune requires primary non-bare repository checkouts; no metadata changed",
        ));
    }
    let top = git::run(&path, &["rev-parse", "--show-toplevel"])?;
    if fs::canonicalize(top.trim())? != canonical {
        return Err(unsupported(
            "Configured prune target is not a repository root; no metadata changed",
        ));
    }
    let stale=worktrees.into_iter().filter_map(|w|w.prune_reason.map(|reason|json!({"branch":w.branch.unwrap_or_default(),"isMain":w.path==canonical,"path":w.path,"pruneReason":reason,"repository":name}))).collect();
    Ok(RepositoryPlan {
        name,
        path: canonical,
        stale,
    })
}
/// `now` is the only supported expiry until Git's age-selection results can be reported accurately.
pub fn prune(w: &Workspace, dry_run: bool, expire: &str) -> Result<Value> {
    if expire != "now" {
        return Err(unsupported(
            "Rust prune currently supports only --expire now; no metadata changed",
        ));
    }
    let mut targets = vec![(
        w.root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        w.root.clone(),
    )];
    if let Some(config) = &w.config {
        for (name, repo) in &config.repos {
            let path = w.root.join(&repo.path);
            let canonical = fs::canonicalize(&path)?;
            if !canonical.starts_with(fs::canonicalize(&w.root)?) {
                return Err(unsupported(
                    "Prune of configured repositories outside the workspace is not yet supported; no metadata changed",
                ));
            }
            targets.push((name.clone(), path));
        }
    }
    let mut plans = Vec::new();
    let mut seen = BTreeSet::new();
    for (name, path) in targets {
        let canonical = fs::canonicalize(&path)?;
        if !seen.insert(canonical) {
            return Err(unsupported(
                "Duplicate configured repository identity; no metadata changed",
            ));
        }
        plans.push(preflight(name, path)?);
    }
    let total_prunable: usize = plans.iter().map(|p| p.stale.len()).sum();
    let mut rows = Vec::new();
    let mut pruned = 0;
    for plan in plans {
        let count = if !dry_run && !plan.stale.is_empty() {
            git::run(&plan.path, &["worktree", "prune", "--expire", expire])?;
            plan.stale.len()
        } else {
            0
        };
        pruned += count;
        rows.push(json!({"name":plan.name,"path":plan.path,"prunable":plan.stale,"prunedCount":count,"status":if count>0{"pruned"}else{"skipped"}}));
    }
    let mut data = json!({"dryRun":dry_run,"expire":expire,"overallStatus":"success","totalRepositories":rows.len(),"repositories":rows,"totalFailed":0,"totalPrunable":total_prunable,"totalPruned":pruned,"workspaceRoot":w.root,"mode":if w.config.is_some(){"configured"}else{"standalone"}});
    if w.config.is_some() {
        data["worktreesBase"] = w.metadata()["worktreesBase"].clone();
    } else {
        data["repositoryPath"] = json!(w.root);
    }
    Ok(data)
}
