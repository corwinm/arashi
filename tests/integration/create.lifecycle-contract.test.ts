import { afterEach, describe, expect, test } from "vitest";
import { access, chmod, copyFile, readFile, realpath, writeFile } from "fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "path";
import { createChildHookWorkspace } from "../helpers/create-child-hook-workspace.ts";
import { runtime } from "../helpers/node-runtime.ts";

const CLI_ENTRY = join(import.meta.dirname, "../../src/index.ts");
type Workspace = Awaited<ReturnType<typeof createChildHookWorkspace>>;
let workspace: Workspace | null = null;

const arashi = async (cwd: string, args: string[]) => {
  const proc = runtime.spawn([process.execPath, CLI_ENTRY, ...args], {
    cwd,
    env: { ...process.env, HOME: "/private/tmp/arashi-focused-empty-home" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr, stdout };
};

const arashiPty = (cwd: string, prompt: string, response: string, args: string[]) =>
  spawnSync(
    "python3",
    [
      join(import.meta.dirname, "../helpers/pty-command.py"),
      cwd,
      prompt,
      response,
      "15",
      JSON.stringify([process.execPath, CLI_ENTRY, ...args]),
    ],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, HOME: "/private/tmp/arashi-focused-empty-home", NO_COLOR: "1" },
    },
  );

const activate = async (example: string, active: string, addition: string) => {
  const content = await readFile(example, "utf8");
  await writeFile(active, content.replace("exit 0\n", `${addition}\nexit 0\n`));
  await chmod(active, 0o755);
};

afterEach(async () => {
  await workspace?.cleanup();
  workspace = null;
});

describe("configured create lifecycle contract", () => {
  test("rejects every invalid timeout before branch or worktree mutation with structured JSON", async () => {
    workspace = await createChildHookWorkspace();
    const configPath = join(workspace.workspacePath, ".arashi", "config.json");
    const baseConfig = JSON.parse(await readFile(configPath, "utf8"));
    for (const [index, timeout] of [0, -1, 1.5, "300000", 2_147_483_648].entries()) {
      const branch = `feature/invalid-timeout-${index}`;
      await writeFile(configPath, JSON.stringify({ ...baseConfig, hooks: { timeout } }));
      const result = await arashi(workspace.workspacePath, ["create", branch, "--json"]);
      expect(result.exitCode).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "CONFIG_VALIDATION_ERROR",
          details: { errors: [expect.stringMatching(/hooks\.timeout.*integer.*2147483647/i)] },
        },
      });
      for (const repositoryPath of [
        workspace.workspacePath,
        ...Object.values(workspace.childRepoPaths),
      ]) {
        const proc = runtime.spawn(["git", "branch", "--list", branch], {
          cwd: repositoryPath,
          stderr: "pipe",
          stdout: "pipe",
        });
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        expect(stdout.trim()).toBe("");
      }
    }
  });

  test("activated init workspace examples receive untargeted context and bracket mutation", async () => {
    workspace = await createChildHookWorkspace();
    expect((await arashi(workspace.workspacePath, ["init", "--force", "--json"])).exitCode).toBe(0);
    const hooks = join(workspace.workspacePath, ".arashi", "hooks");
    const pre = join(hooks, "pre-create.sh");
    const post = join(hooks, "post-create.sh");
    const marker = join(workspace.workspacePath, ".arashi", "workspace-create-order.log");
    const branch = "feature/generated-contract";
    await activate(
      join(hooks, "pre-create.sh.example"),
      pre,
      `test "$PWD" = "$ARASHI_MAIN_REPO_PATH"
test "$ARASHI_HOOK_INPUT" = disabled
test -z "\${ARASHI_HOOK_TARGET_REPOSITORY+x}"
test -z "\${ARASHI_WORKTREE_PATH+x}"
if git -C "$ARASHI_MAIN_REPO_PATH/repos/alpha" show-ref --verify --quiet "refs/heads/$ARASHI_BRANCH_NAME"; then exit 41; fi
printf 'pre:%s\\n' "$ARASHI_BRANCH_NAME" >> "${marker}"`,
    );
    await activate(
      join(hooks, "post-create.sh.example"),
      post,
      `test "$PWD" = "$ARASHI_HOOK_EXECUTION_PATH"
test -d "${workspace.getChildWorktreePath("alpha", branch)}"
printf 'post:%s\\n' "$ARASHI_BRANCH_NAME" >> "${marker}"`,
    );

    const result = await arashi(workspace.workspacePath, [
      "create",
      branch,
      "--no-progress",
      "--json",
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(await readFile(marker, "utf8")).toBe(`pre:${branch}\npost:${branch}\n`);
    expect(envelope.data.hookOutcomes[0]).toMatchObject({
      executionPath: await realpath(workspace.workspacePath),
      hookName: "pre-create",
      hookStatus: "success",
      repositoryId: "workspace",
      scope: "workspace",
      targetRepositoryName: null,
      targetRepositoryPath: null,
      targetWorktreePath: null,
      workspaceMode: "configured",
    });
    expect(envelope.data.hookOutcomes.at(-1)).toMatchObject({
      hookName: "post-create",
      hookStatus: "success",
      repositoryId: "workspace",
    });
  });

  test("workspace post-create failure uses the error ledger and rolls back owned worktrees", async () => {
    workspace = await createChildHookWorkspace();
    expect((await arashi(workspace.workspacePath, ["init", "--force", "--json"])).exitCode).toBe(0);
    const hooks = join(workspace.workspacePath, ".arashi", "hooks");
    await copyFile(join(hooks, "post-create.sh.example"), join(hooks, "post-create.sh"));
    await writeFile(join(hooks, "post-create.sh"), "#!/bin/sh\nexit 37\n");
    await chmod(join(hooks, "post-create.sh"), 0o755);
    const branch = "feature/generated-rollback";

    const result = await arashi(workspace.workspacePath, [
      "create",
      branch,
      "--no-progress",
      "--json",
    ]);
    expect(result.exitCode).not.toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "CREATE_FAILED",
        details: { rolledBack: true },
      },
    });
    expect(envelope.error.details.hookOutcomes.at(-1)).toMatchObject({
      hookName: "post-create",
      hookStatus: "failure",
      reasonCode: "exit_non_zero",
      scope: "workspace",
    });
    await expect(access(workspace.getMainWorktreePath(branch))).rejects.toThrow();
    for (const repoName of workspace.childRepoNames) {
      await expect(access(workspace.getChildWorktreePath(repoName, branch))).rejects.toThrow();
    }
  });

  test.runIf(process.platform !== "win32")(
    "times out an interactive hook waiting for input, kills it, and leaves no create artifacts",
    async () => {
      workspace = await createChildHookWorkspace({ hookTimeoutMs: 750 });
      const hooks = join(workspace.workspacePath, ".arashi", "hooks");
      const pidFile = join(workspace.workspacePath, ".arashi", "timeout-hook.pid");
      const hook = join(hooks, "pre-create.sh");
      await writeFile(
        hook,
        `#!/bin/sh\nprintf 'timeout prompt: '\nprintf '%s' "$$" > "${pidFile}"\nIFS= read -r answer\n`,
      );
      await chmod(hook, 0o755);
      const branch = "feature/interactive-timeout";

      const result = arashiPty(workspace.workspacePath, "timeout prompt:", "__NO_INPUT__", [
        "create",
        branch,
        "--no-progress",
      ]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/timed out/i);
      const childPid = Number(await readFile(pidFile, "utf8"));
      expect(() => process.kill(childPid, 0)).toThrow();
      await expect(access(workspace.getMainWorktreePath(branch))).rejects.toThrow();
      for (const repoName of workspace.childRepoNames) {
        await expect(access(workspace.getChildWorktreePath(repoName, branch))).rejects.toThrow();
      }
    },
    30_000,
  );

  test.runIf(process.platform !== "win32")(
    "rolls back materialized configured worktrees when Ctrl-C interrupts an interactive post-create hook",
    async () => {
      workspace = await createChildHookWorkspace({ hookTimeoutMs: 5_000 });
      const hooks = join(workspace.workspacePath, ".arashi", "hooks");
      const hook = join(hooks, "post-create.sh");
      await writeFile(hook, "#!/bin/sh\nprintf 'interrupt prompt: '\nIFS= read -r answer\n");
      await chmod(hook, 0o755);
      const branch = "feature/interactive-interrupt";

      const result = arashiPty(workspace.workspacePath, "interrupt prompt:", "__CTRL_C__", [
        "create",
        branch,
        "--no-progress",
      ]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
      await expect(access(workspace.getMainWorktreePath(branch))).rejects.toThrow();
      for (const repoName of workspace.childRepoNames) {
        await expect(access(workspace.getChildWorktreePath(repoName, branch))).rejects.toThrow();
      }
    },
    30_000,
  );
});
