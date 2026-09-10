//! Owner-only, no-follow source-format deletion provenance.
use super::*;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
unsafe extern "C" {
    fn geteuid() -> u32;
}
fn nofollow_nonblock() -> Result<i32> {
    #[cfg(target_os = "macos")]
    {
        Ok(0x100 | 0x4)
    }
    #[cfg(target_os = "linux")]
    {
        Ok(0x20000 | 0x800)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Err(unsafe_storage(
            "No-follow receipt open is unavailable on this platform",
        ))
    }
}

pub(super) const PHASES: [&str; 7] = [
    "provenance",
    "worktrees",
    "metadata",
    "canonical-clone",
    "workspace-hooks",
    "configuration",
    "verification",
];
pub(super) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn invalid(message: &str) -> Error {
    closed("DELETE_RECEIPT_INVALID", message, 1)
}
fn stale(message: &str) -> Error {
    closed("DELETE_RECEIPT_STALE", message, 1)
}
fn unsafe_storage(message: &str) -> Error {
    closed("DELETE_RECEIPT_UNSAFE", message, 1)
}
fn parent(path: &Path) -> Result<&Path> {
    path.parent()
        .ok_or_else(|| invalid("Receipt path parent is unavailable"))
}
fn quarantine_suffix(plan_id: &str) -> String {
    hash(format!("arashi-delete-quarantine-v1\0{plan_id}").as_bytes())
}
fn clone_quarantine_path(clone: &Path, key: &str, suffix: &str) -> Result<PathBuf> {
    Ok(parent(clone)?.join(format!("{}{suffix}", quarantine_prefix(key))))
}
fn linked_quarantine_path(path: &Path, suffix: &str) -> Result<PathBuf> {
    let encoded = path
        .to_str()
        .ok_or_else(|| invalid("Non-UTF-8 worktree path"))?;
    Ok(parent(path)?.join(format!(
        ".arashi-delete-worktree-{}-{suffix}",
        hash(encoded.as_bytes())
    )))
}

fn private_path_absent(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.into()),
    }
}

fn quarantine_generation_available(plan: &DeletePlan, suffix: &str) -> Result<bool> {
    let mut paths = vec![clone_quarantine_path(
        &plan.repository_path,
        &plan.repository_key,
        suffix,
    )?];
    paths.extend(
        plan.linked
            .iter()
            .map(|item| linked_quarantine_path(&item.path, suffix))
            .collect::<Result<Vec<_>>>()?,
    );
    for path in paths {
        if !private_path_absent(&path)?
            || !private_path_absent(Path::new(&format!("{}.retiring", path.display())))?
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn allocate_quarantine_suffix(plan: &DeletePlan, plan_id: &str) -> Result<String> {
    let base = quarantine_suffix(plan_id);
    for generation in 0u64.. {
        let suffix = if generation == 0 {
            base.clone()
        } else {
            format!("{base}-{generation}")
        };
        if quarantine_generation_available(plan, &suffix)? {
            return Ok(suffix);
        }
    }
    unreachable!()
}

pub(super) fn path(common: &Path, key: &str) -> PathBuf {
    common
        .join(".arashi-delete-receipts")
        .join(format!("{}.json", hash(key.as_bytes())))
}
pub(super) fn storage(directory: &Path) -> Result<Option<ObjectIdentity>> {
    let metadata = match fs::symlink_metadata(directory) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.mode() & 0o077 != 0
        || metadata.uid() != unsafe { geteuid() }
    {
        return Err(unsafe_storage(
            "Delete receipt directory is not a plain owner-only directory",
        ));
    }
    Ok(Some(ObjectIdentity::path(directory)?))
}
fn read_plain(path: &Path) -> Result<(Vec<u8>, ObjectIdentity)> {
    storage(
        path.parent()
            .ok_or_else(|| unsafe_storage("Receipt parent unavailable"))?,
    )?
    .ok_or_else(|| unsafe_storage("Receipt storage disappeared"))?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.mode() & 0o077 != 0
        || metadata.uid() != unsafe { geteuid() }
    {
        return Err(unsafe_storage(
            "Delete receipt is not a plain owner-only file",
        ));
    }
    let identity = ObjectIdentity::path(path)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nofollow_nonblock()?)
        .open(path)?;
    if ObjectIdentity::file(&file)? != identity || !identity.matches(path) {
        return Err(unsafe_storage("Delete receipt changed while opening"));
    }
    let held = identity.pin.file().metadata()?;
    if held.mode() & 0o077 != 0 || held.uid() != unsafe { geteuid() } {
        return Err(unsafe_storage("Receipt owner/mode changed while opening"));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    if !identity.matches(path) {
        return Err(unsafe_storage("Delete receipt changed while reading"));
    }
    Ok((bytes, identity))
}
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn rename_noreplace(source: &Path, destination: &Path) -> Result<()> {
    rustix::fs::renameat_with(
        rustix::fs::CWD,
        source,
        rustix::fs::CWD,
        destination,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(std::io::Error::from)?;
    Ok(())
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(super) fn rename_noreplace(_source: &Path, _destination: &Path) -> Result<()> {
    Err(unsafe_storage(
        "Atomic no-replace receipt rename is unavailable on this platform",
    ))
}
fn exact(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|map| map.len() == keys.len() && keys.iter().all(|key| map.contains_key(*key)))
}
fn strings(value: &Value) -> Result<Vec<String>> {
    value
        .as_array()
        .ok_or_else(|| invalid("Expected receipt string array"))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| invalid("Expected receipt string"))
        })
        .collect()
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| invalid("Expected receipt string field"))
}
pub(super) fn phase(kind: &str) -> Option<usize> {
    Some(match kind {
        "resume-receipt" => 0,
        "linked-worktree" => 1,
        "worktree-metadata" => 2,
        "canonical-clone" | "local-ref" => 3,
        "workspace-hook" => 4,
        "config-entry" => 5,
        "preserved-global-hook" => 6,
        _ => return None,
    })
}
fn quoted(value: &str) -> String {
    serde_json::to_string(value).unwrap()
}
// JSON property order is significant to the retained source's stableHash.
fn item_json(item: &Value) -> Result<String> {
    let preserve = text(item, "kind")? == "preserved-global-hook";
    Ok(format!(
        "{{\"id\":{},\"kind\":{},\"ownership\":{},\"path\":{},\"ref\":{},\"oid\":{},\"planned\":{},\"completed\":false,\"state\":{},\"reasonCode\":null,\"message\":null}}",
        item["id"],
        item["kind"],
        quoted(if preserve { "preserve" } else { "delete" }),
        item["path"],
        item["ref"],
        item["oid"],
        !preserve,
        quoted(if preserve { "preserved" } else { "planned" })
    ))
}
fn sorted_items(items: &[Value]) -> Vec<Value> {
    let mut items = items.to_vec();
    items.sort_by(|left, right| {
        let rank = |item: &Value| phase(item["kind"].as_str().unwrap_or("")).unwrap_or(99);
        rank(left).cmp(&rank(right)).then_with(|| {
            if rank(left) == 1 {
                let depth = |item: &Value| {
                    item["path"]
                        .as_str()
                        .unwrap_or("")
                        .split(['/', '\\'])
                        .count()
                };
                let order = depth(right).cmp(&depth(left));
                if !order.is_eq() {
                    return order;
                }
            }
            let identity = |item: &Value| {
                ["path", "ref", "oid"]
                    .map(|key| item[key].as_str().unwrap_or(""))
                    .join("\0")
            };
            identity(left).cmp(&identity(right))
        })
    });
    items
}
pub(super) fn plan_hash(record: &Value) -> Result<String> {
    let items = sorted_items(
        record["identities"]
            .as_array()
            .ok_or_else(|| invalid("Missing receipt identities"))?,
    );
    let items = items
        .iter()
        .map(item_json)
        .collect::<Result<Vec<_>>>()?
        .join(",");
    let mut warnings = strings(&record["warnings"])?;
    warnings.sort();
    warnings.dedup();
    Ok(hash(
        format!(
            "{{\"authority\":{{\"configDigest\":{}}},\"items\":[{}],\"warnings\":{}}}",
            record["configDigest"],
            items,
            serde_json::to_string(&warnings)?
        )
        .as_bytes(),
    ))
}
fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let a = chunk[0] as usize;
        let b = chunk.get(1).copied().unwrap_or(0) as usize;
        let c = chunk.get(2).copied().unwrap_or(0) as usize;
        out.push(ABC[a >> 2] as char);
        out.push(ABC[((a & 3) << 4) | (b >> 4)] as char);
        out.push(if chunk.len() > 1 {
            ABC[((b & 15) << 2) | (c >> 6)] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ABC[c & 63] as char
        } else {
            '='
        });
    }
    out
}
pub(super) fn unbase64(input: &str) -> Result<Vec<u8>> {
    const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    if !input.len().is_multiple_of(4) {
        return Err(invalid("Noncanonical base64"));
    }
    let mut out = Vec::new();
    for chunk in input.as_bytes().chunks(4) {
        let mut value = 0u32;
        for byte in chunk {
            value = (value << 6)
                | if *byte == b'=' {
                    0
                } else {
                    ABC.iter()
                        .position(|c| c == byte)
                        .ok_or_else(|| invalid("Invalid base64"))? as u32
                };
        }
        out.push((value >> 16) as u8);
        if chunk[2] != b'=' {
            out.push((value >> 8) as u8);
        }
        if chunk[3] != b'=' {
            out.push(value as u8);
        }
    }
    if base64(&out) != input {
        return Err(invalid("Noncanonical base64"));
    }
    Ok(out)
}
fn entry(path: &Path) -> Result<Value> {
    let pinned = filesystem_identity::PinnedObject::open(path)?;
    let kind = match pinned.kind() {
        filesystem_identity::ObjectKind::Directory => "directory",
        filesystem_identity::ObjectKind::File => "file",
        _ => return Err(unsafe_storage("Unsafe receipt path identity")),
    };
    if !pinned.matches_path(path)? {
        return Err(unsafe_storage("Unsafe receipt path identity"));
    }
    let identity = pinned
        .persisted_identity()
        .map_err(|_| unsafe_storage("Stable receipt creation identity is unavailable"))?;
    Ok(json!({"path":path,"identity":identity,"kind":kind}))
}
pub(super) fn capture(path: &Path) -> Result<Value> {
    let mut ancestors = path
        .ancestors()
        .skip(1)
        .map(entry)
        .collect::<Result<Vec<_>>>()?;
    ancestors.reverse();
    Ok(json!({"path":path,"leaf":entry(path)?,"ancestors":ancestors}))
}
pub(super) fn validate_identity(value: &Value, absent: bool) -> Result<()> {
    let path = Path::new(text(value, "path")?);
    let expected = path.ancestors().skip(1).collect::<Vec<_>>();
    let ancestors = value["ancestors"]
        .as_array()
        .ok_or_else(|| invalid("Missing identity ancestors"))?;
    if ancestors.len() != expected.len() {
        return Err(invalid("Incomplete identity ancestor chain"));
    }
    for (identity, path) in ancestors.iter().zip(expected.iter().rev()) {
        if identity["path"] != json!(path) || entry(path)? != *identity {
            return Err(stale("Deletion ancestor changed"));
        }
    }
    if absent {
        if !matches!(fs::symlink_metadata(path), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
        {
            return Err(stale("Completed deletion path was recreated"));
        }
    } else if entry(path)? != value["leaf"] {
        return Err(stale("Deletion leaf changed"));
    }
    Ok(())
}
fn validate_shape_identity(value: &Value) -> bool {
    let valid_identity = |value: &str| {
        let parts = value.split(':').collect::<Vec<_>>();
        let canonical = |part: &str| {
            !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part == "0" || !part.starts_with('0'))
        };
        parts.len() == 4
            && matches!(parts[0], "posix-v2" | "windows-v2")
            && canonical(parts[1])
            && canonical(parts[2])
            && canonical(parts[3])
            && parts[3] != "0"
    };
    let valid_entry = |entry: &Value| {
        exact(entry, &["path", "identity", "kind"])
            && entry["path"].is_string()
            && entry["identity"].as_str().is_some_and(valid_identity)
            && matches!(entry["kind"].as_str(), Some("file" | "directory"))
    };
    exact(value, &["path", "leaf", "ancestors"])
        && value["path"].is_string()
        && value["path"] == value["leaf"]["path"]
        && valid_entry(&value["leaf"])
        && value["ancestors"]
            .as_array()
            .is_some_and(|items| items.iter().all(valid_entry))
}

fn serialize_record(record: &Value) -> Result<Vec<u8>> {
    let mut ordered: PersistedObject = serde_json::from_slice(&serde_json::to_vec(record)?)?;
    if let Some((_, PersistedValue::Array(items))) =
        ordered.0.iter_mut().find(|(key, _)| key == "identities")
    {
        for item in items {
            if let PersistedValue::Object(object) = item {
                object.0.sort_by_key(|(key, _)| {
                    ["id", "kind", "path", "ref", "oid"]
                        .iter()
                        .position(|name| name == key)
                        .unwrap_or(99)
                });
            }
        }
    }
    serde_json::to_vec_pretty(&ordered).map_err(Error::from)
}

pub(super) struct Receipt {
    pub path: PathBuf,
    pub record: Value,
    bytes: Vec<u8>,
    identity: ObjectIdentity,
    directory: ObjectIdentity,
    legacy_upgrade_pending: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum PersistStage {
    StagedSynced,
    PublishedBeforeParentSync,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum InitialPublishStage {
    StagedSynced,
    PublishedBeforeParentSync,
}
impl Receipt {
    pub fn load(common: &Path, key: &str) -> Result<Option<Self>> {
        let path = path(common, key);
        let directory = storage(parent(&path)?)?;
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
            Ok(_) => {}
        }
        let (bytes, identity) = read_plain(&path)?;
        let record: Value = serde_json::from_slice(&bytes)
            .map_err(|_| invalid("Delete receipt is not UTF-8 JSON"))?;
        let mut receipt = Self {
            path,
            record,
            bytes,
            identity,
            directory: directory.ok_or_else(|| unsafe_storage("Receipt storage disappeared"))?,
            legacy_upgrade_pending: false,
        };
        receipt.validate_schema(common, key)?;
        receipt.legacy_upgrade_pending = receipt.upgrade_legacy_runtime(key)?;
        if receipt.legacy_upgrade_pending {
            receipt.validate_schema(common, key)?;
        }
        Ok(Some(receipt))
    }
    fn upgrade_legacy_runtime(&mut self, key: &str) -> Result<bool> {
        let needs_quarantines = self.record["runtime"].get("quarantinePath").is_none();
        let needs_prepared = self.record["runtime"]
            .get("destructionPreparedItemIds")
            .is_none();
        let needs_terminal_residues = self.record.get("terminalResidues").is_none();
        if !needs_quarantines && !needs_prepared && !needs_terminal_residues {
            return Ok(false);
        }
        let plan_id = text(&self.record, "planId")?.to_owned();
        let suffix = quarantine_suffix(&plan_id);
        let runtime = self.record["runtime"]
            .as_object_mut()
            .ok_or_else(|| invalid("Invalid receipt runtime"))?;
        let clone_path = PathBuf::from(
            runtime["clonePath"]
                .as_str()
                .ok_or_else(|| invalid("Invalid clone path"))?,
        );
        if needs_quarantines {
            runtime.insert(
                "quarantinePath".to_owned(),
                json!(clone_quarantine_path(&clone_path, key, &suffix)?),
            );
            let worktrees = runtime["identities"]["worktrees"]
                .as_array()
                .ok_or_else(|| invalid("Invalid runtime identities"))?
                .iter()
                .map(|identity| {
                    let path = PathBuf::from(text(identity, "path")?);
                    Ok(json!({"path":path,"quarantinePath":linked_quarantine_path(&path, &suffix)?}))
                })
                .collect::<Result<Vec<_>>>()?;
            runtime.insert("worktreeQuarantines".to_owned(), json!(worktrees));
        }
        if needs_prepared {
            runtime.insert("destructionPreparedItemIds".to_owned(), json!([]));
        }
        if needs_terminal_residues {
            self.record["terminalResidues"] = json!([]);
        }
        Ok(true)
    }
    fn validate_schema(&self, common: &Path, key: &str) -> Result<()> {
        let r = &self.record;
        let modern_receipt = exact(
            r,
            &[
                "version",
                "planId",
                "parentIdentity",
                "repositoryKey",
                "configDigest",
                "originalEntryDigest",
                "identities",
                "completedItemIds",
                "completedPhases",
                "remainingPhases",
                "retryArgv",
                "warnings",
                "terminalResidues",
                "runtime",
            ],
        );
        let legacy_receipt = exact(
            r,
            &[
                "version",
                "planId",
                "parentIdentity",
                "repositoryKey",
                "configDigest",
                "originalEntryDigest",
                "identities",
                "completedItemIds",
                "completedPhases",
                "remainingPhases",
                "retryArgv",
                "warnings",
                "runtime",
            ],
        );
        if (!modern_receipt && !legacy_receipt) || r["version"] != 2 {
            return Err(invalid("Invalid delete receipt schema"));
        }
        for key in [
            "planId",
            "parentIdentity",
            "configDigest",
            "originalEntryDigest",
        ] {
            let value = text(r, key)?;
            if value.len() != 64
                || !value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(invalid("Invalid receipt digest"));
            }
        }
        let parent = hash(
            format!(
                "{{\"commonDirectory\":{}}}",
                quoted(common.to_str().ok_or_else(|| invalid("Non-UTF-8 parent"))?)
            )
            .as_bytes(),
        );
        if r["repositoryKey"] != key || r["parentIdentity"] != parent {
            return Err(stale(
                "Delete receipt parent/repository provenance is stale",
            ));
        }
        let retry = strings(&r["retryArgv"])?;
        if retry != ["aw", "delete", key, "--force"]
            && retry != ["aw", "delete", key, "--force", "--json"]
        {
            return Err(invalid("Invalid retry argv"));
        }
        let items = r["identities"]
            .as_array()
            .ok_or_else(|| invalid("Missing identities"))?;
        for item in items {
            if !exact(item, &["id", "kind", "path", "ref", "oid"])
                || !item["id"].is_string()
                || phase(text(item, "kind")?).is_none()
                || ["path", "ref", "oid"]
                    .iter()
                    .any(|key| !item[key].is_null() && !item[key].is_string())
            {
                return Err(invalid("Invalid receipt item"));
            }
        }
        let completed = strings(&r["completedPhases"])?;
        let remaining = strings(&r["remainingPhases"])?;
        if completed
            .iter()
            .chain(&remaining)
            .map(String::as_str)
            .collect::<Vec<_>>()
            != PHASES
        {
            return Err(invalid("Invalid phase ledger"));
        }
        let done = strings(&r["completedItemIds"])?;
        let ids = items
            .iter()
            .map(|item| text(item, "id"))
            .collect::<Result<Vec<_>>>()?;
        let unique = |values: &[&str]| {
            values
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == values.len()
        };
        if !unique(&ids)
            || !unique(&done.iter().map(String::as_str).collect::<Vec<_>>())
            || done.iter().any(|id| !ids.contains(&id.as_str()))
        {
            return Err(invalid("Invalid completed item ledger"));
        }
        let mut gap = false;
        for item in items {
            let rank = phase(text(item, "kind")?).unwrap();
            let finished = done.iter().any(|id| item["id"] == *id);
            if (rank < completed.len() && !finished) || (rank > completed.len() && finished) {
                return Err(invalid("Inconsistent phase/item ledger"));
            }
            if rank == completed.len() {
                if !finished {
                    gap = true;
                } else if gap {
                    return Err(invalid("Active phase is not a prefix"));
                }
            }
        }
        let runtime = &r["runtime"];
        let modern_runtime = exact(
            runtime,
            &[
                "workspaceRoot",
                "configPath",
                "clonePath",
                "quarantinePath",
                "worktreeQuarantines",
                "destructionPreparedItemIds",
                "hookPaths",
                "expectedConfigBase64",
                "nextConfigBase64",
                "topology",
                "identities",
            ],
        );
        let quarantine_runtime = exact(
            runtime,
            &[
                "workspaceRoot",
                "configPath",
                "clonePath",
                "quarantinePath",
                "worktreeQuarantines",
                "hookPaths",
                "expectedConfigBase64",
                "nextConfigBase64",
                "topology",
                "identities",
            ],
        );
        let legacy_runtime = exact(
            runtime,
            &[
                "workspaceRoot",
                "configPath",
                "clonePath",
                "hookPaths",
                "expectedConfigBase64",
                "nextConfigBase64",
                "topology",
                "identities",
            ],
        );
        if !modern_runtime && !quarantine_runtime && !legacy_runtime {
            return Err(invalid("Invalid receipt runtime"));
        }
        for field in ["workspaceRoot", "configPath", "clonePath"] {
            text(runtime, field)?;
        }
        if modern_runtime || quarantine_runtime {
            let clone_path = Path::new(text(runtime, "clonePath")?);
            let quarantine_path = Path::new(text(runtime, "quarantinePath")?);
            let base_suffix = quarantine_suffix(text(r, "planId")?);
            let clone_prefix = quarantine_prefix(key);
            let quarantine_name = quarantine_path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| invalid("Invalid quarantine provenance"))?;
            let suffix = quarantine_name
                .strip_prefix(&clone_prefix)
                .ok_or_else(|| invalid("Invalid quarantine provenance"))?;
            let valid_generation = suffix == base_suffix
                || suffix
                    .strip_prefix(&format!("{base_suffix}-"))
                    .is_some_and(|value| {
                        !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
                    });
            if !clone_path.is_absolute()
                || !valid_generation
                || quarantine_path != clone_quarantine_path(clone_path, key, suffix)?
            {
                return Err(invalid("Invalid quarantine provenance"));
            }
            let worktree_quarantines = runtime["worktreeQuarantines"]
                .as_array()
                .ok_or_else(|| invalid("Invalid worktree quarantine provenance"))?;
            let worktree_paths = runtime["identities"]["worktrees"]
                .as_array()
                .ok_or_else(|| invalid("Invalid runtime identities"))?;
            if worktree_quarantines.len() != worktree_paths.len() {
                return Err(invalid("Invalid worktree quarantine provenance"));
            }
            let mut sources = std::collections::BTreeSet::new();
            let mut destinations = std::collections::BTreeSet::new();
            destinations.insert(quarantine_path.to_owned());
            for (identity, item) in worktree_paths.iter().zip(worktree_quarantines) {
                if !exact(item, &["path", "quarantinePath"])
                    || !item["path"].is_string()
                    || !item["quarantinePath"].is_string()
                    || identity["path"] != item["path"]
                {
                    return Err(invalid("Invalid worktree quarantine provenance"));
                }
                let path = Path::new(text(item, "path")?);
                let quarantine = Path::new(text(item, "quarantinePath")?);
                if !path.is_absolute()
                    || quarantine != linked_quarantine_path(path, suffix)?
                    || !sources.insert(path.to_owned())
                    || !destinations.insert(quarantine.to_owned())
                {
                    return Err(invalid("Invalid worktree quarantine provenance"));
                }
            }
        }
        let prepared = if modern_runtime {
            strings(&runtime["destructionPreparedItemIds"])?
        } else {
            Vec::new()
        };
        let prepared_set = prepared.iter().collect::<std::collections::BTreeSet<_>>();
        if prepared_set.len() != prepared.len()
            || prepared.iter().any(|id| done.contains(id))
            || prepared.iter().any(|id| !ids.contains(&id.as_str()))
        {
            return Err(invalid("Invalid destruction prepared ledger"));
        }
        if !prepared.is_empty() {
            let canonical = items
                .iter()
                .filter(|item| matches!(text(item, "kind"), Ok("canonical-clone" | "local-ref")))
                .map(|item| text(item, "id"))
                .collect::<Result<Vec<_>>>()?;
            let one_linked = prepared.len() == 1
                && items
                    .iter()
                    .any(|item| item["id"] == prepared[0] && item["kind"] == "linked-worktree");
            let canonical_group = prepared.len() == canonical.len()
                && canonical
                    .iter()
                    .all(|id| prepared.iter().any(|value| value == id));
            if !one_linked && !canonical_group {
                return Err(invalid("Prepared destruction group is incomplete"));
            }
            let active = completed.len();
            if prepared.iter().any(|id| {
                items
                    .iter()
                    .find(|item| item["id"] == *id)
                    .and_then(|item| phase(item["kind"].as_str().unwrap_or("")))
                    != Some(active)
            }) {
                return Err(invalid(
                    "Prepared destruction group is outside the active phase",
                ));
            }
        }
        let hooks = strings(&runtime["hookPaths"])?;
        unbase64(text(runtime, "expectedConfigBase64")?)?;
        unbase64(text(runtime, "nextConfigBase64")?)?;
        let topology = &runtime["topology"];
        if !exact(
            topology,
            &[
                "commonDirectory",
                "configuredActivePath",
                "primaryPath",
                "canonicalClonePath",
                "linkedWorktrees",
                "staleMetadata",
                "inventory",
            ],
        ) {
            return Err(invalid("Invalid topology"));
        }
        for field in [
            "commonDirectory",
            "configuredActivePath",
            "primaryPath",
            "canonicalClonePath",
        ] {
            text(topology, field)?;
        }
        for field in ["linkedWorktrees", "inventory"] {
            for item in topology[field]
                .as_array()
                .ok_or_else(|| invalid("Invalid topology inventory"))?
            {
                if !exact(
                    item,
                    &[
                        "path",
                        "head",
                        "branch",
                        "detached",
                        "bare",
                        "locked",
                        "prunable",
                        "metadataPath",
                        "present",
                    ],
                ) || !item["path"].is_string()
                    || ["head", "branch", "locked", "prunable", "metadataPath"]
                        .iter()
                        .any(|key| !item[key].is_null() && !item[key].is_string())
                    || ["detached", "bare", "present"]
                        .iter()
                        .any(|key| !item[key].is_boolean())
                {
                    return Err(invalid("Invalid worktree record"));
                }
            }
        }
        for item in topology["staleMetadata"]
            .as_array()
            .ok_or_else(|| invalid("Invalid stale metadata"))?
        {
            if !exact(item, &["path", "worktreePath"])
                || !item["path"].is_string()
                || !item["worktreePath"].is_string()
            {
                return Err(invalid("Invalid stale metadata"));
            }
        }
        let identities = &runtime["identities"];
        if !exact(
            identities,
            &[
                "clone",
                "canonicalGitAdmin",
                "worktrees",
                "worktreeAdmins",
                "metadata",
                "hooks",
            ],
        ) || !validate_shape_identity(&identities["clone"])
            || !validate_shape_identity(&identities["canonicalGitAdmin"])
        {
            return Err(invalid("Invalid runtime identities"));
        }
        for field in ["worktrees", "worktreeAdmins", "metadata", "hooks"] {
            if !identities[field]
                .as_array()
                .is_some_and(|items| items.iter().all(validate_shape_identity))
            {
                return Err(invalid("Invalid runtime identity list"));
            }
        }
        let paths = |kind: &str| {
            items
                .iter()
                .filter(|item| item["kind"] == kind)
                .map(|item| item["path"].clone())
                .collect::<Vec<_>>()
        };
        if paths("resume-receipt") != [json!(self.path)]
            || paths("canonical-clone") != [runtime["clonePath"].clone()]
            || runtime["clonePath"] != identities["clone"]["path"]
            || runtime["clonePath"] != topology["canonicalClonePath"]
            || topology["commonDirectory"] != identities["canonicalGitAdmin"]["path"]
        {
            return Err(stale("Receipt runtime path provenance is inconsistent"));
        }
        for (kind, field) in [
            ("linked-worktree", "worktrees"),
            ("worktree-metadata", "metadata"),
            ("workspace-hook", "hooks"),
        ] {
            let mut planned = paths(kind);
            let mut runtime_paths = identities[field]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["path"].clone())
                .collect::<Vec<_>>();
            planned.sort_by_key(Value::to_string);
            runtime_paths.sort_by_key(Value::to_string);
            if planned != runtime_paths {
                return Err(invalid("Receipt runtime paths disagree with plan"));
            }
        }
        let mut admin_paths = identities["worktreeAdmins"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["path"].clone())
            .collect::<Vec<_>>();
        let mut topology_admin_paths = topology["linkedWorktrees"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["present"] == true)
            .map(|item| item["metadataPath"].clone())
            .collect::<Vec<_>>();
        admin_paths.sort_by_key(Value::to_string);
        topology_admin_paths.sort_by_key(Value::to_string);
        if admin_paths != topology_admin_paths
            || admin_paths.iter().any(Value::is_null)
            || admin_paths.windows(2).any(|pair| pair[0] == pair[1])
        {
            return Err(invalid("Receipt worktree administration paths disagree"));
        }
        if paths("workspace-hook") != hooks.iter().map(|path| json!(path)).collect::<Vec<_>>() {
            return Err(invalid("Receipt hook paths disagree"));
        }
        if modern_receipt {
            let residues = r["terminalResidues"]
                .as_array()
                .ok_or_else(|| invalid("Invalid terminal residue ledger"))?;
            let mut keys = Vec::new();
            let mut residue_items = std::collections::BTreeSet::new();
            let mut residue_sources = std::collections::BTreeSet::new();
            let mut residue_destinations = std::collections::BTreeSet::new();
            for residue in residues {
                if !exact(residue, &["itemId", "source", "destination"]) {
                    return Err(invalid("Invalid terminal residue entry"));
                }
                let item_id = text(residue, "itemId")?;
                let source = text(residue, "source")?;
                let destination = text(residue, "destination")?;
                let item = items
                    .iter()
                    .find(|item| item["id"] == item_id)
                    .ok_or_else(|| invalid("Unknown terminal residue item"))?;
                let expected_destination = match item["kind"].as_str() {
                    Some("canonical-clone") => PathBuf::from(text(runtime, "quarantinePath")?),
                    Some("linked-worktree") => runtime["worktreeQuarantines"]
                        .as_array()
                        .and_then(|mappings| {
                            mappings.iter().find(|mapping| mapping["path"] == source)
                        })
                        .and_then(|mapping| mapping["quarantinePath"].as_str())
                        .map(PathBuf::from)
                        .ok_or_else(|| invalid("Missing terminal residue quarantine mapping"))?,
                    _ => return Err(invalid("Invalid terminal residue item kind")),
                };
                let mut retiring_name = expected_destination.as_os_str().to_os_string();
                retiring_name.push(".retiring");
                let retiring_destination = PathBuf::from(retiring_name);
                let destination_path = Path::new(destination);
                if item["path"] != source
                    || (destination_path != expected_destination
                        && destination_path != retiring_destination)
                    || !done.iter().any(|id| id == item_id)
                    || !residue_items.insert(item_id)
                    || !residue_sources.insert(source)
                    || !residue_destinations.insert(destination)
                {
                    return Err(invalid("Invalid terminal residue ledger"));
                }
                keys.push(format!("{item_id}\0{source}\0{destination}"));
            }
            let mut sorted = keys.clone();
            sorted.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
            if keys != sorted || (!residues.is_empty() && completed.len() != PHASES.len()) {
                return Err(invalid("Invalid terminal residue ledger"));
            }
        }
        if plan_hash(r)? != text(r, "planId")? {
            return Err(stale("Delete receipt plan provenance is stale"));
        }
        Ok(())
    }
    fn create_with<F>(plan: &DeletePlan, mut boundary: F) -> Result<Self>
    where
        F: FnMut(InitialPublishStage) -> Result<()>,
    {
        let common = parent(&plan.receipts_path)?;
        let path = path(common, &plan.repository_key);
        if storage(&plan.receipts_path)?.is_none() {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&plan.receipts_path)?;
            fs::File::open(common)?.sync_all()?;
        }
        let directory = storage(&plan.receipts_path)?
            .ok_or_else(|| unsafe_storage("Missing receipt directory"))?;
        let mut items = plan.plan_json()["items"].as_array().unwrap().iter().map(|item| json!({"id":item["id"],"kind":item["kind"],"path":item["path"],"ref":item["ref"],"oid":item["oid"]})).collect::<Vec<_>>();
        items.push(json!({"id":format!("resume-receipt:{}",path.display()),"kind":"resume-receipt","path":path,"ref":null,"oid":null}));
        items = sorted_items(&items);
        let worktrees = plan
            .linked
            .iter()
            .map(|item| capture(&item.path))
            .collect::<Result<Vec<_>>>()?;
        let worktree_admins = plan
            .linked
            .iter()
            .map(|item| capture(&item.admin))
            .collect::<Result<Vec<_>>>()?;
        let linked = plan.linked.iter().map(|item| json!({"path":item.path,"head":item.head,"branch":format!("refs/heads/{}",item.branch),"detached":false,"bare":false,"locked":null,"prunable":null,"metadataPath":item.admin,"present":true})).collect::<Vec<_>>();
        let mut inventory = vec![
            json!({"path":plan.repository_path,"head":plan.checkout_head,"branch":plan.checkout_branch.as_ref().map(|branch| format!("refs/heads/{branch}")),"detached":plan.detached,"bare":false,"locked":null,"prunable":null,"metadataPath":null,"present":true}),
        ];
        inventory.extend(linked.clone());
        let mut record = json!({"version":2,"planId":"","parentIdentity":hash(format!("{{\"commonDirectory\":{}}}",quoted(common.to_str().ok_or_else(|| invalid("Non-UTF-8 parent"))?)).as_bytes()),"repositoryKey":plan.repository_key,"configDigest":hash(&plan.config_before),"originalEntryDigest":hash(&original_entry(&plan.config_before,&plan.repository_key)?),"identities":items,"completedItemIds":[],"completedPhases":[],"remainingPhases":PHASES,"retryArgv":["aw","delete",plan.repository_key,"--force","--json"],"warnings":plan.warnings,"terminalResidues":[],"runtime":{"workspaceRoot":plan.workspace_root,"configPath":plan.config_path,"clonePath":plan.repository_path,"hookPaths":[],"expectedConfigBase64":base64(&plan.config_before),"nextConfigBase64":base64(&plan.config_after),"topology":{"commonDirectory":plan.repository_path.join(".git"),"configuredActivePath":plan.repository_path,"primaryPath":plan.repository_path,"canonicalClonePath":plan.repository_path,"linkedWorktrees":linked,"staleMetadata":[],"inventory":inventory},"identities":{"clone":capture(&plan.repository_path)?,"canonicalGitAdmin":capture(&plan.repository_path.join(".git"))?,"worktrees":worktrees,"worktreeAdmins":worktree_admins,"metadata":[],"hooks":[]}}});
        let plan_id = plan_hash(&record)?;
        record["planId"] = json!(&plan_id);
        let suffix = allocate_quarantine_suffix(plan, &plan_id)?;
        record["runtime"]["quarantinePath"] = json!(clone_quarantine_path(
            &plan.repository_path,
            &plan.repository_key,
            &suffix
        )?);
        record["runtime"]["worktreeQuarantines"] = json!(
            plan.linked
                .iter()
                .map(|item| Ok(json!({
                    "path": item.path,
                    "quarantinePath": linked_quarantine_path(&item.path, &suffix)?,
                })))
                .collect::<Result<Vec<_>>>()?
        );
        record["runtime"]["destructionPreparedItemIds"] = json!([]);
        let mut bytes = serialize_record(&record)?;
        bytes.push(b'\n');
        let mut staged = tempfile::NamedTempFile::new_in(&plan.receipts_path)?;
        staged
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
        staged.write_all(&bytes)?;
        staged.as_file().sync_all()?;
        boundary(InitialPublishStage::StagedSynced)?;
        rename_noreplace(staged.path(), &path)?;
        let identity = ObjectIdentity::path(&path)?;
        boundary(InitialPublishStage::PublishedBeforeParentSync)?;
        fs::File::open(&plan.receipts_path)?.sync_all()?;
        let receipt = Self {
            path,
            record,
            bytes,
            identity,
            directory,
            legacy_upgrade_pending: false,
        };
        receipt.validate_schema(common, &plan.repository_key)?;
        receipt.check()?;
        Ok(receipt)
    }
    pub fn create(plan: &DeletePlan) -> Result<Self> {
        Self::create_with(plan, |_| Ok(()))
    }
    #[cfg(test)]
    pub(super) fn create_with_stage<F>(plan: &DeletePlan, boundary: F) -> Result<Self>
    where
        F: FnMut(InitialPublishStage) -> Result<()>,
    {
        Self::create_with(plan, boundary)
    }
    pub fn check(&self) -> Result<()> {
        if storage(parent(&self.path)?)? != Some(self.directory.clone()) {
            return Err(unsafe_storage("Receipt directory identity changed"));
        }
        let (bytes, identity) = read_plain(&self.path)?;
        if bytes != self.bytes || identity != self.identity {
            return Err(stale("Receipt bytes or identity changed concurrently"));
        }
        Ok(())
    }
    fn persist_with<F>(&mut self, mut boundary: F) -> Result<()>
    where
        F: FnMut(PersistStage) -> Result<()>,
    {
        self.check()
            .map_err(|_| stale("Receipt changed before conditional persistence"))?;
        let mut bytes = serialize_record(&self.record)?;
        bytes.push(b'\n');
        let mut staged = tempfile::NamedTempFile::new_in(parent(&self.path)?)?;
        staged
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
        staged.write_all(&bytes)?;
        staged.as_file().sync_all()?;
        boundary(PersistStage::StagedSynced)?;
        self.check()
            .map_err(|_| stale("Receipt changed before atomic publication"))?;
        staged.persist(&self.path).map_err(|error| error.error)?;
        boundary(PersistStage::PublishedBeforeParentSync)?;
        fs::File::open(parent(&self.path)?)?.sync_all()?;
        self.bytes = bytes;
        self.identity = ObjectIdentity::path(&self.path)?;
        self.check()
            .map_err(|_| stale("Published receipt could not be revalidated"))?;
        Ok(())
    }
    pub fn persist(&mut self) -> Result<()> {
        self.persist_with(|_| Ok(()))
    }
    pub fn persist_legacy_upgrade(&mut self) -> Result<()> {
        if self.legacy_upgrade_pending {
            self.persist()?;
            self.legacy_upgrade_pending = false;
        }
        Ok(())
    }
    fn remove_with<F>(self, before_rename: F) -> Result<PathBuf>
    where
        F: FnOnce(),
    {
        self.check()?;
        let retained = PathBuf::from(format!(
            "{}.{}.retained",
            self.path.display(),
            hash(&self.bytes)
        ));
        if fs::symlink_metadata(&retained).is_ok() {
            return Err(stale("Retained delete receipt destination already exists"));
        }
        before_rename();
        rename_noreplace(&self.path, &retained)?;
        let accepted = read_plain(&retained)
            .is_ok_and(|(bytes, identity)| bytes == self.bytes && identity == self.identity);
        if !accepted {
            let _ = rename_noreplace(&retained, &self.path);
            return Err(stale("Retained receipt changed concurrently"));
        }
        fs::File::open(parent(&self.path)?)?.sync_all()?;
        Ok(retained)
    }
    pub fn remove(self) -> Result<PathBuf> {
        self.remove_with(|| {})
    }
    #[cfg(test)]
    pub(super) fn persist_with_race<F>(&mut self, race: F) -> Result<()>
    where
        F: FnOnce(),
    {
        let mut race = Some(race);
        self.persist_with(|stage| {
            if stage == PersistStage::StagedSynced {
                race.take().unwrap()();
            }
            Ok(())
        })
    }
    #[cfg(test)]
    pub(super) fn persist_with_stage<F>(&mut self, boundary: F) -> Result<()>
    where
        F: FnMut(PersistStage) -> Result<()>,
    {
        self.persist_with(boundary)
    }
    #[cfg(test)]
    pub(super) fn remove_with_race<F>(self, race: F) -> Result<PathBuf>
    where
        F: FnOnce(),
    {
        self.remove_with(race)
    }
    pub fn prepared(&self, id: &str) -> bool {
        self.record["runtime"]["destructionPreparedItemIds"]
            .as_array()
            .is_some_and(|items| items.iter().any(|value| value == id))
    }
    pub fn prepare(&mut self, ids: &[String]) -> Result<()> {
        if ids.iter().any(|id| self.done(id)) {
            return Err(invalid("Cannot prepare an already completed item"));
        }
        self.record["runtime"]["destructionPreparedItemIds"] = json!(ids);
        self.persist()
    }
    pub fn complete_prepared(&mut self, ids: &[String]) -> Result<()> {
        if !ids.iter().all(|id| self.prepared(id)) {
            return Err(invalid("Destruction completion lacks prepared provenance"));
        }
        for id in ids {
            if !self.done(id) {
                self.record["completedItemIds"]
                    .as_array_mut()
                    .ok_or_else(|| invalid("Invalid completed item ledger"))?
                    .push(json!(id));
            }
        }
        self.record["runtime"]["destructionPreparedItemIds"] = json!([]);
        self.persist()
    }
    pub fn done(&self, id: &str) -> bool {
        self.record["completedItemIds"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == id)
    }
    pub fn complete(&mut self, ids: &[String]) -> Result<()> {
        for id in ids {
            if !self.done(id) {
                self.record["completedItemIds"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!(id));
            }
        }
        self.persist()
    }
    pub fn finish(&mut self, phase: usize) -> Result<()> {
        let completed = self.record["completedPhases"].as_array_mut().unwrap();
        if completed.len() > phase {
            return Ok(());
        }
        if completed.len() != phase {
            return Err(invalid("Out of order phase completion"));
        }
        completed.push(json!(PHASES[phase]));
        self.record["remainingPhases"] = json!(&PHASES[phase + 1..]);
        self.persist()
    }
}
pub(super) fn original_entry(bytes: &[u8], key: &str) -> Result<Vec<u8>> {
    let parsed: Value = serde_json::from_slice(bytes)?;
    let repo = ["repos", "discoveredRepos", "discovered_repos"]
        .iter()
        .find_map(|map| parsed[*map].as_object())
        .and_then(|repos| repos.get(key))
        .ok_or_else(|| stale("Receipt original repository entry is missing"))?;
    // normalizeRepoConfig in retained config.ts establishes this property order.
    let mut fields = Vec::new();
    for name in [
        "path",
        "baseBranch",
        "copy",
        "symlink",
        "gitUrl",
        "groups",
        "hooks",
    ] {
        let value = if name == "gitUrl" {
            repo.get(name).or_else(|| repo.get("git_url"))
        } else {
            repo.get(name)
        };
        if let Some(value) = value {
            let normalized = if name == "groups" {
                json!(
                    value
                        .as_array()
                        .ok_or_else(|| stale("Invalid groups"))?
                        .iter()
                        .map(|item| item.as_str().unwrap_or("").trim())
                        .collect::<Vec<_>>()
                )
            } else {
                value.clone()
            };
            fields.push(format!(
                "{}:{}",
                quoted(name),
                serde_json::to_string(&normalized)?
            ));
        }
    }
    Ok(format!("{{{}}}", fields.join(",")).into_bytes())
}

#[cfg(test)]
mod tests {
    use super::capture;
    use std::fs;

    #[test]
    fn persisted_identity_includes_creation_incarnation() {
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!(
                "arashi-delete-receipt-identity-{}",
                std::process::id()
            ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir(&root).unwrap();

        let identity = capture(&root).unwrap();
        let value = identity["leaf"]["identity"].as_str().unwrap();
        let parts = value.split(':').collect::<Vec<_>>();
        assert_eq!(parts.len(), 4);
        assert_eq!(parts[0], "posix-v2");
        assert!(
            parts[1..]
                .iter()
                .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        );
        assert_ne!(parts[3], "0");

        fs::remove_dir(&root).unwrap();
    }
}
