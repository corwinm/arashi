//! Exercises held identity through the integrated library API.
use arashi::fs_identity::{ObjectKind, PinnedObject};
use std::{fs, io};

#[test]
fn rename_and_hardlink_keep_object_identity() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let renamed = root.path().join("renamed");
    let linked = root.path().join("linked");
    fs::write(&source, b"owned").unwrap();
    let pin = PinnedObject::open(&source).unwrap();
    assert_eq!(pin.kind(), ObjectKind::File);
    assert!(pin.matches_path(&source).unwrap());
    fs::rename(&source, &renamed).unwrap();
    fs::hard_link(&renamed, &linked).unwrap();
    assert!(pin.matches_path(&renamed).unwrap());
    assert!(pin.matches_path(&linked).unwrap());
    assert!(!pin.matches_path(&source).unwrap());
    assert_eq!(
        pin.identity(),
        PinnedObject::from_file(fs::File::open(&linked).unwrap())
            .unwrap()
            .identity()
    );
}

#[test]
fn publication_captures_destination_then_preserves_replacement() {
    let root = tempfile::tempdir().unwrap();
    let stage = root.path().join("stage");
    let destination = root.path().join("destination");
    let unrelated = root.path().join("unrelated");
    fs::write(&stage, b"same bytes").unwrap();
    fs::write(&unrelated, b"caller").unwrap();
    let prepared = PinnedObject::open(&stage).unwrap();
    fs::hard_link(&stage, &destination).unwrap();
    let published = PinnedObject::open(&destination).unwrap();
    assert_eq!(prepared.identity(), published.identity());
    assert_eq!(
        published.creation_time(),
        published.file().metadata().unwrap().created().ok()
    );
    fs::remove_file(&stage).unwrap();
    fs::remove_file(&destination).unwrap();
    fs::write(&destination, b"same bytes").unwrap();
    assert!(!published.matches_path(&destination).unwrap());
    assert_ne!(
        published.identity(),
        PinnedObject::open(&destination).unwrap().identity()
    );
    assert_eq!(fs::read(&destination).unwrap(), b"same bytes");
    assert_eq!(fs::read(&unrelated).unwrap(), b"caller");
}

#[test]
fn directory_pin_survives_rename_but_rejects_replacement() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("directory");
    let moved = root.path().join("moved");
    fs::create_dir(&path).unwrap();
    let pin = PinnedObject::open(&path).unwrap();
    assert_eq!(pin.kind(), ObjectKind::Directory);
    fs::rename(&path, &moved).unwrap();
    fs::create_dir(&path).unwrap();
    fs::write(path.join("caller"), b"preserve").unwrap();
    assert!(!pin.matches_path(&path).unwrap());
    assert!(pin.matches_path(&moved).unwrap());
    assert_eq!(fs::read(path.join("caller")).unwrap(), b"preserve");
}

#[test]
fn missing_is_not_an_identity() {
    let root = tempfile::tempdir().unwrap();
    assert_eq!(
        PinnedObject::open(&root.path().join("missing"))
            .unwrap_err()
            .kind(),
        io::ErrorKind::NotFound
    );
}

#[cfg(unix)]
#[test]
fn symlink_pin_does_not_follow_even_dangling_target() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("target");
    let link = root.path().join("link");
    fs::write(&target, b"caller").unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let pin = PinnedObject::open(&link).unwrap();
    assert_eq!(pin.kind(), ObjectKind::Symlink);
    assert_ne!(
        pin.identity(),
        PinnedObject::open(&target).unwrap().identity()
    );
    fs::remove_file(&target).unwrap();
    assert!(pin.matches_path(&link).unwrap());
}

#[cfg(windows)]
#[test]
fn native_win32_information_and_busy_handle() {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("file");
    fs::write(&path, b"caller").unwrap();
    let pin = PinnedObject::open(&path).unwrap();
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    assert_ne!(
        unsafe { GetFileInformationByHandle(pin.file().as_raw_handle(), &mut info) },
        0
    );
    eprintln!(
        "NATIVE GetFileInformationByHandle volume={} file_id={}:{}",
        info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
    );
    drop(pin);
    // A read-only share=0 holder can still permit BACKUP_SEMANTICS opens on
    // Windows. A writable exclusive holder is a real denied positive control.
    let busy = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    assert_eq!(fs::File::open(&path).unwrap_err().raw_os_error(), Some(32));
    assert_eq!(
        PinnedObject::open(&path).unwrap_err().raw_os_error(),
        Some(32)
    );
    drop(busy);
    assert_eq!(fs::read(&path).unwrap(), b"caller");
}

#[cfg(windows)]
#[test]
fn junction_is_pinned_as_reparse_not_target_directory() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("target");
    let link = root.path().join("junction");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("caller"), b"preserve").unwrap();
    let output = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&link)
        .arg(&target)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let pin = PinnedObject::open(&link).unwrap();
    assert_eq!(pin.kind(), ObjectKind::ReparsePoint);
    assert_ne!(
        pin.identity(),
        PinnedObject::open(&target).unwrap().identity()
    );
    assert!(pin.matches_path(&link).unwrap());
    drop(pin);
    fs::remove_dir(&link).unwrap();
    assert_eq!(fs::read(target.join("caller")).unwrap(), b"preserve");
}
