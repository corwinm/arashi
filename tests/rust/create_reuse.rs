// Exact-destination create contracts, using disposable Git repositories and the retained source.
mod create_reuse {
    use super::*;
    const CREATE: &[&str] = &[
        "create",
        "feature",
        "--conflict",
        "REUSE_EXISTING",
        "--no-hooks",
        "--no-launch",
        "--no-switch",
        "--json",
    ];
    fn fixture() -> Fixture {
        let mut f = Fixture::new();
        f.configured();
        for repo in [".", "repos/alpha", "repos/zulu"] {
            f.git(&["-C", repo, "config", "maintenance.auto", "false"]);
        }
        f
    }
    fn target(f: &Fixture, repo: &str) -> PathBuf {
        f.repo.join(".arashi/worktrees/feature").join(repo)
    }
    fn add(f: &Fixture, repo: &str, branch: &str) {
        let path = target(f, repo);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        f.git(&[
            "-C",
            p_or_dot(repo),
            "worktree",
            "add",
            "-b",
            branch,
            path.to_str().unwrap(),
            "main",
        ]);
    }
    fn snapshot(root: &Path) -> Vec<(PathBuf, Value)> {
        fn walk(root: &Path, p: &Path, out: &mut Vec<(PathBuf, Value)>) {
            let m = fs::symlink_metadata(p).unwrap();
            let bytes = if m.file_type().is_symlink() {
                fs::read_link(p)
                    .unwrap()
                    .as_os_str()
                    .as_encoded_bytes()
                    .to_vec()
            } else if m.is_file() {
                fs::read(p).unwrap()
            } else {
                vec![]
            };
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                m.permissions().mode()
            };
            #[cfg(not(unix))]
            let mode = u32::from(m.permissions().readonly());
            let kind = if m.file_type().is_symlink() {
                "symlink"
            } else if m.is_dir() {
                "directory"
            } else {
                "file"
            };
            out.push((
                p.strip_prefix(root).unwrap().to_owned(),
                serde_json::json!({"kind":kind,"mode":mode,"bytes":bytes}),
            ));
            if m.is_dir() {
                let mut children = fs::read_dir(p)
                    .unwrap()
                    .map(|e| e.unwrap().path())
                    .collect::<Vec<_>>();
                children.sort();
                for child in children {
                    walk(root, &child, out);
                }
            }
        }
        let mut out = vec![];
        walk(root, root, &mut out);
        out
    }
    fn record(
        label: &str,
        output: &Output,
        before: &[(PathBuf, Value)],
        after: &[(PathBuf, Value)],
    ) {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/create-reuse");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("{label}.json")),
            serde_json::to_vec_pretty(&serde_json::json!({
                "exit":output.status.code(), "stdout":String::from_utf8_lossy(&output.stdout),
                "stderr":String::from_utf8_lossy(&output.stderr), "before":before, "after":after
            }))
            .unwrap(),
        )
        .unwrap();
    }
    fn reuse(characterize: bool, dry: bool, filter: &[&str]) {
        let f = fixture();
        for repo in ["", "repos/alpha", "repos/zulu"] {
            add(&f, repo, "feature");
        }
        let mut args = CREATE.to_vec();
        args.extend(filter);
        if dry {
            args.push("--dry-run");
        }
        let before = snapshot(&f.base);
        let effects = f.coordinated_effects();
        let source = if characterize || std::env::var_os("ARASHI_TS_PARITY").is_some() {
            let s = f.run(true, &args);
            record(
                &format!("source-success-{dry}-{}", filter.join("_")),
                &s,
                &before,
                &snapshot(&f.base),
            );
            assert!(s.status.success(), "{}", String::from_utf8_lossy(&s.stdout));
            assert_eq!(effects, f.coordinated_effects());
            if dry {
                assert_eq!(before, snapshot(&f.base));
            }
            Some(s)
        } else {
            None
        };
        if characterize {
            return;
        }
        let before = snapshot(&f.base);
        let n = f.run(false, &args);
        record(
            &format!("native-success-{dry}-{}", filter.join("_")),
            &n,
            &before,
            &snapshot(&f.base),
        );
        assert!(n.status.success(), "{}", String::from_utf8_lossy(&n.stdout));
        assert_eq!(
            before,
            snapshot(&f.base),
            "reusing all destinations must preserve every byte"
        );
        assert_eq!(effects, f.coordinated_effects());
        if let Some(s) = source {
            compare(&s, &n);
        }
    }
    fn collision(characterize: bool, kind: &str, dry: bool) {
        let f = fixture();
        let dest = target(&f, "repos/alpha");
        match kind {
            "unmanaged" => {
                fs::create_dir_all(&dest).unwrap();
                fs::write(dest.join("keep"), "caller-owned").unwrap();
            }
            "mismatch" => add(&f, "repos/alpha", "other"),
            "stale" => {
                add(&f, "repos/alpha", "feature");
                fs::remove_dir_all(&dest).unwrap();
                fs::create_dir(&dest).unwrap();
            }
            "dirty" => {
                add(&f, "repos/alpha", "feature");
                fs::write(dest.join("caller.txt"), "keep").unwrap();
            }
            "locked" => {
                add(&f, "repos/alpha", "feature");
                f.git(&[
                    "-C",
                    "repos/alpha",
                    "worktree",
                    "lock",
                    dest.to_str().unwrap(),
                ]);
            }
            _ => unreachable!(),
        }
        let mut args = CREATE.to_vec();
        args.extend(["--only", "alpha"]);
        if dry {
            args.push("--dry-run");
        }
        let before = snapshot(&f.base);
        let source = if characterize || std::env::var_os("ARASHI_TS_PARITY").is_some() {
            let s = f.run(true, &args);
            record(
                &format!("source-{kind}-{dry}"),
                &s,
                &before,
                &snapshot(&f.base),
            );
            // Retained source accepts dirty and locked registrations. Native intentionally gates them.
            assert_eq!(
                s.status.success(),
                matches!(kind, "dirty" | "locked"),
                "{}",
                String::from_utf8_lossy(&s.stdout)
            );
            if !s.status.success() || dry {
                assert_eq!(before, snapshot(&f.base));
            }
            Some(s)
        } else {
            None
        };
        if characterize {
            return;
        }
        let before = snapshot(&f.base);
        let n = f.run(false, &args);
        record(
            &format!("native-{kind}-{dry}"),
            &n,
            &before,
            &snapshot(&f.base),
        );
        assert!(!n.status.success());
        assert_eq!(
            before,
            snapshot(&f.base),
            "rejection must preserve all Git, config, worktree and HOME bytes"
        );
        if !matches!(kind, "dirty" | "locked")
            && let Some(s) = source
        {
            compare(&s, &n);
        }
    }
    #[test]
    #[ignore = "retained source characterization"]
    fn create_reuse_source_characterization() {
        for dry in [true, false] {
            for filter in [
                vec![],
                vec!["--only", "alpha"],
                vec!["--group", "Backend"],
                vec!["--only", "zulu,alpha"],
            ] {
                reuse(true, dry, &filter);
            }
            for kind in ["unmanaged", "mismatch", "stale", "dirty", "locked"] {
                collision(true, kind, dry);
            }
        }
    }
    #[cfg(unix)]
    #[test]
    fn create_reuse_success_source_contract() {
        for filter in [
            vec![],
            vec!["--only", "alpha"],
            vec!["--group", "Backend"],
            vec!["--only", "zulu,alpha"],
        ] {
            reuse(false, false, &filter);
        }
    }
    #[cfg(unix)]
    #[test]
    fn create_reuse_dry_run_source_contract() {
        reuse(false, true, &[]);
        reuse(false, true, &["--only", "alpha"]);
    }
    #[test]
    fn create_reuse_collision_source_contract() {
        for dry in [true, false] {
            for kind in ["unmanaged", "mismatch", "stale"] {
                collision(false, kind, dry);
            }
        }
    }
    #[test]
    fn create_reuse_dirty_and_protected_nonmutation() {
        for dry in [true, false] {
            for kind in ["dirty", "locked"] {
                collision(false, kind, dry);
            }
        }
    }
    fn mixed(characterize: bool, dry: bool) {
        let f = fixture();
        add(&f, "", "feature");
        add(&f, "repos/alpha", "feature");
        let mut args = CREATE.to_vec();
        if dry {
            args.push("--dry-run");
        }
        let before = snapshot(&f.base);
        let s = if characterize || std::env::var_os("ARASHI_TS_PARITY").is_some() {
            let s = f.run(true, &args);
            record(
                &format!("source-mixed-{dry}"),
                &s,
                &before,
                &snapshot(&f.base),
            );
            assert!(s.status.success(), "{}", String::from_utf8_lossy(&s.stdout));
            if dry {
                assert_eq!(before, snapshot(&f.base));
            }
            Some(s)
        } else {
            None
        };
        if characterize {
            return;
        }
        let effects = f.coordinated_effects();
        let source_tree = snapshot(&target(&f, ""));
        if !dry && s.is_some() {
            f.git(&[
                "-C",
                "repos/zulu",
                "worktree",
                "remove",
                target(&f, "repos/zulu").to_str().unwrap(),
            ]);
            f.git(&["-C", "repos/zulu", "branch", "-D", "feature"]);
        }
        let existing_alpha = snapshot(&target(&f, "repos/alpha"));
        let n = f.run(false, &args);
        record(
            &format!("native-mixed-{dry}"),
            &n,
            &before,
            &snapshot(&f.base),
        );
        assert!(n.status.success(), "{}", String::from_utf8_lossy(&n.stdout));
        assert_eq!(existing_alpha, snapshot(&target(&f, "repos/alpha")));
        if let Some(s) = s {
            compare(&s, &n);
            assert_eq!(effects, f.coordinated_effects());
            assert_eq!(source_tree, snapshot(&target(&f, "")));
        }
    }
    #[test]
    #[ignore = "retained source characterization"]
    fn create_reuse_mixed_characterization() {
        mixed(true, true);
        mixed(true, false);
    }
    #[cfg(unix)]
    #[test]
    fn create_reuse_mixed_source_contract() {
        mixed(false, true);
        mixed(false, false);
    }

    #[cfg(unix)]
    #[test]
    fn create_reuse_unsupported_topology_and_policy_nonmutation() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        for kind in [
            "nested",
            "foreign-marker",
            "symlink",
            "hook",
            "materialization",
            "filter",
            "gitlink",
            "remote",
            "staged",
            "tracked-dirty",
        ] {
            let f = fixture();
            add(&f, "", "feature");
            add(&f, "repos/alpha", "feature");
            let dest = target(&f, "repos/alpha");
            let marker = f.home.join("hook-ran");
            let mut args = CREATE.to_vec();
            match kind {
                "nested" => {
                    f.git(&["init", dest.join("alien").to_str().unwrap()]);
                    fs::write(f.repo.join("repos/alpha/.git/info/exclude"), "/alien/\n").unwrap();
                }
                "foreign-marker" => {
                    fs::write(
                        dest.join(".git"),
                        format!("gitdir: {}\n", f.repo.join("repos/zulu/.git").display()),
                    )
                    .unwrap();
                }
                "symlink" => {
                    let saved = f.home.join("saved");
                    fs::rename(&dest, &saved).unwrap();
                    symlink(&saved, &dest).unwrap();
                }
                "hook" => {
                    let hooks = f.repo.join(".arashi/hooks");
                    fs::create_dir_all(&hooks).unwrap();
                    let hook = hooks.join("pre-create.sh");
                    fs::write(&hook, "#!/bin/sh\nprintf ran > \"$HOME/hook-ran\"\n").unwrap();
                    fs::set_permissions(hook, fs::Permissions::from_mode(0o755)).unwrap();
                    args.retain(|a| *a != "--no-hooks");
                }
                "materialization" => {
                    let p = f.repo.join(".arashi/config.json");
                    let mut config: Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
                    config["repos"]["zulu"]["copy"] = serde_json::json!(["secret"]);
                    fs::write(p, serde_json::to_vec(&config).unwrap()).unwrap();
                }
                "filter" => {
                    f.git(&[
                        "-C",
                        "repos/alpha",
                        "config",
                        "filter.canary.clean",
                        "touch \"$HOME/hook-ran\"; cat",
                    ]);
                    fs::write(dest.join(".gitattributes"), "* filter=canary\n").unwrap();
                }
                "gitlink" => {
                    let oid = f.git(&["rev-parse", "HEAD"]);
                    f.git(&[
                        "-C",
                        dest.to_str().unwrap(),
                        "update-index",
                        "--add",
                        "--cacheinfo",
                        &format!("160000,{},submodule", oid.trim()),
                    ]);
                }
                "remote" => {
                    f.git(&[
                        "-C",
                        "repos/alpha",
                        "remote",
                        "add",
                        "origin",
                        f.repo.join("repos/zulu").to_str().unwrap(),
                    ]);
                }
                "staged" => {
                    fs::write(dest.join("new"), "keep").unwrap();
                    f.git(&["-C", dest.to_str().unwrap(), "add", "new"]);
                }
                "tracked-dirty" => {
                    fs::write(target(&f, "").join("file.txt"), "keep edited").unwrap();
                }
                _ => unreachable!(),
            }
            let before = snapshot(&f.base);
            for dry in [true, false] {
                let mut args = args.clone();
                if dry {
                    args.push("--dry-run");
                }
                let n = f.run(false, &args);
                record(
                    &format!("native-safety-{kind}-{dry}"),
                    &n,
                    &before,
                    &snapshot(&f.base),
                );
                assert!(
                    !n.status.success(),
                    "{kind}: {}",
                    String::from_utf8_lossy(&n.stdout)
                );
                assert_eq!(before, snapshot(&f.base), "{kind}");
                assert!(!marker.exists(), "{kind}");
            }
        }
    }
    #[cfg(unix)]
    fn injected_args(f: &Fixture, body: &str, extra: &[&str]) -> Output {
        use std::os::unix::fs::PermissionsExt;
        let bin = f.home.join("bin");
        fs::create_dir(&bin).unwrap();
        let real = Command::new("which").arg("git").output().unwrap();
        let real = String::from_utf8(real.stdout).unwrap();
        let script = format!(
            "#!/bin/sh\n{body}\nexec '{}' \"$@\"\n",
            real.trim().replace('\'', "'\\''")
        );
        fs::write(bin.join("git"), script).unwrap();
        fs::set_permissions(bin.join("git"), fs::Permissions::from_mode(0o755)).unwrap();
        let mut c = Command::new(env!("CARGO_BIN_EXE_arashi"));
        f.environment(&mut c);
        c.env(
            "PATH",
            format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()),
        );
        c.env("REUSE_DEST", target(f, "repos/alpha"));
        c.args(CREATE).args(extra).output().unwrap()
    }
    #[cfg(unix)]
    fn injected(f: &Fixture, body: &str) -> Output {
        injected_args(f, body, &[])
    }
    #[cfg(unix)]
    #[test]
    fn create_reuse_concurrent_replacement_preserves_unowned_worktree() {
        let f = fixture();
        add(&f, "", "feature");
        add(&f, "repos/alpha", "feature");
        let dest = target(&f, "repos/alpha");
        let existing = snapshot(&dest);
        let n = injected(
            &f,
            r#"if [ "$1" = branch ] && [ "$2" = feature ] && [ "$(basename "$PWD")" = zulu ]; then
mv "$REUSE_DEST" "$HOME/original"
mkdir "$REUSE_DEST"
cp "$HOME/original/.git" "$REUSE_DEST/.git"
printf replacement > "$REUSE_DEST/sentinel"
fi"#,
        );
        record("native-concurrent-replacement", &n, &[], &snapshot(&f.base));
        assert!(
            !n.status.success(),
            "replacement must be detected: {}",
            String::from_utf8_lossy(&n.stdout)
        );
        assert_eq!(existing, snapshot(&f.home.join("original")));
        assert_eq!(fs::read(dest.join("sentinel")).unwrap(), b"replacement");
        assert!(!target(&f, "repos/zulu").exists());
        assert!(
            f.git(&["-C", "repos/zulu", "branch", "--list", "feature"])
                .trim()
                .is_empty()
        );
        assert!(
            !f.git(&["-C", "repos/alpha", "branch", "--list", "feature"])
                .trim()
                .is_empty()
        );
    }
    #[cfg(unix)]
    #[test]
    fn create_reuse_final_identity_change_rolls_back_new_sibling() {
        let f = fixture();
        add(&f, "", "feature");
        add(&f, "repos/alpha", "feature");
        let dest = target(&f, "repos/alpha");
        let existing = snapshot(&dest);
        let n = injected_args(
            &f,
            r#"if [ -e "$(dirname "$REUSE_DEST")/zulu/.git" ] && [ "$1" = config ] && [ "$2" = --null ] && [ "$3" = --list ]; then
count=0
[ ! -f "$HOME/config-count" ] || count="$(cat "$HOME/config-count")"
count=$((count + 1))
printf '%s' "$count" > "$HOME/config-count"
if [ "$count" -eq 3 ]; then
mv "$REUSE_DEST" "$HOME/original-final"
mkdir "$REUSE_DEST"
cp "$HOME/original-final/.git" "$REUSE_DEST/.git"
printf replacement > "$REUSE_DEST/sentinel"
fi
fi"#,
            &["--only", "alpha,zulu"],
        );
        record(
            "review-fixes/final-identity-change",
            &n,
            &[],
            &snapshot(&f.base),
        );
        assert!(
            !n.status.success(),
            "final replacement must be detected: {}",
            String::from_utf8_lossy(&n.stdout)
        );
        assert_eq!(existing, snapshot(&f.home.join("original-final")));
        assert_eq!(fs::read(dest.join("sentinel")).unwrap(), b"replacement");
        assert!(!target(&f, "repos/zulu").exists());
        assert!(
            f.git(&["-C", "repos/zulu", "branch", "--list", "feature"])
                .trim()
                .is_empty()
        );
    }
    #[cfg(unix)]
    #[test]
    fn create_reuse_safety_revalidation_identity_change_rolls_back_new_sibling() {
        let f = fixture();
        add(&f, "repos/alpha", "feature");
        let dest = target(&f, "repos/alpha");
        let existing = snapshot(&dest);
        let n = injected_args(
            &f,
            r#"if [ -e "$(dirname "$REUSE_DEST")/zulu/.git" ] && [ "$1" = config ] && [ "$2" = --null ] && [ "$3" = --list ]; then
count=0
[ ! -f "$HOME/config-count" ] || count="$(cat "$HOME/config-count")"
count=$((count + 1))
printf '%s' "$count" > "$HOME/config-count"
if [ "$count" -eq 5 ]; then
mv "$REUSE_DEST" "$HOME/original-safety"
mkdir "$REUSE_DEST"
cp "$HOME/original-safety/.git" "$REUSE_DEST/.git"
printf replacement > "$REUSE_DEST/sentinel"
fi
fi"#,
            &["--only", "alpha,zulu"],
        );
        record(
            "review-fixes/safety-revalidation-identity-change",
            &n,
            &[],
            &snapshot(&f.base),
        );
        assert!(
            !n.status.success(),
            "safety-window replacement must be detected: {}",
            String::from_utf8_lossy(&n.stdout)
        );
        assert_eq!(existing, snapshot(&f.home.join("original-safety")));
        assert_eq!(fs::read(dest.join("sentinel")).unwrap(), b"replacement");
        assert!(!target(&f, "repos/zulu").exists());
        assert!(
            f.git(&["-C", "repos/zulu", "branch", "--list", "feature"])
                .trim()
                .is_empty()
        );
    }
    #[cfg(unix)]
    #[test]
    fn create_reuse_failure_rolls_back_only_new_destinations() {
        let f = fixture();
        add(&f, "repos/alpha", "feature");
        // Select children only: an existing container is not itself a parent worktree.
        let before = snapshot(&target(&f, "repos/alpha"));
        // A full create must reject the unmanaged parent container before mutation.
        let all = f.run(false, CREATE);
        assert!(!all.status.success());
        let n = {
            let f2 = fixture();
            add(&f2, "", "feature");
            add(&f2, "repos/alpha", "feature");
            let old = snapshot(&target(&f2, ""));
            let n = injected(
                &f2,
                r#"if [ "$1" = worktree ] && [ "$2" = add ] && [ "$(basename "$PWD")" = zulu ]; then exit 42; fi"#,
            );
            assert!(!n.status.success());
            assert_eq!(old, snapshot(&target(&f2, "")));
            assert!(
                f2.git(&["-C", "repos/zulu", "branch", "--list", "feature"])
                    .trim()
                    .is_empty()
            );
            record("native-rollback", &n, &[], &snapshot(&f2.base));
            n
        };
        assert!(!n.status.success());
        assert_eq!(before, snapshot(&target(&f, "repos/alpha")));
    }
    #[cfg(unix)]
    #[test]
    fn create_reuse_parent_replacement_preserves_transaction() {
        let f = fixture();
        add(&f, "", "feature");
        add(&f, "repos/alpha", "feature");
        let parent = target(&f, "");
        let before = snapshot(&parent);
        let n = injected(
            &f,
            r#"if [ "$1" = branch ] && [ "$2" = feature ] && [ "$(basename "$PWD")" = zulu ]; then
parent="$(dirname "$(dirname "$REUSE_DEST")")"
mv "$parent" "$HOME/original-parent"
mkdir -p "$parent/repos"
cp "$HOME/original-parent/.git" "$parent/.git"
printf replacement > "$parent/sentinel"
fi"#,
        );
        record("native-parent-replacement", &n, &[], &snapshot(&f.base));
        assert!(!n.status.success());
        assert_eq!(before, snapshot(&f.home.join("original-parent")));
        assert_eq!(fs::read(parent.join("sentinel")).unwrap(), b"replacement");
        let v: Value = serde_json::from_slice(&n.stdout).unwrap();
        assert!(
            v["error"]["details"]["rollbackErrors"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e.as_str().unwrap().contains("transaction preserved"))
        );
        // A child created through a replaced ancestor is retained, never removed by path.
        assert!(target(&f, "repos/zulu").join(".git").exists());
    }
    #[cfg(unix)]
    #[test]
    fn create_reuse_selection_ignores_unselected_destinations() {
        let f = fixture();
        add(&f, "repos/alpha", "feature");
        fs::create_dir_all(target(&f, "repos/zulu")).unwrap();
        fs::write(target(&f, "repos/zulu").join("keep"), "unselected").unwrap();
        let mut args = CREATE.to_vec();
        args.extend(["--only", "alpha", "--base", "main"]);
        let source = if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            Some(f.run(true, &args))
        } else {
            None
        };
        let before = snapshot(&f.base);
        let n = f.run(false, &args);
        assert!(n.status.success(), "{}", String::from_utf8_lossy(&n.stdout));
        assert_eq!(before, snapshot(&f.base));
        if let Some(s) = source {
            compare(&s, &n);
        }
    }
    #[cfg(windows)]
    #[test]
    fn create_reuse_windows_rejects_before_mutation() {
        let f = fixture();
        add(&f, "repos/alpha", "feature");
        let mut args = CREATE.to_vec();
        args.extend(["--only", "alpha"]);
        let before = snapshot(&f.base);
        let n = f.run(false, &args);
        assert!(!n.status.success());
        assert_eq!(before, snapshot(&f.base));
        assert!(String::from_utf8_lossy(&n.stdout).contains("POSIX object identity"));
    }
    #[cfg(unix)]
    #[test]
    fn create_reuse_duplicate_registration_rejects_dry_run() {
        fn copy_tree(source: &Path, target: &Path) {
            fs::create_dir(target).unwrap();
            for entry in fs::read_dir(source).unwrap() {
                let entry = entry.unwrap();
                let dest = target.join(entry.file_name());
                if entry.file_type().unwrap().is_dir() {
                    copy_tree(&entry.path(), &dest);
                } else {
                    fs::copy(entry.path(), dest).unwrap();
                }
            }
        }
        let f = fixture();
        add(&f, "repos/alpha", "feature");
        let admin = PathBuf::from(
            f.git(&[
                "-C",
                target(&f, "repos/alpha").to_str().unwrap(),
                "rev-parse",
                "--absolute-git-dir",
            ])
            .trim(),
        );
        copy_tree(&admin, &admin.with_file_name("duplicate"));
        let records = f.git(&["-C", "repos/alpha", "worktree", "list", "--porcelain", "-z"]);
        assert_eq!(
            records.matches("branch refs/heads/feature").count(),
            2,
            "fixture must contain two registrations"
        );
        let mut args = CREATE.to_vec();
        args.extend(["--only", "alpha", "--dry-run"]);
        let before = snapshot(&f.base);
        let n = f.run(false, &args);
        record(
            "native-duplicate-registration",
            &n,
            &before,
            &snapshot(&f.base),
        );
        assert!(
            !n.status.success(),
            "ambiguous registration must not be actionable: {}",
            String::from_utf8_lossy(&n.stdout)
        );
        assert_eq!(before, snapshot(&f.base));
    }
    #[cfg(unix)]
    #[test]
    fn create_reuse_fsmonitor_rejected_before_execution() {
        use std::os::unix::fs::PermissionsExt;
        let f = fixture();
        add(&f, "repos/alpha", "feature");
        let hook = f.home.join("fsmonitor");
        fs::write(
            &hook,
            "#!/bin/sh\nprintf ran > \"$HOME/fsmonitor-ran\"\nprintf 'token\\0'\n",
        )
        .unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        f.git(&[
            "-C",
            "repos/alpha",
            "config",
            "core.fsmonitor",
            hook.to_str().unwrap(),
        ]);
        let mut args = CREATE.to_vec();
        args.extend(["--only", "alpha"]);
        let before = snapshot(&f.base);
        let n = f.run(false, &args);
        record("native-fsmonitor", &n, &before, &snapshot(&f.base));
        assert!(
            !f.home.join("fsmonitor-ran").exists(),
            "reuse ran an unsupported fsmonitor during dirty guidance"
        );
        assert!(!n.status.success());
        assert_eq!(before, snapshot(&f.base));
        // Prove the configured executable is live, without relying on a vacuous guard.
        f.git(&["-C", "repos/alpha", "status", "--porcelain"]);
        assert!(f.home.join("fsmonitor-ran").exists());
    }
    #[cfg(unix)]
    fn mixed_new_driver(kind: &str) {
        use std::os::unix::fs::PermissionsExt;
        let f = fixture();
        add(&f, "repos/alpha", "feature");
        fs::write(f.repo.join("repos/zulu/file.txt"), "tracked\n").unwrap();
        f.git(&["-C", "repos/zulu", "add", "file.txt"]);
        let driver = f.home.join("driver");
        let sentinel = f.home.join("driver-ran");
        fs::write(
            &driver,
            "#!/bin/sh\nprintf ran > \"$HOME/driver-ran\"\ncat\n",
        )
        .unwrap();
        fs::set_permissions(&driver, fs::Permissions::from_mode(0o755)).unwrap();
        if kind == "clean" {
            fs::write(
                f.repo.join("repos/zulu/.git/info/attributes"),
                "* filter=review\n",
            )
            .unwrap();
        }
        let key = if kind == "clean" {
            "filter.review.clean"
        } else {
            "core.fsmonitor"
        };
        f.git(&["-C", "repos/zulu", "config", key, driver.to_str().unwrap()]);
        // A changed tracked file guarantees status needs conversion, independent of stat cache.
        fs::write(f.repo.join("repos/zulu/file.txt"), "changed\n").unwrap();
        f.git(&["-C", "repos/zulu", "status", "--porcelain"]);
        assert!(sentinel.exists(), "positive control did not run {kind}");
        fs::remove_file(&sentinel).unwrap();
        let before = snapshot(&f.base);
        let mut args = CREATE.to_vec();
        args.extend(["--only", "alpha,zulu"]);
        let n = f.run(false, &args);
        let after = snapshot(&f.base);
        record(
            &format!("review-fixes/mixed-new-{kind}"),
            &n,
            &before,
            &after,
        );
        assert!(
            !n.status.success() && !sentinel.exists() && before == after,
            "{kind}: exit={:?}, sentinel={}, byte_exact={} stdout={}",
            n.status.code(),
            sentinel.exists(),
            before == after,
            String::from_utf8_lossy(&n.stdout)
        );
    }
    #[cfg(unix)]
    #[test]
    fn create_reuse_mixed_new_fsmonitor_guard() {
        mixed_new_driver("fsmonitor");
    }
    #[cfg(unix)]
    #[test]
    fn create_reuse_mixed_new_clean_guard() {
        mixed_new_driver("clean");
    }
}
