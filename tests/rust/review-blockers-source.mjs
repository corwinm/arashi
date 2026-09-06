import assert from "node:assert/strict";
import { detectIntegratedIde, detectManagedSwitchContext } from "../../src/lib/switch-launcher.ts";
import { resolveSwitchResolution } from "../../src/commands/switch.ts";
import { resolveConfiguredBaseBranch } from "../../src/lib/base-branch-policy.ts";

const cases = [
  [{ TERM_PROGRAM: "cursor" }, "cursor"],
  [{ TERM_PROGRAM: "Kiro" }, "kiro"],
  [{ TERM_PROGRAM_VERSION: "Cursor 1" }, "cursor"],
  [{ VSCODE_GIT_ASKPASS_NODE: "/Applications/Kiro/node" }, "kiro"],
  [{ VSCODE_GIT_ASKPASS_EXTRA_ARGS: "Cursor" }, "cursor"],
  [{ VSCODE_GIT_IPC_HANDLE: "/tmp/kiro.sock" }, "kiro"],
  [{ VSCODE_PID: "" }, "vscode"],
  [{ VSCODE_GIT_IPC_HANDLE: "" }, "vscode"],
  [{ TERM_PROGRAM: "vscode" }, "vscode"],
  [{ TERM_PROGRAM: " VSCode " }, null],
  [{ TERM_PROGRAM: "VSCODE" }, null],
  [{ TERM_PROGRAM_VERSION: " ", VSCODE_GIT_ASKPASS_NODE: "" }, null],
  [{ TERM_PROGRAM: "kiro", VSCODE_GIT_ASKPASS_EXTRA_ARGS: "CURSOR" }, "cursor"],
];
for (const [env, expected] of cases) {
  assert.equal(detectIntegratedIde(env), expected);
  const managed = detectManagedSwitchContext(env);
  assert.equal(managed, expected);
  const resolve = (options = {}, configMode = "auto") =>
    resolveSwitchResolution({
      configMode,
      options,
      managedContextActive: managed !== null,
      shellIntegrationActive: true,
    }).behavior.mode;
  assert.equal(resolve(), expected ? "launch" : "cd");
  assert.equal(resolve({ cd: true }), "cd");
  assert.equal(resolve({}, "cd"), "cd");
}
assert.equal(detectManagedSwitchContext({ TERM_PROGRAM: "cursor", TMUX: "session" }), "tmux");
assert.equal(detectManagedSwitchContext({ TERM_PROGRAM: "cursor", HERDR_ENV: "1" }), "herdr");
assert.equal(
  detectManagedSwitchContext({ TERM_PROGRAM: "cursor", CMUX_SURFACE_ID: "surface" }),
  "cmux",
);
assert.equal(detectManagedSwitchContext({ TERM_PROGRAM: "cursor", KITTY_PID: "1" }), "cursor");
for (const [baseBranch, expected] of [
  ["origin/develop", "develop"],
  ["origin/origin/develop", "origin/develop"],
  ["upstream/develop", "upstream/develop"],
]) {
  const config = { baseBranch, repos: { api: {} } };
  assert.deepEqual(
    resolveConfiguredBaseBranch(config, { kind: "child", identity: "api", repositoryName: "api" }),
    { requestedBranch: expected, source: "workspace-config" },
  );
  assert.equal(config.baseBranch, baseBranch);
}
console.log(
  `Retained TS: ${cases.length} IDE/resolution cases, 4 managed precedence cases, 3 inherited-base cases passed; no launcher executed.`,
);
