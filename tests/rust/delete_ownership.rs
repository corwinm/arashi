//! Deterministic mutation-boundary tests; only disposable repositories.
use super::*;
use std::{
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
static ID: AtomicU64 = AtomicU64::new(0);
const ISOLATED_TEST: &str = "ARASHI_DELETE_OWNERSHIP_TEST";

// Reexec instead of mutating the environment of the multithreaded test process.
// Both fixture Git commands and in-process production reads use this private home.
fn run_isolated(name: &str) -> bool {
    let name = format!("delete::ownership_tests::{name}");
    if std::env::var(ISOLATED_TEST).as_deref() == Ok(name.as_str()) {
        return false;
    }
    let home = tempfile::tempdir().unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", &name, "--nocapture"])
        .env(ISOLATED_TEST, &name)
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .env("XDG_CONFIG_HOME", home.path())
        .env("GIT_CONFIG_GLOBAL", home.path().join(".gitconfig"))
        .env("GIT_CONFIG_NOSYSTEM", "1");
    // Git command-scope configuration also propagates through the test runner.
    for (key, _) in std::env::vars_os() {
        let text = key.to_string_lossy();
        if matches!(text.as_ref(), "GIT_CONFIG_COUNT" | "GIT_CONFIG_PARAMETERS")
            || text.starts_with("GIT_CONFIG_KEY_")
            || text.starts_with("GIT_CONFIG_VALUE_")
        {
            command.env_remove(key);
        }
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "isolated {name}:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    true
}
#[test]
fn ownership_fixture_isolates_inherited_git_configuration() {
    let home = tempfile::tempdir().unwrap();
    let config = home.path().join(".gitconfig");
    fs::write(&config, "[filter \"ci\"]\nclean = cat\n").unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "delete::ownership_tests::replaced_git_directory_invalidates_the_plan",
            "--nocapture",
        ])
        .env_remove(ISOLATED_TEST)
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .env("XDG_CONFIG_HOME", home.path())
        .env("GIT_CONFIG_GLOBAL", &config)
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "filter.ci.clean")
        .env("GIT_CONFIG_VALUE_0", "cat")
        .env("GIT_CONFIG_PARAMETERS", "'filter.ci.smudge=cat'")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
}

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "arashi-delete-ownership-{}-{}",
            std::process::id(),
            ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        let path = fs::canonicalize(path).unwrap();
        fs::create_dir_all(path.join("repos/api")).unwrap();
        fs::create_dir(path.join(".arashi")).unwrap();
        run(&path, &["init", "--initial-branch=main"]);
        let target = path.join("repos/api");
        run(&target, &["init", "--initial-branch=main"]);
        fs::write(target.join("README"), "tracked\n").unwrap();
        run(&target, &["add", "README"]);
        run(&target, &["commit", "-m", "initial"]);
        let oid = git::run_readonly(&target, &["rev-parse", "HEAD"]).unwrap();
        run(
            &target,
            &["update-ref", "refs/remotes/origin/main", oid.trim()],
        );
        run(
            &target,
            &["remote", "add", "origin", path.to_str().unwrap()],
        );
        fs::write(path.join(".arashi/config.json"), serde_json::to_vec(&json!({"version":"1.0.0","reposDir":"repos","worktreesDir":".arashi/worktrees","repos":{"api":{"path":"repos/api","gitUrl":path}}})).unwrap()).unwrap();
        Self(path)
    }
    fn plan(&self) -> DeletePlan {
        DeletePlan::build(&Workspace::discover(&self.0).unwrap(), "api").unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn run(path: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args([
            "-c",
            "commit.gpgSign=false",
            "-c",
            "maintenance.auto=false",
            "-c",
            "user.name=Delete Test",
            "-c",
            "user.email=delete@example.test",
        ])
        .args(args)
        .current_dir(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn replace_directory_preserving_children(path: &Path) {
    let previous = path.with_extension("previous");
    fs::rename(path, &previous).unwrap();
    fs::create_dir(path).unwrap();
    for entry in fs::read_dir(&previous).unwrap() {
        let entry = entry.unwrap();
        fs::rename(entry.path(), path.join(entry.file_name())).unwrap();
    }
    // Keep the old inode allocated: no inode-reuse false positives.
}
#[test]
fn configuration_changed_since_discovery_cannot_authorize_an_old_target() {
    if run_isolated("configuration_changed_since_discovery_cannot_authorize_an_old_target") {
        return;
    }
    let fixture = Fixture::new();
    let workspace = Workspace::discover(&fixture.0).unwrap();
    let path = fixture.0.join(".arashi/config.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    config["repos"]["api"]["path"] = json!("repos/reassigned");
    fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    let before = fs::read(&path).unwrap();
    assert!(
        DeletePlan::build(&workspace, "api").is_err(),
        "stale discovery accepted new deletion authority"
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(fixture.0.join("repos/api/README").is_file());
}

#[cfg(unix)]
#[test]
fn quarantine_revalidation_rejects_changed_fetch_authority() {
    if run_isolated("quarantine_revalidation_rejects_changed_fetch_authority") {
        return;
    }
    let fixture = Fixture::new();
    let plan = fixture.plan();
    let quarantine = fixture.0.join("repos/quarantine");
    fs::rename(&plan.repository_path, &quarantine).unwrap();
    run(
        &quarantine,
        &[
            "remote",
            "set-url",
            "origin",
            "https://example.invalid/reassigned.git",
        ],
    );
    assert!(
        plan.validate_quarantine(&quarantine, &plan.config_before)
            .is_err(),
        "changed fetch authority was accepted"
    );
    assert!(quarantine.join("README").is_file());
}

#[test]
fn replaced_repository_parent_invalidates_the_plan() {
    if run_isolated("replaced_repository_parent_invalidates_the_plan") {
        return;
    }
    let fixture = Fixture::new();
    let plan = fixture.plan();
    replace_directory_preserving_children(&fixture.0.join("repos"));
    assert!(plan.validate().is_err(), "parent ownership was not frozen");
    assert!(fixture.0.join("repos/api/README").is_file());
}
#[test]
fn replaced_git_directory_invalidates_the_plan() {
    if run_isolated("replaced_git_directory_invalidates_the_plan") {
        return;
    }
    let fixture = Fixture::new();
    let plan = fixture.plan();
    replace_directory_preserving_children(&fixture.0.join("repos/api/.git"));
    // Store the emptied old metadata directory outside the clone, keeping the target clean.
    fs::rename(
        fixture.0.join("repos/api/.git.previous"),
        fixture.0.join("old-git"),
    )
    .unwrap();
    assert!(plan.validate().is_err(), "Git ownership was not frozen");
}
#[cfg(unix)]
#[test]
fn quarantine_revalidation_rejects_new_detached_linked_ownership() {
    if run_isolated("quarantine_revalidation_rejects_new_detached_linked_ownership") {
        return;
    }
    let fixture = Fixture::new();
    let plan = fixture.plan();
    let quarantine = fixture.0.join("repos/quarantine");
    fs::rename(&plan.repository_path, &quarantine).unwrap();
    let linked = fixture.0.join("linked");
    run(
        &quarantine,
        &["worktree", "add", "--detach", linked.to_str().unwrap()],
    );
    assert!(
        plan.validate_quarantine(&quarantine, &plan.config_before)
            .is_err(),
        "new linked owner would be orphaned"
    );
    assert!(linked.join("README").is_file());
    assert!(quarantine.join("README").is_file());
}
