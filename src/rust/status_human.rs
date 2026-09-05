//! Status presentation follows the retained command's explicit ANSI formatting.
use serde_json::Value;
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn color(code: u8, s: impl AsRef<str>) -> String {
    format!("\x1b[{code}m{}\x1b[0m", s.as_ref())
}
fn number(v: &Value) -> u64 {
    v.as_u64().unwrap_or(0)
}
fn drift(v: &Value, separator: &str) -> String {
    let mut parts = vec![];
    if number(&v["ahead"]) > 0 {
        parts.push(format!("↑{}", v["ahead"]));
    }
    if number(&v["behind"]) > 0 {
        parts.push(format!("↓{}", v["behind"]));
    }
    parts.join(separator)
}
fn shared(row: &Value) -> bool {
    !row["baseBranch"]["compareRef"].is_null()
        && row["baseBranch"]["compareRef"] == row["defaultBranch"]["compareRef"]
}
fn base_tracking(row: &Value) -> bool {
    !row["baseBranch"]["remoteRef"].is_null()
        && row["baseBranch"]["remoteRef"] == row["branch"]["remoteBranch"]
}
fn changes(row: &Value) -> String {
    let files = row["files"].as_array().unwrap();
    let counts = [
        (
            "staged",
            files.iter().filter(|f| f["stagingStatus"] != " ").count(),
        ),
        (
            "modified",
            files
                .iter()
                .filter(|f| f["workingStatus"] == "M" && f["stagingStatus"] == " ")
                .count(),
        ),
        (
            "untracked",
            files.iter().filter(|f| f["workingStatus"] == "?").count(),
        ),
    ];
    counts
        .into_iter()
        .filter(|(_, n)| *n > 0)
        .map(|(label, n)| format!("{n} {label}"))
        .collect::<Vec<_>>()
        .join(", ")
}
fn comparison_lines(row: &Value, short: bool) -> String {
    let mut out = String::new();
    let base = &row["baseBranch"];
    if !base_tracking(row) {
        let label = if shared(row) { "Base/default" } else { "Base" };
        if base["state"] == "available" {
            let drift = drift(base, if short { "" } else { ", " });
            if short {
                out += &format!(" {}:{}{drift}", label.to_lowercase(), text(&base["branch"]));
            } else {
                out += &format!(
                    "  {label}: {} [{}]\n",
                    text(&base["branch"]),
                    if drift.is_empty() {
                        "up to date"
                    } else {
                        &drift
                    }
                );
            }
        } else if base["state"] == "unavailable" {
            if short {
                out += &format!(
                    " {}",
                    color(33, format!("(base:{} unavailable)", text(&base["branch"])))
                );
            } else {
                out += &format!(
                    "  {}\n",
                    color(33, format!("Base: {} (unavailable)", text(&base["branch"])))
                );
            }
        }
    }
    let default = &row["defaultBranch"];
    if !shared(row) {
        if default["state"] == "available" && number(&default["behind"]) > 0 {
            if short {
                out += &format!(" {}", color(33, format!("default↓{}", default["behind"])));
            } else {
                out += &format!(
                    "  {}\n",
                    color(
                        33,
                        format!(
                            "Default: {} [↓{}]",
                            text(&default["branch"]),
                            default["behind"]
                        )
                    )
                );
            }
        } else if default["state"] == "unavailable" {
            if short {
                out += &format!(" {}", color(33, "(default unavailable)"));
            } else {
                out += &format!(
                    "  {}\n",
                    color(
                        33,
                        format!("Default: {} (unavailable)", text(&default["branch"]))
                    )
                );
            }
        }
    }
    out
}
pub fn visible(row: &Value, verbose: bool) -> bool {
    verbose
        || !(text(&row["error"]).contains("arashi clone")
            && row["files"].as_array().is_some_and(Vec::is_empty))
}
pub fn render(data: &Value, short: bool, verbose: bool) -> String {
    let standalone = data["mode"] == "standalone";
    let rows = data[if standalone {
        "worktrees"
    } else {
        "repositories"
    }]
    .as_array()
    .unwrap();
    let rows: Vec<_> = rows
        .iter()
        .filter(|r| standalone || visible(r, verbose))
        .collect();
    let mut out = String::new();
    if standalone {
        out += &format!(
            "Workspace mode: standalone\nMain repository: {}\n",
            text(&data["repositoryPath"])
        );
        if data["callerWorktree"] != data["repositoryPath"] {
            out += &format!("Caller worktree: {}\n", text(&data["callerWorktree"]));
        }
    }
    for row in &rows {
        let files = row["files"].as_array().unwrap().len();
        let error = text(&row["error"]);
        let branch = &row["branch"];
        let missing = row["refreshWarning"]["kind"] == "missing-remote-ref";
        let stale = row["refreshWarning"]["kind"] == "stale-remote-tracking";
        if short {
            let branch_label = if branch["isDetached"] == true {
                "detached"
            } else {
                text(&branch["localBranch"])
            };
            out += &format!("{} ({branch_label}", text(&row["path"]));
            let drift = drift(branch, "");
            if !drift.is_empty() {
                out += &format!(" {drift}");
            }
            out += "): ";
            if !error.is_empty() {
                out += &color(
                    31,
                    if error.contains("arashi clone") {
                        "✗ missing (run arashi clone)"
                    } else {
                        "✗ error"
                    },
                );
            } else if files == 0 {
                out += &color(32, "✓ clean");
            } else {
                out += &color(33, format!("● {files} changes ({})", changes(row)));
            }
            if missing {
                out += &format!(
                    " {}",
                    color(33, format!("({})", text(&row["refreshWarning"]["message"])))
                );
            } else if stale {
                out += &format!(" {}", color(33, "(remote tracking stale)"));
            }
            out += &comparison_lines(row, true);
            out += "\n";
            continue;
        }
        out += &format!(
            "\n{} ({})\n",
            color(1, text(&row["name"])),
            text(&row["path"])
        );
        if branch["isDetached"] == true {
            out += &format!("  Branch: {}\n", color(36, "(detached HEAD)"));
        } else if missing {
            out += &format!(
                "  {}\n",
                color(
                    33,
                    format!(
                        "Branch: {} → {}",
                        text(&branch["localBranch"]),
                        text(&row["refreshWarning"]["message"])
                    )
                )
            );
        } else {
            out += &format!("  Branch: {}", color(36, text(&branch["localBranch"])));
            if !branch["remoteBranch"].is_null() {
                out += &format!(" → {}", text(&branch["remoteBranch"]));
                let drift = drift(branch, ", ");
                if !drift.is_empty() {
                    out += &format!(" [{drift}]");
                }
            }
            out += "\n";
        }
        out += &comparison_lines(row, false);
        if verbose {
            out += "\n";
            if !error.is_empty() {
                out += &format!("  {}\n", color(31, format!("✗ Error: {error}")));
            } else if let Some(full) = row["fullStatus"].as_str().filter(|s| !s.is_empty()) {
                for line in full.split('\n') {
                    out += &format!("  {line}\n");
                }
            } else {
                out += &format!("  {}\n", color(32, "✓ Clean - No changes"));
            }
        } else if !error.is_empty() {
            out += &format!(
                "  Status: {}\n  {}\n",
                color(31, "✗ Error"),
                color(31, error)
            );
        } else if files == 0 {
            out += &format!("  Status: {}\n", color(32, "✓ Clean"));
        } else {
            out += &format!(
                "  Status: {} ({files} changes)\n    {}\n",
                color(33, "● Dirty"),
                changes(row)
            );
        }
        if stale {
            out += &format!(
                "  {}\n",
                color(
                    33,
                    format!("Warning: {}", text(&row["refreshWarning"]["message"]))
                )
            );
        }
    }
    let clean = rows
        .iter()
        .filter(|r| r["error"].is_null() && r["files"].as_array().unwrap().is_empty())
        .count();
    let dirty = rows.len() - clean;
    if short {
        out += &format!("\nSummary: {clean} clean, {dirty} dirty\n");
    } else {
        out += &format!(
            "\n{}\n{}\n",
            "─".repeat(40),
            color(
                1,
                format!(
                    "Summary: {clean} clean, {dirty} dirty ({} total)",
                    rows.len()
                )
            )
        );
    }
    out
}
