use super::*;
fn prefix() -> Vec<(Vec<String>, i32, String)> {
    vec![
        step(
            &[if cfg!(windows) { "where" } else { "which" }, "kitten"],
            0,
            "/fixture/kitten\n",
        ),
        step(&["/fixture/kitten", "--version"], 0, "kitten 0.48.2"),
    ]
}
fn ls(state: &str) -> (Vec<String>, i32, String) {
    step(&["/fixture/kitten", "@", "ls"], 0, state)
}
fn focus(id: u64, code: i32) -> (Vec<String>, i32, String) {
    step(
        &[
            "/fixture/kitten",
            "@",
            "focus-window",
            "--match",
            &format!("id:{id}"),
        ],
        code,
        "",
    )
}
fn window(id: u64, focused: bool, marker: &str) -> serde_json::Value {
    json!({"id":id,"cwd":"$CWD","is_focused":focused,"last_focused_at":0,"session_name":"repo: feature","title":"untrusted title","user_vars":{"arashi_worktree_id":marker}})
}
fn state(windows: Vec<serde_json::Value>) -> String {
    json!([{"id":1,"tabs":[{"id":2,"windows":windows}]}]).to_string()
}
fn launch(out: &str) -> (Vec<String>, i32, String) {
    step(
        &[
            "/fixture/kitten",
            "@",
            "launch",
            "--type=tab",
            "--cwd",
            "$CWD",
            "--add-to-session",
            "repo: feature",
            "--var",
            "arashi_worktree_id=$ID",
            "--title",
            "repo: feature",
        ],
        0,
        out,
    )
}
#[test]
fn kitty_new_session_tab_both_dispositions() {
    for d in [LaunchDisposition::Window, LaunchDisposition::Tab] {
        let mut t = prefix();
        t.extend([
            ls(&state(vec![window(9, true, "other")])),
            launch("42\n"),
            focus(42, 0),
            ls(&state(vec![window(42, true, "$ID")])),
        ]);
        check(ManagedFamily::Kitty, d, &[], t, true);
    }
}
#[test]
fn kitty_focus_and_single_replacement_reconciliation() {
    for first_code in [0, 1] {
        for next in [42, 43] {
            let mut t = prefix();
            t.extend([
                ls(&state(vec![window(42, false, "$ID")])),
                focus(42, first_code),
                ls(&state(vec![window(next, first_code == 0, "$ID")])),
            ]);
            if next == 43 {
                t.extend([focus(43, 0), ls(&state(vec![window(43, true, "$ID")]))]);
            }
            check(
                ManagedFamily::Kitty,
                LaunchDisposition::Tab,
                &[],
                t,
                first_code == 0 || next == 43,
            );
        }
    }
    let mut t = prefix();
    t.extend([
        ls(&state(vec![window(42, false, "$ID")])),
        focus(42, 0),
        ls(&state(vec![window(42, false, "$ID")])),
    ]);
    check(ManagedFamily::Kitty, LaunchDisposition::Tab, &[], t, false);
}
#[test]
fn kitty_disappearing_identity_launches_once() {
    for code in [0, 1] {
        let mut t = prefix();
        t.extend([
            ls(&state(vec![window(42, false, "$ID")])),
            focus(42, code),
            ls("[]"),
            launch("43"),
            focus(43, 0),
            ls(&state(vec![window(43, true, "$ID")])),
        ]);
        check(
            ManagedFamily::Kitty,
            LaunchDisposition::Window,
            &[],
            t,
            true,
        );
    }
}
#[test]
fn kitty_malformed_denied_duplicates_no_fallback() {
    for out in [
        "not-json".into(),
        "{}".into(),
        state(vec![window(42, true, "$ID"), window(43, false, "$ID")]),
    ] {
        let mut t = prefix();
        t.push(ls(&out));
        check(ManagedFamily::Kitty, LaunchDisposition::Tab, &[], t, false);
    }
    for key in [
        "id",
        "cwd",
        "is_focused",
        "last_focused_at",
        "session_name",
        "title",
        "user_vars",
    ] {
        let mut w = window(42, true, "$ID");
        w.as_object_mut().unwrap().remove(key);
        let mut t = prefix();
        t.push(ls(&state(vec![w])));
        check(ManagedFamily::Kitty, LaunchDisposition::Tab, &[], t, false);
    }
    let mut t = prefix();
    t.push(step(&["/fixture/kitten", "@", "ls"], 1, "denied"));
    check(ManagedFamily::Kitty, LaunchDisposition::Tab, &[], t, false);
    for version in ["kitten 0.42.9", "garbage", "kitten 0.4.x"] {
        let mut t = prefix();
        t[1].2 = version.into();
        check(ManagedFamily::Kitty, LaunchDisposition::Tab, &[], t, false);
    }
    for id in ["0", "-1", "42 43", "1e3", "9007199254740992"] {
        let mut t = prefix();
        t.extend([ls("[]"), launch(id)]);
        check(ManagedFamily::Kitty, LaunchDisposition::Tab, &[], t, false);
    }
}
#[test]
fn kitty_validates_launched_session_identity_focus() {
    for key in ["session_name", "is_focused", "user_vars", "id"] {
        let mut w = window(42, true, "$ID");
        w[key] = match key {
            "session_name" => json!("wrong"),
            "is_focused" => json!(false),
            "user_vars" => json!({}),
            _ => json!(43),
        };
        let mut t = prefix();
        t.extend([ls("[]"), launch("42"), focus(42, 0), ls(&state(vec![w]))]);
        check(ManagedFamily::Kitty, LaunchDisposition::Tab, &[], t, false);
    }
}

#[cfg(unix)]
#[test]
fn kitty_canonical_identity_unifies_symlink_aliases() {
    use managed_launch::kitty::metadata;
    use sha2::{Digest, Sha256};
    let root = tempfile::tempdir().unwrap();
    let real = root.path().join("real ' ; $HOME");
    std::fs::create_dir(&real).unwrap();
    let alias = root.path().join("alias");
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    let a = metadata(&target(&real)).unwrap();
    let b = metadata(&target(&alias)).unwrap();
    assert_eq!(a, b);
    assert_eq!(
        a.identity,
        format!(
            "arashi-v1-{:x}",
            Sha256::digest(real.canonicalize().unwrap().to_str().unwrap().as_bytes())
        )
    );
    assert!(metadata(&target(&root.path().join("absent"))).is_err());
}
#[test]
fn kitty_foreground_cwd_projection_and_numeric_boundaries() {
    use managed_launch::kitty::parse_state;
    let mut w = window(42, true, "$ID");
    w["foreground_processes"] = json!([{}, {"cwd":" "},{"cwd":"foreground"}]);
    assert_eq!(
        parse_state(&state(vec![w.clone()])).unwrap()[0].cwd,
        "foreground"
    );
    w["foreground_processes"] = json!([]);
    assert_eq!(parse_state(&state(vec![w.clone()])).unwrap()[0].cwd, "$CWD");
    for (key, v) in [
        ("id", json!(0)),
        ("id", json!(1.5)),
        ("id", json!(9007199254740992_u64)),
        ("last_focused_at", json!(-1)),
        ("last_focused_at", json!("0")),
        ("foreground_processes", json!([{"cwd":2}])),
    ] {
        let mut bad = w.clone();
        bad[key] = v;
        assert!(parse_state(&state(vec![bad])).is_err());
    }
    w["id"] = json!(1.0);
    assert_eq!(parse_state(&state(vec![w])).unwrap()[0].id, 1);
}
