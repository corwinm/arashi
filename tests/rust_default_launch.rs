//! Black-box consumer acceptance. All children use disposable HOME and launch binaries.
#![cfg(unix)]
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    home: PathBuf,
    bin: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = arashi::paths::canonicalize(temp.path())
            .unwrap()
            .join("workspace");
        let home = temp.path().join("home");
        let bin = temp.path().join("bin");
        for p in [&root, &home, &bin] {
            fs::create_dir(p).unwrap();
        }
        let f = Self {
            _temp: temp,
            root,
            home,
            bin,
        };
        f.git(&["init", "-b", "main"]);
        fs::write(f.root.join("seed"), "seed\n").unwrap();
        f.git(&["add", "seed"]);
        f.git(&[
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-m",
            "seed",
        ]);
        fs::create_dir(f.root.join(".arashi")).unwrap();
        f.config(serde_json::json!({}));
        f
    }
    fn config(&self, defaults: serde_json::Value) {
        fs::write(self.root.join(".arashi/config.json"), serde_json::json!({"version":"1.0.0","reposDir":"repos","worktreesDir":".arashi/worktrees","repos":{},"defaults":defaults}).to_string()).unwrap();
    }
    fn git(&self, args: &[&str]) -> String {
        let o = Command::new("git")
            .args(args)
            .current_dir(&self.root)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8(o.stdout).unwrap()
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_arashi"));
        c.args(args)
            .current_dir(&self.root)
            .env_clear()
            .env("HOME", &self.home)
            .env("PATH", format!("{}:/usr/bin:/bin", self.bin.display()))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.home.join("gitconfig"));
        c
    }
    fn run(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }
    fn unchanged(&self, refs: &str) {
        assert_eq!(self.git(&["show-ref"]), refs);
        assert!(!self.root.join(".arashi/worktrees").exists());
    }
    #[cfg(unix)]
    fn executable(&self, name: &str, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        let p = self.bin.join(name);
        fs::write(&p, body).unwrap();
        fs::set_permissions(p, fs::Permissions::from_mode(0o755)).unwrap();
    }
}
fn success(o: &Output) {
    assert!(
        o.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    );
}
#[test]
#[ignore = "retained-source process and controlling-PTY oracle"]
fn retained_source_consumer_oracles() {
    if std::env::var("ARASHI_TS_PARITY").as_deref() != Ok("1") {
        return;
    }
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let lookup = Command::new("which").arg("bun").output().unwrap();
    success(&lookup);
    let bun = String::from_utf8(lookup.stdout).unwrap().trim().to_owned();
    let source = repo.join("src/index.ts");
    let native = env!("CARGO_BIN_EXE_arashi");
    let artifact = repo.join("target/default-launch-oracle-tests");
    fs::create_dir_all(&artifact).unwrap();
    let mut matrix = Vec::new();
    for (label, command) in [
        ("source", vec![bun.as_str(), source.to_str().unwrap()]),
        ("native", vec![native]),
    ] {
        for script in ["matrix", "pty"] {
            let o = Command::new("python3")
                .arg(repo.join(format!("tests/rust/default-launch-{script}.py")))
                .args(&command)
                .output()
                .unwrap();
            fs::write(artifact.join(format!("{label}-{script}.json")), &o.stdout).unwrap();
            fs::write(artifact.join(format!("{label}-{script}.stderr")), &o.stderr).unwrap();
            success(&o);
            let rows: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
            if script == "matrix" {
                matrix.push(rows);
            } else {
                assert_eq!(rows.as_array().unwrap().len(), 8);
                assert!(rows.as_array().unwrap().iter().all(|r| r["passed"] == true));
            }
        }
    }
    let source = matrix[0].as_array().unwrap();
    let native = matrix[1].as_array().unwrap();
    assert_eq!(source.len(), 27);
    assert_eq!(native.len(), source.len());
    for (s, n) in source.iter().zip(native) {
        for field in [
            "case",
            "exit",
            "branches",
            "calls",
            "directive",
            "config_unchanged",
        ] {
            assert_eq!(s[field], n[field], "{} field {field}", s["case"]);
        }
        assert_eq!(s["config_unchanged"], true);
        assert_ne!(s["exit"], 124, "oracle timed out: {}", s["case"]);
        if s["case"].as_str().unwrap().starts_with("switch-") {
            assert_eq!(
                s["stdout"].as_str().unwrap().replace("[OK] ", ""),
                n["stdout"].as_str().unwrap(),
                "{} stdout",
                s["case"]
            );
        }
    }
}

#[test]
fn standalone_repository_selection_rejects_before_mutation() {
    for selection in ["--interactive", "--only=workspace", "--group=unused"] {
        let f = Fixture::new();
        fs::remove_file(f.root.join(".arashi/config.json")).unwrap();
        fs::remove_dir(f.root.join(".arashi")).unwrap();
        fs::create_dir(f.root.join(".worktrees")).unwrap();
        fs::write(f.root.join(".git/info/exclude"), ".worktrees/\n").unwrap();
        let refs = f.git(&["show-ref"]);
        let o = f.run(&[
            "create",
            "topic",
            selection,
            "--no-hooks",
            "--no-launch",
            "--no-switch",
        ]);
        assert_eq!(o.status.code(), Some(1), "{selection}: {o:?}");
        assert!(
            String::from_utf8_lossy(&o.stderr)
                .contains("Repository selection is not meaningful in standalone mode"),
            "{selection}: {o:?}"
        );
        assert_eq!(f.git(&["show-ref"]), refs);
        assert!(
            fs::read_dir(f.root.join(".worktrees"))
                .unwrap()
                .next()
                .is_none()
        );
    }
}

#[test]
fn no_launch_create_tolerates_non_unicode_environment() {
    use std::os::unix::ffi::OsStringExt;
    let f = Fixture::new();
    let o = f
        .command(&[
            "create",
            "topic",
            "--json",
            "--dry-run",
            "--no-hooks",
            "--no-launch",
            "--no-switch",
        ])
        .env(
            "ARASHI_NON_UNICODE",
            std::ffi::OsString::from_vec(vec![0xff]),
        )
        .output()
        .unwrap();
    success(&o);
    let json: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
    assert!(json.is_object(), "{json}");
}

#[test]
fn switch_all_skips_missing_configured_clones() {
    let f = Fixture::new();
    let path = f.root.join(".arashi/config.json");
    let mut config: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    config["repos"] = serde_json::json!({"missing":{"path":"repos/missing"}});
    fs::write(path, config.to_string()).unwrap();
    success(&f.run(&["switch", "main", "--all", "--cd"]));
}
#[cfg(unix)]
#[test]
fn generated_bash_wrapper_switches_and_removes_directive() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let target = f
        .root
        .parent()
        .unwrap()
        .join("quote ' dollar $ semi ; topic");
    f.git(&["worktree", "add", "-b", "topic", target.to_str().unwrap()]);
    symlink(env!("CARGO_BIN_EXE_arashi"), f.bin.join("arashi")).unwrap();
    let init = f.run(&["shell", "init", "bash"]);
    success(&init);
    let script = format!(
        "{}\narashi switch --path \"$TARGET\" --cd || exit; printf 'PWD=%s\n' \"$PWD\"; test -z \"${{ARASHI_DIRECTIVE_FILE-}}\"",
        String::from_utf8(init.stdout).unwrap()
    );
    let output = Command::new("/bin/bash")
        .args(["--noprofile", "--norc", "-c", &script])
        .current_dir(&f.root)
        .env_clear()
        .env("HOME", &f.home)
        .env("PATH", format!("{}:/usr/bin:/bin", f.bin.display()))
        .env("TARGET", &target)
        .env("TMPDIR", &f.home)
        .output()
        .unwrap();
    success(&output);
    assert!(String::from_utf8_lossy(&output.stdout).contains(&format!("PWD={}", target.display())));
    assert!(fs::read_dir(&f.home).unwrap().next().is_none());
}

#[test]
fn create_launch_context_error_uses_create_exit_policy() {
    let f = Fixture::new();
    let refs = f.git(&["show-ref"]);
    let o = f.run(&["create", "topic", "--tmux", "--no-hooks"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&o.stderr).contains("requires an active tmux"));
    f.unchanged(&refs);
}
#[test]
fn deprecated_switch_flags_warn_and_preserve_cd_behavior() {
    let f = Fixture::new();
    let o = f.run(&["switch", "main", "--cd", "--no-default-launch"]);
    success(&o);
    assert!(String::from_utf8_lossy(&o.stderr).contains("--no-default-launch is deprecated"));
}
#[cfg(unix)]
#[test]
fn configured_create_launch_is_literal_and_failure_preserves_created_ref() {
    for fail in [false, true] {
        let f = Fixture::new();
        f.config(serde_json::json!({"create":{"launch":"auto"}}));
        f.executable(
            "code",
            &format!(
                "#!/bin/sh\nprintf '%s\n' \"$PWD\" \"$@\" > \"$CANARY\"\nexit {}\n",
                if fail { 7 } else { 0 }
            ),
        );
        let canary = f.home.join("launch");
        let o = f
            .command(&["create", "topic", "--no-hooks"])
            .env("TERM_PROGRAM", "vscode")
            .env("CANARY", &canary)
            .output()
            .unwrap();
        assert_eq!(o.status.success(), !fail, "{:?}", o);
        assert!(f.git(&["show-ref", "--heads"]).contains("refs/heads/topic"));
        let path = f.root.join(".arashi/worktrees/topic");
        assert_eq!(
            fs::read_to_string(canary).unwrap(),
            format!("{}\n--new-window\n{}\n", path.display(), path.display())
        );
    }
}

#[test]
fn ordinary_configured_create_needs_no_suppression_flags() {
    let f = Fixture::new();
    let o = f.run(&["create", "topic", "--no-hooks"]);
    success(&o);
    assert!(f.git(&["show-ref", "--heads"]).contains("refs/heads/topic"));
}
#[test]
fn explicit_tmux_switch_reaches_context_preflight() {
    let f = Fixture::new();
    let o = f.run(&["switch", "main", "--tmux"]);
    assert_eq!(o.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&o.stderr).contains("requires an active tmux"),
        "{:?}",
        o
    );
}
#[test]
fn configured_launch_json_rejects_before_mutation() {
    let f = Fixture::new();
    f.config(serde_json::json!({"create":{"launch":"auto","switch":false}}));
    let refs = f.git(&["show-ref"]);
    let o = f.run(&["create", "topic", "--json", "--no-hooks"]);
    assert!(!o.status.success());
    assert!(
        String::from_utf8_lossy(&o.stdout).contains("JSON_UNSUPPORTED_FOR_MODE"),
        "{:?}",
        o
    );
    f.unchanged(&refs);
}
#[cfg(unix)]
#[test]
fn explicit_ide_launch_uses_real_literal_argv_and_no_directive() {
    let f = Fixture::new();
    let canary = f.home.join("launch");
    let directive = f.home.join("directive");
    f.executable(
        "code",
        "#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"$@\" > \"$CANARY\"\n",
    );
    let o = f
        .command(&["switch", "main", "--vscode"])
        .env("CANARY", &canary)
        .env("ARASHI_DIRECTIVE_FILE", &directive)
        .env("ARASHI_SHELL", "bash")
        .output()
        .unwrap();
    success(&o);
    let bytes = fs::read_to_string(canary).unwrap();
    assert!(bytes.contains(f.root.to_str().unwrap()));
    assert!(!directive.exists());
}
