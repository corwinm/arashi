//! Read-only ownership proof for the bounded exact-destination create slice.
use crate::{
    Result, git,
    managed::{safe, unsupported},
};
#[cfg(unix)]
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Identity(Vec<(PathBuf, u64, u64, Vec<u8>)>);

#[derive(Clone, Debug, PartialEq)]
pub(super) struct RepositorySafety {
    config: String,
    index: String,
}

pub(super) fn repository_safety(path: &Path) -> Result<RepositorySafety> {
    safe(path)?;
    let config = git::run(path, &["config", "--null", "--list"])?;
    if config.split('\0').any(|entry| {
        let key = entry.split('\n').next().unwrap_or("");
        key.starts_with("filter.") && (key.ends_with(".clean") || key.ends_with(".process"))
            || key == "core.worktree"
            || key == "core.fsmonitor"
    }) {
        return Err(unsupported(
            "Reuse with conversion filters, fsmonitor, or core.worktree projection is not yet ported",
        ));
    }
    let index = git::run(
        path,
        &[
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "ls-files",
            "--stage",
            "-z",
        ],
    )?;
    if index.split('\0').any(|entry| entry.starts_with("160000 ")) {
        return Err(unsupported(
            "Reuse with submodule topology is not yet ported",
        ));
    }
    Ok(RepositorySafety { config, index })
}

#[cfg(unix)]
fn capture(path: &Path, directory: bool) -> Result<(PathBuf, u64, u64, Vec<u8>)> {
    use std::os::unix::fs::MetadataExt;
    safe(path)?;
    let before = fs::symlink_metadata(path)?;
    if (directory && !before.is_dir()) || (!directory && !before.is_file()) {
        return Err(unsupported(
            "Reuse requires ordinary directories and Git metadata files",
        ));
    }
    let bytes = if directory { vec![] } else { fs::read(path)? };
    let after = fs::symlink_metadata(path)?;
    if before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.file_type() != after.file_type()
    {
        return Err(unsupported(
            "Reuse ownership changed while inspecting Git metadata",
        ));
    }
    Ok((path.to_owned(), before.dev(), before.ino(), bytes))
}

#[cfg(not(unix))]
pub(super) fn inspect(_root: &Path, _target: &Path, _branch: &str) -> Result<Identity> {
    Err(unsupported(
        "Existing destination reuse requires native POSIX object identity; this platform is not yet supported",
    ))
}

#[cfg(unix)]
pub(super) fn inspect(root: &Path, target: &Path, branch: &str) -> Result<Identity> {
    // Freeze both sides of Git's reciprocal link. Merely appearing in worktree list
    // does not prove that the destination still belongs to this repository.
    if [root, target]
        .iter()
        .any(|p| p.to_str().is_none_or(|s| s.contains(['\n', '\r'])))
    {
        return Err(unsupported(
            "Reuse paths containing line breaks or non-UTF-8 names are not yet ported",
        ));
    }
    let common = root.join(".git");
    let mut entries = vec![
        capture(root, true)?,
        capture(&common, true)?,
        capture(target, true)?,
    ];
    let marker = capture(&target.join(".git"), false)?;
    let raw = std::str::from_utf8(&marker.3).map_err(|_| unsupported("Non-UTF-8 Git marker"))?;
    let admin = raw
        .strip_prefix("gitdir: ")
        .and_then(|s| s.strip_suffix('\n'))
        .map(PathBuf::from)
        .ok_or_else(|| unsupported("Unsupported worktree Git marker"))?;
    if admin.parent() != Some(common.join("worktrees").as_path()) || !admin.is_absolute() {
        return Err(unsupported(
            "Reuse requires a contained primary Git worktree registration",
        ));
    }
    entries.push(marker);
    entries.push(capture(&common.join("worktrees"), true)?);
    entries.push(capture(&admin, true)?);
    let backlink = capture(&admin.join("gitdir"), false)?;
    if backlink.3 != format!("{}\n", target.join(".git").display()).as_bytes() {
        return Err(unsupported(
            "Worktree registration does not point back to the destination",
        ));
    }
    entries.push(backlink);
    let common_link = capture(&admin.join("commondir"), false)?;
    if common_link.3 != b"../..\n" {
        return Err(unsupported(
            "Unsupported worktree common directory projection",
        ));
    }
    entries.push(common_link);
    let head = capture(&admin.join("HEAD"), false)?;
    if head.3 != format!("ref: refs/heads/{branch}\n").as_bytes() {
        return Err(unsupported(
            "Worktree HEAD does not match the requested branch",
        ));
    }
    entries.push(head);
    entries.push(capture(&admin.join("index"), false)?);
    if git::run(target, &["rev-parse", "--show-toplevel"])?.trim_end() != target.to_string_lossy()
        || git::run(
            target,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?
        .trim_end()
            != common.to_string_lossy()
    {
        return Err(unsupported(
            "Worktree Git identity does not match the planned destination",
        ));
    }
    if !git::run(root, &["remote"])?.trim().is_empty() {
        return Err(unsupported(
            "Remote-backed existing destination reuse is not yet ported",
        ));
    }
    // Observe dirty state without optional index writes, fsmonitor execution or
    // entering submodules. Reject conversion filters before Git status can run them.
    for path in [root, target] {
        repository_safety(path)?;
    }
    if !git::run(
        target,
        &[
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
        ],
    )?
    .is_empty()
    {
        return Err(unsupported(
            "Dirty existing destination reuse is not yet ported; no changes made",
        ));
    }
    // Recheck all recorded filesystem objects after Git observations.
    for entry in &entries {
        if capture(&entry.0, entry.3.is_empty() && entry.0.is_dir())? != *entry {
            return Err(unsupported("Reuse ownership changed during preflight"));
        }
    }
    Ok(Identity(entries))
}
