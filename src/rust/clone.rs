//! Bounded configured clone support for local filesystem remotes.
use crate::{
    Error, Result,
    cli::Args,
    config::{Config, Workspace},
    git,
    managed::{IgnorePlan, Transaction, relative, safe, unsupported},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT_STAGING: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone)]
struct Plan {
    name: String,
    destination: PathBuf,
    url: String,
    remote: PathBuf,
    branch: Option<String>,
    base: Value,
    oid: String,
}

fn unsupported_clone(message: impl AsRef<str>) -> Error {
    unsupported(&format!(
        "{}; no changes made",
        message.as_ref().trim_end_matches("; no changes made")
    ))
}

fn exact_local_remote(url: &str) -> Result<PathBuf> {
    if url.contains(['\n', '\r', '\0']) {
        return Err(unsupported_clone(
            "Clone URLs containing control separators are not yet ported",
        ));
    }
    let path = if let Some(path) = url.strip_prefix("file://") {
        if !path.starts_with('/') || path.contains(['%', '?', '#']) || path.starts_with("//") {
            return Err(unsupported_clone(
                "Only plain absolute file:// clone URLs are supported by this Rust slice",
            ));
        }
        PathBuf::from(path)
    } else {
        let path = PathBuf::from(url);
        if !path.is_absolute() {
            return Err(unsupported_clone(
                "Network, authenticated, SCP-style, and relative clone URLs are not yet ported",
            ));
        }
        path
    };
    safe(&path)?;
    let canonical = crate::paths::canonicalize(&path).map_err(|_| {
        unsupported_clone("Clone remotes must be existing local filesystem repositories")
    })?;
    if canonical != path {
        return Err(unsupported_clone(
            "Clone remotes with aliases or non-canonical paths are not yet ported",
        ));
    }
    Ok(path)
}

fn dangerous_configuration(root: &Path) -> Result<()> {
    let config = git::run(root, &["config", "--null", "--list"])?;
    if config.split('\0').filter(|row| !row.is_empty()).any(|row| {
        let key = row.split('\n').next().unwrap_or("").to_ascii_lowercase();
        key.starts_with("filter.")
            || key.starts_with("include.")
            || key.starts_with("includeif.")
            || key.starts_with("url.")
            || key.starts_with("protocol.")
            || key.starts_with("uploadpack.")
            || key.starts_with("transfer.")
            || key == "core.hookspath"
            || key == "core.fsmonitor"
            || key == "core.worktree"
            || key == "init.templatedir"
            || (key.starts_with("remote.") && key.ends_with(".uploadpack"))
            || (key.starts_with("remote.") && key.ends_with(".promisor"))
            || key == "extensions.partialclone"
    }) {
        return Err(unsupported_clone(
            "Clone with executable transport, filter, hook-template, fsmonitor, or projected-worktree Git configuration is not yet ported",
        ));
    }
    Ok(())
}

fn dangerous_environment() -> Result<()> {
    const UNSUPPORTED: &[&str] = &[
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_REPLACE_REF_BASE",
        "GIT_NAMESPACE",
        "GIT_TEMPLATE_DIR",
        "GIT_EXEC_PATH",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "GIT_PROXY_COMMAND",
    ];
    if let Some(name) = UNSUPPORTED
        .iter()
        .find(|name| std::env::var_os(name).is_some())
    {
        return Err(unsupported_clone(format!(
            "Clone with {name} environment projection is not yet ported"
        )));
    }
    Ok(())
}

fn git_dir(remote: &Path) -> Result<PathBuf> {
    let bare = git::run(remote, &["rev-parse", "--is-bare-repository"])?;
    let path = if bare.trim() == "true" {
        remote.to_owned()
    } else {
        let marker = remote.join(".git");
        if !marker.is_dir() {
            return Err(unsupported_clone(
                "Linked or projected local clone remotes are not yet ported",
            ));
        }
        marker
    };
    safe(&path)?;
    Ok(path)
}

fn object_type_without_lazy_fetch(remote: &Path, oid: &str) -> Result<String> {
    let output = Command::new("git")
        .args(["cat-file", "-t", oid])
        .current_dir(remote)
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .output()?;
    if !output.status.success() {
        return Err(Error::new(
            "GIT_ERROR",
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }
    String::from_utf8(output.stdout)
        .map_err(|_| Error::new("UNSUPPORTED_ENCODING", "Git output is not UTF-8"))
}

fn remote_oid(remote: &Path, branch: Option<&str>) -> Result<String> {
    dangerous_configuration(remote)?;
    let git_dir = git_dir(remote)?;
    for relative in [
        "commondir",
        "shallow",
        "objects/info/alternates",
        "info/grafts",
        "refs/replace",
    ] {
        if git_dir.join(relative).try_exists()? {
            return Err(unsupported_clone(
                "Shallow, alternate-object, replace-ref, graft, and linked remote topology is not yet ported",
            ));
        }
    }
    let reference = if let Some(branch) = branch {
        format!("refs/heads/{branch}")
    } else {
        let head = git::run(remote, &["symbolic-ref", "HEAD"])?;
        let head = head.trim();
        if !head.starts_with("refs/heads/") {
            return Err(unsupported_clone(
                "Detached or non-branch remote HEAD is not yet ported",
            ));
        }
        head.to_owned()
    };
    let oid = git::run(remote, &["show-ref", "--hash", "--verify", &reference])?;
    let oid = oid.trim().to_owned();
    if object_type_without_lazy_fetch(remote, &oid)?.trim() != "commit" {
        return Err(unsupported_clone(
            "Clone base must name an ordinary commit branch",
        ));
    }
    Ok(oid)
}

fn branch_is_safe(root: &Path, branch: &str) -> Result<()> {
    if branch.starts_with("origin/") {
        return Err(unsupported_clone(
            "origin/-prefixed clone base normalization is not yet ported",
        ));
    }
    git::run(root, &["check-ref-format", "--branch", branch]).map_err(|_| {
        Error::new(
            "BASE_BRANCH_POLICY_INVALID",
            format!("Invalid clone base branch: {branch}"),
        )
    })?;
    Ok(())
}

fn base_overrides(config: &Config, args: &Args) -> Result<BTreeMap<String, String>> {
    let mut overrides = BTreeMap::new();
    for raw in args.options.get("repo-base").into_iter().flatten() {
        let Some((name, branch)) = raw
            .split_once('=')
            .filter(|(name, branch)| !name.trim().is_empty() && !branch.trim().is_empty())
        else {
            return Err(Error::new(
                "BASE_BRANCH_POLICY_INVALID",
                format!("Invalid --repo-base value: {raw}"),
            ));
        };
        if !config.repos.contains_key(name) || overrides.contains_key(name) {
            return Err(Error::new(
                "BASE_BRANCH_POLICY_INVALID",
                format!("Invalid or duplicate repository base override: {name}"),
            ));
        }
        branch_is_safe(Path::new("."), branch)?;
        overrides.insert(name.to_owned(), branch.to_owned());
    }
    Ok(overrides)
}

fn ordinary_workspace(workspace: &Workspace, cwd: &Path) -> Result<()> {
    safe(&workspace.root)?;
    safe(&workspace.root.join(".arashi/config.json"))?;
    let cwd = crate::paths::canonicalize(cwd)?;
    if cwd != workspace.root {
        return Err(unsupported_clone(
            "Clone from linked worktrees, child repositories, or nested directories is not yet ported",
        ));
    }
    let worktrees = git::worktrees(&workspace.root)?;
    if worktrees.len() != 1
        || worktrees[0].bare
        || crate::paths::canonicalize(&worktrees[0].path)? != workspace.root
    {
        return Err(unsupported_clone(
            "Clone requires an ordinary configured primary checkout with no linked worktrees",
        ));
    }
    dangerous_configuration(&workspace.root)
}

fn clone_to(plan: &Plan, destination: &Path) -> Result<()> {
    let mut command = Command::new("git");
    command.arg("clone");
    if let Some(branch) = &plan.branch {
        command.args(["--branch", branch]);
    }
    let output = command
        .arg(&plan.url)
        .arg(destination)
        .current_dir(destination.parent().unwrap())
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .output()?;
    if !output.status.success() {
        let reason = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(Error::new(
            "GIT_ERROR",
            format!("Git clone failed: {reason}"),
        ));
    }
    Ok(())
}

fn remove_staging(path: &Path) -> Vec<String> {
    match fs::remove_dir_all(path) {
        Ok(()) => Vec::new(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => vec![format!("{}: {error}", path.display())],
    }
}

pub fn clone(workspace: &Workspace, cwd: &Path, args: &Args) -> Result<Value> {
    if !args.has("json") || !args.has("all") {
        return Err(unsupported_clone(
            "Native clone currently requires explicit --all --json; interactive and human modes are not yet ported",
        ));
    }
    if !args.positional.is_empty() {
        return Err(Error::new("USAGE", "clone takes no arguments"));
    }
    dangerous_environment()?;
    ordinary_workspace(workspace, cwd)?;
    let config = workspace.config.as_ref().ok_or_else(|| {
        unsupported_clone("Standalone clone has no configured repository contract")
    })?;
    let config_bytes = fs::read(workspace.root.join(".arashi/config.json"))?;
    let overrides = base_overrides(config, args)?;
    if let Some(branch) = args.value("base") {
        branch_is_safe(&workspace.root, branch)?;
    }

    let repos_root = workspace.root.join(relative(&config.repos_dir)?);
    safe(&repos_root)?;
    if !repos_root.is_dir() {
        return Err(unsupported_clone(
            "The configured repositories directory must already exist for native clone",
        ));
    }

    let mut plans = Vec::new();
    let mut policy_invocation = args.value("base").is_some() || !overrides.is_empty();
    let mut folded_names = BTreeSet::new();
    for (name, repository) in &config.repos {
        if !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
            || !folded_names.insert(name.to_ascii_lowercase())
        {
            return Err(unsupported_clone(
                "Clone repository names outside the ASCII alphanumeric subset or with portable case collisions are not yet ported",
            ));
        }
        let expected = repos_root.join(name);
        let destination = workspace.root.join(relative(&repository.path)?);
        if destination != expected {
            return Err(unsupported_clone(
                "Native clone currently requires each child at reposDir/<repository-name>",
            ));
        }
        safe(&destination)?;
        if fs::symlink_metadata(&destination).is_ok() {
            continue;
        }
        let url = repository.raw["gitUrl"]
            .as_str()
            .ok_or_else(|| unsupported_clone("Every missing repository must have a gitUrl"))?
            .to_owned();
        let (branch, source) = overrides
            .get(name)
            .map(|branch| (Some(branch.clone()), "repository-cli"))
            .or_else(|| {
                args.value("base")
                    .map(|branch| (Some(branch.to_owned()), "cli"))
            })
            .or_else(|| {
                repository.raw["baseBranch"]
                    .as_str()
                    .map(|branch| (Some(branch.to_owned()), "repository-config"))
            })
            .or_else(|| {
                config.raw["baseBranch"]
                    .as_str()
                    .map(|branch| (Some(branch.to_owned()), "workspace-config"))
            })
            .unwrap_or((None, "legacy-omitted"));
        policy_invocation |= source != "legacy-omitted";
        if let Some(branch) = &branch {
            branch_is_safe(&workspace.root, branch)?;
        }
        let remote = exact_local_remote(&url)?;
        let oid = remote_oid(&remote, branch.as_deref())?;
        let mut base = json!({
            "repositoryIdentity": name,
            "repositoryName": name,
            "source": source
        });
        if let Some(branch) = &branch {
            base["requestedBranch"] = json!(branch);
        }
        plans.push(Plan {
            name: name.clone(),
            destination,
            url,
            remote,
            branch,
            base,
            oid,
        });
    }
    plans.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
    });

    if let Some(name) = overrides
        .keys()
        .find(|name| !plans.iter().any(|plan| &plan.name == *name))
    {
        let branch = &overrides[name];
        let message = format!("Repository selector '{name}' is not selected");
        return Err(Error::new(
            "BASE_BRANCH_POLICY_INVALID",
            format!("Invalid base branch policy:\n  - {message}"),
        )
        .with_details(json!({
            "issues": [{
                "code": "UNSELECTED_REPOSITORY",
                "message": message,
                "value": format!("{name}={branch}")
            }]
        })));
    }

    if plans.is_empty() {
        return Ok(json!({
            "cloned": [],
            "failed": [],
            "skipped": [],
            "status": "success"
        }));
    }

    let destinations: BTreeSet<_> = plans.iter().map(|plan| &plan.destination).collect();
    if destinations.len() != plans.len() {
        return Err(unsupported_clone(
            "Duplicate clone destinations are not supported",
        ));
    }
    let ignore = IgnorePlan::build(
        &workspace.root,
        &config.repos_dir,
        &config.worktrees_dir,
        false,
    )?;

    let mut transaction = Transaction::default();
    ignore.apply(&mut transaction)?;
    let staging = loop {
        let candidate = repos_root.join(format!(
            ".arashi-clone-{}-{}",
            std::process::id(),
            NEXT_STAGING.fetch_add(1, Ordering::SeqCst)
        ));
        match fs::create_dir(&candidate) {
            Ok(()) => break candidate,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                let recovery = transaction.rollback();
                let message = if recovery.is_empty() {
                    error.to_string()
                } else {
                    format!("{error}; recovery failed: {}", recovery.join("; "))
                };
                return Err(Error::new("IO_ERROR", message));
            }
        }
    };

    for plan in &plans {
        let staged = staging.join(&plan.name);
        if let Err(mut error) = clone_to(plan, &staged) {
            let mut recovery = remove_staging(&staging);
            recovery.extend(transaction.rollback());
            if !recovery.is_empty() {
                error.message = format!(
                    "{}; recovery failed: {}",
                    error.message,
                    recovery.join("; ")
                );
            }
            return Err(error);
        }
    }

    let validation = (|| -> Result<()> {
        if fs::read(workspace.root.join(".arashi/config.json"))? != config_bytes {
            return Err(unsupported_clone(
                "Configuration changed during clone preflight",
            ));
        }
        for plan in &plans {
            safe(&plan.destination)?;
            if fs::symlink_metadata(&plan.destination).is_ok()
                || remote_oid(&plan.remote, plan.branch.as_deref())? != plan.oid
            {
                return Err(unsupported_clone(
                    "Clone destination or remote base changed during preflight",
                ));
            }
        }
        Ok(())
    })();
    if let Err(mut error) = validation {
        let mut recovery = remove_staging(&staging);
        recovery.extend(transaction.rollback());
        if !recovery.is_empty() {
            error.message = format!(
                "{}; recovery failed: {}",
                error.message,
                recovery.join("; ")
            );
        }
        return Err(error);
    }

    for plan in &plans {
        fs::rename(staging.join(&plan.name), &plan.destination)?;
    }
    fs::remove_dir(&staging)?;

    let mut data = json!({
        "cloned": plans.iter().map(|plan| plan.name.clone()).collect::<Vec<_>>(),
        "failed": [],
        "managedIgnore": ignore.data,
        "skipped": [],
        "status": "success"
    });
    if policy_invocation {
        data["base"] = json!(
            plans
                .iter()
                .map(|plan| plan.base.clone())
                .collect::<Vec<_>>()
        );
    }
    Ok(data)
}
