use serde_json::{Value, json};
use std::process::Command;

#[test]
fn parser_probe() {
    let Ok(raw) = std::env::var("ARASHI_PARSER_PROBE") else {
        return;
    };
    let raw: Vec<String> = serde_json::from_str(&raw).unwrap();
    let args = arashi::parser::parse(&raw).unwrap();
    println!(
        "PROBE:{}",
        json!({"command": args.command, "options": args.options, "positional": args.positional})
    );
}

#[test]
#[ignore = "requires retained TypeScript dependencies and Node"]
fn retained_source_parser_processes() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let report = root.join("target/parser-process-parity.json");
    let output = Command::new("node")
        .arg(root.join("tests/rust/parser-parity.mjs"))
        .arg(env!("CARGO_BIN_EXE_arashi"))
        .arg(report)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
#[ignore = "requires retained TypeScript dependencies and Node"]
fn explicit_values_match_source_in_processes() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let source = std::env::var("ARASHI_TS_SOURCE")
        .unwrap_or_else(|_| root.join("src/index.ts").to_string_lossy().into_owned());
    let program = std::path::Path::new(&source).with_file_name("cli-program.ts");
    let cwd = std::env::temp_dir().join(format!("arashi-parser-values-{}", std::process::id()));
    std::fs::create_dir_all(&cwd).unwrap();
    let script = r#"
const {buildProgram} = await import(process.env.ARASHI_PARSER_PROGRAM);
const program = buildProgram({includeHelpBanner:false});
function visit(command, path) {
 for (const child of command.commands) visit(child, [...path, child.name()]);
 if (!path.length) return;
 command.action(function() {
  const options = {};
  for (const o of this.options) {
   const key = o.attributeName();
   if (this.getOptionValueSource(key) !== 'cli') continue;
   const v = this.opts()[key];
   if (o.negate !== (v === false) && typeof v === 'boolean') continue;
   const name = o.long.slice(2);
   options[name] = v === true || v === false ? [''] : Array.isArray(v) ? v.map(String) : [String(v)];
  }
  console.log('PROBE:' + JSON.stringify({command:path.join(' '), options, positional:this.processedArgs.flat()}));
 });
}
visit(program, []);
program.parse(JSON.parse(process.env.ARASHI_PARSER_PROBE), {from:'user'});
"#;
    let cases = [
        vec![
            "create",
            "branch",
            "--base",
            "first",
            "--base=last",
            "--no-launch",
            "--launch",
            "-ngdocs",
            "-oone",
            "--only",
            "two",
        ],
        vec![
            "create",
            "branch",
            "--launch",
            "--no-launch",
            "--no-hooks",
            "--repo-base",
            "one=main",
            "--repo-base",
            "two=main",
        ],
        vec!["status", "-jvs", "--only=-flag", "--only", "last"],
        vec!["handoff", "--todo", "one", "--todo=two", "--risk", "-flag"],
        vec!["shell", "init", "bash"],
        vec!["install", "-j", "--", "--help"],
        vec!["create", "branch", "--base", "-flag"],
    ];
    let mut evidence = vec![];
    for args in cases {
        let raw = serde_json::to_string(&args).unwrap();
        let native = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "parser_probe", "--nocapture"])
            .env("ARASHI_PARSER_PROBE", &raw)
            .current_dir(&cwd)
            .output()
            .unwrap();
        let source = Command::new("node")
            .args(["--input-type=module", "-e", script])
            .env("ARASHI_PARSER_PROGRAM", &program)
            .env("ARASHI_PARSER_PROBE", &raw)
            .env("NO_COLOR", "1")
            .current_dir(&cwd)
            .output()
            .unwrap();
        assert!(
            native.status.success(),
            "{:?}: {}",
            args,
            String::from_utf8_lossy(&native.stdout)
        );
        assert!(
            source.status.success(),
            "{:?}: {}",
            args,
            String::from_utf8_lossy(&source.stderr)
        );
        let decode = |bytes: &[u8]| -> Value {
            let text = String::from_utf8_lossy(bytes);
            serde_json::from_str(text.lines().find_map(|l| l.strip_prefix("PROBE:")).unwrap())
                .unwrap()
        };
        let actual = decode(&native.stdout);
        let expected = decode(&source.stdout);
        evidence.push(json!({"args":args,"actual":actual,"expected":expected}));
        std::fs::write(
            root.join("target/parser-values.json"),
            serde_json::to_vec_pretty(&evidence).unwrap(),
        )
        .unwrap();
        assert_eq!(actual, expected, "{args:?}");
    }
    std::fs::remove_dir_all(cwd).unwrap();
}
