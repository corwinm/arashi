import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectManagedSwitchContext,
  resolveLaunchPlanForOptions,
  runSwitchProcess,
  runDetachedSwitchProcess,
} from "../../src/lib/switch-launcher.ts";
assert.equal(detectManagedSwitchContext({ TMUX: "x", HERDR_ENV: "1", VSCODE_PID: "" }), "tmux");
assert.equal(detectManagedSwitchContext({ VSCODE_PID: "" }), "vscode");
assert.equal(
  resolveLaunchPlanForOptions({ disposition: "tab" }, { TERM_PROGRAM: "Apple_Terminal" }, "darwin")
    .supported,
  false,
);
const dir = await mkdtemp(join(tmpdir(), "arashi-launch-source-"));
try {
  const args = ["", 'a"b', "trailing\\", "%PATH%!^&|() 雪"];
  const result = await runSwitchProcess(
    [
      process.execPath,
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      ...args,
    ],
    { cwd: dir, env: process.env },
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), args);
  const failure = await runDetachedSwitchProcess([process.execPath, "-e", "process.exit(17)"], {
    cwd: dir,
    env: process.env,
  });
  assert.equal(failure.exitCode, 17);
  console.log(
    JSON.stringify({
      detector: true,
      tabUnsupported: true,
      literalArgv: true,
      detachedImmediateFailure: true,
    }),
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
