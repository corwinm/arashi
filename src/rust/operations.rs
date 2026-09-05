//! Immutable plans are validated before execution. Unsupported coordination fails closed.
use crate::{Error, Result, config::Workspace, git};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Instant,
};
fn unsupported(message: &str) -> Error {
    Error::new("RUST_NOT_YET_PORTED", message)
}
fn standalone(w: &Workspace) -> Result<()> {
    if w.config.is_some() {
        return Err(unsupported(
            "Configured create/remove coordination is not yet ported; no changes made",
        ));
    }
    Ok(())
}
fn safe_ancestors(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(unsupported(
                    "Symlinked mutation destination is unsupported; no changes made",
                ));
            }
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
fn no_global_hooks() -> Result<()> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| unsupported("Cannot determine global hook directory; no changes made"))?;
    let path = PathBuf::from(home).join(".arashi/hooks");
    match fs::symlink_metadata(&path) {
        Ok(_) => {
            return Err(unsupported(
                "Global hook directory exists; hook execution is not yet ported (create can explicitly use --no-hooks)",
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.into()),
    }
    Ok(())
}
fn missing_hooks(w: &Workspace, target: &Path, lifecycles: &[&str]) -> Value {
    let name = w.root.file_name().unwrap_or_default().to_string_lossy();
    let mut values = vec![];
    for lifecycle in lifecycles {
        for scope in ["global-repository", "global-shared"] {
            values.push(json!({"executionPath":w.root,"hookName":lifecycle,"hookStatus":"skipped","message":"Hook script not found","reasonCode":"not_found","repositoryId":name,"scope":scope,"sourceKind":"file","sourceOwnerKind":"user-global","sourceOwnerName":null,"sourceScriptPath":null,"targetRepositoryName":name,"targetRepositoryPath":w.root,"targetWorktreePath":target,"workspaceMode":"standalone"}));
        }
    }
    Value::Array(values)
}
pub fn ignore_evidence(root: &Path, destination: &Path) -> Result<Value> {
    let output = git::run(
        root,
        &[
            "check-ignore",
            "--no-index",
            "--verbose",
            destination
                .to_str()
                .ok_or_else(|| unsupported("Non-UTF8 paths are unsupported"))?,
        ],
    );
    if let Ok(output) = output
        && let Some((metadata, _)) = output.trim_end().split_once('\t')
    {
        let parts: Vec<_> = metadata.rsplitn(3, ':').collect();
        if parts.len() == 3 {
            return Ok(
                json!({"ignored":!parts[0].starts_with('!'),"source":parts[2],"line":parts[1].parse::<u64>().unwrap_or(0),"pattern":parts[0]}),
            );
        }
    }
    Ok(json!({"ignored":false,"source":null,"pattern":null}))
}
pub struct CreatePlan {
    source_oid: String,
    source_ref: String,
    root: PathBuf,
    branch: String,
    destination: PathBuf,
    source: Option<String>,
    existing: bool,
    ignore: Value,
    skip_hooks: bool,
}
impl CreatePlan {
    pub fn build(w: &Workspace, branch: &str, skip_hooks: bool) -> Result<Self> {
        standalone(w)?;
        git::run(&w.root, &["check-ref-format", "--branch", branch])?;
        // Avoid Git's branch shorthand expansion and all path traversal.
        if branch.starts_with('-')
            || branch.contains('@')
            || branch
                .split('/')
                .any(|s| s == ".." || s == "." || s.is_empty())
        {
            return Err(Error::new("INVALID_BRANCH", "Unsafe branch name"));
        }
        let destination = w.root.join(".worktrees").join(branch);
        safe_ancestors(&destination)?;
        if fs::symlink_metadata(&destination).is_ok() {
            return Err(Error::new(
                "DESTINATION_EXISTS",
                "Worktree destination already exists",
            ));
        }
        let records = git::worktrees(&w.root)?;
        if records.iter().any(|tree| tree.path == destination) {
            return Err(Error::new(
                "DESTINATION_REGISTERED",
                "Worktree destination is already registered, including stale metadata; no changes made",
            ));
        }
        let ignore = ignore_evidence(&w.root, &destination)?;
        if ignore["ignored"] != true {
            return Err(Error::new(
                "STANDALONE_DESTINATION_NOT_IGNORED",
                format!("Standalone worktree destination is not ignored: {}. Run \"arashi init --zero-config\" or add .worktrees/ to the repository-local exclude file.",destination.display()),
            ).with_details(json!({"destination":destination,"effectiveIgnore":{"ignored":false,"pattern":null,"source":null},"mode":"standalone","mutation":{"branch":false,"config":false,"ignore":false,"worktree":false},"repairCommands":["arashi init --zero-config",r#"printf '.worktrees/\n' >> "$(git rev-parse --git-path info/exclude)""#]})));
        }
        let existing = git::run(
            &w.root,
            &["show-ref", "--verify", &format!("refs/heads/{branch}")],
        )
        .is_ok();
        if records.iter().any(|t| t.branch.as_deref() == Some(branch)) {
            return Err(Error::new("BRANCH_IN_USE", "Branch is already checked out"));
        }
        let source = if existing {
            Some(branch.to_string())
        } else {
            let refs = git::run(
                &w.root,
                &[
                    "for-each-ref",
                    "--format=%(refname)",
                    &format!("refs/remotes/*/{branch}"),
                ],
            )?;
            let refs: Vec<_> = refs
                .lines()
                .filter_map(|r| r.strip_prefix("refs/remotes/"))
                .collect();
            refs.iter()
                .find(|r| **r == format!("origin/{branch}"))
                .or(refs.first())
                .map(|s| s.to_string())
        };
        let source_ref = if existing {
            format!("refs/heads/{branch}")
        } else if let Some(remote) = &source {
            format!("refs/remotes/{remote}")
        } else {
            "HEAD".to_owned()
        };
        let source_oid = git::run(
            &w.root,
            &["rev-parse", "--verify", &format!("{source_ref}^{{commit}}")],
        )?
        .trim()
        .to_owned();
        if !skip_hooks {
            no_global_hooks()?;
        }
        Ok(Self {
            source_oid,
            source_ref,
            root: w.root.clone(),
            branch: branch.into(),
            destination,
            source,
            existing,
            ignore,
            skip_hooks,
        })
    }
    pub fn execute(self, w: &Workspace, dry_run: bool) -> Result<Value> {
        let mut hooks = json!([]);
        if !dry_run {
            // Revalidate the mutable preconditions immediately before calling Git.
            let current_workspace = Workspace::discover(&self.root)?;
            let current = Self::build(&current_workspace, &self.branch, self.skip_hooks)?;
            if current.source_oid != self.source_oid
                || current.existing != self.existing
                || current.source != self.source
                || current.destination != self.destination
            {
                return Err(Error::new(
                    "PLAN_CHANGED",
                    "Create preconditions changed; no changes made",
                ));
            }
            let destination = self.destination.to_str().unwrap();
            let mut args = vec!["worktree", "add"];
            if !self.existing {
                args.extend(["-b", self.branch.as_str()]);
            }
            args.push(destination);
            if self.existing {
                // Git needs the short local name to attach HEAD to the branch.
                args.push(&self.branch);
            } else if self.source.is_some() {
                args.push(&self.source_ref);
            }
            if let Err(error) = git::run(&self.root, &args) {
                let rollback_errors = self.rollback_created();
                return Err(error.with_details(json!({"rollbackErrors": rollback_errors})));
            }
            if !self.skip_hooks {
                hooks = missing_hooks(w, &self.destination, &["pre-create", "post-create"]);
            }
        }
        let mut data = w.metadata();
        let fields = json!({"branchName":self.branch,"branchSource":self.source,"dryRun":dry_run,"mode":"standalone","repositoryPath":self.root,"reusedRemoteBranch":!self.existing&&self.source.is_some(),"workspaceRoot":self.root,"worktreePath":self.destination,"effectiveIgnore":self.ignore,"hookOutcomes":hooks});
        data.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        Ok(data)
    }

    fn rollback_created(&self) -> Vec<String> {
        let records = match git::worktrees(&self.root) {
            Ok(records) => records,
            Err(error) => {
                return vec![format!("Cannot inspect partial worktree creation: {error}")];
            }
        };
        if let Some(tree) = records.iter().find(|tree| tree.path == self.destination) {
            if tree.head != self.source_oid
                || tree.branch.as_deref() != Some(&self.branch)
                || tree.locked
            {
                return vec![format!(
                    "Worktree ownership changed; preserved {}",
                    self.destination.display()
                )];
            }
            // No --force: newly written content must survive an uncertain rollback.
            if let Err(error) = git::run(
                &self.root,
                &["worktree", "remove", self.destination.to_str().unwrap()],
            ) {
                return vec![format!(
                    "Partial worktree preserved at {}: {error}",
                    self.destination.display()
                )];
            }
        }
        if !self.existing {
            let reference = format!("refs/heads/{}", self.branch);
            if let Ok(oid) = git::run(&self.root, &["rev-parse", "--verify", &reference]) {
                if oid.trim() != self.source_oid {
                    return vec![format!(
                        "Branch ownership changed; preserved {}",
                        self.branch
                    )];
                }
                if let Err(error) = git::run(&self.root, &["branch", "-D", &self.branch]) {
                    return vec![format!("Partial branch preserved: {error}")];
                }
            }
        }
        Vec::new()
    }
}
fn no_nested_repositories(path: &Path) -> Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            if entry.file_name() == ".git" {
                continue;
            }
            let nested_bare = entry.path().join("HEAD").is_file()
                && entry.path().join("objects").is_dir()
                && git::run(&entry.path(), &["rev-parse", "--is-bare-repository"])
                    .is_ok_and(|s| s.trim() == "true");
            if nested_bare || fs::symlink_metadata(entry.path().join(".git")).is_ok() {
                return Err(unsupported(
                    "Nested Git repository in removal target; coordinated removal is not yet ported",
                ));
            }
            no_nested_repositories(&entry.path())?;
        }
    }
    Ok(())
}
pub struct RemovePlan {
    root: PathBuf,
    target: git::Worktree,
    keep_branch: bool,
    force: bool,
}
impl RemovePlan {
    pub fn build(
        w: &Workspace,
        target: &str,
        path_mode: bool,
        keep_branch: bool,
        force: bool,
    ) -> Result<Self> {
        standalone(w)?;
        no_global_hooks()?;
        let target_path = if path_mode {
            Some(crate::paths::canonicalize(target)?)
        } else {
            None
        };
        let target = git::worktrees(&w.root)?
            .into_iter()
            .find(|t| {
                if let Some(p) = &target_path {
                    &t.path == p
                } else {
                    t.branch.as_deref() == Some(target)
                }
            })
            .ok_or_else(|| Error::new("BRANCH_NOT_FOUND", "Standalone worktree not found"))?;
        if target.path == w.root {
            return Err(Error::new(
                "PROTECTED_WORKTREE",
                "Cannot remove the main worktree",
            ));
        }
        if target.locked {
            return Err(Error::new(
                "LOCKED_WORKTREE",
                "Cannot remove a locked worktree",
            ));
        }
        if target.prune_reason.is_some() {
            return Err(Error::new(
                "STALE_WORKTREE",
                "Stale worktree metadata; run arashi prune",
            ));
        }
        safe_ancestors(&target.path)?;
        let current = crate::paths::canonicalize(std::env::current_dir()?)?;
        if current.starts_with(&target.path) {
            return Err(unsupported(
                "Removing the caller worktree is not yet ported",
            ));
        }
        if !target.path.is_dir() {
            return Err(Error::new(
                "STALE_WORKTREE",
                "Worktree is missing; run arashi prune",
            ));
        }
        no_nested_repositories(&target.path)?;
        let dirty = git::run(
            &target.path,
            &["status", "--porcelain", "--untracked-files=all"],
        )?;
        if !force && !dirty.is_empty() {
            return Err(Error::new(
                "DIRTY_WORKTREE",
                "Uncommitted changes; explicit --force required",
            ));
        }
        Ok(Self {
            root: w.root.clone(),
            target,
            keep_branch,
            force,
        })
    }
    pub fn execute(self, w: &Workspace, dry_run: bool) -> Result<Value> {
        let start = Instant::now();
        let name = self.root.file_name().unwrap_or_default().to_string_lossy();
        let branch = self.target.branch.clone().unwrap_or_default();
        let remove_branch = !self.keep_branch && self.target.branch.is_some();
        if dry_run {
            return Err(unsupported(
                "Remove dry-run hook previews are not yet ported; no changes made",
            ));
        }
        if !self.force {
            return Err(unsupported(
                "Interactive removal confirmation is not yet ported; use --force",
            ));
        }
        let current_workspace = Workspace::discover(&self.root)?;
        let current = Self::build(
            &current_workspace,
            self.target.path.to_str().unwrap(),
            true,
            self.keep_branch,
            self.force,
        )?;
        if current.target.branch != self.target.branch || current.target.head != self.target.head {
            return Err(Error::new(
                "PLAN_CHANGED",
                "Removal target changed since planning; no changes made",
            ));
        }
        let mut args = vec!["worktree", "remove"];
        if self.force {
            args.push("--force");
        }
        args.push(self.target.path.to_str().unwrap());
        git::run(&self.root, &args)?;
        let mut operations = vec![
            json!({"branchName":branch,"repository":name,"status":"success","type":"worktree_remove","worktreePath":self.target.path}),
        ];
        if remove_branch {
            if let Err(e) = git::run(&self.root, &["branch", "-D", &branch]) {
                return Err(Error::new("STANDALONE_REMOVE_PARTIAL_FAILURE",e.message).with_details(json!({"finalState":{"branchExists":true,"worktreeExists":false},"operations":operations})));
            }
            operations.push(json!({"branchName":branch,"repository":name,"status":"success","type":"branch_delete"}));
        }
        let mut data = w.metadata();
        data.as_object_mut().unwrap().extend(json!({"repositoryPath":self.root,"dryRun":false,"errors":[],"hookOutcomes":missing_hooks(w,&self.target.path,&["pre-remove","post-remove"]),"operations":operations,"success":true,"summary":{"duration":start.elapsed().as_millis(),"successfulBranches":u8::from(remove_branch),"successfulWorktrees":1,"totalBranches":u8::from(remove_branch),"totalWorktrees":1}}).as_object().unwrap().clone());
        Ok(data)
    }
}
