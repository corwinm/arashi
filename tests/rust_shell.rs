use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);
#[cfg(not(windows))]
const START: &str = "# >>> arashi shell integration >>>";
#[cfg(not(windows))]
const END: &str = "# <<< arashi shell integration <<<";

struct Home(PathBuf);

impl Home {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "arashi-rust-shell-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn run(&self, shell: &str, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_arashi"))
            .args(args)
            .current_dir(&self.0)
            .env("HOME", &self.0)
            .env("USERPROFILE", &self.0)
            .env("SHELL", shell)
            .env("NO_COLOR", "1")
            .output()
            .unwrap()
    }

    #[cfg(not(windows))]
    fn path(&self, relative: &str) -> PathBuf {
        self.0.join(relative)
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn assert_success(output: &Output) {
    assert!(
        output.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn assert_home_files(home: &Path, expected: &[&str]) {
    fn visit(root: &Path, path: &Path, files: &mut Vec<String>) {
        for entry in fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            let kind = entry.file_type().unwrap();
            if kind.is_dir() {
                visit(root, &entry.path(), files);
            } else {
                files.push(
                    entry
                        .path()
                        .strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
    }
    let mut files = Vec::new();
    visit(home, home, &mut files);
    files.sort();
    assert_eq!(files, expected);
}

#[test]
fn shell_parent_reports_its_command_family_without_mutating_home() {
    let home = Home::new();
    let output = home.run("/bin/zsh", &["shell"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.starts_with("Usage: aw shell [options] [command]\n"));
    for command in ["init", "install", "uninstall"] {
        assert!(stderr.contains(command));
    }
    assert_home_files(&home.0, &[]);
}

#[test]
fn shell_init_matches_retained_source_for_every_supported_shell() {
    let home = Home::new();
    for (shell, expected) in [
        (
            "bash",
            include_bytes!("rust/fixtures/shell/bash.init").as_slice(),
        ),
        (
            "zsh",
            include_bytes!("rust/fixtures/shell/zsh.init").as_slice(),
        ),
        (
            "fish",
            include_bytes!("rust/fixtures/shell/fish.init").as_slice(),
        ),
    ] {
        let output = home.run("/bin/unused", &["shell", "init", shell]);
        assert_success(&output);
        assert_eq!(output.stdout, expected);
        assert!(output.stderr.is_empty());
    }
    assert_home_files(&home.0, &[]);
}

#[test]
fn shell_init_rejects_powershell_and_json_without_mutating_home() {
    let home = Home::new();
    let output = home.run("powershell.exe", &["shell", "init", "powershell"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8(output.stderr).unwrap(),
        "[ERR] Unsupported shell `powershell`. Supported shells: bash, zsh, fish.\n"
    );

    let output = home.run("/bin/bash", &["shell", "init", "--json"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stderr.is_empty());
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["command"], "shell");
    assert_eq!(value["error"]["code"], "JSON_UNSUPPORTED_FOR_MODE");
    assert_eq!(value["error"]["details"]["mode"], "init");
    assert_home_files(&home.0, &[]);
}

#[cfg(not(windows))]
#[test]
fn shell_install_upgrades_exact_block_and_is_idempotent() {
    let home = Home::new();
    let profile = home.path(".zshrc");
    let prefix = b"# before\n\n\t\n";
    let suffix = b"\n  \n\n# after\n";
    let old = b"# >>> arashi shell integration >>>\neval \"$(arashi shell init zsh)\"\n# <<< arashi shell integration <<<";
    let mut original = prefix.to_vec();
    original.extend_from_slice(old);
    original.extend_from_slice(suffix);
    fs::write(&profile, &original).unwrap();

    let first = home.run("/bin/zsh", &["shell", "install"]);
    assert_success(&first);
    let once = fs::read(&profile).unwrap();
    assert!(once.starts_with(prefix));
    assert!(once.ends_with(suffix));
    assert!(
        once.windows(b"command arashi shell init zsh".len())
            .any(|v| v == b"command arashi shell init zsh")
    );
    assert!(
        once.windows(b"command arashi completion zsh".len())
            .any(|v| v == b"command arashi completion zsh")
    );

    let second = home.run("/bin/zsh", &["shell", "install"]);
    assert_success(&second);
    assert_eq!(fs::read(&profile).unwrap(), once);
    assert_home_files(&home.0, &[".zshrc"]);
}

#[cfg(not(windows))]
#[test]
fn shell_install_creates_fish_parent_and_refuses_symlinks() {
    let home = Home::new();
    let output = home.run("/opt/bin/fish", &["shell", "install"]);
    assert_success(&output);
    let config = home.path(".config/fish/config.fish");
    let bytes = fs::read(&config).unwrap();
    assert!(
        bytes
            .windows(b"command arashi shell init fish | source".len())
            .any(|v| v == b"command arashi shell init fish | source")
    );

    #[cfg(unix)]
    {
        let linked_home = Home::new();
        let victim = linked_home.path("victim");
        fs::write(&victim, b"outside\n").unwrap();
        std::os::unix::fs::symlink(&victim, linked_home.path(".zshrc")).unwrap();
        let output = linked_home.run("/bin/zsh", &["shell", "install"]);
        assert_eq!(output.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&output.stderr).contains("symbolic link"));
        assert_eq!(fs::read(&victim).unwrap(), b"outside\n");
    }
}

#[cfg(unix)]
#[test]
fn shell_install_rolls_back_when_same_directory_replacement_cannot_start() {
    use std::os::unix::fs::PermissionsExt;

    let home = Home::new();
    let profile = home.path(".zshrc");
    let contents = b"# existing\n";
    fs::write(&profile, contents).unwrap();
    fs::set_permissions(&home.0, fs::Permissions::from_mode(0o500)).unwrap();

    let output = home.run("/bin/zsh", &["shell", "install"]);

    fs::set_permissions(&home.0, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(fs::read(&profile).unwrap(), contents);
    assert_home_files(&home.0, &[".zshrc"]);
}

#[cfg(not(windows))]
#[test]
fn shell_install_rejects_ambiguous_markers_without_changing_bytes() {
    let home = Home::new();
    let profile = home.path(".zshrc");
    let contents = format!("{START}\none\n{END}\n{START}\ntwo\n{END}\n").into_bytes();
    fs::write(&profile, &contents).unwrap();
    let output = home.run("/bin/zsh", &["shell", "install"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("Ambiguous"));
    assert_eq!(fs::read(profile).unwrap(), contents);
}

#[cfg(not(windows))]
#[test]
fn shell_uninstall_dry_run_and_consent_are_nonmutating() {
    let home = Home::new();
    let profile = home.path(".zshrc");
    let contents = format!("before\n{START}\nowned\n{END}\nafter\n").into_bytes();
    fs::write(&profile, &contents).unwrap();

    let dry = home.run("/bin/zsh", &["shell", "uninstall", "--dry-run"]);
    assert_success(&dry);
    assert!(String::from_utf8_lossy(&dry.stdout).contains("Remove the exact managed"));
    assert_eq!(fs::read(&profile).unwrap(), contents);

    let no_consent = home.run("/bin/zsh", &["shell", "uninstall"]);
    assert_eq!(no_consent.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&no_consent.stderr).contains("requires --yes"));
    assert_eq!(fs::read(profile).unwrap(), contents);
}

#[cfg(not(windows))]
#[test]
fn shell_uninstall_preserves_every_byte_outside_the_exact_range() {
    let home = Home::new();
    let profile = home.path(".zshrc");
    let mut contents = vec![0xff, b'\n'];
    contents.extend_from_slice(format!("{START}\r\nowned\r\n{END}").as_bytes());
    contents.extend_from_slice(&[b'\n', 0x80]);
    fs::write(&profile, &contents).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&profile, fs::Permissions::from_mode(0o640)).unwrap();
    }

    let output = home.run("/bin/zsh", &["shell", "uninstall", "--yes"]);
    assert_success(&output);
    assert_eq!(fs::read(&profile).unwrap(), [0xff, b'\n', b'\n', 0x80]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(profile).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }
}

#[cfg(not(windows))]
#[test]
fn shell_uninstall_preflights_all_candidates_before_writing() {
    let home = Home::new();
    let removable = format!("{START}\nowned\n{END}\n").into_bytes();
    let malformed = format!("{START}\norphan\n").into_bytes();
    fs::write(home.path(".bashrc"), &removable).unwrap();
    fs::write(home.path(".bash_profile"), &malformed).unwrap();

    let output = home.run("/bin/bash", &["shell", "uninstall", "--yes"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("marker state"));
    assert_eq!(fs::read(home.path(".bashrc")).unwrap(), removable);
    assert_eq!(fs::read(home.path(".bash_profile")).unwrap(), malformed);
}

#[cfg(unix)]
#[test]
fn shell_uninstall_preserves_symlink_targets() {
    let home = Home::new();
    let victim = home.path("victim");
    let contents = format!("{START}\nowned\n{END}\n").into_bytes();
    fs::write(&victim, &contents).unwrap();
    std::os::unix::fs::symlink(&victim, home.path(".zshrc")).unwrap();

    let output = home.run("/bin/zsh", &["shell", "uninstall", "--yes"]);
    assert_success(&output);
    assert!(String::from_utf8_lossy(&output.stdout).contains("Preserve shell startup candidate"));
    assert_eq!(fs::read(victim).unwrap(), contents);
}

#[cfg(not(windows))]
#[test]
fn shell_live_source_parity_in_disposable_home() {
    if std::env::var_os("ARASHI_TS_PARITY").is_none() {
        return;
    }
    let home = Home::new();
    let source = |args: &[&str]| {
        Command::new("node")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"))
            .args(args)
            .current_dir(&home.0)
            .env("HOME", &home.0)
            .env("USERPROFILE", &home.0)
            .env("SHELL", "/bin/zsh")
            .env("NO_COLOR", "1")
            .output()
            .unwrap()
    };
    for shell in ["bash", "zsh", "fish"] {
        let args = ["shell", "init", shell];
        let actual = home.run("/bin/zsh", &args);
        let expected = source(&args);
        assert_success(&actual);
        assert_eq!(actual.status.code(), expected.status.code());
        assert_eq!(actual.stdout, expected.stdout);
        assert_eq!(actual.stderr, expected.stderr);
    }
    let path = home.path(".zshrc");
    for args in [
        vec!["shell", "install"],
        vec!["shell", "uninstall", "--dry-run"],
        vec!["shell", "uninstall", "--yes"],
    ] {
        let before = fs::read(&path).unwrap_or_default();
        let actual = home.run("/bin/zsh", &args);
        let after = fs::read(&path).unwrap();
        fs::write(&path, &before).unwrap();
        let expected = source(&args);
        assert_success(&actual);
        assert_eq!(actual.status.code(), expected.status.code());
        assert_eq!(actual.stdout, expected.stdout);
        assert_eq!(actual.stderr, expected.stderr);
        assert_eq!(fs::read(&path).unwrap(), after);
    }
    assert_home_files(&home.0, &[".zshrc"]);
}

#[cfg(target_os = "macos")]
#[test]
fn installed_zsh_wrapper_and_completion_work_together_without_leaking_directives() {
    let home = Home::new();
    fs::write(home.path(".zshrc"), b"").unwrap();
    assert_success(&home.run("/bin/zsh", &["shell", "install"]));
    let bin = Path::new(env!("CARGO_BIN_EXE_arashi")).parent().unwrap();
    let mut paths = vec![bin.to_path_buf()];
    paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap()));
    let output = Command::new("/bin/zsh")
        .args(["-f", "-c", "autoload -Uz compinit; compinit -D; source \"$HOME/.zshrc\"; (( $+functions[arashi] && $+functions[aw] )) && [[ $_comps[arashi] == _arashi ]] && arashi --version"])
        .env("HOME", &home.0)
        .env("USERPROFILE", &home.0)
        .env("TMPDIR", &home.0)
        .env("PATH", std::env::join_paths(paths).unwrap())
        .env_remove("ARASHI_DIRECTIVE_FILE")
        .current_dir(&home.0)
        .output().unwrap();
    assert_success(&output);
    assert!(output.stderr.is_empty(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains(env!("CARGO_PKG_VERSION")));
    assert_home_files(&home.0, &[".zshrc"]);
}

#[cfg(windows)]
#[test]
fn shell_mutation_fails_closed_on_windows() {
    let home = Home::new();
    for args in [
        &["shell", "install"][..],
        &["shell", "uninstall", "--yes"][..],
    ] {
        let output = home.run("C:\\Windows\\System32\\bash.exe", args);
        assert_eq!(output.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&output.stderr).contains("not supported on Windows"));
    }
    assert_home_files(&home.0, &[]);
}
