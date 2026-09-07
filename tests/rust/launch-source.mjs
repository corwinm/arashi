import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
// Optional native probe makes every spawn-contract/effect case run against both
// implementations. The retained source modules themselves remain unchanged.
const probe = process.argv[2] ? resolve(process.argv[2]) : null;
const nativeRunner = (detached) => async (command, options) => {
  const out = spawnSync(probe, [detached ? "detached" : "captured", options.cwd, ...command], {
    env: options.env,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(out.error, undefined);
  assert.equal(out.status, 0, out.stderr);
  const [code, stdout, stderr] = out.stdout.split("\n");
  return {
    exitCode: Number(code),
    stdout: Buffer.from(stdout, "hex").toString(),
    stderr: Buffer.from(stderr, "hex").toString(),
  };
};
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
  const missing = join(dir, "absent");
  const captured = [runSwitchProcess, ...(probe ? [nativeRunner(false)] : [])];
  const detached = [runDetachedSwitchProcess, ...(probe ? [nativeRunner(true)] : [])];
  for (const run of captured) {
    assert.deepEqual(await run([missing], { cwd: dir, env: process.env }), {
      exitCode: 1,
      stdout: "",
      stderr: "",
    });
  }
  for (const run of [...captured, ...detached]) {
    assert.deepEqual(await run([process.execPath], { cwd: missing, env: process.env }), {
      exitCode: -1,
      stdout: "",
      stderr: `Working directory not found: ${missing}`,
    });
  }
  for (const run of detached) {
    assert.equal((await run([missing], { cwd: dir, env: process.env })).exitCode, -1);
  }
  if (process.platform === "darwin") {
    const script = join(dir, "no-shebang");
    const shebang = join(dir, "shebang");
    await writeFile(script, 'printf executed > "$1"\n');
    await writeFile(shebang, '#!/bin/sh\nprintf executed > "$1"\n');
    await chmod(script, 0o755);
    await chmod(shebang, 0o755);
    const options = { cwd: dir, env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` } };
    for (const run of [...captured, ...detached]) {
      const marker = join(dir, "marker");
      for (const executable of [script, "no-shebang"]) {
        assert.deepEqual(await run([executable, marker], options), {
          exitCode: -1,
          stdout: "",
          stderr: "spawn ENOEXEC",
        });
        await assert.rejects(access(marker));
      }
      for (const command of [
        ["/bin/sh", script, marker],
        ["shebang", marker],
      ]) {
        assert.equal((await run(command, options)).exitCode, 0);
        assert.equal(await readFile(marker, "utf8"), "executed");
        await rm(marker);
      }
      assert.equal((await run([process.execPath, "-e", "process.exit(0)"], options)).exitCode, 0);
    }
  }
  console.log(
    JSON.stringify({
      detector: true,
      tabUnsupported: true,
      literalArgv: true,
      detachedImmediateFailure: true,
      spawnResultContracts: true,
      darwinExecutionEffects: process.platform === "darwin",
      sourceAndNative: probe !== null,
    }),
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
