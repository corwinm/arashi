//! Non-mutating handoff reports built from the native status snapshot.
use crate::{Result, cli::Args, config::Workspace};
use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};
use serde_json::{Value, json};
use std::path::Path;

pub fn handoff(workspace: &Workspace, cwd: &Path, args: &Args) -> Result<Value> {
    let status = crate::status::status(workspace, cwd)?;
    Ok(build(&status, cwd, args))
}

fn build(status: &Value, cwd: &Path, args: &Args) -> Value {
    let standalone = status["mode"] == "standalone";
    let rows = status[if standalone {
        "worktrees"
    } else {
        "repositories"
    }]
    .as_array()
    .cloned()
    .unwrap_or_default();
    let repositories: Vec<Value> = rows.iter().map(summarize_repository).collect();
    let touched = repositories
        .iter()
        .filter(|row| row["state"] != "clean")
        .count();
    let selected = if standalone {
        let caller = crate::paths::canonicalize(cwd).ok();
        rows.iter()
            .find(|row| {
                caller.as_ref().is_some_and(|caller| {
                    row["path"]
                        .as_str()
                        .is_some_and(|path| Path::new(path) == caller)
                })
            })
            .or_else(|| rows.first())
    } else {
        current_repository(cwd, &rows)
    };
    let workspace_branch = if standalone {
        selected
            .and_then(|row| row["branch"]["localBranch"].as_str())
            .filter(|branch| !branch.is_empty())
            .unwrap_or("unknown")
    } else {
        rows.iter()
            .find(|row| row["name"] == "Main Repository")
            .and_then(|row| row["branch"]["localBranch"].as_str())
            .filter(|branch| !branch.is_empty())
            .unwrap_or("unknown")
    };
    let workspace_root = status["workspaceRoot"].clone();
    let current = selected.map_or(Value::Null, |row| {
        let path = row["path"]
            .as_str()
            .and_then(|path| crate::paths::canonicalize(path).ok())
            .map_or_else(|| row["path"].clone(), |path| json!(path));
        json!({"name":row["name"],"path":path})
    });
    let mut data = json!({
        "context": {
            "links": values(args, "link"),
            "nextCommands": values(args, "next-command"),
            "risks": values(args, "risk"),
            "todos": values(args, "todo"),
            "validations": values(args, "validation")
        },
        "currentRepository": current,
        "effectiveOptions": {"format":if args.has("json") {"json"} else {"markdown"}},
        "generatedNextCommands": generated_commands(&repositories),
        "mode": status["mode"],
        "repositories": repositories,
        "summary": {
            "cleanCount":status["summary"]["cleanCount"],
            "dirtyCount":status["summary"]["dirtyCount"],
            "total":status["summary"]["total"],
            "touchedCount":touched
        },
        "workspace":{"branch":workspace_branch,"path":workspace_root},
        "workspaceRoot":workspace_root,
        "worktreesBase":status["worktreesBase"]
    });
    if standalone {
        data["callerWorktree"] = json!(cwd);
        data["repositoryPath"] = status["repositoryPath"].clone();
    }
    data
}

fn values(args: &Args, key: &str) -> Vec<String> {
    args.options.get(key).cloned().unwrap_or_default()
}

fn summarize_repository(row: &Value) -> Value {
    let mut summary = row.clone();
    if let Some(path) = row["path"].as_str()
        && let Ok(path) = crate::paths::canonicalize(path)
    {
        summary["path"] = json!(path);
    }
    let count = row["files"].as_array().map_or(0, Vec::len);
    summary["changeCount"] = json!(count);
    summary["state"] = json!(if !row["error"].is_null() {
        "error"
    } else if count > 0 {
        "dirty"
    } else {
        "clean"
    });
    summary
}

fn current_repository<'a>(cwd: &Path, rows: &'a [Value]) -> Option<&'a Value> {
    let cwd = crate::paths::canonicalize(cwd).ok()?;
    rows.iter()
        .filter(|row| {
            row["path"]
                .as_str()
                .is_some_and(|path| cwd.starts_with(Path::new(path)))
        })
        .max_by_key(|row| row["path"].as_str().map_or(0, str::len))
}

fn generated_commands(rows: &[Value]) -> Vec<&'static str> {
    let mut commands = vec!["arashi status"];
    if rows.iter().any(needs_verbose_status) {
        commands.push("arashi status --verbose");
    }
    commands
}

fn needs_verbose_status(row: &Value) -> bool {
    !row["error"].is_null()
        || row["files"]
            .as_array()
            .is_some_and(|files| !files.is_empty())
        || row["branch"]["ahead"].as_u64().unwrap_or(0) > 0
        || row["branch"]["behind"].as_u64().unwrap_or(0) > 0
        || comparison_needs_attention(&row["baseBranch"])
        || comparison_needs_attention(&row["defaultBranch"])
        || !row["refreshWarning"].is_null()
}

fn comparison_needs_attention(comparison: &Value) -> bool {
    comparison["state"] == "unavailable"
        || (comparison["state"] == "available" && comparison["behind"].as_u64().unwrap_or(0) > 0)
}

struct OrderedComparison<'a>(&'a Value);

impl Serialize for OrderedComparison<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if self.0.is_null() {
            return serializer.serialize_none();
        }
        let mut map = serializer.serialize_map(None)?;
        let keys: &[&str] = match self.0["state"].as_str() {
            Some("available") => &[
                "ahead",
                "behind",
                "branch",
                "compareRef",
                "remote",
                "remoteRef",
                "state",
            ],
            Some("unavailable") if self.0["reason"] == "unresolved-target" => &[
                "branch",
                "compareRef",
                "details",
                "message",
                "reason",
                "remote",
                "remoteRef",
                "state",
            ],
            Some("unavailable") => &[
                "branch",
                "compareRef",
                "remote",
                "remoteRef",
                "details",
                "message",
                "reason",
                "state",
            ],
            _ => &[
                "branch",
                "compareRef",
                "remote",
                "remoteRef",
                "reason",
                "state",
            ],
        };
        for key in keys {
            if let Some(value) = self.0.get(key) {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}

struct OrderedRepository<'a>(&'a Value);

impl Serialize for OrderedRepository<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("baseBranch", &OrderedComparison(&self.0["baseBranch"]))?;
        if let Some(value) = self.0.get("baseBranchSource") {
            map.serialize_entry("baseBranchSource", value)?;
        }
        map.serialize_entry("branch", &self.0["branch"])?;
        map.serialize_entry("changeCount", &self.0["changeCount"])?;
        map.serialize_entry(
            "defaultBranch",
            &OrderedComparison(&self.0["defaultBranch"]),
        )?;
        for key in ["error", "files", "name", "path", "refreshWarning", "state"] {
            map.serialize_entry(key, &self.0[key])?;
        }
        map.end()
    }
}

struct OrderedRepositories<'a>(&'a [Value]);

impl Serialize for OrderedRepositories<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for repository in self.0 {
            sequence.serialize_element(&OrderedRepository(repository))?;
        }
        sequence.end()
    }
}

struct OrderedHandoffData<'a>(&'a Value);

impl Serialize for OrderedHandoffData<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(None)?;
        for key in [
            "context",
            "currentRepository",
            "effectiveOptions",
            "generatedNextCommands",
            "mode",
        ] {
            map.serialize_entry(key, &self.0[key])?;
        }
        let repositories = self.0["repositories"]
            .as_array()
            .map_or(&[][..], Vec::as_slice);
        map.serialize_entry("repositories", &OrderedRepositories(repositories))?;
        for key in ["summary", "workspace", "workspaceRoot"] {
            map.serialize_entry(key, &self.0[key])?;
        }
        if self.0["mode"] == "standalone" {
            map.serialize_entry("callerWorktree", &self.0["callerWorktree"])?;
            map.serialize_entry("repositoryPath", &self.0["repositoryPath"])?;
        }
        map.serialize_entry("worktreesBase", &self.0["worktreesBase"])?;
        map.end()
    }
}

struct HandoffEnvelope<'a> {
    data: &'a Value,
    warnings: &'a [Value],
}

impl Serialize for HandoffEnvelope<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(5))?;
        map.serialize_entry("command", "handoff")?;
        map.serialize_entry("data", &OrderedHandoffData(self.data))?;
        map.serialize_entry("ok", &true)?;
        map.serialize_entry("schemaVersion", &1)?;
        map.serialize_entry("warnings", self.warnings)?;
        map.end()
    }
}

pub fn render_json(data: &Value, warnings: &[Value]) -> String {
    serde_json::to_string_pretty(&HandoffEnvelope { data, warnings })
        .expect("handoff values serialize as JSON")
}

pub fn render_markdown(data: &Value) -> String {
    let repositories = data["repositories"].as_array().unwrap();
    let repository_lines = repositories
        .iter()
        .map(repository_line)
        .collect::<Vec<_>>()
        .join("\n");
    let touched = repositories
        .iter()
        .filter(|row| row["state"] != "clean")
        .map(repository_line)
        .collect::<Vec<_>>();
    let touched_lines = if touched.is_empty() {
        "- All managed repositories are clean.\n".to_owned()
    } else {
        format!("{}\n", touched.join("\n"))
    };
    let context = &data["context"];
    let user_commands = strings(&context["nextCommands"]);
    let mut commands = user_commands.clone();
    commands.extend(
        strings(&data["generatedNextCommands"])
            .into_iter()
            .filter(|command| !user_commands.contains(command)),
    );
    let command_block = if commands.is_empty() {
        "- No next commands suggested.\n".to_owned()
    } else {
        format!(
            "{}\n",
            commands
                .iter()
                .map(|command| format!("`{command}`"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    let current = if data["currentRepository"].is_null() {
        "not resolved".to_owned()
    } else {
        format!(
            "{} ({})",
            text(&data["currentRepository"]["name"]),
            text(&data["currentRepository"]["path"])
        )
    };
    let caller = data["callerWorktree"].as_str().unwrap_or("not applicable");

    format!(
        "# Arashi Handoff Report\n\n## Workspace\n\n- Workspace mode: {}\n- Path: {}\n- Branch: {}\n- Caller worktree: {}\n- Current repository: {}\n\n## Summary\n\n- Repositories: {} total, {} clean, {} dirty/error\n- Touched repositories: {}\n\n## Repository Status\n\n{}\n\n## Repositories Needing Attention\n\n{}\n## Related Links\n\n{}\n## Validation Evidence\n\n{}\n## Remaining Work\n\n{}\n## Risks / Blockers\n\n{}\n## Suggested Next Commands\n\n{}\n",
        text(&data["mode"]),
        text(&data["workspace"]["path"]),
        text(&data["workspace"]["branch"]),
        caller,
        current,
        data["summary"]["total"],
        data["summary"]["cleanCount"],
        data["summary"]["dirtyCount"],
        data["summary"]["touchedCount"],
        repository_lines,
        touched_lines,
        markdown_list(&context["links"], "No related links supplied."),
        markdown_list(
            &context["validations"],
            "No validation evidence supplied. Add commands/results before relying on this report for merge readiness."
        ),
        markdown_checklist(&context["todos"], "No remaining work supplied."),
        markdown_list(&context["risks"], "No risks or blockers supplied."),
        command_block
    )
}

fn repository_line(row: &Value) -> String {
    let mut parts = vec![
        format!("{}: {}", text(&row["name"]), text(&row["state"])),
        format!("branch {}", branch_text(row)),
    ];
    let count = row["changeCount"].as_u64().unwrap_or(0);
    if count > 0 {
        parts.push(format!(
            "{count} changed file{}",
            if count == 1 { "" } else { "s" }
        ));
    }
    if let Some(error) = row["error"].as_str() {
        parts.push(error.to_owned());
    }
    if row["refreshWarning"]["kind"] != "missing-remote-ref"
        && let Some(message) = row["refreshWarning"]["message"].as_str()
    {
        parts.push(message.to_owned());
    }
    let base = &row["baseBranch"];
    let default = &row["defaultBranch"];
    let same = base["compareRef"].as_str().is_some()
        && default["compareRef"].as_str().is_some()
        && base["compareRef"] == default["compareRef"];
    append_comparison(
        &mut parts,
        base,
        if same { "base/default" } else { "base" },
        true,
    );
    if !same {
        append_comparison(&mut parts, default, "default", false);
    }
    format!("- {}", parts.join("; "))
}

fn append_comparison(
    parts: &mut Vec<String>,
    comparison: &Value,
    label: &str,
    use_remote_ref: bool,
) {
    let branch = if use_remote_ref {
        comparison["remoteRef"]
            .as_str()
            .or_else(|| comparison["branch"].as_str())
    } else {
        comparison["branch"].as_str()
    }
    .unwrap_or("");
    if comparison["state"] == "available" {
        let behind = comparison["behind"].as_u64().unwrap_or(0);
        if behind > 0 {
            parts.push(format!("{label} {branch} behind by {behind}"));
        }
    } else if comparison["state"] == "unavailable" {
        parts.push(format!("configured {label} {branch} unavailable"));
    }
}

fn branch_text(row: &Value) -> String {
    if row["branch"]["isDetached"] == true {
        return "detached HEAD".to_owned();
    }
    let local = row["branch"]["localBranch"]
        .as_str()
        .filter(|branch| !branch.is_empty())
        .unwrap_or("unknown");
    if row["refreshWarning"]["kind"] == "missing-remote-ref" {
        return format!("{} ({})", local, text(&row["refreshWarning"]["message"]));
    }
    let mut value = local.to_owned();
    if let Some(remote) = row["branch"]["remoteBranch"].as_str() {
        value.push_str(&format!(" → {remote}"));
    }
    let mut drift = Vec::new();
    let ahead = row["branch"]["ahead"].as_u64().unwrap_or(0);
    let behind = row["branch"]["behind"].as_u64().unwrap_or(0);
    if ahead > 0 {
        drift.push(format!("ahead {ahead}"));
    }
    if behind > 0 {
        drift.push(format!("behind {behind}"));
    }
    if !drift.is_empty() {
        value.push_str(&format!(" ({})", drift.join(", ")));
    }
    value
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn markdown_list(value: &Value, empty: &str) -> String {
    let values = strings(value);
    if values.is_empty() {
        format!("- {empty}\n")
    } else {
        format!(
            "{}\n",
            values
                .iter()
                .map(|value| format!("- {value}"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    }
}

fn markdown_checklist(value: &Value, empty: &str) -> String {
    let values = strings(value);
    if values.is_empty() {
        format!("- [ ] {empty}\n")
    } else {
        format!(
            "{}\n",
            values
                .iter()
                .map(|value| format!("- [ ] {value}"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    }
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_failure_comparison_preserves_source_spread_order() {
        let comparison = json!({
            "branch":"main",
            "compareRef":"refs/remotes/origin/main",
            "details":{"error":"fetch failed","kind":"generic"},
            "message":"fetch failed",
            "reason":"refresh-failed",
            "remote":"origin",
            "remoteRef":"origin/main",
            "state":"unavailable"
        });

        assert_eq!(
            serde_json::to_string(&OrderedComparison(&comparison)).unwrap(),
            r#"{"branch":"main","compareRef":"refs/remotes/origin/main","remote":"origin","remoteRef":"origin/main","details":{"error":"fetch failed","kind":"generic"},"message":"fetch failed","reason":"refresh-failed","state":"unavailable"}"#
        );
    }
}
