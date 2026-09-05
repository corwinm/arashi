use arashi::{config::Workspace, operations::CreatePlan};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    root: PathBuf,
    home: PathBuf,
}
impl Fixture {
    fn new(configured: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "arashi-safety-review-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&root).unwrap();
        let root = arashi::paths::canonicalize(&root).unwrap();
        let home = root.join(".test-home");
        fs::create_dir(&home).unwrap();
        let f = Self { root, home };
        init_repo(&f.root);
        fs::write(
            f.root.join(".gitignore"),
            ".test-home/\n.worktrees/\n.arashi/worktrees/\nrepos/\n",
        )
        .unwrap();
        if configured {
            fs::create_dir(f.root.join(".arashi")).unwrap();
            fs::write(f.root.join(".arashi/config.json"), r#"{"version":"1.0.0","reposDir":"repos","worktreesDir":".arashi/worktrees","repos":{}}"#).unwrap();
        } else {
            fs::create_dir(f.root.join(".worktrees")).unwrap();
        }
        git(&f.root, &["add", "."]);
        commit(&f.root);
        f
    }
    fn cli(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_arashi"))
            .args(args)
            .current_dir(&self.root)
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .output()
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn git(root: &Path, args: &[&str]) -> String {
    let o = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        o.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
    String::from_utf8(o.stdout).unwrap().trim().to_owned()
}
fn commit(root: &Path) {
    git(
        root,
        &[
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Safety",
            "-c",
            "user.email=safety@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
        ],
    );
}
fn init_repo(root: &Path) {
    fs::create_dir_all(root).unwrap();
    git(root, &["init", "-b", "main"]);
    commit(root);
}
#[test]
fn stale_registration_rejected_before_standalone_branch_creation() {
    let f = Fixture::new(false);
    let target = f.root.join(".worktrees/new");
    git(
        &f.root,
        &["worktree", "add", "-b", "old", target.to_str().unwrap()],
    );
    fs::remove_dir_all(&target).unwrap();
    for dry in [true, false] {
        let mut args = vec!["create", "new", "--no-hooks", "--json"];
        if dry {
            args.push("--dry-run");
        }
        let o = f.cli(&args);
        assert!(
            !o.status.success(),
            "stale registration must fail before mutation (dry={dry})"
        );
        assert!(git(&f.root, &["branch", "--list", "new"]).is_empty());
        assert_eq!(arashi::git::worktrees(&f.root).unwrap().len(), 2);
    }
}
#[test]
fn stale_registration_rejected_before_coordinated_branch_creation() {
    let f = Fixture::new(true);
    let target = f.root.join(".arashi/worktrees/new");
    git(
        &f.root,
        &["worktree", "add", "-b", "old", target.to_str().unwrap()],
    );
    fs::remove_dir_all(&target).unwrap();
    let before = fs::read(f.root.join(".git/info/exclude")).unwrap();
    for dry in [true, false] {
        let mut args = vec![
            "create",
            "new",
            "--no-hooks",
            "--no-launch",
            "--no-switch",
            "--json",
        ];
        if dry {
            args.push("--dry-run");
        }
        let o = f.cli(&args);
        assert!(
            !o.status.success(),
            "stale registration must fail before mutation (dry={dry})"
        );
        assert!(git(&f.root, &["branch", "--list", "new"]).is_empty());
        assert_eq!(fs::read(f.root.join(".git/info/exclude")).unwrap(), before);
    }
}
#[test]
fn same_named_tag_does_not_mask_changed_existing_branch() {
    let f = Fixture::new(false);
    git(&f.root, &["branch", "topic"]);
    git(&f.root, &["tag", "topic"]);
    commit(&f.root);
    let workspace = Workspace::discover(&f.root).unwrap();
    let plan = CreatePlan::build(&workspace, "topic", true).unwrap();
    git(&f.root, &["update-ref", "refs/heads/topic", "HEAD"]);
    let result = plan.execute(&workspace, false);
    assert!(
        result.is_err(),
        "a tag must not hide changes to the branch that will be checked out"
    );
    assert!(!f.root.join(".worktrees/topic").exists());
}
#[cfg(unix)]
fn checkout_failure(root: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let hook = root.join(".git/hooks/post-checkout");
    fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    fs::set_permissions(hook, fs::Permissions::from_mode(0o755)).unwrap();
}
#[cfg(unix)]
#[test]
fn failed_native_checkout_rolls_back_only_owned_standalone_state() {
    for existing in [false, true] {
        let f = Fixture::new(false);
        if existing {
            git(&f.root, &["branch", "topic"]);
        }
        checkout_failure(&f.root);
        let o = f.cli(&["create", "topic", "--no-hooks", "--json"]);
        assert!(!o.status.success());
        assert_eq!(
            arashi::git::worktrees(&f.root).unwrap().len(),
            1,
            "failed checkout left a worktree"
        );
        assert_eq!(
            !git(&f.root, &["branch", "--list", "topic"]).is_empty(),
            existing,
            "pre-existing branch ownership must be preserved"
        );
    }
}
#[cfg(unix)]
#[test]
fn coordinated_rollback_uses_branch_identity_not_same_named_tag() {
    let f = Fixture::new(true);
    let child = f.root.join("repos/api");
    init_repo(&child);
    fs::write(f.root.join(".arashi/config.json"), r#"{"version":"1.0.0","reposDir":"repos","worktreesDir":".arashi/worktrees","repos":{"api":{"path":"repos/api","gitUrl":"file:///fixture/api"}}}"#).unwrap();
    git(&f.root, &["add", ".arashi/config.json"]);
    commit(&f.root);
    git(&f.root, &["branch", "topic"]);
    let old = git(&f.root, &["rev-parse", "refs/heads/topic"]);
    commit(&f.root);
    git(&f.root, &["tag", "topic"]);
    checkout_failure(&child);
    let o = f.cli(&[
        "create",
        "topic",
        "--conflict",
        "REUSE_EXISTING",
        "--no-hooks",
        "--no-launch",
        "--no-switch",
        "--json",
    ]);
    assert!(!o.status.success());
    assert_eq!(
        arashi::git::worktrees(&f.root).unwrap().len(),
        1,
        "existing-branch worktree created by invocation must roll back"
    );
    assert_eq!(arashi::git::worktrees(&child).unwrap().len(), 1);
    assert_eq!(git(&f.root, &["rev-parse", "refs/heads/topic"]), old);
    assert!(git(&child, &["branch", "--list", "topic"]).is_empty());
}
