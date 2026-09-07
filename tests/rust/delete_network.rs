//! Real loopback transfers; the direct daemon child is always killed and reaped.
use super::*;
use std::{
    net::{TcpListener, TcpStream},
    process::{Child, Stdio},
    time::{Duration, Instant},
};

struct Server(Child);
impl Server {
    fn start(root: &Path) -> (Self, String) {
        let socket = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let exec = git(root, &["--exec-path"]);
        let child = Command::new(Path::new(exec.trim()).join("git-daemon"))
            .args([
                "--reuseaddr",
                "--listen=127.0.0.1",
                &format!("--port={port}"),
                "--export-all",
                &format!("--base-path={}", root.display()),
            ])
            .arg(root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut server = Self(child);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            assert!(
                server.0.try_wait().unwrap().is_none(),
                "owned daemon exited"
            );
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            assert!(Instant::now() < deadline, "owned daemon not ready");
            std::thread::sleep(Duration::from_millis(10));
        }
        (server, format!("git://127.0.0.1:{port}/api.git"))
    }
    fn stop(&mut self) {
        if self.0.try_wait().unwrap().is_none() {
            self.0.kill().unwrap();
        }
        self.0.wait().unwrap();
        assert!(self.0.try_wait().unwrap().is_some());
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

fn connected() -> (Fixture, Server, String) {
    let fixture = Fixture::new();
    let (server, url) = Server::start(&fixture.root);
    // Replace only our disposable file clone; the tested clone transfers over TCP.
    fs::remove_dir_all(fixture.workspace.join("repos/api")).unwrap();
    let output = Command::new("git")
        .args(["clone", &url, "repos/api"])
        .current_dir(&fixture.workspace)
        .env("GIT_ALLOW_PROTOCOL", "git")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    set_url(&fixture, Some(&url));
    assert_eq!(
        git(&fixture.workspace.join("repos/api"), &["rev-parse", "HEAD"]),
        git(&fixture.remote, &["rev-parse", "refs/heads/main"])
    );
    (fixture, server, url)
}
fn set_url(fixture: &Fixture, url: Option<&str>) {
    let path = fixture.workspace.join(".arashi/config.json");
    let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    if let Some(url) = url {
        value["repos"]["api"]["gitUrl"] = serde_json::json!(url);
    } else {
        value["repos"]["api"]
            .as_object_mut()
            .unwrap()
            .remove("gitUrl");
    }
    fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(&value).unwrap()),
    )
    .unwrap();
}
fn sources() -> Vec<bool> {
    if std::env::var_os("ARASHI_DELETE_SOURCE_ONLY").is_some() {
        return vec![true];
    }
    if std::env::var_os("ARASHI_TS_PARITY").is_some() {
        vec![true, false]
    } else {
        vec![false]
    }
}
fn observed(f: &Fixture, args: &[&str], source: bool) -> Output {
    let output = f.run_with(args, source);
    println!(
        "source={source} {args:?} exit={} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

#[test]
fn network_retirement_uses_local_loss_evidence_even_when_origin_diverges_or_is_offline() {
    for source in sources() {
        for case in ["published", "diverged", "offline", "omitted"] {
            let (f, mut server, _) = connected();
            let target = f.workspace.join("repos/api");
            if case == "omitted" {
                set_url(&f, None);
            }
            if case == "diverged" {
                fs::write(target.join("README.md"), "local unpublished\n").unwrap();
                git(&target, &["commit", "-am", "local"]);
                fs::write(f.root.join("seed/README.md"), "remote divergence\n").unwrap();
                git(&f.root.join("seed"), &["commit", "-am", "remote"]);
                git(&f.root.join("seed"), &["push", "origin", "main"]);
                assert_ne!(
                    git(&target, &["rev-parse", "HEAD"]),
                    git(&f.remote, &["rev-parse", "main"])
                );
            }
            if case == "offline" {
                server.stop();
            }
            let keep = f.workspace.join("repos/keep");
            fs::write(keep.join("README.md"), "caller stash\n").unwrap();
            git(&keep, &["stash", "push", "-m", "caller"]);
            fs::write(keep.join("caller"), "unselected data\n").unwrap();
            let before = f.snapshot();
            let origin = tree(&f.remote);
            let dry = observed(&f, &["delete", "api", "--dry-run", "--json"], source);
            assert!(
                dry.status.success(),
                "{case}: {}",
                String::from_utf8_lossy(&dry.stdout)
            );
            let plan = json(&dry)["data"]["plan"].clone();
            let loss = plan["warnings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v.as_str().unwrap().starts_with("DELETE_GIT_DATA_LOSS:"));
            assert_eq!(loss, case == "diverged");
            assert!(
                plan["warnings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v.as_str().unwrap().contains("no fetch was performed"))
            );
            let no_force = observed(&f, &["delete", "api", "--json"], source);
            assert_eq!(
                json(&no_force)["error"]["code"],
                if loss {
                    "DELETE_GIT_DATA_LOSS"
                } else {
                    "DELETE_CONFIRMATION_REQUIRED"
                }
            );
            if !source {
                assert_eq!(f.snapshot(), before);
            }
            assert_eq!(tree(&f.remote), origin);
            let forced = observed(&f, &["delete", "api", "--force", "--json"], source);
            assert!(
                forced.status.success(),
                "{case}: {}",
                String::from_utf8_lossy(&forced.stdout)
            );
            assert!(!target.exists());
            assert_eq!(tree(&f.home), before.home);
            assert_eq!(tree(&f.remote), origin);
            for (path, bytes) in &before.workspace {
                if path.starts_with("repos/api") || path == Path::new(".arashi/config.json") {
                    continue;
                }
                assert!(
                    f.workspace.join(path).exists(),
                    "lost surviving path {path:?}"
                );
                if f.workspace.join(path).is_file() {
                    assert_eq!(
                        &fs::read(f.workspace.join(path)).unwrap(),
                        bytes,
                        "{path:?}"
                    );
                }
            }
            let value: Value =
                serde_json::from_slice(&fs::read(f.workspace.join(".arashi/config.json")).unwrap())
                    .unwrap();
            assert!(value["repos"].get("api").is_none());
            assert!(value["repos"].get("keep").is_some());
            assert!(!fs::read_dir(f.workspace.join("repos")).unwrap().any(|v| {
                v.unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".arashi-delete-")
            }));
            server.stop();
        }
    }
}

#[test]
fn network_url_identity_checks_rewrites_and_mismatch_without_contacting_origin() {
    for source in sources() {
        let (f, mut server, url) = connected();
        server.stop();
        for alias in [
            "https://EXAMPLE.test/team/api.git",
            "ssh://git@example.test/team/api.git",
            "git@example.test:team/api.git",
        ] {
            // Source resolves configured rewrites in workspace, not selected clone cwd.
            git(
                &f.workspace,
                &["config", &format!("url.{url}.insteadOf"), alias],
            );
            set_url(&f, Some(alias));
            let before = f.snapshot();
            let out = observed(&f, &["delete", "api", "--dry-run", "--json"], source);
            assert!(out.status.success());
            if !source {
                assert_eq!(f.snapshot(), before);
            }
        }
        set_url(&f, Some("git://127.0.0.1:1/wrong.git"));
        let before = f.snapshot();
        let out = observed(&f, &["delete", "api", "--force", "--json"], source);
        assert_eq!(json(&out)["error"]["code"], "DELETE_TOPOLOGY_INVALID");
        if !source {
            assert_eq!(f.snapshot(), before);
        }
    }
}

#[test]
fn network_linked_caller_data_and_recovery_authority_remain_protected() {
    for case in ["linked", "dirty", "receipt", "promisor"] {
        let (f, mut server, _) = connected();
        server.stop();
        let target = f.workspace.join("repos/api");
        match case {
            "linked" => {
                git(
                    &target,
                    &[
                        "worktree",
                        "add",
                        "--detach",
                        f.workspace.join("linked").to_str().unwrap(),
                    ],
                );
                fs::write(f.workspace.join("linked/caller"), "preserve\n").unwrap();
            }
            "dirty" => {
                fs::write(target.join("caller"), "preserve\n").unwrap();
            }
            "receipt" => {
                let p = f.workspace.join(".git/.arashi-delete-receipts");
                fs::create_dir(&p).unwrap();
                fs::write(p.join("pending.json"), "caller authority\n").unwrap();
            }
            "promisor" => {
                git(&target, &["config", "remote.origin.promisor", "true"]);
            }
            _ => unreachable!(),
        }
        let before = f.snapshot();
        let out = observed(&f, &["delete", "api", "--force", "--json"], false);
        if case == "dirty" {
            assert!(
                out.status.success(),
                "authorized dirty loss: {}",
                String::from_utf8_lossy(&out.stdout)
            );
            assert!(!target.exists());
            assert_eq!(tree(&f.home), before.home);
            assert_eq!(git(&f.remote, &["show-ref"]), before.remote_refs);
        } else {
            assert!(!out.status.success(), "{case}");
            assert_eq!(f.snapshot(), before, "{case}");
        }
    }
}

#[test]
fn network_normalized_fetch_identities_match_source_without_transport() {
    for source in sources() {
        for (configured, stored) in [
            (
                "https://example.test/team/%61pi.git",
                "https://example.test/team/api",
            ),
            (
                "https://[2001:0db8:0:0::1]:443/team/api.git",
                "https://[2001:db8::1]/team/api",
            ),
            (
                "https://example.test/team/old/../api.git",
                "https://example.test/team/api",
            ),
            (
                "https://%75ser@example.test/team/caf%C3%A9.git",
                "https://user@example.test/team/café",
            ),
            (
                "https://EXAMPLE.test:443/team/api.git/",
                "https://example.test/team/api",
            ),
            (
                "http://EXAMPLE.test:80/team/api.GIT",
                "http://example.test/team/api",
            ),
            (
                "git@example.test:team/api.git",
                "ssh://git@example.test/team/api",
            ),
            (
                "ssh://git@EXAMPLE.test:2222/team/api.git",
                "ssh://git@example.test:2222/team/api",
            ),
        ] {
            let (f, mut server, _) = connected();
            server.stop();
            git(
                &f.workspace.join("repos/api"),
                &["remote", "set-url", "origin", stored],
            );
            set_url(&f, Some(configured));
            let before = f.snapshot();
            let out = observed(&f, &["delete", "api", "--dry-run", "--json"], source);
            assert!(out.status.success());
            if !source {
                assert_eq!(f.snapshot(), before);
            }
        }
    }
}

#[test]
fn network_source_and_native_linked_and_dirty_force_contract() {
    for source in sources() {
        for linked in [false, true] {
            let (f, mut server, _) = connected();
            server.stop();
            let target = f.workspace.join("repos/api");
            let dirty = if linked {
                let path = f.workspace.join("linked");
                git(
                    &target,
                    &["worktree", "add", "-b", "topic", path.to_str().unwrap()],
                );
                path
            } else {
                target.clone()
            };
            fs::write(
                dirty.join("caller"),
                "explicit force discards this source-owned fixture data\n",
            )
            .unwrap();
            let before = f.snapshot();
            let preview = observed(&f, &["delete", "api", "--dry-run", "--json"], source);
            assert!(preview.status.success());
            assert!(
                json(&preview)["data"]["plan"]["warnings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v.as_str().unwrap().starts_with("DELETE_GIT_DATA_LOSS:"))
            );
            let denied = observed(&f, &["delete", "api", "--json"], source);
            assert_eq!(json(&denied)["error"]["code"], "DELETE_GIT_DATA_LOSS");
            assert_eq!(
                fs::read(dirty.join("caller")).unwrap(),
                b"explicit force discards this source-owned fixture data\n"
            );
            let forced = observed(&f, &["delete", "api", "--force", "--json"], source);
            assert!(forced.status.success());
            assert!(!target.exists());
            assert!(!dirty.exists());
            assert_eq!(tree(&f.home), before.home);
            assert_eq!(git(&f.remote, &["show-ref"]), before.remote_refs);
        }
    }
}

#[test]
fn file_relative_and_localhost_fetch_identities_execute_without_transport() {
    for source in sources() {
        for relative_url in [false, true] {
            let (f, mut server, _) = connected();
            server.stop();
            let target = f.workspace.join("repos/api");
            let configured = if relative_url {
                "../api.git".to_owned()
            } else {
                format!("file://localhost{}", f.remote.display())
            };
            let stored = if relative_url {
                "../../../api.git".to_owned()
            } else {
                f.remote.to_str().unwrap().to_owned()
            };
            git(&target, &["remote", "set-url", "origin", &stored]);
            set_url(&f, Some(&configured));
            let preview = observed(&f, &["delete", "api", "--dry-run", "--json"], source);
            assert!(preview.status.success());
            let forced = observed(&f, &["delete", "api", "--force", "--json"], source);
            assert!(forced.status.success());
            assert!(!target.exists());
        }
    }
}

#[test]
fn network_stash_tags_custom_refs_and_other_tracking_refs_match_source_loss_contract() {
    let mut expected = None;
    for source in sources() {
        let (f, mut server, _) = connected();
        server.stop();
        let target = f.workspace.join("repos/api");
        git(&target, &["tag", "light"]);
        git(&target, &["tag", "-a", "annotated", "-m", "release"]);
        git(&target, &["update-ref", "refs/custom/caller", "HEAD"]);
        git(
            &target,
            &[
                "remote",
                "add",
                "upstream",
                "https://unavailable.example/api.git",
            ],
        );
        git(
            &target,
            &["update-ref", "refs/remotes/upstream/main", "HEAD"],
        );
        fs::write(target.join("README.md"), "stash-only caller content\n").unwrap();
        git(&target, &["stash", "push", "-m", "caller"]);
        let keep_before = tree(&f.workspace.join("repos/keep"));
        let preview = observed(&f, &["delete", "api", "--dry-run", "--json"], source);
        assert!(
            preview.status.success(),
            "{}",
            String::from_utf8_lossy(&preview.stdout)
        );
        let document = json(&preview);
        let refs = document["data"]["plan"]["items"].as_array().unwrap().iter().filter(|item|item["kind"]=="local-ref").map(|item|serde_json::json!({"ref":item["ref"],"protected":item["reasonCode"]=="DELETE_GIT_DATA_LOSS"})).collect::<Vec<_>>();
        if source {
            expected = Some(refs);
        } else if let Some(expected) = &expected {
            assert_eq!(&refs, expected);
        }
        let denied = observed(&f, &["delete", "api", "--json"], source);
        assert_eq!(json(&denied)["error"]["code"], "DELETE_GIT_DATA_LOSS");
        let forced = observed(&f, &["delete", "api", "--force", "--json"], source);
        assert!(forced.status.success());
        assert!(!target.exists());
        assert_eq!(tree(&f.workspace.join("repos/keep")), keep_before);
    }
}

#[test]
fn network_receipts_cross_source_native_retry_and_preserve_foreign_storage() {
    if std::env::var_os("ARASHI_TS_PARITY").is_none() {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    for source_first in [true, false] {
        let (f, mut server, _) = connected();
        server.stop();
        let target = f.workspace.join("repos/api");
        let config_dir = f.workspace.join(".arashi");
        let before = fs::read(config_dir.join("config.json")).unwrap();
        fs::set_permissions(&config_dir, fs::Permissions::from_mode(0o555)).unwrap();
        let failed = observed(&f, &["delete", "api", "--force", "--json"], source_first);
        fs::set_permissions(&config_dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!failed.status.success());
        assert!(
            !target.exists(),
            "source ordering: {}",
            String::from_utf8_lossy(&failed.stdout)
        );
        assert_eq!(fs::read(config_dir.join("config.json")).unwrap(), before);
        let directory = f.workspace.join(".git/.arashi-delete-receipts");
        let foreign = directory.join("foreign-note");
        fs::write(&foreign, "preserve\n").unwrap();
        let retry = observed(&f, &["delete", "api", "--force", "--json"], !source_first);
        assert!(
            retry.status.success(),
            "source_first={source_first}: {}",
            String::from_utf8_lossy(&retry.stdout)
        );
        assert_eq!(fs::read(&foreign).unwrap(), b"preserve\n");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        let config: Value =
            serde_json::from_slice(&fs::read(config_dir.join("config.json")).unwrap()).unwrap();
        assert!(config["repos"].get("api").is_none());
    }
}

#[test]
fn network_publication_and_cleanup_failures_follow_source_ordering() {
    use std::os::unix::fs::PermissionsExt;
    for source in sources() {
        for partial in [false, true] {
            let (f, mut server, _) = connected();
            server.stop();
            let target = f.workspace.join("repos/api");
            let blocked = if partial {
                target.join(".git/objects")
            } else {
                f.workspace.join(".arashi")
            };
            let before = f.snapshot();
            let config_before = fs::read(f.workspace.join(".arashi/config.json")).unwrap();
            let keep_before = tree(&f.workspace.join("repos/keep"));
            fs::set_permissions(&blocked, fs::Permissions::from_mode(0o555)).unwrap();
            let out = observed(&f, &["delete", "api", "--force", "--json"], source);
            assert!(!out.status.success());
            assert_eq!(json(&out)["error"]["code"], "DELETE_PARTIAL_FAILURE");
            // Source restores the owned (possibly partially cleaned) clone on cleanup
            // failure, but does not resurrect it after configuration publication fails.
            assert_eq!(target.exists(), partial);
            assert_eq!(
                fs::read(f.workspace.join(".arashi/config.json")).unwrap(),
                config_before
            );
            fs::set_permissions(&blocked, fs::Permissions::from_mode(0o755)).unwrap();
            if !partial {
                let retry = observed(&f, &["delete", "api", "--force", "--json"], source);
                assert!(
                    retry.status.success(),
                    "{}",
                    String::from_utf8_lossy(&retry.stdout)
                );
            }
            assert_eq!(tree(&f.workspace.join("repos/keep")), keep_before);
            assert_eq!(tree(&f.home), before.home);
            assert_eq!(git(&f.remote, &["show-ref"]), before.remote_refs);
        }
    }
}
