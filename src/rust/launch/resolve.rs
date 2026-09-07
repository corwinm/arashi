//! Source-ordered environment detection and mutation-free launch preflight.
use super::*;
pub fn detect_ide(env: &Environment) -> Option<Ide> {
    let signals = [
        "TERM_PROGRAM",
        "TERM_PROGRAM_VERSION",
        "VSCODE_GIT_ASKPASS_NODE",
        "VSCODE_GIT_ASKPASS_EXTRA_ARGS",
        "VSCODE_GIT_IPC_HANDLE",
    ]
    .iter()
    .filter_map(|k| env.get(*k))
    .map(|v| v.to_lowercase())
    .collect::<Vec<_>>();
    if signals.iter().any(|v| v.contains("cursor")) {
        Some(Ide::Cursor)
    } else if signals.iter().any(|v| v.contains("kiro")) {
        Some(Ide::Kiro)
    } else if env.get("TERM_PROGRAM").is_some_and(|v| v == "vscode")
        || env.contains_key("VSCODE_PID")
        || env.contains_key("VSCODE_GIT_IPC_HANDLE")
    {
        Some(Ide::VsCode)
    } else {
        None
    }
}
pub fn is_kitty(env: &Environment) -> bool {
    nonempty(env, "KITTY_PID").is_some()
        || nonempty(env, "KITTY_WINDOW_ID").is_some()
        || nonempty(env, "TERM").is_some_and(|v| v.eq_ignore_ascii_case("xterm-kitty"))
}
pub fn detect_context(env: &Environment) -> Option<LaunchSelector> {
    use LaunchSelector::{Ide, Managed};
    if nonempty(env, "TMUX").is_some() {
        Some(Managed(ManagedFamily::Tmux))
    } else if nonempty(env, "HERDR_ENV") == Some("1") {
        Some(Managed(ManagedFamily::Herdr))
    } else if nonempty(env, "CMUX_WORKSPACE_ID").is_some()
        || nonempty(env, "CMUX_SURFACE_ID").is_some()
    {
        Some(Managed(ManagedFamily::Cmux))
    } else if let Some(ide) = detect_ide(env) {
        Some(Ide(ide))
    } else if is_kitty(env) {
        Some(Managed(ManagedFamily::Kitty))
    } else {
        None
    }
}
pub fn detect_terminal(env: &Environment) -> Option<PlatformFamily> {
    let term = env
        .get("TERM_PROGRAM")
        .map(|v| v.to_lowercase())
        .unwrap_or_default();
    if term == "apple_terminal" {
        Some(PlatformFamily::Terminal)
    } else if term == "wezterm"
        || nonempty(env, "WEZTERM_PANE").is_some()
        || nonempty(env, "WEZTERM_EXECUTABLE").is_some()
    {
        Some(PlatformFamily::WezTerm)
    } else if term == "ghostty"
        || nonempty(env, "GHOSTTY_BIN_DIR").is_some()
        || nonempty(env, "GHOSTTY_RESOURCES_DIR").is_some()
    {
        Some(PlatformFamily::Ghostty)
    } else if term == "kitty"
        || nonempty(env, "TERM").is_some_and(|v| v.eq_ignore_ascii_case("xterm-kitty"))
    {
        Some(PlatformFamily::KittyUnmanaged)
    } else if term == "iterm.app" || term == "iterm2" || nonempty(env, "ITERM_SESSION_ID").is_some()
    {
        Some(PlatformFamily::ITerm2)
    } else {
        None
    }
}
pub fn is_msys_bash(env: &Environment) -> bool {
    nonempty(env, "MSYSTEM").is_some()
        && nonempty(env, "SHELL").is_some_and(|v| {
            v.rsplit(['\\', '/']).next().is_some_and(|s| {
                s.eq_ignore_ascii_case("bash") || s.eq_ignore_ascii_case("bash.exe")
            })
        })
}
pub fn fallback_family(c: &LaunchContext) -> PlatformFamily {
    if c.platform == Platform::Windows && nonempty(&c.env, "WT_SESSION").is_some() {
        PlatformFamily::WindowsTerminal
    } else if c.platform == Platform::Windows && is_msys_bash(&c.env) {
        PlatformFamily::GitBash
    } else {
        PlatformFamily::Fallback
    }
}
pub fn version_at_least(value: &str, minimum: [u64; 3]) -> bool {
    let bytes = value.trim().as_bytes();
    let mut pos = 0;
    let mut nums = [0; 3];
    for (i, n) in nums.iter_mut().enumerate() {
        let start = pos;
        while pos < bytes.len() && bytes[pos].is_ascii_digit() {
            pos += 1;
        }
        if start == pos {
            return i == 2 && nums >= minimum;
        }
        let Ok(number) = std::str::from_utf8(&bytes[start..pos])
            .unwrap_or("")
            .parse()
        else {
            return false;
        };
        *n = number;
        if i < 2 {
            if bytes.get(pos) == Some(&b'.') {
                pos += 1;
            } else {
                return i == 1 && nums >= minimum;
            }
        }
    }
    nums >= minimum
}
pub fn available(command: &str, c: &LaunchContext) -> bool {
    let command = vec![
        if c.platform == Platform::Windows {
            "where"
        } else {
            "which"
        }
        .into(),
        command.into(),
    ];
    process::run(&command, &c.cwd, &c.env, false).exit_code == 0
}
pub fn resolve_ide(ide: Ide, c: &LaunchContext, bundle: bool) -> Option<String> {
    if available(ide.command(), c) {
        return Some(ide.command().into());
    }
    if !bundle || c.platform != Platform::MacOs {
        return None;
    }
    let suffix = match ide {
        Ide::Cursor => "Cursor.app/Contents/Resources/app/bin/cursor",
        Ide::VsCode => "Visual Studio Code.app/Contents/Resources/app/bin/code",
        Ide::Kiro => return None,
    };
    let mut paths = vec![PathBuf::from("/Applications").join(suffix)];
    if let Some(home) = &c.home {
        paths.push(home.join("Applications").join(suffix));
    }
    paths
        .into_iter()
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
}
pub fn unsupported(family: PlatformFamily, reason: &str) -> LaunchError {
    LaunchError::new(
        LaunchErrorCode::TabDispositionUnsupported,
        if reason.is_empty() {
            format!(
                "{} does not expose a stable tab target; use the default window disposition or another launcher.",
                family.name()
            )
        } else {
            reason.into()
        },
    )
}
pub fn ensure_supported(
    family: PlatformFamily,
    disposition: LaunchDisposition,
    c: &LaunchContext,
) -> LaunchResult<()> {
    if disposition == LaunchDisposition::Window {
        return Ok(());
    }
    let reason = match family {
        PlatformFamily::Terminal => Some(
            "Terminal.app cannot safely create a true tab through its supported automation. Press Command-T, then run `arashi switch --cd` in the new tab (requires active Arashi shell integration).",
        ),
        PlatformFamily::Ide(_)
        | PlatformFamily::GitBash
        | PlatformFamily::KittyUnmanaged
        | PlatformFamily::Fallback => Some(""),
        PlatformFamily::ITerm2 if c.platform != Platform::MacOs => Some(""),
        PlatformFamily::WezTerm if nonempty(&c.env, "WEZTERM_PANE").is_none() => {
            Some("WezTerm requires a non-empty WEZTERM_PANE to target the current GUI window.")
        }
        PlatformFamily::Ghostty
            if c.platform != Platform::MacOs
                || nonempty(&c.env, "TERM_PROGRAM_VERSION")
                    .is_some_and(|v| !version_at_least(v, [1, 3, 0])) =>
        {
            Some("Ghostty tabs require macOS Ghostty 1.3 or newer.")
        }
        _ => None,
    };
    if let Some(reason) = reason {
        Err(unsupported(family, reason))
    } else {
        Ok(())
    }
}
pub fn preflight(intent: &LaunchIntent, c: &LaunchContext) -> LaunchResult<LaunchPlan> {
    let disposition = intent.disposition;
    if let LaunchSelector::Managed(family) = intent.selector {
        return managed_preflight(family, disposition, c, true);
    }
    if let LaunchSelector::Ide(ide) = intent.selector {
        ensure_supported(PlatformFamily::Ide(ide), disposition, c)?;
        let command=resolve_ide(ide,c,true).ok_or_else(||LaunchError::new(LaunchErrorCode::IdeNotFound,format!("The `{}` launcher is required for --{}. Install {} or choose a different switch mode.",ide.command(),ide.name(),ide.command())))?;
        return Ok(LaunchPlan::Platform(PlatformPlan {
            family: PlatformFamily::Ide(ide),
            disposition,
            ide_command: Some(command),
            mac_target: None,
        }));
    }
    match detect_context(&c.env) {
        Some(LaunchSelector::Managed(family)) => {
            return managed_preflight(family, disposition, c, false);
        }
        Some(LaunchSelector::Ide(ide)) => {
            if let Some(command) = resolve_ide(ide, c, false) {
                ensure_supported(PlatformFamily::Ide(ide), disposition, c)?;
                return Ok(LaunchPlan::Platform(PlatformPlan {
                    family: PlatformFamily::Ide(ide),
                    disposition,
                    ide_command: Some(command),
                    mac_target: None,
                }));
            }
        }
        _ => {}
    }
    if is_kitty(&c.env) {
        return managed_preflight(ManagedFamily::Kitty, disposition, c, false);
    }
    let family = detect_terminal(&c.env).unwrap_or_else(|| fallback_family(c));
    ensure_supported(family, disposition, c)?;
    let mac_target = if disposition == LaunchDisposition::Tab
        && c.platform == Platform::MacOs
        && matches!(family, PlatformFamily::Ghostty | PlatformFamily::ITerm2)
    {
        Some(platform::preflight_mac(family, c)?)
    } else {
        None
    };
    Ok(LaunchPlan::Platform(PlatformPlan {
        family,
        disposition,
        ide_command: None,
        mac_target,
    }))
}
fn managed_preflight(
    family: ManagedFamily,
    disposition: LaunchDisposition,
    c: &LaunchContext,
    explicit: bool,
) -> LaunchResult<LaunchPlan> {
    if explicit && family == ManagedFamily::Tmux && nonempty(&c.env, "TMUX").is_none() {
        return Err(LaunchError::new(
            LaunchErrorCode::TmuxContextRequired,
            "--tmux requires an active tmux client or session (non-empty TMUX environment variable not detected). Run inside tmux or choose a different launcher.",
        ));
    }
    if family == ManagedFamily::Sesh {
        if nonempty(&c.env, "TMUX").is_none() {
            return Err(LaunchError::new(
                LaunchErrorCode::SeshRequiresTmux,
                "--sesh requires an active tmux session (TMUX environment variable not detected).",
            ));
        }
        if !available("sesh", c) {
            return Err(LaunchError::new(
                LaunchErrorCode::SeshNotFound,
                "The `sesh` binary is required for --sesh mode. Install sesh or run `arashi switch` without --sesh.",
            ));
        }
    }
    if family == ManagedFamily::Herdr
        && disposition == LaunchDisposition::Tab
        && nonempty(&c.env, "HERDR_WORKSPACE_ID").is_none()
    {
        return Err(LaunchError::new(
            LaunchErrorCode::TabDispositionUnsupported,
            "Herdr requires a non-empty HERDR_WORKSPACE_ID to create a tab in the active workspace.",
        ));
    }
    Ok(LaunchPlan::Managed(ManagedPlan {
        family,
        disposition,
    }))
}
