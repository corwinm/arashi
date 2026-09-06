//! Sanitized, read-only inspection for configured workspaces.
use crate::{Error, Result, config::Workspace};
use serde_json::{Map, Value, json};
use std::{fs, path::Path};

const LIFECYCLES: [&str; 4] = ["pre-create", "post-create", "pre-remove", "post-remove"];
const SCOPES: [&str; 6] = [
    "workspace-settings",
    "workspace-hooks",
    "command-defaults",
    "editor-defaults",
    "meta-policy",
    "repository",
];

struct SettingDescriptor {
    id: String,
    scope: &'static str,
    ownership: &'static str,
    accepted_shape: &'static str,
    safe_display: &'static str,
}

fn workspace_descriptors() -> Vec<SettingDescriptor> {
    let mut result = vec![
        workspace_descriptor(
            "reposDir",
            "workspace-settings",
            "workspace",
            "workspace-relative-path",
            "value",
        ),
        workspace_descriptor(
            "worktreesDir",
            "workspace-settings",
            "workspace",
            "workspace-relative-path",
            "value",
        ),
        workspace_descriptor(
            "baseBranch",
            "workspace-settings",
            "workspace",
            "git-branch",
            "value",
        ),
        workspace_descriptor(
            "sync.timeoutSeconds",
            "workspace-settings",
            "workspace",
            "non-negative-number-seconds",
            "value",
        ),
        workspace_descriptor(
            "hooks.timeout",
            "workspace-hooks",
            "workspace-hooks",
            "positive-integer-milliseconds",
            "value",
        ),
    ];
    result.extend(LIFECYCLES.map(|lifecycle| {
        workspace_descriptor(
            &format!("hooks.scripts.{lifecycle}"),
            "workspace-hooks",
            "workspace-hooks",
            "inline-bash-or-interpreter-map-or-native-file",
            "source-presence",
        )
    }));
    result.extend([
        workspace_descriptor(
            "defaults.create.switch",
            "command-defaults",
            "command",
            "boolean",
            "value",
        ),
        workspace_descriptor(
            "defaults.create.launch",
            "command-defaults",
            "command",
            "create-launch-mode",
            "value",
        ),
        workspace_descriptor(
            "defaults.switch.mode",
            "command-defaults",
            "command",
            "switch-mode",
            "value",
        ),
    ]);
    for editor in ["vscode", "cursor", "kiro"] {
        result.push(workspace_descriptor(
            &format!("defaults.editors.{editor}.create.switch"),
            "editor-defaults",
            "editor",
            "boolean",
            "value",
        ));
        result.push(workspace_descriptor(
            &format!("defaults.editors.{editor}.create.launch"),
            "editor-defaults",
            "editor",
            "create-launch-mode",
            "value",
        ));
    }
    result.push(workspace_descriptor(
        "meta.baseBranch",
        "meta-policy",
        "meta",
        "git-branch",
        "value",
    ));
    result
}
fn workspace_descriptor(
    id: &str,
    scope: &'static str,
    ownership: &'static str,
    accepted_shape: &'static str,
    safe_display: &'static str,
) -> SettingDescriptor {
    SettingDescriptor {
        id: id.into(),
        scope,
        ownership,
        accepted_shape,
        safe_display,
    }
}
fn effective_resolver(id: &str) -> &'static str {
    if id == "meta.baseBranch" {
        "workspace-inheritance"
    } else if id == "worktreesDir"
        || id == "sync.timeoutSeconds"
        || id == "hooks.timeout"
        || id.ends_with(".create.switch")
        || id.ends_with(".create.launch")
        || id == "defaults.switch.mode"
    {
        "built-in"
    } else {
        "none"
    }
}
fn descriptor_json(entry: &SettingDescriptor) -> Value {
    json!({
        "acceptedShape": entry.accepted_shape,
        "canonicalPath": entry.id,
        "clearable": entry.id != "reposDir",
        "effectiveResolver": effective_resolver(&entry.id),
        "id": entry.id,
        "ownership": entry.ownership,
        "purpose": format!("Configure {}", entry.id),
        "safeDisplay": entry.safe_display,
        "scope": entry.scope,
        "validationAdapter": if entry.accepted_shape.contains("native-file") { "canonical-config-and-active-path" } else { "canonical-config" }
    })
}
fn get_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.')
        .try_fold(value, |current, key| current.as_object()?.get(key))
}
fn aliases(path: &str) -> Vec<String> {
    match path {
        "reposDir" => vec!["reposDir".into(), "repos_dir".into()],
        "worktreesDir" => vec!["worktreesDir".into(), "worktrees_dir".into()],
        "sync.timeoutSeconds" => vec!["sync.timeoutSeconds".into(), "sync.timeout_seconds".into()],
        "defaults.create.launch" => vec![
            "defaults.create.launch".into(),
            "defaults.create.launchMode".into(),
            "defaults.create.launch_mode".into(),
        ],
        "defaults.switch.mode" => vec![
            "defaults.switch.mode".into(),
            "defaults.switch.launchMode".into(),
            "defaults.switch.launch_mode".into(),
        ],
        _ if path.contains(".create.launch") => vec![
            path.into(),
            path.replace(".launch", ".launchMode"),
            path.replace(".launch", ".launch_mode"),
        ],
        _ => vec![path.into()],
    }
}
fn hook_presence(value: &Value, lifecycle: &str) -> Value {
    let mut interpreters = if value.is_string() {
        vec!["bash".to_owned()]
    } else {
        value
            .as_object()
            .map(|map| map.keys().cloned().collect())
            .unwrap_or_default()
    };
    interpreters.sort();
    json!({"interpreters":interpreters,"lifecycle":lifecycle,"sourceKind":"inline-config"})
}
fn built_in(id: &str) -> Option<Value> {
    match id {
        "worktreesDir" => Some(json!(".arashi/worktrees")),
        "sync.timeoutSeconds" => Some(json!(300)),
        "hooks.timeout" => Some(json!(300_000)),
        "defaults.create.switch" => Some(json!(false)),
        "defaults.create.launch" => Some(json!("none")),
        "defaults.switch.mode" => Some(json!("launch")),
        _ if id.ends_with(".create.switch") => Some(json!(false)),
        _ if id.ends_with(".create.launch") => Some(json!("none")),
        _ => None,
    }
}
fn insert(map: &mut Map<String, Value>, key: &str, value: impl Into<Value>) {
    map.insert(key.into(), value.into());
}

fn workspace_settings(candidate: &Value, persisted: &Value, native: &[Value]) -> Vec<Value> {
    workspace_descriptors()
        .into_iter()
        .map(|entry| {
            let persisted_path = aliases(&entry.id)
                .into_iter()
                .find(|path| get_path(persisted, path).is_some());
            let configured_value = persisted_path
                .as_ref()
                .and_then(|_| get_path(candidate, &entry.id));
            let mut row = Map::new();
            insert(&mut row, "canonicalPath", entry.id.clone());
            insert(&mut row, "configured", configured_value.is_some());
            if let Some(value) = configured_value {
                let value = if entry.safe_display == "source-presence" {
                    hook_presence(value, entry.id.strip_prefix("hooks.scripts.").unwrap())
                } else {
                    value.clone()
                };
                insert(&mut row, "configuredValue", value);
            }
            insert(&mut row, "descriptor", descriptor_json(&entry));
            if configured_value.is_none() {
                let effective = if entry.id == "meta.baseBranch" {
                    get_path(candidate, "baseBranch")
                        .map(|value| json!({"source":"inherited","value":value}))
                } else {
                    built_in(&entry.id).map(|value| json!({"source":"built-in","value":value}))
                };
                if let Some(value) = effective {
                    insert(&mut row, "effective", value);
                }
            }
            insert(&mut row, "id", entry.id.clone());
            if let Some(path) = persisted_path {
                insert(&mut row, "persistedPath", path);
            }
            insert(&mut row, "scope", entry.scope);
            if let Some(lifecycle) = entry.id.strip_prefix("hooks.scripts.")
                && let Some(source) = native.iter().find(|source| {
                    source["scope"] == "workspace" && source["lifecycle"] == lifecycle
                })
            {
                insert(&mut row, "nativeSource", source.clone());
            }
            Value::Object(row)
        })
        .collect()
}

struct RepositoryDescriptor {
    id: &'static str,
    label: &'static str,
    accepted: &'static str,
    sensitive: bool,
    action: &'static str,
    projection: &'static str,
    validation: &'static str,
}
fn repository_descriptors() -> [RepositoryDescriptor; 8] {
    [
        repo_descriptor(
            "groups",
            "Groups",
            "string-array",
            false,
            "config",
            "paths",
            "canonical-config",
        ),
        repo_descriptor(
            "baseBranch",
            "Base branch",
            "git-branch",
            false,
            "config",
            "paths",
            "canonical-config",
        ),
        repo_descriptor(
            "copy",
            "Copy paths",
            "repository-relative-string-array",
            false,
            "config",
            "paths",
            "canonical-config",
        ),
        repo_descriptor(
            "symlink",
            "Symlink paths",
            "repository-relative-string-array",
            false,
            "config",
            "paths",
            "canonical-config",
        ),
        repo_descriptor(
            "pre-create",
            "pre-create",
            "inline-bash-or-interpreter-map-or-native-file",
            true,
            "inline-or-file",
            "source-presence",
            "canonical-config-and-active-path",
        ),
        repo_descriptor(
            "post-create",
            "post-create",
            "inline-bash-or-interpreter-map-or-native-file",
            true,
            "inline-or-file",
            "source-presence",
            "canonical-config-and-active-path",
        ),
        repo_descriptor(
            "pre-remove",
            "pre-remove",
            "inline-bash-or-interpreter-map-or-native-file",
            true,
            "inline-or-file",
            "source-presence",
            "canonical-config-and-active-path",
        ),
        repo_descriptor(
            "post-remove",
            "post-remove",
            "inline-bash-or-interpreter-map-or-native-file",
            true,
            "inline-or-file",
            "source-presence",
            "canonical-config-and-active-path",
        ),
    ]
}
fn repo_descriptor(
    id: &'static str,
    label: &'static str,
    accepted: &'static str,
    sensitive: bool,
    action: &'static str,
    projection: &'static str,
    validation: &'static str,
) -> RepositoryDescriptor {
    RepositoryDescriptor {
        id,
        label,
        accepted,
        sensitive,
        action,
        projection,
        validation,
    }
}
fn repository_descriptor_json(entry: &RepositoryDescriptor) -> Value {
    let canonical = if LIFECYCLES.contains(&entry.id) {
        format!("repos.<name>.hooks.{}", entry.id)
    } else {
        format!("repos.<name>.{}", entry.id)
    };
    json!({
        "acceptedShape":entry.accepted,"action":entry.action,"canonicalPath":canonical,
        "effectiveResolver":if entry.id == "baseBranch" { "workspace-inheritance" } else { "none" },
        "id":entry.id,"label":entry.label,"ownership":"repository","precedence":"explicit-editor",
        "projection":entry.projection,"purpose":format!("Configure repository {}",entry.id),
        "safeDisplay":if entry.sensitive { "source-presence" } else { "value" },"scope":"repository",
        "sensitive":entry.sensitive,"validation":entry.validation,"validationAdapter":entry.validation
    })
}
fn persisted_repositories(persisted: &Value) -> Option<&Map<String, Value>> {
    ["repos", "discoveredRepos", "discovered_repos"]
        .into_iter()
        .find_map(|key| persisted.get(key)?.as_object())
}
fn repository_settings(
    name: &str,
    repo: &Value,
    persisted_repo: Option<&Value>,
    workspace_base: Option<&Value>,
    native: &[Value],
) -> Vec<Value> {
    repository_descriptors()
        .into_iter()
        .map(|entry| {
            let relative = if entry.sensitive {
                format!("hooks.{}", entry.id)
            } else {
                entry.id.into()
            };
            let value = get_path(repo, &relative);
            let persisted_value = persisted_repo.and_then(|repo| get_path(repo, &relative));
            let mut row = Map::new();
            insert(
                &mut row,
                "canonicalPath",
                format!(
                    "repos.{name}.{}",
                    if entry.sensitive {
                        format!("hooks.{}", entry.id)
                    } else {
                        entry.id.into()
                    }
                ),
            );
            insert(&mut row, "configured", persisted_value.is_some());
            if persisted_value.is_some()
                && let Some(value) = value
            {
                insert(
                    &mut row,
                    "configuredValue",
                    if entry.sensitive {
                        hook_presence(value, entry.id)
                    } else {
                        value.clone()
                    },
                );
            }
            insert(&mut row, "descriptor", repository_descriptor_json(&entry));
            if entry.id == "baseBranch"
                && value.is_none()
                && let Some(base) = workspace_base
            {
                insert(
                    &mut row,
                    "effective",
                    json!({"source":"inherited","value":base}),
                );
            }
            insert(&mut row, "id", entry.id);
            if entry.sensitive
                && let Some(source) = native.iter().find(|source| {
                    source["scope"] == "repository"
                        && source["ownerName"] == name
                        && source["lifecycle"] == entry.id
                })
            {
                insert(&mut row, "nativeSource", source.clone());
            }
            Value::Object(row)
        })
        .collect()
}

fn native_extension_matches(filename: &str, stem: &str) -> bool {
    if cfg!(windows) {
        ["ps1", "cmd", "bat"]
            .iter()
            .any(|extension| filename.eq_ignore_ascii_case(&format!("{stem}.{extension}")))
    } else {
        filename == format!("{stem}.sh")
    }
}
fn has_native(directory: &Path, stem: &str) -> Result<bool> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        if native_extension_matches(&entry.file_name().to_string_lossy(), stem) {
            return Ok(true);
        }
    }
    Ok(false)
}
fn native_sources(workspace: &Workspace) -> Result<Vec<Value>> {
    let config = workspace.config.as_ref().unwrap();
    let hooks = workspace.root.join(".arashi/hooks");
    let mut sources = Vec::new();
    for lifecycle in LIFECYCLES {
        if has_native(&hooks, lifecycle)? {
            sources.push(json!({"lifecycle":lifecycle,"scope":"workspace","sourceKind":"file"}));
        }
    }
    for name in &config.repo_order {
        let repo = &config.repos[name];
        let root_repository = repo.path == "."
            || crate::paths::same_existing(&workspace.root, workspace.root.join(&repo.path))
                .unwrap_or(false);
        for lifecycle in LIFECYCLES {
            if root_repository && matches!(lifecycle, "pre-remove" | "post-remove") {
                continue;
            }
            let present = if matches!(lifecycle, "pre-create" | "post-create") {
                has_native(&hooks, &format!("{lifecycle}.{name}"))?
            } else {
                let canonical = has_native(&hooks, &format!("{lifecycle}.{name}"))?;
                let compatible = if root_repository {
                    false
                } else {
                    has_native(
                        &workspace.root.join(&repo.path).join(".arashi/hooks"),
                        lifecycle,
                    )?
                };
                canonical || compatible
            };
            if present {
                sources.push(json!({"lifecycle":lifecycle,"ownerName":name,"scope":"repository","sourceKind":"file"}));
            }
        }
    }
    Ok(sources)
}
fn reject_linked(cwd: &Path) -> Result<()> {
    let top = crate::git::run(cwd, &["rev-parse", "--show-toplevel"])?;
    let git_dir = crate::git::run(cwd, &["rev-parse", "--absolute-git-dir"])?;
    let top_git = Path::new(top.trim()).join(".git");
    if !crate::paths::same_existing(Path::new(git_dir.trim()), &top_git).unwrap_or(false) {
        return Err(Error::new(
            "UNSUPPORTED_TOPOLOGY",
            "Linked worktree configure inspection is not yet supported by the Rust port",
        ));
    }
    Ok(())
}

pub fn inspect(cwd: &Path) -> Result<Value> {
    let workspace = Workspace::discover(cwd)?;
    reject_linked(cwd)?;
    let config = workspace.config.as_ref().ok_or_else(|| {
        Error::new(
            "CONFIG_NOT_FOUND",
            "configure requires a configured workspace",
        )
    })?;
    let persisted = &config.persisted;
    let native = native_sources(&workspace)?;
    let persisted_repos = persisted_repositories(persisted);
    let repositories = config.repo_order.iter().map(|name| {
        let repo = &config.repos[name];
        json!({
            "canonicalPath":format!("repos.{name}"),
            "name":name,
            "settings":repository_settings(name, &repo.raw, persisted_repos.and_then(|repos| repos.get(name)), config.raw.get("baseBranch"), &native)
        })
    }).collect::<Vec<_>>();
    Ok(json!({
        "nativeSources":native,
        "repositories":repositories,
        "scopes":SCOPES,
        "settings":workspace_settings(&config.raw, persisted, &native)
    }))
}
