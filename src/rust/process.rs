//! Captured argv execution for exec/setup and a separate noninteractive lifecycle
//! runner. Both preserve the same platform-specific direct launch foundation.
use std::{
    io::{self, Read},
    path::Path,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

pub struct Captured {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub elapsed_ms: u128,
    pub timed_out: bool,
    pub signaled: bool,
    /// Actual child termination signal, independent of synthetic timeout/interrupt exits.
    #[cfg(unix)]
    pub termination_signal: Option<i32>,
    pub error: Option<String>,
}

fn read(mut pipe: impl Read) -> io::Result<String> {
    let mut bytes = Vec::new();
    pipe.read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn run(argv: &[String], cwd: &Path, timeout: Option<Duration>) -> io::Result<Captured> {
    let start = Instant::now();
    let mut command = Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .current_dir(cwd)
        .env_remove("ARASHI_DIRECTIVE_FILE")
        .env_remove("ARASHI_SHELL")
        // Like the retained runtime, input is a private pipe, not terminal input.
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = if cwd.exists() {
        spawn_direct(&mut command)
    } else {
        Err(io::ErrorKind::NotFound.into())
    };
    let mut child = match child {
        Ok(child) => child,
        Err(error) => {
            // On macOS Node throws ENOEXEC synchronously, unlike asynchronous
            // ENOENT/EACCES failures. Setup's source catch returns -1 and stderr.
            let enoexec = cfg!(target_os = "macos") && error.raw_os_error() == Some(8);
            return Ok(Captured {
                stdout: String::new(),
                stderr: if enoexec {
                    "spawn ENOEXEC".into()
                } else {
                    String::new()
                },
                exit_code: if enoexec && timeout.is_some() { -1 } else { 1 },
                elapsed_ms: start.elapsed().as_millis(),
                timed_out: false,
                signaled: false,
                #[cfg(unix)]
                termination_signal: None,
                // Node's asynchronous spawn error resolves exit=1 with empty pipes.
                // The runtime's explicit missing-cwd check instead throws.
                error: (!cwd.exists())
                    .then(|| format!("Working directory not found: {}", cwd.display()))
                    .or_else(|| enoexec.then(|| "spawn ENOEXEC".into())),
            });
        }
    };
    thread::scope(|scope| {
        let stdout = scope.spawn(read_pipe(child.stdout.take().unwrap()));
        let stderr = scope.spawn(read_pipe(child.stderr.take().unwrap()));
        let mut timed_out = false;
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if !timed_out && timeout.is_some_and(|limit| start.elapsed() >= limit) {
                terminate(&mut child)?;
                timed_out = true;
            }
            thread::sleep(Duration::from_millis(2));
        };
        Ok(Captured {
            stdout: stdout.join().expect("stdout reader")?,
            stderr: stderr.join().expect("stderr reader")?,
            exit_code: status.code().unwrap_or(128),
            elapsed_ms: start.elapsed().as_millis(),
            timed_out: timed_out && terminated_by_timeout(&status),
            signaled: status.code().is_none(),
            #[cfg(unix)]
            termination_signal: std::os::unix::process::ExitStatusExt::signal(&status),
            error: None,
        })
    })
}

/// Run a command whose complete subprocess tree must settle on timeout.
#[cfg(unix)]
fn tree_reader(
    mut pipe: impl Read + std::os::fd::AsRawFd + Send,
    stop: Arc<AtomicBool>,
) -> impl FnOnce() -> io::Result<String> {
    move || {
        unsafe extern "C" {
            fn fcntl(fd: i32, command: i32, ...) -> i32;
        }
        // F_GETFL=3 and F_SETFL=4 are stable POSIX values. O_NONBLOCK is
        // platform-specific (Linux/Android differ from Darwin/BSD).
        #[cfg(any(target_os = "linux", target_os = "android"))]
        const O_NONBLOCK: i32 = 0x800;
        #[cfg(any(target_os = "solaris", target_os = "illumos"))]
        const O_NONBLOCK: i32 = 0x80;
        #[cfg(not(any(
            target_os = "linux",
            target_os = "android",
            target_os = "solaris",
            target_os = "illumos"
        )))]
        const O_NONBLOCK: i32 = 0x4;
        let flags = unsafe { fcntl(pipe.as_raw_fd(), 3) };
        if flags < 0 || unsafe { fcntl(pipe.as_raw_fd(), 4, flags | O_NONBLOCK) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 8192];
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            match pipe.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => bytes.extend_from_slice(&buffer[..count]),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(2));
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
}

#[cfg(windows)]
fn tree_reader(
    pipe: impl Read + Send,
    _stop: Arc<AtomicBool>,
) -> impl FnOnce() -> io::Result<String> {
    read_pipe(pipe)
}

pub(crate) fn run_tree(argv: &[String], cwd: &Path, timeout: Duration) -> io::Result<Captured> {
    let start = Instant::now();
    let mut command = Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .current_dir(cwd)
        .env_remove("ARASHI_DIRECTIVE_FILE")
        .env_remove("ARASHI_SHELL")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    let (lineage, descriptor) = lifecycle::Lineage::create()?;
    #[cfg(unix)]
    {
        use std::os::{fd::AsRawFd, unix::process::CommandExt};
        unsafe extern "C" {
            fn setpgid(pid: i32, pgid: i32) -> i32;
            fn dup2(old: i32, new: i32) -> i32;
            fn fcntl(fd: i32, command: i32, ...) -> i32;
        }
        let fd = descriptor.as_raw_fd();
        // SAFETY: these calls are async-signal-safe and use prepared descriptors.
        unsafe {
            command.pre_exec(move || {
                if setpgid(0, 0) < 0 || dup2(fd, 3) < 0 || fcntl(3, 2, 0_i32) < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
    let mut child = spawn_direct(&mut command)?;
    #[cfg(unix)]
    drop(descriptor);
    let pid = child.id();
    let cancel_readers = Arc::new(AtomicBool::new(false));
    thread::scope(|scope| {
        let stdout = scope.spawn(tree_reader(
            child.stdout.take().unwrap(),
            Arc::clone(&cancel_readers),
        ));
        let stderr = scope.spawn(tree_reader(
            child.stderr.take().unwrap(),
            Arc::clone(&cancel_readers),
        ));
        let mut status = None;
        let mut timed_out = false;
        let mut term_at = None;
        let mut settle_at = None;
        let mut settlement_complete = false;
        let mut cleanup_unresolved = false;
        #[cfg(unix)]
        let mut observed = lifecycle::ProcessIdentity::capture(pid as i32)
            .into_iter()
            .collect::<Vec<_>>();
        #[cfg(unix)]
        let mut next_lineage_probe = std::cmp::min(timeout / 2, Duration::from_millis(25));
        loop {
            if status.is_none() {
                status = child.try_wait()?;
            }
            #[cfg(unix)]
            if !settlement_complete && start.elapsed() >= next_lineage_probe {
                // Continue ownership discovery through TERM/KILL settlement so a
                // tracked child cannot fork an untracked survivor during escalation.
                lineage.signal_owned_tree(
                    pid,
                    status.is_none(),
                    &mut observed,
                    if settle_at.is_some() { 9 } else { 0 },
                );
                next_lineage_probe = start.elapsed() + Duration::from_millis(25);
            }
            if !timed_out && start.elapsed() >= timeout {
                timed_out = true;
                #[cfg(unix)]
                lineage.signal_owned_tree(pid, status.is_none(), &mut observed, 15);
                #[cfg(windows)]
                signal_tree(pid, false);
                term_at = Some(Instant::now());
            }
            if timed_out && term_at.is_some_and(|sent| sent.elapsed() >= Duration::from_millis(100))
            {
                #[cfg(unix)]
                lineage.signal_owned_tree(pid, status.is_none(), &mut observed, 9);
                #[cfg(windows)]
                signal_tree(pid, true);
                term_at = None;
                settle_at = Some(Instant::now());
            }
            if !settlement_complete
                && settle_at.is_some_and(|sent| sent.elapsed() >= Duration::from_millis(500))
            {
                #[cfg(unix)]
                {
                    lineage.signal_owned_tree(pid, status.is_none(), &mut observed, 9);
                    cleanup_unresolved = lineage.has_live(&mut observed);
                }
                cancel_readers.store(true, Ordering::SeqCst);
                settlement_complete = true;
            }
            if status.is_some()
                && stdout.is_finished()
                && stderr.is_finished()
                && (!timed_out || settlement_complete)
            {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        let status = status.unwrap();
        Ok(Captured {
            stdout: stdout.join().expect("tree stdout reader")?,
            stderr: stderr.join().expect("tree stderr reader")?,
            exit_code: status.code().unwrap_or(128),
            elapsed_ms: start.elapsed().as_millis(),
            timed_out,
            signaled: status.code().is_none(),
            #[cfg(unix)]
            termination_signal: std::os::unix::process::ExitStatusExt::signal(&status),
            error: cleanup_unresolved.then(|| {
                "Timed-out subprocess tree did not settle; repository recovery is unsafe".to_owned()
            }),
        })
    })
}

#[cfg(windows)]
fn signal_tree(pid: u32, force: bool) {
    let mut command = Command::new("taskkill");
    command.args(["/PID", &pid.to_string(), "/T"]);
    if force {
        command.arg("/F");
    }
    let _ = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(target_os = "macos"))]
fn spawn_direct(command: &mut Command) -> io::Result<std::process::Child> {
    command.spawn()
}

#[cfg(target_os = "macos")]
fn spawn_direct(command: &mut Command) -> io::Result<std::process::Child> {
    use std::{
        collections::BTreeMap,
        ffi::CString,
        os::unix::{ffi::OsStrExt, process::CommandExt},
    };
    unsafe extern "C" {
        fn execve(
            path: *const std::ffi::c_char,
            argv: *const *const std::ffi::c_char,
            envp: *const *const std::ffi::c_char,
        ) -> i32;
    }
    let cstring = |bytes: &[u8]| CString::new(bytes).map_err(io::Error::from);
    let argv = std::iter::once(command.get_program())
        .chain(command.get_args())
        .map(|arg| cstring(arg.as_bytes()))
        .collect::<io::Result<Vec<_>>>()?;
    let mut environment: BTreeMap<_, _> = std::env::vars_os().collect();
    for (key, value) in command.get_envs() {
        if let Some(value) = value {
            environment.insert(key.to_owned(), value.to_owned());
        } else {
            environment.remove(key);
        }
    }
    let program = command.get_program().as_bytes();
    // Match libuv's Darwin search: slash bypasses PATH; empty/relative entries
    // resolve in the child's cwd. Do not preselect using access or file headers:
    // only the kernel can decide whether a candidate is executable.
    let candidates = if program.contains(&b'/') || program.is_empty() {
        vec![cstring(program)?]
    } else {
        let path = environment
            .get(std::ffi::OsStr::new("PATH"))
            .map_or(b"/usr/bin:/bin".as_slice(), |p| p.as_bytes());
        path.split(|b| *b == b':')
            .map(|dir| {
                let mut candidate = dir.to_vec();
                if !dir.is_empty() {
                    candidate.push(b'/');
                }
                candidate.extend_from_slice(program);
                cstring(&candidate)
            })
            .collect::<io::Result<Vec<_>>>()?
    };
    let env = environment
        .iter()
        .map(|(key, value)| {
            let mut entry = key.as_bytes().to_vec();
            entry.push(b'=');
            entry.extend_from_slice(value.as_bytes());
            cstring(&entry)
        })
        .collect::<io::Result<Vec<_>>>()?;
    struct Strings {
        _values: Vec<CString>,
        pointers: Vec<*const std::ffi::c_char>,
    }
    impl Strings {
        fn new(values: Vec<CString>) -> Self {
            let pointers = values
                .iter()
                .map(|s| s.as_ptr())
                .chain(std::iter::once(std::ptr::null()))
                .collect();
            Self {
                _values: values,
                pointers,
            }
        }
        fn as_ptr(&self) -> *const *const std::ffi::c_char {
            self.pointers.as_ptr()
        }
    }
    // SAFETY: pointers refer only to owned CString allocations, which remain
    // stable when moved. Both arrays and strings are immutable after creation.
    unsafe impl Send for Strings {}
    unsafe impl Sync for Strings {}
    let argv = Strings::new(argv);
    let env = Strings::new(env);
    // SAFETY: after fork this callback only calls
    // async-signal-safe execve, and returns OS errors. Captured CStrings remain
    // alive and NUL-terminated; pointer arrays have trailing NULLs. No locks,
    // allocations, environment access or destructors run in the callback.
    // It NEVER returns Ok: Rust must not proceed to execvp's shell fallback.
    unsafe {
        command.pre_exec(move || {
            let mut last = io::Error::from_raw_os_error(2); // Darwin ENOENT
            let mut denied = false;
            for path in &candidates {
                execve(path.as_ptr(), argv.as_ptr(), env.as_ptr());
                last = io::Error::last_os_error();
                match last.raw_os_error() {
                    Some(13) => denied = true, // EACCES: try later PATH entries
                    Some(2 | 20) => {}         // ENOENT / ENOTDIR
                    _ => return Err(last),     // including ENOEXEC: no shell or search fallback
                }
            }
            Err(if denied {
                io::Error::from_raw_os_error(13)
            } else {
                last
            })
        });
    }
    command.spawn()
}
fn read_pipe(pipe: impl Read + Send) -> impl FnOnce() -> io::Result<String> {
    move || read(pipe)
}
#[cfg(unix)]
fn terminate(child: &mut std::process::Child) -> io::Result<()> {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    // SAFETY: pid belongs to our unreaped child; POSIX SIGTERM is 15. Like
    // setup's source runner, this signals the direct child, not a process group.
    if unsafe { kill(child.id() as i32, 15) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
#[cfg(not(unix))]
fn terminate(child: &mut std::process::Child) -> io::Result<()> {
    child.kill()
}

#[cfg(unix)]
fn terminated_by_timeout(status: &std::process::ExitStatus) -> bool {
    use std::os::unix::process::ExitStatusExt;
    status.signal() == Some(15)
}
#[cfg(not(unix))]
fn terminated_by_timeout(_status: &std::process::ExitStatus) -> bool {
    true
}

/// Noninteractive lifecycle execution. Kept separate from setup's direct-child
/// timeout contract; both launch through spawn_direct (including Darwin ENOEXEC).
#[cfg(unix)]
pub(crate) mod lifecycle {
    use super::*;
    use std::{
        collections::BTreeMap,
        os::unix::process::CommandExt,
        sync::atomic::{AtomicBool, Ordering},
    };
    static INTERRUPTED: AtomicBool = AtomicBool::new(false);
    unsafe extern "C" {
        fn signal(sig: i32, handler: usize) -> usize;
        fn kill(pid: i32, sig: i32) -> i32;
        fn dup2(old: i32, new: i32) -> i32;
        fn fcntl(fd: i32, command: i32, ...) -> i32;
    }
    extern "C" fn interrupt(_: i32) {
        INTERRUPTED.store(true, Ordering::SeqCst);
    }
    pub struct InterruptGuard(usize);
    impl InterruptGuard {
        pub fn install() -> io::Result<Self> {
            INTERRUPTED.store(false, Ordering::SeqCst);
            // SAFETY: handler only stores to a lock-free atomic; restored on drop.
            let old = unsafe { signal(2, interrupt as *const () as usize) };
            if old == usize::MAX {
                return Err(io::Error::last_os_error());
            }
            Ok(Self(old))
        }
    }
    impl Drop for InterruptGuard {
        fn drop(&mut self) {
            unsafe {
                signal(2, self.0);
            }
            INTERRUPTED.store(false, Ordering::SeqCst);
        }
    }
    pub fn interrupted() -> bool {
        INTERRUPTED.load(Ordering::SeqCst)
    }
    pub(super) struct Lineage(std::path::PathBuf);
    #[derive(Clone)]
    pub(super) struct ProcessIdentity {
        pid: i32,
        birth: String,
    }
    impl ProcessIdentity {
        pub(super) fn capture(pid: i32) -> Option<Self> {
            process_birth(pid).map(|birth| Self { pid, birth })
        }
        pub(super) fn is_current(&self) -> bool {
            process_birth(self.pid).as_deref() == Some(self.birth.as_str())
        }
        fn is_live(&self) -> bool {
            self.is_current() && !process_is_zombie(self.pid)
        }
    }
    #[cfg(target_os = "linux")]
    fn process_is_zombie(pid: i32) -> bool {
        std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .ok()
            .and_then(|stat| stat.rsplit_once(')').map(|(_, suffix)| suffix.to_owned()))
            .and_then(|suffix| suffix.split_whitespace().next().map(str::to_owned))
            .as_deref()
            == Some("Z")
    }
    #[cfg(not(target_os = "linux"))]
    fn process_is_zombie(pid: i32) -> bool {
        Command::new("/bin/ps")
            .args(["-p", &pid.to_string(), "-o", "stat="])
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|output| output.status.success())
            .is_some_and(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .trim_start()
                    .starts_with('Z')
            })
    }
    #[cfg(target_os = "linux")]
    fn process_birth(pid: i32) -> Option<String> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let fields = stat
            .rsplit_once(')')?
            .1
            .split_whitespace()
            .collect::<Vec<_>>();
        // The suffix begins at field 3; field 22 is the kernel start-time tick.
        fields.get(19).map(|value| (*value).to_owned())
    }
    #[cfg(not(target_os = "linux"))]
    fn process_birth(pid: i32) -> Option<String> {
        let output = Command::new("/bin/ps")
            .args(["-p", &pid.to_string(), "-o", "lstart="])
            .stderr(Stdio::null())
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
            .filter(|value| !value.is_empty())
    }
    impl Drop for Lineage {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    impl Lineage {
        pub(super) fn create() -> io::Result<(Self, std::fs::File)> {
            use std::os::unix::fs::OpenOptionsExt;
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "arashi-native-hook-lineage-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)?;
            Ok((Self(crate::paths::canonicalize(&path)?), file))
        }
        fn holders(&self) -> Vec<i32> {
            #[cfg(target_os = "linux")]
            {
                let mut holders = vec![];
                if let Ok(entries) = std::fs::read_dir("/proc") {
                    for entry in entries.flatten() {
                        let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
                            continue;
                        };
                        if let Ok(fds) = std::fs::read_dir(entry.path().join("fd"))
                            && fds
                                .flatten()
                                .any(|fd| std::fs::read_link(fd.path()).is_ok_and(|p| p == self.0))
                        {
                            holders.push(pid);
                        }
                    }
                }
                holders
            }
            #[cfg(not(target_os = "linux"))]
            {
                Command::new("/usr/sbin/lsof")
                    .args(["-t", "--"])
                    .arg(&self.0)
                    .stderr(Stdio::null())
                    .output()
                    .ok()
                    .map(|o| {
                        String::from_utf8_lossy(&o.stdout)
                            .lines()
                            .filter_map(|s| s.parse().ok())
                            .collect()
                    })
                    .unwrap_or_default()
            }
        }
        fn signal_tree(&self, leader: u32, leader_alive: bool, observed: &mut Vec<i32>, sig: i32) {
            // Retain discovered descendants through escalation, as the source does.
            // Exclude the original leader after reaping unless fresh lineage proves ownership.
            let mut pids: Vec<i32> = observed
                .iter()
                .copied()
                .filter(|pid| leader_alive || *pid != leader as i32)
                .collect();
            for pid in self
                .holders()
                .into_iter()
                .chain(leader_alive.then_some(leader as i32))
            {
                if !pids.contains(&pid) {
                    pids.push(pid);
                }
            }
            if let Ok(output) = Command::new("/bin/ps").args(["-eo", "pid=,ppid="]).output() {
                let rows: Vec<(i32, i32)> = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .filter_map(|line| {
                        let mut fields = line.split_whitespace();
                        Some((fields.next()?.parse().ok()?, fields.next()?.parse().ok()?))
                    })
                    .collect();
                loop {
                    let old = pids.len();
                    for (pid, parent) in &rows {
                        if pids.contains(parent) && !pids.contains(pid) {
                            pids.push(*pid);
                        }
                    }
                    if old == pids.len() {
                        break;
                    }
                }
            }
            // Only descendants/holders of this invocation's private inherited file.
            *observed = pids.clone();
            for pid in pids
                .into_iter()
                .rev()
                .filter(|pid| *pid > 1 && *pid != std::process::id() as i32)
            {
                unsafe {
                    kill(pid, sig);
                }
            }
        }

        // Sync uses birth-checked identities and settlement. Lifecycle retains
        // its existing low-latency signal path and interruption semantics.
        pub(super) fn signal_owned_tree(
            &self,
            leader: u32,
            leader_alive: bool,
            observed: &mut Vec<ProcessIdentity>,
            sig: i32,
        ) {
            // Retain only process incarnations whose birth identity still matches.
            observed.retain(|process| {
                (leader_alive || process.pid != leader as i32) && process.is_live()
            });
            let mut pids = observed
                .iter()
                .map(|process| process.pid)
                .collect::<Vec<_>>();
            for pid in self
                .holders()
                .into_iter()
                .chain(leader_alive.then_some(leader as i32))
            {
                if !pids.contains(&pid)
                    && let Some(identity) = ProcessIdentity::capture(pid)
                {
                    pids.push(pid);
                    observed.push(identity);
                }
            }
            if let Ok(output) = Command::new("/bin/ps").args(["-eo", "pid=,ppid="]).output() {
                let rows: Vec<(i32, i32)> = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .filter_map(|line| {
                        let mut fields = line.split_whitespace();
                        Some((fields.next()?.parse().ok()?, fields.next()?.parse().ok()?))
                    })
                    .collect();
                loop {
                    let old = pids.len();
                    for (pid, parent) in &rows {
                        if pids.contains(parent)
                            && !pids.contains(pid)
                            && let Some(identity) = ProcessIdentity::capture(*pid)
                        {
                            pids.push(*pid);
                            observed.push(identity);
                        }
                    }
                    if old == pids.len() {
                        break;
                    }
                }
            }
            // Recheck birth identity immediately before signaling so PID reuse cannot
            // redirect cleanup to an unrelated process incarnation.
            for process in observed.iter().rev().filter(|process| {
                process.pid > 1 && process.pid != std::process::id() as i32 && process.is_live()
            }) {
                unsafe {
                    kill(process.pid, sig);
                }
            }
        }
        pub(super) fn has_live(&self, observed: &mut Vec<ProcessIdentity>) -> bool {
            observed.retain(ProcessIdentity::is_live);
            for pid in self.holders() {
                if !observed.iter().any(|process| process.pid == pid)
                    && let Some(identity) = ProcessIdentity::capture(pid)
                    && identity.is_live()
                {
                    observed.push(identity);
                }
            }
            !observed.is_empty()
        }
    }
    pub fn run(
        path: &Path,
        cwd: &Path,
        env: &BTreeMap<String, String>,
        timeout: Duration,
    ) -> io::Result<Captured> {
        let start = Instant::now();
        let mut command = Command::new(path);
        command
            .current_dir(cwd)
            .envs(env)
            .env_remove("ARASHI_DIRECTIVE_FILE")
            .env_remove("ARASHI_SHELL")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        use std::os::fd::AsRawFd;
        let (lineage, descriptor) = Lineage::create()?;
        let fd = descriptor.as_raw_fd();
        // SAFETY: dup2/fcntl are async-signal-safe; the descriptor remains live
        // through spawn. FD 3 deliberately survives exec for descendant discovery.
        unsafe {
            command.pre_exec(move || {
                if dup2(fd, 3) < 0 || fcntl(3, 2, 0_i32) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = match spawn_direct(&mut command) {
            Ok(child) => child,
            Err(e) => {
                return Ok(Captured {
                    stdout: String::new(),
                    stderr: format!(
                        "Failed to execute hook: {}",
                        if cfg!(target_os = "macos") && e.raw_os_error() == Some(8) {
                            "spawn ENOEXEC".to_owned()
                        } else {
                            e.to_string()
                        }
                    ),
                    exit_code: -1,
                    elapsed_ms: start.elapsed().as_millis(),
                    timed_out: false,
                    signaled: false,
                    termination_signal: None,
                    error: None,
                });
            }
        };
        drop(descriptor);
        thread::scope(|scope| {
            let stdout = scope.spawn(read_pipe(child.stdout.take().unwrap()));
            let stderr = scope.spawn(read_pipe(child.stderr.take().unwrap()));
            let mut status = None;
            let mut stopping = None;
            let mut timed_out = false;
            let mut interrupted_run = false;
            let mut observed = Vec::new();
            loop {
                if status.is_none() {
                    status = child.try_wait()?;
                }
                if stopping.is_none() && (interrupted() || start.elapsed() >= timeout) {
                    interrupted_run = interrupted();
                    timed_out = !interrupted_run;
                    lineage.signal_tree(
                        child.id(),
                        status.is_none(),
                        &mut observed,
                        if interrupted_run { 2 } else { 15 },
                    );
                    stopping = Some(Instant::now());
                }
                if let Some(stop) = stopping
                    && (stop.elapsed() >= Duration::from_millis(250) || status.is_some())
                {
                    lineage.signal_tree(child.id(), status.is_none(), &mut observed, 9);
                }
                if status.is_some() && stdout.is_finished() && stderr.is_finished() {
                    break;
                }
                thread::sleep(Duration::from_millis(2));
            }
            let status = status.unwrap();
            Ok(Captured {
                stdout: stdout.join().expect("hook stdout reader")?,
                stderr: stderr.join().expect("hook stderr reader")?,
                exit_code: if interrupted_run {
                    130
                } else if timed_out {
                    -1
                } else {
                    status.code().unwrap_or(-1)
                },
                elapsed_ms: start.elapsed().as_millis(),
                timed_out,
                signaled: interrupted_run || status.code().is_none(),
                termination_signal: std::os::unix::process::ExitStatusExt::signal(&status),
                error: None,
            })
        })
    }
}
