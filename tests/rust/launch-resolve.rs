use super::*;

#[test]
fn unsupported_tab_message_uses_source_family_spelling() {
    let c = ctx();
    assert_eq!(
        resolve::ensure_supported(PlatformFamily::Ide(Ide::Kiro), LaunchDisposition::Tab, &c)
            .unwrap_err()
            .message,
        "ide does not expose a stable tab target; use the default window disposition or another launcher."
    );
}

#[test]
fn empty_and_whitespace_detector_matrix() {
    for key in [
        "TMUX",
        "HERDR_ENV",
        "CMUX_WORKSPACE_ID",
        "CMUX_SURFACE_ID",
        "KITTY_PID",
        "KITTY_WINDOW_ID",
    ] {
        for value in ["", " ", "\t\n"] {
            let env = Environment::from([(key.into(), value.into())]);
            assert_eq!(resolve::detect_context(&env), None, "{key}={value:?}");
        }
    }
    for key in ["VSCODE_PID", "VSCODE_GIT_IPC_HANDLE"] {
        for value in ["", " "] {
            let env = Environment::from([(key.into(), value.into())]);
            assert_eq!(
                resolve::detect_context(&env),
                Some(LaunchSelector::Ide(Ide::VsCode))
            );
        }
    }
    for (value, expected) in [
        ("vscode", Some(Ide::VsCode)),
        ("VSCODE", None),
        (" vscode ", None),
        ("KiRo", Some(Ide::Kiro)),
        ("cursor kiro", Some(Ide::Cursor)),
    ] {
        assert_eq!(
            resolve::detect_ide(&Environment::from([("TERM_PROGRAM".into(), value.into())])),
            expected
        );
    }
    for value in ["xterm-kitty", " XTERM-KITTY "] {
        assert!(resolve::is_kitty(&Environment::from([(
            "TERM".into(),
            value.into()
        )])));
    }
}
#[test]
fn terminal_detector_priority_matches_source() {
    let mut e = Environment::from([
        ("TERM_PROGRAM".into(), "Apple_Terminal".into()),
        ("WEZTERM_EXECUTABLE".into(), "x".into()),
        ("GHOSTTY_BIN_DIR".into(), "x".into()),
        ("TERM".into(), "xterm-kitty".into()),
        ("ITERM_SESSION_ID".into(), "x".into()),
    ]);
    for (key, family) in [
        ("TERM_PROGRAM", PlatformFamily::Terminal),
        ("WEZTERM_EXECUTABLE", PlatformFamily::WezTerm),
        ("GHOSTTY_BIN_DIR", PlatformFamily::Ghostty),
        ("TERM", PlatformFamily::KittyUnmanaged),
        ("ITERM_SESSION_ID", PlatformFamily::ITerm2),
    ] {
        assert_eq!(resolve::detect_terminal(&e), Some(family));
        e.remove(key);
    }
    assert_eq!(resolve::detect_terminal(&e), None);
}
#[test]
fn explicit_managed_preflight_errors_and_late_kitty_boundary() {
    let c = ctx();
    for (family, code) in [
        (ManagedFamily::Tmux, LaunchErrorCode::TmuxContextRequired),
        (ManagedFamily::Sesh, LaunchErrorCode::SeshRequiresTmux),
        (
            ManagedFamily::Herdr,
            LaunchErrorCode::TabDispositionUnsupported,
        ),
    ] {
        let error = resolve::preflight(
            &LaunchIntent {
                selector: LaunchSelector::Managed(family),
                disposition: LaunchDisposition::Tab,
            },
            &c,
        )
        .unwrap_err();
        assert_eq!(error.code, code);
    }
    assert!(matches!(
        resolve::preflight(
            &LaunchIntent {
                selector: LaunchSelector::Managed(ManagedFamily::Kitty),
                disposition: LaunchDisposition::Tab
            },
            &c
        )
        .unwrap(),
        LaunchPlan::Managed(ManagedPlan {
            family: ManagedFamily::Kitty,
            ..
        })
    ));
}
#[test]
fn platform_disposition_matrix() {
    let mut c = ctx();
    for platform in [Platform::MacOs, Platform::Linux, Platform::Windows] {
        c.platform = platform;
        for family in [
            PlatformFamily::Terminal,
            PlatformFamily::Ide(Ide::Cursor),
            PlatformFamily::GitBash,
            PlatformFamily::KittyUnmanaged,
            PlatformFamily::Fallback,
            PlatformFamily::WezTerm,
        ] {
            assert!(resolve::ensure_supported(family, LaunchDisposition::Window, &c).is_ok());
            assert_eq!(
                resolve::ensure_supported(family, LaunchDisposition::Tab, &c)
                    .unwrap_err()
                    .code,
                LaunchErrorCode::TabDispositionUnsupported
            );
        }
    }
    c.env.insert("WEZTERM_PANE".into(), "7".into());
    assert!(resolve::ensure_supported(PlatformFamily::WezTerm, LaunchDisposition::Tab, &c).is_ok());
    c.platform = Platform::MacOs;
    c.env.insert("TERM_PROGRAM_VERSION".into(), "1.2.9".into());
    assert!(
        resolve::ensure_supported(PlatformFamily::Ghostty, LaunchDisposition::Tab, &c).is_err()
    );
    c.env
        .insert("TERM_PROGRAM_VERSION".into(), "1.3.0-dev".into());
    assert!(resolve::ensure_supported(PlatformFamily::Ghostty, LaunchDisposition::Tab, &c).is_ok());
}
#[test]
fn versions_follow_source_prefix_grammar() {
    for (value, expected) in [
        ("1.3", true),
        ("1.3.0-dev", true),
        (" 2.0.0 ", true),
        ("1.2.99", false),
        ("v1.3.0", false),
        ("1", false),
        ("1.3.", true),
        ("", false),
    ] {
        assert_eq!(
            resolve::version_at_least(value, [1, 3, 0]),
            expected,
            "{value}"
        );
    }
}
#[test]
fn executable_lookup_respects_path_order_and_mode() {
    let d = tempfile::tempdir().unwrap();
    let a = d.path().join("a");
    let b = d.path().join("b");
    std::fs::create_dir(&a).unwrap();
    std::fs::create_dir(&b).unwrap();
    let suffix = if cfg!(windows) { ".EXE" } else { "" };
    let name = format!("lookup{suffix}");
    for dir in [&a, &b] {
        std::fs::write(dir.join(&name), "fixture").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir.join(&name), std::fs::Permissions::from_mode(0o755))
                .unwrap();
        }
    }
    let env = Environment::from([(
        "PATH".into(),
        format!(
            "{}{}{}",
            b.display(),
            if cfg!(windows) { ';' } else { ':' },
            a.display()
        ),
    )]);
    assert_eq!(
        process::find_executable("lookup", d.path(), &env, Platform::native()),
        Some(b.join(name))
    );
}
