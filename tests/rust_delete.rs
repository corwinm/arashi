use serde_json::Value;
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    workspace: PathBuf,
    home: PathBuf,
    remote: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let fixture_id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "arashi-rust-delete-{}-{unique}-{fixture_id}",
            std::process::id()
        ));
        let workspace = root.join("workspace");
        let home = root.join("home");
        let seed = root.join("seed");
        let remote = root.join("api.git");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&seed).unwrap();
        git(&workspace, &["init", "--initial-branch=main"]);
        fs::write(workspace.join("README.md"), "workspace\n").unwrap();
        git(&workspace, &["add", "README.md"]);
        git(&workspace, &["commit", "-m", "workspace"]);
        git(&seed, &["init", "--initial-branch=main"]);
        fs::write(seed.join("README.md"), "child\n").unwrap();
        git(&seed, &["add", "README.md"]);
        git(&seed, &["commit", "-m", "child"]);
        git(&root, &["init", "--bare", remote.to_str().unwrap()]);
        git(
            &seed,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&seed, &["push", "-u", "origin", "main"]);
        git(&remote, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        fs::create_dir_all(workspace.join("repos")).unwrap();
        git(
            &workspace,
            &["clone", remote.to_str().unwrap(), "repos/api"],
        );
        git(
            &workspace,
            &["clone", remote.to_str().unwrap(), "repos/keep"],
        );
        fs::create_dir_all(workspace.join(".arashi")).unwrap();
        let config = serde_json::json!({
            "version": "1.0.0",
            "reposDir": "repos",
            "worktreesDir": ".arashi/worktrees",
            "repos": {
                "keep": {"path": "repos/keep", "gitUrl": remote},
                "api": {"path": "repos/api", "gitUrl": remote}
            }
        });
        fs::write(
            workspace.join(".arashi/config.json"),
            format!("{}\n", serde_json::to_string_pretty(&config).unwrap()),
        )
        .unwrap();
        git(&workspace, &["add", ".arashi/config.json"]);
        git(&workspace, &["commit", "-m", "configure"]);
        Self {
            root,
            workspace,
            home,
            remote,
        }
    }

    fn run(&self, args: &[&str]) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_arashi"));
        command
            .args(args)
            .current_dir(&self.workspace)
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("GIT_AUTHOR_NAME", "Delete Test")
            .env("GIT_AUTHOR_EMAIL", "delete@example.test")
            .env("GIT_COMMITTER_NAME", "Delete Test")
            .env("GIT_COMMITTER_EMAIL", "delete@example.test")
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "commit.gpgSign")
            .env("GIT_CONFIG_VALUE_0", "false")
            .env("NO_COLOR", "1");
        command.output().unwrap()
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            workspace: tree(&self.workspace),
            home: tree(&self.home),
            remote_refs: git(&self.remote, &["show-ref"]),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Snapshot {
    workspace: BTreeMap<PathBuf, Vec<u8>>,
    home: BTreeMap<PathBuf, Vec<u8>>,
    remote_refs: String,
}

fn tree(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(root: &Path, path: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        let mut entries = fs::read_dir(path)
            .unwrap()
            .collect::<std::io::Result<Vec<_>>>()
            .unwrap();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let relative = path.strip_prefix(root).unwrap().to_path_buf();
            let metadata = fs::symlink_metadata(&path).unwrap();
            if metadata.file_type().is_symlink() {
                out.insert(
                    relative,
                    os_bytes(fs::read_link(&path).unwrap().into_os_string()),
                );
            } else if metadata.is_dir() {
                out.insert(relative.clone(), Vec::new());
                walk(root, &path, out);
            } else {
                out.insert(relative, fs::read(path).unwrap());
            }
        }
    }
    let mut result = BTreeMap::new();
    walk(root, root, &mut result);
    result
}

#[cfg(unix)]
fn os_bytes(value: OsString) -> Vec<u8> {
    use std::os::unix::ffi::OsStringExt;
    value.into_vec()
}

#[cfg(windows)]
fn os_bytes(value: OsString) -> Vec<u8> {
    value.to_string_lossy().as_bytes().to_vec()
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_AUTHOR_NAME", "Delete Test")
        .env("GIT_AUTHOR_EMAIL", "delete@example.test")
        .env("GIT_COMMITTER_NAME", "Delete Test")
        .env("GIT_COMMITTER_EMAIL", "delete@example.test")
        .env("GIT_CONFIG_COUNT", "2")
        .env("GIT_CONFIG_KEY_0", "commit.gpgSign")
        .env("GIT_CONFIG_VALUE_0", "false")
        .env("GIT_CONFIG_KEY_1", "maintenance.auto")
        .env("GIT_CONFIG_VALUE_1", "false")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn json(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "invalid JSON ({error}): stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

#[test]
fn effective_conversion_filter_fails_before_status_can_execute_it() {
    let fixture = Fixture::new();
    let script = fixture.home.join("filter-canary.sh");
    let marker = fixture.home.join("filter-ran");
    fs::write(
        &script,
        format!("#!/bin/sh\ntouch '{}'\ncat\n", marker.display()),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    }
    fs::write(
        fixture.workspace.join("repos/api/.git/info/attributes"),
        "README.md filter=delete-canary\n",
    )
    .unwrap();
    let global = Command::new("git")
        .args([
            "config",
            "--global",
            "filter.delete-canary.clean",
            script.to_str().unwrap(),
        ])
        .env("HOME", &fixture.home)
        .env("USERPROFILE", &fixture.home)
        .output()
        .unwrap();
    assert!(global.status.success());
    let tracked = fixture.workspace.join("repos/api/README.md");
    let bytes = fs::read(&tracked).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    fs::write(&tracked, bytes).unwrap();
    let control = Command::new("git")
        .args(["--no-optional-locks", "status", "--porcelain"])
        .current_dir(fixture.workspace.join("repos/api"))
        .env("HOME", &fixture.home)
        .env("USERPROFILE", &fixture.home)
        .output()
        .unwrap();
    assert!(control.status.success());
    assert!(marker.is_file(), "positive control did not execute filter");
    fs::remove_file(&marker).unwrap();
    let before = fixture.snapshot();
    let output = fixture.run(&["delete", "api", "--dry-run", "--json"]);
    assert!(!output.status.success());
    assert_eq!(fixture.snapshot(), before);
    assert!(!marker.try_exists().unwrap());
}

#[test]
fn dry_run_git_observation_does_not_refresh_the_index() {
    let fixture = Fixture::new();
    let tracked = fixture.workspace.join("repos/api/README.md");
    let bytes = fs::read(&tracked).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    fs::write(&tracked, bytes).unwrap();
    let before = fixture.snapshot();
    let output = fixture.run(&["delete", "api", "--dry-run", "--json"]);
    assert!(output.status.success());
    assert_eq!(fixture.snapshot(), before);
}

#[test]
fn explicit_clean_target_dry_run_is_source_shaped_and_nonmutating() {
    let fixture = Fixture::new();
    let before = fixture.snapshot();
    let output = fixture.run(&["delete", "api", "--dry-run", "--json"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(output.stderr, b"");
    let document = json(&output);
    assert_eq!(document["command"], "delete");
    assert_eq!(document["ok"], true);
    assert_eq!(document["data"]["repositoryKey"], "api");
    assert_eq!(document["data"]["dryRun"], true);
    assert_eq!(document["data"]["force"], false);
    assert_eq!(document["data"]["confirmation"], "not-required");
    assert!(
        document["data"]["plan"]["items"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
    );
    assert_eq!(document["data"]["result"], Value::Null);
    assert_eq!(fixture.snapshot(), before);
}

#[cfg(unix)]
#[test]
fn forced_clean_target_deletes_only_the_owned_clone_and_exact_config_entry() {
    let fixture = Fixture::new();
    let remote_before = git(&fixture.remote, &["show-ref"]);
    let home_before = tree(&fixture.home);
    let keep_before = tree(&fixture.workspace.join("repos/keep"));
    let output = fixture.run(&["delete", "api", "--force", "--json"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let document = json(&output);
    assert_eq!(document["data"]["repositoryKey"], "api");
    assert_eq!(document["data"]["confirmation"], "not-required");
    assert!(document["data"]["result"].is_object());
    let mut item_ids = document["data"]["result"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let mut phased_ids = document["data"]["result"]["phases"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|phase| phase["itemIds"].as_array().unwrap())
        .map(|id| id.as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    item_ids.sort();
    phased_ids.sort();
    assert_eq!(phased_ids, item_ids);
    assert!(!fixture.workspace.join("repos/api").try_exists().unwrap());
    assert_eq!(tree(&fixture.workspace.join("repos/keep")), keep_before);
    assert_eq!(tree(&fixture.home), home_before);
    assert_eq!(git(&fixture.remote, &["show-ref"]), remote_before);
    let config: Value =
        serde_json::from_slice(&fs::read(fixture.workspace.join(".arashi/config.json")).unwrap())
            .unwrap();
    assert!(config["repos"].get("api").is_none());
    assert!(config["repos"].get("keep").is_some());
    assert!(
        fs::read_dir(fixture.workspace.join("repos"))
            .unwrap()
            .all(|entry| {
                !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".arashi-delete-")
            })
    );
}

#[test]
fn destructive_delete_requires_exact_target_and_force_without_a_tty() {
    for args in [
        vec!["delete", "--force", "--json"],
        vec!["delete", "missing", "--force", "--json"],
        vec!["delete", "api", "--json"],
    ] {
        let fixture = Fixture::new();
        let before = fixture.snapshot();
        let output = fixture.run(&args);
        assert!(!output.status.success(), "unexpected success for {args:?}");
        let code = json(&output)["error"]["code"].as_str().unwrap().to_owned();
        assert!(
            [
                "DELETE_SELECTION_REQUIRED",
                "DELETE_REPOSITORY_NOT_FOUND",
                "DELETE_CONFIRMATION_REQUIRED"
            ]
            .contains(&code.as_str()),
            "unexpected code {code}"
        );
        assert_eq!(fixture.snapshot(), before, "mutation for {args:?}");
        if args == ["delete", "api", "--json"] {
            assert_eq!(json(&output)["error"]["details"]["confirmation"], "required");
        }
    }
}

#[cfg(unix)]
#[test]
fn path_shaped_repository_key_uses_a_contained_quarantine_name() {
    let fixture = Fixture::new();
    let config_path = fixture.workspace.join(".arashi/config.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    let api = config["repos"].as_object_mut().unwrap().remove("api").unwrap();
    config["repos"]["api/../../outside"] = api;
    fs::write(
        &config_path,
        format!("{}\n", serde_json::to_string_pretty(&config).unwrap()),
    )
    .unwrap();

    let output = fixture.run(&[
        "delete",
        "api/../../outside",
        "--force",
        "--json",
    ]);

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(!fixture.workspace.join("repos/api").try_exists().unwrap());
    assert!(!fixture.workspace.join("outside").try_exists().unwrap());
    let config: Value = serde_json::from_slice(&fs::read(config_path).unwrap()).unwrap();
    assert!(config["repos"].get("api/../../outside").is_none());
}

#[test]
fn aliased_configured_key_fails_before_deleting_shared_repository_identity() {
    let fixture = Fixture::new();
    let config_path = fixture.workspace.join(".arashi/config.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    config["repos"]["api"]["path"] = serde_json::json!("repos/keep");
    fs::write(
        &config_path,
        format!("{}\n", serde_json::to_string_pretty(&config).unwrap()),
    )
    .unwrap();
    let before = fixture.snapshot();
    let output = fixture.run(&["delete", "api", "--force", "--json"]);
    assert!(!output.status.success());
    assert_eq!(json(&output)["error"]["code"], "DELETE_TOPOLOGY_INVALID");
    assert_eq!(fixture.snapshot(), before);
}

#[test]
fn unsupported_policy_and_topology_cases_fail_before_mutation() {
    for case in [
        "materialization",
        "hooks",
        "linked",
        "dirty",
        "symlink",
        "tag",
        "ignored",
    ] {
        let fixture = Fixture::new();
        let config_path = fixture.workspace.join(".arashi/config.json");
        if case == "materialization" || case == "hooks" {
            let mut config: Value =
                serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
            config["repos"]["api"][if case == "hooks" { "hooks" } else { "copy" }] =
                if case == "hooks" {
                    serde_json::json!({"pre-remove": "touch forbidden"})
                } else {
                    serde_json::json!(["README.md"])
                };
            fs::write(
                &config_path,
                format!("{}\n", serde_json::to_string_pretty(&config).unwrap()),
            )
            .unwrap();
        } else if case == "linked" {
            let linked = fixture.workspace.join("linked-api");
            git(
                &fixture.workspace.join("repos/api"),
                &["worktree", "add", "-b", "topic", linked.to_str().unwrap()],
            );
        } else if case == "dirty" {
            fs::write(fixture.workspace.join("repos/api/UNTRACKED"), "preserve\n").unwrap();
        } else if case == "tag" {
            git(
                &fixture.workspace.join("repos/api"),
                &["tag", "local-release"],
            );
        } else if case == "ignored" {
            fs::write(
                fixture.workspace.join("repos/api/.git/info/exclude"),
                "private-data\n",
            )
            .unwrap();
            fs::write(
                fixture.workspace.join("repos/api/private-data"),
                "preserve\n",
            )
            .unwrap();
        } else {
            let actual = fixture.workspace.join("actual-api");
            fs::rename(fixture.workspace.join("repos/api"), &actual).unwrap();
            #[cfg(unix)]
            std::os::unix::fs::symlink(&actual, fixture.workspace.join("repos/api")).unwrap();
            #[cfg(windows)]
            std::os::windows::fs::symlink_dir(&actual, fixture.workspace.join("repos/api"))
                .unwrap();
        }
        let before = fixture.snapshot();
        let output = fixture.run(&["delete", "api", "--force", "--json"]);
        assert!(!output.status.success(), "unexpected {case} success");
        assert_eq!(fixture.snapshot(), before, "{case} mutated state");
    }
}

#[cfg(unix)]
#[test]
fn config_publication_failure_restores_the_identity_checked_quarantine() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let before = fixture.snapshot();
    let arashi = fixture.workspace.join(".arashi");
    fs::set_permissions(&arashi, fs::Permissions::from_mode(0o555)).unwrap();
    let output = fixture.run(&["delete", "api", "--force", "--json"]);
    fs::set_permissions(&arashi, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(!output.status.success());
    assert!(fixture.workspace.join("repos/api").is_dir());
    assert!(
        fs::read_dir(fixture.workspace.join("repos"))
            .unwrap()
            .all(|entry| {
                !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".arashi-delete-")
            })
    );
    let mut after = fixture.snapshot();
    let mut expected = before;
    // Permission modes are intentionally outside byte snapshots; content must be exact.
    after.workspace.remove(Path::new(".arashi"));
    expected.workspace.remove(Path::new(".arashi"));
    assert_eq!(after, expected);
}
