//! Captured argv execution shared by exec and setup. This is not the lifecycle
//! hook runner: terminal input, provenance and process-tree recovery stay gated.
use std::{
    io::{self, Read},
    path::Path,
    process::{Command, Stdio},
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
            error: None,
        })
    })
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
