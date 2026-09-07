//! External kitten implements transport; Arashi only runs the retained CLI protocol.
use super::*;
use sha2::{Digest, Sha256};
use std::{path::PathBuf, time::Duration};
const MAX_ID: u64 = 9_007_199_254_740_991;
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Metadata {
    pub canonical_path: PathBuf,
    pub identity: String,
    pub label: String,
}
pub fn metadata(target: &LaunchTarget) -> LaunchResult<Metadata> {
    let mut path = target
        .worktree_path
        .canonicalize()
        .map_err(|e| failure(format!("Kitty identity: {e}")))?;
    // Rust's Windows canonicalize returns an extended-length prefix; Node realpath does not.
    #[cfg(windows)]
    {
        let value = path
            .to_str()
            .ok_or_else(|| failure("Kitty path is not Unicode"))?;
        if let Some(p) = value.strip_prefix(r"\\?\UNC\") {
            path = PathBuf::from(format!(r"\\{p}"));
        } else if let Some(p) = value.strip_prefix(r"\\?\") {
            path = PathBuf::from(p);
        }
    }
    #[cfg(not(windows))]
    let _ = &mut path;
    let text = path
        .to_str()
        .ok_or_else(|| failure("Kitty path is not Unicode"))?;
    let identity = format!("arashi-v1-{:x}", Sha256::digest(text.as_bytes()));
    Ok(Metadata {
        canonical_path: path,
        identity,
        label: format!("{}: {}", target.repository, target.branch),
    })
}
#[derive(Debug, Clone)]
pub struct Window {
    pub id: u64,
    pub focused: bool,
    pub session: String,
    pub marker: Option<String>,
    pub cwd: String,
}
fn invalid() -> LaunchError {
    failure("Kitty inspection-validation: missing or wrong-typed required state")
}
fn positive(v: &Value) -> LaunchResult<u64> {
    // JSON's 1.0 is a JS safe integer as well as 1.
    let n = v.as_f64().ok_or_else(invalid)?;
    if n > 0.0 && n <= MAX_ID as f64 && n.fract() == 0.0 {
        Ok(n as u64)
    } else {
        Err(invalid())
    }
}
fn string(v: &Value) -> LaunchResult<&str> {
    v.as_str().ok_or_else(invalid)
}
pub fn parse_state(raw: &str) -> LaunchResult<Vec<Window>> {
    let v: Value = serde_json::from_str(raw).map_err(|_| invalid())?;
    let mut out = Vec::new();
    for os in v.as_array().ok_or_else(invalid)? {
        positive(&os["id"])?;
        for tab in os["tabs"].as_array().ok_or_else(invalid)? {
            positive(&tab["id"])?;
            for w in tab["windows"].as_array().ok_or_else(invalid)? {
                let vars = w["user_vars"].as_object().ok_or_else(invalid)?;
                let mut cwd = None;
                if let Some(fg) = w.get("foreground_processes") {
                    for process in fg.as_array().ok_or_else(invalid)? {
                        let record = process.as_object().ok_or_else(invalid)?;
                        if let Some(value) = record.get("cwd") {
                            let s = string(value)?;
                            if !s.trim().is_empty() {
                                cwd = Some(s);
                                break;
                            }
                        }
                    }
                }
                let cwd = match cwd {
                    Some(s) => s,
                    None => string(&w["cwd"])?,
                };
                let time = w["last_focused_at"].as_f64().ok_or_else(invalid)?;
                if !time.is_finite() || time < 0.0 {
                    return Err(invalid());
                }
                string(&w["title"])?;
                out.push(Window {
                    id: positive(&w["id"])?,
                    focused: w["is_focused"].as_bool().ok_or_else(invalid)?,
                    session: string(&w["session_name"])?.into(),
                    marker: vars
                        .get("arashi_worktree_id")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    cwd: cwd.into(),
                });
            }
        }
    }
    Ok(out)
}
fn selected(state: &[Window], identity: &str) -> LaunchResult<Option<Window>> {
    let mut matching = state
        .iter()
        .filter(|w| w.marker.as_deref() == Some(identity));
    let first = matching.next().cloned();
    if matching.next().is_some() {
        return Err(failure(
            "Kitty duplicate-state: multiple exact worktree identity matches",
        ));
    }
    Ok(first)
}
fn version(raw: &str) -> Option<[u64; 3]> {
    let lower = raw.to_ascii_lowercase();
    // Match the retained word-boundary kitty/kitten version token, including suffixes.
    for (offset, _) in lower.char_indices() {
        if offset > 0
            && lower[..offset]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            continue;
        }
        let tail = &lower[offset..];
        let Some(rest) = tail
            .strip_prefix("kitten")
            .or_else(|| tail.strip_prefix("kitty"))
        else {
            continue;
        };
        if !rest.starts_with(char::is_whitespace) {
            continue;
        }
        let rest = rest.trim_start();
        let bytes = rest.as_bytes();
        let mut i = 0;
        let mut nums = [0; 3];
        let mut valid = true;
        for (part, n) in nums.iter_mut().enumerate() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i == start {
                valid = false;
                break;
            }
            let Ok(value) = rest[start..i].parse() else {
                valid = false;
                break;
            };
            *n = value;
            if part < 2 {
                if bytes.get(i) != Some(&b'.') {
                    valid = false;
                    break;
                }
                i += 1;
            }
        }
        if valid
            && !bytes
                .get(i)
                .is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_')
        {
            return Some(nums);
        }
    }
    None
}
pub(super) fn execute<F>(
    plan: &ManagedPlan,
    target: &LaunchTarget,
    ctx: &LaunchContext,
    lock_root: Option<&Path>,
    run: &mut F,
) -> LaunchResult<LaunchOutcome>
where
    F: FnMut(&[String], &Path, &Environment) -> ProcessResult,
{
    let metadata = metadata(target)?;
    let env = process::child_environment(&ctx.env, ctx.platform);
    let lookup = strings(&[
        if ctx.platform == Platform::Windows {
            "where"
        } else {
            "which"
        },
        "kitten",
    ]);
    let found = run(&lookup, &ctx.cwd, &env);
    let binary = if found.exit_code == 0 {
        found
            .stdout
            .lines()
            .map(str::trim)
            .find(|s| !s.is_empty())
            .map(str::to_owned)
    } else {
        None
    };
    let binary = binary
        .or_else(|| {
            let bundle = "/Applications/kitty.app/Contents/MacOS/kitten";
            (ctx.platform == Platform::MacOs && Path::new(bundle).exists()).then(|| bundle.into())
        })
        .ok_or_else(|| failure("Kitty version-preflight: kitten executable not found"))?;
    let command = strings(&[&binary, "--version"]);
    let result = run(&command, &metadata.canonical_path, &env);
    ensure_success(&command, &result)?;
    if version(&result.stdout).is_none_or(|v| v < [0, 43, 0]) {
        return Err(failure(
            "Kitty version-preflight: require validated Kitty 0.43.0 or newer",
        ));
    }
    let lock = lock::IdentityLock::acquire(&metadata.identity, lock_root, Duration::from_secs(10))?;
    let mut remote = Remote {
        binary,
        metadata,
        env,
        run,
    };
    let result = remote
        .inspect_focus_or_launch()
        .map(|command| LaunchOutcome {
            command,
            mode: "kitty".into(),
            disposition: plan.disposition,
        });
    let released = lock.release();
    match result {
        Err(e) => Err(e),
        Ok(out) => {
            released?;
            Ok(out)
        }
    }
}
struct Remote<'a, F> {
    binary: String,
    metadata: Metadata,
    env: Environment,
    run: &'a mut F,
}
impl<F> Remote<'_, F>
where
    F: FnMut(&[String], &Path, &Environment) -> ProcessResult,
{
    fn run(&mut self, command: &[String]) -> ProcessResult {
        (self.run)(command, &self.metadata.canonical_path, &self.env)
    }
    fn inspect(&mut self) -> LaunchResult<Vec<Window>> {
        let command = strings(&[&self.binary, "@", "ls"]);
        let result = self.run(&command);
        ensure_success(&command, &result)?;
        parse_state(&result.stdout)
    }
    fn inspect_match(&mut self) -> LaunchResult<Option<Window>> {
        let state = self.inspect()?;
        selected(&state, &self.metadata.identity)
    }
    fn focus_command(&self, id: u64) -> Vec<String> {
        strings(&[
            &self.binary,
            "@",
            "focus-window",
            "--match",
            &format!("id:{id}"),
        ])
    }
    fn inspect_focus_or_launch(&mut self) -> LaunchResult<Vec<String>> {
        let Some(original) = self.inspect_match()? else {
            return self.launch();
        };
        let command = self.focus_command(original.id);
        let result = self.run(&command);
        let Some(after) = self.inspect_match()? else {
            return self.launch();
        };
        if after.id == original.id {
            ensure_success(&command, &result)?;
            if !after.focused {
                return Err(failure(
                    "Kitty focus-validation: same managed window remained unfocused",
                ));
            }
            return Ok(command);
        }
        let command = self.focus_command(after.id);
        let result = self.run(&command);
        ensure_success(&command, &result)?;
        if self
            .inspect_match()?
            .is_none_or(|w| w.id != after.id || !w.focused)
        {
            return Err(failure(
                "Kitty focus-validation: state changed after one reconciliation",
            ));
        }
        Ok(command)
    }
    fn launch(&mut self) -> LaunchResult<Vec<String>> {
        let command = strings(&[
            &self.binary,
            "@",
            "launch",
            "--type=tab",
            "--cwd",
            self.metadata.canonical_path.to_str().ok_or_else(invalid)?,
            "--add-to-session",
            &self.metadata.label,
            "--var",
            &format!("arashi_worktree_id={}", self.metadata.identity),
            "--title",
            &self.metadata.label,
        ]);
        let result = self.run(&command);
        ensure_success(&command, &result)?;
        let raw = result.stdout.trim();
        let id = if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) {
            raw.parse::<u64>()
                .ok()
                .filter(|id| *id > 0 && *id <= MAX_ID)
        } else {
            None
        }
        .ok_or_else(|| {
            failure("Kitty launch-response-validation: expected one numeric window ID")
        })?;
        let focus = self.focus_command(id);
        let result = self.run(&focus);
        ensure_success(&focus, &result)?;
        if self
            .inspect_match()?
            .is_none_or(|w| w.id != id || !w.focused || w.session != self.metadata.label)
        {
            return Err(failure(
                "Kitty launch-state-validation: inconsistent identity, session or focus",
            ));
        }
        Ok(command)
    }
}
