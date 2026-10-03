import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { executeSwitch } from "../../src/commands/switch.ts";
import { selectSwitchCandidate } from "../../src/core/switch.ts";
import { calculateWorktreePathPlan } from "../../src/core/worktree.ts";

test.each(["branch", "repo-branch"] as const)(
  "keeps path-budgeted %s names concise for parent and child checkouts",
  async (style) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "switch-budget-")));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
      const parent = {
        name: "workspace",
        path: root,
        defaultBranch: "main",
        hasSetupScript: false,
      };
      const child = {
        name: "docs",
        path: join(root, "projects/docs"),
        defaultBranch: "main",
        hasSetupScript: false,
      };
      const base = join(root, ".arashi/worktrees");
      const branch = "feature/a-very-long-generated-branch-name";
      const plan = await calculateWorktreePathPlan(
        [parent, child],
        branch,
        {
          version: "1.0.0",
          reposDir: "projects",
          repos: {},
          worktreesDir: ".arashi/worktrees",
          worktreeNaming: { style, maxPathLength: base.length + 19 + "/projects/docs".length },
        },
        parent,
      );
      const candidates = [parent, child].map((repo) => ({
        repoName: repo.name,
        branchName: branch,
        worktreePath: plan.get(repo)!.path,
      }));
      expect(candidates[0].worktreePath).toMatch(/-[a-f0-9]{8}$/);
      await selectSwitchCandidate(
        candidates,
        {
          interactive: true,
          displayRoot: root,
          worktreesBase: base,
          repositories: [parent, child],
          workspaceRepoName: "workspace",
        },
        {
          selectPrompt: async (_message, choices) => {
            expect(choices.map((choice) => choice.name)).toEqual([branch, `docs (${branch})`]);
            return { status: "ok", value: candidates[0] };
          },
        },
      );
      const changed = { ...candidates[0], branchName: "feature/changed-branch-name" };
      await selectSwitchCandidate(
        [changed, candidates[1]],
        {
          interactive: true,
          displayRoot: root,
          worktreesBase: base,
          repositories: [parent, child],
          workspaceRepoName: "workspace",
        },
        {
          selectPrompt: async (_message, choices) => {
            expect(choices.find((choice) => choice.value === changed)!.name).toContain(
              "feature/changed-branch-name - .arashi/worktrees/",
            );
            return { status: "ok", value: changed };
          },
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
test.each(["standalone", "configured", "tracked-configured", "tracked-repo-prefix"])(
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
      if (mode !== "standalone") {
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
      if (mode.startsWith("tracked")) {
        git(["add", ".arashi/config.json"]);
        git([
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-m",
          "tracked config",
        ]);
      }
      git(["worktree", "add", "-b", "review", reused]);
      git(["switch", "-c", "feature/new"], reused);
      git([
        "worktree",
        "add",
        "-b",
        "feature/matching",
        join(
          repository,
          worktrees,
          mode === "tracked-repo-prefix" ? "workspace-feature/matching" : "feature/matching",
        ),
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
