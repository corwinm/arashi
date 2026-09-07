//! Human create controller. Mutation planning/rollback remains in the existing engines.
use crate::{
    Error, Result,
    cli::Args,
    config::Workspace,
    launch::{LaunchContext, LaunchDisposition, LaunchIntent, LaunchSelector, ManagedFamily},
    switch::{execute_launch, launch_error},
};
use serde_json::{Value, json};
use std::path::Path;

fn json_unsupported() -> Error {
    Error::new(
        "JSON_UNSUPPORTED_FOR_MODE",
        "JSON output is not supported for interactive-or-launch.",
    )
    .with_details(json!({"mode":"interactive-or-launch"}))
}

fn defaults(args: &Args, workspace: &Workspace) -> (Option<LaunchIntent>, bool) {
    let raw = workspace.config.as_ref().map(|c| &c.raw);
    let configured = raw.map(|raw| {
        if let Some(host) = args.value("editor-host") {
            &raw["defaults"]["editors"][host]["create"]
        } else {
            &raw["defaults"]["create"]
        }
    });
    let mut mode = configured
        .and_then(|c| c["launch"].as_str())
        .unwrap_or("none");
    if args.has("herdr") {
        mode = "herdr";
    } else if args.has("sesh") {
        mode = "sesh";
    } else if args.has("launch") || args.has("tab") {
        mode = "auto";
    } else if args.has("no-launch") {
        mode = "none";
    }
    if args.has("tmux") {
        mode = "tmux";
    }
    let intent = (mode != "none").then(|| LaunchIntent {
        selector: match mode {
            "tmux" => LaunchSelector::Managed(ManagedFamily::Tmux),
            "sesh" => LaunchSelector::Managed(ManagedFamily::Sesh),
            "herdr" => LaunchSelector::Managed(ManagedFamily::Herdr),
            _ => LaunchSelector::Auto,
        },
        disposition: if args.has("tab") {
            LaunchDisposition::Tab
        } else {
            LaunchDisposition::Window
        },
    });
    let should_switch = intent.is_some()
        || args.has("switch")
        || (!args.has("no-switch") && configured.is_some_and(|c| c["switch"] == true));
    (intent, should_switch)
}

fn select_repositories(workspace: &Workspace, args: &mut Args) -> Result<()> {
    use crate::{
        config::RepoConfig,
        prompts::{Choice, PromptOutcome},
    };
    use std::{fs, path::PathBuf};
    let Some(config) = &workspace.config else {
        return Ok(());
    };
    // Mirror the mutation engine's on-disk discovery rather than offer missing clones.
    fn walk(path: &Path, found: &mut Vec<PathBuf>) -> Result<()> {
        if !path.exists() {
            return Ok(());
        }
        crate::managed::safe(path)?;
        let mut entries = fs::read_dir(path)?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if entry.file_type()?.is_symlink() {
                return Err(crate::managed::unsupported(
                    "Symlinked child discovery is unsupported",
                ));
            }
            if !entry.file_type()?.is_dir() {
                continue;
            }
            if entry.path().join(".git").exists() {
                found.push(entry.path());
            } else {
                walk(&entry.path(), found)?;
            }
        }
        Ok(())
    }
    let mut found = vec![];
    walk(
        &workspace
            .root
            .join(crate::managed::relative(&config.repos_dir)?),
        &mut found,
    )?;
    let parent = workspace
        .root
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let mut selection = config.clone();
    selection.repo_order = vec![parent.clone()];
    selection.repos.entry(parent.clone()).or_insert(RepoConfig {
        path: workspace.root.display().to_string(),
        raw: json!({}),
    });
    let mut paths = std::collections::BTreeMap::new();
    for root in found {
        let name = config
            .repo_order
            .iter()
            .find(|name| {
                crate::paths::same_existing(workspace.root.join(&config.repos[*name].path), &root)
                    .unwrap_or(false)
            })
            .cloned()
            .unwrap_or_else(|| {
                root.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            });
        if selection.repo_order.contains(&name) {
            return Err(crate::managed::unsupported(
                "Duplicate discovered repository identities",
            ));
        }
        selection.repo_order.push(name.clone());
        selection.repos.entry(name.clone()).or_insert(RepoConfig {
            path: root.display().to_string(),
            raw: json!({}),
        });
        paths.insert(name, root);
    }
    let (names, _) = crate::selection::select(&selection, args)?;
    let choices = names
        .into_iter()
        .filter(|name| name != &parent)
        .map(|name| Choice {
            description: paths.get(&name).map(|path| path.display().to_string()),
            label: name.clone(),
            value: name,
        })
        .collect::<Vec<_>>();
    let mut selected = vec![parent];
    if !choices.is_empty() {
        match crate::prompts::multi_select(
            "Select child repositories to create worktrees in:",
            &choices,
        )? {
            PromptOutcome::Answer(names) => selected.extend(names),
            PromptOutcome::Cancelled(_) => {
                return Err(
                    Error::new("USER_CANCELLED", "Operation cancelled by user").with_exit_code(2)
                );
            }
        }
    }
    // Explicitly retain the required parent, even when it was outside the initial filter.
    args.options.remove("group");
    args.options.insert("only".into(), selected);
    Ok(())
}

pub fn create(cwd: &Path, args: &Args) -> Result<Value> {
    if args.has("json") && (args.has("tab") || args.has("tmux")) {
        return Err(json_unsupported());
    }
    let launchers = ["tmux", "sesh", "herdr"]
        .into_iter()
        .filter(|k| args.has(k))
        .collect::<Vec<_>>();
    if launchers.len() > 1 {
        return Err(Error::new(
            "CONFLICTING_LAUNCH_OPTIONS",
            format!(
                "Conflicting launch overrides provided ({}). Choose exactly one explicit create launcher.",
                launchers
                    .iter()
                    .map(|s| format!("--{s}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ));
    }
    if args.has("json")
        && ["interactive", "launch", "sesh", "herdr", "switch"]
            .iter()
            .any(|k| args.has(k))
    {
        return Err(json_unsupported());
    }
    args.only(&[
        "base",
        "repo-base",
        "conflict",
        "only",
        "group",
        "no-hooks",
        "no-launch",
        "no-switch",
        "no-progress",
        "dry-run",
        "launch",
        "switch",
        "tmux",
        "sesh",
        "herdr",
        "tab",
        "editor-host",
        "interactive",
    ])?;
    if args.positional.len() != 1 {
        return Err(Error::new("USAGE", "create requires exactly one branch"));
    }
    if args
        .value("editor-host")
        .is_some_and(|v| !["vscode", "cursor", "kiro"].contains(&v))
    {
        return Err(Error::new(
            "USAGE",
            "editor-host must be vscode, cursor, or kiro",
        ));
    }
    let workspace = Workspace::discover(cwd)?;
    let (intent, should_switch) = defaults(args, &workspace);
    if args.has("json") && intent.is_some() {
        return Err(json_unsupported());
    }
    let mut context = LaunchContext::native()?;
    context.cwd = cwd.to_owned();
    // Do not launch anything on dry-run, or mutate before required launch capability is known.
    let preflight = if !args.has("dry-run") {
        intent
            .as_ref()
            .map(|i| {
                crate::launch::resolve::preflight(i, &context)
                    .map_err(|e| launch_error(e).with_exit_code(1))
            })
            .transpose()?
    } else {
        None
    };
    if workspace.config.is_none()
        && (args.has("interactive") || args.has("only") || args.has("group"))
    {
        return Err(Error::new(
            "CREATE_SETUP_ERROR",
            "Repository selection is not meaningful in standalone mode; omit --only, --group, and --interactive.",
        )
        .with_exit_code(1));
    }
    let mut mutation = Args {
        command: args.command.clone(),
        options: args.options.clone(),
        positional: args.positional.clone(),
    };
    if args.has("interactive") {
        select_repositories(&workspace, &mut mutation)?;
    }
    for key in [
        "launch",
        "switch",
        "tmux",
        "sesh",
        "herdr",
        "tab",
        "editor-host",
        "interactive",
    ] {
        mutation.options.remove(key);
    }
    mutation.options.insert("no-launch".into(), vec![]);
    mutation.options.insert("no-switch".into(), vec![]);
    let data = if workspace.config.is_some() {
        crate::coordinated::create(&workspace, &mutation)?
    } else {
        mutation.only(&[
            "no-hooks",
            "no-launch",
            "no-switch",
            "no-progress",
            "dry-run",
        ])?;
        crate::operations::CreatePlan::build(&workspace, &args.positional[0], args.has("no-hooks"))?
            .execute(&workspace, args.has("dry-run"))?
    };
    if args.has("dry-run") || args.has("json") || !should_switch {
        return Ok(data);
    }
    let repo_name = workspace
        .root
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    let selected = if workspace.config.is_some() {
        data["repositories"]
            .as_array()
            .and_then(|rows| {
                let successful = || {
                    rows.iter()
                        .filter(|r| r["status"] == "success" && r["worktreePath"].is_string())
                };
                successful()
                    .find(|r| r["repositoryName"] == repo_name.as_ref())
                    .or_else(|| successful().next())
            })
            .and_then(|r| {
                Some((
                    r["worktreePath"].as_str()?,
                    r["repositoryName"].as_str()?,
                    r["branchName"].as_str()?,
                ))
            })
    } else {
        data["worktreePath"]
            .as_str()
            .map(|p| (p, repo_name.as_ref(), args.positional[0].as_str()))
    };
    let Some((path, repo, branch)) = selected else {
        eprintln!(
            "Could not resolve the primary worktree for post-create defaults. Skipping switch/launch defaults."
        );
        return Ok(data);
    };
    println!("Default switch target: {path}");
    if let Some(plan) = preflight {
        let outcome = execute_launch(&plan, Path::new(path), repo, branch, &context)
            .map_err(|e| e.with_exit_code(1))?;
        println!("Opened {} context for {repo} at {path}", outcome.mode);
    } else {
        // Source --switch is guidance only, not a shell-directive operation.
        println!("Launch skipped (resolved defaults disabled launch for this invocation).");
    }
    Ok(data)
}
