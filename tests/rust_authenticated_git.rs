//! Test-only Node servers; the native CLI always executes native Git itself.
use std::process::Command;

fn driver(args: &[&str]) {
    let output = Command::new("node")
        .args(args)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("authenticated Git fixtures require Node, openssl, ssh-keygen and Git");
    assert!(
        output.status.success(),
        "authenticated fixture: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn real_git_authenticated_tls_ssh_clone_fetch_push_and_denials() {
    driver(&["--test", "tests/rust/authenticated-git.test.mjs"]);
}

// Windows application mutation awaits the independent native identity foundation.
#[cfg(unix)]
#[test]
fn native_authenticated_add_clone_pull_push() {
    driver(&[
        "tests/rust/authenticated-git-acceptance.mjs",
        "native",
        env!("CARGO_BIN_EXE_arashi"),
    ]);
}

#[test]
#[ignore = "retained source oracle requires installed TypeScript dev dependencies"]
fn retained_source_authenticated_add_clone_pull_push() {
    if std::env::var("ARASHI_TS_PARITY").as_deref() != Ok("1") {
        return;
    }
    driver(&["tests/rust/authenticated-git-acceptance.mjs", "source"]);
}
