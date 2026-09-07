//! Shared Darwin direct-exec guard; callers own child lifecycle and environment.
pub(super) fn prepare(
    command: &mut std::process::Command,
    environment: std::collections::BTreeMap<std::ffi::OsString, std::ffi::OsString>,
) -> std::io::Result<()> {
    use std::{
        ffi::CString,
        io,
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
    Ok(())
}
