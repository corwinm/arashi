pub use arashi::{Error, Result};
#[path = "../src/rust/prompts.rs"]
mod prompts;
use prompts::{CancelReason, Choice, PromptOutcome};

#[cfg(target_os = "macos")]
#[derive(Clone)]
struct NodePtySource {
    package: std::path::PathBuf,
    platform: String,
}

#[cfg(target_os = "macos")]
struct IsolatedNodePty {
    _root: tempfile::TempDir,
    node_modules: std::path::PathBuf,
    helper: std::path::PathBuf,
}

#[cfg(target_os = "macos")]
fn resolve_node_pty_source() -> NodePtySource {
    let output = std::process::Command::new("node")
        .args([
            "-e",
            "const {createRequire}=require('node:module');const {dirname,resolve}=require('node:path');const base=process.env.ARASHI_PROMPT_NODE_MODULES?resolve(process.env.ARASHI_PROMPT_NODE_MODULES,'../package.json'):process.cwd()+'/prompt-pty-test.cjs';const moduleRequire=createRequire(base);process.stdout.write(JSON.stringify({package:dirname(moduleRequire.resolve('node-pty/package.json')),platform:`darwin-${process.arch}`}));",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "could not resolve node-pty package"
    );
    let resolved: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    NodePtySource {
        package: resolved["package"].as_str().unwrap().into(),
        platform: resolved["platform"].as_str().unwrap().to_owned(),
    }
}

#[cfg(target_os = "macos")]
fn copy_directory(source: &std::path::Path, destination: &std::path::Path) {
    std::fs::create_dir_all(destination).unwrap();
    for entry in std::fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let destination = destination.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_directory(&entry.path(), &destination);
        } else {
            std::fs::copy(entry.path(), destination).unwrap();
        }
    }
}

#[cfg(target_os = "macos")]
fn make_isolated_node_pty_non_executable_from(source: &NodePtySource) -> IsolatedNodePty {
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().unwrap();
    let node_modules = root.path().join("node_modules");
    let package = node_modules.join("node-pty");
    std::fs::create_dir_all(&package).unwrap();
    std::fs::copy(
        source.package.join("package.json"),
        package.join("package.json"),
    )
    .unwrap();
    copy_directory(&source.package.join("lib"), &package.join("lib"));
    copy_directory(
        &source.package.join("prebuilds").join(&source.platform),
        &package.join("prebuilds").join(&source.platform),
    );
    std::fs::write(root.path().join("package.json"), "{}").unwrap();

    let helper = package
        .join("prebuilds")
        .join(&source.platform)
        .join("spawn-helper");
    let mut permissions = std::fs::metadata(&helper).unwrap().permissions();
    permissions.set_mode(permissions.mode() & !0o111);
    std::fs::set_permissions(&helper, permissions).unwrap();

    IsolatedNodePty {
        _root: root,
        node_modules,
        helper,
    }
}

#[cfg(target_os = "macos")]
fn make_isolated_node_pty_non_executable() -> IsolatedNodePty {
    make_isolated_node_pty_non_executable_from(&resolve_node_pty_source())
}

#[cfg(target_os = "macos")]
#[test]
fn node_pty_fixture_isolated_across_concurrent_builds() {
    use std::os::unix::fs::PermissionsExt;

    let source_root = tempfile::tempdir().unwrap();
    let package = source_root.path().join("node-pty");
    let platform = "darwin-test";
    std::fs::create_dir_all(package.join("lib")).unwrap();
    std::fs::create_dir_all(package.join("prebuilds").join(platform)).unwrap();
    std::fs::write(package.join("package.json"), "{}").unwrap();
    std::fs::write(package.join("lib").join("index.js"), "").unwrap();
    std::fs::write(
        package.join("prebuilds").join(platform).join("pty.node"),
        "fixture",
    )
    .unwrap();
    let source_helper = package
        .join("prebuilds")
        .join(platform)
        .join("spawn-helper");
    std::fs::write(&source_helper, "fixture").unwrap();
    let mut permissions = std::fs::metadata(&source_helper).unwrap().permissions();
    permissions.set_mode(0o640);
    std::fs::set_permissions(&source_helper, permissions).unwrap();
    let source = NodePtySource {
        package,
        platform: platform.to_owned(),
    };

    let builds = (0..2)
        .map(|_| {
            let source = source.clone();
            std::thread::spawn(move || make_isolated_node_pty_non_executable_from(&source))
        })
        .collect::<Vec<_>>();
    let fixtures = builds
        .into_iter()
        .map(|build| build.join().unwrap())
        .collect::<Vec<_>>();

    assert_ne!(fixtures[0].node_modules, fixtures[1].node_modules);
    for fixture in &fixtures {
        assert_ne!(fixture.helper, source_helper);
        assert_eq!(
            std::fs::metadata(&fixture.helper)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640,
        );
    }
    assert_eq!(
        std::fs::metadata(source_helper)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o640,
    );
}

#[test]
fn prompt_fixture() {
    let Ok(case) = std::env::var("ARASHI_PROMPT_CASE") else {
        return;
    };
    let choices = [
        Choice {
            value: 10,
            label: "Alpha".into(),
            description: Some("first description".into()),
        },
        Choice {
            value: 20,
            label: "Beta".into(),
            description: Some("second description".into()),
        },
    ];
    if let Ok(spec) = std::env::var("ARASHI_PROMPT_SEMANTIC") {
        let spec: serde_json::Value = serde_json::from_str(&spec).unwrap();
        if spec["kind"] == "input" {
            assert_eq!(
                prompts::input("Enter text", spec["default"].as_str()).unwrap(),
                PromptOutcome::Answer(spec["expected"].as_str().unwrap().to_owned())
            );
        } else {
            assert_eq!(
                prompts::confirm("Proceed", spec["default"].as_bool()).unwrap(),
                PromptOutcome::Answer(spec["expected"].as_bool().unwrap())
            );
        }
    } else {
        match case.as_str() {
            "select" | "arrows" | "wrap" => assert_eq!(
                prompts::select("Choose item", &choices).unwrap(),
                PromptOutcome::Answer(20)
            ),
            "default-select" => assert_eq!(
                prompts::select("Choose item", &choices).unwrap(),
                PromptOutcome::Answer(10)
            ),
            "multi" => assert_eq!(
                prompts::multi_select("Choose items", &choices).unwrap(),
                PromptOutcome::Answer(vec![10, 20])
            ),
            "empty-multi" => assert_eq!(
                prompts::multi_select::<i32>("Choose items", &[]).unwrap(),
                PromptOutcome::Answer(vec![])
            ),
            "input" => assert_eq!(
                prompts::input("Enter text", None).unwrap(),
                PromptOutcome::Answer("jké".into())
            ),
            "default-input" => assert_eq!(
                prompts::input("Enter text", Some("fallback")).unwrap(),
                PromptOutcome::Answer("fallback".into())
            ),
            "validate" => assert_eq!(
                prompts::input_validated("Enter text", None, |s| if s == "ok" {
                    Ok(())
                } else {
                    Err("Try again".into())
                })
                .unwrap(),
                PromptOutcome::Answer("ok".into())
            ),
            "confirm" => assert_eq!(
                prompts::confirm("Proceed", Some(false)).unwrap(),
                PromptOutcome::Answer(false)
            ),
            "yes" => assert_eq!(
                prompts::confirm("Proceed", None).unwrap(),
                PromptOutcome::Answer(true)
            ),
            "cancel" => assert_eq!(
                prompts::input("Enter text", None).unwrap(),
                PromptOutcome::Cancelled(CancelReason::Exit)
            ),
            "eof" => assert_eq!(
                prompts::input("Enter text", None).unwrap(),
                PromptOutcome::Cancelled(CancelReason::Abort)
            ),
            "cancel-select" => assert_eq!(
                prompts::select("Choose item", &choices).unwrap(),
                PromptOutcome::Cancelled(CancelReason::Exit)
            ),
            "cancel-multi" => assert_eq!(
                prompts::multi_select("Choose items", &choices).unwrap(),
                PromptOutcome::Cancelled(CancelReason::Exit)
            ),
            "cancel-confirm" => assert_eq!(
                prompts::confirm("Proceed", None).unwrap(),
                PromptOutcome::Cancelled(CancelReason::Exit)
            ),
            "panic-restore" => {
                assert!(
                    std::panic::catch_unwind(|| prompts::input_validated(
                        "Enter text",
                        None,
                        |_| panic!("validator panic")
                    ))
                    .is_err()
                );
            }
            "existing-raw" => {
                crossterm::terminal::enable_raw_mode().unwrap();
                assert_eq!(
                    prompts::input("Enter text", None).unwrap(),
                    PromptOutcome::Answer("ok".into())
                );
                assert!(crossterm::terminal::is_raw_mode_enabled().unwrap());
                crossterm::terminal::disable_raw_mode().unwrap();
            }
            "empty-select" => assert!(prompts::select::<i32>("Choose item", &[]).is_err()),
            _ => panic!("unknown case {case}"),
        }
    }
    assert!(
        !crossterm::terminal::is_raw_mode_enabled().unwrap(),
        "raw mode leaked"
    );
    println!("PROMPT_RESULT_OK");
    // A second real prompt detects stale listeners, locks and terminal state.
    assert_eq!(
        prompts::input("Reuse terminal", None).unwrap(),
        PromptOutcome::Answer("reuse".into())
    );
    assert!(!crossterm::terminal::is_raw_mode_enabled().unwrap());
    println!("REUSE_OK");
}

const PTY_DRIVER_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);
const PTY_DRIVER_CASE_BUDGET: std::time::Duration = std::time::Duration::from_secs(20);

fn pty_driver_timeout_reason(
    elapsed: std::time::Duration,
    idle: std::time::Duration,
    case_count: usize,
) -> Option<String> {
    let hard_timeout = PTY_DRIVER_IDLE_TIMEOUT
        .saturating_add(PTY_DRIVER_CASE_BUDGET.saturating_mul(case_count as u32));
    if elapsed > hard_timeout {
        return Some(format!(
            "exceeded the derived {}-second hard deadline",
            hard_timeout.as_secs()
        ));
    }
    if idle >= PTY_DRIVER_IDLE_TIMEOUT {
        return Some(format!(
            "made no progress for {} seconds",
            PTY_DRIVER_IDLE_TIMEOUT.as_secs()
        ));
    }
    None
}

fn pty_driver_case_count(progress: &str) -> Option<usize> {
    let (_, total) = progress.trim().split_once('/')?;
    let total = total.parse().ok()?;
    (total > 0).then_some(total)
}

#[test]
fn pty_driver_watchdog_allows_aggregate_runtime_with_progress() {
    assert_eq!(
        pty_driver_timeout_reason(
            std::time::Duration::from_secs(240),
            std::time::Duration::from_secs(3),
            59,
        ),
        None,
    );
}

#[test]
fn pty_driver_watchdog_still_detects_idle_and_hard_stalls() {
    assert_eq!(
        pty_driver_timeout_reason(
            std::time::Duration::from_secs(46),
            std::time::Duration::from_secs(46),
            59,
        ),
        Some("made no progress for 45 seconds".into()),
    );
    assert_eq!(
        pty_driver_timeout_reason(
            std::time::Duration::from_secs(1_226),
            std::time::Duration::from_secs(1),
            59,
        ),
        Some("exceeded the derived 1225-second hard deadline".into()),
    );
}

#[test]
fn native_pty_contract() {
    if std::env::var_os("ARASHI_PROMPT_CASE").is_some() {
        return;
    }
    #[cfg(target_os = "macos")]
    let isolated_node_pty = make_isolated_node_pty_non_executable();
    let progress_dir = tempfile::tempdir().unwrap();
    let progress_path = progress_dir.path().join("progress");
    let mut command = std::process::Command::new("node");
    command
        .arg(
            std::path::Path::new(file!())
                .with_file_name("rust")
                .join("prompt-pty.mjs"),
        )
        .arg("--binary")
        .arg(std::env::current_exe().unwrap())
        .arg("--progress")
        .arg(&progress_path);
    #[cfg(target_os = "macos")]
    command.env(
        "ARASHI_PROMPT_NODE_MODULES",
        &isolated_node_pty.node_modules,
    );
    let mut child = command.spawn().unwrap();
    // A completed row report is not acceptance if ConPTY handles keep Node alive.
    // Monitor row progress because ConPTY startup cost makes aggregate runtime
    // proportional to the case count; a fixed whole-driver deadline can expire
    // while rows are still completing normally.
    let started = std::time::Instant::now();
    let mut last_progress_at = started;
    let mut progress = String::new();
    let mut case_count = 0;
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if let Ok(current) = std::fs::read_to_string(&progress_path)
            && current != progress
        {
            if let Some(total) = pty_driver_case_count(&current) {
                case_count = total;
            }
            progress = current;
            last_progress_at = std::time::Instant::now();
        }
        let now = std::time::Instant::now();
        if let Some(reason) = pty_driver_timeout_reason(
            now.duration_since(started),
            now.duration_since(last_progress_at),
            case_count,
        ) {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("PTY driver {reason} (last progress: {progress:?})");
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    assert!(status.success(), "PTY driver failed: {status}");
}
