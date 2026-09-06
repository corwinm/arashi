use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicUsize, Ordering},
    },
};

static NEXT: AtomicUsize = AtomicUsize::new(0);
static DYNAMIC: Mutex<()> = Mutex::new(());

fn dynamic_guard() -> MutexGuard<'static, ()> {
    DYNAMIC
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct TempDir(PathBuf);
impl TempDir {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "arashi-rust-completion-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn run(cwd: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_arashi"))
        .args(args)
        .current_dir(cwd)
        .env("ARASHI_COMPLETION_TEST_BUDGET_MS", "2000")
        .env("NO_COLOR", "1")
        .output()
        .unwrap()
}

fn generated_oracle(shell: &str) -> Vec<u8> {
    let script = format!(
        "import('./src/generated/completions.ts').then(m=>process.stdout.write(m.GENERATED_COMPLETIONS[{shell:?}]))"
    );
    let output = Command::new("node")
        .args(["-e", &script])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn records(output: &Output) -> Vec<(String, String)> {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    let mut fields = output
        .stdout
        .split(|byte| *byte == 0)
        .map(|field| String::from_utf8(field.to_vec()).unwrap())
        .collect::<Vec<_>>();
    if fields.last().is_some_and(String::is_empty) {
        fields.pop();
    }
    assert_eq!(
        fields.len() % 2,
        0,
        "records must alternate value and description"
    );
    (0..fields.len())
        .step_by(2)
        .map(|index| (fields[index].clone(), fields[index + 1].clone()))
        .collect()
}

fn query(cwd: &Path, cursor: &str, words: &[&str]) -> Output {
    let mut args = vec!["completion", "__query", cursor, "--"];
    args.extend_from_slice(words);
    run(cwd, &args)
}

fn git(cwd: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(["-c", "commit.gpgsign=false", "-c", "maintenance.auto=false"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Completion Test")
        .env("GIT_AUTHOR_EMAIL", "completion@example.test")
        .env("GIT_COMMITTER_NAME", "Completion Test")
        .env("GIT_COMMITTER_EMAIL", "completion@example.test")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn completion_scripts_are_byte_identical_to_retained_typescript() {
    for shell in ["bash", "zsh", "fish", "powershell"] {
        let output = run(
            Path::new(env!("CARGO_MANIFEST_DIR")),
            &["completion", shell],
        );
        assert!(
            output.status.success(),
            "{shell}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stderr.is_empty());
        assert_eq!(output.stdout, generated_oracle(shell), "{shell}");
        assert_eq!(output.stdout.last(), Some(&b'\n'));
    }
}

#[test]
fn completion_errors_are_plain_non_json_and_query_is_hidden() {
    let missing = run(Path::new(env!("CARGO_MANIFEST_DIR")), &["completion"]);
    assert_eq!(missing.status.code(), Some(2));
    assert!(missing.stdout.is_empty());
    assert_eq!(
        String::from_utf8(missing.stderr).unwrap(),
        "[ERR] Missing required shell. Supported shells: bash, zsh, fish, powershell.\n"
    );
    let unsupported = run(
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &["completion", "tcsh"],
    );
    assert_eq!(unsupported.status.code(), Some(2));
    assert!(unsupported.stdout.is_empty());
    assert_eq!(
        String::from_utf8(unsupported.stderr).unwrap(),
        "[ERR] Unsupported shell `tcsh`. Supported shells: bash, zsh, fish, powershell.\n"
    );
    let root_help = run(Path::new(env!("CARGO_MANIFEST_DIR")), &["--help"]);
    let completion_help = run(
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &["completion", "--help"],
    );
    let root_help = String::from_utf8(root_help.stdout).unwrap();
    assert!(root_help.contains("completion"));
    assert!(!root_help.contains("__query"));
    assert!(
        !String::from_utf8(completion_help.stdout)
            .unwrap()
            .contains("__query")
    );
}

#[test]
fn query_completes_static_commands_options_and_choices() {
    let cwd = Path::new(env!("CARGO_MANIFEST_DIR"));
    assert_eq!(
        records(&query(cwd, "2", &["arashi", "completion", "b"])),
        vec![(
            "bash".into(),
            "Shell name (bash, zsh, fish, powershell)".into()
        )]
    );
    assert_eq!(
        records(&query(
            cwd,
            "4",
            &["arashi", "create", "topic", "--conflict", "R"]
        )),
        vec![("REUSE_EXISTING".into(), "Value for --conflict".into())]
    );
    assert_eq!(
        records(&query(cwd, "3", &["arashi", "init", "--ignore-scope", ""])),
        vec![
            ("local".into(), "Value for --ignore-scope".into()),
            ("none".into(), "Value for --ignore-scope".into()),
            ("tracked".into(), "Value for --ignore-scope".into()),
        ]
    );
    let values = records(&query(cwd, "2", &["arashi", "status", "--"]));
    assert!(values.iter().any(|(value, _)| value == "--group"));
    assert!(values.iter().any(|(value, _)| value == "--only"));
}

#[test]
fn query_emits_lossless_configured_repository_group_and_worktree_records() {
    let _guard = dynamic_guard();
    let temp = TempDir::new("dynamic");
    let root = &temp.0;
    git(root, &["init", "--initial-branch=main"]);
    fs::write(root.join("README.md"), "fixture\n").unwrap();
    git(root, &["add", "README.md"]);
    git(root, &["commit", "-m", "fixture"]);
    fs::create_dir(root.join(".arashi")).unwrap();
    let sensitive = "quote'glob*\\tab\tline\nrepo";
    fs::write(
        root.join(".arashi/config.json"),
        r#"{"version":"1.0.0","reposDir":"repos","repos":{"main":{"path":"."},"repo one":{"path":"repos/repo one","groups":[" docs team "]},"quote'glob*\\tab\tline\nrepo":{"path":"repos/odd","groups":["DOCS TEAM"]}}}"#,
    )
    .unwrap();
    #[cfg(not(windows))]
    let linked = temp.0.join("linked, line\nbreak");
    #[cfg(windows)]
    let linked = temp.0.join("linked, line break");
    git(
        root,
        &[
            "worktree",
            "add",
            "-b",
            "feature,one",
            linked.to_str().unwrap(),
        ],
    );

    let repositories = records(&query(
        root,
        "4",
        &["arashi", "create", "topic", "--only", "repo"],
    ));
    assert!(repositories.contains(&("repo one".into(), "Configured repository".into())));
    let all_repositories = records(&query(
        root,
        "4",
        &["arashi", "create", "topic", "--only", ""],
    ));
    assert!(all_repositories.iter().any(|(value, _)| value == sensitive));
    let groups = records(&query(
        root,
        "4",
        &["arashi", "create", "topic", "--group", "docs"],
    ));
    assert_eq!(
        groups,
        vec![("docs team".into(), "Repository group".into())]
    );
    let worktrees = records(&query(root, "2", &["arashi", "remove", ""]));
    assert!(worktrees.iter().any(|(value, _)| value == "feature,one"));
    let linked = fs::canonicalize(&linked)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    #[cfg(windows)]
    let linked = linked
        .strip_prefix(r"\\?\")
        .unwrap_or(&linked)
        .replace('\\', "/");
    assert!(worktrees.iter().any(|(value, _)| value == &linked));
}

#[cfg(not(windows))]
#[test]
fn query_discovers_configured_common_root_workspace_from_linked_worktree() {
    let _guard = dynamic_guard();
    let temp = TempDir::new("common-root");
    let root = &temp.0;
    let bare = root.join("workspace.git");
    let seed = root.join("seed");
    let linked = root.join("linked");
    let primary_repository = bare.join("repos/app");
    let repository = linked.join("repos/app");

    git(root, &["init", "--bare", bare.to_str().unwrap()]);
    git(
        root,
        &["init", "--initial-branch=main", seed.to_str().unwrap()],
    );
    fs::write(seed.join("README.md"), "fixture\n").unwrap();
    git(&seed, &["add", "README.md"]);
    git(&seed, &["commit", "-m", "fixture"]);
    git(&seed, &["remote", "add", "origin", bare.to_str().unwrap()]);
    git(&seed, &["push", "origin", "main"]);
    git(
        root,
        &[
            "--git-dir",
            bare.to_str().unwrap(),
            "worktree",
            "add",
            linked.to_str().unwrap(),
            "main",
        ],
    );
    fs::create_dir(bare.join(".arashi")).unwrap();
    fs::write(
        bare.join(".arashi/config.json"),
        r#"{"repos":{"app":{"groups":["docs"],"path":"repos/app"}},"reposDir":"repos","version":"1.0.0"}"#,
    )
    .unwrap();
    fs::create_dir_all(&primary_repository).unwrap();
    git(&primary_repository, &["init", "--initial-branch=main"]);
    fs::write(primary_repository.join("README.md"), "child fixture\n").unwrap();
    git(&primary_repository, &["add", "README.md"]);
    git(&primary_repository, &["commit", "-m", "child fixture"]);
    fs::create_dir_all(linked.join("repos")).unwrap();
    git(
        &primary_repository,
        &[
            "worktree",
            "add",
            "-b",
            "linked-child",
            repository.to_str().unwrap(),
        ],
    );

    let repositories = records(&query(
        &linked,
        "4",
        &["arashi", "create", "topic", "--only", "a"],
    ));
    assert!(repositories.iter().any(|(value, _)| value == "app"));

    let worktrees = records(&query(
        &linked,
        "4",
        &["arashi", "move", "topic", "--from", ""],
    ));
    let repository = fs::canonicalize(repository)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(worktrees.iter().any(|(value, _)| value == &repository));

    let removable = records(&query(&linked, "3", &["arashi", "remove", "--path", ""]));
    let linked = fs::canonicalize(linked)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(removable.iter().any(|(value, _)| value == &linked));
    assert!(removable.iter().any(|(value, _)| value == &repository));
}

#[cfg(not(windows))]
#[test]
fn query_recovers_configured_non_bare_workspace_from_external_linked_worktree() {
    let _guard = dynamic_guard();
    let temp = TempDir::new("external-linked");
    let main = temp.0.join("main");
    let linked = temp.0.join("external ");
    fs::create_dir(&main).unwrap();
    git(&main, &["init", "--initial-branch=main"]);
    fs::write(main.join("README.md"), "fixture\n").unwrap();
    git(&main, &["add", "README.md"]);
    git(&main, &["commit", "-m", "fixture"]);
    fs::create_dir(main.join(".arashi")).unwrap();
    fs::write(
        main.join(".arashi/config.json"),
        r#"{"repos":{"app":{"path":"repos/app"}},"version":"1.0.0"}"#,
    )
    .unwrap();
    git(
        &main,
        &[
            "worktree",
            "add",
            "-b",
            "external",
            linked.to_str().unwrap(),
        ],
    );
    let app = linked.join("repos/app");
    fs::create_dir_all(&app).unwrap();
    git(&app, &["init"]);
    fs::create_dir(app.join(".worktrees")).unwrap();

    let repositories = records(&query(
        &linked,
        "4",
        &["arashi", "create", "topic", "--only", "a"],
    ));
    assert!(repositories.iter().any(|(value, _)| value == "app"));

    let nested_repositories = records(&query(
        &app,
        "4",
        &["arashi", "create", "topic", "--only", "a"],
    ));
    assert!(nested_repositories.iter().any(|(value, _)| value == "app"));

    let worktrees = records(&query(
        &linked,
        "4",
        &["arashi", "move", "topic", "--from", ""],
    ));
    let linked = fs::canonicalize(linked)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(
        worktrees.iter().any(|(value, _)| value == &linked),
        "{worktrees:?}"
    );
}

#[cfg(not(windows))]
#[test]
fn query_preserves_worktree_paths_and_matches_command_scope_and_forms() {
    let _guard = dynamic_guard();
    let temp = TempDir::new("scope");
    let root = &temp.0;
    let workspace = root.join("workspace");
    let child = workspace.join("repos/child");
    let bare = workspace.join("repos/bare.git");
    let parent_worktree = root.join("parent, line\nbreak");
    let child_worktree = root.join("child-worktree");

    fs::create_dir_all(&workspace).unwrap();
    git(&workspace, &["init", "--initial-branch=main"]);
    fs::write(workspace.join("README.md"), "fixture\n").unwrap();
    git(&workspace, &["add", "README.md"]);
    git(&workspace, &["commit", "-m", "fixture"]);
    fs::create_dir_all(&child).unwrap();
    git(&child, &["init", "--initial-branch=main"]);
    fs::write(child.join("README.md"), "fixture\n").unwrap();
    git(&child, &["add", "README.md"]);
    git(&child, &["commit", "-m", "fixture"]);
    fs::create_dir(&bare).unwrap();
    git(&bare, &["init", "--bare"]);
    fs::create_dir(workspace.join(".arashi")).unwrap();
    fs::write(
        workspace.join(".arashi/config.json"),
        r#"{"repos":{"bare":{"path":"repos/bare.git"},"child":{"path":"repos/child"}},"version":"1.0.0"}"#,
    )
    .unwrap();
    git(
        &workspace,
        &[
            "worktree",
            "add",
            "-b",
            "parent,feature",
            parent_worktree.to_str().unwrap(),
        ],
    );
    git(
        &child,
        &[
            "worktree",
            "add",
            "-b",
            "child-feature",
            child_worktree.to_str().unwrap(),
        ],
    );
    let parent_worktree = fs::canonicalize(parent_worktree).unwrap();
    let child_worktree = fs::canonicalize(child_worktree).unwrap();
    let values = |words: &[&str]| {
        records(&query(&workspace, &(words.len() - 1).to_string(), words))
            .into_iter()
            .map(|(value, _)| value)
            .collect::<Vec<_>>()
    };
    let parent_path = parent_worktree.to_string_lossy().into_owned();
    let child_path = child_worktree.to_string_lossy().into_owned();

    let parent = values(&["arashi", "switch", ""]);
    assert!(parent.contains(&parent_path));
    assert!(!parent.contains(&child_path));
    let children = values(&["arashi", "switch", "--repos", ""]);
    assert!(children.contains(&child_path));
    assert!(!children.contains(&parent_path));
    let all = values(&["arashi", "switch", "--all", ""]);
    assert!(all.contains(&parent_path));
    assert!(all.contains(&child_path));
    assert!(
        !all.contains(
            &fs::canonicalize(&bare)
                .unwrap()
                .to_string_lossy()
                .into_owned()
        )
    );
    assert!(!all.contains(&bare.file_name().unwrap().to_string_lossy().into_owned()));

    let removable = values(&["arashi", "remove", "--path", ""]);
    assert!(removable.contains(&parent_path));
    assert!(removable.contains(&child_path));
    assert!(
        !removable.contains(
            &fs::canonicalize(&workspace)
                .unwrap()
                .to_string_lossy()
                .into_owned()
        )
    );
    assert!(
        !removable.contains(
            &fs::canonicalize(&child)
                .unwrap()
                .to_string_lossy()
                .into_owned()
        )
    );

    let move_references = values(&["arashi", "move", "--from", ""]);
    assert!(move_references.contains(&"parent,feature".to_owned()));
    assert!(move_references.contains(&"child-feature".to_owned()));
    assert!(
        move_references.contains(
            &parent_worktree
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        )
    );
    assert!(move_references.contains(&parent_path));
    assert!(move_references.contains(&child_path));
    assert!(
        !move_references.contains(
            &child_worktree
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        )
    );

    let remove_references = values(&["arashi", "remove", ""]);
    assert!(remove_references.contains(&"parent,feature".to_owned()));
    assert!(remove_references.contains(&"child-feature".to_owned()));
    assert!(remove_references.contains(&child_path));
    assert!(
        !remove_references.contains(
            &child_worktree
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        )
    );

    assert!(values(&["arashi", "switch", "parent,"]).contains(&"parent,feature".to_owned()));
    let path_prefix = &parent_path[..parent_path.len() - 5];
    assert!(values(&["arashi", "switch", "--path", path_prefix]).contains(&parent_path));
}

#[cfg(unix)]
#[test]
fn query_drains_large_git_worktree_output_within_the_budget() {
    use std::os::unix::fs::PermissionsExt;

    let _guard = dynamic_guard();
    let temp = TempDir::new("large-git-output");
    let root = &temp.0;
    fs::create_dir(root.join(".arashi")).unwrap();
    fs::write(
        root.join(".arashi/config.json"),
        r#"{"repos":{},"version":"1.0.0"}"#,
    )
    .unwrap();
    let mut porcelain = Vec::new();
    for index in 0..800 {
        porcelain.extend_from_slice(format!("worktree /tmp/completion-{index}\0").as_bytes());
        porcelain.extend_from_slice(b"HEAD 0000000000000000000000000000000000000000\0");
        porcelain.extend_from_slice(format!("branch refs/heads/topic-{index}\0\0").as_bytes());
    }
    let output_path = root.join("porcelain");
    fs::write(&output_path, porcelain).unwrap();
    let git_path = root.join("git");
    fs::write(
        &git_path,
        "#!/bin/sh\n/bin/cat \"$ARASHI_TEST_PORCELAIN\"\n",
    )
    .unwrap();
    fs::set_permissions(&git_path, fs::Permissions::from_mode(0o755)).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_arashi"))
        .args([
            "completion",
            "__query",
            "2",
            "--",
            "arashi",
            "switch",
            "topic-799",
        ])
        .current_dir(root)
        .env("NO_COLOR", "1")
        .env("ARASHI_COMPLETION_TEST_BUDGET_MS", "1000")
        .env("PATH", format!("{}:/usr/bin:/bin", root.to_string_lossy()))
        .env("ARASHI_TEST_PORCELAIN", output_path)
        .output()
        .unwrap();

    assert!(
        records(&output)
            .iter()
            .any(|(value, _)| value == "topic-799")
    );
}

#[cfg(unix)]
#[test]
fn query_discards_partial_worktree_candidates_after_deadline() {
    use std::os::unix::fs::PermissionsExt;

    let _guard = dynamic_guard();
    let temp = TempDir::new("partial-deadline");
    let root = &temp.0;
    fs::create_dir(root.join(".arashi")).unwrap();
    let repositories = (0..9)
        .map(|index| {
            let name = format!("repo{index}");
            fs::create_dir_all(root.join(&name).join(".git")).unwrap();
            format!(r#""{name}":{{"path":"{name}"}}"#)
        })
        .collect::<Vec<_>>()
        .join(",");
    fs::write(
        root.join(".arashi/config.json"),
        format!(r#"{{"repos":{{{repositories}}},"version":"1.0.0"}}"#),
    )
    .unwrap();
    let git_path = root.join("git");
    fs::write(
        &git_path,
        "#!/bin/sh\nif [ \"$3\" = worktree ]; then\n  case \"$2\" in\n    */repo8) sleep 1; exit 0 ;;\n    *) printf 'worktree %s/wt\\0HEAD 0000000000000000000000000000000000000000\\0branch refs/heads/topic\\0\\0' \"$2\"; exit 0 ;;\n  esac\nfi\nexit 1\n",
    )
    .unwrap();
    fs::set_permissions(&git_path, fs::Permissions::from_mode(0o755)).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_arashi"))
        .args([
            "completion",
            "__query",
            "3",
            "--",
            "arashi",
            "switch",
            "--all",
            "",
        ])
        .current_dir(root)
        .env("NO_COLOR", "1")
        .env("ARASHI_COMPLETION_TEST_BUDGET_MS", "500")
        .env("PATH", format!("{}:/usr/bin:/bin", root.to_string_lossy()))
        .output()
        .unwrap();

    assert!(output.status.success());
    assert!(
        output.stdout.is_empty(),
        "deadline must discard partial candidates"
    );
    assert!(output.stderr.is_empty());
}

#[cfg(unix)]
#[test]
fn query_deadline_is_not_extended_by_descendants_holding_git_stdout() {
    use std::{os::unix::fs::PermissionsExt, time::Instant};

    let _guard = dynamic_guard();
    let temp = TempDir::new("git-descendant-output");
    let root = &temp.0;
    fs::create_dir(root.join(".arashi")).unwrap();
    fs::write(
        root.join(".arashi/config.json"),
        r#"{"repos":{},"version":"1.0.0"}"#,
    )
    .unwrap();
    let git_path = root.join("git");
    fs::write(
        &git_path,
        "#!/usr/bin/python3\nimport os, subprocess\nsubprocess.Popen(['/bin/sh', '-c', 'sleep 2; echo held'], close_fds=False, start_new_session=True)\nos._exit(0)\n",
    )
    .unwrap();
    fs::set_permissions(&git_path, fs::Permissions::from_mode(0o755)).unwrap();
    let started = Instant::now();
    let output = Command::new(env!("CARGO_BIN_EXE_arashi"))
        .args(["completion", "__query", "2", "--", "arashi", "switch", ""])
        .current_dir(root)
        .env("NO_COLOR", "1")
        .env("PATH", format!("{}:/usr/bin:/bin", root.to_string_lossy()))
        .output()
        .unwrap();

    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
}

#[test]
fn query_completes_registered_worktrees_in_an_ordinary_workspace() {
    let _guard = dynamic_guard();
    let temp = TempDir::new("ordinary-worktrees");
    git(&temp.0, &["init", "--initial-branch=main"]);
    fs::write(temp.0.join("README.md"), "fixture\n").unwrap();
    git(&temp.0, &["add", "README.md"]);
    git(&temp.0, &["commit", "-m", "fixture"]);
    fs::create_dir(temp.0.join(".worktrees")).unwrap();
    let linked = temp.0.join(".worktrees/ordinary");
    git(
        &temp.0,
        &[
            "worktree",
            "add",
            "-b",
            "ordinary-branch",
            linked.to_str().unwrap(),
        ],
    );

    assert_eq!(
        records(&query(&temp.0, "2", &["arashi", "remove", "ordinary"])),
        vec![(
            "ordinary-branch".into(),
            format!(
                "{} worktree (ordinary-branch)",
                temp.0.file_name().unwrap().to_string_lossy()
            )
        )]
    );
}

#[test]
fn query_degrades_silently_for_invalid_cursor_or_workspace_state() {
    let _guard = dynamic_guard();
    let temp = TempDir::new("silent");
    for cursor in ["bogus", "-1"] {
        let output = query(
            &temp.0,
            cursor,
            &["arashi", "create", "topic", "--only", "r"],
        );
        assert!(output.status.success());
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());
    }
    fs::create_dir(temp.0.join(".arashi")).unwrap();
    fs::write(temp.0.join(".arashi/config.json"), "{").unwrap();
    let broken = query(&temp.0, "4", &["arashi", "create", "topic", "--only", "r"]);
    assert!(broken.status.success());
    assert!(broken.stdout.is_empty());
    assert!(broken.stderr.is_empty());
    fs::write(
        temp.0.join(".arashi/config.json"),
        vec![b' '; 1024 * 1024 + 1],
    )
    .unwrap();
    let oversized = query(&temp.0, "4", &["arashi", "create", "topic", "--only", "r"]);
    assert!(oversized.status.success());
    assert!(oversized.stdout.is_empty());
    assert!(oversized.stderr.is_empty());
}
