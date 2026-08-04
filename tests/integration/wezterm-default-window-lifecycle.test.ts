import { afterEach, describe, expect, test } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { launchSwitchTarget, runDetachedSwitchProcess } from "../../src/lib/switch-launcher.ts";
import { tmpdir } from "os";

const roots: string[] = [];
const childPids: number[] = [];

async function readEventually(path: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

afterEach(async () => {
  for (const pid of childPids.splice(0)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The lifecycle double may already have exited after a failed assertion.
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe.skipIf(process.platform === "win32")("WezTerm default-window process lifecycle", () => {
  test("returns while the independent WezTerm process remains alive and passes data as argv", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi wez'term-"));
    roots.push(root);
    const argvPath = join(root, "launcher.argv");
    const pidPath = join(root, "launcher.pid");
    const fakeWezTerm = join(root, "wezterm");
    await writeFile(
      fakeWezTerm,
      [
        "#!/bin/sh\n",
        'if [ "$1" = "cli" ]; then exit 1; fi\n',
        'printf \'%s\\n\' "$@" > "$ARASHI_TEST_ARGV"\n',
        'printf \'%s\\n\' "$$" > "$ARASHI_TEST_PID"\n',
        "trap 'exit 0' TERM INT\n",
        "sleep 3 & wait\n",
      ].join(""),
    );
    await chmod(fakeWezTerm, 0o755);
    const shell = `/bin/fish' & definitely-not-shell-syntax`;

    const startedAt = Date.now();
    const result = await launchSwitchTarget(
      { branchName: "feature/wezterm", repoName: "fixture", worktreePath: root },
      { disposition: "window" },
      {
        env: {
          ARASHI_TEST_ARGV: argvPath,
          ARASHI_TEST_PID: pidPath,
          PATH: `${root}:${process.env.PATH ?? ""}`,
          SHELL: shell,
          TERM_PROGRAM: "WezTerm",
        },
        platform: process.platform,
      },
    );
    const elapsedMs = Date.now() - startedAt;
    const childPid = Number((await readEventually(pidPath)).trim());
    childPids.push(childPid);

    expect(elapsedMs).toBeLessThan(750);
    expect(result.command).toEqual([
      "wezterm",
      "start",
      "--always-new-process",
      "--cwd",
      root,
      "--",
      shell,
    ]);
    expect(await readEventually(argvPath)).toBe(
      `start\n--always-new-process\n--cwd\n${root}\n--\n${shell}\n`,
    );
    expect(() => process.kill(childPid, 0)).not.toThrow();
  });

  test("reports an immediate nonzero WezTerm startup exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi wezterm-startup-failure-"));
    roots.push(root);
    const fakeWezTerm = join(root, "wezterm");
    await writeFile(
      fakeWezTerm,
      ["#!/bin/sh\n", 'if [ "$1" = "cli" ]; then exit 1; fi\n', "exit 23\n"].join(""),
    );
    await chmod(fakeWezTerm, 0o755);

    await expect(
      runDetachedSwitchProcess([fakeWezTerm, "start", "--always-new-process"], {
        cwd: root,
        env: {},
      }),
    ).resolves.toMatchObject({ exitCode: 23, stderr: expect.stringContaining("during startup") });
  });
});
