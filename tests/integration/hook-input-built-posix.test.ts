import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createChildHookWorkspace } from "../helpers/create-child-hook-workspace.ts";

type Workspace = Awaited<ReturnType<typeof createChildHookWorkspace>>;
interface PtySessionResult {
  durationMs: number;
  exitCode: number;
  reused: boolean;
  stderrBase64: string;
  stdoutBase64: string;
}

const root = join(import.meta.dirname, "../..");
const binary = join(root, "bin", "arashi.bin");
const sessionHelper = join(root, "tests/helpers/pty-session.py");
const workspaces: Workspace[] = [];
const tempRoots: string[] = [];

const decode = (value: string) => Buffer.from(value, "base64").toString("utf8");

async function runBuiltSession(
  workspace: Workspace,
  branch: string,
  prompt: string,
  response: "__CTRL_C__" | "__NO_INPUT__" | string,
): Promise<PtySessionResult> {
  const fixture = await mkdtemp(join(tmpdir(), "arashi-built-hook-input-"));
  tempRoots.push(fixture);
  const resultPath = join(fixture, "result.json");
  const stdoutPath = join(fixture, "stdout.bin");
  const stderrPath = join(fixture, "stderr.bin");
  const result = spawnSync(
    "python3",
    [
      sessionHelper,
      JSON.stringify({
        command: [binary, "create", branch, "--no-progress", "--no-launch"],
        cwd: workspace.workspacePath,
        prompt,
        response,
        resultPath,
        stderrPath,
        stdoutPath,
        timeoutSeconds: 15,
      }),
    ],
    {
      cwd: workspace.workspacePath,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: join(fixture, "home"),
        NO_COLOR: "1",
      },
    },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return JSON.parse(await readFile(resultPath, "utf8"));
}

async function workspaceWithHook(timeout: number, body: string): Promise<Workspace> {
  const workspace = await createChildHookWorkspace({
    childRepoNames: ["alpha"],
    hookTimeoutMs: timeout,
  });
  workspaces.push(workspace);
  const hook = join(workspace.workspacePath, ".arashi", "hooks", "pre-create.sh");
  await writeFile(hook, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(hook, 0o755);
  return workspace;
}

function expectProcessGone(pid: number): void {
  expect(() => process.kill(pid, 0)).toThrow();
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()));
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe.runIf(process.platform !== "win32" && process.env.ARASHI_BUILT_HOOK_ACCEPTANCE === "1")(
  "built POSIX CLI hook-input acceptance",
  () => {
    test("covers refusal, timeout, Ctrl-C, exact stream routing, cleanup, and terminal reuse", async () => {
      const exact = await workspaceWithHook(
        5_000,
        "printf 'OUT-A\\n\\nOUT-B\\n\\n'\nprintf 'ERR-A\\n\\nERR-B\\n\\n' >&2\nprintf 'decision? ' >&2\nIFS= read -r answer\n[ \"$answer\" = yes ]",
      );
      const refused = await runBuiltSession(exact, "feature/refused", "decision?", "no");
      expect(refused.exitCode).not.toBe(0);
      expect(refused.reused).toBe(true);
      const refusedStdout = decode(refused.stdoutBase64);
      const refusedStderr = decode(refused.stderrBase64);
      expect(refusedStdout.match(/OUT-A\n\nOUT-B\n\n/g)).toHaveLength(1);
      expect(refusedStderr.match(/ERR-A\n\nERR-B\n\n/g)).toHaveLength(1);
      expect(refusedStdout).not.toContain("ERR-A");
      expect(refusedStderr).not.toContain("OUT-A");
      await expect(access(exact.getMainWorktreePath("feature/refused"))).rejects.toThrow();

      const timeoutPid = join(exact.workspacePath, ".arashi", "timeout.pid");
      const timeout = await workspaceWithHook(
        500,
        `printf '%s' "$$" > '${timeoutPid}'\nprintf 'timeout? ' >&2\nIFS= read -r answer`,
      );
      const timedOut = await runBuiltSession(
        timeout,
        "feature/timeout",
        "timeout?",
        "__NO_INPUT__",
      );
      expect(timedOut.exitCode).not.toBe(0);
      expect(timedOut.reused).toBe(true);
      expect(timedOut.durationMs).toBeLessThan(5_000);
      expectProcessGone(Number(await readFile(timeoutPid, "utf8")));
      await expect(access(timeout.getMainWorktreePath("feature/timeout"))).rejects.toThrow();

      const interruptPid = join(exact.workspacePath, ".arashi", "interrupt.pid");
      const interrupt = await workspaceWithHook(
        5_000,
        `printf '%s' "$$" > '${interruptPid}'\nprintf 'interrupt? ' >&2\nIFS= read -r answer`,
      );
      const interrupted = await runBuiltSession(
        interrupt,
        "feature/interrupted",
        "interrupt?",
        "__CTRL_C__",
      );
      expect(interrupted.exitCode).not.toBe(0);
      expect(interrupted.reused).toBe(true);
      expectProcessGone(Number(await readFile(interruptPid, "utf8")));
      await expect(access(interrupt.getMainWorktreePath("feature/interrupted"))).rejects.toThrow();
    }, 60_000);
  },
);
