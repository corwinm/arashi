//! Bounded configured add using native Git local and network transports.
use crate::{
    Error, Result,
    cli::Args,
    config::{Config, Workspace},
    git,
    managed::{IgnorePlan, relative, safe, unsupported},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

fn validate_git_environment() -> Result<()> {
    crate::clone::dangerous_environment()
}

fn add_error(code: &str, message: impl Into<String>, details: Value) -> Error {
    Error::new(code, message)
        .with_exit_code(2)
        .with_details(details)
}

fn source_preflight_details(mut details: Value, config_entry_present: bool) -> Value {
    details["rollback"] = json!({
        "complete":true,
        "failures":[],
        "finalState":{
            "canonical":{"exists":false,"path":""},
            "configEntryPresent":config_entry_present,
            "configRestored":null,
            "coordinatedBranch":null,
            "managedIgnore":{"changed":false,"restored":null},
            "worktree":null
        }
    });
    details
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.is_ascii()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn parse_url(raw: &str) -> Result<(String, Option<PathBuf>, String)> {
    let url = raw.trim().to_owned();
    let path = if let Some(path) = url.strip_prefix("file://") {
        PathBuf::from(path)
    } else {
        PathBuf::from(&url)
    };
    if !path.is_absolute() && !crate::clone::network_url(&url) {
        if url.contains("://") || url.contains(':') {
            return Err(unsupported(
                "Native add currently requires an ordinary absolute local path or native Git network URL; no changes made",
            ));
        }
        return Err(add_error(
            "INVALID_URL",
            format!("The URL \"{raw}\" is not a valid Git repository URL"),
            source_preflight_details(json!({"url":raw}), false),
        ));
    }
    if url.starts_with("file://") && !url.starts_with("file:///") {
        return Err(unsupported(
            "Native add currently supports only local file:// URLs; no changes made",
        ));
    }
    if path
        .to_str()
        .is_none_or(|value| !value.is_ascii() || value.contains(['\n', '\r']))
    {
        return Err(unsupported(
            "Native add currently requires ordinary ASCII local repository paths; no changes made",
        ));
    }
    let without_trailing_slashes = url.trim_end_matches('/');
    let trimmed = without_trailing_slashes
        .strip_suffix(".git")
        .unwrap_or(without_trailing_slashes);
    let name = trimmed
        .rsplit(['/', ':'])
        .next()
        .filter(|name| valid_name(name))
        .ok_or_else(|| {
            add_error(
                "INVALID_URL",
                format!("The URL \"{raw}\" is not a valid Git repository URL"),
                source_preflight_details(json!({"url":raw}), false),
            )
        })?
        .to_owned();
    let local = (!crate::clone::network_url(&url)).then_some(path);
    Ok((url, local, name))
}

fn direct_primary(workspace: &Workspace) -> Result<()> {
    #[cfg(not(unix))]
    {
        let _ = workspace;
        Err(unsupported(
            "Native add mutation currently requires POSIX filesystem identity; no changes made",
        ))
    }
    #[cfg(unix)]
    {
        safe(&workspace.root)?;
        let records = git::worktrees(&workspace.root)?;
        if records.len() != 1
            || records[0].bare
            || !crate::paths::same_existing(&records[0].path, &workspace.root)?
        {
            return Err(unsupported(
                "Native add currently supports only the ordinary primary configured checkout with no linked worktrees; no changes made",
            ));
        }
        Ok(())
    }
}

fn safe_effective_git_configuration(root: &Path) -> Result<String> {
    let value = git::run(root, &["config", "--null", "--list"])?;
    if value
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .any(|entry| {
            let key = entry.split('\n').next().unwrap_or("");
            key.starts_with("includeif.")
                || (key.starts_with("filter.")
                    && (key.ends_with(".clean")
                        || key.ends_with(".smudge")
                        || key.ends_with(".process")))
                || matches!(
                    key,
                    "core.fsmonitor" | "core.worktree" | "core.hookspath" | "init.templatedir"
                )
                || key.starts_with("uploadpack.")
        })
    {
        return Err(unsupported(
            "Native add with conditional Git includes, filters, hooks, fsmonitor, worktree projection, template, or upload-pack policy is not yet supported; no changes made",
        ));
    }
    Ok(value)
}

#[derive(PartialEq)]
struct RemoteIdentity {
    branch: String,
    config: String,
    oid: String,
    path: PathBuf,
    tree: String,
}

fn validate_remote(remote: &Path) -> Result<RemoteIdentity> {
    safe(remote)?;
    let canonical = crate::paths::canonicalize(remote).map_err(|error| {
        add_error(
            "CLONE_FAILED",
            format!("Git clone operation failed: {error}"),
            json!({"phase":"preflight"}),
        )
    })?;
    if canonical != remote
        || git::run(&canonical, &["rev-parse", "--is-bare-repository"])? != "true\n"
    {
        return Err(unsupported(
            "Native add requires an ordinary canonical bare local origin; no changes made",
        ));
    }
    let config = git::run(&canonical, &["config", "--local", "--null", "--list"])?;
    if config
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .any(|entry| {
            let key = entry.split('\n').next().unwrap_or("");
            !matches!(
                key,
                "core.repositoryformatversion"
                    | "core.filemode"
                    | "core.bare"
                    | "core.logallrefupdates"
                    | "core.ignorecase"
                    | "core.precomposeunicode"
                    | "maintenance.auto"
            )
        })
    {
        return Err(unsupported(
            "Native add local-origin Git configuration is not yet supported; no changes made",
        ));
    }
    for relative in [
        "commondir",
        "shallow",
        "objects/info/alternates",
        "info/grafts",
        "refs/replace",
    ] {
        if canonical.join(relative).try_exists()? {
            return Err(unsupported(
                "Native add local-origin Git topology is not yet supported; no changes made",
            ));
        }
    }
    safe(&canonical.join("hooks"))?;
    for entry in fs::read_dir(canonical.join("hooks"))? {
        let entry = entry?;
        if !entry.file_name().to_string_lossy().ends_with(".sample") {
            return Err(unsupported(
                "Native add local origins with active Git hooks are not yet supported; no changes made",
            ));
        }
    }
    let head = git::run(&canonical, &["symbolic-ref", "HEAD"])?;
    let branch = head
        .trim()
        .strip_prefix("refs/heads/")
        .filter(|branch| !branch.is_empty())
        .ok_or_else(|| {
            add_error(
                "BRANCH_DETECTION_FAILED",
                "Unable to detect default branch: repository has no remote branches",
                json!({"phase":"preflight"}),
            )
        })?
        .to_owned();
    git::run(
        &canonical,
        &["show-ref", "--verify", &format!("refs/heads/{branch}")],
    )?;
    if git::run(
        &canonical,
        &["cat-file", "-t", &format!("refs/heads/{branch}")],
    )?
    .trim()
        != "commit"
    {
        return Err(unsupported(
            "Native add requires an ordinary commit default branch; no changes made",
        ));
    }
    let oid = git::run(&canonical, &["rev-parse", &format!("refs/heads/{branch}")])?
        .trim()
        .to_owned();
    let tree = git::run(
        &canonical,
        &[
            "ls-tree",
            "-r",
            "-z",
            "--format=%(objectmode)%x09%(path)",
            &oid,
        ],
    )?;
    if tree.split('\0').filter(|row| !row.is_empty()).any(|row| {
        let (mode, path) = row.split_once('\t').unwrap_or(("", ""));
        mode == "120000" || mode == "160000" || !path.is_ascii() || path.contains(['\n', '\r'])
    }) {
        return Err(unsupported(
            "Native add local origins with symlinks, gitlinks, non-ASCII, or line-break paths are not yet supported; no changes made",
        ));
    }
    Ok(RemoteIdentity {
        branch,
        config,
        oid,
        path: canonical,
        tree,
    })
}

fn run_clone_git(cwd: &Path, args: &[&str]) -> Result<()> {
    let mut command = Command::new("git");
    let output = command
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
        ])
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()?;
    if !output.status.success() {
        return Err(add_error(
            "CLONE_FAILED",
            format!(
                "Git clone operation failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
            json!({"phase":"clone"}),
        ));
    }
    Ok(())
}

fn setup_script(root: &Path) -> Result<Option<&'static str>> {
    for name in [
        "setup.sh",
        "setup.bash",
        "install.sh",
        "bootstrap.sh",
        "setup.ps1",
        "setup.bat",
        "setup.py",
        "setup.rb",
    ] {
        if root.join(name).is_file() {
            return Ok(Some(name));
        }
    }
    let makefile = root.join("Makefile");
    if makefile.is_file() {
        let text = fs::read_to_string(makefile)?;
        if text
            .lines()
            .any(|line| line.starts_with("setup:") || line.starts_with("install:"))
        {
            return Ok(Some("Makefile"));
        }
    }
    Ok(None)
}

fn validate_config_policy(config: &crate::config::Config, source: &Value) -> Result<()> {
    let allowed_root = [
        "$schema",
        "repos",
        "reposDir",
        "version",
        "worktreesDir",
        "defaults",
        "sync",
    ];
    let source_is_canonical = source.as_object().is_some_and(|root| {
        root.keys().all(|key| allowed_root.contains(&key.as_str()))
            && root.get("version").and_then(Value::as_str) == Some("1.0.0")
            && root.get("$schema").is_none_or(|schema| {
                schema.as_str() == Some("https://unpkg.com/arashi/schema/config.schema.json")
            })
            && root
                .get("repos")
                .and_then(Value::as_object)
                .is_some_and(|repos| {
                    repos.values().all(|repo| {
                        repo.as_object().is_some_and(|value| {
                            value
                                .keys()
                                .all(|key| matches!(key.as_str(), "path" | "gitUrl"))
                        })
                    })
                })
    });
    if !source_is_canonical
        || ["defaults", "sync"]
            .iter()
            .any(|key| source.get(key) != config.raw.get(key))
        || config
            .raw
            .as_object()
            .is_none_or(|root| root.keys().any(|key| !allowed_root.contains(&key.as_str())))
        || config.repos.values().any(|repo| {
            repo.raw.as_object().is_none_or(|value| {
                value
                    .keys()
                    .any(|key| !matches!(key.as_str(), "path" | "gitUrl"))
            })
        })
    {
        return Err(unsupported(
            "Native add currently supports only minimal canonical repository configuration without aliases, custom schemas, hooks, materialization, groups, bases, or naming policies; no changes made",
        ));
    }
    Ok(())
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).expect("strings always serialize")
}

fn serialize_config(
    config: &crate::config::Config,
    added_name: &str,
    added_path: &str,
    git_url: &str,
) -> String {
    let mut repositories = Vec::new();
    for name in &config.repo_order {
        let repo = &config.repos[name];
        let mut fields = vec![format!("      \"path\": {}", json_string(&repo.path))];
        if let Some(url) = repo.raw.get("gitUrl").and_then(Value::as_str) {
            fields.push(format!("      \"gitUrl\": {}", json_string(url)));
        }
        repositories.push(format!(
            "    {}: {{\n{}\n    }}",
            json_string(name),
            fields.join(",\n")
        ));
    }
    repositories.push(format!(
        "    {}: {{\n      \"path\": {},\n      \"gitUrl\": {}\n    }}",
        json_string(added_name),
        json_string(added_path),
        json_string(git_url)
    ));
    let mut serialized = format!(
        "{{\n  \"$schema\": \"https://unpkg.com/arashi/schema/config.schema.json\",\n  \"repos\": {{\n{}\n  }},\n  \"reposDir\": {},\n  \"version\": \"1.0.0\",\n  \"worktreesDir\": {}\n}}",
        repositories.join(",\n"),
        json_string(&config.repos_dir),
        json_string(&config.worktrees_dir)
    );
    // These policies are parsed by the shared config contract but do not run
    // during add. Preserve canonical values rather than dropping them.
    for key in ["sync", "defaults"] {
        if let Some(value) = config.raw.get(key) {
            let pretty = serde_json::to_string_pretty(value).expect("config serializes");
            serialized.truncate(serialized.len() - 2);
            serialized.push_str(&format!(
                ",\n  {}: {}\n}}",
                json_string(key),
                pretty.replace('\n', "\n  ")
            ));
        }
    }
    serialized
}

pub fn add(cwd: &Path, args: &Args) -> Result<Value> {
    if args.positional.len() != 1 {
        return Err(Error::new("USAGE", "add requires exactly one git-url"));
    }
    if !args.has("json") && !args.has("force") {
        return Err(unsupported(
            "Native add currently requires --json or --force; no changes made",
        ));
    }
    validate_git_environment()?;
    let workspace = Workspace::discover(cwd)?;
    workspace.config.as_ref().ok_or_else(|| {
        unsupported("Native add requires a configured workspace; no changes made")
    })?;
    let config_path = workspace.root.join(".arashi/config.json");
    safe(&config_path)?;
    let config_before = fs::read(&config_path)?;
    let source_config: Value = serde_json::from_slice(&config_before)?;
    let config = Config::parse(std::str::from_utf8(&config_before).map_err(|error| {
        Error::new(
            "CONFIG_PARSE_ERROR",
            format!("Invalid configuration: {error}"),
        )
    })?)?;
    direct_primary(&workspace)?;
    validate_config_policy(&config, &source_config)?;
    let (git_url, remote_input, derived_name) = parse_url(&args.positional[0])?;
    let name = args.value("name").unwrap_or(&derived_name);
    if !valid_name(name) {
        return Err(unsupported(
            "Native add custom names require portable ASCII repository components; no changes made",
        ));
    }
    if let Some(existing) = config.repos.get(name) {
        return Err(add_error(
            "DUPLICATE_NAME",
            format!(
                "Repository name \"{name}\" already exists at {}",
                existing.path
            ),
            source_preflight_details(
                json!({"existingPath":existing.path,"gitUrl":git_url,"name":name}),
                true,
            ),
        ));
    }
    safe_effective_git_configuration(&workspace.root)?;
    let repos_relative = relative(&config.repos_dir)?;
    if repos_relative == Path::new(".") {
        return Err(unsupported(
            "Native add does not support repository-root or external repositories directories; no changes made",
        ));
    }
    let destination = workspace.root.join(&repos_relative).join(name);
    safe(&destination)?;
    if fs::symlink_metadata(&destination).is_ok() {
        return Err(add_error(
            "CLONE_FAILED",
            format!(
                "Canonical repository destination already exists: {}",
                destination.display()
            ),
            json!({"canonicalPath":destination,"phase":"preflight"}),
        ));
    }
    let remote = remote_input.as_deref().map(validate_remote).transpose()?;
    let (remote_branch, remote_oid) = if let Some(remote) = &remote {
        (remote.branch.clone(), remote.oid.clone())
    } else {
        crate::clone::network_head(&workspace.root, &git_url, None)?
    };
    let ignore = IgnorePlan::build(
        &workspace.root,
        &config.repos_dir,
        &config.worktrees_dir,
        false,
    )?;
    if ignore.data["attempted"] == true {
        return Err(unsupported(
            "Native add currently requires repository and worktree destinations to be already ignored; no changes made",
        ));
    }
    let git_configuration = safe_effective_git_configuration(&workspace.root)?;
    if source_config
        .get("repos")
        .and_then(Value::as_object)
        .is_none()
    {
        return Err(unsupported(
            "Native add currently requires canonical repos configuration; no changes made",
        ));
    }

    // Revalidate every observation immediately before the first mutation.
    if safe_effective_git_configuration(&workspace.root)? != git_configuration
        || fs::read(&config_path)? != config_before
        || remote_input.as_deref().map(validate_remote).transpose()? != remote
        || fs::symlink_metadata(&destination).is_ok()
    {
        return Err(unsupported(
            "Native add preflight changed before mutation; no changes made",
        ));
    }

    let parent = destination.parent().unwrap();
    fs::create_dir_all(parent)?;
    safe(parent)?;
    fs::create_dir(&destination).map_err(|error| {
        add_error(
            "CLONE_FAILED",
            format!("Canonical repository destination could not be reserved: {error}"),
            json!({"canonicalPath":destination,"phase":"clone"}),
        )
    })?;
    let clone_result = run_clone_git(
        parent,
        &[
            "clone",
            "--no-local",
            "--no-hardlinks",
            "--no-checkout",
            "--",
            &git_url,
            destination.to_str().unwrap(),
        ],
    );
    clone_result?;
    run_clone_git(&destination, &["reset", "--hard", "HEAD"])?;
    let default_branch = git::default_branch(&destination)?;
    if default_branch != remote_branch
        || git::run(&destination, &["rev-parse", "HEAD"])?.trim() != remote_oid
    {
        return Err(add_error(
            "BRANCH_DETECTION_FAILED",
            "Default branch changed during clone",
            json!({"phase":"branch"}),
        ));
    }
    let mut setup = setup_script(&destination)?;
    let setup_created = setup.is_none() && args.has("create-setup");
    if setup_created {
        let path = destination.join("setup.sh");
        use std::io::Write;
        let mut script = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        script.write_all(
            b"#!/usr/bin/env bash\nset -euo pipefail\n\n# Add repository setup commands here.\n",
        )?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            script.set_permissions(fs::Permissions::from_mode(0o755))?;
        }
        setup = Some("setup.sh");
    }
    if fs::read(&config_path)? != config_before {
        return Err(add_error(
            "CONFIG_UPDATE_FAILED",
            "Configuration changed concurrently after add began; preserving the newer file.",
            json!({"phase":"config"}),
        ));
    }
    let configured_path = repos_relative
        .join(name)
        .to_string_lossy()
        .replace('\\', "/");
    let config_after = serialize_config(&config, name, &configured_path, &git_url).into_bytes();
    fs::write(&config_path, config_after)?;

    Ok(json!({
        "managedIgnore":ignore.data,
        "repository":{
            "canonicalPath":destination,
            "coordinatedBranch":null,
            "defaultBranch":default_branch,
            "gitUrl":git_url,
            "materialization":"clone",
            "name":name,
            "path":configured_path,
            "setupScript":setup.map(|script| format!("{configured_path}/{script}")),
            "setupScriptCreated":setup_created,
            "worktreePath":null
        }
    }))
}
