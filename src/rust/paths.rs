//! Filesystem paths shared with native tools must not use Rust's Windows verbatim prefix.
use std::path::{Path, PathBuf};

pub fn canonicalize(path: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(path).map(native_path)
}

/// Compare existing filesystem identities without changing their public path spelling.
pub fn same_existing(left: impl AsRef<Path>, right: impl AsRef<Path>) -> std::io::Result<bool> {
    Ok(canonicalize(left)? == canonicalize(right)?)
}

/// Convert only Windows drive and UNC verbatim prefixes, preserving the UNC authority.
/// Other device namespaces and non-Windows paths are left untouched.
pub fn native_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        use std::path::{Component, Prefix};
        if let Some(Component::Prefix(prefix)) = path.components().next() {
            let mut ordinary = match prefix.kind() {
                Prefix::VerbatimDisk(drive) => OsString::from(format!("{}:", char::from(drive))),
                Prefix::VerbatimUNC(server, share) => {
                    let mut root = OsString::from(r"\\");
                    root.push(server);
                    root.push(r"\");
                    root.push(share);
                    root
                }
                _ => return path,
            };
            let suffix: Vec<u16> = path
                .as_os_str()
                .encode_wide()
                .skip(prefix.as_os_str().encode_wide().count())
                .collect();
            ordinary.push(OsString::from_wide(&suffix));
            return PathBuf::from(ordinary);
        }
    }
    path
}
