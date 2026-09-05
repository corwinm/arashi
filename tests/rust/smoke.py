"""Run a native release journey entirely in a temporary Git repository."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
suffix = ".exe" if os.name == "nt" else ""
binary = root / "target" / "release" / ("arashi" + suffix)
alias = root / "target" / "release" / ("aw" + suffix)
with tempfile.TemporaryDirectory(prefix="arashi-native-smoke-") as scratch:
    cwd = Path(scratch).resolve()
    home = cwd / "home"
    home.mkdir()
    env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home),
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}

    def git(*args):
        return subprocess.check_output(["git", *args], cwd=cwd, env=env, text=True)

    def cli(*args, success=True):
        result = subprocess.run([str(binary), *args, "--json"], cwd=cwd, env=env,
                                text=True, capture_output=True, check=False)
        assert (result.returncode == 0) == success, result.stdout + result.stderr
        value = json.loads(result.stdout)
        assert value["ok"] == success and value["schemaVersion"] == 1
        assert not result.stderr, result.stderr
        return value

    git("init", "-b", "main")
    git("-c", "user.name=Smoke", "-c", "user.email=smoke@example.com",
        "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "seed")
    cli("init", "--zero-config", "--dry-run")
    assert not (cwd / ".worktrees").exists()
    cli("init", "--zero-config")
    cli("create", "feature/smoke", "--no-launch", "--no-switch", "--no-hooks")
    assert len(cli("list")["data"]["worktrees"]) == 2
    assert cli("status")["data"]["summary"]["total"] == 2
    cli("remove", "main", "--force", success=False)
    cli("remove", "feature/smoke", "--force", "--keep-branches")
    assert not (cwd / ".worktrees/feature/smoke").exists()
    assert git("branch", "--list", "feature/smoke").strip()
    cli("create", "stale", "--no-hooks", "--no-launch", "--no-switch")
    shutil.rmtree(cwd / ".worktrees/stale")  # Simulate external loss of this owned scratch worktree.
    assert cli("prune", "--dry-run")["data"]["totalPrunable"] == 1
    assert cli("prune")["data"]["totalPruned"] == 1
    assert git("branch", "--list", "stale").strip()
    assert subprocess.check_output([str(alias), "--version"], text=True).strip() == "2.0.0-alpha.1"
print("Native release smoke journey passed (init/create/list/status/remove/prune/aw).")
