//! Source-ordered durable deletion. All callers hold the shared workspace lock.
use super::receipt::{PHASES, Receipt};
use super::*;

fn stale(message: &str) -> Error {
    closed("DELETE_RECEIPT_STALE", message, 1)
}
fn parent(path: &Path) -> Result<&Path> {
    path.parent()
        .ok_or_else(|| stale("Delete path parent is unavailable"))
}
fn quarantine_collisions(expected: &Path, prefix: &str) -> Result<()> {
    let directory = parent(expected)?;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.path() != expected
            && entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(prefix))
        {
            return Err(closed(
                "DELETE_CONCURRENT_CHANGE",
                "Conflicting delete quarantine generation exists",
                1,
            ));
        }
    }
    Ok(())
}
#[cfg(test)]
fn test_pause(point: &str) -> Result<()> {
    if std::env::var("ARASHI_DELETE_RACE_POINT").as_deref() != Ok(point) {
        return Ok(());
    }
    let ready = PathBuf::from(std::env::var_os("ARASHI_DELETE_RACE_READY").unwrap());
    let resume = PathBuf::from(std::env::var_os("ARASHI_DELETE_RACE_RESUME").unwrap());
    fs::write(&ready, point)?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !resume.try_exists()? {
        if std::time::Instant::now() >= deadline {
            return Err(stale("Timed out waiting at delete race fixture"));
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    Ok(())
}
fn get_path(value: &Value, key: &str) -> Result<PathBuf> {
    value[key]
        .as_str()
        .map(PathBuf::from)
        .ok_or_else(|| stale("Missing runtime path"))
}
fn text_item_id(value: &Value) -> Result<String> {
    value["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| stale("Missing receipt item identifier"))
}
fn worktree_quarantine(runtime: &Value, path: &Path) -> Result<PathBuf> {
    runtime["worktreeQuarantines"]
        .as_array()
        .and_then(|items| items.iter().find(|item| item["path"] == json!(path)))
        .ok_or_else(|| stale("Missing linked quarantine provenance"))
        .and_then(|item| get_path(item, "quarantinePath"))
}
fn absent(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.into()),
    }
}
fn config_bytes(receipt: &Receipt) -> Result<(Vec<u8>, Vec<u8>)> {
    let runtime = &receipt.record["runtime"];
    Ok((
        receipt::unbase64(runtime["expectedConfigBase64"].as_str().unwrap())?,
        receipt::unbase64(runtime["nextConfigBase64"].as_str().unwrap())?,
    ))
}
fn validate_runtime(receipt: &Receipt, workspace: &Workspace) -> Result<()> {
    receipt.check()?;
    let runtime = &receipt.record["runtime"];
    let root = get_path(runtime, "workspaceRoot")?;
    let config_path = get_path(runtime, "configPath")?;
    let clone_path = get_path(runtime, "clonePath")?;
    let quarantine_path = get_path(runtime, "quarantinePath")?;
    if root != workspace.root || config_path != root.join(".arashi/config.json") {
        return Err(stale(
            "Receipt workspace/config path does not match invocation",
        ));
    }
    no_symlink_below(&root, &config_path)?;
    let (before, after) = config_bytes(receipt)?;
    let key = receipt.record["repositoryKey"]
        .as_str()
        .ok_or_else(|| stale("Missing repository key"))?;
    quarantine_collisions(&quarantine_path, &quarantine_prefix(key))?;
    if receipt::hash(&before) != receipt.record["configDigest"]
        || receipt::hash(&receipt::original_entry(&before, key)?)
            != receipt.record["originalEntryDigest"]
    {
        return Err(stale("Receipt configuration digests disagree"));
    }
    let config = crate::config::Config::parse(
        std::str::from_utf8(&before).map_err(|_| stale("Receipt config is not UTF-8"))?,
    )?;
    let repo = config
        .repos
        .get(key)
        .ok_or_else(|| stale("Receipt repository is not configured"))?;
    unsupported_selected_policy(repo)?;
    if root.join(relative(&repo.path)?) != clone_path
        || clone_path.parent() != Some(root.join(relative(&config.repos_dir)?).as_path())
    {
        return Err(stale(
            "Receipt clone path is not the selected configured path",
        ));
    }
    if serialize_without_repository(&before, key)? != after {
        return Err(stale(
            "Receipt next configuration is not the exact selected-entry removal",
        ));
    }
    for (other_key, other) in &config.repos {
        if other_key == key {
            continue;
        }
        let other = root.join(relative(&other.path)?);
        if other.starts_with(&clone_path) || clone_path.starts_with(&other) {
            return Err(stale("Receipt clone overlaps another repository"));
        }
    }
    let current = fs::read(&config_path)?;
    if current != before && current != after {
        return Err(closed(
            "DELETE_CONCURRENT_CHANGE",
            "Configuration changed after planning",
            1,
        ));
    }
    let topology = &runtime["topology"];
    if topology["primaryPath"] != json!(clone_path)
        || topology["commonDirectory"] != json!(clone_path.join(".git"))
        || topology["configuredActivePath"] != json!(clone_path)
    {
        return Err(stale("Receipt topology is not canonical"));
    }
    if !runtime["hookPaths"].as_array().unwrap().is_empty()
        || !runtime["identities"]["metadata"]
            .as_array()
            .unwrap()
            .is_empty()
        || !topology["staleMetadata"].as_array().unwrap().is_empty()
    {
        return Err(unsupported(
            "Receipt includes hook or stale metadata policies not yet ported; no changes made",
        ));
    }
    let clone_absent = absent(&clone_path)?;
    receipt::validate_identity(&runtime["identities"]["clone"], clone_absent)?;
    let items = receipt.record["identities"].as_array().unwrap();
    let clone_ids = items
        .iter()
        .filter(|item| matches!(item["kind"].as_str(), Some("canonical-clone" | "local-ref")))
        .map(text_item_id)
        .collect::<Result<Vec<_>>>()?;
    let clone_done = clone_ids.iter().all(|id| receipt.done(id));
    let clone_prepared = !clone_ids.is_empty() && clone_ids.iter().all(|id| receipt.prepared(id));
    let quarantine_absent = absent(&quarantine_path)?;
    if clone_prepared && !clone_absent {
        return Err(stale("Prepared canonical source was recreated"));
    }
    if clone_absent && !clone_done && !clone_prepared {
        if quarantine_absent {
            return Err(stale(
                "Canonical clone is absent without verified quarantine provenance",
            ));
        }
        let moved = receipt::capture(&quarantine_path)?;
        if moved["leaf"]["identity"] != runtime["identities"]["clone"]["leaf"]["identity"] {
            return Err(stale("Quarantined clone identity changed"));
        }
    }
    if clone_prepared && !quarantine_absent {
        let moved = receipt::capture(&quarantine_path)?;
        if moved["leaf"]["identity"] != runtime["identities"]["clone"]["leaf"]["identity"] {
            return Err(stale("Prepared clone quarantine identity changed"));
        }
    }
    if clone_done && !quarantine_absent {
        return Err(stale("Completed clone remains in quarantine"));
    }
    if clone_done && !clone_absent {
        return Err(stale("Completed clone deletion was recreated"));
    }
    if current == after && (!clone_absent || !clone_done) {
        return Err(stale(
            "Configuration advanced before clone deletion provenance",
        ));
    }
    let mut recovery_pending = false;
    for identity in runtime["identities"]["worktrees"].as_array().unwrap() {
        let path = get_path(identity, "path")?;
        let quarantine = worktree_quarantine(runtime, &path)?;
        let encoded = path
            .to_str()
            .ok_or_else(|| stale("Non-UTF-8 worktree path"))?;
        quarantine_collisions(
            &quarantine,
            &format!(
                ".arashi-delete-worktree-{}-",
                receipt::hash(encoded.as_bytes())
            ),
        )?;
        if clone_path.starts_with(&path)
            || path.starts_with(&clone_path)
            || root.starts_with(&path)
            || config_path.starts_with(&path)
            || receipt.path.starts_with(&path)
        {
            return Err(stale(
                "Receipt linked worktree overlaps workspace authority",
            ));
        }
        for (other_key, other) in &config.repos {
            if other_key == key {
                continue;
            }
            let other = root.join(relative(&other.path)?);
            if other.starts_with(&path) || path.starts_with(&other) {
                return Err(stale("Receipt linked worktree overlaps another repository"));
            }
        }
        let missing = absent(&path)?;
        receipt::validate_identity(identity, missing)?;
        let item = items
            .iter()
            .find(|item| item["kind"] == "linked-worktree" && item["path"] == json!(path))
            .ok_or_else(|| stale("Missing linked receipt item"))?;
        let done = receipt.done(item["id"].as_str().unwrap());
        let prepared = receipt.prepared(item["id"].as_str().unwrap());
        let quarantine_missing = absent(&quarantine)?;
        if prepared && !missing {
            return Err(stale("Prepared linked checkout was recreated"));
        }
        if (done || clone_absent) && !missing {
            return Err(stale("Completed linked checkout reappeared"));
        }
        if missing && !done && !prepared && !clone_absent {
            if quarantine_missing {
                return Err(stale(
                    "Linked checkout is absent without verified quarantine provenance",
                ));
            }
            let moved = receipt::capture(&quarantine)?;
            if moved["leaf"]["identity"] != identity["leaf"]["identity"] {
                return Err(stale("Quarantined linked checkout identity changed"));
            }
            recovery_pending = true;
        } else if prepared && !quarantine_missing {
            let moved = receipt::capture(&quarantine)?;
            if moved["leaf"]["identity"] != identity["leaf"]["identity"] {
                return Err(stale("Prepared linked quarantine identity changed"));
            }
        } else if !prepared && !quarantine_missing {
            return Err(stale("Unexpected linked checkout quarantine remains"));
        }
    }
    if !clone_absent && !recovery_pending {
        let current = DeletePlan::build(workspace, key)?;
        // Compare the accepted receipt, not a newly authorized plan. Only proven
        // completed/absent worktrees may disappear from topology and loss evidence.
        let changed = || {
            closed(
                "DELETE_CONCURRENT_CHANGE",
                "Accepted Git topology or loss evidence changed",
                1,
            )
        };
        let mut expected_linked = Vec::new();
        let mut removed_paths = Vec::new();
        for old in topology["linkedWorktrees"].as_array().unwrap() {
            let path = get_path(old, "path")?;
            let item = items
                .iter()
                .find(|item| item["kind"] == "linked-worktree" && item["path"] == old["path"])
                .ok_or_else(|| stale("Missing linked topology item"))?;
            if receipt.done(item["id"].as_str().unwrap()) || absent(&path)? {
                removed_paths.push(path);
            } else {
                expected_linked.push(old);
            }
        }
        if expected_linked.len() != current.linked.len() {
            return Err(changed());
        }
        for checkout in &current.linked {
            let observed = json!({"path":checkout.path,"head":checkout.head,"branch":format!("refs/heads/{}",checkout.branch),"detached":false,"bare":false,"locked":null,"prunable":null,"metadataPath":checkout.admin,"present":true});
            if !expected_linked.iter().any(|old| **old == observed) {
                return Err(changed());
            }
        }
        let expected_warnings = receipt.record["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|warning| warning.as_str().unwrap())
            .filter(|warning| {
                !removed_paths.iter().any(|path| {
                    warning.starts_with(&format!("DELETE_GIT_DATA_LOSS: {}:", path.display()))
                })
            })
            .collect::<Vec<_>>();
        if current.warnings != expected_warnings {
            return Err(changed());
        }
        let old_refs = items
            .iter()
            .filter(|item| item["kind"] == "local-ref")
            .map(|item| {
                (
                    item["ref"].as_str().unwrap_or(""),
                    item["oid"].as_str().unwrap_or(""),
                )
            })
            .collect::<std::collections::BTreeSet<_>>();
        let refs = current
            .local_refs
            .iter()
            .map(|item| (item.name.as_str(), item.oid.as_str()))
            .collect::<std::collections::BTreeSet<_>>();
        if refs != old_refs {
            return Err(changed());
        }
        let primary = topology["inventory"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["path"] == json!(clone_path))
            .ok_or_else(|| stale("Missing primary topology record"))?;
        if primary["head"] != current.checkout_head
            || primary["branch"]
                != json!(
                    current
                        .checkout_branch
                        .as_ref()
                        .map(|branch| format!("refs/heads/{branch}"))
                )
        {
            return Err(changed());
        }
    }
    Ok(())
}

pub(super) fn serialize_without_repository(before: &[u8], key: &str) -> Result<Vec<u8>> {
    let mut parsed: PersistedObject = serde_json::from_slice(before)?;
    for map in ["repos", "discoveredRepos", "discovered_repos"] {
        if let Some((_, PersistedValue::Object(repos))) =
            parsed.0.iter_mut().find(|(name, _)| name == map)
        {
            let count = repos.0.len();
            repos.0.retain(|(name, _)| name != key);
            if repos.0.len() == count {
                return Err(stale(
                    "Selected repository is absent from original receipt config",
                ));
            }
            let mut bytes = serde_json::to_vec_pretty(&parsed)?;
            bytes.push(b'\n');
            return Ok(bytes);
        }
    }
    Err(stale("No receipt repository map"))
}
fn publish(path: &Path, before: &[u8], after: &[u8]) -> Result<()> {
    no_symlink_below(parent(path)?, path)?;
    let identity = ObjectIdentity::path(path)?;
    if fs::read(path)? != before {
        return Err(closed(
            "DELETE_CONCURRENT_CHANGE",
            "Configuration changed before publication",
            1,
        ));
    }
    let mut staged = tempfile::NamedTempFile::new_in(parent(path)?)?;
    staged.write_all(after)?;
    staged
        .as_file()
        .set_permissions(fs::metadata(path)?.permissions())?;
    staged.as_file().sync_all()?;
    if !identity.matches(path) || fs::read(path)? != before {
        return Err(closed(
            "DELETE_CONCURRENT_CHANGE",
            "Configuration changed during publication",
            1,
        ));
    }
    let quarantine_dir = tempfile::Builder::new()
        .prefix(".config-publication-")
        .tempdir_in(parent(path)?)?
        .keep();
    let quarantine = quarantine_dir.join("expected-config");
    #[cfg(test)]
    test_pause("config-publish")?;
    receipt::rename_noreplace(path, &quarantine)?;
    if !identity.matches(&quarantine) || fs::read(&quarantine)? != before {
        if absent(path)? && receipt::rename_noreplace(&quarantine, path).is_ok() {
            let _ = fs::remove_dir(&quarantine_dir);
        }
        return Err(closed(
            "DELETE_CONCURRENT_CHANGE",
            "Configuration changed during publication",
            1,
        ));
    }
    if let Err(error) = receipt::rename_noreplace(staged.path(), path) {
        if absent(path)? {
            let _ = receipt::rename_noreplace(&quarantine, path);
        }
        return Err(error);
    }
    fs::File::open(parent(path)?)?.sync_all()?;
    if fs::read(path)? != after {
        return Err(closed(
            "DELETE_CONCURRENT_CHANGE",
            "Published configuration was replaced",
            1,
        ));
    }
    if identity.matches(&quarantine) {
        fs::remove_file(&quarantine)?;
        fs::remove_dir(&quarantine_dir)?;
    }
    Ok(())
}
fn remove_captured_directory(path: &Path, expected: &Value) -> Result<()> {
    let captured = receipt::capture(path)?;
    if captured["leaf"]["identity"] != expected["leaf"]["identity"] {
        return Err(stale("Quarantine generation changed before cleanup"));
    }
    fs::remove_dir_all(path)?;
    if !absent(path)? {
        return Err(stale("Quarantine remains after cleanup"));
    }
    Ok(())
}
fn move_captured_directory(source: &Path, destination: &Path, expected: &Value) -> Result<()> {
    receipt::rename_noreplace(source, destination)?;
    let captured = receipt::capture(destination)?;
    if captured["leaf"]["identity"] != expected["leaf"]["identity"] {
        if absent(source)? {
            let _ = receipt::rename_noreplace(destination, source);
        }
        return Err(stale(
            "Deletion source generation changed before quarantine",
        ));
    }
    Ok(())
}
fn result(receipt: &Receipt, active: Option<usize>, durable: bool, error: Option<&Error>) -> Value {
    let mut items = receipt.record["identities"].as_array().unwrap().clone();
    for item in &mut items {
        let done = receipt.done(item["id"].as_str().unwrap());
        item["ownership"] = json!("delete");
        item["planned"] = json!(true);
        item["completed"] = json!(done);
        item["state"] = json!(if done {
            "completed"
        } else if active == receipt::phase(item["kind"].as_str().unwrap()) {
            "failed"
        } else {
            "blocked"
        });
        item["reasonCode"] = if done {
            Value::Null
        } else {
            json!(
                error
                    .map(|e| e.code.as_str())
                    .unwrap_or("DELETE_BLOCKED_BY_PRIOR_FAILURE")
            )
        };
        item["message"] = Value::Null;
    }
    let completed = receipt.record["completedPhases"].as_array().unwrap().len();
    let phases = PHASES.iter().enumerate().map(|(index,name)| json!({"name":name,"state":if index < completed {"completed"}else if active==Some(index){"failed"}else{"pending"},"itemIds":items.iter().filter(|item| receipt::phase(item["kind"].as_str().unwrap())==Some(index)).map(|item|item["id"].clone()).collect::<Vec<_>>(),"error":if active==Some(index){error.map(|error|json!({"code":error.code,"message":error.message}))}else{None},"startedOrder":if index <= active.unwrap_or(6){Some(index*2+1)}else{None},"completedOrder":if index < completed{Some(index*2+2)}else{None}})).collect::<Vec<_>>();
    json!({"items":items,"phases":phases,"retry":{"safe":durable,"argv":if durable{receipt.record["retryArgv"].clone()}else{Value::Null},"guidance":if durable{"Retry the exact configured repository after reviewing surviving state."}else if error.is_some(){"Resume provenance is unavailable; inspect surviving state manually."}else{"Deletion completed; no retry is required."}},"warnings":receipt.record["warnings"]})
}
pub(super) fn execute(
    mut receipt: Receipt,
    workspace: &Workspace,
    accepted: Option<&DeletePlan>,
) -> Result<Value> {
    validate_runtime(&receipt, workspace)?;
    let runtime = receipt.record["runtime"].clone();
    let clone_path = get_path(&runtime, "clonePath")?;
    let quarantine_path = get_path(&runtime, "quarantinePath")?;
    let config_path = get_path(&runtime, "configPath")?;
    let (before, after) = config_bytes(&receipt)?;
    // A process can die after the ownership-preserving rename but before the
    // removal. Recover only the exact captured clone, never an occupied sibling.
    // Restore its canonical location so normal reciprocal Git/ref checks run
    // again before any resumed deletion. A partially destroyed Git repository
    // remains a visible recovery failure rather than a false successful delete.
    let clone_ids = receipt.record["identities"]
        .as_array()
        .ok_or_else(|| stale("Missing receipt identities"))?
        .iter()
        .filter(|item| matches!(item["kind"].as_str(), Some("canonical-clone" | "local-ref")))
        .map(text_item_id)
        .collect::<Result<Vec<_>>>()?;
    let clone_prepared = !clone_ids.is_empty() && clone_ids.iter().all(|id| receipt.prepared(id));
    if clone_prepared && absent(&clone_path)? && absent(&quarantine_path)? {
        receipt.complete_prepared(&clone_ids)?;
    }
    if !clone_prepared && absent(&clone_path)? && fs::read(&config_path)? == before {
        let quarantine = quarantine_path.clone();
        if !absent(&quarantine)?
            && let Ok(moved) = receipt::capture(&quarantine)
            && moved["leaf"]["identity"] == runtime["identities"]["clone"]["leaf"]["identity"]
        {
            if receipt.record["identities"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| {
                    item["kind"] == "canonical-clone" && receipt.done(item["id"].as_str().unwrap())
                })
            {
                return Err(stale("Completed clone remains in quarantine"));
            }
            receipt.check()?;
            receipt::validate_identity(&runtime["identities"]["clone"], true)?;
            move_captured_directory(&quarantine, &clone_path, &runtime["identities"]["clone"])?;
            fs::File::open(parent(&clone_path)?)?.sync_all()?;
            validate_runtime(&receipt, workspace)?;
        }
    }
    for identity in runtime["identities"]["worktrees"].as_array().unwrap() {
        let path = get_path(identity, "path")?;
        let quarantine = worktree_quarantine(&runtime, &path)?;
        let item = receipt.record["identities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["kind"] == "linked-worktree" && item["path"] == json!(path))
            .ok_or_else(|| stale("Missing linked receipt item"))?;
        let id = item["id"]
            .as_str()
            .ok_or_else(|| stale("Missing linked receipt item identifier"))?
            .to_owned();
        let prepared = receipt.prepared(&id);
        if prepared && absent(&path)? && absent(&quarantine)? {
            let metadata = runtime["topology"]["linkedWorktrees"]
                .as_array()
                .and_then(|items| items.iter().find(|value| value["path"] == json!(path)))
                .and_then(|value| value["metadataPath"].as_str())
                .map(PathBuf::from)
                .ok_or_else(|| stale("Missing linked administration provenance"))?;
            if !absent(&metadata)?
                || git::worktrees_readonly(&clone_path)?
                    .iter()
                    .any(|record| record.path == path || record.path == quarantine)
            {
                return Err(stale("Prepared linked destruction is not complete"));
            }
            receipt.complete_prepared(std::slice::from_ref(&id))?;
        } else if !prepared && absent(&path)? && !receipt.done(&id) {
            receipt.check()?;
            let moved = receipt::capture(&quarantine)?;
            if moved["leaf"]["identity"] != identity["leaf"]["identity"] {
                return Err(stale("Quarantined linked checkout identity changed"));
            }
            move_captured_directory(&quarantine, &path, identity)?;
            git::run(
                &clone_path,
                &[
                    "worktree",
                    "repair",
                    "--",
                    path.to_str()
                        .ok_or_else(|| stale("Non-UTF-8 worktree path"))?,
                ],
            )?;
            fs::File::open(parent(&path)?)?.sync_all()?;
        }
    }
    validate_runtime(&receipt, &Workspace::discover(&workspace.root)?)?;
    let mut active = 0usize;
    let mut irreversible_started = false;
    let mut durable = true;
    let operation = (|| -> Result<()> {
        for phase in 0..6 {
            active = phase;
            validate_runtime(&receipt, &Workspace::discover(&workspace.root)?)?;
            let phase_items = receipt.record["identities"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|item| receipt::phase(item["kind"].as_str().unwrap()) == Some(phase))
                .cloned()
                .collect::<Vec<_>>();
            let ids = phase_items
                .iter()
                .map(|item| item["id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>();
            match phase {
                0 => {
                    receipt.complete(&ids)?;
                }
                1 => {
                    for item in phase_items {
                        let id = text_item_id(&item)?;
                        let path = get_path(&item, "path")?;
                        if receipt.done(&id) {
                            continue;
                        }
                        let identity = runtime["identities"]["worktrees"]
                            .as_array()
                            .ok_or_else(|| stale("Missing worktree identities"))?
                            .iter()
                            .find(|identity| identity["path"] == json!(path))
                            .ok_or_else(|| stale("Missing worktree identity"))?;
                        let quarantine = worktree_quarantine(&runtime, &path)?;
                        if !receipt.prepared(&id) {
                            validate_runtime(&receipt, &Workspace::discover(&workspace.root)?)?;
                            receipt::validate_identity(identity, false)?;
                            let checkout = accepted.and_then(|plan| {
                                plan.linked.iter().find(|checkout| checkout.path == path)
                            });
                            if let Some(checkout) = checkout {
                                checkout.validate(&clone_path)?;
                            }
                            receipt.check()?;
                            #[cfg(test)]
                            test_pause("linked-remove")?;
                            if !absent(&quarantine)? {
                                return Err(closed(
                                    "DELETE_CONCURRENT_CHANGE",
                                    "Linked delete quarantine is occupied",
                                    1,
                                ));
                            }
                            move_captured_directory(&path, &quarantine, identity)?;
                            fs::File::open(parent(&path)?)?.sync_all()?;
                            #[cfg(test)]
                            test_pause("linked-remove-after-quarantine")?;
                            let prepared = (|| -> Result<()> {
                                if let Some(checkout) = checkout {
                                    checkout.validate_quarantine_before_repair(&quarantine)?;
                                }
                                git::run(
                                    &clone_path,
                                    &[
                                        "worktree",
                                        "repair",
                                        "--",
                                        quarantine.to_str().ok_or_else(|| {
                                            stale("Non-UTF-8 worktree quarantine path")
                                        })?,
                                    ],
                                )?;
                                if let Some(checkout) = checkout {
                                    checkout.validate_quarantine_after_repair(
                                        &clone_path,
                                        &quarantine,
                                    )?;
                                }
                                receipt.prepare(std::slice::from_ref(&id))
                            })();
                            if let Err(error) = prepared {
                                if absent(&path)? {
                                    move_captured_directory(&quarantine, &path, identity)?;
                                    let _ = git::run(
                                        &clone_path,
                                        &[
                                            "worktree",
                                            "repair",
                                            "--",
                                            path.to_str()
                                                .ok_or_else(|| stale("Non-UTF-8 worktree path"))?,
                                        ],
                                    );
                                    fs::File::open(parent(&path)?)?.sync_all()?;
                                }
                                return Err(error);
                            }
                            #[cfg(test)]
                            test_pause("linked-prepared")?;
                        }
                        irreversible_started = true;
                        durable = true;
                        git::run(
                            &clone_path,
                            &[
                                "worktree",
                                "remove",
                                "--force",
                                "--",
                                quarantine
                                    .to_str()
                                    .ok_or_else(|| stale("Non-UTF-8 worktree quarantine path"))?,
                            ],
                        )?;
                        if !absent(&path)? || !absent(&quarantine)? {
                            return Err(stale("Linked destruction paths remain"));
                        }
                        let admin = accepted
                            .and_then(|plan| {
                                plan.linked.iter().find(|checkout| checkout.path == path)
                            })
                            .map(|checkout| checkout.admin.clone())
                            .or_else(|| {
                                runtime["topology"]["linkedWorktrees"]
                                    .as_array()?
                                    .iter()
                                    .find(|value| value["path"] == json!(path))?["metadataPath"]
                                    .as_str()
                                    .map(PathBuf::from)
                            })
                            .ok_or_else(|| stale("Missing linked administration provenance"))?;
                        if !absent(&admin)?
                            || git::worktrees_readonly(&clone_path)?
                                .iter()
                                .any(|record| record.path == path || record.path == quarantine)
                        {
                            return Err(stale("Linked administration remains after destruction"));
                        }
                        fs::File::open(parent(&path)?)?.sync_all()?;
                        #[cfg(test)]
                        test_pause("linked-after-destruction")?;
                        receipt.complete_prepared(std::slice::from_ref(&id))?;
                        durable = true;
                    }
                }
                3 => {
                    if !ids.iter().all(|id| receipt.done(id)) {
                        let quarantine = quarantine_path.clone();
                        if !ids.iter().all(|id| receipt.prepared(id)) {
                            receipt::validate_identity(&runtime["identities"]["clone"], false)?;
                            if !absent(&quarantine)? {
                                return Err(closed(
                                    "DELETE_CONCURRENT_CHANGE",
                                    "Delete quarantine is occupied",
                                    1,
                                ));
                            }
                            if let Some(plan) = accepted {
                                plan.validate_ancestors()?;
                                if content_inventory(&clone_path)? != plan.contents {
                                    return Err(closed(
                                        "DELETE_CONCURRENT_CHANGE",
                                        "Accepted clone contents changed",
                                        1,
                                    ));
                                }
                            }
                            receipt.check()?;
                            #[cfg(test)]
                            test_pause("clone-rename")?;
                            move_captured_directory(
                                &clone_path,
                                &quarantine,
                                &runtime["identities"]["clone"],
                            )?;
                            fs::File::open(parent(&clone_path)?)?.sync_all()?;
                            receipt::validate_identity(&runtime["identities"]["clone"], true)?;
                            if let Some(plan) = accepted {
                                plan.validate_quarantine(&quarantine, &before)?;
                            } else {
                                let moved = receipt::capture(&quarantine)?;
                                if moved["leaf"]["identity"]
                                    != runtime["identities"]["clone"]["leaf"]["identity"]
                                {
                                    return Err(stale("Quarantined clone identity changed"));
                                }
                            }
                            receipt.prepare(&ids)?;
                            #[cfg(test)]
                            test_pause("clone-prepared")?;
                        }
                        irreversible_started = true;
                        durable = true;
                        #[cfg(test)]
                        test_pause("clone-cleanup")?;
                        remove_captured_directory(&quarantine, &runtime["identities"]["clone"])?;
                        fs::File::open(parent(&clone_path)?)?.sync_all()?;
                        receipt::validate_identity(&runtime["identities"]["clone"], true)?;
                        if !absent(&quarantine)? {
                            return Err(stale("Canonical quarantine remains after destruction"));
                        }
                        #[cfg(test)]
                        test_pause("clone-after-destruction")?;
                        receipt.complete_prepared(&ids)?;
                        durable = true;
                    }
                }
                5 => {
                    if !ids.iter().all(|id| receipt.done(id)) {
                        receipt.check()?;
                        durable = false;
                        if fs::read(&config_path)? != after {
                            irreversible_started = true;
                            publish(&config_path, &before, &after)?;
                        }
                        receipt.complete(&ids)?;
                        durable = true;
                    } else if fs::read(&config_path)? != after {
                        return Err(stale("Completed configuration removal could not be proven"));
                    }
                }
                _ => {
                    if !ids.is_empty() {
                        return Err(unsupported("Receipt phase has unported policy items"));
                    }
                }
            }
            receipt.finish(phase)?;
        }
        active = 6;
        validate_runtime(&receipt, &Workspace::discover(&workspace.root)?)?;
        Ok(())
    })();
    match operation {
        Ok(()) => {
            receipt.finish(6)?;
            let output = result(&receipt, None, false, None);
            receipt.remove()?;
            Ok(output)
        }
        Err(error) => {
            // Source marks provenance unsafe while an operation may have partially
            // mutated state; a validated on-disk file alone is not safe retry proof.
            durable = durable && receipt.check().is_ok();
            let output = result(&receipt, Some(active), durable, Some(&error));
            Err(classify_execution_failure(
                error,
                irreversible_started,
                PHASES[active],
                output,
                receipt.record["repositoryKey"].as_str().unwrap(),
            ))
        }
    }
}

pub(super) fn classify_execution_failure(
    error: Error,
    irreversible_started: bool,
    phase: &str,
    output: Value,
    repository_key: &str,
) -> Error {
    if !irreversible_started {
        return error;
    }
    closed(
        "DELETE_PARTIAL_FAILURE",
        format!("Delete phase {phase} failed: {}", error.message),
        1,
    )
    .with_details(json!({"result":output,"repositoryKey":repository_key}))
}
pub(super) fn preview(
    receipt: &Receipt,
    workspace: &Workspace,
    force: bool,
    dry_run: bool,
) -> Result<Value> {
    validate_runtime(receipt, workspace)?;
    Ok(
        json!({"workspace":workspace.metadata(),"repositoryKey":receipt.record["repositoryKey"],"dryRun":dry_run,"force":force,"confirmation":if dry_run||force{"not-required"}else{"required"},"plan":{"id":receipt.record["planId"],"items":receipt.record["identities"],"warnings":receipt.record["warnings"]},"result":null}),
    )
}
