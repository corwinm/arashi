fn incoming_policy(source: bool, policy: &str) {
    let f = Fixture::new(None);
    let before = git(&f.child, &["rev-parse", "HEAD"]);
    let parent_before = git(&f.root, &["rev-parse", "HEAD"]);
    let incoming = if policy == "timeout" {
        r#"{"version":"1.0.0","reposDir":"repos","repos":{"child":{"path":"repos/child"}},"hooks":{"timeout":1}}"#
    } else if policy == "base" {
        r#"{"version":"1.0.0","reposDir":"repos","repos":{"child":{"path":"repos/child","baseBranch":"release"}}}"#
    } else {
        r#"{"version":"1.0.0","reposDir":"repos","worktreesDir":"new-worktrees","repos":{"child":{"path":"repos/child"}}}"#
    };
    let parent = incoming_config(
        &f,
        &[
            (".arashi/config.json", incoming),
            ("README.md", "incoming parent\n"),
        ],
    );
    if policy == "parent-failure" {
        fs::write(f.root.join("README.md"), "caller parent\n").unwrap();
    }
    let child = f.advance(&f.child_remote, "policy-child", "incoming.txt");
    if policy == "base" {
        git(
            &f.child_remote,
            &["update-ref", "refs/heads/release", &child],
        );
        git(&f.child_remote, &["update-ref", "refs/heads/main", &before]);
    }
    let output = f.run_impl(source, &["pull", "--json"]);
    eprintln!(
        "incoming policy={policy} source={source} exit={:?}\nstdout={}\nstderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let value = json(&output);
    let rows = value["data"]["results"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["repositoryId"], "workspace");
    assert_eq!(rows[1]["repositoryId"], "child");
    if policy == "parent-failure" {
        assert_eq!(output.status.code(), Some(1));
        assert!(matches!(
            rows[0]["status"].as_str(),
            Some("failed" | "manual-update")
        ));
        assert_eq!(git(&f.root, &["rev-parse", "HEAD"]), parent_before);
        assert_eq!(
            fs::read_to_string(f.root.join("README.md")).unwrap(),
            "caller parent\n"
        );
    } else {
        assert_eq!(git(&f.root, &["rev-parse", "HEAD"]), parent);
        assert_eq!(rows[0]["status"], "updated");
    }
    if policy == "timeout" {
        assert_eq!(output.status.code(), Some(1));
        assert_eq!(rows[1]["status"], "failed");
        assert!(
            rows[1]["errorMessage"]
                .as_str()
                .unwrap()
                .contains("Timed out after 1ms")
        );
        assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), before);
    } else {
        assert_eq!(rows[1]["status"], "updated");
        assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), child);
        if policy == "base" {
            assert_eq!(rows[1]["configuredBase"]["branch"], "release");
            assert_eq!(
                git(&f.child, &["rev-parse", "--abbrev-ref", "@{u}"]),
                "origin/main"
            );
        }
        if policy == "ignore" {
            assert!(output.status.success());
            assert_eq!(value["data"]["managedIgnore"]["changed"], true);
            assert_eq!(
                git(&f.root, &["check-ignore", "new-worktrees/probe"]),
                "new-worktrees/probe"
            );
            assert!(
                fs::read_to_string(f.root.join(".git/info/exclude"))
                    .unwrap()
                    .contains("/new-worktrees/")
            );
        }
    }
}

#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn source_incoming_policy_characterization() {
    assert_eq!(std::env::var("ARASHI_TS_PARITY").as_deref(), Ok("1"));
    for policy in ["base", "ignore", "parent-failure", "timeout"] {
        incoming_policy(true, policy);
    }
}

#[test]
fn pull_incoming_policies_apply_after_parent() {
    for policy in ["base", "ignore", "parent-failure", "timeout"] {
        incoming_policy(false, policy);
    }
}

#[test]
fn pull_incoming_gitlinks_fail_before_checkout() {
    let f = Fixture::new(None);
    let parent_before = git(&f.root, &["rev-parse", "HEAD"]);
    let work = f.base.join("incoming-parent");
    incoming_config(
        &f,
        &[(
            ".gitmodules",
            "[submodule \"sub\"]\n path = sub\n url = https://example.invalid/sub\n",
        )],
    );
    let oid = git(&f.child, &["rev-parse", "HEAD"]);
    git(
        &work,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{oid},sub"),
        ],
    );
    git(&work, &["commit", "-m", "incoming gitlink"]);
    git(&work, &["push", "origin", "HEAD:main"]);
    let child = f.advance(&f.child_remote, "safe-child", "safe.txt");
    let output = f.run(&["pull", "--json"]);
    assert_eq!(output.status.code(), Some(1));
    let value = json(&output);
    assert_eq!(value["data"]["results"][0]["status"], "failed");
    assert!(
        value["data"]["results"][0]["errorMessage"]
            .as_str()
            .unwrap()
            .contains("Incoming submodules")
    );
    assert_eq!(git(&f.root, &["rev-parse", "HEAD"]), parent_before);
    assert!(!f.root.join(".gitmodules").exists());
    assert!(!f.root.join("sub").exists());
    assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), child);
}
