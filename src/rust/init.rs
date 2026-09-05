//! Explicit standalone initialization with reversible local-ignore updates.
use crate::{Error, Result, git};
use serde_json::{Value, json};
use std::{fs, path::Path};
const CODE: &str = "ZERO_CONFIG_BOOTSTRAP_FAILED";
const RULE: &str = ".worktrees/";
fn failure(message: impl Into<String>) -> Error {
    let message = message.into();
    Error::new(CODE, message.clone()).with_details(json!({"attempted":{"localExclude":false,"worktreesDirectory":false},"finalState":{"localExcludeChanged":false,"worktreesDirectoryChanged":false},"mode":"standalone","originalFailure":message,"restorationWarnings":[],"restored":{"localExclude":false,"worktreesDirectory":false}}))
}
fn effective_ignore(root: &Path) -> (bool, Option<String>) {
    let Ok(output) = git::run(
        root,
        &[
            "check-ignore",
            "--no-index",
            "-v",
            ".worktrees/.arashi-ignore-probe",
        ],
    ) else {
        return (false, None);
    };
    let metadata = output.trim().split('\t').next().unwrap_or("");
    let mut parts = metadata.rsplitn(3, ':');
    let pattern = parts.next().unwrap_or("");
    let line = parts.next().and_then(|v| v.parse::<usize>().ok());
    let recognized = line.is_some() && parts.next().is_some();
    (
        !metadata.is_empty() && !(recognized && pattern.starts_with('!')),
        (!metadata.is_empty()).then(|| metadata.to_owned()),
    )
}
pub fn init(cwd: &Path, dry_run: bool, zero_config: bool) -> Result<Value> {
    if !zero_config {
        return Err(Error::new(
            "PORT_UNSUPPORTED",
            "Configured initialization is not yet ported; use --zero-config for standalone repositories.",
        ));
    }
    let trees = git::worktrees(cwd).map_err(|_| {
        failure("Zero-config initialization requires an existing non-bare Git repository.")
    })?;
    let root = trees
        .first()
        .filter(|w| !w.bare)
        .ok_or_else(|| {
            failure("Zero-config initialization requires an existing non-bare Git repository.")
        })?
        .path
        .clone();
    let root = crate::paths::canonicalize(root)?;
    if root.join(".arashi/config.json").exists() {
        return Err(failure(
            "A configured Arashi workspace already exists; zero-config standalone mode cannot replace it.",
        ));
    }
    let directory = root.join(".worktrees");
    let raw = git::run(&root, &["rev-parse", "--git-path", "info/exclude"])
        .map_err(|e| failure(e.message))?;
    let exclude = root.join(raw.trim());
    let directory_exists = directory.exists();
    let (ignored, source) = effective_ignore(&root);
    let needs_rule = !ignored;
    let mut result = json!({"attempted":{"localExclude":false,"worktreesDirectory":false},"changed":!dry_run && (!directory_exists || needs_rule),"dryRun":dry_run,"finalState":{"localExcludeChanged":!dry_run && needs_rule,"worktreesDirectoryChanged":!dry_run && !directory_exists},"localExclude":{"changed":!dry_run && needs_rule,"path":exclude,"planned":needs_rule,"rule":RULE},"mode":"standalone","restored":false,"workspaceRoot":root,"worktreesDirectory":{"changed":!dry_run && !directory_exists,"path":directory,"planned":!directory_exists}});
    if let Some(source) = source {
        result["localExclude"]["source"] = json!(source);
    }
    if dry_run {
        return Ok(result);
    }
    // Track only paths this operation owns. Rollback never recursively deletes.
    let mut original: Option<Vec<u8>> = None;
    let mut directory_created = false;
    let mut exclude_written = false;
    let operation = (|| -> Result<()> {
        if !directory_exists {
            result["attempted"]["worktreesDirectory"] = json!(true);
            fs::create_dir(&directory)?;
            directory_created = true;
        }
        if needs_rule {
            result["attempted"]["localExclude"] = json!(true);
            match fs::symlink_metadata(&exclude) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() {
                        return Err(failure(format!(
                            "Refusing to modify symlinked repository-local exclude file: {}",
                            exclude.display()
                        )));
                    }
                    if !metadata.is_file() {
                        return Err(failure("Repository-local exclude is not a regular file."));
                    }
                    original = Some(fs::read(&exclude)?);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(e.into()),
            }
            let bytes = original.as_deref().unwrap_or_default();
            let newline: &[u8] = if bytes.windows(2).any(|w| w == b"\r\n") {
                b"\r\n"
            } else {
                b"\n"
            };
            let mut updated = bytes.to_vec();
            if !updated.is_empty() && !updated.ends_with(b"\n") {
                updated.extend_from_slice(newline);
            }
            updated.extend_from_slice(RULE.as_bytes());
            updated.extend_from_slice(newline);
            fs::create_dir_all(exclude.parent().expect("exclude has parent"))?;
            // Set before write so a partial write is also restored.
            exclude_written = true;
            fs::write(&exclude, updated)?;
            let (verified, source) = effective_ignore(&root);
            if !verified {
                return Err(failure(
                    "The local .worktrees/ exclude is defeated by a higher-precedence Git ignore rule; restore ignore safety manually.",
                ));
            }
            if let Some(source) = source {
                result["localExclude"]["source"] = json!(source);
            }
        }
        Ok(())
    })();
    if let Err(err) = operation {
        let mut warnings = vec![];
        let mut restored_exclude = false;
        let mut restored_directory = false;
        if exclude_written {
            let restore = match &original {
                Some(bytes) => fs::write(&exclude, bytes),
                None => fs::remove_file(&exclude),
            };
            match restore {
                Ok(()) => restored_exclude = true,
                Err(e) => warnings.push(format!("exclude restoration failed: {e}")),
            }
        }
        if directory_created {
            match fs::remove_dir(&directory) {
                Ok(()) => restored_directory = true,
                Err(e) => warnings.push(format!("directory restoration failed: {e}")),
            }
        }
        let suffix = if warnings.is_empty() {
            String::new()
        } else {
            format!(" ({})", warnings.join("; "))
        };
        let exclude_changed = if result["attempted"]["localExclude"] != true {
            false
        } else {
            match &original {
                Some(bytes) => fs::read(&exclude).map(|now| now != *bytes).unwrap_or(true),
                None => exclude.exists(),
            }
        };
        return Err(Error::new(CODE,format!("{}{suffix}",err.message)).with_details(json!({"attempted":result["attempted"],"finalState":{"localExcludeChanged":exclude_changed,"worktreesDirectoryChanged":!directory_exists && directory.exists()},"mode":"standalone","originalFailure":err.message,"restorationWarnings":warnings,"restored":{"localExclude":restored_exclude,"worktreesDirectory":restored_directory},"workspaceRoot":root})));
    }
    Ok(result)
}

pub fn configured(cwd: &Path, args: &crate::cli::Args) -> Result<Value> {
    use crate::managed::{IgnorePlan, Transaction, relative, safe, unsupported};
    let root = crate::paths::canonicalize(cwd)?;
    let trees = git::worktrees(&root)?;
    if !trees.first().is_some_and(|w| !w.bare && w.path == root) {
        return Err(unsupported(
            "Configured init currently requires a primary non-bare repository root",
        ));
    }
    let config_path = root.join(".arashi/config.json");
    if config_path.exists() {
        return Err(Error::new(
            "INIT_2",
            format!(
                "Arashi configuration already exists at: {}",
                config_path.display()
            ),
        )
        .with_exit_code(2)
        .with_details(json!({"exitCode":2,"workspaceRoot":root})));
    }
    let repos = args.value("repos-dir").unwrap_or("./repos");
    let worktrees = args.value("worktrees-dir").unwrap_or(".arashi/worktrees");
    let repos_path = root.join(relative(repos)?);
    relative(worktrees)?;
    safe(&config_path)?;
    safe(&repos_path)?;
    let dry = args.has("dry-run");
    let ignore = IgnorePlan::build(&root, repos, worktrees, dry)?;
    let mut discovered = serde_json::Map::new();
    if !dry && !args.has("no-discover") && repos_path.is_dir() {
        discover_children(&repos_path, &mut discovered)?;
    }
    let config = json!({"$schema":"https://unpkg.com/arashi/schema/config.schema.json","repos":discovered,"reposDir":repos,"version":"1.0.0","worktreesDir":worktrees});
    let hooks = root.join(".arashi/hooks");
    if !dry {
        let mut tx = Transaction::default();
        let operation = (|| -> Result<()> {
            if config_path.exists() {
                return Err(unsupported("Configuration appeared after planning"));
            }
            ignore.apply(&mut tx)?;
            tx.mkdir(&hooks)?;
            let templates: Value = serde_json::from_str(include_str!("init-templates.json"))
                .expect("checked in source templates");
            for template in templates[if cfg!(windows) { "windows" } else { "posix" }]
                .as_array()
                .unwrap()
            {
                let path = hooks.join(template["filename"].as_str().unwrap());
                if !path.exists() {
                    tx.write(&path, template["content"].as_str().unwrap().as_bytes())?;
                }
            }
            tx.mkdir(&repos_path)?;
            if !args.has("no-discover") {
                eprintln!("- Discovering repositories...");
                let mut current = serde_json::Map::new();
                discover_children(&repos_path, &mut current)?;
                if current != discovered {
                    return Err(unsupported(
                        "Repository discovery changed during initialization",
                    ));
                }
                eprintln!(
                    "✔ Found {} {}",
                    discovered.len(),
                    if discovered.len() == 1 {
                        "repository"
                    } else {
                        "repositories"
                    }
                );
            }
            tx.write(
                &config_path,
                serde_json::to_string_pretty(&config).unwrap().as_bytes(),
            )?;
            Ok(())
        })();
        if let Err(e) = operation {
            let errors = tx.rollback();
            return Err(Error::new("INIT_FAILED", e.message)
                .with_details(json!({"rollbackErrors":errors,"workspaceRoot":root})));
        }
    }
    Ok(
        json!({"configPath":config_path,"discoveredCount":discovered.len(),"exitCode":0,"hooksPath":hooks,"managedIgnore":ignore.data,"reposPath":repos_path,"success":true,"worktreesDir":worktrees,"workspaceRoot":root}),
    )
}
fn discover_children(path: &Path, found: &mut serde_json::Map<String, Value>) -> Result<()> {
    let mut entries = fs::read_dir(path)?.collect::<std::result::Result<Vec<_>, _>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if entry.file_type()?.is_symlink() {
            return Err(crate::managed::unsupported(
                "Symlinked repository discovery is not yet ported",
            ));
        }
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let path = entry.path();
        if path.join(".git").exists() {
            let records = git::worktrees(&path)?;
            if !records.first().is_some_and(|w| !w.bare && w.path == path) {
                return Err(crate::managed::unsupported(
                    "Linked/bare repository init discovery is not yet ported",
                ));
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if found.contains_key(&name) {
                return Err(crate::managed::unsupported(
                    "Duplicate repository names in discovery",
                ));
            }
            found.insert(name, json!({"path":path}));
        } else {
            discover_children(&path, found)?;
        }
    }
    Ok(())
}
