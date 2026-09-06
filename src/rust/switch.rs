//! Safe native switch selection and parent-shell directory directives.
//!
//! Terminal, editor, tmux, sesh, Herdr, cmux and Kitty launchers remain
//! deliberately unsupported. The only active integration in this slice is the
//! existing shell wrapper's directive file.
use crate::{
    Error, Result,
    cli::Args,
    config::{Config, Workspace},
    git, managed,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::{IsTerminal, Write},
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Debug)]
struct Candidate {
    branch: String,
    path: PathBuf,
    repository: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Scope {
    Parent,
    Repos,
    All,
}

fn usage(code: &str, message: impl Into<String>) -> Error {
    Error::new(code, message).with_exit_code(2)
}

fn unsupported(message: impl Into<String>) -> Error {
    Error::new("RUST_NOT_YET_PORTED", message)
}

fn nonempty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn managed_context_active() -> bool {
    nonempty_env("TMUX").is_some()
        || nonempty_env("HERDR_ENV").as_deref() == Some("1")
        || nonempty_env("CMUX_WORKSPACE_ID").is_some()
        || nonempty_env("CMUX_SURFACE_ID").is_some()
        || integrated_ide_active()
        || nonempty_env("KITTY_PID").is_some()
        || nonempty_env("KITTY_WINDOW_ID").is_some()
        || nonempty_env("TERM").is_some_and(|value| value.eq_ignore_ascii_case("xterm-kitty"))
}

fn integrated_ide_active() -> bool {
    // Cursor/Kiro signals precede the exact VS Code terminal/presence fallback.
    // This only classifies launch intent; no IDE launcher is implemented here.
    [
        "TERM_PROGRAM",
        "TERM_PROGRAM_VERSION",
        "VSCODE_GIT_ASKPASS_NODE",
        "VSCODE_GIT_ASKPASS_EXTRA_ARGS",
        "VSCODE_GIT_IPC_HANDLE",
    ]
    .iter()
    .filter_map(|name| nonempty_env(name))
    .any(|value| {
        let value = value.to_lowercase();
        value.contains("cursor") || value.contains("kiro")
    }) || std::env::var("TERM_PROGRAM").as_deref() == Ok("vscode")
        || std::env::var_os("VSCODE_PID").is_some()
        || std::env::var_os("VSCODE_GIT_IPC_HANDLE").is_some()
}

fn directive_context() -> Option<(PathBuf, String)> {
    let path = nonempty_env("ARASHI_DIRECTIVE_FILE")?;
    let shell = nonempty_env("ARASHI_SHELL")?;
    ["bash", "zsh", "fish"]
        .contains(&shell.as_str())
        .then(|| (PathBuf::from(path), shell))
}

fn explicit_launch_options(args: &Args) -> Vec<&'static str> {
    ["tmux", "herdr", "sesh", "vscode", "cursor", "kiro"]
        .into_iter()
        .filter(|option| args.has(option))
        .collect()
}

fn validate_options(args: &Args) -> Result<()> {
    let launchers = explicit_launch_options(args);
    let launch_intent =
        args.has("launch") || args.has("no-cd") || args.has("tab") || !launchers.is_empty();
    if launchers.len() > 1 {
        return Err(usage(
            "CONFLICTING_LAUNCH_OPTIONS",
            format!(
                "Conflicting launch overrides provided ({}). Choose exactly one explicit switch mode.",
                launchers
                    .iter()
                    .map(|value| format!("--{value}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ));
    }
    if args.has("cd") && launch_intent {
        return Err(usage(
            "CONFLICTING_SWITCH_OPTIONS",
            "Conflicting switch behavior overrides provided (--cd with an explicit launch override). Choose either parent-shell switching or a launch target.",
        ));
    }
    if launch_intent {
        return Err(unsupported(
            "Terminal and editor switch launchers are not yet ported; no process was launched and no directive was written",
        ));
    }
    Ok(())
}

fn configured_mode(config: Option<&Config>) -> Option<&str> {
    config.and_then(|config| config.raw["defaults"]["switch"]["mode"].as_str())
}

fn requires_launcher(args: &Args, workspace: &Workspace, has_directive: bool) -> bool {
    if args.has("cd") {
        return false;
    }
    match configured_mode(workspace.config.as_ref()) {
        Some("cd") => !has_directive,
        Some("auto") => !has_directive || managed_context_active(),
        Some("launch" | "sesh" | "herdr") | None => true,
        Some(_) => true,
    }
}

fn normalize(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn child_path(root: &Path, configured: &str) -> Result<PathBuf> {
    let configured = Path::new(configured);
    if configured
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return Err(managed::unsupported(
            "External switch repository paths or parent traversal are not yet ported",
        ));
    }
    let path = if configured.is_absolute() {
        let relative = configured.strip_prefix(root).map_err(|_| {
            managed::unsupported("External switch repository paths are not yet ported")
        })?;
        root.join(relative)
    } else {
        root.join(managed::relative(configured.to_str().ok_or_else(
            || managed::unsupported("Non-UTF-8 switch repository paths are not supported"),
        )?)?)
    };
    if !path.starts_with(root) {
        return Err(managed::unsupported(
            "External switch repository paths are not yet ported",
        ));
    }
    managed::safe(&path)?;
    Ok(path)
}

fn append_worktrees(candidates: &mut Vec<Candidate>, repository: &str, root: &Path) -> Result<()> {
    for worktree in git::worktrees(root)? {
        if worktree.bare {
            return Err(managed::unsupported(
                "Bare switch repository topology is not yet ported",
            ));
        }
        let Some(branch) = worktree.branch.filter(|branch| !branch.trim().is_empty()) else {
            continue;
        };
        if worktree.path.as_os_str().is_empty() {
            continue;
        }
        let path = crate::paths::canonicalize(&worktree.path)?;
        if !candidates
            .iter()
            .any(|candidate| candidate.repository == repository && candidate.path == path)
        {
            candidates.push(Candidate {
                branch,
                path,
                repository: repository.to_owned(),
            });
        }
    }
    Ok(())
}

fn discover(workspace: &Workspace, scope: Scope) -> Result<Vec<Candidate>> {
    let parent_name = workspace
        .root
        .file_name()
        .ok_or_else(|| unsupported("Workspace root has no repository name"))?
        .to_string_lossy()
        .into_owned();
    let mut candidates = Vec::new();
    if scope != Scope::Repos {
        append_worktrees(&mut candidates, &parent_name, &workspace.root)?;
    }
    if scope != Scope::Parent
        && let Some(config) = &workspace.config
    {
        for name in &config.repo_order {
            let path = child_path(&workspace.root, &config.repos[name].path)?;
            append_worktrees(&mut candidates, name, &path)?;
        }
    }
    if scope == Scope::Repos {
        let root = crate::paths::canonicalize(&workspace.root)?;
        candidates.retain(|candidate| candidate.path.starts_with(&root));
    }
    Ok(candidates)
}

fn filter_candidates(
    candidates: &[Candidate],
    filter: Option<&str>,
    exact_path: bool,
    scope: Scope,
) -> Vec<Candidate> {
    let Some(filter) = filter.map(str::trim).filter(|filter| !filter.is_empty()) else {
        return if exact_path {
            Vec::new()
        } else {
            candidates.to_vec()
        };
    };
    if exact_path {
        let target = normalize(Path::new(filter));
        return candidates
            .iter()
            .filter(|candidate| candidate.path == target)
            .cloned()
            .collect();
    }
    if scope == Scope::Repos {
        let query = filter.to_lowercase();
        let exact: Vec<_> = candidates
            .iter()
            .filter(|candidate| candidate.repository.to_lowercase() == query)
            .cloned()
            .collect();
        if !exact.is_empty() {
            return exact;
        }
        let mut repositories = Vec::new();
        for candidate in candidates {
            if candidate.repository.to_lowercase().contains(&query)
                && !repositories.contains(&candidate.repository)
            {
                repositories.push(candidate.repository.clone());
            }
        }
        return candidates
            .iter()
            .filter(|candidate| repositories.contains(&candidate.repository))
            .cloned()
            .collect();
    }
    let query = filter.to_lowercase();
    candidates
        .iter()
        .filter(|candidate| {
            candidate.branch.to_lowercase().contains(&query)
                || candidate
                    .path
                    .to_string_lossy()
                    .to_lowercase()
                    .contains(&query)
        })
        .cloned()
        .collect()
}

fn select(candidates: Vec<Candidate>, filter: Option<&str>, exact_path: bool) -> Result<Candidate> {
    if candidates.is_empty() {
        let message = if exact_path {
            if let Some(filter) = filter.map(str::trim).filter(|filter| !filter.is_empty()) {
                format!(
                    "No worktree exists at exact path `{}`. Run `arashi list` to see available worktree paths.",
                    normalize(Path::new(filter)).display()
                )
            } else {
                "Exact path mode requires a worktree path. Run `arashi switch --path <worktree-path>`."
                    .to_owned()
            }
        } else {
            format!(
                "No worktrees matched filter `{}`. Run `arashi switch` to choose interactively or provide a broader filter.",
                filter.unwrap_or("")
            )
        };
        return Err(usage("NO_MATCHES", message));
    }
    if candidates.len() == 1 {
        return Ok(candidates.into_iter().next().unwrap());
    }
    if std::io::stdin().is_terminal() && std::io::stdout().is_terminal() {
        return Err(unsupported(
            "Interactive switch selection is not yet ported; provide a branch or exact --path",
        ));
    }
    Err(usage(
        "AMBIGUOUS_NON_INTERACTIVE",
        format!(
            "Found {} matching worktrees. Provide a more specific filter, for example: arashi switch <branch>.",
            candidates.len()
        ),
    ))
}

fn directive(path: &Path, shell: &str) -> String {
    if shell == "fish" {
        let escaped = path
            .to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('$', "\\$")
            .replace('`', "\\`");
        format!("cd -- \"{escaped}\"\n")
    } else {
        let escaped = path.to_string_lossy().replace('\'', "'\\''");
        format!("cd -- '{escaped}'\n")
    }
}

fn write_directive(path: &Path, contents: &str) -> Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(path)
        && (metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err(Error::new(
            "UNSAFE_DIRECTIVE_PATH",
            "Shell directive path must be a regular file",
        ));
    }
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(Error::new(
            "UNSAFE_DIRECTIVE_PATH",
            "Shell directive path must be a regular file",
        ));
    }
    file.write_all(contents.as_bytes())?;
    file.sync_all()?;
    Ok(())
}

pub fn switch(cwd: &Path, args: &Args) -> Result<Value> {
    args.only(&[
        "all",
        "cd",
        "cursor",
        "herdr",
        "ignore-configured-launcher",
        "kiro",
        "launch",
        "no-cd",
        "no-default-launch",
        "path",
        "repos",
        "sesh",
        "tab",
        "tmux",
        "vscode",
    ])?;
    if args.positional.len() > 1 {
        return Err(usage("USAGE", "switch accepts at most one filter"));
    }
    validate_options(args)?;
    let workspace = Workspace::discover(cwd)?;
    if workspace.config.is_none() && (args.has("repos") || args.has("all")) {
        return Err(usage(
            "CONFLICTING_SWITCH_OPTIONS",
            "--repos and --all are not meaningful in standalone mode; switch already uses this repository's worktrees.",
        ));
    }
    let context = directive_context();
    if requires_launcher(args, &workspace, context.is_some()) {
        return Err(unsupported(
            "The resolved terminal or editor switch launcher is not yet ported; no process was launched and no directive was written",
        ));
    }
    let scope = if args.has("all") {
        Scope::All
    } else if args.has("repos") {
        Scope::Repos
    } else {
        Scope::Parent
    };
    let candidates = discover(&workspace, scope)?;
    if candidates.is_empty() {
        return Err(usage(
            "NO_TARGETS",
            match scope {
                Scope::Parent => {
                    "No switch targets were found in the parent repository. Use `arashi switch --repos` or `arashi switch --all` to broaden the search."
                }
                Scope::Repos => {
                    "No switch targets were found for child repositories in the current workspace. Try `arashi switch --all` to include all worktrees."
                }
                Scope::All => "No switch targets were found in this workspace.",
            },
        ));
    }
    let filter = args.positional.first().map(String::as_str);
    let matched = filter_candidates(&candidates, filter, args.has("path"), scope);
    if matched.is_empty() && scope == Scope::Repos && !args.has("path") {
        let repositories = candidates
            .iter()
            .map(|candidate| candidate.repository.as_str())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
            .join(", ");
        return Err(usage(
            "NO_MATCHES",
            if let Some(filter) = filter.map(str::trim).filter(|filter| !filter.is_empty()) {
                format!(
                    "No child repository matched `{filter}`. Available repositories: {repositories}"
                )
            } else {
                format!(
                    "No child repository matches were found. Available repositories: {repositories}"
                )
            },
        ));
    }
    let selected = select(matched.clone(), filter, args.has("path"))?;
    let directive_written = context.is_some();
    if let Some((directive_path, shell)) = context {
        write_directive(&directive_path, &directive(&selected.path, &shell))?;
    } else {
        eprintln!(
            "Shell integration is not active, so `arashi switch` cannot change the current shell directory for this invocation.\nHint: run `arashi shell install`, restart your shell, and invoke `arashi` through the installed wrapper."
        );
    }
    Ok(json!({
        "directiveWritten": directive_written,
        "launchMode": "cd",
        "matchedCandidates": matched.len(),
        "selected": {
            "branchName": selected.branch,
            "repoName": selected.repository,
            "worktreePath": selected.path,
        },
        "skippedCandidates": 0,
        "totalCandidates": candidates.len(),
    }))
}
