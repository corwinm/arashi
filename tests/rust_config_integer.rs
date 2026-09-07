use arashi::config::Config;
use serde_json::{Value, json};
use std::{fs, process::Command};

const ACCEPTED: &[(&str, u64)] = &[
    ("1", 1),
    ("1.0", 1),
    ("1000.0", 1000),
    ("1e3", 1000),
    ("10.00e-1", 1),
    ("2147483647", 2_147_483_647),
    ("2147483647.0", 2_147_483_647),
    ("2.147483647e9", 2_147_483_647),
];
const REJECTED: &[&str] = &[
    "0",
    "0.0",
    "-0.0",
    "-1",
    "-1.0",
    "0.5",
    "1.5",
    "2147483647.5",
    "2147483648",
    "2147483648.0",
    "1e30",
    "1e309",
    "NaN",
    "Infinity",
    "\"1000\"",
    "null",
    "true",
    "[]",
    "{}",
];
const FIELDS: &[(&str, &str)] = &[("hooks", "timeout"), ("worktreeNaming", "maxPathLength")];

fn text(section: &str, field: &str, number: &str) -> String {
    format!(
        r#"{{"version":"1.0.0","reposDir":"repos","repos":{{"z":{{"path":"repos/z"}},"a":{{"path":"repos/a"}}}},"sync":{{"timeoutSeconds":0.5}},"{section}":{{"{field}":{number}}}}}"#
    )
}

#[test]
fn loaded_integer_numbers_are_normalized_for_raw_consumers_without_persisting() {
    let fixture = tempfile::tempdir().unwrap();
    fs::create_dir(fixture.path().join(".arashi")).unwrap();
    let path = fixture.path().join(".arashi/config.json");
    for &(section, field) in FIELDS {
        for &(spelling, expected) in ACCEPTED {
            let input = text(section, field, spelling);
            fs::write(&path, &input).unwrap();
            let config = Config::load(fixture.path())
                .unwrap_or_else(|error| panic!("{section}.{field}={spelling}: {error:?}"));
            // This is the access used by execution.rs and hooks.rs, not just validation.
            assert_eq!(config.raw[section][field].as_u64(), Some(expected));
            let original: Value = serde_json::from_str(&input).unwrap();
            assert_eq!(config.persisted, original);
            assert_eq!(
                config.persisted[section][field].is_f64(),
                original[section][field].is_f64()
            );
            assert_eq!(config.repo_order, ["z", "a"]);
            assert_eq!(config.raw["sync"]["timeoutSeconds"], json!(0.5));
            assert_eq!(fs::read_to_string(&path).unwrap(), input);
        }
    }
}

#[test]
fn non_integer_or_out_of_range_values_still_reject_without_persisting() {
    let fixture = tempfile::tempdir().unwrap();
    fs::create_dir(fixture.path().join(".arashi")).unwrap();
    let path = fixture.path().join(".arashi/config.json");
    for &(section, field) in FIELDS {
        for &spelling in REJECTED {
            let input = text(section, field, spelling);
            fs::write(&path, &input).unwrap();
            assert!(Config::load(fixture.path()).is_err(), "{input}");
            assert_eq!(fs::read_to_string(&path).unwrap(), input);
        }
    }
}

#[test]
fn retained_source_characterizes_integer_number_spellings() {
    if std::env::var_os("ARASHI_TS_PARITY").is_none() {
        return;
    }
    let fixture = tempfile::tempdir().unwrap();
    let home = fixture.path().join("home");
    fs::create_dir(&home).unwrap();
    fs::write(home.join("sentinel"), b"unchanged").unwrap();
    let root = fixture.path().join("workspace");
    fs::create_dir_all(root.join(".arashi")).unwrap();
    let cases: Vec<Value> = FIELDS.iter().flat_map(|&(section, field)| {
        ACCEPTED.iter().map(move |&(spelling, expected)| {
            json!({"text":text(section,field,spelling),"section":section,"field":field,"expected":expected})
        }).chain(REJECTED.iter().map(move |&spelling| {
            json!({"text":text(section,field,spelling),"section":section,"field":field,"expected":null})
        }))
    }).collect();
    let cases_path = fixture.path().join("cases.json");
    fs::write(&cases_path, serde_json::to_vec(&cases).unwrap()).unwrap();
    // Import and execute the retained real filesystem loader/JSON parser.
    let script = r#"
import {loadConfig} from './src/lib/config.ts';
import {readFileSync, writeFileSync, readdirSync} from 'node:fs';
const [root,casesPath] = process.argv.slice(-2);
const cases = JSON.parse(readFileSync(casesPath,'utf8'));
for (const c of cases) {
  const path = root + '/.arashi/config.json';
  writeFileSync(path,c.text);
  let loaded;
  try { loaded = await loadConfig(root); }
  catch (error) { if (c.expected !== null) throw error; }
  if (c.expected === null ? loaded !== undefined : loaded?.[c.section]?.[c.field] !== c.expected)
    throw new Error('Source disagreement: ' + c.text);
  if (readFileSync(path,'utf8') !== c.text) throw new Error('Source wrote config');
}
if (JSON.stringify(readdirSync(process.env.HOME)) !== '["sentinel"]' ||
    readFileSync(process.env.HOME + '/sentinel','utf8') !== 'unchanged') throw new Error('HOME changed');
console.log(JSON.stringify({checked:cases.length}));
"#;
    let output = Command::new("bun")
        .args(["--eval", script])
        .arg(&root)
        .arg(&cases_path)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("BUN_RUNTIME_TRANSPILER_CACHE_PATH", "0")
        .output()
        .expect("source parity requires Bun and retained source dependencies");
    assert!(output.status.success(), "{output:?}");
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["checked"], cases.len());
    assert_eq!(fs::read(home.join("sentinel")).unwrap(), b"unchanged");
    assert_eq!(fs::read_dir(&home).unwrap().count(), 1);
}
