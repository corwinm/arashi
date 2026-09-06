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
        #[cfg(windows)]
        if matches!(self.0.try_wait(), Ok(None)) {
            // Keep the owned server root alive until all-name descendant cleanup.
            let _ = Command::new("taskkill.exe")
                .args(["/PID", &self.0.id().to_string(), "/T", "/F"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
        #[cfg(unix)]
        {
            // git's launcher can leave git-daemon alive; settle the private group.
            let _ = Command::new("kill")
                .args(["-KILL", "--", &format!("-{}", self.0.id())])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[cfg(windows)]
fn daemon(f: &Fixture) -> (Daemon, String) {
    let ready = f.base.join("http-port");
    let log = fs::File::create(f.base.join("http-server.log")).unwrap();
    let child = Command::new("node")
        .env_clear()
        .envs(std::env::vars_os().filter(|(key, _)| {
            matches!(
                key.to_string_lossy().to_ascii_lowercase().as_str(),
                "path" | "systemroot" | "windir" | "temp" | "tmp" | "pathext"
            )
        }))
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/rust/git-http-server.cjs"))
        .arg(&f.base)
        .arg(&ready)
        .stdout(std::process::Stdio::null())
        .stderr(log)
        .spawn()
        .expect("Windows network fixtures require Node 24 and native Git on PATH");
    let mut guard = Daemon(child);
    let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        assert!(
            guard.0.try_wait().unwrap().is_none(),
            "HTTP fixture exited: {}",
            fs::read_to_string(f.base.join("http-server.log")).unwrap_or_default()
        );
        if let Ok(port) = fs::read_to_string(&ready)
            && let Ok(port) = port.parse::<u16>()
        {
            return (guard, format!("http://127.0.0.1:{port}/child.git"));
        }
        assert!(
            std::time::Instant::now() < until,
            "HTTP fixture readiness timeout"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[cfg(not(windows))]
fn daemon(f: &Fixture) -> (Daemon, String) {
    use std::os::unix::process::CommandExt;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let child = git_command()
        .process_group(0)
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

fn ahead_only_commit_pull_push(network: bool) {
    // Separate fixtures prevent the source fetch from preparing native objects/refs.
    let implementations = if std::env::var("ARASHI_TS_PARITY").as_deref() == Ok("1") {
        vec![true, false]
    } else {
        vec![false]
    };
    for source in implementations {
        let f = Fixture::new(None);
        let _daemon = if network {
            let (daemon, url) = daemon(&f);
            git(&f.child, &["remote", "set-url", "origin", &url]);
            Some(daemon)
        } else {
            let url = format!("file://{}", f.child_remote.display());
            git(&f.child, &["remote", "set-url", "origin", &url]);
            None
        };
        let config = fs::read(f.root.join(".arashi/config.json")).unwrap();
        let remote = git(&f.child_remote, &["rev-parse", "refs/heads/main"]);
        let url = git(&f.child, &["remote", "get-url", "origin"]);
        fs::write(f.child.join("local.txt"), "unpublished commit\n").unwrap();
        git(&f.child, &["add", "local.txt"]);
        git(&f.child, &["commit", "-m", "ordinary local commit"]);
        let local = git(&f.child, &["rev-parse", "HEAD"]);
        assert_ne!(local, remote);
        // The bare origin deliberately does not have the unpublished local object.
        assert!(
            !git_command()
                .args(["cat-file", "-e", &local])
                .current_dir(&f.child_remote)
                .output()
                .unwrap()
                .status
                .success()
        );
        let pull = f.run_impl(source, &["pull", "--only", "child,workspace", "--json"]);
        eprintln!(
            "ahead-only source={source} network={network}: {}",
            json(&pull)
        );
        assert!(pull.status.success(), "{}", json(&pull));
        let value = json(&pull);
        assert_eq!(value["data"]["overallStatus"], "success");
        let results = value["data"]["results"].as_array().unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["repositoryId"], "workspace");
        assert_eq!(results[1]["repositoryId"], "child");
        assert!(results.iter().all(|row| row["status"] == "skipped"));
        assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), local);
        assert_eq!(
            git(&f.child_remote, &["rev-parse", "refs/heads/main"]),
            remote
        );
        assert_eq!(
            git(&f.child, &["rev-parse", "refs/remotes/origin/main"]),
            remote
        );
        let preview = f.run_impl(source, &["push", "--only", "child", "--dry-run", "--json"]);
        assert!(preview.status.success(), "{}", json(&preview));
        assert_eq!(json(&preview)["data"]["results"][0]["status"], "planned");
        assert_eq!(
            git(&f.child_remote, &["rev-parse", "refs/heads/main"]),
            remote
        );
        let push = f.run_impl(source, &["push", "--only", "child", "--json"]);
        assert!(push.status.success(), "{}", json(&push));
        assert_eq!(json(&push)["data"]["results"][0]["status"], "pushed");
        assert_eq!(
            git(&f.child_remote, &["rev-parse", "refs/heads/main"]),
            local
        );
        assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), local);
        assert_eq!(
            git(&f.child, &["rev-parse", "--abbrev-ref", "@{u}"]),
            "origin/main"
        );
        assert_eq!(git(&f.child, &["remote", "get-url", "origin"]), url);
        assert_eq!(
            fs::read(f.root.join(".arashi/config.json")).unwrap(),
            config
        );
        assert_eq!(
            fs::read_to_string(f.child.join("local.txt")).unwrap(),
            "unpublished commit\n"
        );
        assert!(git(&f.child, &["status", "--porcelain"]).is_empty());
        let repeat = f.run_impl(source, &["pull", "--only", "child", "--json"]);
        assert!(repeat.status.success(), "{}", json(&repeat));
        assert_eq!(json(&repeat)["data"]["results"][0]["status"], "skipped");
    }
}

#[test]
fn ahead_only_local_file_commit_pull_push() {
    ahead_only_commit_pull_push(false);
}

#[test]
fn ahead_only_loopback_commit_pull_push() {
    ahead_only_commit_pull_push(true);
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
        let base = arashi::paths::canonicalize(base).unwrap();
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
            .env(
                "GIT_ALLOW_PROTOCOL",
                if cfg!(windows) && self.base.join("http-port").is_file() {
                    "file:git:http"
                } else {
                    "file:git"
                },
            );
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

fn git_command() -> Command {
    let mut command = Command::new("git");
    // Match the CLI fixture's isolation: caller autocrlf must not change checkout bytes.
    command.env("GIT_CONFIG_NOSYSTEM", "1").env(
        "GIT_CONFIG_GLOBAL",
        if cfg!(windows) { "NUL" } else { "/dev/null" },
    );
    command
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = git_command()
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
        git_command()
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
fn push_dirty_repository_publishes_committed_ref() {
    dirty_push_matrix(false);
}

#[test]
fn push_dirty_loopback_publishes_committed_ref() {
    dirty_push_matrix(true);
}

fn dirty_checkout(repo: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    fs::write(repo.join("README.md"), "caller stash\n").unwrap();
    git(repo, &["stash", "push", "-m", "existing caller stash"]);
    fs::write(repo.join("README.md"), "staged caller bytes\n").unwrap();
    git(repo, &["add", "README.md"]);
    fs::write(repo.join("README.md"), "unstaged caller bytes\n").unwrap();
    fs::write(repo.join("untracked.bin"), [0, 255, 1, 10]).unwrap();
    [
        ".git/index",
        ".git/HEAD",
        ".git/refs/stash",
        ".git/logs/refs/stash",
        "README.md",
        "untracked.bin",
    ]
    .iter()
    .map(|name| {
        let path = repo.join(name);
        let bytes = fs::read(&path).unwrap();
        (path, bytes)
    })
    .collect()
}

fn assert_preserved(snapshot: &[(PathBuf, Vec<u8>)]) {
    for (path, bytes) in snapshot {
        assert_eq!(&fs::read(path).unwrap(), bytes, "{}", path.display());
    }
}

fn dirty_push_matrix(network: bool) {
    let implementations = if std::env::var("ARASHI_DIRTY_SOURCE_ONLY").as_deref() == Ok("1") {
        vec![true]
    } else if std::env::var("ARASHI_TS_PARITY").as_deref() == Ok("1") {
        vec![true, false]
    } else {
        vec![false]
    };
    for new_branch in [false, true] {
        for committed in [false, true] {
            let mut oracle = Vec::new();
            for &source in &implementations {
                let f = Fixture::new(None);
                let _daemon = if network {
                    let (guard, url) = daemon(&f);
                    git(&f.child, &["remote", "set-url", "origin", &url]);
                    Some(guard)
                } else {
                    None
                };
                let branch = if new_branch { "feature/dirty" } else { "main" };
                if new_branch {
                    git(&f.child, &["checkout", "-b", branch]);
                }
                if committed {
                    fs::write(f.child.join("committed.txt"), "publish only this commit\n").unwrap();
                    git(&f.child, &["add", "committed.txt"]);
                    git(&f.child, &["commit", "-m", "publishable"]);
                }
                let oid = git(&f.child, &["rev-parse", "HEAD"]);
                let before_refs = git(&f.child_remote, &["show-ref"]);
                let mut snapshot = dirty_checkout(&f.child);
                for path in [
                    f.root.join(".arashi/config.json"),
                    f.root.join(".git/config"),
                    f.root.join(".git/index"),
                    f.root.join(".git/HEAD"),
                ] {
                    snapshot.push((path.clone(), fs::read(path).unwrap()));
                }
                let child_config = fs::read(f.child.join(".git/config")).unwrap();
                let home = f.home.join("caller.bin");
                fs::write(&home, "caller home bytes").unwrap();
                snapshot.push((home, b"caller home bytes".to_vec()));
                let mut observations = Vec::new();
                if new_branch {
                    observations.push(f.run_impl(source, &["push", "--only", "child", "--json"]));
                    assert_eq!(
                        json(observations.last().unwrap())["data"]["results"][0]["status"],
                        "skipped"
                    );
                    assert_preserved(&snapshot);
                }
                let preview = f.run_impl(
                    source,
                    &[
                        "push",
                        "--only",
                        "child",
                        "--set-upstream",
                        "--dry-run",
                        "--json",
                    ],
                );
                assert!(preview.status.success(), "{}", json(&preview));
                assert_eq!(
                    json(&preview)["data"]["results"][0]["status"],
                    if committed { "planned" } else { "skipped" }
                );
                observations.push(preview);
                assert_eq!(git(&f.child_remote, &["show-ref"]), before_refs);
                assert_eq!(fs::read(f.child.join(".git/config")).unwrap(), child_config);
                assert_preserved(&snapshot);
                let push = f.run_impl(
                    source,
                    &["push", "--only", "child", "--set-upstream", "--json"],
                );
                eprintln!(
                    "dirty-push source={source} network={network} new_branch={new_branch} committed={committed} exit={:?} stdout={} stderr={}",
                    push.status.code(),
                    String::from_utf8_lossy(&push.stdout),
                    String::from_utf8_lossy(&push.stderr)
                );
                assert!(push.status.success(), "{}", json(&push));
                assert_eq!(
                    json(&push)["data"]["results"][0]["status"],
                    if committed { "pushed" } else { "skipped" }
                );
                if committed {
                    assert_eq!(
                        git(
                            &f.child_remote,
                            &["rev-parse", &format!("refs/heads/{branch}")]
                        ),
                        oid
                    );
                    assert_eq!(
                        git(&f.child, &["rev-parse", "--abbrev-ref", "@{u}"]),
                        format!("origin/{branch}")
                    );
                    // Keep raw refspec diagnostics: source names the branch, native names the frozen OID.
                    let stderr = json(&push)["data"]["results"][0]["stderr"]
                        .as_str()
                        .unwrap()
                        .to_owned();
                    assert!(stderr.contains(&format!(
                        "{} -> {branch}",
                        if source { branch } else { &oid }
                    )));
                } else {
                    assert_eq!(git(&f.child_remote, &["show-ref"]), before_refs);
                    observations.push(push);
                }
                assert_preserved(&snapshot);
                assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), oid);
                if !(new_branch && committed) {
                    assert_eq!(fs::read(f.child.join(".git/config")).unwrap(), child_config);
                }
                let repeat = f.run_impl(source, &["push", "--only", "child", "--json"]);
                assert_eq!(json(&repeat)["data"]["results"][0]["status"], "skipped");
                observations.push(repeat);
                assert_preserved(&snapshot);
                assert_eq!(fs::read_dir(&f.home).unwrap().count(), 1);
                if source {
                    oracle = observations;
                } else if !oracle.is_empty() {
                    assert_eq!(oracle.len(), observations.len());
                    for (source, native) in oracle.iter().zip(&observations) {
                        compare_json(source, native);
                    }
                }
            }
        }
    }
}

#[test]
fn push_dirty_divergence_continues_in_selection_order() {
    for network in [false, true] {
        for source in [true, false] {
            if source && std::env::var("ARASHI_TS_PARITY").as_deref() != Ok("1") {
                continue;
            }
            let f = Fixture::new(None);
            let _daemon = if network {
                let (guard, url) = daemon(&f);
                git(&f.child, &["remote", "set-url", "origin", &url]);
                git(
                    &f.root,
                    &[
                        "remote",
                        "set-url",
                        "origin",
                        &url.replace("child.git", "main.git"),
                    ],
                );
                Some(guard)
            } else {
                None
            };
            for repo in [&f.root, &f.child] {
                fs::write(repo.join("committed.txt"), "local commit\n").unwrap();
                git(repo, &["add", "committed.txt"]);
                git(repo, &["commit", "-m", "local"]);
            }
            let expected = git(&f.root, &["rev-parse", "HEAD"]);
            let rejected = f.advance(&f.child_remote, "divergent", "remote.txt");
            // Source compares upstream tracking state; make divergence equally observable.
            if network {
                // Allow only this disposable daemon fetch through CI's file-only guard.
                let output = git_command()
                    .args(["-c", "maintenance.auto=false", "fetch", "origin"])
                    .current_dir(&f.child)
                    .env("GIT_TERMINAL_PROMPT", "0")
                    .env(
                        "GIT_ALLOW_PROTOCOL",
                        if cfg!(windows) { "http" } else { "git" },
                    )
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "git fetch origin: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            } else {
                git(&f.child, &["fetch", "origin"]);
            }
            let mut snapshot = dirty_checkout(&f.child);
            snapshot.extend(dirty_checkout(&f.root));
            let output = f.run_impl(
                source,
                &["push", "--only", "child,workspace,workspace", "--json"],
            );
            eprintln!(
                "dirty-divergence source={source} network={network} stdout={} stderr={}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(output.status.code(), Some(1));
            let value = json(&output);
            assert_eq!(value["error"]["code"], "PUSH_FAILED");
            let rows = value["error"]["details"]["results"].as_array().unwrap();
            assert_eq!(rows.len(), 2);
            assert_eq!(rows[0]["repositoryId"], "child");
            assert_eq!(rows[0]["status"], "failed");
            assert_eq!(rows[1]["repositoryId"], "workspace");
            assert_eq!(rows[1]["status"], "pushed");
            assert_eq!(
                git(&f.child_remote, &["rev-parse", "refs/heads/main"]),
                rejected
            );
            assert_eq!(
                git(&f.main_remote, &["rev-parse", "refs/heads/main"]),
                expected
            );
            assert_preserved(&snapshot);
        }
    }
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
        git_command()
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
        git_command()
            .args(["rev-parse", "--verify", "refs/heads/feature/remote-hook",])
            .current_dir(&f.child_remote)
            .output()
            .unwrap()
            .status
            .code()
            != Some(0)
    );
}

fn snapshot_files(root: &Path) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
    fn visit(root: &Path, files: &mut std::collections::BTreeMap<PathBuf, Vec<u8>>) {
        for entry in fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(&path, files);
            } else {
                files.insert(path.clone(), fs::read(path).unwrap());
            }
        }
    }
    let mut files = std::collections::BTreeMap::new();
    visit(root, &mut files);
    files
}

fn rejects_local_hooks_before_mutation(operation: &str) {
    for hook_name in [
        "post-merge",
        "pre-merge-commit",
        "pre-push",
        "reference-transaction",
    ] {
        let f = Fixture::new(None);
        if operation == "pull" {
            f.advance(&f.main_remote, "parent-update", "parent-update.txt");
            f.advance(&f.child_remote, "child-update", "child-update.txt");
        } else {
            f.feature(&f.root, "hook-preflight", "parent-feature.txt");
            f.feature(&f.child, "hook-preflight", "child-feature.txt");
        }
        // Put the blocker last, so the earlier selected repository must not
        // fetch or publish either. Use Git's real hook discovery as a control.
        let hook = f.child.join(".git").join("hooks").join(hook_name);
        let marker = f.child.join("hook-canary");
        fs::write(&hook, "#!/bin/sh\nprintf ran > hook-canary\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        }
        git(&f.child, &["hook", "run", hook_name]);
        assert_eq!(fs::read(&marker).unwrap(), b"ran");
        fs::remove_file(&marker).unwrap();
        let before = snapshot_files(&f.base);
        let previews: &[bool] = if operation == "push" {
            &[false, true]
        } else {
            &[false]
        };
        for &preview in previews {
            let mut args = vec![operation, "--only", "workspace,child", "--json"];
            if operation == "push" {
                args.push("--set-upstream");
            }
            if preview {
                args.push("--dry-run");
            }
            let output = f.run(&args);
            let value = json(&output);
            assert_eq!(
                output.status.code(),
                Some(1),
                "{operation} {hook_name}: {value}"
            );
            assert_eq!(value["error"]["code"], "PORT_UNSUPPORTED", "{value}");
            assert!(
                value["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains(&format!("Active Git hook '{hook_name}'")),
                "{value}"
            );
            assert!(!marker.exists());
            // Includes both checkouts, origins, HOME, indexes, refs, objects and
            // FETCH_HEAD: rejection must precede even a fetch in the first repo.
            assert_eq!(snapshot_files(&f.base), before);
        }
    }
}

#[test]
fn pull_rejects_local_hooks_before_mutation() {
    rejects_local_hooks_before_mutation("pull");
}

#[test]
fn push_rejects_local_hooks_before_mutation() {
    rejects_local_hooks_before_mutation("push");
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
