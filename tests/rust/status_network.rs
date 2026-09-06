//! Independent source/native network observations. Only fixture root paths and
//! elapsed fields are normalized; a shared daemon keeps transport diagnostics exact.
use super::{Fixture, Value, normalized};
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    process::{Command, Output},
};
#[path = "network.rs"]
mod network;

fn bytes(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn visit(root: &Path, path: &Path, result: &mut BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(root, &path, result);
            } else {
                result.insert(
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    fs::read(path).unwrap(),
                );
            }
        }
    }
    let mut result = BTreeMap::new();
    visit(root, root, &mut result);
    result
}
fn snapshot(f: &Fixture) -> BTreeMap<String, Vec<u8>> {
    let mut result = bytes(&f.home);
    for repo in [".", "repos/zulu", "repos/alpha"] {
        for file in [
            ".git/HEAD",
            ".git/index",
            ".git/config",
            ".git/refs/stash",
            ".git/logs/refs/stash",
            "file.txt",
            "untracked",
        ] {
            let path = f.repo.join(repo).join(file);
            if path.exists() {
                result.insert(format!("{repo}/{file}"), fs::read(path).unwrap());
            }
        }
        result.insert(
            format!("{repo}/heads"),
            f.git(&["-C", repo, "show-ref", "--heads"]).into_bytes(),
        );
    }
    result.insert(
        "config".into(),
        fs::read(f.repo.join(".arashi/config.json")).unwrap(),
    );
    result
}
fn run(f: &Fixture, source: bool, args: &[&str]) -> Output {
    let mut command = if source {
        let mut command = Command::new("node");
        command.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"));
        command
    } else {
        Command::new(env!("CARGO_BIN_EXE_arashi"))
    };
    command.args(args);
    f.environment(&mut command);
    command.env("GIT_ALLOW_PROTOCOL", "git");
    if !source {
        command.env_remove("GIT_OPTIONAL_LOCKS");
    }
    command.output().unwrap()
}
fn fixture(
    daemon: &network::GitDaemon,
    origins: &Path,
    side: &str,
    failure: &str,
    url_shape: &str,
) -> Fixture {
    let mut f = Fixture::new();
    f.configured();
    let config_path = f.repo.join(".arashi/config.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    config["worktreesDir"] = ".arashi/worktrees".into();
    config["baseBranch"] = "origin/main".into();
    config["meta"] = serde_json::json!({"baseBranch":"release"});
    config["repos"]["alpha"]["baseBranch"] = "release".into();
    fs::write(config_path, serde_json::to_vec(&config).unwrap()).unwrap();
    f.git(&["add", ".arashi/config.json"]);
    f.git(&["commit", "-m", "configured bases"]);
    for (i, repo) in [".", "repos/zulu", "repos/alpha"].iter().enumerate() {
        if *repo != "." {
            fs::write(f.repo.join(repo).join("file.txt"), "initial\n").unwrap();
            f.git(&["-C", repo, "add", "file.txt"]);
            f.git(&[
                "-C",
                repo,
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-m",
                "tracked",
            ]);
        }
        f.git(&["-C", repo, "branch", "release"]);
        let name = format!("{side}-{i}.git");
        let remote = origins.join(&name);
        f.git(&[
            "clone",
            "--bare",
            f.repo.join(repo).to_str().unwrap(),
            remote.to_str().unwrap(),
        ]);
        let url = format!("{}{name}", daemon.prefix);
        f.git(&["-C", repo, "remote", "add", "origin", &url]);
        f.git(&["-C", repo, "fetch", "origin"]);
        f.git(&[
            "-C",
            repo,
            "branch",
            "--set-upstream-to=origin/main",
            "main",
        ]);
        f.git(&["-C", repo, "remote", "set-head", "origin", "main"]);
        // Renamed local upstream remains supported; no pull/push-specific policy.
        f.git(&["-C", repo, "branch", "-m", "topic"]);
        let oid = f.git(&[
            "-C",
            remote.to_str().unwrap(),
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit-tree",
            "release^{tree}",
            "-p",
            "release",
            "-m",
            "incoming",
        ]);
        for branch in ["main", "release"] {
            f.git(&[
                "-C",
                remote.to_str().unwrap(),
                "update-ref",
                &format!("refs/heads/{branch}"),
                oid.trim(),
            ]);
        }
        if i == 0 && failure != "none" {
            if failure == "transport" {
                f.git(&[
                    "-C",
                    repo,
                    "remote",
                    "set-url",
                    "origin",
                    &format!("{}missing.git", daemon.prefix),
                ]);
            } else {
                f.git(&[
                    "-C",
                    remote.to_str().unwrap(),
                    "update-ref",
                    "-d",
                    &format!("refs/heads/{failure}"),
                ]);
            }
        } else if url_shape != "git" {
            let alias = format!("{url_shape}{name}");
            f.git(&[
                "-C",
                repo,
                "config",
                &format!("url.{}.insteadOf", daemon.prefix),
                url_shape,
            ]);
            f.git(&["-C", repo, "remote", "set-url", "origin", &alias]);
        }
        let tracked = f.repo.join(repo).join("file.txt");
        fs::write(&tracked, "caller stash\n").unwrap();
        f.git(&["-C", repo, "stash", "push", "-m", "caller"]);
        fs::write(&tracked, "staged\n").unwrap();
        f.git(&["-C", repo, "add", "file.txt"]);
        fs::write(&tracked, "staged and unstaged\n").unwrap();
        fs::write(f.repo.join(repo).join("untracked"), "caller bytes\n").unwrap();
        f.git(&["-C", repo, "config", "credential.helper", "cache"]);
        f.git(&[
            "-C",
            repo,
            "config",
            "core.sshCommand",
            "ssh -o BatchMode=yes",
        ]);
    }
    fs::write(f.home.join("preserve"), "HOME bytes").unwrap();
    f
}
fn observations(f: &Fixture, source: bool, failure: &str) -> Vec<(Option<i32>, String, String)> {
    let before = snapshot(f);
    let mut outputs = vec![];
    for args in [
        vec!["status", "--json"],
        vec!["handoff", "--json"],
        vec!["handoff"],
    ] {
        let output = run(f, source, &args);
        assert!(
            output.status.success(),
            "{args:?}: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let mut stdout = String::from_utf8(output.stdout)
            .unwrap()
            .replace(f.base.to_str().unwrap(), "<fixture>");
        if args.contains(&"--json") {
            let mut value: Value = serde_json::from_str(&stdout).unwrap();
            normalized(&mut value);
            if args[0] == "status" {
                let rows = value["data"]["repositories"].as_array().unwrap();
                assert_eq!(rows.len(), 3);
                assert_eq!(
                    rows.iter().find(|row| row["name"] == "zulu").unwrap()["baseBranchSource"],
                    "workspace-config",
                    "{value}"
                );
                assert_eq!(
                    rows.iter().find(|row| row["name"] == "alpha").unwrap()["baseBranchSource"],
                    "repository-config"
                );
                assert_eq!(rows[1]["branch"]["behind"], 1);
                assert_eq!(rows[2]["baseBranch"]["behind"], 1);
                assert_eq!(
                    value["warnings"].as_array().unwrap().is_empty(),
                    failure == "none"
                );
                assert_eq!(
                    rows[0]["baseBranch"]["state"],
                    if failure == "release" || failure == "transport" {
                        "unavailable"
                    } else {
                        "available"
                    }
                );
            }
            stdout = serde_json::to_string(&value).unwrap();
        }
        outputs.push((
            output.status.code(),
            stdout,
            String::from_utf8(output.stderr)
                .unwrap()
                .replace(f.base.to_str().unwrap(), "<fixture>"),
        ));
        assert_eq!(before, snapshot(f), "{args:?} changed caller state");
    }
    outputs
}
#[test]
fn network_status_handoff_source_characterization() {
    if std::env::var_os("ARASHI_TS_PARITY").is_none() {
        return;
    }
    let origins = tempfile::tempdir().unwrap();
    let daemon = network::GitDaemon::start(origins.path());
    for failure in ["none", "main", "release", "transport"] {
        let f = fixture(&daemon, origins.path(), failure, failure, "git");
        observations(&f, true, failure);
    }
}
#[test]
fn network_status_handoff_native_parity() {
    let origins = tempfile::tempdir().unwrap();
    let daemon = network::GitDaemon::start(origins.path());
    for (i, failure) in ["none", "main", "release", "transport"].iter().enumerate() {
        let native = fixture(
            &daemon,
            origins.path(),
            &format!("native-{i}"),
            failure,
            "git",
        );
        let actual = observations(&native, false, failure);
        if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            let source = fixture(
                &daemon,
                origins.path(),
                &format!("source-{i}"),
                failure,
                "git",
            );
            assert_eq!(observations(&source, true, failure), actual);
        }
    }
}
#[test]
fn network_status_handoff_preserves_url_rewrites() {
    let origins = tempfile::tempdir().unwrap();
    let daemon = network::GitDaemon::start(origins.path());
    for (i, shape) in [
        "http://example.invalid/",
        "https://example.invalid/",
        "ssh://git@example.invalid/",
        "git@example.invalid:",
    ]
    .iter()
    .enumerate()
    {
        let native = fixture(
            &daemon,
            origins.path(),
            &format!("native-{i}"),
            "none",
            shape,
        );
        let actual = observations(&native, false, "none");
        if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            let source = fixture(
                &daemon,
                origins.path(),
                &format!("source-{i}"),
                "none",
                shape,
            );
            assert_eq!(observations(&source, true, "none"), actual);
        }
    }
}

#[test]
fn network_status_preflight_rejects_helpers_options_and_controls() {
    let origins = tempfile::tempdir().unwrap();
    let daemon = network::GitDaemon::start(origins.path());
    let f = fixture(&daemon, origins.path(), "unsafe", "none", "git");
    for payload in [
        "ext::sh -c touch-canary",
        "custom-helper::repo",
        "custom://host/repo",
        "-u./canary",
        "git://127.0.0.1/repo\n",
        "ssh://host/repo\u{7f}",
    ] {
        f.git(&["-C", "repos/alpha", "config", "remote.origin.url", payload]);
        let before = bytes(&f.repo);
        for command in ["status", "handoff"] {
            let output = run(&f, false, &[command, "--json"]);
            let value: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(
                value["error"]["code"], "PORT_UNSUPPORTED",
                "{payload}: {value}"
            );
            assert_eq!(
                before,
                bytes(&f.repo),
                "preflight fetched before rejecting {payload}"
            );
        }
    }
    // Reject an effective helper introduced by rewriting a standard URL.
    f.git(&[
        "-C",
        "repos/alpha",
        "config",
        "remote.origin.url",
        "https://example.invalid/repo",
    ]);
    f.git(&[
        "-C",
        "repos/alpha",
        "config",
        "url.ext::false.insteadOf",
        "https://example.invalid/",
    ]);
    let before = bytes(&f.repo);
    assert!(!run(&f, false, &["status", "--json"]).status.success());
    assert_eq!(before, bytes(&f.repo));
}

fn mapping_observation(source: bool) -> Value {
    let origins = tempfile::tempdir().unwrap();
    let daemon = network::GitDaemon::start(origins.path());
    let f = fixture(&daemon, origins.path(), "mapping", "none", "git");
    f.git(&[
        "config",
        "--add",
        "remote.origin.fetch",
        "+refs/heads/main:refs/heads/unrelated",
    ]);
    let origin = origins.path().join("mapping-0.git");
    f.git(&["-C", origin.to_str().unwrap(), "tag", "remote-tag", "main"]);
    let incoming = f.git(&["-C", origin.to_str().unwrap(), "rev-parse", "main"]);
    let mut before = snapshot(&f);
    let output = run(&f, source, &["status", "--json"]);
    assert!(output.status.success());
    // Retained Git fetch honors additional mappings and automatically follows tags.
    // These are allowed comparison metadata effects, not publication by Arashi.
    assert_eq!(f.git(&["rev-parse", "refs/heads/unrelated"]), incoming);
    assert_eq!(f.git(&["rev-parse", "refs/tags/remote-tag"]), incoming);
    let mut after = snapshot(&f);
    before.remove("./heads");
    after.remove("./heads");
    assert_eq!(before, after);
    let mut value: Value = serde_json::from_str(
        &String::from_utf8(output.stdout)
            .unwrap()
            .replace(f.base.to_str().unwrap(), "<fixture>"),
    )
    .unwrap();
    normalized(&mut value);
    value
}

#[test]
fn network_status_mapping_source_characterization() {
    if std::env::var_os("ARASHI_TS_PARITY").is_some() {
        mapping_observation(true);
    }
}

#[test]
fn network_status_mapping_and_tag_effects_match_source() {
    let actual = mapping_observation(false);
    if std::env::var_os("ARASHI_TS_PARITY").is_some() {
        assert_eq!(mapping_observation(true), actual);
    }
}

#[test]
fn network_status_preserves_stale_clean_index() {
    let origins = tempfile::tempdir().unwrap();
    let daemon = network::GitDaemon::start(origins.path());
    let f = fixture(&daemon, origins.path(), "index", "none", "git");
    // Same contents, a new inode/stat cache: ordinary git status rewrites index.
    let file = f.repo.join(".gitignore");
    let contents = fs::read(&file).unwrap();
    fs::remove_file(&file).unwrap();
    fs::write(&file, contents).unwrap();
    let before = snapshot(&f);
    assert!(
        run(&f, false, &["status", "--json", "--verbose"])
            .status
            .success()
    );
    let after = snapshot(&f);
    assert_eq!(before.get("./.git/index"), after.get("./.git/index"));
}

#[test]
fn network_status_fetch_timeout_is_warning_and_bounded() {
    use std::{
        net::TcpListener,
        time::{Duration, Instant},
    };
    let f = Fixture::new();
    fs::create_dir_all(f.repo.join(".arashi")).unwrap();
    fs::write(f.repo.join(".arashi/config.json"), r#"{"version":"1.0.0","reposDir":"repos","worktreesDir":".arashi/worktrees","baseBranch":"main","repos":{}}"#).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("git://{}/stall.git", listener.local_addr().unwrap());
    f.git(&["remote", "add", "origin", &url]);
    f.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
    f.git(&["branch", "--set-upstream-to=origin/main", "main"]);
    let before = bytes(&f.home);
    let start = Instant::now();
    // The kernel accepts the connection, but no server speaks the Git protocol.
    let output = run(&f, false, &["status", "--json"]);
    assert!(start.elapsed() < Duration::from_secs(40));
    assert!(start.elapsed() >= Duration::from_secs(30));
    assert!(output.status.success());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        value["warnings"]
            .to_string()
            .contains("timed out after 30000ms")
    );
    assert_eq!(before, bytes(&f.home));
}

#[test]
fn network_status_rejects_configured_helper_overrides_before_any_fetch() {
    let origins = tempfile::tempdir().unwrap();
    let daemon = network::GitDaemon::start(origins.path());
    let f = fixture(&daemon, origins.path(), "helper", "none", "git");
    for raw_helper in [false, true] {
        if raw_helper {
            f.git(&[
                "-C",
                "repos/alpha",
                "config",
                "--unset",
                "remote.origin.vcs",
            ]);
            f.git(&[
                "-C",
                "repos/alpha",
                "config",
                "remote.origin.url",
                "custom-helper::helper-2.git",
            ]);
            f.git(&[
                "-C",
                "repos/alpha",
                "config",
                &format!("url.{}.insteadOf", daemon.prefix),
                "custom-helper::",
            ]);
        } else {
            f.git(&[
                "-C",
                "repos/alpha",
                "config",
                "remote.origin.vcs",
                "custom-helper",
            ]);
        }
        let before = bytes(&f.repo);
        let output = run(&f, false, &["status", "--json"]);
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["error"]["code"], "PORT_UNSUPPORTED", "{value}");
        assert_eq!(before, bytes(&f.repo));
    }
}
