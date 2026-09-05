//! Local-file origin conflict proof. No fetch or transport command is used here.
use super::{Item, reuse};
use crate::{
    Error, Result, git,
    managed::{safe, unsupported},
};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Identity {
    remote: PathBuf,
    tracking: String,
    oid: String,
    safety: reuse::RepositorySafety,
    objects: Vec<(PathBuf, u64, u64, Vec<u8>)>,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Primary {
    safety: reuse::RepositorySafety,
    objects: Vec<(PathBuf, u64, u64, Vec<u8>)>,
}

/// No object/index/status inspection is allowed before these checks.
pub(super) fn preflight(root: &Path) -> Result<()> {
    if root
        .to_str()
        .is_none_or(|s| !s.is_ascii() || s.contains(['\n', '\r']))
    {
        return Err(unsupported(
            "Remote create requires ordinary ASCII primary paths",
        ));
    }
    safe(root)?;
    configuration(root, true)?;
    safe(&root.join(".git"))?;
    topology(&root.join(".git"))
}

pub(super) fn primary(root: &Path) -> Result<Primary> {
    preflight(root)?;
    let safety = reuse::repository_safety(root)?;
    let common = root.join(".git");
    let mut objects = vec![capture(root)?];
    for relative in [
        "",
        "HEAD",
        "config",
        "index",
        "objects",
        "refs",
        "refs/heads",
        "hooks",
    ] {
        objects.push(capture(&common.join(relative))?);
    }
    if !git::run(
        root,
        &[
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "status",
            "--porcelain",
            "--untracked-files=all",
        ],
    )?
    .is_empty()
    {
        return Err(unsupported(
            "Remote create requires clean primary repositories, including mixed selections",
        ));
    }
    Ok(Primary { safety, objects })
}

fn configuration(root: &Path, bounded: bool) -> Result<()> {
    let config = git::run(root, &["config", "--null", "--list"])?;
    if config
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .any(|entry| {
            let key = entry.split('\n').next().unwrap_or("");
            key.starts_with("url.")
                || key.starts_with("protocol.")
                || key.starts_with("uploadpack.")
                || key.starts_with("transfer.")
                || (bounded
                    && !matches!(
                        key,
                        "core.repositoryformatversion"
                            | "core.filemode"
                            | "core.bare"
                            | "core.logallrefupdates"
                            | "core.ignorecase"
                            | "core.precomposeunicode"
                            | "user.name"
                            | "user.email"
                            | "commit.gpgsign"
                            | "maintenance.auto"
                            | "remote.origin.url"
                            | "remote.origin.fetch"
                    ))
                || (key.starts_with("remote.")
                    && key != "remote.origin.url"
                    && key != "remote.origin.fetch")
        })
    {
        return Err(unsupported(
            "Remote create configuration/tracking policy is not yet supported",
        ));
    }
    Ok(())
}

fn topology(base: &Path) -> Result<()> {
    for relative in [
        "commondir",
        "shallow",
        "objects/info/alternates",
        "info/grafts",
        "refs/replace",
    ] {
        if base.join(relative).try_exists()? {
            return Err(unsupported(
                "Remote create Git topology is not yet supported",
            ));
        }
    }
    safe(&base.join("hooks"))?;
    for entry in std::fs::read_dir(base.join("hooks"))? {
        let entry = entry?;
        if !entry.file_name().to_string_lossy().ends_with(".sample") {
            return Err(unsupported(
                "Remote create with Git hooks is not yet supported",
            ));
        }
    }
    Ok(())
}

pub(super) fn validate_primaries(proofs: &[(PathBuf, Primary)]) -> Result<()> {
    for (root, proof) in proofs {
        if primary(root)? != *proof {
            return Err(Error::new(
                "PLAN_CHANGED",
                "Remote create primary ownership changed",
            ));
        }
    }
    Ok(())
}

pub(super) fn validate_created(proofs: &[(&Item, reuse::Identity)], branch: &str) -> Result<()> {
    for (item, proof) in proofs {
        preflight(&item.root)?;
        let local = local_head(&item.root, branch)?;
        let records = git::worktrees(&item.root)?;
        if local.as_deref() != Some(item.oid.as_str())
            || records
                .iter()
                .filter(|r| r.branch.as_deref() == Some(branch))
                .count()
                != 1
            || !records.iter().any(|r| {
                r.path == item.target
                    && r.branch.as_deref() == Some(branch)
                    && r.head == item.oid
                    && !r.locked
                    && r.prune_reason.is_none()
            })
        {
            return Err(Error::new(
                "PLAN_CHANGED",
                "Created worktree ref or registration ownership changed",
            ));
        }
        if reuse::inspect_created(&item.root, &item.target, branch)? != *proof {
            return Err(Error::new(
                "PLAN_CHANGED",
                "Created worktree filesystem ownership changed",
            ));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn capture(path: &Path) -> Result<(PathBuf, u64, u64, Vec<u8>)> {
    use std::{fs, os::unix::fs::MetadataExt};
    safe(path)?;
    let m = fs::symlink_metadata(path)?;
    if !m.is_file() && !m.is_dir() {
        return Err(unsupported("Remote create requires ordinary Git metadata"));
    }
    let bytes = if m.is_file() { fs::read(path)? } else { vec![] };
    let after = fs::symlink_metadata(path)?;
    if m.dev() != after.dev() || m.ino() != after.ino() {
        return Err(unsupported(
            "Remote create identity changed during inspection",
        ));
    }
    Ok((path.to_owned(), m.dev(), m.ino(), bytes))
}

#[cfg(not(unix))]
fn capture(_path: &Path) -> Result<(PathBuf, u64, u64, Vec<u8>)> {
    Err(unsupported(
        "Remote create requires POSIX object identity; Windows is not yet supported",
    ))
}

fn ordinary_loose_ref(path: &Path) -> Result<()> {
    let bytes = std::fs::read(path)?;
    let oid = bytes.strip_suffix(b"\n").unwrap_or(&bytes);
    if !matches!(oid.len(), 40 | 64)
        || !oid.iter().all(u8::is_ascii_hexdigit)
        || oid.iter().all(|b| *b == b'0')
    {
        return Err(unsupported(
            "Malformed or symbolic target ref is not supported",
        ));
    }
    Ok(())
}

/// Exact ref-name evidence only: no rev-parse, object peeling or transport.
/// A prefix directory is not a ref. Invalid/symbolic loose entries fail closed;
/// packed refs are enumerated by name without reading their target objects.
fn exact_conflict_evidence(root: &Path, common: &Path, name: &str) -> Result<bool> {
    let path = common.join(name);
    safe(&path)?;
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() => {
            ordinary_loose_ref(&path)?;
            return Ok(true);
        }
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Err(unsupported("Target ref requires ordinary metadata")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotADirectory => {
            // A shorter ordinary loose ref can block this path. It does not
            // establish the exact requested name; packed names still need checking.
            let mut ordinary_ancestor = false;
            for ancestor in path.ancestors().skip(1) {
                if ancestor == common.join("refs") {
                    break;
                }
                match std::fs::symlink_metadata(ancestor) {
                    Ok(metadata) if metadata.is_file() => {
                        ordinary_loose_ref(ancestor)?;
                        ordinary_ancestor = true;
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotADirectory => {}
                    _ => break,
                }
            }
            if !ordinary_ancestor {
                return Err(e.into());
            }
        }
        Err(e) => return Err(e.into()),
    }
    Ok(
        git::run(root, &["for-each-ref", "--format=%(refname)", name])?
            .lines()
            .any(|reference| reference == name),
    )
}

pub(super) fn has_target_conflict(root: &Path, branch: &str) -> Result<bool> {
    let common = root.join(".git");
    if exact_conflict_evidence(root, &common, &format!("refs/remotes/origin/{branch}"))? {
        return Ok(true);
    }
    for remote in git::run(root, &["remote"])?
        .lines()
        .filter(|name| *name != "origin")
    {
        if exact_conflict_evidence(root, &common, &format!("refs/remotes/{remote}/{branch}"))? {
            return Ok(true);
        }
    }
    if let Ok(urls) = git::run(root, &["config", "--get-all", "remote.origin.url"]) {
        let url = urls.trim_end_matches('\n');
        let remote = Path::new(url);
        if !url.contains(['\n', '\r'])
            && remote.is_absolute()
            && remote.is_dir()
            && safe(remote).is_ok()
            && git::run(remote, &["config", "--bool", "core.bare"])
                .is_ok_and(|v| v.trim() == "true")
        {
            return exact_conflict_evidence(remote, remote, &format!("refs/heads/{branch}"));
        }
    }
    Ok(false)
}

// Called only after the relevant repository configuration/topology preflight.
// Git's ref atoms read the object named by this exact ref; no revision expansion
// or tag peeling can substitute a different namespace or object.
fn exact_head(root: &Path, common: &Path, branch: &str) -> Result<Option<String>> {
    let name = format!("refs/heads/{branch}");
    if !exact_conflict_evidence(root, common, &name)? {
        return Ok(None);
    }
    let records = git::run(
        root,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)",
            &name,
        ],
    )
    .map_err(|_| unsupported("Target must name an available commit"))?;
    let mut exact = records.lines().filter_map(|line| {
        let fields = line.split('\0').collect::<Vec<_>>();
        (fields.first() == Some(&name.as_str())).then_some(fields)
    });
    let fields = exact
        .next()
        .ok_or_else(|| unsupported("Target branch is missing"))?;
    if exact.next().is_some()
        || fields.len() != 4
        || fields[2] != "commit"
        || !fields[3].is_empty()
        || !matches!(fields[1].len(), 40 | 64)
        || !fields[1].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(unsupported("Target requires an exact ordinary commit ref"));
    }
    Ok(Some(fields[1].to_owned()))
}

pub(super) fn local_head(root: &Path, branch: &str) -> Result<Option<String>> {
    preflight(root)?;
    exact_head(root, &root.join(".git"), branch)
}

pub(super) fn local_source(root: &Path, source: &str) -> Result<String> {
    let branch = source
        .strip_prefix("refs/heads/")
        .ok_or_else(|| unsupported("Remote create requires an exact local base ref"))?;
    local_head(root, branch)?
        .ok_or_else(|| Error::new("PLAN_CHANGED", "Local base ref disappeared"))
}

pub(super) fn inspect(root: &Path, branch: &str) -> Result<Option<Identity>> {
    preflight(root)?;
    let remotes = git::run(root, &["remote"])?;
    let tracking = format!("refs/remotes/origin/{branch}");
    if !root
        .join(".git")
        .join(&tracking)
        .symlink_metadata()
        .is_ok_and(|m| m.is_file())
    {
        return Err(unsupported(
            "Remote create requires an ordinary loose tracking ref",
        ));
    }
    let tracked = git::run(root, &["rev-parse", "--verify", &tracking]).ok();
    if std::env::var_os("GIT_ALLOW_PROTOCOL").is_some()
        || std::env::var_os("GIT_PROTOCOL_FROM_USER").is_some()
    {
        return Err(unsupported(
            "Remote create with environment transport overrides is not yet supported",
        ));
    }
    if remotes.trim() != "origin" {
        return Err(unsupported(
            "Remote create requires exactly one local-file origin; no transport or mutation attempted",
        ));
    }
    let safety = reuse::repository_safety(root)?;
    configuration(root, false)?;
    let urls = git::run(root, &["config", "--get-all", "remote.origin.url"])?;
    let url = urls.trim_end_matches('\n');
    let remote = PathBuf::from(url);
    if url.contains(['\n', '\r']) || !remote.is_absolute() || !remote.is_dir() {
        return Err(unsupported(
            "Remote create supports absolute local-file origin paths only; no network operation attempted",
        ));
    }
    safe(&remote)?;
    // Configuration/topology must be screened before resolving a commit: a
    // promisor repository may otherwise perform an implicit network fetch.
    configuration(&remote, true)?;
    topology(&remote)?;
    if remote.starts_with(root)
        || root.starts_with(&remote)
        || git::run(&remote, &["rev-parse", "--is-bare-repository"])?.trim() != "true"
        || git::run(&remote, &["rev-parse", "--absolute-git-dir"])?.trim() != url
    {
        return Err(unsupported(
            "Remote create requires a separate ordinary bare origin",
        ));
    }
    configuration(root, true)?;
    let fetch = git::run(root, &["config", "--get-all", "remote.origin.fetch"])?;
    if fetch.trim() != "+refs/heads/*:refs/remotes/origin/*" {
        return Err(unsupported(
            "Remote create requires the ordinary origin fetch mapping",
        ));
    }
    if git::run(root, &["symbolic-ref", "HEAD"])?.trim() != "refs/heads/main"
        || git::run(&remote, &["symbolic-ref", "HEAD"])?.trim() != "refs/heads/main"
        || git::run(root, &["symbolic-ref", "refs/remotes/origin/HEAD"])
            .is_ok_and(|head| head.trim() != "refs/remotes/origin/main")
    {
        return Err(unsupported(
            "Remote create currently requires local main and origin main defaults",
        ));
    }
    // Availability/type verification is deliberately after both the selection's
    // primary preflight and this origin's configuration/topology checks.
    let available = git::run(
        root,
        &["rev-parse", "--verify", &format!("{tracking}^{{commit}}")],
    )
    .map_err(|_| unsupported("Remote tracking target must name an available local commit"))?;
    if tracked
        .as_ref()
        .is_none_or(|oid| oid.trim() != available.trim())
    {
        return Err(unsupported(
            "Remote tracking target must be an ordinary commit ref",
        ));
    }
    let oid = exact_head(&remote, &remote, branch)?
        .ok_or_else(|| unsupported("Origin target requires an exact ordinary branch ref"))?;
    if git::run(root, &["symbolic-ref", &tracking]).is_ok()
        || git::run(&remote, &["symbolic-ref", &format!("refs/heads/{branch}")]).is_ok()
    {
        return Err(unsupported(
            "Symbolic target refs are not yet supported for remote create",
        ));
    }
    if tracked.as_ref().is_none_or(|value| value.trim() != oid) {
        return Err(unsupported(
            "Origin target and remote-tracking ref differ or require fetch; no changes made",
        ));
    }
    let common = root.join(".git");
    let mut objects = vec![];
    for base in [&common, &remote] {
        topology(base)?;
        for relative in ["", "HEAD", "config", "objects", "refs", "refs/heads"] {
            objects.push(capture(&base.join(relative))?);
        }
        // Packed refs are common in disposable bare clones; freeze their bytes too.
        let remote_target = format!("refs/heads/{branch}");
        for relative in ["packed-refs", "refs/heads/main", remote_target.as_str()] {
            let p = base.join(relative);
            // The new local target belongs to the transaction, and is verified separately.
            if base == &common && relative == remote_target {
                continue;
            }
            if p.exists() {
                objects.push(capture(&p)?);
            }
        }
    }
    objects.push(capture(root)?);
    objects.push(capture(&common.join("index"))?);
    objects.push(capture(&common.join(&tracking))?);
    if !git::run(
        root,
        &[
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "status",
            "--porcelain",
            "--untracked-files=all",
        ],
    )?
    .is_empty()
    {
        return Err(unsupported(
            "Remote create requires clean primary repositories",
        ));
    }
    Ok(Some(Identity {
        remote,
        tracking,
        oid,
        safety,
        objects,
    }))
}

fn validate_requested_base(item: &Item) -> Result<()> {
    if let Some((reference, oid)) = &item.requested_base
        && local_source(&item.root, reference)? != *oid
    {
        return Err(Error::new(
            "PLAN_CHANGED",
            "Requested create base identity changed",
        ));
    }
    Ok(())
}

fn pending_destination(item: &Item, branch: &str) -> Result<()> {
    let changed = || {
        Error::new(
            "PLAN_CHANGED",
            "Pending worktree destination or registration changed",
        )
    };
    safe(&item.target).map_err(|_| changed())?;
    match std::fs::symlink_metadata(&item.target) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err(changed()),
    }
    for ancestor in item.target.ancestors().skip(1) {
        match std::fs::symlink_metadata(ancestor) {
            Ok(metadata) if metadata.is_dir() => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(changed()),
        }
    }
    // The bounded plan started with only this main primary registered. Extra,
    // relocated or missing registrations must not become an actionable plan.
    let records = git::worktrees(&item.root)?;
    if records.len() != 1
        || records[0].path != item.root
        || records[0].branch.as_deref() != Some("main")
        || records[0].head != item.oid
        || records[0].bare
        || records[0].locked
        || records[0].prune_reason.is_some()
    {
        return Err(changed());
    }
    let local = local_head(&item.root, branch)?;
    if local.as_deref() != item.existing.then_some(item.oid.as_str()) {
        return Err(changed());
    }
    Ok(())
}

pub(super) fn validate_pending(items: &[Item], branch: &str, completed: &[&Item]) -> Result<()> {
    if !items.iter().any(|item| item.remote.is_some()) {
        return Ok(());
    }
    for item in items {
        preflight(&item.root)?;
    }
    for item in items {
        validate_requested_base(item)?;
    }
    for item in items
        .iter()
        .filter(|item| !completed.iter().any(|done| done.root == item.root))
    {
        pending_destination(item, branch)?;
    }
    Ok(())
}

pub(super) fn validate(items: &[Item], branch: &str, completed: &[&Item]) -> Result<()> {
    if !items.iter().any(|i| i.remote.is_some()) {
        return Ok(());
    }
    for item in items {
        preflight(&item.root)?;
    }
    for item in items {
        validate_requested_base(item)?;
        if !completed.iter().any(|done| done.root == item.root) {
            pending_destination(item, branch)?;
        }
        if item.remote.is_none() && has_target_conflict(&item.root, branch)? {
            return Err(Error::new(
                "PLAN_CHANGED",
                "Remote target conflict appeared after planning",
            ));
        }
        if local_source(&item.root, &item.source)? != item.oid {
            return Err(Error::new(
                "PLAN_CHANGED",
                "Remote create base identity changed",
            ));
        }
    }
    for item in items.iter().filter(|i| i.remote.is_some()) {
        if inspect(&item.root, branch)?.as_ref() != item.remote.as_ref() {
            return Err(Error::new(
                "PLAN_CHANGED",
                "Remote create repository or tracking identity changed",
            ));
        }
        let local = local_head(&item.root, branch)?;
        let records = git::worktrees(&item.root)?;
        if completed.iter().any(|done| done.root == item.root) {
            if local.as_deref() != Some(item.oid.as_str())
                || records
                    .iter()
                    .filter(|r| r.branch.as_deref() == Some(branch))
                    .count()
                    != 1
                || !records.iter().any(|r| {
                    r.path == item.target
                        && r.branch.as_deref() == Some(branch)
                        && r.head == item.oid
                        && !r.locked
                        && r.prune_reason.is_none()
                })
                || !git::run(
                    &item.target,
                    &[
                        "--no-optional-locks",
                        "-c",
                        "core.fsmonitor=false",
                        "status",
                        "--porcelain",
                        "--untracked-files=all",
                    ],
                )?
                .is_empty()
            {
                return Err(Error::new(
                    "PLAN_CHANGED",
                    "Created remote-conflict target ownership changed",
                ));
            }
        } else if local.is_some() || records.iter().any(|r| r.branch.as_deref() == Some(branch)) {
            return Err(Error::new(
                "PLAN_CHANGED",
                "Remote-only target became local or checked out",
            ));
        }
    }
    Ok(())
}
