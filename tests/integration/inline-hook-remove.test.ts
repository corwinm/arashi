import { access, chmod, mkdtemp, readFile, realpath, rm } from "fs/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  branchExists,
  readWorkspaceConfig,
  runArashi,
  runGit,
  writeNativeHook,
  writeWorkspaceConfig,
} from "../helpers/inline-hook-test-utils.ts";
import {
  createRemoveWorkspace,
  createWorktreesForBranch,
} from "../helpers/remove-test-workspace.ts";
import { join } from "path";
import { tmpdir } from "os";

type Workspace = Awaited<ReturnType<typeof createRemoveWorkspace>>;
let workspace: Workspace;
let home: string;

const configureInlineRemove = async (
  rootScripts: Record<string, unknown>,
  repositoryScripts: (repositoryName: string) => Record<string, unknown>,
): Promise<void> => {
  const config = await readWorkspaceConfig(workspace.rootPath);
  const repos = config.repos as Record<string, Record<string, unknown>>;
  config.hooks = { scripts: rootScripts, timeout: 2_000 };
  for (const repository of workspace.repos) {
    repos[repository.name] = {
      ...repos[repository.name],
      hooks: repositoryScripts(repository.name),
    };
  }
  await writeWorkspaceConfig(workspace.rootPath, config);
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

beforeEach(async () => {
  workspace = await createRemoveWorkspace(["repo-a", "repo-b"]);
  home = await mkdtemp(join(tmpdir(), "arashi-inline-remove-home-"));
});

afterEach(async () => {
  await workspace.cleanup();
  await rm(home, { force: true, recursive: true });
});

describe("configured remove inline lifecycle parity RED", () => {
  test.runIf(process.platform !== "win32")(
    "composes repository and workspace inline hooks with global files in target/scope order",
    async () => {
      const branch = "feature-inline-remove-order";
      const worktrees = await createWorktreesForBranch(workspace, branch, false);
      const record = join(workspace.rootPath, ".arashi", "inline-remove-order.log");
      const inlineBody = (label: string, expectedCwd: string) =>
        `test "$PWD" = '${expectedCwd}'
printf '${label}|%s|%s|%s|%s\\n' "$ARASHI_REPO_NAME" "$ARASHI_HOOK_SCOPE" "$ARASHI_WORKTREE_PATH" "$ARASHI_BRANCH_NAME" >> '${record}'`;
      await configureInlineRemove(
        {
          "post-remove": inlineBody("workspace-post", workspace.rootPath),
          "pre-remove": inlineBody("workspace-pre", workspace.rootPath),
        },
        (repositoryName) => {
          const repository = workspace.repos.find(
            (candidate) => candidate.name === repositoryName,
          )!;
          return {
            "post-remove": inlineBody("repository-post", repository.path),
            "pre-remove": inlineBody("repository-pre", repository.path),
          };
        },
      );
      for (const lifecycle of ["pre-remove", "post-remove"] as const) {
        for (const repository of workspace.repos) {
          await writeNativeHook(
            join(home, ".arashi", "hooks", repository.name, `${lifecycle}.sh`),
            `printf 'global-targeted-${lifecycle}|%s|%s|%s|%s\\n' "$ARASHI_REPO_NAME" "$ARASHI_HOOK_SCOPE" "$ARASHI_WORKTREE_PATH" "$ARASHI_BRANCH_NAME" >> '${record}'`,
          );
        }
        await writeNativeHook(
          join(home, ".arashi", "hooks", `${lifecycle}.sh`),
          `printf 'global-shared-${lifecycle}|%s|%s|%s|%s\\n' "$ARASHI_REPO_NAME" "$ARASHI_HOOK_SCOPE" "$ARASHI_WORKTREE_PATH" "$ARASHI_BRANCH_NAME" >> '${record}'`,
        );
      }

      const result = await runArashi(
        workspace.rootPath,
        ["remove", branch, "--force", "--json"],
        home,
      );

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      const labels = (await readFile(record, "utf8"))
        .trim()
        .split("\n")
        .map((line) => `${line.split("|")[0]}:${line.split("|")[1]}`);
      expect(labels).toEqual([
        "repository-pre:repo-a",
        "workspace-pre:repo-a",
        "global-targeted-pre-remove:repo-a",
        "global-shared-pre-remove:repo-a",
        "repository-pre:repo-b",
        "workspace-pre:repo-b",
        "global-targeted-pre-remove:repo-b",
        "global-shared-pre-remove:repo-b",
        "repository-post:repo-a",
        "workspace-post:repo-a",
        "global-targeted-post-remove:repo-a",
        "global-shared-post-remove:repo-a",
        "repository-post:repo-b",
        "workspace-post:repo-b",
        "global-targeted-post-remove:repo-b",
        "global-shared-post-remove:repo-b",
      ]);
      expect(labels.filter((label) => label.startsWith("workspace-pre"))).toHaveLength(2);
      expect(labels.filter((label) => label.startsWith("workspace-post"))).toHaveLength(2);
      for (const path of Object.values(worktrees)) {
        expect(await pathExists(path)).toBe(false);
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "previews unavailable inline hooks without fabricating outcomes or mutating targets",
    async () => {
      const branch = "feature-inline-remove-unavailable-preview";
      const worktrees = await createWorktreesForBranch(workspace, branch, false);
      const snippet = "echo preview-private-payload";
      await configureInlineRemove({ "pre-remove": { cmd: snippet } }, () => ({}));

      const result = await runArashi(
        workspace.rootPath,
        ["remove", branch, "--dry-run", "--json"],
        home,
      );

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.data.hookOutcomes).toEqual([]);
      expect(envelope.data.hooks).toEqual(
        expect.arrayContaining(
          workspace.repos.map((repository) =>
            expect.objectContaining({
              availability: "unavailable",
              hookName: "pre-remove",
              reasonCode: "interpreter_unavailable",
              repository: repository.name,
              scope: "workspace",
              selectedInterpreter: null,
              sourceKind: "inline-config",
              sourceOwnerKind: "workspace",
              sourceOwnerName: null,
              sourceScriptPath: null,
              valid: false,
            }),
          ),
        ),
      );
      expect(result.stdout).not.toContain(snippet);
      expect(result.stderr).not.toContain(snippet);
      for (const path of Object.values(worktrees)) {
        expect(await pathExists(path)).toBe(true);
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "retains absent outcomes at unrelated remove-hook locations",
    async () => {
      const branch = "feature-inline-remove-complete-ledger";
      await createWorktreesForBranch(workspace, branch, false);
      await configureInlineRemove({ "pre-remove": "exit 0" }, () => ({}));

      const result = await runArashi(
        workspace.rootPath,
        ["remove", branch, "--force", "--json"],
        home,
      );

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      const outcomes = JSON.parse(result.stdout).data.hookOutcomes;
      for (const repository of workspace.repos) {
        expect(outcomes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              hookName: "pre-remove",
              hookStatus: "skipped",
              reasonCode: "not_found",
              repositoryId: repository.name,
              scope: "repository",
              sourceKind: "file",
            }),
            expect.objectContaining({
              hookName: "pre-remove",
              hookStatus: "success",
              reasonCode: "none",
              repositoryId: repository.name,
              scope: "workspace",
              sourceKind: "inline-config",
            }),
            expect.objectContaining({
              hookName: "pre-remove",
              hookStatus: "skipped",
              reasonCode: "not_found",
              repositoryId: repository.name,
              scope: "global-repository",
              sourceKind: "file",
            }),
            expect.objectContaining({
              hookName: "pre-remove",
              hookStatus: "skipped",
              reasonCode: "not_found",
              repositoryId: repository.name,
              scope: "global-shared",
              sourceKind: "file",
            }),
          ]),
        );
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "previews invalid native hooks without fabricating outcomes or mutating targets",
    async () => {
      const branch = "feature-inline-remove-invalid-file-preview";
      const worktrees = await createWorktreesForBranch(workspace, branch, false);
      const hookPath = join(workspace.rootPath, ".arashi", "hooks", "pre-remove.sh");
      await writeNativeHook(hookPath, "exit 0");
      await chmod(hookPath, 0o644);
      const canonicalHookPath = await realpath(hookPath);

      const result = await runArashi(
        workspace.rootPath,
        ["remove", branch, "--dry-run", "--json"],
        home,
      );

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.data.hookOutcomes).toEqual([]);
      expect(envelope.data.hooks).toEqual(
        expect.arrayContaining(
          workspace.repos.map((repository) =>
            expect.objectContaining({
              availability: "unavailable",
              hookName: "pre-remove",
              reasonCode: "validation_failed",
              repository: repository.name,
              scope: "workspace",
              scriptPath: canonicalHookPath,
              selectedInterpreter: null,
              sourceKind: "file",
              sourceOwnerKind: "workspace",
              sourceOwnerName: null,
              sourceScriptPath: canonicalHookPath,
              valid: false,
            }),
          ),
        ),
      );
      for (const path of Object.values(worktrees)) {
        expect(await pathExists(path)).toBe(true);
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "runs no inline hook or destructive mutation when confirmation is declined",
    async () => {
      const branch = "feature-inline-remove-declined";
      const worktrees = await createWorktreesForBranch(workspace, branch, false);
      const marker = join(workspace.rootPath, ".arashi", "declined-hook-ran");
      await configureInlineRemove({ "pre-remove": `touch '${marker}'` }, () => ({}));
      const { executeRemove } = await import("../../src/commands/remove.ts");
      const originalCwd = process.cwd();
      process.chdir(workspace.rootPath);
      try {
        const exitCode = await executeRemove(
          branch,
          {},
          {
            confirm: async () => ({ status: "ok", value: false }),
            multiSelect: async () => ({ status: "ok", value: [] }),
          },
        );
        expect(exitCode).toBe(0);
      } finally {
        process.chdir(originalCwd);
      }
      expect(await pathExists(marker)).toBe(false);
      for (const path of Object.values(worktrees)) {
        expect(await pathExists(path)).toBe(true);
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "pre-remove failure gates every target and retains the classified hook failure",
    async () => {
      const branch = "feature-inline-remove-gate";
      const worktrees = await createWorktreesForBranch(workspace, branch, false);
      const postMarker = join(workspace.rootPath, ".arashi", "post-after-pre-failure");
      await configureInlineRemove(
        {
          "post-remove": `touch '${postMarker}'`,
          "pre-remove": "printf inline-pre-failure >&2; exit 31",
        },
        () => ({}),
      );

      const result = await runArashi(
        workspace.rootPath,
        ["remove", branch, "--force", "--json"],
        home,
      );

      for (const path of Object.values(worktrees)) {
        expect(await pathExists(path)).toBe(true);
      }
      expect(await pathExists(postMarker)).toBe(false);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.error.details.operations).toEqual([]);
      expect(envelope.error.details.hookOutcomes).toContainEqual(
        expect.objectContaining({
          hookName: "pre-remove",
          hookStatus: "failure",
          reasonCode: "exit_non_zero",
          scope: "workspace",
        }),
      );
    },
  );

  test.runIf(process.platform !== "win32")(
    "retains operation and inline post-remove failures while finalizing unrelated targets",
    async () => {
      const branch = "feature-inline-remove-partial";
      await runGit(workspace.repos[0].path, ["branch", branch]);
      await runGit(workspace.repos[1].path, ["branch", branch]);
      await runGit(workspace.repos[0].path, ["checkout", branch]);
      const record = join(workspace.rootPath, ".arashi", "inline-post-finalization.log");
      await configureInlineRemove(
        {
          "post-remove": `printf 'post:%s\\n' "$ARASHI_REPO_NAME" >> '${record}'
if [ "$ARASHI_REPO_NAME" = repo-b ]; then exit 29; fi`,
        },
        () => ({}),
      );

      const result = await runArashi(
        workspace.rootPath,
        ["remove", branch, "--force", "--keep-worktrees", "--json"],
        home,
      );

      const envelope = JSON.parse(result.stdout);
      expect(result.exitCode).toBe(1);
      expect(envelope.error.details.operations).toContainEqual(
        expect.objectContaining({ repository: "repo-a", status: "failed", type: "branch_delete" }),
      );
      expect(envelope.error.details.hookOutcomes).toContainEqual(
        expect.objectContaining({
          hookName: "post-remove",
          hookStatus: "failure",
          reasonCode: "exit_non_zero",
          repositoryId: "repo-b",
          scope: "workspace",
        }),
      );
      expect(await readFile(record, "utf8")).toBe("post:repo-a\npost:repo-b\n");
      expect(await branchExists(workspace.repos[0].path, branch)).toBe(true);
      expect(await branchExists(workspace.repos[1].path, branch)).toBe(false);
    },
  );
});
