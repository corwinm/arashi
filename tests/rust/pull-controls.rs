// Incoming control files are exercised against independent real origins.
fn incoming_config(f: &Fixture, files: &[(&str, &str)]) -> String {
    let work = f.base.join("incoming-parent");
    git(
        &f.base,
        &[
            "clone",
            f.main_remote.to_str().unwrap(),
            work.to_str().unwrap(),
        ],
    );
    configure(&work);
    for (path, bytes) in files {
        fs::write(work.join(path), bytes).unwrap();
        git(&work, &["add", path]);
    }
    git(&work, &["commit", "-m", "incoming controls"]);
    git(&work, &["push", "origin", "HEAD:main"]);
    git(&work, &["rev-parse", "HEAD"])
}

fn control_reselection(source: bool, network: bool, policy: &str) {
    let f = Fixture::new(None);
    let guard = if network {
        let (guard, url) = daemon(&f);
        git(
            &f.root,
            &[
                "remote",
                "set-url",
                "origin",
                &url.replace("child.git", "main.git"),
            ],
        );
        git(&f.child, &["remote", "set-url", "origin", &url]);
        Some(guard)
    } else {
        None
    };
    let before_parent = git(&f.root, &["rev-parse", "HEAD"]);
    let before_child = git(&f.child, &["rev-parse", "HEAD"]);
    for name in ["zeta", "alpha"] {
        let path = f.root.join("repos").join(name);
        git(
            &f.base,
            &[
                "clone",
                f.child_remote.to_str().unwrap(),
                path.to_str().unwrap(),
            ],
        );
        configure(&path);
        if network {
            let url = git(&f.child, &["remote", "get-url", "origin"]);
            git(&path, &["remote", "set-url", "origin", &url]);
        }
    }
    let new_config = r#"{"version":"1.0.0","reposDir":"repos","worktreesDir":".arashi/worktrees","hooks":{"timeout":15000},"repos":{"zeta":{"path":"repos/zeta","baseBranch":"main"},"missing":{"path":"repos/missing"},"alpha":{"path":"repos/alpha"}}}"#;
    let incoming = if policy == "malformed" {
        "{"
    } else {
        new_config
    };
    let parent = incoming_config(
        &f,
        &[
            (".arashi/config.json", incoming),
            (".gitignore", "# caller tracked rule\n*.cache\n"),
            (".gitmodules", "# no gitlinks\n"),
        ],
    );
    let child = f.advance(&f.child_remote, "incoming-child", "incoming.txt");
    let child_snapshot = snapshot_files(&f.child);
    let home_snapshot = snapshot_files(&f.home);
    let parent_config = fs::read(f.root.join(".arashi/config.json")).unwrap();
    let args: Vec<&str> = match policy {
        "only-removed" => vec!["pull", "--only", "child,workspace,workspace", "--json"],
        "only-parent" => vec!["pull", "--only", "workspace", "--json"],
        "group" => vec!["pull", "--group", "CHILDREN", "--json"],
        "only-child" => vec!["pull", "--only", "child", "--json"],
        _ => vec!["pull", "--json"],
    };
    let output = f.run_impl(source, &args);
    eprintln!(
        "controls source={source} network={network} policy={policy} exit={:?}\nstdout={}\nstderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let value = json(&output);
    let rows = value["data"]["results"]
        .as_array()
        .expect("pull result envelope");
    let names: Vec<_> = rows
        .iter()
        .map(|r| r["repositoryId"].as_str().unwrap())
        .collect();
    if matches!(policy, "group" | "only-child") {
        assert!(output.status.success());
        assert_eq!(names, ["child"]);
        assert_eq!(git(&f.root, &["rev-parse", "HEAD"]), before_parent);
        assert_eq!(
            fs::read(f.root.join(".arashi/config.json")).unwrap(),
            parent_config
        );
        assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), child);
    } else {
        assert_eq!(git(&f.root, &["rev-parse", "HEAD"]), parent);
        assert_eq!(
            fs::read_to_string(f.root.join(".arashi/config.json")).unwrap(),
            incoming
        );
        assert_eq!(
            fs::read_to_string(f.root.join(".gitmodules")).unwrap(),
            "# no gitlinks\n"
        );
        assert_eq!(
            snapshot_files(&f.child),
            child_snapshot,
            "removed/unselected child must not be pre-fetched"
        );
        assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), before_child);
        assert_eq!(rows[0]["status"], "updated");
        if matches!(policy, "malformed" | "only-removed") {
            assert_eq!(output.status.code(), Some(1));
            assert_eq!(names, ["workspace", "workspace-config"]);
            assert_eq!(rows[1]["status"], "failed");
            assert!(
                rows[1]["errorMessage"]
                    .as_str()
                    .unwrap()
                    .starts_with("Failed to reload pulled workspace configuration:")
            );
            assert_eq!(value["data"]["overallStatus"], "partial-failure");
        } else if policy == "only-parent" {
            assert!(output.status.success());
            assert_eq!(names, ["workspace"]);
        } else {
            assert!(output.status.success());
            assert_eq!(names, ["workspace", "zeta", "missing", "alpha"]);
            assert_eq!(rows[1]["status"], "updated");
            assert_eq!(rows[1]["configuredBase"]["source"], "repository-config");
            assert_eq!(rows[2]["status"], "skipped");
            assert_eq!(rows[3]["status"], "updated");
            for name in ["zeta", "alpha"] {
                assert_eq!(
                    git(&f.root.join("repos").join(name), &["rev-parse", "HEAD"]),
                    child
                );
            }
        }
    }
    assert_eq!(snapshot_files(&f.home), home_snapshot);
    assert_eq!(git(&f.main_remote, &["rev-parse", "main"]), parent);
    assert_eq!(git(&f.child_remote, &["rev-parse", "main"]), child);
    drop(guard);
}

#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn source_incoming_controls_characterization() {
    assert_eq!(std::env::var("ARASHI_TS_PARITY").as_deref(), Ok("1"));
    for network in [false, true] {
        for policy in [
            "all",
            "only-removed",
            "only-parent",
            "group",
            "only-child",
            "malformed",
        ] {
            control_reselection(true, network, policy);
        }
    }
}

#[test]
fn pull_incoming_controls_reload_and_reselect() {
    for network in [false, true] {
        for policy in [
            "all",
            "only-removed",
            "only-parent",
            "group",
            "only-child",
            "malformed",
        ] {
            control_reselection(false, network, policy);
        }
    }
}
