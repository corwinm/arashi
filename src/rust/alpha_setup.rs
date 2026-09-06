//! Opt-in trusted-local-archive alpha lifecycle. Never manages stable names or PATH.
//! Schema 1 is shared with the retired Python installer. Concurrent external writers
//! are unsupported; changed/unproven recovery contents are deliberately preserved.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env, fs,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
type Payload = BTreeMap<String, Vec<u8>>;
const LEDGER: &str = ".arashi-alpha-ownership.json";
const MAX: u64 = 128 * 1024 * 1024;

fn refuse<T>(message: impl Into<String>) -> Result<T> {
    Err(io::Error::other(message.into()).into())
}
fn names() -> [&'static str; 2] {
    if cfg!(windows) {
        ["arashi2.exe", "aw2.exe"]
    } else {
        ["arashi2", "aw2"]
    }
}
fn platform() -> Result<String> {
    let os = match env::consts::OS {
        "macos" => "macos",
        "linux" => "linux",
        "windows" => "windows",
        _ => return refuse("Unsupported alpha platform"),
    };
    let arch = match env::consts::ARCH {
        "aarch64" if os != "windows" => "arm64",
        "x86_64" => "x64",
        _ => return refuse("Unsupported alpha architecture"),
    };
    Ok(format!("{os}-{arch}"))
}
fn version(value: &str) -> bool {
    let Some((core, alpha)) = value.split_once("-alpha.") else {
        return false;
    };
    let parts: Vec<_> = core.split('.').collect();
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    parts.len() == 3 && parts[0] == "2" && parts[1..].iter().all(|s| digits(s)) && digits(alpha)
}
fn digest(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

// Windows stable Rust does not expose file IDs/link counts through MetadataExt.
// Query the opened file handle; timestamps are not ownership identities.
#[cfg(windows)]
fn identity(path: &Path, directory: bool) -> Result<(u64, u64, u64)> {
    use std::os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        GetFileInformationByHandle,
    };
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_attributes() & 0x400 != 0
        || (if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        })
    {
        return refuse(format!(
            "Linked, reparse or special path refused: {}",
            path.display()
        ));
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error().into());
    }
    if info.dwFileAttributes & 0x400 != 0 || (!directory && info.nNumberOfLinks != 1) {
        return refuse("Reparse or hardlinked path refused");
    }
    Ok((
        info.dwVolumeSerialNumber as u64,
        ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        info.dwFileAttributes as u64,
    ))
}
#[cfg(unix)]
fn identity(path: &Path, directory: bool) -> Result<(u64, u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let info = fs::symlink_metadata(path)?;
    if info.file_type().is_symlink()
        || (if directory {
            !info.is_dir()
        } else {
            !info.is_file() || info.nlink() != 1
        })
    {
        return refuse(format!(
            "Linked, special or hardlinked path refused: {}",
            path.display()
        ));
    }
    Ok((info.dev(), info.ino(), info.mode() as u64))
}
fn ancestors(path: &Path) -> Result<()> {
    for parent in path.ancestors() {
        identity(parent, true)?;
    }
    Ok(())
}
fn read(path: &Path, limit: u64) -> Result<Vec<u8>> {
    identity(path, false)?;
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return refuse(format!("Oversized file: {}", path.display()));
    }
    Ok(bytes)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Release {
    schema: u32,
    channel: String,
    version: String,
    platform: String,
}
impl Release {
    fn validate(&self) -> Result<()> {
        if self.schema != 1
            || self.channel != "rust-alpha"
            || !version(&self.version)
            || self.platform != platform()?
        {
            return refuse("Wrong alpha release identity/platform");
        }
        Ok(())
    }
}
// A fixed struct (not a JSON map) rejects duplicate and unknown payload keys.
#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Files {
    #[cfg_attr(windows, serde(rename = "arashi2.exe"))]
    arashi2: String,
    #[cfg_attr(windows, serde(rename = "aw2.exe"))]
    aw2: String,
}
fn hashes(payload: &Payload) -> Files {
    Files {
        arashi2: digest(&payload[names()[0]]),
        aw2: digest(&payload[names()[1]]),
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Ledger {
    schema: u32,
    channel: String,
    directory: String,
    platform: String,
    version: String,
    files: Files,
}
#[derive(Debug, PartialEq)]
struct Owned {
    payload: Payload,
    identities: BTreeMap<String, (u64, u64, u64)>,
    root: (u64, u64, u64),
}
fn entries(path: &Path) -> Result<Vec<String>> {
    let mut entries = fs::read_dir(path)?
        .map(|entry| {
            Ok(entry?
                .file_name()
                .into_string()
                .map_err(|_| io::Error::other("Non-UTF-8 entry"))?)
        })
        .collect::<Result<Vec<_>>>()?;
    entries.sort();
    Ok(entries)
}
fn owned(destination: &Path) -> Result<Owned> {
    ancestors(destination)?;
    let mut expected = vec![
        names()[0].to_string(),
        names()[1].to_string(),
        LEDGER.to_string(),
    ];
    expected.sort();
    if entries(destination)? != expected {
        return refuse("Unowned/missing/extra alpha files; preserve directory for manual recovery");
    }
    let mut payload = Payload::new();
    let mut identities = BTreeMap::new();
    for name in expected {
        identities.insert(name.clone(), identity(&destination.join(&name), false)?);
        payload.insert(name.clone(), read(&destination.join(name), MAX)?);
    }
    let ledger: Ledger = serde_json::from_slice(&payload[LEDGER])?;
    Release {
        schema: ledger.schema,
        channel: ledger.channel,
        platform: ledger.platform,
        version: ledger.version,
    }
    .validate()?;
    if Some(ledger.directory.as_str()) != destination.to_str() || ledger.files != hashes(&payload) {
        return refuse("Alpha ownership manifest/payload mismatch; no files removed");
    }
    Ok(Owned {
        payload,
        identities,
        root: identity(destination, true)?,
    })
}
fn remove_owned_tree(path: &Path, payload: &Payload) -> Result<()> {
    identity(path, true)?;
    if entries(path)? != payload.keys().cloned().collect::<Vec<_>>() {
        return refuse(format!(
            "Recovery directory changed; preserved: {}",
            path.display()
        ));
    }
    for (name, data) in payload {
        if read(&path.join(name), MAX)? != *data {
            return refuse(format!(
                "Recovery payload changed; preserved: {}",
                path.join(name).display()
            ));
        }
    }
    for name in payload.keys() {
        fs::remove_file(path.join(name))?;
    }
    fs::remove_dir(path)?;
    Ok(())
}
fn release(archive: &Path, checksum: &Path) -> Result<(Release, Payload)> {
    let bytes = read(archive, 2 * MAX)?;
    let basename = archive
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("Non-UTF-8 archive name")?;
    if read(checksum, 4096)? != format!("{}  {basename}\n", digest(&bytes)).as_bytes() {
        return refuse("Alpha archive SHA-256 mismatch or malformed checksum file");
    }
    let mut zip = zip::ZipArchive::new(io::Cursor::new(&bytes))?;
    // zip indexes by name and silently collapses duplicate central-directory
    // records. Count physical records too, preserving the closed archive boundary.
    let mut offset = usize::try_from(zip.central_directory_start())?;
    let mut records = 0;
    while bytes.get(offset..offset + 4) == Some(b"PK\x01\x02") {
        let header = bytes
            .get(offset..offset + 46)
            .ok_or("Truncated ZIP directory")?;
        let length = |i| u16::from_le_bytes([header[i], header[i + 1]]) as usize;
        offset += 46 + length(28) + length(30) + length(32);
        records += 1;
        if records > 3 || offset > bytes.len() {
            return refuse("Duplicate/extra or truncated alpha ZIP member");
        }
    }
    if records != 3 {
        return refuse("Alpha ZIP requires exactly three physical members");
    }
    if zip.len() != 3 {
        return refuse("Alpha archive must contain exactly two alpha binaries and release.json");
    }
    let mut payload = Payload::new();
    for index in 0..zip.len() {
        let mut member = zip.by_index(index)?;
        let name = member.name().to_string();
        if ![names()[0], names()[1], "release.json"].contains(&name.as_str())
            || payload.contains_key(&name)
            || member
                .unix_mode()
                .is_none_or(|mode| mode & 0o170000 != 0o100000)
            || member.size() > MAX
            || member.encrypted()
        {
            return refuse("Invalid alpha archive member");
        }
        let mut bytes = Vec::new();
        member.by_ref().take(MAX + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX {
            return refuse("Oversized alpha archive member");
        }
        payload.insert(name, bytes);
    }
    let meta: Release = serde_json::from_slice(
        &payload
            .remove("release.json")
            .ok_or("Missing release.json")?,
    )?;
    meta.validate()?;
    Ok((meta, payload))
}
fn smoke(path: &Path, expected: &str) -> Result<()> {
    let mut child = Command::new(path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child.stdout.take().ok_or("Missing smoke stdout")?;
    let stderr = child.stderr.take().ok_or("Missing smoke stderr")?;
    let reader = |stream: Box<dyn Read + Send>| {
        let (sender, receiver) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let mut out = Vec::new();
            let result = stream.take(4096).read_to_end(&mut out).map(|_| out);
            let _ = sender.send(result);
        });
        receiver
    };
    let out = reader(Box::new(stdout));
    let err = reader(Box::new(stderr));
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if start.elapsed() >= Duration::from_secs(15) {
            let _ = child.kill();
            let _ = child.wait();
            return refuse("Alpha binary smoke test timed out");
        }
        thread::sleep(Duration::from_millis(10));
    };
    // Bound the entire capture, including inherited pipes after the direct child
    // exits. This is not an untrusted process-tree sandbox.
    let remaining = || Duration::from_secs(15).saturating_sub(start.elapsed());
    let stdout = out
        .recv_timeout(remaining())
        .map_err(|_| "Alpha binary smoke test timed out")??;
    let stderr = err
        .recv_timeout(remaining())
        .map_err(|_| "Alpha binary smoke test timed out")??;
    if !status.success() || stdout != expected.as_bytes() || !stderr.is_empty() {
        return refuse(format!(
            "Alpha binary smoke test failed: {}",
            path.display()
        ));
    }
    Ok(())
}
fn private_dir(parent: &Path, prefix: &str) -> Result<PathBuf> {
    Ok(tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in(parent)?
        .keep())
}
fn create(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(
            if path.file_name().is_some_and(|s| s == LEDGER) {
                0o600
            } else {
                0o755
            },
        ))?;
    }
    Ok(())
}
fn promote(
    stage: &Path,
    destination: &Path,
    backup: &Path,
    rename: impl Fn(&Path, &Path) -> io::Result<()>,
) -> Result<()> {
    rename(destination, backup)?;
    if let Err(error) = rename(stage, destination) {
        if fs::symlink_metadata(destination).is_err_and(|e| e.kind() == io::ErrorKind::NotFound) {
            rename(backup, destination)?;
        } else {
            eprintln!(
                "Recovery required; previous alpha retained at {}",
                backup.display()
            );
        }
        return Err(error.into());
    }
    Ok(())
}
#[derive(Default)]
struct Args {
    action: String,
    archive: Option<PathBuf>,
    checksum: Option<PathBuf>,
    destination: Option<PathBuf>,
}
fn lifecycle(args: Args) -> Result<()> {
    lifecycle_with_rename(args, |a, b| fs::rename(a, b))
}
fn lifecycle_with_rename(
    args: Args,
    rename: impl Fn(&Path, &Path) -> io::Result<()>,
) -> Result<()> {
    let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or("An absolute HOME/USERPROFILE is required")?;
    let destination = args
        .destination
        .unwrap_or_else(|| home.join(".arashi-alpha"));
    if !destination.is_absolute()
        || destination.file_name().is_none_or(|n| n != ".arashi-alpha")
        || destination
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        || destination.to_str().is_none()
    {
        return refuse(
            "Install directory must be an absolute, canonical path ending in .arashi-alpha",
        );
    }
    let parent = destination.parent().ok_or("Missing destination parent")?;
    ancestors(parent)?;
    let lock = parent.join(".arashi-alpha.lock");
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(&lock)?;
    }
    #[cfg(windows)]
    fs::create_dir(&lock)?;
    let mut stage: Option<PathBuf> = None;
    let mut snapshot = Payload::new();
    let result = (|| -> Result<()> {
        let old = match fs::symlink_metadata(&destination) {
            Ok(_) => Some(owned(&destination)?),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        if args.action == "uninstall" {
            let old = old.ok_or("No owned alpha installation; nothing removed")?;
            if owned(&destination)? != old {
                return refuse("Alpha install changed during preflight");
            }
            remove_owned_tree(&destination, &old.payload)?;
            println!(
                "Removed owned Rust alpha binaries only. Manual PATH entries were not changed."
            );
            return Ok(());
        }
        let (meta, payload) = release(
            args.archive.as_deref().ok_or(
                "install requires --archive and --checksum-file; no latest/stable resolution",
            )?,
            args.checksum
                .as_deref()
                .ok_or("install requires --archive and --checksum-file")?,
        )?;
        let staging = private_dir(parent, ".arashi-alpha-stage-")?;
        stage = Some(staging.clone());
        for (name, data) in &payload {
            snapshot.insert(name.clone(), data.clone());
            create(&staging.join(name), data)?;
        }
        let expected = format!("arashi2 {} (experimental native alpha)\n", meta.version);
        for name in names() {
            smoke(&staging.join(name), &expected)?;
        }
        let ledger = Ledger {
            schema: 1,
            channel: "rust-alpha".into(),
            directory: destination.to_str().ok_or("Non-UTF-8 destination")?.into(),
            platform: platform()?,
            version: meta.version,
            files: hashes(&payload),
        };
        // Sorted compact schema-1 JSON; legacy escaped Unicode remains readable.
        let mut data = serde_json::to_vec(&serde_json::to_value(&ledger)?)?;
        data.push(b'\n');
        snapshot.insert(LEDGER.into(), data.clone());
        create(&staging.join(LEDGER), &data)?;
        ancestors(parent)?;
        if let Some(old) = old {
            if owned(&destination)? != old {
                return refuse("Alpha install changed during staging");
            }
            let backup = private_dir(parent, ".arashi-alpha-backup-")?;
            fs::remove_dir(&backup)?;
            promote(&staging, &destination, &backup, &rename)?;
            stage = None;
            remove_owned_tree(&backup, &old.payload)?;
        } else {
            if fs::symlink_metadata(&destination).is_ok() {
                return refuse("Destination appeared during staging");
            }
            fs::rename(&staging, &destination)?;
            stage = None;
        }
        owned(&destination)?;
        println!("Installed {} at {}", expected.trim(), destination.display());
        println!(
            "No PATH/profile changes. Invoke {} directly, or manually add this alpha-only directory to PATH.",
            destination.join(names()[1]).display()
        );
        Ok(())
    })();
    let cleanup = stage
        .as_ref()
        .map(|p| remove_owned_tree(p, &snapshot))
        .transpose();
    let unlock = fs::remove_dir(&lock);
    if let Err(e) = &cleanup {
        eprintln!("Alpha staging preserved for recovery: {e}");
    }
    result?;
    cleanup?;
    unlock?;
    Ok(())
}
fn main() {
    let result = (|| -> Result<()> {
        let mut tokens = env::args_os().skip(1);
        let first = tokens
            .next()
            .ok_or("Expected install or uninstall; use --help")?;
        if first == "--help" || first == "-h" {
            println!(
                "Native opt-in Rust alpha setup; never manages stable v1.\nUsage: arashi2-setup install --archive FILE --checksum-file FILE [--install-dir ABSOLUTE/.arashi-alpha]\n       arashi2-setup uninstall [--install-dir ABSOLUTE/.arashi-alpha]\nNo network, Python, Node, PATH/profile or registry changes."
            );
            return Ok(());
        }
        if first == "--version" {
            println!("arashi2-setup {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        let action = first.into_string().map_err(|_| "Invalid action")?;
        if action != "install" && action != "uninstall" {
            return refuse("Expected install or uninstall");
        }
        let mut args = Args {
            action,
            ..Default::default()
        };
        while let Some(token) = tokens.next() {
            let slot = match token.to_str() {
                Some("--archive") => &mut args.archive,
                Some("--checksum-file") => &mut args.checksum,
                Some("--install-dir") => &mut args.destination,
                _ => return refuse("Unknown alpha setup argument"),
            };
            if slot.is_some() {
                return refuse("Duplicate alpha setup argument");
            }
            *slot = Some(tokens.next().ok_or("Missing option value")?.into());
        }
        lifecycle(args)
    })();
    if let Err(error) = result {
        eprintln!(
            "Alpha setup refused/failed: {error}\nKeep stable arashi/aw unchanged. Preserve reported recovery directories; never delete an unproven manifest. Obtain a complete trusted alpha bundle for this platform; no runtime fallback is attempted."
        );
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn smoke_timeout_includes_inherited_output_pipes() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("pipe-holder");
        fs::write(
            &executable,
            b"#!/bin/sh\n/bin/sleep 18 &\nprintf expected\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let start = Instant::now();
        assert!(smoke(&executable, "expected").is_err());
        assert!(start.elapsed() < Duration::from_secs(17));
    }
    #[test]
    fn failed_promotion_restores_real_old_directory() {
        let temp = tempfile::tempdir().unwrap();
        let temp_path = temp.path().canonicalize().unwrap();
        let old = temp_path.join(".arashi-alpha");
        if let Some(archive) = env::var_os("ALPHA_TEST_ARCHIVE") {
            let args = || Args {
                action: "install".into(),
                archive: Some(PathBuf::from(&archive)),
                checksum: Some(
                    env::var_os("ALPHA_TEST_CHECKSUM")
                        .expect("checksum fixture")
                        .into(),
                ),
                destination: Some(old.clone()),
            };
            lifecycle(args()).unwrap();
            let original = owned(&old).unwrap();
            let error = lifecycle_with_rename(args(), |a, b| {
                if a.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".arashi-alpha-stage-")
                {
                    Err(io::Error::other("injected promotion failure"))
                } else {
                    fs::rename(a, b)
                }
            })
            .unwrap_err();
            assert!(error.to_string().contains("injected promotion failure"));
            assert_eq!(original, owned(&old).unwrap());
            assert_eq!(entries(&temp_path).unwrap(), [".arashi-alpha"]);
            println!("real release rollback verified");
            return;
        }
        let stage = temp.path().join("stage");
        let backup = temp.path().join("backup");
        fs::create_dir(&old).unwrap();
        fs::create_dir(&stage).unwrap();
        fs::write(old.join("aw2"), b"previous release").unwrap();
        fs::write(stage.join("aw2"), b"candidate").unwrap();
        let result = promote(&stage, &old, &backup, |a, b| {
            if a == stage {
                Err(io::Error::other("injected promotion failure"))
            } else {
                fs::rename(a, b)
            }
        });
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("injected promotion failure")
        );
        assert_eq!(fs::read(old.join("aw2")).unwrap(), b"previous release");
        assert!(!backup.exists());
        assert_eq!(fs::read(stage.join("aw2")).unwrap(), b"candidate");
    }
}
