//! Native terminal prompts. Cancellation is data; command callers own exit policy.
use crate::{Error, Result};
use crossterm::{
    event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
    terminal,
};
use std::io::{self, IsTerminal, Write};
use std::sync::{Mutex, MutexGuard};

#[derive(Clone, Debug)]
pub struct Choice<T> {
    pub value: T,
    pub label: String,
    pub description: Option<String>,
}
#[derive(Debug, PartialEq, Eq)]
pub enum CancelReason {
    Exit,
    Abort,
}
#[derive(Debug, PartialEq, Eq)]
pub enum PromptOutcome<T> {
    Answer(T),
    Cancelled(CancelReason),
}

static TERMINAL: Mutex<()> = Mutex::new(());
struct Session {
    restore: bool,
    _lock: MutexGuard<'static, ()>,
}
impl Session {
    fn open() -> Result<Self> {
        let lock = match TERMINAL.try_lock() {
            Ok(lock) => lock,
            // The protected value is unit; an unwinding validator leaves no shared
            // data to repair. Session::drop already restored terminal mode.
            Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => {
                return Err(Error::new(
                    "PROMPT_BUSY",
                    "A terminal prompt is already active",
                ));
            }
        };
        if !io::stdin().is_terminal() || !io::stderr().is_terminal() {
            return Err(Error::new(
                "PROMPT_NOT_TERMINAL",
                "Prompt requires terminal stdin and stderr",
            ));
        }
        let restore = !terminal::is_raw_mode_enabled()?;
        terminal::enable_raw_mode()?;
        Ok(Self {
            restore,
            _lock: lock,
        })
    }
    fn finish<T>(mut self, answer: PromptOutcome<T>) -> Result<PromptOutcome<T>> {
        if self.restore {
            terminal::disable_raw_mode()?;
            self.restore = false;
        }
        Ok(answer)
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        if self.restore {
            let _ = terminal::disable_raw_mode();
        }
    }
}

// Do not allow labels, paths, or validation messages to issue terminal commands.
fn display(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).collect()
}
fn line(text: &str) -> Result<()> {
    let mut out = io::stderr().lock();
    write!(out, "{}\r\n", display(text))?;
    out.flush()?;
    Ok(())
}
fn key() -> Result<std::result::Result<KeyEvent, CancelReason>> {
    loop {
        match event::read() {
            Ok(Event::Key(k)) if k.kind != KeyEventKind::Release => {
                if k.modifiers.contains(KeyModifiers::CONTROL) {
                    match k.code {
                        KeyCode::Char('c') => return Ok(Err(CancelReason::Exit)),
                        KeyCode::Char('d') | KeyCode::Char('z') => {
                            return Ok(Err(CancelReason::Abort));
                        }
                        _ => continue,
                    }
                }
                if !k
                    .modifiers
                    .intersects(KeyModifiers::ALT | KeyModifiers::SUPER)
                {
                    return Ok(Ok(k));
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::UnexpectedEof | io::ErrorKind::BrokenPipe
                ) =>
            {
                return Ok(Err(CancelReason::Abort));
            }
            Err(e) => return Err(e.into()),
            _ => {}
        }
    }
}
fn menu<T>(
    message: &str,
    choices: &[Choice<T>],
    cursor: usize,
    checked: Option<&[bool]>,
) -> Result<()> {
    line(message)?;
    for (i, choice) in choices.iter().enumerate() {
        let mark = if let Some(checked) = checked {
            if checked[i] { "[x]" } else { "[ ]" }
        } else {
            ""
        };
        line(&format!(
            "{} {} {}",
            if i == cursor { ">" } else { " " },
            mark,
            choice.label
        ))?;
        if i == cursor
            && let Some(description) = &choice.description
        {
            line(description)?;
        }
    }
    Ok(())
}
fn navigate(code: KeyCode, cursor: &mut usize, count: usize) {
    if count == 0 {
        return;
    }
    match code {
        KeyCode::Down | KeyCode::Char('j') => *cursor = (*cursor + 1) % count,
        KeyCode::Up | KeyCode::Char('k') => *cursor = (*cursor + count - 1) % count,
        _ => {}
    }
}
pub fn select<T: Clone>(message: &str, choices: &[Choice<T>]) -> Result<PromptOutcome<T>> {
    if choices.is_empty() {
        return Err(Error::new(
            "PROMPT_EMPTY_CHOICES",
            "Cannot display select prompt with empty choices array",
        ));
    }
    let session = Session::open()?;
    let mut cursor = 0;
    loop {
        menu(message, choices, cursor, None)?;
        let k = match key()? {
            Ok(k) => k,
            Err(reason) => return session.finish(PromptOutcome::Cancelled(reason)),
        };
        if k.code == KeyCode::Enter {
            return session.finish(PromptOutcome::Answer(choices[cursor].value.clone()));
        }
        navigate(k.code, &mut cursor, choices.len());
    }
}
pub fn multi_select<T: Clone>(
    message: &str,
    choices: &[Choice<T>],
) -> Result<PromptOutcome<Vec<T>>> {
    let session = Session::open()?;
    let mut cursor = 0;
    let mut checked = vec![false; choices.len()];
    loop {
        menu(message, choices, cursor, Some(&checked))?;
        let k = match key()? {
            Ok(k) => k,
            Err(reason) => return session.finish(PromptOutcome::Cancelled(reason)),
        };
        match k.code {
            KeyCode::Enter => {
                return session.finish(PromptOutcome::Answer(
                    choices
                        .iter()
                        .zip(&checked)
                        .filter(|(_, checked)| **checked)
                        .map(|(choice, _)| choice.value.clone())
                        .collect(),
                ));
            }
            KeyCode::Char(' ') if !checked.is_empty() => checked[cursor] = !checked[cursor],
            _ => navigate(k.code, &mut cursor, choices.len()),
        }
    }
}
pub fn input(message: &str, default: Option<&str>) -> Result<PromptOutcome<String>> {
    input_validated(message, default, |_| Ok(()))
}
pub fn input_validated(
    message: &str,
    default: Option<&str>,
    mut validate: impl FnMut(&str) -> std::result::Result<(), String>,
) -> Result<PromptOutcome<String>> {
    let session = Session::open()?;
    line(&format!(
        "{}{}",
        message,
        default.map(|d| format!(" ({d})")).unwrap_or_default()
    ))?;
    let mut value = String::new();
    loop {
        let k = match key()? {
            Ok(k) => k,
            Err(reason) => return session.finish(PromptOutcome::Cancelled(reason)),
        };
        match k.code {
            KeyCode::Enter => {
                let answer = if value.is_empty() {
                    default.unwrap_or("").to_string()
                } else {
                    value.clone()
                };
                match validate(&answer) {
                    Ok(()) => {
                        line("")?;
                        return session.finish(PromptOutcome::Answer(answer));
                    }
                    Err(message) => line(&message)?,
                }
            }
            KeyCode::Backspace => {
                value.pop();
            }
            KeyCode::Char(c) if !c.is_control() => value.push(c),
            _ => continue,
        }
        let mut out = io::stderr().lock();
        write!(out, "\r\x1b[2K{}", display(&value))?;
        out.flush()?;
    }
}
pub fn confirm(message: &str, default: Option<bool>) -> Result<PromptOutcome<bool>> {
    let default = default.unwrap_or(true);
    let answer = input_validated(
        &format!("{} ({})", message, if default { "Y/n" } else { "y/N" }),
        Some(if default { "yes" } else { "no" }),
        |text| match text.to_ascii_lowercase().as_str() {
            "y" | "yes" | "n" | "no" => Ok(()),
            _ => Err("Please answer yes or no".into()),
        },
    )?;
    Ok(match answer {
        PromptOutcome::Answer(text) => {
            PromptOutcome::Answer(matches!(text.to_ascii_lowercase().as_str(), "yes" | "y"))
        }
        PromptOutcome::Cancelled(reason) => PromptOutcome::Cancelled(reason),
    })
}
