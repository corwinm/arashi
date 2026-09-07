//! Doctor diagnostics refresh tracking refs without changing caller checkouts or configuration.
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
fn optional(path: &Path, args: &[&str]) -> Option<String> {
    read_git(path, args)
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}
// Keep this retained-source resolution local to doctor: the shared helper
// removes every origin/ prefix and does not implement the remote-only fallback.
fn doctor_default_branch(path: &Path) -> Option<String> {
    if let Some(value) = optional(
        path,
        &["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
    ) {
        return Some(value.strip_prefix("origin/").unwrap_or(&value).to_owned());
    }
    for namespace in ["refs/remotes/origin", "refs/heads"] {
        for branch in ["main", "master", "develop"] {
            if read_git(
                path,
                &["show-ref", "--verify", &format!("{namespace}/{branch}")],
            )
            .is_ok()
            {
                return Some(branch.into());
            }
        }
    }
    if let Some(branches) = optional(
        path,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    ) && let Some(first) = branches.lines().map(str::trim).find(|s| !s.is_empty())
    {
        return Some(first.into());
    }
    let branches = optional(path, &["branch", "-r", "--list"])?;
    branches
        .lines()
        .map(str::trim)
        .find(|s| !s.is_empty() && !s.contains("HEAD"))
        .map(|s| s.strip_prefix("origin/").unwrap_or(s).to_owned())
}
fn default_remote(path: &Path) -> Option<String> {
    let remotes = optional(path, &["remote"])?;
    remotes
        .lines()
        .find(|r| *r == "origin")
        .or_else(|| remotes.lines().next())
        .map(str::to_owned)
}
fn remote_for_branch(path: &Path, branch: &str) -> Option<String> {
    if read_git(
        path,
        &[
            "show-ref",
            "--verify",
            &format!("refs/remotes/origin/{branch}"),
        ],
    )
    .is_ok()
    {
        return Some("origin".into());
    }
    let refs = optional(
        path,
        &["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
    )?;
    let remotes: Vec<_> = refs
        .lines()
        .filter_map(|r| r.split_once('/'))
        .filter(|(_, b)| *b == branch && *b != "HEAD")
        .map(|(r, _)| r)
        .collect();
    if remotes.contains(&"origin") {
        return Some("origin".into());
    }
    if let Some(default) = default_remote(path)
        && remotes.contains(&default.as_str())
    {
        return Some(default);
    }
    remotes.first().map(|r| (*r).to_owned())
}
#[derive(Clone)]
struct TrackingTarget {
    remote: String,
    branch: String,
    upstream: bool,
}
impl TrackingTarget {
    fn reference(&self) -> String {
        format!("refs/remotes/{}/{}", self.remote, self.branch)
    }
}
fn tracking_target(path: &Path) -> Option<TrackingTarget> {
    let upstream = optional(
        path,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    );
    if let Some(u) = &upstream
        && !u.starts_with("refs/heads/")
        && let Some((remote, branch)) = u.strip_prefix("refs/remotes/").unwrap_or(u).split_once('/')
    {
        return Some(TrackingTarget {
            remote: remote.into(),
            branch: branch.into(),
            upstream: true,
        });
    }
    let current = optional(path, &["rev-parse", "--abbrev-ref", "HEAD"]).filter(|b| b != "HEAD")?;
    let remote = optional(
        path,
        &["config", "--get", &format!("branch.{current}.remote")],
    )
    .filter(|r| r != ".")
    .or_else(|| default_remote(path))?;
    let branch = optional(
        path,
        &["config", "--get", &format!("branch.{current}.merge")],
    )
    .and_then(|b| b.strip_prefix("refs/heads/").map(str::to_owned))
    .unwrap_or(current);
    Some(TrackingTarget {
        remote,
        branch,
        upstream: upstream.is_some(),
    })
}
fn refresh(path: &Path, target: &TrackingTarget) -> Option<Value> {
    let argv = vec![
        "git".into(),
        "fetch".into(),
        "--prune".into(),
        target.remote.clone(),
        format!("+refs/heads/{}:{}", target.branch, target.reference()),
    ];
    let error = match crate::process::run_tree(&argv, path, std::time::Duration::from_secs(30)) {
        Ok(o) if o.timed_out => "Remote operation timed out after 30000ms".to_owned(),
        Ok(o) if o.exit_code == 0 => return None,
        Ok(o) => o.stderr.trim().to_owned(),
        Err(e) => e.to_string(),
    };
    let error = format!("Git command failed: {error}");
    let lower = error.to_ascii_lowercase();
    let missing = ["couldn't find remote ref ", "could not find remote ref "]
        .into_iter()
        .find_map(|prefix| {
            lower.find(prefix).map(|i| {
                error[i + prefix.len()..]
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
            })
        });
    Some(if let Some(reference) = missing {
        json!({"error":error,"kind":"missing-remote-ref","message":format!("couldn't find remote ref {reference}")})
    } else {
        json!({"error":error,"kind":"generic","message":error})
    })
}
fn compare(
    path: &Path,
    mut value: Value,
    failure: Option<Value>,
    counts: Option<(u64, u64)>,
) -> Value {
    if let Some(failure) = failure {
        value["state"] = json!("unavailable");
        value["reason"] = json!("refresh-failed");
        value["message"] = failure["message"].clone();
        value["details"] = json!({"error":failure["error"],"kind":failure["kind"]});
        return value;
    }
    let result = counts.map(Ok).unwrap_or_else(|| {
        read_git(
            path,
            &[
                "rev-list",
                "--left-right",
                "--count",
                &format!("HEAD...{}", value["compareRef"].as_str().unwrap()),
            ],
        )
        .map(|s| {
            let mut counts = s.split_whitespace().map(|s| s.parse::<u64>().unwrap_or(0));
            (counts.next().unwrap_or(0), counts.next().unwrap_or(0))
        })
    });
    match result {
        Ok((ahead, behind)) => {
            value["state"] = json!("available");
            value["ahead"] = json!(ahead);
            value["behind"] = json!(behind);
        }
        Err(e) => {
            let message = format!("Git command failed: {e}");
            value["state"] = json!("unavailable");
            value["reason"] = json!("comparison-failed");
            value["message"] = json!(message);
            value["details"] = json!({"error":message});
        }
    }
    value
}
fn branch_comparison(
    path: &Path,
    branch: &str,
    remote: Option<String>,
    tracking: Option<&TrackingTarget>,
    failure: &Option<Value>,
    counts: (u64, u64),
) -> Value {
    let reference = remote
        .as_ref()
        .map(|r| format!("refs/remotes/{r}/{branch}"))
        .unwrap_or_else(|| format!("refs/heads/{branch}"));
    let value = json!({"branch":branch,"compareRef":reference,"remote":remote,"remoteRef":remote.as_ref().map(|r| format!("{r}/{branch}"))});
    if tracking.is_some_and(|t| t.upstream && t.reference() == reference) {
        return compare(path, value, failure.clone(), Some(counts));
    }
    let refresh_failure = remote.and_then(|remote| {
        refresh(
            path,
            &TrackingTarget {
                remote,
                branch: branch.into(),
                upstream: true,
            },
        )
    });
    compare(path, value, refresh_failure, None)
}
fn wildcard<'a>(pattern: &str, value: &'a str) -> Option<&'a str> {
    if let Some((prefix, suffix)) = pattern.split_once('*') {
        if suffix.contains('*') || value.len() < prefix.len() + suffix.len() {
            return None;
        }
        value.strip_prefix(prefix)?.strip_suffix(suffix)
    } else if pattern == value {
        Some("")
    } else {
        None
    }
}
fn namespaces_conflict(left: &str, right: &str) -> bool {
    left == right
        || left.starts_with(&format!("{right}/"))
        || right.starts_with(&format!("{left}/"))
}
fn destination_conflict(pattern: &str, destination: &str) -> bool {
    if let Some((prefix, suffix)) = pattern.split_once('*') {
        if suffix.contains('*') {
            return false;
        }
        if wildcard(pattern, destination).is_some()
            || prefix.starts_with(&format!("{destination}/"))
            || format!("{destination}/").starts_with(prefix)
        {
            return true;
        }
        let mut ancestor = destination;
        while let Some((p, _)) = ancestor.rsplit_once('/') {
            if wildcard(pattern, p).is_some() {
                return true;
            }
            ancestor = p;
        }
        false
    } else {
        namespaces_conflict(pattern, destination)
    }
}
fn destination_patterns_conflict(left: &str, right: &str) -> bool {
    match (left.split_once('*'), right.split_once('*')) {
        (None, None) => namespaces_conflict(left, right),
        (None, Some(_)) => destination_conflict(right, left),
        (Some(_), None) => destination_conflict(left, right),
        (Some((l, _)), Some((r, _))) => l.starts_with(r) || r.starts_with(l),
    }
}
fn refspec_parts(refspec: &str) -> Option<(&str, &str)> {
    let normalized = refspec.trim().strip_prefix('+').unwrap_or(refspec.trim());
    if normalized.starts_with('^') {
        None
    } else {
        normalized.split_once(':')
    }
}
fn refspec_covers(refspec: &str, source: &str, destination: &str) -> bool {
    let Some((s, d)) = refspec_parts(refspec) else {
        return false;
    };
    if !s.contains('*') || !d.contains('*') {
        return s == source && d == destination;
    }
    wildcard(s, source).is_some_and(|v| {
        !d.split_once('*').unwrap().1.contains('*') && d.replacen('*', v, 1) == destination
    })
}
fn manual_refspec(path: &Path, refspec: &str, merge: &str) -> bool {
    if refspec.trim() != refspec || refspec.is_empty() || refspec.starts_with('!') {
        return true;
    }
    let normalized = refspec.strip_prefix('+').unwrap_or(refspec);
    let valid = |s: &str| {
        read_git(
            path,
            &["check-ref-format", &s.replacen('*', "arashi-wildcard", 1)],
        )
        .is_ok()
    };
    if let Some(source) = normalized.strip_prefix('^') {
        return refspec.starts_with('+')
            || source.is_empty()
            || source.contains(':')
            || source.matches('*').count() > 1
            || !valid(source)
            || wildcard(source, merge).is_some();
    }
    let Some((source, destination)) = normalized.split_once(':') else {
        return normalized.contains('*')
            || !valid(normalized)
            || wildcard(normalized, merge).is_some();
    };
    if destination.is_empty() {
        return source.contains('*') || !valid(source) || wildcard(source, merge).is_some();
    }
    source.is_empty()
        || destination.contains(':')
        || source.matches('*').count() > 1
        || destination.matches('*').count() > 1
        || source.matches('*').count() != destination.matches('*').count()
        || !valid(source)
        || !valid(destination)
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn upstream_finding(name: &str, path: &Path) -> Option<Value> {
    let branch = optional(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    if optional(
        path,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .is_some()
    {
        return None;
    }
    let remote = optional(
        path,
        &["config", "--get", &format!("branch.{branch}.remote")],
    )
    .filter(|r| r != ".")?;
    let merges = read_git(
        path,
        &["config", "--get-all", &format!("branch.{branch}.merge")],
    )
    .unwrap_or_default();
    let merges: Vec<_> = merges.lines().collect();
    let merge = merges.first().copied().unwrap_or("");
    let scope = format!("repository:{name}");
    let p = quote(&path.to_string_lossy());
    if merges.len() > 1 && !merge.starts_with("refs/heads/") {
        return Some(finding(
            "repository",
            "REPOSITORY_UPSTREAM_TRACKING_UNAVAILABLE",
            "warning",
            &scope,
            format!(
                "Repository '{name}' branch '{branch}' has ambiguous multi-valued upstream merge configuration; review the configured merge refs manually."
            ),
            Some(
                json!({"branch":branch,"mergeRefs":merges,"path":path,"reason":"ambiguous-merge-configuration","remote":remote,"repository":name}),
            ),
            if cfg!(windows) {
                vec![]
            } else {
                vec![format!(
                    "git -C {p} config --get-all {}",
                    quote(&format!("branch.{branch}.merge"))
                )]
            },
        ));
    }
    let remote_branch = merge
        .strip_prefix("refs/heads/")
        .filter(|s| !s.is_empty())?;
    let expected = format!("refs/remotes/{remote}/{remote_branch}");
    read_git(path, &["show-ref", "--verify", &expected]).ok()?;
    let refspecs = read_git(
        path,
        &["config", "--get-all", &format!("remote.{remote}.fetch")],
    )
    .unwrap_or_default();
    let refspecs: Vec<_> = refspecs.lines().collect();
    let manual: Vec<_> = refspecs
        .iter()
        .map(|r| manual_refspec(path, r, merge))
        .collect();
    let pair_conflict: Vec<_> = refspecs
        .iter()
        .enumerate()
        .map(|(i, left)| {
            refspecs.iter().enumerate().any(|(j, right)| {
                i != j
                    && match (refspec_parts(left), refspec_parts(right)) {
                        (Some((_, l)), Some((_, r))) if !l.is_empty() && !r.is_empty() => {
                            destination_patterns_conflict(l, r)
                        }
                        _ => false,
                    }
            })
        })
        .collect();
    if !manual.iter().any(|m| *m)
        && !pair_conflict.iter().any(|m| *m)
        && refspecs.iter().any(|r| refspec_covers(r, merge, &expected))
    {
        return None;
    }
    let conflicts: Vec<_> = refspecs
        .iter()
        .enumerate()
        .filter(|(i, r)| {
            manual[*i]
                || pair_conflict[*i]
                || (!refspec_covers(r, merge, &expected)
                    && refspec_parts(r).is_some_and(|(s, d)| {
                        wildcard(s, merge).is_some() || destination_conflict(d, &expected)
                    }))
        })
        .map(|(_, r)| *r)
        .collect();
    let mut message = if conflicts.is_empty() {
        format!(
            "Repository '{name}' branch '{branch}' has upstream configuration, but Git cannot use {remote}/{remote_branch} because remote '{remote}' has no covering fetch mapping."
        )
    } else {
        format!(
            "Repository '{name}' branch '{branch}' has upstream configuration, but Git cannot use {remote}/{remote_branch} because remote '{remote}' has fetch mappings that conflict at the expected tracking namespace; review the conflicting fetch mappings manually."
        )
    };
    let key = quote(&format!("remote.{remote}.fetch"));
    let suggested = if cfg!(windows) {
        message.push_str(" Review the structured details and run equivalent Git commands in your active Windows shell; doctor does not emit shell-ambiguous copy-paste commands on Windows.");
        vec![]
    } else if !conflicts.is_empty() {
        vec![format!("git -C {p} config --get-all {key}")]
    } else {
        let mut commands = vec![
            format!(
                "git -C {p} config --add {key} {}",
                quote(&format!("+{merge}:{expected}"))
            ),
            format!("git -C {p} fetch -- {}", quote(&remote)),
        ];
        if merges.len() <= 1 {
            commands.push(format!(
                "git -C {p} branch {} -- {}",
                quote(&format!("--set-upstream-to={remote}/{remote_branch}")),
                quote(&branch)
            ));
        }
        commands
    };
    Some(finding(
        "repository",
        "REPOSITORY_UPSTREAM_TRACKING_UNAVAILABLE",
        "warning",
        &scope,
        message,
        Some(
            json!({"branch":branch,"conflictingFetchRefspecs":conflicts,"expectedRemoteTrackingRef":expected,"mergeRef":merge,"path":path,"reason":"missing-fetch-mapping","remote":remote,"repository":name}),
        ),
        suggested,
    ))
}
fn repository(name: &str, path: &Path, base: Option<(&str, &str)>, configured: bool) -> Vec<Value> {
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
    let tracking = tracking_target(path);
    let tracking_failure = tracking.as_ref().and_then(|t| refresh(path, t));
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
    let heading = output.lines().next().unwrap_or("");
    let remote_branch = heading
        .split_once("...")
        .map(|(_, r)| r.split(" [").next().unwrap_or(r).trim());
    let count = |key: &str| {
        heading
            .split_once(key)
            .and_then(|(_, s)| s.split(|c: char| !c.is_ascii_digit()).next())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0)
    };
    let (ahead, behind) = (count("ahead "), count("behind "));
    if let Some(branch) = branch.map(str::trim) {
        let inspection = if configured
            && tracking_failure
                .as_ref()
                .is_none_or(|f| f["kind"] != "missing-remote-ref")
            && (remote_branch.is_none() || tracking_failure.is_some())
        {
            upstream_finding(name, path)
        } else {
            None
        };
        if let Some(inspection) = inspection {
            f.push(inspection);
        } else if let Some(remote) = remote_branch {
            let (code, message, details, suggested) = if ahead > 0 && behind > 0 {
                (
                    "REPOSITORY_DIVERGED",
                    format!("Repository '{name}' has diverged from {remote}."),
                    json!({"ahead":ahead,"behind":behind,"remoteBranch":remote,"repository":name}),
                    vec![
                        "arashi status".into(),
                        format!("git -C {p} pull --rebase"),
                        format!("git -C {p} push"),
                    ],
                )
            } else if ahead > 0 {
                (
                    "REPOSITORY_AHEAD",
                    format!("Repository '{name}' is ahead of {remote} by {ahead} commit(s)."),
                    json!({"ahead":ahead,"remoteBranch":remote,"repository":name}),
                    vec!["arashi status".into(), format!("git -C {p} push")],
                )
            } else {
                (
                    "REPOSITORY_BEHIND",
                    format!("Repository '{name}' is behind {remote} by {behind} commit(s)."),
                    json!({"behind":behind,"remoteBranch":remote,"repository":name}),
                    vec!["arashi pull".into(), format!("git -C {p} pull --ff-only")],
                )
            };
            if ahead > 0 || behind > 0 {
                f.push(finding(
                    "repository",
                    code,
                    "warning",
                    &scope,
                    message,
                    Some(details),
                    suggested,
                ));
            }
        } else {
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
        }
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
    if let Some(failure) = &tracking_failure {
        let (code, message, detail, command) = if failure["kind"] == "missing-remote-ref" {
            let m = failure["message"].as_str().unwrap();
            (
                "REPOSITORY_MISSING_REMOTE_REF",
                format!("Repository '{name}' tracks a missing remote ref: {m}"),
                m.to_owned(),
                format!("git -C {p} branch -vv"),
            )
        } else {
            let m = format!(
                "Remote tracking may be stale: {}",
                failure["error"].as_str().unwrap()
            );
            (
                "REPOSITORY_REMOTE_REFRESH_FAILED",
                format!("Repository '{name}' remote tracking status may be stale: {m}"),
                m,
                format!("git -C {p} fetch"),
            )
        };
        f.push(finding(
            "repository",
            code,
            "warning",
            &scope,
            message,
            Some(json!({"message":detail,"repository":name})),
            vec!["arashi status".into(), command],
        ));
    }
    let base_comparison = base.map(|(base, _)| {
        let base = base.strip_prefix("origin/").unwrap_or(base);
        let base = base.strip_prefix("origin/").unwrap_or(base);
        let target = base.strip_prefix("origin/").unwrap_or(base);
        let remote = remote_for_branch(path, target).or_else(|| default_remote(path));
        if remote.is_none() {
            let message = format!("No remote is available for configured base branch '{target}'");
            json!({"branch":base,"compareRef":null,"remote":null,"remoteRef":null,"state":"unavailable","reason":"unresolved-target","message":message,"details":{"error":message}})
        } else if branch.is_none() { json!({"state":"skipped"}) }
        else {
            let mut comparison = branch_comparison(path, target, remote, tracking.as_ref(), &tracking_failure, (ahead, behind));
            // Source duplicate-target results retain the requested logical name,
            // while a separately refreshed comparison uses the resolved target.
            if tracking.as_ref().is_some_and(|t| t.upstream && comparison["compareRef"] == t.reference()) {
                comparison["branch"] = json!(base);
            }
            comparison
        }
    }).unwrap_or(Value::Null);
    let default_comparison = branch
        .and_then(|current| {
            let default = doctor_default_branch(path)?;
            let remote = remote_for_branch(path, &default);
            if remote.is_none()
                && (current == default
                    || optional(
                        path,
                        &["show-ref", "--verify", &format!("refs/heads/{default}")],
                    )
                    .is_none())
            {
                return None;
            }
            let reference = remote
                .as_ref()
                .map(|r| format!("refs/remotes/{r}/{default}"))
                .unwrap_or_else(|| format!("refs/heads/{default}"));
            Some(if base_comparison["compareRef"] == reference {
                base_comparison.clone()
            } else {
                branch_comparison(
                    path,
                    &default,
                    remote,
                    tracking.as_ref(),
                    &tracking_failure,
                    (ahead, behind),
                )
            })
        })
        .unwrap_or(Value::Null);
    let same = !base_comparison["compareRef"].is_null()
        && base_comparison["compareRef"] == default_comparison["compareRef"];
    if let Some((_, source)) = base {
        let b = &base_comparison;
        let base_ref = b["remoteRef"]
            .as_str()
            .or_else(|| b["branch"].as_str())
            .unwrap_or("");
        let mut details = json!({"alsoDefault":same,"baseBranch":b["branch"],"compareRef":b["compareRef"],"remote":b["remote"],"remoteRef":b["remoteRef"],"repository":name,"source":source});
        if b["state"] == "unavailable" {
            details["failure"] = b["details"].clone();
            details["message"] = b["message"].clone();
            details["reason"] = b["reason"].clone();
            f.push(finding(
                "repository",
                "REPOSITORY_CONFIGURED_BASE_UNAVAILABLE",
                "warning",
                &scope,
                format!(
                    "Could not compare '{name}' with configured base {base_ref}: {}",
                    b["message"].as_str().unwrap()
                ),
                Some(details),
                commands(&["arashi status --verbose", "arashi pull"]),
            ));
        } else if b["state"] == "available" && b["behind"].as_u64().unwrap_or(0) > 0 {
            details["ahead"] = b["ahead"].clone();
            details["behind"] = b["behind"].clone();
            details["currentBranch"] = json!(branch);
            f.push(finding(
                "repository",
                "REPOSITORY_CONFIGURED_BASE_BEHIND",
                "warning",
                &scope,
                format!(
                    "Repository '{name}' is behind configured base {base_ref} by {} commit(s).",
                    b["behind"]
                ),
                Some(details),
                commands(&["arashi status --verbose", "arashi pull"]),
            ));
        }
    }
    if !same {
        let d = &default_comparison;
        let default = d["branch"].as_str().unwrap_or("");
        if d["state"] == "unavailable" {
            f.push(finding(
                "repository",
                "REPOSITORY_DEFAULT_BRANCH_UNAVAILABLE",
                "info",
                &scope,
                format!("Could not compare '{name}' with its default branch."),
                Some(json!({"defaultBranch":default,"message":d["message"],"repository":name})),
                vec!["arashi status".into(), format!("git -C {p} fetch")],
            ));
        } else if d["state"] == "available" && d["behind"].as_u64().unwrap_or(0) > 0 {
            f.push(finding(
                "repository",
                "REPOSITORY_DEFAULT_BRANCH_BEHIND",
                "warning",
                &scope,
                format!(
                    "Repository '{name}' is behind default branch {default} by {} commit(s).",
                    d["behind"]
                ),
                Some(json!({"behind":d["behind"],"defaultBranch":default,"repository":name})),
                vec![
                    "arashi status".into(),
                    format!("git -C {p} merge {default}"),
                ],
            ));
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
            !standalone,
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
