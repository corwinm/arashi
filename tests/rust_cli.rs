use std::{
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Repo(PathBuf);
impl Repo {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "arashi-rust-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&p).unwrap();
        let r = Self(p.canonicalize().unwrap());
        r.git(&["init", "-b", "main"]);
        r.git(&[
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "seed",
        ]);
        r
    }
    fn git(&self, args: &[&str]) -> String {
        let o = Command::new("git")
            .args(args)
            .current_dir(&self.0)
            .output()
            .unwrap();
        assert!(
            o.status.success(),
            "{:?}: {}",
            args,
            String::from_utf8_lossy(&o.stderr)
        );
        String::from_utf8(o.stdout).unwrap()
    }
    fn cli(&self, args: &[&str]) -> Output {
        run(&self.0, args)
    }
}
impl Drop for Repo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn run(cwd: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_arashi"))
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap()
}
#[test]
fn git_adapter_real_worktrees() {
    let r = Repo::new();
    let path = r.0.join("with space");
    r.git(&["worktree", "add", "-b", "feat/test", path.to_str().unwrap()]);
    let w = arashi::git::worktrees(&r.0).unwrap();
    assert_eq!(w.len(), 2);
    assert_eq!(w[1].path, path);
    assert_eq!(w[1].branch.as_deref(), Some("feat/test"));
    assert_eq!(w[0].head.trim(), r.git(&["rev-parse", "HEAD"]).trim());
}
#[test]
fn version_and_alias() {
    for binary in [env!("CARGO_BIN_EXE_arashi"), env!("CARGO_BIN_EXE_aw")] {
        let o = Command::new(binary).arg("--version").output().unwrap();
        assert!(o.status.success());
        assert_eq!(String::from_utf8(o.stdout).unwrap(), "2.0.0-alpha.1\n");
    }
}
#[test]
fn help_and_unsupported_are_honest() {
    let r = Repo::new();
    let o = r.cli(&["--help"]);
    assert!(o.status.success());
    let s = String::from_utf8(o.stdout).unwrap();
    for c in ["create", "remove", "status", "shell", "configure"] {
        assert!(s.contains(c));
    }
    let o = r.cli(&["sync", "--json"]);
    assert!(!o.status.success());
    let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(v["error"]["code"], "RUST_NOT_YET_PORTED");
    assert_eq!(v["ok"], false);
    assert_eq!(v["schemaVersion"], 1);
    assert!(o.stderr.is_empty());
}
fn document(o: &Output) -> serde_json::Value {
    serde_json::from_slice(&o.stdout).unwrap_or_else(|_| {
        panic!(
            "stdout={} stderr={}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        )
    })
}
fn standalone() -> Repo {
    let r = Repo::new();
    std::fs::create_dir(r.0.join(".worktrees")).unwrap();
    std::fs::write(r.0.join(".git/info/exclude"), ".worktrees/\n").unwrap();
    r
}
#[test]
fn standalone_list_and_create_journey() {
    let r = standalone();
    let o = r.cli(&["list", "--json"]);
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stdout));
    let v = document(&o);
    assert_eq!(v["data"]["worktrees"][0]["branch"], "main");
    assert_eq!(v["data"]["repositoriesBase"], r.0.to_str().unwrap());
    let o = r.cli(&[
        "create",
        "feature/test",
        "--no-launch",
        "--no-switch",
        "--no-hooks",
        "--json",
    ]);
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stdout));
    let v = document(&o);
    assert_eq!(v["data"]["branchName"], "feature/test");
    assert!(r.0.join(".worktrees/feature/test/.git").is_file());
    assert_eq!(v["data"]["hookOutcomes"], serde_json::json!([]));
    let o = r.cli(&["list", "--json"]);
    assert_eq!(
        document(&o)["data"]["worktrees"].as_array().unwrap().len(),
        2
    );
}
#[test]
fn create_dry_run_and_ignore_failure_do_not_mutate() {
    let r = standalone();
    let o = r.cli(&[
        "create",
        "dry",
        "--dry-run",
        "--no-launch",
        "--no-switch",
        "--no-hooks",
        "--json",
    ]);
    assert!(o.status.success());
    assert!(!r.0.join(".worktrees/dry").exists());
    assert!(r.git(&["branch", "--list", "dry"]).is_empty());
    std::fs::write(r.0.join(".git/info/exclude"), "").unwrap();
    let o = r.cli(&["create", "unsafe", "--no-hooks", "--json"]);
    assert!(!o.status.success());
    assert_eq!(
        document(&o)["error"]["code"],
        "STANDALONE_DESTINATION_NOT_IGNORED"
    );
    assert!(r.git(&["branch", "--list", "unsafe"]).is_empty());
}
#[test]
fn remove_real_worktree_and_protect_primary() {
    let r = standalone();
    let p = r.0.join(".worktrees/feature");
    r.git(&["worktree", "add", "-b", "feature", p.to_str().unwrap()]);
    let o = r.cli(&["remove", "main", "--force", "--json"]);
    assert!(!o.status.success());
    assert!(r.0.join(".git").is_dir());
    let o = r.cli(&["remove", "feature", "--force", "--json"]);
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stdout));
    assert!(!p.exists());
    assert!(r.git(&["branch", "--list", "feature"]).is_empty());
    assert_eq!(document(&o)["data"]["summary"]["successfulWorktrees"], 1);
}
#[test]
fn unsupported_option_fails_before_mutation() {
    let r = standalone();
    let o = r.cli(&["create", "unsafe", "--move-changes", "--json"]);
    assert!(!o.status.success());
    assert_eq!(document(&o)["error"]["code"], "RUST_NOT_YET_PORTED");
    assert!(r.git(&["branch", "--list", "unsafe"]).is_empty());
}
#[test]
fn list_plain_is_pipe_friendly_and_install_contract() {
    let r = standalone();
    let o = r.cli(&["list"]);
    assert!(o.status.success());
    assert_eq!(
        String::from_utf8(o.stdout).unwrap(),
        format!("{}\n", r.0.display())
    );
    let o = r.cli(&["install", "--json"]);
    assert!(o.status.success());
    assert_eq!(
        document(&o)["data"]["releasesUrl"],
        "https://github.com/corwinm/arashi/releases"
    );
}
#[test]
fn removal_rejects_locked_nested_and_hooks_before_mutation() {
    let r = standalone();
    let p = r.0.join(".worktrees/feature");
    r.git(&["worktree", "add", "-b", "feature", p.to_str().unwrap()]);
    r.git(&["worktree", "lock", p.to_str().unwrap()]);
    let o = r.cli(&["remove", "feature", "--force", "--json"]);
    assert!(!o.status.success());
    assert!(p.exists());
    r.git(&["worktree", "unlock", p.to_str().unwrap()]);
    let child = p.join("child");
    std::fs::create_dir(&child).unwrap();
    let o = Command::new("git")
        .args(["init", "-b", "main"])
        .current_dir(&child)
        .output()
        .unwrap();
    assert!(o.status.success());
    let o = r.cli(&["remove", "feature", "--force", "--json"]);
    assert!(!o.status.success());
    assert!(child.join(".git").is_dir());
    std::fs::remove_dir_all(&child).unwrap();
    let home = r.0.join("test-home");
    std::fs::create_dir_all(home.join(".arashi/hooks")).unwrap();
    std::fs::write(home.join(".arashi/hooks/pre-remove.sh"), "exit 0").unwrap();
    let o = Command::new(env!("CARGO_BIN_EXE_arashi"))
        .args(["remove", "feature", "--force", "--json"])
        .env("HOME", &home)
        .current_dir(&r.0)
        .output()
        .unwrap();
    assert!(!o.status.success());
    assert!(p.exists());
}
#[cfg(unix)]
#[test]
fn create_refuses_symlink_destination_before_branch_creation() {
    let r = standalone();
    let outside = r.0.join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, r.0.join(".worktrees/escape")).unwrap();
    let o = r.cli(&["create", "escape/topic", "--no-hooks", "--json"]);
    assert!(!o.status.success());
    assert!(r.git(&["branch", "--list", "escape/topic"]).is_empty());
    assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
}
#[test]
fn plans_revalidate_workspace_mode_before_mutation() {
    let r = standalone();
    let w = arashi::config::Workspace::discover(&r.0).unwrap();
    let plan = arashi::operations::CreatePlan::build(&w, "later", true).unwrap();
    std::fs::create_dir(r.0.join(".arashi")).unwrap();
    std::fs::write(
        r.0.join(".arashi/config.json"),
        r#"{"version":"1.0.0","reposDir":"repos","repos":{}}"#,
    )
    .unwrap();
    assert!(plan.execute(&w, false).is_err());
    assert!(r.git(&["branch", "--list", "later"]).is_empty());
}
#[test]
fn removal_revalidates_target_branch_before_mutation() {
    let r = standalone();
    let p = r.0.join(".worktrees/feature");
    r.git(&["worktree", "add", "-b", "feature", p.to_str().unwrap()]);
    let w = arashi::config::Workspace::discover(&r.0).unwrap();
    let plan = arashi::operations::RemovePlan::build(&w, "feature", false, false, true).unwrap();
    r.git(&["-C", p.to_str().unwrap(), "checkout", "-b", "changed"]);
    assert!(plan.execute(&w, false).is_err());
    assert!(p.exists());
    assert!(!r.git(&["branch", "--list", "feature"]).is_empty());
}
#[test]
fn removal_rejects_nested_bare_repository() {
    let r = standalone();
    let p = r.0.join(".worktrees/feature");
    r.git(&["worktree", "add", "-b", "feature", p.to_str().unwrap()]);
    r.git(&["init", "--bare", p.join("nested.git").to_str().unwrap()]);
    let w = arashi::config::Workspace::discover(&r.0).unwrap();
    assert!(arashi::operations::RemovePlan::build(&w, "feature", false, false, true).is_err());
    assert!(p.join("nested.git/HEAD").is_file());
}
#[test]
fn create_revalidates_source_commit() {
    let r = standalone();
    let w = arashi::config::Workspace::discover(&r.0).unwrap();
    let plan = arashi::operations::CreatePlan::build(&w, "later", true).unwrap();
    r.git(&[
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "changed",
    ]);
    assert!(plan.execute(&w, false).is_err());
    assert!(r.git(&["branch", "--list", "later"]).is_empty());
}
#[test]
fn create_file_ancestor_does_not_leave_branch() {
    let r = standalone();
    std::fs::write(r.0.join(".worktrees/blocked"), "keep me").unwrap();
    let o = r.cli(&["create", "blocked/topic", "--no-hooks", "--json"]);
    assert!(!o.status.success());
    assert!(r.git(&["branch", "--list", "blocked/topic"]).is_empty());
    assert_eq!(
        std::fs::read_to_string(r.0.join(".worktrees/blocked")).unwrap(),
        "keep me"
    );
}
#[test]
fn prune_native_journey_preserves_branch_and_live_worktree() {
    let r = standalone();
    let p = r.0.join(".worktrees/stale");
    r.git(&["worktree", "add", "-b", "stale", p.to_str().unwrap()]);
    std::fs::remove_dir_all(&p).unwrap();
    let o = r.cli(&["prune", "--dry-run", "--json"]);
    assert!(o.status.success());
    assert_eq!(document(&o)["data"]["totalPrunable"], 1);
    assert!(
        r.git(&["worktree", "list", "--porcelain"])
            .contains("prunable")
    );
    let o = r.cli(&["prune", "--json"]);
    assert!(o.status.success());
    assert_eq!(document(&o)["data"]["totalPruned"], 1);
    assert!(
        !r.git(&["worktree", "list", "--porcelain"])
            .contains("prunable")
    );
    assert!(!r.git(&["branch", "--list", "stale"]).is_empty());
    assert!(r.0.join(".git").exists());
}
