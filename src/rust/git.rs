//! System Git adapter. No shell interpolation; machine output is parsed as NUL records.
use crate::{Error, Result};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
#[derive(Debug, Clone)]
pub struct Worktree {
    pub path: PathBuf,
    pub branch: Option<String>,
    pub head: String,
    pub bare: bool,
    pub locked: bool,
    pub prune_reason: Option<String>,
}
pub fn run(cwd: &Path, args: &[&str]) -> Result<String> {
    run_with_optional_locks(cwd, args, None)
}

pub fn run_readonly(cwd: &Path, args: &[&str]) -> Result<String> {
    run_with_optional_locks(cwd, args, Some(false))
}

fn run_with_optional_locks(
    cwd: &Path,
    args: &[&str],
    optional_locks: Option<bool>,
) -> Result<String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null());
    if let Some(enabled) = optional_locks {
        command.env("GIT_OPTIONAL_LOCKS", if enabled { "1" } else { "0" });
    }
    let output = command.output()?;
    if !output.status.success() {
        return Err(Error::new(
            "GIT_ERROR",
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }
    String::from_utf8(output.stdout)
        .map_err(|_| Error::new("UNSUPPORTED_ENCODING", "Git output is not UTF-8"))
}
pub fn worktrees(cwd: &Path) -> Result<Vec<Worktree>> {
    parse_worktrees(run(cwd, &["worktree", "list", "--porcelain", "-z"])?)
}

pub fn worktrees_readonly(cwd: &Path) -> Result<Vec<Worktree>> {
    parse_worktrees(run_readonly(
        cwd,
        &["worktree", "list", "--porcelain", "-z"],
    )?)
}

fn parse_worktrees(output: String) -> Result<Vec<Worktree>> {
    let mut records: Vec<Worktree> = vec![];
    for field in output.split('\0') {
        if let Some(path) = field.strip_prefix("worktree ") {
            records.push(Worktree {
                path: PathBuf::from(path),
                branch: None,
                head: String::new(),
                bare: false,
                locked: false,
                prune_reason: None,
            });
        } else if let Some(record) = records.last_mut() {
            if let Some(head) = field.strip_prefix("HEAD ") {
                record.head = head.into();
            } else if let Some(branch) = field.strip_prefix("branch refs/heads/") {
                record.branch = Some(branch.into());
            } else if field == "bare" {
                record.bare = true;
            } else if field.starts_with("locked") {
                record.locked = true;
            } else if let Some(reason) = field.strip_prefix("prunable") {
                record.prune_reason = Some(if reason.trim().is_empty() {
                    "stale worktree metadata".into()
                } else {
                    reason.trim().into()
                });
            }
        }
    }
    Ok(records)
}

pub fn default_branch(root: &Path) -> Result<String> {
    if let Ok(value) = run(
        root,
        &["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
    ) {
        return Ok(value.trim().trim_start_matches("origin/").into());
    }
    for prefix in ["refs/remotes/origin", "refs/heads"] {
        for branch in ["main", "master", "develop"] {
            if run(
                root,
                &[
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("{prefix}/{branch}"),
                ],
            )
            .is_ok()
            {
                return Ok(branch.into());
            }
        }
    }
    let refs = run(
        root,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    )?;
    refs.lines()
        .next()
        .map(str::to_owned)
        .ok_or_else(|| crate::Error::new("GIT_ERROR", "Cannot resolve default branch"))
}
