#[path = "../src/rust/launch.rs"]
pub mod launch;
#[path = "rust/launch-native.rs"]
mod native;
#[path = "rust/launch-resolve.rs"]
mod resolution;
use launch::*;
use std::time::{Duration, Instant};
fn ctx() -> LaunchContext {
    LaunchContext {
        platform: Platform::native(),
        env: Environment::new(),
        cwd: std::env::current_dir().unwrap(),
        home: None,
    }
}
#[test]
fn detector_priority_and_presence() {
    let mut c = ctx();
    c.env.insert("VSCODE_PID".into(), "".into());
    assert_eq!(
        resolve::detect_context(&c.env),
        Some(LaunchSelector::Ide(Ide::VsCode))
    );
    for (key, value, want) in [
        (
            "TERM_PROGRAM_VERSION",
            "Kiro",
            LaunchSelector::Ide(Ide::Kiro),
        ),
        (
            "VSCODE_GIT_ASKPASS_NODE",
            "Cursor",
            LaunchSelector::Ide(Ide::Cursor),
        ),
        (
            "CMUX_SURFACE_ID",
            "x",
            LaunchSelector::Managed(ManagedFamily::Cmux),
        ),
        (
            "HERDR_ENV",
            " 1 ",
            LaunchSelector::Managed(ManagedFamily::Herdr),
        ),
        ("TMUX", " x ", LaunchSelector::Managed(ManagedFamily::Tmux)),
    ] {
        c.env.insert(key.into(), value.into());
        assert_eq!(resolve::detect_context(&c.env), Some(want));
    }
}
#[test]
fn explicit_missing_ide_and_auto_fallback_tab() {
    let mut c = ctx();
    c.platform = Platform::Linux;
    c.env
        .insert("PATH".into(), "/nonexistent-arashi-launch-path".into());
    c.env.insert("VSCODE_PID".into(), "".into());
    let i = LaunchIntent {
        selector: LaunchSelector::Ide(Ide::Kiro),
        disposition: LaunchDisposition::Window,
    };
    assert_eq!(
        resolve::preflight(&i, &c).unwrap_err().code,
        LaunchErrorCode::IdeNotFound
    );
    let i = LaunchIntent {
        selector: LaunchSelector::Auto,
        disposition: LaunchDisposition::Tab,
    };
    c.env.insert("WEZTERM_PANE".into(), "7".into());
    let p = resolve::preflight(&i, &c).unwrap();
    assert!(matches!(p, LaunchPlan::Platform(_)));
    c.env.remove("WEZTERM_PANE");
    assert_eq!(
        resolve::preflight(&i, &c).unwrap_err().code,
        LaunchErrorCode::TabDispositionUnsupported
    );
}
#[test]
fn windows_argument_quote_edges() {
    assert_eq!(process::quote_windows_argument(""), "\"\"");
    assert_eq!(process::quote_windows_argument("a\"b"), "\"a\\\"b\"");
    assert_eq!(process::quote_windows_argument("a\\"), "\"a\\\\\"");
    assert_eq!(
        process::quote_windows_argument("%PATH%!^&|() 雪"),
        "\"%PATH%!^&|() 雪\""
    );
}
#[test]
fn child_fixture() {
    let Ok(mode) = std::env::var("ARASHI_LAUNCH_FIXTURE") else {
        return;
    };
    match mode.as_str() {
        "record" => {
            let out = serde_json::json!({"args":std::env::args().collect::<Vec<_>>(),"directive":std::env::var("ARASHI_DIRECTIVE_FILE").ok(),"shell":std::env::var("ARASHI_SHELL").ok(),"cwd":std::env::current_dir().unwrap()});
            std::fs::write(
                std::env::var("ARASHI_LAUNCH_RECORD").unwrap(),
                out.to_string(),
            )
            .unwrap();
        }
        "fail" => std::process::exit(17),
        "long" => {
            std::fs::write(std::env::var("ARASHI_LAUNCH_RECORD").unwrap(), "started").unwrap();
            use std::io::Read;
            let mut socket =
                std::net::TcpStream::connect(std::env::var("ARASHI_LAUNCH_BARRIER").unwrap())
                    .unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(15)))
                .unwrap();
            let mut release = [0];
            socket.read_exact(&mut release).unwrap();
            assert_eq!(release, [1]);
            std::fs::write(std::env::var("ARASHI_LAUNCH_FINISHED").unwrap(), "survived").unwrap();
        }
        "streams" => {
            use std::io::Write;
            let bytes = vec![b'x'; 262144];
            std::io::stdout().write_all(&bytes).unwrap();
            std::io::stderr().write_all(&bytes).unwrap();
        }
        _ => panic!("unknown fixture"),
    }
    std::process::exit(0);
}
fn child(mode: &str, dir: &std::path::Path) -> (Vec<String>, Environment) {
    let command = vec![
        std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        "--exact".into(),
        "child_fixture".into(),
        "--nocapture".into(),
    ];
    let mut env: Environment = std::env::vars().collect();
    env.insert("ARASHI_LAUNCH_FIXTURE".into(), mode.into());
    env.insert(
        "ARASHI_LAUNCH_RECORD".into(),
        dir.join("record").to_string_lossy().into_owned(),
    );
    env.insert(
        "ARASHI_LAUNCH_FINISHED".into(),
        dir.join("finished").to_string_lossy().into_owned(),
    );
    (command, env)
}
#[test]
fn real_child_strips_directives_and_drains_streams() {
    let d = tempfile::tempdir().unwrap();
    let (cmd, mut env) = child("record", d.path());
    env.insert("ARASHI_DIRECTIVE_FILE".into(), "do-not-touch".into());
    env.insert("ARASHI_SHELL".into(), "bash".into());
    assert_eq!(process::run(&cmd, d.path(), &env, false).exit_code, 0);
    let v: serde_json::Value =
        serde_json::from_slice(&std::fs::read(d.path().join("record")).unwrap()).unwrap();
    assert!(v["directive"].is_null());
    assert!(v["shell"].is_null());
    let (cmd, env) = child("streams", d.path());
    let r = process::run(&cmd, d.path(), &env, false);
    assert_eq!(r.exit_code, 0);
    assert!(r.stdout.len() >= 262144);
    assert_eq!(r.stderr.len(), 262144);
}
// Readiness is the child's TCP connection. Completion is forbidden until the
// parent has received the launcher result and explicitly releases the child.
// Deadlines are deadlock watchdogs, not assertions about machine speed.
fn detached_barrier<T: Send>(
    env: &mut Environment,
    run: impl FnOnce(&Environment) -> T + Send,
) -> T {
    use std::io::Write;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    env.insert(
        "ARASHI_LAUNCH_BARRIER".into(),
        listener.local_addr().unwrap().to_string(),
    );
    std::thread::scope(|scope| {
        let (send, receive) = std::sync::mpsc::channel();
        scope.spawn(move || {
            let _ = send.send(run(env));
        });
        let start = Instant::now();
        let mut socket = loop {
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        start.elapsed() < Duration::from_secs(10),
                        "child never reached readiness barrier"
                    );
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(e) => panic!("{e}"),
            }
        };
        let result = receive.recv_timeout(Duration::from_secs(10));
        // Release even when the launcher improperly waits, so failure can settle.
        socket.write_all(&[1]).unwrap();
        result.expect("launcher waited for a child blocked on parent release")
    })
}
#[test]
fn detached_survives_and_immediate_failure_is_not_success() {
    let d = tempfile::tempdir().unwrap();
    let (cmd, mut env) = child("long", d.path());
    let r = detached_barrier(&mut env, |env| {
        let result = process::run(&cmd, d.path(), env, true);
        assert!(!d.path().join("finished").exists());
        result
    });
    assert_eq!(r.exit_code, 0);
    assert!(d.path().join("record").exists());
    let start = Instant::now();
    while !d.path().join("finished").exists() && start.elapsed() < Duration::from_secs(4) {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(d.path().join("finished").exists());
    let (cmd, env) = child("fail", d.path());
    assert_eq!(process::run(&cmd, d.path(), &env, true).exit_code, 17);
    assert_eq!(
        process::run(
            &["/missing/arashi-launch-executable".into()],
            d.path(),
            &env,
            true
        )
        .exit_code,
        -1
    );
}
#[test]
fn platform_failure_preserves_target() {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("owned"), "keep").unwrap();
    let mut c = ctx();
    let (cmd, env) = child("fail", d.path());
    c.env = env;
    let plan = PlatformPlan {
        family: PlatformFamily::Ide(Ide::Kiro),
        disposition: LaunchDisposition::Window,
        ide_command: Some(cmd[0].clone()),
        mac_target: None,
    };
    let target = LaunchTarget {
        worktree_path: d.path().to_path_buf(),
        repository: "repo".into(),
        branch: "topic".into(),
        herdr_source: None,
    };
    assert!(platform::execute_platform(&target, &plan, &c).is_err());
    assert_eq!(
        std::fs::read_to_string(d.path().join("owned")).unwrap(),
        "keep"
    );
}
