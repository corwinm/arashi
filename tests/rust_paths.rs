use arashi::paths::{canonicalize, native_path};
use std::path::PathBuf;

#[test]
fn canonical_paths_remain_usable_by_git() {
    let root = canonicalize(env!("CARGO_MANIFEST_DIR")).unwrap();
    assert_eq!(canonicalize(&root).unwrap(), root);
    assert!(arashi::git::run(&root, &["rev-parse", "--show-toplevel"]).is_ok());
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
