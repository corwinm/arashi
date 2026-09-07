pub use arashi::{Error, Result};
#[path = "../src/rust/prompts.rs"]
mod prompts;
use prompts::{CancelReason, Choice, PromptOutcome};

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
    let status = std::process::Command::new("node")
        .arg(
            std::path::Path::new(file!())
                .with_file_name("rust")
                .join("prompt-pty.mjs"),
        )
        .arg("--binary")
        .arg(std::env::current_exe().unwrap())
        .status()
        .unwrap();
    assert!(status.success(), "PTY driver failed: {status}");
}
