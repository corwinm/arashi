//! Conservative configured-repository deletion with immutable preflight evidence.
use crate::{
    Error, Result,
    cli::Args,
    config::{RepoConfig, Workspace},
    git,
    managed::{relative, unsupported},
};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq)]
struct ObjectIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    file_index: Option<u64>,
    #[cfg(windows)]
    volume: Option<u32>,
}

impl ObjectIdentity {
    fn metadata(metadata: &fs::Metadata) -> Self {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Self {
                device: metadata.dev(),
                inode: metadata.ino(),
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            Self {
                file_index: metadata.file_index(),
                volume: metadata.volume_serial_number(),
            }
        }
    }

    fn path(path: &Path) -> Result<Self> {
        Ok(Self::metadata(&fs::symlink_metadata(path)?))
    }

    fn matches(&self, path: &Path) -> bool {
        fs::symlink_metadata(path)
            .map(|metadata| Self::metadata(&metadata) == *self)
            .unwrap_or(false)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LocalRef {
    name: String,
    oid: String,
}

#[derive(Clone, Debug, PartialEq)]
struct DeletePlan {
    workspace_root: PathBuf,
    repository_key: String,
    repository_path: PathBuf,
    repository_identity: ObjectIdentity,
    config_path: PathBuf,
    config_identity: ObjectIdentity,
    config_before: Vec<u8>,
    config_after: Vec<u8>,
    config_entry_ref: String,
    local_refs: Vec<LocalRef>,
    ref_inventory: Vec<LocalRef>,
}

fn closed(code: &str, message: impl Into<String>, exit: i32) -> Error {
    Error::new(code, message).with_exit_code(exit)
}

fn quarantine_name(repository_key: &str) -> String {
    let encoded = repository_key
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!(".arashi-delete-{encoded}-{}", std::process::id())
}

fn no_symlink_below(root: &Path, path: &Path) -> Result<()> {
    let relative = path.strip_prefix(root).map_err(|_| {
        closed(
            "DELETE_PATH_UNSAFE",
            "Deletion path escapes the workspace",
            1,
        )
    })?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        let metadata = fs::symlink_metadata(&current).map_err(|error| {
            closed(
                "DELETE_TOPOLOGY_INVALID",
                format!("Deletion path is unavailable: {error}"),
                1,
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(closed(
                "DELETE_PATH_UNSAFE",
                "Deletion target traverses a symbolic link; no changes made",
                1,
            ));
        }
    }
    Ok(())
}

fn unsupported_selected_policy(repo: &RepoConfig) -> Result<()> {
    if ["copy", "symlink"].iter().any(|key| {
        repo.raw
            .get(key)
            .and_then(Value::as_array)
            .is_some_and(|entries| !entries.is_empty())
    }) {
        return Err(unsupported(
            "Delete with materialization policy is not yet ported; no changes made",
        ));
    }
    if repo
        .raw
        .get("hooks")
        .and_then(Value::as_object)
        .is_some_and(|hooks| !hooks.is_empty())
    {
        return Err(unsupported(
            "Delete with repository lifecycle hooks is not yet ported; no changes made",
        ));
    }
    Ok(())
}

fn no_delete_hooks(workspace: &Path, repository: &str, target: &Path) -> Result<()> {
    let workspace_hooks = workspace.join(".arashi/hooks");
    if workspace_hooks.try_exists()? {
        for entry in fs::read_dir(&workspace_hooks)? {
            let name = entry?.file_name().to_string_lossy().into_owned();
            if ["pre-create", "post-create", "pre-remove", "post-remove"]
                .iter()
                .any(|phase| name.starts_with(&format!("{phase}.{repository}.")))
            {
                return Err(unsupported(
                    "Delete of workspace-owned repository hooks is not yet ported; no changes made",
                ));
            }
        }
    }
    let local_hooks = target.join(".arashi/hooks");
    if local_hooks.try_exists()? {
        return Err(unsupported(
            "Delete of compatible child-local hooks is not yet ported; no changes made",
        ));
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
        && PathBuf::from(home).join(".arashi/hooks").try_exists()?
    {
        return Err(unsupported(
            "Delete with global hook policy is not yet ported; no changes made",
        ));
    }
    Ok(())
}

fn no_unsafe_git_configuration(target: &Path) -> Result<()> {
    let config = git::run_readonly(target, &["config", "--null", "--list"])?;
    for entry in config.split('\0') {
        let key = entry.split('\n').next().unwrap_or("").to_ascii_lowercase();
        if key == "core.fsmonitor"
            || key == "core.worktree"
            || key == "extensions.worktreeconfig"
            || key.starts_with("filter.") && (key.ends_with(".clean") || key.ends_with(".process"))
        {
            return Err(unsupported(
                "Delete cannot safely inspect this Git configuration; no changes made",
            ));
        }
    }
    Ok(())
}

fn no_nested_git(path: &Path, root: bool) -> Result<()> {
    let mut entries = fs::read_dir(path)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let file_type = entry.file_type()?;
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        if entry.file_name() == ".git" {
            if root {
                continue;
            }
            return Err(unsupported(
                "Nested Git repository in delete target; no changes made",
            ));
        }
        no_nested_git(&entry.path(), false)?;
    }
    Ok(())
}

fn ref_inventory(target: &Path) -> Result<Vec<LocalRef>> {
    let output = git::run_readonly(
        target,
        &[
            "for-each-ref",
            "--format=%(refname)%09%(objectname)%09%(objecttype)",
            "refs",
        ],
    )?;
    let mut all = Vec::new();
    for line in output.lines() {
        let mut fields = line.split('\t');
        let name = fields.next().unwrap_or("");
        let oid = fields.next().unwrap_or("");
        let kind = fields.next().unwrap_or("");
        if name.is_empty()
            || oid.is_empty()
            || kind != "commit"
            || !(name.starts_with("refs/heads/") || name.starts_with("refs/remotes/origin/"))
        {
            return Err(unsupported(
                "Tags, symbolic, custom, or non-commit delete refs are not yet ported; no changes made",
            ));
        }
        all.push(LocalRef {
            name: name.to_owned(),
            oid: oid.to_owned(),
        });
    }
    Ok(all)
}

fn deletable_local_refs(all: &[LocalRef]) -> Result<Vec<LocalRef>> {
    let locals = all
        .iter()
        .filter(|reference| reference.name.starts_with("refs/heads/"))
        .cloned()
        .collect::<Vec<_>>();
    for local in &locals {
        let branch = local.name.strip_prefix("refs/heads/").unwrap();
        let remote = format!("refs/remotes/origin/{branch}");
        if !all
            .iter()
            .any(|candidate| candidate.name == remote && candidate.oid == local.oid)
        {
            return Err(unsupported(
                "Delete of local-only Git history is not yet ported; no changes made",
            ));
        }
    }
    Ok(locals)
}

fn matching_origin(target: &Path, repo: &RepoConfig) -> Result<()> {
    let configured = repo
        .raw
        .get("gitUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| unsupported("Delete requires an explicit configured gitUrl"))?;
    let configured = Path::new(configured);
    if !configured.is_absolute() || !configured.exists() {
        return Err(unsupported(
            "Delete currently requires an existing absolute filesystem origin",
        ));
    }
    let remotes = git::run_readonly(target, &["remote"])?;
    if remotes.lines().collect::<Vec<_>>() != ["origin"] {
        return Err(unsupported(
            "Delete with non-origin or multiple remotes is not yet ported; no changes made",
        ));
    }
    let urls = git::run_readonly(target, &["remote", "get-url", "--all", "origin"])?;
    let configured = fs::canonicalize(configured)?;
    let matches = urls.lines().any(|url| {
        let path = Path::new(url);
        path.is_absolute() && fs::canonicalize(path).is_ok_and(|candidate| candidate == configured)
    });
    if !matches {
        return Err(closed(
            "DELETE_TOPOLOGY_INVALID",
            "Configured repository URL does not match the clone origin",
            1,
        ));
    }
    Ok(())
}

impl DeletePlan {
    fn build(workspace: &Workspace, repository: &str) -> Result<Self> {
        let config = workspace.config.as_ref().ok_or_else(|| {
            closed(
                "CONFIGURED_WORKSPACE_REQUIRED",
                "Delete requires a configured workspace",
                1,
            )
        })?;
        let repo = config.repos.get(repository).ok_or_else(|| {
            closed(
                "DELETE_REPOSITORY_NOT_FOUND",
                "The exact configured repository key was not found",
                1,
            )
        })?;
        unsupported_selected_policy(repo)?;
        let repos_base = workspace.root.join(relative(&config.repos_dir)?);
        let configured_relative = relative(&repo.path)?;
        let target = workspace.root.join(configured_relative);
        no_symlink_below(&workspace.root, &repos_base)?;
        no_symlink_below(&workspace.root, &target)?;
        let expected_parent = fs::canonicalize(&repos_base)?;
        let target_parent =
            fs::canonicalize(target.parent().ok_or_else(|| {
                closed("DELETE_PATH_UNSAFE", "Deletion target has no parent", 1)
            })?)?;
        if target_parent != expected_parent {
            return Err(unsupported(
                "Delete currently requires a direct child of reposDir; no changes made",
            ));
        }
        let metadata = fs::symlink_metadata(&target)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(closed(
                "DELETE_PATH_UNSAFE",
                "Deletion target is not a plain directory",
                1,
            ));
        }
        let canonical_target = fs::canonicalize(&target)?;
        if !canonical_target.starts_with(fs::canonicalize(&workspace.root)?) {
            return Err(closed(
                "DELETE_PATH_UNSAFE",
                "Deletion target escapes the workspace",
                1,
            ));
        }
        for (other_key, other_repo) in &config.repos {
            if other_key == repository {
                continue;
            }
            let other = workspace.root.join(relative(&other_repo.path)?);
            let aliases_target = other == target
                || target.starts_with(&other)
                || other.starts_with(&target)
                || other.try_exists()?
                    && crate::paths::same_existing(&other, &target).unwrap_or(false);
            if aliases_target {
                return Err(closed(
                    "DELETE_TOPOLOGY_INVALID",
                    "Another configured repository key shares the selected deletion topology",
                    1,
                ));
            }
        }
        no_delete_hooks(&workspace.root, repository, &target)?;
        no_unsafe_git_configuration(&target)?;
        let git_marker = fs::symlink_metadata(target.join(".git"))?;
        if !git_marker.is_dir() || git_marker.file_type().is_symlink() {
            return Err(unsupported(
                "Delete currently requires a canonical non-bare clone; no changes made",
            ));
        }
        let records = git::worktrees_readonly(&target)?;
        if records.len() != 1
            || records[0].bare
            || records[0].locked
            || records[0].prune_reason.is_some()
            || !crate::paths::same_existing(&records[0].path, &target)?
        {
            return Err(unsupported(
                "Delete with linked, locked, stale, or non-primary worktrees is not yet ported; no changes made",
            ));
        }
        let gitlinks = git::run_readonly(&target, &["ls-files", "--stage"])?;
        if gitlinks.lines().any(|line| line.starts_with("160000 ")) {
            return Err(unsupported(
                "Delete with indexed gitlinks is not yet ported; no changes made",
            ));
        }
        no_nested_git(&target, true)?;
        matching_origin(&target, repo)?;
        let ref_inventory = ref_inventory(&target)?;
        let refs = deletable_local_refs(&ref_inventory)?;
        let dirty = git::run_readonly(
            &target,
            &[
                "-c",
                "core.fsmonitor=false",
                "status",
                "--porcelain",
                "--ignored=matching",
                "--untracked-files=all",
            ],
        )?;
        if !dirty.is_empty() {
            return Err(unsupported(
                "Delete of dirty repository contents is not yet ported; no changes made",
            ));
        }
        let config_path = workspace.root.join(".arashi/config.json");
        no_symlink_below(&workspace.root, &config_path)?;
        let config_before = fs::read(&config_path)?;
        let mut persisted: Value = serde_json::from_slice(&config_before).map_err(|_| {
            closed(
                "DELETE_CONFIG_INVALID",
                "Configured workspace bytes are invalid",
                1,
            )
        })?;
        let map_key = ["repos", "discoveredRepos", "discovered_repos"]
            .into_iter()
            .find(|key| persisted.get(*key).and_then(Value::as_object).is_some())
            .ok_or_else(|| closed("DELETE_CONFIG_INVALID", "Repository map is unavailable", 1))?;
        let removed = persisted[map_key]
            .as_object_mut()
            .and_then(|repos| repos.remove(repository));
        if removed.is_none() {
            return Err(closed(
                "DELETE_REPOSITORY_NOT_FOUND",
                "The exact persisted repository key was not found",
                1,
            ));
        }
        let mut config_after = serde_json::to_vec_pretty(&persisted)?;
        config_after.push(b'\n');
        Ok(Self {
            workspace_root: workspace.root.clone(),
            repository_key: repository.to_owned(),
            repository_identity: ObjectIdentity::path(&target)?,
            repository_path: target,
            config_identity: ObjectIdentity::path(&config_path)?,
            config_path,
            config_before,
            config_after,
            config_entry_ref: format!("{map_key}.{repository}"),
            local_refs: refs,
            ref_inventory,
        })
    }

    fn plan_json(&self) -> Value {
        let mut items = vec![json!({
            "id": format!("canonical-clone:{}", self.repository_path.display()),
            "kind": "canonical-clone",
            "ownership": "delete",
            "path": self.repository_path,
            "ref": Value::Null,
            "oid": Value::Null,
            "planned": true,
            "completed": false,
            "state": "planned",
            "reasonCode": Value::Null,
            "message": Value::Null
        })];
        items.extend(self.local_refs.iter().map(|reference| {
            json!({
                "id": format!("local-ref:{}:{}", reference.name, reference.oid),
                "kind": "local-ref",
                "ownership": "delete",
                "path": self.repository_path,
                "ref": reference.name,
                "oid": reference.oid,
                "planned": true,
                "completed": false,
                "state": "planned",
                "reasonCode": Value::Null,
                "message": Value::Null
            })
        }));
        items.push(json!({
            "id": format!("config-entry:{}", self.config_entry_ref),
            "kind": "config-entry",
            "ownership": "delete",
            "path": self.config_path,
            "ref": self.config_entry_ref,
            "oid": Value::Null,
            "planned": true,
            "completed": false,
            "state": "planned",
            "reasonCode": Value::Null,
            "message": Value::Null
        }));
        json!({"id":format!("delete:{}",self.repository_key),"items":items,"warnings":[]})
    }

    fn validate(&self) -> Result<()> {
        let current = Workspace::discover(&self.workspace_root)?;
        let rebuilt = Self::build(&current, &self.repository_key)?;
        if rebuilt != *self {
            return Err(closed(
                "DELETE_CONCURRENT_CHANGE",
                "Delete preconditions changed; no changes made",
                1,
            ));
        }
        Ok(())
    }

    #[cfg(unix)]
    fn validate_quarantine(&self, quarantine: &Path, expected_config: &[u8]) -> Result<()> {
        if !self.repository_identity.matches(quarantine)
            || fs::symlink_metadata(&self.repository_path).is_ok()
            || fs::read(&self.config_path)? != expected_config
            || ref_inventory(quarantine)? != self.ref_inventory
        {
            return Err(closed(
                "DELETE_CONCURRENT_CHANGE",
                "Quarantined repository or configuration changed during delete",
                1,
            ));
        }
        no_unsafe_git_configuration(quarantine)?;
        no_nested_git(quarantine, true)?;
        let dirty = git::run_readonly(
            quarantine,
            &[
                "-c",
                "core.fsmonitor=false",
                "status",
                "--porcelain",
                "--ignored=matching",
                "--untracked-files=all",
            ],
        )?;
        if !dirty.is_empty() {
            return Err(closed(
                "DELETE_CONCURRENT_CHANGE",
                "Quarantined repository contents changed during delete",
                1,
            ));
        }
        Ok(())
    }

    #[cfg(unix)]
    fn execute(&self) -> Result<Value> {
        self.validate()?;
        let quarantine = self
            .repository_path
            .parent()
            .unwrap()
            .join(quarantine_name(&self.repository_key));
        if fs::symlink_metadata(&quarantine).is_ok() {
            return Err(closed(
                "DELETE_CONCURRENT_CHANGE",
                "Private delete quarantine is occupied; no changes made",
                1,
            ));
        }
        fs::rename(&self.repository_path, &quarantine)?;
        let restore_quarantine = |quarantine: &Path| {
            fs::symlink_metadata(&self.repository_path).is_err()
                && self.repository_identity.matches(quarantine)
                && fs::rename(quarantine, &self.repository_path).is_ok()
        };
        if let Err(error) = self.validate_quarantine(&quarantine, &self.config_before) {
            if !restore_quarantine(&quarantine) {
                return Err(closed(
                    "DELETE_PARTIAL_FAILURE",
                    format!(
                        "Delete pre-publication validation failed and quarantine could not be restored: {error}"
                    ),
                    1,
                ));
            }
            return Err(error);
        }
        if let Err(error) = publish_config(self) {
            if !restore_quarantine(&quarantine) {
                return Err(closed(
                    "DELETE_PARTIAL_FAILURE",
                    format!(
                        "Configuration publication failed and quarantine could not be restored: {error}"
                    ),
                    1,
                ));
            }
            return Err(error);
        }
        if let Err(error) = self.validate_quarantine(&quarantine, &self.config_after) {
            return Err(closed(
                "DELETE_PARTIAL_FAILURE",
                format!(
                    "Configuration was updated but quarantine validation failed; repository preserved at {}: {error}",
                    quarantine.display()
                ),
                1,
            ));
        }
        fs::remove_dir_all(&quarantine).map_err(|error| {
            closed(
                "DELETE_PARTIAL_FAILURE",
                format!(
                    "Configuration was updated but repository cleanup is incomplete at {}: {error}",
                    quarantine.display()
                ),
                1,
            )
        })?;
        let plan = self.plan_json();
        let items = plan["items"]
            .as_array()
            .unwrap()
            .iter()
            .cloned()
            .map(|mut item| {
                item["completed"] = json!(true);
                item["state"] = json!("completed");
                item
            })
            .collect::<Vec<_>>();
        let phases = [
            "provenance",
            "worktrees",
            "metadata",
            "canonical-clone",
            "workspace-hooks",
            "configuration",
            "verification",
        ]
        .into_iter()
        .enumerate()
        .map(|(order, name)| {
            let kinds: &[&str] = match name {
                "provenance" => &["resume-receipt"],
                "worktrees" => &["linked-worktree"],
                "metadata" => &["worktree-metadata"],
                "canonical-clone" => &["canonical-clone", "local-ref"],
                "workspace-hooks" => &["workspace-hook"],
                "configuration" => &["config-entry"],
                "verification" => &["preserved-global-hook"],
                _ => unreachable!(),
            };
            let item_ids = items
                .iter()
                .filter(|item| {
                    item["kind"]
                        .as_str()
                        .is_some_and(|kind| kinds.contains(&kind))
                })
                .map(|item| item["id"].clone())
                .collect::<Vec<_>>();
            json!({
                "name": name,
                "state": "completed",
                "itemIds": item_ids,
                "error": Value::Null,
                "startedOrder": order + 1,
                "completedOrder": order + 1
            })
        })
        .collect::<Vec<_>>();
        Ok(json!({
            "items": items,
            "phases": phases,
            "retry": {"safe":false,"argv":Value::Null,"guidance":"Deletion completed."},
            "warnings": []
        }))
    }

    #[cfg(windows)]
    fn execute(&self) -> Result<Value> {
        Err(unsupported(
            "Native configured delete mutation is not yet supported on Windows; no changes made",
        ))
    }
}

#[cfg(unix)]
fn publish_config(plan: &DeletePlan) -> Result<()> {
    if fs::read(&plan.config_path)? != plan.config_before
        || !plan.config_identity.matches(&plan.config_path)
    {
        return Err(closed(
            "DELETE_CONCURRENT_CHANGE",
            "Configuration changed before publication",
            1,
        ));
    }
    let temp = plan.config_path.with_file_name(format!(
        ".config.json.arashi-delete-{}.tmp",
        std::process::id()
    ));
    if fs::symlink_metadata(&temp).is_ok() {
        return Err(closed(
            "DELETE_CONCURRENT_CHANGE",
            "Private configuration publication path is occupied",
            1,
        ));
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    let temp_identity = ObjectIdentity::metadata(&file.metadata()?);
    let operation = (|| -> Result<()> {
        file.write_all(&plan.config_after)?;
        file.sync_all()?;
        fs::set_permissions(&temp, fs::metadata(&plan.config_path)?.permissions())?;
        if fs::read(&plan.config_path)? != plan.config_before
            || !plan.config_identity.matches(&plan.config_path)
            || !temp_identity.matches(&temp)
        {
            return Err(closed(
                "DELETE_CONCURRENT_CHANGE",
                "Configuration changed during publication",
                1,
            ));
        }
        fs::rename(&temp, &plan.config_path)?;
        Ok(())
    })();
    drop(file);
    if operation.is_err() && temp_identity.matches(&temp) {
        let _ = fs::remove_file(&temp);
    }
    operation
}

pub fn delete(workspace: &Workspace, args: &Args) -> Result<Value> {
    args.only(&["force", "dry-run"])?;
    if !args.has("json") {
        return Err(unsupported(
            "Interactive and human configured delete are not yet ported; use --json with an exact target",
        ));
    }
    if args.positional.is_empty() {
        return Err(closed(
            "DELETE_SELECTION_REQUIRED",
            "JSON delete requires one exact configured repository key",
            2,
        ));
    }
    if args.positional.len() != 1 {
        return Err(Error::new("USAGE", "delete accepts exactly one repository"));
    }
    let plan = DeletePlan::build(workspace, &args.positional[0])?;
    let plan_json = plan.plan_json();
    let mut data = workspace.metadata();
    let confirmation = if !args.has("dry-run") && !args.has("force") {
        "required"
    } else {
        "not-required"
    };
    data = json!({
        "workspace": data,
        "repositoryKey": plan.repository_key,
        "dryRun": args.has("dry-run"),
        "force": args.has("force"),
        "confirmation": confirmation,
        "plan": plan_json,
        "result": Value::Null
    });
    if args.has("dry-run") {
        plan.validate()?;
        return Ok(data);
    }
    if !args.has("force") {
        return Err(closed(
            "DELETE_CONFIRMATION_REQUIRED",
            "Non-interactive delete requires explicit --force",
            2,
        )
        .with_details(data));
    }
    data["result"] = plan.execute()?;
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::quarantine_name;
    use std::path::{Component, Path};

    #[test]
    fn quarantine_name_cannot_inherit_path_components_from_repository_key() {
        let name = quarantine_name("api/../../outside\\also");
        assert_eq!(Path::new(&name).components().count(), 1);
        assert!(matches!(
            Path::new(&name).components().next(),
            Some(Component::Normal(_))
        ));
        assert!(!name.contains("../"));
        assert!(!name.contains('\\'));
    }
}
