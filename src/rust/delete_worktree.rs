//! Reciprocal attached-worktree ownership and immutable loss evidence.
use super::*;

fn stale(message: &str) -> Error {
    closed("DELETE_CONCURRENT_CHANGE", message, 1)
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct LinkedCheckout {
    pub path: PathBuf,
    pub identity: ObjectIdentity,
    pub ancestors: Vec<(PathBuf, ObjectIdentity)>,
    pub marker: Vec<u8>,
    pub marker_identity: ObjectIdentity,
    pub admin: PathBuf,
    pub admin_identity: ObjectIdentity,
    pub metadata: Vec<(PathBuf, ContentIdentity, Vec<u8>)>,
    pub contents: Vec<(PathBuf, ContentIdentity, Vec<u8>)>,
    pub dirty: String,
    pub head: String,
    pub branch: String,
}

impl LinkedCheckout {
    fn validate_moved_inventory(&self, moved: &Path) -> Result<()> {
        if content_inventory(moved)? != self.contents {
            return Err(closed(
                "DELETE_CONCURRENT_CHANGE",
                "Quarantined linked checkout contents changed",
                1,
            ));
        }
        if !self.identity.matches(moved)
            || !self.marker_identity.matches(&moved.join(".git"))
            || fs::read(moved.join(".git"))? != self.marker
        {
            return Err(closed(
                "DELETE_CONCURRENT_CHANGE",
                "Quarantined linked checkout identity changed",
                1,
            ));
        }
        Ok(())
    }

    pub fn validate_quarantine_before_repair(&self, moved: &Path) -> Result<()> {
        self.validate_moved_inventory(moved)?;
        if !self.admin_identity.matches(&self.admin)
            || content_inventory(&self.admin)? != self.metadata
        {
            return Err(closed(
                "DELETE_CONCURRENT_CHANGE",
                "Linked checkout administration changed before repair",
                1,
            ));
        }
        Ok(())
    }

    pub fn validate_quarantine_after_repair(&self, target: &Path, moved: &Path) -> Result<()> {
        self.validate_moved_inventory(moved)?;
        if !self.admin_identity.matches(&self.admin) {
            return Err(closed(
                "DELETE_CONCURRENT_CHANGE",
                "Linked checkout administration identity changed during repair",
                1,
            ));
        }
        let actual = content_inventory(&self.admin)?;
        if actual.len() != self.metadata.len() {
            return Err(closed(
                "DELETE_CONCURRENT_CHANGE",
                "Linked checkout administration changed during repair",
                1,
            ));
        }
        for expected in &self.metadata {
            let current = actual
                .iter()
                .find(|entry| entry.0 == expected.0)
                .ok_or_else(|| stale("Linked checkout administration entry disappeared"))?;
            if expected.0 == Path::new("gitdir") {
                if fs::canonicalize(
                    self.admin.join(
                        std::str::from_utf8(&current.2)
                            .map_err(|_| stale("Invalid repaired linked gitdir"))?
                            .trim(),
                    ),
                )? != fs::canonicalize(moved.join(".git"))?
                {
                    return Err(stale("Repaired linked gitdir is not reciprocal"));
                }
            } else if current != expected {
                return Err(closed(
                    "DELETE_CONCURRENT_CHANGE",
                    "Linked checkout administration changed during repair",
                    1,
                ));
            }
        }
        let record = git::worktrees_readonly(target)?
            .into_iter()
            .find(|record| record.path == moved)
            .ok_or_else(|| stale("Repaired linked registration is missing"))?;
        if record.head != self.head || record.branch.as_deref() != Some(self.branch.as_str()) {
            return Err(stale("Repaired linked registration changed identity"));
        }
        Ok(())
    }

    pub fn inspect(target: &Path, record: &git::Worktree) -> Result<Self> {
        if record.bare || record.locked || record.prune_reason.is_some() || record.branch.is_none()
        {
            return Err(unsupported(
                "Detached, locked or stale linked delete ownership is not supported; no changes made",
            ));
        }
        let path = fs::canonicalize(&record.path)?;
        let ancestors = ancestor_identities(&record.path)?;
        let metadata = fs::symlink_metadata(&record.path)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(closed(
                "DELETE_TOPOLOGY_INVALID",
                "Linked checkout is not a plain directory",
                1,
            ));
        }
        let marker_path = path.join(".git");
        let marker_metadata = fs::symlink_metadata(&marker_path)?;
        if !marker_metadata.is_file() || marker_metadata.file_type().is_symlink() {
            return Err(closed(
                "DELETE_TOPOLOGY_INVALID",
                "Linked checkout marker is not a plain file",
                1,
            ));
        }
        let marker = fs::read(&marker_path)?;
        let text = std::str::from_utf8(&marker)
            .map_err(|_| closed("DELETE_TOPOLOGY_INVALID", "Invalid linked marker", 1))?;
        let admin_text = text
            .trim()
            .strip_prefix("gitdir: ")
            .ok_or_else(|| closed("DELETE_TOPOLOGY_INVALID", "Invalid linked marker", 1))?;
        let admin = fs::canonicalize(path.join(admin_text))?;
        let expected_admin_parent = fs::canonicalize(target.join(".git/worktrees"))?;
        if admin.parent() != Some(expected_admin_parent.as_path()) {
            return Err(closed(
                "DELETE_TOPOLOGY_INVALID",
                "Linked metadata belongs to another repository",
                1,
            ));
        }
        no_symlink_below(&target.join(".git"), &admin)?;
        let back = fs::read_to_string(admin.join("gitdir"))?;
        if fs::canonicalize(admin.join(back.trim()))? != marker_path
            || fs::canonicalize(admin.join(fs::read_to_string(admin.join("commondir"))?.trim()))?
                != fs::canonicalize(target.join(".git"))?
        {
            return Err(closed(
                "DELETE_TOPOLOGY_INVALID",
                "Linked metadata is not reciprocal",
                1,
            ));
        }
        no_unsafe_git_configuration(&path)?;
        if git::run_readonly(&path, &["ls-files", "--stage"])?
            .lines()
            .any(|line| line.starts_with("160000 "))
        {
            return Err(unsupported(
                "Delete with indexed gitlinks is not yet ported; no changes made",
            ));
        }
        no_nested_git(&path, true)?;
        Ok(Self {
            identity: ObjectIdentity::path(&path)?,
            ancestors,
            marker,
            marker_identity: ObjectIdentity::path(&marker_path)?,
            admin_identity: ObjectIdentity::path(&admin)?,
            metadata: content_inventory(&admin)?,
            contents: content_inventory(&path)?,
            dirty: git::run_readonly(
                &path,
                &[
                    "-c",
                    "core.fsmonitor=false",
                    "status",
                    "--porcelain",
                    "--ignored=matching",
                    "--untracked-files=all",
                ],
            )?,
            head: record.head.clone(),
            branch: record.branch.clone().unwrap(),
            path,
            admin,
        })
    }

    pub fn validate(&self, target: &Path) -> Result<()> {
        let records = git::worktrees_readonly(target)?;
        let record = records
            .iter()
            .find(|record| record.path == self.path)
            .ok_or_else(|| closed("DELETE_CONCURRENT_CHANGE", "Linked registration changed", 1))?;
        if Self::inspect(target, record)? != *self {
            return Err(closed(
                "DELETE_CONCURRENT_CHANGE",
                "Linked checkout ownership or contents changed",
                1,
            ));
        }
        Ok(())
    }
}
