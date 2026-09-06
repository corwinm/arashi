//! Bounded, fail-closed movement of uncommitted changes between ordinary worktrees.
use crate::{Error, Result, cli::Args, config::Workspace, git};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone)]
struct Dirty {
    deleted: usize,
    modified: usize,
    staged: usize,
    total: usize,
    untracked: usize,
    status: String,
}

impl Dirty {
    fn summary(&self) -> String {
        let mut parts = Vec::new();
        for (count, label) in [
            (self.staged, "staged"),
            (self.modified, "modified"),
            (self.deleted, "deleted"),
            (self.untracked, "untracked"),
        ] {
            if count > 0 {
                parts.push(format!("{count} {label}"));
            }
        }
        if parts.is_empty() {
            "clean".into()
        } else {
            parts.join(", ")
        }
    }
}

#[derive(Clone)]
struct Repository {
    name: String,
    root: PathBuf,
}

#[derive(Clone)]
struct Entry {
    name: String,
    path: PathBuf,
    dirty: Dirty,
    head: String,
}

#[derive(Clone)]
struct Selection {
    label: String,
    primary_path: PathBuf,
    branch: Option<String>,
    repositories: Vec<Entry>,
}

struct Item {
    name: String,
    source: Entry,
    target: Entry,
    incoming: Vec<String>,
}

struct Stashed {
    item: Item,
    oid: String,
    stash_ref: String,
    applied: bool,
    target_state: Option<String>,
}

fn unsupported(message: impl Into<String>) -> Error {
    Error::new("RUST_NOT_YET_PORTED", message)
}

fn read_git(path: &Path, args: &[&str]) -> Result<String> {
    let mut command = vec!["--no-optional-locks", "-c", "core.fsmonitor=false"];
    command.extend_from_slice(args);
    git::run(path, &command)
}

fn repositories(workspace: &Workspace) -> Result<Vec<Repository>> {
    let mut result = vec![Repository {
        name: workspace
            .root
            .file_name()
            .ok_or_else(|| unsupported("Repository root has no portable name"))?
            .to_string_lossy()
            .into_owned(),
        root: workspace.root.clone(),
    }];
    if let Some(config) = &workspace.config {
        let canonical_workspace = crate::paths::canonicalize(&workspace.root)?;
        for name in &config.repo_order {
            let configured = workspace.root.join(&config.repos[name].path);
            crate::managed::safe(&configured)?;
            let canonical = crate::paths::canonicalize(&configured).map_err(|_| {
                unsupported(format!(
                    "Configured repository is unavailable: {}; no changes made",
                    configured.display()
                ))
            })?;
            if !canonical.starts_with(&canonical_workspace) || canonical == canonical_workspace {
                return Err(unsupported(
                    "External, duplicate, or aliased configured repositories are not supported; no changes made",
                ));
            }
            if result.iter().any(|repository| {
                crate::paths::same_existing(&repository.root, &canonical).unwrap_or(false)
            }) {
                return Err(unsupported(
                    "Duplicate configured repository identities are not supported; no changes made",
                ));
            }
            result.push(Repository {
                name: name.clone(),
                root: canonical,
            });
        }
    }
    Ok(result)
}

fn git_observation_policy(repository: &Repository) -> Result<()> {
    let worktrees = git::worktrees(&repository.root)?;
    if worktrees.first().is_none_or(|record| record.bare)
        || read_git(&repository.root, &["rev-parse", "--is-bare-repository"])?.trim() == "true"
    {
        return Err(unsupported(
            "Bare repository move topology is not supported; no changes made",
        ));
    }
    if read_git(&repository.root, &["ls-files", "--stage", "-z"])?
        .split('\0')
        .any(|entry| entry.starts_with("160000 "))
    {
        return Err(unsupported(
            "Move with gitlink/submodule topology is not supported; no changes made",
        ));
    }
    for key in ["core.fsmonitor", "core.worktree"] {
        if git::run(&repository.root, &["config", "--get", key]).is_ok() {
            return Err(unsupported(format!(
                "Move with configured {key} is not supported; no changes made"
            )));
        }
    }
    if let Ok(filters) = git::run(
        &repository.root,
        &["config", "--get-regexp", r"^filter\..*\.(clean|process)$"],
    ) && !filters.trim().is_empty()
    {
        return Err(unsupported(
            "Move with clean/process conversion filters is not supported; no changes made",
        ));
    }
    Ok(())
}

fn dirty(path: &Path) -> Result<Dirty> {
    let status = read_git(path, &["status", "--porcelain=v1", "-uall"])?;
    let mut details = Dirty {
        deleted: 0,
        modified: 0,
        staged: 0,
        total: 0,
        untracked: 0,
        status,
    };
    for line in details
        .status
        .lines()
        .filter(|line| !line.trim().is_empty())
    {
        details.total += 1;
        let bytes = line.as_bytes();
        let index = bytes.first().copied().unwrap_or(b' ');
        let worktree = bytes.get(1).copied().unwrap_or(b' ');
        if line.starts_with("??") {
            details.untracked += 1;
            continue;
        }
        if index != b' ' && index != b'?' {
            details.staged += 1;
        }
        if index == b'D' || worktree == b'D' {
            details.deleted += 1;
        }
        if worktree != b' ' || (index != b' ' && index != b'D') {
            details.modified += 1;
        }
    }
    Ok(details)
}

fn key(path: &Path) -> Result<String> {
    Ok(crate::paths::canonicalize(path)?
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase())
}

fn discover(repositories: &[Repository]) -> Result<Vec<Selection>> {
    let mut selections: BTreeMap<String, Selection> = BTreeMap::new();
    for repository in repositories {
        git_observation_policy(repository)?;
        for record in git::worktrees(&repository.root)? {
            if record.bare {
                continue;
            }
            if record.locked || record.prune_reason.is_some() {
                return Err(unsupported(
                    "Locked or prunable move worktrees are not supported; no changes made",
                ));
            }
            crate::managed::safe(&record.path)?;
            let path = crate::paths::canonicalize(&record.path)?;
            let is_main = crate::paths::same_existing(&path, &repository.root)?;
            let entry = Entry {
                name: repository.name.clone(),
                dirty: dirty(&path)?,
                head: record.head,
                path: path.clone(),
            };
            let map_key = record.branch.as_ref().map_or_else(
                || key(&path).map(|path| format!("path:{path}")),
                |branch| Ok(format!("branch:{branch}")),
            )?;
            if let Some(selection) = selections.get_mut(&map_key) {
                selection.repositories.push(entry);
                if is_main {
                    selection.primary_path = path;
                }
            } else {
                let label = record.branch.clone().unwrap_or_else(|| {
                    path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned()
                });
                selections.insert(
                    map_key,
                    Selection {
                        branch: record.branch,
                        label,
                        primary_path: path,
                        repositories: vec![entry],
                    },
                );
            }
        }
    }
    let mut values: Vec<_> = selections.into_values().collect();
    values.sort_by(|left, right| left.label.cmp(&right.label));
    Ok(values)
}

fn resolve_reference(selections: &[Selection], reference: &str) -> Result<Selection> {
    let absolute = Path::new(reference).is_absolute();
    let comparable = absolute.then(|| key(Path::new(reference))).transpose()?;
    let matches: Vec<_> = selections
        .iter()
        .filter(|selection| {
            selection.branch.as_deref() == Some(reference)
                || selection.label == reference
                || selection
                    .primary_path
                    .file_name()
                    .is_some_and(|name| name == reference)
                || comparable.as_ref().is_some_and(|reference| {
                    selection.repositories.iter().any(|repository| {
                        key(&repository.path).is_ok_and(|path| &path == reference)
                    })
                })
        })
        .cloned()
        .collect();
    match matches.as_slice() {
        [selection] => Ok(selection.clone()),
        [] => Err(Error::new(
            "WORKSPACE_NOT_FOUND",
            format!("Workspace not found: {reference}"),
        )
        .with_details(json!({"ref":reference}))),
        _ => Err(Error::new(
            "AMBIGUOUS_WORKSPACE",
            format!("Workspace reference is ambiguous: {reference}"),
        )
        .with_details(json!({"matches":matches.iter().map(|selection| json!({"branch":selection.branch,"path":selection.primary_path})).collect::<Vec<_>>(),"ref":reference}))),
    }
}

#[cfg(unix)]
fn same_device(left: &Path, right: &Path) -> Result<bool> {
    use std::os::unix::fs::MetadataExt;
    Ok(fs::metadata(left)?.dev() == fs::metadata(right)?.dev())
}

#[cfg(not(unix))]
fn same_device(_left: &Path, _right: &Path) -> Result<bool> {
    Ok(true)
}

fn plan(source: &Selection, target: &Selection) -> Result<(Vec<Item>, Vec<Value>)> {
    if key(&source.primary_path)? == key(&target.primary_path)? {
        return Err(Error::new(
            "SAME_WORKSPACE",
            "Source and target workspaces are the same",
        )
        .with_details(json!({"source":source.primary_path,"target":target.primary_path})));
    }
    let targets: BTreeMap<_, _> = target
        .repositories
        .iter()
        .map(|repository| (repository.name.clone(), repository))
        .collect();
    let mut items = Vec::new();
    let mut skipped = Vec::new();
    for source_repository in &source.repositories {
        if source_repository.dirty.total == 0 {
            skipped.push(json!({"message":"Source repository is clean","repositoryName":source_repository.name,"sourcePath":source_repository.path,"status":"skipped"}));
            continue;
        }
        let Some(target_repository) = targets.get(&source_repository.name) else {
            skipped.push(json!({"message":"Target workspace does not contain this repository","repositoryName":source_repository.name,"sourcePath":source_repository.path,"status":"skipped"}));
            continue;
        };
        if target_repository.dirty.total > 0 {
            return Err(Error::new(
                "DIRTY_TARGET_REPOSITORY",
                format!(
                    "Target repository has uncommitted changes: {}",
                    target_repository.name
                ),
            )
            .with_details(json!({"repositoryName":target_repository.name,"targetPath":target_repository.path})));
        }
        if !same_device(&source_repository.path, &target_repository.path)? {
            return Err(unsupported(
                "Cross-filesystem move worktrees are not supported; no changes made",
            ));
        }
        let mut incoming = read_git(
            &source_repository.path,
            &["diff", "--name-only", "--no-renames", "-z", "HEAD"],
        )?;
        incoming.push_str(&read_git(
            &source_repository.path,
            &["diff", "--cached", "--name-only", "--no-renames", "-z"],
        )?);
        incoming.push_str(&read_git(
            &source_repository.path,
            &["ls-files", "--others", "--exclude-standard", "-z"],
        )?);
        let incoming: Vec<String> = incoming
            .split('\0')
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect();
        check_ignored_collisions(&target_repository.path, &incoming)?;
        items.push(Item {
            incoming,
            name: source_repository.name.clone(),
            source: source_repository.clone(),
            target: (*target_repository).clone(),
        });
    }
    if items.is_empty() {
        return Err(Error::new(
            "NO_COMPATIBLE_CHANGES",
            "No compatible changed repositories were found to move",
        )
        .with_details(json!({"skipped":skipped})));
    }
    Ok((items, skipped))
}

fn check_ignored_collisions(target: &Path, incoming: &[String]) -> Result<()> {
    for name in incoming {
        if fs::symlink_metadata(target.join(name)).is_ok()
            && read_git(target, &["check-ignore", "--quiet", "--", name]).is_ok()
        {
            return Err(Error::new(
                "DIRTY_TARGET_REPOSITORY",
                format!(
                    "Target ignored path would be overwritten: {name}; no further changes made"
                ),
            ));
        }
    }
    Ok(())
}

fn validate_item(item: &Item, source_dirty: bool) -> Result<()> {
    check_ignored_collisions(&item.target.path, &item.incoming)?;
    if key(&item.source.path)? == key(&item.target.path)?
        || read_git(&item.source.path, &["rev-parse", "HEAD"])?.trim() != item.source.head
        || read_git(&item.target.path, &["rev-parse", "HEAD"])?.trim() != item.target.head
    {
        return Err(unsupported(
            "Move worktree identity changed after planning; no further changes made",
        ));
    }
    let source = dirty(&item.source.path)?;
    let target = dirty(&item.target.path)?;
    if target.total > 0
        || (source_dirty && source.status != item.source.dirty.status)
        || (!source_dirty && source.total > 0)
    {
        return Err(unsupported(
            "Move worktree state changed after planning; no further changes made",
        ));
    }
    Ok(())
}

// Compare actual index/worktree bytes, not just porcelain status letters.
fn target_state(path: &Path) -> Result<String> {
    let mut state = read_git(path, &["rev-parse", "HEAD"])?;
    state.push_str(&read_git(
        path,
        &["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"],
    )?);
    state.push_str(&read_git(
        path,
        &[
            "diff",
            "--cached",
            "--binary",
            "--no-ext-diff",
            "--no-textconv",
        ],
    )?);
    for name in read_git(path, &["ls-files", "--others", "--exclude-standard", "-z"])?
        .split('\0')
        .filter(|name| !name.is_empty())
    {
        state.push_str(&format!("{name:?}"));
        let file = path.join(name);
        if fs::symlink_metadata(&file)?.file_type().is_symlink() {
            state.push_str(&format!("{:?}", fs::read_link(file)?));
        } else {
            state.push_str(&format!("{:?}", fs::read(file)?));
        }
    }
    Ok(state)
}

fn restore(stashed: &mut [Stashed]) -> Vec<String> {
    let mut errors = Vec::new();
    for record in stashed.iter().rev().filter(|record| record.applied) {
        if record.target_state.as_ref().is_none_or(|expected| {
            target_state(&record.item.target.path).as_ref().ok() != Some(expected)
        }) {
            errors.push(format!(
                "{} target changed or apply was incomplete; preserved for recovery",
                record.item.name
            ));
            continue;
        }
        // Never recursively clean: only remove the exact untracked entries observed.
        let cleanup = (|| -> Result<()> {
            let names = read_git(
                &record.item.target.path,
                &["ls-files", "--others", "--exclude-standard", "-z"],
            )?;
            read_git(
                &record.item.target.path,
                &["reset", "--hard", &record.item.target.head],
            )?;
            for name in names.split('\0').filter(|name| !name.is_empty()) {
                fs::remove_file(record.item.target.path.join(name))?;
            }
            Ok(())
        })();
        if let Err(error) = cleanup {
            errors.push(format!("{} target cleanup: {error}", record.item.name));
        }
    }
    for record in stashed.iter().rev() {
        if let Err(error) = read_git(
            &record.item.source.path,
            &["stash", "apply", "--index", &record.oid],
        ) {
            errors.push(format!("{} source restore: {error}", record.item.name));
            continue;
        }
        match read_git(
            &record.item.source.path,
            &["rev-parse", "--verify", &record.stash_ref],
        ) {
            Ok(oid) if oid.trim() == record.oid => {
                if let Err(error) = read_git(
                    &record.item.source.path,
                    &["stash", "drop", &record.stash_ref],
                ) {
                    errors.push(format!(
                        "{} recovery stash cleanup: {error}",
                        record.item.name
                    ));
                }
            }
            Ok(_) => errors.push(format!(
                "{} recovery stash changed ownership; preserved",
                record.item.name
            )),
            Err(_) => {}
        }
    }
    errors
}

fn execute(items: Vec<Item>) -> Result<Vec<Value>> {
    for item in &items {
        validate_item(item, true)?;
    }
    let mut stashed = Vec::new();
    for item in items {
        if let Err(error) = validate_item(&item, true) {
            let rollback = restore(&mut stashed);
            return Err(Error::new("MOVE_FAILED", error.to_string())
                .with_details(json!({"rollbackErrors":rollback})));
        }
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let message = format!("arashi-move:{}:{}:{stamp}", item.name, std::process::id());
        let pushed = read_git(
            &item.source.path,
            &["stash", "push", "--include-untracked", "-m", &message],
        );
        // A failed push can already have created a stash and cleaned the source.
        // Record that owned object before handling the command error.
        let owned = (|| -> Result<String> {
            let oid = read_git(&item.source.path, &["rev-parse", "--verify", "refs/stash"])?;
            let oid = oid.trim().to_owned();
            let subject = read_git(&item.source.path, &["show", "-s", "--format=%s", &oid])?;
            if !subject.trim().ends_with(&message) {
                return Err(unsupported(
                    "Move stash ownership could not be established; existing stash preserved",
                ));
            }
            Ok(oid)
        })();
        match owned {
            Ok(oid) => stashed.push(Stashed {
                item,
                oid,
                stash_ref: "stash@{0}".into(),
                applied: false,
                target_state: None,
            }),
            Err(error) => {
                let rollback = restore(&mut stashed);
                return Err(Error::new("MOVE_FAILED", error.to_string())
                    .with_details(json!({"rollbackErrors":rollback,"recovery":"Inspect refs/stash in the source repository; no unverified stash was dropped"})));
            }
        }
        if let Err(error) = pushed {
            let rollback = restore(&mut stashed);
            return Err(Error::new("MOVE_FAILED", error.to_string())
                .with_details(json!({"rollbackErrors":rollback})));
        }
    }
    for index in 0..stashed.len() {
        if let Err(error) = validate_item(&stashed[index].item, false) {
            let rollback = restore(&mut stashed);
            return Err(Error::new("MOVE_FAILED", error.to_string())
                .with_details(json!({"rollbackErrors":rollback})));
        }
        // A failed apply may have partially changed the target. Without a
        // completed post-apply snapshot, preserve that target for recovery.
        stashed[index].applied = true;
        if let Err(error) = read_git(
            &stashed[index].item.target.path,
            &["stash", "apply", "--index", &stashed[index].oid],
        ) {
            let rollback = restore(&mut stashed);
            return Err(Error::new("MOVE_FAILED", error.to_string())
                .with_details(json!({"rollbackErrors":rollback})));
        }
        stashed[index].target_state = target_state(&stashed[index].item.target.path).ok();
    }
    for index in 0..stashed.len() {
        let current = read_git(
            &stashed[index].item.source.path,
            &["rev-parse", "--verify", &stashed[index].stash_ref],
        );
        let drop = match current {
            Ok(oid) if oid.trim() == stashed[index].oid => read_git(
                &stashed[index].item.source.path,
                &["stash", "drop", &stashed[index].stash_ref],
            )
            .map(|_| ()),
            Ok(_) => Err(unsupported(
                "Move recovery stash changed ownership before cleanup",
            )),
            Err(error) => Err(error),
        };
        if let Err(error) = drop {
            let rollback = restore(&mut stashed);
            return Err(Error::new("MOVE_FAILED", error.to_string())
                .with_details(json!({"rollbackErrors":rollback})));
        }
    }
    let mut results = Vec::new();
    for record in &stashed {
        results.push(json!({
            "message":format!("Moved {}",record.item.source.dirty.summary()),
            "repositoryName":record.item.name,
            "sourcePath":record.item.source.path,
            "status":"moved",
            "targetPath":record.item.target.path,
        }));
    }
    Ok(results)
}

pub fn move_changes(workspace: &Workspace, args: &Args) -> Result<Value> {
    if cfg!(windows) {
        return Err(unsupported(
            "Native move mutation is not yet supported on Windows; no changes made",
        ));
    }
    let repositories = repositories(workspace)?;
    let selections = discover(&repositories)?;
    // Resolve explicit references in source order before considering prompts.
    let explicit_source = args
        .value("from")
        .map(|reference| resolve_reference(&selections, reference))
        .transpose()?;
    let explicit_target = args
        .value("to")
        .map(|reference| resolve_reference(&selections, reference))
        .transpose()?;
    let source = if let Some(source) = explicit_source {
        source
    } else {
        let current = key(&std::env::current_dir()?)?;
        selections
            .iter()
            .find(|selection| {
                selection
                    .repositories
                    .iter()
                    .any(|entry| key(&entry.path).is_ok_and(|path| path == current))
                    && selection
                        .repositories
                        .iter()
                        .any(|entry| entry.dirty.total > 0)
            })
            .cloned()
            .ok_or_else(|| {
                unsupported("Native move requires interactive source selection; no changes made")
            })?
    };
    let target = explicit_target.ok_or_else(|| {
        unsupported("Native move requires interactive target selection; no changes made")
    })?;
    let (items, skipped) = plan(&source, &target)?;
    let mut results = execute(items)?;
    results.extend(skipped);
    let moved_count = results
        .iter()
        .filter(|result| result["status"] == "moved")
        .count();
    let skipped_count = results.len() - moved_count;
    let mut data = json!({
        "failedCount":0,
        "movedCount":moved_count,
        "results":results,
        "skippedCount":skipped_count,
        "source":{"branch":source.branch,"label":source.label,"primaryPath":source.primary_path},
        "target":{"branch":target.branch,"label":target.label,"primaryPath":target.primary_path},
    });
    if workspace.config.is_some() {
        data["mode"] = json!("configured");
        data["workspaceRoot"] = json!(workspace.root);
    } else {
        data["mode"] = json!("standalone");
        data["repositoryPath"] = json!(workspace.root);
        data["workspaceRoot"] = json!(workspace.root);
        data["worktreesBase"] = json!(workspace.root.join(".worktrees"));
    }
    Ok(data)
}
