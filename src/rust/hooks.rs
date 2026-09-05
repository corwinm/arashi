//! Frozen configured file-hook discovery and provenance. Inline, interactive and
//! Windows execution remain explicit pre-mutation policies, not fallback shells.
use crate::{
    Error, Result,
    cli::Args,
    config::Workspace,
    managed::{safe, unsupported},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone)]
pub(crate) struct Target {
    pub name: String,
    pub root: PathBuf,
    pub worktree: Option<PathBuf>,
}
// Execution fields remain frozen on platforms whose active hooks are gated.
#[cfg_attr(not(unix), allow(dead_code))]
#[derive(Clone)]
struct Hook {
    outcome: Value,
    path: Option<PathBuf>,
    cwd: PathBuf,
    env: BTreeMap<String, String>,
    bytes: Option<Vec<u8>>,
}
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) struct Plan {
    hooks: Vec<Hook>,
    timeout: Duration,
}
fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
fn candidates(dir: &Path, name: &str) -> Result<Vec<PathBuf>> {
    safe(dir)?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    // Freeze an absolute source before execution changes cwd, including HOME=".".
    let dir = crate::paths::canonicalize(dir)?;
    let mut result = vec![];
    for e in fs::read_dir(dir)? {
        let e = e?;
        let filename = e.file_name().to_string_lossy().into_owned();
        let matches = if cfg!(windows) {
            ["ps1", "cmd", "bat"]
                .iter()
                .any(|ext| filename.eq_ignore_ascii_case(&format!("{name}.{ext}")))
        } else {
            filename == format!("{name}.sh")
        };
        if matches {
            safe(&e.path())?;
            result.push(e.path());
        }
    }
    result.sort();
    Ok(result)
}
fn validate(path: &Path) -> Result<Vec<u8>> {
    safe(path)?;
    let meta = fs::metadata(path)?;
    if !meta.is_file() {
        return Err(Error::new(
            "HOOK_VALIDATION_FAILED",
            format!("Hook is not a file: {}", path.display()),
        ));
    }
    #[cfg(unix)]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        unsafe extern "C" {
            fn access(path: *const std::ffi::c_char, mode: i32) -> i32;
        }
        let native_path = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| unsupported("Invalid lifecycle source path"))?;
        // POSIX X_OK includes ACL and identity checks, as retained fs.access does.
        if unsafe { access(native_path.as_ptr(), 1) } != 0 {
            return Err(Error::new(
                "HOOK_VALIDATION_FAILED",
                format!(
                    "Hook is not executable: {}. Run: chmod +x {}",
                    path.display(),
                    path.display()
                ),
            ));
        }
    }
    Ok(fs::read(path)?)
}
impl Plan {
    pub fn prepare(w: &Workspace, args: &Args, targets: &[Target], branch: &str) -> Result<Self> {
        let c = w.config.as_ref().unwrap();
        let create = args.command == "create";
        if create && args.has("no-hooks") {
            return Ok(Self {
                hooks: vec![],
                timeout: Duration::ZERO,
            });
        }
        let timeout = c.raw["hooks"]["timeout"].as_u64().unwrap_or(300_000);
        if timeout == 0 || timeout > 2_147_483_647 {
            return Err(unsupported(
                "Lifecycle hooks.timeout must be an integer between 1 and 2147483647",
            ));
        }
        let lifecycles = if create {
            ["pre-create", "post-create"]
        } else {
            ["pre-remove", "post-remove"]
        };
        if lifecycles.iter().any(|l| {
            c.raw["hooks"]["scripts"].get(l).is_some()
                || c.repos.values().any(|r| r.raw["hooks"].get(l).is_some())
        }) {
            return Err(unsupported(
                "Inline lifecycle hooks are not yet ported; no changes made",
            ));
        }
        // Configured create never consumes user-global sources or needs a home.
        let global = if create {
            None
        } else {
            let home = std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .ok_or_else(|| unsupported("Cannot resolve global hook directory"))?;
            Some(PathBuf::from(home).join(".arashi/hooks"))
        };
        let workspace = w.root.join(".arashi/hooks");
        let mut hooks = vec![];
        for lifecycle in lifecycles {
            let slots: Vec<(Option<&Target>, &str)> = if create {
                std::iter::once((None, "workspace"))
                    .chain(targets.iter().map(|t| (Some(t), "repository")))
                    .collect()
            } else {
                targets
                    .iter()
                    .flat_map(|t| {
                        [
                            "repository",
                            "workspace",
                            "global-repository",
                            "global-shared",
                        ]
                        .map(|s| (Some(t), s))
                    })
                    .collect()
            };
            for (target, scope) in slots {
                let name = target.map(|t| t.name.as_str());
                if name.is_some_and(|n| n.contains(['/', '\\']) || n == "." || n == "..") {
                    return Err(unsupported("Unsafe lifecycle repository identifier"));
                }
                let hook_name = if create && scope == "repository" {
                    format!("{lifecycle}.{}", name.unwrap())
                } else {
                    lifecycle.to_owned()
                };
                let mut paths = if create {
                    candidates(&workspace, &hook_name)?
                } else {
                    let t = target.unwrap();
                    match scope {
                        "repository" => {
                            let mut paths =
                                candidates(&workspace, &format!("{lifecycle}.{}", t.name))?;
                            if t.root != w.root {
                                paths.extend(candidates(&t.root.join(".arashi/hooks"), lifecycle)?);
                            }
                            paths
                        }
                        "workspace" => candidates(&workspace, lifecycle)?,
                        "global-repository" => {
                            candidates(&global.as_ref().unwrap().join(&t.name), lifecycle)?
                        }
                        _ => candidates(global.as_ref().unwrap(), lifecycle)?,
                    }
                };
                if paths.len() > 1 {
                    return Err(Error::new(
                        "HOOK_AMBIGUOUS",
                        format!(
                            "Ambiguous lifecycle hook '{hook_name}': {}",
                            paths.iter().map(|p| text(p)).collect::<Vec<_>>().join(", ")
                        ),
                    ));
                }
                let path = paths.pop();
                let bytes = path.as_deref().map(validate).transpose()?;
                let cwd = if scope == "workspace" {
                    w.root.clone()
                } else if create {
                    target.unwrap().worktree.clone().unwrap()
                } else {
                    target.unwrap().root.clone()
                };
                let owner = match scope {
                    "repository" => "repository",
                    "workspace" => "workspace",
                    _ => "user-global",
                };
                let outcome = json!({"executionPath":cwd,"hookName":hook_name,"hookStatus":"skipped","message":"Hook script not found","reasonCode":"not_found","repositoryId":name.unwrap_or("workspace"),"scope":scope,"sourceKind":"file","sourceOwnerKind":owner,"sourceOwnerName":if scope=="repository"{json!(name)}else{Value::Null},"sourceScriptPath":path,"targetRepositoryName":name,"targetRepositoryPath":target.map(|t| &t.root),"targetWorktreePath":target.and_then(|t| t.worktree.as_ref()),"workspaceMode":"configured"});
                let mut env = BTreeMap::new();
                for (key, value) in [
                    ("HOOK_NAME", hook_name),
                    ("HOOK_SCOPE", scope.to_owned()),
                    ("HOOK_INPUT", "disabled".into()),
                    ("HOOK_EXECUTION_PATH", text(&cwd)),
                    ("HOOK_WORKSPACE_MODE", "configured".into()),
                    ("MAIN_REPO_PATH", text(&w.root)),
                    ("BRANCH_NAME", branch.to_owned()),
                ] {
                    env.insert(format!("ARASHI_{key}"), value);
                }
                if let Some(p) = &path {
                    env.insert("ARASHI_HOOK_SOURCE_PATH".into(), text(p));
                }
                if let Some(t) = target {
                    for (k, v) in [
                        ("HOOK_TARGET_REPOSITORY", t.name.clone()),
                        ("HOOK_TARGET_REPO_PATH", text(&t.root)),
                        ("REPO_NAME", t.name.clone()),
                        (
                            "REPO_PATH",
                            text(if create {
                                t.worktree.as_ref().unwrap()
                            } else {
                                &t.root
                            }),
                        ),
                    ] {
                        env.insert(format!("ARASHI_{k}"), v);
                    }
                    if let Some(p) = &t.worktree {
                        for k in ["WORKTREE_PATH", "HOOK_TARGET_WORKTREE_PATH"] {
                            env.insert(format!("ARASHI_{k}"), text(p));
                        }
                    }
                    if create {
                        let parent = if t.root == w.root {
                            w.root.clone()
                        } else {
                            let depth = t
                                .root
                                .strip_prefix(&w.root)
                                .map_err(|_| {
                                    unsupported("External lifecycle targets are unsupported")
                                })?
                                .components()
                                .count();
                            t.worktree
                                .as_ref()
                                .unwrap()
                                .ancestors()
                                .nth(depth)
                                .ok_or_else(|| {
                                    unsupported("Cannot resolve lifecycle parent worktree")
                                })?
                                .to_owned()
                        };
                        env.insert("ARASHI_PARENT_REPO_PATH".into(), text(&parent));
                    }
                } else if std::env::var_os("ARASHI_REPO_PATH").is_none_or(|v| v.is_empty()) {
                    env.insert("ARASHI_REPO_PATH".into(), text(&cwd));
                }
                if !create {
                    env.extend(remove_environment(w, targets, branch));
                }
                // Source suppresses absent unconfigured main-repository create slots.
                if create
                    && scope == "repository"
                    && path.is_none()
                    && !c.repos.contains_key(name.unwrap())
                {
                    continue;
                }
                hooks.push(Hook {
                    outcome,
                    path,
                    cwd,
                    env,
                    bytes,
                });
            }
        }
        if hooks.iter().any(|h| h.path.is_some()) {
            if cfg!(windows) {
                return Err(unsupported(
                    "Windows lifecycle file execution is not yet ported; no changes made",
                ));
            }
            use std::io::IsTerminal;
            if !args.has("json") || std::io::stdin().is_terminal() {
                return Err(unsupported(
                    "Active lifecycle hooks currently require --json and nonterminal stdin (disabled input); human/terminal input is not yet ported",
                ));
            }
            if args.has("dry-run") {
                return Err(unsupported(
                    "Active lifecycle hook dry-run previews are not yet ported; no changes made",
                ));
            }
        }
        Ok(Self {
            hooks,
            timeout: Duration::from_millis(timeout),
        })
    }
    #[cfg(unix)]
    pub fn guard(&self) -> Result<Option<crate::process::lifecycle::InterruptGuard>> {
        self.hooks
            .iter()
            .any(|h| h.path.is_some())
            .then(crate::process::lifecycle::InterruptGuard::install)
            .transpose()
            .map_err(Into::into)
    }
    #[cfg(not(unix))]
    pub fn guard(&self) -> Result<Option<()>> {
        Ok(None)
    }
    pub fn run(
        &self,
        lifecycle: &str,
        repository: Option<&str>,
        stop_on_failure: bool,
    ) -> Result<Vec<Value>> {
        let mut outcomes = vec![];
        for hook in &self.hooks {
            if hook.outcome["hookName"] != lifecycle {
                continue;
            }
            if repository.is_some_and(|name| hook.outcome["repositoryId"] != name) {
                continue;
            }
            #[cfg_attr(not(unix), allow(unused_mut))]
            let mut outcome = hook.outcome.clone();
            #[cfg_attr(not(unix), allow(unused_mut))]
            let mut child_interrupted = false;
            if let Some(path) = &hook.path {
                #[cfg(unix)]
                {
                    if crate::process::lifecycle::interrupted() {
                        return Err(Error::new("HOOK_INTERRUPTED", "Lifecycle interrupted"));
                    }
                    let execution = (|| -> Result<crate::process::Captured> {
                        if Some(validate(path)?) != hook.bytes {
                            return Err(Error::new(
                                "HOOK_CHANGED",
                                "Prepared hook source changed before execution",
                            ));
                        }
                        safe(&hook.cwd)?;
                        Ok(crate::process::lifecycle::run(
                            path,
                            &hook.cwd,
                            &hook.env,
                            self.timeout,
                        )?)
                    })();
                    match execution {
                        Ok(result) => {
                            // Retained remove stops post-hook continuation on actual
                            // SIGINT, but ordinary failures (including exit 130) continue.
                            child_interrupted = result.termination_signal == Some(2);
                            let success = result.exit_code == 0;
                            outcome["durationMs"] = json!(result.elapsed_ms);
                            outcome["hookStatus"] =
                                json!(if success { "success" } else { "failure" });
                            outcome["reasonCode"] = json!(if success {
                                "none"
                            } else if result.timed_out {
                                "timeout"
                            } else {
                                "exit_non_zero"
                            });
                            outcome["message"] = json!(if success {
                                "Hook completed".into()
                            } else if !result.stderr.trim().is_empty() {
                                result.stderr.trim().to_owned()
                            } else if result.timed_out {
                                "Hook timed out after configured limit".into()
                            } else {
                                format!("Hook exited with code {}", result.exit_code)
                            });
                        }
                        Err(e) => {
                            outcome["hookStatus"] = json!("failure");
                            outcome["reasonCode"] = json!("validation_failed");
                            outcome["message"] = json!(e.message);
                        }
                    }
                }
                #[cfg(not(unix))]
                {
                    let _ = path;
                    return Err(unsupported(
                        "Lifecycle execution is not yet ported on this platform",
                    ));
                }
            }
            let failed = outcome["hookStatus"] == "failure";
            outcomes.push(outcome);
            if failed && (stop_on_failure || interrupted() || child_interrupted) {
                break;
            }
        }
        Ok(outcomes)
    }
}
pub(crate) fn interrupted() -> bool {
    #[cfg(unix)]
    {
        crate::process::lifecycle::interrupted()
    }
    #[cfg(not(unix))]
    {
        false
    }
}
pub(crate) fn failure(outcomes: &[Value]) -> Option<String> {
    let failures: Vec<_> = outcomes
        .iter()
        .filter(|o| o["hookStatus"] == "failure")
        .map(|o| {
            format!(
                "[{}:{}] {}",
                o["scope"].as_str().unwrap(),
                o["repositoryId"].as_str().unwrap(),
                o["message"].as_str().unwrap()
            )
        })
        .collect();
    (!failures.is_empty()).then(|| failures.join("; "))
}
fn remove_environment(w: &Workspace, targets: &[Target], branch: &str) -> BTreeMap<String, String> {
    let mut targets: Vec<_> = targets.iter().map(|t| json!({"repository":t.name,"branchName":branch,"worktreePath":t.worktree.as_ref().map(|p| text(p).replace('\\',"/"))})).collect();
    targets.sort_by(|a, b| a["repository"].as_str().cmp(&b["repository"].as_str()));
    let names = targets
        .iter()
        .map(|t| t["repository"].as_str().unwrap())
        .collect::<BTreeSet<_>>();
    let paths = targets
        .iter()
        .filter_map(|t| t["worktreePath"].as_str())
        .collect::<BTreeSet<_>>();
    // Serialize with the retained property's insertion order, independent of serde map ordering.
    let target_json = format!(
        "[{}]",
        targets
            .iter()
            .map(|t| format!(
                "{{\"branchName\":{},\"repository\":{},\"worktreePath\":{}}}",
                t["branchName"], t["repository"], t["worktreePath"]
            ))
            .collect::<Vec<_>>()
            .join(",")
    );
    [
        ("OPERATION", "remove".into()),
        ("MAIN_REPO_PATH", text(&w.root)),
        ("REMOVE_TARGETS_JSON", target_json),
        ("REMOVE_TARGET_BRANCHES", branch.into()),
        (
            "REMOVE_TARGET_WORKTREES",
            paths.iter().copied().collect::<Vec<_>>().join(","),
        ),
        (
            "REMOVE_TARGET_REPOSITORIES",
            names.iter().copied().collect::<Vec<_>>().join(","),
        ),
        ("REMOVE_TOTAL_BRANCHES", "1".into()),
        ("REMOVE_TOTAL_WORKTREES", paths.len().to_string()),
        ("REMOVE_TOTAL_REPOSITORIES", names.len().to_string()),
    ]
    .into_iter()
    .map(|(k, v)| (format!("ARASHI_{k}"), v))
    .collect()
}
