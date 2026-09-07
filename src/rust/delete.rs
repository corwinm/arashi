//! Conservative configured-repository deletion with immutable preflight evidence.
use crate::{
    Error, Result,
    cli::Args,
    config::{RepoConfig, Workspace},
    git,
    managed::{relative, unsupported},
};
#[path = "delete_worktree.rs"]
mod worktree;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};
#[cfg(unix)]
use std::{fs::OpenOptions, io::Write};
use worktree::LinkedCheckout;

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
    kind: String,
    peeled: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
struct DeletePlan {
    workspace_root: PathBuf,
    repository_key: String,
    repository_path: PathBuf,
    repository_identity: ObjectIdentity,
    git_identity: ObjectIdentity,
    ancestors: Vec<(PathBuf, ObjectIdentity)>,
    checkout_head: String,
    checkout_branch: Option<String>,
    config_path: PathBuf,
    config_identity: ObjectIdentity,
    config_before: Vec<u8>,
    config_after: Vec<u8>,
    config_entry_ref: String,
    local_refs: Vec<LocalRef>,
    ref_inventory: Vec<LocalRef>,
    head: Vec<u8>,
    git_config: Vec<u8>,
    configured_url: Option<String>,
    fetch_authority: Vec<String>,
    receipts_path: PathBuf,
    detached: bool,
    warnings: Vec<String>,
    protected_refs: Vec<String>,
    contents: Vec<(PathBuf, ObjectIdentity, Vec<u8>)>,
    dirty: String,
    linked: Vec<LinkedCheckout>,
}

// Keep persisted object order local to delete: changing serde_json's global map
// representation would change unrelated command envelopes and selection behavior.
enum PersistedValue {
    Object(PersistedObject),
    Array(Vec<PersistedValue>),
    Scalar(Value),
}

impl<'de> serde::Deserialize<'de> for PersistedValue {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let raw = Box::<serde_json::value::RawValue>::deserialize(deserializer)?;
        let text = raw.get();
        match text.as_bytes().first() {
            Some(b'{') => serde_json::from_str(text).map(Self::Object),
            Some(b'[') => serde_json::from_str(text).map(Self::Array),
            _ => serde_json::from_str(text).map(Self::Scalar),
        }
        .map_err(serde::de::Error::custom)
    }
}

impl serde::Serialize for PersistedValue {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        match self {
            Self::Object(value) => value.serialize(serializer),
            Self::Array(value) => value.serialize(serializer),
            Self::Scalar(value) => value.serialize(serializer),
        }
    }
}

struct PersistedObject(Vec<(String, PersistedValue)>);

impl<'de> serde::Deserialize<'de> for PersistedObject {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = PersistedObject;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a persisted configuration object")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> std::result::Result<Self::Value, M::Error> {
                let mut entries: Vec<(String, PersistedValue)> = Vec::new();
                while let Some((key, value)) = map.next_entry()? {
                    if let Some((_, previous)) = entries.iter_mut().find(|(name, _)| name == &key) {
                        *previous = value;
                    } else {
                        entries.push((key, value));
                    }
                }
                Ok(PersistedObject(entries))
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}

impl serde::Serialize for PersistedObject {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

fn closed(code: &str, message: impl Into<String>, exit: i32) -> Error {
    Error::new(code, message).with_exit_code(exit)
}

#[cfg(any(unix, test))]
fn quarantine_name(repository_key: &str) -> String {
    let encoded = repository_key
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!(".arashi-delete-{encoded}-{}", std::process::id())
}

fn ancestor_identities(path: &Path) -> Result<Vec<(PathBuf, ObjectIdentity)>> {
    path.ancestors()
        .skip(1)
        .map(|ancestor| {
            let metadata = fs::symlink_metadata(ancestor)?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(closed(
                    "DELETE_PATH_UNSAFE",
                    "Deletion ancestor is not a plain directory",
                    1,
                ));
            }
            Ok((ancestor.to_owned(), ObjectIdentity::metadata(&metadata)))
        })
        .collect()
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
            || key == "extensions.partialclone"
            || (key.starts_with("remote.") && key.ends_with(".promisor"))
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

// Freeze authorized checkout contents, not just porcelain labels: an edit to an
// already-dirty file must invalidate confirmation. Never follow checkout links.
fn content_inventory(root: &Path) -> Result<Vec<(PathBuf, ObjectIdentity, Vec<u8>)>> {
    fn visit(
        root: &Path,
        path: &Path,
        items: &mut Vec<(PathBuf, ObjectIdentity, Vec<u8>)>,
    ) -> Result<()> {
        let mut entries = fs::read_dir(path)?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if path == root && entry.file_name() == ".git" {
                continue;
            }
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            let identity = ObjectIdentity::metadata(&metadata);
            let bytes = if metadata.file_type().is_symlink() {
                fs::read_link(&path)?
                    .as_os_str()
                    .as_encoded_bytes()
                    .to_vec()
            } else if metadata.is_file() {
                fs::read(&path)?
            } else if metadata.is_dir() {
                Vec::new()
            } else {
                return Err(unsupported(
                    "Delete checkout contains a special file; no changes made",
                ));
            };
            if !identity.matches(&path) {
                return Err(closed(
                    "DELETE_CONCURRENT_CHANGE",
                    "Checkout entry changed while reading",
                    1,
                ));
            }
            items.push((path.strip_prefix(root).unwrap().to_owned(), identity, bytes));
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                visit(root, &path, items)?;
            }
        }
        Ok(())
    }
    let mut items = Vec::new();
    visit(root, root, &mut items)?;
    Ok(items)
}

fn ref_inventory(target: &Path) -> Result<Vec<LocalRef>> {
    let output = git::run_readonly(
        target,
        &[
            "for-each-ref",
            "--format=%(refname)%09%(objectname)%09%(objecttype)%09%(*objectname)",
            "refs",
        ],
    )?;
    let mut all = Vec::new();
    for line in output.lines() {
        let mut fields = line.split('\t');
        let name = fields.next().unwrap_or("");
        let oid = fields.next().unwrap_or("");
        let kind = fields.next().unwrap_or("");
        let peeled = fields
            .next()
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        if name.is_empty() || oid.is_empty() || !matches!(kind, "commit" | "tag" | "tree" | "blob")
        {
            return Err(unsupported(
                "Tags, symbolic, custom, or non-commit delete refs are not yet ported; no changes made",
            ));
        }
        all.push(LocalRef {
            name: name.to_owned(),
            oid: oid.to_owned(),
            kind: kind.to_owned(),
            peeled,
        });
    }
    Ok(all)
}

fn local_ref_loss(
    target: &Path,
    all: &[LocalRef],
    detached: bool,
) -> Result<(Vec<LocalRef>, Vec<String>, Vec<String>)> {
    let mut locals = all
        .iter()
        .filter(|reference| !reference.name.starts_with("refs/remotes/"))
        .cloned()
        .collect::<Vec<_>>();
    let tags = locals
        .iter()
        .filter(|reference| reference.name.starts_with("refs/tags/"))
        .cloned()
        .collect::<Vec<_>>();
    for tag in tags {
        locals.push(LocalRef {
            name: format!("{}^{{}}", tag.name),
            oid: tag.peeled.unwrap_or(tag.oid),
            kind: "commit".to_owned(),
            peeled: None,
        });
    }
    if detached {
        locals.push(LocalRef {
            name: "HEAD(detached)".to_owned(),
            kind: "commit".to_owned(),
            peeled: None,
            oid: git::run_readonly(target, &["rev-parse", "--verify", "HEAD^{commit}"])?
                .trim()
                .to_owned(),
        });
    }
    let remotes = all
        .iter()
        .filter(|reference| reference.name.starts_with("refs/remotes/"))
        .map(|reference| reference.oid.as_str())
        .collect::<Vec<_>>();
    if remotes.is_empty() {
        return Err(closed(
            "DELETE_GIT_DATA_LOSS",
            "Remote-tracking commit evidence is unavailable",
            1,
        ));
    }
    let mut warnings = vec![
        "DELETE_GIT_REFLOG_BOUNDARY: reflog-only unreachable objects are outside the local publication check".to_owned(),
        "DELETE_GIT_REMOTE_EVIDENCE: reachability uses local remote-tracking refs only; no fetch was performed".to_owned(),
    ];
    let mut protected = Vec::new();
    for local in &locals {
        let mut args = vec!["rev-list", "--count", local.oid.as_str(), "--not"];
        args.extend(&remotes);
        let always_protected = (local.name.starts_with("refs/tags/") && local.kind == "tag")
            || (!local.name.starts_with("refs/heads/")
                && !local.name.starts_with("refs/tags/")
                && local.name != "refs/stash"
                && local.name != "HEAD(detached)");
        let count = if always_protected {
            "1".to_owned()
        } else {
            git::run_readonly(target, &args)?
        };
        let count: u64 = count.trim().parse().map_err(|_| {
            closed(
                "DELETE_GIT_DATA_LOSS",
                "Git reachability evidence is unavailable",
                1,
            )
        })?;
        if count != 0 {
            warnings.push(format!(
                "DELETE_GIT_DATA_LOSS: {} {} is not reachable from local remote-tracking refs",
                local.name, local.oid
            ));
            protected.push(local.name.clone());
        }
    }
    warnings.sort();
    Ok((locals, warnings, protected))
}

// Delete only identifies fetch authority: --get-url applies Git rewrites without
// connecting, fetching, or starting a transport helper. Publication evidence stays
// local, as in retained delete-git-loss.ts, including when origin is unavailable.
fn fetch_identity(cwd: &Path, input: &str) -> Result<String> {
    if input.is_empty() || input.trim() != input || input.chars().any(char::is_control) {
        return Err(closed(
            "DELETE_TOPOLOGY_INVALID",
            "Malformed clone fetch URL",
            1,
        ));
    }
    let rewritten = git::run_readonly(cwd, &["ls-remote", "--get-url", "--", input])?;
    let urls = rewritten.lines().collect::<Vec<_>>();
    if urls.len() != 1 {
        return Err(closed(
            "DELETE_TOPOLOGY_INVALID",
            "Fetch URL rewrite is unavailable",
            1,
        ));
    }
    let url = urls[0];
    if Path::new(url).is_absolute() {
        return Ok(format!("file:{}", fs::canonicalize(url)?.display()));
    }
    // Do not invent identities for helpers, ambiguous escapes, passwords, query
    // strings or exotic URL forms. These remain explicit pre-mutation exclusions.
    if !crate::clone::network_url(url)
        || !url.is_ascii()
        || url.chars().any(|c| c.is_control() || c.is_whitespace())
        || url.contains(['%', '\\', '?', '#'])
    {
        return Err(unsupported(
            "Delete fetch URL identity is not supported; no changes made",
        ));
    }
    let (scheme, authority, path) = if let Some((scheme, rest)) = url.split_once("://") {
        let (authority, path) = rest.split_once('/').unwrap();
        (scheme, authority, path)
    } else {
        let (authority, path) = url.split_once(':').unwrap();
        ("ssh", authority, path)
    };
    let (user, host) = authority.rsplit_once('@').unwrap_or(("", authority));
    if user.contains([':', '@'])
        || host.is_empty()
        || host.starts_with('-')
        || host.contains(['[', ']', '@'])
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':'))
    {
        return Err(unsupported(
            "Delete fetch URL authority is not supported; no changes made",
        ));
    }
    let mut host = host.to_ascii_lowercase();
    if let Some((name, port)) = host.split_once(':') {
        let number = port
            .parse::<u16>()
            .map_err(|_| unsupported("Delete fetch URL port is invalid; no changes made"))?;
        host = if (scheme == "https" && number == 443) || (scheme == "http" && number == 80) {
            name.to_owned()
        } else {
            format!("{name}:{number}")
        };
    }
    let path = path.trim_end_matches('/');
    let path = if path.to_ascii_lowercase().ends_with(".git") {
        &path[..path.len() - 4]
    } else {
        path
    };
    let path = path.trim_end_matches('/');
    if path.is_empty() || path.split('/').any(|part| matches!(part, "." | "..")) {
        return Err(unsupported(
            "Delete fetch URL repository path is unsupported; no changes made",
        ));
    }
    Ok(format!(
        "{scheme}://{}{host}/{path}",
        if user.is_empty() {
            String::new()
        } else {
            format!("{user}@")
        }
    ))
}

fn matching_origin(
    workspace: &Path,
    target: &Path,
    configured: Option<&str>,
) -> Result<Vec<String>> {
    let urls = git::run_readonly(target, &["remote", "get-url", "--all", "origin"])?;
    let configured = configured
        .filter(|url| !url.trim().is_empty())
        .or_else(|| urls.lines().next())
        .ok_or_else(|| {
            closed(
                "DELETE_TOPOLOGY_INVALID",
                "Clone fetch URL is unavailable",
                1,
            )
        })?;
    let remotes = git::run_readonly(target, &["remote"])?;
    if remotes.lines().collect::<Vec<_>>() != ["origin"] {
        return Err(unsupported(
            "Delete with non-origin or multiple remotes is not yet ported; no changes made",
        ));
    }
    // Configured rewrites belong to the execution workspace; stored fetch URLs
    // belong to the clone. Freeze both to catch changed inherited rewrite policy.
    let configured = fetch_identity(workspace, configured)?;
    let mut identities = urls
        .lines()
        .map(|url| fetch_identity(target, url))
        .collect::<Result<Vec<_>>>()?;
    if !identities.contains(&configured) {
        return Err(closed(
            "DELETE_TOPOLOGY_INVALID",
            "Configured repository URL does not match the clone origin",
            1,
        ));
    }
    identities.insert(0, configured);
    Ok(identities)
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
        let parent_common = git::run_readonly(&workspace.root, &["rev-parse", "--git-common-dir"])?;
        let parent_common = fs::canonicalize(workspace.root.join(parent_common.trim()))?;
        let receipts = parent_common.join(".arashi-delete-receipts");
        match fs::symlink_metadata(&receipts) {
            Ok(_) => {
                return Err(unsupported(
                    "Existing delete recovery authority requires retained-source receipt validation; no changes made",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
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
        if parent_common.starts_with(&canonical_target) {
            return Err(closed(
                "DELETE_TOPOLOGY_INVALID",
                "Deletion target contains parent Git authority",
                1,
            ));
        }
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
        if records.is_empty()
            || records[0].bare
            || records[0].locked
            || records[0].prune_reason.is_some()
            || !crate::paths::same_existing(&records[0].path, &target)?
        {
            return Err(unsupported(
                "Delete with linked, locked, stale, or non-primary worktrees is not yet ported; no changes made",
            ));
        }
        let mut linked = Vec::new();
        for record in records.iter().skip(1) {
            let checkout = LinkedCheckout::inspect(&target, record)?;
            if target.starts_with(&checkout.path)
                || checkout.path.starts_with(&target)
                || workspace.root.starts_with(&checkout.path)
                || parent_common.starts_with(&checkout.path)
                || workspace
                    .root
                    .join(".arashi/config.json")
                    .starts_with(&checkout.path)
                || config.repos.iter().any(|(key, repo)| {
                    key != repository && {
                        let other = workspace.root.join(&repo.path);
                        other.starts_with(&checkout.path) || checkout.path.starts_with(&other)
                    }
                })
                || linked.iter().any(|other: &LinkedCheckout| {
                    checkout.path.starts_with(&other.path) || other.path.starts_with(&checkout.path)
                })
            {
                return Err(closed(
                    "DELETE_TOPOLOGY_INVALID",
                    "Linked deletion overlaps unrelated workspace authority",
                    1,
                ));
            }
            linked.push(checkout);
        }
        let gitlinks = git::run_readonly(&target, &["ls-files", "--stage"])?;
        if gitlinks.lines().any(|line| line.starts_with("160000 ")) {
            return Err(unsupported(
                "Delete with indexed gitlinks is not yet ported; no changes made",
            ));
        }
        no_nested_git(&target, true)?;
        let configured_url = repo
            .raw
            .get("gitUrl")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let fetch_authority = matching_origin(&workspace.root, &target, configured_url.as_deref())?;
        let ref_inventory = ref_inventory(&target)?;
        let head = fs::read(target.join(".git/HEAD"))?;
        let detached = records[0].branch.is_none();
        let (refs, mut warnings, protected_refs) =
            local_ref_loss(&target, &ref_inventory, detached)?;
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
        for entry in dirty.lines() {
            warnings.push(format!(
                "DELETE_GIT_DATA_LOSS: {}: {}",
                target.display(),
                entry
            ));
        }
        for checkout in &linked {
            for entry in checkout.dirty.lines() {
                warnings.push(format!(
                    "DELETE_GIT_DATA_LOSS: {}: {}",
                    checkout.path.display(),
                    entry
                ));
            }
        }
        warnings.sort();
        let contents = content_inventory(&target)?;
        let config_path = workspace.root.join(".arashi/config.json");
        no_symlink_below(&workspace.root, &config_path)?;
        let config_before = fs::read(&config_path)?;
        let current_config = crate::config::Config::parse(
            std::str::from_utf8(&config_before)
                .map_err(|_| closed("DELETE_CONFIG_INVALID", "Configuration is not UTF-8", 1))?,
        )?;
        if current_config.raw != config.raw || current_config.repo_order != config.repo_order {
            return Err(closed(
                "DELETE_CONCURRENT_CHANGE",
                "Configuration changed since discovery",
                1,
            ));
        }
        let mut persisted: PersistedObject =
            serde_json::from_slice(&config_before).map_err(|_| {
                closed(
                    "DELETE_CONFIG_INVALID",
                    "Configured workspace bytes are invalid",
                    1,
                )
            })?;
        let (map_key, repos) = ["repos", "discoveredRepos", "discovered_repos"]
            .into_iter()
            .find_map(|key| {
                persisted
                    .0
                    .iter()
                    .position(|(name, value)| {
                        name == key && matches!(value, PersistedValue::Object(_))
                    })
                    .map(|index| (key, index))
            })
            .ok_or_else(|| closed("DELETE_CONFIG_INVALID", "Repository map is unavailable", 1))?;
        let PersistedValue::Object(repos) = &mut persisted.0[repos].1 else {
            unreachable!()
        };
        let previous_len = repos.0.len();
        repos.0.retain(|(key, _)| key != repository);
        if repos.0.len() == previous_len {
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
            git_identity: ObjectIdentity::path(&target.join(".git"))?,
            ancestors: {
                let mut ancestors = ancestor_identities(&target)?;
                ancestors.extend(ancestor_identities(&config_path)?);
                ancestors.push((
                    workspace.root.join(".git"),
                    ObjectIdentity::path(&workspace.root.join(".git"))?,
                ));
                ancestors.push((parent_common.clone(), ObjectIdentity::path(&parent_common)?));
                ancestors
            },
            checkout_head: records[0].head.clone(),
            checkout_branch: records[0].branch.clone(),
            repository_path: target,
            config_identity: ObjectIdentity::path(&config_path)?,
            config_path,
            config_before,
            config_after,
            config_entry_ref: format!("{map_key}.{repository}"),
            local_refs: refs,
            ref_inventory,
            head,
            git_config: fs::read(canonical_target.join(".git/config"))?,
            configured_url,
            fetch_authority,
            receipts_path: receipts,
            detached,
            warnings,
            protected_refs,
            contents,
            dirty,
            linked,
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
        items.extend(self.linked.iter().map(|checkout| {
            json!({
                "id": format!("linked-worktree:{}", checkout.path.display()),
                "kind": "linked-worktree", "ownership": "delete", "path": checkout.path,
                "ref": Value::Null, "oid": Value::Null, "planned": true, "completed": false,
                "state": "planned", "reasonCode": Value::Null, "message": Value::Null
            })
        }));
        items.extend(self.local_refs.iter().map(|reference| {
            json!({
                "id": format!("local-ref:{}:{}", reference.name, reference.oid),
                "kind": "local-ref",
                "ownership": "delete",
                "path": Value::Null,
                "ref": reference.name,
                "oid": reference.oid,
                "planned": true,
                "completed": false,
                "state": "planned",
                "reasonCode": if self.protected_refs.contains(&reference.name) { json!("DELETE_GIT_DATA_LOSS") } else { Value::Null },
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
        json!({"id":format!("delete:{}",self.repository_key),"items":items,"warnings":self.warnings})
    }

    fn validate_ancestors(&self) -> Result<()> {
        if self
            .ancestors
            .iter()
            .any(|(path, identity)| !identity.matches(path))
        {
            return Err(closed(
                "DELETE_CONCURRENT_CHANGE",
                "Deletion ancestor ownership changed",
                1,
            ));
        }
        Ok(())
    }

    fn validate(&self) -> Result<()> {
        self.validate_ancestors()?;
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
        self.validate_ancestors()?;
        if !matches!(fs::symlink_metadata(&self.receipts_path), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
        {
            return Err(closed(
                "DELETE_CONCURRENT_CHANGE",
                "Delete recovery authority appeared or is unavailable",
                1,
            ));
        }
        if matching_origin(
            &self.workspace_root,
            quarantine,
            self.configured_url.as_deref(),
        )? != self.fetch_authority
        {
            return Err(closed(
                "DELETE_CONCURRENT_CHANGE",
                "Quarantined fetch authority changed",
                1,
            ));
        }
        let records = git::worktrees_readonly(quarantine)?;
        if records.len() != 1
            || records[0].bare
            || records[0].locked
            || records[0].prune_reason.is_some()
            || records[0].head != self.checkout_head
            || records[0].branch != self.checkout_branch
            || !crate::paths::same_existing(&records[0].path, quarantine)?
        {
            return Err(closed(
                "DELETE_CONCURRENT_CHANGE",
                "Quarantined Git topology changed",
                1,
            ));
        }
        if !self.repository_identity.matches(quarantine)
            || !self.git_identity.matches(&quarantine.join(".git"))
            || fs::symlink_metadata(&self.repository_path).is_ok()
            || fs::read(&self.config_path)? != expected_config
            || ref_inventory(quarantine)? != self.ref_inventory
            || fs::read(quarantine.join(".git/HEAD"))? != self.head
            || fs::read(quarantine.join(".git/config"))? != self.git_config
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
        if dirty != self.dirty || content_inventory(quarantine)? != self.contents {
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
        if self.detached {
            return Err(unsupported(
                "Detached delete mutation is not yet ported; no changes made",
            ));
        }
        self.validate()?;
        for checkout in &self.linked {
            self.validate_ancestors()?;
            checkout.validate(&self.repository_path)?;
            git::run(
                &self.repository_path,
                &[
                    "worktree",
                    "remove",
                    "--force",
                    "--",
                    checkout.path.to_str().ok_or_else(|| {
                        closed("DELETE_PATH_UNSAFE", "Linked path is not UTF-8", 1)
                    })?,
                ],
            )?;
            if fs::symlink_metadata(&checkout.path).is_ok()
                || fs::symlink_metadata(&checkout.admin).is_ok()
            {
                return Err(closed(
                    "DELETE_PARTIAL_FAILURE",
                    "Linked worktree removal is incomplete",
                    1,
                ));
            }
        }
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
            self.validate_ancestors().is_ok()
                && matches!(fs::symlink_metadata(&self.repository_path), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
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
            "warnings": self.warnings
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
    plan.validate_ancestors()?;
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
    if !args.has("force")
        && (!plan.protected_refs.is_empty()
            || !plan.dirty.is_empty()
            || plan
                .linked
                .iter()
                .any(|checkout| !checkout.dirty.is_empty()))
    {
        data["confirmation"] = json!("not-required");
        return Err(closed(
            "DELETE_GIT_DATA_LOSS",
            "Local Git history is not published; explicit --force is required",
            1,
        )
        .with_details(data));
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
#[path = "../../tests/rust/delete_ownership.rs"]
mod ownership_tests;

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
