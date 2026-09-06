//! Status comparisons against local filesystem remotes and configured bases.
use crate::{Error, Result, config::Workspace, git};
use serde_json::{Value, json};
use std::path::Path;
fn unsupported(message: &str) -> Error {
    Error::new("PORT_UNSUPPORTED", message)
}
fn repository(name: &str, path: &Path, base: Option<(&str, &str)>, verbose: bool) -> Result<Value> {
    if !path.exists() {
        return Ok(
            json!({"baseBranch":null,"branch":{"ahead":0,"behind":0,"isDetached":true,"localBranch":"","remoteBranch":null},"defaultBranch":null,"error":format!("Repository is missing at {}. Run `arashi clone` to clone missing repositories.",path.display()),"files":[],"name":name,"path":path,"refreshWarning":null}),
        );
    }
    let remote = supported_remote(path)?;
    let upstream = git::run(
        path,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .ok()
    .map(|s| s.trim().to_owned());
    let tracking_failure = if remote.is_some()
        && let Ok(current) = git::run(path, &["symbolic-ref", "--short", "HEAD"])
    {
        let branch = upstream
            .as_deref()
            .and_then(|s| s.strip_prefix("origin/"))
            .unwrap_or(current.trim());
        refresh(path, branch)
    } else {
        None
    };
    let refresh_warning = tracking_failure.as_ref().map(|failure| {
        if failure["kind"] == "missing-remote-ref" {
            json!({"kind":"missing-remote-ref","message":failure["message"]})
        } else {
            json!({"kind":"stale-remote-tracking","message":format!("Remote tracking may be stale: {}", failure["error"].as_str().unwrap())})
        }
    });
    let output = git::run(path, &["status", "--porcelain=v1", "--branch"])?;
    let mut lines = output.lines();
    let heading = lines.next().unwrap_or("## HEAD (no branch)");
    let branch = heading.strip_prefix("## ").unwrap_or(heading);
    let detached = branch.starts_with("HEAD (no branch)");
    let branch = if detached {
        ""
    } else {
        branch.split("...").next().unwrap_or(branch)
    };
    let (ahead, behind) = if let Some(ref upstream) = upstream {
        counts(path, upstream)?
    } else {
        (0, 0)
    };
    let files: Vec<Value> = lines
        .filter(|s| s.len() >= 3)
        .map(|s| json!({"path":&s[3..],"stagingStatus":&s[..1],"workingStatus":&s[1..2]}))
        .collect();
    let base_comparison = if let Some((branch, _)) = base {
        let branch = branch.strip_prefix("origin/").unwrap_or(branch);
        if remote.is_none() {
            let message = format!("No remote is available for configured base branch '{branch}'");
            json!({"branch":branch,"compareRef":null,"details":{"error":message},"message":message,"reason":"unresolved-target","remote":null,"remoteRef":null,"state":"unavailable"})
        } else {
            let reference = format!("refs/remotes/origin/{branch}");
            let mut comparison = json!({"branch":branch,"compareRef":reference,"remote":"origin","remoteRef":format!("origin/{branch}")});
            if detached {
                comparison["reason"] = json!("detached-head");
                comparison["state"] = json!("skipped");
            } else {
                let failure = if upstream.as_deref() == Some(&format!("origin/{branch}")) {
                    tracking_failure.clone()
                } else {
                    refresh(path, branch)
                };
                finish_comparison(path, &reference, &mut comparison, failure);
            }
            comparison
        }
    } else {
        Value::Null
    };
    let default = if detached {
        json!({"branch":null,"reason":"detached-head","state":"skipped"})
    } else {
        let default_name = git::default_branch(path).ok();
        let default = default_name.as_deref();
        match default {
            None => json!({"branch":null,"reason":"unresolved","state":"skipped"}),
            Some(default) => {
                let reference = if remote.is_some() {
                    format!("refs/remotes/origin/{default}")
                } else {
                    format!("refs/heads/{default}")
                };
                let mut value = json!({"branch":default,"compareRef":reference,"remote":remote,"remoteRef":remote.map(|r|format!("{r}/{default}"))});
                if branch == default && remote.is_none() {
                    value["reason"] = json!("on-default-branch");
                    value["state"] = json!("skipped");
                } else if base_comparison["compareRef"] == reference {
                    value = base_comparison.clone();
                } else {
                    let failure = if upstream.as_deref() == Some(&format!("origin/{default}")) {
                        tracking_failure.clone()
                    } else if remote.is_some() {
                        refresh(path, default)
                    } else {
                        None
                    };
                    finish_comparison(path, &reference, &mut value, failure);
                }
                value
            }
        }
    };
    let mut value = json!({"name":name,"path":path,"branch":{"ahead":ahead,"behind":behind,"isDetached":detached,"localBranch":branch,"remoteBranch":upstream},"baseBranch":base_comparison,"defaultBranch":default,"error":null,"files":files,"refreshWarning":refresh_warning});
    if let Some((_, source)) = base {
        value["baseBranchSource"] = json!(source);
    }
    if verbose {
        value["fullStatus"] = json!(
            git::run(path, &["status"])
                .map(|s| s.trim().to_owned())
                .unwrap_or_else(|e| format!("Git command failed: {}", e.message))
        );
    }
    Ok(value)
}
pub fn status(workspace: &Workspace, cwd: &Path) -> Result<Value> {
    status_filtered(
        workspace,
        cwd,
        &crate::cli::Args {
            command: "status".into(),
            options: Default::default(),
            positional: vec![],
        },
    )
}
pub fn status_filtered(
    workspace: &Workspace,
    cwd: &Path,
    args: &crate::cli::Args,
) -> Result<Value> {
    if let Some(config) = &workspace.config {
        let (selected, filters) = crate::selection::select(config, args)?;
        // Non-bare configured checkouts own their local configuration. Child-only
        // trees without a copied config continue to use the ancestor workspace.
        // Validate every selected remote before the first fetch can update refs.
        supported_remote(&workspace.root)?;
        for name in &selected {
            let path = crate::paths::lexical(workspace.root.join(&config.repos[name].path));
            if path.exists() {
                supported_remote(&path)?;
            }
        }
        let base = |repository: &Value| {
            repository["baseBranch"]
                .as_str()
                .map(|branch| (branch.to_owned(), "repository-config"))
                .or_else(|| {
                    config.raw["baseBranch"]
                        .as_str()
                        .map(|branch| (branch.to_owned(), "workspace-config"))
                })
        };
        let meta_base = base(&config.raw["meta"]);
        let mut statuses = vec![repository(
            "Main Repository",
            &workspace.root,
            meta_base
                .as_ref()
                .map(|(branch, source)| (branch.as_str(), *source)),
            args.has("verbose"),
        )?];
        for name in selected {
            let repo = &config.repos[&name];
            let repo_base = base(&repo.raw);
            let path = crate::paths::lexical(workspace.root.join(&repo.path));
            statuses.push(repository(
                &name,
                &path,
                repo_base
                    .as_ref()
                    .map(|(branch, source)| (branch.as_str(), *source)),
                args.has("verbose"),
            )?);
        }
        let clean = statuses
            .iter()
            .filter(|s| s["files"].as_array().is_some_and(Vec::is_empty) && s["error"].is_null())
            .count();
        return Ok(
            json!({"filters":filters,"mode":"configured","repositories":statuses,"summary":{"cleanCount":clean,"dirtyCount":statuses.len()-clean,"total":statuses.len()},"workspaceRoot":workspace.root,"worktreesBase":workspace.metadata()["worktreesBase"]}),
        );
    }
    let supplied: Vec<_> = ["only", "group"]
        .into_iter()
        .filter(|key| args.has(key))
        .map(|key| format!("--{key}"))
        .collect();
    if !supplied.is_empty() {
        return Err(Error::new(
            "STANDALONE_FILTER_UNSUPPORTED",
            format!(
                "{} {} not meaningful in standalone mode",
                supplied.join(" and "),
                if supplied.len() == 1 { "is" } else { "are" }
            ),
        )
        .with_exit_code(2));
    }
    let worktrees = git::worktrees(&workspace.root)?;
    for w in &worktrees {
        if w.bare {
            return Err(unsupported("Bare repository status is not yet ported"));
        }
        if w.path.exists() {
            supported_remote(&w.path)?;
        }
    }
    let mut statuses = Vec::new();
    for w in worktrees {
        if w.bare {
            return Err(unsupported("Bare repository status is not yet ported"));
        }
        statuses.push(repository(
            w.branch
                .as_deref()
                .unwrap_or_else(|| w.path.file_name().and_then(|s| s.to_str()).unwrap_or("")),
            &w.path,
            None,
            args.has("verbose"),
        )?);
    }
    let caller = crate::paths::canonicalize(cwd)?;
    let current = statuses
        .iter()
        .find(|s| {
            s["path"]
                .as_str()
                .is_some_and(|path| Path::new(path) == caller)
        })
        .map(|s| s["branch"]["localBranch"].clone())
        .unwrap_or(Value::Null);
    let clean = statuses
        .iter()
        .filter(|s| s["files"].as_array().is_some_and(Vec::is_empty) && s["error"].is_null())
        .count();
    Ok(
        json!({"callerWorktree":caller,"currentBranch":current,"mode":"standalone","repositoryPath":workspace.root,"summary":{"cleanCount":clean,"dirtyCount":statuses.len()-clean,"total":statuses.len()},"workspaceRoot":workspace.root,"worktrees":statuses,"worktreesBase":workspace.root.join(".worktrees")}),
    )
}

fn counts(path: &Path, reference: &str) -> Result<(u64, u64)> {
    let value = git::run(
        path,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("HEAD...{reference}"),
        ],
    )?;
    let values = value
        .split_whitespace()
        .map(str::parse)
        .collect::<std::result::Result<Vec<u64>, _>>()
        .map_err(|_| Error::new("GIT_ERROR", "Invalid revision counts"))?;
    if values.len() != 2 {
        return Err(Error::new("GIT_ERROR", "Missing revision counts"));
    }
    Ok((values[0], values[1]))
}

/// Warnings are envelope metadata; unavailable comparisons do not fail status.
pub fn warnings(data: &Value) -> Vec<Value> {
    let mut warnings = vec![];
    if let Some(rows) = data["repositories"]
        .as_array()
        .or_else(|| data["worktrees"].as_array())
    {
        for row in rows {
            if let Some(kind) = row["refreshWarning"]["kind"].as_str() {
                warnings.push(json!({"code":kind.to_uppercase().replace('-', "_"),"details":{"repository":row["name"]},"message":row["refreshWarning"]["message"]}));
            }
            if row["defaultBranch"]["state"] == "unavailable"
                && (row["baseBranch"]["compareRef"].is_null()
                    || row["baseBranch"]["compareRef"] != row["defaultBranch"]["compareRef"])
            {
                warnings.push(json!({"code":"DEFAULT_BRANCH_COMPARISON_UNAVAILABLE","details":{"repository":row["name"]},"message":row["defaultBranch"]["message"]}));
            }
            if row["baseBranch"]["state"] == "unavailable" {
                warnings.push(json!({"code":"BASE_BRANCH_COMPARISON_UNAVAILABLE","details":{"branch":row["baseBranch"]["branch"],"repository":row["name"]},"message":row["baseBranch"]["message"]}));
            }
        }
    }
    warnings
}

fn supported_remote(path: &Path) -> Result<Option<&'static str>> {
    if let Ok(values) = git::run(path, &["config", "--get-regexp", r"^branch\..*\.remote$"])
        && values.lines().any(|line| {
            line.split_once(' ')
                .is_some_and(|(_, remote)| remote != "origin")
        })
    {
        return Err(unsupported(
            "Non-origin branch tracking policies are not yet ported; no fetch attempted",
        ));
    }
    let remotes = git::run(path, &["remote"])?;
    let remote = if remotes.trim().is_empty() {
        None
    } else {
        if remotes.trim() != "origin" {
            return Err(unsupported(
                "Multiple or non-origin status remotes are not yet ported",
            ));
        }
        let url = git::run(path, &["remote", "get-url", "origin"])?;
        let url = url.trim().strip_prefix("file://").unwrap_or(url.trim());
        if !Path::new(url).is_absolute() || !Path::new(url).is_dir() {
            return Err(unsupported(
                "Remote-refresh status currently supports local filesystem remotes only; no network operation attempted",
            ));
        }
        Some("origin")
    };
    Ok(remote)
}

fn refresh(path: &Path, branch: &str) -> Option<Value> {
    let error = git::run(
        path,
        &[
            "fetch",
            "--prune",
            "origin",
            &format!("+refs/heads/{branch}:refs/remotes/origin/{branch}"),
        ],
    )
    .err()?;
    let message = format!("Git command failed: {}", error.message);
    let missing = ["couldn't find remote ref ", "could not find remote ref "]
        .iter()
        .find_map(|prefix| {
            message
                .split_once(prefix)
                .map(|(_, rest)| rest.split_whitespace().next().unwrap_or(""))
        });
    Some(if let Some(reference) = missing {
        json!({"error":message,"kind":"missing-remote-ref","message":format!("couldn't find remote ref {reference}")})
    } else {
        json!({"error":message,"kind":"generic","message":message})
    })
}

fn finish_comparison(path: &Path, reference: &str, value: &mut Value, failure: Option<Value>) {
    if let Some(failure) = failure {
        value["details"] = json!({"error":failure["error"],"kind":failure["kind"]});
        value["message"] = failure["message"].clone();
        value["reason"] = json!("refresh-failed");
        value["state"] = json!("unavailable");
        return;
    }
    match counts(path, reference) {
        Ok((ahead, behind)) => {
            value["ahead"] = json!(ahead);
            value["behind"] = json!(behind);
            value["state"] = json!("available");
        }
        Err(error) => {
            let message = format!("Git command failed: {}", error.message);
            value["details"] = json!({"error":message});
            value["message"] = json!(message);
            value["reason"] = json!("comparison-failed");
            value["state"] = json!("unavailable");
        }
    }
}
