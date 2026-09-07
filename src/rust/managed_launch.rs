//! Managed launch adapters for retained 07c77e0 source semantics.
//! These families deliberately do not share a universal tab/window policy.
use crate::launch::{
    process::{self, ProcessResult},
    *,
};
#[path = "managed_launch_kitty.rs"]
pub mod kitty;
#[path = "managed_launch_lock.rs"]
pub mod lock;
use serde_json::Value;
use std::path::Path;

pub fn execute(
    plan: &ManagedPlan,
    target: &LaunchTarget,
    ctx: &LaunchContext,
) -> LaunchResult<LaunchOutcome> {
    execute_with(plan, target, ctx, None, &mut |args, cwd, env| {
        process::run(args, cwd, env, false)
    })
}
/// Injectable process boundary; the native entry point always uses the launch lifecycle.
/// `herdr_source` must be resolved by the caller from Git's main non-bare worktree.
pub fn execute_with<F>(
    plan: &ManagedPlan,
    target: &LaunchTarget,
    ctx: &LaunchContext,
    lock_root: Option<&Path>,
    run: &mut F,
) -> LaunchResult<LaunchOutcome>
where
    F: FnMut(&[String], &Path, &Environment) -> ProcessResult,
{
    let env = process::child_environment(&ctx.env, ctx.platform);
    let path = target.worktree_path.to_string_lossy();
    let label = format!("{}: {}", target.repository, target.branch);
    let (mode, command) = match plan.family {
        ManagedFamily::Tmux | ManagedFamily::Sesh => {
            let sesh = plan.family == ManagedFamily::Sesh;
            if nonempty(&ctx.env, "TMUX").is_none() {
                return Err(LaunchError::new(
                    if sesh {
                        LaunchErrorCode::SeshRequiresTmux
                    } else {
                        LaunchErrorCode::TmuxContextRequired
                    },
                    "An active tmux session is required.",
                ));
            }
            if sesh {
                let lookup = strings(&[
                    if ctx.platform == Platform::Windows {
                        "where"
                    } else {
                        "which"
                    },
                    "sesh",
                ]);
                if run(&lookup, &ctx.cwd, &env).exit_code != 0 {
                    return Err(LaunchError::new(
                        LaunchErrorCode::SeshNotFound,
                        "The `sesh` binary is required for --sesh mode.",
                    ));
                }
            }
            let mut args = strings(&["tmux", "new-window", "-c", &path]);
            if sesh {
                args.push(format!("sesh connect '{}'", path.replace('\'', "'\\''")));
            }
            (if sesh { "sesh" } else { "tmux" }, args)
        }
        ManagedFamily::Cmux => (
            "cmux",
            strings(&[
                "cmux",
                "workspace",
                "create",
                "--cwd",
                &path,
                "--focus",
                "true",
                "--json",
            ]),
        ),
        ManagedFamily::Herdr => {
            let args = if plan.disposition == LaunchDisposition::Tab {
                let workspace = nonempty(&ctx.env, "HERDR_WORKSPACE_ID").ok_or_else(|| {
                    LaunchError::new(
                        LaunchErrorCode::TabDispositionUnsupported,
                        "Herdr requires HERDR_WORKSPACE_ID to target the active workspace.",
                    )
                })?;
                strings(&[
                    "herdr",
                    "tab",
                    "create",
                    "--workspace",
                    workspace,
                    "--cwd",
                    &path,
                    "--label",
                    &label,
                    "--focus",
                    "--json",
                ])
            } else {
                let source = target
                    .herdr_source
                    .as_ref()
                    .ok_or_else(|| failure("Herdr requires a non-bare source checkout."))?;
                strings(&[
                    "herdr",
                    "worktree",
                    "open",
                    "--cwd",
                    &source.to_string_lossy(),
                    "--path",
                    &path,
                    "--label",
                    &label,
                    "--focus",
                    "--json",
                ])
            };
            ("herdr", args)
        }
        ManagedFamily::Kitty => return kitty::execute(plan, target, ctx, lock_root, run),
    };
    let result = run(&command, &target.worktree_path, &env);
    ensure_success(&command, &result)?;
    if matches!(plan.family, ManagedFamily::Herdr | ManagedFamily::Cmux) {
        let v: Value = serde_json::from_str(&result.stdout)
            .map_err(|_| failure(format!("Invalid {mode} JSON response")))?;
        let valid = if plan.family == ManagedFamily::Cmux {
            text(&v["workspace_ref"]) || text(&v["workspace_id"])
        } else if plan.disposition == LaunchDisposition::Tab {
            text(&v["result"]["tab"]["tab_id"]) && text(&v["result"]["tab"]["root_pane_id"])
        } else {
            v["result"]["type"] == "worktree_opened"
                && v["result"]["already_open"].is_boolean()
                && text(&v["result"]["workspace"]["workspace_id"])
        };
        if !valid {
            return Err(failure(format!("Invalid {mode} response identity")));
        }
    }
    Ok(LaunchOutcome {
        mode: mode.into(),
        command,
        disposition: plan.disposition,
    })
}
fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| (*s).into()).collect()
}
fn text(v: &Value) -> bool {
    v.as_str().is_some_and(|s| !s.trim().is_empty())
}
fn failure(message: impl Into<String>) -> LaunchError {
    LaunchError::new(LaunchErrorCode::LaunchFailed, message)
}
fn ensure_success(command: &[String], result: &ProcessResult) -> LaunchResult<()> {
    if result.exit_code == 0 {
        Ok(())
    } else {
        Err(failure(format!(
            "Managed launch failed using {}: {}",
            command.join(" "),
            if result.stderr.is_empty() {
                &result.stdout
            } else {
                &result.stderr
            }
        )))
    }
}
