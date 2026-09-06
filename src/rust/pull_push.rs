//! Configured pull/push via native Git transports; unsupported policies fail closed.
use crate::{Error, Result, cli::Args, config::Workspace, git};
use serde_json::{Map, Value, json};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Clone)]
struct Repository {
    name: String,
    path: PathBuf,
    raw: Value,
    base: Option<(String, &'static str)>,
}

#[derive(Clone)]
struct Remote {
    path: PathBuf,
    network: bool,
    url: String,
}

fn unsupported(message: impl Into<String>) -> Error {
    Error::new("PORT_UNSUPPORTED", message)
}

fn elapsed(start: Instant) -> f64 {
    start.elapsed().as_secs_f64()
}

fn command_error(message: impl Into<String>) -> Error {
    Error::new("USAGE", message).with_exit_code(2)
}

fn normalized(args: &Args, key: &str) -> Vec<String> {
    let mut values = Vec::new();
    for value in args
        .options
        .get(key)
        .into_iter()
        .flatten()
        .flat_map(|value| value.split(','))
    {
        let value = value.trim().to_owned();
        if !value.is_empty() && !values.contains(&value) {
            values.push(value);
        }
    }
    values
}

fn repositories(workspace: &Workspace, args: &Args) -> Result<Vec<Repository>> {
    let config = workspace.config.as_ref().ok_or_else(|| {
        Error::new(
            "CONFIGURED_WORKSPACE_REQUIRED",
            format!(
                "The '{}' command requires an arashi workspace with .arashi/config.json",
                args.command
            ),
        )
        .with_exit_code(2)
    })?;
    let parent_name = workspace
        .root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("workspace")
        .to_owned();
    let only = normalized(args, "only");
    let groups = normalized(args, "group");
    let empty: Vec<_> = [("only", &only), ("group", &groups)]
        .into_iter()
        .filter(|(key, values)| args.has(key) && values.is_empty())
        .map(|(key, _)| key)
        .collect();
    if !empty.is_empty() {
        return Err(Error::new(
            "EMPTY_REPOSITORY_FILTERS",
            format!(
                "Explicitly empty repository {}: {}",
                if empty.len() == 1 {
                    "filter"
                } else {
                    "filters"
                },
                empty
                    .iter()
                    .map(|key| format!("--{key}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )
        .with_details(json!({"emptyFilters":empty}))
        .with_exit_code(2));
    }
    let known =
        |name: &str| name == parent_name || name == "@meta" || config.repos.contains_key(name);
    let missing: Vec<_> = only.iter().filter(|name| !known(name)).cloned().collect();
    if !missing.is_empty() {
        return Err(command_error(format!(
            "Unknown repositories in --only filter: {}",
            missing.join(", ")
        )));
    }
    let group_matches = |name: &str, group: &str| {
        config.repos[name].raw["groups"]
            .as_array()
            .is_some_and(|values| {
                values.iter().any(|value| {
                    value
                        .as_str()
                        .is_some_and(|value| value.eq_ignore_ascii_case(group))
                })
            })
    };
    let unknown_groups: Vec<_> = groups
        .iter()
        .filter(|group| {
            !config
                .repo_order
                .iter()
                .any(|name| group_matches(name, group))
        })
        .cloned()
        .collect();
    if !unknown_groups.is_empty() {
        return Err(command_error(format!(
            "Unknown repository groups in --group filter: {}",
            unknown_groups.join(", ")
        )));
    }
    let requested = if only.is_empty() {
        std::iter::once(parent_name.clone())
            .chain(config.repo_order.iter().cloned())
            .collect::<Vec<_>>()
    } else {
        only.iter()
            .map(|name| {
                if name == "@meta" {
                    parent_name.clone()
                } else {
                    name.clone()
                }
            })
            .collect()
    };
    let selected: Vec<_> = requested
        .into_iter()
        .filter(|name| {
            groups.is_empty()
                || (name != &parent_name && groups.iter().any(|group| group_matches(name, group)))
        })
        .collect();
    if selected.is_empty() && (!only.is_empty() || !groups.is_empty()) {
        return Err(command_error(
            "No repositories matched the combined --only/--group filters",
        ));
    }
    let workspace_base = config.raw["baseBranch"].as_str();
    selected
        .into_iter()
        .map(|name| {
            if name == parent_name {
                let raw = config.raw["meta"].clone();
                let base = raw["baseBranch"]
                    .as_str()
                    .map(|branch| (branch.to_owned(), "repository-config"))
                    .or_else(|| {
                        workspace_base.map(|branch| (branch.to_owned(), "workspace-config"))
                    });
                Ok(Repository {
                    name,
                    path: workspace.root.clone(),
                    raw,
                    base,
                })
            } else {
                let repo = &config.repos[&name];
                let base = repo.raw["baseBranch"]
                    .as_str()
                    .map(|branch| (branch.to_owned(), "repository-config"))
                    .or_else(|| {
                        workspace_base.map(|branch| (branch.to_owned(), "workspace-config"))
                    });
                let path = workspace.root.join(crate::managed::relative(&repo.path)?);
                if !path.starts_with(&workspace.root) {
                    return Err(unsupported(
                        "External repository paths are not supported; no changes made",
                    ));
                }
                Ok(Repository {
                    name,
                    path,
                    raw: repo.raw.clone(),
                    base,
                })
            }
        })
        .collect()
}

fn remote(repository: &Repository) -> Result<Option<Remote>> {
    if ["copy", "symlink"].into_iter().any(|field| {
        repository.raw[field]
            .as_array()
            .is_some_and(|entries| !entries.is_empty())
    }) {
        return Err(unsupported(
            "Pull and push with materialization policies are not yet supported; no changes made",
        ));
    }
    if !repository.path.exists() {
        return Ok(None);
    }
    crate::managed::safe(&repository.path)?;
    reject_observation_drivers(&repository.path)?;
    let names = git::run(&repository.path, &["remote"])?;
    if names.lines().collect::<Vec<_>>() != ["origin"] {
        return Err(unsupported(
            "Pull and push currently require exactly one origin remote; no remote operation attempted",
        ));
    }
    if git::run(
        &repository.path,
        &["config", "--get-all", "remote.origin.pushurl"],
    )
    .is_ok()
    {
        return Err(unsupported(
            "Separate push URLs are not yet supported; no remote operation attempted",
        ));
    }
    if let Ok(values) = git::run(
        &repository.path,
        &["config", "--get-regexp", r"^branch\..*\.remote$"],
    ) && values.lines().any(|line| {
        line.split_once(char::is_whitespace)
            .is_some_and(|(_, value)| value.trim() != "origin")
    }) {
        return Err(unsupported(
            "Non-origin branch tracking is not yet supported; no remote operation attempted",
        ));
    }
    let urls = git::run(&repository.path, &["remote", "get-url", "--all", "origin"])?;
    let urls: Vec<_> = urls.lines().collect();
    if urls.len() != 1 {
        return Err(unsupported(
            "Multiple origin URLs are not yet supported; no remote operation attempted",
        ));
    }
    let url = urls[0];
    let network = ["https://", "http://", "ssh://", "git://"]
        .iter()
        .any(|prefix| url.starts_with(prefix))
        || (!url.contains("://")
            && !url.contains("::")
            && !url.starts_with('-')
            && url.split_once(':').is_some_and(|(host, path)| {
                !host.contains('/') && !host.is_empty() && !path.is_empty()
            }));
    if network {
        return Ok(Some(Remote {
            path: repository.path.clone(),
            network: true,
            url: url.to_owned(),
        }));
    }
    let path = urls[0].strip_prefix("file://").unwrap_or(urls[0]);
    let path = PathBuf::from(path);
    if !path.is_absolute() || !path.is_dir() {
        return Err(unsupported(
            "Unsupported remote URL or local remote path; no remote operation attempted",
        ));
    }
    crate::managed::safe(&path)?;
    if git::run(&path, &["rev-parse", "--is-bare-repository"])?.trim() != "true" {
        return Err(unsupported(
            "Local pull and push remotes must be ordinary bare repositories",
        ));
    }
    reject_bare_remote_policy(&path)?;
    Ok(Some(Remote {
        path: crate::paths::canonicalize(&path)?,
        network: false,
        url: url.to_owned(),
    }))
}

fn reject_bare_remote_policy(path: &Path) -> Result<()> {
    if git::run(path, &["config", "--get", "core.hooksPath"]).is_ok() {
        return Err(unsupported(
            "Custom hooks on the local bare origin are not supported; no remote operation attempted",
        ));
    }
    for hook in [
        "pre-receive",
        "update",
        "post-receive",
        "post-update",
        "push-to-checkout",
        "proc-receive",
        "reference-transaction",
    ] {
        if path.join("hooks").join(hook).try_exists()? {
            return Err(unsupported(format!(
                "Hook '{hook}' on the local bare origin is not supported; no remote operation attempted"
            )));
        }
    }
    if let Ok(value) = git::run(
        path,
        &[
            "config",
            "--get-regexp",
            r"^(uploadpack\.packObjectsHook|core\.alternateRefsCommand)$",
        ],
    ) && !value.trim().is_empty()
    {
        return Err(unsupported(
            "Custom commands on the local bare origin are not supported; no remote operation attempted",
        ));
    }
    Ok(())
}

fn reject_observation_drivers(path: &Path) -> Result<()> {
    if let Ok(value) = git::run(
        path,
        &[
            "config",
            "--get-regexp",
            r"^(filter\..*\.(clean|smudge|process)|core\.fsmonitor)$",
        ],
    ) && !value.trim().is_empty()
    {
        return Err(unsupported(
            "Git clean/process filters and fsmonitor hooks are not supported by pull/push preflight",
        ));
    }
    let index = git::run(path, &["ls-files", "--stage", "-z"])?;
    if index
        .split('\0')
        .filter_map(|entry| entry.split_once(' '))
        .any(|(mode, _)| mode == "160000")
    {
        return Err(unsupported(
            "Indexed submodules are not supported by pull/push preflight",
        ));
    }
    if git::run(path, &["config", "--get", "core.hooksPath"]).is_ok() {
        return Err(unsupported(
            "Custom Git hook paths are not supported by pull/push; no changes made",
        ));
    }
    let hooks = PathBuf::from(git::run(path, &["rev-parse", "--git-path", "hooks"])?);
    let hooks = if hooks.is_absolute() {
        hooks
    } else {
        path.join(hooks)
    };
    for hook in [
        "post-merge",
        "pre-merge-commit",
        "pre-push",
        "reference-transaction",
    ] {
        if hooks.join(hook).try_exists()? {
            return Err(unsupported(format!(
                "Active Git hook '{hook}' is not supported by pull/push; no changes made"
            )));
        }
    }
    if let Ok(value) = git::run(
        path,
        &[
            "config",
            "--get-regexp",
            r"^(remote\.origin\.(uploadpack|receivepack|proxy|vcs)|core\.gitProxy|branch\..*\.pushRemote|remote\.pushDefault)$",
        ],
    ) && !value.trim().is_empty()
    {
        return Err(unsupported(
            "Custom Git transport commands are not supported by pull/push; no changes made",
        ));
    }
    Ok(())
}

fn changes_control_files(plan: &PullPlan) -> bool {
    if plan.state != "update" {
        return false;
    }
    git::run(
        &plan.remote.path,
        &[
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            &format!("{}..{}", plan.head, plan.remote_oid),
        ],
    )
    .is_ok_and(|paths| {
        paths.lines().any(|path| {
            path == ".arashi/config.json" || path == ".gitignore" || path == ".gitmodules"
        })
    })
}

fn exact_ref(path: &Path, reference: &str) -> Option<String> {
    git::run(path, &["show-ref", "--verify", "--hash", reference])
        .ok()
        .map(|value| value.trim().to_owned())
}

fn current_branch(path: &Path) -> Option<String> {
    git::run(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .map(|value| value.trim().to_owned())
}

fn head(path: &Path) -> Result<String> {
    Ok(git::run(path, &["rev-parse", "--verify", "HEAD^{commit}"])?
        .trim()
        .to_owned())
}

fn clean(path: &Path) -> Result<bool> {
    Ok(git::run(
        path,
        &[
            "-c",
            "core.fsmonitor=false",
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
        ],
    )?
    .is_empty())
}

fn upstream(path: &Path) -> Option<String> {
    git::run(
        path,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .ok()
    .map(|value| value.trim().to_owned())
}

fn remote_git(remote: &Remote, args: &[&str]) -> Result<String> {
    if !remote.network {
        return git::run(&remote.path, args);
    }
    let argv = std::iter::once("git".to_owned())
        .chain(args.iter().map(|arg| (*arg).to_owned()))
        .collect::<Vec<_>>();
    let output = crate::process::run(&argv, &remote.path, Some(Duration::from_secs(30)))?;
    if output.timed_out {
        return Err(Error::new(
            "GIT_ERROR",
            "Remote operation timed out after 30000ms",
        ));
    }
    if output.exit_code != 0 {
        return Err(Error::new("GIT_ERROR", output.stderr.trim()));
    }
    Ok(output.stdout)
}

fn remote_ref(remote: &Remote, reference: &str) -> Option<String> {
    if !remote.network {
        return exact_ref(&remote.path, reference);
    }
    remote_git(remote, &["ls-remote", "--refs", "origin", reference])
        .ok()?
        .lines()
        .filter_map(|line| line.split_once(char::from(9)))
        .find(|(_, name)| *name == reference)
        .map(|(oid, _)| oid.to_owned())
}

fn fetch_comparison(remote: &Remote, branch: &str) -> Result<()> {
    if remote.network {
        remote_git(
            remote,
            &[
                "fetch",
                "--no-tags",
                "--no-write-fetch-head",
                "--refmap=",
                "origin",
                &format!("refs/heads/{branch}"),
            ],
        )?;
    }
    Ok(())
}

fn default_remote_branch(remote: &Remote) -> Result<String> {
    if remote.network {
        let refs = remote_git(remote, &["ls-remote", "--symref", "origin", "HEAD"])?;
        return refs
            .lines()
            .find_map(|line| {
                line.strip_prefix("ref: refs/heads/")
                    .and_then(|line| line.strip_suffix("\tHEAD"))
            })
            .map(str::to_owned)
            .ok_or_else(|| unsupported("Origin must advertise a symbolic default branch"));
    }
    let reference = git::run(&remote.path, &["symbolic-ref", "HEAD"])?;
    reference
        .trim()
        .strip_prefix("refs/heads/")
        .map(str::to_owned)
        .ok_or_else(|| unsupported("The local origin must have a symbolic default branch"))
}

fn branch_target(repository: &Repository, remote: &Remote) -> Result<String> {
    if let Some(upstream) = upstream(&repository.path) {
        return upstream
            .strip_prefix("origin/")
            .map(str::to_owned)
            .ok_or_else(|| unsupported("Only origin upstreams are supported"));
    }
    if let Some((base, _)) = &repository.base {
        return Ok(base.strip_prefix("origin/").unwrap_or(base).to_owned());
    }
    default_remote_branch(remote)
}

fn is_ancestor(store: &Path, ancestor: &str, descendant: &str) -> bool {
    git::run(
        store,
        &["merge-base", "--is-ancestor", ancestor, descendant],
    )
    .is_ok()
}

fn count(store: &Path, range: &str) -> Option<u64> {
    git::run(store, &["rev-list", "--count", range])
        .ok()?
        .trim()
        .parse()
        .ok()
}

fn configured_base(
    repository: &Repository,
    store: &Path,
    branch: &str,
    oid: &str,
    local: &str,
) -> Option<Value> {
    let (_, source) = repository.base.as_ref()?;
    Some(json!({
        "ahead": count(store, &format!("{oid}..{local}")).unwrap_or(0),
        "behind": count(store, &format!("{local}..{oid}")).unwrap_or(0),
        "branch": branch,
        "compareRef": format!("refs/remotes/origin/{branch}"),
        "remote": "origin",
        "remoteRef": format!("origin/{branch}"),
        "source": source,
        "state": "available"
    }))
}

fn result(fields: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

struct PullPlan {
    repository: Repository,
    remote: Remote,
    branch: String,
    head: String,
    remote_oid: String,
    configured_base: Option<Value>,
    state: &'static str,
    message: Option<String>,
}

fn plan_pull(repository: Repository, remote: Option<Remote>) -> Result<PullPlan> {
    let Some(remote) = remote else {
        return Ok(PullPlan {
            repository,
            remote: Remote {
                path: PathBuf::new(),
                network: false,
                url: String::new(),
            },
            branch: String::new(),
            head: String::new(),
            remote_oid: String::new(),
            configured_base: None,
            state: "missing",
            message: None,
        });
    };
    let Some(current_branch) = current_branch(&repository.path) else {
        return Ok(PullPlan {
            repository,
            remote,
            branch: String::new(),
            head: String::new(),
            remote_oid: String::new(),
            configured_base: None,
            state: "failed",
            message: Some("Repository is not on a named branch".into()),
        });
    };
    let local = head(&repository.path)?;
    let branch = branch_target(&repository, &remote)?;
    let reference = format!("refs/heads/{branch}");
    let Some(remote_oid) = remote_ref(&remote, &reference) else {
        return Ok(PullPlan {
            configured_base: None,
            repository,
            remote,
            branch,
            head: local,
            remote_oid: String::new(),
            state: "failed",
            message: Some(format!(
                "Remote check failed: couldn't find remote ref {reference}"
            )),
        });
    };
    fetch_comparison(&remote, &branch)?;
    let configured_base = configured_base(&repository, &remote.path, &branch, &remote_oid, &local);
    let (state, message) = if local == remote_oid {
        ("current", None)
    } else if !clean(&repository.path)? {
        (
            "failed",
            Some("Working tree is dirty; pull refused without mutation".into()),
        )
    } else if is_ancestor(&repository.path, &remote_oid, &local) {
        // An unpublished local tip is absent from a local bare origin's store.
        // Compare there only for incoming fast-forwards; the checkout contains
        // both commits when origin is an ancestor and there is nothing to pull.
        ("current", None)
    } else if is_ancestor(&remote.path, &local, &remote_oid) {
        ("update", None)
    } else {
        (
            "diverged",
            Some(format!(
                "Local branch '{current_branch}' has diverged from origin/{branch}; update manually"
            )),
        )
    };
    Ok(PullPlan {
        repository,
        remote,
        branch,
        head: local,
        remote_oid,
        configured_base,
        state,
        message,
    })
}

fn pull_result(
    plan: &PullPlan,
    status: &str,
    start: Instant,
    message: Option<String>,
    output: Option<String>,
) -> Value {
    let mut fields = vec![
        ("elapsedSeconds", json!(elapsed(start))),
        ("repositoryId", json!(plan.repository.name)),
        ("status", json!(status)),
    ];
    if let Some(base) = &plan.configured_base {
        fields.push(("configuredBase", base.clone()));
    }
    if let Some(message) = message {
        fields.push(("errorMessage", json!(message)));
    }
    if let Some(output) = output.filter(|value| !value.is_empty()) {
        fields.push(("output", json!(output)));
    }
    result(fields)
}

fn execute_pull(plan: &PullPlan, timeout: Option<Duration>) -> Value {
    let start = Instant::now();
    match plan.state {
        "missing" => pull_result(
            plan,
            "skipped",
            start,
            Some(format!(
                "Repository is not materialized; run `arashi clone` to create {}.",
                plan.repository.name
            )),
            None,
        ),
        "current" => pull_result(plan, "skipped", start, None, None),
        "failed" => pull_result(plan, "failed", start, plan.message.clone(), None),
        "diverged" => pull_result(plan, "manual-update", start, plan.message.clone(), None),
        "update" => {
            let unchanged = same_remote(&plan.repository, &plan.remote)
                && head(&plan.repository.path).is_ok_and(|value| value == plan.head)
                && clean(&plan.repository.path).unwrap_or(false)
                && remote_ref(&plan.remote, &format!("refs/heads/{}", plan.branch))
                    .is_some_and(|value| value == plan.remote_oid);
            if !unchanged {
                return pull_result(
                    plan,
                    "failed",
                    start,
                    Some(
                        "Repository or remote ref changed after pull planning; no merge attempted"
                            .into(),
                    ),
                    None,
                );
            }
            let argv = vec![
                "git".into(),
                "fetch".into(),
                "--prune".into(),
                "origin".into(),
                format!("+refs/heads/{0}:refs/remotes/origin/{0}", plan.branch),
            ];
            let fetched = match crate::process::run(&argv, &plan.repository.path, timeout) {
                Ok(value) => value,
                Err(error) => {
                    return pull_result(plan, "failed", start, Some(error.to_string()), None);
                }
            };
            let stderr = fetched.stderr;
            let output = [fetched.stdout, stderr.clone()]
                .into_iter()
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_owned();
            if fetched.timed_out {
                return pull_result(
                    plan,
                    "failed",
                    start,
                    Some(format!(
                        "Timed out after {}ms",
                        timeout.unwrap_or_default().as_millis()
                    )),
                    Some(output),
                );
            }
            if fetched.exit_code != 0 {
                return pull_result(
                    plan,
                    "manual-update",
                    start,
                    Some(if stderr.trim().is_empty() {
                        "Git fetch failed".into()
                    } else {
                        stderr.trim().to_owned()
                    }),
                    Some(output),
                );
            }
            let still_safe = same_remote(&plan.repository, &plan.remote)
                && head(&plan.repository.path).is_ok_and(|value| value == plan.head)
                && clean(&plan.repository.path).unwrap_or(false)
                && exact_ref(
                    &plan.repository.path,
                    &format!("refs/remotes/origin/{}", plan.branch),
                )
                .is_some_and(|value| value == plan.remote_oid)
                && remote_ref(&plan.remote, &format!("refs/heads/{}", plan.branch))
                    .is_some_and(|value| value == plan.remote_oid);
            if !still_safe {
                return pull_result(
                    plan,
                    "failed",
                    start,
                    Some("Repository or remote ref changed during pull; no merge attempted".into()),
                    Some(output),
                );
            }
            match git::run(
                &plan.repository.path,
                &["merge", "--ff-only", &plan.remote_oid],
            ) {
                Ok(merge) => pull_result(
                    plan,
                    "updated",
                    start,
                    None,
                    Some(
                        [output, merge]
                            .into_iter()
                            .filter(|s| !s.is_empty())
                            .collect::<Vec<_>>()
                            .join("\n")
                            .trim()
                            .to_owned(),
                    ),
                ),
                Err(error) => pull_result(
                    plan,
                    "manual-update",
                    start,
                    Some(error.message),
                    Some(output),
                ),
            }
        }
        _ => unreachable!(),
    }
}

pub fn pull(workspace: &Workspace, args: &Args) -> Result<Value> {
    let mut repositories = repositories(workspace, args)?;
    // Source pulls the configuration-owning parent first, even when --only
    // lists it last. Push retains the explicit selection order.
    repositories.sort_by_key(|repository| repository.path != workspace.root);
    let config = workspace.config.as_ref().unwrap();
    let ignore = crate::managed::IgnorePlan::build(
        &workspace.root,
        &config.repos_dir,
        &config.worktrees_dir,
        false,
    )?;
    if ignore.data["attempted"] == true {
        return Err(unsupported(
            "Pull currently requires managed paths to be already ignored; no changes made",
        ));
    }
    let remotes = repositories
        .iter()
        .map(remote)
        .collect::<Result<Vec<_>>>()?;
    let plans = repositories
        .into_iter()
        .zip(remotes)
        .map(|(repository, remote)| {
            let saved = repository.clone();
            plan_pull(repository, remote).or_else(|error| {
                Ok(PullPlan {
                    repository: saved,
                    remote: Remote {
                        path: PathBuf::new(),
                        network: false,
                        url: String::new(),
                    },
                    branch: String::new(),
                    head: String::new(),
                    remote_oid: String::new(),
                    configured_base: None,
                    state: "failed",
                    message: Some(error.to_string()),
                })
            })
        })
        .collect::<Result<Vec<_>>>()?;
    if plans.iter().any(changes_control_files) {
        return Err(unsupported(
            "Pulling configuration, ignore, or submodule control files is outside this bounded slice; no changes made",
        ));
    }
    let timeout = config.raw["hooks"]["timeout"]
        .as_u64()
        .map(Duration::from_millis);
    let results: Vec<_> = plans
        .iter()
        .map(|plan| execute_pull(plan, timeout))
        .collect();
    let failures = results
        .iter()
        .filter(|value| value["status"] == "failed" || value["status"] == "manual-update")
        .count();
    let overall = if failures == 0 {
        "success"
    } else if failures == results.len() {
        "failure"
    } else {
        "partial-failure"
    };
    Ok(json!({"managedIgnore":ignore.data,"overallStatus":overall,"results":results}))
}

struct PushPlan {
    repository: Repository,
    remote: Remote,
    branch: String,
    head: String,
    expected_target: Option<String>,
    result: Value,
    push: bool,
}

fn push_base(repository: &Repository, remote: &Remote) -> Result<(String, String, Option<Value>)> {
    let branch = if let Some((branch, _)) = &repository.base {
        branch.strip_prefix("origin/").unwrap_or(branch).to_owned()
    } else {
        default_remote_branch(remote)?
    };
    let reference = format!("refs/heads/{branch}");
    let oid = remote_ref(remote, &reference).ok_or_else(|| {
        unsupported(format!(
            "Configured/default base '{branch}' is unavailable on the local origin"
        ))
    })?;
    fetch_comparison(remote, &branch)?;
    let local = head(&repository.path)?;
    let base = configured_base(repository, &repository.path, &branch, &oid, &local);
    Ok((branch, oid, base))
}

fn plan_push(repository: Repository, remote: Option<Remote>, args: &Args) -> Result<PushPlan> {
    let start = Instant::now();
    let Some(remote) = remote else {
        let name = repository.name.clone();
        return Ok(PushPlan {
            repository,
            remote: Remote {
                path: PathBuf::new(),
                network: false,
                url: String::new(),
            },
            branch: String::new(),
            head: String::new(),
            expected_target: None,
            result: result([
                ("elapsedSeconds", json!(elapsed(start))),
                ("reason", json!("repository is not materialized")),
                ("repositoryId", json!(name)),
                ("status", json!("skipped")),
            ]),
            push: false,
        });
    };
    let Some(branch) = current_branch(&repository.path) else {
        let name = repository.name.clone();
        return Ok(PushPlan {
            repository,
            remote,
            branch: String::new(),
            head: String::new(),
            expected_target: None,
            result: result([
                ("elapsedSeconds", json!(elapsed(start))),
                ("reason", json!("repository is not on a named branch")),
                ("repositoryId", json!(name)),
                ("status", json!("skipped")),
            ]),
            push: false,
        });
    };
    let local = head(&repository.path)?;
    let tracking = upstream(&repository.path);
    let (baseline_oid, configured) = if let Some(upstream) = &tracking {
        let target = upstream
            .strip_prefix("origin/")
            .ok_or_else(|| unsupported("Only origin upstreams are supported; no push attempted"))?;
        if target != branch {
            return Err(unsupported(
                "Upstream branch name differs from the current branch; configure the push policy explicitly before publishing",
            ));
        }
        let oid = remote_ref(&remote, &format!("refs/heads/{target}")).ok_or_else(|| {
            unsupported("An existing upstream must still exist on the local origin")
        })?;
        fetch_comparison(&remote, target)?;
        (oid, None)
    } else {
        let (_, oid, configured) = push_base(&repository, &remote)?;
        (oid, configured)
    };
    let ahead = count(&repository.path, &format!("{baseline_oid}..{local}")).ok_or_else(|| {
        unsupported("The remote comparison commit is unavailable locally; fetch explicitly first")
    })?;
    let target = remote_ref(&remote, &format!("refs/heads/{branch}"));
    let mut fields = vec![
        ("branch", json!(branch)),
        ("elapsedSeconds", json!(elapsed(start))),
        ("remote", json!("origin")),
        ("repositoryId", json!(repository.name)),
    ];
    if let Some(configured) = configured {
        fields.push(("configuredBase", configured));
    }
    if let Some(tracking) = &tracking {
        fields.push(("upstream", json!(tracking)));
    }
    if ahead == 0 {
        fields.push((
            "reason",
            json!("branch is already up to date or has no publishable commits"),
        ));
        fields.push(("status", json!("skipped")));
        return Ok(PushPlan {
            repository,
            remote,
            branch,
            head: local,
            expected_target: target,
            result: result(fields),
            push: false,
        });
    }
    if tracking.is_none() && !args.has("set-upstream") {
        fields.push((
            "reason",
            json!("branch has no upstream; rerun with --set-upstream to publish it"),
        ));
        fields.push(("status", json!("skipped")));
        return Ok(PushPlan {
            repository,
            remote,
            branch,
            head: local,
            expected_target: target,
            result: result(fields),
            push: false,
        });
    }
    if let Some(target_oid) = &target
        && !is_ancestor(&repository.path, target_oid, &local)
    {
        fields.push((
            "errorMessage",
            json!(format!(
                "Remote branch origin/{branch} has diverged; push refused without mutation"
            )),
        ));
        fields.push(("status", json!("failed")));
        return Ok(PushPlan {
            repository,
            remote,
            branch,
            head: local,
            expected_target: target,
            result: result(fields),
            push: false,
        });
    }
    fields.push((
        "command",
        json!(if tracking.is_some() {
            vec!["git", "push"]
        } else {
            vec!["git", "push", "--set-upstream", "origin", &branch]
        }),
    ));
    fields.push(("status", json!("planned")));
    fields.push(("upstreamSet", json!(tracking.is_none())));
    Ok(PushPlan {
        repository,
        remote,
        branch,
        head: local,
        expected_target: target,
        result: result(fields),
        push: true,
    })
}

fn same_remote(repository: &Repository, expected: &Remote) -> bool {
    remote(repository).is_ok_and(|actual| {
        actual.is_some_and(|actual| actual.url == expected.url && actual.path == expected.path)
    })
}

fn execute_push(plan: &PushPlan) -> Value {
    if !plan.push {
        return plan.result.clone();
    }
    let start = Instant::now();
    let current_target = remote_ref(&plan.remote, &format!("refs/heads/{}", plan.branch));
    let safe = same_remote(&plan.repository, &plan.remote)
        && head(&plan.repository.path).is_ok_and(|value| value == plan.head)
        && current_target == plan.expected_target;
    if !safe {
        let mut value = plan.result.clone();
        value["elapsedSeconds"] = json!(elapsed(start));
        value["errorMessage"] =
            json!("Repository or remote ref changed after push planning; no push attempted");
        value["status"] = json!("failed");
        return value;
    }
    let refspec = format!("{}:refs/heads/{}", plan.head, plan.branch);
    let mut argv = vec!["git".into(), "push".into()];
    if plan.result["upstreamSet"] == true {
        argv.push("--set-upstream".into());
    }
    argv.extend(["origin".into(), refspec]);
    let outcome = match crate::process::run(
        &argv,
        &plan.repository.path,
        plan.remote.network.then_some(Duration::from_secs(30)),
    ) {
        Ok(outcome) => outcome,
        Err(error) => {
            let mut value = plan.result.clone();
            value["elapsedSeconds"] = json!(elapsed(start));
            value["errorMessage"] = json!(error.to_string());
            value["status"] = json!("failed");
            return value;
        }
    };
    let mut value = plan.result.clone();
    value["elapsedSeconds"] = json!(elapsed(start));
    value["stdout"] = json!(outcome.stdout);
    value["stderr"] = json!(outcome.stderr);
    if outcome.exit_code == 0
        && remote_ref(&plan.remote, &format!("refs/heads/{}", plan.branch))
            .is_some_and(|oid| oid == plan.head)
    {
        if plan.result["upstreamSet"] == true
            && git::run(
                &plan.repository.path,
                &[
                    "branch",
                    "--set-upstream-to",
                    &format!("origin/{}", plan.branch),
                    &plan.branch,
                ],
            )
            .is_err()
        {
            value["errorMessage"] = json!(
                "Remote push succeeded, but local upstream setup failed; configure it manually"
            );
            value["status"] = json!("failed");
        } else {
            value["status"] = json!("pushed");
        }
    } else {
        value["errorMessage"] = json!(
            outcome
                .error
                .unwrap_or_else(|| outcome.stderr.trim().to_owned())
        );
        value["status"] = json!("failed");
    }
    value
}

pub fn push(workspace: &Workspace, args: &Args) -> Result<Value> {
    let repositories = repositories(workspace, args)?;
    let remotes = repositories
        .iter()
        .map(remote)
        .collect::<Result<Vec<_>>>()?;
    let plans = repositories
        .into_iter()
        .zip(remotes)
        .map(|(repository, remote)| {
            let saved = repository.clone();
            plan_push(repository, remote, args).or_else(|error| Ok(PushPlan {
                result: json!({"repositoryId": saved.name, "status": "failed", "elapsedSeconds": 0.0, "errorMessage": error.to_string()}),
                repository: saved, remote: Remote { path: PathBuf::new(), network: false, url: String::new() },
                branch: String::new(), head: String::new(), expected_target: None, push: false,
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    let results: Vec<_> = plans
        .iter()
        .map(|plan| {
            if args.has("dry-run") {
                plan.result.clone()
            } else {
                execute_push(plan)
            }
        })
        .collect();
    let total = results.len();
    let tally = |status: &str| {
        results
            .iter()
            .filter(|value| value["status"] == status)
            .count()
    };
    let failed = tally("failed");
    let mut options = Map::new();
    options.insert("dryRun".into(), json!(args.has("dry-run")));
    if args.has("only") {
        options.insert("only".into(), json!(normalized(args, "only")));
    }
    options.insert("setUpstream".into(), json!(args.has("set-upstream")));
    Ok(json!({
        "dryRun": args.has("dry-run"),
        "options": options,
        "overallStatus": if failed == 0 { "success" } else { "failure" },
        "results": results,
        "totals": {"failed":failed,"planned":tally("planned"),"pushed":tally("pushed"),"skipped":tally("skipped"),"total":total}
    }))
}

pub fn push_warnings(data: &Value) -> Vec<Value> {
    data["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|result| result["status"] == "skipped")
        .map(|result| {
            json!({
                "code":"REPOSITORY_SKIPPED",
                "details":{"repositoryId":result["repositoryId"]},
                "message":result["reason"].as_str().unwrap_or("repository skipped")
            })
        })
        .collect()
}

pub fn human(command: &str, data: &Value, verbose: bool) -> String {
    let mut lines = Vec::new();
    let results = data["results"].as_array().cloned().unwrap_or_default();
    for (index, result) in results.iter().enumerate() {
        lines.push(format!(
            "[{}/{}] {}",
            index + 1,
            results.len(),
            result["repositoryId"].as_str().unwrap_or("")
        ));
        if command == "pull"
            && verbose
            && let Some(output) = result["output"].as_str()
            && !output.is_empty()
        {
            lines.push(output.to_owned());
        }
        let detail = result["errorMessage"]
            .as_str()
            .or_else(|| result["reason"].as_str())
            .map(|detail| format!(" - {detail}"))
            .unwrap_or_default();
        lines.push(format!(
            "{}: {} ({:.2}s){}",
            result["repositoryId"].as_str().unwrap_or(""),
            result["status"].as_str().unwrap_or(""),
            result["elapsedSeconds"].as_f64().unwrap_or(0.0),
            detail
        ));
    }
    lines.push(String::new());
    lines.push(if command == "push" && data["dryRun"] == true {
        "Preview summary:".into()
    } else {
        "Summary:".into()
    });
    lines.push(format!("  total: {}", results.len()));
    for status in if command == "pull" {
        vec!["updated", "skipped", "failed", "manual-update"]
    } else {
        vec!["pushed", "planned", "skipped", "failed"]
    } {
        lines.push(format!(
            "  {status}: {}",
            results
                .iter()
                .filter(|result| result["status"] == status)
                .count()
        ));
    }
    lines.push(format!(
        "  overall: {}",
        data["overallStatus"].as_str().unwrap_or("")
    ));
    lines.join("\n")
}
