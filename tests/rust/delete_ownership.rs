//! Deterministic mutation-boundary tests; only disposable repositories.
use super::*;
use std::{
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
static ID: AtomicU64 = AtomicU64::new(0);
const ISOLATED_TEST: &str = "ARASHI_DELETE_OWNERSHIP_TEST";
const INTERRUPTED_WORKSPACE: &str = "ARASHI_DELETE_INTERRUPTED_WORKSPACE";
const RACE_POINT: &str = "ARASHI_DELETE_RACE_POINT";

fn run_race_child(point: &str) -> bool {
    if std::env::var(RACE_POINT).as_deref() != Ok(point) {
        return false;
    }
    let root = PathBuf::from(std::env::var_os("ARASHI_DELETE_RACE_WORKSPACE").unwrap());
    let plan = DeletePlan::build(&Workspace::discover(&root).unwrap(), "api").unwrap();
    let _ = plan.execute();
    true
}

fn spawn_race(test: &str, fixture: &Fixture, point: &str) -> (Child, PathBuf) {
    let ready = fixture.0.join(format!("race-{point}-ready"));
    let resume = fixture.0.join(format!("race-{point}-resume"));
    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture"])
        .env(ISOLATED_TEST, test)
        .env(RACE_POINT, point)
        .env("ARASHI_DELETE_RACE_WORKSPACE", &fixture.0)
        .env("ARASHI_DELETE_RACE_READY", &ready)
        .env("ARASHI_DELETE_RACE_RESUME", &resume)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !ready.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "race child did not pause"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    (child, resume)
}

fn finish_race(child: Child, resume: &Path) {
    fs::write(resume, "resume\n").unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "race child failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

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

#[cfg(unix)]
#[test]
fn successful_delete_retains_the_receipt_owned_clone_quarantine() {
    if run_isolated("successful_delete_retains_the_receipt_owned_clone_quarantine") {
        return;
    }
    let fixture = Fixture::new();
    let plan = fixture.plan();
    let receipt = receipt::Receipt::create(&plan).unwrap();
    let quarantine = PathBuf::from(
        receipt.record["runtime"]["quarantinePath"]
            .as_str()
            .unwrap(),
    );
    let receipt_path = receipt.path.clone();
    drop(receipt);
    let args = Args {
        command: "delete".to_owned(),
        positional: vec!["api".to_owned()],
        options: [("force".to_owned(), vec![]), ("json".to_owned(), vec![])]
            .into_iter()
            .collect(),
    };

    let output = delete(&Workspace::discover(&fixture.0).unwrap(), &args).unwrap();

    assert!(!fixture.0.join("repos/api").exists());
    assert_eq!(fs::read(quarantine.join("README")).unwrap(), b"tracked\n");
    let retained_receipts = fs::read_dir(receipt_path.parent().unwrap())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with(receipt_path.file_name().unwrap().to_string_lossy().as_ref())
                && name.ends_with(".retained")
        })
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    assert_eq!(retained_receipts.len(), 1);
    let retained_record: Value =
        serde_json::from_slice(&fs::read(&retained_receipts[0]).unwrap()).unwrap();
    assert_eq!(retained_record["warnings"], json!(plan.warnings));
    assert_eq!(
        receipt::plan_hash(&retained_record).unwrap(),
        retained_record["planId"].as_str().unwrap()
    );
    let residues = retained_record["terminalResidues"].as_array().unwrap();
    assert_eq!(residues.len(), 1);
    assert!(Path::new(residues[0]["destination"].as_str().unwrap()).exists());
    assert!(
        output["result"]["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| {
                warning
                    .as_str()
                    .unwrap()
                    .starts_with("DELETE_RETAINED_CLEANUP: ")
            })
    );
}

#[cfg(unix)]
#[test]
fn completed_generation_does_not_block_deleting_a_readded_repository() {
    if run_isolated("completed_generation_does_not_block_deleting_a_readded_repository") {
        return;
    }
    let fixture = Fixture::new();
    let first_plan = fixture.plan();
    let first_receipt = receipt::Receipt::create(&first_plan).unwrap();
    let first_quarantine = PathBuf::from(
        first_receipt.record["runtime"]["quarantinePath"]
            .as_str()
            .unwrap(),
    );
    transaction::execute(
        first_receipt,
        &Workspace::discover(&fixture.0).unwrap(),
        Some(&first_plan),
    )
    .unwrap();

    run(
        &fixture.0,
        &[
            "clone",
            first_quarantine.to_str().unwrap(),
            fixture.0.join("repos/api").to_str().unwrap(),
        ],
    );
    let config = json!({"version":"1.0.0","reposDir":"repos","worktreesDir":".arashi/worktrees","repos":{"api":{"path":"repos/api","gitUrl":first_quarantine}}});
    fs::write(
        fixture.0.join(".arashi/config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    let second_plan = fixture.plan();
    let second_receipt = receipt::Receipt::create(&second_plan).unwrap();
    let second_quarantine = PathBuf::from(
        second_receipt.record["runtime"]["quarantinePath"]
            .as_str()
            .unwrap(),
    );
    transaction::execute(
        second_receipt,
        &Workspace::discover(&fixture.0).unwrap(),
        Some(&second_plan),
    )
    .unwrap();

    assert_ne!(first_quarantine, second_quarantine);
    assert!(first_quarantine.join("README").is_file());
    assert!(second_quarantine.join("README").is_file());
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

#[test]
fn malformed_porcelain_v2_tracked_records_fail_closed() {
    let oid = "0123456789012345678901234567890123456789";
    let valid = [
        format!("1 M. N... 100644 100644 100644 {oid} {oid} file\0"),
        format!("2 R. N... 100644 100644 100644 {oid} {oid} R100 new\0old\0"),
        format!("u UU N... 100644 100644 100644 100644 {oid} {oid} {oid} file\0"),
    ];
    for record in valid {
        assert!(
            parse_checkout_loss_warnings(Path::new("/repo"), &record).is_ok(),
            "valid control={record:?}"
        );
    }
    let malformed = [
        format!("1 ZZ N... 100644 100644 100644 {oid} {oid} file\0"),
        format!("1 M. N... 100644 100648 100644 {oid} {oid} file\0"),
        format!("1 M. N... 100644 100644 100644 nope {oid} file\0"),
        format!("1 M. broken 100644 100644 100644 {oid} {oid} file\0"),
        format!("2 R. N... 100644 100644 100644 {oid} {oid} R101 new\0old\0"),
        format!("2 R. N... 100644 100644 100644 {oid} {oid} R100 new\0../old\0"),
        format!("u XX N... 100644 100644 100644 100644 {oid} {oid} {oid} file\0"),
        format!("u UU N... 100644 100644 100644 100644 {oid} {oid} nope file\0"),
        format!("u UU N... 100644 100644 100644 {oid} {oid} {oid} file\0"),
    ];
    for record in malformed {
        let error = parse_checkout_loss_warnings(Path::new("/repo"), &record).unwrap_err();
        assert_eq!(error.code, "DELETE_GIT_DATA_LOSS", "record={record:?}");
    }
}

#[test]
fn transaction_failure_classification_respects_irreversible_boundary() {
    let before = transaction::classify_execution_failure(
        closed(
            "DELETE_CONCURRENT_CHANGE",
            "pre-destructive revalidation failed",
            1,
        ),
        false,
        "worktrees",
        json!({"phase":"worktrees"}),
        "api",
    );
    assert_eq!(before.code, "DELETE_CONCURRENT_CHANGE");
    assert_eq!(before.message, "pre-destructive revalidation failed");

    let after = transaction::classify_execution_failure(
        closed(
            "DELETE_CONCURRENT_CHANGE",
            "pre-destructive revalidation failed",
            1,
        ),
        true,
        "worktrees",
        json!({"phase":"worktrees"}),
        "api",
    );
    assert_eq!(after.code, "DELETE_PARTIAL_FAILURE");
    assert_eq!(after.details.unwrap()["repositoryKey"], "api");
}

#[cfg(unix)]
#[test]
fn instrumented_receipt_boundaries_refuse_changed_bytes() {
    if run_isolated("instrumented_receipt_boundaries_refuse_changed_bytes") {
        return;
    }
    for retiring in [false, true] {
        let fixture = Fixture::new();
        let plan = fixture.plan();
        let mut receipt = receipt::Receipt::create(&plan).unwrap();
        let receipt_path = receipt::path(&fixture.0.join(".git"), "api");
        let saved = receipt_path.with_extension(if retiring {
            "retire-old"
        } else {
            "persist-old"
        });
        // This deterministic seam verifies best-effort stale detection. Arashi-private
        // receipt names rely on cooperative writers holding the workspace lock.
        let replacement = format!("changed receipt {retiring}\n").into_bytes();
        let race = || {
            fs::rename(&receipt_path, &saved).unwrap();
            fs::write(&receipt_path, &replacement).unwrap();
        };
        let error = if retiring {
            receipt.remove_with_race(race).unwrap_err()
        } else {
            receipt.persist_with_race(race).unwrap_err()
        };
        assert_eq!(error.code, "DELETE_RECEIPT_STALE");
        assert_eq!(fs::read(&receipt_path).unwrap(), replacement);
        assert!(
            saved.exists(),
            "the accepted receipt must remain recoverable"
        );
    }
}

#[cfg(unix)]
#[test]
fn atomic_initial_receipt_publication_exposes_no_partial_active_generation() {
    if run_isolated("atomic_initial_receipt_publication_exposes_no_partial_active_generation") {
        return;
    }
    for boundary in [
        receipt::InitialPublishStage::StagedSynced,
        receipt::InitialPublishStage::PublishedBeforeParentSync,
    ] {
        let fixture = Fixture::new();
        let plan = fixture.plan();
        let active = receipt::path(&fixture.0.join(".git"), "api");
        let error = match receipt::Receipt::create_with_stage(&plan, |stage| {
            if stage == boundary {
                Err(std::io::Error::other("injected initial interruption").into())
            } else {
                Ok(())
            }
        }) {
            Err(error) => error,
            Ok(_) => panic!("initial publication interruption unexpectedly succeeded"),
        };
        assert_eq!(error.message, "injected initial interruption");
        if boundary == receipt::InitialPublishStage::StagedSynced {
            assert!(
                !active.exists(),
                "staging interruption exposed an active receipt"
            );
        } else {
            let bytes = fs::read(&active).unwrap();
            let record: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(record["repositoryKey"], "api");
            assert_eq!(
                record["planId"],
                json!(receipt::plan_hash(&record).unwrap())
            );
            receipt::Receipt::load(&fixture.0.join(".git"), "api")
                .unwrap()
                .unwrap();
        }
    }
}

#[cfg(unix)]
#[test]
fn atomic_receipt_publication_preserves_an_active_generation_at_both_boundaries() {
    if run_isolated("atomic_receipt_publication_preserves_an_active_generation_at_both_boundaries")
    {
        return;
    }
    for boundary in [
        receipt::PersistStage::StagedSynced,
        receipt::PersistStage::PublishedBeforeParentSync,
    ] {
        let fixture = Fixture::new();
        let plan = fixture.plan();
        let mut receipt = receipt::Receipt::create(&plan).unwrap();
        let old = fs::read(&receipt.path).unwrap();
        let provenance_id = receipt.record["identities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["kind"] == "resume-receipt")
            .unwrap()["id"]
            .clone();
        let canonical_ids = receipt.record["identities"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| matches!(item["kind"].as_str(), Some("canonical-clone" | "local-ref")))
            .map(|item| item["id"].clone())
            .collect::<Vec<_>>();
        receipt.record["completedItemIds"] = json!([provenance_id]);
        receipt.record["completedPhases"] = json!(["provenance", "worktrees", "metadata"]);
        receipt.record["remainingPhases"] = json!(receipt::PHASES[3..]);
        receipt.record["runtime"]["destructionPreparedItemIds"] = json!(canonical_ids);
        use std::os::unix::fs::MetadataExt;
        let old_inode = fs::metadata(&receipt.path).unwrap().ino();
        let error = receipt
            .persist_with_stage(|stage| {
                if stage == boundary {
                    Err(std::io::Error::other("injected interruption").into())
                } else {
                    Ok(())
                }
            })
            .unwrap_err();
        assert_eq!(error.message, "injected interruption");
        let active = fs::read(&receipt.path).unwrap();
        if boundary == receipt::PersistStage::StagedSynced {
            assert_eq!(active, old);
            assert_eq!(fs::metadata(&receipt.path).unwrap().ino(), old_inode);
        } else {
            assert_ne!(active, old, "published receipt did not advance real bytes");
            assert_ne!(fs::metadata(&receipt.path).unwrap().ino(), old_inode);
            let loaded = receipt::Receipt::load(&fixture.0.join(".git"), "api")
                .unwrap()
                .unwrap();
            assert_eq!(
                loaded.record["runtime"]["destructionPreparedItemIds"],
                json!(canonical_ids)
            );
        }
    }
}

#[cfg(unix)]
#[test]
fn atomic_config_publication_preserves_old_or_new_pathname_at_both_boundaries() {
    if run_isolated("atomic_config_publication_preserves_old_or_new_pathname_at_both_boundaries") {
        return;
    }
    for boundary in [
        transaction::ConfigPublishStage::StagedSynced,
        transaction::ConfigPublishStage::PublishedBeforeParentSync,
    ] {
        let fixture = Fixture::new();
        let path = fixture.0.join(".arashi/config.json");
        let before = fs::read(&path).unwrap();
        let after = transaction::serialize_without_repository(&before, "api").unwrap();
        let error = transaction::publish_with_stage(&path, &before, &after, |stage| {
            if stage == boundary {
                Err(std::io::Error::other("injected interruption").into())
            } else {
                Ok(())
            }
        })
        .unwrap_err();
        assert_eq!(error.message, "injected interruption");
        assert_eq!(
            fs::read(path).unwrap(),
            if boundary == transaction::ConfigPublishStage::StagedSynced {
                before
            } else {
                after
            }
        );
    }
}

#[cfg(unix)]
#[test]
fn delete_identity_keeps_removed_object_allocated() {
    use std::os::unix::fs::MetadataExt;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("owned");
    fs::write(&path, "owned").unwrap();
    let identity = ObjectIdentity::path(&path).unwrap();
    fs::remove_file(&path).unwrap();
    assert_eq!(identity.pin.file().metadata().unwrap().nlink(), 0);
    fs::write(&path, "replacement").unwrap();
    assert!(!identity.matches(&path));
}

#[cfg(unix)]
#[test]
fn prompt_prepare_is_lock_free() {
    if run_isolated("prompt_prepare_is_lock_free") {
        return;
    }
    let fixture = Fixture::new();
    let workspace = Workspace::discover(&fixture.0).unwrap();
    let path = workspace_lock::resolve_lock_path(&fixture.0).unwrap();
    let guard = workspace_lock::acquire(&path, workspace_lock::LockOptions::default()).unwrap();
    let bytes = fs::read(&path).unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let result =
            PreparedDelete::prepare(&workspace, "api").and_then(|prepared| prepared.preview());
        send.send(result).unwrap();
    });
    let result = receive.recv_timeout(std::time::Duration::from_secs(2));
    assert_eq!(fs::read(&path).unwrap(), bytes);
    guard.release().unwrap();
    worker.join().unwrap();
    assert!(result.is_ok(), "prepare waited for the mutation lock");
    result.unwrap().unwrap();
}

#[cfg(unix)]
#[test]
fn prompt_controller_freezes_acceptance_and_requires_force_for_loss() {
    if run_isolated("prompt_controller_freezes_acceptance_and_requires_force_for_loss") {
        return;
    }
    let fixture = Fixture::new();
    let workspace = Workspace::discover(&fixture.0).unwrap();
    let prepared = PreparedDelete::prepare(&workspace, "api").unwrap();
    assert!(!prepared.has_git_loss());
    prepared.preview().unwrap();
    fs::write(fixture.0.join("repos/api/caller"), "new loss\n").unwrap();
    assert!(prepared.execute(false).is_err());
    let prepared = PreparedDelete::prepare(&workspace, "api").unwrap();
    assert!(prepared.has_git_loss());
    assert_eq!(
        prepared.execute(false).unwrap_err().code,
        "DELETE_GIT_DATA_LOSS"
    );
    PreparedDelete::prepare(&workspace, "api")
        .unwrap()
        .execute(true)
        .unwrap();
    assert!(!fixture.0.join("repos/api").exists());
}

#[test]
fn nested_git_file_is_foreign_even_when_force_authorizes_dirty_loss() {
    if run_isolated("nested_git_file_is_foreign_even_when_force_authorizes_dirty_loss") {
        return;
    }
    let fixture = Fixture::new();
    let target = fixture.0.join("repos/api");
    let other = fixture.0.join("other");
    fs::create_dir(&other).unwrap();
    run(&other, &["init", "--initial-branch=main"]);
    fs::write(other.join("caller"), "foreign\n").unwrap();
    run(&other, &["add", "caller"]);
    run(&other, &["commit", "-m", "foreign"]);
    let nested = target.join("nested");
    run(
        &other,
        &["worktree", "add", "-b", "topic", nested.to_str().unwrap()],
    );
    assert!(DeletePlan::build(&Workspace::discover(&fixture.0).unwrap(), "api").is_err());
    assert_eq!(fs::read(nested.join("caller")).unwrap(), b"foreign\n");
}

#[cfg(unix)]
#[test]
fn instrumented_config_publication_refuses_unexpected_bytes() {
    if run_race_child("config-publish") {
        return;
    }
    if run_isolated("instrumented_config_publication_refuses_unexpected_bytes") {
        return;
    }
    let fixture = Fixture::new();
    // This deterministic seam verifies exact-byte refusal, not protection from an
    // uncooperative writer outside the workspace-lock protocol.
    let test = "delete::ownership_tests::instrumented_config_publication_refuses_unexpected_bytes";
    let (child, resume) = spawn_race(test, &fixture, "config-publish");
    let config = fixture.0.join(".arashi/config.json");
    fs::rename(&config, fixture.0.join("accepted-config")).unwrap();
    fs::write(&config, "foreign configuration\n").unwrap();
    finish_race(child, &resume);
    assert_eq!(fs::read(config).unwrap(), b"foreign configuration\n");
}

#[cfg(unix)]
#[test]
fn clone_quarantine_rename_preserves_a_concurrent_unowned_destination() {
    if run_race_child("clone-rename") {
        return;
    }
    if run_isolated("clone_quarantine_rename_preserves_a_concurrent_unowned_destination") {
        return;
    }
    let fixture = Fixture::new();
    let test = "delete::ownership_tests::clone_quarantine_rename_preserves_a_concurrent_unowned_destination";
    let (child, resume) = spawn_race(test, &fixture, "clone-rename");
    let receipt = receipt::Receipt::load(&fixture.0.join(".git"), "api")
        .unwrap()
        .unwrap();
    let quarantine = PathBuf::from(
        receipt.record["runtime"]["quarantinePath"]
            .as_str()
            .unwrap(),
    );
    drop(receipt);
    fs::create_dir(&quarantine).unwrap();
    finish_race(child, &resume);
    assert!(
        quarantine.is_dir(),
        "unowned destination was replaced and deleted"
    );
}

#[cfg(unix)]
#[test]
fn receipt_recovery_rejects_byte_identical_recreated_canonical_git_administration() {
    if run_race_child("receipt-published") {
        return;
    }
    if run_isolated(
        "receipt_recovery_rejects_byte_identical_recreated_canonical_git_administration",
    ) {
        return;
    }
    let fixture = Fixture::new();
    let target = fixture.0.join("repos/api");
    let original_git = target.join(".git");
    let accepted_git = fixture.0.join("accepted-api-git");
    let test = "delete::ownership_tests::receipt_recovery_rejects_byte_identical_recreated_canonical_git_administration";
    let (mut child, _) = spawn_race(test, &fixture, "receipt-published");
    let receipt = receipt::Receipt::load(&fixture.0.join(".git"), "api")
        .unwrap()
        .unwrap();
    let quarantine = PathBuf::from(
        receipt.record["runtime"]["quarantinePath"]
            .as_str()
            .unwrap(),
    );
    assert!(target.is_dir());
    assert!(!quarantine.exists());
    drop(receipt);
    child.kill().unwrap();
    child.wait().unwrap();

    fs::rename(&original_git, &accepted_git).unwrap();
    let copied = Command::new("cp")
        .args(["-R", "--"])
        .arg(&accepted_git)
        .arg(&original_git)
        .status()
        .unwrap();
    assert!(copied.success());
    assert_ne!(
        receipt::capture(&accepted_git).unwrap()["leaf"]["identity"],
        receipt::capture(&original_git).unwrap()["leaf"]["identity"]
    );

    let args = Args {
        command: "delete".to_owned(),
        positional: vec!["api".to_owned()],
        options: [("force".to_owned(), vec![]), ("json".to_owned(), vec![])]
            .into_iter()
            .collect(),
    };
    let error = delete(&Workspace::discover(&fixture.0).unwrap(), &args).unwrap_err();
    assert_eq!(error.code, "DELETE_RECEIPT_STALE");
    assert!(
        original_git.is_dir(),
        "foreign Git administration was relocated"
    );
    assert!(
        accepted_git.is_dir(),
        "accepted Git administration was changed"
    );
    assert!(
        !quarantine.exists(),
        "clone was quarantined before rejection"
    );
}

#[cfg(unix)]
#[test]
fn receipt_without_canonical_git_administration_identity_fails_closed() {
    if run_isolated("receipt_without_canonical_git_administration_identity_fails_closed") {
        return;
    }
    let fixture = Fixture::new();
    let mut receipt = receipt::Receipt::create(&fixture.plan()).unwrap();
    receipt.record["runtime"]["identities"]
        .as_object_mut()
        .unwrap()
        .remove("canonicalGitAdmin");
    receipt.persist().unwrap();
    drop(receipt);

    let error = match receipt::Receipt::load(&fixture.0.join(".git"), "api") {
        Err(error) => error,
        Ok(_) => panic!("ambiguous receipt unexpectedly loaded"),
    };
    assert_eq!(error.code, "DELETE_RECEIPT_INVALID");
    assert!(fixture.0.join("repos/api/.git").is_dir());
}

#[cfg(unix)]
#[test]
fn clone_retention_preserves_a_concurrent_unowned_replacement() {
    if run_race_child("clone-cleanup") {
        return;
    }
    if run_isolated("clone_retention_preserves_a_concurrent_unowned_replacement") {
        return;
    }
    let fixture = Fixture::new();
    let test =
        "delete::ownership_tests::clone_retention_preserves_a_concurrent_unowned_replacement";
    let (child, resume) = spawn_race(test, &fixture, "clone-cleanup");
    let receipt = receipt::Receipt::load(&fixture.0.join(".git"), "api")
        .unwrap()
        .unwrap();
    let quarantine = PathBuf::from(
        receipt.record["runtime"]["quarantinePath"]
            .as_str()
            .unwrap(),
    );
    drop(receipt);
    let accepted = fixture.0.join("accepted-quarantine");
    fs::rename(&quarantine, &accepted).unwrap();
    fs::create_dir(&quarantine).unwrap();
    fs::write(quarantine.join("foreign"), "preserve\n").unwrap();
    finish_race(child, &resume);
    assert_eq!(fs::read(quarantine.join("foreign")).unwrap(), b"preserve\n");
    assert!(accepted.join("README").is_file());
}

#[cfg(unix)]
#[test]
fn final_directory_retention_preserves_a_concurrent_empty_replacement() {
    if run_race_child("quarantine-final-retain") {
        return;
    }
    if run_isolated("final_directory_retention_preserves_a_concurrent_empty_replacement") {
        return;
    }
    let fixture = Fixture::new();
    let test = "delete::ownership_tests::final_directory_retention_preserves_a_concurrent_empty_replacement";
    let (child, resume) = spawn_race(test, &fixture, "quarantine-final-retain");
    let receipt = receipt::Receipt::load(&fixture.0.join(".git"), "api")
        .unwrap()
        .unwrap();
    let quarantine = PathBuf::from(
        receipt.record["runtime"]["quarantinePath"]
            .as_str()
            .unwrap(),
    );
    drop(receipt);
    let accepted = fixture.0.join("accepted-empty-quarantine");
    fs::rename(&quarantine, &accepted).unwrap();
    fs::create_dir(&quarantine).unwrap();
    finish_race(child, &resume);
    assert!(quarantine.is_dir(), "foreign empty replacement was deleted");
    assert!(accepted.is_dir(), "accepted generation was not preserved");
}

#[cfg(unix)]
#[test]
fn retained_clone_quarantine_resumes_after_process_loss() {
    if run_race_child("clone-after-destruction") {
        return;
    }
    if run_isolated("retained_clone_quarantine_resumes_after_process_loss") {
        return;
    }
    let fixture = Fixture::new();
    let test = "delete::ownership_tests::retained_clone_quarantine_resumes_after_process_loss";
    let (mut child, _) = spawn_race(test, &fixture, "clone-after-destruction");
    let receipt = receipt::Receipt::load(&fixture.0.join(".git"), "api")
        .unwrap()
        .unwrap();
    let quarantine = PathBuf::from(
        receipt.record["runtime"]["quarantinePath"]
            .as_str()
            .unwrap(),
    );
    assert!(quarantine.join("README").is_file());
    drop(receipt);
    child.kill().unwrap();
    child.wait().unwrap();

    let args = Args {
        command: "delete".to_owned(),
        positional: vec!["api".to_owned()],
        options: [("force".to_owned(), vec![]), ("json".to_owned(), vec![])]
            .into_iter()
            .collect(),
    };
    delete(&Workspace::discover(&fixture.0).unwrap(), &args).unwrap();
    assert!(quarantine.join("README").is_file());
    assert!(!fixture.0.join("repos/api").exists());
}

#[cfg(unix)]
#[test]
fn terminal_residue_ledger_resumes_after_process_loss_before_receipt_retirement() {
    if run_race_child("terminal-residues-persisted") {
        return;
    }
    if run_isolated("terminal_residue_ledger_resumes_after_process_loss_before_receipt_retirement")
    {
        return;
    }
    let fixture = Fixture::new();
    let plan = fixture.plan();
    let test = "delete::ownership_tests::terminal_residue_ledger_resumes_after_process_loss_before_receipt_retirement";
    let (mut child, _) = spawn_race(test, &fixture, "terminal-residues-persisted");
    let receipt = receipt::Receipt::load(&fixture.0.join(".git"), "api")
        .unwrap()
        .unwrap();
    assert_eq!(receipt.record["warnings"], json!(plan.warnings));
    assert_eq!(
        receipt::plan_hash(&receipt.record).unwrap(),
        receipt.record["planId"].as_str().unwrap()
    );
    assert!(
        !receipt.record["terminalResidues"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    drop(receipt);
    child.kill().unwrap();
    child.wait().unwrap();

    let args = Args {
        command: "delete".to_owned(),
        positional: vec!["api".to_owned()],
        options: [("force".to_owned(), vec![]), ("json".to_owned(), vec![])]
            .into_iter()
            .collect(),
    };
    delete(&Workspace::discover(&fixture.0).unwrap(), &args).unwrap();
    assert!(
        receipt::Receipt::load(&fixture.0.join(".git"), "api")
            .unwrap()
            .is_none()
    );
}

#[cfg(unix)]
#[test]
fn prepared_linked_checkout_retention_resumes_after_process_loss() {
    if run_race_child("linked-after-destruction") {
        return;
    }
    if run_isolated("prepared_linked_checkout_retention_resumes_after_process_loss") {
        return;
    }
    let fixture = Fixture::new();
    let target = fixture.0.join("repos/api");
    let linked = fixture.0.join("linked-partial");
    run(
        &target,
        &[
            "worktree",
            "add",
            "-b",
            "partial-topic",
            linked.to_str().unwrap(),
        ],
    );
    let test =
        "delete::ownership_tests::prepared_linked_checkout_retention_resumes_after_process_loss";
    let (mut child, _) = spawn_race(test, &fixture, "linked-after-destruction");
    let receipt = receipt::Receipt::load(&fixture.0.join(".git"), "api")
        .unwrap()
        .unwrap();
    let quarantine = PathBuf::from(
        receipt.record["runtime"]["worktreeQuarantines"][0]["quarantinePath"]
            .as_str()
            .unwrap(),
    );
    assert!(quarantine.join("README").is_file());
    drop(receipt);
    child.kill().unwrap();
    child.wait().unwrap();

    let args = Args {
        command: "delete".to_owned(),
        positional: vec!["api".to_owned()],
        options: [("force".to_owned(), vec![]), ("json".to_owned(), vec![])]
            .into_iter()
            .collect(),
    };
    delete(&Workspace::discover(&fixture.0).unwrap(), &args).unwrap();
    assert!(!linked.exists());
    assert!(!target.exists());
    assert!(quarantine.join("README").is_file());
}

#[cfg(unix)]
#[test]
fn retained_quarantine_preserves_accepted_contents() {
    if run_isolated("retained_quarantine_preserves_accepted_contents") {
        return;
    }
    let fixture = Fixture::new();
    let receipt = receipt::Receipt::create(&fixture.plan()).unwrap();
    let quarantine = PathBuf::from(
        receipt.record["runtime"]["quarantinePath"]
            .as_str()
            .unwrap(),
    );
    drop(receipt);
    let args = Args {
        command: "delete".to_owned(),
        positional: vec!["api".to_owned()],
        options: [("force".to_owned(), vec![]), ("json".to_owned(), vec![])]
            .into_iter()
            .collect(),
    };
    delete(&Workspace::discover(&fixture.0).unwrap(), &args).unwrap();
    assert_eq!(fs::read(quarantine.join("README")).unwrap(), b"tracked\n");
}

#[cfg(unix)]
#[test]
fn linked_worktree_removal_preserves_a_concurrent_unowned_replacement() {
    if run_race_child("linked-remove") {
        return;
    }
    if run_isolated("linked_worktree_removal_preserves_a_concurrent_unowned_replacement") {
        return;
    }
    let fixture = Fixture::new();
    let target = fixture.0.join("repos/api");
    let linked = fixture.0.join("linked");
    run(
        &target,
        &["worktree", "add", "-b", "topic", linked.to_str().unwrap()],
    );
    let marker = fs::read(linked.join(".git")).unwrap();
    let test = "delete::ownership_tests::linked_worktree_removal_preserves_a_concurrent_unowned_replacement";
    let (child, resume) = spawn_race(test, &fixture, "linked-remove");
    let accepted = fixture.0.join("accepted-linked");
    fs::rename(&linked, &accepted).unwrap();
    fs::create_dir(&linked).unwrap();
    fs::write(linked.join(".git"), marker).unwrap();
    fs::write(linked.join("foreign"), "preserve\n").unwrap();
    finish_race(child, &resume);
    assert_eq!(fs::read(linked.join("foreign")).unwrap(), b"preserve\n");
    assert!(accepted.join("README").is_file());
}

#[cfg(unix)]
#[test]
fn linked_worktree_removal_ignores_a_post_quarantine_canonical_replacement() {
    if run_race_child("linked-remove-after-quarantine") {
        return;
    }
    if run_isolated("linked_worktree_removal_ignores_a_post_quarantine_canonical_replacement") {
        return;
    }
    let fixture = Fixture::new();
    let target = fixture.0.join("repos/api");
    let linked = fixture.0.join("linked");
    run(
        &target,
        &["worktree", "add", "-b", "topic", linked.to_str().unwrap()],
    );
    let marker = fs::read(linked.join(".git")).unwrap();
    let test = "delete::ownership_tests::linked_worktree_removal_ignores_a_post_quarantine_canonical_replacement";
    let (child, resume) = spawn_race(test, &fixture, "linked-remove-after-quarantine");
    assert!(!linked.exists(), "accepted worktree was not quarantined");
    fs::create_dir(&linked).unwrap();
    fs::write(linked.join(".git"), marker).unwrap();
    fs::write(linked.join("foreign"), "preserve\n").unwrap();
    finish_race(child, &resume);
    assert_eq!(fs::read(linked.join("foreign")).unwrap(), b"preserve\n");
}

#[cfg(unix)]
#[test]
fn linked_worktree_delete_never_repairs_a_recreated_administration_identity() {
    if run_race_child("wrapper-admin-swap") {
        return;
    }
    if run_isolated("linked_worktree_delete_never_repairs_a_recreated_administration_identity") {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let target = fixture.0.join("repos/api");
    let linked = fixture.0.join("linked");
    run(
        &target,
        &[
            "worktree",
            "add",
            "-b",
            "admin-swap",
            linked.to_str().unwrap(),
        ],
    );
    fs::write(linked.join("caller"), "authorized loss\n").unwrap();
    let marker = fs::read_to_string(linked.join(".git")).unwrap();
    let admin = PathBuf::from(marker.trim().strip_prefix("gitdir: ").unwrap());
    let wrapper = fixture.0.join("wrapper");
    fs::create_dir(&wrapper).unwrap();
    let real_git = String::from_utf8(Command::new("which").arg("git").output().unwrap().stdout)
        .unwrap()
        .trim()
        .to_owned();
    let swapped = fixture.0.join("admin-swapped");
    let mutated = fixture.0.join("foreign-admin-mutated");
    let script = format!(
        "#!/bin/sh\nif [ \"$1\" = worktree ] && [ \"$2\" = repair ] && [ ! -e {swapped:?} ]; then\n  mv {admin:?} {accepted:?}\n  cp -R {accepted:?} {admin:?}\n  : > {swapped:?}\n  before=$(cat {gitdir:?})\n  {real_git:?} \"$@\"\n  status=$?\n  after=$(cat {gitdir:?})\n  [ \"$before\" = \"$after\" ] || : > {mutated:?}\n  exit \"$status\"\nfi\nexec {real_git:?} \"$@\"\n",
        accepted = PathBuf::from(format!("{}.accepted", admin.display())),
        gitdir = admin.join("gitdir"),
    );
    let wrapper_git = wrapper.join("git");
    fs::write(&wrapper_git, script).unwrap();
    fs::set_permissions(&wrapper_git, fs::Permissions::from_mode(0o755)).unwrap();
    let test = "delete::ownership_tests::linked_worktree_delete_never_repairs_a_recreated_administration_identity";
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture"])
        .env(ISOLATED_TEST, test)
        .env(RACE_POINT, "wrapper-admin-swap")
        .env("ARASHI_DELETE_RACE_WORKSPACE", &fixture.0)
        .env(
            "PATH",
            format!("{}:{}", wrapper.display(), std::env::var("PATH").unwrap()),
        )
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(
        !mutated.exists(),
        "Git repair modified the recreated foreign administration directory"
    );
    assert!(
        !target.exists(),
        "delete did not complete without Git repair"
    );
}

#[cfg(unix)]
#[test]
fn linked_prepared_swap_preserves_foreign_and_owned_generations() {
    if run_race_child("linked-prepared") {
        return;
    }
    if run_isolated("linked_prepared_swap_preserves_foreign_and_owned_generations") {
        return;
    }
    let fixture = Fixture::new();
    let target = fixture.0.join("repos/api");
    let linked = fixture.0.join("linked");
    run(
        &target,
        &["worktree", "add", "-b", "topic", linked.to_str().unwrap()],
    );
    let test =
        "delete::ownership_tests::linked_prepared_swap_preserves_foreign_and_owned_generations";
    let (child, resume) = spawn_race(test, &fixture, "linked-prepared");
    let receipt = receipt::Receipt::load(&fixture.0.join(".git"), "api")
        .unwrap()
        .unwrap();
    let quarantine = PathBuf::from(
        receipt.record["runtime"]["worktreeQuarantines"][0]["quarantinePath"]
            .as_str()
            .unwrap(),
    );
    drop(receipt);
    let marker = fs::read(quarantine.join(".git")).unwrap();
    let expected_identity = receipt::capture(&quarantine).unwrap()["leaf"]["identity"].clone();
    let owned = fixture.0.join("accepted-linked-quarantine");
    fs::rename(&quarantine, &owned).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(10));
    fs::create_dir(&quarantine).unwrap();
    fs::write(quarantine.join(".git"), marker).unwrap();
    fs::write(quarantine.join("foreign"), "preserve\n").unwrap();
    assert_ne!(
        receipt::capture(&quarantine).unwrap()["leaf"]["identity"],
        expected_identity,
        "the replacement fixture must have a distinct incarnation"
    );

    fs::write(&resume, "resume\n").unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "race child harness failed");
    assert_eq!(fs::read(quarantine.join("foreign")).unwrap(), b"preserve\n");
    assert!(owned.join("README").is_file());
}

#[cfg(unix)]
#[test]
fn linked_prepared_admin_swap_preserves_foreign_and_owned_generations() {
    if run_race_child("linked-prepared") {
        return;
    }
    if run_isolated("linked_prepared_admin_swap_preserves_foreign_and_owned_generations") {
        return;
    }
    let fixture = Fixture::new();
    let target = fixture.0.join("repos/api");
    let linked = fixture.0.join("linked");
    run(
        &target,
        &["worktree", "add", "-b", "topic", linked.to_str().unwrap()],
    );
    let test = "delete::ownership_tests::linked_prepared_admin_swap_preserves_foreign_and_owned_generations";
    let (child, resume) = spawn_race(test, &fixture, "linked-prepared");
    let receipt = receipt::Receipt::load(&fixture.0.join(".git"), "api")
        .unwrap()
        .unwrap();
    let admin = PathBuf::from(
        receipt.record["runtime"]["topology"]["linkedWorktrees"][0]["metadataPath"]
            .as_str()
            .unwrap(),
    );
    drop(receipt);
    let owned = fixture.0.join("accepted-linked-admin");
    fs::rename(&admin, &owned).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(10));
    fs::create_dir(&admin).unwrap();
    fs::write(admin.join("foreign"), "preserve\n").unwrap();

    fs::write(&resume, "resume\n").unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "race child harness failed");
    assert_eq!(fs::read(admin.join("foreign")).unwrap(), b"preserve\n");
    assert!(owned.join("gitdir").is_file());
}

#[test]
fn prepared_linked_quarantine_registration_resumes_after_process_loss() {
    if run_race_child("linked-prepared") {
        return;
    }
    if run_isolated("prepared_linked_quarantine_registration_resumes_after_process_loss") {
        return;
    }
    let fixture = Fixture::new();
    let target = fixture.0.join("repos/api");
    let linked = fixture.0.join("linked");
    run(
        &target,
        &["worktree", "add", "-b", "topic", linked.to_str().unwrap()],
    );
    fs::write(linked.join("caller"), "authorized loss\n").unwrap();
    let test = "delete::ownership_tests::prepared_linked_quarantine_registration_resumes_after_process_loss";
    let (mut child, _) = spawn_race(test, &fixture, "linked-prepared");
    let receipt = receipt::Receipt::load(&fixture.0.join(".git"), "api")
        .unwrap()
        .unwrap();
    let quarantine = PathBuf::from(
        receipt.record["runtime"]["worktreeQuarantines"][0]["quarantinePath"]
            .as_str()
            .unwrap(),
    );
    assert!(quarantine.is_dir());
    assert!(!linked.exists());
    drop(receipt);
    child.kill().unwrap();
    child.wait().unwrap();

    let args = Args {
        command: "delete".to_owned(),
        positional: vec!["api".to_owned()],
        options: [("force".to_owned(), vec![]), ("json".to_owned(), vec![])]
            .into_iter()
            .collect(),
    };
    delete(&Workspace::discover(&fixture.0).unwrap(), &args).unwrap();
    assert!(quarantine.join("README").is_file());
    assert!(!target.exists());
}

#[test]
fn prepared_linked_checkout_removed_before_admin_resumes_after_process_loss() {
    if run_isolated("prepared_linked_checkout_removed_before_admin_resumes_after_process_loss") {
        return;
    }
    let fixture = Fixture::new();
    let target = fixture.0.join("repos/api");
    let linked = fixture.0.join("linked");
    run(
        &target,
        &["worktree", "add", "-b", "topic", linked.to_str().unwrap()],
    );
    let plan = fixture.plan();
    let mut receipt = receipt::Receipt::create(&plan).unwrap();
    let provenance_id = receipt.record["identities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["kind"] == "resume-receipt")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    receipt
        .complete(std::slice::from_ref(&provenance_id))
        .unwrap();
    receipt.finish(0).unwrap();
    let item = receipt.record["identities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["kind"] == "linked-worktree")
        .unwrap()
        .clone();
    let id = item["id"].as_str().unwrap().to_owned();
    let quarantine = PathBuf::from(
        receipt.record["runtime"]["worktreeQuarantines"][0]["quarantinePath"]
            .as_str()
            .unwrap(),
    );
    fs::rename(&linked, &quarantine).unwrap();
    run(
        &target,
        &["worktree", "repair", "--", quarantine.to_str().unwrap()],
    );
    receipt.prepare(std::slice::from_ref(&id)).unwrap();
    fs::remove_dir_all(&quarantine).unwrap();
    drop(receipt);

    let args = Args {
        command: "delete".to_owned(),
        positional: vec!["api".to_owned()],
        options: [("force".to_owned(), vec![]), ("json".to_owned(), vec![])]
            .into_iter()
            .collect(),
    };
    delete(&Workspace::discover(&fixture.0).unwrap(), &args).unwrap();
    assert!(!target.exists());
}

#[test]
fn dirty_primary_and_prepared_linked_warning_order_resumes() {
    if run_race_child("linked-prepared") {
        return;
    }
    if run_isolated("dirty_primary_and_prepared_linked_warning_order_resumes") {
        return;
    }
    let fixture = Fixture::new();
    let target = fixture.0.join("repos/api");
    let linked = fixture.0.join("zlinked");
    run(
        &target,
        &["worktree", "add", "-b", "topic", linked.to_str().unwrap()],
    );
    fs::write(target.join("primary-dirty"), "authorized loss\n").unwrap();
    fs::write(linked.join("linked-dirty"), "authorized loss\n").unwrap();
    let test = "delete::ownership_tests::dirty_primary_and_prepared_linked_warning_order_resumes";
    let (mut child, _) = spawn_race(test, &fixture, "linked-prepared");
    child.kill().unwrap();
    child.wait().unwrap();

    let args = Args {
        command: "delete".to_owned(),
        positional: vec!["api".to_owned()],
        options: [("force".to_owned(), vec![]), ("json".to_owned(), vec![])]
            .into_iter()
            .collect(),
    };
    delete(&Workspace::discover(&fixture.0).unwrap(), &args).unwrap();
    assert!(!target.exists());
}

#[test]
fn ordinary_delete_interrupted_quarantine_is_not_abandoned_on_retry() {
    if let Some(root) = std::env::var_os(INTERRUPTED_WORKSPACE) {
        let root = PathBuf::from(root);
        let plan = DeletePlan::build(&Workspace::discover(&root).unwrap(), "api").unwrap();
        let receipt = receipt::Receipt::create(&plan).unwrap();
        let quarantine = PathBuf::from(
            receipt.record["runtime"]["quarantinePath"]
                .as_str()
                .unwrap(),
        );
        fs::rename(&plan.repository_path, quarantine).unwrap();
        return;
    }
    if run_isolated("ordinary_delete_interrupted_quarantine_is_not_abandoned_on_retry") {
        return;
    }
    let fixture = Fixture::new();
    let plan = fixture.plan();
    let test =
        "delete::ownership_tests::ordinary_delete_interrupted_quarantine_is_not_abandoned_on_retry";
    let interrupted = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture"])
        .env(ISOLATED_TEST, test)
        .env(INTERRUPTED_WORKSPACE, &fixture.0)
        .output()
        .unwrap();
    assert!(
        interrupted.status.success(),
        "interrupted process failed:\n{}\n{}",
        String::from_utf8_lossy(&interrupted.stdout),
        String::from_utf8_lossy(&interrupted.stderr)
    );
    let receipt = receipt::Receipt::load(&fixture.0.join(".git"), "api")
        .unwrap()
        .unwrap();
    let quarantine = PathBuf::from(
        receipt.record["runtime"]["quarantinePath"]
            .as_str()
            .unwrap(),
    );
    assert!(quarantine.is_dir());
    drop(receipt);
    let args = Args {
        command: "delete".to_owned(),
        positional: vec!["api".to_owned()],
        options: [("force".to_owned(), vec![]), ("json".to_owned(), vec![])]
            .into_iter()
            .collect(),
    };
    delete(&Workspace::discover(&fixture.0).unwrap(), &args).unwrap();
    assert!(
        quarantine.exists(),
        "successful retry must retain invocation-owned clone contents"
    );
    assert!(!plan.repository_path.exists());
    assert_eq!(fs::read(&plan.config_path).unwrap(), plan.config_after);
}

#[cfg(unix)]
#[test]
fn ordinary_delete_ignores_and_preserves_a_historical_quarantine_generation() {
    if run_isolated("ordinary_delete_ignores_and_preserves_a_historical_quarantine_generation") {
        return;
    }
    let fixture = Fixture::new();
    let target = fixture.0.join("repos/api");
    let conflict = target
        .parent()
        .unwrap()
        .join(format!("{}999999", quarantine_prefix("api")));
    fs::create_dir(&conflict).unwrap();
    fs::write(conflict.join("foreign"), "preserve\n").unwrap();
    fixture.plan().execute().unwrap();
    assert!(!target.exists());
    assert_eq!(fs::read(conflict.join("foreign")).unwrap(), b"preserve\n");
}

#[cfg(unix)]
#[test]
fn legacy_quarantine_paths_use_the_full_domain_separated_plan_identity() {
    if run_isolated("legacy_quarantine_paths_use_the_full_domain_separated_plan_identity") {
        return;
    }
    let fixture = Fixture::new();
    let target = fixture.0.join("repos/api");
    let linked = fixture.0.join("linked");
    run(
        &target,
        &["worktree", "add", "-b", "topic", linked.to_str().unwrap()],
    );
    let plan = fixture.plan();
    let receipt = receipt::Receipt::create(&plan).unwrap();
    let mut legacy = receipt.record.clone();
    let plan_id = legacy["planId"].as_str().unwrap().to_owned();
    legacy.as_object_mut().unwrap().remove("terminalResidues");
    legacy["runtime"]
        .as_object_mut()
        .unwrap()
        .remove("quarantinePath");
    legacy["runtime"]
        .as_object_mut()
        .unwrap()
        .remove("worktreeQuarantines");
    legacy["runtime"]
        .as_object_mut()
        .unwrap()
        .remove("destructionPreparedItemIds");
    drop(receipt);
    fs::write(
        receipt::path(&fixture.0.join(".git"), "api"),
        format!("{}\n", serde_json::to_string_pretty(&legacy).unwrap()),
    )
    .unwrap();

    let receipt_path = receipt::path(&fixture.0.join(".git"), "api");
    let legacy_bytes = fs::read(&receipt_path).unwrap();
    let legacy_identity = receipt::capture(&receipt_path).unwrap()["leaf"]["identity"].clone();

    let upgraded = receipt::Receipt::load(&fixture.0.join(".git"), "api")
        .unwrap()
        .unwrap();
    assert_eq!(
        fs::read(&receipt_path).unwrap(),
        legacy_bytes,
        "loading a legacy receipt for preview must not persist its upgrade"
    );
    let suffix = receipt::hash(format!("arashi-delete-quarantine-v1\0{plan_id}").as_bytes());
    assert_eq!(suffix.len(), 64);
    assert_eq!(
        upgraded.record["runtime"]["quarantinePath"],
        json!(
            target
                .parent()
                .unwrap()
                .join(format!("{}{suffix}", quarantine_prefix("api")))
        )
    );
    assert_eq!(
        upgraded.record["runtime"]["worktreeQuarantines"][0]["quarantinePath"],
        json!(linked.parent().unwrap().join(format!(
            ".arashi-delete-worktree-{}-{suffix}",
            receipt::hash(linked.to_str().unwrap().as_bytes())
        )))
    );
    assert_eq!(upgraded.record["terminalResidues"], json!([]));
    drop(upgraded);

    let args = Args {
        command: "delete".to_owned(),
        positional: vec!["api".to_owned()],
        options: [("dry-run".to_owned(), vec![]), ("json".to_owned(), vec![])]
            .into_iter()
            .collect(),
    };
    delete(&Workspace::discover(&fixture.0).unwrap(), &args).unwrap();
    assert_eq!(fs::read(&receipt_path).unwrap(), legacy_bytes);
    assert_eq!(
        receipt::capture(&receipt_path).unwrap()["leaf"]["identity"],
        legacy_identity,
        "legacy receipt preview must preserve the receipt incarnation"
    );
}

#[cfg(unix)]
#[test]
fn terminal_residue_retry_rejects_a_recreated_destination_identity() {
    if run_race_child("terminal-residues-persisted") {
        return;
    }
    if run_isolated("terminal_residue_retry_rejects_a_recreated_destination_identity") {
        return;
    }
    let fixture = Fixture::new();
    let plan = fixture.plan();
    let test =
        "delete::ownership_tests::terminal_residue_retry_rejects_a_recreated_destination_identity";
    let (mut child, _) = spawn_race(test, &fixture, "terminal-residues-persisted");

    let receipt = receipt::Receipt::load(&fixture.0.join(".git"), "api")
        .unwrap()
        .unwrap();
    let destination = PathBuf::from(
        receipt.record["terminalResidues"][0]["destination"]
            .as_str()
            .unwrap(),
    );
    drop(receipt);
    child.kill().unwrap();
    child.wait().unwrap();
    let mut owned_name = destination.as_os_str().to_os_string();
    owned_name.push(".owned");
    let owned = PathBuf::from(owned_name);
    fs::rename(&destination, &owned).unwrap();
    fs::create_dir(&destination).unwrap();
    fs::write(destination.join("FOREIGN"), "preserve\n").unwrap();

    let args = Args {
        command: "delete".to_owned(),
        positional: vec!["api".to_owned()],
        options: [("force".to_owned(), vec![]), ("json".to_owned(), vec![])]
            .into_iter()
            .collect(),
    };
    assert!(delete(&Workspace::discover(&fixture.0).unwrap(), &args).is_err());
    assert_eq!(
        fs::read(destination.join("FOREIGN")).unwrap(),
        b"preserve\n"
    );
    assert!(owned.exists());
    assert!(!plan.repository_path.exists());
}

#[cfg(unix)]
#[test]
fn terminal_residue_schema_rejects_a_forged_destination_mapping() {
    if run_isolated("terminal_residue_schema_rejects_a_forged_destination_mapping") {
        return;
    }
    let fixture = Fixture::new();
    let plan = fixture.plan();
    let receipt = receipt::Receipt::create(&plan).unwrap();
    let receipt_path = receipt.path.clone();
    let mut record = receipt.record.clone();
    let clone_item = record["identities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["kind"] == "canonical-clone")
        .unwrap()
        .clone();
    record["completedItemIds"] = json!(
        record["identities"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["kind"] != "preserved-global-hook")
            .map(|item| item["id"].clone())
            .collect::<Vec<_>>()
    );
    record["completedPhases"] = json!([
        "provenance",
        "worktrees",
        "metadata",
        "canonical-clone",
        "workspace-hooks",
        "configuration",
        "verification"
    ]);
    record["remainingPhases"] = json!([]);
    let canonical_destination = record["runtime"]["quarantinePath"].clone();
    record["terminalResidues"] = json!([{
        "itemId": clone_item["id"],
        "source": clone_item["path"],
        "destination": canonical_destination,
    }]);
    drop(receipt);
    fs::write(
        &receipt_path,
        format!("{}\n", serde_json::to_string_pretty(&record).unwrap()),
    )
    .unwrap();
    assert!(
        receipt::Receipt::load(&fixture.0.join(".git"), "api")
            .unwrap()
            .is_some()
    );

    record["terminalResidues"][0]["destination"] = json!(fixture.0.join("forged"));
    fs::write(
        &receipt_path,
        format!("{}\n", serde_json::to_string_pretty(&record).unwrap()),
    )
    .unwrap();
    assert!(receipt::Receipt::load(&fixture.0.join(".git"), "api").is_err());
}

#[cfg(unix)]
#[test]
fn modern_receipt_rejects_non_bijective_or_forged_quarantine_mappings() {
    if run_isolated("modern_receipt_rejects_non_bijective_or_forged_quarantine_mappings") {
        return;
    }
    for mutation in [
        "wrong-clone",
        "wrong-source",
        "duplicate-source",
        "duplicate-destination",
    ] {
        let fixture = Fixture::new();
        let target = fixture.0.join("repos/api");
        let linked_a = fixture.0.join("linked-a");
        let linked_b = fixture.0.join("linked-b");
        run(
            &target,
            &[
                "worktree",
                "add",
                "-b",
                "topic-a",
                linked_a.to_str().unwrap(),
            ],
        );
        run(
            &target,
            &[
                "worktree",
                "add",
                "-b",
                "topic-b",
                linked_b.to_str().unwrap(),
            ],
        );
        let receipt = receipt::Receipt::create(&fixture.plan()).unwrap();
        let mut record = receipt.record.clone();
        drop(receipt);
        match mutation {
            "wrong-clone" => {
                record["runtime"]["quarantinePath"] = json!(fixture.0.join("forged"));
            }
            "wrong-source" => {
                record["runtime"]["worktreeQuarantines"][0]["path"] =
                    json!(fixture.0.join("foreign"));
            }
            "duplicate-source" => {
                record["runtime"]["worktreeQuarantines"][1]["path"] =
                    record["runtime"]["worktreeQuarantines"][0]["path"].clone();
            }
            "duplicate-destination" => {
                record["runtime"]["worktreeQuarantines"][1]["quarantinePath"] =
                    record["runtime"]["worktreeQuarantines"][0]["quarantinePath"].clone();
            }
            _ => unreachable!(),
        }
        fs::write(
            receipt::path(&fixture.0.join(".git"), "api"),
            format!("{}\n", serde_json::to_string_pretty(&record).unwrap()),
        )
        .unwrap();
        let loaded =
            std::panic::catch_unwind(|| receipt::Receipt::load(&fixture.0.join(".git"), "api"));
        assert!(loaded.is_ok(), "{mutation}: malformed receipt panicked");
        assert!(
            loaded.unwrap().is_err(),
            "{mutation}: malformed quarantine provenance was accepted"
        );
    }
}

#[cfg(unix)]
#[test]
fn canonical_retention_crash_resumes_from_durable_write_ahead() {
    if run_race_child("clone-after-destruction") {
        return;
    }
    if run_isolated("canonical_retention_crash_resumes_from_durable_write_ahead") {
        return;
    }
    let fixture = Fixture::new();
    let test =
        "delete::ownership_tests::canonical_retention_crash_resumes_from_durable_write_ahead";
    let (mut child, _resume) = spawn_race(test, &fixture, "clone-after-destruction");
    let target = fixture.0.join("repos/api");
    assert!(!target.exists());
    child.kill().unwrap();
    child.wait().unwrap();
    let args = Args {
        command: "delete".to_owned(),
        positional: vec!["api".to_owned()],
        options: [("force".to_owned(), vec![]), ("json".to_owned(), vec![])]
            .into_iter()
            .collect(),
    };
    delete(&Workspace::discover(&fixture.0).unwrap(), &args).unwrap();
    assert!(!target.exists());
}

#[cfg(unix)]
#[test]
fn linked_retention_crash_resumes_from_durable_write_ahead() {
    if run_race_child("linked-after-destruction") {
        return;
    }
    if run_isolated("linked_retention_crash_resumes_from_durable_write_ahead") {
        return;
    }
    let fixture = Fixture::new();
    let target = fixture.0.join("repos/api");
    let linked = fixture.0.join("linked");
    run(
        &target,
        &["worktree", "add", "-b", "topic", linked.to_str().unwrap()],
    );
    let test = "delete::ownership_tests::linked_retention_crash_resumes_from_durable_write_ahead";
    let (mut child, _resume) = spawn_race(test, &fixture, "linked-after-destruction");
    assert!(!linked.exists());
    assert!(target.exists());
    child.kill().unwrap();
    child.wait().unwrap();
    let args = Args {
        command: "delete".to_owned(),
        positional: vec!["api".to_owned()],
        options: [("force".to_owned(), vec![]), ("json".to_owned(), vec![])]
            .into_iter()
            .collect(),
    };
    delete(&Workspace::discover(&fixture.0).unwrap(), &args).unwrap();
    assert!(!linked.exists());
    assert!(!target.exists());
}

#[cfg(unix)]
#[test]
fn ordinary_delete_receipt_survives_publication_failure_and_resumes() {
    if run_isolated("ordinary_delete_receipt_survives_publication_failure_and_resumes") {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let plan = fixture.plan();
    let config_dir = fixture.0.join(".arashi");
    fs::set_permissions(&config_dir, fs::Permissions::from_mode(0o555)).unwrap();
    let error = plan.execute().unwrap_err();
    fs::set_permissions(&config_dir, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(
        !plan.repository_path.exists(),
        "source deletes clone before config publication"
    );
    assert_eq!(fs::read(&plan.config_path).unwrap(), plan.config_before);
    assert_eq!(error.code, "DELETE_PARTIAL_FAILURE");
    assert!(plan.receipts_path.is_dir());
    let foreign = plan.receipts_path.join("foreign-note");
    fs::write(&foreign, "preserve\n").unwrap();
    let args = Args {
        command: "delete".to_owned(),
        positional: vec!["api".to_owned()],
        options: [("force".to_owned(), vec![]), ("json".to_owned(), vec![])]
            .into_iter()
            .collect(),
    };
    delete(&Workspace::discover(&fixture.0).unwrap(), &args).unwrap();
    assert_eq!(fs::read(&plan.config_path).unwrap(), plan.config_after);
    assert_eq!(fs::read(&foreign).unwrap(), b"preserve\n");
    assert_eq!(fs::read_dir(&plan.receipts_path).unwrap().count(), 2);
}

#[cfg(unix)]
#[test]
fn ordinary_delete_accepts_valid_empty_source_receipt_storage() {
    if run_isolated("ordinary_delete_accepts_valid_empty_source_receipt_storage") {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let receipts = fixture.0.join(".git/.arashi-delete-receipts");
    fs::create_dir(&receipts).unwrap();
    fs::set_permissions(&receipts, fs::Permissions::from_mode(0o700)).unwrap();
    fixture.plan().execute().unwrap();
    assert!(receipts.is_dir());
    assert_eq!(fs::read_dir(&receipts).unwrap().count(), 1);
}

#[test]
fn ordinary_attached_dirty_worktrees_are_selected_not_their_siblings() {
    if run_isolated("ordinary_attached_dirty_worktrees_are_selected_not_their_siblings") {
        return;
    }
    let fixture = Fixture::new();
    let target = fixture.0.join("repos/api");
    let linked = fixture.0.join("linked");
    run(
        &target,
        &["worktree", "add", "-b", "topic", linked.to_str().unwrap()],
    );
    fs::write(linked.join("caller"), "authorized loss\n").unwrap();
    fs::write(fixture.0.join("sibling"), "preserve\n").unwrap();
    let plan = fixture.plan();
    assert!(
        plan.plan_json()["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "linked-worktree")
    );
    plan.validate().unwrap();
    fs::write(linked.join("caller"), "changed loss\n").unwrap();
    assert!(plan.validate().is_err());
    #[cfg(unix)]
    {
        fixture.plan().execute().unwrap();
        assert!(!linked.exists());
        assert!(!target.exists());
    }
    assert_eq!(fs::read(fixture.0.join("sibling")).unwrap(), b"preserve\n");
}

#[test]
fn ordinary_loss_refs_are_inventoried_and_forced() {
    if run_isolated("ordinary_loss_refs_are_inventoried_and_forced") {
        return;
    }
    let fixture = Fixture::new();
    let target = fixture.0.join("repos/api");
    run(&target, &["tag", "light"]);
    run(&target, &["tag", "-a", "annotated", "-m", "release"]);
    run(&target, &["update-ref", "refs/custom/owned", "HEAD"]);
    fs::write(target.join("README"), "stash contents\n").unwrap();
    run(&target, &["stash", "push", "-m", "caller"]);
    let plan = fixture.plan();
    for name in [
        "refs/stash",
        "refs/tags/light",
        "refs/tags/light^{}",
        "refs/tags/annotated",
        "refs/tags/annotated^{}",
        "refs/custom/owned",
    ] {
        assert!(
            plan.local_refs.iter().any(|item| item.name == name),
            "missing {name}"
        );
    }
    assert!(
        plan.local_refs
            .windows(2)
            .all(|pair| pair[0].name <= pair[1].name),
        "source orders ref identities bytewise"
    );
    assert!(plan.protected_refs.contains(&"refs/stash".to_owned()));
    assert!(
        plan.protected_refs
            .contains(&"refs/tags/annotated".to_owned())
    );
    assert!(
        plan.protected_refs
            .contains(&"refs/custom/owned".to_owned())
    );
    assert!(!plan.protected_refs.contains(&"refs/tags/light".to_owned()));
    #[cfg(unix)]
    {
        plan.execute().unwrap();
        assert!(!target.exists());
    }
}

#[test]
fn ordinary_dirty_loss_is_authorized_but_later_bytes_are_not() {
    if run_isolated("ordinary_dirty_loss_is_authorized_but_later_bytes_are_not") {
        return;
    }
    let fixture = Fixture::new();
    let target = fixture.0.join("repos/api");
    fs::write(target.join("README"), "authorized\n").unwrap();
    fs::write(target.join("caller"), "authorized\n").unwrap();
    let plan = fixture.plan();
    assert!(
        plan.warnings
            .iter()
            .any(|warning| warning.contains("DELETE_GIT_DATA_LOSS") && warning.contains("caller"))
    );
    plan.validate().unwrap();
    fs::write(target.join("caller"), "replacement\n").unwrap();
    assert!(plan.validate().is_err());
    let current = fixture.plan();
    #[cfg(unix)]
    {
        current.execute().unwrap();
        assert!(!target.exists());
    }
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

#[cfg(unix)]
#[test]
fn quarantine_revalidation_freezes_network_rewrites_and_recovery_authority() {
    if run_isolated("quarantine_revalidation_freezes_network_rewrites_and_recovery_authority") {
        return;
    }
    for receipt in [false, true] {
        let fixture = Fixture::new();
        let target = fixture.0.join("repos/api");
        let url = "https://example.test/team/api.git";
        run(&target, &["remote", "set-url", "origin", url]);
        let config_path = fixture.0.join(".arashi/config.json");
        let mut config: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
        config["repos"]["api"]["gitUrl"] = json!(url);
        fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
        let plan = fixture.plan();
        let quarantine = fixture.0.join("repos/quarantine");
        fs::rename(&target, &quarantine).unwrap();
        assert!(
            plan.validate_quarantine(&quarantine, &plan.config_before)
                .is_ok(),
            "positive control"
        );
        if receipt {
            let directory = fixture.0.join(".git/.arashi-delete-receipts");
            fs::create_dir(&directory).unwrap();
            fs::write(directory.join("pending.json"), "new recovery authority\n").unwrap();
        } else {
            run(
                &fixture.0,
                &[
                    "config",
                    "url.https://elsewhere.test/.insteadOf",
                    "https://example.test/",
                ],
            );
        }
        assert!(
            plan.validate_quarantine(&quarantine, &plan.config_before)
                .is_err(),
            "receipt={receipt}: changed authority accepted"
        );
        assert!(quarantine.join("README").is_file());
        assert_eq!(fs::read(&config_path).unwrap(), plan.config_before);
    }
}
