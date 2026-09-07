//! Transport-free retained-source Git fetch identity after Git URL rewrites.
use std::{fs, path::Path};
use url::Url;

type IdentityResult = std::result::Result<String, String>;
fn strip_suffix(path: &str) -> &str {
    let path = path.trim_end_matches('/');
    let path = if path.to_ascii_lowercase().ends_with(".git") {
        &path[..path.len() - 4]
    } else {
        path
    };
    let path = path.trim_end_matches('/');
    if path.is_empty() { "/" } else { path }
}
fn decode(input: &str) -> IdentityResult {
    let bytes = input.as_bytes();
    let mut result = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let pair = bytes
                .get(index + 1..index + 3)
                .ok_or("Malformed percent escape")?;
            let digit = |byte: u8| {
                (byte as char)
                    .to_digit(16)
                    .ok_or("Malformed percent escape")
            };
            result.push(((digit(pair[0])? << 4) | digit(pair[1])?) as u8);
            index += 3;
        } else {
            result.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(result).map_err(|_| "Percent escapes are not valid UTF-8".to_owned())
}
fn local(path: &Path) -> IdentityResult {
    let path = fs::canonicalize(path).map_err(|error| error.to_string())?;
    let text = path.to_str().ok_or("Local fetch path is not UTF-8")?;
    Ok(format!("file:{}", strip_suffix(text)))
}
fn scheme(input: &str) -> Option<(&str, &str)> {
    let (scheme, rest) = input.split_once(':')?;
    if !scheme.as_bytes().first()?.is_ascii_alphabetic()
        || !scheme
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
    {
        return None;
    }
    Some((scheme, rest))
}
/// Match delete-git-url.ts, including its deliberate SCP-before-URL ordering.
/// A Git rewrite has already been resolved in the correct workspace/clone cwd.
pub(super) fn canonicalize(rewritten: &str, cwd: &Path) -> IdentityResult {
    if Path::new(rewritten).is_absolute() {
        return local(Path::new(rewritten));
    }
    let hierarchical = scheme(rewritten).is_some_and(|(_, rest)| rest.starts_with("//"));
    if !hierarchical
        && let Some((authority, path)) = rewritten.split_once(':')
        && !authority.is_empty()
        && !authority.contains('/')
        && !path.is_empty()
    {
        let (user, host) = authority
            .split_once('@')
            .filter(|(user, _)| !user.is_empty())
            .unwrap_or(("", authority));
        if host.is_empty()
            || host
                .chars()
                .any(|c| c.is_whitespace() || matches!(c, '?' | '#'))
        {
            return Err("SCP URL is malformed".to_owned());
        }
        return Ok(format!(
            "ssh://{}{}/{}",
            if user.is_empty() {
                String::new()
            } else {
                format!("{user}@")
            },
            host.to_lowercase(),
            strip_suffix(path)
        ));
    }
    if scheme(rewritten).is_some() {
        let parsed = Url::parse(rewritten).map_err(|error| error.to_string())?;
        if parsed.scheme() == "file" {
            // Node fileURLToPath rejects encoded separators; url::to_file_path
            // alone would decode them and silently identify another local path.
            let lower = parsed.path().to_ascii_lowercase();
            if lower.contains("%2f") || (cfg!(windows) && lower.contains("%5c")) {
                return Err("file URL contains an encoded separator".to_owned());
            }
            decode(parsed.path())?; // Node also rejects malformed escapes/UTF-8.
            let path = parsed.to_file_path().map_err(|_| "file URL is malformed")?;
            return local(&path);
        }
        if parsed.host_str().is_none_or(str::is_empty)
            || parsed
                .password()
                .is_some_and(|password| !password.is_empty())
            || parsed.query().is_some_and(|query| !query.is_empty())
            || parsed
                .fragment()
                .is_some_and(|fragment| !fragment.is_empty())
        {
            return Err("URL is malformed".to_owned());
        }
        let user = decode(parsed.username())?;
        let path = decode(parsed.path())?;
        let path = strip_suffix(&path);
        if path == "/" {
            return Err("URL repository path is unavailable".to_owned());
        }
        Ok(format!(
            "{}://{}{}{}{}{}",
            parsed.scheme().to_lowercase(),
            if user.is_empty() {
                String::new()
            } else {
                format!("{user}@")
            },
            parsed.host_str().unwrap().to_lowercase(),
            parsed
                .port()
                .map(|port| format!(":{port}"))
                .unwrap_or_default(),
            if path.starts_with('/') { "" } else { "/" },
            path
        ))
    } else {
        local(&cwd.join(rewritten))
    }
}
