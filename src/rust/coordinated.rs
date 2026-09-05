//! Primary non-bare coordinated worktrees. Plans retain Git identities and rollback ownership.
use crate::{
    Error, Result,
    cli::Args,
    config::{RepoConfig, Workspace},
    git,
    managed::{IgnorePlan, Transaction, relative, safe, unsupported},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};
#[derive(Clone, Debug, PartialEq)]
struct Item {
    name: String,
    root: PathBuf,
    target: PathBuf,
    oid: String,
    source: String,
    existing: bool,
    base: Value,
}
fn primary(root: &Path) -> Result<()> {
    safe(root)?;
    let records = git::worktrees(root)?;
    if !records.first().is_some_and(|w| !w.bare && w.path == root) {
        return Err(unsupported(
            "Configured mutations currently require primary non-bare repositories",
        ));
    }
    Ok(())
}
fn policy(w: &Workspace, args: &Args) -> Result<()> {
    primary(&w.root)?;
    let c = w.config.as_ref().unwrap();
    if args
        .value("conflict")
        .is_some_and(|v| v != "REUSE_EXISTING")
    {
        return Err(unsupported(
            "Only explicit REUSE_EXISTING conflict policy is currently ported",
        ));
    }
    if c.repos.values().any(|r| {
        ["copy", "symlink"].iter().any(|k| {
            r.raw
                .get(k)
                .is_some_and(|v| v.as_array().is_some_and(|v| !v.is_empty()))
        })
    }) {
        return Err(unsupported(
            "Materialization policies are not yet ported; no changes made",
        ));
    }
    if c.raw["worktreeNaming"].get("maxPathLength").is_some() {
        return Err(unsupported(
            "Configured path length fitting is not yet ported",
        ));
    }
    if args.command == "create"
        && (!args.has("no-hooks") || !args.has("no-launch") || !args.has("no-switch"))
    {
        return Err(unsupported(
            "Configured create currently requires explicit --no-hooks --no-launch --no-switch",
        ));
    }
    relative(&c.repos_dir)?;
    relative(&c.worktrees_dir)?;
    Ok(())
}
fn target(w: &Workspace, branch: &str) -> Result<PathBuf> {
    let c = w.config.as_ref().unwrap();
    git::run(&w.root, &["check-ref-format", "--branch", branch])?;
    if branch.starts_with('-') || branch.contains('@') {
        return Err(unsupported("Unsafe branch shorthand"));
    }
    let component = if c.raw["worktreeNaming"]["branchSlashes"] == "flatten" {
        branch.replace('/', "-")
    } else {
        branch.to_owned()
    };
    let name = if c.raw["worktreeNaming"]["style"] == "repo-branch" {
        format!(
            "{}-{component}",
            w.root.file_name().unwrap().to_string_lossy()
        )
    } else {
        component
    };
    let path = w
        .root
        .join(relative(&c.worktrees_dir)?)
        .join(relative(&name)?);
    safe(&path)?;
    Ok(path)
}
fn repositories(w: &Workspace) -> Result<Vec<(String, PathBuf, PathBuf)>> {
    let c = w.config.as_ref().unwrap();
    let base = w.root.join(relative(&c.repos_dir)?);
    let mut found = vec![];
    fn walk(p: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
        if !p.exists() {
            return Ok(());
        }
        safe(p)?;
        let mut entries = fs::read_dir(p)?.collect::<std::result::Result<Vec<_>, _>>()?;
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            if e.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if e.file_type()?.is_symlink() {
                return Err(unsupported("Symlinked child discovery is unsupported"));
            }
            if !e.file_type()?.is_dir() {
                continue;
            }
            if e.path().join(".git").exists() {
                out.push(e.path());
            } else {
                walk(&e.path(), out)?;
            }
        }
        Ok(())
    }
    walk(&base, &mut found)?;
    let mut rows = vec![(
        w.root.file_name().unwrap().to_string_lossy().into_owned(),
        w.root.clone(),
        PathBuf::new(),
    )];
    for root in found {
        primary(&root)?;
        let mut name = root.file_name().unwrap().to_string_lossy().into_owned();
        let mut child_path = root
            .strip_prefix(&w.root)
            .map_err(|_| unsupported("External children unsupported"))?
            .to_owned();
        for (id, r) in &c.repos {
            let configured = w.root.join(&r.path);
            if configured.canonicalize().ok() == Some(root.clone()) {
                name = id.clone();
                child_path = configured
                    .strip_prefix(&w.root)
                    .map_err(|_| unsupported("External children unsupported"))?
                    .to_owned();
                break;
            }
        }
        if rows.iter().any(|(n, _, _)| *n == name) {
            return Err(unsupported("Duplicate discovered repository identities"));
        }
        rows.push((name, root, child_path));
    }
    Ok(rows)
}
fn plan(w: &Workspace, args: &Args) -> Result<Vec<Item>> {
    policy(w, args)?;
    let branch = &args.positional[0];
    let target = target(w, branch)?;
    let rows = repositories(w)?;
    let mut filter_config = w.config.as_ref().unwrap().clone();
    filter_config.repo_order = rows.iter().map(|(n, _, _)| n.clone()).collect();
    for (name, root, _) in &rows {
        filter_config
            .repos
            .entry(name.clone())
            .or_insert(RepoConfig {
                path: root.to_string_lossy().into_owned(),
                raw: json!({}),
            });
    }
    let (selected, _) = crate::selection::select(&filter_config, args).map_err(|e| {
        if e.code == "EMPTY_REPOSITORY_FILTERS" {
            e
        } else {
            Error::new("REPOSITORY_VALIDATION_ERROR", e.message)
        }
    })?;
    let mut items = vec![];
    for name in selected {
        let (_, root, child) = rows
            .iter()
            .find(|(n, _, _)| *n == name)
            .ok_or_else(|| unsupported("Selected repository is not discovered"))?;
        let destination = if child.as_os_str().is_empty() {
            target.clone()
        } else {
            target.join(child)
        };
        safe(&destination)?;
        if destination.exists() {
            return Err(unsupported(
                "Existing destination conflicts are not yet ported; no changes made",
            ));
        }
        let records = git::worktrees(root)?;
        if records.iter().any(|record| record.path == destination) {
            return Err(unsupported(
                "Worktree destination is already registered, including stale metadata; no changes made",
            ));
        }
        if records.iter().any(|w| w.branch.as_deref() == Some(branch)) {
            return Err(unsupported(
                "Branch already checked out; conflict resolution is not yet ported",
            ));
        }
        let existing = git::run(
            root,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )
        .is_ok();
        if existing && (args.value("conflict") != Some("REUSE_EXISTING") || args.has("dry-run")) {
            return Err(unsupported(
                "Existing configured branches require --conflict REUSE_EXISTING; conflict dry-run is not yet ported",
            ));
        }
        let source = if existing {
            format!("refs/heads/{branch}")
        } else if git::run(
            root,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/remotes/origin/{branch}"),
            ],
        )
        .is_ok()
        {
            return Err(unsupported(
                "Configured remote-only target conflicts are not yet ported",
            ));
        } else {
            let default = if *root == w.root {
                git::run(root, &["symbolic-ref", "--short", "HEAD"])?
                    .trim()
                    .to_owned()
            } else {
                git::default_branch(root)?
            };
            [
                format!("refs/heads/{default}"),
                format!("refs/remotes/origin/{default}"),
            ]
            .into_iter()
            .find(|r| git::run(root, &["show-ref", "--verify", "--quiet", r]).is_ok())
            .ok_or_else(|| unsupported("Unresolved default start point"))?
        };
        let oid = git::run(root, &["rev-parse", &source])?.trim().into();
        items.push(Item {
            name,
            root: root.clone(),
            target: destination,
            oid,
            source,
            existing,
            base: Value::Null,
        });
    }
    resolve_bases(w, args, &mut items)?;
    // The parent must precede its children even when explicitly selected last.
    items.sort_by_key(|i| usize::from(i.root != w.root));
    Ok(items)
}
pub fn create(w: &Workspace, args: &Args) -> Result<Value> {
    let items = plan(w, args)?;
    let branch = &args.positional[0];
    let dry = args.has("dry-run");
    let c = w.config.as_ref().unwrap();
    let ignore = IgnorePlan::build(&w.root, &c.repos_dir, &c.worktrees_dir, dry)?;
    let mut rows = vec![];
    if !dry {
        let current = Workspace::discover(&w.root)?;
        if current.config.as_ref().unwrap().raw != c.raw || plan(&current, args)? != items {
            return Err(Error::new(
                "PLAN_CHANGED",
                "Create preconditions changed; no changes made",
            ));
        }
        let mut tx = Transaction::default();
        let mut owned: Vec<&Item> = vec![];
        let operation = (|| -> Result<()> {
            ignore.apply(&mut tx)?;
            for item in &items {
                // Recheck each repository immediately before creating its branch/worktree.
                if item.target.exists()
                    || git::run(&item.root, &["rev-parse", &item.source])?.trim() != item.oid
                {
                    return Err(Error::new(
                        "PLAN_CHANGED",
                        "Repository changed during coordinated create",
                    ));
                }
                tx.mkdir(item.target.parent().unwrap())?;
                if !item.existing {
                    let source = if item.base["source"] != "legacy-omitted" {
                        &item.oid
                    } else {
                        &item.source
                    };
                    git::run(&item.root, &["branch", branch, source])?;
                }
                // Branch creation succeeded (or the branch predates this operation).
                // Record ownership before worktree add so partial Git failures can be cleaned up.
                owned.push(item);
                git::run(
                    &item.root,
                    &["worktree", "add", item.target.to_str().unwrap(), branch],
                )?;
                rows.push(json!({"branchName":branch,"duration":0,"error":null,"hookOutcomes":[],"materializationOutcomes":[],"repositoryName":item.name,"repositoryPath":item.root,"status":"success","warnings":if item.existing {vec![format!("Reused existing branch '{branch}'")]}else{vec![]},"worktreePath":item.target}));
            }
            Ok(())
        })();
        if let Err(e) = operation {
            let mut rollback_errors = vec![];
            for item in owned.into_iter().rev() {
                let records = match git::worktrees(&item.root) {
                    Ok(records) => records,
                    Err(e) => {
                        rollback_errors.push(e.message);
                        continue;
                    }
                };
                if let Some(record) = records.iter().find(|r| r.path == item.target) {
                    if record.head != item.oid
                        || record.branch.as_deref() != Some(branch)
                        || record.locked
                    {
                        rollback_errors.push(format!(
                            "Worktree ownership changed: {}",
                            item.target.display()
                        ));
                        continue;
                    }
                    if let Err(e) = git::run(
                        &item.root,
                        &["worktree", "remove", item.target.to_str().unwrap()],
                    ) {
                        rollback_errors.push(e.message);
                        continue;
                    }
                }
                if !item.existing {
                    if git::run(&item.root, &["rev-parse", &format!("refs/heads/{branch}")])
                        .is_ok_and(|oid| oid.trim() == item.oid)
                    {
                        if let Err(e) = git::run(&item.root, &["branch", "-D", branch]) {
                            rollback_errors.push(e.message);
                        }
                    } else {
                        rollback_errors.push(format!("Branch ownership changed: {}", item.name));
                    }
                }
            }
            rollback_errors.extend(tx.rollback());
            return Err(Error::new("COORDINATED_CREATE_FAILED", e.message)
                .with_details(json!({"completed":rows,"rollbackErrors":rollback_errors})));
        }
    }
    let mut data = w.metadata();
    let count = items.len();
    data.as_object_mut().unwrap().extend(json!({"branchName":branch,"dirtyWorkspaceGuidance":null,"dryRun":dry,"errorSummary":null,"failureCount":0,"hookOutcomes":[],"managedIgnore":ignore.data,"moveSummary":null,"nextSteps":[],"repositories":rows,"rolledBack":false,"skippedCount":if dry {count}else{0},"successCount":if dry {0}else{count},"totalDuration":0,"totalRepositories":count}).as_object().unwrap().clone());
    if dry {
        data["dryRunOutcome"] = json!({"conflicts":[],"plannedWorktrees":items.iter().map(|i|json!({"branchName":branch,"planStatus":"actionable","repositoryName":i.name,"worktreePath":i.target})).collect::<Vec<_>>(),"summaryCounts":{"blockingTotal":0,"conflictTotal":0,"plannedTotal":count}});
    }
    if let Some(first) = items
        .iter()
        .find(|i| !i.base.is_null() && i.base["source"] != "legacy-omitted")
    {
        data["base"] = json!({"requestedBranch":first.base["requestedBranch"],"source":first.base["source"],"repositories":items.iter().map(|i| i.base.clone()).collect::<Vec<_>>()});
    }
    if !dry {
        data["dirtyWorkspaceGuidance"] = dirty_guidance(w, branch, &items)?;
    }
    Ok(data)
}

fn no_remove_hooks(w: &Workspace, roots: &[(String, PathBuf, PathBuf)]) -> Result<()> {
    let c = w.config.as_ref().unwrap();
    if c.raw["hooks"].get("scripts").is_some()
        || c.repos.values().any(|r| r.raw.get("hooks").is_some())
    {
        return Err(unsupported(
            "Configured remove hook policies are not yet ported",
        ));
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| unsupported("Cannot resolve global hook directory"))?;
    let mut dirs = vec![PathBuf::from(home).join(".arashi/hooks")];
    dirs.extend(roots.iter().map(|(_, p, _)| p.join(".arashi/hooks")));
    fn inspect(path: &Path) -> Result<()> {
        safe(path)?;
        if !path.exists() {
            return Ok(());
        }
        for e in fs::read_dir(path)? {
            let e = e?;
            if e.file_type()?.is_dir() {
                inspect(&e.path())?;
            } else if !e.file_name().to_string_lossy().ends_with(".example") {
                return Err(unsupported(
                    "Remove hook files are not yet ported; no changes made",
                ));
            }
        }
        Ok(())
    }
    for dir in dirs {
        inspect(&dir)?;
    }
    Ok(())
}
fn nested_safety(path: &Path, targets: &[Item]) -> Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_name() == ".git" {
            continue;
        }
        if entry.file_type()?.is_dir() {
            let p = entry.path();
            let bare = p.join("HEAD").is_file() && p.join("objects").is_dir();
            if (bare || p.join(".git").exists()) && !targets.iter().any(|i| i.target == p) {
                return Err(unsupported(
                    "Unmanaged nested Git repository in removal target; no changes made",
                ));
            }
            nested_safety(&p, targets)?;
        }
    }
    Ok(())
}
fn remove_plan(w: &Workspace, args: &Args) -> Result<Vec<Item>> {
    policy(w, args)?;
    let mut rows = repositories(w)?;
    let config = w.config.as_ref().unwrap();
    rows.sort_by_key(|(n, p, _)| {
        if *p == w.root {
            0
        } else {
            config
                .repo_order
                .iter()
                .position(|id| id == n)
                .map_or(usize::MAX, |i| i + 1)
        }
    });
    no_remove_hooks(w, &rows)?;
    let branch = &args.positional[0];
    let caller = std::env::current_dir()?.canonicalize()?;
    let mut items = vec![];
    for (name, root, _) in rows {
        let records = git::worktrees(&root)?;
        if let Some(t) = records.iter().find(|t| t.branch.as_deref() == Some(branch)) {
            if t.path == root
                || t.locked
                || t.prune_reason.is_some()
                || caller.starts_with(&t.path)
                || !t.path.is_dir()
            {
                return Err(unsupported(
                    "Primary, locked, stale, or caller-containing worktree cannot be removed",
                ));
            }
            if !t.path.starts_with(
                w.root
                    .join(relative(&w.config.as_ref().unwrap().worktrees_dir)?),
            ) {
                return Err(unsupported(
                    "Removal of worktrees outside the configured base is not yet ported",
                ));
            }
            safe(&t.path)?;
            if !args.has("force")
                && !git::run(&t.path, &["status", "--porcelain", "--untracked-files=all"])?
                    .is_empty()
            {
                return Err(Error::new(
                    "DIRTY_WORKTREE",
                    "Uncommitted changes; explicit --force required",
                ));
            }
            items.push(Item {
                name,
                root,
                target: t.path.clone(),
                oid: t.head.clone(),
                source: branch.clone(),
                existing: true,
                base: Value::Null,
            });
        } else if git::run(
            &root,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )
        .is_ok()
        {
            return Err(unsupported(
                "Configured branch-only removal is not yet ported; no changes made",
            ));
        }
    }
    if items.is_empty() {
        return Err(unsupported("No matching configured worktrees"));
    }
    for i in &items {
        nested_safety(&i.target, &items)?;
    }
    Ok(items)
}
pub fn remove(w: &Workspace, args: &Args) -> Result<Value> {
    args.only(&["force", "keep-branches", "dry-run"])?;
    let dry = args.has("dry-run");
    let items = remove_plan(w, args)?;
    if !dry && !args.has("force") {
        return Err(unsupported(
            "Interactive configured removal requires --force in this port",
        ));
    }
    let current = Workspace::discover(&w.root)?;
    if current.config.as_ref().unwrap().raw != w.config.as_ref().unwrap().raw
        || remove_plan(&current, args)? != items
    {
        return Err(Error::new(
            "PLAN_CHANGED",
            "Removal preconditions changed; no changes made",
        ));
    }
    let mut ordered = items.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|i| std::cmp::Reverse(i.target.components().count()));
    let branch = &args.positional[0];
    let keep = args.has("keep-branches");
    let mut missing = vec![];
    let mut names = vec![w.root.file_name().unwrap().to_string_lossy().into_owned()];
    names.extend(w.config.as_ref().unwrap().repo_order.clone());
    for name in names {
        if !items.iter().any(|i| i.name == name) {
            missing.push(name);
        }
    }

    let mut hooks = vec![];
    let mut operations = vec![];
    if dry {
        for i in &ordered {
            operations.push(json!({"branchName":branch,"repository":i.name,"status":"pending","type":"worktree_remove","worktreePath":i.target}));
        }
        if !keep {
            for i in &items {
                operations.push(json!({"branchName":branch,"repository":i.name,"status":"pending","type":"branch_delete"}));
            }
        }
        let mut data = w.metadata();
        let branches = if keep { 0 } else { items.len() };
        data.as_object_mut().unwrap().extend(json!({"dryRun":true,"errors":[],"hookOutcomes":[],"operations":operations,"success":true,"summary":{"duration":0,"successfulBranches":0,"successfulWorktrees":0,"totalBranches":branches,"totalWorktrees":items.len()},"effectiveOptions":{"checkDirty":true,"force":args.has("force"),"keepBranches":keep,"keepWorktrees":false},"hooks":[],"missingBranches":{branch:missing}}).as_object().unwrap().clone());
        return Ok(data);
    }
    for lifecycle in ["pre-remove", "post-remove"] {
        for i in &ordered {
            for scope in [
                "repository",
                "workspace",
                "global-repository",
                "global-shared",
            ] {
                hooks.push(json!({"executionPath":if scope=="workspace"{&w.root}else{&i.root},"hookName":lifecycle,"hookStatus":"skipped","message":"Hook script not found","reasonCode":"not_found","repositoryId":i.name,"scope":scope,"sourceKind":"file","sourceOwnerKind":if scope=="repository"{"repository"}else if scope=="workspace"{"workspace"}else{"user-global"},"sourceOwnerName":if scope=="repository"{json!(i.name)}else{Value::Null},"sourceScriptPath":null,"targetRepositoryName":i.name,"targetRepositoryPath":i.root,"targetWorktreePath":i.target,"workspaceMode":"configured"}));
            }
        }
    }
    for item in &ordered {
        // Recheck nested ownership after prior child removals before invoking Git.
        nested_safety(&item.target, &[])?;
        let records = git::worktrees(&item.root)?;
        if !records.iter().any(|r| {
            r.path == item.target
                && r.head == item.oid
                && r.branch.as_deref() == Some(branch)
                && !r.locked
        }) {
            return Err(Error::new(
                "COORDINATED_REMOVE_PARTIAL_FAILURE",
                "Target changed during removal",
            )
            .with_details(json!({"operations":operations})));
        }
        if let Err(e) = git::run(
            &item.root,
            &[
                "worktree",
                "remove",
                "--force",
                item.target.to_str().unwrap(),
            ],
        ) {
            return Err(Error::new("COORDINATED_REMOVE_PARTIAL_FAILURE", e.message)
                .with_details(json!({"operations":operations})));
        }
        operations.push(json!({"branchName":branch,"repository":item.name,"status":"success","type":"worktree_remove","worktreePath":item.target}));
    }
    if !keep {
        for item in &items {
            if let Err(e) = git::run(&item.root, &["branch", "-D", branch]) {
                return Err(Error::new("COORDINATED_REMOVE_PARTIAL_FAILURE", e.message)
                    .with_details(json!({"operations":operations})));
            }
            operations.push(json!({"branchName":branch,"repository":item.name,"status":"success","type":"branch_delete"}));
        }
    }
    let mut data = w.metadata();
    let branches = if keep { 0 } else { items.len() };
    data.as_object_mut().unwrap().extend(json!({"dryRun":false,"errors":[],"hookOutcomes":hooks,"operations":operations,"success":true,"summary":{"duration":0,"successfulBranches":branches,"successfulWorktrees":items.len(),"totalBranches":branches,"totalWorktrees":items.len()},"missingBranches":{branch:missing}}).as_object().unwrap().clone());
    Ok(data)
}
fn resolve_bases(w: &Workspace, args: &Args, items: &mut [Item]) -> Result<()> {
    let c = w.config.as_ref().unwrap();
    let mut overrides = std::collections::BTreeMap::new();
    let mut issues = vec![];
    for value in args.options.get("repo-base").into_iter().flatten() {
        let Some((name, branch)) = value
            .split_once('=')
            .filter(|(n, b)| !n.is_empty() && !b.is_empty())
        else {
            issues.push(json!({"code":"MALFORMED_OVERRIDE","value":value,"message":format!("'{value}' must use non-empty <repository=branch> syntax")}));
            continue;
        };
        let branch = branch.strip_prefix("origin/").unwrap_or(branch);
        if branch.starts_with('-')
            || branch.contains('@')
            || git::run(&w.root, &["check-ref-format", "--branch", branch]).is_err()
        {
            issues.push(json!({"code":"INVALID_BRANCH","value":value,"message":format!("'{value}' contains an invalid Git branch name")}));
            continue;
        }
        if overrides.contains_key(name) {
            issues.push(json!({"code":"DUPLICATE_SELECTOR","value":value,"message":format!("Repository selector '{name}' is repeated")}));
            continue;
        }
        overrides.insert(name, branch);
    }
    for (name, branch) in &overrides {
        let selected = items.iter().any(|i| {
            if i.root == w.root {
                *name == "@meta"
            } else {
                i.name == *name
            }
        });
        let issue = if *name == "@meta" && !selected {
            Some((
                "UNSELECTED_REPOSITORY",
                "@meta does not identify a selected repository".to_owned(),
            ))
        } else if *name != "@meta" && !c.repos.contains_key(*name) {
            Some((
                "UNKNOWN_REPOSITORY",
                format!("Unknown configured repository selector '{name}'"),
            ))
        } else if !selected {
            Some((
                "UNSELECTED_REPOSITORY",
                format!("Repository selector '{name}' is not selected"),
            ))
        } else {
            None
        };
        if let Some((code, message)) = issue {
            issues.push(json!({"code":code,"value":format!("{name}={branch}"),"message":message}));
        }
    }
    if !issues.is_empty() {
        return Err(Error::new(
            "BASE_BRANCH_POLICY_INVALID",
            format!(
                "Invalid base branch policy:\n{}",
                issues
                    .iter()
                    .map(|i| format!("  - {}", i["message"].as_str().unwrap()))
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
        )
        .with_details(json!({"issues":issues})));
    }
    let mut failures = vec![];
    for i in items.iter_mut() {
        let identity = if i.root == w.root { "@meta" } else { &i.name };
        let repository = if i.root == w.root {
            &c.raw["meta"]
        } else {
            &c.raw["repos"][&i.name]
        };
        let requested = overrides
            .get(identity)
            .map(|b| (*b, "repository-cli"))
            .or_else(|| args.value("base").map(|b| (b, "cli")))
            .or_else(|| {
                repository["baseBranch"]
                    .as_str()
                    .map(|b| (b, "repository-config"))
            })
            .or_else(|| {
                c.raw["baseBranch"]
                    .as_str()
                    .map(|b| (b, "workspace-config"))
            });
        let mut value = json!({"repositoryName":i.name,"repositoryIdentity":identity,"repositoryPath":i.root,"targetAction":if i.existing{"reused"}else{"created"}});
        if let Some((branch, source)) = requested {
            let branch = branch.strip_prefix("origin/").unwrap_or(branch);
            git::run(&i.root, &["check-ref-format", "--branch", branch])?;
            if branch.starts_with('-') || branch.contains('@') {
                return Err(unsupported("Unsafe base shorthand"));
            }
            value["requestedBranch"] = json!(branch);
            value["source"] = json!(source);
            let refs = [
                format!("refs/heads/{branch}"),
                format!("refs/remotes/origin/{branch}"),
            ];
            if let Some((reference, oid)) = refs.iter().find_map(|r| {
                git::run(
                    &i.root,
                    &["rev-parse", "--verify", &format!("{r}^{{commit}}")],
                )
                .ok()
                .map(|oid| (r, oid.trim().to_owned()))
            }) {
                value["resolvedRef"] = json!(reference);
                value["resolvedOid"] = json!(oid);
                if !i.existing {
                    i.source = reference.clone();
                    i.oid = oid;
                }
            } else {
                let mut failure = value.clone();
                failure.as_object_mut().unwrap().remove("targetAction");
                failure["attemptedRefs"] = json!(refs);
                failures.push(failure);
            }
        } else {
            value["requestedBranch"] = json!(if i.root == w.root {
                git::run(&i.root, &["symbolic-ref", "--short", "HEAD"])?
                    .trim()
                    .to_owned()
            } else {
                git::default_branch(&i.root)?
            });
            value["source"] = json!("legacy-omitted");
        }
        i.base = value;
    }
    if let Some(first) = failures.first() {
        return Err(Error::new("CREATE_BASE_RESOLUTION_FAILED",format!("Base branch resolution failed in: {}",failures.iter().map(|f|format!("{} ({})",f["repositoryName"].as_str().unwrap(),f["requestedBranch"].as_str().unwrap())).collect::<Vec<_>>().join(", "))).with_details(json!({"requestedBranch":first["requestedBranch"],"source":first["source"],"repositories":failures})));
    }
    Ok(())
}
fn dirty_guidance(w: &Workspace, branch: &str, items: &[Item]) -> Result<Value> {
    let mut changes = vec![];
    let c = w.config.as_ref().unwrap();
    let mut ordered = items.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|i| {
        if i.root == w.root {
            0
        } else {
            c.repo_order
                .iter()
                .position(|n| *n == i.name)
                .map_or(usize::MAX, |p| p + 1)
        }
    });
    for i in ordered {
        let raw = git::run(&i.root, &["status", "--porcelain=v1", "-uall"])?;
        let (mut staged, mut modified, mut deleted, mut untracked) = (0, 0, 0, 0);
        for line in raw.lines().filter(|l| l.len() >= 2) {
            let b = line.as_bytes();
            if line.starts_with("??") {
                untracked += 1;
                continue;
            }
            if b[0] != b' ' && b[0] != b'?' {
                staged += 1;
            }
            if b[0] == b'D' || b[1] == b'D' {
                deleted += 1;
            }
            if b[1] != b' ' || (b[0] != b' ' && b[0] != b'D') {
                modified += 1;
            }
        }
        let summary = [
            (staged, "staged"),
            (modified, "modified"),
            (deleted, "deleted"),
            (untracked, "untracked"),
        ]
        .into_iter()
        .filter(|(n, _)| *n > 0)
        .map(|(n, s)| format!("{n} {s}"))
        .collect::<Vec<_>>()
        .join(", ");
        if !summary.is_empty() {
            changes.push(json!({"path":i.root,"repositoryName":i.name,"summary":summary}));
        }
    }
    Ok(if changes.is_empty() {
        Value::Null
    } else {
        json!({"changedRepositories":changes,"command":format!("arashi move --to {branch}"),"target":branch})
    })
}
