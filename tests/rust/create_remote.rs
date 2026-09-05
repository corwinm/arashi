mod create_remote {
    use super::*;
    const ARGS: &[&str] = &[
        "create",
        "feature",
        "--no-hooks",
        "--no-launch",
        "--no-switch",
        "--json",
        "--conflict",
        "REUSE_EXISTING",
    ];
    fn fixture(mixed: bool) -> Fixture {
        let mut f = Fixture::new();
        f.configured();
        for repo in ["", "repos/alpha", "repos/zulu"] {
            if mixed && repo != "repos/alpha" {
                continue;
            }
            let p = p_or_dot(repo);
            f.git(&["-C", p, "config", "maintenance.auto", "false"]);
            f.git(&["-C", p, "checkout", "-b", "feature"]);
            f.git(&[
                "-C",
                p,
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "remote target",
            ]);
            let remote = f.base.join(if repo.is_empty() {
                "meta.git"
            } else if repo.ends_with("alpha") {
                "alpha.git"
            } else {
                "zulu.git"
            });
            f.git(&[
                "clone",
                "--bare",
                f.repo.join(repo).to_str().unwrap(),
                remote.to_str().unwrap(),
            ]);
            f.git(&[
                "-C",
                remote.to_str().unwrap(),
                "symbolic-ref",
                "HEAD",
                "refs/heads/main",
            ]);
            f.git(&["-C", p, "checkout", "main"]);
            f.git(&["-C", p, "branch", "-D", "feature"]);
            f.git(&["-C", p, "remote", "add", "origin", remote.to_str().unwrap()]);
            f.git(&["-C", p, "fetch", "origin"]);
        }
        f
    }
    #[cfg(unix)]
    fn effects(f: &Fixture) -> Vec<String> {
        ["", "repos/alpha", "repos/zulu"]
            .iter()
            .flat_map(|p| {
                [
                    f.git(&[
                        "-C",
                        p_or_dot(p),
                        "for-each-ref",
                        "--format=%(refname) %(objectname) %(upstream)",
                    ]),
                    f.git(&["-C", p_or_dot(p), "worktree", "list", "--porcelain"]),
                    f.git(&["-C", p_or_dot(p), "config", "--list"]),
                ]
            })
            .collect()
    }
    fn snapshot(p: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        fn walk(p: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
            let m = fs::symlink_metadata(p).unwrap();
            out.push((
                p.to_owned(),
                if m.is_file() {
                    fs::read(p).unwrap()
                } else if m.is_symlink() {
                    fs::read_link(p)
                        .unwrap()
                        .as_os_str()
                        .as_encoded_bytes()
                        .to_vec()
                } else {
                    vec![]
                },
            ));
            if m.is_dir() {
                let mut paths = fs::read_dir(p)
                    .unwrap()
                    .map(|p| p.unwrap().path())
                    .collect::<Vec<_>>();
                paths.sort();
                for child in paths {
                    walk(&child, out);
                }
            }
        }
        let mut out = vec![];
        walk(p, &mut out);
        out
    }
    #[cfg(unix)]
    fn evidence(label: &str, source: &Output, native: &Output) {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/create-remote-only");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{label}.json")), serde_json::to_vec_pretty(&serde_json::json!({"source":{"exit":source.status.code(),"stdout":String::from_utf8_lossy(&source.stdout),"stderr":String::from_utf8_lossy(&source.stderr)},"native":{"exit":native.status.code(),"stdout":String::from_utf8_lossy(&native.stdout),"stderr":String::from_utf8_lossy(&native.stderr)}})).unwrap()).unwrap();
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "requires Node and TypeScript dependencies"]
    fn create_remote_success_and_selection() {
        for (label, mixed, filter) in [
            ("full", false, vec![]),
            ("selected", false, vec!["--only", "alpha"]),
            ("mixed", true, vec![]),
            ("packed-bare", true, vec![]),
            ("mixed-local", true, vec![]),
            ("explicit-base", true, vec!["--base", "main"]),
            ("group", true, vec!["--group", "UI"]),
            ("order", true, vec!["--only", "zulu,alpha"]),
        ] {
            let f = fixture(mixed);
            if label == "packed-bare" {
                f.git(&[
                    "-C",
                    f.base.join("alpha.git").to_str().unwrap(),
                    "pack-refs",
                    "--all",
                    "--prune",
                ]);
            }
            if label == "mixed-local" {
                f.git(&["-C", "repos/zulu", "branch", "feature"]);
            }
            let mut args = ARGS.to_vec();
            args.extend(filter);
            let remote_before = snapshot(&f.base.join("alpha.git"));
            let source = f.run(true, &args);
            let expected = effects(&f);
            let source_tree = snapshot(&f.repo.join(".arashi/worktrees/feature"));
            f.reset_coordinated();
            if label == "mixed-local" {
                f.git(&["-C", "repos/zulu", "branch", "feature"]);
            }
            let native = f.run(false, &args);
            evidence(label, &source, &native);
            compare(&source, &native);
            assert_eq!(expected, effects(&f));
            assert_eq!(
                source_tree,
                snapshot(&f.repo.join(".arashi/worktrees/feature"))
            );
            fs::write(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("target/create-remote-only/{label}-effects.json")),serde_json::to_vec_pretty(&serde_json::json!({"source":expected,"native":effects(&f),"sourceTree":source_tree,"nativeTree":snapshot(&f.repo.join(".arashi/worktrees/feature"))})).unwrap()).unwrap();
            assert_eq!(remote_before, snapshot(&f.base.join("alpha.git")));
            for p in ["", "repos/alpha", "repos/zulu"] {
                let row = f.git(&[
                    "-C",
                    p_or_dot(p),
                    "for-each-ref",
                    "--format=%(upstream)",
                    "refs/heads/feature",
                ]);
                assert!(row.trim().is_empty());
            }
        }
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "requires Node and TypeScript dependencies"]
    fn create_remote_abort_and_dry_nonmutation() {
        for policy in ["ABORT", "REUSE_EXISTING"] {
            for dry in [true, false] {
                if policy == "REUSE_EXISTING" && !dry {
                    continue;
                }
                let f = fixture(true);
                let mut args = ARGS.to_vec();
                *args.last_mut().unwrap() = policy;
                if dry {
                    args.push("--dry-run");
                }
                let before = snapshot(&f.base);
                let source = f.run(true, &args);
                assert_eq!(before, snapshot(&f.base));
                let native = f.run(false, &args);
                assert_eq!(before, snapshot(&f.base));
                evidence(&format!("{policy}-{dry}"), &source, &native);
                compare(&source, &native);
            }
        }
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "requires Node and TypeScript dependencies"]
    fn create_remote_absent_target_keeps_conflict_free_create() {
        let f = fixture(true);
        f.git(&[
            "-C",
            "repos/alpha",
            "config",
            "branch.main.remote",
            "origin",
        ]);
        f.git(&[
            "-C",
            "repos/alpha",
            "config",
            "branch.main.merge",
            "refs/heads/main",
        ]);
        f.git(&[
            "-C",
            f.base.join("alpha.git").to_str().unwrap(),
            "update-ref",
            "-d",
            "refs/heads/feature",
        ]);
        f.git(&[
            "-C",
            "repos/alpha",
            "update-ref",
            "-d",
            "refs/remotes/origin/feature",
        ]);
        let source = f.run(true, ARGS);
        let expected = effects(&f);
        f.reset_coordinated();
        let native = f.run(false, ARGS);
        evidence("absent-target", &source, &native);
        compare(&source, &native);
        assert_eq!(expected, effects(&f));
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "requires Node and TypeScript dependencies"]
    fn create_remote_mixed_base_abort_and_dry_actions() {
        for (policy, dry) in [("ABORT", false), ("ABORT", true), ("REUSE_EXISTING", true)] {
            let f = fixture(true);
            f.git(&["-C", "repos/zulu", "branch", "feature"]);
            let mut args = ARGS.to_vec();
            *args.last_mut().unwrap() = policy;
            args.extend(["--base", "main"]);
            if dry {
                args.push("--dry-run");
            }
            let before = snapshot(&f.base);
            let source = f.run(true, &args);
            assert_eq!(before, snapshot(&f.base));
            let native = f.run(false, &args);
            assert_eq!(before, snapshot(&f.base));
            evidence(&format!("mixed-base-{policy}-{dry}"), &source, &native);
            compare(&source, &native);
        }
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "requires Node and TypeScript dependencies"]
    fn create_remote_ignore_changes_fail_closed() {
        let f = fixture(true);
        fs::write(f.repo.join(".gitignore"), "repos/\n").unwrap();
        f.git(&["add", ".gitignore"]);
        f.git(&["commit", "-m", "require worktree ignore"]);
        let before = snapshot(&f.base);
        let mut args = ARGS.to_vec();
        *args.last_mut().unwrap() = "ABORT";
        let source = f.run(true, &args);
        assert_eq!(source.status.code(), Some(1));
        let value: Value = serde_json::from_slice(&source.stdout).unwrap();
        assert_eq!(value["error"]["details"]["managedIgnore"]["restored"], true);
        assert_eq!(before, snapshot(&f.base));
        for policy in ["ABORT", "REUSE_EXISTING"] {
            *args.last_mut().unwrap() = policy;
            let native = f.run(false, &args);
            evidence(&format!("ignore-required-{policy}"), &source, &native);
            let value: Value = serde_json::from_slice(&native.stdout).unwrap();
            assert_eq!(value["error"]["code"], "RUST_NOT_YET_PORTED");
            assert_eq!(before, snapshot(&f.base));
        }
    }
    #[cfg(unix)]
    #[test]
    fn create_remote_unsupported_nonmutation() {
        use std::os::unix::fs::symlink;
        for kind in [
            "protocol-policy",
            "remote-promisor",
            "mixed-git-hook",
            "symbolic-tracking",
            "network",
            "network-broken-tracking",
            "packed-tracking",
            "malformed-tracking",
            "dangling-tracking",
            "dangling-tracking-object",
            "multiple",
            "non-origin",
            "missing-tracking",
            "stale-tracking",
            "remote-base",
            "dirty",
            "dirty-mixed",
            "locked",
            "checked-out",
            "occupied",
            "filter",
            "fsmonitor",
            "git-hook",
            "materialization",
            "hooks",
            "human",
            "symlink-remote",
            "protected",
            "gitlink",
            "mixed-gitlink",
        ] {
            let f = fixture(true);
            let mut args = ARGS.to_vec();
            match kind {
                "protocol-policy" => {
                    f.git(&[
                        "-C",
                        "repos/alpha",
                        "config",
                        "protocol.file.allow",
                        "never",
                    ]);
                }
                "remote-promisor" => {
                    f.git(&[
                        "-C",
                        f.base.join("alpha.git").to_str().unwrap(),
                        "config",
                        "remote.origin.promisor",
                        "true",
                    ]);
                }
                "dangling-tracking-object" => {
                    let oid = f.git(&[
                        "-C",
                        "repos/alpha",
                        "rev-parse",
                        "refs/remotes/origin/feature",
                    ]);
                    let oid = oid.trim();
                    fs::remove_file(
                        f.repo
                            .join("repos/alpha/.git/objects")
                            .join(&oid[..2])
                            .join(&oid[2..]),
                    )
                    .unwrap();
                }
                "packed-tracking" => {
                    f.git(&["-C", "repos/alpha", "pack-refs", "--all", "--prune"]);
                }
                "malformed-tracking" => {
                    fs::write(
                        f.repo.join("repos/alpha/.git/refs/remotes/origin/feature"),
                        "not-an-oid\n",
                    )
                    .unwrap();
                }
                "dangling-tracking" => {
                    f.git(&[
                        "-C",
                        "repos/alpha",
                        "symbolic-ref",
                        "refs/remotes/origin/feature",
                        "refs/remotes/origin/absent",
                    ]);
                }
                "network-broken-tracking" => {
                    f.git(&[
                        "-C",
                        "repos/alpha",
                        "remote",
                        "set-url",
                        "origin",
                        "https://example.invalid/repo.git",
                    ]);
                    f.git(&[
                        "-C",
                        "repos/alpha",
                        "config",
                        "protocol.https.allow",
                        "never",
                    ]);
                    fs::write(
                        f.repo.join("repos/alpha/.git/refs/remotes/origin/feature"),
                        "0000000000000000000000000000000000000000\n",
                    )
                    .unwrap();
                }
                "network" => {
                    f.git(&[
                        "-C",
                        "repos/alpha",
                        "remote",
                        "set-url",
                        "origin",
                        "https://example.invalid/repo.git",
                    ]);
                }
                "multiple" => {
                    f.git(&[
                        "-C",
                        "repos/alpha",
                        "remote",
                        "add",
                        "other",
                        "https://example.invalid/repo.git",
                    ]);
                }
                "non-origin" => {
                    f.git(&["-C", "repos/alpha", "remote", "rename", "origin", "other"]);
                }
                "missing-tracking" => {
                    f.git(&[
                        "-C",
                        "repos/alpha",
                        "update-ref",
                        "-d",
                        "refs/remotes/origin/feature",
                    ]);
                }
                "stale-tracking" => {
                    f.git(&[
                        "-C",
                        "repos/alpha",
                        "update-ref",
                        "refs/remotes/origin/feature",
                        "main",
                    ]);
                }
                "remote-base" => {
                    args.extend(["--base", "feature"]);
                }
                "dirty" => {
                    fs::write(f.repo.join("repos/alpha/dirty"), "keep").unwrap();
                }
                "dirty-mixed" => {
                    fs::write(f.repo.join("dirty"), "keep").unwrap();
                }
                "locked" | "checked-out" | "protected" => {
                    let dest = f.base.join("elsewhere");
                    f.git(&[
                        "-C",
                        "repos/alpha",
                        "worktree",
                        "add",
                        "-b",
                        "feature",
                        dest.to_str().unwrap(),
                        "main",
                    ]);
                    if kind == "locked" {
                        f.git(&[
                            "-C",
                            "repos/alpha",
                            "worktree",
                            "lock",
                            dest.to_str().unwrap(),
                        ]);
                    }
                    if kind == "protected" {
                        f.git(&[
                            "-C",
                            "repos/alpha",
                            "worktree",
                            "remove",
                            dest.to_str().unwrap(),
                        ]);
                        f.git(&["-C", "repos/alpha", "checkout", "feature"]);
                    }
                }
                "occupied" => {
                    fs::create_dir_all(f.repo.join(".arashi/worktrees/feature")).unwrap();
                }
                "filter" => {
                    f.git(&["-C", "repos/alpha", "config", "filter.test.clean", "false"]);
                }
                "fsmonitor" => {
                    f.git(&["-C", "repos/alpha", "config", "core.fsmonitor", "false"]);
                }
                "git-hook" | "mixed-git-hook" => {
                    fs::write(
                        f.repo.join(if kind == "git-hook" {
                            "repos/alpha/.git/hooks/post-checkout"
                        } else {
                            ".git/hooks/post-checkout"
                        }),
                        "#!/bin/sh\nexit 1\n",
                    )
                    .unwrap();
                }
                "symbolic-tracking" => {
                    f.git(&[
                        "-C",
                        "repos/alpha",
                        "symbolic-ref",
                        "refs/remotes/origin/feature",
                        "refs/remotes/origin/main",
                    ]);
                    f.git(&[
                        "-C",
                        f.base.join("alpha.git").to_str().unwrap(),
                        "update-ref",
                        "refs/heads/feature",
                        "main",
                    ]);
                }
                "materialization" => {
                    let p = f.repo.join(".arashi/config.json");
                    let mut v: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
                    v["repos"]["alpha"]["copy"] = serde_json::json!(["file.txt"]);
                    fs::write(p, serde_json::to_vec(&v).unwrap()).unwrap();
                }
                "hooks" => {
                    args.retain(|a| *a != "--no-hooks");
                }
                "human" => {
                    args.retain(|a| *a != "--json");
                }
                "symlink-remote" => {
                    let link = f.base.join("linked.git");
                    symlink(f.base.join("alpha.git"), &link).unwrap();
                    f.git(&[
                        "-C",
                        "repos/alpha",
                        "remote",
                        "set-url",
                        "origin",
                        link.to_str().unwrap(),
                    ]);
                }
                "gitlink" | "mixed-gitlink" => {
                    let p = if kind == "gitlink" {
                        "repos/alpha"
                    } else {
                        "."
                    };
                    let oid = f.git(&["-C", p, "rev-parse", "HEAD"]);
                    f.git(&[
                        "-C",
                        p,
                        "update-index",
                        "--add",
                        "--cacheinfo",
                        &format!("160000,{},nested", oid.trim()),
                    ]);
                }
                _ => unreachable!(),
            }
            let before = snapshot(&f.base);
            let n = f.run(false, &args);
            assert!(
                !n.status.success(),
                "{kind}: {}",
                String::from_utf8_lossy(&n.stdout)
            );
            assert_eq!(before, snapshot(&f.base), "{kind} mutated");
        }
    }
    #[cfg(unix)]
    fn injected(f: &Fixture, body: &str) -> Output {
        injected_args(f, body, &[])
    }
    #[cfg(unix)]
    fn injected_args(f: &Fixture, body: &str, extra: &[&str]) -> Output {
        injected_engine(f, body, extra, "native")
    }
    #[cfg(unix)]
    fn injected_engine(f: &Fixture, body: &str, extra: &[&str], engine: &str) -> Output {
        use std::os::unix::fs::PermissionsExt;
        let real = Command::new("which").arg("git").output().unwrap();
        let real = String::from_utf8(real.stdout).unwrap();
        let bin = f.home.join("bin");
        fs::create_dir(&bin).unwrap();
        fs::write(
            bin.join("git"),
            format!(
                "#!/bin/sh\n{body}\nexec '{}' \"$@\"\n",
                real.trim().replace('\'', "'\\''")
            ),
        )
        .unwrap();
        fs::set_permissions(bin.join("git"), fs::Permissions::from_mode(0o755)).unwrap();
        let mut c = match engine {
            "source" => {
                let mut c = Command::new("node");
                c.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"));
                c
            }
            "baseline" => Command::new(std::env::var_os("ARASHI_REVIEW_BASELINE").unwrap()),
            _ => Command::new(env!("CARGO_BIN_EXE_arashi")),
        };
        c.current_dir(&f.repo);
        f.environment(&mut c);
        c.env(
            "PATH",
            format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()),
        )
        .env("REAL_GIT", real.trim())
        .env("ROOT", &f.repo)
        .args(ARGS)
        .args(extra)
        .output()
        .unwrap()
    }
    #[cfg(unix)]
    #[test]
    fn create_remote_dry_ref_change_before_success() {
        let f = fixture(true);
        let n = injected_args(
            &f,
            r#"if [ "$1" = config ] && [ "$2" = --local ] && [ "$4" = arashi.ignoreScope ]; then
"$REAL_GIT" -C "$ROOT/repos/alpha" update-ref refs/remotes/origin/feature main
fi"#,
            &["--dry-run"],
        );
        assert!(
            !n.status.success(),
            "dry-run published stale plan: {}",
            String::from_utf8_lossy(&n.stdout)
        );
        assert!(!f.repo.join(".arashi/worktrees/feature").exists());
    }
    #[cfg(unix)]
    #[test]
    fn create_remote_final_ref_change_preserves_existing_branch() {
        let f = fixture(true);
        f.git(&["-C", "repos/zulu", "branch", "feature"]);
        let before = f.git(&["-C", "repos/zulu", "show-ref", "--heads"]);
        let n = injected(
            &f,
            r#"if [ "$1" = worktree ] && [ "$2" = add ] && [ "$(basename "$PWD")" = zulu ]; then
"$REAL_GIT" -C "$ROOT/repos/alpha" update-ref refs/remotes/origin/feature main
fi"#,
        );
        assert!(!n.status.success());
        assert_eq!(before, f.git(&["-C", "repos/zulu", "show-ref", "--heads"]));
        assert!(!f.repo.join(".arashi/worktrees/feature").exists());
        for p in [".", "repos/alpha"] {
            assert!(
                f.git(&["-C", p, "branch", "--list", "feature"])
                    .trim()
                    .is_empty()
            );
        }
    }
    #[cfg(unix)]
    #[test]
    fn create_remote_changed_tracking_rolls_back_owned_branches() {
        let f = fixture(true);
        let n = injected(
            &f,
            r#"if [ "$1" = branch ] && [ "$2" = feature ] && [ "$PWD" = "$ROOT" ]; then
"$REAL_GIT" -C "$ROOT/repos/alpha" update-ref refs/remotes/origin/feature main
fi"#,
        );
        assert!(!n.status.success());
        for p in [".", "repos/alpha", "repos/zulu"] {
            assert!(
                f.git(&["-C", p, "branch", "--list", "feature"])
                    .trim()
                    .is_empty()
            );
        }
        assert_eq!(
            f.git(&["-C", "repos/alpha", "rev-parse", "main"]),
            f.git(&[
                "-C",
                "repos/alpha",
                "rev-parse",
                "refs/remotes/origin/feature"
            ])
        );
        assert!(!f.repo.join(".arashi/worktrees/feature").exists());
    }
    #[cfg(unix)]
    #[test]
    fn create_remote_replaced_created_worktree_is_preserved() {
        let f = fixture(true);
        let n = injected(
            &f,
            r#"if [ "$1" = branch ] && [ "$2" = feature ] && [ "$(basename "$PWD")" = zulu ]; then
mv "$ROOT/.arashi/worktrees/feature/repos/alpha" "$HOME/original"
cp -R "$HOME/original" "$ROOT/.arashi/worktrees/feature/repos/alpha"
fi"#,
        );
        assert!(
            !n.status.success(),
            "replacement not detected: {}",
            String::from_utf8_lossy(&n.stdout)
        );
        assert!(
            f.repo
                .join(".arashi/worktrees/feature/repos/alpha/.git")
                .exists()
        );
        assert!(f.home.join("original/.git").exists());
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "requires Node and TypeScript dependencies"]
    fn create_remote_review_conflict_free_remotes() {
        let mut failures = vec![];
        for kind in [
            "https",
            "multiple",
            "unsupported-config",
            "remote-prefix",
            "remote-prefix-packed",
            "promisor-with-local-base",
        ] {
            let f = if kind == "promisor-with-local-base" {
                review2_promisor_fixture(false, None)
            } else {
                fixture(true)
            };
            f.git(&[
                "-C",
                "repos/alpha",
                "update-ref",
                "-d",
                "refs/remotes/origin/feature",
            ]);
            f.git(&[
                "-C",
                f.base.join("alpha.git").to_str().unwrap(),
                "update-ref",
                "-d",
                "refs/heads/feature",
            ]);
            match kind {
                "promisor-with-local-base" => {
                    f.git(&["-C", "repos/zulu", "update-ref", "-d", "refs/heads/base"]);
                }
                "https" => {
                    f.git(&[
                        "-C",
                        "repos/alpha",
                        "remote",
                        "set-url",
                        "origin",
                        "https://example.invalid/absent.git",
                    ]);
                    // Real Git rejects transport locally; the source catches the unavailable remote.
                    f.git(&[
                        "-C",
                        "repos/alpha",
                        "config",
                        "protocol.https.allow",
                        "never",
                    ]);
                }
                "multiple" => {
                    f.git(&[
                        "-C",
                        "repos/alpha",
                        "remote",
                        "add",
                        "backup",
                        f.base.join("alpha.git").to_str().unwrap(),
                    ]);
                }
                "remote-prefix" | "remote-prefix-packed" => {
                    f.git(&[
                        "-C",
                        f.base.join("alpha.git").to_str().unwrap(),
                        "branch",
                        "feature/nested",
                        "main",
                    ]);
                    f.git(&["-C", "repos/alpha", "fetch", "origin"]);
                    if kind == "remote-prefix-packed" {
                        f.git(&["-C", "repos/alpha", "pack-refs", "--all", "--prune"]);
                        f.git(&[
                            "-C",
                            f.base.join("alpha.git").to_str().unwrap(),
                            "pack-refs",
                            "--all",
                            "--prune",
                        ]);
                    }
                }
                _ => {
                    f.git(&[
                        "-C",
                        "repos/alpha",
                        "config",
                        "remote.origin.tagOpt",
                        "--no-tags",
                    ]);
                }
            }
            let source = review2_command(&f, "source", ARGS);
            assert!(!f.home.join("transport-canary").exists());
            assert!(
                source.status.success(),
                "{kind}: {}",
                String::from_utf8_lossy(&source.stdout)
            );
            let expected = effects(&f);
            f.reset_coordinated();
            if std::env::var_os("ARASHI_REVIEW_BASELINE").is_some() {
                let baseline = review2_command(&f, "baseline", ARGS);
                assert!(!f.home.join("transport-canary").exists());
                evidence(&format!("review-baseline-{kind}"), &source, &baseline);
                compare(&source, &baseline);
                assert_eq!(expected, effects(&f));
                f.reset_coordinated();
            }
            let before = snapshot(&f.base);
            let native = review2_command(&f, "native", ARGS);
            assert!(!f.home.join("transport-canary").exists());
            evidence(&format!("review-conflict-free-{kind}"), &source, &native);
            fs::write(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("target/create-remote-only/review-conflict-free-{kind}-effects.json")), serde_json::to_vec_pretty(&serde_json::json!({"source":expected, "native":effects(&f), "nativeNonmutation":before == snapshot(&f.base)})).unwrap()).unwrap();
            if !native.status.success() {
                assert_eq!(before, snapshot(&f.base));
                failures.push(kind);
            } else {
                compare(&source, &native);
                assert_eq!(expected, effects(&f));
            }
        }
        assert!(
            failures.is_empty(),
            "conflict-free regressions: {failures:?}"
        );
    }
    #[cfg(unix)]
    fn review_mutation(kind: &str) -> String {
        let mutation = match kind {
            "oid" => {
                r#"oid=$("$REAL_GIT" -C "$ROOT/repos/zulu" -c user.name=Test -c user.email=test@example.invalid commit-tree 'main^{tree}' -p main -m changed)
"$REAL_GIT" -C "$ROOT/repos/zulu" update-ref refs/heads/feature "$oid"
printf '%s' "$oid" > "$HOME/changed-oid""#
            }
            "lock" => {
                r#""$REAL_GIT" -C "$ROOT/repos/zulu" worktree lock --reason review "$ROOT/.arashi/worktrees/feature/repos/zulu""#
            }
            "registration" => {
                r#""$REAL_GIT" -C "$ROOT/repos/zulu" worktree move "$ROOT/.arashi/worktrees/feature/repos/zulu" "$HOME/moved""#
            }
            _ => unreachable!(),
        };
        format!(
            r#"if [ "$1" = worktree ] && [ "$2" = add ] && [ "$(basename "$PWD")" = alpha ]; then
{mutation}
fi"#
        )
    }
    #[cfg(unix)]
    fn review_changed_created(kind: &str) {
        let f = fixture(true);
        let n = injected_args(&f, &review_mutation(kind), &["--only", "zulu,alpha"]);
        evidence(&format!("review-created-{kind}"), &n, &n);
        assert!(
            !n.status.success(),
            "changed {kind} published success: {}",
            String::from_utf8_lossy(&n.stdout)
        );
        let target = f.repo.join(".arashi/worktrees/feature/repos/zulu");
        match kind {
            "oid" => {
                assert!(target.join(".git").exists());
                assert_eq!(
                    f.git(&["-C", "repos/zulu", "rev-parse", "feature"]).trim(),
                    fs::read_to_string(f.home.join("changed-oid")).unwrap()
                );
            }
            "lock" => {
                assert!(target.join(".git").exists());
                assert!(
                    f.git(&["-C", "repos/zulu", "worktree", "list", "--porcelain"])
                        .contains("locked review")
                );
            }
            "registration" => {
                assert!(f.home.join("moved/.git").exists());
                assert!(!target.exists());
            }
            _ => unreachable!(),
        }
        assert!(
            !f.repo
                .join(".arashi/worktrees/feature/repos/alpha")
                .exists(),
            "owned sibling was preserved"
        );
        assert!(
            f.git(&["-C", "repos/alpha", "branch", "--list", "feature"])
                .trim()
                .is_empty(),
            "owned sibling branch was preserved"
        );
    }
    #[cfg(unix)]
    #[test]
    fn create_remote_review_created_oid() {
        review_changed_created("oid");
    }
    #[cfg(unix)]
    #[test]
    fn create_remote_review_created_lock() {
        review_changed_created("lock");
    }
    #[cfg(unix)]
    #[test]
    fn create_remote_review_created_registration() {
        review_changed_created("registration");
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "requires Node and TypeScript dependencies"]
    fn create_remote_review_race_characterization() {
        for kind in ["oid", "lock", "registration"] {
            for engine in ["source", "baseline", "native"] {
                if engine == "baseline" && std::env::var_os("ARASHI_REVIEW_BASELINE").is_none() {
                    continue;
                }
                let f = fixture(true);
                let result = injected_engine(
                    &f,
                    &review_mutation(kind),
                    &["--only", "zulu,alpha"],
                    engine,
                );
                evidence(&format!("review-race-{engine}-{kind}"), &result, &result);
                let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/create-remote-only");
                fs::write(
                    dir.join(format!("review-race-{engine}-{kind}-effects.json")),
                    serde_json::to_vec_pretty(&effects(&f)).unwrap(),
                )
                .unwrap();
                if engine == "baseline" {
                    assert!(!result.status.success());
                    assert!(!f.repo.join(".arashi/worktrees/feature").exists());
                } else if engine == "source" {
                    assert!(
                        result.status.success(),
                        "source {kind}: {}",
                        String::from_utf8_lossy(&result.stdout)
                    );
                }
            }
        }
    }
    #[cfg(unix)]
    #[test]
    fn create_remote_review_new_tracking_conflict_before_success() {
        let f = fixture(true);
        let n = injected_args(
            &f,
            r#"if [ "$1" = worktree ] && [ "$2" = add ] && [ "$(basename "$PWD")" = alpha ]; then
"$REAL_GIT" -C "$ROOT/repos/zulu" update-ref refs/remotes/origin/feature main
fi"#,
            &["--only", "zulu,alpha"],
        );
        evidence("review-new-tracking", &n, &n);
        assert!(
            !n.status.success(),
            "new remote conflict published success: {}",
            String::from_utf8_lossy(&n.stdout)
        );
        assert_eq!(
            f.git(&["-C", "repos/zulu", "rev-parse", "main"]),
            f.git(&[
                "-C",
                "repos/zulu",
                "rev-parse",
                "refs/remotes/origin/feature"
            ])
        );
        for repo in ["repos/zulu", "repos/alpha"] {
            assert!(
                f.git(&["-C", repo, "branch", "--list", "feature"])
                    .trim()
                    .is_empty()
            );
        }
        assert!(!f.repo.join(".arashi/worktrees/feature").exists());
    }
    #[cfg(unix)]
    fn review2_promisor_fixture(missing_default: bool, tracking: Option<bool>) -> Fixture {
        use std::os::unix::fs::PermissionsExt;
        let f = fixture(true);
        let oid = f.git(&[
            "-C",
            "repos/zulu",
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit-tree",
            "main^{tree}",
            "-p",
            "main",
            "-m",
            "missing base",
        ]);
        let oid = oid.trim();
        f.git(&["-C", "repos/zulu", "update-ref", "refs/heads/base", oid]);
        if missing_default {
            f.git(&["-C", "repos/zulu", "update-ref", "refs/heads/main", oid]);
        }
        if let Some(packed) = tracking {
            f.git(&[
                "-C",
                "repos/zulu",
                "update-ref",
                "refs/remotes/lazy/feature",
                oid,
            ]);
            if packed {
                f.git(&["-C", "repos/zulu", "pack-refs", "--all", "--prune"]);
            }
        }
        fs::remove_file(
            f.repo
                .join("repos/zulu/.git/objects")
                .join(&oid[..2])
                .join(&oid[2..]),
        )
        .unwrap();
        f.git(&[
            "-C",
            "repos/zulu",
            "config",
            "remote.lazy.url",
            "arashi-review-canary::fixture",
        ]);
        f.git(&["-C", "repos/zulu", "config", "remote.lazy.promisor", "true"]);
        f.git(&[
            "-C",
            "repos/zulu",
            "config",
            "remote.lazy.partialclonefilter",
            "blob:none",
        ]);
        f.git(&[
            "-C",
            "repos/zulu",
            "config",
            "protocol.arashi-review-canary.allow",
            "always",
        ]);
        fs::create_dir(f.home.join("bin")).unwrap();
        let helper = f.home.join("bin/git-remote-arashi-review-canary");
        fs::write(&helper, "#!/bin/sh\nprintf 'transport %s %s\\n' \"$1\" \"$2\" >> \"$HOME/transport-canary\"\nexit 1\n").unwrap();
        fs::set_permissions(helper, fs::Permissions::from_mode(0o755)).unwrap();
        f
    }
    #[cfg(unix)]
    fn review2_command(f: &Fixture, engine: &str, args: &[&str]) -> Output {
        let mut c = match engine {
            "source" => {
                let mut c = Command::new("node");
                c.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"));
                c
            }
            "baseline" => Command::new(std::env::var_os("ARASHI_REVIEW_BASELINE").unwrap()),
            "git" => Command::new("git"),
            _ => Command::new(env!("CARGO_BIN_EXE_arashi")),
        };
        f.environment(&mut c);
        c.env(
            "PATH",
            format!(
                "{}:{}",
                f.home.join("bin").display(),
                std::env::var("PATH").unwrap()
            ),
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(args)
        .output()
        .unwrap()
    }
    #[cfg(unix)]
    fn review2_evidence(label: &str, f: &Fixture, out: &Output, unchanged: bool) {
        let p =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/create-remote-only/review-fixes-2");
        fs::create_dir_all(&p).unwrap();
        fs::write(p.join(format!("{label}.json")), serde_json::to_vec_pretty(&serde_json::json!({"exit":out.status.code(), "stdout":String::from_utf8_lossy(&out.stdout), "stderr":String::from_utf8_lossy(&out.stderr), "canary":fs::read_to_string(f.home.join("transport-canary")).ok(), "unchanged":unchanged})).unwrap()).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn create_remote_review2_promisor_preflight() {
        let control = review2_promisor_fixture(false, None);
        let positive = review2_command(
            &control,
            "git",
            &[
                "-C",
                "repos/zulu",
                "rev-parse",
                "--verify",
                "refs/heads/base^{commit}",
            ],
        );
        review2_evidence("positive-control", &control, &positive, false);
        assert!(
            control.home.join("transport-canary").exists(),
            "undiscoverable canary: {}",
            String::from_utf8_lossy(&positive.stderr)
        );
        let mut failures = vec![];
        for tracking in [None, Some(false), Some(true)] {
            for missing_default in [false, true] {
                for order in ["alpha,zulu", "zulu,alpha"] {
                    for policy in ["ABORT", "REUSE_EXISTING"] {
                        for dry in [false, true] {
                            let f = review2_promisor_fixture(missing_default, tracking);
                            let before = snapshot(&f.base);
                            let mut args = vec![
                                "create",
                                "feature",
                                "--json",
                                "--no-hooks",
                                "--no-launch",
                                "--no-switch",
                                "--conflict",
                                policy,
                                "--only",
                                order,
                                "--repo-base",
                                "zulu=base",
                            ];
                            if dry {
                                args.push("--dry-run");
                            }
                            let out = review2_command(&f, "native", &args);
                            let unchanged = before == snapshot(&f.base);
                            let label = format!(
                                "native-{order}-{policy}-{dry}-default-{missing_default}-tracking-{tracking:?}"
                            );
                            review2_evidence(&label, &f, &out, unchanged);
                            if out.status.success()
                                || !unchanged
                                || f.home.join("transport-canary").exists()
                            {
                                failures.push(label);
                            }
                        }
                    }
                }
            }
        }
        assert!(
            failures.is_empty(),
            "preflight transport/mutation: {failures:?}"
        );
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "requires Node and TypeScript dependencies"]
    fn create_remote_review2_promisor_characterization() {
        for engine in ["source", "baseline"] {
            if engine == "baseline" && std::env::var_os("ARASHI_REVIEW_BASELINE").is_none() {
                continue;
            }
            for policy in ["ABORT", "REUSE_EXISTING"] {
                for dry in [false, true] {
                    let f = review2_promisor_fixture(false, None);
                    let before = snapshot(&f.base);
                    let mut args = vec![
                        "create",
                        "feature",
                        "--json",
                        "--no-hooks",
                        "--no-launch",
                        "--no-switch",
                        "--conflict",
                        policy,
                        "--only",
                        "alpha,zulu",
                        "--repo-base",
                        "zulu=base",
                    ];
                    if dry {
                        args.push("--dry-run");
                    }
                    let out = review2_command(&f, engine, &args);
                    review2_evidence(
                        &format!("{engine}-{policy}-{dry}"),
                        &f,
                        &out,
                        before == snapshot(&f.base),
                    );
                    assert!(!out.status.success(), "missing base unexpectedly resolved");
                }
            }
        }
        for engine in ["source", "baseline", "native"] {
            if engine == "baseline" && std::env::var_os("ARASHI_REVIEW_BASELINE").is_none() {
                continue;
            }
            let f = fixture(true);
            let oid = f.git(&[
                "-C",
                "repos/alpha",
                "rev-parse",
                "refs/remotes/origin/feature",
            ]);
            let oid = oid.trim();
            fs::remove_file(
                f.repo
                    .join("repos/alpha/.git/objects")
                    .join(&oid[..2])
                    .join(&oid[2..]),
            )
            .unwrap();
            let before = snapshot(&f.base);
            let out = review2_command(&f, engine, ARGS);
            review2_evidence(
                &format!("dangling-object-{engine}"),
                &f,
                &out,
                before == snapshot(&f.base),
            );
            if engine == "source" || engine == "baseline" {
                assert!(
                    out.status.success(),
                    "{}",
                    String::from_utf8_lossy(&out.stdout)
                );
            }
        }
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "requires Node and TypeScript dependencies"]
    fn create_remote_review2_prefix_dry_run() {
        for packed in [false, true] {
            let f = fixture(true);
            f.git(&[
                "-C",
                "repos/alpha",
                "update-ref",
                "-d",
                "refs/remotes/origin/feature",
            ]);
            f.git(&[
                "-C",
                f.base.join("alpha.git").to_str().unwrap(),
                "update-ref",
                "-d",
                "refs/heads/feature",
            ]);
            f.git(&[
                "-C",
                f.base.join("alpha.git").to_str().unwrap(),
                "branch",
                "feature/nested",
                "main",
            ]);
            f.git(&["-C", "repos/alpha", "fetch", "origin"]);
            if packed {
                f.git(&["-C", "repos/alpha", "pack-refs", "--all", "--prune"]);
                f.git(&[
                    "-C",
                    f.base.join("alpha.git").to_str().unwrap(),
                    "pack-refs",
                    "--all",
                    "--prune",
                ]);
            }
            let before = snapshot(&f.base);
            let mut args = ARGS.to_vec();
            args.push("--dry-run");
            let source = f.run(true, &args);
            assert!(source.status.success());
            assert_eq!(before, snapshot(&f.base));
            for engine in ["baseline", "native"] {
                if engine == "baseline" && std::env::var_os("ARASHI_REVIEW_BASELINE").is_none() {
                    continue;
                }
                let output = review2_command(&f, engine, &args);
                review2_evidence(
                    &format!("prefix-dry-{engine}-{packed}"),
                    &f,
                    &output,
                    before == snapshot(&f.base),
                );
                compare(&source, &output);
                assert_eq!(before, snapshot(&f.base));
            }
        }
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "requires Node and TypeScript dependencies"]
    fn create_remote_review3_inverse_prefix() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/create-remote-only/review-fixes-3/current");
        fs::create_dir_all(&dir).unwrap();
        let mut failures = vec![];
        for kind in [
            "tracking-loose",
            "tracking-packed",
            "bare-loose",
            "bare-packed",
        ] {
            for dry in [false, true] {
                let f = fixture(true);
                let bare = f.base.join("alpha.git");
                let oid = f.git(&["-C", "repos/alpha", "rev-parse", "origin/feature"]);
                if kind.starts_with("bare") {
                    f.git(&[
                        "-C",
                        "repos/alpha",
                        "update-ref",
                        "-d",
                        "refs/remotes/origin/feature",
                    ]);
                }
                let (root, name) = if kind.starts_with("tracking") {
                    (f.repo.join("repos/alpha"), "refs/remotes/origin/feature")
                } else {
                    (bare.clone(), "refs/heads/feature")
                };
                f.git(&["-C", root.to_str().unwrap(), "update-ref", "-d", name]);
                f.git(&["-C", root.to_str().unwrap(), "update-ref", name, oid.trim()]);
                if kind.ends_with("packed") {
                    f.git(&[
                        "-C",
                        root.to_str().unwrap(),
                        "pack-refs",
                        "--all",
                        "--prune",
                    ]);
                }
                let common = if kind.starts_with("bare") {
                    root.clone()
                } else {
                    root.join(".git")
                };
                if kind.ends_with("loose") {
                    assert_eq!(
                        fs::symlink_metadata(common.join(format!("{name}/nested")))
                            .unwrap_err()
                            .kind(),
                        std::io::ErrorKind::NotADirectory
                    );
                }
                assert!(
                    f.git(&[
                        "-C",
                        root.to_str().unwrap(),
                        "for-each-ref",
                        "--format=%(refname)",
                        &format!("{name}/nested")
                    ])
                    .trim()
                    .is_empty()
                );
                let mut args = ARGS.to_vec();
                args[1] = "feature/nested";
                if dry {
                    args.push("--dry-run");
                }
                let mut source = None;
                let mut expected = None;
                for engine in ["source", "baseline", "native"] {
                    if engine == "baseline" && std::env::var_os("ARASHI_REVIEW_BASELINE").is_none()
                    {
                        continue;
                    }
                    let before = snapshot(&f.base);
                    let out = review2_command(&f, engine, &args);
                    let unchanged = before == snapshot(&f.base);
                    let after = effects(&f);
                    fs::write(dir.join(format!("{kind}-{dry}-{engine}.json")), serde_json::to_vec_pretty(&serde_json::json!({
                        "exit":out.status.code(), "stdout":String::from_utf8_lossy(&out.stdout),
                        "stderr":String::from_utf8_lossy(&out.stderr), "unchanged":unchanged, "effects":after
                    })).unwrap()).unwrap();
                    if engine == "native" && !out.status.success() {
                        failures.push(format!(
                            "{kind}/{dry}: {}",
                            String::from_utf8_lossy(&out.stdout)
                        ));
                        assert!(unchanged);
                    } else {
                        assert!(
                            out.status.success(),
                            "{kind}/{dry}/{engine}: {}",
                            String::from_utf8_lossy(&out.stdout)
                        );
                        if let Some(ref source) = source {
                            compare(source, &out);
                        }
                        if let Some(ref expected) = expected {
                            assert_eq!(expected, &after);
                        }
                        if dry {
                            assert!(unchanged);
                        }
                    }
                    if engine == "source" {
                        source = Some(out);
                        expected = Some(after);
                    }
                    if !dry {
                        for repo in ["repos/alpha", "repos/zulu", ""] {
                            let listing =
                                f.git(&["-C", p_or_dot(repo), "worktree", "list", "--porcelain"]);
                            for record in listing.split("\n\n") {
                                if record
                                    .lines()
                                    .any(|l| l == "branch refs/heads/feature/nested")
                                {
                                    let path = record
                                        .lines()
                                        .find_map(|l| l.strip_prefix("worktree "))
                                        .unwrap();
                                    f.git(&[
                                        "-C",
                                        p_or_dot(repo),
                                        "worktree",
                                        "remove",
                                        "--force",
                                        path,
                                    ]);
                                    f.git(&[
                                        "-C",
                                        p_or_dot(repo),
                                        "branch",
                                        "-D",
                                        "feature/nested",
                                    ]);
                                }
                            }
                        }
                        let path = f.repo.join(".arashi/worktrees/feature");
                        if path.exists() {
                            fs::remove_dir_all(path).unwrap();
                        }
                    }
                }
            }
        }
        assert!(
            failures.is_empty(),
            "inverse-prefix regressions: {failures:?}"
        );
    }
    #[cfg(unix)]
    #[test]
    fn create_remote_review3_inverse_prefix_gates() {
        for kind in ["malformed", "symbolic", "symlink", "packed-exact"] {
            let f = fixture(true);
            let common = f.repo.join("repos/alpha/.git");
            let shorter = common.join("refs/remotes/origin/feature");
            let oid = fs::read_to_string(&shorter).unwrap();
            match kind {
                "malformed" => fs::write(&shorter, "not-an-oid\n").unwrap(),
                "symbolic" => fs::write(&shorter, "ref: refs/remotes/origin/absent\n").unwrap(),
                "symlink" => {
                    fs::remove_file(&shorter).unwrap();
                    std::os::unix::fs::symlink("absent", &shorter).unwrap();
                }
                "packed-exact" => fs::write(
                    common.join("packed-refs"),
                    format!(
                        "# pack-refs with: sorted\n{} refs/remotes/origin/feature/nested\n",
                        oid.trim()
                    ),
                )
                .unwrap(),
                _ => unreachable!(),
            }
            let before = snapshot(&f.base);
            let mut args = ARGS.to_vec();
            args[1] = "feature/nested";
            for dry in [false, true] {
                if dry {
                    args.push("--dry-run");
                }
                let output = f.run(false, &args);
                assert!(!output.status.success(), "{kind}/{dry}");
                assert_eq!(before, snapshot(&f.base), "{kind}/{dry}");
            }
        }
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "requires Node and TypeScript dependencies"]
    fn create_remote_review3_local_prefix_audit() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/create-remote-only/review-fixes-3/local-prefix");
        fs::create_dir_all(&dir).unwrap();
        for inverse in [false, true] {
            for packed in [false, true] {
                for dry in [false, true] {
                    let mut f = Fixture::new();
                    f.configured();
                    let (existing, requested) = if inverse {
                        ("feature", "feature/nested")
                    } else {
                        ("feature/nested", "feature")
                    };
                    f.git(&["branch", existing, "main"]);
                    if packed {
                        f.git(&["pack-refs", "--all", "--prune"]);
                    }
                    let mut args = ARGS.to_vec();
                    args[1] = requested;
                    if dry {
                        args.push("--dry-run");
                    }
                    let mut baseline = None;
                    for engine in ["source", "baseline", "native"] {
                        if engine == "baseline"
                            && std::env::var_os("ARASHI_REVIEW_BASELINE").is_none()
                        {
                            continue;
                        }
                        let before = snapshot(&f.base);
                        let output = review2_command(&f, engine, &args);
                        let unchanged = before == snapshot(&f.base);
                        fs::write(dir.join(format!("{inverse}-{packed}-{dry}-{engine}.json")), serde_json::to_vec_pretty(&serde_json::json!({"exit":output.status.code(),"stdout":String::from_utf8_lossy(&output.stdout),"stderr":String::from_utf8_lossy(&output.stderr),"unchanged":unchanged})).unwrap()).unwrap();
                        assert_eq!(output.status.success(), dry);
                        if dry || engine != "source" {
                            assert!(unchanged);
                        }
                        if engine == "native"
                            && let Some(ref b) = baseline
                        {
                            compare(b, &output);
                        }
                        if engine == "baseline" {
                            baseline = Some(output);
                        }
                    }
                }
            }
        }
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "requires Node and TypeScript dependencies"]
    fn create_remote_review4_tag_shadow() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/create-remote-only/review-fixes-4/current");
        fs::create_dir_all(&dir).unwrap();
        let mut failures = vec![];
        for packed in [false, true] {
            for policy in ["ABORT", "REUSE_EXISTING"] {
                for dry in [false, true] {
                    let f = fixture(true);
                    let remote = f.base.join("alpha.git");
                    let oid = f.git(&[
                        "-C",
                        "repos/alpha",
                        "rev-parse",
                        "refs/remotes/origin/feature",
                    ]);
                    f.git(&[
                        "-C",
                        remote.to_str().unwrap(),
                        "update-ref",
                        "-d",
                        "refs/heads/feature",
                    ]);
                    f.git(&[
                        "-C",
                        remote.to_str().unwrap(),
                        "tag",
                        "refs/heads/feature",
                        oid.trim(),
                    ]);
                    if packed {
                        f.git(&[
                            "-C",
                            remote.to_str().unwrap(),
                            "pack-refs",
                            "--all",
                            "--prune",
                        ]);
                    }
                    assert!(
                        f.git(&[
                            "-C",
                            remote.to_str().unwrap(),
                            "for-each-ref",
                            "--format=%(refname)",
                            "refs/heads/feature"
                        ])
                        .trim()
                        .is_empty()
                    );
                    assert_eq!(
                        f.git(&[
                            "-C",
                            remote.to_str().unwrap(),
                            "rev-parse",
                            "--verify",
                            "refs/heads/feature^{commit}"
                        ])
                        .trim(),
                        oid.trim()
                    );
                    assert!(
                        f.git(&[
                            "-C",
                            "repos/alpha",
                            "ls-remote",
                            "--heads",
                            "origin",
                            "feature"
                        ])
                        .trim()
                        .is_empty()
                    );
                    let mut args = ARGS.to_vec();
                    args[7] = policy;
                    if dry {
                        args.push("--dry-run");
                    }
                    for engine in ["source", "baseline", "native"] {
                        if engine == "baseline"
                            && std::env::var_os("ARASHI_REVIEW_BASELINE").is_none()
                        {
                            continue;
                        }
                        let before = snapshot(&f.base);
                        let out = review2_command(&f, engine, &args);
                        let unchanged = before == snapshot(&f.base);
                        let json: Value = serde_json::from_slice(&out.stdout).unwrap();
                        fs::write(dir.join(format!("{packed}-{policy}-{dry}-{engine}.json")), serde_json::to_vec_pretty(&serde_json::json!({"exit":out.status.code(),"stdout":String::from_utf8_lossy(&out.stdout),"stderr":String::from_utf8_lossy(&out.stderr),"unchanged":unchanged,"effects":effects(&f)})).unwrap()).unwrap();
                        if engine == "source" {
                            assert!(out.status.success());
                            if dry {
                                assert!(unchanged);
                            }
                        }
                        if engine == "native"
                            && (out.status.success()
                                || json["error"]["code"] != "RUST_NOT_YET_PORTED"
                                || !unchanged)
                        {
                            failures.push(format!(
                                "{packed}/{policy}/{dry}: {}",
                                String::from_utf8_lossy(&out.stdout)
                            ));
                        }
                        if !dry {
                            f.reset_coordinated();
                        }
                    }
                }
            }
        }
        assert!(
            failures.is_empty(),
            "tag-shadow false conflicts/acceptance: {failures:?}"
        );
    }
    #[cfg(unix)]
    #[test]
    fn create_remote_review4_head_gates() {
        for kind in [
            "missing",
            "malformed",
            "symbolic",
            "dangling",
            "unavailable",
            "tag-object",
            "packed-tag-object",
        ] {
            for dry in [false, true] {
                let f = fixture(true);
                let remote = f.base.join("alpha.git");
                let head = remote.join("refs/heads/feature");
                let oid = f.git(&["-C", "repos/alpha", "rev-parse", "origin/feature"]);
                f.git(&[
                    "-C",
                    remote.to_str().unwrap(),
                    "update-ref",
                    "-d",
                    "refs/heads/feature",
                ]);
                match kind {
                    "missing" => {}
                    "malformed" => fs::write(&head, "not-an-oid\n").unwrap(),
                    "symbolic" => fs::write(&head, "ref: refs/heads/main\n").unwrap(),
                    "dangling" => fs::write(&head, "ref: refs/heads/absent\n").unwrap(),
                    "unavailable" => {
                        fs::write(&head, &oid).unwrap();
                        fs::remove_file(
                            remote
                                .join("objects")
                                .join(&oid.trim()[..2])
                                .join(&oid.trim()[2..]),
                        )
                        .unwrap();
                    }
                    "tag-object" | "packed-tag-object" => {
                        f.git(&[
                            "-C",
                            remote.to_str().unwrap(),
                            "-c",
                            "user.name=Test",
                            "-c",
                            "user.email=test@example.invalid",
                            "tag",
                            "-a",
                            "annotated",
                            "-m",
                            "not a branch commit",
                            oid.trim(),
                        ]);
                        let tag = f.git(&[
                            "-C",
                            remote.to_str().unwrap(),
                            "rev-parse",
                            "refs/tags/annotated",
                        ]);
                        if kind == "tag-object" {
                            fs::write(&head, tag).unwrap();
                        } else {
                            let packed = remote.join("packed-refs");
                            let content = fs::read_to_string(&packed).unwrap();
                            fs::write(
                                &packed,
                                content.replace(
                                    "# pack-refs with: peeled fully-peeled sorted ",
                                    "# pack-refs with: peeled fully-peeled ",
                                ) + &format!("{} refs/heads/feature\n", tag.trim()),
                            )
                            .unwrap();
                        }
                    }
                    _ => unreachable!(),
                }
                let before = snapshot(&f.base);
                let mut args = ARGS.to_vec();
                if dry {
                    args.push("--dry-run");
                }
                let out = f.run(false, &args);
                assert!(
                    !out.status.success(),
                    "{kind}/{dry}: {}",
                    String::from_utf8_lossy(&out.stdout)
                );
                assert_eq!(before, snapshot(&f.base), "{kind}/{dry}");
            }
        }
    }
    #[cfg(unix)]
    #[test]
    fn create_remote_review4_head_revalidation() {
        for stage in ["before", "dry", "after"] {
            let f = fixture(true);
            let mutation = r#"remote="$ROOT/../alpha.git"
oid=$("$REAL_GIT" -C "$ROOT/repos/alpha" rev-parse refs/remotes/origin/feature)
"$REAL_GIT" -C "$remote" update-ref -d refs/heads/feature
"$REAL_GIT" -C "$remote" tag refs/heads/feature "$oid"
printf changed > "$HOME/head-shadowed""#;
            let body = if stage == "after" {
                format!(
                    r#"if [ "$1" = worktree ] && [ "$2" = add ] && [ "$PWD" = "$ROOT/repos/alpha" ]; then
"$REAL_GIT" "$@" || exit $?
{mutation}
exit 0
fi"#
                )
            } else {
                format!(
                    r#"if [ "$1" = rev-parse ] && [ "$2" = --verify ] && [ "$3" = refs/remotes/origin/feature ] && [ "$PWD" = "$ROOT/repos/alpha" ]; then
if [ -f "$HOME/head-inspected" ] && [ ! -f "$HOME/head-shadowed" ]; then
{mutation}
fi
printf seen > "$HOME/head-inspected"
fi"#
                )
            };
            let out = injected_args(&f, &body, if stage == "dry" { &["--dry-run"] } else { &[] });
            let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/create-remote-only/review-fixes-4/revalidation");
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(format!("{stage}.json")), serde_json::to_vec_pretty(&serde_json::json!({"exit":out.status.code(),"stdout":String::from_utf8_lossy(&out.stdout),"stderr":String::from_utf8_lossy(&out.stderr),"effects":effects(&f)})).unwrap()).unwrap();
            assert!(f.home.join("head-shadowed").exists());
            assert!(!out.status.success(), "{stage}");
            assert!(!f.base.join("alpha.git/refs/heads/feature").exists());
            assert!(
                f.base
                    .join("alpha.git/refs/tags/refs/heads/feature")
                    .exists()
            );
            for repo in ["", "repos/alpha", "repos/zulu"] {
                assert!(
                    f.git(&["-C", p_or_dot(repo), "branch", "--list", "feature"])
                        .trim()
                        .is_empty()
                );
                assert_eq!(
                    f.git(&["-C", p_or_dot(repo), "worktree", "list", "--porcelain"])
                        .matches("worktree ")
                        .count(),
                    1
                );
            }
        }
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "requires Node and TypeScript dependencies"]
    fn create_remote_review5_local_tag_shadow() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/create-remote-only/review-fixes-5/current");
        fs::create_dir_all(&dir).unwrap();
        let mut failures = vec![];
        for packed in [false, true] {
            for policy in ["ABORT", "REUSE_EXISTING"] {
                for dry in [false, true] {
                    let f = fixture(true);
                    f.git(&[
                        "-C",
                        "repos/alpha",
                        "tag",
                        "refs/heads/feature",
                        "origin/feature",
                    ]);
                    if packed {
                        f.git(&["-C", "repos/alpha", "pack-refs", "--prune"]);
                    }
                    assert!(
                        f.repo
                            .join("repos/alpha/.git/refs/remotes/origin/feature")
                            .is_file()
                    );
                    assert!(
                        f.git(&[
                            "-C",
                            "repos/alpha",
                            "for-each-ref",
                            "--format=%(refname)",
                            "refs/heads/feature"
                        ])
                        .trim()
                        .is_empty()
                    );
                    assert_eq!(
                        f.git(&[
                            "-C",
                            "repos/alpha",
                            "rev-parse",
                            "--verify",
                            "refs/heads/feature"
                        ])
                        .trim(),
                        f.git(&["-C", "repos/alpha", "rev-parse", "origin/feature"])
                            .trim()
                    );
                    let mut args = ARGS.to_vec();
                    args[7] = policy;
                    if dry {
                        args.push("--dry-run");
                    }
                    let mut source = None;
                    let mut expected = None;
                    for engine in ["source", "baseline", "native"] {
                        if engine == "baseline"
                            && std::env::var_os("ARASHI_REVIEW_BASELINE").is_none()
                        {
                            continue;
                        }
                        let before = snapshot(&f.base);
                        let output = review2_command(&f, engine, &args);
                        let unchanged = before == snapshot(&f.base);
                        let after = effects(&f);
                        fs::write(dir.join(format!("{packed}-{policy}-{dry}-{engine}.json")), serde_json::to_vec_pretty(&serde_json::json!({"exit":output.status.code(),"stdout":String::from_utf8_lossy(&output.stdout),"stderr":String::from_utf8_lossy(&output.stderr),"unchanged":unchanged,"effects":after})).unwrap()).unwrap();
                        if engine == "source" {
                            assert_eq!(output.status.success(), dry || policy == "REUSE_EXISTING");
                            if dry || policy == "ABORT" {
                                assert!(unchanged);
                            }
                        }
                        if engine == "native" {
                            let json: Value = serde_json::from_slice(&output.stdout).unwrap();
                            if json["error"]["code"] == "PLAN_CHANGED"
                                || json["error"]["code"] == "COORDINATED_CREATE_FAILED"
                            {
                                failures.push(format!(
                                    "{packed}/{policy}/{dry}: {}",
                                    String::from_utf8_lossy(&output.stdout)
                                ));
                            } else {
                                compare(source.as_ref().unwrap(), &output);
                                assert_eq!(expected.as_ref().unwrap(), &after);
                                if dry || policy == "ABORT" {
                                    assert!(unchanged);
                                }
                            }
                        }
                        if engine == "source" {
                            source = Some(output);
                            expected = Some(after);
                        }
                        if !dry {
                            f.reset_coordinated();
                        }
                    }
                }
            }
        }
        assert!(
            failures.is_empty(),
            "local tag-shadow regressions: {failures:?}"
        );
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "requires Node and TypeScript dependencies"]
    fn create_remote_review5_existing_local_heads() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/create-remote-only/review-fixes-5/existing");
        fs::create_dir_all(&dir).unwrap();
        for packed in [false, true] {
            for dry in [false, true] {
                let f = fixture(true);
                f.git(&["-C", "repos/zulu", "branch", "feature", "main"]);
                let tag_oid = f.git(&[
                    "-C",
                    "repos/zulu",
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit-tree",
                    "main^{tree}",
                    "-p",
                    "main",
                    "-m",
                    "tag only",
                ]);
                f.git(&[
                    "-C",
                    "repos/zulu",
                    "tag",
                    "refs/heads/feature",
                    tag_oid.trim(),
                ]);
                if packed {
                    f.git(&["-C", "repos/zulu", "pack-refs", "--all", "--prune"]);
                }
                let mut args = ARGS.to_vec();
                if dry {
                    args.push("--dry-run");
                }
                let before = snapshot(&f.base);
                let source = f.run(true, &args);
                assert!(source.status.success());
                let expected = effects(&f);
                if dry {
                    assert_eq!(before, snapshot(&f.base));
                } else {
                    f.reset_coordinated();
                    f.git(&["-C", "repos/zulu", "branch", "feature", "main"]);
                    if packed {
                        f.git(&["-C", "repos/zulu", "pack-refs", "--all", "--prune"]);
                    }
                }
                let before = snapshot(&f.base);
                let native = f.run(false, &args);
                fs::write(dir.join(format!("{packed}-{dry}.json")), serde_json::to_vec_pretty(&serde_json::json!({"source":{"exit":source.status.code(),"stdout":String::from_utf8_lossy(&source.stdout),"stderr":String::from_utf8_lossy(&source.stderr),"effects":expected},"native":{"exit":native.status.code(),"stdout":String::from_utf8_lossy(&native.stdout),"stderr":String::from_utf8_lossy(&native.stderr),"effects":effects(&f)},"nativeUnchanged":before==snapshot(&f.base)})).unwrap()).unwrap();
                compare(&source, &native);
                assert_eq!(expected, effects(&f));
                if dry {
                    assert_eq!(before, snapshot(&f.base));
                }
                assert_eq!(
                    f.git(&[
                        "-C",
                        "repos/zulu",
                        "show-ref",
                        "--hash",
                        "--verify",
                        "refs/heads/feature"
                    ])
                    .trim(),
                    f.git(&["-C", "repos/zulu", "rev-parse", "main"]).trim()
                );
            }
        }
    }
    #[cfg(unix)]
    #[test]
    fn create_remote_review5_removed_local_head_preserved() {
        let f = fixture(true);
        let body = r#"if [ "$1" = worktree ] && [ "$2" = add ] && [ "$PWD" = "$ROOT/repos/alpha" ]; then
oid=$("$REAL_GIT" -C "$ROOT/repos/zulu" rev-parse refs/heads/feature)
"$REAL_GIT" -C "$ROOT/repos/zulu" update-ref -d refs/heads/feature
"$REAL_GIT" -C "$ROOT/repos/zulu" tag refs/heads/feature "$oid"
printf changed > "$HOME/local-head-shadowed"
fi"#;
        let out = injected_args(&f, body, &["--only", "zulu,alpha"]);
        let dir =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/create-remote-only/review-fixes-5");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("removed-local-head.json"), serde_json::to_vec_pretty(&serde_json::json!({"exit":out.status.code(),"stdout":String::from_utf8_lossy(&out.stdout),"stderr":String::from_utf8_lossy(&out.stderr),"effects":effects(&f)})).unwrap()).unwrap();
        assert!(f.home.join("local-head-shadowed").exists());
        assert!(!out.status.success());
        assert!(
            f.repo
                .join(".arashi/worktrees/feature/repos/zulu/.git")
                .exists()
        );
        assert!(
            f.repo
                .join("repos/zulu/.git/refs/tags/refs/heads/feature")
                .exists()
        );
        for repo in ["repos/zulu", "repos/alpha"] {
            assert!(
                f.git(&[
                    "-C",
                    repo,
                    "for-each-ref",
                    "--format=%(refname)",
                    "refs/heads/feature"
                ])
                .trim()
                .is_empty()
            );
        }
        assert!(
            !f.repo
                .join(".arashi/worktrees/feature/repos/alpha")
                .exists()
        );
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "requires Node and TypeScript dependencies"]
    fn create_remote_review6_remote_base_shadow() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/create-remote-only/review-fixes-6/base-current");
        fs::create_dir_all(&dir).unwrap();
        let mut failures = vec![];
        for kind in ["loose-tag", "packed-tag", "exact-remote"] {
            for dry in [false, true] {
                let f = fixture(true);
                f.git(&["-C", "repos/zulu", "branch", "feature", "main"]);
                if kind == "exact-remote" {
                    f.git(&[
                        "-C",
                        "repos/zulu",
                        "update-ref",
                        "refs/remotes/origin/missing",
                        "main",
                    ]);
                } else {
                    f.git(&[
                        "-C",
                        "repos/zulu",
                        "tag",
                        "refs/remotes/origin/missing",
                        "main",
                    ]);
                    if kind == "packed-tag" {
                        f.git(&["-C", "repos/zulu", "pack-refs", "--prune"]);
                    }
                    assert!(
                        f.git(&[
                            "-C",
                            "repos/zulu",
                            "for-each-ref",
                            "--format=%(refname)",
                            "refs/remotes/origin/missing"
                        ])
                        .trim()
                        .is_empty()
                    );
                }
                assert!(
                    f.git(&[
                        "-C",
                        "repos/zulu",
                        "for-each-ref",
                        "--format=%(refname)",
                        "refs/heads/missing"
                    ])
                    .trim()
                    .is_empty()
                );
                let mut args = ARGS.to_vec();
                args.extend(["--repo-base", "zulu=missing"]);
                if dry {
                    args.push("--dry-run");
                }
                for engine in ["source", "baseline", "native"] {
                    if engine == "baseline" && std::env::var_os("ARASHI_REVIEW_BASELINE").is_none()
                    {
                        continue;
                    }
                    let before = snapshot(&f.base);
                    let output = review2_command(&f, engine, &args);
                    let unchanged = before == snapshot(&f.base);
                    fs::write(dir.join(format!("{kind}-{dry}-{engine}.json")), serde_json::to_vec_pretty(&serde_json::json!({"exit":output.status.code(),"stdout":String::from_utf8_lossy(&output.stdout),"stderr":String::from_utf8_lossy(&output.stderr),"unchanged":unchanged,"effects":effects(&f)})).unwrap()).unwrap();
                    if engine == "native" && (output.status.success() || !unchanged) {
                        failures.push(format!(
                            "{kind}/{dry}: {}",
                            String::from_utf8_lossy(&output.stdout)
                        ));
                    }
                    if !dry {
                        f.reset_coordinated();
                        f.git(&["-C", "repos/zulu", "branch", "feature", "main"]);
                    }
                }
            }
        }
        assert!(
            failures.is_empty(),
            "remote-base false acceptance: {failures:?}"
        );
    }
    #[cfg(unix)]
    #[test]
    fn create_remote_review6_pending_destinations() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/create-remote-only/review-fixes-6/destination-current");
        fs::create_dir_all(&dir).unwrap();
        let mut failures = vec![];
        for repo in ["alpha", "zulu"] {
            for kind in [
                "file",
                "directory",
                "dangling",
                "ancestor-file",
                "ancestor-symlink",
                "registered",
                "wrong-location",
                "registered-missing",
            ] {
                for dry in [true, false] {
                    let f = fixture(true);
                    let mutation = match kind {
                        "file" => r#"mkdir -p "$(dirname "$target")"; printf sentinel > "$target""#,
                        "directory" => r#"mkdir -p "$target"; printf sentinel > "$target/caller""#,
                        "dangling" => r#"mkdir -p "$(dirname "$target")"; ln -s missing "$target""#,
                        "ancestor-file" => {
                            r#"mkdir -p "$ROOT/.arashi/worktrees"; printf sentinel > "$ROOT/.arashi/worktrees/feature""#
                        }
                        "ancestor-symlink" => {
                            r#"mkdir -p "$ROOT/.arashi/worktrees" "$HOME/caller"; printf sentinel > "$HOME/caller/sentinel"; ln -s "$HOME/caller" "$ROOT/.arashi/worktrees/feature""#
                        }
                        "registered" => {
                            r#""$REAL_GIT" -C "$primary" worktree add --detach "$target" main; printf sentinel > "$target/caller""#
                        }
                        "wrong-location" => {
                            r#""$REAL_GIT" -C "$primary" worktree add --detach "$HOME/caller" main; printf sentinel > "$HOME/caller/sentinel""#
                        }
                        "registered-missing" => {
                            r#""$REAL_GIT" -C "$primary" worktree add --detach "$target" main; mv "$target" "$HOME/caller"; printf sentinel > "$HOME/caller/sentinel""#
                        }
                        _ => unreachable!(),
                    };
                    let body = format!(
                        r#"if [ "$1" = config ] && [ "$2" = --local ] && [ "$4" = arashi.ignoreScope ] && [ ! -f "$HOME/injected" ]; then
target="$ROOT/.arashi/worktrees/feature/repos/{repo}"
primary="$ROOT/repos/{repo}"
{mutation}
printf done > "$HOME/injected"
fi"#
                    );
                    let mut extra = vec!["--only", "alpha,zulu"];
                    if dry {
                        extra.push("--dry-run");
                    }
                    let output = injected_args(&f, &body, &extra);
                    assert!(f.home.join("injected").exists());
                    let target = f
                        .repo
                        .join(format!(".arashi/worktrees/feature/repos/{repo}"));
                    let preserved = match kind {
                        "file" => fs::read(&target).unwrap() == b"sentinel",
                        "directory" | "registered" => {
                            fs::read(target.join("caller")).unwrap() == b"sentinel"
                        }
                        "dangling" => fs::read_link(&target).unwrap() == Path::new("missing"),
                        "ancestor-file" => {
                            fs::read(f.repo.join(".arashi/worktrees/feature")).unwrap()
                                == b"sentinel"
                        }
                        _ => fs::read(f.home.join("caller/sentinel")).unwrap() == b"sentinel",
                    };
                    assert!(preserved);
                    fs::write(dir.join(format!("{repo}-{kind}-{dry}.json")), serde_json::to_vec_pretty(&serde_json::json!({"exit":output.status.code(),"stdout":String::from_utf8_lossy(&output.stdout),"stderr":String::from_utf8_lossy(&output.stderr),"callerStatePreserved":preserved,"effects":effects(&f)})).unwrap()).unwrap();
                    if output.status.success() {
                        failures.push(format!("{repo}/{kind}/{dry}"));
                    }
                    for r in ["repos/alpha", "repos/zulu"] {
                        assert!(
                            f.git(&["-C", r, "branch", "--list", "feature"])
                                .trim()
                                .is_empty()
                        );
                    }
                }
            }
        }
        assert!(
            failures.is_empty(),
            "stale destinations published success: {failures:?}"
        );
    }
    #[cfg(unix)]
    #[test]
    fn create_remote_review6_actual_pending_after_sibling() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/create-remote-only/review-fixes-6/after-sibling");
        fs::create_dir_all(&dir).unwrap();
        for kind in ["file", "directory", "dangling", "registered"] {
            let f = fixture(true);
            let mutation = match kind {
                "file" => r#"printf sentinel > "$target""#,
                "directory" => r#"mkdir "$target"; printf sentinel > "$target/caller""#,
                "dangling" => r#"ln -s missing "$target""#,
                "registered" => {
                    r#""$REAL_GIT" -C "$ROOT/repos/zulu" worktree add --detach "$target" main; printf sentinel > "$target/caller""#
                }
                _ => unreachable!(),
            };
            let body = format!(
                r#"if [ "$1" = worktree ] && [ "$2" = add ] && [ "$PWD" = "$ROOT/repos/alpha" ]; then
"$REAL_GIT" "$@" || exit $?
target="$ROOT/.arashi/worktrees/feature/repos/zulu"
{mutation}
printf done > "$HOME/injected"
exit 0
fi"#
            );
            let out = injected_args(&f, &body, &["--only", "alpha,zulu"]);
            assert!(f.home.join("injected").exists());
            let target = f.repo.join(".arashi/worktrees/feature/repos/zulu");
            let preserved = match kind {
                "file" => fs::read(&target).unwrap() == b"sentinel",
                "dangling" => fs::read_link(&target).unwrap() == Path::new("missing"),
                _ => fs::read(target.join("caller")).unwrap() == b"sentinel",
            };
            fs::write(dir.join(format!("{kind}.json")), serde_json::to_vec_pretty(&serde_json::json!({"exit":out.status.code(),"stdout":String::from_utf8_lossy(&out.stdout),"stderr":String::from_utf8_lossy(&out.stderr),"callerStatePreserved":preserved,"effects":effects(&f)})).unwrap()).unwrap();
            assert!(!out.status.success());
            assert!(preserved);
            assert!(
                !f.repo
                    .join(".arashi/worktrees/feature/repos/alpha")
                    .exists()
            );
            for repo in ["repos/alpha", "repos/zulu"] {
                assert!(
                    f.git(&["-C", repo, "branch", "--list", "feature"])
                        .trim()
                        .is_empty()
                );
            }
        }
    }
    #[cfg(unix)]
    #[test]
    fn create_remote_review7_mutation_boundary() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/create-remote-only/review-fixes-7/current");
        fs::create_dir_all(&dir).unwrap();
        let mut failures = vec![];
        for repo in ["alpha", "zulu"] {
            for kind in ["moved-main", "missing-main-shadow"] {
                let f = fixture(true);
                let primary = format!("repos/{repo}");
                let planned = f.git(&[
                    "-C",
                    &primary,
                    "show-ref",
                    "--verify",
                    "--hash",
                    "refs/heads/main",
                ]);
                let changed = f.git(&[
                    "-C",
                    &primary,
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit-tree",
                    "main^{tree}",
                    "-p",
                    "main",
                    "-m",
                    "mutation-boundary",
                ]);
                fs::write(f.home.join("changed-oid"), changed.trim()).unwrap();
                let mutation = if kind == "moved-main" {
                    r#""$REAL_GIT" update-ref refs/heads/main "$changed""#
                } else {
                    r#""$REAL_GIT" update-ref -d refs/heads/main
"$REAL_GIT" tag refs/heads/main "$changed""#
                };
                let body = format!(
                    r#"if [ "$1" = branch ] && [ "$2" = feature ] && [ "$PWD" = "$ROOT/repos/{repo}" ]; then
printf '%s' "$3" > "$HOME/mutation-argument"
changed=$(cat "$HOME/changed-oid")
{mutation}
"$REAL_GIT" "$@" || exit $?
"$REAL_GIT" show-ref --verify --hash refs/heads/feature > "$HOME/created-oid"
exit 0
fi"#
                );
                let order = if repo == "alpha" {
                    "zulu,alpha"
                } else {
                    "alpha,zulu"
                };
                let out = injected_args(&f, &body, &["--only", order]);
                let actual = fs::read_to_string(f.home.join("created-oid")).unwrap();
                let argument = fs::read_to_string(f.home.join("mutation-argument")).unwrap();
                let target = f
                    .repo
                    .join(format!(".arashi/worktrees/feature/repos/{repo}"));
                let remaining = f.git(&[
                    "-C",
                    &primary,
                    "for-each-ref",
                    "--format=%(refname) %(objectname)",
                    "refs/heads/feature",
                ]);
                fs::write(dir.join(format!("{repo}-{kind}.json")), serde_json::to_vec_pretty(&serde_json::json!({"exit":out.status.code(),"stdout":String::from_utf8_lossy(&out.stdout),"stderr":String::from_utf8_lossy(&out.stderr),"plannedOid":planned.trim(),"changedOid":changed.trim(),"createdOid":actual.trim(),"mutationArgument":argument,"remainingTargetRef":remaining,"targetPreserved":target.join(".git").exists(),"effects":effects(&f)})).unwrap()).unwrap();
                assert!(!out.status.success());
                if actual.trim() != planned.trim() || argument != planned.trim() {
                    failures.push(format!(
                        "{repo}/{kind}: created {} from {argument}, planned {}",
                        actual.trim(),
                        planned.trim()
                    ));
                }
                if kind == "moved-main" {
                    assert_eq!(
                        f.git(&[
                            "-C",
                            &primary,
                            "show-ref",
                            "--verify",
                            "--hash",
                            "refs/heads/main"
                        ])
                        .trim(),
                        changed.trim()
                    );
                } else {
                    assert!(
                        f.git(&[
                            "-C",
                            &primary,
                            "for-each-ref",
                            "--format=%(refname)",
                            "refs/heads/main"
                        ])
                        .trim()
                        .is_empty()
                    );
                    assert_eq!(
                        f.git(&[
                            "-C",
                            &primary,
                            "show-ref",
                            "--verify",
                            "--hash",
                            "refs/tags/refs/heads/main"
                        ])
                        .trim(),
                        changed.trim()
                    );
                }
                if actual.trim() == planned.trim() {
                    assert!(
                        remaining.is_empty(),
                        "owned target branch was not rolled back"
                    );
                    assert!(
                        !target.exists(),
                        "owned target worktree was not rolled back"
                    );
                }
                let sibling = if repo == "alpha" { "zulu" } else { "alpha" };
                assert!(
                    f.git(&[
                        "-C",
                        &format!("repos/{sibling}"),
                        "branch",
                        "--list",
                        "feature"
                    ])
                    .trim()
                    .is_empty()
                );
                assert!(
                    !f.repo
                        .join(format!(".arashi/worktrees/feature/repos/{sibling}"))
                        .exists()
                );
            }
        }
        assert!(
            failures.is_empty(),
            "unpinned default mutation: {failures:?}"
        );
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "requires Node and TypeScript dependencies"]
    fn create_remote_review7_stable_default() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/create-remote-only/review-fixes-7/stable");
        fs::create_dir_all(&dir).unwrap();
        for remote_scope in [true, false] {
            let f = fixture(true);
            if !remote_scope {
                f.git(&[
                    "-C",
                    "repos/alpha",
                    "update-ref",
                    "-d",
                    "refs/remotes/origin/feature",
                ]);
                f.git(&[
                    "-C",
                    f.base.join("alpha.git").to_str().unwrap(),
                    "update-ref",
                    "-d",
                    "refs/heads/feature",
                ]);
            }
            let source = f.run(true, ARGS);
            assert!(source.status.success());
            let expected = effects(&f);
            f.reset_coordinated();
            let body = r#"if [ "$1" = branch ] && [ "$2" = feature ]; then
printf '%s\n' "$3" >> "$HOME/mutation-arguments"
fi"#;
            let native = injected(&f, body);
            let arguments = fs::read_to_string(f.home.join("mutation-arguments")).unwrap();
            fs::write(dir.join(format!("{remote_scope}.json")), serde_json::to_vec_pretty(&serde_json::json!({"source":{"exit":source.status.code(),"stdout":String::from_utf8_lossy(&source.stdout),"stderr":String::from_utf8_lossy(&source.stderr),"effects":expected},"native":{"exit":native.status.code(),"stdout":String::from_utf8_lossy(&native.stdout),"stderr":String::from_utf8_lossy(&native.stderr),"effects":effects(&f)},"arguments":arguments})).unwrap()).unwrap();
            compare(&source, &native);
            assert_eq!(expected, effects(&f));
            assert_eq!(arguments.lines().count(), 3);
            for argument in arguments.lines() {
                if remote_scope {
                    assert!(
                        matches!(argument.len(), 40 | 64)
                            && argument.bytes().all(|b| b.is_ascii_hexdigit())
                    );
                } else {
                    assert_eq!(argument, "refs/heads/main");
                }
            }
        }
    }
    #[cfg(unix)]
    #[test]
    fn create_remote_review8_requested_base_revalidation() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/create-remote-only/review-fixes-8/current");
        fs::create_dir_all(&dir).unwrap();
        let mut failures = vec![];
        for packed in [false, true] {
            for kind in ["delete", "change", "shadow"] {
                for stage in ["dry", "alpha", "zulu"] {
                    let f = fixture(true);
                    for branch in ["feature", "base"] {
                        f.git(&["-C", "repos/zulu", "branch", branch, "main"]);
                    }
                    let planned = f.git(&[
                        "-C",
                        "repos/zulu",
                        "show-ref",
                        "--verify",
                        "--hash",
                        "refs/heads/base",
                    ]);
                    let changed = f.git(&[
                        "-C",
                        "repos/zulu",
                        "-c",
                        "user.name=Test",
                        "-c",
                        "user.email=test@example.invalid",
                        "commit-tree",
                        "main^{tree}",
                        "-p",
                        "main",
                        "-m",
                        "requested base change",
                    ]);
                    fs::write(f.home.join("changed-oid"), changed.trim()).unwrap();
                    if packed {
                        f.git(&["-C", "repos/zulu", "pack-refs", "--all", "--prune"]);
                    }
                    let mutation = match kind {
                        "delete" => {
                            r#""$REAL_GIT" -C "$ROOT/repos/zulu" update-ref -d refs/heads/base"#
                        }
                        "change" => {
                            r#""$REAL_GIT" -C "$ROOT/repos/zulu" update-ref refs/heads/base "$(cat "$HOME/changed-oid")""#
                        }
                        "shadow" => {
                            r#""$REAL_GIT" -C "$ROOT/repos/zulu" update-ref -d refs/heads/base
"$REAL_GIT" -C "$ROOT/repos/zulu" tag refs/heads/base main"#
                        }
                        _ => unreachable!(),
                    };
                    let pack_tag = if packed && kind == "shadow" {
                        r#""$REAL_GIT" -C "$ROOT/repos/zulu" pack-refs --prune"#
                    } else {
                        ""
                    };
                    let body = if stage == "dry" {
                        format!(
                            r#"if [ "$1" = config ] && [ "$2" = --local ] && [ "$4" = arashi.ignoreScope ] && [ ! -f "$HOME/base-changed" ]; then
{mutation}
{pack_tag}
printf done > "$HOME/base-changed"
fi"#
                        )
                    } else {
                        format!(
                            r#"if [ "$1" = worktree ] && [ "$2" = add ] && [ "$PWD" = "$ROOT/repos/{stage}" ]; then
"$REAL_GIT" "$@" || exit $?
{mutation}
{pack_tag}
printf done > "$HOME/base-changed"
exit 0
fi"#
                        )
                    };
                    let mut extra = vec!["--only", "alpha,zulu", "--repo-base", "zulu=base"];
                    if stage == "dry" {
                        extra.push("--dry-run");
                    }
                    let out = injected_args(&f, &body, &extra);
                    assert!(f.home.join("base-changed").exists());
                    let exact = f.git(&[
                        "-C",
                        "repos/zulu",
                        "for-each-ref",
                        "--format=%(refname) %(objectname)",
                        "refs/heads/base",
                    ]);
                    assert_eq!(
                        f.git(&[
                            "-C",
                            "repos/zulu",
                            "show-ref",
                            "--verify",
                            "--hash",
                            "refs/heads/feature"
                        ])
                        .trim(),
                        planned.trim()
                    );
                    if kind == "change" {
                        assert!(exact.contains(changed.trim()));
                    } else {
                        assert!(exact.is_empty());
                    }
                    if kind == "shadow" {
                        assert_eq!(
                            f.git(&[
                                "-C",
                                "repos/zulu",
                                "show-ref",
                                "--verify",
                                "--hash",
                                "refs/tags/refs/heads/base"
                            ])
                            .trim(),
                            planned.trim()
                        );
                    }
                    fs::write(dir.join(format!("{packed}-{kind}-{stage}.json")), serde_json::to_vec_pretty(&serde_json::json!({"exit":out.status.code(),"stdout":String::from_utf8_lossy(&out.stdout),"stderr":String::from_utf8_lossy(&out.stderr),"plannedBaseOid":planned.trim(),"changedOid":changed.trim(),"exactBaseAfter":exact,"effects":effects(&f),"alphaTargetExists":f.repo.join(".arashi/worktrees/feature/repos/alpha").exists(),"zuluTargetExists":f.repo.join(".arashi/worktrees/feature/repos/zulu").exists()})).unwrap()).unwrap();
                    if out.status.success() {
                        failures.push(format!("{packed}/{kind}/{stage}"));
                    } else {
                        assert!(
                            f.git(&["-C", "repos/alpha", "branch", "--list", "feature"])
                                .trim()
                                .is_empty()
                        );
                        for repo in ["alpha", "zulu"] {
                            assert!(
                                !f.repo
                                    .join(format!(".arashi/worktrees/feature/repos/{repo}"))
                                    .exists()
                            );
                        }
                    }
                }
            }
        }
        assert!(
            failures.is_empty(),
            "stale requested-base success: {failures:?}"
        );
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "requires Node and TypeScript dependencies"]
    fn create_remote_review8_stable_requested_base() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/create-remote-only/review-fixes-8/stable");
        fs::create_dir_all(&dir).unwrap();
        for packed in [false, true] {
            for dry in [false, true] {
                let f = fixture(true);
                for branch in ["feature", "base"] {
                    f.git(&["-C", "repos/zulu", "branch", branch, "main"]);
                }
                if packed {
                    f.git(&["-C", "repos/zulu", "pack-refs", "--all", "--prune"]);
                }
                let mut args = ARGS.to_vec();
                args.extend(["--only", "alpha,zulu", "--repo-base", "zulu=base"]);
                if dry {
                    args.push("--dry-run");
                }
                let before = snapshot(&f.base);
                let source = f.run(true, &args);
                assert!(source.status.success());
                let expected = effects(&f);
                if dry {
                    assert_eq!(before, snapshot(&f.base));
                } else {
                    f.reset_coordinated();
                    f.git(&["-C", "repos/zulu", "branch", "feature", "main"]);
                    if packed {
                        f.git(&["-C", "repos/zulu", "pack-refs", "--all", "--prune"]);
                    }
                }
                let before = snapshot(&f.base);
                let native = f.run(false, &args);
                fs::write(dir.join(format!("{packed}-{dry}.json")), serde_json::to_vec_pretty(&serde_json::json!({"source":{"exit":source.status.code(),"stdout":String::from_utf8_lossy(&source.stdout),"stderr":String::from_utf8_lossy(&source.stderr),"effects":expected},"native":{"exit":native.status.code(),"stdout":String::from_utf8_lossy(&native.stdout),"stderr":String::from_utf8_lossy(&native.stderr),"effects":effects(&f)},"nativeUnchanged":before==snapshot(&f.base)})).unwrap()).unwrap();
                compare(&source, &native);
                assert_eq!(expected, effects(&f));
                if dry {
                    assert_eq!(before, snapshot(&f.base));
                }
            }
        }
    }
    #[cfg(windows)]
    #[test]
    fn create_remote_windows_rejects_before_mutation() {
        let f = fixture(true);
        let before = snapshot(&f.base);
        assert!(!f.run(false, ARGS).status.success());
        assert_eq!(before, snapshot(&f.base));
    }
}
