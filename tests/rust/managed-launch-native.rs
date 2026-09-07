use super::*;
#[test]
#[ignore = "subprocess driver entry, requires FIXTURE_INPUT"]
fn fixture_entry() {
    if std::env::var_os("FIXTURE_INPUT").is_none() {
        return;
    }
    let input: serde_json::Value =
        serde_json::from_str(&std::env::var("FIXTURE_INPUT").unwrap()).unwrap();
    let c = &input["candidate"];
    let o = &input["options"];
    let mut target = target(Path::new(c["worktreePath"].as_str().unwrap()));
    target.repository = c["repoName"].as_str().unwrap().into();
    target.branch = c["branchName"].as_str().unwrap().into();
    target.herdr_source = c["herdrSource"]["path"].as_str().map(Into::into);
    let ctx = LaunchContext::native().unwrap();
    let family = if o["tmux"] == true {
        ManagedFamily::Tmux
    } else if o["sesh"] == true {
        ManagedFamily::Sesh
    } else if o["herdr"] == true {
        ManagedFamily::Herdr
    } else {
        match launch::resolve::detect_context(&ctx.env).unwrap() {
            LaunchSelector::Managed(f) => f,
            _ => panic!("fixture expects managed family"),
        }
    };
    let disposition = if o["disposition"] == "tab" {
        LaunchDisposition::Tab
    } else {
        LaunchDisposition::Window
    };
    let result = managed_launch::execute_with(
        &ManagedPlan {
            family,
            disposition,
        },
        &target,
        &ctx,
        input["lockRoot"].as_str().map(Path::new),
        &mut |args, cwd, env| launch::process::run(args, cwd, env, false),
    );
    let output = match result {
        Ok(r) => {
            json!({"ok":true,"result":{"command":r.command,"mode":r.mode,"disposition":o["disposition"]}})
        }
        Err(e) => json!({"ok":false,"code":format!("{:?}",e.code),"message":e.message}),
    };
    println!("ARASHI_FIXTURE_RESULT={output}");
}
#[cfg(unix)]
#[test]
#[ignore = "installed tmux acceptance, private server only"]
fn installed_private_tmux() {
    if std::env::var("ARASHI_MANAGED_NATIVE_TMUX").as_deref() != Ok("1") {
        return;
    }
    use std::{fs, process::Command};
    let dir = tempfile::Builder::new()
        .prefix("arashi-mux-")
        .tempdir()
        .unwrap();
    let root = dir.path().canonicalize().unwrap();
    let socket = root.join("server");
    let cwd = root.join("quoted ' space ; $HOME");
    fs::create_dir(&cwd).unwrap();
    let mut ctx = LaunchContext::native().unwrap();
    ctx.cwd = cwd.clone();
    ctx.home = Some(root.clone());
    ctx.env = [
        ("PATH".into(), ctx.env.get("PATH").unwrap().clone()),
        ("HOME".into(), root.to_string_lossy().into_owned()),
        ("SHELL".into(), "/bin/sh".into()),
        ("TERM".into(), "xterm-256color".into()),
    ]
    .into();
    struct Server {
        socket: std::path::PathBuf,
    }
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = Command::new("tmux")
                .args(["-S"])
                .arg(&self.socket)
                .arg("kill-server")
                .output();
        }
    }
    let mux = |args: &[&str]| {
        let out = Command::new("tmux")
            .arg("-S")
            .arg(&socket)
            .args(["-f", "/dev/null"])
            .args(args)
            .current_dir(&cwd)
            .env_clear()
            .envs(&ctx.env)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    };
    let _server = Server {
        socket: socket.clone(),
    };
    mux(&[
        "new-session",
        "-d",
        "-s",
        "arashi-fixture",
        "-c",
        cwd.to_str().unwrap(),
        "sleep 60",
    ]);
    let pid = mux(&["display-message", "-p", "-t", "arashi-fixture", "#{pid}"]);
    let tmux = format!("{},{pid},0", socket.display());
    // Readback intentionally uses the isolated server, never inherited TMUX.
    for (index, disposition) in [LaunchDisposition::Window, LaunchDisposition::Tab]
        .into_iter()
        .enumerate()
    {
        let mut child = ctx.clone();
        child.env.insert("TMUX".into(), tmux.clone());
        child.env.insert(
            "ARASHI_DIRECTIVE_FILE".into(),
            root.join("must-not-write").to_string_lossy().into_owned(),
        );
        let out = managed_launch::execute(
            &ManagedPlan {
                family: ManagedFamily::Tmux,
                disposition,
            },
            &target(&cwd),
            &child,
        )
        .unwrap();
        assert_eq!(
            out.command,
            vec![
                "tmux".to_string(),
                "new-window".into(),
                "-c".into(),
                cwd.to_str().unwrap().into()
            ]
        );
        let observed = mux(&[
            "list-windows",
            "-t",
            "arashi-fixture",
            "-F",
            "#{window_id}|#{pane_current_path}",
        ]);
        assert_eq!(observed.lines().count(), index + 2);
        assert!(
            observed
                .lines()
                .all(|l| l.ends_with(&format!("|{}", cwd.display())))
        );
        assert!(!root.join("must-not-write").exists());
        println!("{disposition:?}: {observed}");
    }
}

#[test]
#[ignore = "cross-process lock oracle entry, requires LOCK_FIXTURE_ROOT"]
fn lock_entry() {
    use std::io::{self, Write};
    let Some(root) = std::env::var_os("LOCK_FIXTURE_ROOT") else {
        return;
    };
    let timeout = std::env::var("LOCK_FIXTURE_TIMEOUT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1000);
    let lock = match managed_launch::lock::IdentityLock::acquire(
        "arashi-v1-interop",
        Some(Path::new(&root)),
        std::time::Duration::from_millis(timeout),
    ) {
        Ok(lock) => lock,
        Err(e) => {
            println!("LOCK_DENIED={e}");
            return;
        }
    };
    println!("LOCK_READY={}", std::process::id());
    io::stdout().flush().unwrap();
    let mut input = String::new();
    io::stdin().read_line(&mut input).unwrap();
    if input.trim() == "crash" {
        std::process::exit(0);
    }
    lock.release().unwrap();
    println!("LOCK_RELEASED");
}
