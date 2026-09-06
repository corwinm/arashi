use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicU64, Ordering},
};

static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    workspace: PathBuf,
    home: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "arashi-rust-configure-{}-{}",
            std::process::id(),
            FIXTURE_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        let workspace = root.join("workspace");
        let home = root.join("home");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir(&home).unwrap();
        git(&workspace, &["init", "-b", "main"]);
        git(&workspace, &["config", "user.name", "Test"]);
        git(
            &workspace,
            &["config", "user.email", "test@example.invalid"],
        );
        fs::write(workspace.join("README"), "fixture\n").unwrap();
        git(&workspace, &["add", "README"]);
        git(&workspace, &["commit", "-m", "fixture"]);
        Self {
            root,
            workspace,
            home,
        }
    }
    fn configure(&self, config: Value) {
        self.configure_text(&format!(
            "{}\n",
            serde_json::to_string_pretty(&config).unwrap()
        ));
    }
    fn configure_text(&self, config: &str) {
        fs::create_dir_all(self.workspace.join(".arashi/hooks")).unwrap();
        fs::write(self.workspace.join(".arashi/config.json"), config).unwrap();
    }
    fn run(&self, cwd: &Path, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_arashi"))
            .args(args)
            .current_dir(cwd)
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.home.join("gitconfig"))
            .env("GIT_OPTIONAL_LOCKS", "0")
            .output()
            .unwrap()
    }
    fn run_source(&self, cwd: &Path, args: &[&str]) -> Output {
        Command::new("node")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"))
            .args(args)
            .current_dir(cwd)
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.home.join("gitconfig"))
            .env("GIT_OPTIONAL_LOCKS", "0")
            .output()
            .unwrap()
    }
    fn snapshot(&self) -> BTreeMap<String, Vec<u8>> {
        fn walk(root: &Path, at: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
            let mut entries = fs::read_dir(at)
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                let path = entry.path();
                let relative = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                let kind = entry.file_type().unwrap();
                if kind.is_dir() {
                    out.insert(format!("{relative}/"), vec![]);
                    walk(root, &path, out);
                } else if kind.is_symlink() {
                    out.insert(
                        relative,
                        fs::read_link(path)
                            .unwrap()
                            .as_os_str()
                            .as_encoded_bytes()
                            .to_vec(),
                    );
                } else {
                    out.insert(relative, fs::read(path).unwrap());
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(&self.root, &self.root, &mut out);
        out
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn git(cwd: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(["-c", "maintenance.auto=false", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn setting<'a>(settings: &'a [Value], id: &str) -> &'a Value {
    settings.iter().find(|value| value["id"] == id).unwrap()
}
fn repository<'a>(data: &'a Value, name: &str) -> &'a Value {
    data["repositories"]
        .as_array()
        .unwrap()
        .iter()
        .find(|value| value["name"] == name)
        .unwrap()
}

fn envelope(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "invalid JSON ({error}): stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

fn repository_native_source_count(data: &Value, name: &str, lifecycle: &str) -> usize {
    data["nativeSources"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|source| {
            source["scope"] == "repository"
                && source["ownerName"] == name
                && source["lifecycle"] == lifecycle
        })
        .count()
}

fn native_hook_extension() -> &'static str {
    if cfg!(windows) { ".ps1" } else { ".sh" }
}

#[test]
fn json_inspection_preserves_order_values_aliases_inheritance_and_sanitized_hooks() {
    let f = Fixture::new();
    for name in ["zulu", "alpha"] {
        let path = f.workspace.join("repos").join(name);
        fs::create_dir_all(&path).unwrap();
        git(&path, &["init", "-b", "main"]);
    }
    f.configure_text(r#"{
      "version":"1", "repos_dir":"repos", "worktrees_dir":"legacy-worktrees",
      "baseBranch":"develop", "sync":{"timeout_seconds":17},
      "hooks":{"timeout":42,"scripts":{"pre-create":{"powershell":"INLINE_PS_BODY","bash":"INLINE_BASH_BODY"}}},
      "defaults":{"create":{"switch":true,"launch_mode":"auto"},"switch":{"launchMode":"auto"},"editors":{"vscode":{"create":{"launch_mode":"sesh"}}}},
      "meta":{},
      "repos":{
        "zulu":{"path":"repos/zulu","groups":["Backend"],"copy":[".env"],"hooks":{"post-remove":{"cmd":"REPO_CMD_BODY","bash":"REPO_BASH_BODY"}}},
        "alpha":{"path":"repos/alpha","symlink":["node_modules"],"baseBranch":"release"}
      }
    }
    "#);
    fs::write(
        f.workspace.join(format!(
            ".arashi/hooks/pre-remove{}",
            native_hook_extension()
        )),
        "WORKSPACE_FILE_BODY\n",
    )
    .unwrap();
    fs::write(
        f.workspace.join(format!(
            ".arashi/hooks/post-create.zulu{}",
            native_hook_extension()
        )),
        "REPOSITORY_FILE_BODY\n",
    )
    .unwrap();
    let before = f.snapshot();
    let output = f.run(&f.workspace, &["configure", "--json"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        before,
        f.snapshot(),
        "configure --json must not mutate any fixture or HOME bytes"
    );
    assert!(output.stderr.is_empty());
    let serialized = String::from_utf8(output.stdout).unwrap();
    for secret in [
        "INLINE_PS_BODY",
        "INLINE_BASH_BODY",
        "REPO_CMD_BODY",
        "REPO_BASH_BODY",
        "WORKSPACE_FILE_BODY",
        "REPOSITORY_FILE_BODY",
    ] {
        assert!(
            !serialized.contains(secret),
            "inspection exposed hook body {secret}"
        );
    }
    let native_envelope: Value = serde_json::from_str(&serialized).unwrap();
    if std::env::var_os("ARASHI_TS_PARITY").is_some() {
        let source = f.run_source(&f.workspace, &["configure", "--json"]);
        assert!(
            source.status.success(),
            "{}",
            String::from_utf8_lossy(&source.stderr)
        );
        assert!(source.stderr.is_empty());
        assert_eq!(native_envelope, envelope(&source));
        assert_eq!(before, f.snapshot());
    }
    let envelope = native_envelope;
    assert_eq!(envelope["command"], "configure");
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["schemaVersion"], 1);
    assert_eq!(envelope["warnings"], json!([]));
    let data = &envelope["data"];
    assert_eq!(
        data["scopes"],
        json!([
            "workspace-settings",
            "workspace-hooks",
            "command-defaults",
            "editor-defaults",
            "meta-policy",
            "repository"
        ])
    );
    assert_eq!(
        data["repositories"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["zulu", "alpha"]
    );
    let settings = data["settings"].as_array().unwrap();
    assert_eq!(settings.len(), 19);
    assert_eq!(setting(settings, "reposDir")["persistedPath"], "repos_dir");
    assert_eq!(setting(settings, "reposDir")["configuredValue"], "repos");
    assert_eq!(
        setting(settings, "worktreesDir")["persistedPath"],
        "worktrees_dir"
    );
    assert_eq!(
        setting(settings, "sync.timeoutSeconds")["persistedPath"],
        "sync.timeout_seconds"
    );
    assert_eq!(
        setting(settings, "defaults.create.launch")["persistedPath"],
        "defaults.create.launch_mode"
    );
    assert_eq!(
        setting(settings, "defaults.switch.mode")["persistedPath"],
        "defaults.switch.launchMode"
    );
    assert_eq!(
        setting(settings, "defaults.switch.mode")["configuredValue"],
        "launch"
    );
    assert_eq!(
        setting(settings, "defaults.editors.vscode.create.launch")["persistedPath"],
        "defaults.editors.vscode.create.launch_mode"
    );
    assert_eq!(
        setting(settings, "meta.baseBranch")["effective"],
        json!({"source":"inherited","value":"develop"})
    );
    assert_eq!(
        setting(settings, "defaults.editors.cursor.create.switch")["effective"],
        json!({"source":"built-in","value":false})
    );
    assert_eq!(
        setting(settings, "hooks.scripts.pre-create")["configuredValue"],
        json!({"interpreters":["bash","powershell"],"lifecycle":"pre-create","sourceKind":"inline-config"})
    );
    let zulu = repository(data, "zulu");
    assert_eq!(zulu["settings"].as_array().unwrap().len(), 8);
    assert_eq!(
        setting(zulu["settings"].as_array().unwrap(), "baseBranch")["effective"],
        json!({"source":"inherited","value":"develop"})
    );
    assert_eq!(
        setting(zulu["settings"].as_array().unwrap(), "post-remove")["configuredValue"],
        json!({"interpreters":["bash","cmd"],"lifecycle":"post-remove","sourceKind":"inline-config"})
    );
    assert_eq!(
        setting(
            repository(data, "alpha")["settings"].as_array().unwrap(),
            "baseBranch"
        )["configuredValue"],
        "release"
    );
    assert_eq!(
        data["nativeSources"],
        json!([
            {"lifecycle":"pre-remove","scope":"workspace","sourceKind":"file"},
            {"lifecycle":"post-create","ownerName":"zulu","scope":"repository","sourceKind":"file"}
        ])
    );
}

#[test]
fn omitted_values_report_built_ins_without_pretending_they_are_configured() {
    let f = Fixture::new();
    f.configure(json!({"version":"1.0.0","reposDir":"repos","repos":{}}));
    let output = f.run(&f.workspace, &["configure", "--json"]);
    assert!(output.status.success());
    let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
    let settings = envelope["data"]["settings"].as_array().unwrap();
    for (id, value) in [
        ("worktreesDir", json!(".arashi/worktrees")),
        ("sync.timeoutSeconds", json!(300)),
        ("hooks.timeout", json!(300000)),
        ("defaults.create.switch", json!(false)),
        ("defaults.create.launch", json!("none")),
        ("defaults.switch.mode", json!("launch")),
    ] {
        let row = setting(settings, id);
        assert_eq!(row["configured"], false);
        assert!(row.get("configuredValue").is_none());
        assert!(row.get("persistedPath").is_none());
        assert_eq!(row["effective"], json!({"source":"built-in","value":value}));
    }
}

#[test]
fn valid_legacy_switch_combinations_report_the_retained_source_replacement_mode() {
    for (mode, launch_mode, expected) in [
        (None, "auto", "launch"),
        (None, "sesh", "sesh"),
        (None, "herdr", "herdr"),
        (Some("launch"), "auto", "launch"),
        (Some("launch"), "sesh", "sesh"),
        (Some("launch"), "herdr", "herdr"),
        (Some("auto"), "auto", "auto"),
        (Some("auto"), "sesh", "sesh"),
        (Some("auto"), "herdr", "herdr"),
        (Some("cd"), "auto", "cd"),
        (Some("sesh"), "auto", "sesh"),
        (Some("sesh"), "sesh", "sesh"),
        (Some("herdr"), "auto", "herdr"),
        (Some("herdr"), "herdr", "herdr"),
    ] {
        let f = Fixture::new();
        let mut switch = json!({"launchMode":launch_mode});
        if let Some(mode) = mode {
            switch["mode"] = json!(mode);
        }
        f.configure(json!({
            "version":"1.0.0", "reposDir":"repos", "repos":{},
            "defaults":{"switch":switch}
        }));

        let output = f.run(&f.workspace, &["configure", "--json"]);

        assert!(
            output.status.success(),
            "mode {mode:?} with launchMode {launch_mode}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(output.stderr.is_empty());
        let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(envelope["warnings"], json!([]));
        let row = setting(
            envelope["data"]["settings"].as_array().unwrap(),
            "defaults.switch.mode",
        );
        assert_eq!(
            row["configuredValue"], expected,
            "mode {mode:?} with launchMode {launch_mode}"
        );
        assert_eq!(
            row["persistedPath"],
            if mode.is_some() {
                "defaults.switch.mode"
            } else {
                "defaults.switch.launchMode"
            }
        );
    }
}

#[test]
fn unrepresentable_legacy_switch_combinations_report_validation_diagnostics() {
    for (mode, launch_mode) in [
        ("cd", "sesh"),
        ("cd", "herdr"),
        ("sesh", "herdr"),
        ("herdr", "sesh"),
    ] {
        let f = Fixture::new();
        f.configure(json!({
            "version":"1.0.0", "reposDir":"repos", "repos":{},
            "defaults":{"switch":{"mode":mode,"launchMode":launch_mode}}
        }));
        let before = f.snapshot();

        let output = f.run(&f.workspace, &["configure", "--json"]);

        assert!(!output.status.success());
        assert!(output.stderr.is_empty());
        assert_eq!(before, f.snapshot());
        let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(envelope["error"]["code"], "CONFIG_VALIDATION_ERROR");
        assert!(
            envelope["error"]["message"]
                .as_str()
                .unwrap()
                .contains(&format!(
                    "defaults.switch.mode: {mode:?} cannot be combined with legacy defaults.switch.launchMode: {launch_mode:?}"
                ))
        );
    }
}

#[test]
fn canonical_qualified_repository_remove_hooks_are_reported_without_reading_contents() {
    let f = Fixture::new();
    let repository_path = f.workspace.join("repos/app");
    fs::create_dir_all(&repository_path).unwrap();
    git(&repository_path, &["init", "-b", "main"]);
    f.configure(json!({
        "version":"1.0.0", "reposDir":"repos",
        "repos":{"app":{"path":"repos/app"}}
    }));
    for lifecycle in ["pre-remove", "post-remove"] {
        fs::write(
            f.workspace.join(format!(
                ".arashi/hooks/{lifecycle}.app{}",
                native_hook_extension()
            )),
            format!("CANONICAL_{lifecycle}_SECRET\n"),
        )
        .unwrap();
    }

    let before = f.snapshot();
    let output = f.run(&f.workspace, &["configure", "--json"]);

    assert!(output.status.success());
    assert_eq!(before, f.snapshot());
    let serialized = String::from_utf8(output.stdout).unwrap();
    assert!(!serialized.contains("CANONICAL_pre-remove_SECRET"));
    assert!(!serialized.contains("CANONICAL_post-remove_SECRET"));
    let envelope: Value = serde_json::from_str(&serialized).unwrap();
    for lifecycle in ["pre-remove", "post-remove"] {
        assert_eq!(
            repository_native_source_count(&envelope["data"], "app", lifecycle),
            1
        );
        assert_eq!(
            setting(
                repository(&envelope["data"], "app")["settings"]
                    .as_array()
                    .unwrap(),
                lifecycle
            )["nativeSource"],
            json!({"lifecycle":lifecycle,"ownerName":"app","scope":"repository","sourceKind":"file"})
        );
    }
}

#[test]
fn canonical_and_compatible_repository_remove_hooks_deduplicate_logical_sources() {
    let f = Fixture::new();
    let repository_path = f.workspace.join("repos/app");
    fs::create_dir_all(repository_path.join(".arashi/hooks")).unwrap();
    git(&repository_path, &["init", "-b", "main"]);
    f.configure(json!({
        "version":"1.0.0", "reposDir":"repos",
        "repos":{"app":{"path":"repos/app"}}
    }));
    for lifecycle in ["pre-remove", "post-remove"] {
        fs::write(
            f.workspace.join(format!(
                ".arashi/hooks/{lifecycle}.app{}",
                native_hook_extension()
            )),
            format!("CANONICAL_{lifecycle}_SECRET\n"),
        )
        .unwrap();
        fs::write(
            repository_path.join(format!(
                ".arashi/hooks/{lifecycle}{}",
                native_hook_extension()
            )),
            format!("COMPATIBLE_{lifecycle}_SECRET\n"),
        )
        .unwrap();
    }

    let before = f.snapshot();
    let output = f.run(&f.workspace, &["configure", "--json"]);

    assert!(output.status.success());
    assert_eq!(before, f.snapshot());
    let serialized = String::from_utf8(output.stdout).unwrap();
    for secret in ["CANONICAL_", "COMPATIBLE_"] {
        assert!(!serialized.contains(secret));
    }
    let envelope: Value = serde_json::from_str(&serialized).unwrap();
    for lifecycle in ["pre-remove", "post-remove"] {
        assert_eq!(
            repository_native_source_count(&envelope["data"], "app", lifecycle),
            1
        );
    }
}

#[test]
fn conflicting_canonical_and_legacy_command_default_aliases_fail_without_repair() {
    for (scope, defaults) in [
        (
            "defaults.switch",
            json!({"switch":{"mode":"sesh","launchMode":"herdr"}}),
        ),
        (
            "defaults.create",
            json!({"create":{"launch":"sesh","launch_mode":"herdr"}}),
        ),
        (
            "defaults.editors.vscode.create",
            json!({"editors":{"vscode":{"create":{"launch":"sesh","launchMode":"herdr"}}}}),
        ),
    ] {
        let f = Fixture::new();
        let content = format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({
                "version":"1.0.0", "reposDir":"repos", "repos":{}, "defaults":defaults
            }))
            .unwrap()
        );
        f.configure_text(&content);
        let before = f.snapshot();

        let output = f.run(&f.workspace, &["configure", "--json"]);

        assert!(!output.status.success(), "{scope} conflict succeeded");
        assert!(output.stderr.is_empty());
        assert_eq!(
            before,
            f.snapshot(),
            "{scope} conflict repaired config bytes"
        );
        let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(envelope["command"], "configure");
        assert_eq!(envelope["ok"], false);
        assert_eq!(envelope["schemaVersion"], 1);
        assert_eq!(envelope["error"]["code"], "CONFIG_VALIDATION_ERROR");
        assert!(
            envelope["error"]["message"]
                .as_str()
                .unwrap()
                .contains(scope)
        );
    }
}

#[test]
fn legacy_boolean_create_launch_defaults_match_the_retained_source_in_every_scope() {
    for (scope, defaults, expected) in [
        ("defaults.create", json!({"create":{"launch":true}}), "auto"),
        (
            "defaults.create",
            json!({"create":{"launch":false}}),
            "none",
        ),
        (
            "defaults.create",
            json!({"create":{"launch":true,"launchMode":"sesh"}}),
            "sesh",
        ),
        (
            "defaults.editors.vscode.create",
            json!({"editors":{"vscode":{"create":{"launch":true}}}}),
            "auto",
        ),
        (
            "defaults.editors.cursor.create",
            json!({"editors":{"cursor":{"create":{"launch":false}}}}),
            "none",
        ),
        (
            "defaults.editors.kiro.create",
            json!({"editors":{"kiro":{"create":{"launch":true,"launch_mode":"herdr"}}}}),
            "herdr",
        ),
    ] {
        let f = Fixture::new();
        f.configure(json!({
            "version":"1.0.0", "reposDir":"repos", "repos":{}, "defaults":defaults
        }));

        let native = f.run(&f.workspace, &["configure", "--json"]);

        assert!(
            native.status.success(),
            "{scope}: {}",
            String::from_utf8_lossy(&native.stdout)
        );
        let native_json = envelope(&native);
        let id = format!("{scope}.launch");
        let row = setting(native_json["data"]["settings"].as_array().unwrap(), &id);
        assert_eq!(row["configuredValue"], expected, "{scope}");
        if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            let source = f.run_source(&f.workspace, &["configure", "--json"]);
            assert!(
                source.status.success(),
                "{scope}: {}",
                String::from_utf8_lossy(&source.stdout)
            );
            let source_json = envelope(&source);
            let source_row = setting(source_json["data"]["settings"].as_array().unwrap(), &id);
            assert_eq!(
                row["configuredValue"], source_row["configuredValue"],
                "{scope}"
            );
            assert_eq!(row["persistedPath"], source_row["persistedPath"], "{scope}");
        }
    }
}

#[test]
fn invalid_legacy_launch_aliases_are_rejected_even_beside_canonical_fields() {
    for (scope, defaults) in [
        (
            "defaults.switch.launchMode",
            json!({"switch":{"mode":"cd","launchMode":7}}),
        ),
        (
            "defaults.create.launchMode",
            json!({"create":{"launch":"sesh","launchMode":7}}),
        ),
        (
            "defaults.editors.vscode.create.launch_mode",
            json!({"editors":{"vscode":{"create":{"launch":"sesh","launch_mode":7}}}}),
        ),
    ] {
        let f = Fixture::new();
        f.configure(json!({
            "version":"1.0.0", "reposDir":"repos", "repos":{}, "defaults":defaults
        }));
        let before = f.snapshot();

        let native = f.run(&f.workspace, &["configure", "--json"]);

        assert!(!native.status.success(), "{scope} unexpectedly succeeded");
        assert_eq!(before, f.snapshot(), "{scope} changed fixture bytes");
        let native_json = envelope(&native);
        assert_eq!(native_json["error"]["code"], "CONFIG_VALIDATION_ERROR");
        assert!(
            native_json["error"]["message"]
                .as_str()
                .unwrap()
                .contains(scope)
        );
        if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            let source = f.run_source(&f.workspace, &["configure", "--json"]);
            let source_json = envelope(&source);
            assert_eq!(source.status.success(), native.status.success(), "{scope}");
            assert!(
                source_json["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains(scope)
            );
        }
    }
}

#[cfg(unix)]
#[test]
fn configure_inspection_uses_one_fifo_snapshot_and_finishes_within_a_bound() {
    use std::io::Write;
    use std::time::{Duration, Instant};

    let f = Fixture::new();
    let arashi = f.workspace.join(".arashi");
    fs::create_dir_all(&arashi).unwrap();
    let config_path = arashi.join("config.json");
    let status = Command::new("mkfifo").arg(&config_path).status().unwrap();
    assert!(status.success(), "mkfifo failed");
    let snapshot = br#"{"version":"1.0.0","reposDir":"repos","defaults":{"create":{"launch":"auto"}},"repos":{}}"#.to_vec();
    let writer_path = config_path.clone();
    let writer = std::thread::spawn(move || {
        let mut fifo = fs::OpenOptions::new()
            .write(true)
            .open(writer_path)
            .unwrap();
        fifo.write_all(&snapshot).unwrap();
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_arashi"))
        .args(["configure", "--json"])
        .current_dir(&f.workspace)
        .env("HOME", &f.home)
        .env("USERPROFILE", &f.home)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", f.home.join("gitconfig"))
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let completed = loop {
        if child.try_wait().unwrap().is_some() {
            break true;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            break false;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let output = child.wait_with_output().unwrap();
    writer.join().unwrap();

    assert!(
        completed,
        "configure attempted a second config read and blocked on the FIFO"
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let value = envelope(&output);
    let row = setting(
        value["data"]["settings"].as_array().unwrap(),
        "defaults.create.launch",
    );
    assert_eq!(row["configuredValue"], "auto");
    assert_eq!(row["persistedPath"], "defaults.create.launch");
}

#[test]
fn unsupported_modes_and_topologies_fail_closed_without_mutation() {
    let f = Fixture::new();
    f.configure(json!({"version":"1.0.0","reposDir":"repos","repos":{}}));
    for args in [&["configure"][..], &["configure", "extra", "--json"]] {
        let before = f.snapshot();
        let output = f.run(&f.workspace, args);
        assert!(!output.status.success(), "{args:?} unexpectedly succeeded");
        assert_eq!(before, f.snapshot());
    }
    let standalone = Fixture::new();
    let before = standalone.snapshot();
    let output = standalone.run(&standalone.workspace, &["configure", "--json"]);
    assert!(!output.status.success());
    assert_eq!(before, standalone.snapshot());
}

#[test]
fn linked_and_bare_roots_return_explicit_topology_rejections() {
    let f = Fixture::new();
    f.configure(json!({"version":"1.0.0","reposDir":"repos","repos":{}}));
    let linked = f.root.join("linked");
    git(
        &f.workspace,
        &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
    );
    let linked_output = f.run(&linked, &["configure", "--json"]);
    let linked_error: Value = serde_json::from_slice(&linked_output.stdout).unwrap();
    assert!(!linked_output.status.success());
    assert_eq!(linked_error["error"]["code"], "UNSUPPORTED_TOPOLOGY");

    let bare = f.root.join("bare.git");
    git(
        &f.root,
        &[
            "clone",
            "--bare",
            f.workspace.to_str().unwrap(),
            bare.to_str().unwrap(),
        ],
    );
    fs::create_dir_all(bare.join(".arashi")).unwrap();
    fs::write(
        bare.join(".arashi/config.json"),
        r#"{"version":"1.0.0","reposDir":"repos","repos":{}}"#,
    )
    .unwrap();
    let bare_output = f.run(&bare, &["configure", "--json"]);
    let bare_error: Value = serde_json::from_slice(&bare_output.stdout).unwrap();
    assert!(!bare_output.status.success());
    assert_eq!(bare_error["error"]["code"], "UNSUPPORTED_TOPOLOGY");
}
