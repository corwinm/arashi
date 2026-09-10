import os, pathlib, subprocess, tempfile, json, hashlib, shutil

ROOT = pathlib.Path(__file__).resolve().parents[2]
GIT = shutil.which("git")
NODE = shutil.which("node")
assert GIT and NODE
BIN = pathlib.Path(os.environ["ARASHI_DELETE_BIN"])
results = []


def snap(p):
    return {
        str(f.relative_to(p)): hashlib.sha256(f.read_bytes()).hexdigest()
        for f in p.rglob("*")
        if f.is_file() and not f.is_symlink()
    }


for change in [
    "new-untracked",
    "changed-linked-branch",
    "native-dirty-receipt",
    "source-dirty-receipt",
]:
    with tempfile.TemporaryDirectory(prefix="delete-review-") as td:
        base = pathlib.Path(td).resolve()
        ws = base / "workspace"
        home = base / "home"
        seed = base / "seed"
        origin = base / "origin.git"
        linked = base / "attached"
        for p in [ws, home, seed]:
            p.mkdir()
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        env.update(
            HOME=str(home),
            USERPROFILE=str(home),
            XDG_CONFIG_HOME=str(home / ".config"),
            GIT_CONFIG_GLOBAL=str(home / ".gitconfig"),
            GIT_CONFIG_NOSYSTEM="1",
            GIT_AUTHOR_NAME="Review",
            GIT_AUTHOR_EMAIL="review@example.test",
            GIT_COMMITTER_NAME="Review",
            GIT_COMMITTER_EMAIL="review@example.test",
            GIT_CONFIG_COUNT="2",
            GIT_CONFIG_KEY_0="commit.gpgSign",
            GIT_CONFIG_VALUE_0="false",
            GIT_CONFIG_KEY_1="maintenance.auto",
            GIT_CONFIG_VALUE_1="false",
            NO_COLOR="1",
        )

        def git(cwd, *args):
            p = subprocess.run(
                [GIT, *args], cwd=cwd, env=env, capture_output=True, text=True
            )
            assert p.returncode == 0, (args, p.stderr)
            return p.stdout

        for p in [ws, seed]:
            git(p, "init", "--initial-branch=main")
            (p / "README").write_text("tracked\n")
            git(p, "add", "README")
            git(p, "commit", "-m", "initial")
        git(base, "clone", "--bare", str(seed), str(origin))
        (ws / "repos").mkdir()
        for key in ["api", "keep"]:
            git(ws, "clone", str(origin), "repos/" + key)
        target = ws / "repos/api"
        git(target, "worktree", "add", "-b", "topic", str(linked))
        git(target, "branch", "other", "main")
        (ws / ".arashi").mkdir()
        config = ws / ".arashi/config.json"
        config.write_text(
            json.dumps(
                {
                    "version": "1.0.0",
                    "reposDir": "repos",
                    "worktreesDir": ".arashi/worktrees",
                    "repos": {
                        k: {"path": "repos/" + k, "gitUrl": str(origin)}
                        for k in ["api", "keep"]
                    },
                },
                indent=2,
            )
            + "\n"
        )
        wrapper = base / "bin"
        wrapper.mkdir()
        blocked = base / "receipt-publication-blocked"
        receipts_dir = ws / ".git/.arashi-delete-receipts"
        (wrapper / "git").write_text(
            '#!/bin/sh\ncase " $* " in *" status "*) if [ -d '
            + repr(str(receipts_dir))
            + " ] && ls "
            + repr(str(receipts_dir))
            + "/*.json >/dev/null 2>&1 && [ ! -e "
            + repr(str(blocked))
            + " ]; then : > "
            + repr(str(blocked))
            + "; (while [ -d "
            + repr(str(linked))
            + " ]; do sleep 0.001; done; chmod 500 "
            + repr(str(receipts_dir))
            + ") >/dev/null 2>&1 & fi;; esac\nexec "
            + GIT
            + ' "$@"\n'
        )
        (wrapper / "git").chmod(0o755)
        calls = []

        def run(source, inject=False):
            e = env.copy()
            if inject:
                e["PATH"] = str(wrapper) + os.pathsep + e["PATH"]
            argv = ([NODE, str(ROOT / "src/index.ts")] if source else [str(BIN)]) + [
                "delete",
                "api",
                "--force",
                "--json",
            ]
            p = subprocess.run(
                argv, cwd=ws, env=e, capture_output=True, text=True, timeout=60
            )
            calls.append(
                {
                    "source": source,
                    "injected_failure": inject,
                    "exit": p.returncode,
                    "stdout": p.stdout,
                    "stderr": p.stderr,
                    "target_exists": target.exists(),
                    "linked_exists": linked.exists(),
                }
            )
            return p

        if change in ["native-dirty-receipt", "source-dirty-receipt"]:
            (linked / "original-caller-data").write_text(
                "present BEFORE original delete\n"
            )
            (target / "README").write_text("unstaged primary edit\n")
            (target / ".git/info/exclude").write_text("ignored-data\n")
            (linked / "ignored-data").write_text("ignored loss\n")
            git(linked, "mv", "README", "renamed file")
            (linked / "renamed file").write_text("staged rename and unstaged edit\n")
        first_source = change != "native-dirty-receipt"
        first = run(first_source, True)
        receipts_dir.chmod(0o700)
        assert first.returncode != 0 and target.exists(), calls
        assert not linked.exists(), calls
        receipts = list((ws / ".git/.arashi-delete-receipts").glob("*.json"))
        assert len(receipts) == 1
        original_receipt = json.loads(receipts[0].read_text())
        quarantine = pathlib.Path(
            original_receipt["runtime"]["worktreeQuarantines"][0]["quarantinePath"]
        )
        assert quarantine.exists(), calls
        if change == "new-untracked":
            linked.mkdir()
            (linked / "new-caller-data").write_text(
                "created AFTER original delete failed\n"
            )
        elif change == "changed-linked-branch":
            metadata = pathlib.Path(
                original_receipt["runtime"]["topology"]["linkedWorktrees"][0][
                    "metadataPath"
                ]
            )
            (metadata / "HEAD").write_text("ref: refs/heads/other\n")
        preserved_before = {
            "keep": snap(ws / "repos/keep"),
            "origin": snap(origin),
            "home": snap(home),
            "config": config.read_text(),
        }
        old_target = snap(target)
        old_linked = snap(linked)
        old_quarantine = snap(quarantine)
        source = run(change != "source-dirty-receipt")
        source_preserved = (
            old_target == snap(target)
            and old_linked == snap(linked)
            and old_quarantine == snap(quarantine)
            and config.read_text() == preserved_before["config"]
        )
        native = run(False)
        results.append(
            {
                "case": change,
                "receipt": original_receipt,
                "calls": calls,
                "source_preserved_selected": source_preserved,
                "native_deleted_selected": not target.exists() and not linked.exists(),
                "native_preserved_selected": old_target == snap(target)
                and old_linked == snap(linked)
                and old_quarantine == snap(quarantine)
                and config.read_text() == preserved_before["config"],
                "unselected_origin_home_preserved": all(
                    snap(p) == preserved_before[k]
                    for k, p in [
                        ("keep", ws / "repos/keep"),
                        ("origin", origin),
                        ("home", home),
                    ]
                ),
                "config_after": config.read_text(),
            }
        )
(ROOT / "target/delete-regression-resume.json").write_text(
    json.dumps(results, indent=2) + "\n"
)
for row in results:
    print(
        json.dumps(
            {
                k: v
                for k, v in row.items()
                if k not in ["receipt", "config_after", "calls"]
            }
        ),
        [(c["source"], c["injected_failure"], c["exit"]) for c in row["calls"]],
    )

for row in results:
    assert row["unselected_origin_home_preserved"], row["case"]
    if row["case"] == "new-untracked":
        assert row["source_preserved_selected"] and row["native_preserved_selected"], (
            row["case"]
        )
        assert row["calls"][1]["exit"] != 0 and row["calls"][2]["exit"] != 0, row[
            "case"
        ]
        assert "DELETE_CONCURRENT_CHANGE" in row["calls"][1]["stdout"], row["case"]
        assert any(
            code in row["calls"][2]["stdout"]
            for code in ["DELETE_CONCURRENT_CHANGE", "DELETE_RECEIPT_STALE"]
        ), row["case"]
    elif row["case"] == "changed-linked-branch":
        assert row["calls"][1]["exit"] != 0 and row["calls"][2]["exit"] != 0, row[
            "case"
        ]
        assert not row["native_deleted_selected"], row["case"]
    else:
        assert row["calls"][1]["exit"] == 0 and row["native_deleted_selected"], row[
            "case"
        ]
