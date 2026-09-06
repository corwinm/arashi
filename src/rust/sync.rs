//! Bounded configured sync for local ordinary primary checkouts.
use crate::{
    Error, Result,
    cli::Args,
    config::{Config, RepoConfig, Workspace},
    git, managed, process,
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::{
    io::{Read, Write},
    os::fd::OwnedFd,
};

const DEFAULT_TIMEOUT_MS: u64 = 300_000;
static NEXT_OWNERSHIP_TOKEN: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileIdentity {
    canonical: PathBuf,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RepositoryIdentity {
    directory: FileIdentity,
    git_dir: FileIdentity,
    common_dir: FileIdentity,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RefIdentity {
    name: String,
    oid: String,
    object_type: String,
    symref: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct HeadIdentity {
    reference: Option<RefIdentity>,
    oid: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
struct Registration {
    path: String,
    canonical: Option<PathBuf>,
    branch: Option<String>,
    head: String,
    bare: bool,
    locked: bool,
    prune_reason: Option<String>,
}

#[derive(Clone)]
struct Plan {
    name: String,
    path: PathBuf,
    identity: Option<RepositoryIdentity>,
    expected_head: Option<HeadIdentity>,
    expected_target: Option<RefIdentity>,
    registrations: Vec<Registration>,
    failure: Option<String>,
}

struct FrozenWorkspace {
    root: RepositoryIdentity,
    head: HeadIdentity,
    config_path: PathBuf,
    config_identity: FileIdentity,
    config_bytes: Vec<u8>,
}

#[derive(Clone)]
struct Mutation {
    plan: usize,
    original_head: HeadIdentity,
    target: RefIdentity,
    created_branch: Option<RefIdentity>,
    changed_checkout: bool,
}

type RollbackErrors = Vec<(usize, String)>;
type RestoredPlans = Vec<(usize, Plan)>;

fn unsupported(message: &str) -> Error {
    managed::unsupported(message)
}

fn configured<'a>(workspace: &'a Workspace, args: &Args) -> Result<&'a Config> {
    workspace.config.as_ref().ok_or_else(|| {
        Error::new(
            "CONFIGURED_WORKSPACE_REQUIRED",
            "arashi sync requires a configured workspace. Run \"arashi init\" (without --zero-config) to enable repository coordination.",
        )
        .with_details(json!({"command":"sync","mode":"standalone"}))
        .with_exit_code(if args.has("json") { 2 } else { 1 })
    })
}

fn reject_configured_policy(config: &Config, selected: &[String]) -> Result<()> {
    if config.raw["hooks"].get("scripts").is_some()
        || config.raw["hooks"]
            .as_object()
            .is_some_and(|hooks| hooks.keys().any(|key| key != "timeout" && key != "scripts"))
    {
        return Err(unsupported(
            "Configured lifecycle hooks are not supported by bounded local sync; no changes made",
        ));
    }
    for name in selected {
        let raw = &config.repos[name].raw;
        if raw.get("gitUrl").is_some() {
            return Err(unsupported(
                "Configured gitUrl repositories are not supported by bounded local sync; no changes made",
            ));
        }
        if raw.get("hooks").is_some() {
            return Err(unsupported(
                "Configured lifecycle hooks are not supported by bounded local sync; no changes made",
            ));
        }
        if ["copy", "symlink"]
            .iter()
            .any(|key| raw[*key].as_array().is_some_and(|items| !items.is_empty()))
        {
            return Err(unsupported(
                "Materialization policies are not supported by bounded local sync; no changes made",
            ));
        }
    }
    Ok(())
}

fn repository_path(root: &Path, repo: &RepoConfig) -> Result<PathBuf> {
    let configured = Path::new(&repo.path);
    let path = if configured.is_absolute() {
        if configured
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
            || !configured.starts_with(root)
        {
            return Err(unsupported(
                "External repository paths are not supported by bounded local sync; no changes made",
            ));
        }
        configured.to_owned()
    } else {
        root.join(managed::relative(&repo.path)?)
    };
    if !path.starts_with(root) {
        return Err(unsupported(
            "Repository paths outside the workspace are not supported; no changes made",
        ));
    }
    managed::safe(&path)?;
    Ok(path)
}

fn file_identity(path: &Path) -> Result<FileIdentity> {
    managed::safe(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(unsupported(
            "Repository and Git metadata paths must remain ordinary directories; no changes made",
        ));
    }
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    Ok(FileIdentity {
        canonical: crate::paths::canonicalize(path)?,
        #[cfg(unix)]
        device: metadata.dev(),
        #[cfg(unix)]
        inode: metadata.ino(),
    })
}

fn resolved_git_path(repository: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value.trim());
    if path.is_absolute() {
        path
    } else {
        repository.join(path)
    }
}

fn repository_identity(path: &Path) -> Result<RepositoryIdentity> {
    let directory = file_identity(path)?;
    let git_dir = resolved_git_path(path, &git::run(path, &["rev-parse", "--absolute-git-dir"])?);
    let common_dir = resolved_git_path(path, &git::run(path, &["rev-parse", "--git-common-dir"])?);
    Ok(RepositoryIdentity {
        directory,
        git_dir: file_identity(&git_dir)?,
        common_dir: file_identity(&common_dir)?,
    })
}

fn require_primary(path: &Path) -> Result<Vec<git::Worktree>> {
    if git::run(path, &["rev-parse", "--is-bare-repository"])
        .is_ok_and(|value| value.trim() == "true")
    {
        return Err(unsupported(
            "Bare repositories are not supported by bounded local sync; no changes made",
        ));
    }
    let records = git::worktrees(path).map_err(|_| {
        unsupported("Configured repositories must be ordinary Git checkouts; no changes made")
    })?;
    if !records.first().is_some_and(|record| {
        !record.bare && crate::paths::same_existing(&record.path, path).unwrap_or(false)
    }) {
        return Err(unsupported(
            "Linked repository checkouts are not supported by bounded local sync; no changes made",
        ));
    }
    Ok(records)
}

fn reject_git_execution_policy(path: &Path) -> Result<()> {
    if git::run(path, &["config", "--get", "core.logAllRefUpdates"]).is_ok() {
        let parsed = git::run(
            path,
            &["config", "--type=bool", "--get", "core.logAllRefUpdates"],
        );
        if !matches!(parsed, Ok(ref value) if value.trim() == "true") {
            return Err(unsupported(
                "Disabled or malformed ref logging is not supported by bounded local sync; no changes made",
            ));
        }
    }
    if !git::run(path, &["remote"])?.trim().is_empty() {
        return Err(unsupported(
            "Repositories with configured remotes are not supported by bounded local sync; no changes made",
        ));
    }
    for (args, message) in [
        (
            ["config", "--get", "core.hooksPath"].as_slice(),
            "core.hooksPath is not supported by bounded local sync; no changes made",
        ),
        (
            ["config", "--get", "core.fsmonitor"].as_slice(),
            "core.fsmonitor is not supported by bounded local sync; no changes made",
        ),
        (
            ["config", "--get", "core.worktree"].as_slice(),
            "core.worktree is not supported by bounded local sync; no changes made",
        ),
    ] {
        if git::run(path, args).is_ok() {
            return Err(unsupported(message));
        }
    }
    if git::run(
        path,
        &[
            "config",
            "--get-regexp",
            r"^filter\..*\.(clean|smudge|process)$",
        ],
    )
    .is_ok()
    {
        return Err(unsupported(
            "Git conversion filters are not supported by bounded local sync; no changes made",
        ));
    }
    let hook =
        path.join(git::run(path, &["rev-parse", "--git-path", "hooks/post-checkout"])?.trim());
    managed::safe(&hook)?;
    if hook.try_exists()? {
        return Err(unsupported(
            "Git checkout hooks are not supported by bounded local sync; no changes made",
        ));
    }
    Ok(())
}

fn exact_ref(path: &Path, name: &str) -> Result<Option<RefIdentity>> {
    let output = git::run(
        path,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)",
            name,
        ],
    )
    .map_err(|_| {
        unsupported("Malformed or unreadable Git refs are not supported; no changes made")
    })?;
    let mut exact = None;
    for row in output.lines() {
        let fields = row.split('\0').collect::<Vec<_>>();
        if fields.len() != 4 {
            return Err(unsupported(
                "Malformed Git ref inventory is not supported; no changes made",
            ));
        }
        if fields[0] != name {
            continue;
        }
        if exact.is_some() {
            return Err(unsupported(
                "Ambiguous exact Git refs are not supported; no changes made",
            ));
        }
        let reference = RefIdentity {
            name: fields[0].to_owned(),
            oid: fields[1].to_owned(),
            object_type: fields[2].to_owned(),
            symref: (!fields[3].is_empty()).then(|| fields[3].to_owned()),
        };
        if reference.symref.is_some() || reference.object_type != "commit" {
            return Err(unsupported(
                "Target refs must be direct commit refs; no changes made",
            ));
        }
        exact = Some(reference);
    }
    validate_exact_ref_storage(path, name, exact.as_ref())?;
    let status = Command::new("git")
        .args(["show-ref", "--verify", "--quiet", name])
        .current_dir(path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    match status.code() {
        Some(0) if exact.is_none() => {
            return Err(unsupported(
                "Exact Git ref inventory disagreed with ref storage; no changes made",
            ));
        }
        Some(1) if exact.is_some() => {
            return Err(unsupported(
                "Exact Git ref disappeared during validation; no changes made",
            ));
        }
        Some(0 | 1) => {}
        _ => {
            return Err(unsupported(
                "Malformed or unreadable Git refs are not supported; no changes made",
            ));
        }
    }
    Ok(exact)
}

fn valid_oid_text(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_exact_ref_storage(
    repository: &Path,
    name: &str,
    exact: Option<&RefIdentity>,
) -> Result<()> {
    let loose = resolved_git_path(
        repository,
        &git::run(repository, &["rev-parse", "--git-path", name])?,
    );
    managed::safe(&loose)?;
    match fs::symlink_metadata(&loose) {
        Ok(metadata) => {
            managed::safe(&loose)?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(unsupported(
                    "Target ref storage must be an ordinary file; no changes made",
                ));
            }
            let value = fs::read_to_string(&loose)?;
            let value = value.trim();
            if value.starts_with("ref:")
                || !valid_oid_text(value)
                || exact.is_none_or(|reference| reference.oid != value)
            {
                return Err(unsupported(
                    "Malformed, symbolic, or inconsistent target ref; no changes made",
                ));
            }
            return Ok(());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let packed = resolved_git_path(
        repository,
        &git::run(repository, &["rev-parse", "--git-path", "packed-refs"])?,
    );
    managed::safe(&packed)?;
    let Ok(contents) = fs::read_to_string(&packed) else {
        return Ok(());
    };
    for line in contents
        .lines()
        .filter(|line| !line.starts_with(['#', '^']))
    {
        if let Some((oid, reference)) = line.split_once(' ')
            && reference == name
        {
            if !valid_oid_text(oid) || exact.is_none_or(|value| value.oid != oid) {
                return Err(unsupported(
                    "Malformed or inconsistent packed target ref; no changes made",
                ));
            }
            return Ok(());
        }
        if line.ends_with(name) {
            return Err(unsupported("Malformed packed target ref; no changes made"));
        }
    }
    Ok(())
}

fn head_identity(path: &Path) -> Result<HeadIdentity> {
    let oid = git::run(path, &["rev-parse", "--verify", "HEAD"])?
        .trim()
        .to_owned();
    if git::run(path, &["cat-file", "-t", &oid])?.trim() != "commit" {
        return Err(unsupported(
            "Repository HEAD must be a commit; no changes made",
        ));
    }
    let reference = match git::run(path, &["symbolic-ref", "--quiet", "HEAD"]) {
        Ok(value) => {
            let name = value.trim();
            Some(exact_ref(path, name)?.ok_or_else(|| {
                unsupported("Repository HEAD must name an exact direct branch; no changes made")
            })?)
        }
        Err(_) => None,
    };
    if reference
        .as_ref()
        .is_some_and(|reference| reference.oid != oid)
    {
        return Err(unsupported(
            "Repository HEAD and branch identity disagree; no changes made",
        ));
    }
    Ok(HeadIdentity { reference, oid })
}

fn registrations(records: &[git::Worktree]) -> Vec<Registration> {
    let mut values = records
        .iter()
        .map(|record| Registration {
            path: record.path.to_string_lossy().into_owned(),
            canonical: crate::paths::canonicalize(&record.path).ok(),
            branch: record.branch.clone(),
            head: record.head.clone(),
            bare: record.bare,
            locked: record.locked,
            prune_reason: record.prune_reason.clone(),
        })
        .collect::<Vec<_>>();
    values.sort();
    values
}

fn replace_primary_registration(plan: &mut Plan, head: &HeadIdentity) {
    let canonical = plan.identity.as_ref().unwrap().directory.canonical.clone();
    if let Some(record) = plan
        .registrations
        .iter_mut()
        .find(|record| record.canonical.as_ref() == Some(&canonical))
    {
        record.head.clone_from(&head.oid);
        record.branch = head.reference.as_ref().and_then(|reference| {
            reference
                .name
                .strip_prefix("refs/heads/")
                .map(str::to_owned)
        });
    }
}

fn preflight(root: &Path, config: &Config, selected: &[String], target: &str) -> Result<Vec<Plan>> {
    managed::safe(root)?;
    require_primary(root)?;
    reject_git_execution_policy(root)?;
    reject_configured_policy(config, selected)?;
    git::run(root, &["check-ref-format", &format!("refs/heads/{target}")])?;
    let mut plans = vec![];
    for name in selected {
        let path = repository_path(root, &config.repos[name])?;
        if fs::symlink_metadata(&path)
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            plans.push(Plan {
                name: name.clone(),
                path: path.clone(),
                identity: None,
                expected_head: None,
                expected_target: None,
                registrations: vec![],
                failure: Some(format!(
                    "git rev-parse --abbrev-ref HEAD failed: Working directory not found: {}",
                    path.display()
                )),
            });
            continue;
        }
        let identity = repository_identity(&path)?;
        let records = require_primary(&path)?;
        reject_git_execution_policy(&path)?;
        if records.iter().any(|record| {
            record.branch.as_deref() == Some(target)
                && !crate::paths::same_existing(&record.path, &path).unwrap_or(false)
        }) {
            return Err(unsupported(
                "Target branch is checked out in another worktree; relocation, deletion, and reuse are not supported; no changes made",
            ));
        }
        let expected_head = head_identity(&path)?;
        let expected_target = exact_ref(&path, &format!("refs/heads/{target}"))?;
        plans.push(Plan {
            name: name.clone(),
            path,
            identity: Some(identity),
            expected_head: Some(expected_head),
            expected_target,
            registrations: registrations(&records),
            failure: None,
        });
    }
    Ok(plans)
}

fn freeze_workspace(root: &Path) -> Result<FrozenWorkspace> {
    let config_path = root.join(".arashi/config.json");
    Ok(FrozenWorkspace {
        root: repository_identity(root)?,
        head: head_identity(root)?,
        config_identity: file_identity(config_path.parent().unwrap())?,
        config_bytes: fs::read(&config_path)?,
        config_path,
    })
}

fn revalidate_all(
    frozen: &FrozenWorkspace,
    config: &Config,
    selected: &[String],
    target: &str,
    plans: &[Plan],
) -> Result<()> {
    if repository_identity(&frozen.root.directory.canonical)? != frozen.root
        || head_identity(&frozen.root.directory.canonical)? != frozen.head
        || file_identity(frozen.config_path.parent().unwrap())? != frozen.config_identity
        || fs::read(&frozen.config_path)? != frozen.config_bytes
    {
        return Err(unsupported(
            "Workspace identity, configuration, or target HEAD changed during sync; owned changes will be rolled back",
        ));
    }
    reject_configured_policy(config, selected)?;
    reject_git_execution_policy(&frozen.root.directory.canonical)?;
    for plan in plans {
        let Some(expected_identity) = &plan.identity else {
            if fs::symlink_metadata(&plan.path).is_ok() {
                return Err(unsupported(
                    "A planned missing repository path changed during sync; owned changes will be rolled back",
                ));
            }
            continue;
        };
        managed::safe(&plan.path)?;
        if repository_identity(&plan.path)? != *expected_identity {
            return Err(unsupported(
                "Repository or Git metadata identity changed during sync; owned changes will be rolled back",
            ));
        }
        reject_git_execution_policy(&plan.path)?;
        let records = require_primary(&plan.path)?;
        if registrations(&records) != plan.registrations {
            return Err(unsupported(
                "Git worktree registrations changed during sync; owned changes will be rolled back",
            ));
        }
        if head_identity(&plan.path)? != *plan.expected_head.as_ref().unwrap()
            || exact_ref(&plan.path, &format!("refs/heads/{target}"))? != plan.expected_target
        {
            return Err(unsupported(
                "Repository HEAD or target ref changed during sync; owned changes will be rolled back",
            ));
        }
        if records.iter().any(|record| {
            record.branch.as_deref() == Some(target)
                && !crate::paths::same_existing(&record.path, &plan.path).unwrap_or(false)
        }) {
            return Err(unsupported(
                "Target branch registration changed during sync; owned changes will be rolled back",
            ));
        }
    }
    Ok(())
}

fn timeout_ms(config: &Config) -> u64 {
    config.raw["sync"]["timeoutSeconds"]
        .as_f64()
        .map(|seconds| (seconds * 1000.0).floor().clamp(0.0, u64::MAX as f64) as u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
}

fn timed_git(path: &Path, args: &[&str], started: Instant, limit: Duration) -> process::Captured {
    let elapsed = started.elapsed();
    if elapsed >= limit {
        return process::Captured {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: -1,
            elapsed_ms: elapsed.as_millis(),
            timed_out: true,
            signaled: false,
            #[cfg(unix)]
            termination_signal: None,
            error: None,
        };
    }
    let argv = std::iter::once("git".to_owned())
        .chain(args.iter().map(|arg| (*arg).to_owned()))
        .collect::<Vec<_>>();
    process::run_tree(&argv, path, limit - elapsed).unwrap_or_else(|error| process::Captured {
        stdout: String::new(),
        stderr: String::new(),
        exit_code: 1,
        elapsed_ms: started.elapsed().as_millis(),
        timed_out: false,
        signaled: false,
        #[cfg(unix)]
        termination_signal: None,
        error: Some(error.to_string()),
    })
}

fn failure(previous: Option<&str>, output: &process::Captured, description: &str) -> Value {
    let detail = if let Some(error) = &output.error {
        error.trim()
    } else if !output.stderr.trim().is_empty() {
        output.stderr.trim()
    } else if !output.stdout.trim().is_empty() {
        output.stdout.trim()
    } else {
        "Unknown error"
    };
    json!({
        "createdBranch":false,
        "currentBranch":previous,
        "errorMessage":format!("git {description} failed: {detail}"),
        "previousBranch":previous,
        "status":"failure"
    })
}

fn timeout_outcome(previous: Option<&str>) -> Value {
    json!({"createdBranch":false,"currentBranch":previous,"errorMessage":"Repository operation timed out","previousBranch":previous,"status":"timeout"})
}

fn unsettled_outcome(previous: Option<&str>, output: &process::Captured) -> Option<Value> {
    let message = output.error.as_deref()?;
    message
        .starts_with("Timed-out subprocess tree did not settle")
        .then(|| {
            json!({
                "createdBranch":false,
                "currentBranch":previous,
                "errorMessage":message,
                "previousBranch":previous,
                "recoveryBlocked":true,
                "status":"failure"
            })
        })
}

fn ownership_token() -> String {
    format!(
        "arashi-sync-{}-{}",
        std::process::id(),
        NEXT_OWNERSHIP_TOKEN.fetch_add(1, Ordering::Relaxed)
    )
}

fn reflog_proves_creation(path: &Path, reference: &str, token: &str) -> bool {
    git::run(path, &["reflog", "show", "--format=%gs", "-1", reference])
        .is_ok_and(|value| value.trim() == token)
}

fn inspect_after_attachment(plan: &mut Plan, target_ref: &str) -> Result<bool> {
    let before = plan.expected_head.as_ref().unwrap();
    let expected_target = plan.expected_target.as_ref().unwrap();
    let current = head_identity(&plan.path)?;
    let target = exact_ref(&plan.path, target_ref)?;
    if target.as_ref() != Some(expected_target) {
        return Err(unsupported(
            "Target ref identity changed during attachment; owned changes will be rolled back",
        ));
    }
    let attached =
        current.reference.as_ref() == Some(expected_target) && current.oid == expected_target.oid;
    if !attached && current != *before {
        return Err(unsupported(
            "Repository HEAD changed outside the expected attachment transition; caller-owned state was preserved",
        ));
    }
    if attached {
        plan.expected_head = Some(current.clone());
        replace_primary_registration(plan, &current);
    }
    Ok(attached)
}

fn revalidate_recovery(plan: &Plan, target_ref: &str) -> Result<()> {
    let identity = plan.identity.as_ref().unwrap();
    managed::safe(&plan.path)?;
    if repository_identity(&plan.path)? != *identity {
        return Err(unsupported(&format!(
            "Repository ownership changed; preserved for recovery: {}",
            plan.path.display()
        )));
    }
    reject_git_execution_policy(&plan.path)?;
    if registrations(&require_primary(&plan.path)?) != plan.registrations {
        return Err(unsupported(&format!(
            "Worktree registrations changed; recovery preserved: {}",
            plan.path.display()
        )));
    }
    if head_identity(&plan.path)? != *plan.expected_head.as_ref().unwrap()
        || exact_ref(&plan.path, target_ref)? != plan.expected_target
    {
        return Err(unsupported(&format!(
            "Repository HEAD or target ref changed; preserved for recovery: {}",
            plan.path.display()
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn rustix_error(error: rustix::io::Errno) -> Error {
    std::io::Error::from_raw_os_error(error.raw_os_error()).into()
}

#[cfg(unix)]
fn open_owned_directory(path: &Path, expected: &FileIdentity) -> Result<OwnedFd> {
    use rustix::fs::{Mode, OFlags, fstat, open};

    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(unsupported(&format!(
            "Repository ownership changed; preserved for recovery: {}",
            path.display()
        )));
    }
    let directory = open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(rustix_error)?;
    let metadata = fstat(&directory).map_err(rustix_error)?;
    if metadata.st_dev as u64 != expected.device || metadata.st_ino as u64 != expected.inode {
        return Err(unsupported(&format!(
            "Repository ownership changed; preserved for recovery: {}",
            path.display()
        )));
    }
    Ok(directory)
}

#[cfg(unix)]
fn open_owned_git_directory(plan: &Plan) -> Result<OwnedFd> {
    let identity = plan.identity.as_ref().unwrap();
    let _repository = open_owned_directory(&plan.path, &identity.directory)?;
    let _common = open_owned_directory(&identity.common_dir.canonical, &identity.common_dir)?;
    open_owned_directory(&identity.git_dir.canonical, &identity.git_dir)
}

#[cfg(unix)]
fn read_owned_file(directory: &OwnedFd, name: &str) -> Result<Vec<u8>> {
    use rustix::fs::{Mode, OFlags, openat};

    let file = openat(
        directory,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(rustix_error)?;
    let mut file = fs::File::from(file);
    let mut bytes = vec![];
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(unix)]
fn restore_symbolic_head(plan: &Plan, detached: &HeadIdentity, reference: &str) -> Result<()> {
    use rustix::fs::{AtFlags, Mode, OFlags, openat, renameat, unlinkat};

    if detached.reference.is_some() {
        return Err(unsupported(&format!(
            "Recovery HEAD is no longer detached; preserved: {}",
            plan.path.display()
        )));
    }
    let git_dir = open_owned_git_directory(plan)?;
    let lock = openat(
        &git_dir,
        "HEAD.lock",
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::RUSR | Mode::WUSR | Mode::RGRP | Mode::ROTH,
    )
    .map_err(rustix_error)?;
    let result = (|| -> Result<()> {
        if read_owned_file(&git_dir, "HEAD")? != format!("{}\n", detached.oid).as_bytes() {
            return Err(unsupported(&format!(
                "Recovery HEAD changed at the mutation boundary; preserved: {}",
                plan.path.display()
            )));
        }
        let mut lock = fs::File::from(lock);
        lock.write_all(format!("ref: {reference}\n").as_bytes())?;
        lock.sync_all()?;
        drop(lock);
        renameat(&git_dir, "HEAD.lock", &git_dir, "HEAD").map_err(rustix_error)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = unlinkat(&git_dir, "HEAD.lock", AtFlags::empty());
    }
    result
}

#[cfg(not(unix))]
fn restore_symbolic_head(_plan: &Plan, _detached: &HeadIdentity, _reference: &str) -> Result<()> {
    Err(unsupported(
        "Bounded local sync requires stable repository identity and is not supported on this platform; no changes made",
    ))
}

fn rollback(
    plans: &[Plan],
    mutations: &[Mutation],
    target_ref: &str,
) -> (RollbackErrors, RestoredPlans) {
    let mut errors = vec![];
    let mut restored = vec![];
    for mutation in mutations.iter().rev() {
        let mut expected = plans[mutation.plan].clone();
        let result = (|| -> Result<()> {
            revalidate_recovery(&expected, target_ref)?;
            let original = &mutation.original_head;
            let current = expected.expected_head.as_ref().unwrap().clone();
            if mutation.changed_checkout && current != *original {
                if current.oid != mutation.target.oid {
                    return Err(unsupported(&format!(
                        "Checkout ownership changed; preserved for recovery: {}",
                        expected.path.display()
                    )));
                }
                git::run(&expected.path, &["checkout", "--detach", &original.oid])?;
                let detached = head_identity(&expected.path)?;
                if detached.reference.is_some() || detached.oid != original.oid {
                    return Err(unsupported(&format!(
                        "Frozen HEAD could not be restored safely: {}",
                        expected.path.display()
                    )));
                }
                expected.expected_head = Some(detached.clone());
                replace_primary_registration(&mut expected, &detached);
                revalidate_recovery(&expected, target_ref)?;
                if let Some(reference) = &original.reference {
                    if exact_ref(&expected.path, &reference.name)?.as_ref() != Some(reference) {
                        return Err(unsupported(&format!(
                            "Previous branch identity changed; checkout left detached at frozen HEAD: {}",
                            expected.path.display()
                        )));
                    }
                    // End command-backed observations before acquiring a no-follow
                    // handle and Git-compatible HEAD lock at the mutation boundary.
                    revalidate_recovery(&expected, target_ref)?;
                    restore_symbolic_head(&expected, &detached, &reference.name)?;
                    let restored = head_identity(&expected.path)?;
                    if restored != *original {
                        return Err(unsupported(&format!(
                            "Previous HEAD identity could not be restored safely: {}",
                            expected.path.display()
                        )));
                    }
                    expected.expected_head = Some(restored.clone());
                    replace_primary_registration(&mut expected, &restored);
                }
            }
            if let Some(created) = &mutation.created_branch {
                revalidate_recovery(&expected, target_ref)?;
                let reference = expected.expected_target.as_ref().ok_or_else(|| {
                    unsupported("Invocation-owned target ref disappeared during recovery")
                })?;
                if reference != created {
                    return Err(unsupported(&format!(
                        "Created branch ownership changed; preserved for recovery: {}",
                        expected.path.display()
                    )));
                }
                // End command-backed recovery observations with a renewed frozen
                // repository identity check before deleting the owned ref.
                if repository_identity(&expected.path)? != *expected.identity.as_ref().unwrap() {
                    return Err(unsupported(&format!(
                        "Repository ownership changed; preserved for recovery: {}",
                        expected.path.display()
                    )));
                }
                git::run(
                    &expected.path,
                    &["update-ref", "-d", target_ref, &reference.oid],
                )?;
                expected.expected_target = None;
            }
            revalidate_recovery(&expected, target_ref)?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                if let Some((_, recovered)) = restored
                    .iter_mut()
                    .find(|(plan_index, _)| *plan_index == mutation.plan)
                {
                    *recovered = expected;
                } else {
                    restored.push((mutation.plan, expected));
                }
            }
            Err(error) => errors.push((mutation.plan, error.message)),
        }
    }
    (errors, restored)
}

fn duration(value: u128) -> String {
    if value >= 1000 {
        format!("{:.2}s", value as f64 / 1000.0)
    } else {
        format!("{value}ms")
    }
}

fn print_result(result: &Value, verbose: bool) {
    let name = result["repositoryName"].as_str().unwrap();
    let elapsed = result["durationMs"].as_u64().unwrap();
    match result["status"].as_str().unwrap() {
        "success" => println!(
            "{name}: synced to {}{} ({})",
            result["targetBranch"].as_str().unwrap(),
            if result["createdBranch"] == true {
                " (created)"
            } else {
                ""
            },
            duration(elapsed as u128)
        ),
        "timeout" => println!("{name}: timed out ({})", duration(elapsed as u128)),
        _ => println!("{name}: failed ({})", duration(elapsed as u128)),
    }
    if verbose {
        let mut details = vec![
            format!("branch={}", result["targetBranch"].as_str().unwrap()),
            format!("duration={}", duration(elapsed as u128)),
        ];
        if result["createdBranch"] == true {
            details.push("created=true".into());
        }
        if let Some(error) = result["errorMessage"].as_str() {
            details.push(format!("error={error}"));
        }
        println!("  {name}: {}", details.join(", "));
    }
}

pub fn sync(cwd: &Path, args: &Args) -> Result<Value> {
    if cfg!(windows) {
        return Err(unsupported(
            "Bounded local sync requires stable repository identity and is not supported on Windows; no changes made",
        ));
    }
    args.only(&["only", "group", "verbose"])?;
    if !args.positional.is_empty() {
        return Err(Error::new("USAGE", "sync takes no arguments").with_exit_code(2));
    }
    let workspace = Workspace::discover(cwd).map_err(|error| {
        if error.code == "CONFIG_NOT_FOUND" {
            Error::new(
                "RUST_NOT_YET_PORTED",
                "Bounded local sync requires a configured workspace; no changes made",
            )
        } else {
            error
        }
    })?;
    configured(&workspace, args)?;
    let frozen = freeze_workspace(&workspace.root)?;
    let config_text = String::from_utf8(frozen.config_bytes.clone())
        .map_err(|_| unsupported("Workspace configuration must remain UTF-8; no changes made"))?;
    let config = Config::parse(&config_text)?;
    let (selected, _) = crate::selection::select(&config, args).map_err(|error| {
        if error.code == "EMPTY_REPOSITORY_FILTERS" {
            error
        } else {
            Error::new("UNKNOWN_ERROR", error.message).with_exit_code(2)
        }
    })?;
    if selected.is_empty() {
        return Err(
            Error::new("UNKNOWN_ERROR", "No managed repositories found to sync").with_exit_code(2),
        );
    }
    let root_head = frozen.head.clone();
    let root_ref = root_head.reference.as_ref().ok_or_else(|| {
        Error::new(
            "UNKNOWN_ERROR",
            "Parent repository is in detached HEAD state",
        )
        .with_exit_code(2)
    })?;
    let target = root_ref
        .name
        .strip_prefix("refs/heads/")
        .ok_or_else(|| unsupported("Parent HEAD must be a direct local branch; no changes made"))?
        .to_owned();
    let target_ref = format!("refs/heads/{target}");
    let mut plans = preflight(&workspace.root, &config, &selected, &target)?;
    revalidate_all(&frozen, &config, &selected, &target, &plans)?;
    let timeout = Duration::from_millis(timeout_ms(&config));
    let mut results: Vec<Value> = vec![];
    let mut mutations = vec![];

    let originals: Vec<Option<HeadIdentity>> =
        plans.iter().map(|p| p.expected_head.clone()).collect();

    for index in 0..plans.len() {
        let started = Instant::now();
        let previous = originals[index]
            .as_ref()
            .and_then(|head| head.reference.as_ref())
            .and_then(|reference| reference.name.strip_prefix("refs/heads/"))
            .map(str::to_owned);
        let outcome = if let Some(message) = &plans[index].failure {
            json!({"createdBranch":false,"currentBranch":null,"errorMessage":message,"previousBranch":null,"status":"failure"})
        } else if timeout.is_zero() {
            timeout_outcome(previous.as_deref())
        } else if previous.as_deref() == Some(&target) {
            json!({"createdBranch":false,"currentBranch":target,"previousBranch":target,"status":"success"})
        } else {
            let created = plans[index].expected_target.is_none();
            let operation = (|| -> Result<Value> {
                if created {
                    revalidate_all(&frozen, &config, &selected, &target, &plans)?;
                    let oid = originals[index].as_ref().unwrap().oid.clone();
                    let token = ownership_token();
                    let output = timed_git(
                        &plans[index].path,
                        &["update-ref", "-m", &token, &target_ref, &oid, ""],
                        started,
                        timeout,
                    );
                    if let Some(outcome) = unsettled_outcome(previous.as_deref(), &output) {
                        return Ok(outcome);
                    }
                    let actual = exact_ref(&plans[index].path, &target_ref)?;
                    let owned = output.exit_code == 0 && !output.timed_out
                        || reflog_proves_creation(&plans[index].path, &target_ref, &token);
                    if owned
                        && actual
                            .as_ref()
                            .is_some_and(|reference| reference.oid == oid)
                    {
                        plans[index].expected_target = actual.clone();
                        mutations.push(Mutation {
                            plan: index,
                            original_head: originals[index].clone().unwrap(),
                            target: actual.clone().unwrap(),
                            created_branch: actual,
                            changed_checkout: false,
                        });
                    } else if output.exit_code == 0 && !output.timed_out {
                        return Err(unsupported(
                            "Created target ref could not be verified; owned changes will be rolled back",
                        ));
                    }
                    if output.timed_out || output.exit_code != 0 {
                        return Ok(if output.timed_out {
                            timeout_outcome(previous.as_deref())
                        } else {
                            failure(
                                previous.as_deref(),
                                &output,
                                &format!("update-ref {target_ref} {oid}"),
                            )
                        });
                    }
                    if plans[index].expected_target.is_none() {
                        return Err(unsupported(
                            "Created target ref could not be verified; owned changes will be rolled back",
                        ));
                    }
                }
                revalidate_all(&frozen, &config, &selected, &target, &plans)?;
                let oid = plans[index].expected_target.as_ref().unwrap().oid.clone();
                let output = timed_git(
                    &plans[index].path,
                    &["checkout", "--detach", &oid],
                    started,
                    timeout,
                );
                if let Some(outcome) = unsettled_outcome(previous.as_deref(), &output) {
                    return Ok(outcome);
                }
                let current = head_identity(&plans[index].path)?;
                let reached_detached_target = current.reference.is_none() && current.oid == oid;
                if reached_detached_target {
                    plans[index].expected_head = Some(current.clone());
                    replace_primary_registration(&mut plans[index], &current);
                    if let Some(mutation) =
                        mutations.iter_mut().find(|mutation| mutation.plan == index)
                    {
                        mutation.changed_checkout = true;
                    } else {
                        mutations.push(Mutation {
                            plan: index,
                            original_head: originals[index].clone().unwrap(),
                            target: plans[index].expected_target.clone().unwrap(),
                            created_branch: None,
                            changed_checkout: true,
                        });
                    }
                }
                if output.timed_out || output.exit_code != 0 {
                    return Ok(if output.timed_out {
                        timeout_outcome(previous.as_deref())
                    } else {
                        failure(
                            previous.as_deref(),
                            &output,
                            &format!("checkout --detach {oid}"),
                        )
                    });
                }
                if !reached_detached_target {
                    return Err(unsupported(
                        "Checkout did not reach detached HEAD at the frozen target OID; caller-owned state was preserved",
                    ));
                }
                revalidate_all(&frozen, &config, &selected, &target, &plans)?;
                let frozen_detached = plans[index].expected_head.as_ref().unwrap();
                let attachment_head = head_identity(&plans[index].path)?;
                if attachment_head != *frozen_detached
                    || attachment_head.reference.is_some()
                    || attachment_head.oid != oid
                {
                    return Err(unsupported(
                        "Repository HEAD was not detached at the frozen target OID immediately before attachment; caller-owned state was preserved",
                    ));
                }
                let output = timed_git(
                    &plans[index].path,
                    &["symbolic-ref", "HEAD", &target_ref],
                    started,
                    timeout,
                );
                if let Some(outcome) = unsettled_outcome(previous.as_deref(), &output) {
                    return Ok(outcome);
                }
                if output.timed_out || output.exit_code != 0 {
                    inspect_after_attachment(&mut plans[index], &target_ref)?;
                    return Ok(if output.timed_out {
                        timeout_outcome(previous.as_deref())
                    } else {
                        failure(
                            previous.as_deref(),
                            &output,
                            &format!("symbolic-ref HEAD {target_ref}"),
                        )
                    });
                }
                if !inspect_after_attachment(&mut plans[index], &target_ref)? {
                    return Err(unsupported(
                        "Attachment command did not select the exact frozen target ref; caller-owned state was preserved",
                    ));
                }
                let verified = plans[index].expected_head.as_ref().unwrap();
                if verified.reference.as_ref() != plans[index].expected_target.as_ref()
                    || verified.oid != oid
                {
                    return Err(unsupported(
                        "Post-checkout HEAD/ref verification failed; owned changes will be rolled back",
                    ));
                }
                revalidate_all(&frozen, &config, &selected, &target, &plans)?;
                Ok(
                    json!({"createdBranch":created,"currentBranch":target,"previousBranch":previous,"status":"success"}),
                )
            })();
            match operation {
                Ok(value) => value,
                Err(error) => {
                    json!({"createdBranch":false,"currentBranch":previous,"errorMessage":error.message,"previousBranch":previous,"status":"failure"})
                }
            }
        };
        let failed = outcome["status"] != "success";
        let process_unsettled = outcome["recoveryBlocked"] == true;
        let mut recovery_failed = false;
        let mut result = json!({
            "createdBranch":outcome["createdBranch"],
            "durationMs":started.elapsed().as_millis() as u64,
            "repositoryName":plans[index].name,
            "status":outcome["status"],
            "targetBranch":target,
        });
        if let Some(message) = outcome["errorMessage"].as_str() {
            result["errorMessage"] = json!(message);
        }
        if process_unsettled {
            result["recoveryBlocked"] = json!(true);
            recovery_failed = true;

            for previous_result in &mut results {
                if previous_result["status"] == "success" {
                    previous_result["status"] = json!("failure");
                    previous_result["recoveryBlocked"] = json!(true);
                    previous_result["errorMessage"] = json!(
                        "Recovery blocked because a timed-out subprocess tree did not settle"
                    );
                }
            }
            mutations.clear();
        } else if failed && !mutations.is_empty() {
            // Restore against the frozen preflight identities, not mutable branch names.
            let (rollback_errors, restored) = rollback(&plans, &mutations, &target_ref);
            for (restored_index, recovered) in restored {
                plans[restored_index] = recovered;
                if restored_index == index {
                    result["createdBranch"] = json!(false);
                    result["rolledBack"] = json!(true);
                } else if let Some(previous_result) = results.get_mut(restored_index) {
                    previous_result["createdBranch"] = json!(false);
                    previous_result["status"] = json!("failure");
                    previous_result["rolledBack"] = json!(true);
                    previous_result["errorMessage"] =
                        json!("Rolled back after another repository failed");
                }
            }
            for (failed_index, message) in &rollback_errors {
                if *failed_index == index {
                    result["rollbackFailed"] = json!(true);
                } else if let Some(previous_result) = results.get_mut(*failed_index) {
                    previous_result["status"] = json!("failure");
                    previous_result["rollbackFailed"] = json!(true);
                    previous_result["errorMessage"] = json!(format!("Rollback failed: {message}"));
                }
            }
            if !rollback_errors.is_empty() {
                recovery_failed = true;
                let rollback_messages = rollback_errors
                    .iter()
                    .map(|(_, message)| message.as_str())
                    .collect::<Vec<_>>()
                    .join("; ");
                result["errorMessage"] = json!(format!(
                    "{}; rollback failed: {}",
                    result["errorMessage"]
                        .as_str()
                        .unwrap_or("Repository operation failed"),
                    rollback_messages
                ));
            }
            mutations.clear();
        }
        results.push(result);
        if recovery_failed {
            break;
        }
    }

    if let Err(error) = revalidate_all(&frozen, &config, &selected, &target, &plans) {
        let (rollback_errors, restored) = rollback(&plans, &mutations, &target_ref);
        for (restored_index, recovered) in restored {
            plans[restored_index] = recovered;
            if let Some(result) = results.get_mut(restored_index) {
                result["createdBranch"] = json!(false);
                result["rolledBack"] = json!(true);
            }
        }
        for result in &mut results {
            if result["status"] == "success" {
                result["status"] = json!("failure");
                result["errorMessage"] =
                    json!(format!("Final revalidation failed: {}", error.message));
            }
        }
        for (failed_index, message) in rollback_errors {
            if let Some(result) = results.get_mut(failed_index) {
                result["rollbackFailed"] = json!(true);
                result["errorMessage"] = json!(format!(
                    "Final revalidation failed: {}; rollback failed: {message}",
                    error.message
                ));
            }
        }
        mutations.clear();
    }
    let success = results
        .iter()
        .filter(|result| result["status"] == "success")
        .count();
    let failed = results.len() - success;
    if !args.has("json") {
        for result in &results {
            print_result(result, args.has("verbose"));
        }
        println!("Sync complete: {success} succeeded, {failed} failed");
        if failed > 0 {
            for result in results
                .iter()
                .filter(|result| result["status"] != "success")
            {
                println!(
                    "  {}: {} ({}){}",
                    result["repositoryName"].as_str().unwrap(),
                    result["status"].as_str().unwrap(),
                    duration(result["durationMs"].as_u64().unwrap() as u128),
                    result["errorMessage"]
                        .as_str()
                        .map_or(String::new(), |message| format!(" - {message}"))
                );
            }
        }
    }
    Ok(json!({"failureCount":failed,"results":results,"successCount":success}))
}
