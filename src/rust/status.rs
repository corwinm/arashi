//! Local status rendering. Remote refresh and configured base policies fail explicitly.
use crate::{Error, Result, config::Workspace, git};
use serde_json::{Value, json};
use std::path::Path;
fn unsupported(message: &str) -> Error {
    Error::new("PORT_UNSUPPORTED", message)
}
fn repository(name: &str, path: &Path) -> Result<Value> {
    if !path.exists() {
        return Ok(
            json!({"baseBranch":null,"branch":{"ahead":0,"behind":0,"isDetached":true,"localBranch":"","remoteBranch":null},"defaultBranch":null,"error":format!("Repository is missing at {}. Run `arashi clone` to clone missing repositories.",path.display()),"files":[],"name":name,"path":path,"refreshWarning":null}),
        );
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
    let upstream = git::run(
        path,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .ok()
    .map(|s| s.trim().to_owned());
    if remote.is_some() {
        let current = git::run(path, &["symbolic-ref", "--short", "HEAD"])?;
        let branch = upstream
            .as_deref()
            .and_then(|s| s.strip_prefix("origin/"))
            .unwrap_or(current.trim());
        git::run(
            path,
            &[
                "fetch",
                "--prune",
                "origin",
                &format!("+refs/heads/{branch}:refs/remotes/origin/{branch}"),
            ],
        )?;
    }
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
                if remote.is_some() {
                    git::run(
                        path,
                        &[
                            "fetch",
                            "--prune",
                            "origin",
                            &format!("+refs/heads/{default}:{reference}"),
                        ],
                    )?;
                }
                let mut value = json!({"branch":default,"compareRef":reference,"remote":remote,"remoteRef":remote.map(|r|format!("{r}/{default}"))});
                if branch == default && remote.is_none() {
                    value["reason"] = json!("on-default-branch");
                    value["state"] = json!("skipped");
                } else {
                    let counts = git::run(
                        path,
                        &[
                            "rev-list",
                            "--left-right",
                            "--count",
                            &format!("HEAD...{reference}"),
                        ],
                    )?;
                    let counts: Vec<u64> = counts
                        .split_whitespace()
                        .map(str::parse)
                        .collect::<std::result::Result<_, _>>()
                        .map_err(|_| Error::new("GIT_ERROR", "Invalid revision counts"))?;
                    if counts.len() != 2 {
                        return Err(Error::new("GIT_ERROR", "Missing revision counts"));
                    }
                    value["ahead"] = json!(counts[0]);
                    value["behind"] = json!(counts[1]);
                    value["state"] = json!("available");
                }
                value
            }
        }
    };
    Ok(
        json!({"name":name,"path":path,"branch":{"ahead":ahead,"behind":behind,"isDetached":detached,"localBranch":branch,"remoteBranch":upstream},"baseBranch":null,"defaultBranch":default,"error":null,"files":files,"refreshWarning":null}),
    )
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
        let caller_root = git::run(cwd, &["rev-parse", "--show-toplevel"])?;
        if git::worktrees(cwd)?
            .first()
            .is_some_and(|w| w.path != Path::new(caller_root.trim()))
        {
            return Err(unsupported(
                "Configured linked execution-root projection is not yet ported",
            ));
        }
        if git::worktrees(&workspace.root)?.first().is_some_and(|w| {
            !crate::paths::same_existing(&w.path, &workspace.root).unwrap_or(false)
        }) {
            return Err(unsupported(
                "Configured linked execution-root projection is not yet ported",
            ));
        }

        if config.raw.get("baseBranch").is_some()
            || config
                .raw
                .get("meta")
                .and_then(|m| m.get("baseBranch"))
                .is_some()
            || config
                .repos
                .values()
                .any(|r| r.raw.get("baseBranch").is_some())
        {
            return Err(unsupported(
                "Configured base-branch status policies are not yet ported",
            ));
        }
        let mut statuses = vec![repository("Main Repository", &workspace.root)?];
        for name in selected {
            let repo = &config.repos[&name];
            statuses.push(repository(&name, &workspace.root.join(&repo.path))?);
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
    let mut statuses = Vec::new();
    for w in git::worktrees(&workspace.root)? {
        if w.bare {
            return Err(unsupported("Bare repository status is not yet ported"));
        }
        statuses.push(repository(
            w.branch
                .as_deref()
                .unwrap_or_else(|| w.path.file_name().and_then(|s| s.to_str()).unwrap_or("")),
            &w.path,
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
