//! Launch-only child lifecycle: never uses the tree-killing operation runner.
#[cfg(target_os = "macos")]
use super::direct_exec;
use super::{Environment, Platform};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
#[derive(Clone, Debug)]
pub struct ProcessResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}
impl ProcessResult {
    fn failure(error: impl ToString) -> Self {
        Self {
            exit_code: -1,
            stdout: String::new(),
            stderr: error.to_string(),
        }
    }
}
/// CommandLineToArgvW quoting used by retained prepare-spawn-command.js.
pub fn quote_windows_argument(value: &str) -> String {
    let mut out = String::from("\"");
    let mut slashes = 0;
    for c in value.chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        if c == '"' {
            out.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
        } else {
            out.extend(std::iter::repeat_n('\\', slashes));
        }
        slashes = 0;
        out.push(c);
    }
    out.extend(std::iter::repeat_n('\\', slashes * 2));
    out.push('"');
    out
}
pub fn child_environment(env: &Environment, platform: Platform) -> Environment {
    let mut result = Environment::new();
    for (key, value) in env {
        let upper = key.to_ascii_uppercase();
        if key == "ARASHI_DIRECTIVE_FILE"
            || key == "ARASHI_SHELL"
            || (platform == Platform::Windows
                && (upper == "ARASHI_DIRECTIVE_FILE" || upper == "ARASHI_SHELL"))
        {
            continue;
        }
        result.insert(
            if platform == Platform::Windows && upper == "PATH" {
                "Path".into()
            } else {
                key.clone()
            },
            value.clone(),
        );
    }
    result
}
fn env_value<'a>(env: &'a Environment, key: &str, platform: Platform) -> Option<&'a str> {
    env.iter()
        .find(|(k, _)| {
            if platform == Platform::Windows {
                k.eq_ignore_ascii_case(key)
            } else {
                k.as_str() == key
            }
        })
        .map(|(_, v)| v.as_str())
}
/// Explicit snapshot lookup, including Windows PATHEXT. No parent-env mutation.
pub fn find_executable(
    name: &str,
    cwd: &Path,
    env: &Environment,
    platform: Platform,
) -> Option<PathBuf> {
    let direct = name.contains('/') || name.contains('\\');
    let mut bases = Vec::new();
    if direct {
        let p = PathBuf::from(name);
        bases.push(if p.is_absolute() { p } else { cwd.join(p) });
    } else {
        if platform == Platform::Windows {
            bases.push(cwd.join(name));
        }
        let path = env_value(env, "PATH", platform).unwrap_or("");
        let separator = if platform == Platform::Windows {
            ';'
        } else {
            ':'
        };
        for part in path.split(separator).filter(|p| !p.is_empty()) {
            let p = Path::new(part);
            bases.push(if p.is_absolute() {
                p.join(name)
            } else {
                cwd.join(p).join(name)
            });
        }
    }
    for base in bases {
        let mut candidates = vec![base.clone()];
        if platform == Platform::Windows && base.extension().is_none() {
            for ext in env_value(env, "PATHEXT", platform)
                .unwrap_or(".COM;.EXE;.BAT;.CMD")
                .split(';')
                .filter(|e| !e.is_empty())
            {
                candidates.push(PathBuf::from(format!("{}{}", base.display(), ext)));
            }
        }
        for p in candidates {
            if !p.is_file() {
                continue;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if platform != Platform::Windows
                    && p.metadata().ok()?.permissions().mode() & 0o111 == 0
                {
                    continue;
                }
            }
            return Some(p);
        }
    }
    None
}
#[derive(Clone, Debug)]
pub struct PreparedCommand {
    pub command: String,
    pub args: Vec<String>,
    pub env: Environment,
    pub verbatim: bool,
}
/// Fixed environment tokens keep user data out of cmd syntax. No CALL second expansion.
pub fn prepare_command(
    command: &[String],
    env: &Environment,
    platform: Platform,
) -> PreparedCommand {
    let mut env = child_environment(env, platform);
    let executable = command.first().cloned().unwrap_or_default();
    let lower = executable.to_ascii_lowercase();
    let mut values = command;
    let shell = platform == Platform::Windows
        && (lower == "cmd.exe" || lower.ends_with("\\cmd.exe") || lower.ends_with("/cmd.exe"));
    if shell
        && command.len() >= 4
        && command[1].eq_ignore_ascii_case("/d")
        && command[2].eq_ignore_ascii_case("/c")
    {
        values = &command[3..];
    }
    let batch = lower.ends_with(".cmd") || lower.ends_with(".bat");
    if platform != Platform::Windows || (!batch && values.len() == command.len()) {
        return PreparedCommand {
            command: executable,
            args: command.iter().skip(1).cloned().collect(),
            env,
            verbatim: false,
        };
    }
    let interpreter = env_value(&env, "COMSPEC", platform)
        .unwrap_or("cmd.exe")
        .to_string();
    env.retain(|k, _| {
        !k.to_ascii_uppercase().starts_with("ARASHI_CMD_ARGUMENT_")
            && !k.eq_ignore_ascii_case("ARASHI_CMD_LITERAL_PERCENT")
    });
    let mut tokens = Vec::new();
    for (index, arg) in values.iter().enumerate() {
        let key = format!("ARASHI_CMD_ARGUMENT_{index}");
        tokens.push(format!("%{key}%"));
        // Expansion precedes cmd syntax parsing: argv quoting alone does not
        // protect an embedded quote followed by shell operators. A forwarding
        // batch file parses %* once more, so its arguments need a second layer.
        let escape = |value: &str| {
            let mut escaped = String::new();
            for ch in value.chars() {
                if "()%!^\"<>&|".contains(ch) {
                    escaped.push('^');
                }
                escaped.push(ch);
            }
            escaped
        };
        // The executable path cannot contain a quote on Windows; keep its
        // surrounding quotes syntactic so a path containing spaces stays whole.
        let mut quoted = quote_windows_argument(arg);
        if index > 0 {
            quoted = escape(&quoted);
        }
        let target = values[0].to_ascii_lowercase();
        if index > 0 && (target.ends_with(".cmd") || target.ends_with(".bat")) {
            quoted = escape(&quoted);
        }
        env.insert(key, quoted);
    }
    PreparedCommand {
        command: interpreter,
        args: vec![
            "/d".into(),
            "/v:off".into(),
            "/s".into(),
            "/c".into(),
            format!("\"{}\"", tokens.join(" ")),
        ],
        env,
        verbatim: true,
    }
}
pub fn run(command: &[String], cwd: &Path, env: &Environment, detached: bool) -> ProcessResult {
    if command.is_empty() {
        return ProcessResult::failure("Empty launch command");
    }
    if !cwd.exists() {
        return ProcessResult::failure(format!("Working directory not found: {}", cwd.display()));
    }
    let platform = Platform::native();
    let normalized = child_environment(env, platform);
    let mut actual = command.to_vec();
    if platform != Platform::MacOs
        && let Some(path) = find_executable(&actual[0], cwd, &normalized, platform)
    {
        actual[0] = path.to_string_lossy().into_owned();
    }
    let prepared = prepare_command(&actual, &normalized, platform);
    let mut cmd = Command::new(&prepared.command);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if prepared.verbatim {
            cmd.raw_arg(prepared.args.join(" "));
        } else {
            cmd.args(&prepared.args);
        }
        if detached {
            cmd.creation_flags(0x00000008 | 0x00000200);
        }
    }
    #[cfg(not(windows))]
    {
        cmd.args(&prepared.args);
    }
    cmd.current_dir(cwd)
        .env_clear()
        .envs(&prepared.env)
        .stdin(Stdio::null());
    if !detached {
        #[cfg(target_os = "macos")]
        if let Err(e) = direct_exec::prepare(
            &mut cmd,
            prepared
                .env
                .iter()
                .map(|(k, v)| (k.into(), v.into()))
                .collect(),
        ) {
            return ProcessResult::failure(e);
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        let child = match cmd.spawn() {
            Ok(child) => child,
            // Node records asynchronous spawn errors as exit 1 with empty pipes;
            // Darwin ENOEXEC is instead a synchronous throw.
            Err(e) if cfg!(target_os = "macos") && e.raw_os_error() == Some(8) => {
                return ProcessResult::failure("spawn ENOEXEC");
            }
            Err(_) => {
                return ProcessResult {
                    exit_code: 1,
                    stdout: String::new(),
                    stderr: String::new(),
                };
            }
        };
        return match child.wait_with_output() {
            Ok(out) => ProcessResult {
                exit_code: out.status.code().unwrap_or(128),
                stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            },
            Err(e) => ProcessResult::failure(e),
        };
    }
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe extern "C" {
            fn setsid() -> i32;
        }
        unsafe {
            cmd.pre_exec(|| {
                if setsid() < 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
    // Register after setsid: direct exec never returns Ok into later callbacks.
    #[cfg(target_os = "macos")]
    if let Err(e) = direct_exec::prepare(
        &mut cmd,
        prepared
            .env
            .iter()
            .map(|(k, v)| (k.into(), v.into()))
            .collect(),
    ) {
        return ProcessResult::failure(e);
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) if cfg!(target_os = "macos") && e.raw_os_error() == Some(8) => {
            return ProcessResult::failure("spawn ENOEXEC");
        }
        Err(e) => return ProcessResult::failure(e),
    };
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let code = status.code().unwrap_or(128);
                return ProcessResult {
                    exit_code: code,
                    stdout: String::new(),
                    stderr: if code == 0 {
                        String::new()
                    } else {
                        format!("{} exited with code {code} during startup", command[0])
                    },
                };
            }
            Err(e) => return ProcessResult::failure(e),
            Ok(None) => {}
        }
        if start.elapsed() >= Duration::from_millis(300) {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    // Reap if this embedding process lives on; the thread does not delay process exit.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    ProcessResult {
        exit_code: 0,
        stdout: String::new(),
        stderr: String::new(),
    }
}
