//! Disposable loopback Git transport; no public network or credentials.
use std::{
    net::{TcpListener, TcpStream},
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub struct GitDaemon {
    child: Child,
    pub prefix: String,
}
impl GitDaemon {
    pub fn start(root: &Path) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut command = Command::new("git");
        command
            .args([
                "daemon",
                "--reuseaddr",
                "--export-all",
                "--listen=127.0.0.1",
                &format!("--port={port}"),
                &format!("--base-path={}", root.display()),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut server = Self {
            child: command.spawn().unwrap(),
            prefix: format!("git://127.0.0.1:{port}/"),
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            assert!(
                server.child.try_wait().unwrap().is_none(),
                "git daemon exited"
            );
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            assert!(Instant::now() < deadline, "git daemon readiness timeout");
            thread::sleep(Duration::from_millis(20));
        }
        server
    }
}
impl Drop for GitDaemon {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            unsafe extern "C" {
                fn kill(pid: i32, sig: i32) -> i32;
            }
            kill(-(self.child.id() as i32), 9);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
