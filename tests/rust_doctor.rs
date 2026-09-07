use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};
#[path = "rust/doctor_network.rs"]
mod doctor_network;
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    root: PathBuf,
    home: PathBuf,
}
impl Fixture {
    fn new(configured: bool) -> Self {
        let base = std::env::temp_dir().join(format!(
            "arashi-doctor-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(base.join("home")).unwrap();
        fs::create_dir(base.join("workspace")).unwrap();
        let f = Self {
            root: arashi::paths::canonicalize(base.join("workspace")).unwrap(),
            home: base.join("home"),
        };
        f.init(&f.root);
        if configured {
            fs::create_dir_all(f.root.join(".arashi")).unwrap();
            fs::write(f.root.join(".arashi/config.json"), r#"{"version":"1.0.0","reposDir":"repos","worktreesDir":".arashi/worktrees","repos":{}}"#).unwrap();
            fs::write(
                f.root.join(".git/info/exclude"),
                "/repos/\n/.arashi/worktrees/\n",
            )
            .unwrap();
            f.git(&f.root, &["add", ".arashi/config.json"]);
            f.git(&f.root, &["commit", "-m", "config"]);
        }
        f
    }
    fn command(&self, program: &str, cwd: &Path) -> Command {
        let mut c = Command::new(program);
        c.current_dir(cwd)
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("XDG_CONFIG_HOME", &self.home)
            .env("GIT_CONFIG_GLOBAL", self.home.join("gitconfig"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            // Both setup and oracle runs use only owned local/file and loopback Git fixtures.
            .env("GIT_ALLOW_PROTOCOL", "file:git")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("NO_COLOR", "1")
            .env_remove("FORCE_COLOR");
        c
    }
    fn git(&self, cwd: &Path, args: &[&str]) -> String {
        // Setup commits can leave detached maintenance changing object files
        // after Git exits. Disable it only for fixture operations; doctor must
        // still prove read-only behavior without this protection.
        let o = self
            .command("git", cwd)
            .args(["-c", "commit.gpgsign=false", "-c", "maintenance.auto=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8(o.stdout).unwrap()
    }
    fn init(&self, p: &Path) {
        fs::create_dir_all(p).unwrap();
        self.git(p, &["init", "-b", "main"]);
        self.git(p, &["config", "user.name", "Test"]);
        self.git(p, &["config", "user.email", "test@example.invalid"]);
        fs::write(p.join("tracked"), "initial").unwrap();
        self.git(p, &["add", "tracked"]);
        self.git(p, &["commit", "-m", "initial"]);
    }
    fn run(&self, source: bool, cwd: &Path, human: bool) -> Output {
        let mut c = self.command(
            if source {
                "node"
            } else {
                env!("CARGO_BIN_EXE_arashi")
            },
            cwd,
        );
        if source {
            c.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"));
        }
        if !source {
            c.env_remove("GIT_OPTIONAL_LOCKS");
        }
        c.arg("doctor");
        if !human {
            c.arg("--json");
        }
        c.output().unwrap()
    }
    fn check(&self, cwd: &Path, codes: &[&str]) {
        let before = self.snapshot();
        let n = self.run(false, cwd, false);
        let v: Value = serde_json::from_slice(&n.stdout).unwrap();
        let data = if v["ok"] == true {
            &v["data"]
        } else {
            &v["error"]["details"]
        };
        let actual: Vec<_> = data["findings"]
            .as_array()
            .expect("real doctor findings")
            .iter()
            .map(|f| f["code"].as_str().unwrap())
            .collect();
        for code in codes {
            assert!(actual.contains(code), "missing {code}: {v}");
        }
        assert!(n.stderr.is_empty());
        if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            let s = self.run(true, cwd, false);
            let sv: Value = serde_json::from_slice(&s.stdout).unwrap();
            assert_eq!(v, sv, "complete JSON parity");
            assert_eq!(n.status.code(), s.status.code());
            assert_eq!(n.stderr, s.stderr);
            let s = self.run(true, cwd, true);
            let n = self.run(false, cwd, true);
            assert_eq!(n.stdout, s.stdout, "human stdout");
            assert_eq!(n.stderr, s.stderr, "human stderr");
            assert_eq!(n.status.code(), s.status.code());
        }
        assert_eq!(
            before,
            self.snapshot(),
            "doctor must not mutate fixture files, index, refs, or registrations"
        );
    }
    fn snapshot(&self) -> Vec<(PathBuf, Vec<u8>)> {
        fn walk(p: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
            for e in fs::read_dir(p).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    walk(&p, out)
                } else {
                    out.push((p.clone(), fs::read(p).unwrap()));
                }
            }
        }
        let mut v = vec![];
        walk(self.root.parent().unwrap(), &mut v);
        v.sort();
        v
    }
    fn children(&self) {
        self.init(&self.root.join("repos/zulu"));
        self.init(&self.root.join("repos/alpha"));
        fs::write(self.root.join(".arashi/config.json"),r#"{"version":"1.0.0","reposDir":"repos","worktreesDir":".arashi/worktrees","repos":{"zulu":{"path":"repos/zulu"},"alpha":{"path":"repos/alpha"}}}"#).unwrap();
        self.git(&self.root, &["commit", "-am", "children"]);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.root.parent().unwrap());
    }
}
#[test]
fn fixture_commits_do_not_launch_automatic_maintenance() {
    let f = Fixture::new(true);
    // Force observable maintenance on every commit, synchronously so the
    // regression does not depend on catching a short-lived maintenance.lock.
    for (key, value) in [
        ("maintenance.auto", "true"),
        ("maintenance.autoDetach", "false"),
        ("gc.autoDetach", "false"),
        ("maintenance.gc.enabled", "false"),
        ("maintenance.commit-graph.enabled", "true"),
        ("maintenance.commit-graph.auto", "-1"),
    ] {
        f.git(&f.root, &["config", key, value]);
    }
    let graph = f.root.join(".git/objects/info/commit-graphs");
    assert!(!graph.exists());
    f.git(&f.root, &["commit", "--allow-empty", "-m", "fixture"]);
    assert!(
        !graph.exists(),
        "fixture commit launched automatic maintenance before doctor ran"
    );

    // Positive control: ordinary Git really performs the configured work.
    let output = f
        .command("git", &f.root)
        .args([
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-m",
            "maintenance control",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(graph.exists(), "control must exercise real Git maintenance");
}
#[test]
fn ordinary_and_outside() {
    let f = Fixture::new(false);
    f.check(&f.root, &["DOCTOR_NOT_IN_WORKSPACE"]);
    f.check(&f.home, &["DOCTOR_NOT_IN_WORKSPACE"]);
}
#[test]
fn configured_parent_child_order() {
    let f = Fixture::new(true);
    f.children();
    f.check(&f.root, &["REPOSITORY_NO_UPSTREAM"]);
    f.check(&f.root.join("repos/zulu"), &["REPOSITORY_NO_UPSTREAM"]);
}
#[test]
fn dirty_detached_missing_and_stale() {
    let f = Fixture::new(true);
    f.children();
    fs::write(f.root.join("tracked"), "dirty").unwrap();
    fs::write(f.root.join("untracked"), "new").unwrap();
    f.git(&f.root.join("repos/zulu"), &["checkout", "--detach"]);
    fs::remove_dir_all(f.root.join("repos/alpha")).unwrap();
    let stale = f.root.join(".arashi/worktrees/stale");
    f.git(
        &f.root,
        &["worktree", "add", "-b", "stale", stale.to_str().unwrap()],
    );
    fs::remove_dir_all(stale).unwrap();
    f.check(
        &f.root,
        &[
            "REPOSITORY_DIRTY",
            "REPOSITORY_DETACHED_HEAD",
            "REPOSITORY_MISSING",
            "WORKTREE_STALE_METADATA",
            "WORKTREE_DISCOVERY_FAILED",
        ],
    );
}
#[test]
fn ignore_and_local_default() {
    let f = Fixture::new(true);
    f.git(&f.root, &["branch", "feature"]);
    fs::write(f.root.join("tracked"), "main ahead").unwrap();
    f.git(&f.root, &["commit", "-am", "ahead"]);
    f.git(&f.root, &["checkout", "feature"]);
    fs::write(
        f.root.join(".git/info/exclude"),
        "# BEGIN Arashi managed ignore rules\n/old/\n# END Arashi managed ignore rules\n",
    )
    .unwrap();
    f.check(
        &f.root,
        &[
            "MANAGED_IGNORE_MISSING",
            "MANAGED_IGNORE_STALE_RULE",
            "REPOSITORY_DEFAULT_BRANCH_BEHIND",
        ],
    );
}
#[test]
fn standalone_main_only_and_missing_ignore() {
    let f = Fixture::new(false);
    fs::create_dir(f.root.join(".worktrees")).unwrap();
    let linked = f.root.join(".worktrees/feature");
    f.git(
        &f.root,
        &["worktree", "add", "-b", "feature", linked.to_str().unwrap()],
    );
    fs::write(linked.join("tracked"), "dirty linked").unwrap();
    f.check(
        &linked,
        &["STANDALONE_WORKTREES_NOT_IGNORED", "REPOSITORY_NO_UPSTREAM"],
    );
}
#[test]
fn git_conversion_filters_are_rejected_before_execution() {
    for kind in ["clean", "process"] {
        let f = Fixture::new(true);
        fs::write(f.root.join(".gitattributes"), "tracked filter=review\n").unwrap();
        f.git(&f.root, &["add", ".gitattributes"]);
        f.git(&f.root, &["commit", "-m", "attributes"]);
        let command = if kind == "clean" {
            "printf invoked > sentinel; cat"
        } else {
            "printf invoked > sentinel; exit 1"
        };
        f.git(
            &f.root,
            &["config", &format!("filter.review.{kind}"), command],
        );
        // Keep the tracked size unchanged so status compares cleaned content.
        fs::write(f.root.join("tracked"), "changed").unwrap();
        // Control: ordinary Git status really executes this configured driver.
        let _ = f
            .command("git", &f.root)
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
        let sentinel = f.root.join("sentinel");
        assert!(sentinel.exists(), "{kind} filter control did not execute");
        fs::remove_file(&sentinel).unwrap();
        let before = f.snapshot();
        let output = f.run(false, &f.root, false);
        assert!(!sentinel.exists(), "doctor executed the {kind} filter");
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["error"]["code"], "PORT_UNSUPPORTED");
        assert!(!output.status.success());
        assert_eq!(before, f.snapshot());
    }
}

#[test]
fn unsupported_policies_do_not_mutate_or_leak_scripts() {
    for policy in ["hook", "inline", "materialization", "preference"] {
        let f = Fixture::new(true);
        match policy {
            "hook" => {
                fs::create_dir_all(f.root.join(".arashi/hooks")).unwrap();
                fs::write(f.root.join(".arashi/hooks/pre-create.sh"), "touch sentinel").unwrap();
            }
            "preference" => {
                f.git(&f.root, &["config", "arashi.ignoreScope", "none"]);
            }
            other => {
                let p = f.root.join(".arashi/config.json");
                let mut v: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
                if other == "inline" {
                    v["hooks"] = json!({"scripts":{"pre-create":"SECRET_DO_NOT_PRINT"}});
                } else {
                    v["repos"] = json!({"child":{"path":"repos/child","copy":["tracked"]}});
                }
                fs::write(p, serde_json::to_vec(&v).unwrap()).unwrap();
            }
        }
        let before = f.snapshot();
        let o = f.run(false, &f.root, false);
        assert!(!o.status.success());
        let v: Value = serde_json::from_slice(&o.stdout).unwrap();
        assert_eq!(v["error"]["code"], "PORT_UNSUPPORTED", "{policy}: {v}");
        assert!(!String::from_utf8_lossy(&o.stdout).contains("SECRET_DO_NOT_PRINT"));
        assert_eq!(before, f.snapshot());
    }
}

#[test]
fn broken_repository_keeps_other_phases() {
    let f = Fixture::new(true);
    f.children();
    fs::remove_dir_all(f.root.join("repos/zulu/.git")).unwrap();
    fs::write(f.root.join("repos/zulu/.git"), "gitdir: absent\n").unwrap();
    f.check(
        &f.root,
        &[
            "REPOSITORY_STATUS_FAILED",
            "WORKTREE_DISCOVERY_FAILED",
            "REPOSITORY_NO_UPSTREAM",
        ],
    );
}
#[test]
fn malformed_config_is_blocking_and_read_only() {
    let f = Fixture::new(true);
    fs::write(f.root.join(".arashi/config.json"), "{").unwrap();
    let before = f.snapshot();
    let o = f.run(false, &f.root, false);
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(o.status.code(), Some(1));
    assert!(o.stderr.is_empty());
    assert_eq!(v["error"]["code"], "DOCTOR_BLOCKING_FINDINGS");
    assert_eq!(
        v["error"]["details"]["checkedCategories"],
        json!(["configuration"])
    );
    assert_eq!(
        v["error"]["details"]["findings"][0]["code"],
        "CONFIG_LOAD_FAILED"
    );
    assert_eq!(before, f.snapshot());
}
#[test]
fn directory_ignore_is_not_probe_ignore() {
    let f = Fixture::new(true);
    fs::write(f.root.join(".git/info/exclude"), ".arashi-ignore-probe\n").unwrap();
    f.check(&f.root, &["MANAGED_IGNORE_MISSING"]);
}
#[test]
fn global_hooks_and_linked_topology_fail_closed() {
    for policy in ["global", "child-inline", "linked"] {
        let f = Fixture::new(true);
        let mut cwd = f.root.clone();
        match policy {
            "global" => {
                let p = f.home.join(".arashi/hooks/workspace.example");
                fs::create_dir_all(&p).unwrap();
                fs::write(p.join("pre-remove.sh"), "touch sentinel").unwrap();
            }
            "child-inline" => {
                let p = f.root.join(".arashi/config.json");
                let mut v: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
                v["repos"] = json!({"child":{"path":"repos/child","hooks":{"pre-create":"SECRET_DO_NOT_PRINT"}}});
                fs::write(p, serde_json::to_vec(&v).unwrap()).unwrap();
            }
            _ => {
                cwd = f.root.join(".arashi/worktrees/linked");
                f.git(
                    &f.root,
                    &["worktree", "add", "-b", "linked", cwd.to_str().unwrap()],
                );
            }
        }
        let before = f.snapshot();
        let o = f.run(false, &cwd, false);
        let v: Value = serde_json::from_slice(&o.stdout).unwrap();
        assert_eq!(v["error"]["code"], "PORT_UNSUPPORTED", "{policy}: {v}");
        assert!(!String::from_utf8_lossy(&o.stdout).contains("SECRET_DO_NOT_PRINT"));
        assert_eq!(before, f.snapshot());
    }
}

#[test]
fn failed_ignore_phase_retains_repository_observations() {
    let f = Fixture::new(true);
    fs::create_dir(f.root.join(".gitignore")).unwrap();
    let before = f.snapshot();
    let o = f.run(false, &f.root, false);
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(o.status.code(), Some(1));
    let findings = v["error"]["details"]["findings"].as_array().unwrap();
    assert_eq!(findings[0]["code"], "DOCTOR_PHASE_FAILED");
    assert!(
        findings
            .iter()
            .any(|f| f["code"] == "REPOSITORY_NO_UPSTREAM")
    );
    assert_eq!(before, f.snapshot());
}
#[cfg(unix)]
#[test]
fn git_fsmonitor_hook_is_never_executed() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new(true);
    let hook = f.home.join("fsmonitor");
    fs::write(&hook, "#!/bin/sh\ntouch sentinel\n").unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    f.git(
        &f.root,
        &["config", "core.fsmonitor", hook.to_str().unwrap()],
    );
    let before = f.snapshot();
    let o = f.run(false, &f.root, false);
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stdout));
    assert_eq!(before, f.snapshot());
    assert!(!f.root.join("sentinel").exists());
}

#[test]
fn configured_absolute_contained_child_paths() {
    let f = Fixture::new(true);
    f.children();
    let path = f.root.join(".arashi/config.json");
    let mut v: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for name in ["alpha", "zulu"] {
        v["repos"][name]["path"] = json!(f.root.join("repos").join(name));
    }
    fs::write(path, serde_json::to_vec(&v).unwrap()).unwrap();
    f.git(&f.root, &["commit", "-am", "absolute paths"]);
    f.check(&f.root, &["REPOSITORY_NO_UPSTREAM"]);
}

// Exercise Git's recursive status, including a configured child and a grandchild.
fn submodule_filter_guard(kind: &str, depth: usize, configured: bool) {
    let f = Fixture::new(configured);
    let mut parent = f.root.clone();
    if configured {
        f.children();
        parent = f.root.join("repos/alpha");
    } else {
        fs::create_dir(f.root.join(".worktrees")).unwrap();
    }
    let source = f.home.join("submodule-source");
    f.init(&source);
    fs::write(source.join("tracked"), "original\n").unwrap();
    fs::write(source.join(".gitattributes"), "tracked filter=review\n").unwrap();
    f.git(&source, &["add", "."]);
    f.git(&source, &["commit", "-m", "attributes"]);
    for _ in 0..depth {
        f.git(
            &parent,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                source.to_str().unwrap(),
                "module",
            ],
        );
        f.git(
            &parent,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-am",
                "submodule",
            ],
        );
        parent = parent.join("module");
    }
    let command = if kind == "clean" {
        "printf invoked > sentinel; cat"
    } else {
        "printf invoked > sentinel; exit 1"
    };
    f.git(
        &parent,
        &["config", &format!("filter.review.{kind}"), command],
    );
    // Avoid racily clean index entries and force equal-size content comparison.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    fs::write(parent.join("tracked"), "modified\n").unwrap();
    let sentinel = parent.join("sentinel");
    let _ = f
        .command("git", &f.root)
        .args(["status", "--porcelain"])
        .output()
        .unwrap();
    // Configured children are ignored by the parent; control their actual target.
    if configured {
        let _ = f
            .command("git", &f.root.join("repos/alpha"))
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
    }
    assert!(
        sentinel.exists(),
        "recursive {kind} control did not execute at depth {depth}"
    );
    fs::remove_file(&sentinel).unwrap();
    let before = f.snapshot();
    let output = f.run(false, &f.root, false);
    assert!(
        !sentinel.exists(),
        "doctor executed submodule {kind} at depth {depth}: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(before, f.snapshot(), "doctor changed fixture state");
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["error"]["code"], "PORT_UNSUPPORTED", "{value}");
    assert!(!output.status.success());
}
#[test]
fn submodule_clean_filter_is_rejected() {
    submodule_filter_guard("clean", 1, false);
}
#[test]
fn submodule_process_filter_is_rejected() {
    submodule_filter_guard("process", 1, false);
}
#[test]
fn nested_submodule_clean_filter_is_rejected() {
    submodule_filter_guard("clean", 2, true);
}
#[test]
fn nested_submodule_process_filter_is_rejected() {
    submodule_filter_guard("process", 2, true);
}

#[test]
fn configured_bases_without_remotes_match_source() {
    for mode in ["workspace", "overrides", "detached", "missing-child"] {
        let f = Fixture::new(true);
        f.children();
        let path = f.root.join(".arashi/config.json");
        let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        config["baseBranch"] = json!("origin/main");
        if mode == "overrides" {
            config["meta"] = json!({"baseBranch":"meta-base"});
            config["repos"]["alpha"]["baseBranch"] = json!("origin/child-base");
        }
        fs::write(path, serde_json::to_vec(&config).unwrap()).unwrap();
        f.git(&f.root, &["commit", "-am", "bases"]);
        if mode == "detached" {
            f.git(&f.root, &["checkout", "--detach"]);
        } else if mode == "missing-child" {
            fs::remove_dir_all(f.root.join("repos/alpha")).unwrap();
        } else {
            f.git(&f.root, &["checkout", "-b", "feature", "HEAD~1"]);
            // Keep the configuration on the feature while leaving main ahead.
            fs::write(
                f.root.join(".arashi/config.json"),
                serde_json::to_vec(&config).unwrap(),
            )
            .unwrap();
        }
        f.check(&f.root, &["REPOSITORY_CONFIGURED_BASE_UNAVAILABLE"]);
    }
}

#[test]
fn unborn_local_repositories_match_source() {
    for mode in ["standalone", "configured", "child", "orphan"] {
        let f = Fixture::new(mode != "standalone");
        let target = if mode == "child" {
            f.children();
            f.root.join("repos/alpha")
        } else {
            f.root.clone()
        };
        if mode == "standalone" {
            fs::create_dir(f.root.join(".worktrees")).unwrap();
        }
        if mode == "orphan" {
            f.git(&target, &["symbolic-ref", "HEAD", "refs/heads/unborn"]);
        } else {
            f.git(&target, &["update-ref", "-d", "refs/heads/main"]);
        }
        f.check(&f.root, &["REPOSITORY_DIRTY", "REPOSITORY_NO_UPSTREAM"]);
    }
}

#[test]
fn gitlinks_without_gitmodules_are_rejected_from_index_metadata() {
    let f = Fixture::new(true);
    let oid = f.git(&f.root, &["rev-parse", "HEAD"]);
    // NUL-delimited inspection must not depend on .gitmodules or path lines.
    let gitlink_path = if cfg!(windows) {
        "uninitialized module"
    } else {
        "uninitialized\tmodule\npath"
    };
    f.git(
        &f.root,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{},{gitlink_path}", oid.trim()),
        ],
    );
    let before = f.snapshot();
    let output = f.run(false, &f.root, false);
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["error"]["code"], "PORT_UNSUPPORTED");
    assert!(!output.status.success());
    assert_eq!(before, f.snapshot());
}
#[test]
fn unreadable_index_topology_fails_before_observation() {
    let f = Fixture::new(true);
    fs::write(f.root.join(".git/index"), "invalid index").unwrap();
    let before = f.snapshot();
    let output = f.run(false, &f.root, false);
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["error"]["code"], "PORT_UNSUPPORTED");
    assert!(!output.status.success());
    assert_eq!(before, f.snapshot());
}

#[test]
fn configured_base_repeated_origin_prefixes_match_source() {
    let f = Fixture::new(true);
    f.children();
    let path = f.root.join(".arashi/config.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    config["baseBranch"] = json!("origin/origin/main");
    config["repos"]["alpha"]["baseBranch"] = json!("origin/origin/origin/main");
    fs::write(path, serde_json::to_vec(&config).unwrap()).unwrap();
    f.check(&f.root, &["REPOSITORY_CONFIGURED_BASE_UNAVAILABLE"]);
}
