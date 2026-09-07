//! Native launch foundation. Command-specific selection/JSON policy stays with callers.
#[cfg(target_os = "macos")]
#[path = "launch/direct_exec.rs"]
pub(crate) mod direct_exec;
#[path = "launch/platform.rs"]
pub mod platform;
#[path = "launch/process.rs"]
pub mod process;
#[path = "launch/resolve.rs"]
pub mod resolve;
use std::{collections::BTreeMap, path::PathBuf};
pub type Environment = BTreeMap<String, String>;
pub type LaunchResult<T> = std::result::Result<T, LaunchError>;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Platform {
    MacOs,
    Linux,
    Windows,
}
impl Platform {
    pub fn native() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::MacOs
        } else {
            Self::Linux
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchDisposition {
    Window,
    Tab,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Ide {
    VsCode,
    Cursor,
    Kiro,
}
impl Ide {
    pub fn command(self) -> &'static str {
        match self {
            Self::VsCode => "code",
            Self::Cursor => "cursor",
            Self::Kiro => "kiro",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::VsCode => "vscode",
            Self::Cursor => "cursor",
            Self::Kiro => "kiro",
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManagedFamily {
    Tmux,
    Sesh,
    Herdr,
    Cmux,
    Kitty,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchSelector {
    Auto,
    Managed(ManagedFamily),
    Ide(Ide),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaunchIntent {
    pub selector: LaunchSelector,
    pub disposition: LaunchDisposition,
}
#[derive(Clone, Debug)]
pub struct LaunchTarget {
    pub worktree_path: PathBuf,
    pub repository: String,
    pub branch: String,
    pub herdr_source: Option<PathBuf>,
}
#[derive(Clone, Debug)]
pub struct LaunchContext {
    pub platform: Platform,
    pub env: Environment,
    pub cwd: PathBuf,
    pub home: Option<PathBuf>,
}
impl LaunchContext {
    pub fn native() -> std::io::Result<Self> {
        Ok(Self {
            platform: Platform::native(),
            env: std::env::vars().collect(),
            cwd: std::env::current_dir()?,
            home: std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(PathBuf::from),
        })
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagedPlan {
    pub family: ManagedFamily,
    pub disposition: LaunchDisposition,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlatformFamily {
    Ide(Ide),
    WezTerm,
    KittyUnmanaged,
    Ghostty,
    Terminal,
    ITerm2,
    WindowsTerminal,
    GitBash,
    Fallback,
}
impl PlatformFamily {
    pub fn name(self) -> &'static str {
        match self {
            Self::Ide(_) => "ide",
            Self::WezTerm => "wezterm",
            Self::KittyUnmanaged => "kitty-unmanaged",
            Self::Ghostty => "ghostty",
            Self::Terminal => "terminal",
            Self::ITerm2 => "iterm2",
            Self::WindowsTerminal => "windows-terminal",
            Self::GitBash => "git-bash",
            Self::Fallback => "fallback",
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MacTarget {
    pub version: String,
    pub target: String,
    pub profile: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlatformPlan {
    pub family: PlatformFamily,
    pub disposition: LaunchDisposition,
    pub ide_command: Option<String>,
    pub mac_target: Option<MacTarget>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LaunchPlan {
    Managed(ManagedPlan),
    Platform(PlatformPlan),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaunchOutcome {
    pub mode: String,
    pub command: Vec<String>,
    pub disposition: LaunchDisposition,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchErrorCode {
    TmuxContextRequired,
    SeshRequiresTmux,
    SeshNotFound,
    IdeNotFound,
    TabDispositionUnsupported,
    LaunchFailed,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaunchError {
    pub code: LaunchErrorCode,
    pub message: String,
}
impl LaunchError {
    pub fn new(code: LaunchErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn switch_exit_code(&self) -> i32 {
        match self.code {
            LaunchErrorCode::TmuxContextRequired
            | LaunchErrorCode::SeshRequiresTmux
            | LaunchErrorCode::SeshNotFound
            | LaunchErrorCode::IdeNotFound => 2,
            _ => 1,
        }
    }
}
impl std::fmt::Display for LaunchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(f)
    }
}
impl std::error::Error for LaunchError {}
pub(crate) fn nonempty<'a>(env: &'a Environment, key: &str) -> Option<&'a str> {
    env.get(key).map(|s| s.trim()).filter(|s| !s.is_empty())
}
