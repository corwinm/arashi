// Real configured create fixtures; production TypeScript remains the oracle.
mod materialization {
    use super::*;
    const CREATE: &[&str] = &[
        "create",
        "feature",
        "--no-launch",
        "--no-switch",
        "--no-hooks",
        "--json",
    ];
    fn fixture() -> Fixture {
        let mut f = Fixture::new();
        f.configured();
        for repo in ["", "repos/alpha", "repos/zulu"] {
            f.git(&["-C", p_or_dot(repo), "config", "maintenance.auto", "false"]);
        }
        let root = f.repo.join("repos/alpha");
        fs::create_dir_all(root.join("assets with spaces/nested")).unwrap();
        fs::write(
            root.join("assets with spaces/nested/value$.txt"),
            b"asset\0bytes",
        )
        .unwrap();
        fs::write(root.join("secret.env"), b"private\n").unwrap();
        fs::write(root.join("cache"), b"cache\n").unwrap();
        configure(
            &f,
            serde_json::json!({"copy":["secret.env", "assets with spaces", "optional"]}),
        );
        f
    }
    fn configure(f: &Fixture, policy: Value) {
        let path = f.repo.join(".arashi/config.json");
        let mut c: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        c["repos"]["alpha"]
            .as_object_mut()
            .unwrap()
            .extend(policy.as_object().unwrap().clone());
        fs::write(path, serde_json::to_vec(&c).unwrap()).unwrap();
    }
    fn snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        fn visit(root: &Path, path: &Path, rows: &mut Vec<(PathBuf, Vec<u8>)>) {
            let metadata = fs::symlink_metadata(path).unwrap();
            let bytes = if metadata.file_type().is_symlink() {
                fs::read_link(path)
                    .unwrap()
                    .to_string_lossy()
                    .as_bytes()
                    .to_vec()
            } else if metadata.is_file() {
                fs::read(path).unwrap()
            } else {
                vec![]
            };
            rows.push((path.strip_prefix(root).unwrap().to_owned(), bytes));
            if metadata.is_dir() {
                let mut children = fs::read_dir(path)
                    .unwrap()
                    .map(|e| e.unwrap().path())
                    .collect::<Vec<_>>();
                children.sort();
                for child in children {
                    visit(root, &child, rows);
                }
            }
        }
        let mut rows = vec![];
        visit(root, root, &mut rows);
        rows
    }
    fn target(f: &Fixture) -> PathBuf {
        f.repo
            .join(".arashi")
            .join("worktrees")
            .join("feature")
            .join("repos")
            .join("alpha")
    }
    fn record(label: &str, output: &Output) {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/materialization");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{label}.json")), serde_json::to_vec_pretty(&serde_json::json!({"exit":output.status.code(),"stdout":String::from_utf8_lossy(&output.stdout),"stderr":String::from_utf8_lossy(&output.stderr)})).unwrap()).unwrap();
    }
    fn journey(characterize: bool, dry: bool, selected: bool) {
        let f = fixture();
        let mut args = CREATE.to_vec();
        if dry {
            args.push("--dry-run");
        }
        if selected {
            args.extend(["--only", "alpha"]);
        }
        let check = |source| {
            let o = f.run(source, &args);
            record(
                &format!(
                    "{}-{dry}-{selected}",
                    if source { "source" } else { "native" }
                ),
                &o,
            );
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stdout));
            if !dry {
                assert_eq!(
                    fs::read(target(&f).join("secret.env")).unwrap(),
                    b"private\n"
                );
                assert_eq!(
                    fs::read(target(&f).join("assets with spaces/nested/value$.txt")).unwrap(),
                    b"asset\0bytes"
                );
                assert!(!target(&f).join("optional").exists());
            }
            o
        };
        let source = if characterize || std::env::var_os("ARASHI_TS_PARITY").is_some() {
            Some(check(true))
        } else {
            None
        };
        if characterize {
            return;
        }
        if source.is_some() {
            f.reset_coordinated();
        }
        let native = check(false);
        if let Some(source) = source {
            compare(&source, &native);
        }
    }
    #[test]
    #[ignore = "retained source characterization"]
    fn materialization_source_characterization() {
        for dry in [true, false] {
            for selected in [true, false] {
                journey(true, dry, selected);
            }
        }
    }
    #[cfg(unix)]
    #[test]
    fn materialization_copy_source_contract() {
        for dry in [true, false] {
            for selected in [true, false] {
                journey(false, dry, selected);
            }
        }
    }
    #[cfg(unix)]
    fn hook(f: &Fixture, name: &str, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        let path = f.repo.join(".arashi/hooks").join(format!("{name}.sh"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn materialization_hook_order_and_links_source_contract() {
        let f = fixture();
        configure(&f, serde_json::json!({"symlink":["cache"]}));
        hook(
            &f,
            "pre-create.alpha",
            "test ! -e secret.env || exit 9; printf pre > \"$HOME/trace\"; printf refreshed > \"$ARASHI_HOOK_TARGET_REPO_PATH/secret.env\"",
        );
        hook(
            &f,
            "post-create.alpha",
            "test \"$(cat secret.env)\" = refreshed && test -L cache || exit 10; printf post >> \"$HOME/trace\"",
        );
        let args: Vec<_> = CREATE
            .iter()
            .copied()
            .filter(|a| *a != "--no-hooks")
            .collect();
        let check = |source| {
            let o = f.run(source, &args);
            record(
                if source {
                    "source-hooks"
                } else {
                    "native-hooks"
                },
                &o,
            );
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stdout));
            assert_eq!(fs::read(f.home.join("trace")).unwrap(), b"prepost");
            assert_eq!(
                fs::read_link(target(&f).join("cache")).unwrap(),
                f.repo.join("repos").join("alpha").join("cache")
            );
            o
        };
        let s = std::env::var_os("ARASHI_TS_PARITY").map(|_| check(true));
        if s.is_some() {
            f.reset_coordinated();
        }
        let n = check(false);
        if let Some(s) = s {
            compare(&s, &n);
        }
    }
    #[cfg(unix)]
    #[test]
    fn materialization_target_tree_blocks_before_mutation() {
        for dry in [false, true] {
            let f = fixture();
            f.git(&["-C", "repos/alpha", "add", "secret.env"]);
            f.git(&[
                "-C",
                "repos/alpha",
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-m",
                "tracked",
            ]);
            let before = f.coordinated_effects();
            let mut args = CREATE.to_vec();
            if dry {
                args.push("--dry-run");
            }
            let source = std::env::var_os("ARASHI_TS_PARITY").map(|_| {
                let source = f.run(true, &args);
                record(&format!("source-blocked-{dry}"), &source);
                assert!(!source.status.success());
                source
            });
            let native = f.run(false, &args);
            record(&format!("native-blocked-{dry}"), &native);
            assert!(!native.status.success());
            if let Some(source) = source {
                compare(&source, &native);
            }
            assert_eq!(before, f.coordinated_effects());
        }
    }
    #[cfg(unix)]
    #[test]
    fn materialization_rollback_preserves_changed_copy_and_existing_branch() {
        for changed in [false, true] {
            let f = fixture();
            f.git(&["-C", "repos/alpha", "branch", "feature"]);
            let oid = f.git(&["-C", "repos/alpha", "rev-parse", "feature"]);
            hook(
                &f,
                "post-create.alpha",
                if changed {
                    "printf user-edit > secret.env; exit 17"
                } else {
                    "exit 17"
                },
            );
            let mut args: Vec<_> = CREATE
                .iter()
                .copied()
                .filter(|a| *a != "--no-hooks")
                .collect();
            args.extend(["--conflict", "REUSE_EXISTING"]);
            let o = f.run(false, &args);
            record(&format!("native-rollback-{changed}"), &o);
            assert!(!o.status.success());
            assert_eq!(f.git(&["-C", "repos/alpha", "rev-parse", "feature"]), oid);
            assert_eq!(
                fs::read(f.repo.join("repos/alpha/secret.env")).unwrap(),
                b"private\n"
            );
            if changed {
                assert_eq!(
                    fs::read(target(&f).join("secret.env")).unwrap(),
                    b"user-edit"
                );
                assert!(String::from_utf8_lossy(&o.stdout).contains("preserved"));
            } else {
                assert!(!target(&f).exists());
            }
        }
    }
    #[cfg(unix)]
    #[test]
    fn materialization_sources_fail_closed_before_hooks() {
        use std::os::unix::fs::symlink;
        for topology in ["dangling", "outside", "nested", "overlap", "unicode"] {
            let f = fixture();
            match topology {
                "dangling" => {
                    fs::remove_file(f.repo.join("repos/alpha/secret.env")).unwrap();
                    symlink("absent", f.repo.join("repos/alpha/secret.env")).unwrap();
                }
                "outside" => {
                    symlink(
                        &f.home,
                        f.repo.join("repos/alpha/assets with spaces/outside"),
                    )
                    .unwrap();
                }
                "nested" => {
                    fs::create_dir(f.repo.join("repos/alpha/assets with spaces/.git")).unwrap();
                }
                "overlap" => configure(
                    &f,
                    serde_json::json!({"copy":["assets with spaces","assets with spaces/nested"]}),
                ),
                _ => configure(&f, serde_json::json!({"copy":["caf\u{e9}"]})),
            }
            hook(&f, "pre-create", "printf ran > \"$HOME/canary\"");
            let before = f.coordinated_effects();
            let args: Vec<_> = CREATE
                .iter()
                .copied()
                .filter(|a| *a != "--no-hooks")
                .collect();
            let o = f.run(false, &args);
            record(&format!("native-safety-{topology}"), &o);
            assert!(!o.status.success(), "{topology}");
            assert!(!f.home.join("canary").exists(), "{topology}");
            assert_eq!(before, f.coordinated_effects());
        }
        let f = fixture();
        hook(&f, "pre-create", "printf ran > \"$HOME/canary\"");
        let args: Vec<_> = CREATE
            .iter()
            .copied()
            .filter(|a| *a != "--no-hooks")
            .collect();
        assert!(f.run(false, &args).status.success());
        assert!(f.home.join("canary").exists());
    }
    #[cfg(unix)]
    #[test]
    fn materialization_partial_write_rolls_back() {
        let f = fixture();
        fs::write(f.repo.join("repos/alpha/secret.env"), vec![b'x'; 200_000]).unwrap();
        let before = f.coordinated_effects();
        let mut c = Command::new("python3");
        c.args(["-c", "import os,resource,signal,sys; resource.setrlimit(resource.RLIMIT_FSIZE,(65536,65536)); signal.signal(signal.SIGXFSZ,signal.SIG_IGN); os.execv(sys.argv[1],sys.argv[1:])", env!("CARGO_BIN_EXE_arashi")]);
        c.args(CREATE);
        f.environment(&mut c);
        let o = c.output().unwrap();
        record("native-partial-write", &o);
        assert!(!o.status.success());
        assert!(String::from_utf8_lossy(&o.stdout).contains("File too large"));
        assert!(!target(&f).exists());
        assert_eq!(before, f.coordinated_effects());
    }
    #[cfg(unix)]
    #[test]
    fn materialization_nested_parent_modes_source_contract() {
        use std::os::unix::fs::PermissionsExt;
        let f = fixture();
        configure(
            &f,
            serde_json::json!({"copy":["assets with spaces/nested/value$.txt"]}),
        );
        fs::set_permissions(
            f.repo.join("repos/alpha/assets with spaces"),
            fs::Permissions::from_mode(0o750),
        )
        .unwrap();
        fs::set_permissions(
            f.repo.join("repos/alpha/assets with spaces/nested"),
            fs::Permissions::from_mode(0o710),
        )
        .unwrap();
        for source in [true, false] {
            if source && std::env::var_os("ARASHI_TS_PARITY").is_none() {
                continue;
            }
            let o = f.run(source, CREATE);
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stdout));
            assert_eq!(
                fs::metadata(target(&f).join("assets with spaces"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o750
            );
            assert_eq!(
                fs::metadata(target(&f).join("assets with spaces/nested"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o710
            );
            f.reset_coordinated();
        }
    }
    #[cfg(unix)]
    #[test]
    fn materialization_parent_policy_cannot_overlap_child_destinations() {
        let f = fixture();
        let path = f.repo.join(".arashi/config.json");
        let mut c: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        // Missing source still must not grant a later hook permission to occupy child topology.
        c["repos"]["workspace"] = serde_json::json!({"path":".","copy":["repos/alpha"]});
        fs::write(path, serde_json::to_vec(&c).unwrap()).unwrap();
        hook(&f, "pre-create", "printf ran > \"$HOME/canary\"");
        let args: Vec<_> = CREATE
            .iter()
            .copied()
            .filter(|a| *a != "--no-hooks")
            .collect();
        let o = f.run(false, &args);
        record("native-overlap-child", &o);
        assert!(!o.status.success());
        assert!(!f.home.join("canary").exists());
    }

    #[cfg(unix)]
    #[test]
    fn materialization_readonly_directory_rollback() {
        use std::os::unix::fs::PermissionsExt;
        let f = fixture();
        let source = f.repo.join("repos/alpha/assets with spaces/nested");
        fs::set_permissions(&source, fs::Permissions::from_mode(0o500)).unwrap();
        hook(&f, "post-create.alpha", "exit 17");
        let args: Vec<_> = CREATE
            .iter()
            .copied()
            .filter(|a| *a != "--no-hooks")
            .collect();
        let o = f.run(false, &args);
        // Reopen fixture source before its disposable cleanup.
        fs::set_permissions(source, fs::Permissions::from_mode(0o700)).unwrap();
        record("native-readonly-rollback", &o);
        assert!(!o.status.success());
        assert!(
            !target(&f).exists(),
            "{}",
            String::from_utf8_lossy(&o.stdout)
        );
    }
    #[cfg(unix)]
    #[test]
    fn materialization_hook_destination_symlink_does_not_touch_outside() {
        let f = fixture();
        hook(
            &f,
            "pre-create.alpha",
            "ln -s \"$HOME\" 'assets with spaces'",
        );
        let before = fs::read(f.repo.join("repos/alpha/secret.env")).unwrap();
        let args: Vec<_> = CREATE
            .iter()
            .copied()
            .filter(|a| *a != "--no-hooks")
            .collect();
        let o = f.run(false, &args);
        assert!(!o.status.success());
        assert!(!f.home.join("nested").exists());
        assert!(!target(&f).exists());
        assert_eq!(
            before,
            fs::read(f.repo.join("repos/alpha/secret.env")).unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn materialization_changed_ref_preserves_committed_copy() {
        let f = fixture();
        hook(
            &f,
            "post-create.alpha",
            "git add secret.env; git -c user.name=Test -c user.email=test@example.invalid -c maintenance.auto=false commit -m hook >/dev/null; exit 17",
        );
        let args: Vec<_> = CREATE
            .iter()
            .copied()
            .filter(|a| *a != "--no-hooks")
            .collect();
        let o = f.run(false, &args);
        record("native-changed-ref", &o);
        assert!(!o.status.success());
        assert_eq!(
            fs::read(target(&f).join("secret.env")).unwrap(),
            b"private\n"
        );
        assert!(
            f.git(&["-C", target(&f).to_str().unwrap(), "status", "--porcelain"])
                .lines()
                .all(|line| !line.contains("secret.env"))
        );
    }
    #[cfg(unix)]
    #[test]
    fn materialization_shared_readonly_parent_source_contract() {
        use std::os::unix::fs::PermissionsExt;
        let f = fixture();
        let source_dir = f.repo.join("repos/alpha/assets with spaces/nested");
        fs::write(source_dir.join("second"), b"second").unwrap();
        configure(
            &f,
            serde_json::json!({"copy":["assets with spaces/nested/value$.txt","assets with spaces/nested/second"]}),
        );
        fs::set_permissions(&source_dir, fs::Permissions::from_mode(0o500)).unwrap();
        for source in [true, false] {
            if source && std::env::var_os("ARASHI_TS_PARITY").is_none() {
                continue;
            }
            let o = f.run(source, CREATE);
            record(
                if source {
                    "source-shared-parent"
                } else {
                    "native-shared-parent"
                },
                &o,
            );
            // Always reopen source so failed assertions do not prevent fixture cleanup.
            fs::set_permissions(&source_dir, fs::Permissions::from_mode(0o700)).unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stdout));
            assert_eq!(
                fs::read(target(&f).join("assets with spaces/nested/second")).unwrap(),
                b"second"
            );
            assert_eq!(
                fs::metadata(target(&f).join("assets with spaces/nested"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o500
            );
            fs::set_permissions(
                target(&f).join("assets with spaces/nested"),
                fs::Permissions::from_mode(0o700),
            )
            .unwrap();
            f.reset_coordinated();
            fs::set_permissions(&source_dir, fs::Permissions::from_mode(0o500)).unwrap();
        }
        fs::set_permissions(source_dir, fs::Permissions::from_mode(0o700)).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn materialization_missing_registration_preserves_files() {
        let f = fixture();
        hook(
            &f,
            "post-create.alpha",
            "rm .git; git -C \"$ARASHI_HOOK_TARGET_REPO_PATH\" worktree prune --expire now; exit 17",
        );
        let args: Vec<_> = CREATE
            .iter()
            .copied()
            .filter(|a| *a != "--no-hooks")
            .collect();
        let o = f.run(false, &args);
        record("native-missing-registration", &o);
        assert!(!o.status.success());
        assert_eq!(
            fs::read(target(&f).join("secret.env")).unwrap(),
            b"private\n"
        );
    }
    #[cfg(unix)]
    #[test]
    fn materialization_replans_target_ref_after_pre_hook() {
        let f = fixture();
        hook(
            &f,
            "pre-create.alpha",
            "printf tracked > secret.env; git add secret.env; git -c user.name=Test -c user.email=test@example.invalid -c maintenance.auto=false commit -m pre >/dev/null; rm secret.env",
        );
        hook(
            &f,
            "post-create.alpha",
            "printf ran > \"$HOME/post-canary\"",
        );
        let args: Vec<_> = CREATE
            .iter()
            .copied()
            .filter(|a| *a != "--no-hooks")
            .collect();
        for source in [true, false] {
            if source && std::env::var_os("ARASHI_TS_PARITY").is_none() {
                continue;
            }
            let o = f.run(source, &args);
            record(
                if source {
                    "source-pre-ref"
                } else {
                    "native-pre-ref"
                },
                &o,
            );
            assert!(
                !o.status.success(),
                "{}",
                String::from_utf8_lossy(&o.stdout)
            );
            if source {
                assert!(
                    String::from_utf8_lossy(&o.stdout).contains("destination_exists"),
                    "{}",
                    String::from_utf8_lossy(&o.stdout)
                );
            }
            assert!(!f.home.join("post-canary").exists());
            assert!(!target(&f).join("secret.env").exists());
            f.reset_coordinated();
        }
    }

    #[cfg(unix)]
    #[test]
    fn materialization_preserved_directory_restores_copied_mode() {
        use std::os::unix::fs::PermissionsExt;
        let f = fixture();
        let source = f.repo.join("repos/alpha/assets with spaces/nested");
        fs::set_permissions(&source, fs::Permissions::from_mode(0o500)).unwrap();
        hook(
            &f,
            "post-create.alpha",
            "printf changed > 'assets with spaces/nested/value$.txt'; exit 17",
        );
        let args: Vec<_> = CREATE
            .iter()
            .copied()
            .filter(|a| *a != "--no-hooks")
            .collect();
        let o = f.run(false, &args);
        fs::set_permissions(&source, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(!o.status.success());
        let dir = target(&f).join("assets with spaces/nested");
        let mode = fs::symlink_metadata(&dir).unwrap().permissions().mode() & 0o777;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(fs::read(dir.join("value$.txt")).unwrap(), b"changed");
        assert_eq!(mode, 0o500, "preserved copied directory mode");
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn materialization_symlink_capability_blocks_before_mutation() {
        let f = fixture();
        configure(&f, serde_json::json!({"copy":[], "symlink":["cache"]}));
        hook(&f, "pre-create", "printf ran > \"$HOME/canary\"");
        let args: Vec<_> = CREATE
            .iter()
            .copied()
            .filter(|a| *a != "--no-hooks")
            .collect();
        // Positive control: the exact hook and native link policy really execute.
        assert!(f.run(false, &args).status.success());
        assert!(f.home.join("canary").exists());
        assert!(
            fs::symlink_metadata(target(&f).join("cache"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        f.reset_coordinated();
        fs::remove_file(f.home.join("canary")).unwrap();
        let source = f.home.join("deny.c");
        let library = f.home.join("deny.dylib");
        fs::write(&source, r#"
#include <errno.h>
#include <unistd.h>
#ifdef __APPLE__
static int deny_link(const char *target, const char *path) {
    (void)target; (void)path; errno = EOPNOTSUPP; return -1;
}
__attribute__((used)) static struct { const void *replacement; const void *original; }
interpose __attribute__((section("__DATA,__interpose"))) = { (const void *)deny_link, (const void *)symlink };
#else
int symlink(const char *target, const char *path) {
    (void)target; (void)path; errno = EOPNOTSUPP; return -1;
}
#endif
"#).unwrap();
        let mut cc = Command::new("cc");
        cc.args(if cfg!(target_os = "macos") {
            vec!["-dynamiclib"]
        } else {
            vec!["-shared", "-fPIC"]
        });
        assert!(
            cc.arg(&source)
                .arg("-o")
                .arg(&library)
                .status()
                .unwrap()
                .success()
        );
        let before = f.coordinated_effects();
        let files_before = (snapshot(&f.repo), snapshot(&f.home));
        let mut command = Command::new(env!("CARGO_BIN_EXE_arashi"));
        f.environment(&mut command);
        command.args(&args).env(
            if cfg!(target_os = "macos") {
                "DYLD_INSERT_LIBRARIES"
            } else {
                "LD_PRELOAD"
            },
            &library,
        );
        let o = command.output().unwrap();
        assert!(!o.status.success());
        assert!(
            !f.home.join("canary").exists(),
            "unsupported symlink reached executable hook"
        );
        assert_eq!(
            files_before,
            (snapshot(&f.repo), snapshot(&f.home)),
            "probe, Git, config, ignore and HOME bytes"
        );
        assert_eq!(before, f.coordinated_effects());
        assert!(
            String::from_utf8_lossy(&o.stdout).contains("symlink_unsupported"),
            "{}",
            String::from_utf8_lossy(&o.stdout)
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn materialization_missing_symlink_source_probes_before_hooks() {
        let f = fixture();
        configure(&f, serde_json::json!({"copy":[], "symlink":["late"]}));
        hook(
            &f,
            "pre-create",
            "printf late > repos/alpha/late; printf ran > \"$HOME/canary\"",
        );
        let source = f.home.join("deny-late.c");
        let library = f.home.join("deny-late.dylib");
        fs::write(
            &source,
            r#"
#include <errno.h>
#include <unistd.h>
#ifdef __APPLE__
static int deny_link(const char *target, const char *path) {
    (void)target; (void)path; errno = EOPNOTSUPP; return -1;
}
__attribute__((used)) static struct { const void *replacement; const void *original; }
interpose __attribute__((section("__DATA,__interpose"))) = { (const void *)deny_link, (const void *)symlink };
#else
int symlink(const char *target, const char *path) {
    (void)target; (void)path; errno = EOPNOTSUPP; return -1;
}
#endif
"#,
        )
        .unwrap();
        let mut cc = Command::new("cc");
        cc.args(if cfg!(target_os = "macos") {
            vec!["-dynamiclib"]
        } else {
            vec!["-shared", "-fPIC"]
        });
        assert!(
            cc.arg(&source)
                .arg("-o")
                .arg(&library)
                .status()
                .unwrap()
                .success()
        );
        let before = f.coordinated_effects();
        let files_before = (snapshot(&f.repo), snapshot(&f.home));
        let mut command = Command::new(env!("CARGO_BIN_EXE_arashi"));
        f.environment(&mut command);
        let args: Vec<_> = CREATE
            .iter()
            .copied()
            .filter(|a| *a != "--no-hooks")
            .collect();
        command.args(&args).env(
            if cfg!(target_os = "macos") {
                "DYLD_INSERT_LIBRARIES"
            } else {
                "LD_PRELOAD"
            },
            &library,
        );
        let o = command.output().unwrap();
        assert!(!o.status.success());
        assert!(
            String::from_utf8_lossy(&o.stdout).contains("symlink_unsupported"),
            "{}",
            String::from_utf8_lossy(&o.stdout)
        );
        assert!(!f.home.join("canary").exists());
        assert!(!f.repo.join("repos/alpha/late").exists());
        assert_eq!(files_before, (snapshot(&f.repo), snapshot(&f.home)));
        assert_eq!(before, f.coordinated_effects());
    }

    #[test]
    fn materialization_never_uses_timestamp_ownership() {
        // Portable safety guard; Windows behavioral acceptance is separately gated below.
        let implementation = include_str!("../../src/rust/materialization.rs");
        assert!(
            !implementation.contains(".created()"),
            "mutable creation timestamps cannot establish rollback ownership"
        );
    }

    #[cfg(windows)]
    #[test]
    fn materialization_windows_policies_reject_before_mutation() {
        for policy in [
            serde_json::json!({"copy":["secret.env"],"symlink":[]}),
            serde_json::json!({"copy":[],"symlink":["cache"]}),
        ] {
            for hooks in [false, true] {
                let f = fixture();
                configure(&f, policy.clone());
                let hook = f.repo.join(".arashi").join("hooks").join("pre-create.cmd");
                fs::create_dir_all(hook.parent().unwrap()).unwrap();
                fs::write(&hook, "@echo ran > %USERPROFILE%\\canary\r\n").unwrap();
                let before = f.coordinated_effects();
                let files_before = (snapshot(&f.repo), snapshot(&f.home));
                let args: Vec<_> = CREATE
                    .iter()
                    .copied()
                    .filter(|a| !hooks || *a != "--no-hooks")
                    .collect();
                let o = f.run(false, &args);
                assert!(!o.status.success());
                assert!(
                    String::from_utf8_lossy(&o.stdout)
                        .contains("Windows materialization is unsupported"),
                    "{}",
                    String::from_utf8_lossy(&o.stdout)
                );
                assert!(!f.home.join("canary").exists());
                assert_eq!(files_before, (snapshot(&f.repo), snapshot(&f.home)));
                assert_eq!(before, f.coordinated_effects());
            }
        }
    }
}
