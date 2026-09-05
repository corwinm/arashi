//! Configured repository command execution; no lifecycle hook policies are applied.
use crate::{
    Error, Result,
    cli::Args,
    config::{RepoConfig, Workspace},
    managed, process,
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

fn usage(message: impl Into<String>) -> Error {
    Error::new("UNKNOWN_ERROR", message).with_exit_code(2)
}
struct Repository {
    name: String,
    path: PathBuf,
    data: Value,
}
struct Selection {
    repositories: Vec<Repository>,
    selected: Vec<String>,
    filters: Value,
    timeout: u64,
}
fn load(cwd: &Path, args: &Args) -> Result<Selection> {
    let workspace = Workspace::discover(cwd).map_err(|e| {
        if e.code == "CONFIG_NOT_FOUND" {
            usage("Not in an arashi workspace. Run \"arashi init\" to initialize a workspace")
        } else {
            e
        }
    })?;
    let config = workspace.config.as_ref().ok_or_else(|| {
        Error::new("CONFIGURED_WORKSPACE_REQUIRED", format!("arashi {} requires a configured workspace. Run \"arashi init\" (without --zero-config) to enable repository coordination.", args.command))
            .with_details(json!({"command":args.command,"mode":"standalone"})).with_exit_code(if args.has("json") { 2 } else { 1 })
    })?;
    managed::safe(&workspace.root)?;
    let main_name = workspace
        .root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    if config.repos.contains_key(&main_name) {
        return Err(managed::unsupported(
            "Duplicate main/child repository names are not yet ported",
        ));
    }
    let mut selection_config = config.clone();
    selection_config.repo_order.insert(0, main_name.clone());
    selection_config.repos.insert(
        main_name.clone(),
        RepoConfig {
            path: ".".into(),
            raw: json!({}),
        },
    );
    let (selected, filters) = crate::selection::select(&selection_config, args).map_err(|e| {
        if e.code == "EMPTY_REPOSITORY_FILTERS" {
            e
        } else {
            usage(e.message)
        }
    })?;
    let mut repositories = vec![];
    for name in &selection_config.repo_order {
        let main = name == &main_name;
        let raw = if main {
            &config.raw["meta"]
        } else {
            &config.repos[name].raw
        };
        let path = if main {
            workspace.root.clone()
        } else {
            let configured = Path::new(&config.repos[name].path);
            let path = if configured.is_absolute() {
                workspace.root.join(managed::relative(
                    configured
                        .strip_prefix(&workspace.root)
                        .map_err(|_| {
                            managed::unsupported("External execution paths are not yet ported")
                        })?
                        .to_str()
                        .ok_or_else(|| {
                            managed::unsupported("Non-UTF-8 repository paths are not supported")
                        })?,
                )?)
            } else {
                workspace
                    .root
                    .join(managed::relative(&config.repos[name].path)?)
            };
            if !path.starts_with(&workspace.root) {
                return Err(managed::unsupported(
                    "External execution paths are not yet ported",
                ));
            }
            path
        };
        managed::safe(&path)?;
        // Source materialization projection includes primary-source discovery.
        // Fail before executing anything until that complete projection is ported.
        for key in ["copy", "symlink"] {
            if raw[key].as_array().is_some_and(|a| !a.is_empty()) {
                return Err(managed::unsupported(
                    "Materialization source projection for exec/setup is not yet ported",
                ));
            }
        }
        let mut data = json!({"name":name,"path":path});
        if !main {
            for key in ["copy", "symlink", "gitUrl", "groups"] {
                if let Some(v) = raw.get(key) {
                    data[key] = v.clone();
                }
            }
        }
        if let Some(base) = raw["baseBranch"]
            .as_str()
            .or(config.raw["baseBranch"].as_str())
        {
            data["baseBranch"] = json!(base.strip_prefix("origin/").unwrap_or(base));
            data["baseBranchSource"] = json!(if raw["baseBranch"].is_string() {
                "repository-config"
            } else {
                "workspace-config"
            });
        }
        repositories.push(Repository {
            name: name.clone(),
            path,
            data,
        });
    }
    Ok(Selection {
        repositories,
        selected,
        filters,
        timeout: config.raw["hooks"]["timeout"].as_u64().unwrap_or(300_000),
    })
}
fn exec_result(repo: &Repository, argv: &[String]) -> Result<Value> {
    let output = process::run(argv, &repo.path, None)?;
    let mut result = json!({"repositoryId":repo.name,"path":repo.path,"command":argv,"exitCode":output.exit_code,"status":if output.exit_code == 0 {"passed"} else {"failed"},"stdout":output.stdout,"stderr":output.stderr,"elapsedMs":output.elapsed_ms});
    if let Some(error) = output.error {
        result["stderr"] = json!(format!("{error}\n"));
        result["errorMessage"] = json!(error);
    }
    Ok(result)
}
pub fn exec(cwd: &Path, args: &Args) -> Result<Value> {
    args.only(&["only", "group", "dirty", "jobs", "fail-fast"])?;
    if args.positional.is_empty() {
        return Err(usage(
            "Missing child command. Use: arashi exec [options] -- <command>",
        ));
    }
    let jobs_text = args.value("jobs").filter(|s| !s.is_empty()).unwrap_or("1");
    let jobs = jobs_text
        .parse::<usize>()
        .ok()
        .filter(|n| *n > 0 && n.to_string() == jobs_text)
        .ok_or_else(|| usage("--jobs must be a positive integer"))?;
    #[cfg(windows)]
    if [".cmd", ".bat"]
        .iter()
        .any(|extension| args.positional[0].to_lowercase().ends_with(extension))
    {
        return Err(managed::unsupported(
            "Windows batch argv execution is not yet ported",
        ));
    }
    let selection = load(cwd, args)?;
    let mut repos = vec![];
    for repo in &selection.repositories {
        if selection.selected.contains(&repo.name) {
            repos.push(repo);
        }
    }
    // --only order, unlike setup, is scheduling order.
    repos.sort_by_key(|r| {
        selection
            .selected
            .iter()
            .position(|n| n == &r.name)
            .unwrap()
    });
    if args.has("dirty") {
        let mut dirty = vec![];
        for repo in repos {
            let output = process::run(
                &["git".into(), "status".into(), "--porcelain=v1".into()],
                &repo.path,
                None,
            )?;
            if output.exit_code != 0 || !output.stdout.trim().is_empty() {
                dirty.push(repo);
            }
        }
        repos = dirty;
    }
    if !args.has("json") {
        if repos.is_empty() {
            println!("No repositories selected for exec");
        } else {
            println!(
                "Running {} in {} repositories",
                args.positional
                    .iter()
                    .map(|s| serde_json::to_string(s).unwrap())
                    .collect::<Vec<_>>()
                    .join(" "),
                repos.len()
            );
        }
    }
    let state = Mutex::new((0_usize, false));
    let results = Mutex::new(
        (0..repos.len())
            .map(|_| None)
            .collect::<Vec<Option<Result<Value>>>>(),
    );
    std::thread::scope(|scope| {
        for _ in 0..jobs.min(repos.len()) {
            scope.spawn(|| {
                loop {
                    let index = {
                        let mut state = state.lock().unwrap();
                        if state.1 || state.0 >= repos.len() {
                            break;
                        }
                        let index = state.0;
                        state.0 += 1;
                        index
                    };
                    let result = exec_result(repos[index], &args.positional);
                    if args.has("fail-fast")
                        && (result.as_ref().is_err()
                            || result.as_ref().is_ok_and(|r| r["status"] == "failed"))
                    {
                        state.lock().unwrap().1 = true;
                    }
                    results.lock().unwrap()[index] = Some(result);
                }
            });
        }
    });
    let results: Vec<Value> = results.into_inner().unwrap().into_iter().enumerate().map(|(i, r)| {
        r.unwrap_or_else(|| Ok(json!({"repositoryId":repos[i].name,"path":repos[i].path,"command":args.positional,"exitCode":null,"status":"not-started","stdout":"","stderr":"","elapsedMs":0,"errorMessage":"Skipped because --fail-fast stopped scheduling after an earlier failure"})))
    }).collect::<Result<_>>()?;
    let count = |status| results.iter().filter(|r| r["status"] == status).count();
    let summary = json!({"command":args.positional,"options":{"dirty":args.has("dirty"),"failFast":args.has("fail-fast"),"groups":selection.filters["groups"],"only":selection.filters["only"],"jobs":jobs,"json":args.has("json")},"selectedRepositories":repos.iter().map(|r| json!({"name":r.name,"path":r.path})).collect::<Vec<_>>(),"total":results.len(),"passed":count("passed"),"failed":count("failed"),"skipped":count("not-started"),"results":results});
    if !args.has("json") && !repos.is_empty() {
        print_exec(&summary);
    }
    if summary["failed"].as_u64().unwrap() > 0 {
        return Err(Error::new(
            "EXEC_COMMAND_FAILED",
            format!("{} repository command(s) failed", summary["failed"]),
        )
        .with_details(summary));
    }
    Ok(summary)
}
fn print_exec(summary: &Value) {
    for result in summary["results"].as_array().unwrap() {
        let status = result["status"].as_str().unwrap();
        println!(
            "\n[{}] {} ({}) {}",
            result["repositoryId"].as_str().unwrap(),
            if status == "passed" { "ok" } else { status },
            result["exitCode"]
                .as_i64()
                .map_or("n/a".into(), |n| n.to_string()),
            result["path"].as_str().unwrap()
        );
        for (key, label) in [
            ("errorMessage", "note"),
            ("stdout", "stdout"),
            ("stderr", "stderr"),
        ] {
            if let Some(value) = result[key].as_str() {
                let value = value.strip_suffix('\n').unwrap_or(value);
                if !value.is_empty() {
                    println!("  {label}:");
                    for line in value.split('\n') {
                        println!("    {line}");
                    }
                }
            }
        }
    }
    println!(
        "\nSummary: {} passed, {} failed, {} skipped, {} total",
        summary["passed"], summary["failed"], summary["skipped"], summary["total"]
    );
}

pub fn setup(cwd: &Path, args: &Args) -> Result<Value> {
    args.only(&["only", "group", "verbose"])?;
    if !args.positional.is_empty() {
        return Err(usage("setup takes no arguments"));
    }
    let selection = load(cwd, args)?;
    let mut targets = vec![];
    for (index, repo) in selection.repositories.iter().enumerate() {
        let selected = selection.selected.contains(&repo.name);
        let script = if selected {
            ["setup.sh", "setup.bash", ".arashi/setup.sh"]
                .iter()
                .map(|p| repo.path.join(p))
                .find(|p| p.exists())
        } else {
            None
        };
        if let Some(path) = &script {
            managed::safe(path)?;
        }
        let mut target = repo.data.clone();
        target["scopeType"] = json!(if index == 0 { "main" } else { "sub" });
        target["selected"] = json!(selected);
        target["hasSetupTask"] = json!(script.is_some());
        if let Some(script) = script {
            target["setupScriptPath"] = json!(script);
        } else {
            target["skipReason"] = json!(if selected {
                "no setup script found"
            } else {
                "excluded by --only filter"
            });
        }
        targets.push(target);
    }
    let executable = targets.iter().filter(|t| t["hasSetupTask"] == true).count();
    let mut executions = vec![];
    let mut index = 0;
    for target in &targets {
        let mut result = json!({"repositoryName":target["name"],"durationMs":0});
        if let Some(script) = target["setupScriptPath"].as_str() {
            index += 1;
            if !args.has("json") {
                println!(
                    "[{index}/{executable}] {}",
                    target["name"].as_str().unwrap()
                );
            }
            let argv = if cfg!(windows) {
                vec!["cmd.exe".into(), "/c".into(), script.into()]
            } else {
                vec!["sh".into(), script.into()]
            };
            let output = process::run(
                &argv,
                Path::new(target["path"].as_str().unwrap()),
                Some(Duration::from_millis(selection.timeout)),
            )?;
            let text = [output.stdout.trim(), output.stderr.trim()]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            result["durationMs"] = json!(output.elapsed_ms);
            result["output"] = json!(text);
            if output.timed_out {
                result["status"] = json!("timed-out");
                result["detail"] = json!(format!("Timed out after {}ms", selection.timeout));
            } else if output.exit_code != 0 {
                result["status"] = json!("failed");
                result["detail"] = json!(if text.is_empty() {
                    format!(
                        "Setup exited with code {}",
                        if output.signaled {
                            -1
                        } else {
                            output.exit_code
                        }
                    )
                } else {
                    text.clone()
                });
            } else {
                result["status"] = json!("success");
            }
            if args.has("verbose") && !args.has("json") && !text.is_empty() {
                println!("{text}");
            }
        } else {
            result["status"] = json!("skipped");
            result["detail"] = target["skipReason"].clone();
        }
        if !args.has("json") {
            println!(
                "{}: {} ({:.2}s){}",
                result["repositoryName"].as_str().unwrap(),
                result["status"].as_str().unwrap(),
                result["durationMs"].as_f64().unwrap() / 1000.,
                result["detail"]
                    .as_str()
                    .map_or(String::new(), |s| format!(" - {s}"))
            );
        }
        executions.push(result);
    }
    let count = |status| executions.iter().filter(|r| r["status"] == status).count();
    let (success, failed, skipped, timed_out) = (
        count("success"),
        count("failed"),
        count("skipped"),
        count("timed-out"),
    );
    let selected = targets.iter().filter(|t| t["selected"] == true).count();
    let summary = json!({"overallStatus":if failed + timed_out == 0 {"success"} else if success > 0 {"partial-failure"} else {"failure"},"totalRepositoriesEvaluated":targets.len(),"executedCount":executable,"successCount":success,"skippedCount":skipped,"failedCount":failed,"timedOutCount":timed_out,"selectedCount":selected,"excludedCount":targets.len()-selected,"targets":targets,"executions":executions});
    if !args.has("json") {
        println!("\nSummary:");
        for (label, key) in [
            ("total", "totalRepositoriesEvaluated"),
            ("selected", "selectedCount"),
            ("executed", "executedCount"),
            ("success", "successCount"),
            ("skipped", "skippedCount"),
            ("failed", "failedCount"),
            ("timed-out", "timedOutCount"),
        ] {
            println!("  {label}: {}", summary[key]);
        }
        if args.has("only") || args.has("group") {
            println!("  excluded: {}", summary["excludedCount"]);
        }
        println!("  overall: {}", summary["overallStatus"].as_str().unwrap());
    }
    Ok(summary)
}
