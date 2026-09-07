use super::*;
use managed_launch::lock::IdentityLock;
use std::{fs, time::Duration};
const WAIT: Duration = Duration::from_millis(60);
#[test]
fn lock_serializes_live_owner_and_releases() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().join("locks");
    let a = IdentityLock::acquire("arashi-v1-fixture", Some(&root), WAIT).unwrap();
    assert!(IdentityLock::acquire("arashi-v1-fixture", Some(&root), WAIT).is_err());
    let owner: serde_json::Value =
        serde_json::from_slice(&fs::read(a.path.join("owner.json")).unwrap()).unwrap();
    assert_eq!(owner["pid"], std::process::id());
    assert_eq!(
        owner["createdAt"].as_f64().unwrap().fract(),
        0.0,
        "Date.now integer milliseconds are required for source-compatible ownership readback"
    );
    assert_eq!(owner["identity"], "arashi-v1-fixture");
    a.release().unwrap();
    IdentityLock::acquire("arashi-v1-fixture", Some(&root), WAIT)
        .unwrap()
        .release()
        .unwrap();
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
}
#[test]
fn lock_recovers_dead_owner_and_stale_recovery_guard() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().join("locks");
    fs::create_dir(&root).unwrap();
    for (suffix, identity) in [
        (".lock", "arashi-v1-fixture"),
        (".lock.recovery", "arashi-v1-fixture:recovery"),
    ] {
        let path = root.join(format!("arashi-v1-fixture{suffix}"));
        fs::create_dir(&path).unwrap();
        fs::write(
            path.join("owner.json"),
            json!({"pid":2147483647,"owner":"dead","createdAt":0,"identity":identity}).to_string(),
        )
        .unwrap();
    }
    IdentityLock::acquire("arashi-v1-fixture", Some(&root), WAIT)
        .unwrap()
        .release()
        .unwrap();
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
}
#[test]
fn lock_never_removes_changed_owner() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().join("locks");
    let a = IdentityLock::acquire("arashi-v1-fixture", Some(&root), WAIT).unwrap();
    let path = a.path.clone();
    let other=json!({"pid":std::process::id(),"owner":"replacement","createdAt":0,"identity":"arashi-v1-fixture"}).to_string();
    fs::write(path.join("owner.json"), &other).unwrap();
    a.release().unwrap();
    assert_eq!(fs::read_to_string(path.join("owner.json")).unwrap(), other);
}
#[test]
fn lock_recent_malformed_is_not_stolen() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().join("locks");
    let p = root.join("arashi-v1-fixture.lock");
    fs::create_dir_all(&p).unwrap();
    assert!(IdentityLock::acquire("arashi-v1-fixture", Some(&root), WAIT).is_err());
    assert!(p.exists());
}
#[cfg(unix)]
#[test]
fn lock_root_symlink_rejected_and_permissions_secured() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let d = tempfile::tempdir().unwrap();
    let real = d.path().join("real");
    fs::create_dir(&real).unwrap();
    let link = d.path().join("link");
    symlink(&real, &link).unwrap();
    assert!(IdentityLock::acquire("arashi-v1-fixture", Some(&link), WAIT).is_err());
    let lock = IdentityLock::acquire("arashi-v1-fixture", Some(&real), WAIT).unwrap();
    assert_eq!(
        fs::metadata(&real).unwrap().permissions().mode() & 0o777,
        0o700
    );
    lock.release().unwrap();
}

#[test]
fn lock_corrupt_owner_release_reports_failure_without_deleting() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().join("locks");
    let a = IdentityLock::acquire("arashi-v1-fixture", Some(&root), WAIT).unwrap();
    let path = a.path.clone();
    fs::write(path.join("owner.json"), "malformed").unwrap();
    assert!(a.release().is_err());
    assert!(path.exists());
}
#[test]
fn lock_stale_malformed_and_parallel_contenders() {
    use std::{
        sync::{
            Arc, Barrier,
            atomic::{AtomicUsize, Ordering},
        },
        thread,
        time::SystemTime,
    };
    let d = tempfile::tempdir().unwrap();
    let root = d.path().join("locks");
    let path = root.join("arashi-v1-fixture.lock");
    fs::create_dir_all(&path).unwrap();
    {
        #[cfg(unix)]
        let file = fs::File::open(&path).unwrap();
        #[cfg(windows)]
        let file = {
            use std::os::windows::fs::OpenOptionsExt;
            fs::OpenOptions::new()
                .access_mode(0x100)
                .custom_flags(0x02000000)
                .open(&path)
                .unwrap()
        };
        file
    }
    .set_modified(SystemTime::now() - Duration::from_secs(31))
    .unwrap();
    IdentityLock::acquire("arashi-v1-fixture", Some(&root), Duration::from_secs(1))
        .unwrap()
        .release()
        .unwrap();
    let active = Arc::new(AtomicUsize::new(0));
    let barrier = Arc::new(Barrier::new(4));
    thread::scope(|scope| {
        for _ in 0..4 {
            let root = &root;
            let active = Arc::clone(&active);
            let barrier = Arc::clone(&barrier);
            scope.spawn(move || {
                barrier.wait();
                let lock =
                    IdentityLock::acquire("arashi-v1-fixture", Some(root), Duration::from_secs(3))
                        .unwrap();
                assert_eq!(active.fetch_add(1, Ordering::SeqCst), 0);
                thread::sleep(Duration::from_millis(10));
                assert_eq!(active.fetch_sub(1, Ordering::SeqCst), 1);
                lock.release().unwrap();
            });
        }
    });
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
}
