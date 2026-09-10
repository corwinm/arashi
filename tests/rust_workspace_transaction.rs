pub use arashi::{Error, Result};
#[path = "../src/rust/workspace_transaction.rs"]
pub mod workspace_transaction;
use std::{fs, time::Duration};
use workspace_transaction::{LockOptions, acquire};

#[test]
fn source_integer_valued_pid_spelling_is_a_live_owner() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lock");
    let bytes = format!(
        "{{\"pid\":{}.0,\"token\":\"source-number\"}}",
        std::process::id()
    );
    fs::write(&path, &bytes).unwrap();
    assert!(
        acquire(
            &path,
            LockOptions {
                retries: 2,
                incomplete_grace: Duration::ZERO
            }
        )
        .is_err()
    );
    assert_eq!(fs::read_to_string(path).unwrap(), bytes);
}

#[test]
fn retained_source_and_native_exclude_one_another() {
    use std::{
        io::Write,
        process::{Command, Stdio},
        time::Instant,
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lock");
    let ready = dir.path().join("ready");
    let mut source = Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/configure-edit/source-lock.mjs"
        ))
        .arg(&path)
        .arg(&ready)
        .arg("stdin")
        .env("HOME", dir.path())
        .env("USERPROFILE", dir.path())
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready.exists() && Instant::now() < deadline {
        if let Some(status) = source.try_wait().unwrap() {
            panic!("source exited before ready: {status}");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    if !ready.exists() {
        let _ = source.kill();
        let _ = source.wait();
        panic!("source lock readiness timeout");
    }
    let original = fs::read(&path).unwrap();
    let result = acquire(
        &path,
        LockOptions {
            retries: 2,
            incomplete_grace: Duration::ZERO,
        },
    );
    source
        .stdin
        .take()
        .unwrap()
        .write_all(b"release\n")
        .unwrap();
    let output = source.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(result.is_err());
    assert!(serde_json::from_slice::<serde_json::Value>(&original).unwrap()["token"].is_string());
    let guard = acquire(&path, LockOptions::default()).unwrap();
    let original = fs::read(&path).unwrap();
    let blocked = Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/configure-edit/source-lock.mjs"
        ))
        .arg(&path)
        .arg(dir.path().join("blocked-ready"))
        .arg("none")
        .env("HOME", dir.path())
        .output()
        .unwrap();
    assert!(!blocked.status.success());
    assert_eq!(fs::read(&path).unwrap(), original);
    guard.release().unwrap();
}
#[cfg(unix)]
#[test]
fn live_reclaimer_claim_is_respected_and_unrelated_files_survive() {
    use std::os::unix::fs::MetadataExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lock");
    fs::write(&path, b"incomplete").unwrap();
    let m = fs::metadata(&path).unwrap();
    let claim = dir.path().join(format!(
        "lock.reclaim-{}-{}-{}-foreign",
        m.dev(),
        m.ino(),
        std::process::id()
    ));
    fs::hard_link(&path, &claim).unwrap();
    fs::write(dir.path().join("unrelated"), b"caller").unwrap();
    assert!(
        acquire(
            &path,
            LockOptions {
                retries: 2,
                incomplete_grace: Duration::ZERO
            }
        )
        .is_err()
    );
    assert_eq!(fs::read(&path).unwrap(), b"incomplete");
    assert!(claim.exists());
    assert_eq!(fs::read(dir.path().join("unrelated")).unwrap(), b"caller");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 3);
}

#[test]
fn guard_excludes_live_owner_releases_on_drop_and_preserves_foreign_token() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lock");
    let options = LockOptions {
        retries: 2,
        incomplete_grace: Duration::ZERO,
    };
    let guard = acquire(&path, options).unwrap();
    let original = fs::read(&path).unwrap();
    assert!(acquire(&path, options).is_err());
    assert_eq!(fs::read(&path).unwrap(), original);
    drop(guard);
    assert!(!path.exists());
    let guard = acquire(&path, options).unwrap();
    fs::write(
        &path,
        format!("{{\"pid\":{},\"token\":\"foreign\"}}", std::process::id()),
    )
    .unwrap();
    guard.release().unwrap();
    assert!(path.exists());
}
#[test]
fn malformed_recent_lock_has_grace_but_zero_grace_recovers() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lock");
    fs::write(&path, b"{").unwrap();
    assert!(
        acquire(
            &path,
            LockOptions {
                retries: 1,
                incomplete_grace: Duration::from_secs(30)
            }
        )
        .is_err()
    );
    assert_eq!(fs::read(&path).unwrap(), b"{");
    acquire(
        &path,
        LockOptions {
            retries: 2,
            incomplete_grace: Duration::ZERO,
        },
    )
    .unwrap()
    .release()
    .unwrap();
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
}
#[test]
fn dead_owner_recovers_but_foreign_live_claim_prevents_reclaim() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lock");
    // Spawn and reap a real child, rather than guessing an unallocated PID.
    let mut child = std::process::Command::new("git")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let pid = child.id();
    assert!(child.wait().unwrap().success());
    fs::write(&path, format!("{{\"pid\":{pid},\"token\":\"dead\"}}")).unwrap();
    acquire(
        &path,
        LockOptions {
            retries: 2,
            incomplete_grace: Duration::from_secs(30),
        },
    )
    .unwrap()
    .release()
    .unwrap();
    assert!(!path.exists());
}

#[test]
fn duplicate_owner_members_use_last_value_like_source() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lock");
    let pid = std::process::id();
    let options = LockOptions {
        retries: 2,
        incomplete_grace: Duration::ZERO,
    };
    for bytes in [
        format!(r#"{{"pid":{pid},"pid":{pid},"token":"live"}}"#),
        format!(r#"{{"pid":"invalid","pid":{pid}.0,"token":"live"}}"#),
        format!(r#"{{"pid":{pid}e0,"token":null,"token":"live"}}"#),
        format!(r#"{{"pid":{pid},"token":"old","token":"live"}}"#),
    ] {
        fs::write(&path, &bytes).unwrap();
        let result = acquire(&path, options);
        assert!(
            result.is_err(),
            "valid last-member owner reclaimed: {bytes}"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), bytes);
    }
    for bytes in [
        format!(r#"{{"pid":{pid},"pid":"invalid","token":"live"}}"#),
        format!(r#"{{"pid":{pid},"pid":1.5,"token":"live"}}"#),
        format!(r#"{{"pid":{pid},"token":"live","token":null}}"#),
    ] {
        fs::write(&path, &bytes).unwrap();
        acquire(&path, options).unwrap().release().unwrap();
        assert!(!path.exists());
    }
}

#[test]
fn retained_source_generation_and_duplicate_owner_regressions() {
    let output = std::process::Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/configure-edit/source-lock.mjs"
        ))
        .arg("--regressions")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("PASS source duplicate-member final-value matrix"));
    assert!(stdout.contains("PASS source fresh incomplete generation keeps its own grace"));
    print!("{stdout}");
}

#[test]
fn release_uses_final_duplicate_token_and_not_pid_equality() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lock");
    for matches in [true, false] {
        let guard = acquire(&path, LockOptions::default()).unwrap();
        let owner: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let token = owner["token"].to_string();
        let bytes = if matches {
            format!(r#"{{"pid":0,"token":"foreign","token":{token}}}"#)
        } else {
            format!(r#"{{"pid":0,"token":{token},"token":"foreign"}}"#)
        };
        fs::write(&path, &bytes).unwrap();
        guard.release().unwrap();
        if matches {
            assert!(!path.exists());
        } else {
            assert_eq!(fs::read_to_string(&path).unwrap(), bytes);
        }
    }
}
