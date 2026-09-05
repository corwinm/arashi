//! Independent source-versus-native journeys; requires Node and installed source dependencies.
//! Run: cargo test --test rust_parity -- --ignored
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
        let base = base.canonicalize().unwrap();
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
            .env("NO_COLOR", "1")
            .env_remove("ARASHI_DIRECTIVE_FILE")
            .env_remove("ARASHI_SHELL");
    }
    fn git(&self, args: &[&str]) -> String {
        let mut c = Command::new("git");
        c.args(args);
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
            serde_json::json!(["secret"])
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
fn configured_linked_child_status_fails_closed_until_projection_is_ported() {
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
    assert!(f.run(false, &create).status.success());
    f.repo = f.repo.join(".arashi/worktrees/feature/repos/alpha");
    assert!(!f.run(false, &["status", "--json"]).status.success());
}
