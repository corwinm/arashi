// Retained-source process characterization; fixtures are NOT live vendor acceptance.
// Run: node tests/rust/managed-launch-source.mjs [report.json]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = (await import("node:fs")).realpathSync(
  mkdtempSync(join(tmpdir(), "arashi-managed-source-")),
);
const results = [];
// Positional columns keep the subprocess transcript expectations readable.
// oxlint-disable-next-line max-params
const response = (name, args, stdout = "", code = 0, stderr = "") => ({
  args,
  code,
  name,
  stderr,
  stdout,
});
const git = (...args) => {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const bun = spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim();
assert.ok(bun, "Bun is needed only to execute the retained TypeScript oracle");
try {
  const bin = join(root, "bin");
  const cwd = join(root, "worktree space ' ; $HOME");
  const home = join(root, "home");
  mkdirSync(bin);
  mkdirSync(cwd);
  mkdirSync(home);
  const state = join(root, "state.json");
  const vendor = `#!${process.execPath}\nconst fs=require('node:fs');const s=JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE,'utf8'));const name=require('node:path').basename(process.argv[1]);const args=process.argv.slice(2);s.calls.push({name,args,cwd:process.cwd(),directive:process.env.ARASHI_DIRECTIVE_FILE??null});const next=s.responses.shift();fs.writeFileSync(process.env.FIXTURE_STATE,JSON.stringify(s));if(!next){console.error('unexpected fixture invocation');process.exit(97)};if(next.name!==name||JSON.stringify(next.args)!==JSON.stringify(args)){console.error('unexpected argv '+JSON.stringify({name,args,next}));process.exit(98)};process.stdout.write(next.stdout??'');process.stderr.write(next.stderr??'');process.exit(next.code??0);\n`;
  for (const name of ["tmux", "sesh", "herdr", "cmux", "kitten"]) {
    writeFileSync(join(bin, name), vendor, { mode: 0o700 });
  }
  const source = pathToFileURL(join(repo, "src/lib/switch-launcher.ts")).href;
  const driver = join(root, "probe.ts");
  writeFileSync(
    driver,
    `import { launchSwitchTarget } from ${JSON.stringify(source)};
const input = JSON.parse(process.env.FIXTURE_INPUT!);
try { const result = await launchSwitchTarget(input.candidate,input.options,{env:process.env,platform:process.platform,kittyLockRoot:input.lockRoot}); console.log(JSON.stringify({ok:true,result})); }
catch(e) { console.log(JSON.stringify({ok:false,code:e.code,message:e.message})); }
`,
  );
  const candidate = {
    branchName: "feature",
    herdrSource: { status: "available", path: join(root, "source checkout") },
    repoName: "repo",
    worktreePath: cwd,
  };
  function check(name, options, env, responses, expected, candidateOverride = {}) {
    writeFileSync(state, JSON.stringify({ calls: [], responses }));
    const child = spawnSync(bun, [driver], {
      cwd,
      encoding: "utf8",
      env: {
        PATH: bin + ":/usr/bin:/bin",
        HOME: home,
        FIXTURE_STATE: state,
        ARASHI_DIRECTIVE_FILE: join(root, "caller-directive"),
        FIXTURE_INPUT: JSON.stringify({
          candidate: { ...candidate, ...candidateOverride },
          options,
          lockRoot: join(root, "locks"),
        }),
        ...env,
      },
      timeout: 15000,
    });
    assert.equal(child.status, 0, `${name}: ${child.stderr}`);
    const output = JSON.parse(child.stdout);
    const observed = JSON.parse(readFileSync(state, "utf8"));
    assert.equal(observed.responses.length, 0, `${name}: unconsumed responses`);
    assert.deepEqual(
      observed.calls.map(({ name, args }) => ({ args, name })),
      responses.map(({ name, args }) => ({ args, name })),
      `${name}: exact ordered vendor argv`,
    );
    assert.equal(output.ok, expected, `${name}: ${JSON.stringify(output)}`);
    assert.ok(
      observed.calls.every((c) => c.directive === null),
      `${name}: leaked directive`,
    );
    assert.ok(
      observed.calls.every((c) => c.cwd === cwd),
      `${name}: cwd mismatch`,
    );
    results.push({ calls: observed.calls, name, output });
  }
  for (const disposition of ["window", "tab"]) {
    check(
      `tmux-${disposition}`,
      { disposition, tmux: true },
      { TMUX: "fixture" },
      [response("tmux", ["new-window", "-c", cwd])],
      true,
    );
    check(
      `sesh-${disposition}`,
      { disposition, sesh: true },
      { TMUX: "fixture" },
      [
        response("tmux", [
          "new-window",
          "-c",
          cwd,
          `sesh connect '${cwd.replaceAll("'", String.raw`'\''`)}'`,
        ]),
      ],
      true,
    );
    check(
      `cmux-${disposition}`,
      { disposition },
      { CMUX_WORKSPACE_ID: "caller-workspace" },
      [
        response(
          "cmux",
          ["workspace", "create", "--cwd", cwd, "--focus", "true", "--json"],
          '{"workspace_ref":"workspace:4"}',
        ),
      ],
      true,
    );
  }
  check(
    "tmux-denied-no-fallback",
    { disposition: "tab", tmux: true },
    { TMUX: "fixture" },
    [response("tmux", ["new-window", "-c", cwd], "", 1, "permission denied")],
    false,
  );
  check("tmux-missing-context", { disposition: "window", tmux: true }, {}, [], false);
  const herdrArgs = [
    "worktree",
    "open",
    "--cwd",
    candidate.herdrSource.path,
    "--path",
    cwd,
    "--label",
    "repo: feature",
    "--focus",
    "--json",
  ];
  for (const already of [false, true]) {
    check(
      `herdr-already-open-${already}`,
      { herdr: true, disposition: "window" },
      {},
      [
        response(
          "herdr",
          herdrArgs,
          JSON.stringify({
            result: {
              type: "worktree_opened",
              already_open: already,
              workspace: { workspace_id: "fixture-workspace" },
            },
          }),
        ),
      ],
      true,
    );
  }
  check(
    "herdr-tab",
    { disposition: "tab", herdr: true },
    { HERDR_WORKSPACE_ID: "caller-workspace" },
    [
      response(
        "herdr",
        [
          "tab",
          "create",
          "--workspace",
          "caller-workspace",
          "--cwd",
          cwd,
          "--label",
          "repo: feature",
          "--focus",
          "--json",
        ],
        '{"result":{"tab":{"tab_id":"tab:1","root_pane_id":"pane:1"}}}',
      ),
    ],
    true,
  );
  check(
    "herdr-tab-no-target-no-window-fallback",
    { disposition: "tab", herdr: true },
    {},
    [],
    false,
  );
  check(
    "herdr-invalid-identity",
    { disposition: "window", herdr: true },
    {},
    [
      response(
        "herdr",
        herdrArgs,
        '{"result":{"type":"worktree_opened","already_open":true,"workspace":{"workspace_id":""}}}',
      ),
    ],
    false,
  );
  check(
    "cmux-malformed-no-fallback",
    { disposition: "tab" },
    { CMUX_WORKSPACE_ID: "caller-workspace" },
    [
      response(
        "cmux",
        ["workspace", "create", "--cwd", cwd, "--focus", "true", "--json"],
        "not-json",
      ),
    ],
    false,
  );
  const canonical = (await import("node:fs")).realpathSync(cwd);
  const identity = "arashi-v1-" + createHash("sha256").update(canonical).digest("hex");
  const kittyState = JSON.stringify([
    {
      id: 1,
      tabs: [
        {
          id: 2,
          windows: [
            {
              cwd: canonical,
              id: 3,
              is_focused: true,
              last_focused_at: 1,
              session_name: "repo: feature",
              title: "repo: feature",
              user_vars: { arashi_worktree_id: identity },
            },
          ],
        },
      ],
    },
  ]);
  const version = () => response("kitten", ["--version"], "kitten 0.48.2");
  const inspect = (value) => response("kitten", ["@", "ls"], value);
  for (const disposition of ["window", "tab"]) {
    check(
      `kitty-reuse-${disposition}`,
      { disposition },
      { KITTY_PID: "fixture" },
      [
        version(),
        inspect(kittyState),
        response("kitten", ["@", "focus-window", "--match", "id:3"]),
        inspect(kittyState),
      ],
      true,
    );
    check(
      `kitty-create-${disposition}`,
      { disposition },
      { KITTY_PID: "fixture" },
      [
        version(),
        inspect("[]"),
        response(
          "kitten",
          [
            "@",
            "launch",
            "--type=tab",
            "--cwd",
            canonical,
            "--add-to-session",
            "repo: feature",
            "--var",
            `arashi_worktree_id=${identity}`,
            "--title",
            "repo: feature",
          ],
          "3",
        ),
        response("kitten", ["@", "focus-window", "--match", "id:3"]),
        inspect(kittyState),
      ],
      true,
    );
  }
  check(
    "kitty-denied-no-fallback",
    { disposition: "tab" },
    { KITTY_PID: "fixture" },
    [version(), response("kitten", ["@", "ls"], "", 1, "remote control denied")],
    false,
  );
  const report = {
    kind: "retained-source subprocess protocol fixtures, not live vendor acceptance",
    kittyBlob: git("rev-parse", "HEAD:src/lib/kitty-launcher.ts"),
    passed: results.length,
    results,
    revision: git("rev-parse", "HEAD"),
    sourceBlob: git("rev-parse", "HEAD:src/lib/switch-launcher.ts"),
  };
  if (process.argv[2]) {
    writeFileSync(resolve(process.argv[2]), JSON.stringify(report, null, 2) + "\n");
  }
  console.log(
    JSON.stringify(
      { names: results.map((r) => r.name), passed: report.passed, revision: report.revision },
      null,
      2,
    ),
  );
} finally {
  rmSync(root, { force: true, recursive: true });
}
