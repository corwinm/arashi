import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { executeSwitch } from "../../src/commands/switch.ts";
import { selectSwitchCandidate } from "../../src/core/switch.ts";

test.each(["standalone", "configured"])(
  "switch labels a reused checkout from a linked %s invocation",
  async (mode) => {
    const originalCwd = process.cwd();
    const root = await realpath(await mkdtemp(join(tmpdir(), "switch-label-")));
    const repository = join(root, "workspace");
    const worktrees = mode === "standalone" ? ".worktrees" : ".arashi/worktrees";
    const reused = join(repository, worktrees, "review");
    const git = (args: string[], cwd = repository) =>
      execFileSync("git", args, {
        cwd,
        env: {
          ...process.env,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "commit.gpgsign",
          GIT_CONFIG_VALUE_0: "false",
        },
        stdio: "pipe",
      });
    try {
      await mkdir(repository);
      git(["init", "-b", "main"]);
      git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "base",
      ]);
      if (mode === "configured") {
        await mkdir(join(repository, ".arashi"));
        await writeFile(
          join(repository, ".arashi/config.json"),
          JSON.stringify({
            version: "1.0.0",
            reposDir: "repos",
            repos: {},
            worktreesDir: worktrees,
          }),
        );
      }
      git(["worktree", "add", "-b", "review", reused]);
      git(["switch", "-c", "feature/new"], reused);
      git([
        "worktree",
        "add",
        "-b",
        "feature/matching",
        join(repository, worktrees, "feature/matching"),
      ]);
      process.chdir(reused);
      const result = await executeSwitch(
        undefined,
        {},
        {
          stdinIsTTY: true,
          stdoutIsTTY: true,
          selectSwitchCandidate: (candidates, options) =>
            selectSwitchCandidate(candidates, options, {
              selectPrompt: async (_message, choices) => {
                expect(options.displayRoot).toBe(repository);
                expect(choices.map((choice) => choice.name)).toEqual([
                  "feature/matching",
                  `feature/new - ${worktrees}/review`,
                  "main",
                ]);
                return {
                  status: "ok",
                  value: choices.find((choice) => choice.value.worktreePath === reused)!.value,
                };
              },
            }),
          launchSwitchTarget: async () => ({
            mode: "fallback",
            command: [],
            disposition: "window",
          }),
        },
      );
      expect(result.selected.worktreePath).toBe(reused);
    } finally {
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }
  },
);
