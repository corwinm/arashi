use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
    base: PathBuf,
    workspace: PathBuf,
    home: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!(
            "arashi-rust-clone-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&base).unwrap();
        let base = arashi::paths::canonicalize(&base).unwrap();
        let workspace = base.join("workspace");
        let home = base.join("home");
        fs::create_dir(&workspace).unwrap();
        fs::create_dir(&home).unwrap();
        git(&workspace, &["init", "-b", "main"]);
        git(&workspace, &["config", "user.name", "Clone Test"]);
        git(
            &workspace,
            &["config", "user.email", "clone@example.invalid"],
        );
        git(&workspace, &["config", "commit.gpgSign", "false"]);
        fs::write(workspace.join("README.md"), "workspace\n").unwrap();
        git(&workspace, &["add", "README.md"]);
        git(&workspace, &["commit", "-m", "workspace"]);
        fs::create_dir(workspace.join(".arashi")).unwrap();
        fs::create_dir(workspace.join("repos")).unwrap();
        Self {
            base,
            workspace,
            home,
        }
    }

    fn remote(&self, name: &str, extra_branch: Option<&str>) -> PathBuf {
        let path = self.base.join("remotes").join(name);
        fs::create_dir_all(&path).unwrap();
        git(&path, &["init", "-b", "main"]);
        git(&path, &["config", "user.name", "Clone Test"]);
        git(&path, &["config", "user.email", "clone@example.invalid"]);
        git(&path, &["config", "commit.gpgSign", "false"]);
        fs::write(path.join("README.md"), format!("{name}\n")).unwrap();
        git(&path, &["add", "README.md"]);
        git(&path, &["commit", "-m", "base"]);
        if let Some(branch) = extra_branch {
            git(&path, &["branch", branch]);
        }
        path
    }

    fn configure(&self, text: &str) {
        fs::write(self.workspace.join(".arashi/config.json"), text).unwrap();
    }

    fn command(&self, source: bool, args: &[&str]) -> Output {
        self.command_env(source, args, &[])
    }

    fn command_env(&self, source: bool, args: &[&str], extra: &[(&str, &Path)]) -> Output {
        let mut command = if source {
            let mut command = Command::new("node");
            command.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"));
            command
        } else {
            Command::new(env!("CARGO_BIN_EXE_arashi"))
        };
        command
            .args(args)
            .current_dir(&self.workspace)
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.home.join(".gitconfig"))
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_ALLOW_PROTOCOL", "file")
            .env("NO_COLOR", "1")
            .env("GIT_OPTIONAL_LOCKS", "0");
        for (key, value) in extra {
            command.env(key, value);
        }
        command.output().unwrap()
    }

    fn reset_after_source(&self, exclude: &[u8]) {
        for entry in fs::read_dir(self.workspace.join("repos")).unwrap() {
            fs::remove_dir_all(entry.unwrap().path()).unwrap();
        }
        fs::write(self.workspace.join(".git/info/exclude"), exclude).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(["-c", "maintenance.auto=false"])
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn json(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "{error}: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

fn clone_effects(fixture: &Fixture, names: &[&str]) -> Vec<(String, String, String)> {
    names
        .iter()
        .map(|name| {
            let path = fixture.workspace.join("repos").join(name);
            (
                (*name).to_owned(),
                fs::read_to_string(path.join("README.md")).unwrap(),
                git(&path, &["symbolic-ref", "--short", "HEAD"]),
            )
        })
        .collect()
}

#[test]
#[ignore = "requires Node and retained TypeScript dependencies"]
fn local_and_file_remotes_match_source_json_and_effects() {
    let fixture = Fixture::new();
    let zulu = fixture.remote("zulu", None);
    let alpha = fixture.remote("alpha", None);
    fixture.configure(
        &serde_json::json!({
            "version": "1.0.0",
            "reposDir": "repos",
            "worktreesDir": ".arashi/worktrees",
            "repos": {
                "zulu": {"path": "repos/zulu", "gitUrl": zulu},
                "alpha": {"path": "repos/alpha", "gitUrl": format!("file://{}", alpha.display())}
            }
        })
        .to_string(),
    );
    let exclude = fs::read(fixture.workspace.join(".git/info/exclude")).unwrap();

    let source = fixture.command(true, &["clone", "--all", "--json"]);
    assert!(
        source.status.success(),
        "{}",
        String::from_utf8_lossy(&source.stderr)
    );
    let source_effects = clone_effects(&fixture, &["alpha", "zulu"]);
    fixture.reset_after_source(&exclude);

    let native = fixture.command(false, &["clone", "--all", "--json"]);
    assert!(
        native.status.success(),
        "{}",
        String::from_utf8_lossy(&native.stdout)
    );
    assert_eq!(
        json(&native),
        json(&source),
        "complete JSON envelope parity"
    );
    assert_eq!(native.stderr, source.stderr, "complete stderr parity");
    assert_eq!(clone_effects(&fixture, &["alpha", "zulu"]), source_effects);
}

#[test]
#[ignore = "requires Node and retained TypeScript dependencies"]
fn explicit_base_matches_source_json_and_checkout() {
    let fixture = Fixture::new();
    let remote = fixture.remote("api", Some("release"));
    fixture.configure(
        &serde_json::json!({
            "version": "1.0.0",
            "reposDir": "repos",
            "worktreesDir": ".arashi/worktrees",
            "repos": {"api": {"path": "repos/api", "gitUrl": remote}}
        })
        .to_string(),
    );
    let exclude = fs::read(fixture.workspace.join(".git/info/exclude")).unwrap();

    let source = fixture.command(true, &["clone", "--all", "--base", "release", "--json"]);
    assert!(
        source.status.success(),
        "{}",
        String::from_utf8_lossy(&source.stdout)
    );
    let source_effects = clone_effects(&fixture, &["api"]);
    fixture.reset_after_source(&exclude);

    let native = fixture.command(false, &["clone", "--all", "--base", "release", "--json"]);
    assert!(
        native.status.success(),
        "{}",
        String::from_utf8_lossy(&native.stdout)
    );
    assert_eq!(
        json(&native),
        json(&source),
        "complete JSON envelope parity"
    );
    assert_eq!(clone_effects(&fixture, &["api"]), source_effects);
}

#[test]
fn unsupported_transport_and_topology_fail_before_mutation() {
    let fixture = Fixture::new();
    let before = fs::read(fixture.workspace.join(".git/info/exclude")).unwrap();
    fixture.configure(
        r#"{"version":"1.0.0","reposDir":"repos","worktreesDir":".arashi/worktrees","repos":{"api":{"path":"repos/api","gitUrl":"https://example.invalid/api.git"}}}"#,
    );
    let output = fixture.command(false, &["clone", "--all", "--json"]);
    assert!(!output.status.success());
    assert_eq!(json(&output)["error"]["code"], "RUST_NOT_YET_PORTED");
    assert_eq!(
        fs::read(fixture.workspace.join(".git/info/exclude")).unwrap(),
        before
    );
    assert!(
        fs::read_dir(fixture.workspace.join("repos"))
            .unwrap()
            .next()
            .is_none()
    );

    #[cfg(unix)]
    {
        let remote = fixture.remote("local", None);
        let outside = fixture.base.join("outside");
        fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, fixture.workspace.join("repos/api")).unwrap();
        fixture.configure(
            &serde_json::json!({
                "version": "1.0.0",
                "reposDir": "repos",
                "worktreesDir": ".arashi/worktrees",
                "repos": {"api": {"path": "repos/api", "gitUrl": remote}}
            })
            .to_string(),
        );
        let output = fixture.command(false, &["clone", "--all", "--json"]);
        assert!(!output.status.success());
        assert_eq!(json(&output)["error"]["code"], "RUST_NOT_YET_PORTED");
        assert_eq!(
            fs::read(fixture.workspace.join(".git/info/exclude")).unwrap(),
            before
        );
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
    }
}

#[test]
fn interactive_and_non_json_modes_fail_before_mutation() {
    let fixture = Fixture::new();
    let remote = fixture.remote("api", None);
    fixture.configure(
        &serde_json::json!({
            "version": "1.0.0",
            "reposDir": "repos",
            "worktreesDir": ".arashi/worktrees",
            "repos": {"api": {"path": "repos/api", "gitUrl": remote}}
        })
        .to_string(),
    );
    let before = fs::read(fixture.workspace.join(".git/info/exclude")).unwrap();
    for args in [&["clone", "--json"][..], &["clone", "--all"][..]] {
        let output = fixture.command(false, args);
        assert!(!output.status.success());
        assert_eq!(
            fs::read(fixture.workspace.join(".git/info/exclude")).unwrap(),
            before
        );
    }
}

#[cfg(unix)]
#[test]
fn executable_git_template_is_rejected_before_clone_or_ignore_mutation() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = Fixture::new();
    let remote = fixture.remote("api", None);
    fixture.configure(
        &serde_json::json!({
            "version": "1.0.0",
            "reposDir": "repos",
            "worktreesDir": ".arashi/worktrees",
            "repos": {"api": {"path": "repos/api", "gitUrl": remote}}
        })
        .to_string(),
    );
    let template = fixture.base.join("template");
    let hooks = template.join("hooks");
    let marker = fixture.base.join("template-ran");
    fs::create_dir_all(&hooks).unwrap();
    let hook = hooks.join("post-checkout");
    fs::write(
        &hook,
        format!("#!/bin/sh\nprintf ran > '{}'\n", marker.display()),
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();

    let control = fixture.base.join("control");
    let output = Command::new("git")
        .args(["clone", remote.to_str().unwrap(), control.to_str().unwrap()])
        .env("GIT_TEMPLATE_DIR", &template)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(
        marker.exists(),
        "positive control must execute the template hook"
    );
    fs::remove_file(&marker).unwrap();

    let before = fs::read(fixture.workspace.join(".git/info/exclude")).unwrap();
    let output = fixture.command_env(
        false,
        &["clone", "--all", "--json"],
        &[("GIT_TEMPLATE_DIR", &template)],
    );
    assert!(!output.status.success());
    assert_eq!(json(&output)["error"]["code"], "RUST_NOT_YET_PORTED");
    assert!(!marker.exists());
    assert_eq!(
        fs::read(fixture.workspace.join(".git/info/exclude")).unwrap(),
        before
    );
    assert!(!fixture.workspace.join("repos/api").exists());
}

#[cfg(unix)]
#[test]
fn remote_disappearing_after_clone_rolls_back_staging_and_ignore() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = Fixture::new();
    let remote = fixture.remote("api", None);
    fixture.configure(
        &serde_json::json!({
            "version": "1.0.0",
            "reposDir": "repos",
            "worktreesDir": ".arashi/worktrees",
            "repos": {"api": {"path": "repos/api", "gitUrl": remote}}
        })
        .to_string(),
    );
    let real_git = PathBuf::from(
        String::from_utf8(Command::new("which").arg("git").output().unwrap().stdout)
            .unwrap()
            .trim(),
    );
    let bin = fixture.base.join("bin");
    fs::create_dir(&bin).unwrap();
    let wrapper = bin.join("git");
    fs::write(
        &wrapper,
        "#!/bin/sh\n\"$ARASHI_REAL_GIT\" \"$@\"\nstatus=$?\nif [ \"$1\" = clone ]; then /bin/rm -rf \"$ARASHI_REMOTE\"; fi\nexit $status\n",
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    let before = fs::read(fixture.workspace.join(".git/info/exclude")).unwrap();

    let output = fixture.command_env(
        false,
        &["clone", "--all", "--json"],
        &[
            ("PATH", &bin),
            ("ARASHI_REAL_GIT", &real_git),
            ("ARASHI_REMOTE", &remote),
        ],
    );
    assert!(!output.status.success());
    assert_eq!(
        fs::read(fixture.workspace.join(".git/info/exclude")).unwrap(),
        before
    );
    assert!(!fixture.workspace.join("repos/api").exists());
    assert!(
        fs::read_dir(fixture.workspace.join("repos"))
            .unwrap()
            .next()
            .is_none(),
        "staging clone must be removed"
    );
}

#[cfg(unix)]
#[test]
fn conditional_hook_configuration_is_rejected_before_mutation() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = Fixture::new();
    let remote = fixture.remote("api", None);
    fixture.configure(
        &serde_json::json!({
            "version": "1.0.0", "reposDir": "repos", "worktreesDir": ".arashi/worktrees",
            "repos": {"api": {"path": "repos/api", "gitUrl": remote}}
        })
        .to_string(),
    );
    let hooks = fixture.base.join("hooks");
    let marker = fixture.base.join("conditional-hook-ran");
    fs::create_dir(&hooks).unwrap();
    let hook = hooks.join("post-checkout");
    fs::write(
        &hook,
        format!("#!/bin/sh\nprintf ran > '{}'\n", marker.display()),
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    let included = fixture.home.join("included.gitconfig");
    fs::write(
        &included,
        format!("[core]\n\thooksPath = {}\n", hooks.display()),
    )
    .unwrap();
    fs::write(
        fixture.home.join(".gitconfig"),
        format!(
            "[includeIf \"gitdir:{}/repos/**\"]\n\tpath = {}\n",
            fixture.workspace.display(),
            included.display()
        ),
    )
    .unwrap();
    let before = fs::read(fixture.workspace.join(".git/info/exclude")).unwrap();

    let output = fixture.command(false, &["clone", "--all", "--json"]);

    assert!(!output.status.success());
    assert_eq!(json(&output)["error"]["code"], "RUST_NOT_YET_PORTED");
    assert!(!marker.exists());
    assert_eq!(
        fs::read(fixture.workspace.join(".git/info/exclude")).unwrap(),
        before
    );
    assert!(!fixture.workspace.join("repos/api").exists());
}

#[test]
fn promisor_remote_is_rejected_without_lazy_fetch_or_mutation() {
    let fixture = Fixture::new();
    let remote = fixture.remote("api", None);
    let origin = fixture.base.join("origin.git");
    git(
        &fixture.base,
        &[
            "clone",
            "--bare",
            remote.to_str().unwrap(),
            origin.to_str().unwrap(),
        ],
    );
    let oid = git(&remote, &["rev-parse", "HEAD"]);
    git(
        &remote,
        &["config", "remote.origin.url", origin.to_str().unwrap()],
    );
    git(&remote, &["config", "remote.origin.promisor", "true"]);
    git(
        &remote,
        &["config", "remote.origin.partialclonefilter", "blob:none"],
    );
    let missing_object = remote.join(".git/objects").join(&oid[..2]).join(&oid[2..]);
    fs::remove_file(&missing_object).unwrap();
    let pack_dir = remote.join(".git/objects/pack");
    let mut packs_before = fs::read_dir(&pack_dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    packs_before.sort();
    fixture.configure(
        &serde_json::json!({
            "version": "1.0.0", "reposDir": "repos", "worktreesDir": ".arashi/worktrees",
            "repos": {"api": {"path": "repos/api", "gitUrl": remote}}
        })
        .to_string(),
    );
    let before = fs::read(fixture.workspace.join(".git/info/exclude")).unwrap();

    let output = fixture.command(false, &["clone", "--all", "--json"]);

    let mut packs_after = fs::read_dir(&pack_dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    packs_after.sort();
    assert!(!output.status.success());
    assert_eq!(json(&output)["error"]["code"], "RUST_NOT_YET_PORTED");
    assert!(
        !missing_object.exists(),
        "preflight must not lazy-fetch objects"
    );
    assert_eq!(packs_after, packs_before, "preflight must not write packs");
    assert_eq!(
        fs::read(fixture.workspace.join(".git/info/exclude")).unwrap(),
        before
    );
    assert!(!fixture.workspace.join("repos/api").exists());
}

#[test]
#[ignore = "requires Node and retained TypeScript dependencies"]
fn repository_override_for_present_child_is_rejected_before_mutation() {
    let fixture = Fixture::new();
    let api = fixture.remote("api", None);
    let other = fixture.remote("other", None);
    fs::create_dir(fixture.workspace.join("repos/api")).unwrap();
    fixture.configure(
        &serde_json::json!({
            "version": "1.0.0", "reposDir": "repos", "worktreesDir": ".arashi/worktrees",
            "repos": {
                "api": {"path": "repos/api", "gitUrl": api},
                "other": {"path": "repos/other", "gitUrl": other}
            }
        })
        .to_string(),
    );
    let before = fs::read(fixture.workspace.join(".git/info/exclude")).unwrap();
    let args = ["clone", "--all", "--repo-base", "api=main", "--json"];

    let source = fixture.command(true, &args);
    let native = fixture.command(false, &args);

    assert!(!source.status.success());
    assert!(!native.status.success());
    assert_eq!(json(&native), json(&source));
    assert_eq!(
        fs::read(fixture.workspace.join(".git/info/exclude")).unwrap(),
        before
    );
    assert!(!fixture.workspace.join("repos/other").exists());
}

#[test]
#[ignore = "requires Node and retained TypeScript dependencies"]
fn mixed_repository_base_policy_matches_source_json() {
    let fixture = Fixture::new();
    let alpha = fixture.remote("alpha", None);
    let beta = fixture.remote("beta", None);
    fixture.configure(
        &serde_json::json!({
            "version": "1.0.0",
            "reposDir": "repos",
            "worktreesDir": ".arashi/worktrees",
            "repos": {
                "alpha": {"path": "repos/alpha", "gitUrl": alpha},
                "beta": {"path": "repos/beta", "gitUrl": beta}
            }
        })
        .to_string(),
    );
    let exclude = fs::read(fixture.workspace.join(".git/info/exclude")).unwrap();
    let args = ["clone", "--all", "--repo-base", "alpha=main", "--json"];

    let source = fixture.command(true, &args);
    assert!(source.status.success());
    fixture.reset_after_source(&exclude);
    let native = fixture.command(false, &args);

    assert!(native.status.success());
    assert_eq!(json(&native), json(&source));
}

#[test]
fn nested_repository_name_is_rejected_before_mutation() {
    let fixture = Fixture::new();
    let remote = fixture.remote("shared", None);
    fixture.configure(
        &serde_json::json!({
            "version": "1.0.0", "reposDir": "repos", "worktreesDir": ".arashi/worktrees",
            "repos": {
                "a": {"path": "repos/a", "gitUrl": remote},
                "a/b": {"path": "repos/a/b", "gitUrl": remote}
            }
        })
        .to_string(),
    );
    let before = fs::read(fixture.workspace.join(".git/info/exclude")).unwrap();

    let output = fixture.command(false, &["clone", "--all", "--json"]);

    assert!(!output.status.success());
    assert_eq!(json(&output)["error"]["code"], "RUST_NOT_YET_PORTED");
    assert_eq!(
        fs::read(fixture.workspace.join(".git/info/exclude")).unwrap(),
        before
    );
    assert!(
        fs::read_dir(fixture.workspace.join("repos"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn unsupported_ascii_collation_name_is_rejected_before_mutation() {
    let fixture = Fixture::new();
    let remote = fixture.remote("shared", None);
    fixture.configure(
        &serde_json::json!({
            "version": "1.0.0", "reposDir": "repos", "worktreesDir": ".arashi/worktrees",
            "repos": {
                "a-b": {"path": "repos/a-b", "gitUrl": remote},
                "a_b": {"path": "repos/a_b", "gitUrl": remote}
            }
        })
        .to_string(),
    );
    let before = fs::read(fixture.workspace.join(".git/info/exclude")).unwrap();

    let output = fixture.command(false, &["clone", "--all", "--json"]);

    assert!(!output.status.success());
    assert_eq!(json(&output)["error"]["code"], "RUST_NOT_YET_PORTED");
    assert_eq!(
        fs::read(fixture.workspace.join(".git/info/exclude")).unwrap(),
        before
    );
    assert!(
        fs::read_dir(fixture.workspace.join("repos"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn ascii_repository_order_matches_source_locale_order() {
    let fixture = Fixture::new();
    let alpha = fixture.remote("alpha", None);
    let zulu = fixture.remote("Zulu", None);
    fixture.configure(
        &serde_json::json!({
            "version": "1.0.0", "reposDir": "repos", "worktreesDir": ".arashi/worktrees",
            "repos": {
                "Zulu": {"path": "repos/Zulu", "gitUrl": zulu},
                "alpha": {"path": "repos/alpha", "gitUrl": alpha}
            }
        })
        .to_string(),
    );
    let output = fixture.command(false, &["clone", "--all", "--json"]);
    assert!(output.status.success());
    assert_eq!(
        json(&output)["data"]["cloned"],
        serde_json::json!(["alpha", "Zulu"])
    );
}
