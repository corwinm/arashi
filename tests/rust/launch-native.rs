use super::*;

#[test]
fn fallback_failure_reports_only_generic_source_attempts() {
    let d = tempfile::tempdir().unwrap();
    for name in [
        "wezterm",
        "x-terminal-emulator",
        "gnome-terminal",
        "konsole",
    ] {
        install_fixture(d.path(), name);
    }
    let mut c = fixture_context(d.path());
    c.platform = Platform::Linux;
    c.env.insert("ARASHI_LAUNCH_EXIT".into(), "19".into());
    let p = PlatformPlan {
        family: PlatformFamily::WezTerm,
        disposition: LaunchDisposition::Window,
        ide_command: None,
        mac_target: None,
    };
    let path = d.path().to_str().unwrap();
    let error = platform::execute_platform(&target(d.path()), &p, &c).unwrap_err();
    assert_eq!(
        error.message,
        format!(
            "Failed to open a terminal at {path}. Attempted commands: x-terminal-emulator --working-directory {path}: unknown failure | gnome-terminal --working-directory {path}: unknown failure | konsole --workdir {path}: unknown failure"
        )
    );
}

#[test]
fn real_ide_success_preserves_special_path_and_child_environment() {
    let d = tempfile::tempdir().unwrap();
    install_fixture(d.path(), "kiro");
    let path = d.path().join(if cfg!(windows) {
        "space %PATH%!^&() 雪"
    } else {
        "space ' \" $() ; %PATH%!^&|() 雪\\"
    });
    std::fs::create_dir(&path).unwrap();
    let mut c = fixture_context(d.path());
    c.env.insert(
        "ARASHI_DIRECTIVE_FILE".into(),
        d.path().join("directive").to_str().unwrap().into(),
    );
    c.env.insert("ARASHI_SHELL".into(), "bash".into());
    c.env.insert(
        "ARASHI_LAUNCH_ENV_RECORD".into(),
        d.path().join("environment").to_str().unwrap().into(),
    );
    let LaunchPlan::Platform(plan) = resolve::preflight(
        &LaunchIntent {
            selector: LaunchSelector::Ide(Ide::Kiro),
            disposition: LaunchDisposition::Window,
        },
        &c,
    )
    .unwrap() else {
        panic!()
    };
    let result = platform::execute_platform(&target(&path), &plan, &c).unwrap();
    assert_eq!(result.mode, "kiro");
    assert_eq!(
        records(d.path()),
        vec![vec![
            "--new-window".to_string(),
            path.to_str().unwrap().into()
        ]]
    );
    let env = std::fs::read_to_string(d.path().join("environment")).unwrap();
    assert!(env.starts_with("\n\n"));
    assert!(!d.path().join("directive").exists());
}
#[cfg(unix)]
#[test]
fn explicit_bundle_fallback_is_not_automatic_and_kiro_has_none() {
    let d = tempfile::tempdir().unwrap();
    let mut c = fixture_context(d.path());
    c.platform = Platform::MacOs;
    c.home = Some(d.path().into());
    let bundle = d
        .path()
        .join("Applications/Visual Studio Code.app/Contents/Resources/app/bin/code");
    std::fs::create_dir_all(bundle.parent().unwrap()).unwrap();
    std::fs::write(&bundle, "bundle").unwrap();
    // Use a real isolated `which` returning unavailable; never inspect installed editor launchers.
    let which = d.path().join("which");
    std::fs::write(&which, "#!/bin/sh\nexit 1\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(which, std::fs::Permissions::from_mode(0o755)).unwrap();
    // System bundle may legitimately precede HOME according to source.
    let explicit = resolve::resolve_ide(Ide::VsCode, &c, true).unwrap();
    assert!(
        explicit == bundle.to_str().unwrap()
            || explicit == "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
    );
    assert_eq!(resolve::resolve_ide(Ide::VsCode, &c, false), None);
    assert_eq!(resolve::resolve_ide(Ide::Kiro, &c, true), None);
}
#[test]
fn mac_preflight_uses_real_probe_and_stale_tab_error_never_falls_back() {
    let d = tempfile::tempdir().unwrap();
    install_fixture(d.path(), "osascript");
    install_fixture(d.path(), "open");
    let mut c = fixture_context(d.path());
    c.platform = Platform::MacOs;
    c.env.insert("TERM_PROGRAM".into(), "iTerm2".into());
    c.env
        .insert("ARASHI_LAUNCH_STDOUT".into(), "3.5.0\n42\nDefault".into());
    let LaunchPlan::Platform(p) = resolve::preflight(
        &LaunchIntent {
            selector: LaunchSelector::Auto,
            disposition: LaunchDisposition::Tab,
        },
        &c,
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(p.mac_target.as_ref().unwrap().target, "42");
    c.env.insert("ARASHI_LAUNCH_EXIT".into(), "42".into());
    let e = platform::execute_platform(&target(d.path()), &p, &c).unwrap_err();
    assert_eq!(e.code, LaunchErrorCode::TabDispositionUnsupported);
    assert_eq!(records(d.path()).len(), 2);
}

fn native_fixture() -> &'static std::path::Path {
    static FIXTURE: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
    let dir = FIXTURE.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let status = std::process::Command::new("rustc")
            .args(["--edition=2024", "tests/rust/launch-fixture.rs", "-o"])
            .arg(dir.path().join(if cfg!(windows) {
                "fixture.exe"
            } else {
                "fixture"
            }))
            .status()
            .unwrap();
        assert!(status.success());
        dir
    });
    dir.path()
}
fn install_fixture(dir: &std::path::Path, name: &str) -> String {
    let name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    };
    let path = dir.join(name);
    std::fs::copy(
        native_fixture().join(if cfg!(windows) {
            "fixture.exe"
        } else {
            "fixture"
        }),
        &path,
    )
    .unwrap();
    path.to_str().unwrap().into()
}
fn fixture_context(dir: &std::path::Path) -> LaunchContext {
    let mut c = ctx();
    c.cwd = dir.into();
    c.env.insert(
        "PATH".into(),
        if cfg!(windows) {
            format!(
                "{};{}",
                dir.display(),
                std::env::var("PATH").unwrap_or_default()
            )
        } else {
            format!("{}:/usr/bin:/bin", dir.display())
        },
    );
    if cfg!(windows) {
        for key in [
            "SYSTEMROOT",
            "SystemRoot",
            "COMSPEC",
            "PATHEXT",
            "TEMP",
            "TMP",
        ] {
            if let Ok(v) = std::env::var(key) {
                c.env.insert(key.into(), v);
            }
        }
    }
    c.env.insert(
        "ARASHI_LAUNCH_RECORD".into(),
        dir.join("argv").to_str().unwrap().into(),
    );
    c
}
fn target(dir: &std::path::Path) -> LaunchTarget {
    LaunchTarget {
        worktree_path: dir.into(),
        repository: "repo".into(),
        branch: "topic".into(),
        herdr_source: None,
    }
}
fn records(dir: &std::path::Path) -> Vec<Vec<String>> {
    std::fs::read(dir.join("argv"))
        .unwrap()
        .split(|b| *b == 255)
        .filter(|v| !v.is_empty())
        .map(|v| {
            v.split(|b| *b == 0)
                .take(v.iter().filter(|b| **b == 0).count())
                .map(|v| String::from_utf8(v.into()).unwrap())
                .collect()
        })
        .collect()
}
#[test]
fn captured_spawn_failure_contract() {
    let d = tempfile::tempdir().unwrap();
    let c = fixture_context(d.path());
    let missing = d.path().join("absent");
    let r = process::run(&[missing.to_str().unwrap().into()], d.path(), &c.env, false);
    assert_eq!(
        (r.exit_code, r.stdout.as_str(), r.stderr.as_str()),
        (1, "", "")
    );
}
#[test]
fn missing_cwd_contract() {
    let d = tempfile::tempdir().unwrap();
    let c = fixture_context(d.path());
    let missing = d.path().join("absent");
    let command = vec![std::env::current_exe().unwrap().to_str().unwrap().into()];
    let r = process::run(&command, &missing, &c.env, false);
    assert_eq!(r.exit_code, -1);
    assert!(r.stdout.is_empty());
    assert_eq!(
        r.stderr,
        format!("Working directory not found: {}", missing.display())
    );
}
#[cfg(target_os = "macos")]
#[test]
fn darwin_direct_exec_refuses_implicit_shell_in_both_modes() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let c = fixture_context(d.path());
    let script = d.path().join("no-shebang");
    std::fs::write(&script, "printf executed > \"$1\"\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    for detached in [false, true] {
        for executable in [script.to_str().unwrap(), "no-shebang"] {
            let marker = d.path().join("must-not-execute");
            let r = process::run(
                &[executable.into(), marker.to_str().unwrap().into()],
                d.path(),
                &c.env,
                detached,
            );
            assert!(
                !marker.exists(),
                "implicit shell executed: {r:?}, detached={detached}"
            );
            assert_eq!(
                (r.exit_code, r.stdout.as_str(), r.stderr.as_str()),
                (-1, "", "spawn ENOEXEC")
            );
        }
    }
}
#[cfg(unix)]
#[test]
fn direct_exec_explicit_shell_shebang_and_native_controls() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let c = fixture_context(d.path());
    let script = d.path().join("script");
    let shebang = d.path().join("shebang");
    std::fs::write(&script, "printf executed > \"$1\"\n").unwrap();
    std::fs::write(&shebang, "#!/bin/sh\nprintf executed > \"$1\"\n").unwrap();
    std::fs::set_permissions(&shebang, std::fs::Permissions::from_mode(0o755)).unwrap();
    for detached in [false, true] {
        for mut command in [
            vec!["/bin/sh".into(), script.to_str().unwrap().into()],
            vec!["shebang".into()],
        ] {
            let marker = d.path().join("positive");
            command.push(marker.to_str().unwrap().into());
            let r = process::run(&command, d.path(), &c.env, detached);
            assert_eq!(r.exit_code, 0, "{r:?}");
            assert_eq!(std::fs::read_to_string(&marker).unwrap(), "executed");
            std::fs::remove_file(marker).unwrap();
        }
        assert_eq!(
            process::run(&["/usr/bin/true".into()], d.path(), &c.env, detached).exit_code,
            0
        );
    }
}
#[test]
fn native_executable_literal_arguments() {
    let d = tempfile::tempdir().unwrap();
    let exe = install_fixture(d.path(), "native");
    let c = fixture_context(d.path());
    let args = ["", "a\"b", "trailing\\", "%PATH%!^&|() 雪", "a\\\"b"];
    let mut command = vec![exe];
    command.extend(args.iter().map(|v| v.to_string()));
    assert_eq!(process::run(&command, d.path(), &c.env, false).exit_code, 0);
    assert_eq!(records(d.path()), vec![args.map(String::from).to_vec()]);
}
#[test]
fn real_ide_preflight_launch_failure_has_no_fallback() {
    let d = tempfile::tempdir().unwrap();
    install_fixture(d.path(), "kiro");
    install_fixture(d.path(), "open");
    install_fixture(d.path(), "x-terminal-emulator");
    let mut c = fixture_context(d.path());
    c.env.insert("ARASHI_LAUNCH_EXIT".into(), "19".into());
    let i = LaunchIntent {
        selector: LaunchSelector::Ide(Ide::Kiro),
        disposition: LaunchDisposition::Window,
    };
    let LaunchPlan::Platform(p) = resolve::preflight(&i, &c).unwrap() else {
        panic!()
    };
    let e = platform::execute_platform(&target(d.path()), &p, &c).unwrap_err();
    assert_eq!(e.code, LaunchErrorCode::LaunchFailed);
    assert_eq!(
        records(d.path()),
        vec![vec![
            "--new-window".to_string(),
            d.path().to_str().unwrap().into()
        ]]
    );
}
#[test]
fn real_available_auto_ide_tab_fails_before_launch() {
    let d = tempfile::tempdir().unwrap();
    install_fixture(d.path(), "kiro");
    let mut c = fixture_context(d.path());
    c.env.insert("TERM_PROGRAM".into(), "kiro".into());
    c.env.insert("WEZTERM_PANE".into(), "7".into());
    let i = LaunchIntent {
        selector: LaunchSelector::Auto,
        disposition: LaunchDisposition::Tab,
    };
    assert_eq!(
        resolve::preflight(&i, &c).unwrap_err().code,
        LaunchErrorCode::TabDispositionUnsupported
    );
    assert!(!d.path().join("argv").exists());
}
#[test]
fn real_wezterm_window_uses_detached_start_after_cli_failure() {
    let d = tempfile::tempdir().unwrap();
    install_fixture(d.path(), "wezterm");
    let mut c = fixture_context(d.path());
    c.env.insert("TERM_PROGRAM".into(), "WezTerm".into());
    c.env.insert("ARASHI_LAUNCH_MODE".into(), "wezterm".into());

    c.env.insert(
        "ARASHI_LAUNCH_FINISHED".into(),
        d.path().join("finished").to_str().unwrap().into(),
    );
    let LaunchPlan::Platform(p) = resolve::preflight(
        &LaunchIntent {
            selector: LaunchSelector::Auto,
            disposition: LaunchDisposition::Window,
        },
        &c,
    )
    .unwrap() else {
        panic!()
    };
    let mut env = c.env.clone();
    let out = detached_barrier(&mut env, |env| {
        c.env = env.clone();
        let result = platform::execute_platform(&target(d.path()), &p, &c);
        assert!(!d.path().join("finished").exists());
        result
    })
    .unwrap();
    assert_eq!(out.command[1], "start");
    let start = Instant::now();
    while !d.path().join("finished").exists() && start.elapsed() < Duration::from_secs(4) {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(d.path().join("finished").exists());
    assert_eq!(records(d.path()).len(), 2);
}
#[test]
fn real_wezterm_tab_failure_never_opens_window() {
    let d = tempfile::tempdir().unwrap();
    install_fixture(d.path(), "wezterm");
    let mut c = fixture_context(d.path());
    c.env.insert("WEZTERM_PANE".into(), "7".into());
    c.env.insert("ARASHI_LAUNCH_MODE".into(), "wezterm".into());
    let LaunchPlan::Platform(p) = resolve::preflight(
        &LaunchIntent {
            selector: LaunchSelector::Auto,
            disposition: LaunchDisposition::Tab,
        },
        &c,
    )
    .unwrap() else {
        panic!()
    };
    assert!(platform::execute_platform(&target(d.path()), &p, &c).is_err());
    assert_eq!(
        records(d.path()),
        vec![
            vec![
                "cli",
                "spawn",
                "--pane-id",
                "7",
                "--cwd",
                d.path().to_str().unwrap()
            ]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>()
        ]
    );
}
#[test]
fn mac_target_parser_and_literal_argv() {
    assert!(platform::parse_mac_target(r#"{"version":"1.3","target":3,"profile":"a"}"#).is_none());
    assert!(platform::parse_mac_target("1.3\n\nprofile").is_none());
    let t = platform::parse_mac_target("1.3.0\n42\nDefault\n").unwrap();
    let mut c = ctx();
    c.platform = Platform::MacOs;
    let p = PlatformPlan {
        family: PlatformFamily::Ghostty,
        disposition: LaunchDisposition::Tab,
        ide_command: None,
        mac_target: Some(t),
    };
    let path = "/tmp/a'\" $() 雪\\";
    let commands = platform::terminal_commands(path, &p, &c).unwrap();
    assert_eq!(commands.len(), 1);
    assert_eq!(commands[0][4], path);
    assert!(commands[0][2].contains("repeat with candidateWindow in windows"));
    assert!(!commands[0][2].contains(path));
}
#[test]
fn windows_fallback_payload_and_profile_are_literal() {
    let mut c = ctx();
    c.platform = Platform::Windows;
    c.env.insert("WT_SESSION".into(), "session".into());
    c.env.insert("WT_PROFILE_ID".into(), " {profile} ".into());
    c.env.insert("MSYSTEM".into(), "MINGW64".into());
    c.env
        .insert("SHELL".into(), "C:\\Git\\bin\\bash.exe".into());
    let path = "C:\\work trees\\%PATH%!^&|() 雪";
    let commands = platform::fallback_commands(path, &c);
    assert_eq!(commands.len(), 4);
    assert_eq!(
        commands[0],
        vec![
            "wt.exe",
            "-w",
            "new",
            "new-tab",
            "-p",
            "{profile}",
            "-d",
            path
        ]
    );
    assert!(!commands[1][4].contains(path));
    let e = platform::attempt_environment(&commands[1], path, &c.env);
    assert_eq!(e["CHERE_INVOKING"], "1");
    assert_eq!(e["ARASHI_SWITCH_WORKTREE"], path);
    assert!(
        !platform::attempt_environment(&commands[0], path, &c.env).contains_key("CHERE_INVOKING")
    );
}
#[test]
fn windows_prepare_uses_fixed_tokens_not_raw_user_syntax() {
    let args = vec![
        "code.cmd".into(),
        "".into(),
        "a\"b\\".into(),
        "%PATH%!^&|() 雪".into(),
    ];
    let mut env = Environment::new();
    env.insert("PATH".into(), "first".into());
    env.insert("Path".into(), "last".into());
    env.insert("ARASHI_CMD_ARGUMENT_99".into(), "untrusted".into());
    let p = process::prepare_command(&args, &env, Platform::Windows);
    assert!(p.verbatim);
    assert_eq!(p.command, "cmd.exe");
    assert_eq!(p.args[1], "/v:off");
    assert!(!p.args.last().unwrap().contains("雪"));
    for (i, arg) in args.iter().enumerate() {
        assert_eq!(
            p.env[&format!("ARASHI_CMD_ARGUMENT_{i}")],
            process::quote_windows_argument(arg)
        );
    }
    assert!(!p.env.contains_key("ARASHI_CMD_ARGUMENT_99"));
    assert!(!p.env.contains_key("PATH"));
    assert_eq!(p.env["Path"], "last");
}
#[cfg(windows)]
#[test]
fn windows_native_cmd_and_ide_exe_preserve_literal_arguments() {
    let d = tempfile::tempdir().unwrap();
    let exe = install_fixture(d.path(), "native");
    let mut c = fixture_context(d.path());
    c.env.insert("ARASHI_LAUNCH_NATIVE".into(), exe.clone());
    let batch = d.path().join("launcher.cmd");
    std::fs::write(&batch, "@\"%ARASHI_LAUNCH_NATIVE%\" %*\r\n").unwrap();
    let args = ["", "a\"b", "trailing\\", "%PATH%!^&|() 雪"];
    for prefix in [
        vec![exe.clone()],
        vec![batch.to_str().unwrap().into()],
        vec!["cmd.exe".into(), "/d".into(), "/c".into(), exe],
    ] {
        let mut cmd = prefix;
        cmd.extend(args.iter().map(|s| s.to_string()));
        let r = process::run(&cmd, d.path(), &c.env, false);
        assert_eq!(r.exit_code, 0, "{r:?}");
    }
    assert_eq!(records(d.path()), vec![args.map(String::from).to_vec(); 3]);
}
