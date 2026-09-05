use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Repo(PathBuf);
impl Repo {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "arashi-init-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&p).unwrap();
        let r = Self(fs::canonicalize(p).unwrap());
        r.git(&["init", "-b", "main"]);
        r
    }
    fn git(&self, args: &[&str]) {
        let out = Command::new("git")
            .args(["-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(&self.0)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    fn init(&self, dry: bool) -> arashi::Result<serde_json::Value> {
        arashi::init::init(&self.0, dry, true)
    }
}
impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn zero_config_creates_then_is_idempotent() {
    let r = Repo::new();
    let exclude = r.0.join(".git/info/exclude");
    fs::write(&exclude, b"# existing\r\nline").unwrap();
    let data = r.init(false).unwrap();
    assert_eq!(
        data["attempted"],
        json!({"localExclude":true,"worktreesDirectory":true})
    );
    assert_eq!(
        data["finalState"],
        json!({"localExcludeChanged":true,"worktreesDirectoryChanged":true})
    );
    assert_eq!(data["mode"], "standalone");
    assert_eq!(data["workspaceRoot"], json!(r.0));
    assert_eq!(
        data["localExclude"]["source"],
        ".git/info/exclude:3:.worktrees/"
    );
    assert_eq!(
        fs::read(&exclude).unwrap(),
        b"# existing\r\nline\r\n.worktrees/\r\n"
    );
    assert!(r.0.join(".worktrees").is_dir());
    assert!(!r.0.join(".arashi").exists());
    assert_eq!(r.init(false).unwrap()["changed"], false);
}
#[test]
fn dry_run_has_exact_plan_and_no_writes() {
    let r = Repo::new();
    let exclude = r.0.join(".git/info/exclude");
    let before = fs::read(&exclude).unwrap();
    assert_eq!(
        r.init(true).unwrap(),
        json!({"attempted":{"localExclude":false,"worktreesDirectory":false},"changed":false,"dryRun":true,"finalState":{"localExcludeChanged":false,"worktreesDirectoryChanged":false},"localExclude":{"changed":false,"path":exclude,"planned":true,"rule":".worktrees/"},"mode":"standalone","restored":false,"workspaceRoot":r.0,"worktreesDirectory":{"changed":false,"path":r.0.join(".worktrees"),"planned":true}})
    );
    assert_eq!(fs::read(exclude).unwrap(), before);
    assert!(!r.0.join(".worktrees").exists());
}
#[test]
fn tracked_ignore_is_honored() {
    let r = Repo::new();
    fs::write(r.0.join(".gitignore"), ".worktrees/\n").unwrap();
    let exclude = r.0.join(".git/info/exclude");
    let before = fs::read(&exclude).unwrap();
    let data = r.init(false).unwrap();
    assert_eq!(data["localExclude"]["changed"], false);
    assert_eq!(data["localExclude"]["source"], ".gitignore:1:.worktrees/");
    assert_eq!(fs::read(exclude).unwrap(), before);
}
#[test]
fn negation_rolls_back_bytes_and_owned_directory() {
    let r = Repo::new();
    fs::write(r.0.join(".gitignore"), "!.worktrees/\n").unwrap();
    let exclude = r.0.join(".git/info/exclude");
    let before = fs::read(&exclude).unwrap();
    let err = r.init(false).unwrap_err();
    assert_eq!(err.code, "ZERO_CONFIG_BOOTSTRAP_FAILED");
    assert!(err.message.contains("higher-precedence"));
    assert_eq!(fs::read(exclude).unwrap(), before);
    assert!(!r.0.join(".worktrees").exists());
}
#[test]
fn configured_workspace_and_default_init_fail_before_mutation() {
    let r = Repo::new();
    fs::create_dir(r.0.join(".arashi")).unwrap();
    fs::write(r.0.join(".arashi/config.json"), "{}").unwrap();
    assert_eq!(
        r.init(false).unwrap_err().code,
        "ZERO_CONFIG_BOOTSTRAP_FAILED"
    );
    assert!(!r.0.join(".worktrees").exists());
    assert_eq!(
        arashi::init::init(&r.0, false, false).unwrap_err().code,
        "PORT_UNSUPPORTED"
    );
}
#[cfg(unix)]
#[test]
fn symlink_exclude_is_never_modified() {
    let r = Repo::new();
    let exclude = r.0.join(".git/info/exclude");
    fs::remove_file(&exclude).unwrap();
    let target = r.0.join("outside-exclude");
    fs::write(&target, "original").unwrap();
    std::os::unix::fs::symlink(&target, &exclude).unwrap();
    let err = r.init(false).unwrap_err();
    assert_eq!(err.code, "ZERO_CONFIG_BOOTSTRAP_FAILED");
    assert!(err.message.contains("symlink"));
    assert_eq!(fs::read_to_string(target).unwrap(), "original");
    assert!(!r.0.join(".worktrees").exists());
}
#[test]
fn rollback_error_details_match_contract() {
    let r = Repo::new();
    fs::write(r.0.join(".gitignore"), "!.worktrees/\n").unwrap();
    let err = r.init(false).unwrap_err();
    let details = err.details.unwrap();
    assert_eq!(details["mode"], "standalone");
    assert_eq!(
        details["attempted"],
        json!({"localExclude":true,"worktreesDirectory":true})
    );
    assert_eq!(
        details["restored"],
        json!({"localExclude":true,"worktreesDirectory":true})
    );
    assert_eq!(
        details["finalState"],
        json!({"localExcludeChanged":false,"worktreesDirectoryChanged":false})
    );
    assert_eq!(details["restorationWarnings"], json!([]));
}
#[test]
fn linked_worktree_bootstraps_main_and_bare_is_rejected() {
    let r = Repo::new();
    r.git(&[
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
    ]);
    let linked = r.0.join("linked");
    r.git(&["worktree", "add", "-b", "linked", linked.to_str().unwrap()]);
    let data = arashi::init::init(&linked, false, true).unwrap();
    assert_eq!(data["workspaceRoot"], json!(r.0));
    assert!(!linked.join(".worktrees").exists());
    let bare = r.0.join("bare.git");
    r.git(&["init", "--bare", bare.to_str().unwrap()]);
    let err = arashi::init::init(&bare, false, true).unwrap_err();
    assert_eq!(err.code, "ZERO_CONFIG_BOOTSTRAP_FAILED");
    assert_eq!(
        err.details.unwrap()["attempted"],
        json!({"localExclude":false,"worktreesDirectory":false})
    );
    assert!(!bare.join(".worktrees").exists());
}

/// Independent oracle comparison against retained TypeScript, using the same scratch root.
#[test]
#[ignore = "requires Bun and npm dependencies; cargo test --test rust_init source_zero_config_parity -- --ignored"]
fn source_zero_config_parity() {
    for ignore in [None, Some(".worktrees/\n"), Some("!.worktrees/\n")] {
        for dry in [true, false] {
            let r = Repo::new();
            if let Some(ignore) = ignore {
                fs::write(r.0.join(".gitignore"), ignore).unwrap();
            }
            let exclude = r.0.join(".git/info/exclude");
            let before = fs::read(&exclude).unwrap();
            let source =
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/lib/zero-config-bootstrap.ts");
            let script = format!(
                "import {{bootstrapZeroConfig}} from {}; try {{ console.log(JSON.stringify({{ok:true,data:await bootstrapZeroConfig(process.cwd(),{{dryRun:{dry}}})}})); }} catch(e) {{ console.log(JSON.stringify({{ok:false,error:{{code:e.code,message:e.message,details:e.details}}}})); }}",
                serde_json::to_string(&source).unwrap()
            );
            let output = Command::new("bun")
                .args(["--eval", &script])
                .current_dir(&r.0)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let expected: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            let source_exclude = fs::read(&exclude).unwrap();
            let source_dir = r.0.join(".worktrees").exists();
            if source_dir {
                fs::remove_dir(r.0.join(".worktrees")).unwrap();
            }
            fs::write(&exclude, &before).unwrap();
            let actual = match r.init(dry) {
                Ok(data) => json!({"ok":true,"data":data}),
                Err(err) => {
                    json!({"ok":false,"error":{"code":err.code,"message":err.message,"details":err.details}})
                }
            };
            assert_eq!(actual, expected, "ignore={ignore:?}, dry={dry}");
            assert_eq!(fs::read(&exclude).unwrap(), source_exclude);
            assert_eq!(r.0.join(".worktrees").exists(), source_dir);
        }
    }
}
