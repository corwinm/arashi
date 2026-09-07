fn source_ignore_helper(f: &Fixture, trees: &str, dry: bool) -> Value {
    let module = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib/managed-ignore.ts");
    let script = format!(
        "import {{pathToFileURL}} from 'node:url'; const {{reconcileManagedIgnore}} = await import(pathToFileURL({})); console.log(JSON.stringify(await reconcileManagedIgnore({{workspaceRoot:process.cwd(),reposDir:'repos',worktreesDir:{},dryRun:{dry}}}).catch(error => ({{error:error.message,details:error.details}}))));",
        serde_json::to_string(&module).unwrap(),
        serde_json::to_string(trees).unwrap(),
    );
    let output = Command::new("node")
        .args(["--input-type=module", "-e", &script])
        .current_dir(&f.root)
        .env("HOME", &f.home)
        .env("USERPROFILE", &f.home)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", f.home.join(".gitconfig"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    eprintln!("helper trees={trees} dry={dry}: {value}");
    value
}

#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn managed_ignore_helper_source_transitions_dry_run_and_rollback() {
    use arashi::managed::{IgnorePlan, Transaction};
    assert_eq!(std::env::var("ARASHI_TS_PARITY").as_deref(), Ok("1"));
    let f = Fixture::new(None);
    let files = [f.root.join(".git/info/exclude"), f.root.join(".gitignore")];
    // Both unowned rules and suffix bytes must survive every direction.
    fs::write(&files[0], "# caller\r\n/caller/\n\n# BEGIN Arashi managed ignore rules\n/.arashi/worktrees/\n/repos/\n# END Arashi managed ignore rules\n# tail").unwrap();
    fs::write(&files[1], "# tracked caller\r\n/unowned/\n# tracked tail").unwrap();
    for (scope, trees) in [
        ("tracked", ".arashi/worktrees"),
        ("local", "trees-two"),
        ("none", "trees-three"),
        ("tracked", "trees-three"),
        ("", "trees-four"),
    ] {
        git(&f.root, &["config", "--local", "arashi.ignoreScope", scope]);
        let config = fs::read(f.root.join(".git/config")).unwrap();
        let before = files.each_ref().map(|p| fs::read(p).unwrap());
        for dry in [true, false] {
            let expected = source_ignore_helper(&f, trees, dry);
            let after = files.each_ref().map(|p| fs::read(p).unwrap());
            for i in 0..2 {
                fs::write(&files[i], &before[i]).unwrap();
            }
            let plan = IgnorePlan::build(&f.root, "repos", trees, dry).unwrap();
            assert_eq!(plan.data, expected);
            let mut tx = Transaction::default();
            plan.apply(&mut tx).unwrap();
            assert_eq!(files.each_ref().map(|p| fs::read(p).unwrap()), after);
            assert_eq!(fs::read(f.root.join(".git/config")).unwrap(), config);
            // Restore both sides, then leave the applied transition as the
            // next transition's real input.
            assert!(tx.rollback().is_empty());
            assert_eq!(files.each_ref().map(|p| fs::read(p).unwrap()), before);
            if !dry {
                plan.apply(&mut Transaction::default()).unwrap();
            }
        }
    }
}

#[test]
fn managed_ignore_helper_revalidates_both_files_and_preference() {
    use arashi::managed::{IgnorePlan, Transaction};
    for change in ["local", "tracked", "preference"] {
        let f = Fixture::new(None);
        fs::write(f.root.join(".gitignore"), "# caller").unwrap();
        git(
            &f.root,
            &["config", "--local", "arashi.ignoreScope", "tracked"],
        );
        let plan = IgnorePlan::build(&f.root, "repos", "new-trees", false).unwrap();
        match change {
            "local" => fs::write(f.root.join(".git/info/exclude"), "# concurrent local").unwrap(),
            "tracked" => fs::write(f.root.join(".gitignore"), "# concurrent tracked").unwrap(),
            _ => {
                git(
                    &f.root,
                    &["config", "--local", "arashi.ignoreScope", "none"],
                );
            }
        }
        let before = snapshot_files(&f.root);
        let mut tx = Transaction::default();
        assert!(plan.apply(&mut tx).is_err());
        assert!(tx.rollback().is_empty());
        assert_eq!(snapshot_files(&f.root), before);
    }
}

// POSIX file permissions inject an actual second-file publication failure.
// Native Windows permission behavior remains a parent CI acceptance gate.
#[cfg(unix)]
#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn managed_ignore_helper_failed_second_write_restores_first_without_caller_rollback() {
    use arashi::managed::{IgnorePlan, Transaction};
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::env::var("ARASHI_TS_PARITY").as_deref(), Ok("1"));
    let f = Fixture::new(None);
    let local = f.root.join(".git/info/exclude");
    let tracked = f.root.join(".gitignore");
    let bytes = "# caller prefix\n# BEGIN Arashi managed ignore rules\n/repos/\n/.arashi/worktrees/\n# END Arashi managed ignore rules\n# tail";
    fs::write(&local, bytes).unwrap();
    fs::write(&tracked, "# tracked caller").unwrap();
    git(
        &f.root,
        &["config", "--local", "arashi.ignoreScope", "tracked"],
    );
    fs::set_permissions(&tracked, fs::Permissions::from_mode(0o444)).unwrap();
    let source = source_ignore_helper(&f, "trees", false);
    assert!(source["error"].as_str().unwrap().contains("EACCES"));
    assert_eq!(fs::read_to_string(&local).unwrap(), bytes);
    let before = snapshot_files(&f.root);
    let plan = IgnorePlan::build(&f.root, "repos", "trees", false).unwrap();
    let mut tx = Transaction::default();
    let result = plan.apply(&mut tx);
    let after = snapshot_files(&f.root);
    fs::set_permissions(&tracked, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(result.is_err());
    // pull and clone use ? on apply: they do not roll back its temporary plan.
    assert_eq!(after, before);
    assert!(tx.rollback().is_empty());
}

#[test]
fn managed_ignore_helper_preserves_concurrent_rollback_bytes() {
    use arashi::managed::{IgnorePlan, Transaction};
    let f = Fixture::new(None);
    let local = f.root.join(".git/info/exclude");
    let tracked = f.root.join(".gitignore");
    let bytes = "# BEGIN Arashi managed ignore rules\n/repos/\n/.arashi/worktrees/\n# END Arashi managed ignore rules\n";
    fs::write(&local, bytes).unwrap();
    git(
        &f.root,
        &["config", "--local", "arashi.ignoreScope", "tracked"],
    );
    let plan = IgnorePlan::build(&f.root, "repos", "new-trees", false).unwrap();
    let mut tx = Transaction::default();
    plan.apply(&mut tx).unwrap();
    fs::write(&tracked, "# concurrent tracked bytes").unwrap();
    assert_eq!(tx.rollback().len(), 1);
    assert_eq!(fs::read_to_string(&local).unwrap(), bytes);
    assert_eq!(
        fs::read_to_string(&tracked).unwrap(),
        "# concurrent tracked bytes"
    );
}
