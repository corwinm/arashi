// Retained commands/pull.ts reconciles only after the parent update/reload.
// lib/managed-ignore.ts: stored preferences migrate owned blocks; no preference
// prunes only the local block, and none preserves both files (including stale rules).
fn incoming_scope_control(source: bool, scope: Option<&str>) {
    let f = Fixture::new(None);
    let local_before = "# local caller\r\n/caller-local/\r\n\n# BEGIN Arashi managed ignore rules\n/repos/\n/.arashi/worktrees/\n# END Arashi managed ignore rules\r\n# local tail";
    let tracked_before = "# tracked caller\r\n/caller-tracked/\r\n\n# BEGIN Arashi managed ignore rules\n/repos/\n/old-tracked/\n# END Arashi managed ignore rules\r\n# tracked tail";
    fs::write(f.root.join(".git/info/exclude"), local_before).unwrap();
    if let Some(scope) = scope {
        git(&f.root, &["config", "--local", "arashi.ignoreScope", scope]);
    }
    let config_before = fs::read(f.root.join(".git/config")).unwrap();
    let home_before = snapshot_files(&f.home);
    let incoming = r#"{"version":"1.0.0","reposDir":"repos","worktreesDir":"new-worktrees","repos":{"child":{"path":"repos/child"}}}"#;
    let parent = incoming_config(
        &f,
        &[
            (".arashi/config.json", incoming),
            (".gitignore", tracked_before),
        ],
    );
    let child = f.advance(&f.child_remote, "scope-child", "scope.txt");
    let output = f.run_impl(source, &["pull", "--json"]);
    eprintln!("scope={scope:?} source={source}: {}", json(&output));
    assert!(output.status.success(), "{}", json(&output));
    assert_eq!(git(&f.root, &["rev-parse", "HEAD"]), parent);
    assert_eq!(git(&f.child, &["rev-parse", "HEAD"]), child);
    let local_after = fs::read_to_string(f.root.join(".git/info/exclude")).unwrap();
    let tracked_after = fs::read_to_string(f.root.join(".gitignore")).unwrap();
    let block = |rules: &str| {
        format!("# BEGIN Arashi managed ignore rules\n{rules}# END Arashi managed ignore rules")
    };
    let old_local = block("/repos/\n/.arashi/worktrees/\n");
    let old_tracked = block("/repos/\n/old-tracked/\n");
    match scope {
        Some("none") => {
            assert_eq!(local_after, local_before);
            assert_eq!(tracked_after, tracked_before);
        }
        Some("tracked") => {
            assert_eq!(local_after, local_before.replace(&old_local, ""));
            assert_eq!(
                tracked_after,
                tracked_before.replace(&old_tracked, &block("/repos/\n/new-worktrees/\n"))
            );
        }
        Some("local") => {
            assert_eq!(
                local_after,
                local_before.replace(&old_local, &block("/repos/\n/new-worktrees/\n"))
            );
            assert_eq!(tracked_after, tracked_before.replace(&old_tracked, ""));
        }
        None | Some("") => {
            assert_eq!(
                local_after,
                local_before.replace(&old_local, &block("/repos/\n/new-worktrees/\n"))
            );
            assert_eq!(tracked_after, tracked_before);
        }
        _ => unreachable!(),
    }
    assert_eq!(fs::read(f.root.join(".git/config")).unwrap(), config_before);
    assert_eq!(snapshot_files(&f.home), home_before);
    assert_eq!(
        fs::read_to_string(f.root.join(".arashi/config.json")).unwrap(),
        incoming
    );
}

#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn source_incoming_ignore_scopes() {
    assert_eq!(std::env::var("ARASHI_TS_PARITY").as_deref(), Ok("1"));
    for scope in [None, Some("local"), Some("tracked"), Some("none"), Some("")] {
        incoming_scope_control(true, scope);
    }
}

fn invalid_scope_control(source: bool) {
    let f = Fixture::new(None);
    git(
        &f.root,
        &["config", "--local", "arashi.ignoreScope", "invalid"],
    );
    let incoming = r#"{"version":"1.0.0","reposDir":"repos","worktreesDir":"changed","repos":{"child":{"path":"repos/child"}}}"#;
    let parent = incoming_config(&f, &[(".arashi/config.json", incoming)]);
    f.advance(&f.child_remote, "invalid-scope-child", "scope.txt");
    let child = snapshot_files(&f.child);
    let local = fs::read(f.root.join(".git/info/exclude")).unwrap();
    let config = fs::read(f.root.join(".git/config")).unwrap();
    let home = snapshot_files(&f.home);
    let output = f.run_impl(source, &["pull", "--json"]);
    eprintln!("invalid scope source={source}: {}", json(&output));
    assert_eq!(output.status.code(), Some(1));
    let value = json(&output);
    assert_eq!(value["data"]["results"][0]["status"], "updated");
    assert_eq!(
        value["data"]["results"][1]["repositoryId"],
        "managed-ignore"
    );
    assert!(
        value["data"]["results"][1]["errorMessage"]
            .as_str()
            .unwrap()
            .contains("Invalid clone-local arashi.ignoreScope")
    );
    assert_eq!(git(&f.root, &["rev-parse", "HEAD"]), parent);
    assert_eq!(snapshot_files(&f.child), child);
    assert_eq!(snapshot_files(&f.home), home);
    assert_eq!(fs::read(f.root.join(".git/info/exclude")).unwrap(), local);
    assert_eq!(fs::read(f.root.join(".git/config")).unwrap(), config);
}

#[test]
#[ignore = "requires Node and TypeScript dependencies"]
fn source_incoming_invalid_ignore_scope() {
    assert_eq!(std::env::var("ARASHI_TS_PARITY").as_deref(), Ok("1"));
    invalid_scope_control(true);
}

#[test]
fn pull_incoming_invalid_ignore_scope() {
    invalid_scope_control(false);
}

#[test]
fn pull_incoming_ignore_scopes() {
    for scope in [None, Some("local"), Some("tracked"), Some("none"), Some("")] {
        incoming_scope_control(false, scope);
    }
}
