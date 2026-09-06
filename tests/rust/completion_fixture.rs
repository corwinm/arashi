use std::{fs, path::Path, process::Command};

// Register lightweight worktrees using Git's on-disk format. No checkout per
// record is needed: completion only consumes `git worktree list --porcelain -z`.
// Unlike a freshly written PATH shim, this exercises the installed Git producer.
pub fn large_worktree_fixture(root: &Path) {
    let git = |args: &[&str]| {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        output.stdout
    };
    git(&["init", "--initial-branch=main"]);
    fs::create_dir(root.join(".arashi")).unwrap();
    fs::write(
        root.join(".arashi/config.json"),
        r#"{"repos":{},"version":"1.0.0"}"#,
    )
    .unwrap();
    for index in 0..800 {
        let worktree = root.join(format!("completion-{index}"));
        let admin = root.join(format!(".git/worktrees/completion-{index}"));
        fs::create_dir(&worktree).unwrap();
        fs::create_dir_all(&admin).unwrap();
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", admin.display()),
        )
        .unwrap();
        fs::write(
            admin.join("gitdir"),
            format!("{}\n", worktree.join(".git").display()),
        )
        .unwrap();
        fs::write(admin.join("commondir"), "../..\n").unwrap();
        fs::write(
            admin.join("HEAD"),
            format!("ref: refs/heads/topic-{index}\n"),
        )
        .unwrap();
    }
}
