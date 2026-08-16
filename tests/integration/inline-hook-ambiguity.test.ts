import { access, mkdtemp, readFile, realpath, rm } from "fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import {
  createRemoveWorkspace,
  createWorktreesForBranch,
} from "../helpers/remove-test-workspace.ts";
import {
  readWorkspaceConfig,
  runArashi,
  writeNativeHook,
  writeWorkspaceConfig,
} from "../helpers/inline-hook-test-utils.ts";
import { createChildHookWorkspace } from "../helpers/create-child-hook-workspace.ts";
import { join } from "path";
import { tmpdir } from "os";

const cleanups: (() => Promise<void>)[] = [];
const canary = "INLINE_AMBIGUITY_SECRET_6f97d6";

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const expectNoDisclosure = (result: { stderr: string; stdout: string }): void => {
  expect(`${result.stdout}\n${result.stderr}`).not.toContain(canary);
};

const parseJson = (stdout: string): Record<string, unknown> => {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  expect(stdout.trim()).toBe(JSON.stringify(parsed, null, 2));
  return parsed;
};

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("same-location inline/file ambiguity RED", () => {
  test.runIf(process.platform !== "win32")(
    "configured create root collision is CREATE_FAILED in JSON and human output before lifecycle mutation",
    async () => {
      const workspace = await createChildHookWorkspace();
      cleanups.push(workspace.cleanup);
      const config = await readWorkspaceConfig(workspace.workspacePath);
      config.hooks = {
        ...(config.hooks as object),
        scripts: { "pre-create": `touch ${canary}` },
      };
      await writeWorkspaceConfig(workspace.workspacePath, config);
      const marker = join(workspace.workspacePath, ".arashi", "ambiguous-create-file-ran");
      const filePath = join(workspace.workspacePath, ".arashi", "hooks", "pre-create.sh");
      await writeNativeHook(filePath, `touch '${marker}'`);

      const json = await runArashi(workspace.workspacePath, [
        "create",
        "feature-create-root-ambiguity",
        "--no-progress",
        "--json",
      ]);
      const human = await runArashi(workspace.workspacePath, [
        "create",
        "feature-create-root-ambiguity-human",
        "--no-progress",
      ]);

      expect(await exists(marker)).toBe(false);
      expect(await exists(workspace.getMainWorktreePath("feature-create-root-ambiguity"))).toBe(
        false,
      );
      const envelope = parseJson(json.stdout) as {
        error?: { code?: string; details?: { hookOutcomes?: unknown[] } };
      };
      expect(envelope.error?.code).toBe("CREATE_FAILED");
      expect(envelope.error?.details?.hookOutcomes).toContainEqual(
        expect.objectContaining({
          hookName: "pre-create",
          hookStatus: "failure",
          reasonCode: "validation_failed",
          scope: "workspace",
          sourceScriptPath: await realpath(filePath),
        }),
      );
      expect(`${human.stdout}\n${human.stderr}`).toMatch(/inline-config/i);
      expect(`${human.stdout}\n${human.stderr}`).toMatch(/file/i);
      expect(`${human.stdout}\n${human.stderr}`).toContain(await realpath(filePath));
      expectNoDisclosure(json);
      expectNoDisclosure(human);
    },
  );

  test.runIf(process.platform !== "win32")(
    "repository create collision identifies owner and repository-specific workspace file before any hook runs",
    async () => {
      const workspace = await createChildHookWorkspace();
      cleanups.push(workspace.cleanup);
      const config = await readWorkspaceConfig(workspace.workspacePath);
      const repos = config.repos as Record<string, Record<string, unknown>>;
      repos.alpha = {
        ...repos.alpha,
        hooks: { "post-create": `printf ${canary}` },
      };
      await writeWorkspaceConfig(workspace.workspacePath, config);
      const marker = join(workspace.workspacePath, ".arashi", "different-scope-must-not-run");
      await writeNativeHook(
        join(workspace.workspacePath, ".arashi", "hooks", "pre-create.sh"),
        `touch '${marker}'`,
      );
      const collisionPath = join(
        workspace.workspacePath,
        ".arashi",
        "hooks",
        "post-create.alpha.sh",
      );
      await writeNativeHook(collisionPath, `touch '${marker}'`);

      const result = await runArashi(workspace.workspacePath, [
        "create",
        "feature-create-repository-ambiguity",
        "--no-progress",
        "--json",
      ]);

      expect(await exists(marker)).toBe(false);
      const envelope = parseJson(result.stdout) as {
        error?: { code?: string; details?: { hookOutcomes?: unknown[] } };
      };
      expect(envelope.error?.code).toBe("CREATE_FAILED");
      expect(envelope.error?.details?.hookOutcomes).toContainEqual(
        expect.objectContaining({
          hookName: "post-create.alpha",
          reasonCode: "validation_failed",
          repositoryId: "alpha",
          scope: "repository",
          sourceScriptPath: await realpath(collisionPath),
        }),
      );
      expectNoDisclosure(result);
    },
  );

  test.runIf(process.platform !== "win32")(
    "configured remove root collision is non-secret in human and HOOK_CONFIGURATION_INVALID in JSON",
    async () => {
      const workspace = await createRemoveWorkspace(["repo-a"]);
      cleanups.push(workspace.cleanup);
      const branch = "feature-remove-root-ambiguity";
      const worktrees = await createWorktreesForBranch(workspace, branch, false);
      const config = await readWorkspaceConfig(workspace.rootPath);
      config.hooks = { scripts: { "pre-remove": `printf ${canary}` } };
      await writeWorkspaceConfig(workspace.rootPath, config);
      const marker = join(workspace.rootPath, ".arashi", "ambiguous-root-remove-ran");
      const collisionPath = join(workspace.rootPath, ".arashi", "hooks", "pre-remove.sh");
      await writeNativeHook(collisionPath, `touch '${marker}'`);

      const json = await runArashi(workspace.rootPath, ["remove", branch, "--force", "--json"]);
      const human = await runArashi(workspace.rootPath, ["remove", branch, "--force"]);

      expect(await exists(marker)).toBe(false);
      expect(await exists(worktrees["repo-a"])).toBe(true);
      const envelope = parseJson(json.stdout) as {
        error?: { code?: string; details?: { hookOutcomes?: unknown[] } };
      };
      expect(envelope.error?.code).toBe("HOOK_CONFIGURATION_INVALID");
      expect(envelope.error?.details?.hookOutcomes).toContainEqual(
        expect.objectContaining({
          hookName: "pre-remove",
          reasonCode: "validation_failed",
          scope: "workspace",
          sourceScriptPath: await realpath(collisionPath),
        }),
      );
      expect(`${human.stdout}\n${human.stderr}`).toMatch(/inline-config/i);
      expect(`${human.stdout}\n${human.stderr}`).toContain(await realpath(collisionPath));
      expectNoDisclosure(json);
      expectNoDisclosure(human);
    },
  );

  test.runIf(process.platform !== "win32")(
    "configured remove and dry-run classify repository collision without execution or mutation",
    async () => {
      const workspace = await createRemoveWorkspace(["repo-a"]);
      cleanups.push(workspace.cleanup);
      const branch = "feature-remove-repository-ambiguity";
      const worktrees = await createWorktreesForBranch(workspace, branch, false);
      const config = await readWorkspaceConfig(workspace.rootPath);
      const repos = config.repos as Record<string, Record<string, unknown>>;
      repos["repo-a"] = {
        ...repos["repo-a"],
        hooks: { "pre-remove": `printf ${canary}` },
      };
      await writeWorkspaceConfig(workspace.rootPath, config);
      const marker = join(workspace.rootPath, ".arashi", "ambiguous-remove-file-ran");
      const collisionPath = join(workspace.repos[0].path, ".arashi", "hooks", "pre-remove.sh");
      await writeNativeHook(collisionPath, `touch '${marker}'`);

      for (const args of [
        ["remove", branch, "--force", "--json"],
        ["remove", branch, "--dry-run", "--json"],
      ]) {
        const result = await runArashi(workspace.rootPath, args);
        expect(await exists(marker)).toBe(false);
        expect(await exists(worktrees["repo-a"])).toBe(true);
        const envelope = parseJson(result.stdout) as {
          error?: { code?: string; details?: { hookOutcomes?: unknown[] } };
        };
        expect(envelope.error?.code).toBe("HOOK_CONFIGURATION_INVALID");
        expect(envelope.error?.details?.hookOutcomes).toContainEqual(
          expect.objectContaining({
            hookName: "pre-remove",
            reasonCode: "validation_failed",
            repositoryId: "repo-a",
            scope: "repository",
            sourceScriptPath: await realpath(collisionPath),
          }),
        );
        expectNoDisclosure(result);
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "doctor emits HOOK_AMBIGUOUS with only the exact non-secret detail keys and executes neither source",
    async () => {
      const workspace = await createRemoveWorkspace(["repo-a"]);
      cleanups.push(workspace.cleanup);
      const config = await readWorkspaceConfig(workspace.rootPath);
      config.hooks = { scripts: { "pre-remove": `printf ${canary}` } };
      await writeWorkspaceConfig(workspace.rootPath, config);
      const marker = join(workspace.rootPath, ".arashi", "doctor-ambiguity-ran");
      const collisionPath = join(workspace.rootPath, ".arashi", "hooks", "pre-remove.sh");
      await writeNativeHook(collisionPath, `touch '${marker}'`);

      const result = await runArashi(workspace.rootPath, ["doctor", "--json"]);

      expect(await exists(marker)).toBe(false);
      const envelope = parseJson(result.stdout) as {
        error?: {
          details?: { findings?: { code: string; details: Record<string, unknown> }[] };
        };
      };
      const finding = envelope.error?.details?.findings?.find(
        (candidate) => candidate.code === "HOOK_AMBIGUOUS",
      );
      expect(finding).toBeDefined();
      expect(Object.keys(finding!.details).toSorted()).toEqual([
        "hookName",
        "scope",
        "sourceKinds",
        "sourceOwnerKind",
        "sourceOwnerName",
        "sourceScriptPath",
      ]);
      expect(finding!.details).toEqual({
        hookName: "pre-remove",
        scope: "workspace",
        sourceKinds: ["file", "inline-config"],
        sourceOwnerKind: "workspace",
        sourceOwnerName: null,
        sourceScriptPath: await realpath(collisionPath),
      });
      expectNoDisclosure(result);
    },
  );

  test.runIf(process.platform !== "win32")(
    "different repository-inline and workspace-file remove scopes compose instead of colliding",
    async () => {
      const workspace = await createRemoveWorkspace(["repo-a"]);
      cleanups.push(workspace.cleanup);
      const home = await mkdtemp(join(tmpdir(), "arashi-inline-ambiguity-home-"));
      cleanups.push(() => rm(home, { force: true, recursive: true }));
      const branch = "feature-remove-different-scopes";
      await createWorktreesForBranch(workspace, branch, false);
      const record = join(workspace.rootPath, ".arashi", "different-scopes.log");
      const config = await readWorkspaceConfig(workspace.rootPath);
      const repos = config.repos as Record<string, Record<string, unknown>>;
      repos["repo-a"] = {
        ...repos["repo-a"],
        hooks: { "pre-remove": `printf 'repository-inline\\n' >> '${record}'` },
      };
      await writeWorkspaceConfig(workspace.rootPath, config);
      await writeNativeHook(
        join(workspace.rootPath, ".arashi", "hooks", "pre-remove.sh"),
        `printf 'workspace-file\\n' >> '${record}'`,
      );

      const result = await runArashi(
        workspace.rootPath,
        ["remove", branch, "--force", "--json"],
        home,
      );

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(await readFile(record, "utf8")).toBe("repository-inline\nworkspace-file\n");
    },
  );
});
