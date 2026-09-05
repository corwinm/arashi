// Local, disposable lifecycle oracles. Included by rust_parity for fixture reuse.
#[cfg(unix)]
mod lifecycle {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    const CREATE: &[&str] = &["create", "feature", "--no-launch", "--no-switch", "--json"];
    const REMOVE: &[&str] = &["remove", "feature", "--force", "--json"];
    fn hook(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    fn record(f: &Fixture, label: &str, o: &Output) {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/lifecycle");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("{label}.json")),
            serde_json::to_vec_pretty(&serde_json::json!({
                "exit":o.status.code(), "stdout":String::from_utf8_lossy(&o.stdout),
                "stderr":String::from_utf8_lossy(&o.stderr),"effects":f.coordinated_effects(),
                "trace":fs::read_to_string(f.home.join("trace")).unwrap_or_default()
            }))
            .unwrap(),
        )
        .unwrap();
    }
    fn trace_hook(path: &Path) {
        hook(
            path,
            r#"if IFS= read -r answer; then exit 91; fi
printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' "$ARASHI_HOOK_NAME" "$ARASHI_HOOK_SCOPE" "$ARASHI_HOOK_INPUT" "$PWD" "$ARASHI_HOOK_SOURCE_PATH" "$ARASHI_HOOK_TARGET_REPOSITORY" "$ARASHI_HOOK_TARGET_REPO_PATH" "$ARASHI_HOOK_TARGET_WORKTREE_PATH" "$ARASHI_REPO_PATH" "$ARASHI_PARENT_REPO_PATH" "$ARASHI_REMOVE_TARGETS_JSON" "$ARASHI_REMOVE_TARGET_REPOSITORIES" >> "$HOME/trace""#,
        );
    }
    fn fixture(create: bool, fail: &str) -> Fixture {
        let mut f = Fixture::new();
        f.configured();
        // Disable automatic maintenance only in this fixture's Git calls.
        for repo in ["", "repos/alpha", "repos/zulu"] {
            f.git(&["-C", p_or_dot(repo), "config", "maintenance.auto", "false"]);
        }
        if !create {
            let mut args = CREATE.to_vec();
            args.push("--no-hooks");
            assert!(f.run(false, &args).status.success());
        }
        let dir = f.repo.join(".arashi/hooks");
        let verb = if create { "create" } else { "remove" };
        for phase in ["pre", "post"] {
            trace_hook(&dir.join(format!("{phase}-{verb}.sh")));
            for name in ["workspace", "alpha", "zulu"] {
                trace_hook(&dir.join(format!("{phase}-{verb}.{name}.sh")));
                if !create {
                    trace_hook(
                        &f.home
                            .join(format!(".arashi/hooks/{name}/{phase}-{verb}.sh")),
                    );
                }
            }
            if !create {
                trace_hook(&f.home.join(format!(".arashi/hooks/{phase}-{verb}.sh")));
            }
        }
        if !fail.is_empty() {
            hook(
                &dir.join(format!("{fail}-{verb}.sh")),
                "printf failed >&2; exit 17",
            );
        }
        f
    }
    fn journey(create: bool, fail: &str, characterize: bool) {
        let f = fixture(create, fail);
        let args = if create { CREATE } else { REMOVE };
        let label = format!(
            "{}-{}",
            if create { "create" } else { "remove" },
            if fail.is_empty() { "success" } else { fail }
        );
        let source = if characterize || std::env::var_os("ARASHI_TS_PARITY").is_some() {
            let s = f.run(true, args);
            record(&f, &format!("source-{label}"), &s);
            assert_eq!(
                s.status.success(),
                fail.is_empty(),
                "{}",
                String::from_utf8_lossy(&s.stdout)
            );
            if characterize {
                return;
            }
            let trace = fs::read_to_string(f.home.join("trace")).unwrap_or_default();
            let effects = f.coordinated_effects();
            f.reset_coordinated();
            if !create {
                let mut a = CREATE.to_vec();
                a.push("--no-hooks");
                assert!(f.run(false, &a).status.success());
            }
            let _ = fs::remove_file(f.home.join("trace"));
            Some((s, trace, effects))
        } else {
            None
        };
        let n = f.run(false, args);
        record(&f, &format!("native-{label}"), &n);
        assert_eq!(
            n.status.success(),
            fail.is_empty(),
            "{}",
            String::from_utf8_lossy(&n.stdout)
        );
        if let Some((s, trace, effects)) = source {
            compare(&s, &n);
            assert_eq!(
                trace,
                fs::read_to_string(f.home.join("trace")).unwrap_or_default()
            );
            assert_eq!(effects, f.coordinated_effects());
        }
    }
    #[test]
    #[ignore = "retained source characterization only"]
    fn lifecycle_source_characterization() {
        for create in [true, false] {
            for failure in ["", "pre", "post"] {
                journey(create, failure, true);
            }
        }
    }
    #[test]
    fn lifecycle_create_files_source_contract() {
        journey(true, "", false);
    }
    #[test]
    fn lifecycle_remove_files_source_contract() {
        journey(false, "", false);
    }
    #[test]
    fn lifecycle_remove_failure_source_contract() {
        for phase in ["pre", "post"] {
            journey(false, phase, false);
        }
    }
    fn post_remove_continuation(body: &str, label: &str, continues: bool) {
        let f = fixture(false, "");
        fs::remove_dir_all(f.repo.join(".arashi/hooks")).unwrap();
        fs::remove_dir_all(f.home.join(".arashi/hooks")).unwrap();
        hook(&f.repo.join(".arashi/hooks/post-remove.workspace.sh"), body);
        hook(
            &f.repo.join(".arashi/hooks/post-remove.sh"),
            r#"if [ "$ARASHI_HOOK_TARGET_REPOSITORY" = workspace ]; then printf continued > "$HOME/trace"; fi"#,
        );
        let check = |source| {
            let output = f.run(source, REMOVE);
            record(
                &f,
                &format!("p2-{}-{label}", if source { "source" } else { "native" }),
                &output,
            );
            assert_eq!(output.status.code(), Some(1));
            assert_eq!(
                f.home.join("trace").exists(),
                continues,
                "{label}: {} post-remove continuation",
                if source { "source" } else { "native" }
            );
            assert!(!f.repo.join(".arashi/worktrees/feature").exists());
            output
        };
        let source = std::env::var_os("ARASHI_TS_PARITY").map(|_| {
            let output = check(true);
            let effects = f.coordinated_effects();
            f.reset_coordinated();
            let mut args = CREATE.to_vec();
            args.push("--no-hooks");
            assert!(f.run(false, &args).status.success());
            let _ = fs::remove_file(f.home.join("trace"));
            (output, effects)
        });
        let native = check(false);
        if let Some((source, effects)) = source {
            compare(&source, &native);
            assert_eq!(effects, f.coordinated_effects());
        }
    }
    #[test]
    fn lifecycle_post_remove_child_sigint_stops() {
        post_remove_continuation("kill -INT $$", "sigint", false);
    }
    #[test]
    fn lifecycle_post_remove_ordinary_failure_continues() {
        post_remove_continuation("exit 17", "exit17", true);
    }
    #[test]
    fn lifecycle_post_remove_explicit_exit130_continues() {
        post_remove_continuation("exit 130", "exit130", true);
    }
    #[test]
    fn lifecycle_create_slash_parent_source_contract() {
        let f = fixture(true, "");
        let mut args = CREATE.to_vec();
        args[1] = "topic/nested";
        let source = std::env::var_os("ARASHI_TS_PARITY").map(|_| {
            let o = f.run(true, &args);
            assert!(o.status.success());
            let trace = fs::read_to_string(f.home.join("trace")).unwrap();
            // Fixture-only cleanup supports this separate branch.
            for repo in ["repos/alpha", "repos/zulu", ""] {
                let target = f.repo.join(".arashi/worktrees/topic/nested").join(repo);
                f.git(&[
                    "-C",
                    p_or_dot(repo),
                    "worktree",
                    "remove",
                    "--force",
                    target.to_str().unwrap(),
                ]);
                f.git(&["-C", p_or_dot(repo), "branch", "-D", "topic/nested"]);
            }
            fs::remove_file(f.home.join("trace")).unwrap();
            (o, trace)
        });
        let native = f.run(false, &args);
        assert!(native.status.success());
        if let Some((s, trace)) = source {
            compare(&s, &native);
            assert_eq!(trace, fs::read_to_string(f.home.join("trace")).unwrap());
        }
    }
    #[test]
    fn lifecycle_timeout_descendants_source_contract() {
        for detached in [false, true] {
            let f = fixture(false, "");
            // Exercise one deliberately blocking hook. A short global deadline on
            // the success/order fixture can time out an unrelated earlier hook
            // under concurrent load, never exercising descendant cleanup at all.
            fs::remove_dir_all(f.repo.join(".arashi/hooks")).unwrap();
            fs::remove_dir_all(f.home.join(".arashi/hooks")).unwrap();
            let config_path = f.repo.join(".arashi/config.json");
            let mut config: Value =
                serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
            config["hooks"] = serde_json::json!({"timeout":3000});
            fs::write(config_path, serde_json::to_vec(&config).unwrap()).unwrap();
            let body = if detached {
                // Publish readiness only after detaching, retaining the inherited
                // descriptors so this exercises the source lineage contract.
                r#"python3 -c 'import os,time; os.setsid(); open(os.environ["HOME"]+"/ready","w").write("ready"); time.sleep(10); open(os.environ["HOME"]+"/late","w").write("escaped")' &
trap 'exit 0' TERM
wait"#
            } else {
                r#"(printf ready > "$HOME/ready"; sleep 10; printf escaped > "$HOME/late") &
trap 'exit 0' TERM
wait"#
            };
            hook(&f.repo.join(".arashi/hooks/pre-remove.zulu.sh"), body);
            let before = f.coordinated_effects();
            let assert_timeout_cleanup = |o: &Output| {
                assert!(!o.status.success());
                let result: Value = serde_json::from_slice(&o.stdout).unwrap();
                let outcomes = result["error"]["details"]["hookOutcomes"]
                    .as_array()
                    .unwrap();
                assert_eq!(outcomes.len(), 5);
                for outcome in &outcomes[..4] {
                    assert_eq!(outcome["hookStatus"], "skipped");
                    assert_eq!(outcome["reasonCode"], "not_found");
                }
                assert_eq!(outcomes[4]["repositoryId"], "zulu");
                assert_eq!(outcomes[4]["scope"], "repository");
                assert_eq!(outcomes[4]["hookName"], "pre-remove");
                assert_eq!(outcomes[4]["hookStatus"], "failure");
                assert_eq!(outcomes[4]["reasonCode"], "timeout");
                assert_eq!(
                    fs::read_to_string(f.home.join("ready")).expect("descendant must start"),
                    "ready"
                );
                // Outwait the descendant's delayed write even if it started just
                // before CLI exit. Readiness prevents a vacuous cleanup pass.
                std::thread::sleep(std::time::Duration::from_millis(10_100));
                assert!(
                    !f.home.join("late").exists(),
                    "timeout left a live descendant"
                );
                assert_eq!(before, f.coordinated_effects());
                fs::remove_file(f.home.join("ready")).unwrap();
            };
            let source = std::env::var_os("ARASHI_TS_PARITY").map(|_| {
                let o = f.run(true, REMOVE);
                record(
                    &f,
                    if detached {
                        "source-timeout-detached"
                    } else {
                        "source-timeout-tree"
                    },
                    &o,
                );
                assert_timeout_cleanup(&o);
                o
            });
            let n = f.run(false, REMOVE);
            record(
                &f,
                if detached {
                    "native-timeout-detached"
                } else {
                    "native-timeout-tree"
                },
                &n,
            );
            assert_timeout_cleanup(&n);
            if let Some(s) = source {
                compare(&s, &n);
            }
        }
    }

    #[test]
    fn lifecycle_create_failure_owned_rollback() {
        for phase in [
            "pre-create",
            "pre-create.alpha",
            "post-create.alpha",
            "post-create",
        ] {
            let f = fixture(true, "");
            hook(
                &f.repo.join(format!(".arashi/hooks/{phase}.sh")),
                r#"if [ -n "$ARASHI_WORKTREE_PATH" ]; then printf owned > "$ARASHI_WORKTREE_PATH/generated"; fi
printf failed >&2; exit 19"#,
            );
            let before = f.coordinated_effects();
            let source = std::env::var_os("ARASHI_TS_PARITY").map(|_| {
                let s = f.run(true, CREATE);
                record(&f, &format!("source-rollback-{phase}"), &s);
                assert!(!s.status.success());
                let mut v: Value = serde_json::from_slice(&s.stdout).unwrap();
                normalized(&mut v);
                assert_eq!(before, f.coordinated_effects());
                let _ = fs::remove_file(f.home.join("trace"));
                v["error"]["details"]["hookOutcomes"].clone()
            });
            let n = f.run(false, CREATE);
            record(&f, &format!("native-rollback-{phase}"), &n);
            assert!(!n.status.success());
            let mut v: Value = serde_json::from_slice(&n.stdout).unwrap();
            normalized(&mut v);
            assert_eq!(
                v["error"]["details"]["rollbackErrors"],
                serde_json::json!([])
            );
            assert_eq!(before, f.coordinated_effects());
            if let Some(outcomes) = source {
                assert_eq!(outcomes, v["error"]["details"]["hookOutcomes"]);
            }
        }
    }
    #[test]
    fn lifecycle_preflight_atomic_and_inactive_discovery() {
        for mode in [
            "invalid-post",
            "alias",
            "inline",
            "symlink",
            "human",
            "dry-run",
        ] {
            let f = fixture(false, "");
            let mut args = REMOVE.to_vec();
            match mode {
                "invalid-post" => fs::set_permissions(
                    f.repo.join(".arashi/hooks/post-remove.alpha.sh"),
                    fs::Permissions::from_mode(0o644),
                )
                .unwrap(),
                "alias" => hook(
                    &f.repo.join("repos/alpha/.arashi/hooks/pre-remove.sh"),
                    "printf bad > \"$HOME/unexpected\"",
                ),
                "inline" => {
                    let p = f.repo.join(".arashi/config.json");
                    let mut v: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
                    v["repos"]["alpha"]["hooks"] = serde_json::json!({"post-remove":"printf bad"});
                    fs::write(p, serde_json::to_vec(&v).unwrap()).unwrap();
                }
                "symlink" => {
                    let p = f.repo.join(".arashi/hooks/post-remove.alpha.sh");
                    fs::remove_file(&p).unwrap();
                    std::os::unix::fs::symlink(f.repo.join(".arashi/hooks/pre-remove.sh"), p)
                        .unwrap();
                }
                "human" => {
                    args.pop();
                }
                "dry-run" => args.push("--dry-run"),
                _ => unreachable!(),
            }
            let before = f.coordinated_effects();
            let n = f.run(false, &args);
            assert!(!n.status.success(), "{mode}");
            assert_eq!(before, f.coordinated_effects());
            assert!(
                !f.home.join("trace").exists(),
                "{mode} executed a hook before rejection"
            );
            assert!(!f.home.join("unexpected").exists());
        }
        let mut f = Fixture::new();
        f.configured();
        let dir = f.repo.join(".arashi/hooks");
        for filename in ["pre-create.sh.example", "pre-create.ps1", "PRE-CREATE.sh"] {
            hook(&dir.join(filename), "printf bad > \"$HOME/unexpected\"");
        }
        let s = std::env::var_os("ARASHI_TS_PARITY").map(|_| {
            let s = f.run(true, CREATE);
            f.reset_coordinated();
            s
        });
        let n = f.run(false, CREATE);
        assert!(n.status.success());
        assert!(!f.home.join("unexpected").exists());
        if let Some(s) = s {
            compare(&s, &n);
        }
    }

    #[test]
    fn lifecycle_remove_branch_only_and_compatible_source_contract() {
        let f = fixture(false, "");
        // Canonical and compatible child-local aliases have the same provenance slot.
        fs::rename(
            f.repo.join(".arashi/hooks/pre-remove.alpha.sh"),
            f.repo.join("pre-remove.tmp"),
        )
        .unwrap();
        fs::create_dir_all(f.repo.join("repos/alpha/.arashi/hooks")).unwrap();
        fs::rename(
            f.repo.join("pre-remove.tmp"),
            f.repo.join("repos/alpha/.arashi/hooks/pre-remove.sh"),
        )
        .unwrap();
        f.git(&[
            "-C",
            "repos/alpha",
            "worktree",
            "remove",
            "--force",
            f.repo
                .join(".arashi/worktrees/feature/repos/alpha")
                .to_str()
                .unwrap(),
        ]);
        let source = std::env::var_os("ARASHI_TS_PARITY").map(|_| {
            let s = f.run(true, REMOVE);
            assert!(s.status.success());
            let trace = fs::read_to_string(f.home.join("trace")).unwrap();
            let mut a = CREATE.to_vec();
            a.push("--no-hooks");
            assert!(f.run(false, &a).status.success());
            f.git(&[
                "-C",
                "repos/alpha",
                "worktree",
                "remove",
                "--force",
                f.repo
                    .join(".arashi/worktrees/feature/repos/alpha")
                    .to_str()
                    .unwrap(),
            ]);
            fs::remove_file(f.home.join("trace")).unwrap();
            (s, trace)
        });
        let n = f.run(false, REMOVE);
        assert!(n.status.success());
        if let Some((s, trace)) = source {
            compare(&s, &n);
            assert_eq!(trace, fs::read_to_string(f.home.join("trace")).unwrap());
        }
    }
    fn interrupt_run(f: &Fixture, source: bool, args: &[&str]) -> Output {
        let mut command = if source {
            let mut c = Command::new("node");
            c.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"));
            c
        } else {
            Command::new(env!("CARGO_BIN_EXE_arashi"))
        };
        f.environment(&mut command);
        command
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = command.spawn().unwrap();
        let start = std::time::Instant::now();
        while !f.home.join("ready").exists() {
            assert!(
                child.try_wait().unwrap().is_none(),
                "CLI exited before hook started"
            );
            if start.elapsed() > std::time::Duration::from_secs(240) {
                child.kill().unwrap();
                panic!("Hook did not become ready");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(
            Command::new("/bin/kill")
                .args(["-INT", &child.id().to_string()])
                .status()
                .unwrap()
                .success()
        );
        let signaled = std::time::Instant::now();
        while child.try_wait().unwrap().is_none() {
            if signaled.elapsed() > std::time::Duration::from_secs(60) {
                child.kill().unwrap();
                panic!("Interrupted CLI did not settle");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        child.wait_with_output().unwrap()
    }
    #[test]
    fn lifecycle_direct_interrupt_and_tree_cleanup() {
        for create in [false, true] {
            let f = fixture(create, "");
            let phase = if create {
                "post-create.alpha"
            } else {
                "pre-remove.zulu"
            };
            hook(
                &f.repo.join(format!(".arashi/hooks/{phase}.sh")),
                r#"(sleep 2; printf escaped > "$HOME/late") &
printf ready > "$HOME/ready"
wait"#,
            );
            let before = f.coordinated_effects();
            let args = if create { CREATE } else { REMOVE };
            let source = std::env::var_os("ARASHI_TS_PARITY").map(|_| {
                let o = interrupt_run(&f, true, args);
                record(&f, &format!("source-interrupt-{phase}"), &o);
                assert!(!o.status.success());
                assert_eq!(before, f.coordinated_effects());
                std::thread::sleep(std::time::Duration::from_millis(2100));
                assert!(!f.home.join("late").exists());
                fs::remove_file(f.home.join("ready")).unwrap();
                let _ = fs::remove_file(f.home.join("trace"));
                o
            });
            let n = interrupt_run(&f, false, args);
            record(&f, &format!("native-interrupt-{phase}"), &n);
            assert!(!n.status.success());
            assert_eq!(before, f.coordinated_effects());
            std::thread::sleep(std::time::Duration::from_millis(2100));
            assert!(!f.home.join("late").exists());
            if let Some(s) = source {
                if create {
                    let mut s: Value = serde_json::from_slice(&s.stdout).unwrap();
                    let mut n: Value = serde_json::from_slice(&n.stdout).unwrap();
                    normalized(&mut s);
                    normalized(&mut n);
                    assert_eq!(
                        s["error"]["details"]["hookOutcomes"],
                        n["error"]["details"]["hookOutcomes"]
                    );
                } else {
                    compare(&s, &n);
                }
            }
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn lifecycle_macos_enoexec_never_runs_implicit_shell() {
        let f = fixture(false, "");
        fs::write(
            f.repo.join(".arashi/hooks/pre-remove.zulu.sh"),
            "printf bad > \"$HOME/implicit-shell\"\n",
        )
        .unwrap();
        let before = f.coordinated_effects();
        let source = std::env::var_os("ARASHI_TS_PARITY").map(|_| f.run(true, REMOVE));
        let n = f.run(false, REMOVE);
        assert!(!n.status.success());
        assert!(!f.home.join("implicit-shell").exists());
        assert_eq!(before, f.coordinated_effects());
        if let Some(s) = source {
            compare(&s, &n);
        }
    }
    #[test]
    fn lifecycle_revalidates_roots_after_repository_hooks() {
        let f = fixture(true, "");
        hook(
            &f.repo.join(".arashi/hooks/post-create.workspace.sh"),
            r#"mv "$ARASHI_MAIN_REPO_PATH/repos/alpha" "$HOME/alpha-source"
ln -s "$HOME/alpha-source" "$ARASHI_MAIN_REPO_PATH/repos/alpha""#,
        );
        let n = f.run(false, CREATE);
        assert!(
            !n.status.success(),
            "{}",
            String::from_utf8_lossy(&n.stdout)
        );
        assert!(
            f.git(&[
                "-C",
                f.home.join("alpha-source").to_str().unwrap(),
                "branch",
                "--list",
                "feature"
            ])
            .trim()
            .is_empty(),
            "hook redirected a later mutation outside planned roots"
        );
        assert!(!f.repo.join(".arashi/worktrees/feature").exists());
    }
    #[test]
    fn lifecycle_selected_child_and_reused_branch_rollback() {
        for failure in [false, true] {
            let f = fixture(true, "");
            let mut args = CREATE.to_vec();
            args.extend(["--only", "alpha"]);
            if failure {
                f.git(&["-C", "repos/alpha", "branch", "feature"]);
                args.extend(["--conflict", "REUSE_EXISTING"]);
                hook(
                    &f.repo.join(".arashi/hooks/post-create.alpha.sh"),
                    r#"printf owned > "$ARASHI_WORKTREE_PATH/generated"; exit 9"#,
                );
            }
            let before = f.coordinated_effects();
            let source = std::env::var_os("ARASHI_TS_PARITY").map(|_| {
                let s = f.run(true, &args);
                assert_eq!(s.status.success(), !failure);
                let trace = fs::read_to_string(f.home.join("trace")).unwrap();
                let effects = f.coordinated_effects();
                if failure {
                    assert_eq!(before, effects);
                } else {
                    f.reset_coordinated();
                }
                fs::remove_file(f.home.join("trace")).unwrap();
                (s, trace, effects)
            });
            let n = f.run(false, &args);
            assert_eq!(
                n.status.success(),
                !failure,
                "{}",
                String::from_utf8_lossy(&n.stdout)
            );
            if failure {
                assert_eq!(before, f.coordinated_effects());
            }
            if let Some((s, trace, effects)) = source {
                if !failure {
                    compare(&s, &n);
                } else {
                    let v: Value = serde_json::from_slice(&n.stdout).unwrap();
                    assert_eq!(
                        v["error"]["details"]["rollbackErrors"],
                        serde_json::json!([])
                    );
                }
                assert_eq!(trace, fs::read_to_string(f.home.join("trace")).unwrap());
                assert_eq!(effects, f.coordinated_effects());
            }
        }
    }
    fn home_journey(create: bool) {
        let mut f = Fixture::new();
        f.configured();
        let mut disabled = CREATE.to_vec();
        disabled.push("--no-hooks");
        if !create {
            assert!(f.run(false, &disabled).status.success());
        }
        let verb = if create { "create" } else { "remove" };
        hook(
            &f.repo.join(format!(".arashi/hooks/pre-{verb}.sh")),
            r#"printf '%s|%s|%s\n' "$ARASHI_HOOK_SOURCE_PATH" "$ARASHI_HOOK_SCOPE" "$PWD" >> "$ARASHI_MAIN_REPO_PATH/.arashi/home-provenance.trace""#,
        );
        let run = |source: bool| {
            let mut command = if source {
                let mut c = Command::new("node");
                c.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"));
                c
            } else {
                Command::new(env!("CARGO_BIN_EXE_arashi"))
            };
            f.environment(&mut command);
            // Git remains isolated by an explicit fixture GIT_CONFIG_GLOBAL.
            command.env_remove("HOME").env_remove("USERPROFILE");
            if !create {
                command.env("HOME", ".");
            }
            command
                .args(if create { CREATE } else { REMOVE })
                .output()
                .unwrap()
        };
        let trace_path = f.repo.join(".arashi/home-provenance.trace");
        let source = std::env::var_os("ARASHI_TS_PARITY").map(|_| {
            let o = run(true);
            record(&f, &format!("source-home-{verb}"), &o);
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stdout));
            let trace = fs::read_to_string(&trace_path).unwrap();
            f.reset_coordinated();
            if !create {
                assert!(f.run(false, &disabled).status.success());
            }
            fs::remove_file(&trace_path).unwrap();
            (o, trace)
        });
        let n = run(false);
        record(&f, &format!("native-home-{verb}"), &n);
        assert!(n.status.success(), "{}", String::from_utf8_lossy(&n.stdout));
        if let Some((o, trace)) = source {
            compare(&o, &n);
            assert_eq!(trace, fs::read_to_string(&trace_path).unwrap());
        }
    }
    #[test]
    fn lifecycle_create_without_home_source_contract() {
        home_journey(true);
    }
    #[test]
    fn lifecycle_remove_relative_home_provenance_source_contract() {
        home_journey(false);
    }
    #[test]
    fn lifecycle_rejects_traversing_child_projection_before_hooks() {
        for (absolute, skip_hooks) in [(false, false), (true, false), (false, true), (true, true)] {
            let f = fixture(true, "");
            let path = f.repo.join(".arashi/config.json");
            let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            config["repos"]["alpha"]["path"] = serde_json::json!(if absolute {
                f.repo
                    .join("../workspace/repos/alpha")
                    .to_string_lossy()
                    .into_owned()
            } else {
                "../workspace/repos/alpha".into()
            });
            fs::write(path, serde_json::to_vec(&config).unwrap()).unwrap();
            let before = f.coordinated_effects();
            let mut args = CREATE.to_vec();
            if skip_hooks {
                args.push("--no-hooks");
            }
            let native = f.run(false, &args);
            assert!(
                !native.status.success(),
                "{}",
                String::from_utf8_lossy(&native.stdout)
            );
            assert_eq!(before, f.coordinated_effects());
            assert!(
                !f.home.join("trace").exists(),
                "unsupported traversal executed a hook"
            );
        }
    }
    #[test]
    fn lifecycle_preserves_source_session_launch_contract() {
        let f = fixture(false, "");
        fs::write(
            f.repo.join(".arashi/hooks/pre-remove.sh"),
            r#"#!/usr/bin/env python3
import os
os.setsid()
with open(os.environ["ARASHI_MAIN_REPO_PATH"] + "/.arashi/session-probe", "w") as out:
    out.write("session-created")
"#,
        )
        .unwrap();
        let source = std::env::var_os("ARASHI_TS_PARITY").map(|_| {
            let s = f.run(true, REMOVE);
            record(&f, "source-session-launch", &s);
            assert!(s.status.success(), "{}", String::from_utf8_lossy(&s.stdout));
            assert_eq!(
                fs::read_to_string(f.repo.join(".arashi/session-probe")).unwrap(),
                "session-created"
            );
            f.reset_coordinated();
            let mut a = CREATE.to_vec();
            a.push("--no-hooks");
            assert!(f.run(false, &a).status.success());
            fs::remove_file(f.repo.join(".arashi/session-probe")).unwrap();
            let _ = fs::remove_file(f.home.join("trace"));
            s
        });
        let n = f.run(false, REMOVE);
        record(&f, "native-session-launch", &n);
        assert!(n.status.success(), "{}", String::from_utf8_lossy(&n.stdout));
        assert_eq!(
            fs::read_to_string(f.repo.join(".arashi/session-probe")).unwrap(),
            "session-created"
        );
        if let Some(s) = source {
            compare(&s, &n);
        }
    }
    #[test]
    fn lifecycle_terminal_input_is_rejected_before_hooks() {
        let f = fixture(false, "");
        let before = f.coordinated_effects();
        let argv = std::iter::once(env!("CARGO_BIN_EXE_arashi"))
            .chain(REMOVE.iter().copied())
            .collect::<Vec<_>>();
        let mut command = Command::new("python3");
        f.environment(&mut command);
        let script = r#"import os,pty,subprocess,sys,json
master,slave=pty.openpty()
try:
    result=subprocess.run(json.loads(sys.argv[1]),stdin=slave,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    sys.stdout.buffer.write(result.stdout)
    sys.stderr.buffer.write(result.stderr)
    sys.exit(result.returncode)
finally:
    os.close(slave)
    os.close(master)
"#;
        let n = command
            .args(["-c", script, &serde_json::to_string(&argv).unwrap()])
            .output()
            .unwrap();
        assert!(
            !n.status.success(),
            "{}",
            String::from_utf8_lossy(&n.stdout)
        );
        let v: Value = serde_json::from_slice(&n.stdout).unwrap();
        assert_eq!(v["error"]["code"], "RUST_NOT_YET_PORTED");
        assert_eq!(before, f.coordinated_effects());
        assert!(!f.home.join("trace").exists());
    }
}
