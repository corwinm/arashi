//! Independent source-versus-native journeys; requires Node and installed source dependencies.
//! Run: cargo test --test rust_parity -- --ignored
include!("rust/parser_composition.rs");
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    base: PathBuf,
    repo: PathBuf,
    home: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!(
            "arashi-parity-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&base).unwrap();
        let base = arashi::paths::canonicalize(&base).unwrap();
        let f = Self {
            repo: base.join("workspace"),
            home: base.join("home"),
            base,
        };
        fs::create_dir_all(&f.repo).unwrap();
        fs::create_dir_all(&f.home).unwrap();
        f.git(&["init", "-b", "main"]);
        f.git(&["config", "user.name", "Arashi Test"]);
        f.git(&["config", "user.email", "arashi@example.invalid"]);
        fs::write(f.repo.join("file.txt"), "fixture\n").unwrap();
        f.git(&["add", "file.txt"]);
        f.git(&["commit", "-m", "fixture"]);
        fs::create_dir(f.repo.join(".worktrees")).unwrap();
        fs::write(f.repo.join(".git/info/exclude"), ".worktrees/\n").unwrap();
        f
    }
    fn environment(&self, c: &mut Command) {
        c.current_dir(&self.repo)
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.home.join(".gitconfig"))
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "commit.gpgsign")
            .env("GIT_CONFIG_VALUE_0", "false")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("NO_COLOR", "1")
            .env_remove("ARASHI_DIRECTIVE_FILE")
            .env_remove("ARASHI_SHELL")
            .env_remove("GIT_ALLOW_PROTOCOL")
            .env_remove("GIT_PROTOCOL_FROM_USER");
    }
    fn git(&self, args: &[&str]) -> String {
        let mut c = Command::new("git");
        c.args(["-c", "maintenance.auto=false"]).args(args);
        self.environment(&mut c);
        let o = c.output().unwrap();
        assert!(
            o.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&o.stderr)
        );
        String::from_utf8(o.stdout).unwrap()
    }
    fn run(&self, source: bool, args: &[&str]) -> Output {
        let mut c = if source {
            let mut c = Command::new("node");
            c.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"));
            c
        } else {
            Command::new(env!("CARGO_BIN_EXE_arashi"))
        };
        c.args(args);
        self.environment(&mut c);
        if !source {
            c.env_remove("GIT_OPTIONAL_LOCKS");
        }
        c.output().unwrap()
    }
    fn reset_target(&self) {
        let target = self.repo.join(".worktrees/feature");
        if target.exists() {
            self.git(&["worktree", "remove", target.to_str().unwrap()]);
        }
        if !self.git(&["branch", "--list", "feature"]).trim().is_empty() {
            self.git(&["branch", "-D", "feature"]);
        }
    }
    fn effects(&self) -> (String, String, String, bool) {
        (
            self.git(&["worktree", "list", "--porcelain"]),
            self.git(&["show-ref", "--heads"]),
            self.git(&["status", "--porcelain"]),
            self.repo.join(".worktrees/feature/file.txt").exists(),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}
#[test]
fn fixture_commits_do_not_launch_automatic_maintenance() {
    let f = Fixture::new();
    // Force observable maintenance on every commit, synchronously so the
    // regression does not depend on catching a short-lived maintenance.lock.
    for (key, value) in [
        ("maintenance.auto", "true"),
        ("maintenance.autoDetach", "false"),
        ("gc.autoDetach", "false"),
        ("maintenance.gc.enabled", "false"),
        ("maintenance.commit-graph.enabled", "true"),
        ("maintenance.commit-graph.auto", "-1"),
    ] {
        f.git(&["config", key, value]);
    }
    let graph = f.repo.join(".git/objects/info/commit-graphs");
    assert!(!graph.exists());
    f.git(&["commit", "--allow-empty", "-m", "fixture"]);
    assert!(
        !graph.exists(),
        "fixture commit launched automatic maintenance before parity ran"
    );

    // Positive control: ordinary Git really performs the configured work.
    let mut command = Command::new("git");
    command.args(["commit", "--allow-empty", "-m", "maintenance control"]);
    f.environment(&mut command);
    command.env_remove("GIT_OPTIONAL_LOCKS");
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(graph.exists(), "control must exercise real Git maintenance");
}
fn normalized(v: &mut Value) {
    match v {
        Value::Object(map) => {
            for (key, value) in map {
                if key == "totalDuration"
                    || key == "duration"
                    || key == "durationMs"
                    || key == "elapsedMs"
                {
                    *value = Value::from(0);
                } else {
                    normalized(value);
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(normalized),
        _ => {}
    }
}
fn compare(source: &Output, native: &Output) {
    assert_eq!(
        source.status.code(),
        native.status.code(),
        "exit mismatch\nsource stderr={}\nnative stderr={}\nsource={}\nnative={}",
        String::from_utf8_lossy(&source.stderr),
        String::from_utf8_lossy(&native.stderr),
        String::from_utf8_lossy(&source.stdout),
        String::from_utf8_lossy(&native.stdout)
    );
    let mut s: Value = serde_json::from_slice(&source.stdout).unwrap_or_else(|e| {
        panic!(
            "Source must emit one JSON document: {e}: {}",
            String::from_utf8_lossy(&source.stdout)
        )
    });
    let mut n: Value =
        serde_json::from_slice(&native.stdout).expect("Native must emit one JSON document");
    normalized(&mut s);
    normalized(&mut n);
    if s != n {
        fn differences(s: &Value, n: &Value, path: &str) {
            if s == n {
                return;
            }
            if let (Some(s), Some(n)) = (s.as_object(), n.as_object()) {
                for k in s
                    .keys()
                    .chain(n.keys())
                    .collect::<std::collections::BTreeSet<_>>()
                {
                    differences(
                        s.get(k).unwrap_or(&Value::Null),
                        n.get(k).unwrap_or(&Value::Null),
                        &format!("{path}.{k}"),
                    );
                }
            } else if let (Some(s), Some(n)) = (s.as_array(), n.as_array()) {
                for i in 0..s.len().max(n.len()) {
                    differences(
                        s.get(i).unwrap_or(&Value::Null),
                        n.get(i).unwrap_or(&Value::Null),
                        &format!("{path}[{i}]"),
                    );
                }
            } else {
                eprintln!("DIFF {path}: source={s} native={n}");
            }
        }
        differences(&s, &n, "$");
    }
    assert_eq!(s, n, "full JSON envelope parity");
    assert_eq!(source.stderr, native.stderr, "complete stderr parity");
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn list_standalone() {
    let f = Fixture::new();
    f.git(&["worktree", "add", "-b", "feature", ".worktrees/feature"]);
    compare(
        &f.run(true, &["list", "--json"]),
        &f.run(false, &["list", "--json"]),
    );
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn list_configured() {
    let f = Fixture::new();
    fs::remove_dir(f.repo.join(".worktrees")).unwrap();
    fs::create_dir(f.repo.join(".arashi")).unwrap();
    fs::write(
        f.repo.join(".arashi/config.json"),
        r#"{"version":"1.0.0","reposDir":"repos","worktreesDir":".arashi/worktrees","repos":{}}"#,
    )
    .unwrap();
    compare(
        &f.run(true, &["list", "--json"]),
        &f.run(false, &["list", "--json"]),
    );
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn create_dry_run() {
    let f = Fixture::new();
    let before = f.effects();
    let args = [
        "create",
        "feature",
        "--no-hooks",
        "--no-launch",
        "--no-switch",
        "--dry-run",
        "--json",
    ];
    let s = f.run(true, &args);
    assert_eq!(before, f.effects());
    let n = f.run(false, &args);
    assert_eq!(before, f.effects());
    compare(&s, &n);
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn create_actual() {
    let f = Fixture::new();
    let args = [
        "create",
        "feature",
        "--no-hooks",
        "--no-launch",
        "--no-switch",
        "--json",
    ];
    let s = f.run(true, &args);
    let se = f.effects();
    f.reset_target();
    let n = f.run(false, &args);
    assert_eq!(se, f.effects(), "filesystem and git effects");
    compare(&s, &n);
}
fn remove(keep: bool) {
    let f = Fixture::new();
    f.git(&["worktree", "add", "-b", "feature", ".worktrees/feature"]);
    let mut args = vec!["remove", "feature", "--force", "--json"];
    if keep {
        args.push("--keep-branches");
    }
    let s = f.run(true, &args);
    let se = f.effects();
    f.reset_target();
    f.git(&["worktree", "add", "-b", "feature", ".worktrees/feature"]);
    let n = f.run(false, &args);
    assert_eq!(se, f.effects(), "filesystem and git effects");
    compare(&s, &n);
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn remove_normal() {
    remove(false);
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn remove_keep_branches() {
    remove(true);
}

#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn list_outside_repository_error() {
    let f = Fixture::new();
    fs::remove_dir_all(f.repo.join(".git")).unwrap();
    compare(
        &f.run(true, &["list", "--json"]),
        &f.run(false, &["list", "--json"]),
    );
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn status_outside_repository_error() {
    let f = Fixture::new();
    fs::remove_dir_all(f.repo.join(".git")).unwrap();
    compare(
        &f.run(true, &["status", "--json"]),
        &f.run(false, &["status", "--json"]),
    );
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn create_missing_ignore_error() {
    let f = Fixture::new();
    fs::write(f.repo.join(".git/info/exclude"), "").unwrap();
    let before = f.effects();
    let args = [
        "create",
        "feature",
        "--no-hooks",
        "--no-launch",
        "--no-switch",
        "--json",
    ];
    let s = f.run(true, &args);
    assert_eq!(before, f.effects());
    let n = f.run(false, &args);
    assert_eq!(before, f.effects());
    compare(&s, &n);
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn create_reuses_existing_local_branch() {
    let f = Fixture::new();
    f.git(&["branch", "feature"]);
    let args = [
        "create",
        "feature",
        "--no-hooks",
        "--no-launch",
        "--no-switch",
        "--json",
    ];
    let s = f.run(true, &args);
    let se = f.effects();
    f.reset_target();
    f.git(&["branch", "feature"]);
    let n = f.run(false, &args);
    assert_eq!(se, f.effects(), "filesystem and Git effects");
    compare(&s, &n);
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn create_from_remote_tracking_branch() {
    let f = Fixture::new();
    // A local remote-tracking ref requires no server or fetch.
    f.git(&["remote", "add", "origin", "https://example.invalid/unused"]);
    f.git(&["update-ref", "refs/remotes/origin/feature", "HEAD"]);
    let args = [
        "create",
        "feature",
        "--no-hooks",
        "--no-launch",
        "--no-switch",
        "--json",
    ];
    let s = f.run(true, &args);
    let se = f.effects();
    let source_tracking = f.git(&["config", "--get-regexp", "^branch.feature\\."]);
    f.reset_target();
    let n = f.run(false, &args);
    let native_tracking = f.git(&["config", "--get-regexp", "^branch.feature\\."]);
    assert_eq!(se, f.effects(), "filesystem and Git effects");
    assert_eq!(source_tracking, native_tracking, "upstream tracking config");
    compare(&s, &n);
}

#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn ordinary_list_without_standalone_directory() {
    let f = Fixture::new();
    fs::remove_dir(f.repo.join(".worktrees")).unwrap();
    let before = f.effects();
    compare(
        &f.run(true, &["list", "--json"]),
        &f.run(false, &["list", "--json"]),
    );
    let s = f.run(true, &["list"]);
    let n = f.run(false, &["list"]);
    assert_eq!(s.status.code(), n.status.code());
    assert_eq!(s.stdout, n.stdout);
    assert_eq!(before, f.effects());
    assert!(
        !f.run(false, &["create", "feature", "--no-hooks", "--json"])
            .status
            .success()
    );
}

#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn configured_status_child_order_and_filters() {
    let mut f = Fixture::new();
    fs::create_dir(f.repo.join(".arashi")).unwrap();
    fs::write(f.repo.join(".arashi/config.json"), r#"{"version":"1.0.0","reposDir":"repos","repos":{"zulu":{"path":"repos/zulu","groups":["Backend"]},"alpha":{"path":"repos/alpha","groups":["UI"]}}}"#).unwrap();
    for name in ["zulu", "alpha"] {
        let root = f.repo.clone();
        f.repo = root.join("repos").join(name);
        fs::create_dir_all(&f.repo).unwrap();
        f.git(&["init", "-b", "main"]);
        f.git(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
        ]);
        f.repo = root;
    }
    for child in [false, true] {
        let root = f.repo.clone();
        if child {
            f.repo = root.join("repos/zulu");
        }
        for filters in [
            vec![],
            vec!["--only", "alpha,zulu"],
            vec!["--group", "backend"],
            vec!["--only", "absent"],
            vec!["--group", "absent"],
            vec!["--only", " , "],
            vec!["--only", "alpha", "--group", "Backend"],
        ] {
            let mut args = vec!["status", "--json"];
            args.extend(filters);
            compare(&f.run(true, &args), &f.run(false, &args));
        }
        f.repo = root;
    }
}

fn files(path: &Path) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
    let mut result = std::collections::BTreeMap::new();
    if path.is_dir() {
        for entry in fs::read_dir(path).unwrap() {
            let p = entry.unwrap().path();
            if p.is_dir() {
                result.extend(files(&p));
            } else {
                result.insert(p.clone(), fs::read(p).unwrap());
            }
        }
    }
    result
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn configured_init_files_and_dry_run() {
    for custom in [false, true] {
        let f = Fixture::new();
        let mut args = vec!["init", "--json", "--no-discover"];
        if custom {
            args.extend(["--repos-dir", "components", "--worktrees-dir", "trees"]);
        }
        let before = f.effects();
        let mut dry = args.clone();
        dry.push("--dry-run");
        compare(&f.run(true, &dry), &f.run(false, &dry));
        assert_eq!(before, f.effects());
        let exclude = fs::read(f.repo.join(".git/info/exclude")).unwrap();
        let s = f.run(true, &args);
        let source_files = files(&f.repo.join(".arashi"));
        let source_exclude = fs::read(f.repo.join(".git/info/exclude")).unwrap();
        fs::remove_dir_all(f.repo.join(".arashi")).unwrap();
        fs::remove_dir(f.repo.join(if custom { "components" } else { "repos" })).unwrap();
        fs::write(f.repo.join(".git/info/exclude"), exclude).unwrap();
        let n = f.run(false, &args);
        compare(&s, &n);
        assert_eq!(
            source_files,
            files(&f.repo.join(".arashi")),
            "all initialized file bytes"
        );
        assert_eq!(
            source_exclude,
            fs::read(f.repo.join(".git/info/exclude")).unwrap()
        );
        compare(&f.run(true, &args), &f.run(false, &args));
    }
}

impl Fixture {
    fn configured(&mut self) {
        for name in ["zulu", "alpha"] {
            let root = self.repo.clone();
            self.repo = root.join("repos").join(name);
            fs::create_dir_all(&self.repo).unwrap();
            self.git(&["init", "-b", "main"]);
            self.git(&[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "fixture",
            ]);
            self.repo = root;
        }
        fs::create_dir_all(self.repo.join(".arashi")).unwrap();
        fs::write(self.repo.join(".arashi/config.json"),r#"{"version":"1.0.0","reposDir":"repos","repos":{"zulu":{"path":"repos/zulu","groups":["Backend"]},"alpha":{"path":"repos/alpha","groups":["UI"]}}}"#).unwrap();
        fs::write(self.repo.join(".gitignore"), "repos/\n.arashi/worktrees/\n").unwrap();
        self.git(&["add", ".arashi/config.json", ".gitignore"]);
        self.git(&["commit", "-m", "config"]);
    }
    fn coordinated_effects(&self) -> Vec<String> {
        ["", "repos/alpha", "repos/zulu"]
            .into_iter()
            .flat_map(|p| {
                [
                    self.git(&["-C", p_or_dot(p), "worktree", "list", "--porcelain"]),
                    self.git(&["-C", p_or_dot(p), "show-ref", "--heads"]),
                    self.git(&["-C", p_or_dot(p), "status", "--porcelain"]),
                ]
            })
            .collect()
    }
    fn reset_coordinated(&self) {
        for repo in ["repos/alpha", "repos/zulu", ""] {
            let p = if repo.is_empty() {
                ".arashi/worktrees/feature".to_owned()
            } else {
                format!(".arashi/worktrees/feature/{repo}")
            };
            if self.repo.join(&p).join(".git").exists() {
                self.git(&[
                    "-C",
                    p_or_dot(repo),
                    "worktree",
                    "remove",
                    "--force",
                    self.repo.join(p).to_str().unwrap(),
                ]);
            }
            if !self
                .git(&["-C", p_or_dot(repo), "branch", "--list", "feature"])
                .trim()
                .is_empty()
            {
                self.git(&["-C", p_or_dot(repo), "branch", "-D", "feature"]);
            }
        }
        let p = self.repo.join(".arashi/worktrees/feature");
        if p.exists() {
            fs::remove_dir_all(p).unwrap();
        }
    }
}
fn p_or_dot(p: &str) -> &str {
    if p.is_empty() { "." } else { p }
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn configured_create_coordination_and_selection() {
    for filter in [vec![], vec!["--only", "alpha"], vec!["--group", "Backend"]] {
        let mut f = Fixture::new();
        f.configured();
        let mut args = vec![
            "create",
            "feature",
            "--no-hooks",
            "--no-launch",
            "--no-switch",
            "--json",
        ];
        args.extend(filter);
        let before = f.coordinated_effects();
        let mut dry = args.clone();
        dry.push("--dry-run");
        compare(&f.run(true, &dry), &f.run(false, &dry));
        assert_eq!(before, f.coordinated_effects());
        let s = f.run(true, &args);
        let effects = f.coordinated_effects();
        f.reset_coordinated();
        let n = f.run(false, &args);
        compare(&s, &n);
        assert_eq!(effects, f.coordinated_effects());
    }
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn configured_remove_coordination() {
    for keep in [false, true] {
        let mut f = Fixture::new();
        f.configured();
        let create = [
            "create",
            "feature",
            "--no-hooks",
            "--no-launch",
            "--no-switch",
            "--json",
        ];
        assert!(f.run(true, &create).status.success());
        let mut args = vec!["remove", "feature", "--force", "--json"];
        if keep {
            args.push("--keep-branches");
        }
        let mut dry = args.clone();
        dry.push("--dry-run");
        let before = f.coordinated_effects();
        compare(&f.run(true, &dry), &f.run(false, &dry));
        assert_eq!(before, f.coordinated_effects());
        let s = f.run(true, &args);
        let effects = f.coordinated_effects();
        f.reset_coordinated();
        assert!(f.run(true, &create).status.success());
        let n = f.run(false, &args);
        compare(&s, &n);
        assert_eq!(effects, f.coordinated_effects());
    }
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn configured_local_remote_status() {
    let mut f = Fixture::new();
    f.configured();
    for repo in [".", "repos/zulu", "repos/alpha"] {
        let name = repo.replace('/', "-");
        let remote = f.base.join(format!("remote-{name}.git"));
        f.git(&[
            "clone",
            "--bare",
            f.repo.join(repo).to_str().unwrap(),
            remote.to_str().unwrap(),
        ]);
        f.git(&[
            "-C",
            repo,
            "remote",
            "add",
            "origin",
            remote.to_str().unwrap(),
        ]);
        f.git(&["-C", repo, "fetch", "origin"]);
        f.git(&[
            "-C",
            repo,
            "branch",
            "--set-upstream-to=origin/main",
            "main",
        ]);
        f.git(&["-C", repo, "remote", "set-head", "origin", "main"]);
    }
    compare(
        &f.run(true, &["status", "--json"]),
        &f.run(false, &["status", "--json"]),
    );
    f.git(&[
        "-C",
        "repos/zulu",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "ahead",
    ]);
    compare(
        &f.run(true, &["status", "--json"]),
        &f.run(false, &["status", "--json"]),
    );
    let remote = f.base.join("remote-repos-alpha.git");
    f.git(&["-C", remote.to_str().unwrap(), "branch", "release", "main"]);
    f.git(&["-C", "repos/alpha", "fetch", "origin"]);
    f.git(&[
        "-C",
        "repos/alpha",
        "remote",
        "set-head",
        "origin",
        "release",
    ]);
    compare(
        &f.run(true, &["status", "--json"]),
        &f.run(false, &["status", "--json"]),
    );
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn configured_create_bases_and_dirty_guidance() {
    for policy in [false, true] {
        let mut f = Fixture::new();
        f.configured();
        if policy {
            let p = f.repo.join(".arashi/config.json");
            let mut c: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
            c["baseBranch"] = Value::from("main");
            fs::write(p, serde_json::to_vec(&c).unwrap()).unwrap();
            f.git(&["commit", "-am", "base policy"]);
        }
        fs::write(f.repo.join("file.txt"), "dirty\n").unwrap();
        fs::write(f.repo.join("repos/zulu/untracked"), "preserve me").unwrap();
        let mut args = vec![
            "create",
            "feature",
            "--no-hooks",
            "--no-launch",
            "--no-switch",
            "--json",
        ];
        if !policy {
            args.extend(["--base", "main", "--repo-base", "alpha=main"]);
        }
        let mut dry = args.clone();
        dry.push("--dry-run");
        compare(&f.run(true, &dry), &f.run(false, &dry));
        let s = f.run(true, &args);
        let effects = f.coordinated_effects();
        f.reset_coordinated();
        let n = f.run(false, &args);
        compare(&s, &n);
        assert_eq!(effects, f.coordinated_effects());
        assert_eq!(
            fs::read_to_string(f.repo.join("repos/zulu/untracked")).unwrap(),
            "preserve me"
        );
    }
}

#[test]
fn configured_mutations_reject_unsafe_policies_without_effects() {
    for key in ["copy", "symlink", "hooks"] {
        let mut f = Fixture::new();
        f.configured();
        let p = f.repo.join(".arashi/config.json");
        let mut c: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
        c["repos"]["alpha"][key] = if key == "hooks" {
            serde_json::json!({"pre-remove":"touch should-not-exist"})
        } else {
            serde_json::json!(["unsupported-unicode-\u{e9}"])
        };
        fs::write(p, serde_json::to_vec(&c).unwrap()).unwrap();
        let before = f.coordinated_effects();
        let args = if key == "hooks" {
            vec!["remove", "feature", "--force", "--json"]
        } else {
            vec![
                "create",
                "feature",
                "--no-hooks",
                "--no-launch",
                "--no-switch",
                "--json",
            ]
        };
        assert!(!f.run(false, &args).status.success());
        assert_eq!(before, f.coordinated_effects());
    }
}
#[test]
fn configured_remove_protects_unmanaged_nested_git() {
    let mut f = Fixture::new();
    f.configured();
    let args = [
        "create",
        "feature",
        "--no-hooks",
        "--no-launch",
        "--no-switch",
        "--json",
    ];
    assert!(f.run(false, &args).status.success());
    let unexpected = f.repo.join(".arashi/worktrees/feature/unmanaged");
    fs::create_dir(&unexpected).unwrap();
    f.git(&["-C", unexpected.to_str().unwrap(), "init", "-b", "main"]);
    let before = f.coordinated_effects();
    assert!(
        !f.run(false, &["remove", "feature", "--force", "--json"])
            .status
            .success()
    );
    assert_eq!(before, f.coordinated_effects());
    assert!(unexpected.join(".git").is_dir());
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn configured_custom_paths_and_naming() {
    let mut f = Fixture::new();
    f.configured();
    let p = f.repo.join(".arashi/config.json");
    let mut c: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
    c["worktreesDir"] = Value::from("trees");
    c["worktreeNaming"] = serde_json::json!({"style":"repo-branch","branchSlashes":"flatten"});
    fs::write(&p, serde_json::to_vec(&c).unwrap()).unwrap();
    fs::write(f.repo.join(".gitignore"), "repos/\ntrees/\n").unwrap();
    f.git(&["commit", "-am", "custom paths"]);
    let args = [
        "create",
        "feature/demo",
        "--no-hooks",
        "--no-launch",
        "--no-switch",
        "--json",
    ];
    let mut dry = args.to_vec();
    dry.push("--dry-run");
    compare(&f.run(true, &dry), &f.run(false, &dry));
    let s = f.run(true, &args);
    let effects = f.coordinated_effects();
    for repo in ["repos/alpha", "repos/zulu", ""] {
        let target = if repo.is_empty() {
            f.repo.join("trees/workspace-feature-demo")
        } else {
            f.repo.join("trees/workspace-feature-demo").join(repo)
        };
        f.git(&[
            "-C",
            p_or_dot(repo),
            "worktree",
            "remove",
            "--force",
            target.to_str().unwrap(),
        ]);
        f.git(&["-C", p_or_dot(repo), "branch", "-D", "feature/demo"]);
    }
    let n = f.run(false, &args);
    compare(&s, &n);
    assert_eq!(effects, f.coordinated_effects());
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn configured_missing_base_is_atomic() {
    let mut f = Fixture::new();
    f.configured();
    let before = f.coordinated_effects();
    let args = [
        "create",
        "feature",
        "--base",
        "absent",
        "--no-hooks",
        "--no-launch",
        "--no-switch",
        "--json",
    ];
    compare(&f.run(true, &args), &f.run(false, &args));
    assert_eq!(before, f.coordinated_effects());
}

#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn configured_missing_child_status_exit() {
    let mut f = Fixture::new();
    f.configured();
    fs::remove_dir_all(f.repo.join("repos/zulu")).unwrap();
    compare(
        &f.run(true, &["status", "--json"]),
        &f.run(false, &["status", "--json"]),
    );
}
#[cfg(unix)]
#[test]
fn configured_create_failure_rolls_back_only_owned_branches() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    f.configured();
    f.git(&["-C", "repos/alpha", "branch", "feature"]);
    let before = f.coordinated_effects();
    let bin = f.base.join("bin");
    fs::create_dir(&bin).unwrap();
    let actual = Command::new("which").arg("git").output().unwrap();
    let actual = String::from_utf8(actual.stdout).unwrap();
    let script = format!(
        "#!/bin/sh\nif [ \"$1\" = worktree ] && [ \"$2\" = add ] && [ \"$(basename \"$PWD\")\" = zulu ]; then echo 'injected Git failure' >&2; exit 42; fi\nexec '{}' \"$@\"\n",
        actual.trim().replace('\'', "'\\''")
    );
    fs::write(bin.join("git"), script).unwrap();
    fs::set_permissions(bin.join("git"), fs::Permissions::from_mode(0o755)).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_arashi"));
    f.environment(&mut command);
    command.env(
        "PATH",
        format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()),
    );
    let result = command
        .args([
            "create",
            "feature",
            "--no-hooks",
            "--no-launch",
            "--no-switch",
            "--json",
            "--conflict",
            "REUSE_EXISTING",
        ])
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert_eq!(
        before,
        f.coordinated_effects(),
        "rollback preserves the existing alpha branch and all source repositories"
    );
    let data: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(
        data["error"]["details"]["rollbackErrors"],
        serde_json::json!([])
    );
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn configured_remove_selected_child() {
    let mut f = Fixture::new();
    f.configured();
    let create = [
        "create",
        "feature",
        "--only",
        "alpha",
        "--no-hooks",
        "--no-launch",
        "--no-switch",
        "--json",
    ];
    assert!(f.run(true, &create).status.success());
    let args = ["remove", "feature", "--force", "--json"];
    let s = f.run(true, &args);
    let effects = f.coordinated_effects();
    f.reset_coordinated();
    assert!(f.run(false, &create).status.success());
    let n = f.run(false, &args);
    compare(&s, &n);
    assert_eq!(effects, f.coordinated_effects());
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn configured_reuses_local_branch() {
    let mut f = Fixture::new();
    f.configured();
    f.git(&["-C", "repos/alpha", "branch", "feature"]);
    let args = [
        "create",
        "feature",
        "--no-hooks",
        "--no-launch",
        "--no-switch",
        "--json",
        "--conflict",
        "REUSE_EXISTING",
    ];
    let s = f.run(true, &args);
    let effects = f.coordinated_effects();
    f.reset_coordinated();
    f.git(&["-C", "repos/alpha", "branch", "feature"]);
    let n = f.run(false, &args);
    compare(&s, &n);
    assert_eq!(effects, f.coordinated_effects());
}
#[test]
fn transaction_rollback_preserves_concurrently_changed_files() {
    let f = Fixture::new();
    let path = f.repo.join("file.txt");
    let mut tx = arashi::managed::Transaction::default();
    tx.write(&path, b"owned update").unwrap();
    fs::write(&path, b"concurrent caller edit").unwrap();
    assert_eq!(tx.rollback().len(), 1);
    assert_eq!(fs::read(&path).unwrap(), b"concurrent caller edit");
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn configured_create_invalid_filters() {
    let mut f = Fixture::new();
    f.configured();
    let before = f.coordinated_effects();
    for filters in [
        vec!["--only", "absent"],
        vec!["--group", "absent"],
        vec!["--only", " , "],
        vec!["--only", "alpha", "--group", "Backend"],
    ] {
        let mut args = vec![
            "create",
            "feature",
            "--no-hooks",
            "--no-launch",
            "--no-switch",
            "--json",
        ];
        args.extend(filters);
        compare(&f.run(true, &args), &f.run(false, &args));
        assert_eq!(before, f.coordinated_effects());
    }
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn configured_base_override_errors() {
    let mut f = Fixture::new();
    f.configured();
    let before = f.coordinated_effects();
    for overrides in [
        vec!["--repo-base", "alpha="],
        vec!["--repo-base", "alpha=bad..branch"],
        vec!["--repo-base", "absent=main"],
        vec!["--only", "alpha", "--repo-base", "@meta=main"],
        vec!["--repo-base", "alpha=main", "--repo-base", "alpha=main"],
    ] {
        let mut args = vec![
            "create",
            "feature",
            "--no-hooks",
            "--no-launch",
            "--no-switch",
            "--json",
        ];
        args.extend(overrides);
        compare(&f.run(true, &args), &f.run(false, &args));
        assert_eq!(before, f.coordinated_effects());
    }
}
#[test]
fn configured_ignore_revalidates_effective_rules_before_writing() {
    let mut f = Fixture::new();
    f.configured();
    let plan =
        arashi::managed::IgnorePlan::build(&f.repo, "repos", ".arashi/worktrees", false).unwrap();
    fs::write(f.repo.join(".gitignore"), "").unwrap();
    let exclude = fs::read(f.repo.join(".git/info/exclude")).unwrap();
    let mut tx = arashi::managed::Transaction::default();
    assert!(plan.apply(&mut tx).is_err());
    assert_eq!(fs::read(f.repo.join(".git/info/exclude")).unwrap(), exclude);
    assert!(tx.rollback().is_empty());
}
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn unknown_option_raw_output() {
    let f = Fixture::new();
    for args in [
        vec!["list", "--not-an-option"],
        vec!["list", "--json", "--not-an-option"],
    ] {
        let s = f.run(true, &args);
        let n = f.run(false, &args);
        assert_eq!(s.status.code(), n.status.code());
        assert_eq!(s.stdout, n.stdout);
        assert_eq!(s.stderr, n.stderr);
    }
}
#[test]
fn configured_linked_child_status_uses_active_config_root() {
    for child_only in [false, true] {
        let mut f = Fixture::new();
        f.configured();
        let mut create = vec![
            "create",
            "feature",
            "--no-hooks",
            "--no-launch",
            "--no-switch",
            "--json",
        ];
        if child_only {
            create.extend(["--only", "alpha"]);
        }
        assert!(f.run(false, &create).status.success());
        let root = f.repo.join(".arashi").join("worktrees").join("feature");
        let expected = if child_only {
            f.repo.clone()
        } else {
            root.clone()
        };
        for path in [root.clone(), root.join("repos/alpha")] {
            f.repo = path;
            let args = ["status", "--json", "--only", "alpha"];
            let native = f.run(false, &args);
            assert!(
                native.status.success(),
                "{}",
                String::from_utf8_lossy(&native.stdout)
            );
            let value: Value = serde_json::from_slice(&native.stdout).unwrap();
            assert_eq!(value["data"]["workspaceRoot"], serde_json::json!(expected));
            for row in value["data"]["repositories"].as_array().unwrap() {
                assert_eq!(
                    row["branch"]["localBranch"],
                    if child_only { "main" } else { "feature" }
                );
            }
            if std::env::var_os("ARASHI_TS_PARITY").is_some() {
                compare(&f.run(true, &args), &native);
            }
        }
    }
}

#[test]
fn configured_status_base_comparisons() {
    for remote_enabled in [false, true] {
        let mut f = Fixture::new();
        f.configured();
        let config_path = f.repo.join(".arashi/config.json");
        let mut config: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
        config["worktreesDir"] = Value::from(".arashi/worktrees");
        config["baseBranch"] = Value::from("origin/main");
        config["meta"] = serde_json::json!({"baseBranch":"release"});
        config["repos"]["alpha"]["baseBranch"] = Value::from("release");
        fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
        for repo in [".", "repos/zulu", "repos/alpha"] {
            f.git(&["-C", repo, "branch", "release"]);
            if remote_enabled {
                let remote = f.base.join(format!("base-{}.git", repo.replace('/', "-")));
                f.git(&[
                    "clone",
                    "--bare",
                    f.repo.join(repo).to_str().unwrap(),
                    remote.to_str().unwrap(),
                ]);
                f.git(&[
                    "-C",
                    repo,
                    "remote",
                    "add",
                    "origin",
                    remote.to_str().unwrap(),
                ]);
                f.git(&["-C", repo, "fetch", "origin"]);
                f.git(&[
                    "-C",
                    repo,
                    "branch",
                    "--set-upstream-to=origin/main",
                    "main",
                ]);
                f.git(&["-C", repo, "remote", "set-head", "origin", "main"]);
                let commit = f.git(&[
                    "-C",
                    remote.to_str().unwrap(),
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit-tree",
                    "release^{tree}",
                    "-p",
                    "release",
                    "-m",
                    "remote release advances",
                ]);
                f.git(&[
                    "-C",
                    remote.to_str().unwrap(),
                    "update-ref",
                    "refs/heads/release",
                    commit.trim(),
                ]);
                f.git(&[
                    "-C",
                    repo,
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit",
                    "--allow-empty",
                    "-m",
                    "local main advances",
                ]);
            }
        }
        for detached in [false, true] {
            if detached {
                f.git(&["checkout", "--detach"]);
            }
            let before = f.coordinated_effects();
            let bytes = fs::read(&config_path).unwrap();
            let native = f.run(false, &["status", "--json"]);
            assert!(
                native.status.success(),
                "{}",
                String::from_utf8_lossy(&native.stdout)
            );
            let value: Value = serde_json::from_slice(&native.stdout).unwrap();
            let rows = value["data"]["repositories"].as_array().unwrap();
            for (i, row) in rows.iter().enumerate() {
                assert_eq!(
                    row["baseBranchSource"],
                    if row["name"] == "zulu" {
                        "workspace-config"
                    } else {
                        "repository-config"
                    }
                );
                assert_eq!(
                    row["baseBranch"]["branch"],
                    if row["name"] == "zulu" {
                        "main"
                    } else {
                        "release"
                    }
                );
                assert_eq!(
                    row["baseBranch"]["state"],
                    if !remote_enabled {
                        "unavailable"
                    } else if detached && i == 0 {
                        "skipped"
                    } else {
                        "available"
                    }
                );
            }
            if remote_enabled && !detached {
                for row in rows {
                    assert_eq!(row["baseBranch"]["ahead"], 1);
                    assert_eq!(
                        row["baseBranch"]["behind"],
                        if row["name"] == "zulu" { 0 } else { 1 }
                    );
                }
            }
            if std::env::var_os("ARASHI_TS_PARITY").is_some() {
                compare(&f.run(true, &["status", "--json"]), &native);
                for flags in [
                    vec!["status"],
                    vec!["status", "--short"],
                    vec!["status", "--verbose"],
                ] {
                    let source = f.run(true, &flags);
                    let native = f.run(false, &flags);
                    assert_eq!(source.status.code(), native.status.code());
                    assert_eq!(
                        String::from_utf8_lossy(&source.stdout),
                        String::from_utf8_lossy(&native.stdout)
                    );
                    assert_eq!(source.stderr, native.stderr);
                }
            }
            assert_eq!(before, f.coordinated_effects());
            assert_eq!(bytes, fs::read(&config_path).unwrap());
        }
    }
}

#[test]
fn configured_status_missing_remote_refs_are_warnings() {
    for missing in ["release", "main", "transport"] {
        let f = Fixture::new();
        fs::create_dir_all(f.repo.join(".arashi")).unwrap();
        fs::write(f.repo.join(".arashi/config.json"), r#"{"version":"1.0.0","reposDir":"repos","worktreesDir":".arashi/worktrees","baseBranch":"main","meta":{"baseBranch":"release"},"repos":{}}"#).unwrap();
        f.git(&["branch", "release"]);
        let remote = f.base.join("remote.git");
        f.git(&[
            "clone",
            "--bare",
            f.repo.to_str().unwrap(),
            remote.to_str().unwrap(),
        ]);
        f.git(&["remote", "add", "origin", remote.to_str().unwrap()]);
        f.git(&["fetch", "origin"]);
        f.git(&["branch", "--set-upstream-to=origin/main", "main"]);
        f.git(&["remote", "set-head", "origin", "main"]);
        if missing == "transport" {
            f.git(&["config", "remote.origin.uploadpack", "false"]);
        } else {
            f.git(&[
                "-C",
                remote.to_str().unwrap(),
                "update-ref",
                "-d",
                &format!("refs/heads/{missing}"),
            ]);
        }

        let native = f.run(false, &["status", "--json"]);
        assert!(
            native.status.success(),
            "{}",
            String::from_utf8_lossy(&native.stdout)
        );
        let value: Value = serde_json::from_slice(&native.stdout).unwrap();
        assert!(!value["warnings"].as_array().unwrap().is_empty());
        assert_eq!(
            value["data"]["repositories"][0][if missing == "release" {
                "baseBranch"
            } else {
                "defaultBranch"
            }]["reason"],
            "refresh-failed"
        );
        if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            compare(&f.run(true, &["status", "--json"]), &native);
            for args in [
                vec!["status"],
                vec!["status", "--short"],
                vec!["status", "--verbose"],
            ] {
                let source = f.run(true, &args);
                let native = f.run(false, &args);
                assert_eq!(source.status.code(), native.status.code());
                assert_eq!(
                    String::from_utf8_lossy(&source.stdout),
                    String::from_utf8_lossy(&native.stdout)
                );
                assert_eq!(source.stderr, native.stderr);
            }
        }
    }
}

#[test]
fn configured_status_preflights_all_remotes_before_fetch() {
    let mut f = Fixture::new();
    f.configured();
    let remote = f.base.join("remote.git");
    f.git(&[
        "clone",
        "--bare",
        f.repo.to_str().unwrap(),
        remote.to_str().unwrap(),
    ]);
    f.git(&["remote", "add", "origin", remote.to_str().unwrap()]);
    f.git(&[
        "-C",
        "repos/alpha",
        "remote",
        "add",
        "origin",
        "https://example.invalid/never-fetch",
    ]);
    let native = f.run(false, &["status", "--json"]);
    assert!(!native.status.success());
    assert!(
        !f.repo.join(".git/FETCH_HEAD").exists(),
        "unsupported child policy must fail before parent fetch"
    );
    assert!(f.git(&["for-each-ref", "refs/remotes"]).is_empty());
}

#[test]
fn status_human_modes_and_verbose_json() {
    for configured in [false, true] {
        let mut f = Fixture::new();
        if configured {
            f.configured();
        }
        fs::write(f.repo.join("file.txt"), "changed\n").unwrap();
        fs::write(f.repo.join("untracked"), "new\n").unwrap();
        for flag in [None, Some("--short"), Some("--verbose")] {
            let mut args = vec!["status"];
            if let Some(flag) = flag {
                args.push(flag);
            }
            let native = f.run(false, &args);
            assert!(
                native.status.success(),
                "{}",
                String::from_utf8_lossy(&native.stderr)
            );
            assert!(String::from_utf8_lossy(&native.stdout).contains("Summary:"));
            if std::env::var_os("ARASHI_TS_PARITY").is_some() {
                let source = f.run(true, &args);
                assert_eq!(source.status.code(), native.status.code());
                assert_eq!(
                    String::from_utf8_lossy(&source.stdout),
                    String::from_utf8_lossy(&native.stdout),
                    "{args:?}"
                );
                assert_eq!(source.stderr, native.stderr);
            }
        }
        if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            compare(
                &f.run(true, &["status", "--verbose", "--json"]),
                &f.run(false, &["status", "--verbose", "--json"]),
            );
            compare(
                &f.run(true, &["status", "--verbose", "--short", "--json"]),
                &f.run(false, &["status", "--verbose", "--short", "--json"]),
            );
        }
    }
}

#[test]
fn status_human_missing_child_and_base_warnings() {
    let mut f = Fixture::new();
    f.configured();
    let p = f.repo.join(".arashi/config.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
    config["baseBranch"] = Value::from("main");
    config["worktreesDir"] = Value::from(".arashi/worktrees");
    fs::write(p, serde_json::to_vec(&config).unwrap()).unwrap();
    fs::remove_dir_all(f.repo.join("repos/alpha")).unwrap();
    f.git(&["checkout", "--detach"]);
    for flag in [None, Some("--short"), Some("--verbose")] {
        let mut args = vec!["status"];
        if let Some(flag) = flag {
            args.push(flag);
        }
        let native = f.run(false, &args);
        assert_eq!(
            native.status.code(),
            Some(if flag == Some("--verbose") { 1 } else { 0 })
        );
        if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            let source = f.run(true, &args);
            assert_eq!(native.status.code(), source.status.code());
            assert_eq!(
                String::from_utf8_lossy(&native.stdout),
                String::from_utf8_lossy(&source.stdout)
            );
            assert_eq!(native.stderr, source.stderr);
        }
    }
}

#[test]
fn configured_remove_branch_only_and_mixed_targets() {
    for mixed in [false, true] {
        let mut f = Fixture::new();
        f.configured();
        let branch = "old-feature";
        let child = f.repo.join(".arashi/worktrees/old-feature/repos/alpha");
        let prepare = || {
            for repo in [".", "repos/zulu", "repos/alpha"] {
                f.git(&["-C", repo, "branch", branch]);
            }
            if mixed {
                f.git(&[
                    "-C",
                    "repos/alpha",
                    "worktree",
                    "add",
                    child.to_str().unwrap(),
                    branch,
                ]);
            }
        };
        prepare();
        let before = f.coordinated_effects();
        if !mixed {
            let args = ["remove", branch, "--force", "--keep-branches", "--json"];
            let native = f.run(false, &args);
            assert!(native.status.success());
            if std::env::var_os("ARASHI_TS_PARITY").is_some() {
                compare(&f.run(true, &args), &native);
            }
            assert_eq!(before, f.coordinated_effects());
            let no_force = f.run(false, &["remove", branch, "--json"]);
            assert!(!no_force.status.success());
            assert_eq!(before, f.coordinated_effects());
        }
        let args = ["remove", branch, "--force", "--dry-run", "--json"];
        let native = f.run(false, &args);
        assert!(
            native.status.success(),
            "{}",
            String::from_utf8_lossy(&native.stdout)
        );
        let value: Value = serde_json::from_slice(&native.stdout).unwrap();
        assert_eq!(value["data"]["summary"]["totalBranches"], 3);
        assert_eq!(
            value["data"]["summary"]["totalWorktrees"],
            usize::from(mixed)
        );
        assert_eq!(before, f.coordinated_effects());
        if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            compare(&f.run(true, &args), &native);
        }
        let args = ["remove", branch, "--force", "--json"];
        let source = if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            let source = f.run(true, &args);
            assert!(
                source.status.success(),
                "{}",
                String::from_utf8_lossy(&source.stdout)
            );
            prepare();
            Some(source)
        } else {
            None
        };
        let native = f.run(false, &args);
        assert!(
            native.status.success(),
            "{}",
            String::from_utf8_lossy(&native.stdout)
        );
        if let Some(source) = source {
            compare(&source, &native);
        }
        for repo in [".", "repos/zulu", "repos/alpha"] {
            assert!(f.git(&["-C", repo, "branch", "--list", branch]).is_empty());
        }
        assert!(!child.exists());
    }
}

#[test]
fn status_rejects_unported_branch_remote_before_fetch() {
    let f = Fixture::new();
    let remote = f.base.join("remote.git");
    f.git(&[
        "clone",
        "--bare",
        f.repo.to_str().unwrap(),
        remote.to_str().unwrap(),
    ]);
    f.git(&["remote", "add", "origin", remote.to_str().unwrap()]);
    f.git(&["config", "branch.main.remote", "."]);
    f.git(&["config", "branch.main.merge", "refs/heads/main"]);
    let native = f.run(false, &["status", "--json"]);
    assert!(!native.status.success());
    let value: Value = serde_json::from_slice(&native.stdout).unwrap();
    assert_eq!(value["error"]["code"], "PORT_UNSUPPORTED");
    assert!(!f.repo.join(".git/FETCH_HEAD").exists());
}

// Exec/setup are process contracts, independent of create/remove lifecycle hooks.
#[cfg(unix)]
fn run_with_path(
    f: &Fixture,
    source: bool,
    args: &[&str],
    path: Option<&std::ffi::OsStr>,
) -> Output {
    let mut c = if source {
        // Resolve the oracle runtime before replacing the child's search path.
        let node = Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .unwrap();
        assert!(node.status.success());
        let mut c = Command::new(String::from_utf8(node.stdout).unwrap().trim());
        c.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"));
        c
    } else {
        Command::new(env!("CARGO_BIN_EXE_arashi"))
    };
    f.environment(&mut c);
    c.args(args);
    if let Some(path) = path {
        c.env("PATH", path);
    } else {
        c.env_remove("PATH");
    }
    c.output().unwrap()
}

#[cfg(unix)]
#[test]
fn exec_direct_launch_arguments_and_path_source_contract() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let mut f = Fixture::new();
    f.configured();
    let script = "printf '%s\\n' \"$1\"; printf '%s\\n' \"$2\"; printf '%s\\n' \"$3\"";
    for dir in ["bin space", "denied"] {
        fs::create_dir(f.repo.join(dir)).unwrap();
    }
    let probe = f.repo.join("bin space/probe");
    fs::write(&probe, format!("#!/bin/sh\n{script}\n")).unwrap();
    fs::set_permissions(&probe, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(f.repo.join("denied/probe"), "must not run").unwrap();
    fs::set_permissions(
        f.repo.join("denied/probe"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    symlink(&probe, f.repo.join("probe-link")).unwrap();
    fs::write(f.repo.join("plain"), script).unwrap();
    let custom_path = std::ffi::OsStr::new("missing:file.txt:denied:bin space:/usr/bin:/bin");
    for (command, path) in [
        (vec!["./bin space/probe"], Some(custom_path)),
        (vec![probe.to_str().unwrap()], Some(custom_path)),
        (vec!["./probe-link"], Some(custom_path)),
        (vec!["probe"], Some(custom_path)),
        (
            vec!["probe-link"],
            Some(std::ffi::OsStr::new(":/usr/bin:/bin")),
        ),
        (
            vec!["probe-link"],
            Some(std::ffi::OsStr::new("/usr/bin:/bin:")),
        ),
        (vec!["sh", "./plain"], None),
        (
            vec!["/bin/sh", "-c", script, "argv-zero"],
            Some(custom_path),
        ),
    ] {
        let mut args = vec!["exec", "--json", "--only", "workspace", "--"];
        args.extend(command);
        args.extend(["literal;$() a b", "", "--help"]);
        let native = run_with_path(&f, false, &args, path);
        assert!(
            native.status.success(),
            "{}",
            String::from_utf8_lossy(&native.stdout)
        );
        let value: Value = serde_json::from_slice(&native.stdout).unwrap();
        assert_eq!(
            value["data"]["results"][0]["stdout"],
            "literal;$() a b\n\n--help\n"
        );
        if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            compare(&run_with_path(&f, true, &args, path), &native);
        }
    }
    // A missing interpreter, non-executable file and directory are launch
    // failures, not permission to invoke a shell or alter argv.
    fs::write(&probe, "#!/arashi-no-such-interpreter\necho wrong\n").unwrap();
    for program in ["probe", "./denied/probe", "./bin space"] {
        let args = ["exec", "--json", "--only", "workspace", "--", program];
        let native = run_with_path(&f, false, &args, Some(custom_path));
        assert_eq!(native.status.code(), Some(1));
        if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            compare(&run_with_path(&f, true, &args, Some(custom_path)), &native);
        }
    }
}

#[cfg(target_os = "macos")]
#[test]
fn setup_path_interpreter_rejects_implicit_shell_source_contract() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    f.configured();
    fs::create_dir(f.repo.join("fake-bin")).unwrap();
    fs::write(
        f.repo.join("fake-bin/sh"),
        "echo executed > implicit-shell-sentinel\n",
    )
    .unwrap();
    fs::set_permissions(
        f.repo.join("fake-bin/sh"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    fs::write(f.repo.join("setup.sh"), "echo setup\n").unwrap();
    let args = ["setup", "--json", "--only", "workspace"];
    let path = Some(std::ffi::OsStr::new("fake-bin:/usr/bin:/bin"));
    let source = std::env::var_os("ARASHI_TS_PARITY").map(|_| {
        let output = run_with_path(&f, true, &args, path);
        assert_eq!(output.status.code(), Some(1));
        assert!(!f.repo.join("implicit-shell-sentinel").exists());
        output
    });
    let native = run_with_path(&f, false, &args, path);
    assert!(!f.repo.join("implicit-shell-sentinel").exists());
    assert_eq!(native.status.code(), Some(1));
    let value: Value = serde_json::from_slice(&native.stdout).unwrap();
    assert_eq!(value["data"]["executions"][0]["detail"], "spawn ENOEXEC");
    if let Some(source) = source {
        compare(&source, &native);
    }
}

#[cfg(target_os = "macos")]
#[test]
fn exec_no_shebang_rejects_implicit_shell_source_contract() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    f.configured();
    let probe = f.repo.join("probe");
    let sentinel = f.repo.join("implicit-shell-sentinel");
    fs::write(
        &probe,
        "printf 'executed\\n' > implicit-shell-sentinel; printf '%s\\n' \"$1\"\n",
    )
    .unwrap();
    fs::set_permissions(&probe, fs::Permissions::from_mode(0o755)).unwrap();
    std::os::unix::fs::symlink(&probe, f.repo.join("probe-link")).unwrap();
    fs::create_dir(f.repo.join("later")).unwrap();
    fs::write(
        f.repo.join("later/probe"),
        "#!/bin/sh\nprintf 'wrong fallback\\n'\n",
    )
    .unwrap();
    fs::set_permissions(
        f.repo.join("later/probe"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let path = Some(std::ffi::OsStr::new(".:later:/usr/bin:/bin"));
    for program in ["./probe", probe.to_str().unwrap(), "./probe-link", "probe"] {
        let args = [
            "exec",
            "--json",
            "--only",
            "workspace",
            "--",
            program,
            "literal;$() a b",
        ];
        let source = std::env::var_os("ARASHI_TS_PARITY").map(|_| {
            let source = run_with_path(&f, true, &args, path);
            assert_eq!(source.status.code(), Some(1));
            assert!(!sentinel.exists(), "source implicitly executed text");
            let value: Value = serde_json::from_slice(&source.stdout).unwrap();
            assert_eq!(value["error"]["code"], "EXEC_COMMAND_FAILED");
            assert_eq!(
                value["error"]["details"]["results"][0]["errorMessage"],
                "spawn ENOEXEC"
            );
            eprintln!(
                "source {program}: exit={:?}, sentinel={}, stdout={}",
                source.status.code(),
                sentinel.exists(),
                String::from_utf8_lossy(&source.stdout)
            );
            source
        });
        let native = run_with_path(&f, false, &args, path);
        eprintln!(
            "native {program}: exit={:?}, sentinel={}, stdout={}",
            native.status.code(),
            sentinel.exists(),
            String::from_utf8_lossy(&native.stdout)
        );
        assert!(!sentinel.exists(), "native implicitly executed text");
        assert_eq!(native.status.code(), Some(1));
        if let Some(source) = source {
            compare(&source, &native);
        }
    }
}

#[test]
fn exec_source_contract() {
    let mut f = Fixture::new();
    f.configured();
    let script = "process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1),directive:process.env.ARASHI_DIRECTIVE_FILE??null,shell:process.env.ARASHI_SHELL??null})+'\\n');process.stderr.write('diagnostic\\n')";
    for flags in [
        vec![],
        vec!["--only", "alpha,zulu,alpha"],
        vec!["--group", "backend"],
        vec!["--jobs", "2"],
        vec!["--dirty"],
    ] {
        let mut args = vec!["exec", "--json"];
        args.extend(flags);
        args.extend([
            "--",
            "node",
            "-e",
            script,
            "--",
            "a b",
            "literal;$()",
            "--help",
            "--json",
        ]);
        let native = f.run(false, &args);
        assert!(
            native.status.success(),
            "{}",
            String::from_utf8_lossy(&native.stdout)
        );
        let value: Value = serde_json::from_slice(&native.stdout).unwrap();
        assert_eq!(value["data"]["failed"], 0);
        if args.contains(&"--dirty") {
            assert_eq!(value["data"]["total"], 0);
        }
        if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            compare(&f.run(true, &args), &native);
        }
    }
    // Child flags must not change the parent output mode or help dispatch.
    let args = [
        "exec", "--only", "alpha", "--", "node", "-e", script, "--", "--help", "--json",
    ];
    let native = f.run(false, &args);
    assert!(String::from_utf8_lossy(&native.stdout).starts_with("Running "));
    if std::env::var_os("ARASHI_TS_PARITY").is_some() {
        let source = f.run(true, &args);
        assert_eq!(source.stdout, native.stdout);
        assert_eq!(source.stderr, native.stderr);
        assert_eq!(source.status.code(), native.status.code());
    }
}

#[test]
fn exec_failures_dirty_and_usage_source_contract() {
    let mut f = Fixture::new();
    f.configured();
    fs::write(f.repo.join("repos/alpha/dirty"), "change").unwrap();
    for args in [
        vec![
            "exec",
            "--json",
            "--",
            "node",
            "-e",
            "process.stdout.write('out\\n');process.stderr.write('err\\n');process.exit(7)",
        ],
        vec![
            "exec",
            "--json",
            "--fail-fast",
            "--",
            "node",
            "-e",
            "process.exit(7)",
        ],
        vec![
            "exec",
            "--json",
            "--dirty",
            "--",
            "node",
            "-e",
            "console.log(process.cwd())",
        ],
        vec!["exec", "--json", "--", "arashi-no-such-executable-fixture"],
        vec!["exec", "--json"],
        vec!["exec", "--json", "--jobs", "01", "--", "node"],
        vec!["exec", "--json", "--only", "missing", "--", "node"],
        vec!["exec", "--json", "--group", "missing", "--", "node"],
        vec![
            "exec", "--json", "--only", "alpha", "--group", "Backend", "--", "node",
        ],
        vec!["exec", "--json", "--only", " , ", "--", "node"],
    ] {
        let before = f.coordinated_effects();
        let native = f.run(false, &args);
        let value: Value = serde_json::from_slice(&native.stdout).unwrap();
        assert_ne!(value["error"]["code"], "RUST_NOT_YET_PORTED");
        if args.contains(&"--dirty") {
            assert!(native.status.success());
            assert_eq!(value["data"]["total"], 1);
        } else {
            assert!(!native.status.success());
        }
        assert_eq!(before, f.coordinated_effects());
        if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            compare(&f.run(true, &args), &native);
        }
    }
}

#[test]
fn setup_discovery_filters_source_contract() {
    let mut f = Fixture::new();
    f.configured();
    for flags in [
        vec![],
        vec!["--only", "alpha,zulu"],
        vec!["--group", "backend"],
        vec!["--only", "workspace"],
        vec!["--only", "missing"],
        vec!["--only", " , "],
    ] {
        let mut args = vec!["setup", "--json"];
        args.extend(flags);
        let before = f.coordinated_effects();
        let native = f.run(false, &args);
        let value: Value = serde_json::from_slice(&native.stdout).unwrap();
        assert_ne!(value["error"]["code"], "RUST_NOT_YET_PORTED");
        if value["ok"] == true {
            assert_eq!(value["data"]["skippedCount"], 3);
        }
        assert_eq!(before, f.coordinated_effects());
        if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            compare(&f.run(true, &args), &native);
        }
    }
}

#[cfg(unix)]
#[test]
fn setup_scripts_order_output_failure_and_timeout_source_contract() {
    let mut f = Fixture::new();
    f.configured();
    fs::create_dir_all(f.repo.join("repos/alpha/.arashi")).unwrap();
    fs::write(
        f.repo.join("setup.sh"),
        "printf ' main out \\n'; printf ' main err \\n' >&2; echo main >> order\n",
    )
    .unwrap();
    fs::write(
        f.repo.join("repos/zulu/setup.bash"),
        "echo zulu >> ../../order; echo failing >&2; exit 7\n",
    )
    .unwrap();
    fs::write(
        f.repo.join("repos/alpha/.arashi/setup.sh"),
        "echo alpha >> ../../order; echo done\n",
    )
    .unwrap();
    // Detection order wins; setup.bash is still interpreted with sh.
    fs::write(f.repo.join("setup.bash"), "echo wrong >> order\n").unwrap();
    for flags in [
        vec![],
        vec!["--only", "alpha,zulu"],
        vec!["--group", "Backend"],
    ] {
        let mut args = vec!["setup", "--json"];
        args.extend(flags);
        let native = f.run(false, &args);
        assert_eq!(native.status.code(), Some(1));
        let order = fs::read(f.repo.join("order")).unwrap();
        if args.len() == 2 {
            assert_eq!(order, b"main\nzulu\nalpha\n");
        }
        fs::remove_file(f.repo.join("order")).unwrap();
        if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            let source = f.run(true, &args);
            compare(&source, &native);
            assert_eq!(fs::read(f.repo.join("order")).unwrap(), order);
            fs::remove_file(f.repo.join("order")).unwrap();
        }
    }
    let p = f.repo.join(".arashi/config.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
    config["hooks"] = serde_json::json!({"timeout":100});
    fs::write(p, serde_json::to_vec(&config).unwrap()).unwrap();
    // exec replaces the shell: timeout controls exactly the source's direct child.
    fs::write(f.repo.join("setup.sh"), "exec sleep 2\n").unwrap();
    let args = ["setup", "--json", "--only", "workspace"];
    let native = f.run(false, &args);
    assert_eq!(native.status.code(), Some(1));
    let value: Value = serde_json::from_slice(&native.stdout).unwrap();
    assert_eq!(value["data"]["timedOutCount"], 1);
    if std::env::var_os("ARASHI_TS_PARITY").is_some() {
        compare(&f.run(true, &args), &native);
    }
}

#[cfg(unix)]
#[test]
fn setup_signal_and_directory_source_contract() {
    let mut f = Fixture::new();
    f.configured();
    let p = f.repo.join(".arashi/config.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
    config["hooks"] = serde_json::json!({"timeout":150});
    fs::write(p, serde_json::to_vec(&config).unwrap()).unwrap();
    let args = ["setup", "--json", "--only", "workspace"];
    for script in [
        "kill -TERM $$\n",
        "trap 'exit 0' TERM\nwhile :; do :; done\n",
    ] {
        fs::write(f.repo.join("setup.sh"), script).unwrap();
        let source = std::env::var_os("ARASHI_TS_PARITY").map(|_| f.run(true, &args));
        let native = f.run(false, &args);
        if let Some(source) = source {
            compare(&source, &native);
        }
    }
    fs::remove_file(f.repo.join("setup.sh")).unwrap();
    fs::create_dir(f.repo.join("setup.sh")).unwrap();
    let source = std::env::var_os("ARASHI_TS_PARITY").map(|_| f.run(true, &args));
    let native = f.run(false, &args);
    let value: Value = serde_json::from_slice(&native.stdout).unwrap();
    assert_eq!(value["data"]["targets"][0]["hasSetupTask"], true);
    if let Some(source) = source {
        compare(&source, &native);
    }
}

#[test]
fn execution_rejects_unsupported_projection_before_any_child_runs() {
    let mut f = Fixture::new();
    f.configured();
    let config_path = f.repo.join(".arashi/config.json");
    let original: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    for command in ["exec", "setup"] {
        for policy in ["materialization", "external-parent"] {
            let mut config = original.clone();
            if policy == "materialization" {
                config["repos"]["alpha"]["copy"] = serde_json::json!(["file"]);
            } else {
                config["repos"]["alpha"]["path"] = serde_json::json!(f.repo.join("../home"));
            }
            fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
            fs::write(f.repo.join("setup.sh"), "echo ran > sentinel\n").unwrap();
            let args = if command == "exec" {
                vec![
                    "exec",
                    "--json",
                    "--",
                    "node",
                    "-e",
                    "require('fs').writeFileSync('sentinel','ran')",
                ]
            } else {
                vec!["setup", "--json"]
            };
            let native = f.run(false, &args);
            assert!(
                !native.status.success(),
                "{policy}: {}",
                String::from_utf8_lossy(&native.stdout)
            );
            let value: Value = serde_json::from_slice(&native.stdout).unwrap();
            assert_eq!(value["error"]["code"], "RUST_NOT_YET_PORTED");
            assert!(
                !f.repo.join("sentinel").exists(),
                "must preflight all repositories"
            );
            assert!(!f.repo.join("repos/zulu/sentinel").exists());
            assert!(!f.home.join("sentinel").exists());
        }
    }
}

#[test]
fn exec_parallel_barrier_and_environment_source_contract() {
    let mut f = Fixture::new();
    f.configured();
    let script = r#"const fs=require('fs'),path=require('path');
if(process.env.ARASHI_DIRECTIVE_FILE||process.env.ARASHI_SHELL)process.exit(10);
const root=path.resolve('..','..');const name=path.basename(process.cwd());
fs.writeFileSync(path.join(root,name+'.started'),'yes');
const start=Date.now();const timer=setInterval(()=>{
 if(['alpha','zulu'].every(n=>fs.existsSync(path.join(root,n+'.started')))){
  clearInterval(timer);process.stdout.write('x'.repeat(200000));process.stderr.write('y'.repeat(200000));
 } else if(Date.now()-start>3000){clearInterval(timer);process.exit(9);}
},10);"#;
    let args = [
        "exec",
        "--json",
        "--jobs",
        "2",
        "--only",
        "zulu,alpha",
        "--",
        "node",
        "-e",
        script,
    ];
    for source in [true, false] {
        if source && std::env::var_os("ARASHI_TS_PARITY").is_none() {
            continue;
        }
        let mut c = if source {
            let mut c = Command::new("node");
            c.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"));
            c
        } else {
            Command::new(env!("CARGO_BIN_EXE_arashi"))
        };
        f.environment(&mut c);
        c.args(args)
            .env("ARASHI_DIRECTIVE_FILE", f.home.join("directives"))
            .env("ARASHI_SHELL", "zsh");
        let output = c.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["data"]["passed"], 2);
        for result in value["data"]["results"].as_array().unwrap() {
            assert_eq!(result["stdout"].as_str().unwrap().len(), 200000);
            assert_eq!(result["stderr"].as_str().unwrap().len(), 200000);
        }
        for name in ["alpha", "zulu"] {
            assert_eq!(
                fs::read(f.repo.join(format!("{name}.started"))).unwrap(),
                b"yes"
            );
            fs::remove_file(f.repo.join(format!("{name}.started"))).unwrap();
        }
        if source {
            fs::write(f.base.join("source.stdout"), &output.stdout).unwrap();
        } else if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            let mut source: Value =
                serde_json::from_slice(&fs::read(f.base.join("source.stdout")).unwrap()).unwrap();
            let mut native = value;
            normalized(&mut source);
            normalized(&mut native);
            assert_eq!(source, native);
            assert!(output.stderr.is_empty());
        }
        assert!(!f.home.join("directives").exists());
    }
}

#[test]
fn execution_context_and_missing_repository_source_contract() {
    let mut f = Fixture::new();
    for command in ["exec", "setup"] {
        for json in [true, false] {
            let mut args = vec![command];
            if json {
                args.push("--json");
            }
            if command == "exec" {
                args.extend(["--", "git", "--version"]);
            }
            let source = std::env::var_os("ARASHI_TS_PARITY").map(|_| f.run(true, &args));
            let native = f.run(false, &args);
            assert_eq!(native.status.code(), Some(if json { 2 } else { 1 }));
            if let Some(source) = source {
                if json {
                    compare(&source, &native);
                } else {
                    assert_eq!(source.stdout, native.stdout);
                    assert_eq!(source.stderr, native.stderr);
                    assert_eq!(source.status.code(), native.status.code());
                }
            }
        }
    }
    f.configured();
    fs::remove_dir_all(f.repo.join("repos/alpha")).unwrap();
    for args in [
        vec![
            "exec",
            "--json",
            "--only",
            "alpha",
            "--",
            "git",
            "--version",
        ],
        vec!["setup", "--json", "--only", "alpha"],
        vec![
            "exec",
            "--json",
            "--jobs=",
            "--only",
            "zulu",
            "--",
            "git",
            "--version",
        ],
    ] {
        let source = std::env::var_os("ARASHI_TS_PARITY").map(|_| f.run(true, &args));
        let native = f.run(false, &args);
        if let Some(source) = source {
            compare(&source, &native);
        }
    }
}

#[test]
fn setup_metadata_and_human_skips_source_contract() {
    let mut f = Fixture::new();
    f.configured();
    let config_path = f.repo.join(".arashi/config.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    config["baseBranch"] = serde_json::json!("origin/workspace-base");
    config["meta"] = serde_json::json!({"baseBranch":"origin/meta-base"});
    config["repos"]["alpha"]["baseBranch"] = serde_json::json!("origin/child-base");
    config["repos"]["zulu"]["gitUrl"] = serde_json::json!("../local-remote");
    config["hooks"] =
        serde_json::json!({"scripts":{"pre-create":"echo forbidden > lifecycle-sentinel"}});
    fs::write(config_path, serde_json::to_vec(&config).unwrap()).unwrap();
    fs::create_dir_all(f.repo.join(".arashi/hooks")).unwrap();
    fs::write(
        f.repo.join(".arashi/hooks/pre-create.sh"),
        "echo forbidden > lifecycle-sentinel\n",
    )
    .unwrap();
    for args in [
        vec!["setup", "--json"],
        vec!["setup"],
        vec!["setup", "--verbose", "--group", "backend"],
        vec!["exec", "--json", "--only", "zulu", "--", "git", "--version"],
    ] {
        let before = f.coordinated_effects();
        let source = std::env::var_os("ARASHI_TS_PARITY").map(|_| f.run(true, &args));
        let native = f.run(false, &args);
        assert!(native.status.success());
        assert_eq!(before, f.coordinated_effects());
        if let Some(source) = source {
            if args.contains(&"--json") {
                compare(&source, &native);
            } else {
                assert_eq!(source.stdout, native.stdout);
                assert_eq!(source.stderr, native.stderr);
                assert_eq!(source.status.code(), native.status.code());
            }
        }
        assert!(!f.repo.join("lifecycle-sentinel").exists());
    }
}

include!("rust/lifecycle.rs");
include!("rust/materialization.rs");

include!("rust/create_reuse.rs");
include!("rust/create_remote.rs");
