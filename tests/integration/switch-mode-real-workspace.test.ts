import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { executeSwitch } from "../../src/commands/switch.ts";
import { join } from "path";
import { spawn } from "../helpers/node-runtime.ts";
import { tmpdir } from "os";

interface WorkspaceFixture {
  configPath: string;
  root: string;
  worktreePath: string;
}

interface WorkspaceSnapshot {
  branches: string;
  config: string | null;
  status: string;
  worktrees: string;
}

const roots: string[] = [];
const originalCwd = process.cwd();

async function run(cwd: string, command: string[]): Promise<string> {
  const proc = spawn(command, { cwd, stderr: "pipe", stdout: "pipe" });
  const [exitCode, stderr, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${exitCode}): ${stderr}`);
  }
  return stdout;
}

async function createRepository(config?: Record<string, unknown>): Promise<WorkspaceFixture> {
  const root = await mkdtemp(join(tmpdir(), "arashi switch $safe's "));
  roots.push(root);
  await run(root, ["git", "init", "-b", "main"]);
  await run(root, ["git", "config", "user.email", "test@example.com"]);
  await run(root, ["git", "config", "user.name", "Test User"]);
  await writeFile(join(root, "README.md"), "switch integration fixture\n");

  const configPath = join(root, ".arashi", "config.json");
  if (config) {
    await mkdir(join(root, ".arashi"), { recursive: true });
    await writeFile(configPath, JSON.stringify(config, null, 2));
  }

  await run(root, ["git", "add", "."]);
  await run(root, ["git", "commit", "-m", "initial fixture"]);

  const worktreesDir = config ? join(root, ".arashi", "worktrees") : join(root, ".worktrees");
  await mkdir(worktreesDir, { recursive: true });
  const worktreePath = join(worktreesDir, "review path's $target");
  await run(root, ["git", "worktree", "add", "-b", "feature/safe-switch", worktreePath]);

  return { configPath, root, worktreePath: await realpath(worktreePath) };
}

async function snapshotWorkspace(fixture: WorkspaceFixture): Promise<WorkspaceSnapshot> {
  let config: string | null = null;
  try {
    config = await readFile(fixture.configPath, "utf8");
  } catch {
    // Standalone workspaces intentionally have no configuration file.
  }

  const [branches, status, worktrees] = await Promise.all([
    run(fixture.root, ["git", "branch", "--format=%(refname:short)"]),
    run(fixture.root, ["git", "status", "--porcelain=v1", "--untracked-files=all"]),
    run(fixture.root, ["git", "worktree", "list", "--porcelain"]),
  ]);
  return { branches, config, status, worktrees };
}

function configuredWorkspace(switchDefaults: Record<string, unknown>): Record<string, unknown> {
  return {
    defaults: { switch: switchDefaults },
    repos: {},
    reposDir: "./repos",
    version: "1.0.0",
    worktreesDir: "./.arashi/worktrees",
  };
}

afterEach(async () => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("real workspace switch mode resolution", () => {
  test.each([
    ["unified cd mode", { mode: "cd" }],
    ["accepted legacy auto mode", { launch_mode: "auto", mode: "auto" }],
  ])(
    "loads %s and emits an argv-safe parent-shell directive without mutation",
    async (_name, defaults) => {
      const fixture = await createRepository(configuredWorkspace(defaults));
      const directiveDir = await mkdtemp(join(tmpdir(), "arashi-switch-directive-"));
      roots.push(directiveDir);
      const directivePath = join(directiveDir, "switch directive.sh");
      const before = await snapshotWorkspace(fixture);
      const warning = vi.spyOn(console, "error").mockImplementation(() => {});
      process.chdir(fixture.root);

      const result = await executeSwitch(
        fixture.worktreePath,
        { path: true },
        {
          env: {
            ARASHI_DIRECTIVE_FILE: directivePath,
            ARASHI_SHELL: "bash",
          },
          stdinIsTTY: false,
          stdoutIsTTY: false,
        },
      );

      expect(result.launchMode).toBe("cd");
      expect(result.selected.worktreePath).toBe(fixture.worktreePath);
      expect(await readFile(directivePath, "utf8")).toBe(
        `cd -- '${fixture.worktreePath.replaceAll("'", `'\\''`)}'\n`,
      );
      if ("launch_mode" in defaults) {
        expect(warning).toHaveBeenCalledTimes(1);
        expect(String(warning.mock.calls[0]?.[0])).toContain(
          'defaults.switch.launch_mode is deprecated; use defaults.switch.mode: "auto" instead.',
        );
      } else {
        expect(warning).not.toHaveBeenCalled();
      }
      expect(await snapshotWorkspace(fixture)).toEqual(before);
    },
  );

  test.skipIf(process.platform === "win32")(
    "uses explicit tmux in real configured and standalone workspaces without mutation",
    async () => {
      for (const configured of [true, false]) {
        const fixture = await createRepository(
          configured ? configuredWorkspace({ mode: "cd" }) : undefined,
        );
        const fakeBin = await mkdtemp(join(tmpdir(), "arashi-switch-tmux-bin-"));
        roots.push(fakeBin);
        const argvPath = join(fakeBin, "tmux.argv");
        const tmuxPath = join(fakeBin, "tmux");
        const script = ["#!", "/bin/sh\n", 'printf \'%s\\n\' "$@" > "$ARASHI_TEST_ARGV"\n'].join(
          "",
        );
        await writeFile(tmuxPath, script);
        await chmod(tmuxPath, 0o755);
        const before = await snapshotWorkspace(fixture);
        process.chdir(fixture.root);

        const result = await executeSwitch(
          fixture.worktreePath,
          { path: true, tmux: true },
          {
            env: {
              ARASHI_TEST_ARGV: argvPath,
              PATH: fakeBin,
              TMUX: " /tmp/tmux/client ",
            },
            stdinIsTTY: false,
            stdoutIsTTY: false,
          },
        );

        expect(result.launchMode).toBe("tmux");
        expect(await readFile(argvPath, "utf8")).toBe(`new-window\n-c\n${fixture.worktreePath}\n`);
        if (!configured) {
          await expect(access(fixture.configPath)).rejects.toThrow();
        }
        expect(await snapshotWorkspace(fixture)).toEqual(before);
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "uses automatic launch for a standalone workspace with absent mode via a fake executable",
    async () => {
      const fixture = await createRepository();
      const fakeBin = await mkdtemp(join(tmpdir(), "arashi-switch-bin-"));
      roots.push(fakeBin);
      const argvPath = join(fakeBin, "ghostty.argv");
      const ghosttyPath = join(fakeBin, "ghostty");
      const script = ["#!", "/bin/sh\n", 'printf \'%s\\n\' "$@" > "$ARASHI_TEST_ARGV"\n'].join("");
      await writeFile(ghosttyPath, script);
      await chmod(ghosttyPath, 0o755);
      const before = await snapshotWorkspace(fixture);
      process.chdir(fixture.root);

      const result = await executeSwitch(
        fixture.worktreePath,
        { path: true },
        {
          env: {
            ARASHI_TEST_ARGV: argvPath,
            PATH: fakeBin,
            TERM_PROGRAM: "ghostty",
          },
          platform: "linux",
          stdinIsTTY: false,
          stdoutIsTTY: false,
        },
      );

      expect(result.launchMode).toBe("fallback");
      expect(result.selected.worktreePath).toBe(fixture.worktreePath);
      expect(await readFile(argvPath, "utf8")).toBe(
        `+new-window\n--working-directory\n${fixture.worktreePath}\n-e\n/bin/zsh\n`,
      );
      await expect(access(fixture.configPath)).rejects.toThrow();
      expect(await snapshotWorkspace(fixture)).toEqual(before);
    },
  );
});
