//! Source-first remote diagnosis with byte-exact checkout and HOME protection.

#[test]
fn remote_default_preserves_origin_named_logical_branch() {
    let f = Fixture::new(true);
    let origin = connected(&f, None, "origin");
    advance(&f, &origin, "origin/main");
    f.git(&f.root, &["fetch", "origin"]);
    f.git(
        &f.root,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/origin/main",
        ],
    );
    oracle(&f, &["REPOSITORY_DEFAULT_BRANCH_BEHIND"]);
}

#[test]
fn remote_multiple_remotes_choose_existing_origin_base() {
    let f = Fixture::new(true);
    let mut config: Value =
        serde_json::from_slice(&fs::read(f.root.join(".arashi/config.json")).unwrap()).unwrap();
    config["baseBranch"] = "main".into();
    fs::write(
        f.root.join(".arashi/config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    f.git(&f.root, &["commit", "-am", "base"]);
    let origin = connected(&f, None, "origin");
    let other = f.root.parent().unwrap().join("other.git");
    f.git(
        &f.root,
        &[
            "clone",
            "--bare",
            f.root.to_str().unwrap(),
            other.to_str().unwrap(),
        ],
    );
    f.git(
        &f.root,
        &["remote", "add", "upstream", other.to_str().unwrap()],
    );
    f.git(&f.root, &["fetch", "upstream"]);
    f.git(
        &f.root,
        &["branch", "--set-upstream-to=upstream/main", "main"],
    );
    f.git(&f.root, &["switch", "-c", "topic"]);
    f.git(
        &f.root,
        &["branch", "--set-upstream-to=upstream/main", "topic"],
    );
    advance(&f, &origin, "main");
    oracle(&f, &["REPOSITORY_CONFIGURED_BASE_BEHIND"]);
    // A local logical branch can share a short spelling with a tracking ref.
    // Target selection must still probe the exact origin ref before other remotes.
    f.git(&f.root, &["branch", "origin/main"]);
    oracle(&f, &["REPOSITORY_CONFIGURED_BASE_BEHIND"]);
}

#[test]
fn remote_upstream_mapping_diagnostics_matrix() {
    for mappings in [
        vec!["+refs/heads/elsewhere:refs/remotes/origin/main"],
        vec!["+refs/heads/main:refs/remotes/origin/other"],
        vec!["+refs/heads/*:refs/remotes/origin/*", "^refs/heads/main"],
        vec![
            "+refs/heads/main:refs/remotes/origin/main",
            "+refs/heads/main:refs/remotes/origin/main",
        ],
        vec!["refs/heads/main"],
        vec!["+refs/heads/*:refs/remotes/origin/nested/*"],
    ] {
        let f = Fixture::new(true);
        connected(&f, None, "origin");
        f.git(&f.root, &["config", "--unset-all", "remote.origin.fetch"]);
        for mapping in mappings {
            f.git(
                &f.root,
                &["config", "--add", "remote.origin.fetch", mapping],
            );
        }
        oracle(&f, &[]);
    }
}
#[test]
fn remote_multiple_merge_configuration() {
    for first in ["refs/heads/main", "refs/tags/missing", ""] {
        let f = Fixture::new(true);
        connected(&f, None, "origin");
        f.git(&f.root, &["config", "--unset-all", "remote.origin.fetch"]);
        f.git(&f.root, &["config", "branch.main.merge", first]);
        f.git(
            &f.root,
            &["config", "--add", "branch.main.merge", "refs/heads/main"],
        );
        oracle(&f, &["REPOSITORY_UPSTREAM_TRACKING_UNAVAILABLE"]);
    }
}
#[test]
fn remote_standalone_dirty_stash_and_detached() {
    let f = Fixture::new(false);
    fs::create_dir(f.root.join(".worktrees")).unwrap();
    fs::write(f.root.join(".git/info/exclude"), "/.worktrees/\n").unwrap();
    let origin = connected(&f, None, "origin");
    fs::write(f.root.join("tracked"), "stashed caller").unwrap();
    f.git(&f.root, &["stash", "push", "-m", "caller stash"]);
    fs::write(f.root.join("tracked"), "staged caller").unwrap();
    f.git(&f.root, &["add", "tracked"]);
    fs::write(f.root.join("tracked"), "unstaged caller").unwrap();
    advance(&f, &origin, "main");
    oracle(&f, &["REPOSITORY_DIRTY", "REPOSITORY_BEHIND"]);
    f.git(&f.root, &["switch", "--detach"]);
    oracle(&f, &["REPOSITORY_DIRTY", "REPOSITORY_DETACHED_HEAD"]);
}
#[test]
fn remote_partial_child_success_and_status_consumer() {
    let f = Fixture::new(true);
    f.children();
    let daemon = network::GitDaemon::start(f.root.parent().unwrap());
    let origin = connected(&f, Some(&daemon.prefix), "origin");
    let child = f.root.join("repos/alpha");
    f.git(
        &child,
        &[
            "remote",
            "add",
            "origin",
            &format!("{}origin.git", daemon.prefix),
        ],
    );
    f.git(&child, &["fetch", "origin"]);
    f.git(&child, &["branch", "--set-upstream-to=origin/main", "main"]);
    f.git(&child, &["reset", "--hard", "origin/main"]);
    let oid = advance(&f, &origin, "main");
    f.git(
        &f.root,
        &[
            "remote",
            "set-url",
            "origin",
            &format!("{}absent.git", daemon.prefix),
        ],
    );
    oracle(
        &f,
        &["REPOSITORY_REMOTE_REFRESH_FAILED", "REPOSITORY_BEHIND"],
    );
    if std::env::var_os("ARASHI_DOCTOR_CHARACTERIZE").is_none() {
        assert_eq!(
            f.git(&child, &["rev-parse", "refs/remotes/origin/main"])
                .trim(),
            oid
        );
        let before = protected(&f);
        let n = f
            .command(env!("CARGO_BIN_EXE_arashi"), &f.root)
            .args(["status", "--json"])
            .output()
            .unwrap();
        assert!(n.status.success(), "{}", String::from_utf8_lossy(&n.stdout));
        if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            let s = f
                .command("node", &f.root)
                .arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"))
                .args(["status", "--json"])
                .output()
                .unwrap();
            let n: Value = serde_json::from_slice(&n.stdout).unwrap();
            let s: Value = serde_json::from_slice(&s.stdout).unwrap();
            assert_eq!(n, s, "connected status consumes refreshed refs");
        }
        assert_eq!(before, protected(&f));
    }
}
#[test]
fn remote_configured_base_prefix_and_missing_target() {
    for base in ["origin/origin/main", "origin/origin/origin/main", "missing"] {
        let f = Fixture::new(true);
        let mut config: Value =
            serde_json::from_slice(&fs::read(f.root.join(".arashi/config.json")).unwrap()).unwrap();
        config["baseBranch"] = base.into();
        fs::write(
            f.root.join(".arashi/config.json"),
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        f.git(&f.root, &["commit", "-am", "base"]);
        let origin = connected(&f, None, "origin");
        advance(&f, &origin, "main");
        oracle(&f, &[]);
    }
}

use super::{Fixture, Value, fs};
#[path = "network.rs"]
mod network;

fn restore(f: &Fixture, before: &[(std::path::PathBuf, Vec<u8>)]) {
    for (path, _) in f.snapshot() {
        if !before.iter().any(|(old, _)| old == &path) {
            fs::remove_file(path).unwrap();
        }
    }
    for (path, bytes) in before {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        if fs::read(path).ok().as_deref() != Some(bytes.as_slice()) {
            fs::write(path, bytes).unwrap();
        }
    }
}
fn protected(f: &Fixture) -> Vec<(std::path::PathBuf, Vec<u8>)> {
    f.snapshot()
        .into_iter()
        .filter(|(p, _)| {
            let s = p.to_string_lossy().replace('\\', "/");
            !s.contains("/.git/objects/")
                && !s.contains("/.git/refs/remotes/")
                && !s.contains("/.git/logs/refs/remotes/")
                && !s.ends_with("/.git/FETCH_HEAD")
        })
        .collect()
}
fn oracle(f: &Fixture, codes: &[&str]) {
    let before = f.snapshot();
    let immutable = protected(f);
    let source_only = std::env::var_os("ARASHI_DOCTOR_CHARACTERIZE").is_some();
    let source = if source_only || std::env::var_os("ARASHI_TS_PARITY").is_some() {
        let s = f.run(true, &f.root, false);
        let value: Value = serde_json::from_slice(&s.stdout).unwrap();
        println!("SOURCE {}", String::from_utf8_lossy(&s.stdout));
        assert!(s.status.success(), "{value}");
        for code in codes {
            assert!(
                value["data"]["findings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v["code"] == *code),
                "{code}: {value}"
            );
        }
        assert_eq!(
            immutable,
            protected(f),
            "source checkout/config/HOME effects"
        );
        let refs = f.git(
            &f.root,
            &["for-each-ref", "--format=%(refname) %(objectname)"],
        );
        let fetch = fs::read(f.root.join(".git/FETCH_HEAD")).ok();
        restore(f, &before);
        Some((s, value, refs, fetch))
    } else {
        None
    };
    if source_only {
        return;
    }
    let n = f.run(false, &f.root, false);
    let value: Value = serde_json::from_slice(&n.stdout).unwrap();
    assert!(n.status.success(), "{value}");
    for code in codes {
        assert!(
            value["data"]["findings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["code"] == *code),
            "{code}: {value}"
        );
    }
    assert_eq!(
        immutable,
        protected(f),
        "native checkout/config/HOME effects"
    );
    if let Some((s, sv, refs, fetch)) = source {
        assert_eq!(value, sv, "complete doctor envelope");
        assert_eq!(n.stderr, s.stderr);
        assert_eq!(n.status.code(), s.status.code());
        assert_eq!(
            refs,
            f.git(
                &f.root,
                &["for-each-ref", "--format=%(refname) %(objectname)"]
            )
        );
        assert_eq!(fetch, fs::read(f.root.join(".git/FETCH_HEAD")).ok());
        restore(f, &before);
        let s = f.run(true, &f.root, true);
        restore(f, &before);
        let n = f.run(false, &f.root, true);
        assert_eq!(n.stdout, s.stdout, "human diagnosis");
        assert_eq!(n.stderr, s.stderr);
        assert_eq!(n.status.code(), s.status.code());
    }
}
fn connected(f: &Fixture, prefix: Option<&str>, remote: &str) -> std::path::PathBuf {
    let origin = f.root.parent().unwrap().join("origin.git");
    f.git(
        &f.root,
        &[
            "clone",
            "--bare",
            f.root.to_str().unwrap(),
            origin.to_str().unwrap(),
        ],
    );
    let url = prefix
        .map(|p| format!("{p}origin.git"))
        .unwrap_or_else(|| origin.to_string_lossy().into_owned());
    f.git(&f.root, &["remote", "add", remote, &url]);
    f.git(&f.root, &["fetch", remote]);
    f.git(
        &f.root,
        &[
            "branch",
            &format!("--set-upstream-to={remote}/main"),
            "main",
        ],
    );
    f.git(&f.root, &["remote", "set-head", remote, "main"]);
    f.git(&f.root, &["config", "maintenance.auto", "false"]);
    origin
}
fn advance(f: &Fixture, origin: &std::path::Path, branch: &str) -> String {
    let oid = f.git(
        origin,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit-tree",
            "main^{tree}",
            "-p",
            "main",
            "-m",
            "incoming",
        ],
    );
    f.git(
        origin,
        &["update-ref", &format!("refs/heads/{branch}"), oid.trim()],
    );
    oid.trim().to_owned()
}
#[test]
fn remote_network_divergence_and_duplicate_base() {
    let f = Fixture::new(true);
    let mut config: Value =
        serde_json::from_slice(&fs::read(f.root.join(".arashi/config.json")).unwrap()).unwrap();
    config["baseBranch"] = "origin/main".into();
    fs::write(
        f.root.join(".arashi/config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    f.git(&f.root, &["commit", "-am", "base"]);
    let daemon = network::GitDaemon::start(f.root.parent().unwrap());
    let origin = connected(&f, Some(&daemon.prefix), "origin");
    f.git(&f.root, &["branch", "-m", "topic"]);
    advance(&f, &origin, "main");
    f.git(&f.root, &["commit", "--allow-empty", "-m", "outgoing"]);
    fs::write(f.root.join("tracked"), "dirty caller").unwrap();
    fs::write(f.root.join("untracked"), "caller").unwrap();
    oracle(
        &f,
        &[
            "REPOSITORY_DIRTY",
            "REPOSITORY_DIVERGED",
            "REPOSITORY_CONFIGURED_BASE_BEHIND",
        ],
    );
}
#[test]
fn remote_missing_and_unavailable_continue_children() {
    let f = Fixture::new(true);
    f.children();
    let daemon = network::GitDaemon::start(f.root.parent().unwrap());
    let origin = connected(&f, Some(&daemon.prefix), "origin");
    f.git(&origin, &["update-ref", "-d", "refs/heads/main"]);
    oracle(
        &f,
        &[
            "REPOSITORY_MISSING_REMOTE_REF",
            "REPOSITORY_DEFAULT_BRANCH_UNAVAILABLE",
            "REPOSITORY_NO_UPSTREAM",
        ],
    );
    f.git(
        &f.root,
        &[
            "remote",
            "set-url",
            "origin",
            &format!("{}absent.git", daemon.prefix),
        ],
    );
    oracle(
        &f,
        &[
            "REPOSITORY_REMOTE_REFRESH_FAILED",
            "REPOSITORY_DEFAULT_BRANCH_UNAVAILABLE",
        ],
    );
}
#[test]
fn remote_non_origin_and_missing_mapping() {
    let f = Fixture::new(true);
    let origin = connected(&f, None, "upstream");
    advance(&f, &origin, "main");
    oracle(
        &f,
        &["REPOSITORY_BEHIND", "REPOSITORY_DEFAULT_BRANCH_BEHIND"],
    );
    f.git(&f.root, &["config", "--unset-all", "remote.upstream.fetch"]);
    oracle(&f, &["REPOSITORY_UPSTREAM_TRACKING_UNAVAILABLE"]);
}
#[test]
fn remote_default_uses_local_when_no_remote_ref_exists() {
    let f = Fixture::new(true);
    connected(&f, None, "origin");
    f.git(&f.root, &["branch", "local-base"]);
    f.git(
        &f.root,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/local-base",
        ],
    );
    f.git(&f.root, &["switch", "-c", "topic"]);
    oracle(
        &f,
        &["REPOSITORY_NO_UPSTREAM", "REPOSITORY_MISSING_REMOTE_REF"],
    );
}
