//! Managed ignore planning; migrates owned rules while preserving caller-owned bytes.
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
const BLOCK_START: &str = "# BEGIN Arashi managed ignore rules";
const BLOCK_END: &str = "# END Arashi managed ignore rules";
fn read_ignore(path: &Path) -> Result<Option<Vec<u8>>> {
    safe(path)?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() => {
            return Err(unsupported("Non-regular ignore files are unsupported"));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
        _ => {}
    }
    Ok(Some(fs::read(path)?))
}
fn owned_rules(content: &str) -> Result<Vec<String>> {
    let Some((_, tail)) = content.split_once(BLOCK_START) else {
        return Ok(vec![]);
    };
    let (body, _) = tail
        .split_once(BLOCK_END)
        .ok_or_else(|| unsupported("Incomplete managed ignore block"))?;
    Ok(body
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.starts_with('#'))
        .map(str::to_owned)
        .collect())
}
// Retained managed-ignore.ts replaces only the first owned block; unowned
// prefixes/suffixes keep their newline styles and missing final newline.
fn replace_owned(content: Option<&[u8]>, rules: &[String]) -> Option<Vec<u8>> {
    if content.is_none() && rules.is_empty() {
        return None;
    }
    let original = std::str::from_utf8(content.unwrap_or_default()).expect("validated ignore UTF8");
    let block = if rules.is_empty() {
        String::new()
    } else {
        format!("{BLOCK_START}\n{}\n{BLOCK_END}", rules.join("\n"))
    };
    let next = if let Some(i) = original.find(BLOCK_START) {
        let j = original[i..]
            .find(BLOCK_END)
            .expect("validated owned block")
            + i
            + BLOCK_END.len();
        format!("{}{block}{}", &original[..i], &original[j..])
    } else if block.is_empty() {
        original.to_owned()
    } else {
        let separator = if original.is_empty() {
            ""
        } else if original.ends_with('\n') {
            "\n"
        } else {
            "\n\n"
        };
        format!("{original}{separator}{block}\n")
    };
    Some(
        next.strip_prefix("\n# BEGIN")
            .map_or_else(|| next.clone(), |tail| format!("# BEGIN{tail}"))
            .into_bytes(),
    )
}
pub struct IgnorePlan {
    pub data: Value,
    pub path: PathBuf,
    files: [PathBuf; 2],
    before: [Option<Vec<u8>>; 2],
    after: [Option<Vec<u8>>; 2],
    root: PathBuf,
    repos: String,
    trees: String,
    dry: bool,
}
impl IgnorePlan {
    pub fn build(root: &Path, repos: &str, trees: &str, dry: bool) -> Result<Self> {
        let preference = std::process::Command::new("git")
            .args(["config", "--local", "--get", "arashi.ignoreScope"])
            .current_dir(root)
            .stdin(std::process::Stdio::null())
            .output()?;
        let stored = match preference.status.code() {
            Some(0) => {
                let value = String::from_utf8(preference.stdout)
                    .map_err(|_| unsupported("Non-UTF8 ignore scope unsupported"))?;
                let value = value.trim();
                if value.is_empty() {
                    None
                } else {
                    Some(value.to_owned())
                }
            }
            Some(1) => None,
            _ => {
                return Err(Error::new(
                    "GIT_ERROR",
                    String::from_utf8_lossy(&preference.stderr).trim(),
                ));
            }
        };
        let scope = stored.as_deref().unwrap_or("local");
        if !matches!(scope, "local" | "tracked" | "none") {
            return Err(unsupported(&format!(
                "Invalid clone-local arashi.ignoreScope value '{scope}'. Run `git config --local --unset arashi.ignoreScope` or `arashi init --ignore-scope local`."
            )));
        }
        let local = root.join(git::run(root, &["rev-parse", "--git-path", "info/exclude"])?.trim());
        let files = [local.clone(), root.join(".gitignore")];
        let before = [read_ignore(&files[0])?, read_ignore(&files[1])?];
        let mut owned = [vec![], vec![]];
        for i in 0..2 {
            let text = std::str::from_utf8(before[i].as_deref().unwrap_or_default())
                .map_err(|_| unsupported("Non-UTF8 ignore contents unsupported"))?;
            owned[i] = owned_rules(text)?;
        }
        let target = match scope {
            "local" => Some(0),
            "tracked" => Some(1),
            _ => None,
        };
        let other = target.filter(|_| stored.is_some()).map(|i| 1 - i);
        let types = ["local", "tracked"];
        let mut paths = vec![];
        let mut rules = vec![];
        let mut safe_rules = vec![];
        let mut missing = vec![];
        for input in [repos, trees] {
            let p = relative(input)?;
            safe(&root.join(&p))?;
            let rule = format!("/{}/", p.to_string_lossy().replace('\\', "/"));
            if safe_rules.contains(&rule) {
                continue;
            }
            safe_rules.push(rule.clone());
            let evidence = ignore_evidence(root, &root.join(&p).join(".arashi-ignore-probe"))?;
            let mut row = json!({"input":input,"rule":rule,"safety":"safe","status":"unignored"});
            let mut needs_rule = evidence["ignored"] != true;
            if !needs_rule {
                let source = evidence["source"].as_str().unwrap_or("");
                let source_type = if source.ends_with("info/exclude") {
                    "local"
                } else if source.ends_with(".gitignore") {
                    "tracked"
                } else {
                    "global"
                };
                row["status"] = json!("already-ignored");
                row["source"] =
                    json!({"path":source,"pattern":evidence["pattern"],"type":source_type});
                needs_rule =
                    other.is_some_and(|i| source_type == types[i] && owned[i].contains(&rule));
            }
            if needs_rule {
                missing.push(rule.clone());
                if target.is_some() {
                    row["status"] = json!(if dry { "planned" } else { "applied" });
                    rules.push(rule);
                }
            }
            paths.push(row);
        }
        let mut stale = vec![];
        for i in 0..2 {
            for rule in &owned[i] {
                if !safe_rules.contains(rule) {
                    stale.push(json!({"path":files[i],"rule":rule,"target":types[i]}));
                }
            }
        }
        let mut after = before.clone();
        if let Some(i) = target {
            let mut next: Vec<String> = vec![];
            for rule in owned[i]
                .iter()
                .filter(|r| safe_rules.contains(r))
                .chain(rules.iter())
            {
                if !next.contains(rule) {
                    next.push(rule.clone());
                }
            }
            after[i] = replace_owned(before[i].as_deref(), &next);
            if let Some(j) = other {
                after[j] = replace_owned(before[j].as_deref(), &[]);
            }
        }
        let warnings: Vec<String> = if target.is_none() {
            missing
                .iter()
                .map(|r| format!("Managed path '{r}' remains unignored because scope is none."))
                .chain(stale.iter().map(|r| {
                    format!(
                        "Stale Arashi-owned rule '{}' remains unchanged because scope is none.",
                        r["rule"].as_str().unwrap()
                    )
                }))
                .collect()
        } else {
            vec![]
        };
        let attempted = before != after;
        let changed = attempted && !dry;
        let mut data = json!({"localExcludePath":local,"paths":paths,"scope":scope,"staleRules":stale,"storedPreference":stored,"trackedIgnorePath":files[1],"appliedRules":if !dry {rules.clone()} else {vec![]},"attempted":attempted,"changed":changed,"fileChanges":{"local":!dry && before[0]!=after[0],"preference":false,"tracked":!dry && before[1]!=after[1]},"plannedRules":rules,"restored":false,"warnings":warnings});
        if let Some(i) = target {
            data["targetPath"] = json!(files[i]);
            data["targetType"] = json!(types[i]);
        }
        Ok(Self {
            root: root.to_owned(),
            repos: repos.to_owned(),
            trees: trees.to_owned(),
            dry,
            data,
            path: target.map_or(local, |i| files[i].clone()),
            files,
            before,
            after,
        })
    }
    pub fn apply(&self, tx: &mut Transaction) -> Result<()> {
        let current = Self::build(&self.root, &self.repos, &self.trees, self.dry)?;
        if current.data != self.data
            || current.files != self.files
            || current.before != self.before
            || current.after != self.after
        {
            return Err(unsupported(
                "Effective ignore policy changed after planning; no changes made",
            ));
        }
        if self.dry {
            return Ok(());
        }
        // Freeze both files before the first write, then publish in source order.
        for i in 0..2 {
            if read_ignore(&self.files[i])? != self.before[i] {
                return Err(unsupported("Ignore file changed after planning"));
            }
        }
        // Pull/clone callers propagate apply errors without rolling back their
        // transaction. Keep this reconciliation private until both writes
        // succeed, so a failed tracked write cannot strand the local removal.
        let mut pending = Transaction::default();
        for i in 0..2 {
            if self.before[i] != self.after[i]
                && let Some(bytes) = &self.after[i]
                && let Err(error) = pending.write(&self.files[i], bytes)
            {
                let restoration = pending.rollback();
                if restoration.is_empty() {
                    return Err(error);
                }
                return Err(Error::new(
                    "MANAGED_IGNORE_RECONCILIATION_FAILED",
                    format!("{error}; ignore restoration: {}", restoration.join("; ")),
                ));
            }
        }
        tx.files.append(&mut pending.files);
        tx.dirs.append(&mut pending.dirs);
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
