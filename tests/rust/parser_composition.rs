#[test]
fn parser_composes_configured_readers_and_exec_argv() {
    let mut f = Fixture::new();
    f.configured();
    let before = f.coordinated_effects();
    let config = fs::read(f.repo.join(".arashi/config.json")).unwrap();
    for args in [
        vec!["status", "-jvoalpha", "--only", "zulu", "--", "ignored"],
        vec!["setup", "-jjoalpha", "--only", "zulu"],
        vec![
            "handoff",
            "-jj",
            "--link",
            "--help",
            "--todo=one",
            "--todo",
            "two",
        ],
        vec![
            "exec",
            "node",
            "-jjoalpha",
            "--only",
            "zulu",
            "--eval",
            "console.log(JSON.stringify(process.argv.slice(1)))",
        ],
    ] {
        let native = f.run(false, &args);
        assert!(native.status.success(), "{args:?}: {native:?}");
        if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            compare(&f.run(true, &args), &native);
        }
        assert_eq!(before, f.coordinated_effects(), "{args:?}");
        assert_eq!(
            config,
            fs::read(f.repo.join(".arashi/config.json")).unwrap()
        );
        assert!(files(&f.home).is_empty());
    }
    // A value spelled like a rendering flag is not an explicit rendering option.
    let args = ["handoff", "--link", "-j", "--todo", "--help"];
    let native = f.run(false, &args);
    assert!(native.status.success());
    assert!(String::from_utf8_lossy(&native.stdout).contains("-j"));
    if std::env::var_os("ARASHI_TS_PARITY").is_some() {
        let source = f.run(true, &args);
        assert_eq!(source.status.code(), native.status.code());
        assert_eq!(source.stdout, native.stdout);
        assert_eq!(source.stderr, native.stderr);
    }
    assert_eq!(before, f.coordinated_effects());
}

#[test]
fn parser_composes_explicit_create_overrides_and_forced_remove() {
    let mut f = Fixture::new();
    f.configured();
    let config = fs::read(f.repo.join(".arashi/config.json")).unwrap();
    let create = [
        "create",
        "parser-feature",
        "ignored",
        "-jj",
        "--no-launch",
        "--switch",
        "--no-switch",
        "--no-hooks",
    ];
    let remove = ["remove", "parser-feature", "ignored", "-fj"];
    // Create's action-level positive launch override is not last-spelling-wins.
    for flags in [["--launch", "--no-launch"], ["--no-launch", "--launch"]] {
        let before = f.coordinated_effects();
        let args = [
            "create",
            "blocked",
            "-jj",
            "--no-hooks",
            "--no-switch",
            flags[0],
            flags[1],
        ];
        let native = f.run(false, &args);
        assert!(!native.status.success());
        let value: Value = serde_json::from_slice(&native.stdout).unwrap();
        assert_eq!(value["error"]["code"], "JSON_UNSUPPORTED_FOR_MODE");
        if std::env::var_os("ARASHI_TS_PARITY").is_some() {
            compare(&f.run(true, &args), &native);
        }
        assert_eq!(before, f.coordinated_effects());
    }
    for source in [false, true] {
        if source && std::env::var_os("ARASHI_TS_PARITY").is_none() {
            continue;
        }
        let before = f.coordinated_effects();
        let dry: Vec<_> = create.iter().copied().chain(["-n"]).collect();
        let preview = f.run(source, &dry);
        assert!(preview.status.success(), "source={source}: {preview:?}");
        assert_eq!(before, f.coordinated_effects());
        let made = f.run(source, &create);
        assert!(made.status.success(), "source={source}: {made:?}");
        let data: Value = serde_json::from_slice(&made.stdout).unwrap();
        assert_eq!(data["ok"], true);
        for path in [
            &f.repo,
            &f.repo.join("repos/alpha"),
            &f.repo.join("repos/zulu"),
        ] {
            let output = Command::new("git")
                .args(["show-ref", "--verify", "refs/heads/parser-feature"])
                .current_dir(path)
                .output()
                .unwrap();
            assert!(output.status.success());
        }
        let removed = f.run(source, &remove);
        assert!(removed.status.success(), "source={source}: {removed:?}");
        assert_eq!(before, f.coordinated_effects());
        assert_eq!(
            config,
            fs::read(f.repo.join(".arashi/config.json")).unwrap()
        );
        assert!(files(&f.home).is_empty());
    }
}
