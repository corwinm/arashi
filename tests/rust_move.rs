use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

#[cfg(unix)]
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn reference_errors_precede_interactive_selection_like_source() {
    for args in [
        vec!["move", "--to", "missing", "--json"],
        vec!["move", "--from", "missing", "--json"],
        vec!["move", "--from", "main", "--to", "missing", "--json"],
    ] {
        let fixture = Fixture::new();
        fixture.configured();
        let source = fixture.run_source(&args);
        let native = fixture.run(&args);
        assert_eq!(source.status.code(), Some(1));
        assert_eq!(document(&source)["error"]["code"], "WORKSPACE_NOT_FOUND");
        assert_eq!(document(&source), document(&native), "{args:?}");
        assert_eq!(source.stderr, native.stderr);
        assert!(fixture.status(&fixture.root).is_empty());
        assert!(fixture.git(&fixture.root, &["stash", "list"]).is_empty());
    }
}

#[cfg(unix)]
#[test]
fn move_composes_with_create_configure_shell_status_and_handoff() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    for source in [false, true] {
        if source && std::env::var_os("ARASHI_TS_PARITY").is_none() {
            continue;
        }
        let f = Fixture::new();
        let target = f.configured();
        let child = f.root.join("repos/alpha");
        f.git(
            &child,
            &[
                "worktree",
                "remove",
                target.join("repos/alpha").to_str().unwrap(),
            ],
        );
        f.git(&f.root, &["worktree", "remove", target.to_str().unwrap()]);
        for path in [&f.root, &child] {
            f.git(path, &["branch", "-D", "feature"]);
        }
        let config_path = f.root.join(".arashi/config.json");
        let mut config: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
        config["defaults"] =
            serde_json::json!({"switch":{"mode":"cd"},"create":{"launch":false,"switch":false}});
        config["sync"] = serde_json::json!({"timeoutSeconds":10});
        fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
        f.git(&f.root, &["add", ".arashi/config.json"]);
        f.git(&f.root, &["commit", "-m", "policies"]);
        let config_bytes = fs::read(&config_path).unwrap();
        let heads = [
            f.git(&f.root, &["rev-parse", "HEAD"]),
            f.git(&child, &["rev-parse", "HEAD"]),
        ];
        // A pre-existing stash must survive the full round trip.
        fs::write(f.root.join("tracked"), "caller saved\n").unwrap();
        f.git(&f.root, &["stash", "push", "-m", "caller-owned"]);
        let stash = f.git(&f.root, &["rev-parse", "refs/stash"]);
        fs::create_dir(f.home.join("bin")).unwrap();
        fs::create_dir(f.home.join("tmp")).unwrap();
        let executable = f.home.join("bin/arashi");
        if source {
            fs::write(
                &executable,
                "#!/bin/sh\nexec node \"$ARASHI_SOURCE_ENTRY\" \"$@\"\n",
            )
            .unwrap();
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        } else {
            symlink(env!("CARGO_BIN_EXE_arashi"), &executable).unwrap();
        }
        symlink("arashi", f.home.join("bin/aw")).unwrap();
        let mut paths = vec![f.home.join("bin")];
        paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap()));
        let mut command = Command::new("bash");
        f.environment(&mut command);
        let output = command
            .args([
                "--noprofile",
                "--norc",
                "-c",
                r#"
set -e
arashi shell init bash > "$HOME/wrapper"
. "$HOME/wrapper"
arashi configure --json > "$HOME/configure.json"
arashi create feature --json --no-hooks --no-launch --no-switch > "$HOME/create.json"
printf 'staged\n' > tracked
git add tracked
printf 'unstaged\n' > tracked
printf 'untracked\n' > untracked
printf 'child changes\n' > repos/alpha/tracked
arashi move --to feature --json > "$HOME/move.json"
arashi status --json > "$HOME/status.json"
arashi handoff --json --todo 'review moved changes' > "$HOME/handoff.json"
arashi switch --cd --repos --path "$EXPECTED_CHILD"
[ "$(pwd -P)" = "$EXPECTED_CHILD" ]
[ "$(cat tracked)" = 'child changes' ]
aw switch --cd --path "$EXPECTED_ROOT"
[ "$(pwd -P)" = "$EXPECTED_ROOT" ]
aw move --from feature --to main --json > "$HOME/return.json"
[ -z "${ARASHI_DIRECTIVE_FILE+x}" ]
"#,
            ])
            .env("PATH", std::env::join_paths(paths).unwrap())
            .env("EXPECTED_ROOT", &f.root)
            .env("EXPECTED_CHILD", target.join("repos/alpha"))
            .env("TMPDIR", f.home.join("tmp"))
            .env(
                "ARASHI_SOURCE_ENTRY",
                Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"),
            )
            .env_remove("ARASHI_DIRECTIVE_FILE")
            .env_remove("ARASHI_SHELL")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "source={source}: {output:?}; reports={:?}",
            fs::read_dir(&f.home)
                .unwrap()
                .map(|e| {
                    let p = e.unwrap().path();
                    (p.clone(), fs::read_to_string(p).ok())
                })
                .collect::<Vec<_>>()
        );
        for name in ["configure", "create", "move", "status", "handoff", "return"] {
            let value: Value =
                serde_json::from_slice(&fs::read(f.home.join(format!("{name}.json"))).unwrap())
                    .unwrap();
            assert_eq!(value["ok"], true, "{name}: {value}");
            if name == "move" || name == "return" {
                assert_eq!(value["data"]["movedCount"], 2);
                assert_eq!(value["data"]["results"][0]["repositoryName"], "workspace");
                assert_eq!(value["data"]["results"][1]["repositoryName"], "alpha");
            }
        }
        assert_eq!(fs::read(&config_path).unwrap(), config_bytes);
        assert_eq!(f.git(&f.root, &["rev-parse", "refs/stash"]), stash);
        for (i, path) in [&f.root, &child].iter().enumerate() {
            assert_eq!(f.git(path, &["rev-parse", "HEAD"]), heads[i]);
        }
        assert_eq!(f.git(&f.root, &["show", ":tracked"]), "staged\n");
        assert_eq!(
            fs::read_to_string(f.root.join("tracked")).unwrap(),
            "unstaged\n"
        );
        assert_eq!(
            fs::read_to_string(f.root.join("untracked")).unwrap(),
            "untracked\n"
        );
        assert_eq!(
            fs::read_to_string(child.join("tracked")).unwrap(),
            "child changes\n"
        );
        assert!(f.status(&target).is_empty());
        assert!(f.status(&target.join("repos/alpha")).is_empty());
        assert!(f.git(&child, &["stash", "list"]).is_empty());
        assert_eq!(fs::read_dir(f.home.join("tmp")).unwrap().count(), 0);
    }
}

#[cfg(windows)]
#[test]
fn windows_move_rejects_without_changing_workspaces_or_owned_stashes() {
    fn snapshot(path: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut out = Vec::new();
        for entry in fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                out.extend(snapshot(&path));
            } else {
                out.push((path.clone(), fs::read(&path).unwrap()));
            }
        }
        out.sort();
        out
    }
    for configured in [false, true] {
        let f = Fixture::new();
        if configured {
            f.configured();
        } else {
            f.standalone();
        }
        fs::write(f.root.join("tracked"), "caller stash\n").unwrap();
        f.git(&f.root, &["stash", "push", "-m", "caller-owned"]);
        fs::write(f.root.join("tracked"), "caller changes\n").unwrap();
        let before = snapshot(&f.base);
        for args in [
            vec!["move", "--to", "feature", "--json"],
            vec!["move", "--from", "main", "--to", "feature", "--json"],
            vec!["move", "--to", "feature"],
        ] {
            let output = f.run(&args);
            assert_eq!(output.status.code(), Some(1));
            if args.contains(&"--json") {
                assert_eq!(document(&output)["error"]["code"], "RUST_NOT_YET_PORTED");
                assert!(
                    document(&output)["error"]["message"]
                        .as_str()
                        .unwrap()
                        .contains("Windows")
                );
            }
            assert_eq!(snapshot(&f.base), before);
        }
        assert!(!f.status(&f.root).is_empty());
    }
}

struct Fixture {
    base: PathBuf,
    root: PathBuf,
    home: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!(
            "arashi-move-rust-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&base).unwrap();
        let base = arashi::paths::canonicalize(&base).unwrap();
        let root = base.join("workspace");
        let home = base.join("home");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&home).unwrap();
        let fixture = Self { base, root, home };
        fixture.git(&fixture.root, &["init", "-b", "main"]);
        fs::write(fixture.root.join("tracked"), "base\n").unwrap();
        fixture.git(&fixture.root, &["add", "tracked"]);
        fixture.git(&fixture.root, &["commit", "-m", "base"]);
        fixture
    }

    fn environment(&self, command: &mut Command) {
        command
            .current_dir(&self.root)
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.home.join(".gitconfig"))
            .env("GIT_CONFIG_COUNT", "2")
            .env("GIT_CONFIG_KEY_0", "commit.gpgsign")
            .env("GIT_CONFIG_VALUE_0", "false")
            .env("GIT_CONFIG_KEY_1", "maintenance.auto")
            .env("GIT_CONFIG_VALUE_1", "false")
            .env("NO_COLOR", "1");
    }

    fn git(&self, cwd: &Path, args: &[&str]) -> String {
        let mut command = Command::new("git");
        command
            .args([
                "-c",
                "maintenance.auto=false",
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
            ])
            .args(args)
            .current_dir(cwd);
        self.environment_without_cwd(&mut command);
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    fn environment_without_cwd(&self, command: &mut Command) {
        command
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.home.join(".gitconfig"))
            .env("GIT_CONFIG_COUNT", "2")
            .env("GIT_CONFIG_KEY_0", "commit.gpgsign")
            .env("GIT_CONFIG_VALUE_0", "false")
            .env("GIT_CONFIG_KEY_1", "maintenance.auto")
            .env("GIT_CONFIG_VALUE_1", "false");
    }

    fn run(&self, args: &[&str]) -> Output {
        self.run_with_path(args, None)
    }

    #[cfg(unix)]
    fn run_source(&self, args: &[&str]) -> Output {
        let mut command = Command::new("node");
        command
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"))
            .args(args);
        self.environment(&mut command);
        command.output().unwrap()
    }

    fn run_with_path(&self, args: &[&str], path: Option<&std::ffi::OsStr>) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_arashi"));
        command.args(args);
        self.environment(&mut command);
        if let Some(path) = path {
            command.env("PATH", path);
        }
        command.output().unwrap()
    }

    fn standalone(&self) -> PathBuf {
        fs::create_dir(self.root.join(".worktrees")).unwrap();
        fs::write(self.root.join(".git/info/exclude"), ".worktrees/\n").unwrap();
        self.git(
            &self.root,
            &["worktree", "add", "-b", "feature", ".worktrees/feature"],
        );
        self.root.join(".worktrees/feature")
    }

    fn configured(&self) -> PathBuf {
        let child = self.root.join("repos/alpha");
        fs::create_dir_all(&child).unwrap();
        self.git(&child, &["init", "-b", "main"]);
        fs::write(child.join("tracked"), "alpha base\n").unwrap();
        self.git(&child, &["add", "tracked"]);
        self.git(&child, &["commit", "-m", "base"]);
        fs::create_dir_all(self.root.join(".arashi")).unwrap();
        fs::write(
            self.root.join(".arashi/config.json"),
            r#"{"version":"1.0.0","reposDir":"repos","worktreesDir":".arashi/worktrees","repos":{"alpha":{"path":"repos/alpha"}}}"#,
        )
        .unwrap();
        fs::write(self.root.join(".gitignore"), "repos/\n.arashi/worktrees/\n").unwrap();
        self.git(&self.root, &["add", ".arashi/config.json", ".gitignore"]);
        self.git(&self.root, &["commit", "-m", "config"]);
        let target = self.root.join(".arashi/worktrees/feature");
        self.git(
            &self.root,
            &["worktree", "add", "-b", "feature", target.to_str().unwrap()],
        );
        fs::create_dir_all(target.join("repos")).unwrap();
        self.git(
            &child,
            &[
                "worktree",
                "add",
                "-b",
                "feature",
                target.join("repos/alpha").to_str().unwrap(),
            ],
        );
        target
    }

    fn status(&self, cwd: &Path) -> String {
        self.git(cwd, &["status", "--porcelain=v1", "-uall"])
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn document(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "{error}: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

#[cfg(unix)]
#[test]
fn standalone_moves_index_worktree_and_untracked_changes() {
    let fixture = Fixture::new();
    let target = fixture.standalone();
    fs::write(fixture.root.join("tracked"), "staged\n").unwrap();
    fixture.git(&fixture.root, &["add", "tracked"]);
    fs::write(fixture.root.join("tracked"), "worktree\n").unwrap();
    fs::write(fixture.root.join("untracked"), "new\n").unwrap();

    let output = fixture.run(&["move", "--from", "main", "--to", "feature", "--json"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let data = &document(&output)["data"];
    assert_eq!(data["mode"], "standalone");
    assert_eq!(data["movedCount"], 1);
    assert_eq!(
        data["results"][0]["message"],
        "Moved 1 staged, 1 modified, 1 untracked"
    );
    assert!(fixture.status(&fixture.root).is_empty());
    assert_eq!(
        fs::read_to_string(target.join("tracked")).unwrap(),
        "worktree\n"
    );
    assert_eq!(
        fs::read_to_string(target.join("untracked")).unwrap(),
        "new\n"
    );
    assert!(fixture.status(&target).contains("MM tracked"));
    assert!(fixture.status(&target).contains("?? untracked"));
    assert!(fixture.git(&fixture.root, &["stash", "list"]).is_empty());
}

#[cfg(unix)]
#[test]
fn implicit_current_source_moves_changes() {
    let fixture = Fixture::new();
    let target = fixture.standalone();
    fs::write(fixture.root.join("tracked"), "staged\n").unwrap();
    fixture.git(&fixture.root, &["add", "tracked"]);
    fs::write(fixture.root.join("tracked"), "worktree\n").unwrap();
    fs::write(fixture.root.join("untracked"), "new\n").unwrap();

    let output = fixture.run(&["move", "--to", "feature", "--json"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let data = &document(&output)["data"];
    assert_eq!(data["mode"], "standalone");
    assert_eq!(data["movedCount"], 1);
    assert_eq!(
        data["results"][0]["message"],
        "Moved 1 staged, 1 modified, 1 untracked"
    );
    assert!(fixture.status(&fixture.root).is_empty());
    assert_eq!(
        fs::read_to_string(target.join("tracked")).unwrap(),
        "worktree\n"
    );
    assert_eq!(
        fs::read_to_string(target.join("untracked")).unwrap(),
        "new\n"
    );
    assert!(fixture.status(&target).contains("MM tracked"));
    assert!(fixture.status(&target).contains("?? untracked"));
    assert!(fixture.git(&fixture.root, &["stash", "list"]).is_empty());
}

#[cfg(unix)]
#[test]
fn configured_moves_all_matching_repositories_in_source_order() {
    let fixture = Fixture::new();
    let target = fixture.configured();
    fs::write(fixture.root.join("tracked"), "meta changed\n").unwrap();
    fs::write(fixture.root.join("repos/alpha/tracked"), "alpha changed\n").unwrap();

    let output = fixture.run(&["move", "--from", "main", "--to", "feature", "--json"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let data = &document(&output)["data"];
    assert_eq!(data["mode"], "configured");
    assert_eq!(data["movedCount"], 2);
    assert_eq!(data["results"][0]["repositoryName"], "workspace");
    assert_eq!(data["results"][1]["repositoryName"], "alpha");
    assert_eq!(
        fs::read_to_string(target.join("tracked")).unwrap(),
        "meta changed\n"
    );
    assert_eq!(
        fs::read_to_string(target.join("repos/alpha/tracked")).unwrap(),
        "alpha changed\n"
    );
    assert!(fixture.status(&fixture.root).is_empty());
    assert!(fixture.status(&fixture.root.join("repos/alpha")).is_empty());
}

#[cfg(unix)]
#[test]
fn dirty_target_collision_is_nonmutating() {
    let fixture = Fixture::new();
    let target = fixture.standalone();
    fs::write(fixture.root.join("tracked"), "source\n").unwrap();
    fs::write(target.join("tracked"), "target\n").unwrap();
    let before_source = fixture.status(&fixture.root);
    let before_target = fixture.status(&target);

    let output = fixture.run(&["move", "--from", "main", "--to", "feature", "--json"]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        document(&output)["error"]["code"],
        "DIRTY_TARGET_REPOSITORY"
    );
    assert_eq!(fixture.status(&fixture.root), before_source);
    assert_eq!(fixture.status(&target), before_target);
    assert!(fixture.git(&fixture.root, &["stash", "list"]).is_empty());
}

#[cfg(unix)]
#[test]
fn canonical_path_aliases_are_the_same_workspace_without_mutation() {
    let fixture = Fixture::new();
    fixture.standalone();
    fs::write(fixture.root.join("tracked"), "source\n").unwrap();
    let alias = fixture.base.join("root-alias");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&fixture.root, &alias).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(&fixture.root, &alias).unwrap();
    let before = fixture.status(&fixture.root);

    let output = fixture.run(&[
        "move",
        "--from",
        "main",
        "--to",
        alias.to_str().unwrap(),
        "--json",
    ]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(document(&output)["error"]["code"], "SAME_WORKSPACE");
    assert_eq!(fixture.status(&fixture.root), before);
}

#[cfg(unix)]
#[test]
fn configured_create_policies_do_not_block_move() {
    for extra in [
        r#", "copy":["tracked"]"#,
        r#", "hooks":{"pre-create":"touch should-not-run"}"#,
    ] {
        let fixture = Fixture::new();
        let target = fixture.configured();
        let config = format!(
            r#"{{"version":"1.0.0","reposDir":"repos","worktreesDir":".arashi/worktrees","repos":{{"alpha":{{"path":"repos/alpha"{extra}}}}}}}"#
        );
        fs::write(fixture.root.join(".arashi/config.json"), config).unwrap();
        fs::write(fixture.root.join("tracked"), "source\n").unwrap();
        let before = fixture.status(&fixture.root);
        let output = fixture.run(&["move", "--from", "main", "--to", "feature", "--json"]);
        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(fixture.status(&fixture.root).is_empty());
        assert_eq!(fixture.status(&target), before);
        assert!(fixture.git(&fixture.root, &["stash", "list"]).is_empty());
    }
}

#[cfg(unix)]
#[test]
fn configured_missing_target_repository_skips_it_like_source() {
    let fixture = Fixture::new();
    let target = fixture.configured();
    fixture.git(
        &fixture.root.join("repos/alpha"),
        &[
            "worktree",
            "remove",
            "--force",
            target.join("repos/alpha").to_str().unwrap(),
        ],
    );
    fs::write(fixture.root.join("tracked"), "meta changed\n").unwrap();
    fs::write(fixture.root.join("repos/alpha/tracked"), "alpha changed\n").unwrap();

    let output = fixture.run(&["move", "--from", "main", "--to", "feature", "--json"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let data = &document(&output)["data"];
    assert_eq!(data["movedCount"], 1);
    assert_eq!(data["skippedCount"], 1);
    assert_eq!(data["results"][1]["repositoryName"], "alpha");
    assert_eq!(data["results"][1]["status"], "skipped");
    assert_eq!(
        data["results"][1]["message"],
        "Target workspace does not contain this repository"
    );
    assert!(!fixture.status(&fixture.root.join("repos/alpha")).is_empty());
}

#[cfg(unix)]
#[test]
fn clean_filter_is_rejected_before_status_can_execute_it() {
    let fixture = Fixture::new();
    fixture.standalone();
    fs::write(fixture.root.join("tracked"), "source with equal size\n").unwrap();
    let canary = fixture.base.join("filter-ran");
    let filter = format!("printf ran > '{}' ; cat", canary.display());
    fixture.git(&fixture.root, &["config", "filter.evil.clean", &filter]);
    fixture.git(&fixture.root, &["config", "filter.evil.required", "true"]);
    fs::write(fixture.root.join(".gitattributes"), "tracked filter=evil\n").unwrap();

    let output = fixture.run(&["move", "--from", "main", "--to", "feature", "--json"]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(document(&output)["error"]["code"], "RUST_NOT_YET_PORTED");
    assert!(
        !canary.exists(),
        "move status executed a configured clean filter"
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("tracked")).unwrap(),
        "source with equal size\n"
    );
    assert!(fixture.git(&fixture.root, &["stash", "list"]).is_empty());
}

#[cfg(unix)]
#[test]
fn coordinated_stash_drop_failure_rolls_back_every_repository() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let target = fixture.configured();
    fs::write(fixture.root.join("tracked"), "meta changed\n").unwrap();
    fs::write(fixture.root.join("repos/alpha/tracked"), "alpha changed\n").unwrap();
    let source_meta = fixture.status(&fixture.root);
    let source_child = fixture.status(&fixture.root.join("repos/alpha"));
    let bin = fixture.base.join("bin");
    fs::create_dir(&bin).unwrap();
    let real_git = String::from_utf8(
        Command::new("sh")
            .args(["-c", "command -v git"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    let wrapper = bin.join("git");
    let marker = fixture.base.join("drop-failed-once");
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\ncase \"$PWD:$*\" in *'/repos/alpha:'*'stash drop'*) if test ! -e '{}'; then : > '{}'; exit 42; fi;; esac\nexec {} \"$@\"\n",
            marker.display(), marker.display(), real_git.trim()
        ),
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());

    let output = fixture.run_with_path(
        &["move", "--from", "main", "--to", "feature", "--json"],
        Some(path.as_ref()),
    );
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(document(&output)["error"]["code"], "MOVE_FAILED");
    assert_eq!(
        document(&output)["error"]["details"]["rollbackErrors"],
        serde_json::json!([])
    );
    assert_eq!(fixture.status(&fixture.root), source_meta);
    assert_eq!(
        fixture.status(&fixture.root.join("repos/alpha")),
        source_child
    );
    assert!(fixture.status(&target).is_empty());
    assert!(fixture.status(&target.join("repos/alpha")).is_empty());
    assert!(fixture.git(&fixture.root, &["stash", "list"]).is_empty());
    assert!(
        fixture
            .git(&fixture.root.join("repos/alpha"), &["stash", "list"])
            .is_empty()
    );
}

#[cfg(unix)]
#[test]
fn stash_push_error_after_creation_restores_every_source() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let target = fixture.configured();
    fs::write(fixture.root.join("tracked"), "meta changed\n").unwrap();
    fs::write(fixture.root.join("repos/alpha/tracked"), "alpha changed\n").unwrap();
    let source_meta = fixture.status(&fixture.root);
    let source_child = fixture.status(&fixture.root.join("repos/alpha"));
    let bin = fixture.base.join("bin");
    fs::create_dir(&bin).unwrap();
    let real_git = String::from_utf8(
        Command::new("sh")
            .args(["-c", "command -v git"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    let wrapper = bin.join("git");
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\ncase \"$PWD:$*\" in *'/repos/alpha:'*'stash push'*) {} \"$@\"; exit 42;; esac\nexec {} \"$@\"\n",
            real_git.trim(), real_git.trim()
        ),
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());

    let output = fixture.run_with_path(
        &["move", "--from", "main", "--to", "feature", "--json"],
        Some(path.as_ref()),
    );
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(document(&output)["error"]["code"], "MOVE_FAILED");
    assert_eq!(
        document(&output)["error"]["details"]["rollbackErrors"],
        serde_json::json!([])
    );
    assert_eq!(fixture.status(&fixture.root), source_meta);
    assert_eq!(
        fixture.status(&fixture.root.join("repos/alpha")),
        source_child
    );
    assert!(fixture.status(&target).is_empty());
    assert!(fixture.status(&target.join("repos/alpha")).is_empty());
    assert!(fixture.git(&fixture.root, &["stash", "list"]).is_empty());
    assert!(
        fixture
            .git(&fixture.root.join("repos/alpha"), &["stash", "list"])
            .is_empty()
    );
}

#[cfg(unix)]
#[test]
fn caller_edits_after_apply_survive_failed_drop() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let target = fixture.configured();
    fs::write(fixture.root.join("tracked"), "meta changed\n").unwrap();
    fs::write(fixture.root.join("repos/alpha/tracked"), "alpha changed\n").unwrap();
    let source_meta = fixture.status(&fixture.root);
    let source_child = fixture.status(&fixture.root.join("repos/alpha"));
    let bin = fixture.base.join("bin");
    fs::create_dir(&bin).unwrap();
    let real_git = String::from_utf8(
        Command::new("sh")
            .args(["-c", "command -v git"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    let wrapper = bin.join("git");
    let marker = fixture.base.join("drop-failed-once");
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\ncase \"$PWD:$*\" in *'/repos/alpha:'*'stash drop'*) if test ! -e '{}'; then : > '{}'; printf caller > '{}'; printf caller-tracked > '{}'; exit 42; fi;; esac\nexec {} \"$@\"\n",
            marker.display(), marker.display(), target.join("caller-owned").display(), target.join("tracked").display(), real_git.trim()
        ),
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());

    let output = fixture.run_with_path(
        &["move", "--from", "main", "--to", "feature", "--json"],
        Some(path.as_ref()),
    );
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(document(&output)["error"]["code"], "MOVE_FAILED");
    assert!(
        !document(&output)["error"]["details"]["rollbackErrors"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(fixture.status(&fixture.root), source_meta);
    assert_eq!(
        fixture.status(&fixture.root.join("repos/alpha")),
        source_child
    );
    assert_eq!(
        fs::read_to_string(target.join("caller-owned")).unwrap(),
        "caller"
    );
    assert_eq!(
        fs::read_to_string(target.join("tracked")).unwrap(),
        "caller-tracked"
    );
    assert!(fixture.status(&target.join("repos/alpha")).is_empty());
    assert!(fixture.git(&fixture.root, &["stash", "list"]).is_empty());
    assert!(
        fixture
            .git(&fixture.root.join("repos/alpha"), &["stash", "list"])
            .is_empty()
    );
}

#[cfg(unix)]
#[test]
fn caller_target_change_detected_before_apply_is_preserved_during_rollback() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let target = fixture.configured();
    fs::write(fixture.root.join("tracked"), "meta changed\n").unwrap();
    fs::write(fixture.root.join("repos/alpha/tracked"), "alpha changed\n").unwrap();
    let source_meta = fixture.status(&fixture.root);
    let source_child = fixture.status(&fixture.root.join("repos/alpha"));
    let caller = target.join("caller-owned");
    let bin = fixture.base.join("bin-change");
    fs::create_dir(&bin).unwrap();
    let real_git = String::from_utf8(
        Command::new("sh")
            .args(["-c", "command -v git"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    let wrapper = bin.join("git");
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\ncase \"$PWD:$*\" in *'/repos/alpha:'*'stash push'*) printf caller > '{}';; esac\nexec {} \"$@\"\n",
            caller.display(), real_git.trim()
        ),
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());

    let output = fixture.run_with_path(
        &["move", "--from", "main", "--to", "feature", "--json"],
        Some(path.as_ref()),
    );
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(document(&output)["error"]["code"], "MOVE_FAILED");
    assert_eq!(fs::read_to_string(&caller).unwrap(), "caller");
    assert_eq!(fixture.status(&fixture.root), source_meta);
    assert_eq!(
        fixture.status(&fixture.root.join("repos/alpha")),
        source_child
    );
    assert!(fixture.status(&target).contains("?? caller-owned"));
    assert!(fixture.status(&target.join("repos/alpha")).is_empty());
}

#[cfg(unix)]
fn scrub_paths(value: &mut Value, base: &Path) {
    match value {
        Value::String(text) => *text = text.replace(&base.to_string_lossy().to_string(), "<BASE>"),
        Value::Array(values) => values.iter_mut().for_each(|value| scrub_paths(value, base)),
        Value::Object(values) => values
            .values_mut()
            .for_each(|value| scrub_paths(value, base)),
        _ => {}
    }
}

#[cfg(unix)]
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn source_and_native_json_envelopes_match_for_standalone_and_configured_moves() {
    for (configured, implicit) in [(false, false), (false, true), (true, false), (true, true)] {
        let source = Fixture::new();
        let native = Fixture::new();
        if configured {
            source.configured();
            native.configured();
            for fixture in [&source, &native] {
                let config_path = fixture.root.join(".arashi/config.json");
                let mut config: Value =
                    serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
                config["repos"]["alpha"]["copy"] = serde_json::json!(["tracked"]);
                config["repos"]["alpha"]["hooks"] = serde_json::json!({"pre-create":"exit 42"});
                fs::write(config_path, serde_json::to_vec(&config).unwrap()).unwrap();
            }
            fs::write(source.root.join("repos/alpha/tracked"), "alpha changed\n").unwrap();
            fs::write(native.root.join("repos/alpha/tracked"), "alpha changed\n").unwrap();
        } else {
            source.standalone();
            native.standalone();
        }
        fs::write(source.root.join("tracked"), "meta changed\n").unwrap();
        fs::write(native.root.join("tracked"), "meta changed\n").unwrap();
        for fixture in [&source, &native] {
            fixture.git(&fixture.root, &["add", "tracked"]);
            fs::write(fixture.root.join("tracked"), "unstaged bytes\n").unwrap();
            fs::write(fixture.root.join("untracked"), "untracked bytes\n").unwrap();
        }
        let args = if implicit {
            vec!["move", "--to", "feature", "--json"]
        } else {
            vec!["move", "--from", "main", "--to", "feature", "--json"]
        };
        let source_output = source.run_source(&args);
        let native_output = native.run(&args);
        assert_eq!(source_output.status.code(), native_output.status.code());
        assert_eq!(source_output.stderr, native_output.stderr);
        let mut source_json = document(&source_output);
        let mut native_json = document(&native_output);
        scrub_paths(&mut source_json, &source.base);
        scrub_paths(&mut native_json, &native.base);
        assert_eq!(source_json, native_json);
        let target = if configured {
            ".arashi/worktrees/feature"
        } else {
            ".worktrees/feature"
        };
        for relative in ["", target] {
            for git_args in [
                vec!["status", "--porcelain=v1", "-uall"],
                vec!["diff", "--binary"],
                vec!["diff", "--cached", "--binary"],
                vec!["stash", "list"],
            ] {
                assert_eq!(
                    source.git(&source.root.join(relative), &git_args),
                    native.git(&native.root.join(relative), &git_args)
                );
            }
        }
        assert_eq!(
            fs::read(source.root.join(target).join("untracked")).unwrap(),
            fs::read(native.root.join(target).join("untracked")).unwrap()
        );
    }
}

#[test]
fn interactive_target_selection_remains_explicitly_unsupported() {
    let fixture = Fixture::new();
    fixture.standalone();
    fs::write(fixture.root.join("tracked"), "source\n").unwrap();
    let before = fixture.status(&fixture.root);
    for args in [
        vec!["move", "--json"],
        vec!["move", "--from", "main", "--json"],
    ] {
        let output = fixture.run(&args);
        assert_eq!(output.status.code(), Some(1));
        assert_eq!(document(&output)["error"]["code"], "RUST_NOT_YET_PORTED");
        assert_eq!(fixture.status(&fixture.root), before);
    }
}

#[cfg(unix)]
#[test]
fn existing_caller_stash_survives_success() {
    let fixture = Fixture::new();
    fixture.standalone();
    fs::write(fixture.root.join("tracked"), "caller saved\n").unwrap();
    fixture.git(&fixture.root, &["stash", "push", "-m", "caller-owned"]);
    let stash = fixture.git(&fixture.root, &["rev-parse", "refs/stash"]);
    fs::write(fixture.root.join("tracked"), "move me\n").unwrap();
    let output = fixture.run(&["move", "--to", "feature", "--json"]);
    assert!(output.status.success());
    assert_eq!(
        fixture.git(&fixture.root, &["rev-parse", "refs/stash"]),
        stash
    );
}

#[cfg(unix)]
#[test]
fn conflicting_apply_restores_source_index_and_untracked_bytes() {
    let fixture = Fixture::new();
    let target = fixture.standalone();
    fs::write(target.join("tracked"), "target commit\n").unwrap();
    fixture.git(&target, &["add", "tracked"]);
    fixture.git(&target, &["commit", "-m", "target divergence"]);
    fs::write(fixture.root.join("tracked"), "staged source\n").unwrap();
    fixture.git(&fixture.root, &["add", "tracked"]);
    fs::write(fixture.root.join("tracked"), "unstaged source\n").unwrap();
    fs::write(fixture.root.join("untracked"), "source untracked\n").unwrap();
    let index = fixture.git(&fixture.root, &["diff", "--cached", "--binary"]);
    let worktree = fixture.git(&fixture.root, &["diff", "--binary"]);
    let output = fixture.run(&["move", "--to", "feature", "--json"]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        fixture.git(&fixture.root, &["diff", "--cached", "--binary"]),
        index
    );
    assert_eq!(fixture.git(&fixture.root, &["diff", "--binary"]), worktree);
    assert_eq!(
        fs::read_to_string(fixture.root.join("untracked")).unwrap(),
        "source untracked\n"
    );
    assert!(
        !document(&output)["error"]["details"]["rollbackErrors"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[cfg(unix)]
#[test]
fn ignored_target_collision_preserves_caller_bytes() {
    let fixture = Fixture::new();
    let target = fixture.standalone();
    fs::write(
        fixture.root.join(".git/info/exclude"),
        ".worktrees/\nprivate\n",
    )
    .unwrap();
    fs::write(fixture.root.join("private"), "source staged\n").unwrap();
    fixture.git(&fixture.root, &["add", "-f", "private"]);
    fs::write(target.join("private"), "caller ignored\n").unwrap();
    let output = fixture.run(&["move", "--to", "feature", "--json"]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        fs::read_to_string(target.join("private")).unwrap(),
        "caller ignored\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("private")).unwrap(),
        "source staged\n"
    );
    assert!(fixture.status(&fixture.root).contains("A  private"));
}

#[cfg(unix)]
#[test]
fn ignored_target_collision_with_staged_then_deleted_file_preserves_caller_bytes() {
    let fixture = Fixture::new();
    let target = fixture.standalone();
    fs::write(
        fixture.root.join(".git/info/exclude"),
        ".worktrees/\nprivate\n",
    )
    .unwrap();
    fs::write(fixture.root.join("private"), "source staged\n").unwrap();
    fixture.git(&fixture.root, &["add", "-f", "private"]);
    fs::remove_file(fixture.root.join("private")).unwrap();
    fs::write(target.join("private"), "caller ignored\n").unwrap();
    let output = fixture.run(&["move", "--to", "feature", "--json"]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        fs::read_to_string(target.join("private")).unwrap(),
        "caller ignored\n"
    );
    assert!(!fixture.root.join("private").exists());
    assert!(fixture.status(&fixture.root).contains("AD private"));
}
