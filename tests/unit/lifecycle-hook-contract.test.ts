import {
  DEFAULT_LIFECYCLE_HOOK_TIMEOUT,
  buildHookEnvironment,
  buildRemoveHookOperationData,
  discoverLifecycleHook,
  getHookSpawnCommand,
} from "../../src/lib/hooks.ts";
import { normalizeConfig } from "../../src/lib/config.ts";
import { afterEach, describe, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const roots: string[] = [];
const tempRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "arashi-hook-contract-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("lifecycle hook contract", () => {
  test("uses one five-minute timeout and validates the configured integer range", () => {
    expect(DEFAULT_LIFECYCLE_HOOK_TIMEOUT).toBe(300_000);
    expect(
      normalizeConfig({ version: "1.0.0", reposDir: "repos", repos: {}, hooks: { timeout: 1 } })
        .hooks?.timeout,
    ).toBe(1);
    expect(
      normalizeConfig({
        version: "1.0.0",
        reposDir: "repos",
        repos: {},
        hooks: { timeout: 2_147_483_647 },
      }).hooks?.timeout,
    ).toBe(2_147_483_647);
    for (const timeout of [0, -1, 1.5, "300000", 2_147_483_648]) {
      expect(() =>
        normalizeConfig({ version: "1.0.0", reposDir: "repos", repos: {}, hooks: { timeout } }),
      ).toThrow(/integer.*1.*2147483647/i);
    }
  });

  test("publishes the same timeout bounds in the JSON schema", async () => {
    const schema = JSON.parse(
      await readFile(join(process.cwd(), "schema", "config.schema.json"), "utf8"),
    );
    expect(schema.definitions.Config.properties.hooks.properties.timeout).toMatchObject({
      maximum: 2_147_483_647,
      minimum: 1,
      multipleOf: 1,
      type: "number",
    });
  });

  test("serializes canonical remove targets and omits ambiguous scalar aliases", () => {
    const data = buildRemoveHookOperationData({
      mainRepoPath: "/workspace",
      targets: [
        { repository: "repo-b", branchName: "z", worktreePath: "/tmp/z/../b/" },
        { repository: "repo-a", branchName: null, worktreePath: null },
        { repository: "repo-b", branchName: "a", worktreePath: "/tmp/a" },
        { repository: "repo-b", branchName: "a", worktreePath: "/tmp/a" },
      ],
    });
    expect(JSON.parse(data.REMOVE_TARGETS_JSON)).toEqual([
      { repository: "repo-a", branchName: null, worktreePath: null },
      { repository: "repo-b", branchName: "a", worktreePath: "/tmp/a" },
      { repository: "repo-b", branchName: "z", worktreePath: "/tmp/b" },
    ]);
    expect(data).not.toHaveProperty("BRANCH_NAME");
    expect(data).not.toHaveProperty("WORKTREE_PATH");
    expect(data.REMOVE_TARGET_BRANCHES).toBe("a,z");
    expect(data.REMOVE_TARGET_WORKTREES).toBe("/tmp/a,/tmp/b");
    expect(data.REMOVE_TARGET_REPOSITORIES).toBe("repo-a,repo-b");
    expect(data.REMOVE_TOTAL_BRANCHES).toBe("2");
  });

  test("normalizes Windows drive and UNC targets without locale ordering or realpath", () => {
    const data = buildRemoveHookOperationData({
      mainRepoPath: "/workspace",
      targets: [
        { repository: "z", branchName: null, worktreePath: "c:\\work\\a\\..\\b\\" },
        { repository: "Å", branchName: "x", worktreePath: "\\\\server\\share\\a\\..\\b" },
        { repository: "a", branchName: null, worktreePath: null },
      ],
    });
    expect(JSON.parse(data.REMOVE_TARGETS_JSON)).toEqual([
      { repository: "a", branchName: null, worktreePath: null },
      { repository: "z", branchName: null, worktreePath: "C:/work/b" },
      { repository: "Å", branchName: "x", worktreePath: "//server/share/b" },
    ]);
  });

  test("executor metadata is authoritative over operation data", () => {
    const env = buildHookEnvironment({
      hookName: "pre-remove",
      hookScope: "workspace",
      operationData: { HOOK_NAME: "forged", HOOK_SCOPE: "forged", HOOK_EXECUTION_PATH: "/forged" },
      repoPath: "/workspace",
      sourceScriptPath: "/workspace/.arashi/hooks/pre-remove.sh",
      targetRepoName: "child",
      targetRepoPath: "/workspace/repos/child",
      targetWorktreePath: "/workspace/.arashi/worktrees/feature/repos/child",
      workspaceMode: "configured",
      mainRepoPath: "/workspace",
    });
    expect(env).toMatchObject({
      ARASHI_HOOK_NAME: "pre-remove",
      ARASHI_HOOK_SCOPE: "workspace",
      ARASHI_HOOK_EXECUTION_PATH: "/workspace",
      ARASHI_HOOK_WORKSPACE_MODE: "configured",
      ARASHI_MAIN_REPO_PATH: "/workspace",
      ARASHI_HOOK_TARGET_REPOSITORY: "child",
      ARASHI_HOOK_TARGET_REPO_PATH: "/workspace/repos/child",
      ARASHI_HOOK_TARGET_WORKTREE_PATH: "/workspace/.arashi/worktrees/feature/repos/child",
    });
  });

  test("configured workspace create context does not invent a child target", () => {
    const env = buildHookEnvironment({
      hookName: "pre-create",
      hookScope: "workspace",
      operationData: { BRANCH_NAME: "feature/context", MAIN_REPO_PATH: "/workspace" },
      repoPath: "/workspace",
      sourceScriptPath: "/workspace/.arashi/hooks/pre-create.sh",
      workspaceMode: "configured",
      mainRepoPath: "/workspace",
    });
    expect(env.ARASHI_REPO_PATH).toBe("/workspace");
    expect(env).not.toHaveProperty("ARASHI_REPO_NAME");
    expect(env).not.toHaveProperty("ARASHI_WORKTREE_PATH");
    expect(env).not.toHaveProperty("ARASHI_HOOK_TARGET_REPOSITORY");
  });

  test("discovers POSIX shell hooks and rejects Windows ambiguity case-insensitively", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".arashi", "hooks"), { recursive: true });
    const shell = join(root, ".arashi", "hooks", "pre-create.sh");
    await writeFile(shell, "#!/bin/sh\nexit 0\n");
    await chmod(shell, 0o755);
    await expect(discoverLifecycleHook("pre-create", root, "linux")).resolves.toBe(shell);

    await rm(shell);
    await writeFile(join(root, ".arashi", "hooks", "pre-create.PS1"), "exit 0\n");
    await writeFile(join(root, ".arashi", "hooks", "pre-create.cmd"), "exit /b 0\r\n");
    await expect(discoverLifecycleHook("pre-create", root, "win32")).rejects.toThrow(
      /ambiguous.*PS1.*cmd/i,
    );
  });

  test("uses the normative native Windows interpreter argv", () => {
    expect(getHookSpawnCommand("C:\\hooks\\pre-create.PS1", "win32")).toEqual([
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\hooks\\pre-create.PS1",
    ]);
    expect(getHookSpawnCommand("C:\\hooks\\pre-remove.cmd", "win32")).toEqual([
      "cmd.exe",
      "/d",
      "/e:on",
      "/v:off",
      "/c",
      "call",
      "C:\\hooks\\pre-remove.cmd",
    ]);
  });
});
