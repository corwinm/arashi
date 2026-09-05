//! Managed local ignore planning; preserves caller-owned bytes and rejects unsupported migrations.
use crate::{Error, Result, git, operations::ignore_evidence};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};
pub fn unsupported(message: &str) -> Error {
    Error::new("RUST_NOT_YET_PORTED", message)
}
pub fn relative(path: &str) -> Result<PathBuf> {
    let path = Path::new(path);
    if path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
        || path.as_os_str().is_empty()
    {
        return Err(unsupported(
            "External or traversing managed paths are not yet ported; no changes made",
        ));
    }
    let clean: PathBuf = path
        .components()
        .filter(|c| *c != Component::CurDir)
        .collect();
    if clean.as_os_str().is_empty() {
        return Err(unsupported("Repository-root managed paths are unsupported"));
    }
    Ok(clean)
}
pub fn safe(path: &Path) -> Result<()> {
    for p in path.ancestors() {
        if let Ok(m) = fs::symlink_metadata(p)
            && m.file_type().is_symlink()
        {
            return Err(unsupported(
                "Symlinked managed paths are unsupported; no changes made",
            ));
        }
    }
    Ok(())
}
pub struct IgnorePlan {
    pub data: Value,
    pub path: PathBuf,
    before: Option<Vec<u8>>,
    after: Option<Vec<u8>>,
    root: PathBuf,
    repos: String,
    trees: String,
    dry: bool,
}
impl IgnorePlan {
    pub fn build(root: &Path, repos: &str, trees: &str, dry: bool) -> Result<Self> {
        if git::run(root, &["config", "--local", "--get", "arashi.ignoreScope"]).is_ok() {
            return Err(unsupported(
                "Stored ignore-scope preferences are not yet ported; no changes made",
            ));
        }
        let local = root.join(git::run(root, &["rev-parse", "--git-path", "info/exclude"])?.trim());
        safe(&local)?;
        let before = match fs::read(&local) {
            Ok(v) => Some(v),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        let mut paths = vec![];
        let mut rules = vec![];
        for input in [repos, trees] {
            let p = relative(input)?;
            safe(&root.join(&p))?;
            let rule = format!("/{}/", p.to_string_lossy().replace('\\', "/"));
            let evidence = ignore_evidence(root, &root.join(&p).join(".arashi-ignore-probe"))?;
            let mut row = json!({"input":input,"rule":rule,"safety":"safe","status":if dry {"planned"} else {"applied"}});
            if evidence["ignored"] == true {
                let source = evidence["source"].as_str().unwrap_or("");
                row["status"] = json!("already-ignored");
                row["source"] = json!({"path":source,"pattern":evidence["pattern"],"type":if source.ends_with("info/exclude") {"local"} else if source.ends_with(".gitignore") {"tracked"} else {"global"}});
            } else {
                rules.push(rule);
            }
            paths.push(row);
        }
        let original = String::from_utf8(before.clone().unwrap_or_default())
            .map_err(|_| unsupported("Non-UTF8 ignore contents unsupported"))?;
        let start = "# BEGIN Arashi managed ignore rules";
        let end = "# END Arashi managed ignore rules";
        let mut owned = vec![];
        if let Some((_, tail)) = original.split_once(start) {
            let (body, _) = tail
                .split_once(end)
                .ok_or_else(|| unsupported("Incomplete managed ignore block"))?;
            owned = body
                .lines()
                .map(str::trim)
                .filter(|s| !s.is_empty() && !s.starts_with('#'))
                .map(str::to_owned)
                .collect();
            if owned
                .iter()
                .any(|rule| !paths.iter().any(|p| p["rule"] == *rule))
            {
                return Err(unsupported(
                    "Stale managed ignore rules require reconciliation not yet ported",
                ));
            }
        }
        for rule in &rules {
            if !owned.contains(rule) {
                owned.push(rule.clone());
            }
        }
        let mut after = before.clone();
        if !owned.is_empty() {
            let block = format!("{start}\n{}\n{end}", owned.join("\n"));
            let next = if let Some(i) = original.find(start) {
                let j = original[i..].find(end).unwrap() + i + end.len();
                format!("{}{block}{}", &original[..i], &original[j..])
            } else {
                format!(
                    "{}{separator}{block}\n",
                    original,
                    separator = if original.is_empty() {
                        ""
                    } else if original.ends_with('\n') {
                        "\n"
                    } else {
                        "\n\n"
                    }
                )
            };
            after = Some(next.into_bytes());
        }
        let attempted = before != after;
        let changed = attempted && !dry;
        let data = json!({"localExcludePath":local,"paths":paths,"scope":"local","staleRules":[],"storedPreference":null,"trackedIgnorePath":root.join(".gitignore"),"appliedRules":if changed {rules.clone()} else {vec![]},"attempted":attempted,"changed":changed,"fileChanges":{"local":changed,"preference":false,"tracked":false},"plannedRules":rules,"restored":false,"targetPath":local,"targetType":"local","warnings":[]});
        Ok(Self {
            root: root.to_owned(),
            repos: repos.to_owned(),
            trees: trees.to_owned(),
            dry,
            data,
            path: local,
            before,
            after,
        })
    }
    pub fn apply(&self, tx: &mut Transaction) -> Result<()> {
        let current = Self::build(&self.root, &self.repos, &self.trees, self.dry)?;
        if current.data != self.data || current.before != self.before || current.after != self.after
        {
            return Err(unsupported(
                "Effective ignore policy changed after planning; no changes made",
            ));
        }
        if fs::read(&self.path).ok() != self.before {
            return Err(unsupported("Ignore file changed after planning"));
        }
        if self.before != self.after
            && let Some(bytes) = &self.after
        {
            tx.write(&self.path, bytes)?;
        }
        Ok(())
    }
}
#[derive(Default)]
pub struct Transaction {
    files: Vec<(PathBuf, Option<Vec<u8>>, Vec<u8>)>,
    dirs: Vec<PathBuf>,
}
impl Transaction {
    pub fn mkdir(&mut self, path: &Path) -> Result<()> {
        safe(path)?;
        if path.is_dir() {
            return Ok(());
        }
        if let Some(parent) = path.parent() {
            self.mkdir(parent)?;
        }
        fs::create_dir(path)?;
        self.dirs.push(path.to_owned());
        Ok(())
    }
    pub fn write(&mut self, path: &Path, bytes: &[u8]) -> Result<()> {
        safe(path)?;
        let before = match fs::read(path) {
            Ok(v) => Some(v),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        self.mkdir(path.parent().unwrap())?;
        self.files.push((path.to_owned(), before, bytes.to_vec()));
        fs::write(path, bytes)?;
        Ok(())
    }
    pub fn rollback(&mut self) -> Vec<String> {
        let mut errors = vec![];
        for (path, bytes, written) in self.files.drain(..).rev() {
            if fs::read(&path).ok().as_deref() != Some(written.as_slice()) {
                errors.push(format!(
                    "{}: file changed after this operation wrote it; preserved for recovery",
                    path.display()
                ));
                continue;
            }
            let result = match bytes {
                Some(bytes) => fs::write(&path, bytes),
                None => fs::remove_file(&path),
            };
            if let Err(e) = result {
                errors.push(format!("{}: {e}", path.display()));
            }
        }
        for path in self.dirs.drain(..).rev() {
            if let Err(e) = fs::remove_dir(&path)
                && e.kind() != std::io::ErrorKind::NotFound
            {
                errors.push(format!("{}: {e}", path.display()));
            }
        }
        errors
    }
}
