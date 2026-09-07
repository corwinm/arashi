//! Source-ordered durable deletion. All callers hold the shared workspace lock.
use super::receipt::{PHASES, Receipt};
use super::*;

fn stale(message: &str) -> Error {
    closed("DELETE_RECEIPT_STALE", message, 1)
}
fn get_path(value: &Value, key: &str) -> Result<PathBuf> {
    value[key]
        .as_str()
        .map(PathBuf::from)
        .ok_or_else(|| stale("Missing runtime path"))
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
    if root != workspace.root || config_path != root.join(".arashi/config.json") {
        return Err(stale(
            "Receipt workspace/config path does not match invocation",
        ));
    }
    no_symlink_below(&root, &config_path)?;
    let (before, after) = config_bytes(receipt)?;
    let key = receipt.record["repositoryKey"].as_str().unwrap();
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
    let clone_done = items
        .iter()
        .filter(|item| item["kind"] == "canonical-clone")
        .all(|item| receipt.done(item["id"].as_str().unwrap()));
    if clone_done && !clone_absent {
        return Err(stale("Completed clone deletion was recreated"));
    }
    if current == after && (!clone_absent || !clone_done) {
        return Err(stale(
            "Configuration advanced before clone deletion provenance",
        ));
    }
    for identity in runtime["identities"]["worktrees"].as_array().unwrap() {
        let path = get_path(identity, "path")?;
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
        if (receipt.done(item["id"].as_str().unwrap()) || clone_absent) && !missing {
            return Err(stale("Completed linked checkout reappeared"));
        }
    }
    if !clone_absent {
        let current = DeletePlan::build(workspace, key)?;
        // On an explicit retry, inspect surviving content again, but never adopt a
        // replacement identity, new ref, new worktree or changed checkout OID.
        for checkout in &current.linked {
            if !runtime["identities"]["worktrees"]
                .as_array()
                .unwrap()
                .iter()
                .any(|identity| identity["path"] == json!(checkout.path))
            {
                return Err(stale("New linked ownership appeared during delete"));
            }
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
            return Err(stale("Repository ref evidence changed during delete"));
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
            return Err(stale("Primary checkout evidence changed during delete"));
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
    no_symlink_below(path.parent().unwrap(), path)?;
    let identity = ObjectIdentity::path(path)?;
    if fs::read(path)? != before {
        return Err(closed(
            "DELETE_CONCURRENT_CHANGE",
            "Configuration changed before publication",
            1,
        ));
    }
    let mut staged = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
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
    fs::rename(staged.path(), path)?;
    fs::File::open(path.parent().unwrap())?.sync_all()?;
    if fs::read(path)? != after {
        return Err(closed(
            "DELETE_CONCURRENT_CHANGE",
            "Published configuration was replaced",
            1,
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
    let config_path = get_path(&runtime, "configPath")?;
    let (before, after) = config_bytes(&receipt)?;
    // A process can die after the ownership-preserving rename but before the
    // removal. Recover only the exact captured clone, never an occupied sibling.
    // Restore its canonical location so normal reciprocal Git/ref checks run
    // again before any resumed deletion. A partially destroyed Git repository
    // remains a visible recovery failure rather than a false successful delete.
    if absent(&clone_path)? && fs::read(&config_path)? == before {
        let quarantine = clone_path.parent().unwrap().join(quarantine_name(
            receipt.record["repositoryKey"].as_str().unwrap(),
        ));
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
            fs::rename(&quarantine, &clone_path)?;
            fs::File::open(clone_path.parent().unwrap())?.sync_all()?;
            validate_runtime(&receipt, workspace)?;
        }
    }
    let mut active = 0usize;
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
                        let id = item["id"].as_str().unwrap().to_owned();
                        let path = get_path(&item, "path")?;
                        if receipt.done(&id) {
                            continue;
                        }
                        let identity = runtime["identities"]["worktrees"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|identity| identity["path"] == json!(path))
                            .unwrap();
                        if !absent(&path)? {
                            receipt::validate_identity(identity, false)?;
                            if let Some(accepted) = accepted {
                                accepted
                                    .linked
                                    .iter()
                                    .find(|checkout| checkout.path == path)
                                    .ok_or_else(|| stale("Unaccepted linked path"))?
                                    .validate(&clone_path)?;
                            }
                            receipt.check()?;
                            durable = false;
                            git::run(
                                &clone_path,
                                &[
                                    "worktree",
                                    "remove",
                                    "--force",
                                    "--",
                                    path.to_str()
                                        .ok_or_else(|| stale("Non-UTF-8 worktree path"))?,
                                ],
                            )?;
                        }
                        receipt::validate_identity(identity, true)?;
                        receipt.complete(&[id])?;
                        durable = true;
                    }
                }
                3 => {
                    if !ids.iter().all(|id| receipt.done(id)) {
                        if !absent(&clone_path)? {
                            receipt::validate_identity(&runtime["identities"]["clone"], false)?;
                            let quarantine = clone_path.parent().unwrap().join(quarantine_name(
                                receipt.record["repositoryKey"].as_str().unwrap(),
                            ));
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
                            durable = false;
                            fs::rename(&clone_path, &quarantine)?;
                            let remove = (|| -> Result<()> {
                                // The original parent chain must still be owned after rename.
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
                                receipt.check()?;
                                fs::remove_dir_all(&quarantine)?;
                                fs::File::open(clone_path.parent().unwrap())?.sync_all()?;
                                Ok(())
                            })();
                            if let Err(error) = remove {
                                if absent(&clone_path)?
                                    && receipt::validate_identity(
                                        &runtime["identities"]["clone"],
                                        true,
                                    )
                                    .is_ok()
                                    && let Ok(moved) = receipt::capture(&quarantine)
                                    && moved["leaf"]["identity"]
                                        == runtime["identities"]["clone"]["leaf"]["identity"]
                                {
                                    let _ = fs::rename(&quarantine, &clone_path);
                                }
                                return Err(error);
                            }
                        }
                        receipt::validate_identity(&runtime["identities"]["clone"], true)?;
                        receipt.complete(&ids)?;
                        durable = true;
                    }
                }
                5 => {
                    if !ids.iter().all(|id| receipt.done(id)) {
                        receipt.check()?;
                        durable = false;
                        if fs::read(&config_path)? != after {
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
            Err(closed(
                "DELETE_PARTIAL_FAILURE",
                format!("Delete phase {} failed: {}", PHASES[active], error.message),
                1,
            )
            .with_details(json!({"result":output,"repositoryKey":receipt.record["repositoryKey"]})))
        }
    }
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
