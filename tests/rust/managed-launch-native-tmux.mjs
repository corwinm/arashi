// Non-disruptive native acceptance: isolated tmux server, no user configuration.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "arashi-mux-")));
const socket = join(root, "server");
const cwd = join(root, "quoted ' space ; $HOME");
mkdirSync(cwd);
const env = { HOME: root, PATH: process.env.PATH, SHELL: "/bin/sh", TERM: "xterm-256color" };
const mux = (...args) =>
  spawnSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env,
    timeout: 10000,
  });
const checked = (...args) => {
  const r = mux(...args);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
try {
  checked("new-session", "-d", "-s", "arashi-fixture", "-c", cwd, "sleep 60");
  const pid = checked("display-message", "-p", "-t", "arashi-fixture", "#{pid}");
  const windows = () =>
    checked(
      "list-windows",
      "-t",
      "arashi-fixture",
      "-F",
      "#{window_id}|#{pane_current_path}",
    ).split("\n");
  assert.equal(windows().length, 1);
  const source = pathToFileURL(join(repo, "src/lib/switch-launcher.ts")).href;
  for (const [index, disposition] of ["window", "tab"].entries()) {
    const code = `import {launchSwitchTarget} from ${JSON.stringify(source)};console.log(JSON.stringify(await launchSwitchTarget({worktreePath:${JSON.stringify(cwd)},repoName:'repo',branchName:'feature'},{tmux:true,disposition:${JSON.stringify(disposition)}},{env:process.env})));`;
    const r = spawnSync("bun", ["-e", code], {
      cwd: repo,
      encoding: "utf8",
      env: { ...env, TMUX: `${socket},${pid},0` },
      timeout: 15000,
    });
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.deepEqual(result.command, ["tmux", "new-window", "-c", cwd]);
    const observed = windows();
    assert.equal(observed.length, index + 2);
    assert.ok(
      observed.every((w) => w.endsWith("|" + cwd)),
      JSON.stringify({ cwd, observed }),
    );
    console.log(JSON.stringify({ disposition, observed, result }));
  }
  console.log(
    "PASS: installed tmux, two source launches create two additional windows; no session reuse/discovery",
  );
} finally {
  mux("kill-server");
  rmSync(root, { force: true, recursive: true });
}
