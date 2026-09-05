//! Bounded local doctor. Observations never fetch, execute hooks, reconcile ignores, or prune.
use crate::{Error, Result, config::Workspace, git};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};
fn unsupported(message: &str) -> Error {
    Error::new("PORT_UNSUPPORTED", message)
}
fn read_git(path: &Path, args: &[&str]) -> Result<String> {
    let mut command = vec!["--no-optional-locks", "-c", "core.fsmonitor=false"];
    command.extend_from_slice(args);
    git::run(path, &command)
}
fn finding(
    category: &str,
    code: &str,
    severity: &str,
    scope: &str,
    message: String,
    details: Option<Value>,
    commands: Vec<String>,
) -> Value {
    let mut v = json!({"category":category,"code":code,"severity":severity,"scope":scope,"message":message,"suggestedCommands":commands});
    if let Some(d) = details {
        v["details"] = d;
    }
    v
}
fn commands(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}
fn finish(mut data: Value, findings: Vec<Value>) -> Result<Value> {
    let count = |s: &str| findings.iter().filter(|f| f["severity"] == s).count();
    let errors = count("error");
    data["summary"] = json!({"error":errors,"warning":count("warning"),"info":count("info"),"total":findings.len()});
    data["findings"] = json!(findings);
    if errors > 0 {
        Err(Error::new(
            "DOCTOR_BLOCKING_FINDINGS",
            format!("{errors} blocking doctor finding(s) detected"),
        )
        .with_details(data))
    } else {
        Ok(data)
    }
}
fn hooks_guard(dir: &Path) -> Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_dir() || !entry.file_name().to_string_lossy().ends_with(".example")
        {
            return Err(unsupported(
                "Doctor hook definitions are not yet supported; no hooks executed",
            ));
        }
    }
    Ok(())
}
fn policy_guard(w: &Workspace, cwd: &Path, targets: &[(String, PathBuf)]) -> Result<()> {
    if let Some(c) = &w.config {
        for raw in std::iter::once(&c.raw)
            .chain(c.repos.values().map(|r| &r.raw))
            .chain(c.raw.get("meta"))
        {
            if raw.get("hooks").is_some_and(|h| {
                h.get("scripts")
                    .and_then(Value::as_object)
                    .is_some_and(|s| !s.is_empty())
                    || h.as_object()
                        .is_some_and(|o| o.keys().any(|k| k != "timeout" && k != "scripts"))
            }) {
                return Err(unsupported(
                    "Doctor inline hook policies are not yet supported",
                ));
            }
            if ["copy", "symlink"].iter().any(|k| {
                raw.get(k)
                    .and_then(Value::as_array)
                    .is_some_and(|v| !v.is_empty())
            }) {
                return Err(unsupported(
                    "Doctor materialization policies are not yet supported",
                ));
            }
        }
        if let Ok(root) = read_git(cwd, &["rev-parse", "--show-toplevel"])
            && git::worktrees(cwd)?.first().is_some_and(|t| {
                !crate::paths::same_existing(&t.path, Path::new(root.trim())).unwrap_or(false)
            })
        {
            return Err(unsupported(
                "Doctor configured linked execution topology is not yet supported",
            ));
        }
    }
    for (_, p) in targets {
        if !p.exists() {
            continue;
        }
        crate::managed::safe(p)?;
        // Status recursively enters initialized gitlinks, whose local filters are
        // not covered by this target's configuration. Inspect only index metadata
        // (NUL-delimited so unusual paths cannot hide a gitlink), and reject the
        // entire topology before any target is observed. Do not hide dirty state
        // with --ignore-submodules. Uninitialized gitlinks are rejected too.
        match read_git(p, &["ls-files", "--stage", "-z"]) {
            Ok(index) if index.split('\0').any(|entry| entry.starts_with("160000 ")) => {
                return Err(unsupported(
                    "Doctor submodule topology is not yet supported; no repository status observed",
                ));
            }
            Err(_) if read_git(p, &["rev-parse", "--git-dir"]).is_ok() => {
                return Err(unsupported(
                    "Doctor could not safely inspect repository index topology; no repository status observed",
                ));
            }
            // Broken repositories retain their existing diagnostic findings.
            _ => {}
        }
        if read_git(
            p,
            &["config", "--get-regexp", r"^filter\..*\.(clean|process)$"],
        )
        .is_ok()
        {
            return Err(unsupported(
                "Doctor Git conversion filters are not yet supported; no filter executed",
            ));
        }
        if let Ok(remotes) = read_git(p, &["remote"])
            && !remotes.trim().is_empty()
        {
            return Err(unsupported(
                "Doctor remote-backed repositories are not yet supported; no fetch attempted",
            ));
        }
        if read_git(p, &["for-each-ref", "--format=%(refname)", "refs/remotes"])
            .is_ok_and(|s| !s.trim().is_empty())
        {
            return Err(unsupported(
                "Doctor remote-tracking refs are not yet supported",
            ));
        }
        if read_git(
            p,
            &["config", "--get-regexp", r"^branch\..*\.(remote|merge)$"],
        )
        .is_ok()
        {
            return Err(unsupported(
                "Doctor upstream tracking policies are not yet supported",
            ));
        }
        if let Ok(trees) = git::worktrees(p)
            && trees.first().is_some_and(|t| {
                t.bare || !crate::paths::same_existing(&t.path, p).unwrap_or(false)
            })
        {
            return Err(unsupported(
                "Doctor requires primary non-bare repository targets",
            ));
        }
        hooks_guard(&p.join(".arashi/hooks"))?;
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        hooks_guard(&PathBuf::from(home).join(".arashi/hooks"))?;
    }
    if read_git(
        &w.root,
        &["config", "--local", "--get", "arashi.ignoreScope"],
    )
    .is_ok()
    {
        return Err(unsupported(
            "Doctor stored ignore-scope preferences are not yet supported",
        ));
    }
    Ok(())
}
// Configured source probes the directory itself; standalone probes a child.
// Keep exit 1 (unignored) distinct from inspection failure.
fn ignored(root: &Path, relative: &str) -> Result<bool> {
    let mut child = std::process::Command::new("git")
        .args([
            "--no-optional-locks",
            "check-ignore",
            "--no-index",
            "-z",
            "-v",
            "--stdin",
        ])
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;
    use std::io::Write;
    let write = child
        .stdin
        .take()
        .unwrap()
        .write_all(format!("{relative}\0").as_bytes());
    let output = child.wait_with_output()?;
    write?;
    match output.status.code() {
        Some(1) => Ok(false),
        Some(0) => {
            let fields: Vec<_> = output.stdout.split(|b| *b == 0).collect();
            if fields.len() < 4 {
                return Err(Error::new("GIT_ERROR", "Malformed Git ignore evidence"));
            }
            Ok(!fields[2].starts_with(b"!"))
        }
        _ => Err(Error::new(
            "GIT_ERROR",
            format!(
                "Git command failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        )),
    }
}
fn ignore_findings(w: &Workspace) -> Result<Vec<Value>> {
    let mut f = vec![];
    if let Some(c) = &w.config {
        let mut rules = vec![];
        for input in [&c.repos_dir, &c.worktrees_dir] {
            let relative = crate::managed::relative(input)?;
            crate::managed::safe(&w.root.join(&relative))?;
            let normalized = relative.to_string_lossy().replace('\\', "/");
            let escaped: String = normalized
                .chars()
                .enumerate()
                .flat_map(|(i, c)| {
                    if "*?[]".contains(c) || (i == 0 && "#!".contains(c)) {
                        vec!['\\', c]
                    } else {
                        vec![c]
                    }
                })
                .collect();
            let rule = format!("/{escaped}/");
            if rules.contains(&rule) {
                continue;
            }
            if !ignored(&w.root, &format!("{normalized}/"))? {
                f.push(finding(
                    "configuration",
                    "MANAGED_IGNORE_MISSING",
                    "warning",
                    &format!("managed-ignore:{rule}"),
                    format!("Managed path '{rule}' is not effectively ignored (scope: local)."),
                    Some(json!({"path":input,"rule":rule,"scope":"local"})),
                    commands(&["arashi init --ignore-scope local"]),
                ));
            }
            rules.push(rule);
        }
        let local = w
            .root
            .join(read_git(&w.root, &["rev-parse", "--git-path", "info/exclude"])?.trim());
        for (target, path) in [("local", local), ("tracked", w.root.join(".gitignore"))] {
            let text = match fs::read_to_string(&path) {
                Ok(s) => s,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
                Err(e) => return Err(e.into()),
            };
            let mut owned = false;
            for line in text.lines() {
                if line.trim() == "# BEGIN Arashi managed ignore rules" {
                    if owned {
                        return Err(unsupported("Nested managed ignore blocks are unsupported"));
                    }
                    owned = true;
                    continue;
                }
                if line.trim() == "# END Arashi managed ignore rules" {
                    owned = false;
                    continue;
                }
                let rule = line.trim();
                if owned
                    && !rule.is_empty()
                    && !rule.starts_with('#')
                    && !rules.iter().any(|r| r == rule)
                {
                    f.push(finding(
                        "configuration",
                        "MANAGED_IGNORE_STALE_RULE",
                        "warning",
                        &format!("managed-ignore:{target}"),
                        format!(
                            "Arashi-owned ignore rule '{rule}' is stale in {}.",
                            path.display()
                        ),
                        Some(json!({"path":path,"rule":rule,"target":target})),
                        commands(&["arashi init --ignore-scope local"]),
                    ));
                }
            }
            if owned {
                return Err(unsupported(
                    "Incomplete managed ignore blocks are unsupported",
                ));
            }
        }
    } else if !ignored(&w.root, ".worktrees/.arashi-ignore-probe")? {
        f.push(finding(
            "configuration",
            "STANDALONE_WORKTREES_NOT_IGNORED",
            "warning",
            &w.root.to_string_lossy(),
            ".worktrees is not effectively ignored".into(),
            None,
            commands(&["arashi init --zero-config"]),
        ));
    }
    Ok(f)
}
fn repository(name: &str, path: &Path, base: Option<(&str, &str)>) -> Vec<Value> {
    let scope = format!("repository:{name}");
    let p = path.display();
    let mut f = vec![];
    if !path.exists() {
        return vec![finding(
            "repository",
            "REPOSITORY_MISSING",
            "error",
            &scope,
            format!("Configured repository '{name}' is missing at {p}."),
            Some(json!({"path":path,"repository":name})),
            vec!["arashi clone".into(), format!("git clone <url> {p}")],
        )];
    }
    let status = read_git(path, &["status", "--porcelain=v1", "--branch"]);
    let output = match status {
        Ok(s) => s,
        Err(e) => {
            let error = format!("Git command failed: {e}");
            return vec![finding(
                "repository",
                "REPOSITORY_STATUS_FAILED",
                "error",
                &scope,
                format!("Could not collect Git status for '{name}': {error}"),
                Some(json!({"error":error,"path":path,"repository":name})),
                vec![format!("git -C {p} status")],
            )];
        }
    };
    let files: Vec<_> = output.lines().skip(1).filter(|s| s.len() >= 3).collect();
    if !files.is_empty() {
        let staged = files.iter().filter(|s| s.as_bytes()[0] != b' ').count();
        let unstaged = files
            .iter()
            .filter(|s| !matches!(s.as_bytes()[1], b' ' | b'?'))
            .count();
        let untracked = files.iter().filter(|s| s.as_bytes()[1] == b'?').count();
        f.push(finding("repository","REPOSITORY_DIRTY","warning",&scope,format!("Repository '{name}' has uncommitted changes."),Some(json!({"changes":{"staged":staged,"unstaged":unstaged,"untracked":untracked},"path":path,"repository":name})),vec!["arashi status --verbose".into(),format!("git -C {p} status")]));
    }
    // Match the source's porcelain heading, including its unborn-branch label.
    let branch = output
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("## "))
        .filter(|line| !line.contains("no branch") && !line.starts_with("HEAD (detached"))
        .and_then(|line| line.split("...").next());
    if let Some(branch) = branch {
        let branch = branch.trim();
        f.push(finding(
            "repository",
            "REPOSITORY_NO_UPSTREAM",
            "warning",
            &scope,
            format!("Repository '{name}' branch '{branch}' has no upstream."),
            Some(json!({"branch":branch,"path":path,"repository":name})),
            vec![
                "arashi status".into(),
                format!("git -C {p} branch --set-upstream-to <upstream>"),
            ],
        ));
    } else {
        f.push(finding(
            "repository",
            "REPOSITORY_DETACHED_HEAD",
            "warning",
            &scope,
            format!("Repository '{name}' is in detached HEAD state."),
            Some(json!({"path":path,"repository":name})),
            vec![format!("git -C {p} switch <branch>")],
        ));
    }
    // The source resolves configured bases through a remote, even when a local
    // branch exists. policy_guard has established that no target has a remote.
    if let Some((base, source)) = base {
        // Source checkRepoStatus and configured comparison each normalize once;
        // remote resolution normalizes again when constructing its failure.
        let base = base.strip_prefix("origin/").unwrap_or(base);
        let base = base.strip_prefix("origin/").unwrap_or(base);
        let remote_base = base.strip_prefix("origin/").unwrap_or(base);
        let message = format!("No remote is available for configured base branch '{remote_base}'");
        f.push(finding(
            "repository",
            "REPOSITORY_CONFIGURED_BASE_UNAVAILABLE",
            "warning",
            &scope,
            format!("Could not compare '{name}' with configured base {base}: {message}"),
            Some(json!({"alsoDefault":false,"baseBranch":base,"compareRef":null,"failure":{"error":message},"message":message,"reason":"unresolved-target","remote":null,"remoteRef":null,"repository":name,"source":source})),
            commands(&["arashi status --verbose", "arashi pull"]),
        ));
    }
    if let Some(branch) = branch.map(str::trim)
        && let Ok(default) = git::default_branch(path)
        && default != branch
    {
        match read_git(path,&["rev-list","--left-right","--count",&format!("HEAD...refs/heads/{default}")]) {
                Ok(counts)=>{if let Some(behind)=counts.split_whitespace().nth(1).and_then(|s|s.parse::<u64>().ok()) && behind>0 {f.push(finding("repository","REPOSITORY_DEFAULT_BRANCH_BEHIND","warning",&scope,format!("Repository '{name}' is behind default branch {default} by {behind} commit(s)."),Some(json!({"behind":behind,"defaultBranch":default,"repository":name})),vec!["arashi status".into(),format!("git -C {p} merge {default}")]));}},
                Err(e)=>f.push(finding("repository","REPOSITORY_DEFAULT_BRANCH_UNAVAILABLE","info",&scope,format!("Could not compare '{name}' with its default branch."),Some(json!({"defaultBranch":default,"message":format!("Git command failed: {e}"),"repository":name})),vec!["arashi status".into(),format!("git -C {p} fetch")])),
            }
    }
    f
}
fn worktree_findings(name: &str, path: &Path) -> Vec<Value> {
    let scope = format!("repository:{name}");
    match git::worktrees(path) {
        Ok(records) => records
            .into_iter()
            .filter_map(|t| {
                t.prune_reason.map(|reason| {
                    finding(
                        "worktree",
                        "WORKTREE_STALE_METADATA",
                        "warning",
                        &scope,
                        format!(
                            "Repository '{name}' has stale worktree metadata for {}.",
                            t.path.display()
                        ),
                        Some(json!({"path":t.path,"pruneReason":reason,"repository":name})),
                        commands(&["arashi prune --dry-run", "arashi prune"]),
                    )
                })
            })
            .collect(),
        Err(e) => {
            let error = if !path.exists() {
                format!(
                    "Failed to spawn git command: Working directory not found: {}",
                    path.display()
                )
            } else {
                format!("Git command failed: {e}")
            };
            vec![finding(
                "worktree",
                "WORKTREE_DISCOVERY_FAILED",
                "error",
                &scope,
                format!("Could not inspect worktree metadata for '{name}': {error}"),
                Some(json!({"error":error,"path":path,"repository":name})),
                vec![format!(
                    "git -C {} worktree list --porcelain",
                    path.display()
                )],
            )]
        }
    }
}
pub fn doctor(cwd: &Path) -> Result<Value> {
    let w = match Workspace::discover(cwd) {
        Ok(w) => w,
        Err(e) if e.code == "CONFIG_NOT_FOUND" => {
            return finish(
                json!({"checkedCategories":["workspace"],"workspaceRoot":null,"mode":"configured"}),
                vec![finding(
                    "workspace",
                    "DOCTOR_NOT_IN_WORKSPACE",
                    "error",
                    "workspace",
                    "No Arashi workspace was found from the current directory.".into(),
                    Some(json!({"error":e.message})),
                    commands(&["arashi init", "cd <arashi-workspace>"]),
                )],
            );
        }
        Err(e) if e.code.starts_with("CONFIG_") || e.code == "UNSUPPORTED_CONFIG_VERSION" => {
            let message = e.message.clone();
            let f = finding(
                "configuration",
                "CONFIG_LOAD_FAILED",
                "error",
                &cwd.to_string_lossy(),
                message.clone(),
                e.details,
                vec![],
            );
            let result = finish(json!({"checkedCategories":["configuration"]}), vec![f]);
            return result.map_err(|mut e| {
                e.message = format!("1 blocking doctor finding(s) detected: {message}");
                e
            });
        }
        Err(e) => return Err(e),
    };
    let standalone = w.config.is_none();
    let main_name = w
        .root
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let mut targets = vec![(main_name.clone(), w.root.clone())];
    if let Some(c) = &w.config {
        for name in &c.repo_order {
            let configured = w.root.join(&c.repos[name].path);
            let relative = configured.strip_prefix(&w.root).map_err(|_| {
                unsupported("Doctor external repository paths are not yet supported")
            })?;
            let relative = crate::managed::relative(&relative.to_string_lossy())?;
            targets.push((name.clone(), w.root.join(relative)));
        }
    }
    policy_guard(&w, cwd, &targets)?;
    // Fail closed for unsupported inspection policies, retaining genuine phase failures below.
    let mut findings = match ignore_findings(&w) {
        Ok(f) => f,
        Err(e) if e.code == "PORT_UNSUPPORTED" || e.code == "RUST_NOT_YET_PORTED" => return Err(e),
        Err(e) => vec![finding(
            "workspace",
            "DOCTOR_PHASE_FAILED",
            "error",
            "workspace",
            format!("A doctor diagnostic phase failed: {e}"),
            Some(json!({"error":e.message})),
            commands(&["arashi status --verbose", "arashi prune --dry-run"]),
        )],
    };
    for (i, (name, path)) in targets.iter().enumerate() {
        let base = w.config.as_ref().and_then(|config| {
            let raw = if i == 0 {
                &config.raw["meta"]
            } else {
                &config.repos[name].raw
            };
            raw["baseBranch"]
                .as_str()
                .map(|branch| (branch, "repository-config"))
                .or_else(|| {
                    config.raw["baseBranch"]
                        .as_str()
                        .map(|branch| (branch, "workspace-config"))
                })
        });
        findings.extend(repository(
            if i == 0 && !standalone {
                "Main Repository"
            } else {
                name
            },
            path,
            base,
        ));
    }
    for (name, path) in &targets {
        findings.extend(worktree_findings(name, path));
    }
    let data = if standalone {
        json!({"checkedCategories":["workspace","repository","worktree"],"mode":"standalone","repositoryPath":w.root,"workspaceRoot":w.root})
    } else {
        json!({"checkedCategories":["workspace","configuration","repository","worktree","hook","shell","install"],"mode":"configured","workspaceRoot":w.root,"worktreesBase":w.metadata()["worktreesBase"]})
    };
    finish(data, findings)
}
pub fn human(data: &Value) -> String {
    let mut lines = vec![];
    if data["mode"] == "standalone" {
        lines.push("Workspace mode: standalone".into());
    }
    lines.push("Arashi workspace doctor".into());
    if let Some(root) = data["workspaceRoot"].as_str() {
        lines.push(format!("Workspace: {root}"));
    }
    let s = &data["summary"];
    lines.push(format!(
        "Summary: {} blocking, {} warning, {} info ({} total)",
        s["error"], s["warning"], s["info"], s["total"]
    ));
    let findings = data["findings"].as_array().unwrap();
    if findings.is_empty() {
        lines.push("\n✓ No workspace health findings were detected.".into());
    }
    for (severity, heading, label) in [
        ("error", "Blocking findings", "BLOCKING"),
        ("warning", "Warnings", "WARNING"),
        ("info", "Information", "INFO"),
    ] {
        let group: Vec<_> = findings
            .iter()
            .filter(|f| f["severity"] == severity)
            .collect();
        if group.is_empty() {
            continue;
        }
        lines.push(String::new());
        lines.push(heading.into());
        for f in group {
            lines.push(format!(
                "  {label} {} [{}]",
                f["code"].as_str().unwrap(),
                f["scope"].as_str().unwrap()
            ));
            lines.push(format!("    {}", f["message"].as_str().unwrap()));
            let commands = f["suggestedCommands"].as_array().unwrap();
            if !commands.is_empty() {
                lines.push("    Suggested commands:".into());
                for c in commands {
                    lines.push(format!("      - {}", c.as_str().unwrap()));
                }
            }
        }
    }
    lines.join("\n")
}
