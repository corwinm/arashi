#![cfg(unix)]

use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
    thread,
    time::{Duration, Instant},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
    root: PathBuf,
    remote: PathBuf,
    workspace: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "arashi-add-rust-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let root = arashi::paths::canonicalize(&root).unwrap();
        let remote = root.join("child.git");
        fs::create_dir(&remote).unwrap();
        git(&remote, &["init", "--bare"]);
        let seed = root.join("seed");
        git(
            &root,
            &["clone", remote.to_str().unwrap(), seed.to_str().unwrap()],
        );
        git(&seed, &["config", "user.name", "Test"]);
        git(&seed, &["config", "user.email", "test@example.invalid"]);
        fs::write(seed.join("README.md"), "child\n").unwrap();
        fs::write(seed.join("setup.sh"), "#!/bin/sh\n").unwrap();
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-m", "initial"]);
        git(&seed, &["branch", "-M", "main"]);
        git(&seed, &["push", "origin", "main"]);
        git(&remote, &["symbolic-ref", "HEAD", "refs/heads/main"]);

        let workspace = root.join("workspace");
        fs::create_dir(&workspace).unwrap();
        git(&workspace, &["init", "-b", "main"]);
        git(&workspace, &["config", "user.name", "Test"]);
        git(
            &workspace,
            &["config", "user.email", "test@example.invalid"],
        );
        fs::create_dir(workspace.join(".arashi")).unwrap();
        fs::write(
            workspace.join(".arashi/config.json"),
            "{\n  \"repos\": {},\n  \"reposDir\": \"./repos\",\n  \"version\": \"1.0.0\"\n}",
        )
        .unwrap();
        fs::write(workspace.join(".gitignore"), "repos/\n.arashi/worktrees/\n").unwrap();
        git(&workspace, &["add", ".arashi/config.json", ".gitignore"]);
        git(&workspace, &["commit", "-m", "configure"]);
        Self {
            root,
            remote,
            workspace,
        }
    }

    fn cli(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_arashi"))
            .args(args)
            .current_dir(&self.workspace)
            .env("HOME", self.root.join("home"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.root.join("missing-global-config"))
            .output()
            .unwrap()
    }

    fn add(&self, extra: &[&str]) -> Output {
        let mut args = vec!["add", self.remote.to_str().unwrap(), "--json", "--force"];
        args.extend_from_slice(extra);
        self.cli(&args)
    }

    fn source_add(&self) -> Output {
        Command::new("node")
            .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"))
            .args(["add", self.remote.to_str().unwrap(), "--json", "--force"])
            .current_dir(&self.workspace)
            .env("HOME", self.root.join("home"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.root.join("missing-global-config"))
            .output()
            .unwrap()
    }

    fn state(&self) -> (Vec<u8>, Vec<u8>, bool, String) {
        (
            fs::read(self.workspace.join(".arashi/config.json")).unwrap(),
            fs::read(self.workspace.join(".git/info/exclude")).unwrap(),
            self.workspace.join("repos/child").exists(),
            git(
                &self.workspace,
                &["status", "--porcelain=v1", "--untracked-files=all"],
            ),
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(["-c", "commit.gpgsign=false", "-c", "maintenance.auto=false"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn document(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "{error}: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

#[test]
fn configured_local_add_clones_detects_setup_and_persists_minimal_entry() {
    let fixture = Fixture::new();
    let output = fixture.add(&[]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    let value = document(&output);
    assert_eq!(value["command"], "add");
    assert_eq!(value["ok"], true);
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["warnings"], serde_json::json!([]));
    assert_eq!(value["data"]["repository"]["name"], "child");
    assert_eq!(
        value["data"]["repository"]["gitUrl"],
        fixture.remote.to_str().unwrap()
    );
    assert_eq!(value["data"]["repository"]["path"], "repos/child");
    assert_eq!(value["data"]["repository"]["defaultBranch"], "main");
    assert_eq!(value["data"]["repository"]["materialization"], "clone");
    assert_eq!(
        value["data"]["repository"]["coordinatedBranch"],
        Value::Null
    );
    assert_eq!(value["data"]["repository"]["worktreePath"], Value::Null);
    assert_eq!(
        value["data"]["repository"]["setupScript"],
        "repos/child/setup.sh"
    );
    assert_eq!(value["data"]["repository"]["setupScriptCreated"], false);
    let clone = fixture.workspace.join("repos/child");
    assert!(clone.join(".git").is_dir());
    assert_eq!(git(&clone, &["branch", "--show-current"]), "main");
    assert_eq!(
        fs::read_to_string(clone.join("README.md")).unwrap(),
        "child\n"
    );
    let config: Value =
        serde_json::from_slice(&fs::read(fixture.workspace.join(".arashi/config.json")).unwrap())
            .unwrap();
    assert_eq!(
        config["repos"]["child"],
        serde_json::json!({"gitUrl":fixture.remote,"path":"repos/child"})
    );
}

#[test]
fn file_url_and_custom_name_clone_to_the_configured_name() {
    let fixture = Fixture::new();
    let git_url = format!("file://{}", fixture.remote.display());
    let output = fixture.cli(&[
        "add",
        &git_url,
        "--json",
        "--force",
        "--name",
        "custom-child",
    ]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value = document(&output);
    assert_eq!(value["data"]["repository"]["name"], "custom-child");
    assert_eq!(value["data"]["repository"]["gitUrl"], git_url);
    assert_eq!(value["data"]["repository"]["path"], "repos/custom-child");
    assert!(fixture.workspace.join("repos/custom-child/.git").is_dir());
}

#[test]
fn derived_name_removes_only_one_git_suffix_like_source() {
    let fixture = Fixture::new();
    let renamed_remote = fixture.root.join("child.git.git");
    fs::rename(&fixture.remote, &renamed_remote).unwrap();
    let output = fixture.cli(&["add", renamed_remote.to_str().unwrap(), "--json", "--force"]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value = document(&output);
    assert_eq!(value["data"]["repository"]["name"], "child.git");
    assert_eq!(value["data"]["repository"]["path"], "repos/child.git");
    assert!(fixture.workspace.join("repos/child.git/.git").is_dir());
}

#[test]
fn duplicate_name_matches_source_error_and_does_not_mutate() {
    let fixture = Fixture::new();
    let config_path = fixture.workspace.join(".arashi/config.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    config["repos"]["child"] = serde_json::json!({"gitUrl":fixture.remote,"path":"repos/child"});
    fs::write(&config_path, serde_json::to_vec_pretty(&config).unwrap()).unwrap();
    let before = fixture.state();
    let output = fixture.add(&[]);
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(document(&output)["error"]["code"], "DUPLICATE_NAME");
    assert_eq!(fixture.state(), before);
}

#[test]
fn invalid_url_fails_before_any_mutation() {
    let fixture = Fixture::new();
    let before = fixture.state();
    let output = fixture.cli(&["add", "invalid-url", "--json", "--force"]);
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(document(&output)["error"]["code"], "INVALID_URL");
    assert_eq!(fixture.state(), before);
}

#[test]
fn unsupported_policies_fail_closed_before_mutation() {
    for args in [
        vec!["add", "ext::unsupported-child.git", "--json", "--force"],
        vec![
            "add",
            "/tmp/child.git",
            "--json",
            "--force",
            "--name",
            "../escape",
        ],
    ] {
        let fixture = Fixture::new();
        let before = fixture.state();
        let output = fixture.cli(&args);
        assert!(!output.status.success(), "unexpected success for {args:?}");
        if args.contains(&"--json") {
            assert_eq!(document(&output)["error"]["code"], "RUST_NOT_YET_PORTED");
        }
        assert_eq!(fixture.state(), before, "mutation for {args:?}");
    }
}

#[test]
fn linked_parent_topology_fails_before_clone_or_config_mutation() {
    let fixture = Fixture::new();
    let linked = fixture.root.join("linked");
    git(
        &fixture.workspace,
        &[
            "worktree",
            "add",
            "-b",
            "feature/add",
            linked.to_str().unwrap(),
        ],
    );
    let before = fixture.state();
    let output = Command::new(env!("CARGO_BIN_EXE_arashi"))
        .args(["add", fixture.remote.to_str().unwrap(), "--json", "--force"])
        .current_dir(&linked)
        .env("HOME", fixture.root.join("home"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            fixture.root.join("missing-global-config"),
        )
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(document(&output)["error"]["code"], "RUST_NOT_YET_PORTED");
    assert_eq!(fixture.state(), before);
    assert!(!linked.join("repos/child").exists());
}

#[test]
fn configured_filter_policy_is_rejected_before_clone() {
    let fixture = Fixture::new();
    git(
        &fixture.workspace,
        &["config", "filter.danger.smudge", "touch filter-ran"],
    );
    let before = fixture.state();
    let output = fixture.add(&[]);
    assert!(!output.status.success());
    assert_eq!(document(&output)["error"]["code"], "RUST_NOT_YET_PORTED");
    assert_eq!(fixture.state(), before);
    assert!(!fixture.workspace.join("filter-ran").exists());
}

#[test]
fn noncanonical_config_alias_is_rejected_before_mutation() {
    let fixture = Fixture::new();
    let config_path = fixture.workspace.join(".arashi/config.json");
    let bytes = fs::read(&config_path).unwrap();
    fs::write(
        &config_path,
        String::from_utf8(bytes)
            .unwrap()
            .replace("\"reposDir\"", "\"repos_dir\""),
    )
    .unwrap();
    let before = fixture.state();
    let output = fixture.add(&[]);
    assert!(!output.status.success());
    assert_eq!(document(&output)["error"]["code"], "RUST_NOT_YET_PORTED");
    assert_eq!(fixture.state(), before);
}

#[test]
fn inherited_git_repository_environment_is_rejected_before_mutation() {
    let fixture = Fixture::new();
    let external_index = fixture.root.join("external-index");
    let before = fixture.state();
    let output = Command::new(env!("CARGO_BIN_EXE_arashi"))
        .args(["add", fixture.remote.to_str().unwrap(), "--json", "--force"])
        .current_dir(&fixture.workspace)
        .env("HOME", fixture.root.join("home"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            fixture.root.join("missing-global-config"),
        )
        .env("GIT_INDEX_FILE", &external_index)
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert_eq!(document(&output)["error"]["code"], "RUST_NOT_YET_PORTED");
    assert_eq!(fixture.state(), before);
    assert!(!external_index.exists());
}

#[cfg(unix)]
#[test]
fn config_edit_during_discovery_is_preserved_by_the_add_write() {
    let fixture = Fixture::new();
    let fifo = fixture.root.join("global-config.fifo");
    let ready = fixture.root.join("global-config.ready");
    let release = fixture.root.join("global-config.release");
    assert!(
        Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );

    let script = r#"
exec 3>"$1"
: >"$2"
while [ ! -e "$3" ]; do sleep 0.01; done
printf '\n' >&3
exec 3>&-
while :; do
  printf '\n' >"$1" || exit
  sleep 0.05
done
"#;
    let mut feeder = Command::new("sh")
        .args(["-c", script, "sh"])
        .arg(&fifo)
        .arg(&ready)
        .arg(&release)
        .spawn()
        .unwrap();
    let native = Command::new(env!("CARGO_BIN_EXE_arashi"))
        .args(["add", fixture.remote.to_str().unwrap(), "--json", "--force"])
        .current_dir(&fixture.workspace)
        .env("HOME", fixture.root.join("home"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", &fifo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(ready.exists(), "native add did not reach Git discovery");
    let config_path = fixture.workspace.join(".arashi/config.json");
    fs::write(
        &config_path,
        format!(
            "{{\n  \"repos\": {{\n    \"existing\": {{\n      \"path\": \"repos/existing\",\n      \"gitUrl\": {}\n    }}\n  }},\n  \"reposDir\": \"./repos\",\n  \"version\": \"1.0.0\"\n}}",
            serde_json::to_string(fixture.remote.to_str().unwrap()).unwrap()
        ),
    )
    .unwrap();
    fs::write(&release, b"release\n").unwrap();

    let output = native.wait_with_output().unwrap();
    let _ = feeder.kill();
    let _ = feeder.wait();
    assert_eq!(
        output.status.code(),
        Some(0),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let persisted: Value = serde_json::from_slice(&fs::read(config_path).unwrap()).unwrap();
    assert_eq!(
        persisted["repos"]["existing"],
        serde_json::json!({"path":"repos/existing","gitUrl":fixture.remote})
    );
    assert!(persisted["repos"]["child"].is_object());
}

#[cfg(unix)]
#[test]
fn remote_symlink_topology_is_rejected_before_clone() {
    let fixture = Fixture::new();
    let seed = fixture.root.join("seed");
    std::os::unix::fs::symlink("README.md", seed.join("linked-readme")).unwrap();
    git(&seed, &["add", "linked-readme"]);
    git(&seed, &["commit", "-m", "add symlink"]);
    git(&seed, &["push", "origin", "main"]);
    let before = fixture.state();
    let output = fixture.add(&[]);
    assert!(!output.status.success());
    assert_eq!(document(&output)["error"]["code"], "RUST_NOT_YET_PORTED");
    assert_eq!(fixture.state(), before);
}

#[test]
#[ignore = "requires Node TypeScript source runtime"]
fn source_oracle_success_matches_json_and_persisted_effects() {
    source_add_effects(false);
}

#[test]
#[ignore = "requires Node TypeScript source runtime"]
fn source_oracle_add_preserves_canonical_switch_and_sync_config_bytes() {
    source_add_effects(true);
}

fn source_add_effects(policies: bool) {
    if std::env::var_os("ARASHI_TS_PARITY").is_none() {
        return;
    }
    let fixture = Fixture::new();
    let config_path = fixture.workspace.join(".arashi/config.json");
    if policies {
        let mut config: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
        config["defaults"] = serde_json::json!({"switch":{"mode":"cd"}});
        config["sync"] = serde_json::json!({"timeoutSeconds":10});
        fs::write(&config_path, serde_json::to_vec_pretty(&config).unwrap()).unwrap();
    }
    let exclude_path = fixture.workspace.join(".git/info/exclude");
    let config_before = fs::read(&config_path).unwrap();
    let exclude_before = fs::read(&exclude_path).unwrap();
    let source = fixture.source_add();
    assert_eq!(
        source.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&source.stderr)
    );
    let expected_document = document(&source);
    let expected_config = fs::read(&config_path).unwrap();
    let expected_exclude = fs::read(&exclude_path).unwrap();
    fs::remove_dir_all(fixture.workspace.join("repos/child")).unwrap();
    fs::write(&config_path, config_before).unwrap();
    fs::write(&exclude_path, exclude_before).unwrap();

    let native = fixture.add(&[]);
    assert_eq!(native.status.code(), source.status.code());
    assert_eq!(native.stderr, source.stderr);
    assert_eq!(document(&native), expected_document);
    assert_eq!(fs::read(&config_path).unwrap(), expected_config);
    assert_eq!(fs::read(&exclude_path).unwrap(), expected_exclude);
    assert_eq!(
        fs::read(fixture.workspace.join("repos/child/README.md")).unwrap(),
        b"child\n"
    );
}

#[test]
#[ignore = "requires Node TypeScript source runtime"]
fn source_oracle_preflight_errors_match_without_effects() {
    if std::env::var_os("ARASHI_TS_PARITY").is_none() {
        return;
    }
    let fixture = Fixture::new();
    for args in [
        vec!["add", "invalid-url", "--json", "--force"],
        vec![
            "add",
            fixture.remote.to_str().unwrap(),
            "--json",
            "--force",
            "--name",
            "existing",
        ],
    ] {
        if args.contains(&"existing") {
            let config_path = fixture.workspace.join(".arashi/config.json");
            let mut value: Value =
                serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
            value["repos"]["existing"] =
                serde_json::json!({"path":"repos/existing","gitUrl":fixture.remote});
            fs::write(config_path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        }
        let before = fixture.state();
        let source = Command::new("node")
            .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"))
            .args(&args)
            .current_dir(&fixture.workspace)
            .env("HOME", fixture.root.join("home"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                fixture.root.join("missing-global-config"),
            )
            .output()
            .unwrap();
        let native = fixture.cli(&args);
        assert_eq!(native.status.code(), source.status.code());
        assert_eq!(document(&native), document(&source));
        assert_eq!(fixture.state(), before);
    }
}

#[path = "rust/network.rs"]
mod network;

#[test]
#[cfg(unix)]
#[ignore = "requires Node and retained TypeScript dependencies"]
fn network_and_setup_match_source() {
    use std::os::unix::fs::PermissionsExt;
    for action in ["add", "clone", "setup"] {
        for prefix in [
            "direct",
            "https://example.invalid/",
            "ssh://git@example.invalid/",
            "git@example.invalid:",
        ] {
            let fixture = Fixture::new();
            if action == "setup" {
                let seed = fixture.root.join("seed");
                git(&seed, &["rm", "setup.sh"]);
                git(&seed, &["commit", "-m", "no setup"]);
                git(&seed, &["push", "origin", "main"]);
            }
            let daemon = network::GitDaemon::start(&fixture.root);
            let url = format!(
                "{}child.git",
                if prefix == "direct" {
                    &daemon.prefix
                } else {
                    prefix
                }
            );
            let global = fixture.root.join("missing-global-config");
            if prefix != "direct" {
                fs::write(
                    &global,
                    format!(
                        "[url \"{}\"]\n insteadOf = {prefix}\n[credential]\n helper =\n",
                        daemon.prefix
                    ),
                )
                .unwrap();
            }
            if action == "clone" {
                fs::create_dir(fixture.workspace.join("repos")).unwrap();
                fs::write(fixture.workspace.join(".arashi/config.json"), serde_json::json!({"version":"1.0.0","reposDir":"repos","repos":{"child":{"path":"repos/child","gitUrl":url}}}).to_string()).unwrap();
            }
            let before = fixture.state();
            let args = if action == "clone" {
                vec!["clone", "--all", "--json"]
            } else if action == "setup" {
                vec!["add", &url, "--json", "--force", "--create-setup"]
            } else {
                vec!["add", &url, "--json", "--force"]
            };
            let run = |source: bool| {
                let mut cmd = if source {
                    let mut c = Command::new("node");
                    c.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"));
                    c
                } else {
                    Command::new(env!("CARGO_BIN_EXE_arashi"))
                };
                cmd.args(&args)
                    .current_dir(&fixture.workspace)
                    .env("HOME", fixture.root.join("home"))
                    .env("GIT_CONFIG_NOSYSTEM", "1")
                    .env("GIT_CONFIG_GLOBAL", &global)
                    .env("GIT_ALLOW_PROTOCOL", "git")
                    .env("GIT_TERMINAL_PROMPT", "0")
                    .output()
                    .unwrap()
            };
            let source = run(true);
            assert!(
                source.status.success(),
                "{}",
                String::from_utf8_lossy(&source.stdout)
            );
            let effects = fixture.state();
            let child = fixture.workspace.join("repos/child");
            let oid = git(&child, &["rev-parse", "HEAD"]);
            let bytes = fs::read(child.join("setup.sh")).unwrap();
            let mode = fs::metadata(child.join("setup.sh"))
                .unwrap()
                .permissions()
                .mode();
            fs::remove_dir_all(&child).unwrap();
            fs::write(fixture.workspace.join(".arashi/config.json"), &before.0).unwrap();
            fs::write(fixture.workspace.join(".git/info/exclude"), &before.1).unwrap();
            let native = run(false);
            assert!(
                native.status.success(),
                "{action} {prefix}: {}",
                String::from_utf8_lossy(&native.stdout)
            );
            assert_eq!(document(&native), document(&source));
            assert_eq!(native.stderr, source.stderr);
            assert_eq!(fixture.state(), effects);
            assert_eq!(git(&child, &["rev-parse", "HEAD"]), oid);
            assert_eq!(git(&child, &["config", "--get", "remote.origin.url"]), url);
            assert_eq!(fs::read(child.join("setup.sh")).unwrap(), bytes);
            assert_eq!(
                fs::metadata(child.join("setup.sh"))
                    .unwrap()
                    .permissions()
                    .mode(),
                mode
            );
        }
    }
}

#[test]
#[ignore = "requires Node and retained TypeScript dependencies"]
fn configured_add_clone_and_shell_journey_preserves_command_policies() {
    for network in [false, true] {
        for source in [true, false] {
            let fixture = Fixture::new();
            let daemon = network.then(|| network::GitDaemon::start(&fixture.root));
            let url = daemon
                .as_ref()
                .map(|d| format!("{}child.git", d.prefix))
                .unwrap_or_else(|| fixture.remote.to_string_lossy().into_owned());
            let config_path = fixture.workspace.join(".arashi/config.json");
            let mut config: Value =
                serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
            config["defaults"] = serde_json::json!({"switch":{"mode":"cd"}});
            config["sync"] = serde_json::json!({"timeoutSeconds":10});
            fs::write(&config_path, serde_json::to_vec_pretty(&config).unwrap()).unwrap();
            let run = |args: &[&str]| {
                let mut command = if source {
                    let mut cmd = Command::new("node");
                    cmd.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"));
                    cmd
                } else {
                    Command::new(env!("CARGO_BIN_EXE_arashi"))
                };
                command
                    .args(args)
                    .current_dir(&fixture.workspace)
                    .env("HOME", fixture.root.join("home"))
                    .env("GIT_CONFIG_NOSYSTEM", "1")
                    .env("GIT_CONFIG_GLOBAL", "/dev/null")
                    .env("GIT_ALLOW_PROTOCOL", if network { "git" } else { "file" })
                    .env("GIT_TERMINAL_PROMPT", "0")
                    .stdin(Stdio::null())
                    .output()
                    .unwrap()
            };
            let add = run(&["add", &url, "--json"]);
            assert!(
                add.status.success(),
                "add source={source} network={network}: {} {}",
                String::from_utf8_lossy(&add.stdout),
                String::from_utf8_lossy(&add.stderr)
            );
            let persisted: Value =
                serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
            assert_eq!(persisted["defaults"], config["defaults"]);
            assert_eq!(persisted["sync"], config["sync"]);
            let saved = fs::read(&config_path).unwrap();
            let inspect = run(&["configure", "--json"]);
            assert!(
                inspect.status.success(),
                "{}",
                String::from_utf8_lossy(&inspect.stdout)
            );
            assert_eq!(fs::read(&config_path).unwrap(), saved);
            let child = fixture.workspace.join("repos/child");
            let oid = git(&child, &["rev-parse", "HEAD"]);
            fs::remove_dir_all(&child).unwrap();
            let cloned = run(&["clone", "--all", "--json"]);
            assert!(
                cloned.status.success(),
                "clone source={source}: {}",
                String::from_utf8_lossy(&cloned.stdout)
            );
            assert_eq!(git(&child, &["rev-parse", "HEAD"]), oid);
            assert_eq!(git(&child, &["config", "--get", "remote.origin.url"]), url);
            assert_eq!(fs::read(&config_path).unwrap(), saved);
            assert!(run(&["clone", "--all", "--json"]).status.success());
            // Network/local-origin sync remains unsupported, with no mutation.
            if !source {
                let rejected = run(&["sync", "--json"]);
                assert!(!rejected.status.success());
                assert_eq!(document(&rejected)["error"]["code"], "RUST_NOT_YET_PORTED");
                assert_eq!(fs::read(&config_path).unwrap(), saved);
                assert_eq!(git(&child, &["rev-parse", "HEAD"]), oid);
                assert_eq!(git(&child, &["branch", "--show-current"]), "main");
            }
            // Explicitly disconnect the disposable origin and its configured URL
            // before exercising the supported local-only sync consumer.
            git(&child, &["remote", "remove", "origin"]);
            let mut local_config: Value = serde_json::from_slice(&saved).unwrap();
            local_config["repos"]["child"]
                .as_object_mut()
                .unwrap()
                .remove("gitUrl");
            fs::write(
                &config_path,
                serde_json::to_vec_pretty(&local_config).unwrap(),
            )
            .unwrap();
            let saved = fs::read(&config_path).unwrap();
            git(&fixture.workspace, &["checkout", "-b", "journey"]);
            let sync = run(&["sync", "--json"]);
            assert!(
                sync.status.success(),
                "sync source={source}: {}",
                String::from_utf8_lossy(&sync.stdout)
            );
            assert_eq!(git(&child, &["branch", "--show-current"]), "journey");
            assert_eq!(git(&child, &["rev-parse", "HEAD"]), oid);
            assert!(run(&["sync", "--json"]).status.success());
            assert!(run(&["status", "--json"]).status.success());
            assert!(run(&["handoff", "--json"]).status.success());
            let wrapper = run(&["shell", "init", "bash"]);
            assert!(wrapper.status.success());
            let script = fixture.root.join("journey.sh");
            let binary = if source {
                format!(
                    "node '{}'",
                    Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("src/index.ts")
                        .display()
                )
            } else {
                format!("'{}'", env!("CARGO_BIN_EXE_arashi"))
            };
            let bin = fixture.root.join("bin");
            fs::create_dir(&bin).unwrap();
            fs::write(
                bin.join("arashi"),
                format!("#!/bin/sh\nexec {binary} \"$@\"\n"),
            )
            .unwrap();
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(bin.join("arashi"), fs::Permissions::from_mode(0o755)).unwrap();
            std::os::unix::fs::symlink("arashi", bin.join("aw")).unwrap();
            let mut paths = vec![bin];
            paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap()));
            let script_text = format!(
                "set -e\n{}\narashi switch --repos --path '{}'\ntest \"$PWD\" = '{}'\naw switch --cd --path '{}'\ntest \"$PWD\" = '{}'\n",
                String::from_utf8(wrapper.stdout).unwrap(),
                child.display(),
                child.display(),
                fixture.workspace.display(),
                fixture.workspace.display()
            );
            fs::write(&script, script_text).unwrap();
            let shell = Command::new("bash")
                .arg(&script)
                .current_dir(&fixture.workspace)
                .env("PATH", std::env::join_paths(paths).unwrap())
                .env("HOME", fixture.root.join("home"))
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env_remove("TERM_PROGRAM")
                .env_remove("VSCODE_PID")
                .env_remove("VSCODE_GIT_IPC_HANDLE")
                .output()
                .unwrap();
            assert!(
                shell.status.success(),
                "shell source={source}: {} {}",
                String::from_utf8_lossy(&shell.stdout),
                String::from_utf8_lossy(&shell.stderr)
            );
            assert_eq!(fs::read(&config_path).unwrap(), saved);
        }
    }
}

#[test]
fn clone_all_human_is_supported() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.workspace.join("repos")).unwrap();
    fs::write(fixture.workspace.join(".arashi/config.json"),serde_json::json!({"version":"1.0.0","reposDir":"repos","repos":{"child":{"path":"repos/child","gitUrl":fixture.remote}}}).to_string()).unwrap();
    let output = fixture.cli(&["clone", "--all"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("child"));
    assert!(fixture.workspace.join("repos/child/.git").is_dir());
}

#[test]
#[cfg(unix)]
fn native_network_add_and_clone_use_loopback_transport() {
    for action in ["add", "clone"] {
        let fixture = Fixture::new();
        let daemon = network::GitDaemon::start(&fixture.root);
        let url = format!("{}child.git", daemon.prefix);
        if action == "clone" {
            fs::create_dir(fixture.workspace.join("repos")).unwrap();
            fs::write(fixture.workspace.join(".arashi/config.json"),serde_json::json!({"version":"1.0.0","reposDir":"repos","repos":{"child":{"path":"repos/child","gitUrl":url}}}).to_string()).unwrap();
        }
        let args = if action == "add" {
            vec!["add", &url, "--json", "--force"]
        } else {
            vec!["clone", "--all", "--json"]
        };
        let output = Command::new(env!("CARGO_BIN_EXE_arashi"))
            .args(args)
            .current_dir(&fixture.workspace)
            .env("HOME", fixture.root.join("home"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_ALLOW_PROTOCOL", "git")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        let child = fixture.workspace.join("repos/child");
        assert_eq!(
            git(&child, &["rev-parse", "HEAD"]),
            git(&fixture.remote, &["rev-parse", "HEAD"])
        );
        assert_eq!(fs::read(child.join("README.md")).unwrap(), b"child\n");
    }
}

#[test]
fn configured_add_json_or_force_is_noninteractive() {
    for option in ["--json", "--force"] {
        let fixture = Fixture::new();
        let output = fixture.cli(&["add", fixture.remote.to_str().unwrap(), option]);
        assert!(
            output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(fixture.workspace.join("repos/child/.git").is_dir());
    }
}

#[test]
fn network_create_setup_never_follows_dangling_symlink() {
    let fixture = Fixture::new();
    let outside = fixture.root.join("outside-script");
    let seed = fixture.root.join("seed");
    git(&seed, &["rm", "setup.sh"]);
    std::os::unix::fs::symlink(&outside, seed.join("setup.sh")).unwrap();
    git(&seed, &["add", "setup.sh"]);
    git(&seed, &["commit", "-m", "dangling symlink"]);
    git(&seed, &["push", "origin", "main"]);
    let before = fs::read(fixture.workspace.join(".arashi/config.json")).unwrap();
    let daemon = network::GitDaemon::start(&fixture.root);
    let output = Command::new(env!("CARGO_BIN_EXE_arashi"))
        .args([
            "add",
            &format!("{}child.git", daemon.prefix),
            "--json",
            "--create-setup",
        ])
        .current_dir(&fixture.workspace)
        .env("HOME", fixture.root.join("home"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_ALLOW_PROTOCOL", "git")
        .output()
        .unwrap();
    assert!(!outside.exists(), "setup creation escaped clone");
    assert!(!output.status.success());
    assert_eq!(
        fs::read(fixture.workspace.join(".arashi/config.json")).unwrap(),
        before
    );
}
