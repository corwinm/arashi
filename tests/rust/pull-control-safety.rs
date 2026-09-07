#[test]
fn pull_reloaded_plain_directory_is_not_a_repository() {
    let f = Fixture::new(None);
    fs::create_dir(f.root.join("repos/pretend")).unwrap();
    let incoming = r#"{"version":"1.0.0","reposDir":"repos","repos":{"pretend":{"path":"repos/pretend"},"child":{"path":"repos/child"}}}"#;
    let parent = incoming_config(&f, &[(".arashi/config.json", incoming)]);
    let child = f.advance(&f.child_remote, "actual-child", "actual.txt");
    let output = f.run(&["pull", "--json"]);
    eprintln!("plain directory: {}", json(&output));
    assert_eq!(output.status.code(), Some(1));
    let value = json(&output);
    let rows = value["data"]["results"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["status"], "updated");
    assert_eq!(rows[1]["repositoryId"], "pretend");
    assert_eq!(rows[1]["status"], "failed");
    assert!(
        rows[1]["errorMessage"]
            .as_str()
            .unwrap()
            .contains("repository root")
    );
    assert_eq!(rows[2]["status"], "updated");
    assert_eq!(git(&f.root, &["rev-parse", "HEAD"]), parent);
    assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), child);
    assert!(snapshot_files(&f.root.join("repos/pretend")).is_empty());
}

fn stale_ignore_control(source: bool) {
    let f = Fixture::new(None);
    fs::write(f.root.join(".git/info/exclude"), "# caller prefix\n\n# BEGIN Arashi managed ignore rules\n/repos/\n/.arashi/worktrees/\n# END Arashi managed ignore rules\n").unwrap();
    let incoming = r#"{"version":"1.0.0","reposDir":"repos","worktreesDir":"new-worktrees","repos":{"child":{"path":"repos/child"}}}"#;
    let parent = incoming_config(&f, &[(".arashi/config.json", incoming)]);
    let child = f.advance(&f.child_remote, "stale-child", "stale.txt");
    let output = f.run_impl(source, &["pull", "--json"]);
    eprintln!("stale owned ignore source={source}: {}", json(&output));
    assert_eq!(git(&f.root, &["rev-parse", "HEAD"]), parent);
    assert!(output.status.success(), "{}", json(&output));
    assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), child);
    assert_eq!(
        fs::read_to_string(f.root.join(".git/info/exclude")).unwrap(),
        "# caller prefix\n\n# BEGIN Arashi managed ignore rules\n/repos/\n/new-worktrees/\n# END Arashi managed ignore rules\n"
    );
}

#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn source_incoming_owned_ignore_migration() {
    assert_eq!(std::env::var("ARASHI_TS_PARITY").as_deref(), Ok("1"));
    stale_ignore_control(true);
}

#[test]
fn pull_incoming_owned_ignore_migration() {
    stale_ignore_control(false);
}
