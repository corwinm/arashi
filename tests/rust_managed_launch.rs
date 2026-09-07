#[path = "rust/managed-launch-kitty.rs"]
mod kitty;
#[path = "../src/rust/launch.rs"]
pub mod launch;
#[path = "rust/managed-launch-lock.rs"]
mod locks;
#[path = "../src/rust/managed_launch.rs"]
pub mod managed_launch;
#[path = "rust/managed-launch-native.rs"]
mod native;
use launch::*;
use serde_json::json;
use std::{collections::VecDeque, path::Path};
fn target(path: &Path) -> LaunchTarget {
    LaunchTarget {
        worktree_path: path.into(),
        repository: "repo".into(),
        branch: "feature".into(),
        herdr_source: Some(path.join("source checkout")),
    }
}
fn context(path: &Path) -> LaunchContext {
    LaunchContext {
        platform: Platform::native(),
        cwd: path.into(),
        home: None,
        env: [
            ("TMUX".into(), "fixture".into()),
            ("ARASHI_DIRECTIVE_FILE".into(), "private".into()),
            ("ARASHI_SHELL".into(), "zsh".into()),
        ]
        .into(),
    }
}
fn check(
    family: ManagedFamily,
    disposition: LaunchDisposition,
    env: &[(&str, &str)],
    transcript: Vec<(Vec<String>, i32, String)>,
    success: bool,
) {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    #[cfg(windows)]
    let cwd = {
        let value = cwd.to_str().unwrap();
        if let Some(p) = value.strip_prefix(r"\\?\UNC\") {
            std::path::PathBuf::from(format!(r"\\{p}"))
        } else {
            std::path::PathBuf::from(value.strip_prefix(r"\\?\").unwrap_or(value))
        }
    };
    let target = target(&cwd);
    let mut ctx = context(&cwd);
    for (k, v) in env {
        ctx.env.insert((*k).into(), (*v).into());
    }
    use sha2::{Digest, Sha256};
    let identity = format!(
        "arashi-v1-{:x}",
        Sha256::digest(cwd.to_str().unwrap().as_bytes())
    );
    let subst = |s: String| {
        s.replace(
            "$SOURCE",
            target.herdr_source.as_ref().unwrap().to_str().unwrap(),
        )
        .replace("$CWD", cwd.to_str().unwrap())
        .replace("$ID", &identity)
    };
    let mut calls: VecDeque<_> = transcript
        .into_iter()
        .map(|(args, code, out)| {
            (
                args.into_iter().map(&subst).collect::<Vec<_>>(),
                code,
                if out.starts_with('{') || out.starts_with('[') {
                    let escaped = serde_json::to_string(cwd.to_str().unwrap()).unwrap();
                    out.replace("$CWD", &escaped[1..escaped.len() - 1])
                        .replace("$ID", &identity)
                } else {
                    subst(out)
                },
            )
        })
        .collect();
    let result = managed_launch::execute_with(
        &ManagedPlan {
            family,
            disposition,
        },
        &target,
        &ctx,
        Some(&cwd.join("locks")),
        &mut |args, path, env| {
            let (expected, code, out) = calls.pop_front().expect("unexpected command");
            assert_eq!(args, expected);
            assert_eq!(path, cwd);
            assert!(!env.contains_key("ARASHI_DIRECTIVE_FILE"));
            assert!(!env.contains_key("ARASHI_SHELL"));
            launch::process::ProcessResult {
                exit_code: code,
                stdout: out,
                stderr: String::new(),
            }
        },
    );
    assert_eq!(result.is_ok(), success, "{result:?}");
    assert!(calls.is_empty(), "unconsumed transcript {calls:?}");
    if let Ok(result) = result {
        assert_eq!(result.disposition, disposition);
    }
}
fn step(args: &[&str], code: i32, output: &str) -> (Vec<String>, i32, String) {
    (
        args.iter().map(|s| (*s).into()).collect(),
        code,
        output.into(),
    )
}
#[test]
fn tmux_both_dispositions_and_denial() {
    for d in [LaunchDisposition::Window, LaunchDisposition::Tab] {
        for code in [0, 1] {
            check(
                ManagedFamily::Tmux,
                d,
                &[],
                vec![step(&["tmux", "new-window", "-c", "$CWD"], code, "")],
                code == 0,
            );
        }
    }
    check(
        ManagedFamily::Tmux,
        LaunchDisposition::Window,
        &[("TMUX", " ")],
        vec![],
        false,
    );
}
#[test]
fn sesh_delegates_connect_in_new_tmux_window() {
    for d in [LaunchDisposition::Window, LaunchDisposition::Tab] {
        check(
            ManagedFamily::Sesh,
            d,
            &[],
            vec![
                step(
                    &[if cfg!(windows) { "where" } else { "which" }, "sesh"],
                    0,
                    "/fixture/sesh",
                ),
                step(
                    &["tmux", "new-window", "-c", "$CWD", "sesh connect '$CWD'"],
                    0,
                    "",
                ),
            ],
            true,
        );
    }
    check(
        ManagedFamily::Sesh,
        LaunchDisposition::Tab,
        &[("TMUX", "")],
        vec![],
        false,
    );
    check(
        ManagedFamily::Sesh,
        LaunchDisposition::Tab,
        &[],
        vec![step(
            &[if cfg!(windows) { "where" } else { "which" }, "sesh"],
            1,
            "",
        )],
        false,
    );
}
#[test]
fn herdr_ordered_argv_validated_identity_and_target() {
    let window = [
        "herdr",
        "worktree",
        "open",
        "--cwd",
        "$SOURCE",
        "--path",
        "$CWD",
        "--label",
        "repo: feature",
        "--focus",
        "--json",
    ];
    for already in [false, true] {
        check(ManagedFamily::Herdr,LaunchDisposition::Window,&[],vec![step(&window,0,&json!({"result":{"type":"worktree_opened","already_open":already,"workspace":{"workspace_id":"w"}}}).to_string())],true);
    }
    for out in [
        "{}",
        "not-json",
        r#"{"result":{"type":"worktree_opened","already_open":true,"workspace":{"workspace_id":" "}}}"#,
    ] {
        check(
            ManagedFamily::Herdr,
            LaunchDisposition::Window,
            &[],
            vec![step(&window, 0, out)],
            false,
        );
    }
    let tab = [
        "herdr",
        "tab",
        "create",
        "--workspace",
        "caller",
        "--cwd",
        "$CWD",
        "--label",
        "repo: feature",
        "--focus",
        "--json",
    ];
    for (out, ok) in [
        (
            r#"{"result":{"tab":{"tab_id":"t","root_pane_id":"p"}}}"#,
            true,
        ),
        (r#"{"result":{"tab":{"tab_id":"t"}}}"#, false),
    ] {
        check(
            ManagedFamily::Herdr,
            LaunchDisposition::Tab,
            &[("HERDR_WORKSPACE_ID", " caller ")],
            vec![step(&tab, 0, out)],
            ok,
        );
    }
    check(
        ManagedFamily::Herdr,
        LaunchDisposition::Tab,
        &[],
        vec![],
        false,
    );
}
#[test]
fn cmux_creates_workspace_even_for_tab_and_never_falls_back() {
    for d in [LaunchDisposition::Window, LaunchDisposition::Tab] {
        for (out, ok) in [
            (r#"{"workspace_ref":"workspace:4"}"#, true),
            (r#"{"workspace_id":"w"}"#, true),
            (r#"{"workspace_id":" "}"#, false),
            ("[]", false),
            ("malformed", false),
        ] {
            check(
                ManagedFamily::Cmux,
                d,
                &[],
                vec![step(
                    &[
                        "cmux",
                        "workspace",
                        "create",
                        "--cwd",
                        "$CWD",
                        "--focus",
                        "true",
                        "--json",
                    ],
                    0,
                    out,
                )],
                ok,
            );
        }
    }
}
