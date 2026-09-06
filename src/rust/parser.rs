//! Commander-compatible structural parsing, independent of command execution.
//! Help is a checked-in, process-captured non-TTY source artifact (never a runtime fallback).
use crate::{Error, Result, cli::Args};
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};

pub enum Invocation {
    Command(Args),
    Output {
        text: String,
        stderr: bool,
        code: i32,
    },
}
fn contract() -> Value {
    serde_json::from_str(include_str!("../../contracts/cli-commands.json")).unwrap()
}
fn help(path: &str, stderr: bool) -> Invocation {
    let data: Value = serde_json::from_str(include_str!("parser-help.json")).unwrap();
    Invocation::Output {
        text: data[path].as_str().unwrap_or("").to_owned(),
        stderr,
        code: i32::from(stderr),
    }
}
fn usage(message: impl Into<String>) -> Error {
    Error::new("PARSER_USAGE", message)
}
fn maybe_option(s: &str) -> bool {
    s.len() > 1 && s.starts_with('-')
}

struct Scan {
    operands: Vec<String>,
    unknown: Vec<String>,
    options: BTreeMap<String, Vec<String>>,
    version: bool,
}
fn scan(raw: &[String], definitions: &[Value]) -> Result<Scan> {
    let mut result = Scan {
        operands: vec![],
        unknown: vec![],
        options: BTreeMap::new(),
        version: false,
    };
    let mut queue: VecDeque<String> = raw.iter().cloned().collect();
    let mut unknown = false;
    while let Some(arg) = queue.pop_front() {
        if arg == "--" {
            if unknown {
                result.unknown.push(arg);
                result.unknown.extend(queue);
            } else {
                result.operands.extend(queue);
            }
            break;
        }
        let find = |flag: &str| {
            definitions
                .iter()
                .find(|o| o["long"] == flag || o["short"] == flag)
        };
        let mut option = find(&arg);
        let mut inline = None;
        if option.is_none() && arg.starts_with('-') && !arg.starts_with("--") && arg.len() > 2 {
            let end = 1 + arg[1..].chars().next().unwrap().len_utf8();
            option = find(&arg[..end]);
            if let Some(o) = option {
                if o["required"] == true || o["optional"] == true {
                    inline = Some(arg[end..].to_owned());
                } else {
                    queue.push_front(format!("-{}", &arg[end..]));
                }
            }
        }
        if option.is_none()
            && arg.starts_with("--")
            && let Some((flag, value)) = arg.split_once('=')
        {
            option = find(flag).filter(|o| o["required"] == true || o["optional"] == true);
            if option.is_some() {
                inline = Some(value.to_owned());
            }
        }
        if let Some(o) = option {
            let key = o["long"].as_str().unwrap().trim_start_matches('-');
            if key == "version" {
                result.version = true;
                return Ok(result);
            }
            let value = if let Some(value) = inline {
                value
            } else if o["required"] == true {
                queue.pop_front().ok_or_else(|| {
                    usage(format!(
                        "error: option '{}' argument missing",
                        o["flags"].as_str().unwrap()
                    ))
                })?
            } else if o["optional"] == true && queue.front().is_some_and(|s| !maybe_option(s)) {
                queue.pop_front().unwrap()
            } else {
                String::new()
            };
            if let Some(choices) = o["choices"].as_array()
                && !choices.iter().any(|c| c == &value)
            {
                // Contract choices are sorted; the retained registration uses this order.
                let choices = if key == "ignore-scope" {
                    "local, tracked, none".to_owned()
                } else {
                    choices
                        .iter()
                        .map(|v| v.as_str().unwrap())
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                return Err(usage(format!(
                    "error: option '{}' argument '{}' is invalid. Allowed choices are {}.",
                    o["flags"].as_str().unwrap(),
                    value,
                    choices
                )));
            }
            if key == "max-depth"
                && (value.is_empty()
                    || !value.bytes().all(|b| b.is_ascii_digit())
                    || !value
                        .parse::<u64>()
                        .is_ok_and(|v| v <= 9_007_199_254_740_991))
            {
                return Err(usage(format!(
                    "error: option '{}' argument '{}' is invalid. --max-depth must be a non-negative safe integer",
                    o["flags"].as_str().unwrap(),
                    value
                )));
            }
            // Args retains explicit negated spellings, but only the last of a dual pair survives.
            let opposite = key
                .strip_prefix("no-")
                .map(str::to_owned)
                .unwrap_or_else(|| format!("no-{key}"));
            result.options.remove(&opposite);
            let values = result.options.entry(key.to_owned()).or_default();
            if o["repeatable"] != true
                && !o["semanticPolicy"]["selector"]["accepts"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v == "repeated"))
            {
                values.clear();
            }
            values.push(value);
        } else {
            unknown |= maybe_option(&arg);
            if unknown {
                result.unknown.push(arg);
            } else {
                result.operands.push(arg);
            }
        }
    }
    Ok(result)
}

pub fn invocation(raw: &[String]) -> Result<Invocation> {
    let contract = contract();
    descend(&contract, "", vec![], raw)
}
fn descend(
    contract: &Value,
    path: &str,
    mut operands: Vec<String>,
    raw: &[String],
) -> Result<Invocation> {
    let commands = contract["commands"].as_array().unwrap();
    let definition = if path.is_empty() {
        &contract["root"]
    } else {
        commands.iter().find(|c| c["path"] == path).unwrap()
    };
    // Implicit help is inspected after option parsing, rather than emitted while scanning.
    let definitions: Vec<Value> = definition["options"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|o| o["long"] != "--help")
        .cloned()
        .collect();
    let mut scan = scan(raw, &definitions)?;
    if scan.version {
        return Ok(Invocation::Output {
            text: format!("{}\n", env!("CARGO_PKG_VERSION")),
            stderr: false,
            code: 0,
        });
    }
    operands.extend(scan.operands);
    let child = |name: &str| {
        commands.iter().find(|c| {
            let candidate = if path.is_empty() {
                name.to_owned()
            } else {
                format!("{path} {name}")
            };
            c["path"] == candidate
                || c["aliasPaths"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|p| p == &candidate))
        })
    };
    if let Some(command) = operands.first().and_then(|name| child(name)) {
        return descend(
            contract,
            command["path"].as_str().unwrap(),
            operands[1..].to_vec(),
            &scan.unknown,
        );
    }
    let has_children = commands.iter().any(|c| {
        c["path"]
            .as_str()
            .unwrap()
            .rsplit_once(' ')
            .map_or(path.is_empty(), |(parent, _)| parent == path)
    });
    if has_children && operands.first().is_some_and(|s| s == "help") {
        return Ok(if let Some(name) = operands.get(1) {
            child(name).map_or_else(
                || help(path, true),
                |c| help(c["path"].as_str().unwrap(), false),
            )
        } else {
            help(path, false)
        });
    }
    if path == "completion __query" {
        operands.extend(scan.unknown);
        if operands.is_empty() {
            return Err(usage("error: missing required argument 'cursor'"));
        }
        return Ok(Invocation::Command(Args {
            command: path.to_owned(),
            options: scan.options,
            positional: operands,
        }));
    }
    if scan.unknown.iter().any(|s| s == "--help" || s == "-h") {
        return Ok(help(path, false));
    }
    // Exec deliberately allows unknown options as child argv. Its domain layer
    // owns missing-command/jobs/workspace error ordering and JSON envelopes.
    if path == "exec" {
        operands.append(&mut scan.unknown);
    }
    if let Some(flag) = scan.unknown.first() {
        let candidates = definition["options"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|o| o["hidden"] != true)
            .filter_map(|o| o["long"].as_str())
            .collect();
        return Err(usage(format!(
            "error: unknown option '{flag}'{}",
            suggest(flag, candidates)
        )));
    }
    if has_children && (path.is_empty() || path == "shell") {
        if let Some(name) = operands.first() {
            let candidates = commands
                .iter()
                .filter(|c| c["hidden"] != true)
                .filter_map(|c| {
                    let p = c["path"].as_str().unwrap();
                    if path.is_empty() {
                        (!p.contains(' ')).then_some(p)
                    } else {
                        p.strip_prefix(&format!("{path} "))
                            .filter(|s| !s.contains(' '))
                    }
                })
                .collect();
            return Err(usage(format!(
                "error: unknown command '{name}'{}",
                suggest(name, candidates)
            )));
        }
        return Ok(help(path, true));
    }
    let arguments = definition["arguments"].as_array().unwrap();
    if path == "completion"
        && let Some(shell) = operands.first()
        && !["bash", "zsh", "fish", "powershell"].contains(&shell.as_str())
    {
        return Err(usage(format!(
            "error: command-argument value '{shell}' is invalid for argument 'shell'. Allowed choices are bash, zsh, fish, powershell."
        )));
    }
    for (i, arg) in arguments.iter().enumerate() {
        if arg["required"] == true && operands.get(i).is_none() {
            return Err(usage(format!(
                "error: missing required argument '{}'",
                arg["name"].as_str().unwrap()
            )));
        }
    }
    // Commander 13 permits excess arguments; actions receive declared arguments only.
    if !arguments.iter().any(|a| a["variadic"] == true) {
        operands.truncate(arguments.len());
    }
    Ok(Invocation::Command(Args {
        command: path.to_owned(),
        options: scan.options,
        positional: operands,
    }))
}

// Optimal string alignment with Commander's distance/similarity cutoffs.
fn suggest(word: &str, candidates: Vec<&str>) -> String {
    if word.starts_with('-') && !word.starts_with("--") {
        return String::new();
    }
    let prefix = if word.starts_with("--") { "--" } else { "" };
    let word: Vec<char> = word.trim_start_matches(prefix).chars().collect();
    let mut best = 3;
    let mut matches = vec![];
    for candidate in candidates {
        let candidate = candidate.strip_prefix(prefix).unwrap_or(candidate);
        let chars: Vec<char> = candidate.chars().collect();
        if chars.len() <= 1 || chars.len().abs_diff(word.len()) > 3 {
            continue;
        }
        let mut d = vec![vec![0; chars.len() + 1]; word.len() + 1];
        for (i, row) in d.iter_mut().enumerate() {
            row[0] = i;
        }
        for (j, cell) in d[0].iter_mut().enumerate() {
            *cell = j;
        }
        for i in 1..=word.len() {
            for j in 1..=chars.len() {
                d[i][j] = (d[i - 1][j] + 1)
                    .min(d[i][j - 1] + 1)
                    .min(d[i - 1][j - 1] + usize::from(word[i - 1] != chars[j - 1]));
                if i > 1 && j > 1 && word[i - 1] == chars[j - 2] && word[i - 2] == chars[j - 1] {
                    d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1);
                }
            }
        }
        let distance = d[word.len()][chars.len()];
        let length = word.len().max(chars.len());
        if distance > best || (length.saturating_sub(distance) as f64 / length as f64) <= 0.4 {
            continue;
        }
        if distance < best {
            matches.clear();
            best = distance;
        }
        matches.push(format!("{prefix}{candidate}"));
    }
    matches.sort();
    matches.dedup();
    match matches.len() {
        0 => String::new(),
        1 => format!("\n(Did you mean {}?)", matches[0]),
        _ => format!("\n(Did you mean one of {}?)", matches.join(", ")),
    }
}

pub fn parse(raw: &[String]) -> Result<Args> {
    match invocation(raw)? {
        Invocation::Command(args) => Ok(args),
        Invocation::Output { .. } => Err(usage("Help/version requested instead of a command")),
    }
}
