//! Source repository filter normalization, ordering, and usage errors.
use crate::{Error, Result, cli::Args, config::Config};
use serde_json::{Value, json};
fn normalize(args: &Args, key: &str) -> Vec<String> {
    let mut values = Vec::new();
    for value in args
        .options
        .get(key)
        .into_iter()
        .flatten()
        .flat_map(|s| s.split(','))
    {
        let value = value.trim().to_owned();
        if !value.is_empty() && !values.contains(&value) {
            values.push(value);
        }
    }
    values
}
pub fn select(config: &Config, args: &Args) -> Result<(Vec<String>, Value)> {
    let only = normalize(args, "only");
    let groups = normalize(args, "group");
    let filters = json!({"only":only,"groups":groups});
    let fail = |code: &str, message: String, details: Value| {
        Error::new(code, message)
            .with_details(details)
            .with_exit_code(2)
    };
    let empty: Vec<_> = [("only", &only), ("group", &groups)]
        .into_iter()
        .filter(|(key, v)| args.has(key) && v.is_empty())
        .map(|(key, _)| key)
        .collect();
    if !empty.is_empty() {
        return Err(fail(
            "EMPTY_REPOSITORY_FILTERS",
            format!(
                "Explicitly empty repository {}: {}",
                if empty.len() == 1 {
                    "filter"
                } else {
                    "filters"
                },
                empty
                    .iter()
                    .map(|s| format!("--{s}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            json!({"emptyFilters":empty}),
        ));
    }
    let missing: Vec<_> = only
        .iter()
        .filter(|n| !config.repos.contains_key(*n))
        .cloned()
        .collect();
    if !missing.is_empty() {
        return Err(fail(
            "UNKNOWN_REPOSITORIES",
            format!(
                "Unknown repositories in --only filter: {}",
                missing.join(", ")
            ),
            json!({"repositories":only,"unknownRepositories":missing}),
        ));
    }
    let matches = |name: &str, group: &str| {
        config.repos[name].raw["groups"]
            .as_array()
            .is_some_and(|gs| {
                gs.iter().any(|g| {
                    g.as_str()
                        .is_some_and(|g| g.to_lowercase() == group.to_lowercase())
                })
            })
    };
    let unknown: Vec<_> = groups
        .iter()
        .filter(|g| !config.repo_order.iter().any(|n| matches(n, g)))
        .cloned()
        .collect();
    if !unknown.is_empty() {
        return Err(fail(
            "UNKNOWN_REPOSITORY_GROUPS",
            format!(
                "Unknown repository groups in --group filter: {}",
                unknown.join(", ")
            ),
            json!({"groups":groups,"unknownGroups":unknown}),
        ));
    }
    let selected: Vec<_> = if only.is_empty() {
        &config.repo_order
    } else {
        &only
    }
    .iter()
    .filter(|n| groups.is_empty() || groups.iter().any(|g| matches(n, g)))
    .cloned()
    .collect();
    if selected.is_empty() && (!only.is_empty() || !groups.is_empty()) {
        return Err(fail(
            "EMPTY_REPOSITORY_SELECTION",
            "No repositories matched the combined --only/--group filters".into(),
            json!({"filters":filters}),
        ));
    }
    Ok((selected, filters))
}
