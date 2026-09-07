pub use arashi::{Error, Result};
#[path = "../src/rust/prompts.rs"]
mod prompts;
use prompts::{CancelReason, Choice, PromptOutcome};

#[cfg(target_os = "macos")]
struct SpawnHelperPermissions {
    path: std::path::PathBuf,
    original: std::fs::Permissions,
}

#[cfg(target_os = "macos")]
impl Drop for SpawnHelperPermissions {
    fn drop(&mut self) {
        std::fs::set_permissions(&self.path, self.original.clone()).unwrap();
    }
}

#[cfg(target_os = "macos")]
fn make_spawn_helper_non_executable() -> SpawnHelperPermissions {
    use std::os::unix::fs::PermissionsExt;

    let output = std::process::Command::new("node")
        .args([
            "-e",
            "const {createRequire}=require('node:module');const {dirname,join,resolve}=require('node:path');const base=process.env.ARASHI_PROMPT_NODE_MODULES?resolve(process.env.ARASHI_PROMPT_NODE_MODULES,'../package.json'):process.cwd()+'/prompt-pty-test.cjs';const moduleRequire=createRequire(base);process.stdout.write(join(dirname(moduleRequire.resolve('node-pty')),'..','prebuilds',`darwin-${process.arch}`,'spawn-helper'));",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "could not resolve node-pty spawn-helper"
    );
    let path = std::path::PathBuf::from(String::from_utf8(output.stdout).unwrap());
    let original = std::fs::metadata(&path).unwrap().permissions();
    let mut non_executable = original.clone();
    non_executable.set_mode(original.mode() & !0o111);
    std::fs::set_permissions(&path, non_executable).unwrap();
    SpawnHelperPermissions { path, original }
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

#[test]
fn native_pty_contract() {
    if std::env::var_os("ARASHI_PROMPT_CASE").is_some() {
        return;
    }
    #[cfg(target_os = "macos")]
    let _spawn_helper_permissions = make_spawn_helper_non_executable();
    let mut child = std::process::Command::new("node")
        .arg(
            std::path::Path::new(file!())
                .with_file_name("rust")
                .join("prompt-pty.mjs"),
        )
        .arg("--binary")
        .arg(std::env::current_exe().unwrap())
        .spawn()
        .unwrap();
    // A completed row report is not acceptance if ConPTY handles keep Node alive.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("PTY driver did not exit within 90 seconds");
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    assert!(status.success(), "PTY driver failed: {status}");
}
