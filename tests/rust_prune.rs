use arashi::{
    config::{Config, Workspace},
    prune::prune,
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "arashi-prune-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&p).unwrap();
        let p = arashi::paths::canonicalize(&p).unwrap();
        init(&p);
        fs::create_dir(p.join(".worktrees")).unwrap();
        Self(p)
    }
    fn workspace(&self) -> Workspace {
        Workspace {
            root: self.0.clone(),
            config: None,
        }
    }
    fn stale(&self, branch: &str) -> PathBuf {
        stale(&self.0, branch)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn git(root: &Path, args: &[&str]) -> String {
    let o = Command::new("git")
        .args(["-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        o.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
    String::from_utf8(o.stdout).unwrap()
}
fn init(root: &Path) {
    git(root, &["init", "-b", "main"]);
    git(
        root,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        ],
    );
}
fn stale(root: &Path, branch: &str) -> PathBuf {
    let p = root.join(".worktrees").join(branch);
    git(
        root,
        &["worktree", "add", "-b", branch, p.to_str().unwrap()],
    );
    fs::remove_dir_all(&p).unwrap();
    p
}
#[test]
fn stale_dry_run_then_prune_preserves_branches_and_live_files() {
    let f = Fixture::new();
    let stale = f.stale("gone");
    fs::write(f.0.join("keep"), "safe").unwrap();
    let before = git(&f.0, &["worktree", "list", "--porcelain"]);
    let data = prune(&f.workspace(), true, "now").unwrap();
    assert_eq!(data["totalPrunable"], 1);
    assert_eq!(data["totalPruned"], 0);
    assert_eq!(data["repositories"][0]["status"], "skipped");
    assert_eq!(data["repositories"][0]["prunable"][0]["path"], json!(stale));
    assert_eq!(before, git(&f.0, &["worktree", "list", "--porcelain"]));
    let data = prune(&f.workspace(), false, "now").unwrap();
    assert_eq!(data["totalPruned"], 1);
    assert_eq!(data["repositories"][0]["status"], "pruned");
    assert_eq!(arashi::git::worktrees(&f.0).unwrap().len(), 1);
    assert_eq!(fs::read_to_string(f.0.join("keep")).unwrap(), "safe");
    git(&f.0, &["show-ref", "--verify", "refs/heads/gone"]);
}
#[test]
fn clean_standalone_exact_shape() {
    let f = Fixture::new();
    let name = f.0.file_name().unwrap().to_str().unwrap();
    assert_eq!(
        prune(&f.workspace(), false, "now").unwrap(),
        json!({"dryRun":false,"expire":"now","overallStatus":"success","repositories":[{"name":name,"path":f.0,"prunable":[],"prunedCount":0,"status":"skipped"}],"totalFailed":0,"totalPrunable":0,"totalPruned":0,"totalRepositories":1,"workspaceRoot":f.0,"mode":"standalone","repositoryPath":f.0})
    );
}
#[test]
fn unsupported_expiry_fails_without_metadata_mutation() {
    let f = Fixture::new();
    f.stale("gone");
    assert!(prune(&f.workspace(), false, "yesterday").is_err());
    assert_eq!(arashi::git::worktrees(&f.0).unwrap().len(), 2);
}
#[test]
fn configured_preflights_every_repository_before_pruning() {
    let f = Fixture::new();
    f.stale("gone");
    let mut w = f.workspace();
    w.config=Some(Config::parse(r#"{"version":"1.0.0","reposDir":"repos","repos":{"missing":{"path":"repos/missing"}}}"#).unwrap());
    assert!(prune(&w, false, "now").is_err());
    assert_eq!(arashi::git::worktrees(&f.0).unwrap().len(), 2);
}
#[test]
fn configured_prunes_parent_and_child() {
    let f = Fixture::new();
    f.stale("gone");
    let child = f.0.join("repos/api");
    fs::create_dir_all(&child).unwrap();
    init(&child);
    stale(&child, "gone");
    let mut w = f.workspace();
    w.config = Some(
        Config::parse(
            r#"{"version":"1.0.0","reposDir":"repos","repos":{"api":{"path":"repos/api"}}}"#,
        )
        .unwrap(),
    );
    let data = prune(&w, false, "now").unwrap();
    assert_eq!(data["totalPruned"], 2);
    assert_eq!(data["totalRepositories"], 2);
    assert_eq!(data["mode"], "configured");
    assert_eq!(data["worktreesBase"], json!(f.0.join(".arashi/worktrees")));
    assert!(data.get("repositoryPath").is_none());
    assert_eq!(arashi::git::worktrees(&child).unwrap().len(), 1);
}
#[test]
#[ignore = "requires Node TypeScript source runtime"]
fn source_oracle() {
    for configured in [false, true] {
        let f = Fixture::new();
        let mut repositories = vec![f.0.clone()];
        if configured {
            fs::create_dir(f.0.join(".arashi")).unwrap();
            let s =
                r#"{"version":"1.0.0","reposDir":"repos","repos":{"api":{"path":"repos/api"}}}"#;
            fs::write(f.0.join(".arashi/config.json"), s).unwrap();
            let child = f.0.join("repos/api");
            fs::create_dir_all(&child).unwrap();
            init(&child);
            repositories.push(child);
        }
        for root in &repositories {
            stale(root, "gone");
            fs::write(root.join("keep"), "untracked file remains").unwrap();
            let live = root.join(".worktrees/live");
            git(
                root,
                &["worktree", "add", "-b", "live", live.to_str().unwrap()],
            );
            fs::write(live.join("keep"), "live worktree file remains").unwrap();
            git(
                root,
                &[
                    "worktree",
                    "lock",
                    "--reason",
                    "oracle protection",
                    live.to_str().unwrap(),
                ],
            );
        }
        let invoke = |native: bool, dry: bool| {
            let mut command = if native {
                Command::new(env!("CARGO_BIN_EXE_arashi"))
            } else {
                let mut c = Command::new("node");
                c.arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"));
                c
            };
            command.args(["prune", "--json"]);
            if dry {
                command.arg("--dry-run");
            }
            command.current_dir(&f.0).output().unwrap()
        };
        let state = || {
            repositories
                .iter()
                .map(|root| {
                    (
                        git(root, &["worktree", "list", "--porcelain", "-z"]),
                        git(
                            root,
                            &[
                                "for-each-ref",
                                "--format=%(refname) %(objectname)",
                                "refs/heads/",
                            ],
                        ),
                        fs::read(root.join("keep")).unwrap(),
                        fs::read(root.join(".worktrees/live/keep")).unwrap(),
                        root.join(".worktrees/gone").exists(),
                    )
                })
                .collect::<Vec<_>>()
        };
        let initial = state();
        for dry in [true, false] {
            let source = invoke(false, dry);
            assert!(
                source.status.success(),
                "{}",
                String::from_utf8_lossy(&source.stderr)
            );
            let expected_state = state();
            if dry {
                assert_eq!(expected_state, initial);
            } else {
                // Reconstruct only stale metadata so both CLIs start from identical Git state.
                // Branch refs and all surviving files remain exactly as the source left them.
                for root in &repositories {
                    let missing = root.join(".worktrees/gone");
                    git(
                        root,
                        &["worktree", "add", missing.to_str().unwrap(), "gone"],
                    );
                    fs::remove_dir_all(missing).unwrap();
                }
                assert_eq!(state(), initial);
            }
            let native = invoke(true, dry);
            assert_eq!(
                native.status.code(),
                source.status.code(),
                "{}",
                String::from_utf8_lossy(&native.stderr)
            );
            let source_json: Value = serde_json::from_slice(&source.stdout).unwrap();
            let native_json: Value = serde_json::from_slice(&native.stdout).unwrap();
            assert_eq!(
                native_json, source_json,
                "configured={configured}, dry={dry}"
            );
            assert_eq!(state(), expected_state, "filesystem and Git effects differ");
            if !dry {
                for root in &repositories {
                    assert_eq!(arashi::git::worktrees(root).unwrap().len(), 2);
                    git(root, &["show-ref", "--verify", "refs/heads/gone"]);
                }
            }
        }
    }
}
