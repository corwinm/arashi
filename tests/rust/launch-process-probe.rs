//! Standalone source-oracle bridge: rustc --edition=2024 this file -o <probe>.
#![allow(dead_code)]
// Only the process module is included; no planner or application is substituted.
type Environment = std::collections::BTreeMap<String, String>;
#[derive(Clone, Copy, PartialEq)]
enum Platform {
    Windows,
    MacOs,
    Linux,
}
impl Platform {
    fn native() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::MacOs
        } else {
            Self::Linux
        }
    }
}
#[path = "../../src/rust/launch/process.rs"]
mod process;
fn hex(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let env = std::env::vars().collect();
    let result = process::run(
        &args[3..],
        std::path::Path::new(&args[2]),
        &env,
        args[1] == "detached",
    );
    println!(
        "{}\n{}\n{}",
        result.exit_code,
        hex(&result.stdout),
        hex(&result.stderr)
    );
}
