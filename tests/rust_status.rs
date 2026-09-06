use arashi::config::Workspace;
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
            "arashi-status-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&p).unwrap();
        let r = Self(arashi::paths::canonicalize(p).unwrap());
        r.git(&["init", "-b", "main"]);
        r.git(&["config", "user.email", "test@example.invalid"]);
        r.git(&["config", "user.name", "Test"]);
        fs::write(r.0.join("tracked"), "initial").unwrap();
        r.git(&["add", "tracked"]);
        r.git(&["commit", "-m", "initial"]);
        r
    }
    fn git(&self, a: &[&str]) {
        assert!(
            Command::new("git")
                .args(["-c", "commit.gpgsign=false"])
                .args(a)
                .current_dir(&self.0)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    fn workspace(&self) -> Workspace {
        Workspace {
            root: self.0.clone(),
            config: None,
        }
    }
}
impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn standalone_clean_shape() {
    let r = Repo::new();
    let data = arashi::status::status(&r.workspace(), &r.0).unwrap();
    assert_eq!(
        data,
        json!({"callerWorktree":r.0,"currentBranch":"main","mode":"standalone","repositoryPath":r.0,"summary":{"cleanCount":1,"dirtyCount":0,"total":1},"workspaceRoot":r.0,"worktreesBase":r.0.join(".worktrees"),"worktrees":[{"name":"main","path":arashi::git::worktrees(&r.0).unwrap()[0].path,"branch":{"ahead":0,"behind":0,"isDetached":false,"localBranch":"main","remoteBranch":null},"baseBranch":null,"defaultBranch":{"branch":"main","compareRef":"refs/heads/main","remote":null,"remoteRef":null,"reason":"on-default-branch","state":"skipped"},"error":null,"files":[],"refreshWarning":null}]})
    );
}
#[test]
fn dirty_files_and_local_default_divergence() {
    let r = Repo::new();
    r.git(&["checkout", "-b", "feature"]);
    fs::write(r.0.join("tracked"), "feature").unwrap();
    r.git(&["commit", "-am", "feature"]);
    fs::write(r.0.join("tracked"), "dirty").unwrap();
    fs::write(r.0.join("new file"), "new").unwrap();
    let data = arashi::status::status(&r.workspace(), &r.0).unwrap();
    assert_eq!(
        data["summary"],
        json!({"cleanCount":0,"dirtyCount":1,"total":1})
    );
    assert_eq!(data["worktrees"][0]["defaultBranch"]["ahead"], 1);
    assert_eq!(
        data["worktrees"][0]["files"],
        json!([{"path":"tracked","stagingStatus":" ","workingStatus":"M"},{"path":"\"new file\"","stagingStatus":"?","workingStatus":"?"}])
    );
}
#[test]
fn remote_status_fails_before_fetch() {
    let r = Repo::new();
    r.git(&["remote", "add", "origin", "https://example.invalid/repo"]);
    let e = arashi::status::status(&r.workspace(), &r.0).unwrap_err();
    assert_eq!(e.code, "PORT_UNSUPPORTED");
    assert!(!r.0.join(".git/FETCH_HEAD").exists());
}
#[test]
fn configured_shape_and_unavailable_local_base() {
    let r = Repo::new();
    let mut w = r.workspace();
    w.config=Some(arashi::config::Config::parse(r#"{"version":"1.0.0","reposDir":"repos","worktreesDir":".arashi/worktrees","repos":{}}"#).unwrap());
    let data = arashi::status::status(&w, &r.0).unwrap();
    assert_eq!(data["mode"], "configured");
    assert_eq!(data["filters"], json!({"groups":[],"only":[]}));
    assert_eq!(data["repositories"][0]["name"], "Main Repository");
    assert_eq!(
        data["summary"],
        json!({"cleanCount":1,"dirtyCount":0,"total":1})
    );
    assert!(data.get("worktrees").is_none());
    w.config.as_mut().unwrap().raw["baseBranch"] = json!("main");
    assert_eq!(
        arashi::status::status(&w, &r.0).unwrap()["repositories"][0]["baseBranch"]["reason"],
        "unresolved-target"
    );
}

#[test]
fn missing_configured_repository_path_is_lexically_normalized() {
    let r = Repo::new();
    let mut w = r.workspace();
    w.config = Some(
        arashi::config::Config::parse(
            r#"{"version":"1.0.0","reposDir":"./repos","worktreesDir":".arashi/worktrees","repos":{"missing":{"path":"./repos/missing"}}}"#,
        )
        .unwrap(),
    );
    let expected = r.0.join("repos/missing");

    let data = arashi::status::status(&w, &r.0).unwrap();
    let row = &data["repositories"][1];
    assert_eq!(row["path"], json!(expected));
    assert_eq!(
        row["error"],
        format!(
            "Repository is missing at {}. Run `arashi clone` to clone missing repositories.",
            expected.display()
        )
    );
}

/// Opt-in independent comparison with the retained TypeScript CLI.
/// ARASHI_TS_PARITY=1 cargo test --test rust_status source_oracle
#[test]
fn source_oracle() {
    if std::env::var_os("ARASHI_TS_PARITY").is_none() {
        return;
    }
    let r = Repo::new();
    fs::create_dir(r.0.join(".worktrees")).unwrap();
    fs::write(r.0.join("new file"), "untracked").unwrap();
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/index.ts");
    let output = Command::new("node")
        .arg(source)
        .args(["status", "--json"])
        .current_dir(&r.0)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let actual: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        actual["data"],
        arashi::status::status(&r.workspace(), &r.0).unwrap()
    );
}

#[test]
fn linked_status_matches_native_caller_to_git_path() {
    let r = Repo::new();
    let linked = r.0.join("linked worktree");
    r.git(&["worktree", "add", "-b", "feature", linked.to_str().unwrap()]);
    let caller = fs::canonicalize(&linked).unwrap();
    let data = arashi::status::status(&r.workspace(), &caller).unwrap();
    assert_eq!(data["callerWorktree"], json!(linked));
    assert_eq!(data["currentBranch"], "feature");
    assert_eq!(data["summary"]["total"], 2);
}
