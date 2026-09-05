use arashi::paths::{canonicalize, native_path};
use std::path::PathBuf;

#[test]
fn canonical_paths_remain_usable_by_git() {
    let root = canonicalize(env!("CARGO_MANIFEST_DIR")).unwrap();
    assert_eq!(canonicalize(&root).unwrap(), root);
    assert!(arashi::git::run(&root, &["rev-parse", "--show-toplevel"]).is_ok());
}

#[cfg(windows)]
#[test]
fn configured_commands_accept_case_aliased_primary_paths() {
    use std::{fs, process::Command};
    let root = std::env::temp_dir().join(format!("arashi-case-alias-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let git = |args: &[&str]| {
        let output = Command::new("git")
            .args(args)
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
    };
    git(&["init", "-b", "main"]);
    git(&[
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
    ]);
    let alias = PathBuf::from(root.to_str().unwrap().to_uppercase());
    let cli = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_arashi"))
            .args(args)
            .current_dir(&alias)
            .output()
            .unwrap()
    };
    let init = cli(&["init", "--no-discover", "--json"]);
    assert!(init.status.success(), "{init:?}");
    for args in [
        vec!["status", "--json"],
        vec![
            "create",
            "feature",
            "--no-hooks",
            "--no-launch",
            "--no-switch",
            "--dry-run",
            "--json",
        ],
        vec![
            "create",
            "feature",
            "--no-hooks",
            "--no-launch",
            "--no-switch",
            "--json",
        ],
        vec!["remove", "feature", "--force", "--json"],
    ] {
        let output = cli(&args);
        assert!(output.status.success(), "{output:?}");
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn ordinary_paths_are_unchanged() {
    for path in ["relative/name", "/tmp/a", r"\\server\share\a", r"C:\a"] {
        assert_eq!(native_path(PathBuf::from(path)), PathBuf::from(path));
    }
}

#[cfg(windows)]
#[test]
fn windows_verbatim_paths_preserve_drive_unc_and_device_identity() {
    for (input, expected) in [
        (r"\\?\C:\a b\child", r"C:\a b\child"),
        (r"\\?\UNC\server\share\a b", r"\\server\share\a b"),
        (r"\\?\UNC\server\share\", r"\\server\share\"),
        (r"\\?\Volume{abc}\a", r"\\?\Volume{abc}\a"),
        (r"\\.\pipe\name", r"\\.\pipe\name"),
    ] {
        assert_eq!(native_path(PathBuf::from(input)).as_os_str(), expected);
    }
}

#[cfg(not(windows))]
#[test]
fn windows_looking_names_are_literal_on_unix() {
    let path = PathBuf::from(r"\\?\UNC\server\share\name");
    assert_eq!(native_path(path.clone()), path);
}
