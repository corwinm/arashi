//! Shared retained-source workspace lock protocol for cooperating mutation commands.
use crate::{Error, Result};
use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime},
};
const LOCK_NAME: &str = ".arashi-add.transaction.lock";
fn failure(message: impl Into<String>) -> Error {
    Error::new("WORKSPACE_TRANSACTION_ERROR", message)
}
fn close_file(file: fs::File) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::fd::IntoRawFd;
        unsafe extern "C" {
            fn close(fd: i32) -> i32;
        }
        let fd = file.into_raw_fd();
        if unsafe { close(fd) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::IntoRawHandle;
        if unsafe { windows_sys::Win32::Foundation::CloseHandle(file.into_raw_handle()) } == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

pub fn resolve_lock_path(root: &Path) -> Result<PathBuf> {
    let output = Command::new("git")
        .args(["rev-parse", "--git-common-dir"])
        .current_dir(root)
        .output()?;
    if output.status.success() {
        let common = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if common.is_empty() {
            return Err(failure("Git returned an empty common directory."));
        }
        Ok(fs::canonicalize(root.join(common))?.join(LOCK_NAME))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("not a git repository") {
            Ok(fs::canonicalize(root)?.join(LOCK_NAME))
        } else {
            Err(failure(stderr.into_owned()))
        }
    }
}
#[derive(Debug, Serialize)]
struct Owner {
    pid: i64,
    token: String,
}
fn read_owner(path: &Path) -> Option<Owner> {
    // JSON.parse accepts duplicate members with last-member-wins semantics.
    // Deserialize an object first, then validate the final values, not each member.
    let value: serde_json::Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let object = value.as_object()?;
    let number = object
        .get("pid")?
        .as_f64()
        .filter(|number| number.is_finite() && number.fract() == 0.0)?;
    // Out-of-range native PID values remain conservatively live, like process.kill's non-ESRCH error.
    Some(Owner {
        pid: number as i64,
        token: object.get("token")?.as_str()?.to_owned(),
    })
}
fn token() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!(
        "{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}
fn alive(pid: i64) -> bool {
    #[cfg(unix)]
    {
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        let Ok(pid) = i32::try_from(pid) else {
            return true;
        };
        if unsafe { kill(pid, 0) } == 0 {
            return true;
        }
        io::Error::last_os_error().raw_os_error() != Some(3)
    }
    #[cfg(windows)]
    {
        // Explicit native liveness query; access denied remains alive/unknown.
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn GetExitCodeProcess(handle: *mut std::ffi::c_void, code: *mut u32) -> i32;
        }
        let Ok(pid) = u32::try_from(pid) else {
            return true;
        };
        let handle = unsafe { OpenProcess(0x1000, 0, pid) };
        if handle.is_null() {
            return io::Error::last_os_error().raw_os_error() != Some(87);
        }
        let mut code = 259;
        let result = unsafe { GetExitCodeProcess(handle, &mut code) };
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(handle);
        }
        result == 0 || code == 259
    }
}
fn stat_identity(path: &Path) -> Result<(u64, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let m = fs::metadata(path)?;
        Ok((m.dev(), m.ino()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
        };
        let file = fs::File::open(path)?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(io::Error::last_os_error().into());
        }
        Ok((
            u64::from(info.dwVolumeSerialNumber),
            (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        ))
    }
}
fn reclaim(path: &Path, grace: Duration) -> Result<bool> {
    reclaim_with_metadata(path, grace, |path| fs::metadata(path))
}
// Keep filesystem reads injectable so a generation change can be scheduled without sleeps.
fn reclaim_with_metadata(
    path: &Path,
    grace: Duration,
    metadata_at: impl Fn(&Path) -> io::Result<fs::Metadata>,
) -> Result<bool> {
    match metadata_at(path) {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(e) => return Err(e.into()),
    };
    let (dev, ino) = stat_identity(path)?;
    // Node stat exposes numeric IDs as IEEE-754 numbers; retain its claim filename spelling.
    let legacy = format!(
        "{}.reclaim-{:.0}-{:.0}",
        path.to_string_lossy(),
        dev as f64,
        ino as f64
    );
    let prefix = format!("{legacy}-");
    let claim = PathBuf::from(format!("{prefix}{}-{}", std::process::id(), token()));
    match fs::hard_link(path, &claim) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(e) => return Err(e.into()),
    }
    let result = (|| -> Result<bool> {
        // Grace belongs to the hardlinked generation, never the initial path snapshot.
        let metadata = metadata_at(&claim)?;
        let claimed = stat_identity(&claim)?;
        if stat_identity(path).ok() != Some(claimed) {
            return Ok(true);
        }
        let prefix_name = Path::new(&prefix).file_name().unwrap().to_string_lossy();
        for entry in fs::read_dir(path.parent().unwrap())? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(suffix) = name.strip_prefix(prefix_name.as_ref()) else {
                continue;
            };
            let pid = suffix.split('-').next().and_then(|v| v.parse::<i64>().ok());
            if !pid.is_some_and(alive) {
                remove_if_exists(&entry.path())?;
            } else if entry.path() != claim {
                return Ok(false);
            }
        }
        let owner = read_owner(&claim);
        if owner.as_ref().is_some_and(|o| alive(o.pid)) {
            return Ok(false);
        }
        if owner.is_none()
            && SystemTime::now()
                .duration_since(metadata.modified()?)
                .unwrap_or_default()
                < grace
        {
            return Ok(false);
        }
        if stat_identity(path).ok() != Some(claimed) {
            return Ok(true);
        }
        fs::remove_file(path)?;
        remove_if_exists(Path::new(&legacy))?;
        Ok(true)
    })();
    let cleanup = remove_if_exists(&claim);
    match (result, cleanup) {
        (Err(error), _) | (_, Err(error)) => Err(error),
        (Ok(value), Ok(())) => Ok(value),
    }
}
fn remove_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
pub fn acquire(path: &Path, options: LockOptions) -> Result<WorkspaceLock> {
    let LockOptions {
        retries,
        incomplete_grace,
    } = options;
    let owner = Owner {
        pid: i64::from(std::process::id()),
        token: token(),
    };
    let mut lock = None;
    for _ in 0..retries {
        match OpenOptions::new().write(true).create_new(true).open(path) {
            Ok(mut file) => {
                let result = (|| -> Result<()> {
                    file.write_all(&serde_json::to_vec(&owner)?)?;
                    file.sync_all()?;
                    Ok(())
                })();
                if let Err(error) = result {
                    close_file(file)?;
                    remove_if_exists(path)?;
                    return Err(error);
                }
                lock = Some(file);
                break;
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                if reclaim(path, incomplete_grace)? {
                    continue;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(e.into()),
        }
    }
    let file = lock.ok_or_else(|| {
        failure(format!(
            "Timed out waiting for workspace transaction lock: {}",
            path.display()
        ))
    })?;
    Ok(WorkspaceLock {
        path: path.to_owned(),
        owner,
        file: Some(file),
    })
}

#[derive(Clone, Copy, Debug)]
pub struct LockOptions {
    pub retries: usize,
    pub incomplete_grace: Duration,
}
impl Default for LockOptions {
    fn default() -> Self {
        Self {
            retries: 90_000,
            incomplete_grace: Duration::from_secs(30),
        }
    }
}
#[derive(Debug)]
pub struct WorkspaceLock {
    path: PathBuf,
    owner: Owner,
    file: Option<fs::File>,
}
impl WorkspaceLock {
    /// Report close/removal failures explicitly; Drop provides best-effort unwind cleanup.
    pub fn release(mut self) -> Result<()> {
        self.release_inner()
    }
    fn release_inner(&mut self) -> Result<()> {
        let Some(file) = self.file.take() else {
            return Ok(());
        };
        close_file(file)?;
        if read_owner(&self.path).is_some_and(|owner| owner.token == self.owner.token) {
            remove_if_exists(&self.path)?;
        }
        Ok(())
    }
}
impl Drop for WorkspaceLock {
    fn drop(&mut self) {
        let _ = self.release_inner();
    }
}
pub fn with_lock<T>(
    path: &Path,
    retries: usize,
    incomplete_grace: Duration,
    operation: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let guard = acquire(
        path,
        LockOptions {
            retries,
            incomplete_grace,
        },
    )?;
    let result = operation();
    guard.release()?;
    result
}

#[cfg(test)]
mod regression_tests {
    use super::*;

    #[test]
    fn replacement_incomplete_lock_gets_its_own_grace() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lock");
        let old = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        old.set_modified(SystemTime::UNIX_EPOCH).unwrap();
        let swapped = std::cell::Cell::new(false);
        let writer = std::cell::RefCell::new(None);
        let reclaimed = reclaim_with_metadata(&path, Duration::from_secs(30), |observed| {
            let metadata = fs::metadata(observed)?;
            if !swapped.replace(true) {
                // A second reclaimer removes the old generation; a cooperating writer
                // publishes an empty new one and keeps its descriptor open before write.
                assert!(reclaim(&path, Duration::ZERO).unwrap());
                *writer.borrow_mut() = Some(
                    OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&path)?,
                );
            }
            Ok(metadata)
        })
        .unwrap();
        assert!(
            !reclaimed,
            "fresh incomplete writer was reclaimed using old-generation age"
        );
        assert_eq!(fs::read(&path).unwrap(), b"");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        let mut writer = writer.into_inner().unwrap();
        writer
            .write_all(
                &serde_json::to_vec(&Owner {
                    pid: i64::from(std::process::id()),
                    token: "writer".into(),
                })
                .unwrap(),
            )
            .unwrap();
        writer.sync_all().unwrap();
        assert!(
            acquire(
                &path,
                LockOptions {
                    retries: 2,
                    incomplete_grace: Duration::ZERO
                }
            )
            .is_err()
        );
        drop(writer);
        drop(old); // Pin the old inode throughout the schedule, preventing reuse.
    }
}
