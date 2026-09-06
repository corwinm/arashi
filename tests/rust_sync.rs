use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
    temp: PathBuf,
    root: PathBuf,
    home: PathBuf,
}

impl Fixture {
    fn new(names: &[&str]) -> Self {
        let temp = std::env::temp_dir().join(format!(
            "arashi-sync-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&temp).unwrap();
        let temp = arashi::paths::canonicalize(&temp).unwrap();
        let root = temp.join("workspace");
        let home = temp.join("home");
        fs::create_dir(&home).unwrap();
        init(&root);
        fs::create_dir(root.join(".arashi")).unwrap();
        for name in names {
            init(&root.join("repos").join(name));
        }
        let repos = names
            .iter()
            .map(|name| {
                format!(
                    "{}:{{\"path\":{},\"groups\":{}}}",
                    serde_json::to_string(name).unwrap(),
                    serde_json::to_string(&format!("repos/{name}")).unwrap(),
                    if *name == "alpha" {
                        "[\"core\",\"docs\"]"
                    } else {
                        "[\"core\"]"
                    }
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        fs::write(
            root.join(".arashi/config.json"),
            format!("{{\"version\":\"1.0.0\",\"reposDir\":\"repos\",\"repos\":{{{repos}}}}}"),
        )
        .unwrap();
        Self { temp, root, home }
    }
    fn repo(&self, name: &str) -> PathBuf {
        self.root.join("repos").join(name)
    }
    fn config(&self, value: Value) {
        fs::write(
            self.root.join(".arashi/config.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    }
    fn run(&self, args: &[&str]) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_arashi"));
        command.args(args).current_dir(&self.root);
        isolated(&mut command, &self.home);
        command.output().unwrap()
    }
    fn run_with_path(&self, args: &[&str], path: &str) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_arashi"));
        command.args(args).current_dir(&self.root).env("PATH", path);
        isolated(&mut command, &self.home);
        command.output().unwrap()
    }
    fn json(&self, args: &[&str]) -> (Output, Value) {
        let output = self.run(args);
        let value = serde_json::from_slice(&output.stdout).unwrap_or_else(|_| {
            panic!(
                "stdout={} stderr={}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
        });
        (output, value)
    }
    fn snapshot(&self) -> Vec<(PathBuf, Vec<u8>)> {
        snapshot(&self.temp)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.temp);
    }
}

fn isolated(command: &mut Command, home: &Path) {
    command
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("XDG_CONFIG_HOME", home)
        .env("GIT_CONFIG_GLOBAL", home.join("gitconfig"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0");
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(["-c", "commit.gpgsign=false", "-c", "maintenance.auto=false"])
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

fn init(root: &Path) {
    fs::create_dir_all(root).unwrap();
    git(root, &["init", "-b", "main"]);
    git(root, &["config", "user.name", "Test"]);
    git(root, &["config", "user.email", "test@example.invalid"]);
    fs::write(root.join("tracked"), "initial").unwrap();
    git(root, &["add", "tracked"]);
    git(root, &["commit", "-m", "initial"]);
}

fn branch(root: &Path) -> String {
    git(root, &["symbolic-ref", "--short", "HEAD"])
}

fn head(root: &Path, reference: &str) -> String {
    git(root, &["rev-parse", reference])
}

fn process_alive(pid_file: &Path) -> bool {
    let Ok(pid) = fs::read_to_string(pid_file) else {
        return false;
    };
    let Ok(output) = Command::new("ps")
        .args(["-p", pid.trim(), "-o", "stat="])
        .output()
    else {
        return false;
    };
    output.status.success()
        && !String::from_utf8_lossy(&output.stdout)
            .trim_start()
            .starts_with('Z')
}

fn snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    fn walk(root: &Path, path: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
        let mut entries = fs::read_dir(path)
            .unwrap()
            .map(|entry| entry.unwrap())
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let relative = path.strip_prefix(root).unwrap().to_owned();
            let metadata = fs::symlink_metadata(&path).unwrap();
            if metadata.file_type().is_symlink() {
                out.push((
                    relative,
                    fs::read_link(&path)
                        .unwrap()
                        .as_os_str()
                        .as_encoded_bytes()
                        .to_vec(),
                ));
            } else if metadata.is_dir() {
                walk(root, &path, out);
            } else {
                out.push((relative, fs::read(&path).unwrap()));
            }
        }
    }
    let mut out = vec![];
    walk(root, root, &mut out);
    out
}

fn stable_snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    snapshot(root)
        .into_iter()
        .filter(|(path, _)| {
            let text = path.to_string_lossy();
            !text.contains("/.git/logs/")
                && !text.ends_with("/.git/index")
                && !text.ends_with("/.git/ORIG_HEAD")
        })
        .collect()
}

#[cfg(unix)]
#[test]
fn sync_composes_with_configure_shell_switch_status_and_handoff() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    for source in [false, true] {
        if source && std::env::var_os("ARASHI_TS_PARITY").is_none() {
            continue;
        }
        let f = Fixture::new(&["zeta", "alpha"]);
        f.config(json!({"version":"1.0.0", "reposDir":"repos",
            "defaults":{"switch":{"mode":"cd"}, "create":{"launch":false,"switch":false}},
            "repos":{"zeta":{"path":"repos/zeta"},"alpha":{"path":"repos/alpha"}}}));
        git(&f.root, &["checkout", "-b", "composed"]);
        git(&f.repo("alpha"), &["branch", "composed"]);
        let config = fs::read(f.root.join(".arashi/config.json")).unwrap();
        let parent_head = head(&f.root, "HEAD");
        let child_heads = [
            head(&f.repo("zeta"), "HEAD"),
            head(&f.repo("alpha"), "HEAD"),
        ];
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
        isolated(&mut command, &f.home);
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
arashi sync --json > "$HOME/sync.json"
arashi status --json > "$HOME/status.json"
arashi handoff --json --todo 'continue composed journey' > "$HOME/handoff.json"
arashi switch --cd --repos --path "$EXPECTED_CHILD"
[ "$(pwd -P)" = "$EXPECTED_CHILD" ]
aw switch --cd --path "$EXPECTED_ROOT"
[ "$(pwd -P)" = "$EXPECTED_ROOT" ]
aw sync --json > "$HOME/repeat.json"
[ -z "${ARASHI_DIRECTIVE_FILE+x}" ]
"#,
            ])
            .current_dir(&f.root)
            .env("PATH", std::env::join_paths(paths).unwrap())
            .env("TMPDIR", f.home.join("tmp"))
            .env("EXPECTED_ROOT", &f.root)
            .env("EXPECTED_CHILD", f.repo("alpha"))
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
            "source={source}: {output:?}; outputs={:?}",
            snapshot(&f.home)
        );
        for name in ["configure", "sync", "status", "handoff", "repeat"] {
            let value: Value =
                serde_json::from_slice(&fs::read(f.home.join(format!("{name}.json"))).unwrap())
                    .unwrap();
            assert_eq!(value["ok"], true, "{name}: {value}");
            if name == "sync" || name == "repeat" {
                assert_eq!(value["data"]["successCount"], 2);
                assert_eq!(value["data"]["failureCount"], 0);
                for result in value["data"]["results"].as_array().unwrap() {
                    assert_eq!(
                        result["createdBranch"],
                        name == "sync" && result["repositoryName"] == "zeta"
                    );
                }
            }
        }
        assert_eq!(
            fs::read(f.root.join(".arashi/config.json")).unwrap(),
            config
        );
        assert_eq!(head(&f.root, "HEAD"), parent_head);
        for (index, name) in ["zeta", "alpha"].iter().enumerate() {
            assert_eq!(branch(&f.repo(name)), "composed");
            assert_eq!(head(&f.repo(name), "HEAD"), child_heads[index]);
            assert_eq!(
                git(
                    &f.repo(name),
                    &[
                        "for-each-ref",
                        "--format=%(upstream)",
                        "refs/heads/composed"
                    ]
                ),
                ""
            );
        }
        assert_eq!(fs::read_dir(f.home.join("tmp")).unwrap().count(), 0);
    }
}

fn data(value: &Value) -> &Value {
    assert_eq!(value["command"], "sync");
    assert_eq!(value["ok"], true);
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["warnings"], json!([]));
    &value["data"]
}

#[cfg(unix)]
#[test]
#[ignore = "requires retained TypeScript dependencies and ARASHI_TS_PARITY=1"]
fn source_parity_for_local_sync_workflows() {
    assert!(std::env::var_os("ARASHI_TS_PARITY").is_some());
    let source = std::env::var_os("ARASHI_TS_SOURCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"));
    for args in [
        vec!["sync", "--json"],
        vec!["sync", "--json", "--only", "alpha,zeta"],
        vec!["sync", "--json", "--group", "docs"],
    ] {
        let mut outcomes = vec![];
        for native in [false, true] {
            let f = Fixture::new(&["zeta", "alpha"]);
            git(&f.root, &["checkout", "-b", "parity"]);
            git(&f.repo("alpha"), &["branch", "parity"]);
            let before = [
                head(&f.repo("zeta"), "HEAD"),
                head(&f.repo("alpha"), "HEAD"),
            ];
            // Repeat the invocation to exercise current-branch no-op as well.
            for _ in 0..2 {
                let output = if native {
                    f.run(&args)
                } else {
                    let mut command = Command::new("node");
                    command.arg(&source).args(&args).current_dir(&f.root);
                    isolated(&mut command, &f.home);
                    command.output().unwrap()
                };
                assert!(
                    output.status.success(),
                    "stdout={} stderr={}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
                let mut value: Value = serde_json::from_slice(&output.stdout).unwrap();
                for result in value["data"]["results"].as_array_mut().unwrap() {
                    result["durationMs"] = json!(0);
                }
                outcomes.push((output.status.code(), output.stderr, value));
            }
            for (index, name) in ["zeta", "alpha"].iter().enumerate() {
                let selected = *name == "alpha" || !args.contains(&"docs");
                assert_eq!(
                    branch(&f.repo(name)),
                    if selected { "parity" } else { "main" }
                );
                assert_eq!(head(&f.repo(name), "HEAD"), before[index]);
                if selected {
                    assert!(
                        git(
                            &f.repo(name),
                            &["for-each-ref", "--format=%(upstream)", "refs/heads/parity"]
                        )
                        .is_empty()
                    );
                }
            }
        }
        assert_eq!(outcomes[0], outcomes[2], "{args:?}: initial sync");
        assert_eq!(outcomes[1], outcomes[3], "{args:?}: no-op sync");
    }
}

#[test]
fn creates_missing_branches_at_frozen_head_without_upstream_in_config_order() {
    let f = Fixture::new(&["zeta", "alpha"]);
    git(&f.root, &["checkout", "-b", "feature/sync"]);
    let frozen = [
        head(&f.repo("zeta"), "HEAD"),
        head(&f.repo("alpha"), "HEAD"),
    ];
    let (output, value) = f.json(&["sync", "--json"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let summary = data(&value);
    assert_eq!(summary["successCount"], 2);
    assert_eq!(summary["failureCount"], 0);
    assert_eq!(summary["results"][0]["repositoryName"], "zeta");
    assert_eq!(summary["results"][1]["repositoryName"], "alpha");
    for (index, name) in ["zeta", "alpha"].iter().enumerate() {
        let repo = f.repo(name);
        assert_eq!(branch(&repo), "feature/sync");
        assert_eq!(head(&repo, "refs/heads/feature/sync"), frozen[index]);
        assert!(
            git(
                &repo,
                &[
                    "for-each-ref",
                    "--format=%(upstream)",
                    "refs/heads/feature/sync"
                ]
            )
            .is_empty()
        );
        assert_eq!(summary["results"][index]["createdBranch"], true);
        assert_eq!(summary["results"][index]["targetBranch"], "feature/sync");
        assert!(summary["results"][index]["durationMs"].is_u64());
        assert!(summary["results"][index].get("errorMessage").is_none());
    }
    assert_eq!(
        branch(&f.root),
        "feature/sync",
        "meta repository is target-only"
    );
}

#[test]
fn existing_branch_checkout_and_current_branch_noop_preserve_refs() {
    let f = Fixture::new(&["zeta", "alpha"]);
    git(&f.root, &["checkout", "-b", "feature"]);
    git(&f.repo("zeta"), &["branch", "feature"]);
    git(&f.repo("alpha"), &["checkout", "-b", "feature"]);
    let before_alpha = f.snapshot();
    let (output, value) = f.json(&["sync", "--json", "--only", "alpha"]);
    assert!(output.status.success());
    assert_eq!(branch(&f.repo("zeta")), "main");
    assert_eq!(branch(&f.repo("alpha")), "feature");
    assert_eq!(data(&value)["results"][0]["createdBranch"], false);
    assert_eq!(
        before_alpha,
        f.snapshot(),
        "no-op sync must not write any fixture or HOME bytes"
    );
}

#[test]
fn explicit_only_order_and_group_intersection_are_preserved() {
    let f = Fixture::new(&["zeta", "alpha"]);
    git(&f.root, &["checkout", "-b", "ordered"]);
    let (output, value) = f.json(&["sync", "--json", "--only", "alpha,zeta"]);
    assert!(output.status.success());
    assert_eq!(data(&value)["results"][0]["repositoryName"], "alpha");
    assert_eq!(data(&value)["results"][1]["repositoryName"], "zeta");

    git(&f.root, &["checkout", "-b", "grouped"]);
    let (output, value) = f.json(&["sync", "--json", "--only", "zeta,alpha", "--group", "docs"]);
    assert!(output.status.success());
    assert_eq!(data(&value)["results"].as_array().unwrap().len(), 1);
    assert_eq!(data(&value)["results"][0]["repositoryName"], "alpha");
    assert_eq!(branch(&f.repo("zeta")), "ordered");
    assert_eq!(branch(&f.repo("alpha")), "grouped");
}

#[test]
fn contained_absolute_repository_path_is_supported() {
    let f = Fixture::new(&["alpha"]);
    git(&f.root, &["checkout", "-b", "absolute"]);
    f.config(
        json!({"version":"1.0.0","reposDir":"repos","repos":{"alpha":{"path":f.repo("alpha")}}}),
    );
    let (output, value) = f.json(&["sync", "--json"]);
    assert!(output.status.success());
    assert_eq!(data(&value)["successCount"], 1);
    assert_eq!(branch(&f.repo("alpha")), "absolute");
}

#[test]
fn timeout_and_repository_failure_continue_with_source_statuses() {
    let f = Fixture::new(&["zeta", "alpha"]);
    git(&f.root, &["checkout", "-b", "timed"]);
    f.config(json!({"version":"1.0.0","reposDir":"repos","sync":{"timeoutSeconds":0},"repos":{"zeta":{"path":"repos/zeta"},"missing":{"path":"repos/missing"},"alpha":{"path":"repos/alpha"}}}));
    let (output, value) = f.json(&["sync", "--json"]);
    assert_eq!(output.status.code(), Some(1));
    let summary = data(&value);
    assert_eq!(summary["successCount"], 0);
    assert_eq!(summary["failureCount"], 3);
    assert_eq!(summary["results"][0]["status"], "timeout");
    assert_eq!(
        summary["results"][0]["errorMessage"],
        "Repository operation timed out"
    );
    assert_eq!(summary["results"][1]["status"], "failure");
    assert_eq!(
        summary["results"][1]["errorMessage"],
        format!(
            "git rev-parse --abbrev-ref HEAD failed: Working directory not found: {}",
            f.root.join("repos/missing").display()
        )
    );
    assert_eq!(summary["results"][2]["status"], "timeout");
    assert_eq!(branch(&f.repo("zeta")), "main");
    assert_eq!(branch(&f.repo("alpha")), "main");
}

#[test]
fn missing_repository_rollback_refreshes_plans_before_continuing() {
    let f = Fixture::new(&["zeta", "alpha"]);
    git(&f.root, &["checkout", "-b", "continue-after-rollback"]);
    f.config(json!({
        "version":"1.0.0",
        "reposDir":"repos",
        "repos":{
            "zeta":{"path":"repos/zeta"},
            "missing":{"path":"repos/missing"},
            "alpha":{"path":"repos/alpha"}
        }
    }));
    let (output, value) = f.json(&["sync", "--json"]);
    assert_eq!(output.status.code(), Some(1));
    let summary = data(&value);
    assert_eq!(summary["results"].as_array().unwrap().len(), 3);
    assert_eq!(summary["results"][0]["rolledBack"], true);
    assert_eq!(summary["results"][0]["status"], "failure");
    assert_eq!(summary["results"][1]["status"], "failure");
    assert_eq!(summary["results"][2]["status"], "success");
    assert_eq!(branch(&f.repo("alpha")), "main");
    assert_eq!(branch(&f.repo("zeta")), "continue-after-rollback");
}

#[test]
fn human_and_verbose_output_retains_source_summary_and_details() {
    let f = Fixture::new(&["alpha"]);
    git(&f.root, &["checkout", "-b", "human"]);
    let output = f.run(&["sync", "--verbose"]);
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(
        stdout.contains("alpha: synced to human (created)"),
        "{stdout}"
    );
    assert!(
        stdout.contains("alpha: branch=human, duration="),
        "{stdout}"
    );
    assert!(
        stdout.contains("Sync complete: 1 succeeded, 0 failed"),
        "{stdout}"
    );
}

#[test]
fn configured_remote_hooks_materialization_and_git_url_reject_before_any_mutation() {
    for (label, extra) in [
        ("git-url", json!({"gitUrl":"https://example.invalid/repo"})),
        ("copy", json!({"copy":["file"]})),
        ("symlink", json!({"symlink":["file"]})),
        ("repo-hook", json!({"hooks":{"pre-create":"echo nope"}})),
    ] {
        let f = Fixture::new(&["zeta", "alpha"]);
        git(&f.root, &["checkout", "-b", "blocked"]);
        f.config(json!({"version":"1.0.0","reposDir":"repos","repos":{"zeta":{"path":"repos/zeta"},"alpha":{"path":"repos/alpha", "groups":[], "baseBranch":"main"}}}));
        let mut config: Value =
            serde_json::from_slice(&fs::read(f.root.join(".arashi/config.json")).unwrap()).unwrap();
        for (key, value) in extra.as_object().unwrap() {
            config["repos"]["alpha"][key] = value.clone();
        }
        f.config(config);
        let before = f.snapshot();
        let (output, value) = f.json(&["sync", "--json"]);
        assert!(!output.status.success(), "{label}");
        assert_eq!(
            value["error"]["code"], "RUST_NOT_YET_PORTED",
            "{label}: {value}"
        );
        assert_eq!(
            before,
            f.snapshot(),
            "{label} mutated files, refs, registrations, or HOME"
        );
    }

    let f = Fixture::new(&["zeta", "alpha"]);
    git(&f.root, &["checkout", "-b", "blocked"]);
    git(
        &f.repo("alpha"),
        &["remote", "add", "origin", "/tmp/never-used"],
    );
    let before = f.snapshot();
    let (output, value) = f.json(&["sync", "--json"]);
    assert!(!output.status.success());
    assert_eq!(value["error"]["code"], "RUST_NOT_YET_PORTED");
    assert!(!f.repo("alpha").join(".git/FETCH_HEAD").exists());
    assert_eq!(before, f.snapshot());
}

#[cfg(unix)]
#[test]
fn checkout_hooks_and_core_hooks_path_reject_without_execution_or_mutation() {
    use std::os::unix::fs::PermissionsExt;
    for custom in [false, true] {
        let f = Fixture::new(&["zeta", "alpha"]);
        git(&f.root, &["checkout", "-b", "blocked"]);
        let hook_dir = if custom {
            let path = f.repo("alpha").join("custom-hooks");
            fs::create_dir(&path).unwrap();
            git(
                &f.repo("alpha"),
                &["config", "core.hooksPath", "custom-hooks"],
            );
            path
        } else {
            f.repo("alpha").join(".git/hooks")
        };
        let hook = hook_dir.join("post-checkout");
        fs::write(&hook, "#!/bin/sh\nprintf ran > hook-ran\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        let before = f.snapshot();
        let (output, value) = f.json(&["sync", "--json"]);
        assert!(!output.status.success());
        assert_eq!(value["error"]["code"], "RUST_NOT_YET_PORTED");
        assert!(!f.repo("alpha").join("hook-ran").exists());
        assert_eq!(before, f.snapshot());
    }
}

#[cfg(unix)]
#[test]
fn external_symlinked_linked_bare_and_checked_out_elsewhere_topologies_reject_before_mutation() {
    use std::os::unix::fs::symlink;
    // Symlinked configured path.
    let f = Fixture::new(&["zeta", "real"]);
    git(&f.root, &["checkout", "-b", "blocked"]);
    symlink(f.repo("real"), f.repo("alias")).unwrap();
    f.config(json!({"version":"1.0.0","reposDir":"repos","repos":{"zeta":{"path":"repos/zeta"},"alias":{"path":"repos/alias"}}}));
    let before = f.snapshot();
    let (output, value) = f.json(&["sync", "--json"]);
    assert!(!output.status.success());
    assert_eq!(value["error"]["code"], "RUST_NOT_YET_PORTED");
    assert_eq!(before, f.snapshot());

    // Existing target checked out elsewhere must block all selected repositories.
    let f = Fixture::new(&["zeta", "alpha"]);
    git(&f.root, &["checkout", "-b", "occupied"]);
    let linked = f.temp.join("linked-alpha");
    git(
        &f.repo("alpha"),
        &[
            "worktree",
            "add",
            "-b",
            "occupied",
            linked.to_str().unwrap(),
        ],
    );
    let before = f.snapshot();
    let (output, value) = f.json(&["sync", "--json"]);
    assert!(!output.status.success());
    assert_eq!(value["error"]["code"], "RUST_NOT_YET_PORTED");
    assert_eq!(branch(&f.repo("zeta")), "main");
    assert_eq!(before, f.snapshot());

    // A configured path naming a linked checkout is unsupported.
    let f = Fixture::new(&["zeta", "alpha"]);
    git(&f.root, &["checkout", "-b", "linked"]);
    let linked = f.root.join("repos/linked-alpha");
    git(
        &f.repo("alpha"),
        &["worktree", "add", "-b", "other", linked.to_str().unwrap()],
    );
    f.config(json!({"version":"1.0.0","reposDir":"repos","repos":{"zeta":{"path":"repos/zeta"},"linked":{"path":"repos/linked-alpha"}}}));
    let before = f.snapshot();
    let (output, _) = f.json(&["sync", "--json"]);
    assert!(!output.status.success());
    assert_eq!(before, f.snapshot());

    // External configured paths and bare repositories are rejected.
    let f = Fixture::new(&["zeta"]);
    git(&f.root, &["checkout", "-b", "outside"]);
    let external = f.temp.join("external");
    init(&external);
    f.config(json!({"version":"1.0.0","reposDir":"repos","repos":{"zeta":{"path":"repos/zeta"},"external":{"path":external}}}));
    let before = f.snapshot();
    assert!(!f.run(&["sync", "--json"]).status.success());
    assert_eq!(before, f.snapshot());

    let f = Fixture::new(&["zeta"]);
    git(&f.root, &["checkout", "-b", "bare"]);
    let bare = f.root.join("repos/bare");
    fs::create_dir(&bare).unwrap();
    git(&bare, &["init", "--bare"]);
    f.config(json!({"version":"1.0.0","reposDir":"repos","repos":{"zeta":{"path":"repos/zeta"},"bare":{"path":"repos/bare"}}}));
    let before = f.snapshot();
    assert!(!f.run(&["sync", "--json"]).status.success());
    assert_eq!(before, f.snapshot());
}

#[cfg(unix)]
#[test]
fn failed_checkout_rolls_back_invocation_created_branch_and_preserves_snapshot() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new(&["zeta"]);
    git(&f.root, &["checkout", "-b", "collision"]);
    let bin = f.temp.join("bin");
    fs::create_dir(&bin).unwrap();
    let shim = bin.join("git");
    let real_git = String::from_utf8(
        Command::new("sh")
            .args(["-c", "command -v git"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    let marker = f.temp.join("checkout-failed-once");
    fs::write(
        &shim,
        format!(
            "#!/bin/sh\nif [ \"$1\" = checkout ] && [ ! -e '{}' ]; then\n  '{}' \"$@\" || exit $?\n  : > '{}'\n  echo injected checkout failure >&2\n  exit 73\nfi\nexec '{}' \"$@\"\n",
            marker.display(),
            real_git.trim(),
            marker.display(),
            real_git.trim()
        ),
    )
    .unwrap();
    fs::set_permissions(&shim, fs::Permissions::from_mode(0o755)).unwrap();
    let before = stable_snapshot(&f.temp);
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
    let output = f.run_with_path(&["sync", "--json"], &path);
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(data(&value)["results"][0]["status"], "failure");
    assert_eq!(branch(&f.repo("zeta")), "main");
    assert!(
        Command::new("git")
            .args(["show-ref", "--verify", "--quiet", "refs/heads/collision"])
            .current_dir(f.repo("zeta"))
            .status()
            .unwrap()
            .code()
            != Some(0)
    );
    fs::remove_file(marker).unwrap();
    assert_eq!(
        before,
        stable_snapshot(&f.temp),
        "failed checkout must roll back only its branch mutation"
    );
}

#[cfg(unix)]
fn git_shim(f: &Fixture, body: &str) -> String {
    use std::os::unix::fs::PermissionsExt;
    let bin = f.temp.join("shim-bin");
    fs::create_dir_all(&bin).unwrap();
    let real_git = String::from_utf8(
        Command::new("sh")
            .args(["-c", "command -v git"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    let shim = bin.join("git");
    fs::write(
        &shim,
        format!(
            "#!/bin/sh\nREAL_GIT='{}'\n{}\nexec \"$REAL_GIT\" \"$@\"\n",
            real_git.trim(),
            body
        ),
    )
    .unwrap();
    fs::set_permissions(&shim, fs::Permissions::from_mode(0o755)).unwrap();
    format!("{}:{}", bin.display(), std::env::var("PATH").unwrap())
}

#[cfg(unix)]
#[test]
fn later_failure_reports_previously_successful_repository_as_rolled_back() {
    let f = Fixture::new(&["zeta", "alpha"]);
    git(&f.root, &["checkout", "-b", "rollback-report"]);
    let marker = f.temp.join("alpha-checkout-failed");
    let body = format!(
        "if [ \"$PWD\" = '{}' ] && [ \"$1\" = checkout ] && [ ! -e '{}' ]; then\n  \"$REAL_GIT\" \"$@\" || exit $?\n  : > '{}'\n  exit 73\nfi",
        f.repo("alpha").display(),
        marker.display(),
        marker.display()
    );
    let path = git_shim(&f, &body);
    let output = f.run_with_path(&["sync", "--json"], &path);
    assert_eq!(output.status.code(), Some(1));
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    let summary = data(&value);
    assert_eq!(summary["successCount"], 0);
    assert_eq!(summary["failureCount"], 2);
    assert_eq!(summary["results"][0]["status"], "failure");
    assert_eq!(summary["results"][0]["rolledBack"], true);
    assert_eq!(summary["results"][0]["createdBranch"], false);
    assert_eq!(summary["results"][1]["rolledBack"], true);
    assert_eq!(branch(&f.repo("zeta")), "main");
    assert_eq!(branch(&f.repo("alpha")), "main");
}

#[cfg(unix)]
#[test]
fn final_revalidation_failure_reports_counts_and_rollback_failure() {
    let f = Fixture::new(&["zeta"]);
    git(&f.root, &["checkout", "-b", "final-race"]);
    git(&f.repo("zeta"), &["checkout", "-b", "alternate"]);
    fs::write(f.repo("zeta").join("tracked"), "alternate").unwrap();
    git(&f.repo("zeta"), &["add", "tracked"]);
    git(&f.repo("zeta"), &["commit", "-m", "alternate"]);
    let alternate = head(&f.repo("zeta"), "HEAD");
    git(&f.repo("zeta"), &["checkout", "main"]);
    let counter = f.temp.join("target-ref-count");
    let marker = f.temp.join("final-ref-raced");
    let body = format!(
        "if [ \"$PWD\" = '{}' ] && [ \"$1\" = for-each-ref ] && [ \"$3\" = refs/heads/final-race ]; then\n  count=0; [ ! -e '{}' ] || count=$(cat '{}')\n  count=$((count + 1)); printf '%s' \"$count\" > '{}'\n  \"$REAL_GIT\" \"$@\"; status=$?\n  if [ \"$count\" = 9 ]; then \"$REAL_GIT\" update-ref refs/heads/final-race '{}' && : > '{}'; fi\n  exit $status\nfi",
        f.repo("zeta").display(),
        counter.display(),
        counter.display(),
        counter.display(),
        alternate,
        marker.display()
    );
    let path = git_shim(&f, &body);
    let output = f.run_with_path(&["sync", "--json"], &path);
    assert!(marker.exists(), "fixture did not reach final revalidation");
    assert_eq!(output.status.code(), Some(1));
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    let summary = data(&value);
    assert_eq!(summary["successCount"], 0);
    assert_eq!(summary["failureCount"], 1);
    assert_eq!(summary["results"][0]["status"], "failure");
    assert_eq!(summary["results"][0]["rollbackFailed"], true);
}

#[cfg(unix)]
#[test]
fn repository_replaced_by_external_symlink_rejects_and_rolls_back_prior_repository() {
    let f = Fixture::new(&["zeta", "alpha"]);
    git(&f.root, &["checkout", "-b", "swap"]);
    let external = f.temp.join("external-alpha");
    init(&external);
    let saved = f.temp.join("saved-alpha");
    let marker = f.temp.join("swapped");
    let body = format!(
        "if [ \"$PWD\" = '{}' ] && [ \"$1\" = checkout ] && [ ! -e '{}' ]; then\n  \"$REAL_GIT\" \"$@\" || exit $?\n  mv '{}' '{}'\n  ln -s '{}' '{}'\n  : > '{}'\n  exit 0\nfi",
        f.repo("zeta").display(),
        marker.display(),
        f.repo("alpha").display(),
        saved.display(),
        external.display(),
        f.repo("alpha").display(),
        marker.display()
    );
    let path = git_shim(&f, &body);
    let output = f.run_with_path(&["sync", "--json"], &path);
    assert_eq!(
        output.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    let summary = data(&value);
    assert_eq!(summary["successCount"], 0);
    assert_eq!(summary["failureCount"], 2);
    assert_eq!(summary["results"][0]["repositoryName"], "zeta");
    assert_eq!(summary["results"][0]["status"], "failure");
    assert_eq!(summary["results"][0]["rolledBack"], true);
    assert_eq!(summary["results"][0]["createdBranch"], false);
    assert_eq!(summary["results"][1]["repositoryName"], "alpha");
    assert_eq!(summary["results"][1]["status"], "failure");
    assert_eq!(
        branch(&f.repo("zeta")),
        "main",
        "prior checkout must roll back"
    );
    assert!(
        Command::new("git")
            .args(["show-ref", "--verify", "--quiet", "refs/heads/swap"])
            .current_dir(f.repo("zeta"))
            .status()
            .unwrap()
            .code()
            != Some(0),
        "prior invocation-created branch must roll back"
    );
    assert_eq!(
        branch(&external),
        "main",
        "external repository must not be mutated"
    );
    assert!(
        fs::symlink_metadata(f.repo("alpha"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[cfg(unix)]
#[test]
fn malformed_target_ref_rejects_before_any_repository_mutation() {
    let f = Fixture::new(&["zeta", "alpha"]);
    git(&f.root, &["checkout", "-b", "malformed"]);
    fs::write(
        f.repo("alpha").join(".git/refs/heads/malformed"),
        "not-an-object-id\n",
    )
    .unwrap();
    let marker = f.temp.join("mutation-ran");
    let body = format!(
        "if [ \"$PWD\" = '{}' ] && {{ [ \"$1\" = update-ref ] || [ \"$1\" = checkout ]; }}; then : > '{}'; fi",
        f.repo("zeta").display(),
        marker.display()
    );
    let path = git_shim(&f, &body);
    let output = f.run_with_path(&["sync", "--json"], &path);
    assert!(!output.status.success());
    assert!(!marker.exists(), "malformed ref must fail global preflight");
    assert_eq!(branch(&f.repo("zeta")), "main");
}

#[test]
fn disabled_ref_logging_rejects_global_preflight() {
    let f = Fixture::new(&["zeta", "alpha"]);
    git(&f.root, &["checkout", "-b", "no-reflog"]);
    git(
        &f.repo("alpha"),
        &["config", "core.logAllRefUpdates", "false"],
    );
    let before = stable_snapshot(&f.temp);
    let output = f.run(&["sync", "--json"]);
    assert!(!output.status.success());
    assert_eq!(branch(&f.repo("zeta")), "main");
    assert_eq!(before, stable_snapshot(&f.temp));
}

#[test]
fn symbolic_and_non_commit_target_refs_fail_global_preflight() {
    for kind in ["symbolic", "blob"] {
        let f = Fixture::new(&["zeta", "alpha"]);
        git(&f.root, &["checkout", "-b", "poisoned"]);
        if kind == "symbolic" {
            git(
                &f.repo("alpha"),
                &["symbolic-ref", "refs/heads/poisoned", "refs/heads/main"],
            );
        } else {
            let blob = git(&f.repo("alpha"), &["hash-object", "-w", "tracked"]);
            fs::write(
                f.repo("alpha").join(".git/refs/heads/poisoned"),
                format!("{blob}\n"),
            )
            .unwrap();
        }
        let before = stable_snapshot(&f.temp);
        let output = f.run(&["sync", "--json"]);
        assert!(!output.status.success(), "{kind}");
        assert_eq!(
            branch(&f.repo("zeta")),
            "main",
            "{kind} ref must block globally"
        );
        assert_eq!(
            before,
            stable_snapshot(&f.temp),
            "{kind} preflight mutated state"
        );
    }
}

#[cfg(unix)]
#[test]
fn missing_nested_target_ref_rejects_symlinked_ref_ancestor_before_mutation() {
    let f = Fixture::new(&["zeta"]);
    git(&f.root, &["checkout", "-b", "nested/topic"]);
    let external = f.temp.join("external-refs");
    fs::create_dir(&external).unwrap();
    std::os::unix::fs::symlink(&external, f.repo("zeta").join(".git/refs/heads/nested")).unwrap();
    let before = stable_snapshot(&f.temp);
    let output = f.run(&["sync", "--json"]);
    assert!(!output.status.success());
    assert_eq!(before, stable_snapshot(&f.temp));
    assert!(fs::read_dir(external).unwrap().next().is_none());
}

#[cfg(unix)]
#[test]
fn failed_create_only_update_does_not_adopt_same_oid_concurrent_ref() {
    let f = Fixture::new(&["zeta"]);
    git(&f.root, &["checkout", "-b", "concurrent"]);
    let body = "if [ \"$1\" = update-ref ] && [ \"$2\" = -m ]; then\n  \"$REAL_GIT\" update-ref \"$4\" \"$5\" || exit $?\n  echo concurrent creation >&2\n  exit 73\nfi";
    let path = git_shim(&f, body);
    let output = f.run_with_path(&["sync", "--json"], &path);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(branch(&f.repo("zeta")), "main");
    assert_eq!(
        head(&f.repo("zeta"), "refs/heads/concurrent"),
        head(&f.repo("zeta"), "refs/heads/main"),
        "ambiguous same-OID ref belongs to the concurrent actor"
    );
}

#[cfg(unix)]
#[test]
fn successful_detach_command_must_reach_frozen_target_before_attachment() {
    let f = Fixture::new(&["zeta"]);
    git(&f.root, &["checkout", "-b", "race"]);
    git(&f.repo("zeta"), &["branch", "race"]);
    let marker = f.temp.join("symbolic-ran");
    let body = format!(
        "if [ \"$1\" = checkout ] && [ \"$2\" = --detach ]; then exit 0; fi\nif [ \"$1\" = symbolic-ref ] && [ \"$2\" = HEAD ]; then : > '{}'; fi",
        marker.display()
    );
    let path = git_shim(&f, &body);
    let output = f.run_with_path(&["sync", "--json"], &path);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(branch(&f.repo("zeta")), "main");
    assert!(!marker.exists(), "attachment ran without a verified detach");
}

#[cfg(unix)]
#[test]
fn failed_attachment_does_not_adopt_unrelated_same_oid_head() {
    let f = Fixture::new(&["zeta"]);
    git(&f.root, &["checkout", "-b", "race"]);
    git(&f.repo("zeta"), &["branch", "race"]);
    git(&f.repo("zeta"), &["branch", "other"]);
    let marker = f.temp.join("attachment-raced");
    let body = format!(
        "if [ \"$1\" = symbolic-ref ] && [ \"$2\" = HEAD ] && [ ! -e '{}' ]; then\n  \"$REAL_GIT\" symbolic-ref HEAD refs/heads/other || exit $?\n  : > '{}'\n  echo concurrent attachment >&2\n  exit 73\nfi",
        marker.display(),
        marker.display()
    );
    let path = git_shim(&f, &body);
    let output = f.run_with_path(&["sync", "--json"], &path);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(branch(&f.repo("zeta")), "other");
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("rollback failed"),
        "ambiguous caller-owned HEAD must be preserved and reported"
    );
}

#[cfg(unix)]
#[test]
fn recovery_revalidates_repository_identity_before_each_mutation() {
    let f = Fixture::new(&["zeta"]);
    git(&f.root, &["checkout", "-b", "race"]);
    git(&f.repo("zeta"), &["branch", "race"]);
    let external = f.temp.join("external-recovery");
    init(&external);
    git(&external, &["checkout", "-b", "sentinel"]);
    let failed = f.temp.join("attachment-failed");
    let swapped = f.temp.join("recovery-swapped");
    let saved = f.temp.join("saved-zeta");
    let body = format!(
        "if [ \"$1\" = symbolic-ref ] && [ \"$2\" = HEAD ] && [ ! -e '{}' ]; then\n  \"$REAL_GIT\" \"$@\" || exit $?\n  : > '{}'\n  exit 73\nfi\nif [ \"$1\" = checkout ] && [ \"$2\" = --detach ] && [ -e '{}' ] && [ ! -e '{}' ]; then\n  \"$REAL_GIT\" \"$@\" || exit $?\n  mv '{}' '{}'\n  ln -s '{}' '{}'\n  : > '{}'\n  exit 0\nfi",
        failed.display(),
        failed.display(),
        failed.display(),
        swapped.display(),
        f.repo("zeta").display(),
        saved.display(),
        external.display(),
        f.repo("zeta").display(),
        swapped.display()
    );
    let path = git_shim(&f, &body);
    let output = f.run_with_path(&["sync", "--json"], &path);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(branch(&external), "sentinel");
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("rollback failed"),
        "replacement preservation must be reported"
    );
}

#[cfg(unix)]
#[test]
fn branch_created_then_timeout_is_inspected_rolled_back_and_settles_quickly() {
    let f = Fixture::new(&["zeta"]);
    git(&f.root, &["checkout", "-b", "slow-branch"]);
    f.config(json!({"version":"1.0.0","reposDir":"repos","sync":{"timeoutSeconds":1.0},"repos":{"zeta":{"path":"repos/zeta"}}}));
    let marker = f.temp.join("branch-slept");
    let pid_file = f.temp.join("branch-descendant-pid");
    let body = format!(
        "if [ \"$1\" = branch ] || [ \"$1\" = update-ref ]; then\n  if [ ! -e '{}' ]; then\n    \"$REAL_GIT\" \"$@\" || exit $?\n    : > '{}'\n    perl -MPOSIX=setsid -e 'open(F,q(>),q({})); print F $$; close F; $SIG{{TERM}}=q(IGNORE); select undef,undef,undef,0.1; POSIX::close(3); setsid(); sleep 30' & wait\n    exit 0\n  fi\nfi",
        marker.display(),
        marker.display(),
        pid_file.display()
    );
    let path = git_shim(&f, &body);
    let started = std::time::Instant::now();
    let output = f.run_with_path(&["sync", "--json"], &path);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(20),
        "timeout did not settle boundedly: {:?}",
        started.elapsed()
    );
    assert!(
        marker.exists(),
        "timeout fixture never reached the mutation"
    );
    assert!(
        pid_file.exists(),
        "timeout fixture never spawned its descendant"
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(data(&value)["results"][0]["status"], "timeout", "{value}");
    assert_eq!(data(&value)["results"][0]["rolledBack"], true, "{value}");
    assert_eq!(output.status.code(), Some(1));
    assert!(
        !process_alive(&pid_file),
        "escaped descendant survived timeout"
    );
    assert_eq!(branch(&f.repo("zeta")), "main");
    assert!(
        Command::new("git")
            .args(["show-ref", "--verify", "--quiet", "refs/heads/slow-branch"])
            .current_dir(f.repo("zeta"))
            .status()
            .unwrap()
            .code()
            != Some(0)
    );
}

#[cfg(unix)]
#[test]
fn checkout_then_timeout_is_inspected_restored_and_settles_quickly() {
    let f = Fixture::new(&["zeta"]);
    git(&f.root, &["checkout", "-b", "slow-checkout"]);
    git(&f.repo("zeta"), &["branch", "slow-checkout"]);
    f.config(json!({"version":"1.0.0","reposDir":"repos","sync":{"timeoutSeconds":1.0},"repos":{"zeta":{"path":"repos/zeta"}}}));
    let marker = f.temp.join("checkout-slept");
    let pid_file = f.temp.join("checkout-descendant-pid");
    let body = format!(
        "if [ \"$1\" = checkout ] && [ ! -e '{}' ]; then\n  \"$REAL_GIT\" \"$@\" || exit $?\n  : > '{}'\n  perl -MPOSIX=setsid -e 'open(F,q(>),q({})); print F $$; close F; $SIG{{TERM}}=q(IGNORE); select undef,undef,undef,0.1; POSIX::close(3); setsid(); sleep 30' & wait\n  exit 0\nfi",
        marker.display(),
        marker.display(),
        pid_file.display()
    );
    let path = git_shim(&f, &body);
    let started = std::time::Instant::now();
    let output = f.run_with_path(&["sync", "--json"], &path);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(20),
        "timeout did not settle boundedly: {:?}",
        started.elapsed()
    );
    assert!(
        marker.exists(),
        "timeout fixture never reached the mutation"
    );
    assert!(
        pid_file.exists(),
        "timeout fixture never spawned its descendant"
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(data(&value)["results"][0]["status"], "timeout", "{value}");
    assert_eq!(data(&value)["results"][0]["rolledBack"], true, "{value}");
    assert_eq!(output.status.code(), Some(1));
    assert!(
        !process_alive(&pid_file),
        "escaped descendant survived timeout"
    );
    assert_eq!(branch(&f.repo("zeta")), "main");
    assert_eq!(
        head(&f.repo("zeta"), "refs/heads/slow-checkout"),
        head(&f.repo("zeta"), "refs/heads/main")
    );
}

#[cfg(unix)]
#[test]
fn stalled_recovery_checkout_settles_and_preserves_owned_state() {
    stalled_recovery_mutation("checkout");
}

#[cfg(unix)]
#[test]
fn stalled_recovery_delete_settles_and_preserves_owned_state() {
    stalled_recovery_mutation("delete");
}

#[cfg(unix)]
fn stalled_recovery_mutation(operation: &str) {
    {
        let f = Fixture::new(&["zeta"]);
        git(&f.root, &["checkout", "-b", "recovery-timeout"]);
        let failed = f.temp.join("attachment-failed");
        let pid_file = f.temp.join("recovery-descendant-pid");
        let condition = if operation == "checkout" {
            "[ \"$1\" = checkout ]"
        } else {
            "[ \"$1\" = update-ref ] && [ \"$2\" = -d ]"
        };
        let body = format!(
            "if [ \"$1\" = symbolic-ref ] && [ \"$2\" = HEAD ]; then : > '{}'; exit 73; fi\nif [ -e '{}' ] && {}; then\n  sleep 30 &\n  printf '%s' $! > '{}'\n  wait\nfi",
            failed.display(),
            failed.display(),
            condition,
            pid_file.display()
        );
        let path = git_shim(&f, &body);
        let started = std::time::Instant::now();
        let output = f.run_with_path(&["sync", "--json"], &path);
        assert!(
            pid_file.exists(),
            "{operation}: recovery injection never ran"
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(20),
            "{operation}: recovery was unbounded: {:?}",
            started.elapsed()
        );
        assert!(
            !process_alive(&pid_file),
            "{operation}: recovery descendant survived"
        );
        assert_eq!(output.status.code(), Some(1));
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        let result = &data(&value)["results"][0];
        assert_eq!(result["rollbackFailed"], true, "{value}");
        assert!(
            result["errorMessage"]
                .as_str()
                .unwrap()
                .contains("Recovery operation timed out"),
            "{value}"
        );
        assert_eq!(
            head(&f.repo("zeta"), "refs/heads/recovery-timeout"),
            head(&f.repo("zeta"), "refs/heads/main")
        );
        if operation == "checkout" {
            assert_eq!(
                git(&f.repo("zeta"), &["rev-parse", "--abbrev-ref", "HEAD"]),
                "HEAD"
            );
        } else {
            assert_eq!(branch(&f.repo("zeta")), "main");
        }
    }
}

#[cfg(unix)]
#[test]
fn successful_attachment_command_does_not_adopt_unrelated_same_oid_head() {
    let f = Fixture::new(&["zeta"]);
    git(&f.root, &["checkout", "-b", "race-success"]);
    git(&f.repo("zeta"), &["branch", "race-success"]);
    git(&f.repo("zeta"), &["branch", "other"]);
    let marker = f.temp.join("successful-attachment-raced");
    let body = format!(
        "if [ \"$1\" = symbolic-ref ] && [ \"$2\" = HEAD ] && [ ! -e '{}' ]; then\n  \"$REAL_GIT\" symbolic-ref HEAD refs/heads/other || exit $?\n  : > '{}'\n  exit 0\nfi",
        marker.display(),
        marker.display()
    );
    let path = git_shim(&f, &body);
    let output = f.run_with_path(&["sync", "--json"], &path);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(branch(&f.repo("zeta")), "other");
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("rollback failed"),
        "successful but unowned HEAD transition must be preserved and reported"
    );
}

#[cfg(unix)]
#[test]
fn recovery_last_observation_replacement_preserves_external_repository() {
    let f = Fixture::new(&["zeta"]);
    git(&f.root, &["checkout", "-b", "recovery-race"]);
    git(&f.repo("zeta"), &["branch", "recovery-race"]);
    let external = f.temp.join("external-after-check");
    init(&external);
    git(&external, &["checkout", "-b", "sentinel"]);
    fs::write(
        external.join("external-byte-sentinel"),
        b"must remain exact",
    )
    .unwrap();
    let external_before = snapshot(&external);
    let failed = f.temp.join("attachment-failed-after-write");
    let recovery_checkout = f.temp.join("recovery-checkout-finished");
    let recovery_show_refs = f.temp.join("recovery-show-ref-count");
    let swapped = f.temp.join("swapped-after-final-observation");
    let saved = f.temp.join("saved-after-final-observation");
    let body = format!(
        "if [ \"$1\" = symbolic-ref ] && [ \"$2\" = HEAD ] && [ ! -e '{}' ]; then\n  \"$REAL_GIT\" \"$@\" || exit $?\n  : > '{}'\n  exit 73\nfi\nif [ \"$1\" = checkout ] && [ \"$2\" = --detach ] && [ -e '{}' ]; then\n  \"$REAL_GIT\" \"$@\" || exit $?\n  : > '{}'\n  exit 0\nfi\nif [ \"$1\" = show-ref ] && [ \"$4\" = refs/heads/recovery-race ] && [ -e '{}' ] && [ ! -e '{}' ]; then\n  count=0; [ ! -e '{}' ] || count=$(cat '{}')\n  count=$((count + 1)); printf '%s' \"$count\" > '{}'\n  if [ \"$count\" -eq 2 ]; then\n    \"$REAL_GIT\" \"$@\"; status=$?\n    mv '{}' '{}'\n    ln -s '{}' '{}'\n    : > '{}'\n    exit $status\n  fi\nfi",
        failed.display(),
        failed.display(),
        failed.display(),
        recovery_checkout.display(),
        recovery_checkout.display(),
        swapped.display(),
        recovery_show_refs.display(),
        recovery_show_refs.display(),
        recovery_show_refs.display(),
        f.repo("zeta").display(),
        saved.display(),
        external.display(),
        f.repo("zeta").display(),
        swapped.display()
    );
    let path = git_shim(&f, &body);
    let output = f.run_with_path(&["sync", "--json"], &path);
    assert!(
        swapped.exists(),
        "fixture did not replace zeta after the final command-backed observation"
    );
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        snapshot(&external),
        external_before,
        "external repository bytes changed after replacement"
    );
    assert_eq!(branch(&external), "sentinel");
    assert!(
        fs::symlink_metadata(f.repo("zeta"))
            .unwrap()
            .file_type()
            .is_symlink(),
        "replacement symlink was not preserved"
    );
    assert_eq!(fs::read_link(f.repo("zeta")).unwrap(), external);
    assert!(String::from_utf8_lossy(&output.stdout).contains("rollback failed"));
}

#[cfg(unix)]
#[test]
fn attachment_rechecks_detached_frozen_head_immediately_before_mutation() {
    let f = Fixture::new(&["zeta"]);
    git(&f.root, &["checkout", "-b", "attach-race"]);
    git(&f.repo("zeta"), &["branch", "attach-race"]);
    git(&f.repo("zeta"), &["branch", "other"]);
    let detached = f.temp.join("detach-finished");
    let raced = f.temp.join("head-raced-before-attachment");
    let attached = f.temp.join("attachment-ran-after-race");
    let captured = f.temp.join("captured-target-ref");
    let body = format!(
        "if [ \"$PWD\" = '{}' ] && [ \"$1\" = checkout ] && [ \"$2\" = --detach ]; then\n  \"$REAL_GIT\" \"$@\" || exit $?\n  : > '{}'\n  exit 0\nfi\nif [ \"$PWD\" = '{}' ] && [ \"$1\" = rev-parse ] && [ \"$2\" = --git-path ] && [ \"$3\" = refs/heads/attach-race ] && [ -e '{}' ] && [ ! -e '{}' ]; then\n  \"$REAL_GIT\" \"$@\" > '{}'; status=$?\n  \"$REAL_GIT\" symbolic-ref HEAD refs/heads/other || exit $?\n  : > '{}'\n  cat '{}'; rm -f '{}'\n  exit $status\nfi\nif [ \"$PWD\" = '{}' ] && [ \"$1\" = symbolic-ref ] && [ \"$2\" = HEAD ] && [ \"$3\" = refs/heads/attach-race ] && [ -e '{}' ]; then : > '{}'; fi",
        f.repo("zeta").display(),
        detached.display(),
        f.repo("zeta").display(),
        detached.display(),
        raced.display(),
        captured.display(),
        raced.display(),
        captured.display(),
        captured.display(),
        f.repo("zeta").display(),
        raced.display(),
        attached.display()
    );
    let path = git_shim(&f, &body);
    let output = f.run_with_path(&["sync", "--json"], &path);
    assert!(
        raced.exists(),
        "fixture did not race the pre-attachment check"
    );
    assert_eq!(output.status.code(), Some(1));
    assert!(
        !attached.exists(),
        "attachment overwrote caller-selected HEAD; stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(branch(&f.repo("zeta")), "other");
}
