use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn standalone() -> Self {
        let fixture = Self::repository("standalone");
        fs::create_dir(fixture.root.join(".worktrees")).unwrap();
        fs::write(fixture.root.join(".git/info/exclude"), ".worktrees/\n").unwrap();
        fixture
    }

    fn configured(mode: &str) -> Self {
        let fixture = Self::repository("configured");
        let child = fixture.root.join("repos/api");
        fs::create_dir_all(&child).unwrap();
        fixture.git_at(&child, &["init", "-b", "main"]);
        fixture.commit_at(&child);
        fs::create_dir_all(fixture.root.join(".arashi")).unwrap();
        fs::write(
            fixture.root.join(".arashi/config.json"),
            format!(
                r#"{{"version":"1.0.0","reposDir":"repos","worktreesDir":".arashi/worktrees","defaults":{{"switch":{{"mode":"{mode}"}}}},"repos":{{"api":{{"path":"repos/api"}}}}}}"#,
            ),
        )
        .unwrap();
        fixture.commit_at(&fixture.root);
        fixture
    }

    fn configure_child_path(&self, mode: &str, path: &Path) {
        fs::write(
            self.root.join(".arashi/config.json"),
            serde_json::json!({
                "version": "1.0.0",
                "reposDir": "repos",
                "worktreesDir": ".arashi/worktrees",
                "defaults": {"switch": {"mode": mode}},
                "repos": {"api": {"path": path}},
            })
            .to_string(),
        )
        .unwrap();
    }

    fn repository(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "arashi-rust-switch-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&path).unwrap();
        let fixture = Self {
            root: arashi::paths::canonicalize(&path).unwrap(),
        };
        fixture.git(&["init", "-b", "main"]);
        fixture.commit_at(&fixture.root);
        fixture
    }

    fn commit_at(&self, path: &Path) {
        let marker = path.join("seed");
        if !marker.exists() {
            fs::write(&marker, "seed\n").unwrap();
        }
        self.git_at(path, &["add", "."]);
        self.git_at(
            path,
            &[
                "-c",
                "commit.gpgsign=false",
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-m",
                "seed",
            ],
        );
    }

    fn git(&self, args: &[&str]) -> String {
        self.git_at(&self.root, args)
    }

    fn git_at(&self, path: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    fn add_worktree(&self, branch: &str, relative: &str) -> PathBuf {
        let path = self.root.join(relative);
        self.git(&["worktree", "add", "-b", branch, path.to_str().unwrap()]);
        arashi::paths::canonicalize(&path).unwrap()
    }

    fn run(&self, args: &[&str], directive: Option<&Path>) -> Output {
        self.run_with(args, directive, false)
    }

    fn run_with(&self, args: &[&str], directive: Option<&Path>, source: bool) -> Output {
        let mut command = if source {
            let mut command = Command::new("node");
            command.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"));
            command
        } else {
            Command::new(env!("CARGO_BIN_EXE_arashi"))
        };
        command.args(args).current_dir(&self.root);
        command.env_remove("TMUX");
        command.env_remove("HERDR_ENV");
        command.env_remove("CMUX_WORKSPACE_ID");
        command.env_remove("CMUX_SURFACE_ID");
        command.env_remove("KITTY_PID");
        command.env_remove("KITTY_WINDOW_ID");
        command.env_remove("TERM_PROGRAM");
        command.env("TERM", "dumb");
        command.env_remove("VSCODE_GIT_ASKPASS_NODE");
        command.env_remove("VSCODE_GIT_ASKPASS_EXTRA_ARGS");
        if let Some(path) = directive {
            command
                .env("ARASHI_DIRECTIVE_FILE", path)
                .env("ARASHI_SHELL", "bash");
        } else {
            command
                .env_remove("ARASHI_DIRECTIVE_FILE")
                .env_remove("ARASHI_SHELL");
        }
        command.output().unwrap()
    }

    fn snapshot(&self) -> (String, String, String) {
        (
            self.git(&["branch", "--format=%(refname:short)"]),
            self.git(&["status", "--porcelain=v1", "--untracked-files=all"]),
            self.git(&["worktree", "list", "--porcelain"]),
        )
    }

    fn directive(&self) -> PathBuf {
        self.root.with_extension("directive")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_file(self.directive());
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[cfg(unix)]
fn wrapper_switch_journey(shell: &str) {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let fixture = Fixture::configured("cd");
    let target = fixture.add_worktree(
        "wrapper-target",
        ".arashi/worktrees/space ' dollar$ slash\\ target",
    );
    let before = fixture.snapshot();
    let home = fixture.root.with_extension("wrapper-home");
    fs::create_dir_all(home.join("bin")).unwrap();
    fs::create_dir_all(home.join("tmp")).unwrap();
    let mut paths = vec![home.join("bin")];
    paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap()));
    let path = std::env::join_paths(paths).unwrap();
    for source in [false, true] {
        if source && std::env::var_os("ARASHI_TS_PARITY").is_none() {
            continue;
        }
        let executable = home.join("bin/arashi");
        if source {
            fs::remove_file(&executable).unwrap();
            fs::write(
                &executable,
                "#!/bin/sh\nexec node \"$ARASHI_SOURCE_ENTRY\" \"$@\"\n",
            )
            .unwrap();
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        } else {
            symlink(env!("CARGO_BIN_EXE_arashi"), &executable).unwrap();
            symlink("arashi", home.join("bin/aw")).unwrap();
        }
        let mut init = Command::new(&executable);
        let output = init
            .args(["shell", "init", shell])
            .env("HOME", &home)
            .env(
                "ARASHI_SOURCE_ENTRY",
                Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"),
            )
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        fs::write(home.join("wrapper"), &output.stdout).unwrap();
        let script = if shell == "fish" {
            "source \"$HOME/wrapper\"; arashi switch wrapper-target; or exit 31; test (pwd -P) = \"$EXPECTED_TARGET\"; or exit 32; aw switch --cd --path \"$EXPECTED_ROOT\"; or exit 33; test (pwd -P) = \"$EXPECTED_ROOT\"; or exit 34; aw switch definitely-missing-target; and exit 35; test (pwd -P) = \"$EXPECTED_ROOT\"; or exit 36; set -q ARASHI_DIRECTIVE_FILE; and exit 37; exit 0"
        } else {
            ". \"$HOME/wrapper\"; arashi switch wrapper-target || exit 31; [ \"$(pwd -P)\" = \"$EXPECTED_TARGET\" ] || exit 32; aw switch --cd --path \"$EXPECTED_ROOT\" || exit 33; [ \"$(pwd -P)\" = \"$EXPECTED_ROOT\" ] || exit 34; aw switch definitely-missing-target && exit 35; [ \"$(pwd -P)\" = \"$EXPECTED_ROOT\" ] || exit 36; [ -z \"${ARASHI_DIRECTIVE_FILE+x}\" ] || exit 37; exit 0"
        };
        let mut command = Command::new(shell);
        if shell == "bash" {
            command.args(["--noprofile", "--norc"]);
        }
        if shell == "zsh" {
            command.arg("-f");
        }
        if shell == "fish" {
            command.arg("--no-config");
        }
        let output = command
            .args(["-c", script])
            .current_dir(&fixture.root)
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env("TMPDIR", home.join("tmp"))
            .env("PATH", &path)
            .env("EXPECTED_TARGET", &target)
            .env("EXPECTED_ROOT", &fixture.root)
            .env(
                "ARASHI_SOURCE_ENTRY",
                Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"),
            )
            .env("NO_COLOR", "1")
            .env("TERM", "dumb")
            .env_remove("ARASHI_DIRECTIVE_FILE")
            .env_remove("ARASHI_SHELL")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{shell} source={source}: {output:?}"
        );
        assert_eq!(fs::read_dir(home.join("tmp")).unwrap().count(), 0);
        assert_eq!(fixture.snapshot(), before);
    }
    fs::remove_dir_all(home).unwrap();
}

#[cfg(unix)]
#[test]
fn bash_wrapper_switches_real_parent_shell_and_cleans_directives() {
    wrapper_switch_journey("bash");
}

#[cfg(target_os = "macos")]
#[test]
fn zsh_wrapper_switches_real_parent_shell_and_cleans_directives() {
    wrapper_switch_journey("zsh");
}

#[cfg(unix)]
#[test]
fn fish_wrapper_switches_real_parent_shell_and_cleans_directives() {
    if Command::new("fish").arg("--version").output().is_err() {
        eprintln!("Fish journey not exercised: Fish is not installed on this host");
        return;
    }
    wrapper_switch_journey("fish");
}

fn error_document(output: &Output) -> serde_json::Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|_| {
        panic!(
            "stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

#[test]
fn json_guard_precedes_conflicts_discovery_and_directive_writes() {
    let fixture = Fixture::standalone();
    let directive = fixture.root.join("must-not-exist");
    let before = fixture.snapshot();
    let output = fixture.run(&["switch", "--json", "--cd", "--tmux"], Some(&directive));
    assert_eq!(output.status.code(), Some(2));
    let document = error_document(&output);
    assert_eq!(document["command"], "switch");
    assert_eq!(document["error"]["code"], "JSON_UNSUPPORTED_FOR_MODE");
    assert_eq!(document["error"]["details"]["mode"], "launch");
    assert!(output.stderr.is_empty());
    assert!(!directive.exists());
    assert_eq!(fixture.snapshot(), before);
}

#[test]
fn multiple_launchers_take_precedence_over_cd_conflict() {
    let fixture = Fixture::standalone();
    let directive = fixture.directive();
    let before = fixture.snapshot();
    let output = fixture.run(
        &["switch", "main", "--cd", "--tmux", "--sesh"],
        Some(&directive),
    );
    assert_eq!(output.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("Conflicting launch overrides provided (--tmux, --sesh)")
    );
    assert!(!directive.exists());
    if std::env::var_os("ARASHI_TS_PARITY").is_some() {
        let source = fixture.run_with(
            &["switch", "main", "--cd", "--tmux", "--sesh"],
            Some(&directive),
            true,
        );
        assert_eq!(source.status.code(), output.status.code());
        assert!(
            String::from_utf8_lossy(&source.stderr)
                .contains("Conflicting launch overrides provided (--tmux, --sesh)")
        );
        assert!(!directive.exists());
    }
    assert_eq!(fixture.snapshot(), before);
}

#[test]
fn standalone_current_and_branch_targets_write_source_compatible_directives() {
    let fixture = Fixture::standalone();
    let feature = fixture.add_worktree("feature/safe", ".worktrees/feature/safe");
    let directive = fixture.directive();
    let before = fixture.snapshot();

    let current = fixture.run(&["switch", "main", "--cd"], Some(&directive));
    assert!(current.status.success(), "{current:?}");
    assert_eq!(
        fs::read_to_string(&directive).unwrap(),
        format!("cd -- '{}'\n", fixture.root.display())
    );

    let branch = fixture.run(&["switch", "feature/safe", "--cd"], Some(&directive));
    assert!(branch.status.success(), "{branch:?}");
    assert_eq!(
        fs::read_to_string(&directive).unwrap(),
        format!("cd -- '{}'\n", feature.display())
    );
    assert_eq!(fixture.snapshot(), before);
}

#[test]
fn exact_path_selects_one_target_and_missing_path_is_nonmutating() {
    let fixture = Fixture::standalone();
    let feature = fixture.add_worktree("feature", ".worktrees/feature");
    let directive = fixture.directive();
    let before = fixture.snapshot();

    let selected = fixture.run(
        &["switch", feature.to_str().unwrap(), "--path", "--cd"],
        Some(&directive),
    );
    assert!(selected.status.success(), "{selected:?}");
    assert!(
        fs::read_to_string(&directive)
            .unwrap()
            .contains(feature.to_str().unwrap())
    );

    fs::remove_file(&directive).unwrap();
    let missing = fixture.run(&["switch", "missing", "--path", "--cd"], Some(&directive));
    assert_eq!(missing.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&missing.stderr).contains("No worktree exists at exact path"));
    assert!(!directive.exists());
    assert_eq!(fixture.snapshot(), before);
}

#[test]
fn ambiguous_noninteractive_selection_rejects_before_directive_write() {
    let fixture = Fixture::standalone();
    fixture.add_worktree("feature", ".worktrees/feature");
    let directive = fixture.directive();
    let before = fixture.snapshot();
    let output = fixture.run(&["switch", "--cd"], Some(&directive));
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("Found 2 matching worktrees"));
    assert!(!directive.exists());
    assert_eq!(fixture.snapshot(), before);
}

#[test]
fn configured_parent_repos_and_all_scopes_select_source_candidates() {
    let fixture = Fixture::configured("cd");
    let parent_topic = fixture.add_worktree("topic", ".arashi/worktrees/topic");
    let directive = fixture.directive();
    let before = fixture.snapshot();

    let parent = fixture.run(&["switch", "topic"], Some(&directive));
    assert!(parent.status.success(), "{parent:?}");
    assert!(
        fs::read_to_string(&directive)
            .unwrap()
            .contains(parent_topic.to_str().unwrap())
    );

    let child = fixture.run(&["switch", "api", "--repos"], Some(&directive));
    assert!(child.status.success(), "{child:?}");
    assert!(
        fs::read_to_string(&directive)
            .unwrap()
            .contains(fixture.root.join("repos/api").to_str().unwrap())
    );

    let all = fixture.run(&["switch", "api", "--all"], Some(&directive));
    assert!(all.status.success(), "{all:?}");
    assert!(
        fs::read_to_string(&directive)
            .unwrap()
            .contains(fixture.root.join("repos/api").to_str().unwrap())
    );
    assert_eq!(fixture.snapshot(), before);
}

#[test]
fn repos_no_match_lists_available_repositories_without_effects() {
    let fixture = Fixture::configured("cd");
    let directive = fixture.directive();
    let before = fixture.snapshot();
    let output = fixture.run(&["switch", "missing", "--repos"], Some(&directive));
    assert_eq!(output.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("No child repository matched `missing`. Available repositories: api")
    );
    assert!(!directive.exists());
    assert_eq!(fixture.snapshot(), before);
}

#[test]
fn explicit_cd_overrides_configured_launcher_without_launching() {
    for mode in ["launch", "sesh", "herdr"] {
        let fixture = Fixture::configured(mode);
        let directive = fixture.directive();
        let before = fixture.snapshot();
        let output = fixture.run(&["switch", "main", "--cd"], Some(&directive));
        assert!(output.status.success(), "mode={mode}: {output:?}");
        assert_eq!(
            fs::read_to_string(&directive).unwrap(),
            format!("cd -- '{}'\n", fixture.root.display())
        );
        assert_eq!(fixture.snapshot(), before);
    }
}

#[test]
fn unsupported_explicit_and_configured_launchers_fail_before_effects() {
    let explicit = [
        "--launch", "--tab", "--tmux", "--sesh", "--herdr", "--vscode", "--cursor", "--kiro",
        "--no-cd",
    ];
    for option in explicit {
        let fixture = Fixture::standalone();
        let directive = fixture.directive();
        let before = fixture.snapshot();
        let output = fixture.run(&["switch", "main", option], Some(&directive));
        assert!(!output.status.success(), "option={option}: {output:?}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("not yet ported"));
        assert!(!directive.exists());
        assert_eq!(fixture.snapshot(), before);
    }

    for mode in ["launch", "sesh", "herdr"] {
        let fixture = Fixture::configured(mode);
        let directive = fixture.directive();
        let before = fixture.snapshot();
        let output = fixture.run(&["switch", "main"], Some(&directive));
        assert!(!output.status.success(), "mode={mode}: {output:?}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("not yet ported"));
        assert!(!directive.exists());
        assert_eq!(fixture.snapshot(), before);
    }
}

#[test]
fn configured_auto_rejects_managed_context_but_uses_plain_shell_integration() {
    let fixture = Fixture::configured("auto");
    let directive = fixture.directive();
    let mut command = Command::new(env!("CARGO_BIN_EXE_arashi"));
    let rejected = command
        .args(["switch", "main"])
        .current_dir(&fixture.root)
        .env("ARASHI_DIRECTIVE_FILE", &directive)
        .env("ARASHI_SHELL", "bash")
        .env("TMUX", "/tmp/tmux")
        .output()
        .unwrap();
    assert!(!rejected.status.success(), "{rejected:?}");
    assert!(!directive.exists());

    let accepted = fixture.run(&["switch", "main"], Some(&directive));
    assert!(accepted.status.success(), "{accepted:?}");
    assert!(
        fs::read_to_string(&directive)
            .unwrap()
            .contains(fixture.root.to_str().unwrap())
    );
}

#[test]
fn explicit_cd_without_shell_integration_is_a_safe_source_compatible_noop() {
    let fixture = Fixture::standalone();
    let before = fixture.snapshot();
    let output = fixture.run(&["switch", "main", "--cd"], None);
    assert!(output.status.success(), "{output:?}");
    assert!(output.stdout.is_empty(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("Shell integration is not active"));
    assert!(String::from_utf8_lossy(&output.stderr).contains("Hint: run `arashi shell install`"));
    if std::env::var_os("ARASHI_TS_PARITY").is_some() {
        let source = fixture.run_with(&["switch", "main", "--cd"], None, true);
        assert_eq!(source.status.code(), output.status.code());
        // Source also prints workspace context and its install hint to stdout;
        // the native subset promises no prepared-switch success on a no-op,
        // not byte-identical human rendering.
        assert!(
            !String::from_utf8_lossy(&source.stdout).contains("Prepared shell directory switch")
        );
        assert!(
            String::from_utf8_lossy(&source.stderr).contains("Shell integration is not active")
        );
    }
    assert_eq!(fixture.snapshot(), before);
}

#[test]
fn traversing_absolute_child_path_is_rejected_before_selection_or_directive_write() {
    let fixture = Fixture::configured("cd");
    let external = Fixture::repository("external");
    let configured_path = fixture
        .root
        .join("..")
        .join(external.root.file_name().unwrap());
    fixture.configure_child_path("cd", &configured_path);
    let directive = fixture.directive();
    fs::write(&directive, "existing directive\n").unwrap();
    let before = fixture.snapshot();
    let external_before = external.snapshot();

    let output = fixture.run(
        &[
            "switch",
            external.root.to_str().unwrap(),
            "--all",
            "--path",
            "--cd",
        ],
        Some(&directive),
    );

    assert!(!output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("External switch repository paths"));
    assert_eq!(
        fs::read_to_string(&directive).unwrap(),
        "existing directive\n"
    );
    assert_eq!(fixture.snapshot(), before);
    assert_eq!(external.snapshot(), external_before);
}
