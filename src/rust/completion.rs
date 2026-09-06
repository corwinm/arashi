use serde_json::Value;
use std::{
    collections::{BTreeSet, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const CONTRACT: &str = include_str!("../../contracts/cli-commands.json");
const QUERY_BUDGET: Duration = Duration::from_millis(200);
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
const MAX_CONCURRENT_GIT: usize = 8;
const SHELLS: &str = "bash, zsh, fish, powershell";

fn query_budget() -> Duration {
    #[cfg(debug_assertions)]
    if let Some(milliseconds) = std::env::var("ARASHI_COMPLETION_TEST_BUDGET_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| (1..=5_000).contains(value))
    {
        return Duration::from_millis(milliseconds);
    }
    QUERY_BUDGET
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Candidate {
    value: String,
    description: String,
}

struct Context<'a> {
    command: Option<&'a Value>,
    current: String,
    option_assignment: String,
    end_of_options: bool,
    option: Option<&'a Value>,
    positional_index: usize,
    words_before_cursor: Vec<String>,
}

pub fn run(raw: &[String]) -> i32 {
    if raw.get(1).is_some_and(|value| value == "__query") {
        let Some(cursor) = raw.get(2).and_then(|value| value.parse::<usize>().ok()) else {
            return 0;
        };
        let mut start = 3;
        if raw.get(start).is_some_and(|value| value == "--") {
            start += 1;
        }
        let bytes = query(
            &raw[start..],
            cursor,
            &std::env::current_dir().unwrap_or_default(),
        );
        use std::io::Write;
        let _ = std::io::stdout().write_all(&bytes);
        return 0;
    }
    match raw.get(1).map(String::as_str) {
        None => {
            eprintln!("[ERR] Missing required shell. Supported shells: {SHELLS}.");
            2
        }
        Some(shell @ ("bash" | "zsh" | "fish" | "powershell")) if raw.len() == 2 => {
            print!("{}", render(shell));
            0
        }
        Some(shell) => {
            eprintln!("[ERR] Unsupported shell `{shell}`. Supported shells: {SHELLS}.");
            2
        }
    }
}

pub fn render(shell: &str) -> String {
    let marker = format!(
        "# arashi-completion-contract-v6:{}\n",
        sha256_hex(compact_json(CONTRACT).as_bytes())
    );
    marker
        + match shell {
            "bash" => BASH,
            "zsh" => ZSH,
            "fish" => FISH,
            "powershell" => POWERSHELL,
            _ => "",
        }
}

fn contract() -> Value {
    serde_json::from_str(CONTRACT).expect("checked-in CLI contract")
}

fn option_spellings(option: &Value) -> impl Iterator<Item = &str> {
    [option["short"].as_str(), option["long"].as_str()]
        .into_iter()
        .flatten()
}

fn command_for_path<'a>(contract: &'a Value, path: &str) -> Option<&'a Value> {
    contract["commands"].as_array()?.iter().find(|command| {
        !command["hidden"].as_bool().unwrap_or(false)
            && (command["path"].as_str() == Some(path)
                || command["aliasPaths"].as_array().is_some_and(|aliases| {
                    aliases.iter().any(|alias| alias.as_str() == Some(path))
                }))
    })
}

fn parse_context<'a>(contract: &'a Value, argv: &[String], cursor: usize) -> Context<'a> {
    let words = argv
        .iter()
        .take(cursor.saturating_add(1))
        .cloned()
        .collect::<Vec<_>>();
    let mut current = words.get(cursor).cloned().unwrap_or_default();
    let before = words
        .get(1..cursor.min(words.len()))
        .unwrap_or_default()
        .to_vec();
    let mut command = None;
    let mut command_path = String::new();
    let mut index = 0;
    while let Some(word) = before.get(index) {
        if word.starts_with('-') {
            break;
        }
        let candidate_path = if command_path.is_empty() {
            word.clone()
        } else {
            format!("{command_path} {word}")
        };
        let Some(next) = command_for_path(contract, &candidate_path) else {
            break;
        };
        command = Some(next);
        command_path = next["path"].as_str().unwrap_or_default().to_owned();
        index += 1;
    }
    let options = command
        .and_then(|value| value["options"].as_array())
        .or_else(|| contract["root"]["options"].as_array())
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut end_of_options = false;
    let mut positional_index = 0;
    while index < before.len() {
        let word = &before[index];
        if word == "--" {
            end_of_options = true;
            index += 1;
            continue;
        }
        if !end_of_options && word.starts_with('-') {
            let spelling = word.split_once('=').map_or(word.as_str(), |pair| pair.0);
            if let Some(option) = options
                .iter()
                .find(|option| option_spellings(option).any(|item| item == spelling))
                && option["valueShape"].as_str() != Some("boolean")
                && !word.contains('=')
            {
                index += 1;
            }
        } else {
            positional_index += 1;
        }
        index += 1;
    }
    let mut active_option = None;
    if !end_of_options
        && let Some(prior) = before.last()
        && !prior.contains('=')
    {
        active_option = options.iter().find(|option| {
            option["valueShape"].as_str() != Some("boolean")
                && option_spellings(option).any(|item| item == prior)
        });
    }
    let mut option_assignment = String::new();
    if !end_of_options
        && current.starts_with('-')
        && let Some(equals) = current.find('=')
    {
        let spelling = &current[..equals];
        if let Some(option) = options.iter().find(|option| {
            option["valueShape"].as_str() != Some("boolean")
                && option_spellings(option).any(|item| item == spelling)
        }) {
            active_option = Some(option);
            option_assignment = current[..=equals].to_owned();
            current = current[equals + 1..].to_owned();
        }
    }
    Context {
        command,
        current,
        option_assignment,
        end_of_options,
        option: active_option,
        positional_index,
        words_before_cursor: before,
    }
}

fn active_argument<'a>(context: &'a Context<'a>) -> Option<&'a Value> {
    let arguments = context.command?.get("arguments")?.as_array()?;
    arguments.get(context.positional_index).or_else(|| {
        arguments
            .last()
            .filter(|argument| argument["variadic"].as_bool() == Some(true))
    })
}

fn prefixed(mut candidates: Vec<Candidate>, prefix: &str, comma_segments: bool) -> Vec<Candidate> {
    let comma = comma_segments.then(|| prefix.rfind(',')).flatten();
    let leading = comma.map_or("", |at| &prefix[..=at]);
    let segment = comma.map_or(prefix, |at| prefix[at + 1..].trim());
    let normalized = segment.to_lowercase();
    candidates.retain(|candidate| candidate.value.to_lowercase().starts_with(&normalized));
    for candidate in &mut candidates {
        candidate.value = format!("{leading}{}", candidate.value);
    }
    candidates.sort_by(|left, right| left.value.cmp(&right.value));
    candidates
}

fn choices(
    owner: &Value,
    context: &Context<'_>,
    description: impl Fn(&str) -> String,
) -> Vec<Candidate> {
    let values = owner["choices"].as_array().cloned().unwrap_or_default();
    prefixed(
        values
            .iter()
            .filter_map(Value::as_str)
            .map(|value| Candidate {
                value: value.to_owned(),
                description: description(value),
            })
            .collect(),
        &context.current,
        false,
    )
}

fn static_candidates(contract: &Value, context: &Context<'_>) -> Vec<Candidate> {
    if let Some(option) = context.option {
        return choices(option, context, |_| {
            format!("Value for {}", option["long"].as_str().unwrap_or_default())
        });
    }
    if let Some(argument) = active_argument(context)
        && argument["choices"]
            .as_array()
            .is_some_and(|values| !values.is_empty())
    {
        return choices(argument, context, |_| {
            argument["description"]
                .as_str()
                .unwrap_or_default()
                .to_owned()
        });
    }
    if let Some(argument) = active_argument(context)
        && argument["variadic"].as_bool() == Some(true)
        && context.positional_index
            >= context
                .command
                .and_then(|command| command["arguments"].as_array())
                .map_or(0, Vec::len)
    {
        return Vec::new();
    }
    let prefix = context
        .command
        .and_then(|command| command["path"].as_str())
        .unwrap_or_default();
    let mut candidates = Vec::new();
    for command in contract["commands"].as_array().into_iter().flatten() {
        if command["hidden"].as_bool().unwrap_or(false) {
            continue;
        }
        let path = command["path"].as_str().unwrap_or_default();
        let parent = path.rsplit_once(' ').map_or("", |pair| pair.0);
        if parent == prefix {
            let description = command["description"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            candidates.push(Candidate {
                value: path.rsplit(' ').next().unwrap_or_default().to_owned(),
                description: description.clone(),
            });
            for alias in command["aliases"].as_array().into_iter().flatten() {
                if let Some(alias) = alias.as_str() {
                    candidates.push(Candidate {
                        value: alias.to_owned(),
                        description: description.clone(),
                    });
                }
            }
        }
    }
    if !context.end_of_options {
        let options = context
            .command
            .and_then(|command| command["options"].as_array())
            .or_else(|| contract["root"]["options"].as_array())
            .map(Vec::as_slice)
            .unwrap_or_default();
        let mut present = HashSet::new();
        let mut blocked = HashSet::new();
        for word in context
            .words_before_cursor
            .iter()
            .filter(|word| word.starts_with('-'))
        {
            let spelling = word.split_once('=').map_or(word.as_str(), |pair| pair.0);
            present.insert(spelling.to_owned());
            if let Some(option) = options
                .iter()
                .find(|option| option_spellings(option).any(|item| item == spelling))
            {
                if let Some(long) = option["long"].as_str() {
                    present.insert(long.to_owned());
                }
                for conflict in option["conflicts"].as_array().into_iter().flatten() {
                    if let Some(conflict) = conflict.as_str() {
                        blocked.insert(conflict.to_owned());
                    }
                }
            }
        }
        for option in options {
            let long = option["long"].as_str().unwrap_or_default();
            let selector = option.pointer("/semanticPolicy/selector").is_some();
            let already_present =
                present.contains(long) && !selector && option["repeatable"].as_bool() != Some(true);
            let conflicts = option["conflicts"].as_array().is_some_and(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|item| present.contains(item))
            });
            if option["hidden"].as_bool().unwrap_or(false)
                || already_present
                || conflicts
                || option_spellings(option).any(|spelling| blocked.contains(spelling))
            {
                continue;
            }
            for value in option_spellings(option) {
                candidates.push(Candidate {
                    value: value.to_owned(),
                    description: option["description"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                });
            }
        }
    }
    prefixed(candidates, &context.current, false)
}

struct Repository {
    name: String,
    path: PathBuf,
    primary_path: Option<PathBuf>,
    synthetic_parent: bool,
}

struct Workspace {
    configured: bool,
    repositories: Vec<Repository>,
    groups: Vec<String>,
    root: PathBuf,
}

fn ordered_repositories(text: &str) -> Option<Vec<(String, Value)>> {
    use serde::de::{MapAccess, Visitor};
    use serde_json::value::RawValue;
    use std::collections::BTreeMap;

    let source: BTreeMap<String, Box<RawValue>> = serde_json::from_str(text).ok()?;
    let repositories = source
        .get("repos")
        .or_else(|| source.get("discoveredRepos"))
        .or_else(|| source.get("discovered_repos"))?;
    struct Entries;
    impl<'de> Visitor<'de> for Entries {
        type Value = Vec<(String, Value)>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("repository object")
        }
        fn visit_map<M: MapAccess<'de>>(
            self,
            mut map: M,
        ) -> std::result::Result<Self::Value, M::Error> {
            let mut entries = Vec::new();
            while let Some(name) = map.next_key::<String>()? {
                let repository = map.next_value::<Value>()?;
                entries.push((name, repository));
            }
            Ok(entries)
        }
    }
    serde::de::Deserializer::deserialize_map(
        &mut serde_json::Deserializer::from_str(repositories.get()),
        Entries,
    )
    .ok()
}

fn read_completion_config(path: &Path, deadline: Instant) -> Option<String> {
    if Instant::now() >= deadline {
        return None;
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(any(target_os = "linux", target_os = "android"))]
        const O_NONBLOCK: i32 = 0x800;
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        const O_NONBLOCK: i32 = 0x4;
        options.custom_flags(O_NONBLOCK);
    }
    let file = options.open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES {
        return None;
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES || Instant::now() >= deadline {
        return None;
    }
    String::from_utf8(bytes).ok()
}

fn workspace_from_roots(
    configuration_root: &Path,
    execution_root: &Path,
    deadline: Instant,
    bare_root: bool,
) -> Option<Workspace> {
    let path = configuration_root.join(".arashi/config.json");
    let text = read_completion_config(&path, deadline)?;
    let repos = ordered_repositories(&text)?;
    let mut repositories = vec![Repository {
        name: configuration_root
            .file_name()?
            .to_string_lossy()
            .into_owned(),
        path: execution_root.to_path_buf(),
        primary_path: (!bare_root).then(|| configuration_root.to_path_buf()),
        synthetic_parent: true,
    }];
    let mut groups = Vec::new();
    let mut seen_groups = BTreeSet::new();
    for (name, repository) in repos {
        let relative = repository["path"].as_str()?;
        repositories.push(Repository {
            name,
            path: execution_root.join(relative),
            primary_path: Some(configuration_root.join(relative)),
            synthetic_parent: false,
        });
        for group in repository["groups"].as_array().into_iter().flatten() {
            let group = group.as_str()?.trim();
            if !group.is_empty() && seen_groups.insert(group.to_lowercase()) {
                groups.push(group.to_owned());
            }
        }
    }
    Some(Workspace {
        configured: true,
        repositories,
        groups,
        root: execution_root.to_path_buf(),
    })
}

fn git_path(bytes: Vec<u8>) -> Option<PathBuf> {
    let mut value = String::from_utf8(bytes).ok()?;
    if value.ends_with('\n') {
        value.pop();
        if value.ends_with('\r') {
            value.pop();
        }
    }
    (!value.is_empty()).then(|| PathBuf::from(value))
}

fn filesystem_git_top(start: &Path) -> Option<PathBuf> {
    let mut directory = start.to_path_buf();
    loop {
        if fs::symlink_metadata(directory.join(".git")).is_ok() {
            return Some(directory);
        }
        if !directory.pop() {
            return None;
        }
    }
}

fn configured_common_root(start: &Path, deadline: Instant) -> Option<(PathBuf, PathBuf, bool)> {
    let mut checked = HashSet::new();
    let mut directory = start.to_path_buf();
    loop {
        if Instant::now() >= deadline {
            return None;
        }
        let raw_common = bounded_git(&directory, &["rev-parse", "--git-common-dir"], deadline)
            .and_then(git_path)?;
        let common_root = if raw_common.is_absolute() {
            raw_common
        } else {
            directory.join(raw_common)
        };
        let bare_root = common_root.file_name().is_none_or(|name| name != ".git");
        let configuration_root = if bare_root {
            common_root.clone()
        } else {
            common_root.parent()?.to_path_buf()
        };
        let top_level = filesystem_git_top(&directory).or_else(|| {
            bounded_git(&directory, &["rev-parse", "--show-toplevel"], deadline).and_then(git_path)
        });
        if checked.insert(configuration_root.clone())
            && configuration_root.join(".arashi/config.json").exists()
        {
            return Some((
                configuration_root,
                top_level.unwrap_or(common_root),
                bare_root,
            ));
        }
        let parent = top_level?.parent()?.to_path_buf();
        if parent == directory {
            return None;
        }
        directory = parent;
    }
}

fn workspace(cwd: &Path, deadline: Instant) -> Option<Workspace> {
    let mut directory = cwd.to_path_buf();
    loop {
        if Instant::now() >= deadline {
            return None;
        }
        if directory.join(".arashi/config.json").exists() {
            return workspace_from_roots(&directory, &directory, deadline, false);
        }
        if !directory.pop() {
            break;
        }
    }
    let common = git_path(bounded_git(
        cwd,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        deadline,
    )?)?;
    let bare_root = common.file_name().is_none_or(|name| name != ".git");
    let root = if bare_root {
        common.clone()
    } else {
        common.parent()?.to_path_buf()
    };
    let execution_root = filesystem_git_top(cwd).or_else(|| {
        bounded_git(cwd, &["rev-parse", "--show-toplevel"], deadline).and_then(git_path)
    });
    if root.join(".arashi/config.json").exists() {
        return workspace_from_roots(
            &root,
            &execution_root.unwrap_or_else(|| common.clone()),
            deadline,
            bare_root,
        );
    }
    if let Some(ancestor_root) = execution_root
        .as_deref()
        .and_then(Path::parent)
        .and_then(filesystem_git_top)
        && let Some((configuration_root, ancestor_execution_root, ancestor_bare_root)) =
            configured_common_root(&ancestor_root, deadline)
    {
        return workspace_from_roots(
            &configuration_root,
            &ancestor_execution_root,
            deadline,
            ancestor_bare_root,
        );
    }
    if root.join(".worktrees").is_dir() {
        return Some(Workspace {
            configured: false,
            repositories: vec![Repository {
                name: root.file_name()?.to_string_lossy().into_owned(),
                path: root.clone(),
                primary_path: Some(root.clone()),
                synthetic_parent: false,
            }],
            groups: Vec::new(),
            root,
        });
    }
    None
}

fn bounded_git(path: &Path, args: &[&str], deadline: Instant) -> Option<Vec<u8>> {
    if Instant::now() >= deadline {
        return None;
    }
    let mut child = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut output = Vec::new();
        if stdout.read_to_end(&mut output).is_ok() {
            let _ = sender.send(output);
        }
    });
    let mut status = None;
    loop {
        if status.is_none() {
            status = child.try_wait().ok()?;
        }
        if let Some(exit) = status {
            match receiver.try_recv() {
                Ok(output) => return exit.success().then_some(output),
                Err(std::sync::mpsc::TryRecvError::Disconnected) => return None,
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
            }
        }
        if Instant::now() >= deadline {
            if status.is_none() {
                let _ = child.kill();
            }
            let _ = child.wait();
            return None;
        }
        thread::sleep(Duration::from_millis(2));
    }
}

fn worktree_repositories<'a>(
    workspace: &'a Workspace,
    context: &Context<'_>,
) -> Vec<&'a Repository> {
    let command = context
        .command
        .and_then(|command| command["path"].as_str())
        .unwrap_or_default();
    if command != "switch"
        || context
            .words_before_cursor
            .iter()
            .any(|word| word == "--all")
    {
        return workspace.repositories.iter().collect();
    }
    let parent = workspace
        .repositories
        .iter()
        .filter(|repository| repository.path == workspace.root)
        .collect::<Vec<_>>();
    if context
        .words_before_cursor
        .iter()
        .any(|word| word == "--repos")
    {
        return workspace
            .repositories
            .iter()
            .filter(|repository| repository.path != workspace.root)
            .collect();
    }
    if parent.is_empty() {
        workspace.repositories.iter().take(1).collect()
    } else {
        parent
    }
}

fn worktree_candidates(
    workspace: &Workspace,
    context: &Context<'_>,
    deadline: Instant,
) -> Vec<Candidate> {
    let command = context
        .command
        .and_then(|command| command["path"].as_str())
        .unwrap_or_default();
    let paths_only = context
        .words_before_cursor
        .iter()
        .any(|word| word == "--path");
    let mut found = std::collections::BTreeMap::new();
    let mut repositories = worktree_repositories(workspace, context);
    repositories.sort_by_key(|repository| !repository.path.join(".git").exists());
    let mut outputs = Vec::new();
    for batch in repositories.chunks(MAX_CONCURRENT_GIT) {
        if Instant::now() >= deadline {
            break;
        }
        outputs.extend(thread::scope(|scope| {
            let handles = batch
                .iter()
                .copied()
                .map(|repository| {
                    scope.spawn(move || {
                        let output = bounded_git(
                            &repository.path,
                            &["worktree", "list", "--porcelain", "-z"],
                            deadline,
                        );
                        (repository, output)
                    })
                })
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .filter_map(|handle| handle.join().ok())
                .filter_map(|(repository, output)| output.map(|output| (repository, output)))
                .collect::<Vec<_>>()
        }));
    }
    for (repository, output) in outputs {
        let mut path = String::new();
        let mut branch = String::new();
        let mut bare = false;
        let mut prunable = false;
        let add = |found: &mut std::collections::BTreeMap<String, Candidate>,
                   path: &str,
                   branch: &str,
                   bare: bool,
                   prunable: bool| {
            if path.is_empty() || bare || prunable {
                return;
            }
            let candidate_path = PathBuf::from(path)
                .canonicalize()
                .unwrap_or_else(|_| PathBuf::from(path));
            if command == "remove"
                && let Some(primary_path) = &repository.primary_path
            {
                let primary = primary_path
                    .canonicalize()
                    .unwrap_or_else(|_| primary_path.clone());
                if candidate_path == primary {
                    return;
                }
            }
            let branch_suffix = if branch.is_empty() {
                String::new()
            } else {
                format!(" ({branch})")
            };
            let description = format!("{} worktree{branch_suffix}", repository.name);
            let basename = Path::new(path)
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_default();
            let values: Vec<&str> = if paths_only {
                vec![path]
            } else if command == "move" {
                if repository.path == workspace.root {
                    vec![branch, &basename, path]
                } else {
                    vec![branch, path]
                }
            } else if command == "remove" {
                if workspace.configured {
                    vec![branch, path]
                } else {
                    vec![branch]
                }
            } else {
                vec![&basename, branch, path]
            };
            for value in values.into_iter().filter(|value| !value.is_empty()) {
                found.insert(
                    value.to_owned(),
                    Candidate {
                        value: value.to_owned(),
                        description: description.clone(),
                    },
                );
            }
        };
        for record in output.split(|byte| *byte == 0) {
            let line = String::from_utf8_lossy(record);
            if line.is_empty() {
                add(&mut found, &path, &branch, bare, prunable);
                path.clear();
                branch.clear();
                bare = false;
                prunable = false;
            } else if let Some(value) = line.strip_prefix("worktree ") {
                path = value.to_owned();
            } else if let Some(value) = line.strip_prefix("branch refs/heads/") {
                branch = value.to_owned();
            } else if line == "bare" {
                bare = true;
            } else if line == "prunable" || line.starts_with("prunable ") {
                prunable = true;
            }
        }
        add(&mut found, &path, &branch, bare, prunable);
    }
    prefixed(found.into_values().collect(), &context.current, false)
}

fn dynamic_candidates(
    kind: &str,
    contract: &Value,
    context: &Context<'_>,
    cwd: &Path,
    deadline: Instant,
) -> Vec<Candidate> {
    if kind == "shell" || kind == "choice" {
        return static_candidates(contract, context);
    }
    let Some(workspace) = workspace(cwd, deadline) else {
        return Vec::new();
    };
    if Instant::now() >= deadline {
        return Vec::new();
    }
    if kind == "repository" || kind == "configured-repository" {
        if !workspace.configured {
            return Vec::new();
        }
        let command = context
            .command
            .and_then(|value| value["path"].as_str())
            .and_then(|path| path.split(' ').next())
            .unwrap_or_default();
        let configured_only =
            kind == "configured-repository" || command == "status" || command == "sync";
        return prefixed(
            workspace
                .repositories
                .iter()
                .filter(|repository| !configured_only || !repository.synthetic_parent)
                .map(|repository| Candidate {
                    value: repository.name.clone(),
                    description: "Configured repository".to_owned(),
                })
                .collect(),
            &context.current,
            true,
        );
    }
    if kind == "group" {
        return prefixed(
            workspace
                .groups
                .iter()
                .map(|group| Candidate {
                    value: group.clone(),
                    description: "Repository group".to_owned(),
                })
                .collect(),
            &context.current,
            true,
        );
    }
    worktree_candidates(&workspace, context, deadline)
}

fn query(argv: &[String], cursor: usize, cwd: &Path) -> Vec<u8> {
    let deadline = Instant::now() + query_budget();
    let contract = contract();
    let context = parse_context(&contract, argv, cursor);
    if context.command.and_then(|value| value["path"].as_str()) == Some("delete")
        && context.positional_index
            >= context
                .command
                .and_then(|value| value["arguments"].as_array())
                .map_or(0, Vec::len)
        && !context.current.starts_with('-')
    {
        return Vec::new();
    }
    let completing_option =
        !context.end_of_options && context.option.is_none() && context.current.starts_with('-');
    let owner = if completing_option {
        None
    } else {
        context.option.or_else(|| active_argument(&context))
    };
    let mut candidates = if let Some(kind) = owner.and_then(|value| value["candidateKind"].as_str())
    {
        dynamic_candidates(kind, &contract, &context, cwd, deadline)
    } else {
        static_candidates(&contract, &context)
    };
    if !context.option_assignment.is_empty() {
        for candidate in &mut candidates {
            candidate.value = format!("{}{}", context.option_assignment, candidate.value);
        }
    }
    let mut output = Vec::new();
    for candidate in candidates {
        output.extend_from_slice(candidate.value.as_bytes());
        output.push(0);
        output.extend_from_slice(candidate.description.as_bytes());
        output.push(0);
    }
    output
}

fn compact_json(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut quoted = false;
    let mut escaped = false;
    for character in text.chars() {
        if quoted {
            output.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                quoted = false;
            }
        } else if character == '"' {
            quoted = true;
            output.push(character);
        } else if !character.is_whitespace() {
            output.push(character);
        }
    }
    output
}

fn sha256_hex(input: &[u8]) -> String {
    const INITIAL: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let bit_len = (input.len() as u64) * 8;
    let mut message = input.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());
    let mut state = INITIAL;
    for chunk in message.chunks(64) {
        let mut words = [0u32; 64];
        for (index, word) in words.iter_mut().take(16).enumerate() {
            let offset = index * 4;
            *word = u32::from_be_bytes(chunk[offset..offset + 4].try_into().unwrap());
        }
        for index in 16..64 {
            let s0 = words[index - 15].rotate_right(7)
                ^ words[index - 15].rotate_right(18)
                ^ (words[index - 15] >> 3);
            let s1 = words[index - 2].rotate_right(17)
                ^ words[index - 2].rotate_right(19)
                ^ (words[index - 2] >> 10);
            words[index] = words[index - 16]
                .wrapping_add(s0)
                .wrapping_add(words[index - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for index in 0..64 {
            let sum1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choice = (e & f) ^ (!e & g);
            let temp1 = h
                .wrapping_add(sum1)
                .wrapping_add(choice)
                .wrapping_add(K[index])
                .wrapping_add(words[index]);
            let sum0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = sum0.wrapping_add(majority);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        for (slot, value) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *slot = slot.wrapping_add(value);
        }
    }
    state.iter().map(|word| format!("{word:08x}")).collect()
}

const BASH: &str = r###"_arashi() {
  local value description quoted
  local cursor="$COMP_CWORD"
  local -a words=("${COMP_WORDS[@]}")
  while true; do
    if (( cursor >= 1 )) && [[ "${words[cursor]}" == "=" ]]; then
      local assignment="${words[cursor - 1]}="
      words=("${words[@]:0:cursor - 1}" "$assignment" "${words[@]:cursor + 1}")
      cursor=$((cursor - 1))
    elif (( cursor >= 2 )) && [[ "${words[cursor - 1]}" == "=" ]]; then
      local assignment="${words[cursor - 2]}=${words[cursor]}"
      words=("${words[@]:0:cursor - 2}" "$assignment" "${words[@]:cursor + 1}")
      cursor=$((cursor - 2))
    elif (( cursor >= 1 )) && [[ "${words[cursor]}" == ":" || "${words[cursor]}" == "@" ]]; then
      local combined_word="${words[cursor - 1]}${words[cursor]}"
      words=("${words[@]:0:cursor - 1}" "$combined_word" "${words[@]:cursor + 1}")
      cursor=$((cursor - 1))
    elif (( cursor >= 2 )) && [[ "${words[cursor - 1]}" == ":" || "${words[cursor - 1]}" == "@" ]]; then
      local combined_word="${words[cursor - 2]}${words[cursor - 1]}${words[cursor]}"
      words=("${words[@]:0:cursor - 2}" "$combined_word" "${words[@]:cursor + 1}")
      cursor=$((cursor - 2))
    else
      break
    fi
  done
  local current_word="${words[cursor]}" dequoted_word="" char next_char quote_state=""
  local index
  for ((index = 0; index < ${#current_word}; index++)); do
    char="${current_word:index:1}"
    if [[ "$quote_state" == "single" ]]; then
      if [[ "$char" == "'" ]]; then
        quote_state=""
      else
        dequoted_word+="$char"
      fi
    elif [[ "$quote_state" == "double" ]]; then
      if [[ "$char" == '"' ]]; then
        quote_state=""
      elif [[ "$char" == "\\" ]] && ((index + 1 < ${#current_word})); then
        next_char="${current_word:index+1:1}"
        if [[ "$next_char" == '$' || "$next_char" == '"' || "$next_char" == "\\" || "$next_char" == $'\x60' ]]; then
          index=$((index + 1))
          dequoted_word+="$next_char"
        elif [[ "$next_char" == $'\n' ]]; then
          index=$((index + 1))
        else
          dequoted_word+="$char"
        fi
      else
        dequoted_word+="$char"
      fi
    elif [[ "$char" == "'" ]]; then
      quote_state="single"
    elif [[ "$char" == '"' ]]; then
      quote_state="double"
    elif [[ "$char" == "\\" ]] && ((index + 1 < ${#current_word})); then
      index=$((index + 1))
      next_char="${current_word:index:1}"
      if [[ "$next_char" != $'\n' ]]; then
        dequoted_word+="$next_char"
      fi
    else
      dequoted_word+="$char"
    fi
  done
  words[cursor]="$dequoted_word"
  COMPREPLY=()
  while IFS= read -r -d '' value && IFS= read -r -d '' description; do
    printf -v quoted '%q' "$value"
    COMPREPLY+=("$quoted")
  done < <(command arashi completion __query "$cursor" -- "${words[@]}")
}
complete -F _arashi arashi
if ! alias aw >/dev/null 2>&1 && { ! declare -F aw >/dev/null 2>&1 || declare -f aw | grep -Fq 'arashi-managed-shell-wrapper:aw:v1'; }; then
  complete -F _arashi aw
fi
"###;

const ZSH: &str = r###"if ! (( $+functions[compdef] )); then
  autoload -Uz compinit && compinit -i
fi
_arashi() {
  local value description display
  local -a values displays
  while IFS= read -r -d $'\0' value && IFS= read -r -d $'\0' description; do
    values+=("$value")
    display="$value"
    [[ -n "$description" ]] && display+=" -- $description"
    displays+=("$display")
  done < <(command arashi completion __query "$((CURRENT - 1))" -- "${words[@]}")
  compadd -d displays -- "${values[@]}"
}
compdef _arashi arashi
if (( ! ${+aliases[aw]} )); then
  if (( ! ${+functions[aw]} )) || [[ "${functions[aw]}" == *'arashi-managed-shell-wrapper:aw:v1'* ]]; then
    compdef _arashi aw
  fi
fi
"###;

const FISH: &str = r###"function __arashi_complete
    set -l words (commandline -opc)
    set -l current (commandline -ct)
    set -a words "$current"
    set -l cursor (math (count $words) - 1)
    set -l fields (command arashi completion __query $cursor -- $words | string split0)
    if test (count $fields) -ge 2
        for index in (seq 1 2 (count $fields))
            set -l description_index (math $index + 1)
            set -l description (string replace -ar '[\t\r\n]' ' ' -- "$fields[$description_index]")
            printf '%s\t%s\n' (string escape --no-quoted -- "$fields[$index]") "$description"
        end
    end
end
complete -c arashi -f -a '(__arashi_complete)'
if not functions -q aw; or functions aw | string match -q '*arashi-managed-shell-wrapper:aw:v1*'
    complete -c aw -f -a '(__arashi_complete)'
end
"###;

const POWERSHELL: &str = r###"Register-ArgumentCompleter -Native -CommandName arashi, aw -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })
  if ($words.Count -eq 0) { $words = @('arashi') }
  $lastElementEnd = $commandAst.CommandElements[-1].Extent.EndOffset
  if ($cursorPosition -gt $lastElementEnd) { $words += $wordToComplete }
  $cursor = $words.Count - 1
  $fields = ((& arashi completion __query $cursor -- @words) -join "
") -split [char]0
  for ($index = 0; $index + 1 -lt $fields.Count; $index += 2) {
    $value = $fields[$index]
    $description = $fields[$index + 1]
    if ($value -like "$wordToComplete*") {
      $completionText = "'" + $value.Replace("'", "''") + "'"
      [System.Management.Automation.CompletionResult]::new($completionText, $value, 'ParameterValue', $description)
    }
  }
}
"###;

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn completion_config_reader_does_not_block_on_fifo() {
        let path = std::env::temp_dir().join(format!(
            "arashi-completion-config-fifo-{}",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        let created = Command::new("mkfifo").arg(&path).status().unwrap();
        assert!(created.success());

        let started = Instant::now();
        let result = read_completion_config(&path, Instant::now() + Duration::from_millis(200));
        let elapsed = started.elapsed();
        let _ = fs::remove_file(&path);

        assert!(result.is_none());
        assert!(elapsed < Duration::from_secs(1), "elapsed: {elapsed:?}");
    }
}
