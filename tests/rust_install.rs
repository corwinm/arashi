use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "arashi-install-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn run(&self, source: bool, args: &[&str], plain: bool) -> std::process::Output {
        let mut command = if source {
            let mut command = Command::new("node");
            command.arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/index.ts"));
            command
        } else {
            Command::new(env!("CARGO_BIN_EXE_arashi"))
        };
        command
            .args(args)
            .current_dir(&self.0)
            .env("HOME", &self.0)
            .env("USERPROFILE", &self.0)
            .env("NODE_DISABLE_COMPILE_CACHE", "1")
            .env_remove("FORCE_COLOR");
        if plain {
            command.env("NO_COLOR", "1");
        } else {
            command.env_remove("NO_COLOR");
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            output.stderr.is_empty(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fs::read_dir(&self.0).unwrap().count(),
            0,
            "install is informational, not an installation"
        );
        output
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}

#[test]
fn direct_install_human_messages_match_source_without_filesystem_effects() {
    let fixture = Fixture::new();
    for plain in [true, false] {
        let native = fixture.run(false, &["install"], plain);
        let symbol = if plain { "[OK]" } else { "✓" };
        let expected = format!(
            "{symbol} No npm-managed binary installation is needed in this direct binary context.\nThe npm package entrypoint handles `arashi install` before the native binary starts.\nFor direct binary or curl installs, reinstall Arashi or download a release asset if the binary is missing.\nManual releases: https://github.com/corwinm/arashi/releases\n"
        );
        assert_eq!(String::from_utf8(native.stdout.clone()).unwrap(), expected);
        if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            assert_eq!(native.stdout, fixture.run(true, &["install"], plain).stdout);
        }
    }
}

#[test]
fn direct_install_json_remains_one_document_without_filesystem_effects() {
    let fixture = Fixture::new();
    let native = fixture.run(false, &["install", "--json"], true);
    let actual: serde_json::Value = serde_json::from_slice(&native.stdout).unwrap();
    assert_eq!(actual["command"], "install");
    assert_eq!(actual["ok"], true);
    assert_eq!(
        actual["data"]["releasesUrl"],
        "https://github.com/corwinm/arashi/releases"
    );
    if std::env::var_os("ARASHI_TS_PARITY").is_some() {
        let source = fixture.run(true, &["install", "--json"], true);
        assert_eq!(
            actual,
            serde_json::from_slice::<serde_json::Value>(&source.stdout).unwrap()
        );
    }
}
