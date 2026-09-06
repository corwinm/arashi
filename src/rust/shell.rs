use crate::{Error, Result, cli::Args};
use serde_json::{Value, json};
use std::{
    env,
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const START_MARKER: &[u8] = b"# >>> arashi shell integration >>>";
const END_MARKER: &[u8] = b"# <<< arashi shell integration <<<";
static NEXT_TEMPORARY: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Shell {
    Bash,
    Zsh,
    Fish,
}

impl Shell {
    fn name(self) -> &'static str {
        match self {
            Self::Bash => "bash",
            Self::Zsh => "zsh",
            Self::Fish => "fish",
        }
    }
}

#[derive(Debug)]
enum UninstallPlan {
    Unsafe {
        path: PathBuf,
        diagnostic: &'static str,
    },
    Remove {
        path: PathBuf,
        current: Vec<u8>,
        next: Vec<u8>,
        metadata: Metadata,
    },
}

pub fn execute(args: &Args) -> Result<Value> {
    match args.command.as_str() {
        "shell" => {
            args.only(&[])?;
            if !args.positional.is_empty() {
                return Err(usage(format!(
                    "Unknown shell subcommand: {}",
                    args.positional[0]
                )));
            }
            Err(Error::new("SHELL_HELP", parent_help()))
        }
        "shell init" => init(args),
        "shell install" => install(args),
        "shell uninstall" => uninstall(args),
        _ => unreachable!("shell dispatch only receives shell commands"),
    }
}

fn parent_help() -> &'static str {
    "Usage: aw shell [options] [command]\n\nManage shell integration for parent-shell switching\n\nOptions:\n  -h, --help              display help for command\n\nCommands:\n  init [options] [shell]  Print shell wrapper code\n  uninstall [options]     Remove exact managed shell integration\n  install                 Install shell integration into the active shell\n                          startup file\n  help [command]          display help for command\n"
}

fn init(args: &Args) -> Result<Value> {
    args.only(&[])?;
    if args.has("json") {
        return Err(Error::new(
            "JSON_UNSUPPORTED_FOR_MODE",
            "JSON output is not supported for init.",
        )
        .with_exit_code(2)
        .with_details(json!({"mode":"init"})));
    }
    if args.positional.len() != 1 {
        return Err(usage(
            "Missing required shell. Supported shells: bash, zsh, fish.",
        ));
    }
    let supplied = &args.positional[0];
    let shell = parse_shell(supplied).ok_or_else(|| {
        usage(format!(
            "Unsupported shell `{supplied}`. Supported shells: bash, zsh, fish."
        ))
    })?;
    Ok(json!({"action":"init","script":build_init_script(shell)}))
}

fn install(args: &Args) -> Result<Value> {
    args.only(&[])?;
    if !args.positional.is_empty() {
        return Err(usage("shell install takes no arguments"));
    }
    reject_windows_mutation()?;
    let shell = detect_shell("install")?;
    let home = home_directory("install")?;
    let path = resolve_startup_file(&home, shell)?;
    let block = install_block(shell);

    let existing = match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(usage(format!(
                    "Shell startup target is a symbolic link: {}",
                    path.display()
                )));
            }
            if !metadata.is_file() {
                return Err(usage(format!(
                    "Shell startup target is not a regular file: {}",
                    path.display()
                )));
            }
            Some((read_checked(&path, &metadata)?, metadata))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    let current = existing
        .as_ref()
        .map_or_else(Vec::new, |(bytes, _)| bytes.clone());
    let next = upsert_block(&current, block.as_bytes())?;
    let updated = current != next;
    if updated {
        atomic_replace(&home, &path, existing.as_ref().map(|(_, metadata)| metadata), &current, &next)
            .map_err(|_| {
                usage(format!(
                    "Unable to write {}. Use `arashi shell init {}` and `arashi completion {}` for manual setup.",
                    path.display(),
                    shell.name(),
                    shell.name()
                ))
            })?;
    }
    Ok(json!({
        "action":"install",
        "created":existing.is_none(),
        "shell":shell.name(),
        "startupFilePath":path,
        "updated":updated
    }))
}

fn uninstall(args: &Args) -> Result<Value> {
    args.only(&["dry-run", "yes"])?;
    if !args.positional.is_empty() {
        return Err(usage("shell uninstall takes no arguments"));
    }
    reject_windows_mutation()?;
    let shell = detect_shell("uninstall")?;
    let home = home_directory("uninstall")?;
    let mut plans = Vec::new();
    for path in startup_candidates(&home, shell) {
        if let Some(plan) = plan_uninstall(path)? {
            plans.push(plan);
        }
    }

    let removable = plans
        .iter()
        .filter(|plan| matches!(plan, UninstallPlan::Remove { .. }))
        .count();
    if !args.has("dry-run") && removable > 0 && !args.has("yes") {
        return Err(usage_with_details(
            "Non-interactive shell uninstall requires --yes.",
            json!({"action":"uninstall","plans":plans_to_json(&plans, false)}),
        ));
    }
    if !args.has("dry-run") && removable > 1 {
        return Err(usage(
            "Multiple managed startup files require separate removal; no changes made.",
        ));
    }
    if !args.has("dry-run") {
        for plan in &plans {
            if let UninstallPlan::Remove {
                path,
                current,
                next,
                metadata,
            } = plan
            {
                atomic_replace(&home, path, Some(metadata), current, next)?;
            }
        }
    }
    Ok(json!({
        "action":"uninstall",
        "plans":plans_to_json(&plans, plans.is_empty()),
    }))
}

fn usage(message: impl Into<String>) -> Error {
    Error::new("USAGE", message).with_exit_code(2)
}

fn usage_with_details(message: impl Into<String>, details: Value) -> Error {
    usage(message).with_details(details)
}

#[cfg(windows)]
fn reject_windows_mutation() -> Result<()> {
    Err(usage(
        "Automatic shell startup-file mutation is not supported on Windows; no changes made.",
    ))
}

#[cfg(not(windows))]
fn reject_windows_mutation() -> Result<()> {
    Ok(())
}

fn parse_shell(value: &str) -> Option<Shell> {
    match value.trim().to_lowercase().as_str() {
        "bash" => Some(Shell::Bash),
        "zsh" => Some(Shell::Zsh),
        "fish" => Some(Shell::Fish),
        _ => None,
    }
}

fn detect_shell(operation: &str) -> Result<Shell> {
    let value = env::var("SHELL").unwrap_or_default();
    let name = Path::new(value.trim())
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    parse_shell(name).ok_or_else(|| {
        let suffix = if operation == "install" {
            " Use `arashi shell init <bash|zsh|fish>` for manual setup. Then run `arashi completion <bash|zsh|fish>` to activate completion."
        } else {
            ""
        };
        usage(format!(
            "Unable to detect a supported shell for `arashi shell {operation}`.{suffix}"
        ))
    })
}

fn home_directory(operation: &str) -> Result<PathBuf> {
    env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
        .ok_or_else(|| {
            usage(format!(
                "Unable to determine a home directory for `arashi shell {operation}`."
            ))
        })
}

fn startup_candidates(home: &Path, shell: Shell) -> Vec<PathBuf> {
    match shell {
        Shell::Bash => {
            #[cfg(target_os = "macos")]
            let names = [".bash_profile", ".bashrc", ".profile"];
            #[cfg(not(target_os = "macos"))]
            let names = [".bashrc", ".bash_profile", ".profile"];
            names.into_iter().map(|name| home.join(name)).collect()
        }
        Shell::Zsh => vec![home.join(".zshrc")],
        Shell::Fish => vec![home.join(".config/fish/config.fish")],
    }
}

fn resolve_startup_file(home: &Path, shell: Shell) -> Result<PathBuf> {
    let candidates = startup_candidates(home, shell);
    for candidate in &candidates {
        match fs::symlink_metadata(candidate) {
            Ok(_) => return Ok(candidate.clone()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    candidates.into_iter().next().ok_or_else(|| {
        usage(format!(
            "Unable to determine a writable startup file for {}.",
            shell.name()
        ))
    })
}

fn install_block(shell: Shell) -> String {
    let body = match shell {
        Shell::Fish => {
            "command arashi shell init fish | source\ncommand arashi completion fish | source"
                .to_string()
        }
        _ => format!(
            "eval \"$(command arashi shell init {})\"\nsource <(command arashi completion {})",
            shell.name(),
            shell.name()
        ),
    };
    format!(
        "{}\n{body}\n{}",
        String::from_utf8_lossy(START_MARKER),
        String::from_utf8_lossy(END_MARKER)
    )
}

fn build_init_script(shell: Shell) -> String {
    if shell == Shell::Fish {
        let function = |name: &str| {
            format!(
                "function {name} --wraps {name} --description \"Run arashi with shell integration\"\n    # arashi-managed-shell-wrapper:{name}:v1\n    set -l tmp_root /tmp\n    if test -n \"$TMPDIR\"\n        set tmp_root $TMPDIR\n    end\n\n    set -l directive_file (mktemp \"$tmp_root/arashi-directive.XXXXXX\")\n    if test -z \"$directive_file\"\n        return 1\n    end\n\n    set -lx ARASHI_DIRECTIVE_FILE \"$directive_file\"\n    set -lx ARASHI_SHELL fish\n    command {name} $argv\n    set -l status_code $status\n\n    if test -s \"$directive_file\"\n        source \"$directive_file\"\n    end\n\n    rm -f \"$directive_file\"\n    return $status_code\nend\n"
            )
        };
        return format!(
            "{}\nif not functions -q aw; or functions aw | string match -q '*arashi-managed-shell-wrapper:aw:v1*'\n{}end\n",
            function("arashi"),
            function("aw")
        );
    }

    let name = shell.name();
    let function = |command: &str| {
        format!(
            "{command}() {{\n  : arashi-managed-shell-wrapper:{command}:v1\n  local directive_file status_code\n  directive_file=\"$(mktemp \"${{TMPDIR:-/tmp}}/arashi-directive.XXXXXX\")\" || return 1\n\n  ARASHI_DIRECTIVE_FILE=\"$directive_file\" ARASHI_SHELL={name} command {command} \"$@\"\n  status_code=$?\n\n  if [ -s \"$directive_file\" ]; then\n    . \"$directive_file\"\n  fi\n\n  rm -f \"$directive_file\"\n  return \"$status_code\"\n}}\n"
        )
    };
    let guard = if shell == Shell::Zsh {
        format!(
            "if (( ! ${{+aliases[aw]}} )); then\n  if (( ! ${{+functions[aw]}} )) || [[ \"${{functions[aw]}}\" == *arashi-managed-shell-wrapper:aw:v1* ]]; then\n{}  fi\nfi",
            function("aw")
        )
    } else {
        format!(
            "if ! alias aw >/dev/null 2>&1 && {{ ! declare -F aw >/dev/null 2>&1 || declare -f aw | grep -Fq arashi-managed-shell-wrapper:aw:v1; }}; then\n{}fi",
            function("aw")
        )
    };
    format!("{}\n{guard}\n", function("arashi"))
}

fn marker_lines(contents: &[u8], marker: &[u8]) -> Vec<usize> {
    occurrences(contents, marker)
        .into_iter()
        .filter(|offset| {
            let starts_line = *offset == 0 || contents[*offset - 1] == b'\n';
            let after = *offset + marker.len();
            let ends_line = after == contents.len()
                || contents[after] == b'\n'
                || (contents[after] == b'\r' && contents.get(after + 1).copied() == Some(b'\n'));
            starts_line && ends_line
        })
        .collect()
}

fn occurrences(contents: &[u8], needle: &[u8]) -> Vec<usize> {
    if needle.is_empty() || contents.len() < needle.len() {
        return Vec::new();
    }
    contents
        .windows(needle.len())
        .enumerate()
        .filter_map(|(offset, value)| (value == needle).then_some(offset))
        .collect()
}

fn upsert_block(current: &[u8], block: &[u8]) -> Result<Vec<u8>> {
    let starts = marker_lines(current, START_MARKER);
    let ends = marker_lines(current, END_MARKER);
    if (!starts.is_empty() || !ends.is_empty())
        && (starts.len() != 1 || ends.len() != 1 || ends[0] <= starts[0])
    {
        return Err(usage("Ambiguous Arashi shell integration marker state."));
    }
    if starts.len() == 1 {
        let mut next = Vec::with_capacity(current.len() + block.len());
        next.extend_from_slice(&current[..starts[0]]);
        next.extend_from_slice(block);
        next.extend_from_slice(&current[ends[0] + END_MARKER.len()..]);
        return Ok(next);
    }

    let text = std::str::from_utf8(current)
        .map_err(|_| usage("Shell startup file is not valid UTF-8; no changes made."))?;
    let trimmed = text.trim_end();
    if trimmed.is_empty() {
        let mut next = block.to_vec();
        next.push(b'\n');
        return Ok(next);
    }
    let mut next = trimmed.as_bytes().to_vec();
    next.extend_from_slice(b"\n\n");
    next.extend_from_slice(block);
    next.push(b'\n');
    Ok(next)
}

fn plan_uninstall(path: PathBuf) -> Result<Option<UninstallPlan>> {
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() {
        return Ok(Some(UninstallPlan::Unsafe {
            path,
            diagnostic: "symbolic link",
        }));
    }
    if !metadata.is_file() {
        return Ok(Some(UninstallPlan::Unsafe {
            path,
            diagnostic: "not a regular file",
        }));
    }
    let current = read_checked(&path, &metadata)?;
    let starts = marker_lines(&current, START_MARKER);
    let ends = marker_lines(&current, END_MARKER);
    let raw_starts = occurrences(&current, START_MARKER).len();
    let raw_ends = occurrences(&current, END_MARKER).len();
    if raw_starts == 0 && raw_ends == 0 {
        return Ok(None);
    }
    if starts.len() != 1
        || ends.len() != 1
        || raw_starts != 1
        || raw_ends != 1
        || starts[0] >= ends[0]
    {
        return Err(usage(format!(
            "Ambiguous Arashi shell integration marker state in {}.",
            path.display()
        )));
    }
    let mut next = Vec::with_capacity(current.len());
    next.extend_from_slice(&current[..starts[0]]);
    next.extend_from_slice(&current[ends[0] + END_MARKER.len()..]);
    Ok(Some(UninstallPlan::Remove {
        path,
        current,
        next,
        metadata,
    }))
}

fn plans_to_json(plans: &[UninstallPlan], absent: bool) -> Value {
    let rows: Vec<Value> = plans
        .iter()
        .map(|plan| match plan {
            UninstallPlan::Unsafe { path, diagnostic } => json!({
                "diagnostic":diagnostic,
                "startupFilePath":path,
                "status":"preserved-unsafe"
            }),
            UninstallPlan::Remove { path, .. } => json!({
                "startupFilePath":path,
                "status":"removable"
            }),
        })
        .collect();
    json!({"absent":absent,"plans":rows})
}

pub fn render_human(data: &Value) {
    match data["action"].as_str().unwrap_or_default() {
        "init" => print!("{}", data["script"].as_str().unwrap_or_default()),
        "install" => {
            println!(
                "[OK] Installed Arashi shell integration for {} in {}",
                data["shell"].as_str().unwrap_or_default(),
                data["startupFilePath"].as_str().unwrap_or_default()
            );
            println!(
                "Restart your shell or source the startup file to enable switching and completion."
            );
        }
        "uninstall" => {
            let details = &data["plans"];
            if details["absent"] == true {
                println!(
                    "No managed Arashi shell block exists in the deterministic startup files."
                );
            }
            if let Some(plans) = details["plans"].as_array() {
                for plan in plans {
                    let path = plan["startupFilePath"].as_str().unwrap_or_default();
                    if plan["status"] == "removable" {
                        println!("Remove the exact managed Arashi shell block from {path}.");
                    } else {
                        println!(
                            "Preserve shell startup candidate {path}: {}.",
                            plan["diagnostic"].as_str().unwrap_or("unsafe target")
                        );
                    }
                }
            }
        }
        _ => unreachable!("shell action requires renderer"),
    }
}

fn read_checked(path: &Path, expected: &Metadata) -> Result<Vec<u8>> {
    let mut file = open_no_follow(path)?;
    let opened = file.metadata()?;
    if !same_file(expected, &opened) {
        return Err(usage(format!(
            "Shell startup file changed after preflight: {}",
            path.display()
        )));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let latest = fs::symlink_metadata(path)?;
    if latest.file_type().is_symlink() || !latest.is_file() || !same_file(&opened, &latest) {
        return Err(usage(format!(
            "Shell startup file changed after preflight: {}",
            path.display()
        )));
    }
    Ok(bytes)
}

#[cfg(unix)]
fn open_no_follow(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    #[cfg(target_os = "linux")]
    const O_NOFOLLOW: i32 = 0x20000;
    #[cfg(not(target_os = "linux"))]
    const O_NOFOLLOW: i32 = 0x100;
    OpenOptions::new()
        .read(true)
        .custom_flags(O_NOFOLLOW)
        .open(path)
}

#[cfg(not(unix))]
fn open_no_follow(path: &Path) -> std::io::Result<File> {
    File::open(path)
}

#[cfg(unix)]
fn same_file(left: &Metadata, right: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_file(left: &Metadata, right: &Metadata) -> bool {
    left.len() == right.len() && left.modified().ok() == right.modified().ok()
}

fn ensure_safe_parent(home: &Path, parent: &Path) -> Result<()> {
    let home_metadata = fs::symlink_metadata(home)?;
    if home_metadata.file_type().is_symlink() || !home_metadata.is_dir() {
        return Err(usage(format!(
            "Shell home target is not a direct directory: {}",
            home.display()
        )));
    }
    let relative = parent
        .strip_prefix(home)
        .map_err(|_| usage("Shell startup path escapes HOME; no changes made."))?;
    let mut current = home.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(usage(format!(
                        "Shell startup parent is not a direct directory: {}",
                        current.display()
                    )));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current)?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn atomic_replace(
    home: &Path,
    path: &Path,
    expected: Option<&Metadata>,
    current: &[u8],
    next: &[u8],
) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| usage("Shell startup path has no parent."))?;
    ensure_safe_parent(home, parent)?;
    if let Some(metadata) = expected {
        let latest = fs::symlink_metadata(path)?;
        if latest.file_type().is_symlink()
            || !latest.is_file()
            || !same_file(metadata, &latest)
            || read_checked(path, metadata)? != current
        {
            return Err(usage(format!(
                "Shell startup file changed after preflight: {}",
                path.display()
            )));
        }
    } else if fs::symlink_metadata(path).is_ok() {
        return Err(usage(format!(
            "Shell startup file changed after preflight: {}",
            path.display()
        )));
    }

    let temporary = parent.join(format!(
        ".{}.arashi-shell-{}-{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("startup"),
        std::process::id(),
        NEXT_TEMPORARY.fetch_add(1, Ordering::SeqCst)
    ));
    let result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        if let Some(metadata) = expected {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            options.mode(metadata.permissions().mode() & 0o777);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(next)?;
        if let Some(metadata) = expected {
            file.set_permissions(metadata.permissions())?;
        }
        file.sync_all()?;

        if let Some(metadata) = expected {
            let latest = fs::symlink_metadata(path)?;
            if latest.file_type().is_symlink()
                || !latest.is_file()
                || !same_file(metadata, &latest)
                || read_checked(path, metadata)? != current
            {
                return Err(usage(format!(
                    "Shell startup file changed after preflight: {}",
                    path.display()
                )));
            }
        } else if fs::symlink_metadata(path).is_ok() {
            return Err(usage(format!(
                "Shell startup file changed after preflight: {}",
                path.display()
            )));
        }
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
