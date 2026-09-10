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


for change in ["live-lock-preview"]:
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
        import time

        lock = ws / ".git/.arashi-add.transaction.lock"
        ready = base / "ready"
        holder = subprocess.Popen(
            [
                NODE,
                str(ROOT / "tests/configure-edit/source-lock.mjs"),
                str(lock),
                str(ready),
                "stdin",
            ],
            cwd=ws,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            deadline = time.monotonic() + 10
            while not ready.exists() and time.monotonic() < deadline:
                assert holder.poll() is None
                time.sleep(0.01)
            assert ready.exists()
            before = snap(ws)
            original_lock = lock.read_bytes()
            calls = []
            for source, args in [
                (True, ["--dry-run"]),
                (False, ["--dry-run"]),
                (False, ["--force"]),
            ]:
                argv = (
                    [NODE, str(ROOT / "src/index.ts")] if source else [str(BIN)]
                ) + ["delete", "api", *args, "--json"]
                p = subprocess.Popen(
                    argv,
                    cwd=ws,
                    env=env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                claims = []
                try:
                    stdout, stderr = p.communicate(timeout=10 if source else 3)
                    code = p.returncode
                except subprocess.TimeoutExpired:
                    p.kill()
                    stdout, stderr = p.communicate(timeout=10)
                    code = "timeout-killed"
                    # SIGKILL can interrupt the shared protocol between hardlink
                    # claim creation and unlink. Account only for this dead
                    # contender's proven hardlinks, never ignore caller files.
                    after = snap(ws)
                    added = set(after) - set(before)
                    stat = lock.stat()
                    prefix = (
                        f"{lock.name}.reclaim-{float(stat.st_dev):.0f}-"
                        f"{float(stat.st_ino):.0f}-{p.pid}-"
                    )
                    for relative in added:
                        claim = ws / relative
                        assert claim.parent == lock.parent and claim.name.startswith(
                            prefix
                        ), relative
                        assert (
                            claim.samefile(lock) and claim.read_bytes() == original_lock
                        ), relative
                        claims.append(relative)
                    for relative in claims:
                        (ws / relative).unlink()
                calls.append(
                    {
                        "source": source,
                        "args": args,
                        "exit": code,
                        "stdout": stdout,
                        "stderr": stderr,
                        "killed_contender_claims_cleaned": claims,
                        "workspace_unchanged": snap(ws) == before,
                        "lock_unchanged": lock.read_bytes() == original_lock,
                    }
                )
            results.append({"case": change, "calls": calls})
        finally:
            holder.communicate("release\n", timeout=10)
        assert not lock.exists()
(ROOT / "target/delete-regression-lock.json").write_text(
    json.dumps(results, indent=2) + "\n"
)
for row in results:
    for c in row["calls"]:
        print(
            c["source"],
            c["args"],
            c["exit"],
            c["workspace_unchanged"],
            json.loads(c["stdout"] or "{}").get("error", {}).get("code"),
        )

for row in results:
    assert [c["exit"] for c in row["calls"]] == [0, 0, "timeout-killed"], row
    assert all(
        c["workspace_unchanged"] and c["lock_unchanged"] for c in row["calls"]
    ), row
