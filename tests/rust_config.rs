use arashi::config::{Config, Workspace};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "arashi-rust-config-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&p).unwrap();
        Self(p.canonicalize().unwrap())
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn git(p: &std::path::Path, args: &[&str]) {
    assert!(
        Command::new("git")
            .args(["-c", "commit.gpgsign=false"])
            .arg("-C")
            .arg(p)
            .args(args)
            .output()
            .unwrap()
            .status
            .success()
    );
}
#[test]
fn aliases_and_defaults() {
    let c=Config::parse(r#"{"version":"1","repos_dir":"repos","discovered_repos":{"api":{"path":"repos/api","git_url":"x","defaultBranch":"main"}}}"#).unwrap();
    assert_eq!(c.worktrees_dir, ".arashi/worktrees");
    assert_eq!(c.raw["version"], "1.0.0");
    assert_eq!(c.repos["api"].raw["gitUrl"], "x");
    assert!(c.repos["api"].raw.get("defaultBranch").is_none());
}
#[test]
fn invalid_configuration_rejected() {
    for s in [
        r#"{"version":"2","reposDir":"repos","repos":{}}"#,
        r#"{"version":"1.0.0","reposDir":"repos","repos":{},"typo":true}"#,
        r#"{"version":"1.0.0","reposDir":"repos","repos":{"api":{"path":"a","unknown":1}}}"#,
        r#"{"version":"1.0.0","reposDir":"repos","repos":{},"hooks":{"timeout":0}}"#,
        r#"{"version":"1.0.0","reposDir":"repos","repos":{},"worktreesDir":"/absolute"}"#,
        r#"{"version":"1.0.0","reposDir":"repos","repos":{"@meta":{"path":"a"}}}"#,
    ] {
        assert!(Config::parse(s).is_err(), "{s}");
    }
}
#[test]
fn configured_ancestor_wins_and_loading_does_not_write() {
    let t = Temp::new();
    fs::create_dir_all(t.0.join(".arashi")).unwrap();
    fs::create_dir_all(t.0.join("nested/deep")).unwrap();
    let s = r#"{"version":"1","repos_dir":"repos","repos":{}}"#;
    fs::write(t.0.join(".arashi/config.json"), s).unwrap();
    let w = Workspace::discover(&t.0.join("nested/deep")).unwrap();
    assert_eq!(w.root, t.0);
    assert!(w.config.is_some());
    assert_eq!(
        fs::read_to_string(t.0.join(".arashi/config.json")).unwrap(),
        s
    );
}
#[test]
fn standalone_requires_convention_and_resolves_linked_primary() {
    let t = Temp::new();
    git(&t.0, &["init", "-b", "main"]);
    git(
        &t.0,
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
    assert!(Workspace::discover(&t.0).is_err());
    fs::create_dir(t.0.join(".worktrees")).unwrap();
    let linked = t.0.join(".worktrees/topic");
    git(
        &t.0,
        &["worktree", "add", "-b", "topic", linked.to_str().unwrap()],
    );
    let w = Workspace::discover(&linked).unwrap();
    assert_eq!(w.root, t.0);
    assert!(w.config.is_none());
    assert_eq!(w.metadata()["mode"], "standalone");
}
#[test]
fn malformed_nearer_config_is_not_hidden() {
    let t = Temp::new();
    fs::create_dir_all(t.0.join(".arashi")).unwrap();
    fs::write(t.0.join(".arashi/config.json"), "{").unwrap();
    assert!(Workspace::discover(&t.0).is_err());
}
#[test]
fn materialization_portable_paths_are_validated() {
    for paths in [
        r#"["../secret"]"#,
        r#"[".git/config"]"#,
        r#"["CON"]"#,
        r#"["x", "X"]"#,
    ] {
        let text = format!(
            r#"{{"version":"1.0.0","reposDir":"repos","repos":{{"api":{{"path":"api","copy":{paths}}}}}}}"#
        );
        assert!(Config::parse(&text).is_err(), "{text}");
    }
}
#[test]
fn configured_list_reports_short_commit_dirty_and_main() {
    let t = Temp::new();
    git(&t.0, &["init", "-b", "main"]);
    git(
        &t.0,
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
    fs::create_dir(t.0.join(".arashi")).unwrap();
    fs::write(
        t.0.join(".arashi/config.json"),
        r#"{"version":"1.0.0","reposDir":"repos","repos":{}}"#,
    )
    .unwrap();
    let linked = t.0.join("topic");
    git(
        &t.0,
        &["worktree", "add", "-b", "topic", linked.to_str().unwrap()],
    );
    let w = Workspace::discover(&t.0).unwrap();
    let value = arashi::list::list(&w).unwrap();
    let rows = value["worktrees"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["isMain"], true);
    assert_eq!(rows[0]["hasChanges"], true);
    assert_eq!(rows[0]["commit"].as_str().unwrap().len(), 7);
    assert_eq!(rows[1]["isMain"], false);
    assert_eq!(rows[1]["hasChanges"], false);
    assert!(rows[1].get("head").is_none());
    assert!(value.get("repositoryPath").is_none());
}
#[test]
fn standalone_list_preserves_full_head_shape() {
    let t = Temp::new();
    git(&t.0, &["init", "-b", "main"]);
    git(
        &t.0,
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
    fs::create_dir(t.0.join(".worktrees")).unwrap();
    let w = Workspace::discover(&t.0).unwrap();
    let v = arashi::list::list(&w).unwrap();
    assert_eq!(v["worktrees"][0]["head"].as_str().unwrap().len(), 40);
    assert!(v["worktrees"][0].get("commit").is_none());
    assert_eq!(v["repositoryPath"], t.0.to_str().unwrap());
}
#[test]
fn configured_linked_bare_topology_is_rejected() {
    let t = Temp::new();
    let bare = t.0.join("bare.git");
    let active = t.0.join("active");
    git(&t.0, &["init", "-b", "main"]);
    git(
        &t.0,
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
    git(
        &t.0,
        &[
            "clone",
            "--bare",
            t.0.to_str().unwrap(),
            bare.to_str().unwrap(),
        ],
    );
    git(
        &bare,
        &["worktree", "add", "-b", "topic", active.to_str().unwrap()],
    );
    fs::create_dir(active.join(".arashi")).unwrap();
    fs::write(
        active.join(".arashi/config.json"),
        r#"{"version":"1.0.0","reposDir":"repos","repos":{}}"#,
    )
    .unwrap();
    let result = Workspace::discover(&active);
    assert!(result.is_err(), "{result:?}");
}
