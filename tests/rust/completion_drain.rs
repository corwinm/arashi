use super::*;

#[path = "completion_fixture.rs"]
mod fixture;

#[test]
fn drains_every_git_byte_independently_of_the_production_query_budget() {
    struct Directory(PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let directory = Directory(
        std::env::temp_dir().join(format!("arashi-completion-drain-{}", std::process::id())),
    );
    fs::create_dir(&directory.0).unwrap();
    fixture::large_worktree_fixture(&directory.0);
    // Force producer latency beyond QUERY_BUDGET. This tests draining with
    // an explicit test deadline, not the production query's time contract.
    let args = [
        "-c",
        "alias.completion-drain=!sleep 0.3; git worktree list --porcelain -z",
        "completion-drain",
    ];
    let output = bounded_git(&directory.0, &args, Instant::now() + Duration::from_secs(5))
        .expect("large output must drain before the explicit test deadline");
    let expected = Command::new("git")
        .arg("-C")
        .arg(&directory.0)
        .args(["worktree", "list", "--porcelain", "-z"])
        .output()
        .unwrap();
    assert!(expected.status.success(), "{expected:?}");
    assert!(
        expected.stdout.len() > 65_536,
        "fixture must exceed pipe capacity"
    );
    assert_eq!(
        output, expected.stdout,
        "every byte including the final record must drain"
    );
    assert!(
        output
            .windows(b"branch refs/heads/topic-799\0".len())
            .any(|field| field == b"branch refs/heads/topic-799\0")
    );
}
