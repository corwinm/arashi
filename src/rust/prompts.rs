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
        if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
            return Err(Error::new(
                "PROMPT_NOT_TERMINAL",
                "Prompt requires terminal stdin and stdout",
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
    let mut out = io::stdout().lock();
    write!(out, "{}\r\n", display(text))?;
    out.flush()?;
    Ok(())
}
fn clear_menu(lines: usize) -> Result<()> {
    if lines == 0 {
        return Ok(());
    }
    let mut out = io::stdout().lock();
    for _ in 0..lines {
        write!(out, "\x1b[1A\r\x1b[2K")?;
    }
    out.flush()?;
    Ok(())
}
fn key(editing: bool) -> Result<std::result::Result<KeyEvent, CancelReason>> {
    loop {
        match event::read() {
            Ok(Event::Key(k)) if k.kind != KeyEventKind::Release => {
                if k.modifiers.contains(KeyModifiers::CONTROL) {
                    match k.code {
                        KeyCode::Char('c') => return Ok(Err(CancelReason::Exit)),
                        KeyCode::Char('d') if editing => return Ok(Ok(k)),
                        KeyCode::Char('d') | KeyCode::Char('z') => {
                            return Ok(Err(CancelReason::Abort));
                        }
                        _ if editing => return Ok(Ok(k)),
                        _ => continue,
                    }
                }
                if editing
                    || !k
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
fn viewport(count: usize, cursor: usize, rows: usize) -> std::ops::Range<usize> {
    let visible = rows.saturating_sub(4).max(1).min(count);
    let start = cursor.saturating_sub(visible / 2).min(count - visible);
    start..start + visible
}
fn menu<T>(
    message: &str,
    choices: &[Choice<T>],
    cursor: usize,
    checked: Option<&[bool]>,
) -> Result<usize> {
    let rows = terminal::size().map_or(24, |(_, rows)| usize::from(rows));
    let visible = viewport(choices.len(), cursor, rows);
    let mut lines = 1;
    line(message)?;
    if visible.start > 0 {
        line(&format!("↑ {} more", visible.start))?;
        lines += 1;
    }
    for (i, choice) in choices
        .iter()
        .enumerate()
        .take(visible.end)
        .skip(visible.start)
    {
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
        lines += 1;
        if i == cursor
            && let Some(description) = &choice.description
        {
            line(description)?;
            lines += 1;
        }
    }
    if visible.end < choices.len() {
        line(&format!("↓ {} more", choices.len() - visible.end))?;
        lines += 1;
    }
    Ok(lines)
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
    let mut rendered = 0;
    loop {
        clear_menu(rendered)?;
        rendered = menu(message, choices, cursor, None)?;
        let k = match key(false)? {
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
    let mut rendered = 0;
    loop {
        clear_menu(rendered)?;
        rendered = menu(message, choices, cursor, Some(&checked))?;
        let k = match key(false)? {
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
// Node readline's \w is ASCII, including underscore.
fn word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

// Character-indexed editing follows the retained Node readline controls.
#[derive(Default)]
struct EditBuffer {
    chars: Vec<char>,
    cursor: usize,
}
impl EditBuffer {
    fn text(&self) -> String {
        self.chars.iter().collect()
    }
    fn set(&mut self, text: &str) {
        self.chars = text.chars().collect();
        self.cursor = self.chars.len();
    }
    fn word_left(&self) -> usize {
        let mut at = self.cursor;
        while at > 0 && self.chars[at - 1].is_whitespace() {
            at -= 1;
        }
        if at > 0 {
            let category = word(self.chars[at - 1]);
            while at > 0
                && !self.chars[at - 1].is_whitespace()
                && word(self.chars[at - 1]) == category
            {
                at -= 1;
            }
        }
        at
    }
    fn word_right(&self, deleting: bool) -> usize {
        let mut at = self.cursor;
        if at < self.chars.len() {
            let first = self.chars[at];
            while at < self.chars.len()
                && if first.is_whitespace() {
                    self.chars[at].is_whitespace()
                } else if word(first) {
                    word(self.chars[at])
                } else {
                    !word(self.chars[at]) && (deleting || !self.chars[at].is_whitespace())
                }
            {
                at += 1;
            }
            while at < self.chars.len() && self.chars[at].is_whitespace() {
                at += 1;
            }
        }
        at
    }
    fn edit(&mut self, key: KeyEvent) {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        if key.modifiers.contains(KeyModifiers::SUPER) {
            return;
        }
        if (ctrl && key.code == KeyCode::Left) || (alt && key.code == KeyCode::Char('b')) {
            self.cursor = self.word_left();
            return;
        }
        if (ctrl && key.code == KeyCode::Right) || (alt && key.code == KeyCode::Char('f')) {
            self.cursor = self.word_right(false);
            return;
        }
        if ((ctrl || alt) && key.code == KeyCode::Delete) || (alt && key.code == KeyCode::Char('d'))
        {
            self.chars.drain(self.cursor..self.word_right(true));
            return;
        }
        if (alt && key.code == KeyCode::Backspace)
            || (ctrl && key.code == KeyCode::Char('w'))
            || (ctrl && key.code == KeyCode::Backspace && !cfg!(windows))
        {
            let start = self.word_left();
            self.chars.drain(start..self.cursor);
            self.cursor = start;
            return;
        }
        if alt {
            return;
        }
        let code = if key.modifiers.contains(KeyModifiers::CONTROL) {
            match key.code {
                KeyCode::Char('a') => KeyCode::Home,
                KeyCode::Char('e') => KeyCode::End,
                KeyCode::Char('b') => KeyCode::Left,
                KeyCode::Char('f') => KeyCode::Right,
                KeyCode::Char('h') => KeyCode::Backspace,
                KeyCode::Backspace if cfg!(windows) => KeyCode::Backspace,
                KeyCode::Char('d') => KeyCode::Delete,
                KeyCode::Char('u') => {
                    self.chars.drain(..self.cursor);
                    self.cursor = 0;
                    return;
                }
                KeyCode::Char('k') => {
                    self.chars.truncate(self.cursor);
                    return;
                }
                _ => return,
            }
        } else {
            key.code
        };
        match code {
            KeyCode::Left => self.cursor = self.cursor.saturating_sub(1),
            KeyCode::Right => self.cursor = (self.cursor + 1).min(self.chars.len()),
            KeyCode::Home => self.cursor = 0,
            KeyCode::End => self.cursor = self.chars.len(),
            KeyCode::Backspace if self.cursor > 0 => {
                self.cursor -= 1;
                self.chars.remove(self.cursor);
            }
            KeyCode::Delete if self.cursor < self.chars.len() => {
                self.chars.remove(self.cursor);
            }
            KeyCode::Char(c) if !c.is_control() => {
                self.chars.insert(self.cursor, c);
                self.cursor += 1;
            }
            KeyCode::Tab => {
                self.chars.insert(self.cursor, char::from(9));
                self.cursor += 1;
            }
            _ => {}
        }
    }
    fn render(&self) -> Result<()> {
        let before: String = self.chars[..self.cursor].iter().collect();
        let after: String = self.chars[self.cursor..].iter().collect();
        let mut out = io::stdout().lock();
        // Save at the cursor rather than guessing Unicode display widths.
        write!(
            out,
            "\r\x1b[2K{}\x1b[s{}\x1b[u",
            display(&before),
            display(&after)
        )?;
        out.flush()?;
        Ok(())
    }
}
fn editing_key(buffer: &EditBuffer) -> Result<std::result::Result<KeyEvent, CancelReason>> {
    Ok(match key(true)? {
        Ok(k)
            if k.modifiers.contains(KeyModifiers::CONTROL)
                && k.code == KeyCode::Char('d')
                && buffer.chars.is_empty() =>
        {
            Err(CancelReason::Abort)
        }
        other => other,
    })
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
    let mut default = default.unwrap_or("").to_owned();
    let mut buffer = EditBuffer::default();
    loop {
        let k = match editing_key(&buffer)? {
            Ok(k) => k,
            Err(reason) => return session.finish(PromptOutcome::Cancelled(reason)),
        };
        match k.code {
            KeyCode::Enter => {
                let value = buffer.text();
                let answer = if value.is_empty() {
                    default.clone()
                } else {
                    value
                };
                match validate(&answer) {
                    Ok(()) => {
                        line("")?;
                        return session.finish(PromptOutcome::Answer(answer));
                    }
                    Err(message) => line(&message)?,
                }
            }
            KeyCode::Backspace if buffer.chars.is_empty() => default.clear(),
            KeyCode::Tab if buffer.chars.is_empty() => {
                buffer.set(&default);
                default.clear();
            }
            _ => buffer.edit(k),
        }
        buffer.render()?;
    }
}
fn boolean_value(text: &str, default: bool) -> bool {
    match text.as_bytes().first() {
        Some(b'y' | b'Y') => true,
        Some(b'n' | b'N') => false,
        _ => default,
    }
}
pub fn confirm(message: &str, default: Option<bool>) -> Result<PromptOutcome<bool>> {
    let session = Session::open()?;
    let default = default.unwrap_or(true);
    line(&format!(
        "{} ({})",
        message,
        if default { "Y/n" } else { "y/N" }
    ))?;
    let mut buffer = EditBuffer::default();
    loop {
        let k = match editing_key(&buffer)? {
            Ok(k) => k,
            Err(reason) => return session.finish(PromptOutcome::Cancelled(reason)),
        };
        match k.code {
            KeyCode::Enter => {
                line("")?;
                return session.finish(PromptOutcome::Answer(boolean_value(
                    &buffer.text(),
                    default,
                )));
            }
            KeyCode::Tab => buffer.set(if boolean_value(&buffer.text(), default) {
                "No"
            } else {
                "Yes"
            }),
            _ => buffer.edit(k),
        }
        buffer.render()?;
    }
}

#[cfg(test)]
mod tests {
    use super::viewport;

    #[test]
    fn viewport_keeps_active_choice_visible_and_bounded() {
        for cursor in [0, 1, 50, 98, 99] {
            let range = viewport(100, cursor, 10);
            assert!(range.contains(&cursor), "cursor={cursor}, range={range:?}");
            assert!(range.len() <= 6, "{range:?}");
        }
    }
}
