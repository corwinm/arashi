//! Primary non-bare coordinated worktrees. Plans retain Git identities and rollback ownership.
use crate::{
    Error, Result,
    cli::Args,
    config::{RepoConfig, Workspace},
    git,
    managed::{IgnorePlan, Transaction, relative, safe, unsupported},
};
#[path = "create_remote.rs"]
mod create_remote;
#[path = "reuse.rs"]
mod reuse;
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
    reuse: Option<reuse::Identity>,
    remote: Option<create_remote::Identity>,
    base: Value,
    requested_base: Option<(String, String)>,
}
fn primary(root: &Path) -> Result<()> {
    safe(root)?;
    let records = git::worktrees(root)?;
    if !records
        .first()
        .is_some_and(|w| !w.bare && crate::paths::same_existing(&w.path, root).unwrap_or(false))
    {
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
        .is_some_and(|v| v != "REUSE_EXISTING" && v != "ABORT")
    {
        return Err(unsupported(
            "Only explicit REUSE_EXISTING conflict policy is currently ported",
        ));
    }
    if args.command != "create"
        && c.repos.values().any(|r| {
            ["copy", "symlink"].iter().any(|k| {
                r.raw
                    .get(k)
                    .is_some_and(|v| v.as_array().is_some_and(|v| !v.is_empty()))
            })
        })
    {
        return Err(unsupported(
            "Materialization policies are not yet ported; no changes made",
        ));
    }
    if c.raw["worktreeNaming"].get("maxPathLength").is_some() {
        return Err(unsupported(
            "Configured path length fitting is not yet ported",
        ));
    }
    if args.command == "create" && (!args.has("no-launch") || !args.has("no-switch")) {
        return Err(unsupported(
            "Configured create currently requires explicit --no-launch --no-switch",
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
            if crate::paths::same_existing(&configured, &root).unwrap_or(false) {
                name = id.clone();
                child_path = configured
                    .strip_prefix(&w.root)
                    .map_err(|_| unsupported("External children unsupported"))?
                    .to_owned();
                break;
            }
        }
        // A configured alias may resolve to this clone while its raw ../ path
        // would project the destination outside the requested workspace.
        child_path = relative(
            child_path
                .to_str()
                .ok_or_else(|| unsupported("Non-UTF-8 child paths are unsupported"))?,
        )?;
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
    // Discover conflict evidence for the entire selection without resolving any
    // object. A later sibling may have lazy-fetch configuration even when the
    // first repository's remote conflict is otherwise supported.
    let selected_roots = selected
        .iter()
        .map(|name| {
            rows.iter()
                .find(|(n, _, _)| n == name)
                .map(|(_, root, _)| root)
                .ok_or_else(|| unsupported("Selected repository is not discovered"))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut remote_scope = false;
    for root in &selected_roots {
        remote_scope |= create_remote::has_target_conflict(root, branch)?;
    }
    if remote_scope {
        if !args.has("json")
            || !args.has("no-hooks")
            || !matches!(args.value("conflict"), Some("ABORT" | "REUSE_EXISTING"))
        {
            return Err(unsupported(
                "Remote create requires JSON and explicit conflict/no-hooks",
            ));
        }
        for root in &selected_roots {
            create_remote::preflight(root)?;
        }
    }
    let mut items = vec![];
    for name in selected {
        let (_, root, child) = rows
            .iter()
            .find(|(n, _, _)| *n == name)
            .ok_or_else(|| unsupported("Selected repository is not discovered"))?;
        if remote_scope {
            create_remote::preflight(root)?;
        }
        let destination = if child.as_os_str().is_empty() {
            target.clone()
        } else {
            target.join(child)
        };
        safe(&destination)?;
        let records = git::worktrees(root)?;
        let registration = records.iter().find(|r| r.path == destination);
        let reusable = destination.try_exists()?
            && registration
                .is_some_and(|r| r.branch.as_deref() == Some(branch) && r.prune_reason.is_none());
        if (destination.try_exists()? || registration.is_some()) && !reusable {
            return Err(Error::new(
                "WORKTREE_DESTINATION_COLLISION",
                format!(
                    "Worktree path already exists: {} ({name})",
                    destination.display()
                ),
            )
            .with_details(json!({"conflict":{"repositoryName":name,"worktreePath":destination}})));
        }
        if records
            .iter()
            .any(|r| r.branch.as_deref() == Some(branch) && r.path != destination)
        {
            return Err(unsupported(
                "Branch already checked out elsewhere; conflict resolution is not yet ported",
            ));
        }
        let reuse = if reusable {
            if records
                .iter()
                .filter(|r| r.path == destination || r.branch.as_deref() == Some(branch))
                .count()
                != 1
            {
                return Err(unsupported(
                    "Ambiguous existing worktree registrations are not supported; no changes made",
                ));
            }
            if args.value("conflict") != Some("REUSE_EXISTING") || !args.has("no-hooks") {
                return Err(unsupported(
                    "Existing destination reuse requires explicit --conflict REUSE_EXISTING --no-hooks",
                ));
            }
            if registration.is_some_and(|r| r.locked || r.bare) || destination == *root {
                return Err(unsupported(
                    "Protected existing destination reuse is not yet ported; no changes made",
                ));
            }
            Some(reuse::inspect(root, &destination, branch)?)
        } else {
            None
        };
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
        let remote = if create_remote::has_target_conflict(root, branch)? {
            if !remote_scope {
                return Err(Error::new(
                    "PLAN_CHANGED",
                    "Remote conflict appeared during planning",
                ));
            }
            create_remote::inspect(root, branch)?
        } else {
            None
        };
        if remote.is_some() && existing {
            return Err(unsupported(
                "Remote create with an existing local target is not yet supported",
            ));
        }
        let source = if existing {
            format!("refs/heads/{branch}")
        } else if remote.is_none()
            && git::run(
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
        let oid = if remote_scope {
            create_remote::local_source(root, &source)?
        } else {
            git::run(root, &["rev-parse", &source])?.trim().into()
        };
        items.push(Item {
            name,
            root: root.clone(),
            target: destination,
            oid,
            source,
            existing,
            reuse,
            remote,
            base: Value::Null,
            requested_base: None,
        });
    }
    if items.iter().any(|i| i.reuse.is_some()) {
        // Existing-worktree materialization has a distinct preservation/rollback
        // contract. Do not let a mixed plan enter the new-worktree-only ledger.
        if items.iter().any(|i| {
            w.config
                .as_ref()
                .unwrap()
                .repos
                .get(&i.name)
                .is_some_and(|r| {
                    ["copy", "symlink"].iter().any(|k| {
                        r.raw
                            .get(k)
                            .and_then(Value::as_array)
                            .is_some_and(|v| !v.is_empty())
                    })
                })
        }) {
            return Err(unsupported(
                "Materialization combined with existing destination reuse is not yet ported; no changes made",
            ));
        }
        for item in items.iter().filter(|i| i.reuse.is_some()) {
            nested_safety(&item.target, &items)?;
        }
    }
    if remote_scope {
        for root in &selected_roots {
            create_remote::preflight(root)?;
        }
    }
    resolve_bases(w, args, &mut items)?;
    let remote_scope = items.iter().any(|i| i.remote.is_some());
    if remote_scope {
        if !args.has("json")
            || !args.has("no-hooks")
            || !matches!(args.value("conflict"), Some("ABORT" | "REUSE_EXISTING"))
            || items.iter().any(|i| {
                i.reuse.is_some()
                    || !i.source.starts_with("refs/heads/")
                    || w.config
                        .as_ref()
                        .unwrap()
                        .repos
                        .get(&i.name)
                        .is_some_and(|r| {
                            ["copy", "symlink"]
                                .iter()
                                .any(|k| r.raw[*k].as_array().is_some_and(|a| !a.is_empty()))
                        })
            })
        {
            return Err(unsupported(
                "Remote create requires JSON, explicit conflict/no-hooks and local bases; reuse/materialization combinations are not yet supported",
            ));
        }
        for item in &items {
            reuse::repository_safety(&item.root)?;
            if git::run(&item.root, &["symbolic-ref", "HEAD"])?.trim() != "refs/heads/main"
                || create_remote::local_head(&item.root, "main")?.as_deref()
                    != Some(item.oid.as_str())
                || git::worktrees(&item.root)?.len() != 1
            {
                return Err(unsupported(
                    "Remote create requires main-base primary repositories without other registered worktrees",
                ));
            }
        }
    }
    if !remote_scope
        && (args.value("conflict") == Some("ABORT")
            || items.iter().any(|i| {
                i.existing
                    && (args.value("conflict") != Some("REUSE_EXISTING")
                        || args.has("dry-run") && i.reuse.is_none())
            }))
    {
        return Err(unsupported(
            "Existing configured branches require --conflict REUSE_EXISTING; conflict dry-run is not yet ported",
        ));
    }
    // The parent must precede its children even when explicitly selected last.
    items.sort_by_key(|i| usize::from(i.root != w.root));
    Ok(items)
}
fn plan_materialization(w: &Workspace, items: &[Item]) -> Result<Vec<Value>> {
    let mut plans = vec![];
    for item in items {
        if let Some(policy) = w.config.as_ref().unwrap().repos.get(&item.name)
            && let Some(plan) = crate::materialization::plan(
                &item.root,
                &item.target,
                &item.name,
                &item.oid,
                &policy.raw,
            )?
        {
            plans.push(plan);
        }
    }
    Ok(plans)
}
fn reuse_safety(items: &[Item]) -> Result<Vec<(PathBuf, reuse::RepositorySafety)>> {
    if !items.iter().any(|item| item.reuse.is_some()) {
        return Ok(vec![]);
    }
    items
        .iter()
        .map(|item| Ok((item.root.clone(), reuse::repository_safety(&item.root)?)))
        .collect()
}
fn validate_reuse_safety(
    items: &[Item],
    expected: &[(PathBuf, reuse::RepositorySafety)],
) -> Result<()> {
    if reuse_safety(items)? != expected {
        return Err(Error::new(
            "PLAN_CHANGED",
            "Repository safety configuration changed during create",
        ));
    }
    Ok(())
}
pub fn create(w: &Workspace, args: &Args) -> Result<Value> {
    let items = plan(w, args)?;
    let remote_scope = items.iter().any(|i| i.remote.is_some());
    let remote_primaries = if remote_scope {
        items
            .iter()
            .map(|i| Ok((i.root.clone(), create_remote::primary(&i.root)?)))
            .collect::<Result<Vec<_>>>()?
    } else {
        vec![]
    };
    let reuse_safety = reuse_safety(&items)?;
    let branch = &args.positional[0];
    let dry = args.has("dry-run");
    let c = w.config.as_ref().unwrap();
    let materialization_plans = plan_materialization(w, &items)?;
    crate::materialization::require_actionable(&materialization_plans)?;
    let ignore = IgnorePlan::build(&w.root, &c.repos_dir, &c.worktrees_dir, dry)?;
    if remote_scope && ignore.data["attempted"] == true {
        return Err(unsupported(
            "Remote conflicts require managed paths to be already ignored; ignore reconciliation is not yet supported in this subset",
        ));
    }
    let mut rows = vec![];
    let targets = items
        .iter()
        .map(|i| crate::hooks::Target {
            name: i.name.clone(),
            root: i.root.clone(),
            worktree: Some(i.target.clone()),
        })
        .collect::<Vec<_>>();
    let hook_plan = crate::hooks::Plan::prepare(w, args, &targets, branch)?;
    let _interrupt_guard = hook_plan.guard()?;
    let mut hook_outcomes = vec![];
    let mut dirty_workspace_guidance = Value::Null;
    let remote_abort =
        args.value("conflict") == Some("ABORT") && items.iter().any(|i| i.remote.is_some());
    if !dry && !remote_abort {
        let current = Workspace::discover(&w.root)?;
        if current.config.as_ref().unwrap().raw != c.raw || plan(&current, args)? != items {
            return Err(Error::new(
                "PLAN_CHANGED",
                "Create preconditions changed; no changes made",
            ));
        }
        validate_reuse_safety(&items, &reuse_safety)?;
        let mut tx = Transaction::default();
        let mut owned: Vec<&Item> = vec![];
        let mut remote_created = vec![];
        let mut materialized = crate::materialization::Ownership::default();
        let operation = (|| -> Result<()> {
            let pre = hook_plan.run("pre-create", Some("workspace"), true)?;
            let failure = crate::hooks::failure(&pre);
            hook_outcomes.extend(pre);
            if let Some(message) = failure {
                return Err(Error::new("CREATE_HOOK_FAILED", message));
            }
            let refreshed = Workspace::discover(&w.root)?;
            if refreshed.config.as_ref().unwrap().raw != c.raw || plan(&refreshed, args)? != items {
                return Err(Error::new(
                    "PLAN_CHANGED",
                    "Create preconditions changed after workspace hook",
                ));
            }
            validate_reuse_safety(&items, &reuse_safety)?;
            if crate::hooks::interrupted() {
                return Err(Error::new("HOOK_INTERRUPTED", "Lifecycle interrupted"));
            }
            crate::materialization::require_actionable(&plan_materialization(w, &items)?)?;
            ignore.apply(&mut tx)?;
            for item in &items {
                if crate::hooks::interrupted() {
                    return Err(Error::new("HOOK_INTERRUPTED", "Lifecycle interrupted"));
                }
                safe(&item.root)?;
                safe(&item.target)?;
                primary(&item.root)?;
                // Recheck each repository immediately before creating its branch/worktree.
                validate_reuse(&items, branch)?;
                validate_reuse_safety(&items, &reuse_safety)?;
                create_remote::validate(&items, branch, &owned)?;
                create_remote::validate_primaries(&remote_primaries)?;
                create_remote::validate_created(&remote_created, branch)?;
                if (item.reuse.is_none() && item.target.exists())
                    || if remote_scope {
                        create_remote::local_source(&item.root, &item.source)? != item.oid
                    } else {
                        git::run(&item.root, &["rev-parse", &item.source])?.trim() != item.oid
                    }
                {
                    return Err(Error::new(
                        "PLAN_CHANGED",
                        "Repository changed during coordinated create",
                    ));
                }
                create_remote::validate_pending(&items, branch, &owned)?;
                if item.reuse.is_none() {
                    tx.mkdir(item.target.parent().unwrap())?;
                    if !item.existing {
                        let source = if remote_scope || item.base["source"] != "legacy-omitted" {
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
                    if remote_scope {
                        remote_created.push((
                            item,
                            reuse::inspect_created(&item.root, &item.target, branch)?,
                        ));
                    }
                }
                let mut repo_hooks = vec![];
                let mut materialization_outcomes = vec![];
                for phase in ["pre-create", "post-create"] {
                    if phase == "post-create"
                        && let Some(policy) = c.repos.get(&item.name)
                        && let Some(plan) = crate::materialization::plan(
                            &item.root,
                            &item.target,
                            &item.name,
                            &format!("refs/heads/{branch}"),
                            &policy.raw,
                        )?
                    {
                        crate::materialization::require_actionable(std::slice::from_ref(&plan))?;
                        materialization_outcomes =
                            materialized.execute(&item.root, &item.target, &plan)?;
                    }
                    let outcomes =
                        hook_plan.run(&format!("{phase}.{}", item.name), Some(&item.name), true)?;
                    let failure = crate::hooks::failure(&outcomes);
                    hook_outcomes.extend(outcomes.clone());
                    repo_hooks.extend(outcomes);
                    if let Some(message) = failure {
                        return Err(Error::new("CREATE_HOOK_FAILED", message));
                    }
                }
                rows.push(json!({"branchName":branch,"duration":0,"error":null,"hookOutcomes":repo_hooks,"materializationOutcomes":materialization_outcomes,"repositoryName":item.name,"repositoryPath":item.root,"status":"success","warnings":if item.existing {vec![format!("Reused existing branch '{branch}'")]}else{vec![]},"worktreePath":item.target}));
            }
            validate_reuse(&items, branch)?;
            create_remote::validate(&items, branch, &owned)?;
            create_remote::validate_primaries(&remote_primaries)?;
            create_remote::validate_created(&remote_created, branch)?;
            let post = hook_plan.run("post-create", Some("workspace"), true)?;
            let failure = crate::hooks::failure(&post);
            hook_outcomes.extend(post);
            if let Some(message) = failure {
                return Err(Error::new("CREATE_HOOK_FAILED", message));
            }
            validate_reuse(&items, branch)?;
            validate_reuse_safety(&items, &reuse_safety)?;
            dirty_workspace_guidance = dirty_guidance(w, branch, &items)?;
            validate_reuse(&items, branch)?;
            create_remote::validate(&items, branch, &owned)?;
            create_remote::validate_primaries(&remote_primaries)?;
            create_remote::validate_created(&remote_created, branch)?;
            create_remote::validate_pending(&items, branch, &owned)?;
            Ok(())
        })();
        if let Err(e) = operation {
            // Git ownership must still hold before deleting even invocation-written files:
            // a hook may have committed them or changed/locked the registered worktree.
            let mut rollback_errors = vec![];
            // Preserve changed objects and ancestors containing them, while allowing
            // independent siblings with intact ownership proofs to roll back.
            let changed_created: Vec<_> = remote_created
                .iter()
                .filter(|proof| {
                    create_remote::validate_created(std::slice::from_ref(proof), branch).is_err()
                })
                .map(|(item, _)| &item.target)
                .chain(
                    owned
                        .iter()
                        .filter(|item| {
                            remote_scope
                                && !remote_created
                                    .iter()
                                    .any(|(done, _)| done.root == item.root)
                                && item.target.symlink_metadata().is_ok()
                        })
                        .map(|item| &item.target),
                )
                .collect();
            let changed_primaries: Vec<_> = remote_primaries
                .iter()
                .filter(|proof| {
                    create_remote::validate_primaries(std::slice::from_ref(proof)).is_err()
                })
                .map(|(root, _)| root)
                .collect();
            // A reused ancestor is caller-owned. If its filesystem/Git ownership
            // changed, even a newly added descendant may now name someone else's
            // files. Preserve the whole transaction rather than clean through it.
            for reused in items.iter().filter(|i| i.reuse.is_some()) {
                if owned.iter().any(|i| {
                    i.target.starts_with(&reused.target) || i.root.starts_with(&reused.root)
                }) && (reuse::inspect(&reused.root, &reused.target, branch)
                    .ok()
                    .as_ref()
                    != reused.reuse.as_ref()
                    || !git::worktrees(&reused.root).is_ok_and(|records| {
                        records.iter().any(|r| {
                            r.path == reused.target
                                && r.head == reused.oid
                                && r.branch.as_deref() == Some(branch)
                                && !r.locked
                                && r.prune_reason.is_none()
                        })
                    }))
                {
                    rollback_errors.push(format!(
                        "Reused ancestor ownership changed; transaction preserved for recovery: {}",
                        reused.target.display()
                    ));
                    return Err(Error::new("COORDINATED_CREATE_FAILED", e.message)
                        .with_details(json!({"completed":rows,"rollbackErrors":rollback_errors,"hookOutcomes":hook_outcomes})));
                }
            }
            for item in owned.iter().filter(|_| !materialization_plans.is_empty()) {
                let ownership = (|| -> Result<()> {
                    safe(&item.root)?;
                    safe(&item.target)?;
                    if let Some(record) = git::worktrees(&item.root)?
                        .iter()
                        .find(|r| r.path == item.target)
                    {
                        if record.head != item.oid
                            || record.branch.as_deref() != Some(branch)
                            || record.locked
                            || record.prune_reason.is_some()
                        {
                            return Err(unsupported(
                                "Worktree ownership changed; materialization preserved",
                            ));
                        }
                        nested_safety(&item.target, &items)?;
                    } else if item.target.try_exists()? {
                        return Err(unsupported(
                            "Worktree registration disappeared; materialization preserved",
                        ));
                    }
                    Ok(())
                })();
                if let Err(e) = ownership {
                    rollback_errors.push(e.message);
                }
            }
            if rollback_errors.is_empty() {
                rollback_errors.extend(materialized.rollback());
            }
            let materialization_preserved = !rollback_errors.is_empty();
            for item in owned.into_iter().rev() {
                if changed_created.iter().any(|target| {
                    item.target.starts_with(target) || target.starts_with(&item.target)
                }) || changed_primaries
                    .iter()
                    .any(|root| item.root.starts_with(root) || item.target.starts_with(root))
                    || remote_created
                        .iter()
                        .filter(|(done, _)| done.root == item.root)
                        .any(|proof| {
                            create_remote::validate_created(std::slice::from_ref(proof), branch)
                                .is_err()
                        })
                {
                    rollback_errors.push(format!(
                        "Worktree ownership changed; preserved for recovery: {}",
                        item.target.display()
                    ));
                    continue;
                }

                if materialization_preserved {
                    rollback_errors.push(format!(
                        "Worktree preserved after materialization rollback failure: {}",
                        item.target.display()
                    ));
                    continue;
                }
                if let Err(e) = safe(&item.root).and_then(|()| safe(&item.target)) {
                    rollback_errors.push(e.message);
                    continue;
                }
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
                        || record.prune_reason.is_some()
                    {
                        rollback_errors.push(format!(
                            "Worktree ownership changed: {}",
                            item.target.display()
                        ));
                        continue;
                    }
                    if let Err(e) = nested_safety(&item.target, &[]) {
                        rollback_errors.push(e.message);
                        continue;
                    }
                    // Hook writes inside newly owned worktrees are rolled back.
                    // Without hooks retain the original conservative dirty cleanup.
                    let mut remove = vec!["worktree", "remove"];
                    if hook_outcomes.iter().any(|o| o["hookStatus"] != "skipped") {
                        remove.push("--force");
                    }
                    remove.push(item.target.to_str().unwrap());
                    if let Err(e) = git::run(&item.root, &remove) {
                        rollback_errors.push(e.message);
                        continue;
                    }
                }
                if !item.existing {
                    if if remote_scope {
                        create_remote::local_head(&item.root, branch)
                            .is_ok_and(|oid| oid.as_deref() == Some(item.oid.as_str()))
                    } else {
                        git::run(&item.root, &["rev-parse", &format!("refs/heads/{branch}")])
                            .is_ok_and(|oid| oid.trim() == item.oid)
                    } {
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
                .with_details(json!({"completed":rows,"rollbackErrors":rollback_errors,"hookOutcomes":hook_outcomes})));
        }
    }
    let mut data = w.metadata();
    let count = items.len();
    data.as_object_mut().unwrap().extend(json!({"branchName":branch,"dirtyWorkspaceGuidance":null,"dryRun":dry,"errorSummary":null,"failureCount":0,"hookOutcomes":hook_outcomes,"managedIgnore":ignore.data,"moveSummary":null,"nextSteps":[],"repositories":rows,"rolledBack":false,"skippedCount":if dry {count}else{0},"successCount":if dry {0}else{count},"totalDuration":0,"totalRepositories":count}).as_object().unwrap().clone());
    if dry {
        let conflicts = items.iter().filter(|i| i.reuse.is_some() || i.remote.is_some() || i.existing).map(|i| json!({"blocking":remote_abort,"conflictType":"branch_exists","message":format!("Branch '{branch}' already exists {}", if i.remote.is_some() { "remotely" } else { "locally" }),"repositoryName":i.name,"scope":format!("{}:{branch}",i.name)})).collect::<Vec<_>>();
        let conflict_count = conflicts.len();
        data["dryRunOutcome"] = json!({"conflicts":conflicts,"plannedWorktrees":items.iter().map(|i|json!({"branchName":branch,"planStatus":if remote_abort && (i.remote.is_some() || i.existing) { "blocked" } else { "actionable" },"repositoryName":i.name,"worktreePath":i.target})).collect::<Vec<_>>(),"summaryCounts":{"blockingTotal":if remote_abort {conflict_count}else{0},"conflictTotal":conflict_count,"plannedTotal":count}});
        if remote_abort {
            data["errorSummary"] = json!("Blocking conflicts detected during dry-run");
        }
    }
    if !materialization_plans.is_empty() {
        data["repositoryResults"] = data["repositories"].clone();
        if dry {
            data["dryRunOutcome"]["materializationPlans"] = json!(materialization_plans);
        }
    }
    if let Some(first) = items
        .iter()
        .find(|i| !i.base.is_null() && i.base["source"] != "legacy-omitted")
    {
        data["base"] = json!({"requestedBranch":first.base["requestedBranch"],"source":first.base["source"],"repositories":items.iter().map(|i| i.base.clone()).collect::<Vec<_>>()});
    }
    if !dry {
        data["dirtyWorkspaceGuidance"] = dirty_workspace_guidance;
    }
    if dry || remote_abort {
        create_remote::validate(&items, branch, &[])?;
        create_remote::validate_primaries(&remote_primaries)?;
        create_remote::validate_pending(&items, branch, &[])?;
    }
    if remote_abort && !dry {
        data["errorSummary"] = json!("Operation aborted due to branch conflicts");
        data["failureCount"] = json!(1);
        data["successCount"] = json!(0);
        data["rolledBack"] = json!(true);
        return Err(
            Error::new("CREATE_FAILED", "Operation aborted due to branch conflicts")
                .with_details(data),
        );
    }
    Ok(data)
}

fn validate_reuse(items: &[Item], branch: &str) -> Result<()> {
    for item in items.iter().filter(|i| i.reuse.is_some()) {
        let records = git::worktrees(&item.root)?;
        let valid = records
            .iter()
            .filter(|r| r.branch.as_deref() == Some(branch))
            .collect::<Vec<_>>();
        if valid.len() != 1
            || valid[0].path != item.target
            || valid[0].head != item.oid
            || valid[0].locked
            || valid[0].prune_reason.is_some()
            || reuse::inspect(&item.root, &item.target, branch)? != *item.reuse.as_ref().unwrap()
        {
            return Err(Error::new(
                "PLAN_CHANGED",
                "Existing worktree ownership changed during create",
            ));
        }
        nested_safety(&item.target, items)?;
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
#[derive(Clone, Debug, PartialEq)]
struct BranchRemoval {
    name: String,
    root: PathBuf,
    oid: String,
}
#[derive(Clone, Debug, PartialEq)]
struct RemovePlan {
    worktrees: Vec<Item>,
    branches: Vec<BranchRemoval>,
}
fn remove_plan(w: &Workspace, args: &Args) -> Result<RemovePlan> {
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
    let branch = &args.positional[0];
    let caller = crate::paths::canonicalize(std::env::current_dir()?)?;
    let mut items = vec![];
    let mut branches = vec![];
    for (name, root, _) in rows {
        let records = git::worktrees(&root)?;
        if let Ok(oid) = git::run(
            &root,
            &[
                "show-ref",
                "--verify",
                "--hash",
                &format!("refs/heads/{branch}"),
            ],
        ) {
            branches.push(BranchRemoval {
                name: name.clone(),
                root: root.clone(),
                oid: oid.trim().into(),
            });
        }
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
                reuse: None,
                remote: None,
                base: Value::Null,
                requested_base: None,
            });
        }
    }
    if items.is_empty() && branches.is_empty() {
        return Err(unsupported("No matching configured worktrees"));
    }
    for i in &items {
        nested_safety(&i.target, &items)?;
    }
    Ok(RemovePlan {
        worktrees: items,
        branches,
    })
}
pub fn remove(w: &Workspace, args: &Args) -> Result<Value> {
    args.only(&["force", "keep-branches", "dry-run"])?;
    let dry = args.has("dry-run");
    let plan = remove_plan(w, args)?;
    let items = &plan.worktrees;
    if !dry && !args.has("force") {
        return Err(unsupported(
            "Interactive configured removal requires --force in this port",
        ));
    }
    let current = Workspace::discover(&w.root)?;
    if current.config.as_ref().unwrap().raw != w.config.as_ref().unwrap().raw
        || remove_plan(&current, args)? != plan
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
        if !plan.branches.iter().any(|i| i.name == name) {
            missing.push(name);
        }
    }

    let mut hook_targets: Vec<_> = ordered
        .iter()
        .map(|i| (&i.name, &i.root, Some(&i.target)))
        .collect();
    for branch in &plan.branches {
        if !hook_targets
            .iter()
            .any(|(name, _, _)| *name == &branch.name)
        {
            hook_targets.push((&branch.name, &branch.root, None));
        }
    }
    let targets = hook_targets
        .iter()
        .map(|(name, root, target)| crate::hooks::Target {
            name: (*name).clone(),
            root: (*root).clone(),
            worktree: target.cloned(),
        })
        .collect::<Vec<_>>();
    let hook_plan = crate::hooks::Plan::prepare(w, args, &targets, branch)?;
    let _interrupt_guard = hook_plan.guard()?;
    let mut hooks = vec![];
    let mut operations = vec![];
    if dry {
        for i in &ordered {
            operations.push(json!({"branchName":branch,"repository":i.name,"status":"pending","type":"worktree_remove","worktreePath":i.target}));
        }
        if !keep {
            for i in &plan.branches {
                operations.push(json!({"branchName":branch,"repository":i.name,"status":"pending","type":"branch_delete"}));
            }
        }
        let mut data = w.metadata();
        let branches = if keep { 0 } else { plan.branches.len() };
        data.as_object_mut().unwrap().extend(json!({"dryRun":true,"errors":[],"hookOutcomes":[],"operations":operations,"success":true,"summary":{"duration":0,"successfulBranches":0,"successfulWorktrees":0,"totalBranches":branches,"totalWorktrees":items.len()},"effectiveOptions":{"checkDirty":true,"force":args.has("force"),"keepBranches":keep,"keepWorktrees":false},"hooks":[],"missingBranches":{branch:missing}}).as_object().unwrap().clone());
        return Ok(data);
    }
    hooks.extend(hook_plan.run("pre-remove", None, true)?);
    if let Some(message) = crate::hooks::failure(&hooks) {
        let message = format!("pre-remove hook failed: {message}");
        let mut data = w.metadata();
        let branches = if keep { 0 } else { plan.branches.len() };
        data.as_object_mut().unwrap().extend(json!({"dryRun":false,"errors":[message],"hookOutcomes":hooks,"operations":[],"success":false,"summary":{"duration":0,"successfulBranches":0,"successfulWorktrees":0,"totalBranches":branches,"totalWorktrees":items.len()},"missingBranches":{branch:missing}}).as_object().unwrap().clone());
        return Err(Error::new("REMOVE_HOOK_FAILED", message).with_details(data));
    }
    // Hooks may change refs, configuration or nested worktree topology.
    let refreshed = Workspace::discover(&w.root)?;
    if refreshed.config.as_ref().unwrap().raw != w.config.as_ref().unwrap().raw
        || remove_plan(&refreshed, args)? != plan
    {
        return Err(
            Error::new("PLAN_CHANGED", "Removal preconditions changed after hooks")
                .with_details(json!({"hookOutcomes":hooks})),
        );
    }
    for item in &ordered {
        if crate::hooks::interrupted() {
            return Err(Error::new("HOOK_INTERRUPTED", "Lifecycle interrupted")
                .with_details(json!({"operations":operations,"hookOutcomes":hooks})));
        }
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
        for item in &plan.branches {
            if crate::hooks::interrupted() {
                return Err(Error::new("HOOK_INTERRUPTED", "Lifecycle interrupted")
                    .with_details(json!({"operations":operations,"hookOutcomes":hooks})));
            }
            safe(&item.root)?;
            let oid = git::run(
                &item.root,
                &[
                    "show-ref",
                    "--verify",
                    "--hash",
                    &format!("refs/heads/{branch}"),
                ],
            )?;
            if oid.trim() != item.oid
                || git::worktrees(&item.root)?
                    .iter()
                    .any(|w| w.branch.as_deref() == Some(branch))
            {
                return Err(Error::new(
                    "COORDINATED_REMOVE_PARTIAL_FAILURE",
                    "Branch changed during removal",
                )
                .with_details(json!({"operations":operations})));
            }
            if let Err(e) = git::run(&item.root, &["branch", "-D", branch]) {
                return Err(Error::new("COORDINATED_REMOVE_PARTIAL_FAILURE", e.message)
                    .with_details(json!({"operations":operations})));
            }
            operations.push(json!({"branchName":branch,"repository":item.name,"status":"success","type":"branch_delete"}));
        }
    }
    let post = hook_plan.run("post-remove", None, false)?;
    let failure =
        crate::hooks::failure(&post).map(|message| format!("post-remove hook failed: {message}"));
    hooks.extend(post);
    let mut data = w.metadata();
    let branches = if keep { 0 } else { plan.branches.len() };
    data.as_object_mut().unwrap().extend(json!({"dryRun":false,"errors":[],"hookOutcomes":hooks,"operations":operations,"success":true,"summary":{"duration":0,"successfulBranches":branches,"successfulWorktrees":items.len(),"totalBranches":branches,"totalWorktrees":items.len()},"missingBranches":{branch:missing}}).as_object().unwrap().clone());
    if let Some(message) = failure {
        data["errors"] = json!([message]);
        data["success"] = json!(false);
        return Err(Error::new("REMOVE_FAILED", message).with_details(data));
    }
    Ok(data)
}
fn resolve_bases(w: &Workspace, args: &Args, items: &mut [Item]) -> Result<()> {
    let remote_scope = items.iter().any(|item| item.remote.is_some());
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
        let mut value = json!({"repositoryName":i.name,"repositoryIdentity":identity,"repositoryPath":i.root,"targetAction":if i.existing && args.value("conflict") != Some("ABORT"){"reused"}else{"created"}});
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
            let resolved = if remote_scope {
                create_remote::local_head(&i.root, branch)?.map(|oid| (&refs[0], oid))
            } else {
                refs.iter().find_map(|r| {
                    git::run(
                        &i.root,
                        &["rev-parse", "--verify", &format!("{r}^{{commit}}")],
                    )
                    .ok()
                    .map(|oid| (r, oid.trim().to_owned()))
                })
            };
            if let Some((reference, oid)) = resolved {
                value["resolvedRef"] = json!(reference);
                value["resolvedOid"] = json!(oid);
                i.requested_base = Some((reference.clone(), oid.clone()));
                if !i.existing {
                    i.source = reference.clone();
                    i.oid = oid;
                }
            } else {
                let mut failure = value.clone();
                failure.as_object_mut().unwrap().remove("targetAction");
                failure["attemptedRefs"] = if remote_scope {
                    json!([refs[0]])
                } else {
                    json!(refs)
                };
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
        let raw = git::run(
            &i.root,
            &[
                "--no-optional-locks",
                "-c",
                "core.fsmonitor=false",
                "status",
                "--porcelain=v1",
                "-uall",
            ],
        )?;
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
