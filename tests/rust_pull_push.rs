use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Daemon(std::process::Child);
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn daemon(f: &Fixture) -> (Daemon, String) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let child = Command::new("git")
        .args([
            "daemon",
            "--reuseaddr",
            "--listen=127.0.0.1",
            &format!("--port={port}"),
            "--export-all",
            "--enable=receive-pack",
            &format!("--base-path={}", f.base.display()),
            f.base.to_str().unwrap(),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut guard = Daemon(child);
    let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        assert!(guard.0.try_wait().unwrap().is_none(), "git daemon exited");
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        assert!(
            std::time::Instant::now() < until,
            "git daemon readiness timeout"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    (guard, format!("git://127.0.0.1:{port}/child.git"))
}
#[test]
fn real_git_transport_pull_and_push() {
    let f = Fixture::new(None);
    let (_daemon, url) = daemon(&f);
    git(&f.child, &["remote", "set-url", "origin", &url]);
    let pulled = f.advance(&f.child_remote, "network-advance", "network.txt");
    let output = f.run(&["pull", "--only", "child", "--json"]);
    assert!(output.status.success(), "{}", json(&output));
    assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), pulled);
    let pushed = f.feature(&f.child, "network-feature", "publish.txt");
    let preview = f.run(&[
        "push",
        "--only",
        "child",
        "--set-upstream",
        "--dry-run",
        "--json",
    ]);
    assert!(preview.status.success(), "{}", json(&preview));
    assert_eq!(json(&preview)["data"]["results"][0]["status"], "planned");
    let output = f.run(&["push", "--only", "child", "--set-upstream", "--json"]);
    assert!(output.status.success(), "{}", json(&output));
    assert_eq!(
        git(
            &f.child_remote,
            &["rev-parse", "refs/heads/network-feature"]
        ),
        pushed
    );
    assert_eq!(
        git(&f.child, &["rev-parse", "--abbrev-ref", "@{u}"]),
        "origin/network-feature"
    );
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn source_parity_network_current_and_preview() {
    if std::env::var("ARASHI_TS_PARITY").as_deref() != Ok("1") {
        return;
    }
    let f = Fixture::new(None);
    let (_daemon, url) = daemon(&f);
    git(&f.child, &["remote", "set-url", "origin", &url]);
    compare_json(
        &f.run_impl(true, &["pull", "--only", "child", "--json"]),
        &f.run(&["pull", "--only", "child", "--json"]),
    );
    f.feature(&f.child, "network-preview", "preview.txt");
    let args = [
        "push",
        "--only",
        "child",
        "--set-upstream",
        "--dry-run",
        "--json",
    ];
    compare_json(&f.run_impl(true, &args), &f.run(&args));
}

#[test]
fn network_failure_continues_to_later_repository() {
    for operation in ["pull", "push"] {
        let f = Fixture::new(None);
        let (_daemon, url) = daemon(&f);
        let failing = if operation == "pull" {
            &f.root
        } else {
            &f.child
        };
        git(
            failing,
            &[
                "remote",
                "set-url",
                "origin",
                &url.replace("child.git", "missing.git"),
            ],
        );
        let expected = if operation == "pull" {
            f.advance(&f.child_remote, "continue-network", "continued.txt")
        } else {
            f.feature(&f.root, "continue-network", "continued.txt")
        };
        let mut args = vec![operation, "--only", "child,@meta", "--json"];
        if operation == "push" {
            args.push("--set-upstream");
        }
        let output = f.run(&args);
        assert_eq!(output.status.code(), Some(1), "{}", json(&output));
        let envelope = json(&output);
        let results = if operation == "pull" {
            &envelope["data"]["results"]
        } else {
            &envelope["error"]["details"]["results"]
        };
        assert_eq!(results[0]["status"], "failed");
        assert_eq!(
            results[1]["status"],
            if operation == "pull" {
                "updated"
            } else {
                "pushed"
            }
        );
        let actual = if operation == "pull" {
            git(&f.child, &["rev-parse", "HEAD"])
        } else {
            git(
                &f.main_remote,
                &["rev-parse", "refs/heads/continue-network"],
            )
        };
        assert_eq!(actual, expected);
    }
}

#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn source_parity_pull_is_parent_first_and_push_preserves_selection() {
    if std::env::var("ARASHI_TS_PARITY").as_deref() != Ok("1") {
        return;
    }
    for operation in ["pull", "push"] {
        let f = Fixture::new(None);
        let args = [operation, "--only", "child,workspace,workspace", "--json"];
        let source = f.run_impl(true, &args);
        let native = f.run(&args);
        compare_json(&source, &native);
        let value = json(&native);
        let names: Vec<_> = value["data"]["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["repositoryId"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            if operation == "pull" {
                vec!["workspace", "child"]
            } else {
                vec!["child", "workspace"]
            }
        );
    }
}

#[test]
fn verbose_pull_reports_git_output() {
    let f = Fixture::new(None);
    f.advance(&f.child_remote, "verbose-advance", "verbose.txt");
    let output = f.run(&["pull", "--only", "child", "--verbose"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("verbose.txt"));
}

struct Fixture {
    base: PathBuf,
    root: PathBuf,
    home: PathBuf,
    main_remote: PathBuf,
    child_remote: PathBuf,
    child: PathBuf,
}

impl Fixture {
    fn new(timeout_ms: Option<u64>) -> Self {
        let base = std::env::temp_dir().join(format!(
            "arashi-pull-push-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&base).unwrap();
        let base = fs::canonicalize(base).unwrap();
        let home = base.join("home");
        fs::create_dir(&home).unwrap();
        let main_remote = base.join("main.git");
        let child_remote = base.join("child.git");
        bare(&base, &main_remote);
        bare(&base, &child_remote);
        seed(&base, &main_remote, "main-seed");
        seed(&base, &child_remote, "child-seed");
        let root = base.join("workspace");
        git(
            &base,
            &[
                "clone",
                main_remote.to_str().unwrap(),
                root.to_str().unwrap(),
            ],
        );
        configure(&root);
        let child = root.join("repos/child");
        fs::create_dir(root.join("repos")).unwrap();
        git(
            &root.join("repos"),
            &[
                "clone",
                child_remote.to_str().unwrap(),
                child.to_str().unwrap(),
            ],
        );
        configure(&child);
        fs::create_dir(root.join(".arashi")).unwrap();
        let hooks = timeout_ms.map_or(String::new(), |value| {
            format!(r#", "hooks": {{ "timeout": {value} }}"#)
        });
        fs::write(
            root.join(".arashi/config.json"),
            format!(
                r#"{{"version":"1.0.0","reposDir":"repos","worktreesDir":".arashi/worktrees","repos":{{"child":{{"path":"repos/child","groups":["children"]}}}}{hooks}}}"#,
            ),
        )
        .unwrap();
        fs::write(
            root.join(".git/info/exclude"),
            "/repos/\n/.arashi/worktrees/\n",
        )
        .unwrap();
        git(&root, &["add", ".arashi/config.json"]);
        git(&root, &["commit", "-m", "configure workspace"]);
        git(&root, &["push", "origin", "HEAD:main"]);
        Self {
            base,
            root,
            home,
            main_remote,
            child_remote,
            child,
        }
    }

    fn run(&self, args: &[&str]) -> Output {
        self.run_impl(false, args)
    }

    fn run_impl(&self, source: bool, args: &[&str]) -> Output {
        let mut command = if source {
            let mut command = Command::new("node");
            command.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"));
            command
        } else {
            Command::new(env!("CARGO_BIN_EXE_arashi"))
        };
        command
            .args(args)
            .current_dir(&self.root)
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.home.join(".gitconfig"))
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("NO_COLOR", "1")
            .env("GIT_ALLOW_PROTOCOL", "file:git");
        command.output().unwrap()
    }

    fn advance(&self, remote: &Path, name: &str, file: &str) -> String {
        let work = self.base.join(name);
        git(
            &self.base,
            &["clone", remote.to_str().unwrap(), work.to_str().unwrap()],
        );
        configure(&work);
        fs::write(work.join(file), format!("{name}\n")).unwrap();
        git(&work, &["add", file]);
        git(&work, &["commit", "-m", name]);
        git(&work, &["push", "origin", "HEAD:main"]);
        git(remote, &["rev-parse", "refs/heads/main"])
    }

    fn feature(&self, repo: &Path, name: &str, file: &str) -> String {
        git(repo, &["checkout", "-b", name]);
        fs::write(repo.join(file), format!("{name}\n")).unwrap();
        git(repo, &["add", file]);
        git(repo, &["commit", "-m", name]);
        git(repo, &["rev-parse", "HEAD"])
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn configure(path: &Path) {
    git(path, &["config", "user.name", "Arashi Test"]);
    git(path, &["config", "user.email", "arashi@example.invalid"]);
    git(path, &["config", "commit.gpgSign", "false"]);
    git(path, &["config", "maintenance.auto", "false"]);
}

fn bare(base: &Path, path: &Path) {
    git(base, &["init", "--bare", path.to_str().unwrap()]);
}

fn seed(base: &Path, remote: &Path, name: &str) {
    let work = base.join(name);
    git(
        base,
        &["clone", remote.to_str().unwrap(), work.to_str().unwrap()],
    );
    configure(&work);
    fs::write(work.join("README.md"), format!("{name}\n")).unwrap();
    git(&work, &["add", "README.md"]);
    git(&work, &["commit", "-m", "initial"]);
    git(&work, &["push", "origin", "HEAD:main"]);
    git(remote, &["symbolic-ref", "HEAD", "refs/heads/main"]);
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(["-c", "maintenance.auto=false"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn json(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "invalid JSON: {error}\nstdout={}\nstderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

fn normalize_elapsed(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if key == "elapsedSeconds" {
                    *value = serde_json::json!(0);
                } else {
                    normalize_elapsed(value);
                }
            }
        }
        Value::Array(values) => values.iter_mut().for_each(normalize_elapsed),
        _ => {}
    }
}

fn compare_json(source: &Output, native: &Output) {
    assert_eq!(source.status.code(), native.status.code());
    assert_eq!(source.stderr, native.stderr);
    let mut source = json(source);
    let mut native = json(native);
    normalize_elapsed(&mut source);
    normalize_elapsed(&mut native);
    assert_eq!(source, native);
}

#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn source_parity_for_current_pull_json() {
    if std::env::var("ARASHI_TS_PARITY").as_deref() != Ok("1") {
        return;
    }
    let f = Fixture::new(None);
    compare_json(
        &f.run_impl(true, &["pull", "--json"]),
        &f.run(&["pull", "--json"]),
    );
}

#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn source_parity_for_push_dry_run_json() {
    if std::env::var("ARASHI_TS_PARITY").as_deref() != Ok("1") {
        return;
    }
    let f = Fixture::new(None);
    f.feature(&f.child, "feature/parity", "parity.txt");
    let args = [
        "push",
        "--only",
        "child",
        "--set-upstream",
        "--dry-run",
        "--json",
    ];
    compare_json(&f.run_impl(true, &args), &f.run(&args));
}

#[test]
fn pull_updates_parent_then_child_and_reports_json() {
    let f = Fixture::new(None);
    let main = f.advance(&f.main_remote, "main-update", "main.txt");
    let child = f.advance(&f.child_remote, "child-update", "child.txt");
    let output = f.run(&["pull", "--json"]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value = json(&output);
    assert_eq!(value["ok"], true);
    assert_eq!(value["data"]["overallStatus"], "success");
    let results = value["data"]["results"].as_array().unwrap();
    assert_eq!(
        results
            .iter()
            .map(|v| v["repositoryId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["workspace", "child"]
    );
    assert!(results.iter().all(|v| v["status"] == "updated"));
    assert_eq!(git(&f.root, &["rev-parse", "HEAD"]), main);
    assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), child);
}

#[test]
fn pull_only_and_group_preserve_explicit_selection() {
    let f = Fixture::new(None);
    let before = git(&f.root, &["rev-parse", "HEAD"]);
    let child = f.advance(&f.child_remote, "selected-update", "selected.txt");
    let output = f.run(&["pull", "--only", "child", "--group", "CHILDREN", "--json"]);
    assert_eq!(output.status.code(), Some(0));
    let value = json(&output);
    assert_eq!(value["data"]["results"].as_array().unwrap().len(), 1);
    assert_eq!(value["data"]["results"][0]["repositoryId"], "child");
    assert_eq!(git(&f.root, &["rev-parse", "HEAD"]), before);
    assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), child);
}

#[test]
fn pull_dirty_failure_continues_without_touching_dirty_repository() {
    let f = Fixture::new(None);
    let main = f.advance(&f.child_remote, "continuation-main", "continued.txt");
    let child_before = git(&f.root, &["rev-parse", "HEAD"]);
    fs::write(f.root.join("README.md"), "caller change\n").unwrap();
    f.advance(&f.main_remote, "dirty-child", "remote.txt");
    let output = f.run(&["pull", "--only", "child", "--only", "workspace", "--json"]);
    assert_eq!(output.status.code(), Some(1));
    let value = json(&output);
    assert_eq!(value["data"]["overallStatus"], "partial-failure");
    assert_eq!(value["data"]["results"][0]["status"], "failed");
    assert_eq!(value["data"]["results"][1]["status"], "updated");
    assert_eq!(git(&f.root, &["rev-parse", "HEAD"]), child_before);
    assert_eq!(
        fs::read_to_string(f.root.join("README.md")).unwrap(),
        "caller change\n"
    );
    assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), main);
}

#[test]
fn pull_divergence_fails_without_moving_head_or_tracking_ref() {
    let f = Fixture::new(None);
    fs::write(f.child.join("local.txt"), "local\n").unwrap();
    git(&f.child, &["add", "local.txt"]);
    git(&f.child, &["commit", "-m", "local"]);
    let head = git(&f.child, &["rev-parse", "HEAD"]);
    let tracking = git(&f.child, &["rev-parse", "refs/remotes/origin/main"]);
    f.advance(&f.child_remote, "diverged-child", "remote.txt");
    let output = f.run(&["pull", "--only", "child", "--json"]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        json(&output)["data"]["results"][0]["status"],
        "manual-update"
    );
    assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), head);
    assert_eq!(
        git(&f.child, &["rev-parse", "refs/remotes/origin/main"]),
        tracking
    );
}

#[test]
fn pull_timeout_is_failed_and_does_not_move_head() {
    let f = Fixture::new(Some(1));
    let before = git(&f.child, &["rev-parse", "HEAD"]);
    f.advance(&f.child_remote, "timeout-child", "timeout.txt");
    let output = f.run(&["pull", "--only", "child", "--json"]);
    assert_eq!(output.status.code(), Some(1));
    let result = &json(&output)["data"]["results"][0];
    assert_eq!(result["status"], "failed");
    assert!(
        result["errorMessage"]
            .as_str()
            .unwrap()
            .contains("Timed out")
    );
    assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), before);
}

#[test]
fn pull_rejects_helper_remote_before_any_selected_repository_changes() {
    let f = Fixture::new(None);
    let before = git(&f.root, &["rev-parse", "HEAD"]);
    f.advance(&f.main_remote, "blocked-main", "blocked.txt");
    git(
        &f.child,
        &["remote", "set-url", "origin", "ext::untrusted-helper"],
    );
    let output = f.run(&["pull", "--json"]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(json(&output)["error"]["code"], "PORT_UNSUPPORTED");
    assert_eq!(git(&f.root, &["rev-parse", "HEAD"]), before);
    assert!(!f.root.join("blocked.txt").exists());
}

#[test]
fn push_set_upstream_uses_selection_order_and_updates_local_remote() {
    let f = Fixture::new(None);
    let child_oid = f.feature(&f.child, "feature/push", "child-feature.txt");
    let output = f.run(&["push", "--only", "child", "--set-upstream", "--json"]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value = json(&output);
    assert_eq!(
        value["data"]["totals"],
        serde_json::json!({"failed":0,"planned":0,"pushed":1,"skipped":0,"total":1})
    );
    assert_eq!(value["data"]["results"][0]["repositoryId"], "child");
    assert_eq!(value["data"]["results"][0]["status"], "pushed");
    assert_eq!(
        git(&f.child_remote, &["rev-parse", "refs/heads/feature/push"]),
        child_oid
    );
    assert_eq!(
        git(&f.child, &["rev-parse", "--abbrev-ref", "@{u}"]),
        "origin/feature/push"
    );
}

#[test]
fn push_dry_run_and_missing_upstream_do_not_create_remote_refs() {
    let f = Fixture::new(None);
    f.feature(&f.root, "feature/preview", "preview.txt");
    let skipped = f.run(&["push", "--only", "workspace", "--json"]);
    assert_eq!(skipped.status.code(), Some(0));
    assert_eq!(json(&skipped)["data"]["results"][0]["status"], "skipped");
    let preview = f.run(&[
        "push",
        "--only",
        "workspace",
        "--set-upstream",
        "--dry-run",
        "--json",
    ]);
    assert_eq!(preview.status.code(), Some(0));
    assert_eq!(json(&preview)["data"]["results"][0]["status"], "planned");
    assert!(
        Command::new("git")
            .args(["rev-parse", "--verify", "refs/heads/feature/preview"])
            .current_dir(&f.main_remote)
            .output()
            .unwrap()
            .status
            .code()
            != Some(0)
    );
}

#[test]
fn push_diverged_failure_continues_and_preserves_rejected_remote_ref() {
    let f = Fixture::new(None);
    let main_oid = f.feature(&f.root, "feature/coordinated", "main-feature.txt");
    f.feature(&f.child, "feature/coordinated", "child-feature.txt");
    let publisher = f.base.join("publisher");
    git(
        &f.base,
        &[
            "clone",
            f.child_remote.to_str().unwrap(),
            publisher.to_str().unwrap(),
        ],
    );
    configure(&publisher);
    git(&publisher, &["checkout", "-b", "feature/coordinated"]);
    fs::write(publisher.join("remote-feature.txt"), "remote\n").unwrap();
    git(&publisher, &["add", "remote-feature.txt"]);
    git(&publisher, &["commit", "-m", "remote feature"]);
    git(&publisher, &["push", "origin", "HEAD:feature/coordinated"]);
    let rejected = git(
        &f.child_remote,
        &["rev-parse", "refs/heads/feature/coordinated"],
    );
    let output = f.run(&["push", "--set-upstream", "--json"]);
    assert_eq!(output.status.code(), Some(1));
    let value = json(&output);
    assert_eq!(value["error"]["code"], "PUSH_FAILED");
    let results = value["error"]["details"]["results"].as_array().unwrap();
    assert_eq!(results[0]["status"], "pushed");
    assert_eq!(results[1]["status"], "failed");
    assert_eq!(
        git(
            &f.main_remote,
            &["rev-parse", "refs/heads/feature/coordinated"]
        ),
        main_oid
    );
    assert_eq!(
        git(
            &f.child_remote,
            &["rev-parse", "refs/heads/feature/coordinated"]
        ),
        rejected
    );
}

#[test]
fn push_dirty_repository_fails_without_creating_remote_ref() {
    let f = Fixture::new(None);
    f.feature(&f.child, "feature/dirty", "committed.txt");
    fs::write(f.child.join("dirty.txt"), "dirty\n").unwrap();
    let output = f.run(&["push", "--only", "child", "--set-upstream", "--json"]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        json(&output)["error"]["details"]["results"][0]["status"],
        "failed"
    );
    assert!(
        Command::new("git")
            .args(["rev-parse", "--verify", "refs/heads/feature/dirty"])
            .current_dir(&f.child_remote)
            .output()
            .unwrap()
            .status
            .code()
            != Some(0)
    );
}

#[test]
fn push_rejects_helper_remote_before_any_selected_repository_changes() {
    let f = Fixture::new(None);
    f.feature(&f.root, "feature/blocked", "blocked.txt");
    f.feature(&f.child, "feature/blocked", "blocked-child.txt");
    git(
        &f.child,
        &["remote", "set-url", "origin", "ext::untrusted-helper"],
    );
    let output = f.run(&["push", "--set-upstream", "--json"]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(json(&output)["error"]["code"], "PORT_UNSUPPORTED");
    assert!(
        Command::new("git")
            .args(["rev-parse", "--verify", "refs/heads/feature/blocked"])
            .current_dir(&f.main_remote)
            .output()
            .unwrap()
            .status
            .code()
            != Some(0)
    );
}

#[cfg(unix)]
#[test]
fn push_rejects_remote_hooks_before_the_hook_or_ref_can_change() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new(None);
    f.feature(&f.child, "feature/remote-hook", "hook-feature.txt");
    let marker = f.base.join("remote-hook-ran");
    let hook = f.child_remote.join("hooks/pre-receive");
    fs::write(
        &hook,
        format!("#!/bin/sh\nprintf ran > '{}'\n", marker.display()),
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();

    let output = f.run(&["push", "--only", "child", "--set-upstream", "--json"]);

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(json(&output)["error"]["code"], "PORT_UNSUPPORTED");
    assert!(!marker.exists());
    assert!(
        Command::new("git")
            .args(["rev-parse", "--verify", "refs/heads/feature/remote-hook",])
            .current_dir(&f.child_remote)
            .output()
            .unwrap()
            .status
            .code()
            != Some(0)
    );
}

#[test]
fn human_pull_and_push_render_progress_results_and_summaries() {
    let f = Fixture::new(None);
    f.advance(&f.child_remote, "human-pull", "human.txt");
    let pull = f.run(&["pull", "--only", "child"]);
    let stdout = String::from_utf8(pull.stdout).unwrap();
    assert!(stdout.contains("[1/1] child"));
    assert!(stdout.contains("child: updated"));
    assert!(stdout.contains("Summary:"));
    f.feature(&f.child, "feature/human", "human-feature.txt");
    let push = f.run(&["push", "--only", "child", "--set-upstream"]);
    let stdout = String::from_utf8(push.stdout).unwrap();
    assert!(stdout.contains("[1/1] child"));
    assert!(stdout.contains("child: pushed"));
    assert!(stdout.contains("Summary:"));
}
