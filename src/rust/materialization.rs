//! Bounded primary-checkout materialization. Never overwrite an occupied entry.
use crate::{
    Error, Result, git,
    managed::{relative, unsupported},
};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

fn metadata(path: &Path) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(m) => Ok(Some(m)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
fn safe(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        if let Some(m) = metadata(ancestor)?
            && m.file_type().is_symlink()
        {
            return Err(unsupported(
                "Symlinked materialization paths are unsupported",
            ));
        }
    }
    Ok(())
}
fn same_identity(before: &fs::Metadata, now: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        before.dev() == now.dev() && before.ino() == now.ino()
    }
    #[cfg(not(unix))]
    {
        let _ = (before, now);
        false // No stable native identity implementation on these platforms.
    }
}
// Recheck identity on the opened object; chmod the handle, never a replacement path.
fn set_directory_permissions(
    path: &Path,
    before: &fs::Metadata,
    permissions: fs::Permissions,
) -> Result<()> {
    safe(path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "macos")]
        options.custom_flags(0x100); // O_NOFOLLOW
        #[cfg(target_os = "linux")]
        options.custom_flags(0x20000); // O_NOFOLLOW
    }
    let directory = options.open(path)?;
    let now = directory.metadata()?;
    if !now.is_dir() || !same_identity(before, &now) {
        return Err(unsupported(
            "Materialization directory identity changed; preserved",
        ));
    }
    directory.set_permissions(permissions)?;
    Ok(())
}
fn inspect_source(path: &Path) -> Result<bool> {
    safe(path)?;
    let Some(m) = metadata(path)? else {
        return Ok(false);
    };
    if !m.is_file() && !m.is_dir() {
        return Err(unsupported(
            "Materialization requires regular files or directories",
        ));
    }
    if m.is_dir() {
        if path.join(".git").try_exists()?
            || (path.join("HEAD").is_file() && path.join("objects").is_dir())
        {
            return Err(unsupported(
                "Nested Git materialization sources are unsupported",
            ));
        }
        let mut keys = std::collections::BTreeSet::new();
        for e in fs::read_dir(path)? {
            let e = e?;
            let name = e.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| unsupported("Non-UTF8 materialization names are unsupported"))?;
            if !name.is_ascii() || !keys.insert(name.to_ascii_lowercase()) {
                return Err(unsupported(
                    "Non-ASCII or colliding materialization names are unsupported",
                ));
            }
            inspect_source(&e.path())?;
        }
    }
    Ok(true)
}
fn occupied(root: &Path, path: &str) -> Result<Option<(&'static str, &'static str)>> {
    safe(root)?;
    let mut current = root.to_owned();
    let parts: Vec<_> = path.split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        if current.is_dir() {
            for e in fs::read_dir(&current)? {
                let e = e?;
                let name = e.file_name();
                let name = name.to_str().ok_or_else(|| {
                    unsupported("Non-UTF8 materialization destination names are unsupported")
                })?;
                if !name.is_ascii() {
                    return Err(unsupported(
                        "Non-ASCII materialization destination names are unsupported",
                    ));
                }
                if name.eq_ignore_ascii_case(part) && name != *part {
                    return Ok(Some(("destination_exists", "Destination already exists")));
                }
            }
        }
        current.push(part);
        if let Some(m) = metadata(&current)? {
            if index + 1 == parts.len() {
                return Ok(Some(("destination_exists", "Destination already exists")));
            }
            if m.file_type().is_symlink() || !m.is_dir() {
                return Ok(Some((
                    "destination_ancestor_unsafe",
                    "Destination ancestor is not a real directory",
                )));
            }
        }
    }
    Ok(None)
}
fn tree_collision(root: &Path, oid: &str, path: &str) -> Result<bool> {
    let mut tree = oid.to_owned();
    let parts: Vec<_> = path.split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        let listing = git::run(root, &["ls-tree", "-z", &tree])?;
        let mut matches = vec![];
        for record in listing.split('\0').filter(|r| !r.is_empty()) {
            let (meta, name) = record
                .split_once('\t')
                .ok_or_else(|| unsupported("Invalid target tree record"))?;
            if !name.is_ascii() {
                return Err(unsupported(
                    "Non-ASCII materialization target trees are unsupported",
                ));
            }
            if name.eq_ignore_ascii_case(part) {
                matches.push(meta);
            }
        }
        if matches.is_empty() {
            return Ok(false);
        }
        if matches.len() != 1 || index + 1 == parts.len() {
            return Ok(true);
        }
        let fields: Vec<_> = matches[0].split(' ').collect();
        if fields.get(1) != Some(&"tree") {
            return Ok(true);
        }
        tree = fields
            .get(2)
            .ok_or_else(|| unsupported("Invalid target tree object"))?
            .to_string();
    }
    Ok(false)
}
#[cfg(unix)]
fn symlink_capability(destination: &Path) -> Result<bool> {
    use std::{
        os::unix::fs::DirBuilderExt,
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    safe(destination)?;
    let mut parent = destination;
    loop {
        if let Some(m) = metadata(parent)? {
            if !m.is_dir() {
                return Err(unsupported("Symlink probe ancestor is not a directory"));
            }
            break;
        }
        parent = parent
            .parent()
            .ok_or_else(|| unsupported("No symlink probe ancestor"))?;
    }
    // Exclusive, private directory on the nearest existing destination filesystem.
    let mut probe = None;
    for _ in 0..64 {
        let path = parent.join(format!(
            ".arashi-symlink-probe-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        match fs::DirBuilder::new().mode(0o700).create(&path) {
            Ok(()) => {
                probe = Some(path);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    let probe = probe.ok_or_else(|| unsupported("Cannot allocate symlink capability probe"))?;
    let mut owned = Ownership::default();
    owned.record(
        &probe,
        Owned::Directory(fs::symlink_metadata(&probe)?.permissions()),
    )?;
    let result = (|| -> Result<bool> {
        let target = probe.join("target");
        let link = probe.join("link");
        // POSIX link creation does not require an existing target.
        if std::os::unix::fs::symlink(&target, &link).is_err() {
            return Ok(false);
        }
        owned.record(&link, Owned::Link(target))?;
        Ok(true)
    })();
    let errors = owned.rollback();
    if !errors.is_empty() {
        return Err(unsupported(&format!(
            "Symlink probe cleanup failed: {}",
            errors.join("; ")
        )));
    }
    result
}
#[cfg(not(unix))]
fn symlink_capability(_: &Path) -> Result<bool> {
    Ok(false)
}

pub fn plan(
    root: &Path,
    destination: &Path,
    name: &str,
    oid: &str,
    policy: &Value,
) -> Result<Option<Value>> {
    let entries: Vec<_> = ["copy", "symlink"]
        .into_iter()
        .flat_map(|action| {
            policy[action]
                .as_array()
                .into_iter()
                .flatten()
                .map(move |p| (action, p.as_str().unwrap()))
        })
        .collect();
    if entries.is_empty() {
        return Ok(None);
    }
    if !cfg!(unix) {
        return Err(unsupported(
            "Windows materialization is unsupported until stable object identity is implemented",
        ));
    }
    let symlink_supported = if entries.iter().any(|(action, _)| *action == "symlink") {
        symlink_capability(destination)?
    } else {
        true
    };
    let mut outcomes = vec![];
    for (action, path) in &entries {
        if !path.is_ascii() {
            return Err(unsupported(
                "Non-ASCII materialization paths are unsupported",
            ));
        }
        let key = path.to_ascii_lowercase();
        if entries
            .iter()
            .filter(|(_, p)| {
                let other = p.to_ascii_lowercase();
                other == key
                    || other.starts_with(&format!("{key}/"))
                    || key.starts_with(&format!("{other}/"))
            })
            .count()
            > 1
        {
            return Err(unsupported(
                "Overlapping materialization paths are unsupported",
            ));
        }
        let source = root.join(relative(path)?);
        let (status, reason, message) = if *action == "symlink" && !symlink_supported {
            (
                "blocked",
                "symlink_unsupported",
                "Native symbolic links are unavailable".to_owned(),
            )
        } else if !inspect_source(&source)? {
            (
                "skipped",
                "source_missing",
                "Source is missing; entry is optional".to_owned(),
            )
        } else if tree_collision(root, oid, path)? {
            (
                "blocked",
                "destination_exists",
                "Target Git tree contains the destination or an incompatible ancestor".to_owned(),
            )
        } else if let Some((reason, message)) = occupied(destination, path)? {
            ("blocked", reason, message.to_owned())
        } else {
            (
                if *action == "copy" {
                    "would-copy"
                } else {
                    "would-link"
                },
                "none",
                format!("Would {action} '{path}'"),
            )
        };
        outcomes.push(json!({"action":action,"path":path,"status":status,"reasonCode":reason,"message":message}));
    }
    Ok(Some(
        json!({"classification":if outcomes.iter().any(|o|o["status"]=="blocked") {"blocked"} else {"actionable"},"outcomes":outcomes,"repositoryId":name,"targetOid":oid}),
    ))
}
pub fn require_actionable(plans: &[Value]) -> Result<()> {
    if plans.iter().any(|p| p["classification"] == "blocked") {
        return Err(Error::new(
            "MATERIALIZATION_PLAN_BLOCKED",
            "Configured worktree materialization preflight is blocked",
        )
        .with_details(json!({"dryRunOutcome":{"materializationPlans":plans}})));
    }
    Ok(())
}
#[derive(Default)]
pub struct Ownership {
    entries: Vec<(PathBuf, fs::Metadata, Owned)>,
    modes: Vec<(PathBuf, fs::Permissions)>,
}
enum Owned {
    File(Vec<u8>),
    Directory(fs::Permissions),
    #[cfg(unix)]
    Link(PathBuf),
}
impl Ownership {
    fn record(&mut self, path: &Path, kind: Owned) -> Result<()> {
        self.entries
            .push((path.to_owned(), fs::symlink_metadata(path)?, kind));
        Ok(())
    }
    fn parents(&mut self, source: &Path, destination: &Path) -> Result<()> {
        safe(destination)?;
        if let Some(m) = metadata(destination)? {
            if !m.is_dir() {
                return Err(unsupported("Materialization parent is not a directory"));
            }
            #[cfg(unix)]
            if let Some((_, before, _)) = self
                .entries
                .iter()
                .find(|(path, _, kind)| path == destination && matches!(kind, Owned::Directory(_)))
            {
                use std::os::unix::fs::PermissionsExt;
                if !same_identity(before, &m) {
                    return Err(unsupported("Materialization directory identity changed"));
                }
                let permissions = fs::metadata(source)?.permissions();
                fs::set_permissions(
                    destination,
                    fs::Permissions::from_mode(permissions.mode() | 0o700),
                )?;
                self.modes.push((destination.to_owned(), permissions));
            }
            return Ok(());
        }
        self.parents(source.parent().unwrap(), destination.parent().unwrap())?;
        fs::create_dir(destination)?;
        self.record(
            destination,
            Owned::Directory(fs::metadata(source)?.permissions()),
        )?;
        self.modes
            .push((destination.to_owned(), fs::metadata(source)?.permissions()));
        Ok(())
    }
    fn copy(&mut self, source: &Path, destination: &Path) -> Result<()> {
        inspect_source(source)?;
        safe(destination)?;
        self.parents(source.parent().unwrap(), destination.parent().unwrap())?;
        if source.is_dir() {
            fs::create_dir(destination)?;
            self.record(
                destination,
                Owned::Directory(fs::metadata(source)?.permissions()),
            )?;
            let mut entries = fs::read_dir(source)?.collect::<std::io::Result<Vec<_>>>()?;
            entries.sort_by_key(|e| e.file_name());
            for e in entries {
                self.copy(&e.path(), &destination.join(e.file_name()))?;
            }
            fs::set_permissions(destination, fs::metadata(source)?.permissions())?;
        } else {
            let bytes = fs::read(source)?;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination)?;
            self.record(destination, Owned::File(vec![]))?;
            // Keep the exact successfully written prefix, including short writes.
            let index = self.entries.len() - 1;
            let mut written = 0;
            while written < bytes.len() {
                let n = file.write(&bytes[written..])?;
                if n == 0 {
                    return Err(std::io::Error::from(std::io::ErrorKind::WriteZero).into());
                }
                written += n;
                self.entries[index].2 = Owned::File(bytes[..written].to_vec());
            }
            file.set_permissions(fs::metadata(source)?.permissions())?;
        }
        Ok(())
    }
    pub fn execute(&mut self, root: &Path, destination: &Path, plan: &Value) -> Result<Vec<Value>> {
        let mut outcomes = vec![];
        for outcome in plan["outcomes"].as_array().unwrap() {
            if outcome["status"] == "skipped" {
                outcomes.push(outcome.clone());
                continue;
            }
            let path = outcome["path"].as_str().unwrap();
            let source = root.join(relative(path)?);
            let target = destination.join(relative(path)?);
            inspect_source(&source)?;
            if occupied(destination, path)?.is_some() {
                return Err(unsupported("Materialization destination changed"));
            }
            let copy = outcome["action"] == "copy";
            if copy {
                self.copy(&source, &target)?;
            } else {
                self.parents(source.parent().unwrap(), target.parent().unwrap())?;
                #[cfg(unix)]
                {
                    std::os::unix::fs::symlink(&source, &target)?;
                    self.record(&target, Owned::Link(source))?;
                }
                #[cfg(not(unix))]
                return Err(unsupported("Materialization symlinks unsupported"));
            }
            let mut outcome = outcome.clone();
            outcome["status"] = json!(if copy { "copied" } else { "linked" });
            outcome["message"] = json!(format!(
                "{} '{path}'",
                if copy { "Copied" } else { "Linked" }
            ));
            for (path, permissions) in self.modes.drain(..).rev() {
                safe(&path)?;
                fs::set_permissions(path, permissions)?;
            }
            outcomes.push(outcome);
        }
        Ok(outcomes)
    }
    pub fn rollback(&mut self) -> Vec<String> {
        let mut errors = vec![];
        // Only reopen directories still owned by this invocation; never follow replacements.
        #[cfg(unix)]
        for (path, before, kind) in &self.entries {
            if matches!(kind, Owned::Directory(_)) {
                let reopen = (|| -> Result<()> {
                    use std::os::unix::fs::PermissionsExt;
                    safe(path)?;
                    if let Some(now) = metadata(path)? {
                        if !same_identity(before, &now) || !now.is_dir() {
                            return Err(unsupported(
                                "Materialization directory identity changed; preserved",
                            ));
                        }
                        set_directory_permissions(
                            path,
                            before,
                            fs::Permissions::from_mode(now.permissions().mode() | 0o700),
                        )?;
                    }
                    Ok(())
                })();
                if let Err(e) = reopen {
                    errors.push(format!("{}: {}", path.display(), e.message));
                }
            }
        }
        for (path, before, kind) in self.entries.iter().rev() {
            let remove = (|| -> Result<()> {
                safe(path.parent().unwrap())?;
                let Some(now) = metadata(path)? else {
                    return Ok(());
                };
                if !same_identity(before, &now) {
                    return Err(unsupported("Materialization identity changed; preserved"));
                }
                match kind {
                    Owned::File(bytes)
                        if now.is_file()
                            && !now.file_type().is_symlink()
                            && fs::read(path)? == *bytes =>
                    {
                        fs::remove_file(path)?
                    }
                    #[cfg(unix)]
                    Owned::Link(target)
                        if now.file_type().is_symlink() && fs::read_link(path)? == *target =>
                    {
                        fs::remove_file(path)?
                    }
                    Owned::Directory(_) if now.is_dir() && !now.file_type().is_symlink() => {
                        fs::remove_dir(path)?
                    }
                    _ => return Err(unsupported("Materialization contents changed; preserved")),
                }
                Ok(())
            })();
            if let Err(e) = remove {
                errors.push(format!("{}: {}", path.display(), e.message));
            }
        }
        // Children first, so restoring a restrictive parent cannot prevent child restoration.
        for (path, before, kind) in self.entries.drain(..).rev() {
            if let Owned::Directory(permissions) = kind {
                let restore = (|| -> Result<()> {
                    safe(&path)?;
                    if let Some(now) = metadata(&path)? {
                        if !now.is_dir() || !same_identity(&before, &now) {
                            return Err(unsupported(
                                "Materialization directory identity changed; mode preserved",
                            ));
                        }
                        set_directory_permissions(&path, &before, permissions)?;
                    }
                    Ok(())
                })();
                if let Err(e) = restore {
                    errors.push(format!(
                        "{}: permission restoration failed: {}",
                        path.display(),
                        e.message
                    ));
                }
            }
        }
        errors
    }
}
