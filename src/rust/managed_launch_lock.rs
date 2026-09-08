//! Retained mkdir/owner.json identity protocol, including recovery guard and owner readback.
use super::*;
use serde::Serialize;
use serde_json::value::RawValue;
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Write},
    path::PathBuf,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
const POLL: Duration = Duration::from_millis(50);
const STALE: Duration = Duration::from_secs(30);
#[derive(Debug, Clone, Serialize, PartialEq)]
struct Owner {
    #[serde(rename = "createdAt")]
    created_at: f64,
    identity: String,
    owner: String,
    pid: u64,
}
pub struct IdentityLock {
    pub path: PathBuf,
    owner: Owner,
    active: bool,
}
fn io_error(e: io::Error) -> LaunchError {
    failure(format!("Kitty identity-lock: {e}"))
}
fn missing(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::NotFound
}
fn transient(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::PermissionDenied
            | io::ErrorKind::DirectoryNotEmpty
            | io::ErrorKind::ResourceBusy
    )
}
fn retry_io<T>(deadline: Instant, mut f: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    loop {
        match f() {
            Err(e) if transient(&e) && Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(5))
            }
            r => return r,
        }
    }
}
#[cfg(unix)]
fn uid() -> u32 {
    unsafe extern "C" {
        fn getuid() -> u32;
    }
    unsafe { getuid() }
}
fn pid_alive(pid: u64) -> bool {
    #[cfg(unix)]
    {
        unsafe extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        if pid > i32::MAX as u64 {
            return true;
        }
        // No signal is delivered. Only ESRCH proves absence; permission or
        // other capability errors cannot authorize recovery.
        unsafe { kill(pid as i32, 0) == 0 || io::Error::last_os_error().raw_os_error() != Some(3) }
    }
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn GetExitCodeProcess(process: *mut std::ffi::c_void, code: *mut u32) -> i32;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        let Ok(pid) = u32::try_from(pid) else {
            return true;
        };
        unsafe {
            let h = OpenProcess(0x1000, 0, pid);
            if h.is_null() {
                return io::Error::last_os_error().raw_os_error() != Some(87);
            }
            let mut code = 0;
            let ok = GetExitCodeProcess(h, &mut code);
            CloseHandle(h);
            ok == 0 || code == 259
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        true
    }
}
fn prepare(root: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(root)?;
    let meta = fs::symlink_metadata(root)?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(io::Error::other("lock root must be a real directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if meta.uid() != uid() {
            return Err(io::Error::other("lock root is not owned by current user"));
        }
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
        let secured = fs::symlink_metadata(root)?;
        if secured.uid() != uid() || secured.mode() & 0o777 != 0o700 {
            return Err(io::Error::other("lock root could not be secured"));
        }
    }
    Ok(())
}
fn new_owner(identity: &str, root: &Path) -> io::Result<Owner> {
    // tempfile provides an OS-random ownership token, not a pid-only identity.
    let token = tempfile::Builder::new()
        .prefix("owner-")
        .tempfile_in(root)?;
    let owner = token
        .path()
        .file_name()
        .ok_or_else(|| io::Error::other("owner token"))?
        .to_string_lossy()
        .into_owned();
    Ok(Owner {
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as f64,
        identity: identity.into(),
        owner,
        pid: u64::from(std::process::id()),
    })
}
fn write_owner(path: &Path, owner: &Owner, create: bool) -> io::Result<()> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true);
    if create {
        opts.create_new(true);
    } else {
        opts.create(true).truncate(true);
    }
    opts.open(path.join("owner.json"))?
        .write_all(serde_json::to_string(owner)?.as_bytes())
}
fn read_owner(path: &Path) -> io::Result<Option<Owner>> {
    let raw = match fs::read(path.join("owner.json")) {
        Ok(r) => r,
        Err(e) if missing(&e) => return Ok(None),
        Err(e) => return Err(e),
    };
    Ok(parse_owner(&raw).ok().flatten())
}
// JSON.parse resolves duplicate members before validating Number.isSafeInteger.
// Use the same normalized owner for acquisition, recovery readback and release.
fn parse_owner(raw: &[u8]) -> serde_json::Result<Option<Owner>> {
    let raw: Box<RawValue> = serde_json::from_slice(raw)?;
    if !raw.get().trim_start().starts_with('{') {
        return Ok(None);
    }
    let value: BTreeMap<String, Box<RawValue>> = serde_json::from_str(raw.get())?;
    let number = |name| value.get(name)?.get().parse::<f64>().ok();
    let string = |name| serde_json::from_str::<String>(value.get(name)?.get()).ok();
    let Some(pid) = number("pid") else {
        return Ok(None);
    };
    if !(1.0..=9_007_199_254_740_991.0).contains(&pid) || pid.fract() != 0.0 {
        return Ok(None);
    }
    let Some(owner) = string("owner") else {
        return Ok(None);
    };
    if owner.is_empty() {
        return Ok(None);
    }
    Ok(Some(Owner {
        created_at: match number("createdAt") {
            Some(created_at) => created_at,
            None => return Ok(None),
        },
        identity: match string("identity") {
            Some(identity) => identity,
            None => return Ok(None),
        },
        owner,
        pid: pid as u64,
    }))
}
fn suffix(path: &Path, tail: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(tail);
    PathBuf::from(name)
}
fn markers(path: &Path) -> io::Result<Vec<PathBuf>> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("lock parent"))?;
    let prefix = format!(
        "{}.recovery",
        path.file_name().unwrap_or_default().to_string_lossy()
    );
    let entries = match fs::read_dir(parent) {
        Ok(e) => e,
        Err(e) if missing(&e) => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    entries
        .filter_map(|e| match e {
            Ok(e) if e.file_name().to_string_lossy().starts_with(&prefix) => Some(Ok(e.path())),
            Ok(_) => None,
            Err(e) => Some(Err(e)),
        })
        .collect()
}
fn stale(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age >= STALE)
}
fn recoverable(path: &Path, owner: &Option<Owner>, identity: &str) -> bool {
    match owner {
        Some(o) if o.identity == identity => !pid_alive(o.pid),
        _ => stale(path),
    }
}
impl IdentityLock {
    pub fn acquire(identity: &str, root: Option<&Path>, timeout: Duration) -> LaunchResult<Self> {
        let default = std::env::temp_dir().join(format!("arashi-kitty-locks-{}", {
            #[cfg(unix)]
            {
                uid().to_string()
            }
            #[cfg(not(unix))]
            {
                "user".to_string()
            }
        }));
        let root = root.unwrap_or(&default);
        prepare(root).map_err(io_error)?;
        let owner = new_owner(identity, root).map_err(io_error)?;
        let path = root.join(format!("{identity}.lock"));
        let deadline = Instant::now() + timeout;
        loop {
            let attempt = (|| -> io::Result<Option<Self>> {
                if markers(&path)?.is_empty() {
                    match fs::create_dir(&path) {
                        Ok(()) => {
                            write_owner(&path, &owner, true)?;
                            let lock = Self {
                                path: path.clone(),
                                owner: owner.clone(),
                                active: true,
                            };
                            if markers(&path)?.is_empty() {
                                return Ok(Some(lock));
                            }
                            lock.release().map_err(io::Error::other)?;
                        }
                        Err(e) if e.kind() == io::ErrorKind::AlreadyExists || missing(&e) => {}
                        Err(e) => return Err(e),
                    }
                }
                let present = !markers(&path)?.is_empty();
                let should_guard = if present {
                    true
                } else {
                    match fs::metadata(&path) {
                        Ok(_) => {
                            let observed = read_owner(&path)?;
                            !observed
                                .as_ref()
                                .is_some_and(|o| o.identity == identity && pid_alive(o.pid))
                        }
                        Err(e) if missing(&e) => false,
                        Err(e) => return Err(e),
                    }
                };
                if should_guard && let Some(guard) = recovery_guard(&path, identity)? {
                    let recovered = recover(&path, identity);
                    let released = guard.release().map_err(io::Error::other);
                    recovered?;
                    released?;
                }
                Ok(None)
            })();
            match attempt {
                Ok(Some(lock)) => return Ok(lock),
                Ok(None) => {}
                Err(e) if transient(&e) => {}
                Err(e) => return Err(io_error(e)),
            }
            if Instant::now() >= deadline {
                return Err(failure(
                    "Kitty identity-lock: timed out waiting for worktree identity lock",
                ));
            }
            thread::sleep(POLL.min(deadline.saturating_duration_since(Instant::now())));
        }
    }
    pub fn release(mut self) -> LaunchResult<()> {
        self.active = false;
        release_owned(&self.path, &self.owner).map_err(io_error)
    }
}
impl Drop for IdentityLock {
    fn drop(&mut self) {
        if self.active {
            let _ = release_owned(&self.path, &self.owner);
        }
    }
}
fn recovery_guard(path: &Path, identity: &str) -> io::Result<Option<IdentityLock>> {
    let guard = suffix(path, ".recovery");
    let guard_identity = format!("{identity}:recovery");
    let owner = new_owner(&guard_identity, path.parent().unwrap())?;
    let found = markers(path)?;
    if found.is_empty() {
        match fs::create_dir(&guard) {
            Ok(()) => {
                write_owner(&guard, &owner, true)?;
                let lock = IdentityLock {
                    path: guard.clone(),
                    owner,
                    active: true,
                };
                if markers(path)? == vec![guard] {
                    return Ok(Some(lock));
                }
                lock.release().map_err(io::Error::other)?;
                return Ok(None);
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists || missing(&e) => return Ok(None),
            Err(e) => return Err(e),
        }
    }
    if found.len() != 1 {
        return Ok(None);
    }
    let marker = &found[0];
    let prefix = format!("{}.takeover-", guard.to_string_lossy());
    if marker
        .to_string_lossy()
        .strip_prefix(&prefix)
        .and_then(|s| s.split('-').next())
        .and_then(|s| {
            s.parse::<u64>()
                .ok()
                .filter(|pid| *pid > 0 && *pid <= 9_007_199_254_740_991)
        })
        .is_some_and(pid_alive)
    {
        return Ok(None);
    }
    let inspected = read_owner(marker)?;
    if !recoverable(marker, &inspected, &guard_identity) {
        return Ok(None);
    }
    let takeover = suffix(
        &guard,
        &format!(".takeover-{}-{}", std::process::id(), owner.owner),
    );
    match fs::rename(marker, &takeover) {
        Ok(()) => {}
        Err(e) if missing(&e) => return Ok(None),
        Err(e) => return Err(e),
    }
    if read_owner(&takeover)? != inspected {
        fs::rename(&takeover, marker)?;
        return Ok(None);
    }
    write_owner(&takeover, &owner, false)?;
    fs::rename(&takeover, &guard)?;
    Ok(Some(IdentityLock {
        path: guard,
        owner,
        active: true,
    }))
}
fn recover(path: &Path, identity: &str) -> io::Result<()> {
    let inspected = read_owner(path)?;
    if !recoverable(path, &inspected, identity) || read_owner(path)? != inspected {
        return Ok(());
    }
    let token = new_owner(identity, path.parent().unwrap())?;
    let moved = suffix(
        path,
        &format!(".recover-{}-{}", std::process::id(), token.owner),
    );
    match fs::rename(path, &moved) {
        Ok(()) => {}
        Err(e) if missing(&e) => return Ok(()),
        Err(e) => return Err(e),
    }
    let observed = match read_owner(&moved) {
        Ok(o) => o,
        Err(e) => {
            fs::rename(&moved, path)?;
            return Err(e);
        }
    };
    if observed != inspected {
        fs::rename(&moved, path)?;
        return Ok(());
    }
    retry_io(Instant::now() + Duration::from_secs(2), || {
        fs::remove_dir_all(&moved)
    })
}
fn release_owned(path: &Path, owner: &Owner) -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let observed = retry_io(deadline, || {
            let raw = match fs::read(path.join("owner.json")) {
                Ok(raw) => raw,
                Err(e) if missing(&e) => return Ok(None),
                Err(e) => return Err(e),
            };
            // Malformed JSON is a release failure, never permission to remove a lock.
            parse_owner(&raw).map_err(io::Error::other)
        })?;
        if observed.is_none() {
            if !markers(path)?.is_empty() {
                if Instant::now() >= deadline {
                    return Err(io::Error::other(
                        "timed out waiting for recovery during release",
                    ));
                }
                thread::sleep(Duration::from_millis(5));
                continue;
            }
            if path.exists() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(5));
                continue;
            }
            return Ok(());
        }
        if observed.as_ref() != Some(owner) {
            return Ok(());
        }
        let moved = suffix(path, &format!(".release-{}", owner.owner));
        match retry_io(deadline, || fs::rename(path, &moved)) {
            Ok(()) => {}
            Err(e) if missing(&e) => continue,
            Err(e) => return Err(e),
        }
        if retry_io(deadline, || read_owner(&moved))?.as_ref() != Some(owner) {
            fs::rename(&moved, path)?;
            return Ok(());
        }
        return retry_io(deadline, || fs::remove_dir_all(&moved));
    }
}
