// Separate distribution identity; never enable canonical v1 shell integration.
pub fn entry() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() == 1 && matches!(args[0].as_str(), "--version" | "-V" | "-v") {
        println!(
            "arashi2 {} (experimental native alpha)",
            env!("CARGO_PKG_VERSION")
        );
        return 0;
    }
    if args.first().is_some_and(|arg| {
        matches!(
            arg.as_str(),
            "install" | "uninstall" | "update" | "shell" | "shell-init" | "completion"
        )
    }) {
        eprintln!(
            "arashi2 alpha: installer and shell integration commands are disabled. Use the separate alpha setup bundle to refresh/uninstall; stable arashi/aw are never managed here."
        );
        return 1;
    }
    eprintln!("arashi2 experimental native alpha: incomplete; see docs/rust-port.md");
    arashi::cli::alpha_entry()
}
