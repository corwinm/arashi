//! Real platform execution, with only source-sanctioned ordered fallbacks.
use super::*;
const WINDOWS_GIT_BASH_LAUNCH: &str = "$directory = Split-Path -Parent (Get-Command git.exe -ErrorAction Stop).Source; while ($directory) { $gitBash = Join-Path $directory 'git-bash.exe'; if (Test-Path -LiteralPath $gitBash) { Start-Process -FilePath $gitBash -ArgumentList '--no-cd' -WorkingDirectory $env:ARASHI_SWITCH_WORKTREE -ErrorAction Stop; exit 0 }; $parent = Split-Path -Parent $directory; if ($parent -eq $directory) { break }; $directory = $parent }; exit 1";
fn argv(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| (*s).into()).collect()
}
pub fn windows_terminal_command(
    path: &str,
    env: &Environment,
    disposition: LaunchDisposition,
) -> Vec<String> {
    let mut c = argv(&[
        "wt.exe",
        "-w",
        if disposition == LaunchDisposition::Tab {
            "0"
        } else {
            "new"
        },
        "new-tab",
    ]);
    if let Some(profile) = nonempty(env, "WT_PROFILE_ID") {
        c.extend(argv(&["-p", profile]));
    }
    c.extend(argv(&["-d", path]));
    c
}
pub fn fallback_commands(path: &str, c: &LaunchContext) -> Vec<Vec<String>> {
    match c.platform {
        Platform::MacOs => vec![argv(&["open", "-a", "Terminal", path])],
        Platform::Linux => vec![
            argv(&["x-terminal-emulator", "--working-directory", path]),
            argv(&["gnome-terminal", "--working-directory", path]),
            argv(&["konsole", "--workdir", path]),
        ],
        Platform::Windows => {
            let mut commands = Vec::new();
            if nonempty(&c.env, "WT_SESSION").is_some() {
                commands.push(windows_terminal_command(
                    path,
                    &c.env,
                    LaunchDisposition::Window,
                ));
            }
            if resolve::is_msys_bash(&c.env) {
                commands.push(argv(&[
                    "powershell.exe",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    WINDOWS_GIT_BASH_LAUNCH,
                ]));
                commands.push(argv(&[
                    "mintty.exe",
                    "--daemon",
                    "--dir",
                    path,
                    "/usr/bin/bash",
                    "--login",
                    "-i",
                ]));
            }
            commands.push(argv(&[
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Process -FilePath cmd.exe -WorkingDirectory $env:ARASHI_SWITCH_WORKTREE",
            ]));
            commands
        }
    }
}
pub fn attempt_environment(command: &[String], path: &str, env: &Environment) -> Environment {
    let mut e = env.clone();
    if command.get(4).is_some_and(|v| v == WINDOWS_GIT_BASH_LAUNCH)
        || command.first().is_some_and(|v| v == "mintty.exe")
    {
        e.insert("CHERE_INVOKING".into(), "1".into());
    }
    if command.first().is_some_and(|v| v == "powershell.exe") {
        e.insert("ARASHI_SWITCH_WORKTREE".into(), path.into());
    }
    e
}
const EXACT_WINDOW: &str = r#"set targetWindow to missing value
repeat with candidateWindow in windows
if (id of candidateWindow as text) is targetIdentifier then
set targetWindow to contents of candidateWindow
exit repeat
end if
end repeat
if targetWindow is missing value then error "ARASHI_TAB_TARGET_UNAVAILABLE" number 42"#;
pub fn mac_script(family: PlatformFamily, disposition: LaunchDisposition) -> String {
    let tab = disposition == LaunchDisposition::Tab;
    if family == PlatformFamily::Ghostty {
        return format!(
            r#"on run argv
set targetDirectory to item 1 of argv
set targetShell to item 2 of argv
set targetIdentifier to item 3 of argv
tell application "Ghostty"
set surfaceConfig to new surface configuration
set initial working directory of surfaceConfig to targetDirectory
set command of surfaceConfig to targetShell
{}
activate
end tell
end run"#,
            if tab {
                format!("{EXACT_WINDOW}\nnew tab in targetWindow with configuration surfaceConfig")
            } else {
                "new window with configuration surfaceConfig".into()
            }
        );
    }
    let (app, variable, action, after) = if family == PlatformFamily::Terminal {
        (
            "Terminal",
            "terminalWasRunning",
            r#"if targetProfile is "" and terminalWasRunning and (count of windows) > 0 then
set targetProfile to name of current settings of selected tab of front window
end if
set createdTab to do script launchCommand"#
                .to_string(),
            "if targetProfile is not \"\" then set current settings of createdTab to settings set targetProfile\n",
        )
    } else {
        (
            "iTerm2",
            "iTermWasRunning",
            if tab {
                format!(
                    "{EXACT_WINDOW}\ntell targetWindow to create tab with profile targetProfile command launchCommand"
                )
            } else {
                r#"if targetProfile is "" and iTermWasRunning and (count of windows) > 0 then
set targetProfile to profile name of current session of current window
end if
if targetProfile is "" then
create window with default profile command launchCommand
else
create window with profile targetProfile command launchCommand
end if"#
                    .into()
            },
            "",
        )
    };
    format!(
        r#"on run argv
set targetDirectory to item 1 of argv
set targetShell to item 2 of argv
set targetIdentifier to item 3 of argv
set targetProfile to item 4 of argv
set launchCommand to "cd " & quoted form of targetDirectory & "; exec " & quoted form of targetShell & " -l"
set {variable} to application "{app}" is running
tell application "{app}"
{action}
{after}activate
end tell
end run"#
    )
}
pub fn mac_preflight_script(family: PlatformFamily) -> String {
    let (app, window, profile) = match family {
        PlatformFamily::ITerm2 => (
            "iTerm2",
            "current window",
            "profile name of current session of targetWindow",
        ),
        PlatformFamily::Terminal => (
            "Terminal",
            "front window",
            "name of current settings of selected tab of targetWindow",
        ),
        _ => ("Ghostty", "front window", "\"Default\""),
    };
    format!(
        r#"if not (application "{app}" is running) then error "ARASHI_TAB_TARGET_UNAVAILABLE" number 42
tell application "{app}"
if (count of windows) is 0 then error "ARASHI_TAB_TARGET_UNAVAILABLE" number 42
set targetWindow to {window}
set targetProfile to {profile}
return (version as text) & linefeed & (id of targetWindow as text) & linefeed & targetProfile
end tell"#
    )
}
pub fn parse_mac_target(stdout: &str) -> Option<MacTarget> {
    let (version, target, profile) =
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
            (
                v.get("version")?.as_str()?.to_string(),
                v.get("target")?.as_str()?.to_string(),
                v.get("profile")?.as_str()?.to_string(),
            )
        } else {
            let mut lines = stdout.trim().split('\n');
            (
                lines.next()?.into(),
                lines.next()?.into(),
                lines.next()?.into(),
            )
        };
    if [&version, &target, &profile]
        .iter()
        .any(|v| v.trim().is_empty())
    {
        return None;
    }
    Some(MacTarget {
        version: version.trim().into(),
        target: target.trim().into(),
        profile: profile.trim().into(),
    })
}
pub fn preflight_mac(family: PlatformFamily, c: &LaunchContext) -> LaunchResult<MacTarget> {
    let command = argv(&["osascript", "-e", &mac_preflight_script(family), "--"]);
    let result = process::run(&command, &c.cwd, &c.env, false);
    if result.exit_code != 0 {
        if result.stderr.contains("ARASHI_TAB_TARGET_UNAVAILABLE")
            || result.stdout.contains("ARASHI_TAB_TARGET_UNAVAILABLE")
        {
            return Err(resolve::unsupported(
                family,
                "Exact active tab target is unavailable.",
            ));
        }
        return Err(failure(&c.cwd.to_string_lossy(), &command, &result));
    }
    let target = parse_mac_target(&result.stdout).filter(|t| {
        family != PlatformFamily::Ghostty || resolve::version_at_least(&t.version, [1, 3, 0])
    });
    target.ok_or_else(|| {
        resolve::unsupported(
            family,
            "Supported version and exact target evidence are required for this launch.",
        )
    })
}
pub fn terminal_commands(
    path: &str,
    p: &PlatformPlan,
    c: &LaunchContext,
) -> LaunchResult<Vec<Vec<String>>> {
    resolve::ensure_supported(p.family, p.disposition, c)?;
    let tab = p.disposition == LaunchDisposition::Tab;
    let shell = nonempty(&c.env, "SHELL").unwrap_or("/bin/zsh");
    match p.family {
        PlatformFamily::Ide(ide) => {
            let command = p.ide_command.as_deref().ok_or_else(|| {
                LaunchError::new(
                    LaunchErrorCode::IdeNotFound,
                    format!("Missing {} preflight command", ide.name()),
                )
            })?;
            Ok(vec![if c.platform == Platform::Windows {
                argv(&["cmd.exe", "/d", "/c", command, "--new-window", path])
            } else {
                argv(&[command, "--new-window", path])
            }])
        }
        PlatformFamily::WezTerm => Ok(if tab {
            vec![argv(&[
                "wezterm",
                "cli",
                "spawn",
                "--pane-id",
                nonempty(&c.env, "WEZTERM_PANE").unwrap_or(""),
                "--cwd",
                path,
            ])]
        } else {
            vec![
                argv(&["wezterm", "cli", "spawn", "--new-window", "--cwd", path]),
                argv(&["wezterm", "start", "--always-new-process", "--cwd", path]),
            ]
        }),
        PlatformFamily::KittyUnmanaged => Ok(vec![if c.platform == Platform::MacOs {
            argv(&["open", "-na", "kitty.app", "--args", "--directory", path])
        } else {
            argv(&["kitty", "--detach", "--directory", path])
        }]),
        PlatformFamily::WindowsTerminal | PlatformFamily::GitBash | PlatformFamily::Fallback => {
            Ok(if tab {
                vec![windows_terminal_command(path, &c.env, p.disposition)]
            } else {
                fallback_commands(path, c)
            })
        }
        _ => {
            let modern_ghostty = c.platform == Platform::MacOs
                && p.family == PlatformFamily::Ghostty
                && (p
                    .mac_target
                    .as_ref()
                    .is_some_and(|t| resolve::version_at_least(&t.version, [1, 3, 0]))
                    || (!tab
                        && nonempty(&c.env, "TERM_PROGRAM_VERSION")
                            .is_some_and(|v| resolve::version_at_least(v, [1, 3, 0]))));
            let applescript = c.platform == Platform::MacOs
                && (matches!(p.family, PlatformFamily::Terminal | PlatformFamily::ITerm2)
                    || modern_ghostty);
            let mut commands = Vec::new();
            if applescript {
                if tab && p.mac_target.is_none() {
                    return Err(resolve::unsupported(
                        p.family,
                        "Exact active tab preflight evidence is required.",
                    ));
                }
                let t = p.mac_target.as_ref();
                commands.push(argv(&[
                    "osascript",
                    "-e",
                    &mac_script(p.family, p.disposition),
                    "--",
                    path,
                    shell,
                    t.map(|t| t.target.as_str()).unwrap_or(""),
                    t.map(|t| t.profile.as_str()).unwrap_or(""),
                    t.map(|t| t.version.as_str()).unwrap_or_else(|| {
                        if p.family == PlatformFamily::Ghostty {
                            c.env
                                .get("TERM_PROGRAM_VERSION")
                                .map(String::as_str)
                                .unwrap_or("")
                        } else {
                            ""
                        }
                    }),
                ]));
                if tab {
                    return Ok(commands);
                }
                match p.family {
                    PlatformFamily::Terminal => {
                        commands.push(argv(&["open", "-a", "Terminal", path]))
                    }
                    PlatformFamily::ITerm2 => {
                        commands.push(argv(&["open", "-a", "iTerm", path]));
                        commands.push(argv(&["open", "-a", "iTerm2", path]));
                    }
                    _ => commands.push(argv(&[
                        "open",
                        "-na",
                        "Ghostty.app",
                        "--args",
                        "--working-directory",
                        path,
                        "-e",
                        shell,
                    ])),
                };
                return Ok(commands);
            }
            if tab {
                return Err(resolve::unsupported(
                    p.family,
                    "Exact supported tab target is required.",
                ));
            }
            Ok(vec![match c.platform {
                Platform::Linux => argv(&[
                    "ghostty",
                    "+new-window",
                    "--working-directory",
                    path,
                    "-e",
                    shell,
                ]),
                Platform::MacOs => argv(&[
                    "open",
                    "-na",
                    "Ghostty.app",
                    "--args",
                    "--working-directory",
                    path,
                    "-e",
                    shell,
                ]),
                Platform::Windows => argv(&["ghostty", "--working-directory", path, "-e", shell]),
            }])
        }
    }
}
fn failure(path: &str, command: &[String], result: &process::ProcessResult) -> LaunchError {
    let reason = if result.stderr.is_empty() {
        &result.stdout
    } else {
        &result.stderr
    };
    LaunchError::new(
        LaunchErrorCode::LaunchFailed,
        format!(
            "Failed to open a terminal context for {path} using `{}`: {}",
            command.join(" "),
            if reason.trim().is_empty() {
                "unknown failure"
            } else {
                reason.trim()
            }
        ),
    )
}
pub fn execute_platform(
    target: &LaunchTarget,
    plan: &PlatformPlan,
    c: &LaunchContext,
) -> LaunchResult<LaunchOutcome> {
    let path = target.worktree_path.to_str().ok_or_else(|| {
        LaunchError::new(
            LaunchErrorCode::LaunchFailed,
            "Launch target path is not UTF-8",
        )
    })?;
    let mut commands = terminal_commands(path, plan, c)?;
    let detected = !matches!(
        plan.family,
        PlatformFamily::Ide(_)
            | PlatformFamily::WindowsTerminal
            | PlatformFamily::GitBash
            | PlatformFamily::Fallback
    );
    let fallback_start = if detected { commands.len() } else { 0 };
    if detected && plan.disposition == LaunchDisposition::Window {
        commands.extend(fallback_commands(path, c));
    }
    let mut errors = Vec::new();
    for (index, command) in commands.into_iter().enumerate() {
        let detached = command.first().is_some_and(|s| s == "wt.exe")
            || (command.first().is_some_and(|s| s == "wezterm")
                && command.get(1).is_some_and(|s| s == "start"));
        let env = if detected {
            // Detected attempts inherit unchanged env; generic fallback gets its own payload.
            if command
                .first()
                .is_some_and(|s| s == "powershell.exe" || s == "mintty.exe")
            {
                attempt_environment(&command, path, &c.env)
            } else {
                c.env.clone()
            }
        } else {
            attempt_environment(&command, path, &c.env)
        };
        let result = process::run(&command, &target.worktree_path, &env, detached);
        if result.exit_code == 0 {
            return Ok(LaunchOutcome {
                mode: if let PlatformFamily::Ide(ide) = plan.family {
                    ide.name().into()
                } else {
                    "fallback".into()
                },
                command,
                disposition: plan.disposition,
            });
        }
        if plan.disposition == LaunchDisposition::Tab
            && (result.exit_code == 42
                || result.stderr.contains("ARASHI_TAB_TARGET_UNAVAILABLE")
                || result.stdout.contains("ARASHI_TAB_TARGET_UNAVAILABLE"))
        {
            return Err(resolve::unsupported(
                plan.family,
                "Exact active tab target is unavailable.",
            ));
        }
        let error = failure(path, &command, &result);
        if plan.disposition == LaunchDisposition::Tab
            || matches!(plan.family, PlatformFamily::Ide(_))
        {
            return Err(error);
        }
        if index >= fallback_start {
            let detail = if !result.stderr.is_empty() {
                &result.stderr
            } else if !result.stdout.is_empty() {
                &result.stdout
            } else {
                "unknown failure"
            };
            errors.push(format!("{}: {}", command.join(" "), detail.trim()));
        }
    }
    Err(LaunchError::new(
        LaunchErrorCode::LaunchFailed,
        format!(
            "Failed to open a terminal at {path}. Attempted commands: {}",
            errors.join(" | ")
        ),
    ))
}
