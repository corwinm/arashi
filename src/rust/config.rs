use crate::{Error, Result};
use serde_json::{Map, Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Debug, Clone)]
pub struct RepoConfig {
    pub path: String,
    pub raw: Value,
}
#[derive(Debug, Clone)]
pub struct Config {
    pub raw: Value,
    pub repos_dir: String,
    pub worktrees_dir: String,
    pub repos: BTreeMap<String, RepoConfig>,
    pub repo_order: Vec<String>,
}
fn invalid(message: impl Into<String>) -> Error {
    Error::new("CONFIG_VALIDATION_ERROR", message)
}
fn object<'a>(v: &'a Value, scope: &str) -> Result<&'a Map<String, Value>> {
    v.as_object()
        .ok_or_else(|| invalid(format!("{scope}: must be an object")))
}
fn keys(v: &Value, allowed: &[&str], scope: &str) -> Result<()> {
    for key in object(v, scope)?.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(invalid(format!("{scope}.{key}: unknown property")));
        }
    }
    Ok(())
}
fn nonempty(v: &Value, scope: &str) -> Result<String> {
    v.as_str()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("{scope}: must be a non-empty string")))
}
fn alias(v: &mut Value, new: &str, old: &[&str]) {
    if v.get(new).is_none() {
        for key in old {
            if let Some(value) = v.get(*key).cloned() {
                v[new] = value;
                break;
            }
        }
    }
    for key in old {
        v.as_object_mut().unwrap().remove(*key);
    }
}
fn branch(v: &Value, scope: &str) -> Result<()> {
    let s = nonempty(v, scope)?;
    let s = s.strip_prefix("origin/").unwrap_or(&s);
    if s == "HEAD"
        || s == "@"
        || s.starts_with(['-', '.', '/'])
        || s.ends_with(['.', '/'])
        || s.contains("..")
        || s.contains("//")
        || s.contains("@{")
        || s.chars()
            .any(|c| c.is_control() || c.is_whitespace() || "~^:?*[\\".contains(c))
        || s.split('/')
            .any(|c| c.starts_with('.') || c.ends_with(".lock"))
    {
        return Err(invalid(format!(
            "{scope}: must be a valid Git branch name if present"
        )));
    }
    Ok(())
}
fn hooks(v: &Value, scope: &str) -> Result<()> {
    keys(
        v,
        &["pre-create", "post-create", "pre-remove", "post-remove"],
        scope,
    )?;
    for (name, hook) in object(v, scope)? {
        let name = format!("{scope}.{name}");
        if hook.is_string() {
            nonempty(hook, &name)?;
        } else {
            keys(hook, &["bash", "powershell", "cmd"], &name)?;
            if object(hook, &name)?.is_empty() {
                return Err(invalid(format!(
                    "{name}: must be a non-empty interpreter map"
                )));
            }
            for val in object(hook, &name)?.values() {
                nonempty(val, &name)?;
            }
        }
    }
    Ok(())
}
fn choice(v: &Value, choices: &[&str], scope: &str) -> Result<()> {
    if !v.as_str().is_some_and(|s| choices.contains(&s)) {
        return Err(invalid(format!("{scope}: invalid value")));
    }
    Ok(())
}
fn integer(v: &Value, scope: &str) -> Result<()> {
    if !v.as_u64().is_some_and(|n| (1..=2_147_483_647).contains(&n)) {
        return Err(invalid(format!(
            "{scope}: must be an integer from 1 through 2147483647"
        )));
    }
    Ok(())
}
fn defaults(v: &mut Value) -> Result<()> {
    keys(v, &["create", "editors", "switch"], "defaults")?;
    if let Some(create) = v.get_mut("create") {
        create_defaults(create)?;
    }
    if let Some(editors) = v.get_mut("editors") {
        keys(editors, &["vscode", "cursor", "kiro"], "defaults.editors")?;
        for editor in editors.as_object_mut().unwrap().values_mut() {
            keys(editor, &["create"], "defaults.editors.editor")?;
            if let Some(create) = editor.get_mut("create") {
                create_defaults(create)?;
            }
        }
    }
    if let Some(s) = v.get_mut("switch") {
        keys(s, &["mode", "launchMode", "launch_mode"], "defaults.switch")?;
        alias(s, "mode", &["launchMode", "launch_mode"]);
        if let Some(mode) = s.get("mode") {
            choice(
                mode,
                &["auto", "cd", "launch", "sesh", "herdr"],
                "defaults.switch.mode",
            )?;
        }
    }
    Ok(())
}
fn create_defaults(v: &mut Value) -> Result<()> {
    keys(
        v,
        &["switch", "launch", "launchMode", "launch_mode"],
        "defaults.create",
    )?;
    alias(v, "launch", &["launchMode", "launch_mode"]);
    if v.get("switch").is_some_and(|s| !s.is_boolean()) {
        return Err(invalid("defaults.create.switch: must be a boolean"));
    }
    if let Some(l) = v.get("launch") {
        choice(
            l,
            &["none", "auto", "sesh", "herdr"],
            "defaults.create.launch",
        )?;
    }
    Ok(())
}
fn normalize_relative(s: &str) -> Result<String> {
    let s = s.trim().replace('\\', "/");
    if s.starts_with('/') || s.as_bytes().get(1) == Some(&b':') {
        return Err(invalid("worktreesDir: must be a relative path"));
    }
    if s.is_empty() {
        return Err(invalid("worktreesDir: must be non-empty"));
    }
    let mut parts: Vec<&str> = vec![];
    for p in s.split('/') {
        match p {
            "" | "." => {}
            ".." if parts.last().is_some_and(|p| *p != "..") => {
                parts.pop();
            }
            _ => parts.push(p),
        }
    }
    Ok(if parts.is_empty() {
        ".".to_owned()
    } else {
        parts.join("/")
    })
}
fn normalize_materialization(raw: &str) -> Result<String> {
    if raw.starts_with(['/', '\\'])
        || raw
            .chars()
            .any(|c| c.is_control() || ":<>\"|?*".contains(c))
    {
        return Err(invalid(
            "materialization path must be a portable relative path",
        ));
    }
    let normalized = raw.replace('\\', "/");
    let mut parts = Vec::new();
    for component in normalized.split('/') {
        if component == ".." {
            return Err(invalid(
                "materialization path must not contain '..' segments",
            ));
        }
        if component.is_empty() || component == "." {
            continue;
        }
        let lower = component.to_lowercase();
        let device = lower.split('.').next().unwrap_or("");
        if component.ends_with(['.', ' '])
            || ["con", "prn", "aux", "nul"].contains(&device)
            || ((device.starts_with("com") || device.starts_with("lpt"))
                && device.len() == 4
                && device.as_bytes()[3].is_ascii_digit()
                && device.as_bytes()[3] != b'0')
        {
            return Err(invalid(
                "materialization path contains a Windows reserved component",
            ));
        }
        parts.push(component);
    }
    if parts.is_empty() || parts[0].eq_ignore_ascii_case(".git") {
        return Err(invalid(
            "materialization path is empty or targets reserved .git",
        ));
    }
    Ok(parts.join("/"))
}
impl Config {
    pub fn parse(text: &str) -> Result<Self> {
        let mut v: Value = serde_json::from_str(text).map_err(|e| {
            Error::new(
                "CONFIG_PARSE_ERROR",
                format!("Failed to parse configuration: {e}"),
            )
        })?;
        keys(
            &v,
            &[
                "$schema",
                "version",
                "reposDir",
                "repos_dir",
                "worktreesDir",
                "worktrees_dir",
                "worktreeNaming",
                "repos",
                "discoveredRepos",
                "discovered_repos",
                "hooks",
                "sync",
                "defaults",
                "baseBranch",
                "meta",
            ],
            "config",
        )?;
        let version = nonempty(&v["version"], "version")?;
        if !["1", "1.0.0"].contains(&version.trim()) {
            return Err(Error::new(
                "UNSUPPORTED_CONFIG_VERSION",
                format!(
                    "Unsupported configuration version \"{version}\". This version of arashi supports \"1.0.0\"."
                ),
            ));
        }
        v["version"] = json!("1.0.0");
        alias(&mut v, "reposDir", &["repos_dir"]);
        alias(&mut v, "worktreesDir", &["worktrees_dir"]);
        alias(&mut v, "repos", &["discoveredRepos", "discovered_repos"]);
        let repos_dir = nonempty(&v["reposDir"], "reposDir")?;
        let worktrees_dir = match v.get("worktreesDir") {
            Some(s) => normalize_relative(&nonempty(s, "worktreesDir")?)?,
            None => ".arashi/worktrees".into(),
        };
        v["worktreesDir"] = json!(worktrees_dir);
        if let Some(s) = v.get("$schema") {
            nonempty(s, "$schema")?;
        }
        if let Some(b) = v.get("baseBranch") {
            branch(b, "baseBranch")?;
        }
        if let Some(m) = v.get("meta") {
            keys(m, &["baseBranch"], "meta")?;
            if let Some(b) = m.get("baseBranch") {
                branch(b, "meta.baseBranch")?;
            }
        }
        if let Some(n) = v.get("worktreeNaming") {
            keys(
                n,
                &["style", "branchSlashes", "maxPathLength"],
                "worktreeNaming",
            )?;
            if let Some(s) = n.get("style") {
                choice(
                    s,
                    &["default", "branch", "repo-branch"],
                    "worktreeNaming.style",
                )?;
            }
            if let Some(s) = n.get("branchSlashes") {
                choice(s, &["preserve", "flatten"], "worktreeNaming.branchSlashes")?;
            }
            if let Some(s) = n.get("maxPathLength") {
                integer(s, "worktreeNaming.maxPathLength")?;
            }
        }
        if let Some(h) = v.get("hooks") {
            keys(h, &["timeout", "scripts"], "hooks")?;
            if let Some(t) = h.get("timeout") {
                integer(t, "hooks.timeout")?;
            }
            if let Some(s) = h.get("scripts") {
                hooks(s, "hooks.scripts")?;
            }
        }
        if let Some(s) = v.get_mut("sync") {
            keys(s, &["timeoutSeconds", "timeout_seconds"], "sync")?;
            alias(s, "timeoutSeconds", &["timeout_seconds"]);
            if s.get("timeoutSeconds")
                .is_some_and(|t| !t.as_f64().is_some_and(|n| n >= 0.0 && n.is_finite()))
            {
                return Err(invalid(
                    "sync.timeoutSeconds: must be a non-negative number",
                ));
            }
        }
        if let Some(d) = v.get_mut("defaults") {
            defaults(d)?;
        }
        object(&v["repos"], "repos")?;
        let mut repos = BTreeMap::new();
        for (name, repo) in v["repos"].as_object_mut().unwrap() {
            if name == "@meta" {
                return Err(invalid(
                    "repos.@meta: '@meta' is reserved for the meta repository selector",
                ));
            }
            keys(
                repo,
                &[
                    "path",
                    "copy",
                    "symlink",
                    "gitUrl",
                    "git_url",
                    "defaultBranch",
                    "default_branch",
                    "isBare",
                    "is_bare",
                    "worktrees",
                    "groups",
                    "hooks",
                    "baseBranch",
                ],
                &format!("repos.{name}"),
            )?;
            alias(repo, "gitUrl", &["git_url"]);
            for k in [
                "defaultBranch",
                "default_branch",
                "isBare",
                "is_bare",
                "worktrees",
            ] {
                repo.as_object_mut().unwrap().remove(k);
            }
            let path = nonempty(&repo["path"], &format!("repos.{name}.path"))?;
            if let Some(g) = repo.get("gitUrl") {
                nonempty(g, "gitUrl")?;
            }
            if let Some(b) = repo.get("baseBranch") {
                branch(b, "baseBranch")?;
            }
            if let Some(h) = repo.get("hooks") {
                hooks(h, "hooks")?;
            }
            if let Some(groups) = repo.get_mut("groups") {
                let groups = groups
                    .as_array_mut()
                    .ok_or_else(|| invalid("groups: must be an array of non-empty strings"))?;
                let mut seen = std::collections::BTreeSet::new();
                for group in groups {
                    let g = nonempty(group, "groups")?.trim().to_string();
                    if !seen.insert(g.to_lowercase()) {
                        return Err(invalid("groups: duplicate group"));
                    }
                    *group = json!(g);
                }
            }
            let mut seen = std::collections::BTreeSet::new();
            for field in ["copy", "symlink"] {
                if let Some(paths) = repo.get_mut(field) {
                    let paths = paths
                        .as_array_mut()
                        .ok_or_else(|| invalid(format!("{field}: must be an array")))?;
                    for p in paths {
                        let path = normalize_materialization(&nonempty(p, field)?)?;
                        if !seen.insert(path.to_lowercase()) {
                            return Err(invalid(format!(
                                "{field}: duplicate or portable collision"
                            )));
                        }
                        *p = json!(path);
                    }
                }
            }
            repos.insert(
                name.clone(),
                RepoConfig {
                    path,
                    raw: repo.clone(),
                },
            );
        }
        let source: BTreeMap<String, Box<serde_json::value::RawValue>> =
            serde_json::from_str(text).map_err(|e| invalid(e.to_string()))?;
        let repo_source = source
            .get("repos")
            .or_else(|| source.get("discoveredRepos"))
            .or_else(|| source.get("discovered_repos"))
            .ok_or_else(|| invalid("repos missing"))?;
        let repo_order = ordered_keys(repo_source.get())?;
        Ok(Self {
            repo_order,
            raw: v,
            repos_dir,
            worktrees_dir,
            repos,
        })
    }
    pub fn load(root: &Path) -> Result<Self> {
        Self::parse(&fs::read_to_string(root.join(".arashi/config.json"))?)
    }
}
#[derive(Debug, Clone)]
pub struct Workspace {
    pub root: PathBuf,
    pub config: Option<Config>,
}
fn absolute(path: &Path) -> Result<PathBuf> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut result = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            _ => result.push(c.as_os_str()),
        }
    }
    Ok(result)
}
fn workspace_root(root: &Path) -> Result<PathBuf> {
    #[cfg(windows)]
    {
        // Git expands Windows short names and case aliases. Retain one physical
        // spelling for coordinated destination planning and rollback ownership.
        crate::managed::safe(root)?;
        Ok(crate::paths::canonicalize(root)?)
    }
    #[cfg(not(windows))]
    {
        Ok(root.to_path_buf())
    }
}
impl Workspace {
    pub fn discover(cwd: &Path) -> Result<Self> {
        let cwd = absolute(cwd)?;
        for root in cwd.ancestors() {
            let p = root.join(".arashi/config.json");
            if p.try_exists()? {
                let config = Config::load(root)?;
                if crate::git::worktrees(root)
                    .is_ok_and(|records| records.first().is_some_and(|primary| primary.bare))
                {
                    return Err(Error::new(
                        "UNSUPPORTED_TOPOLOGY",
                        "Linked worktrees of bare repositories are not yet supported by the Rust port",
                    ));
                }
                if crate::git::run(root, &["rev-parse", "--is-bare-repository"])
                    .is_ok_and(|s| s.trim() == "true")
                {
                    return Err(Error::new(
                        "UNSUPPORTED_TOPOLOGY",
                        "Configured bare repositories are not yet supported by the Rust port",
                    ));
                }
                return Ok(Self {
                    root: workspace_root(root)?,
                    config: Some(config),
                });
            }
        }
        let bare = crate::git::run(&cwd, &["rev-parse", "--is-bare-repository"]);
        if bare.as_ref().is_ok_and(|s| s.trim() == "true") {
            return Err(Error::new(
                "UNSUPPORTED_TOPOLOGY",
                "Bare repositories are not yet supported by the Rust port",
            ));
        }
        if let Some(primary) = crate::git::worktrees(&cwd)
            .ok()
            .and_then(|w| w.into_iter().next())
        {
            if primary.bare {
                return Err(Error::new(
                    "UNSUPPORTED_TOPOLOGY",
                    "Linked worktrees of bare repositories are not yet supported by the Rust port",
                ));
            }
            let main = absolute(&primary.path)?;
            for root in main.ancestors() {
                if root.join(".arashi/config.json").try_exists()? {
                    return Ok(Self {
                        root: workspace_root(root)?,
                        config: Some(Config::load(root)?),
                    });
                }
            }
            if main.join(".worktrees").is_dir() {
                return Ok(Self {
                    root: main,
                    config: None,
                });
            }
        }
        Err(Error::new(
            "CONFIG_NOT_FOUND",
            format!(
                "Configuration file not found at {}. Run \"arashi init\" to create it.",
                cwd.join(".arashi/config.json").display()
            ),
        ))
    }
    pub fn metadata(&self) -> Value {
        let (mode, repos, worktrees) = match &self.config {
            Some(c) => (
                "configured",
                self.root.join(&c.repos_dir),
                self.root.join(&c.worktrees_dir),
            ),
            None => (
                "standalone",
                self.root.clone(),
                self.root.join(".worktrees"),
            ),
        };
        json!({"mode":mode,"repositoriesBase":absolute(&repos).unwrap_or(repos),"workspaceRoot":self.root,"worktreesBase":absolute(&worktrees).unwrap_or(worktrees)})
    }
}

// Keep JavaScript Object.entries order without changing deterministic JSON rendering.
fn ordered_keys(text: &str) -> Result<Vec<String>> {
    struct Keys;
    impl<'de> serde::de::Visitor<'de> for Keys {
        type Value = Vec<String>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("repository object")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut map: M,
        ) -> std::result::Result<Self::Value, M::Error> {
            let mut keys = Vec::new();
            while let Some(key) = map.next_key::<String>()? {
                map.next_value::<serde::de::IgnoredAny>()?;
                if !keys.contains(&key) {
                    keys.push(key);
                }
            }
            keys.sort_by_key(|key| {
                key.parse::<u32>()
                    .ok()
                    .filter(|n| *n != u32::MAX && n.to_string() == *key)
                    .map_or((1, 0), |n| (0, n))
            });
            Ok(keys)
        }
    }
    serde::de::Deserializer::deserialize_map(&mut serde_json::Deserializer::from_str(text), Keys)
        .map_err(|e| invalid(e.to_string()))
}
