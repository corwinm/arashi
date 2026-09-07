//! Canonical alpha identity composes with native shell and completion.
use std::process::Command;

#[test]
fn canonical_binaries_report_controlled_alpha_identity() {
    for binary in [env!("CARGO_BIN_EXE_aw"), env!("CARGO_BIN_EXE_arashi")] {
        let output = Command::new(binary).arg("--version").output().unwrap();
        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            "arashi 2.0.0-alpha.1 (controlled native alpha)\n"
        );
        assert!(output.stderr.is_empty());
    }
}

#[test]
fn canonical_alpha_emits_canonical_shell_and_completion() {
    let home = tempfile::tempdir().unwrap();
    for args in [
        ["shell", "init", "bash"].as_slice(),
        ["completion", "bash"].as_slice(),
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_arashi"))
            .args(args)
            .env("HOME", home.path())
            .env("USERPROFILE", home.path())
            .current_dir(home.path())
            .output()
            .unwrap();
        assert!(output.status.success(), "{args:?}: {output:?}");
        assert!(output.stderr.is_empty(), "{args:?}: {output:?}");
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(text.contains("command arashi"), "{args:?}: {text}");
        assert!(!text.contains("arashi2"), "{args:?}: {text}");
        assert!(!text.contains("aw2"), "{args:?}: {text}");
    }
    assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 0);
}

#[test]
fn canonical_alpha_blocks_stable_update_and_uninstall_dispatch() {
    let home = tempfile::tempdir().unwrap();
    for args in [
        ["--", "update", "--dry-run"].as_slice(),
        ["--", "uninstall", "--dry-run"].as_slice(),
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_aw"))
            .args(args)
            .env("HOME", home.path())
            .env("USERPROFILE", home.path())
            .current_dir(home.path())
            .output()
            .unwrap();
        assert!(!output.status.success(), "{args:?}: {output:?}");
        assert!(output.stdout.is_empty(), "{args:?}: {output:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("controlled alpha setup bundle"),
            "{args:?}: {output:?}"
        );
    }
    assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 0);
}
