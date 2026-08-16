import { access, readFile } from "fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import {
  branchExists,
  readWorkspaceConfig,
  runArashi,
  runGit,
  writeWorkspaceConfig,
} from "../helpers/inline-hook-test-utils.ts";
import { createChildHookWorkspace } from "../helpers/create-child-hook-workspace.ts";
import { join } from "path";

type Workspace = Awaited<ReturnType<typeof createChildHookWorkspace>>;
let workspace: Workspace | null = null;

const configureInlineCreate = async (
  current: Workspace,
  rootScripts: Record<string, unknown>,
  repositoryScripts: (repositoryName: string) => Record<string, unknown>,
): Promise<void> => {
  const config = await readWorkspaceConfig(current.workspacePath);
  const repos = config.repos as Record<string, Record<string, unknown>>;
  config.hooks = { ...(config.hooks as object), scripts: rootScripts };
  for (const repositoryName of current.childRepoNames) {
    repos[repositoryName] = {
      ...repos[repositoryName],
      hooks: repositoryScripts(repositoryName),
    };
  }
  await writeWorkspaceConfig(current.workspacePath, config);
};

const missing = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
};

afterEach(async () => {
  await workspace?.cleanup();
  workspace = null;
});

describe("configured create inline lifecycle parity RED", () => {
  test.runIf(process.platform !== "win32")(
    "runs workspace once and repositories in selection order at exact materialization boundaries",
    async () => {
      workspace = await createChildHookWorkspace();
      const current = workspace;
      const branch = "feature-inline-create-order";
      const record = join(current.workspacePath, ".arashi", "inline-create-order.log");
      const childPaths = Object.fromEntries(
        current.childRepoNames.map((name) => [name, current.getChildWorktreePath(name, branch)]),
      );
      await configureInlineCreate(
        current,
        {
          "post-create": `test "$PWD" = "$ARASHI_MAIN_REPO_PATH"
test -d '${childPaths.alpha}' && test -d '${childPaths.beta}'
printf 'workspace-post|%s|%s|%s\\n' "$PWD" "$ARASHI_HOOK_NAME" "$ARASHI_HOOK_SCOPE" >> '${record}'`,
          "pre-create": `test "$PWD" = "$ARASHI_MAIN_REPO_PATH"
test ! -e '${workspace.getMainWorktreePath(branch)}'
printf 'workspace-pre|%s|%s|%s\\n' "$PWD" "$ARASHI_HOOK_NAME" "$ARASHI_HOOK_SCOPE" >> '${record}'`,
        },
        (repositoryName) => ({
          "post-create": `test "$PWD" = "$ARASHI_WORKTREE_PATH"
printf '${repositoryName}-post|%s|%s|%s|%s\\n' "$PWD" "$ARASHI_HOOK_NAME" "$ARASHI_REPO_NAME" "$ARASHI_BRANCH_NAME" >> '${record}'`,
          "pre-create": `test -d "$ARASHI_WORKTREE_PATH"
test "$PWD" = "$ARASHI_WORKTREE_PATH"
printf '${repositoryName}-pre|%s|%s|%s|%s\\n' "$PWD" "$ARASHI_HOOK_NAME" "$ARASHI_REPO_NAME" "$ARASHI_BRANCH_NAME" >> '${record}'`,
        }),
      );

      const result = await runArashi(workspace.workspacePath, [
        "create",
        branch,
        "--no-progress",
        "--json",
      ]);

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      const lines = (await readFile(record, "utf8")).trim().split("\n");
      expect(lines.map((line) => line.split("|")[0])).toEqual([
        "workspace-pre",
        "alpha-pre",
        "alpha-post",
        "beta-pre",
        "beta-post",
        "workspace-post",
      ]);
      expect(lines.filter((line) => line.startsWith("workspace-"))).toHaveLength(2);
      for (const repositoryName of workspace.childRepoNames) {
        const repositoryLines = lines.filter((line) => line.startsWith(`${repositoryName}-`));
        expect(repositoryLines).toHaveLength(2);
        expect(
          repositoryLines.every((line) =>
            line.includes(`.${repositoryName}|${repositoryName}|${branch}`),
          ),
        ).toBe(true);
      }
      const envelope = JSON.parse(result.stdout);
      expect(
        envelope.data.hookOutcomes.map((outcome: { hookName: string }) => outcome.hookName),
      ).toEqual([
        "pre-create",
        "pre-create.alpha",
        "post-create.alpha",
        "pre-create.beta",
        "post-create.beta",
        "post-create",
      ]);
    },
  );

  test.runIf(process.platform !== "win32")(
    "retains not-found outcomes for absent locations unrelated to one inline source",
    async () => {
      workspace = await createChildHookWorkspace();
      const branch = "feature-inline-create-complete-ledger";
      await configureInlineCreate(workspace, { "pre-create": "exit 0" }, () => ({}));

      const result = await runArashi(workspace.workspacePath, [
        "create",
        branch,
        "--no-progress",
        "--json",
      ]);

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(
        envelope.data.hookOutcomes.map(
          (outcome: {
            hookName: string;
            hookStatus: string;
            reasonCode: string;
            repositoryId: string;
            scope: string;
            sourceKind: string;
          }) => ({
            hookName: outcome.hookName,
            hookStatus: outcome.hookStatus,
            reasonCode: outcome.reasonCode,
            repositoryId: outcome.repositoryId,
            scope: outcome.scope,
            sourceKind: outcome.sourceKind,
          }),
        ),
      ).toEqual([
        {
          hookName: "pre-create",
          hookStatus: "success",
          reasonCode: "none",
          repositoryId: "workspace",
          scope: "workspace",
          sourceKind: "inline-config",
        },
        ...workspace.childRepoNames.flatMap((repositoryId) =>
          (["pre-create", "post-create"] as const).map((lifecycle) => ({
            hookName: `${lifecycle}.${repositoryId}`,
            hookStatus: "skipped",
            reasonCode: "not_found",
            repositoryId,
            scope: "repository",
            sourceKind: "file",
          })),
        ),
        {
          hookName: "post-create",
          hookStatus: "skipped",
          reasonCode: "not_found",
          repositoryId: "workspace",
          scope: "workspace",
          sourceKind: "file",
        },
      ]);
    },
  );

  test.runIf(process.platform !== "win32")(
    "retains inline post-create failure and pre-existing-branch warnings while rolling back owned worktrees",
    async () => {
      workspace = await createChildHookWorkspace();
      const branch = "feature-inline-create-rollback";
      await runGit(workspace.childRepoPaths.alpha, ["branch", branch]);
      await configureInlineCreate(workspace, {}, (repositoryName) =>
        repositoryName === "beta" ? { "post-create": "printf rollback-canary >&2; exit 23" } : {},
      );

      const result = await runArashi(workspace.workspacePath, [
        "create",
        branch,
        "--no-progress",
        "--conflict",
        "REUSE_EXISTING",
        "--json",
      ]);

      expect(await missing(workspace.getMainWorktreePath(branch))).toBe(true);
      for (const repositoryName of workspace.childRepoNames) {
        expect(await missing(workspace.getChildWorktreePath(repositoryName, branch))).toBe(true);
      }
      expect(await branchExists(workspace.childRepoPaths.alpha, branch)).toBe(true);
      const envelope = JSON.parse(result.stdout);
      expect(result.exitCode).toBe(1);
      expect(envelope).toMatchObject({
        error: { code: "CREATE_FAILED", details: { rolledBack: true } },
        ok: false,
      });
      expect(envelope.error.details.hookOutcomes).toContainEqual(
        expect.objectContaining({
          hookName: "post-create.beta",
          hookStatus: "failure",
          reasonCode: "exit_non_zero",
        }),
      );
      expect(
        envelope.error.details.repositories.find(
          (repository: { repositoryName: string }) => repository.repositoryName === "alpha",
        ).warnings,
      ).not.toEqual([]);
    },
  );

  test.runIf(process.platform !== "win32")(
    "classifies inline timeout and rolls back before final create handling",
    async () => {
      workspace = await createChildHookWorkspace({ hookTimeoutMs: 100 });
      const branch = "feature-inline-create-timeout";
      await configureInlineCreate(workspace, {}, (repositoryName) =>
        repositoryName === "alpha" ? { "post-create": "sleep 2" } : {},
      );

      const result = await runArashi(workspace.workspacePath, [
        "create",
        branch,
        "--no-progress",
        "--json",
      ]);

      expect(await missing(workspace.getMainWorktreePath(branch))).toBe(true);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.error.code).toBe("CREATE_FAILED");
      expect(envelope.error.details.hookOutcomes).toContainEqual(
        expect.objectContaining({
          hookName: "post-create.alpha",
          hookStatus: "failure",
          reasonCode: "timeout",
        }),
      );
    },
  );
});
