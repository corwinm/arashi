use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
    root: PathBuf,
    child: Option<PathBuf>,
}

impl Fixture {
    fn directory(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "arashi-handoff-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        arashi::paths::canonicalize(path).unwrap()
    }

    fn repository(path: &Path) {
        fs::create_dir_all(path).unwrap();
        git(path, &["init", "-b", "main"]);
        git(path, &["config", "user.email", "test@example.invalid"]);
        git(path, &["config", "user.name", "Test User"]);
        fs::write(path.join("tracked"), "initial\n").unwrap();
        git(path, &["add", "tracked"]);
        git(path, &["commit", "-m", "initial"]);
    }

    fn configured() -> Self {
        let root = Self::directory("configured");
        Self::repository(&root);
        let child = root.join("repos/child");
        Self::repository(&child);
        fs::create_dir(root.join(".arashi")).unwrap();
        fs::write(
            root.join(".arashi/config.json"),
            r#"{
  "version": "1.0.0",
  "reposDir": "./repos",
  "worktreesDir": "../.worktrees",
  "repos": {
    "child": { "path": "./repos/child" }
  }
}
"#,
        )
        .unwrap();
        fs::write(root.join(".gitignore"), "repos/\n").unwrap();
        git(&root, &["add", ".arashi/config.json", ".gitignore"]);
        git(&root, &["commit", "-m", "configure"]);
        Self {
            root,
            child: Some(child),
        }
    }

    fn standalone_linked() -> (Self, PathBuf) {
        let root = Self::directory("standalone");
        Self::repository(&root);
        fs::create_dir(root.join(".worktrees")).unwrap();
        fs::write(root.join(".git/info/exclude"), ".worktrees/\n").unwrap();
        let linked = root.join(".worktrees/feature");
        git(
            &root,
            &["worktree", "add", "-b", "feature", linked.to_str().unwrap()],
        );
        (Self { root, child: None }, linked)
    }

    fn state(&self) -> Vec<String> {
        std::iter::once(&self.root)
            .chain(self.child.iter())
            .map(|path| {
                [
                    git_output(path, &["rev-parse", "HEAD"]),
                    git_output(path, &["branch", "--show-current"]),
                    git_output(path, &["status", "--porcelain=v1", "--untracked-files=all"]),
                    git_output(path, &["worktree", "list", "--porcelain"]),
                ]
                .join("\n")
            })
            .collect()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn git(cwd: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(["-c", "commit.gpgsign=false", "-c", "maintenance.auto=false"])
        .args(args)
        .current_dir(cwd)
        .env("HOME", cwd)
        .env("USERPROFILE", cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env_remove("ARASHI_DIRECTIVE_FILE")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn git_output(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(["-c", "maintenance.auto=false"])
        .args(args)
        .current_dir(cwd)
        .env("HOME", cwd)
        .env("USERPROFILE", cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env_remove("ARASHI_DIRECTIVE_FILE")
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}: {output:?}");
    String::from_utf8(output.stdout).unwrap()
}

fn native(cwd: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_arashi"))
        .args(args)
        .env_remove("NO_COLOR")
        .current_dir(cwd)
        .env("HOME", cwd)
        .env("USERPROFILE", cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env_remove("ARASHI_DIRECTIVE_FILE")
        .output()
        .unwrap()
}

fn source(cwd: &Path, args: &[&str]) -> Option<Output> {
    std::env::var_os("ARASHI_TS_PARITY")?;
    Some(
        Command::new("node")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"))
            .args(args)
            .env_remove("NO_COLOR")
            .current_dir(cwd)
            .env("HOME", cwd)
            .env("USERPROFILE", cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .env_remove("ARASHI_DIRECTIVE_FILE")
            .output()
            .unwrap(),
    )
}

fn assert_source_parity(cwd: &Path, args: &[&str], actual: &Output) {
    if let Some(expected) = source(cwd, args) {
        assert_eq!(actual.status.code(), expected.status.code(), "{args:?}");
        if actual.stdout != expected.stdout {
            let index = actual
                .stdout
                .iter()
                .zip(&expected.stdout)
                .position(|(left, right)| left != right)
                .unwrap_or_else(|| actual.stdout.len().min(expected.stdout.len()));
            let start = index.saturating_sub(80);
            let actual_end = (index + 80).min(actual.stdout.len());
            let expected_end = (index + 80).min(expected.stdout.len());
            panic!(
                "{args:?} stdout differs at byte {index}; lengths {} != {}; actual={:?}; expected={:?}",
                actual.stdout.len(),
                expected.stdout.len(),
                String::from_utf8_lossy(&actual.stdout[start..actual_end]),
                String::from_utf8_lossy(&expected.stdout[start..expected_end])
            );
        }
        assert_eq!(actual.stderr, expected.stderr, "{args:?} stderr");
    }
}

fn assert_parser_source_parity(cwd: &Path, args: &[&str], actual: &Output) {
    if let Some(expected) = source(cwd, args) {
        assert_eq!(
            actual.status.code(),
            expected.status.code(),
            "{args:?} exit"
        );
        assert_eq!(actual.stdout, expected.stdout, "{args:?} stdout");
        assert_eq!(actual.stderr, expected.stderr, "{args:?} stderr");
    }
}

fn document(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|_| {
        panic!(
            "stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

#[test]
fn configured_json_and_markdown_preserve_source_contract_and_git_state() {
    let fixture = Fixture::configured();
    let child = fixture.child.as_ref().unwrap();
    fs::write(child.join("new file"), "dirty\n").unwrap();
    let before = fixture.state();
    let context = [
        "handoff",
        "--link",
        "https://example.test/issues/1",
        "--link",
        "https://example.test/pulls/2",
        "--validation",
        "cargo test — passed",
        "--todo",
        "watch CI",
        "--risk",
        "Windows pending",
        "--risk",
        "review pending",
        "--next-command",
        "gh pr checks 1",
    ];

    let markdown = native(child, &context);
    assert!(markdown.status.success(), "{markdown:?}");
    assert!(markdown.stderr.is_empty(), "{markdown:?}");
    assert_source_parity(child, &context, &markdown);
    let markdown_text = String::from_utf8(markdown.stdout).unwrap();
    assert!(markdown_text.starts_with("# Arashi Handoff Report\n\n"));
    assert!(markdown_text.contains("child: dirty; branch main; 1 changed file"));
    assert!(markdown_text.contains("- [ ] watch CI"));
    assert!(
        markdown_text.contains("`gh pr checks 1`\n`arashi status`\n`arashi status --verbose`\n")
    );

    let mut json_args = context.to_vec();
    json_args.push("--json");
    let output = native(child, &json_args);
    assert!(output.status.success(), "{output:?}");
    assert!(output.stderr.is_empty(), "{output:?}");
    assert_source_parity(child, &json_args, &output);
    let envelope = document(&output);
    assert_eq!(envelope["command"], "handoff");
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["schemaVersion"], 1);
    assert_eq!(envelope["warnings"], json!([]));
    assert_eq!(envelope["data"]["mode"], "configured");
    assert_eq!(envelope["data"]["effectiveOptions"]["format"], "json");
    assert_eq!(
        envelope["data"]["context"]["links"],
        json!([
            "https://example.test/issues/1",
            "https://example.test/pulls/2"
        ])
    );
    assert_eq!(
        envelope["data"]["summary"],
        json!({"cleanCount":1,"dirtyCount":1,"total":2,"touchedCount":1})
    );
    assert_eq!(fixture.state(), before);
}

#[test]
fn distinct_default_branch_markdown_uses_logical_branch_like_source() {
    let fixture = Fixture::configured();
    let child = fixture.child.as_ref().unwrap();
    let origin = Fixture::directory("distinct-default-origin");
    git(&origin, &["init", "--bare", "-b", "main"]);
    let _origin_fixture = Fixture {
        root: origin.clone(),
        child: None,
    };
    git(
        child,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    git(child, &["push", "-u", "origin", "main"]);
    git(child, &["branch", "release"]);
    git(child, &["push", "origin", "release"]);

    let config_path = fixture.root.join(".arashi/config.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    config["repos"]["child"]["baseBranch"] = json!("release");
    fs::write(config_path, serde_json::to_vec_pretty(&config).unwrap()).unwrap();

    let updater = Fixture::directory("distinct-default-updater");
    fs::remove_dir(&updater).unwrap();
    git(
        fixture.root.parent().unwrap(),
        &["clone", origin.to_str().unwrap(), updater.to_str().unwrap()],
    );
    git(&updater, &["config", "user.email", "test@example.invalid"]);
    git(&updater, &["config", "user.name", "Test User"]);
    fs::write(updater.join("remote-change"), "new\n").unwrap();
    git(&updater, &["add", "remote-change"]);
    git(&updater, &["commit", "-m", "advance default"]);
    git(&updater, &["push", "origin", "main"]);

    let output = native(child, &["handoff"]);
    assert!(output.status.success(), "{output:?}");
    assert_source_parity(child, &["handoff"], &output);
    let markdown = String::from_utf8(output.stdout).unwrap();
    assert!(markdown.contains("default main behind by 1"), "{markdown}");
    assert!(
        !markdown.contains("default origin/main behind by 1"),
        "{markdown}"
    );
    fs::remove_dir_all(updater).unwrap();
}

#[test]
fn missing_configured_repository_paths_match_source_bytes_without_curdir() {
    let fixture = Fixture::configured();
    let child = fixture.child.as_ref().unwrap();
    fs::remove_dir_all(child).unwrap();
    let expected_path = fixture.root.join("repos/child");
    let expected_error = format!(
        "Repository is missing at {}. Run `arashi clone` to clone missing repositories.",
        expected_path.display()
    );

    for args in [&["handoff", "--json"][..], &["status", "--json"][..]] {
        let output = native(&fixture.root, args);
        assert_eq!(output.status.code(), Some(1), "{args:?}: {output:?}");
        if args[0] == "handoff" {
            assert_source_parity(&fixture.root, args, &output);
        }
        let envelope = document(&output);
        let row = &envelope["data"]["repositories"][1];
        assert_eq!(row["path"], json!(expected_path));
        assert_eq!(row["error"], expected_error);
        assert!(!String::from_utf8_lossy(&output.stdout).contains("/./"));
    }
}

#[test]
fn standalone_primary_and_linked_worktrees_preserve_source_contract() {
    let (fixture, linked) = Fixture::standalone_linked();
    fs::write(linked.join("dirty"), "dirty\n").unwrap();
    let before = fixture.state();

    for (cwd, branch) in [(&fixture.root, "main"), (&linked, "feature")] {
        for args in [vec!["handoff"], vec!["handoff", "--json"]] {
            let output = native(cwd, &args);
            assert!(output.status.success(), "{output:?}");
            assert_source_parity(cwd, &args, &output);
            if args.contains(&"--json") {
                let data = &document(&output)["data"];
                assert_eq!(data["mode"], "standalone");
                assert_eq!(data["workspace"]["branch"], branch);
                assert_eq!(data["currentRepository"]["name"], branch);
                assert_eq!(data["summary"]["total"], 2);
                assert!(data.get("worktrees").is_none());
            }
        }
    }
    assert_eq!(fixture.state(), before);
}

#[test]
fn detached_standalone_workspace_branch_matches_source_unknown_fallback() {
    let (_fixture, linked) = Fixture::standalone_linked();
    git(&linked, &["checkout", "--detach"]);

    let output = native(&linked, &["handoff", "--json"]);
    assert!(output.status.success(), "{output:?}");
    assert!(output.stderr.is_empty(), "{output:?}");
    assert_source_parity(&linked, &["handoff", "--json"], &output);
    assert_eq!(document(&output)["data"]["workspace"]["branch"], "unknown");
}

#[test]
fn deleted_upstream_refresh_failure_preserves_source_json_key_order() {
    let origin = Fixture::directory("deleted-upstream-origin");
    git(&origin, &["init", "--bare", "-b", "main"]);
    let _origin_fixture = Fixture {
        root: origin.clone(),
        child: None,
    };
    let (fixture, linked) = Fixture::standalone_linked();
    git(
        &fixture.root,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    git(&fixture.root, &["push", "-u", "origin", "main"]);
    git(&linked, &["push", "-u", "origin", "feature"]);
    git(&fixture.root, &["branch", "deleted-upstream"]);
    git(&fixture.root, &["push", "origin", "deleted-upstream"]);
    git(
        &fixture.root,
        &["remote", "set-head", "origin", "deleted-upstream"],
    );
    git(&origin, &["branch", "-D", "deleted-upstream"]);

    let output = native(&linked, &["handoff", "--json"]);
    assert!(output.status.success(), "{output:?}");
    assert!(output.stderr.is_empty(), "{output:?}");
    assert_source_parity(&linked, &["handoff", "--json"], &output);

    let markdown = native(&linked, &["handoff"]);
    assert_source_parity(&linked, &["handoff"], &markdown);
    let markdown_text = String::from_utf8(markdown.stdout).unwrap();
    assert!(markdown_text.contains("default deleted-upstream unavailable"));
    assert!(!markdown_text.contains("configured default deleted-upstream unavailable"));

    let text = String::from_utf8(output.stdout).unwrap();
    let start = text.find("\"defaultBranch\": {").unwrap();
    let end = text[start..].find("\n        \"error\":").unwrap() + start;
    let comparison = &text[start..end];
    let positions = [
        "\"remote\"",
        "\"remoteRef\"",
        "\"details\"",
        "\"message\"",
        "\"reason\"",
    ]
    .map(|key| comparison.find(key).unwrap());
    assert!(
        positions.windows(2).all(|pair| pair[0] < pair[1]),
        "{comparison}"
    );
}

#[test]
fn deprecated_markdown_is_hidden_and_json_suppresses_its_warning() {
    let fixture = Fixture::configured();
    let help = native(&fixture.root, &["handoff", "--help"]);
    assert!(help.status.success(), "{help:?}");
    let help_text = String::from_utf8(help.stdout).unwrap();
    assert!(!help_text.contains("--markdown"));
    assert!(help_text.contains("--json"));
    assert!(help_text.contains("--next-command"));

    let omitted = native(&fixture.root, &["handoff"]);
    let explicit = native(&fixture.root, &["handoff", "--markdown"]);
    assert_eq!(explicit.status.code(), omitted.status.code());
    assert_eq!(explicit.stdout, omitted.stdout);
    assert!(omitted.stderr.is_empty());
    assert_eq!(
        explicit.stderr,
        b"\xE2\x9A\xA0 --markdown is deprecated; omit --markdown and use the default Markdown output.\n"
    );
    assert_source_parity(&fixture.root, &["handoff", "--markdown"], &explicit);

    let json = native(&fixture.root, &["handoff", "--markdown", "--json"]);
    assert!(json.status.success(), "{json:?}");
    assert!(json.stderr.is_empty());
    assert_eq!(document(&json)["ok"], true);
    assert_source_parity(&fixture.root, &["handoff", "--markdown", "--json"], &json);
}

#[test]
fn outside_workspace_uses_source_json_error_envelope_and_exit() {
    let outside = Fixture::directory("outside");
    let output = native(&outside, &["handoff", "--json"]);
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(output.stderr.is_empty());
    assert_eq!(
        document(&output),
        json!({
            "command":"handoff",
            "error":{"code":"NOT_IN_WORKSPACE","message":"Not in an arashi workspace"},
            "ok":false,
            "schemaVersion":1,
            "warnings":[]
        })
    );
    assert_source_parity(&outside, &["handoff", "--json"], &output);
    fs::remove_dir_all(outside).unwrap();
}

#[test]
fn unsupported_bare_topology_rejects_before_success() {
    let bare = Fixture::directory("bare");
    git(&bare, &["init", "--bare"]);
    let output = native(&bare, &["handoff", "--json"]);
    assert!(!output.status.success(), "{output:?}");
    let envelope = document(&output);
    assert_eq!(envelope["ok"], false);
    assert_eq!(envelope["error"]["code"], "UNSUPPORTED_TOPOLOGY");
    assert!(envelope.get("data").is_none());
    fs::remove_dir_all(bare).unwrap();
}

#[test]
fn json_flag_does_not_wrap_commander_parser_failures() {
    let fixture = Fixture::configured();

    let extra = native(&fixture.root, &["handoff", "--json", "extra"]);
    assert_parser_source_parity(&fixture.root, &["handoff", "--json", "extra"], &extra);
    assert!(extra.status.success(), "{extra:?}");
    assert!(extra.stderr.is_empty());

    let option_value = native(&fixture.root, &["handoff", "--json", "--link", "-x"]);
    assert_parser_source_parity(
        &fixture.root,
        &["handoff", "--json", "--link", "-x"],
        &option_value,
    );
    assert!(option_value.status.success(), "{option_value:?}");
    assert_eq!(
        document(&option_value)["data"]["context"]["links"],
        json!(["-x"])
    );

    let missing = native(&fixture.root, &["handoff", "--json", "--link"]);
    assert_parser_source_parity(&fixture.root, &["handoff", "--json", "--link"], &missing);
    assert_eq!(missing.status.code(), Some(1));
    assert!(missing.stdout.is_empty());
    assert_eq!(
        missing.stderr,
        b"error: option '--link <link>' argument missing\n"
    );
}
