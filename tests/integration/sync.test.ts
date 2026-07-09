import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "fs/promises";
import { createRemoveWorkspace } from "../helpers/remove-test-workspace.ts";
import { executeSync } from "../../src/commands/sync.ts";
import { join } from "path";
import { spawn } from "bun";
type RemoveTestWorkspace = Awaited<ReturnType<typeof createRemoveWorkspace>>;

type SyncConfig = {
  repos: Record<string, { path: string } & Record<string, unknown>>;
  sync?: {
    timeoutSeconds?: number;
  };
} & Record<string, unknown>;

const SYNC_TEST_TIMEOUT_MS = 15_000;

describe("sync command - integration", () => {
  let workspace: RemoveTestWorkspace;

  beforeEach(async () => {
    workspace = await createRemoveWorkspace(["repo-a", "repo-b"]);
  }, SYNC_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await workspace.cleanup();
  }, SYNC_TEST_TIMEOUT_MS);

  test(
    "aligns repositories to the parent branch",
    async () => {
      await ensureBranchCheckedOut(workspace.rootPath, "feature-sync");

      for (const repo of workspace.repos) {
        await ensureBranch(repo.path, "feature-sync");
      }

      const summary = await runSync(workspace.rootPath);

      expect(summary.successCount).toBe(2);
      expect(summary.failureCount).toBe(0);

      for (const repo of workspace.repos) {
        const branch = await getCurrentBranch(repo.path);
        expect(branch).toBe("feature-sync");
      }
    },
    SYNC_TEST_TIMEOUT_MS,
  );

  test(
    "creates missing branch from current branch",
    async () => {
      await ensureBranchCheckedOut(workspace.rootPath, "feature-missing");

      await ensureBranch(workspace.repos[0].path, "feature-missing");

      const summary = await runSync(workspace.rootPath);

      expect(summary.successCount).toBe(2);
      expect(summary.failureCount).toBe(0);

      for (const repo of workspace.repos) {
        const branch = await getCurrentBranch(repo.path);
        expect(branch).toBe("feature-missing");
      }

      const createdExists = await branchExists(workspace.repos[1].path, "feature-missing");
      expect(createdExists).toBe(true);
    },
    SYNC_TEST_TIMEOUT_MS,
  );

  test(
    "fails fast on invalid configuration",
    async () => {
      await ensureBranchCheckedOut(workspace.rootPath, "feature-invalid");

      const configPath = join(workspace.rootPath, ".arashi", "config.json");
      await writeFile(configPath, "{ this is not valid json }");

      const originalCwd = process.cwd();
      process.chdir(workspace.rootPath);

      try {
        await expect(executeSync({})).rejects.toBeDefined();
      } finally {
        process.chdir(originalCwd);
      }

      for (const repo of workspace.repos) {
        const branch = await getCurrentBranch(repo.path);
        expect(branch).toBe("main");
      }
    },
    SYNC_TEST_TIMEOUT_MS,
  );

  test(
    "reports timeout per repository and continues",
    async () => {
      await ensureBranchCheckedOut(workspace.rootPath, "feature-timeout");

      await updateConfig(workspace.rootPath, (config) => ({
        ...config,
        sync: {
          timeoutSeconds: 0,
        },
      }));

      const summary = await runSync(workspace.rootPath);

      expect(summary.successCount).toBe(0);
      expect(summary.failureCount).toBe(2);
      expect(summary.results).toHaveLength(2);
      expect(summary.results.every((result) => result.status === "timeout")).toBe(true);
    },
    SYNC_TEST_TIMEOUT_MS,
  );

  test(
    "syncs only the specified repositories",
    async () => {
      await ensureBranchCheckedOut(workspace.rootPath, "feature-only");

      for (const repo of workspace.repos) {
        await ensureBranch(repo.path, "feature-only");
      }

      const summary = await runSync(workspace.rootPath, { only: "repo-a" });

      expect(summary.successCount).toBe(1);
      expect(summary.failureCount).toBe(0);
      expect(summary.results).toHaveLength(1);
      expect(summary.results[0].repositoryName).toBe("repo-a");

      const repoABranch = await getCurrentBranch(workspace.repos[0].path);
      const repoBBranch = await getCurrentBranch(workspace.repos[1].path);
      expect(repoABranch).toBe("feature-only");
      expect(repoBBranch).toBe("main");
    },
    SYNC_TEST_TIMEOUT_MS,
  );

  test(
    "syncs only repositories selected by group",
    async () => {
      await ensureBranchCheckedOut(workspace.rootPath, "feature-group");

      await updateConfig(workspace.rootPath, (config) => ({
        ...config,
        repos: {
          ...config.repos,
          "repo-a": { ...config.repos["repo-a"], groups: ["core"] },
          "repo-b": { ...config.repos["repo-b"], groups: ["docs"] },
        },
      }));

      for (const repo of workspace.repos) {
        await ensureBranch(repo.path, "feature-group");
      }

      const summary = await runSync(workspace.rootPath, { group: "core" });

      expect(summary.successCount).toBe(1);
      expect(summary.failureCount).toBe(0);
      expect(summary.results).toHaveLength(1);
      expect(summary.results[0].repositoryName).toBe("repo-a");

      const repoABranch = await getCurrentBranch(workspace.repos[0].path);
      const repoBBranch = await getCurrentBranch(workspace.repos[1].path);
      expect(repoABranch).toBe("feature-group");
      expect(repoBBranch).toBe("main");
    },
    SYNC_TEST_TIMEOUT_MS,
  );

  test(
    "prints verbose details when enabled",
    async () => {
      await ensureBranchCheckedOut(workspace.rootPath, "feature-verbose");

      for (const repo of workspace.repos) {
        await ensureBranch(repo.path, "feature-verbose");
      }

      const originalLog = console.log;
      let output = "";
      console.log = (message: string) => {
        output += `${message}\n`;
      };

      try {
        await runSync(workspace.rootPath, { verbose: true });
      } finally {
        console.log = originalLog;
      }

      expect(output).toContain("branch=feature-verbose");
    },
    SYNC_TEST_TIMEOUT_MS,
  );

  test(
    "reports summary counts when failures occur",
    async () => {
      await ensureBranchCheckedOut(workspace.rootPath, "feature-summary");

      await updateConfig(workspace.rootPath, (config) => ({
        ...config,
        repos: {
          ...config.repos,
          "repo-b": {
            ...config.repos["repo-b"],
            path: "./repos/missing-repo",
          },
        },
      }));

      const summary = await runSync(workspace.rootPath);

      expect(summary.successCount).toBe(1);
      expect(summary.failureCount).toBe(1);
      expect(summary.results).toHaveLength(2);
      expect(summary.results.some((result) => result.status === "failure")).toBe(true);
    },
    SYNC_TEST_TIMEOUT_MS,
  );
});

async function runSync(
  workspaceRoot: string,
  options?: { group?: string; only?: string; verbose?: boolean },
) {
  const originalCwd = process.cwd();
  process.chdir(workspaceRoot);

  try {
    return await executeSync({
      group: options?.group,
      only: options?.only,
      verbose: options?.verbose,
    });
  } finally {
    process.chdir(originalCwd);
  }
}

async function ensureBranchCheckedOut(repoPath: string, branchName: string): Promise<void> {
  const exists = await branchExists(repoPath, branchName);
  if (!exists) {
    await execGit(["checkout", "-b", branchName], repoPath);
    return;
  }

  await execGit(["checkout", branchName], repoPath);
}

async function ensureBranch(repoPath: string, branchName: string): Promise<void> {
  const exists = await branchExists(repoPath, branchName);
  if (!exists) {
    await execGit(["branch", branchName], repoPath);
  }
}

async function branchExists(repoPath: string, branchName: string): Promise<boolean> {
  const proc = spawn(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], {
    cwd: repoPath,
    stderr: "ignore",
    stdout: "ignore",
  });
  const exitCode = await proc.exited;
  return exitCode === 0;
}

async function getCurrentBranch(repoPath: string): Promise<string> {
  const proc = spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoPath,
    stderr: "pipe",
    stdout: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error("Failed to determine current branch");
  }
  const stdout = await new Response(proc.stdout).text();
  return stdout.trim();
}

async function execGit(args: string[], cwd: string): Promise<void> {
  const proc = spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

async function updateConfig(
  workspaceRoot: string,
  update: (config: SyncConfig) => SyncConfig,
): Promise<void> {
  const configPath = join(workspaceRoot, ".arashi", "config.json");
  const raw = await readFile(configPath, "utf8");
  const config = JSON.parse(raw) as SyncConfig;
  const updated = update(config);
  await writeFile(configPath, JSON.stringify(updated, null, 2));
}
