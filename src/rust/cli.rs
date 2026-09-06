//! Parsing and rendering are separate from domain planning and execution.
use crate::{Error, Result};
use serde_json::{Value, json};
use std::collections::BTreeMap;
#[derive(Debug)]
pub struct Args {
    pub command: String,
    pub options: BTreeMap<String, Vec<String>>,
    pub positional: Vec<String>,
}
impl Args {
    pub fn has(&self, key: &str) -> bool {
        self.options.contains_key(key)
    }
    pub fn value(&self, key: &str) -> Option<&str> {
        self.options
            .get(key)
            .and_then(|v| v.last())
            .map(String::as_str)
    }
    pub fn only(&self, allowed: &[&str]) -> Result<()> {
        for key in self.options.keys() {
            if key != "json" && !allowed.contains(&key.as_str()) {
                return Err(Error::new(
                    "RUST_NOT_YET_PORTED",
                    format!(
                        "Option --{key} is not yet ported for {}; no changes made",
                        self.command
                    ),
                ));
            }
        }
        Ok(())
    }
}
fn contract() -> Value {
    serde_json::from_str(include_str!("../../contracts/cli-commands.json"))
        .expect("checked-in CLI contract")
}
fn definition(name: &str) -> Option<Value> {
    contract()["commands"]
        .as_array()?
        .iter()
        .find(|v| v["path"] == name)
        .cloned()
}
fn help(name: Option<&str>) -> Result<String> {
    let c = contract();
    let mut s = String::from("Arashi Rust 2.0.0-alpha.1 (experimental; see docs/rust-port.md)\n");
    if let Some(name) = name {
        let d = definition(name)
            .ok_or_else(|| Error::new("USAGE", format!("Unknown command: {name}")))?;
        s.push_str(&format!(
            "Usage: arashi {name} [options]\n{}\n",
            d["description"].as_str().unwrap_or("")
        ));
        for o in d["options"].as_array().unwrap() {
            s.push_str(&format!(
                "  {}  {}\n",
                o["flags"].as_str().unwrap(),
                o["description"].as_str().unwrap()
            ));
        }
    } else {
        s.push_str("Usage: arashi <command> [options]\n  -V, --version\n  -h, --help\nCommands (registration does not imply Rust support):\n");
        for d in c["commands"].as_array().unwrap() {
            s.push_str(&format!("  {}\n", d["path"].as_str().unwrap()));
        }
    }
    Ok(s)
}
pub fn parse(raw: &[String]) -> Result<Args> {
    let command = raw
        .first()
        .ok_or_else(|| Error::new("USAGE", "Command required"))?
        .clone();
    let d = definition(&command)
        .ok_or_else(|| Error::new("USAGE", format!("Unknown command: {command}")))?;
    let mut options: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut positional = vec![];
    let mut i = 1;
    while i < raw.len() {
        let a = &raw[i];
        if a == "--" {
            positional.extend_from_slice(&raw[i + 1..]);
            break;
        }
        if a.starts_with('-') {
            let (flag, inline) = a
                .split_once('=')
                .map_or((a.as_str(), None), |(a, b)| (a, Some(b)));
            let o = d["options"]
                .as_array()
                .unwrap()
                .iter()
                .find(|o| o["long"].as_str() == Some(flag) || o["short"].as_str() == Some(flag))
                .ok_or_else(|| Error::new("USAGE", format!("Unknown option: {flag}")))?;
            let key = o["long"]
                .as_str()
                .unwrap()
                .trim_start_matches('-')
                .to_string();
            let value = if o["required"] == true {
                if let Some(v) = inline {
                    v.to_string()
                } else {
                    i += 1;
                    raw.get(i)
                        .filter(|v| !v.starts_with('-'))
                        .ok_or_else(|| {
                            Error::new("USAGE", format!("Option {flag} requires a value"))
                        })?
                        .clone()
                }
            } else {
                if inline.is_some() {
                    return Err(Error::new(
                        "USAGE",
                        format!("Option {flag} does not take a value"),
                    ));
                }
                String::new()
            };
            options.entry(key).or_default().push(value);
        } else {
            positional.push(a.clone());
        }
        i += 1;
    }
    Ok(Args {
        command,
        options,
        positional,
    })
}
pub fn entry() -> i32 {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    if raw.len() == 1 && ["--version", "-V"].contains(&raw[0].as_str()) {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return 0;
    }
    if raw.is_empty()
        || raw
            .iter()
            .take_while(|a| *a != "--")
            .any(|a| a == "--help" || a == "-h")
        || raw.first().is_some_and(|a| a == "help")
    {
        let name = if raw.first().is_some_and(|a| a == "help") {
            raw.get(1).map(String::as_str)
        } else {
            raw.first()
                .filter(|a| !a.starts_with('-'))
                .map(String::as_str)
        };
        match help(name) {
            Ok(s) => {
                print!("{s}");
                return 0;
            }
            Err(e) => {
                eprintln!("{e}");
                return 1;
            }
        }
    }
    let json_mode = raw
        .iter()
        .take_while(|a| *a != "--")
        .any(|a| a == "--json" || a == "-j");
    let command = raw.first().cloned().unwrap_or_default();
    let result = parse(&raw).and_then(|args| dispatch(&args));
    match result {
        Ok(data) => {
            let verbose = raw.iter().any(|s| s == "--verbose" || s == "-v");
            let short = raw.iter().any(|s| s == "--short" || s == "-s");
            let exit_code = if (command == "status"
                && data["repositories"].as_array().is_some_and(|rows| {
                    rows.iter().any(|r| {
                        !r["error"].is_null()
                            && (json_mode || crate::status_human::visible(r, verbose))
                    })
                }))
                || (command == "setup"
                    && (data["failedCount"].as_u64().unwrap_or(0)
                        + data["timedOutCount"].as_u64().unwrap_or(0)
                        > 0))
            {
                1
            } else {
                0
            };
            if json_mode {
                let warnings = if command == "status" {
                    crate::status::warnings(&data)
                } else {
                    vec![]
                };
                println!("{}",serde_json::to_string_pretty(&json!({"command":command,"data":data,"ok":true,"schemaVersion":1,"warnings":warnings})).unwrap());
            } else if command == "status" {
                if data["mode"] == "configured" {
                    eprintln!("- Checking repository status...");
                }
                println!("{}", crate::status_human::render(&data, short, verbose));
            } else if command != "exec" && command != "setup" {
                render_human(&command, &data);
            }
            exit_code
        }
        Err(e) => {
            if e.code == "USAGE"
                && let Some(flag) = e.message.strip_prefix("Unknown option: ")
            {
                eprintln!("error: unknown option '{flag}'");
                return e.exit_code;
            }
            if json_mode {
                println!("{}",serde_json::to_string_pretty(&json!({"command":command,"error":error_value(&e),"ok":false,"schemaVersion":1,"warnings":[]})).unwrap());
            } else {
                if command == "exec" && e.code == "EXEC_COMMAND_FAILED" {
                    // Results were already rendered by exec.
                } else if command == "exec" {
                    eprintln!("{e}");
                } else if command == "setup" {
                    eprintln!("[ERR] {e}");
                } else if command == "doctor" && e.code == "DOCTOR_BLOCKING_FINDINGS" {
                    let data = e.details.as_ref().unwrap();
                    if data["checkedCategories"] == json!(["configuration"]) {
                        eprintln!("{}", data["findings"][0]["message"].as_str().unwrap());
                    } else {
                        println!("{}", crate::doctor::human(data));
                    }
                } else {
                    eprintln!("Error: {e}");
                }
            }
            e.exit_code
        }
    }
}
fn dispatch(args: &Args) -> Result<Value> {
    let cwd = std::env::current_dir()?;
    match args.command.as_str() {
        "exec" => crate::execution::exec(&cwd, args),
        "setup" => crate::execution::setup(&cwd, args),
        "doctor" => {
            args.only(&[])?;
            if !args.positional.is_empty() {
                return Err(Error::new("USAGE", "doctor takes no arguments"));
            }
            crate::doctor::doctor(&cwd)
        }
        "install" => {
            args.only(&[])?;
            if !args.positional.is_empty() {
                return Err(Error::new("USAGE", "install takes no arguments"));
            }
            Ok(
                json!({"message":"No npm-managed binary installation is needed in this direct binary context.","npmEntrypointMessage":"The npm package entrypoint handles `arashi install` before the native binary starts.","reinstallMessage":"For direct binary or curl installs, reinstall Arashi or download a release asset if the binary is missing.","releasesUrl":"https://github.com/corwinm/arashi/releases"}),
            )
        }
        "clone" => {
            args.only(&["all", "base", "repo-base"])?;
            let workspace = crate::config::Workspace::discover(&cwd)?;
            crate::clone::clone(&workspace, &cwd, args)
        }
        "create" => {
            args.only(&[
                "base",
                "repo-base",
                "conflict",
                "only",
                "group",
                "no-hooks",
                "no-launch",
                "no-switch",
                "no-progress",
                "dry-run",
            ])?;
            if args.positional.len() != 1 {
                return Err(Error::new("USAGE", "create requires exactly one branch"));
            }
            let w = crate::config::Workspace::discover(&cwd)?;
            if w.config.is_some() {
                return crate::coordinated::create(&w, args);
            }
            args.only(&[
                "no-hooks",
                "no-launch",
                "no-switch",
                "no-progress",
                "dry-run",
            ])?;
            crate::operations::CreatePlan::build(&w, &args.positional[0], args.has("no-hooks"))?
                .execute(&w, args.has("dry-run"))
        }
        "remove" => {
            args.only(&["force", "keep-branches", "path", "dry-run"])?;
            if args.positional.len() != 1 {
                return Err(Error::new("USAGE", "remove requires exactly one target"));
            }
            let w = crate::config::Workspace::discover(&cwd)?;
            if w.config.is_some() {
                return crate::coordinated::remove(&w, args);
            }
            crate::operations::RemovePlan::build(
                &w,
                &args.positional[0],
                args.has("path"),
                args.has("keep-branches"),
                args.has("force"),
            )?
            .execute(&w, args.has("dry-run"))
        }
        "list" => {
            args.only(&[])?;
            if !args.positional.is_empty() {
                return Err(Error::new("USAGE", "list takes no arguments"));
            }
            if let Err(e) = crate::config::Workspace::discover(&cwd)
                && e.code == "CONFIG_NOT_FOUND"
                && let Ok(records) = crate::git::worktrees(&cwd)
                && let Some(primary) = records.first()
            {
                return crate::list::ordinary(primary.path.clone());
            }
            let w = crate::config::Workspace::discover(&cwd).map_err(|e| {
                if e.code != "CONFIG_NOT_FOUND" {
                    return e;
                }
                if args.command == "status" {
                    return Error::new("NOT_IN_WORKSPACE", "Not in an arashi workspace")
                        .with_exit_code(2);
                }
                if crate::git::run(&cwd, &["rev-parse", "--is-inside-work-tree"]).is_err() {
                    Error::new(
                        "NOT_IN_REPOSITORY",
                        format!(
                            "Not a git repository: {}. Run from repository root.",
                            cwd.display()
                        ),
                    )
                    .with_details(json!({"path":cwd}))
                } else {
                    e
                }
            })?;
            crate::list::list(&w)
        }
        "prune" => {
            args.only(&["dry-run", "expire"])?;
            if !args.positional.is_empty() {
                return Err(Error::new("USAGE", "prune takes no arguments"));
            }
            let w = crate::config::Workspace::discover(&cwd).map_err(|e| {
                if e.code == "CONFIG_NOT_FOUND" {
                    Error::new("NOT_IN_WORKSPACE", "Not in an arashi workspace").with_exit_code(2)
                } else {
                    e
                }
            })?;
            crate::prune::prune(
                &w,
                args.has("dry-run"),
                args.value("expire").unwrap_or("now"),
            )
        }
        "status" => {
            args.only(&["only", "group", "short", "verbose"])?;
            if args.has("short") && args.has("verbose") {
                return Err(Error::new(
                    "CONFLICTING_OPTIONS",
                    "Cannot use --verbose and --short together",
                )
                .with_exit_code(2)
                .with_details(json!({"options":["--verbose","--short"]})));
            }
            if !args.positional.is_empty() {
                return Err(Error::new("USAGE", "status takes no arguments"));
            }
            let w = crate::config::Workspace::discover(&cwd).map_err(|e| {
                if e.code != "CONFIG_NOT_FOUND" {
                    return e;
                }
                if args.command == "status" {
                    return Error::new("NOT_IN_WORKSPACE", "Not in an arashi workspace")
                        .with_exit_code(2);
                }
                if crate::git::run(&cwd, &["rev-parse", "--is-inside-work-tree"]).is_err() {
                    Error::new(
                        "NOT_IN_REPOSITORY",
                        format!(
                            "Not a git repository: {}. Run from repository root.",
                            cwd.display()
                        ),
                    )
                    .with_details(json!({"path":cwd}))
                } else {
                    e
                }
            })?;
            crate::status::status_filtered(&w, &cwd, args)
        }
        "init" => {
            args.only(&[
                "zero-config",
                "dry-run",
                "no-discover",
                "repos-dir",
                "worktrees-dir",
            ])?;
            if !args.positional.is_empty() {
                return Err(Error::new("USAGE", "init takes no arguments"));
            }
            if args.has("zero-config") && args.has("no-discover") {
                return Err(Error::new(
                    "ZERO_CONFIG_INCOMPATIBLE_OPTIONS",
                    "--zero-config is incompatible with --no-discover",
                ));
            }
            if !args.has("zero-config") {
                return crate::init::configured(&cwd, args);
            }
            args.only(&["zero-config", "dry-run", "no-discover"])?;
            crate::init::init(&cwd, args.has("dry-run"), true)
        }
        _ => Err(Error::new(
            "RUST_NOT_YET_PORTED",
            format!(
                "Command '{}' is not yet ported to Rust; no changes made",
                args.command
            ),
        )),
    }
}

fn error_value(e: &Error) -> Value {
    let mut v = json!({"code":e.code,"message":e.message});
    if let Some(d) = &e.details {
        v["details"] = d.clone();
    }
    v
}

fn render_human(command: &str, data: &Value) {
    if command == "doctor" {
        println!("{}", crate::doctor::human(data));
        return;
    }
    match command {
        "list" => {
            if data["mode"] == "standalone" {
                eprintln!("Workspace mode: standalone");
            }
            if let Some(rows) = data["worktrees"].as_array() {
                for row in rows {
                    println!("{}", row["path"].as_str().unwrap_or(""));
                }
            }
        }
        "create" => println!(
            "{} worktree at {}",
            if data["dryRun"] == true {
                "Would create"
            } else {
                "Created"
            },
            data["worktreePath"].as_str().unwrap_or("")
        ),
        "remove" => println!(
            "Removed {} worktree(s) and {} branch(es)",
            data["summary"]["successfulWorktrees"], data["summary"]["successfulBranches"]
        ),
        "init" => println!(
            "{} standalone workspace: {}",
            if data["dryRun"] == true {
                "Would initialize"
            } else {
                "Initialized"
            },
            data["workspaceRoot"].as_str().unwrap_or("")
        ),
        "install" => {
            for key in [
                "message",
                "npmEntrypointMessage",
                "reinstallMessage",
                "releasesUrl",
            ] {
                println!("{}", data[key].as_str().unwrap_or(""));
            }
        }
        "prune" => println!(
            "{} {} stale worktree metadata entries",
            if data["dryRun"] == true {
                "Would prune"
            } else {
                "Pruned"
            },
            if data["dryRun"] == true {
                &data["totalPrunable"]
            } else {
                &data["totalPruned"]
            }
        ),
        _ => unreachable!("implemented command requires human renderer"),
    }
}
