//! Held filesystem object identity, independent of transaction policy.
//!
//! Keep the pin alive through ownership decisions: a detached numeric ID can be
//! reused after the last handle/link disappears. Creation time is supplementary
//! evidence, not identity; capture it at the published destination, not staging.
//! These no-follow opens protect the final component only. Ancestor validation,
//! byte/mode checks, and publication/rollback policy remain the caller's job.
//! `matches_path` is an observation, NOT an atomic conditional unlink/rename.
use std::{fs::File, io, path::Path, time::SystemTime};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ObjectIdentity {
    volume: u64,
    file_id: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObjectKind {
    File,
    Directory,
    #[cfg(unix)]
    Symlink,
    #[cfg(windows)]
    ReparsePoint,
    #[cfg(unix)]
    Other,
}

/// Owns the handle that keeps the observed object allocated, not its pathname.
/// Windows handles share read/write/delete so publication and quarantine remain
/// possible; this is not an exclusive lock against edits or namespace changes.
#[derive(Debug)]
pub struct PinnedObject {
    file: File,
    identity: ObjectIdentity,
    kind: ObjectKind,
    creation_time: Option<SystemTime>,
}

impl PinnedObject {
    pub fn open(path: &Path) -> io::Result<Self> {
        Self::from_file(open_nofollow(path)?)
    }

    /// Takes ownership of an already-opened object. The caller chooses access
    /// rights and is responsible for its original no-follow/create-new policy.
    pub fn from_file(file: File) -> io::Result<Self> {
        let (identity, kind) = describe(&file)?;
        let creation_time = file.metadata()?.created().ok();
        Ok(Self {
            file,
            identity,
            kind,
            creation_time,
        })
    }

    pub fn identity(&self) -> ObjectIdentity {
        self.identity
    }
    pub fn kind(&self) -> ObjectKind {
        self.kind
    }
    pub fn creation_time(&self) -> Option<SystemTime> {
        self.creation_time
    }
    /// Borrow the held object for metadata/handle operations. Access rights are
    /// platform dependent; use `from_file` when the caller needs writable access.
    pub fn file(&self) -> &File {
        &self.file
    }

    /// Missing means false; permission/sharing/other errors remain distinguishable
    /// and must not be silently promoted into ownership or permission to clean up.
    pub fn matches_path(&self, path: &Path) -> io::Result<bool> {
        match Self::open(path) {
            Ok(now) => Ok(self.identity == now.identity && self.kind == now.kind),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }
}

#[cfg(windows)]
fn open_nofollow(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(unix)]
fn open_nofollow(path: &Path) -> io::Result<File> {
    use rustix::fs::{Mode, OFlags, open};
    #[cfg(target_os = "linux")]
    let flags = OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    #[cfg(target_os = "macos")]
    let flags = OFlags::RDONLY | OFlags::NONBLOCK | OFlags::CLOEXEC
        // Darwin <sys/fcntl.h> O_SYMLINK: open the link object, not its target.
        | OFlags::from_bits_retain(0x0020_0000);
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let flags = OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    Ok(File::from(open(path, flags, Mode::empty())?))
}

#[cfg(unix)]
fn describe(file: &File) -> io::Result<(ObjectIdentity, ObjectKind)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    let kind = if metadata.is_symlink() {
        ObjectKind::Symlink
    } else if metadata.is_file() {
        ObjectKind::File
    } else if metadata.is_dir() {
        ObjectKind::Directory
    } else {
        ObjectKind::Other
    };
    Ok((
        ObjectIdentity {
            volume: metadata.dev(),
            file_id: metadata.ino(),
        },
        kind,
    ))
}

#[cfg(windows)]
fn describe(file: &File) -> io::Result<(ObjectIdentity, ObjectKind)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        GetFileInformationByHandle,
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: File owns a live handle; info is correctly sized writable storage.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let kind = if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        ObjectKind::ReparsePoint
    } else if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
        ObjectKind::Directory
    } else {
        ObjectKind::File
    };
    Ok((
        ObjectIdentity {
            volume: u64::from(info.dwVolumeSerialNumber),
            file_id: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        },
        kind,
    ))
}
