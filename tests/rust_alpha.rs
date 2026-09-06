//! Alpha identity must compose with the integrated parser before dispatch.
use std::process::Command;

#[test]
fn alpha_parser_cannot_bypass_distribution_boundary() {
    let home = tempfile::tempdir().unwrap();
    for binary in [env!("CARGO_BIN_EXE_aw2"), env!("CARGO_BIN_EXE_arashi2")] {
        for args in [
            vec!["--", "shell", "init", "bash"],
            vec!["--", "completion", "bash"],
            vec!["--", "completion", "__query", "0", "aw"],
            vec!["--", "update"],
            vec!["--", "uninstall"],
        ] {
            let output = Command::new(binary)
                .args(&args)
                .env("HOME", home.path())
                .env("USERPROFILE", home.path())
                .current_dir(home.path())
                .output()
                .unwrap();
            assert!(!output.status.success(), "{args:?}: {output:?}");
            assert!(
                String::from_utf8_lossy(&output.stderr)
                    .contains("Use the separate alpha setup bundle"),
                "{args:?}: {output:?}"
            );
            assert!(
                output.stdout.is_empty(),
                "must not emit stable integration: {output:?}"
            );
        }
    }
    assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 0);
}

#[test]
fn alpha_parser_outputs_keep_alpha_identity() {
    for binary in [env!("CARGO_BIN_EXE_aw2"), env!("CARGO_BIN_EXE_arashi2")] {
        for args in [
            vec!["--help"],
            vec!["help", "create"],
            vec!["--help", "--version"],
        ] {
            let output = Command::new(binary).args(&args).output().unwrap();
            assert!(output.status.success(), "{args:?}: {output:?}");
            let text = String::from_utf8(output.stdout).unwrap();
            assert!(text.contains("arashi2"), "{args:?}: {text}");
            assert!(!text.contains("Usage: arashi "), "{text}");
        }
    }
}
