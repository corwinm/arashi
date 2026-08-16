import { access, mkdtemp, readFile, realpath, rm, writeFile } from "fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { basename, join } from "path";
import {
  createRemoveWorkspace,
  createWorktreesForBranch,
} from "../helpers/remove-test-workspace.ts";
import {
  readWorkspaceConfig,
  runArashi,
  runGit,
  writeNativeHook,
  writeWorkspaceConfig,
} from "../helpers/inline-hook-test-utils.ts";
import { createChildHookWorkspace } from "../helpers/create-child-hook-workspace.ts";
import { tmpdir } from "os";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("all inline lifecycle fields and unchanged file-only compatibility RED", () => {
  test.runIf(process.platform !== "win32")(
    "activates all four root and repository fields at the existing create/remove boundaries",
    async () => {
      const workspace = await createRemoveWorkspace(["repo-a"]);
      cleanups.push(workspace.cleanup);
      const branch = "feature-inline-all-fields";
      await createWorktreesForBranch(workspace, branch, false);
      const record = join(workspace.rootPath, ".arashi", "all-inline-fields.log");
      const config = await readWorkspaceConfig(workspace.rootPath);
      const repos = config.repos as Record<string, Record<string, unknown>>;
      config.hooks = {
        scripts: {
          "post-create": `printf 'root-post-create\\n' >> '${record}'`,
          "post-remove": `printf 'root-post-remove\\n' >> '${record}'`,
          "pre-create": `printf 'root-pre-create\\n' >> '${record}'`,
          "pre-remove": `printf 'root-pre-remove\\n' >> '${record}'`,
        },
      };
      repos["repo-a"] = {
        ...repos["repo-a"],
        hooks: {
          "post-create": `printf 'repo-post-create\\n' >> '${record}'`,
          "post-remove": `printf 'repo-post-remove\\n' >> '${record}'`,
          "pre-create": `printf 'repo-pre-create\\n' >> '${record}'`,
          "pre-remove": `printf 'repo-pre-remove\\n' >> '${record}'`,
        },
      };
      await writeWorkspaceConfig(workspace.rootPath, config);

      const removed = await runArashi(workspace.rootPath, ["remove", branch, "--force", "--json"]);
      expect(removed.exitCode, `${removed.stdout}\n${removed.stderr}`).toBe(0);
      const removeLedger = JSON.parse(removed.stdout).data.hookOutcomes.map(
        (outcome: { hookName: string; hookStatus: string; scope: string; sourceKind: string }) =>
          `${outcome.hookName}:${outcome.scope}:${outcome.sourceKind}:${outcome.hookStatus}`,
      );
      expect(removeLedger).toEqual([
        "pre-remove:repository:inline-config:success",
        "pre-remove:workspace:inline-config:success",
        "pre-remove:global-repository:file:skipped",
        "pre-remove:global-shared:file:skipped",
        "post-remove:repository:inline-config:success",
        "post-remove:workspace:inline-config:success",
        "post-remove:global-repository:file:skipped",
        "post-remove:global-shared:file:skipped",
      ]);

      const created = await runArashi(workspace.rootPath, [
        "create",
        branch,
        "--no-progress",
        "--json",
      ]);
      expect(created.exitCode, `${created.stdout}\n${created.stderr}`).toBe(0);
      const createNames = JSON.parse(created.stdout).data.hookOutcomes.map(
        (outcome: { hookName: string }) => outcome.hookName,
      );
      expect(createNames).toEqual([
        "pre-create",
        "pre-create.repo-a",
        "post-create.repo-a",
        "post-create",
      ]);
      expect((await readFile(record, "utf8")).trim().split("\n")).toEqual([
        "repo-pre-remove",
        "root-pre-remove",
        "repo-post-remove",
        "root-post-remove",
        "root-pre-create",
        "repo-pre-create",
        "repo-post-create",
        "root-post-create",
      ]);
    },
  );

  test.runIf(process.platform !== "win32")(
    "retains configured file-only discovery, ordering, cwd, dry-run preview, flags, and outcomes",
    async () => {
      const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
      cleanups.push(workspace.cleanup);
      const branch = "feature-file-only-baseline";
      const record = join(workspace.workspacePath, ".arashi", "file-only-baseline.log");
      await writeNativeHook(
        join(workspace.workspacePath, ".arashi", "hooks", "pre-create.sh"),
        `test "$PWD" = "$ARASHI_MAIN_REPO_PATH"; printf pre-create >> '${record}'`,
      );
      await writeNativeHook(
        join(workspace.workspacePath, ".arashi", "hooks", "post-create.sh"),
        `test "$PWD" = "$ARASHI_MAIN_REPO_PATH"; printf ',post-create' >> '${record}'`,
      );

      const created = await runArashi(workspace.workspacePath, [
        "create",
        branch,
        "--no-hook-input",
        "--no-progress",
        "--json",
      ]);
      expect(created.exitCode, `${created.stdout}\n${created.stderr}`).toBe(0);
      expect(await readFile(record, "utf8")).toBe("pre-create,post-create");
      expect(
        JSON.parse(created.stdout)
          .data.hookOutcomes.filter(
            (outcome: { hookStatus: string }) => outcome.hookStatus === "success",
          )
          .map((outcome: { hookName: string }) => outcome.hookName),
      ).toEqual(["pre-create", "post-create"]);
    },
  );

  test.runIf(process.platform !== "win32")(
    "retains configured file-only remove dry-run, doctor, execution order, cwd, and outcomes",
    async () => {
      const workspace = await createRemoveWorkspace(["repo-a"]);
      cleanups.push(workspace.cleanup);
      const canonicalWorkspaceRoot = await realpath(workspace.rootPath);
      const branch = "feature-file-only-remove-baseline";
      const worktrees = await createWorktreesForBranch(workspace, branch, false);
      const record = join(workspace.rootPath, ".arashi", "file-only-remove-baseline.log");
      const prePath = join(workspace.rootPath, ".arashi", "hooks", "pre-remove.sh");
      const postPath = join(workspace.rootPath, ".arashi", "hooks", "post-remove.sh");
      const canonicalPrePath = join(canonicalWorkspaceRoot, ".arashi", "hooks", "pre-remove.sh");
      const canonicalPostPath = join(canonicalWorkspaceRoot, ".arashi", "hooks", "post-remove.sh");
      await writeNativeHook(
        prePath,
        `test "$PWD" = "$ARASHI_MAIN_REPO_PATH"; printf 'pre|%s|%s\\n' "$ARASHI_REPO_NAME" "$PWD" >> '${record}'`,
      );
      await writeNativeHook(
        postPath,
        `test "$PWD" = "$ARASHI_MAIN_REPO_PATH"; printf 'post|%s|%s\\n' "$ARASHI_REPO_NAME" "$PWD" >> '${record}'`,
      );

      const doctor = await runArashi(workspace.rootPath, ["doctor", "--json"]);
      expect(`${doctor.stdout}\n${doctor.stderr}`).not.toMatch(
        /HOOK_(?:AMBIGUOUS|INVALID|MISSING|NOT_EXECUTABLE)/,
      );
      await expect(access(record)).rejects.toThrow();

      const preview = await runArashi(workspace.rootPath, [
        "remove",
        branch,
        "--dry-run",
        "--json",
      ]);
      expect(preview.exitCode, `${preview.stdout}\n${preview.stderr}`).toBe(0);
      expect(await access(worktrees["repo-a"])).toBeUndefined();
      await expect(access(record)).rejects.toThrow();
      expect(
        JSON.parse(preview.stdout)
          .data.hooks.filter(
            (hook: { scope: string; scriptPath: string | null }) =>
              hook.scope === "workspace" && hook.scriptPath !== null,
          )
          .map((hook: { hookName: string; scriptPath: string }) => [
            hook.hookName,
            hook.scriptPath,
          ]),
      ).toEqual([
        ["pre-remove", canonicalPrePath],
        ["post-remove", canonicalPostPath],
      ]);

      const removed = await runArashi(workspace.rootPath, [
        "remove",
        branch,
        "--force",
        "--no-hook-input",
        "--json",
      ]);
      expect(removed.exitCode, `${removed.stdout}\n${removed.stderr}`).toBe(0);
      expect((await readFile(record, "utf8")).trim().split("\n")).toEqual([
        `pre|repo-a|${canonicalWorkspaceRoot}`,
        `post|repo-a|${canonicalWorkspaceRoot}`,
      ]);
      expect(
        JSON.parse(removed.stdout)
          .data.hookOutcomes.filter(
            (outcome: { hookStatus: string; scope: string }) =>
              outcome.hookStatus === "success" && outcome.scope === "workspace",
          )
          .map((outcome: { hookName: string; sourceScriptPath: string }) => [
            outcome.hookName,
            outcome.sourceScriptPath,
          ]),
      ).toEqual([
        ["pre-remove", canonicalPrePath],
        ["post-remove", canonicalPostPath],
      ]);
    },
  );

  test.runIf(process.platform !== "win32")(
    "retains standalone create and remove file hooks with exact order, cwd, outcomes, and doctor non-execution",
    async () => {
      const repository = await mkdtemp(join(tmpdir(), "arashi-standalone-file-baseline-"));
      cleanups.push(() => rm(repository, { force: true, recursive: true }));
      const home = await mkdtemp(join(tmpdir(), "arashi-inline-file-baseline-home-"));
      cleanups.push(() => rm(home, { force: true, recursive: true }));
      await runGit(repository, ["init", "-b", "main"]);
      await runGit(repository, ["config", "user.email", "test@example.com"]);
      await runGit(repository, ["config", "user.name", "Test User"]);
      await writeFile(join(repository, "README.md"), "baseline\n");
      await runGit(repository, ["add", "."]);
      await runGit(repository, ["commit", "-m", "initial"]);
      const canonicalRepository = await realpath(repository);
      const initialized = await runArashi(repository, ["init", "--zero-config"], home);
      expect(initialized.exitCode).toBe(0);
      const record = join(home, "standalone-file-only.log");
      const hookPaths: Record<string, string> = {};
      for (const lifecycle of ["pre-create", "post-create", "pre-remove", "post-remove"] as const) {
        const targeted = join(home, ".arashi", "hooks", basename(repository), `${lifecycle}.sh`);
        const shared = join(home, ".arashi", "hooks", `${lifecycle}.sh`);
        hookPaths[`${lifecycle}:global-repository`] = targeted;
        hookPaths[`${lifecycle}:global-shared`] = shared;
        await writeNativeHook(
          targeted,
          `test "$PWD" = "$ARASHI_MAIN_REPO_PATH"; printf '${lifecycle}|global-repository|%s\\n' "$PWD" >> '${record}'`,
        );
        await writeNativeHook(
          shared,
          `test "$PWD" = "$ARASHI_MAIN_REPO_PATH"; printf '${lifecycle}|global-shared|%s\\n' "$PWD" >> '${record}'`,
        );
      }

      const doctor = await runArashi(repository, ["doctor", "--json"], home);
      expect(`${doctor.stdout}\n${doctor.stderr}`).not.toMatch(
        /HOOK_(?:AMBIGUOUS|INVALID|MISSING|NOT_EXECUTABLE)/,
      );
      await expect(access(record)).rejects.toThrow();

      const created = await runArashi(
        repository,
        ["create", "standalone-file-baseline", "--json"],
        home,
      );
      expect(created.exitCode, `${created.stdout}\n${created.stderr}`).toBe(0);
      expect((await readFile(record, "utf8")).trim().split("\n")).toEqual([
        `pre-create|global-repository|${canonicalRepository}`,
        `pre-create|global-shared|${canonicalRepository}`,
        `post-create|global-repository|${canonicalRepository}`,
        `post-create|global-shared|${canonicalRepository}`,
      ]);
      const createOutcomes = JSON.parse(created.stdout).data.hookOutcomes.filter(
        (outcome: { hookStatus: string }) => outcome.hookStatus === "success",
      );
      expect(
        createOutcomes.map(
          (outcome: {
            hookName: string;
            scope: string;
            sourceOwnerName: string | null;
            targetRepositoryName: string;
          }) =>
            `${outcome.hookName}:${outcome.scope}:${String(outcome.sourceOwnerName)}:${outcome.targetRepositoryName}`,
        ),
      ).toEqual([
        `pre-create:global-repository:null:${basename(repository)}`,
        `pre-create:global-shared:null:${basename(repository)}`,
        `post-create:global-repository:null:${basename(repository)}`,
        `post-create:global-shared:null:${basename(repository)}`,
      ]);
      expect(
        createOutcomes.map(
          (outcome: { hookName: string; scope: string; sourceScriptPath: string }) =>
            outcome.sourceScriptPath === hookPaths[`${outcome.hookName}:${outcome.scope}`],
        ),
      ).toEqual([true, true, true, true]);

      const removed = await runArashi(
        repository,
        ["remove", "standalone-file-baseline", "--force", "--json"],
        home,
      );
      expect(removed.exitCode, `${removed.stdout}\n${removed.stderr}`).toBe(0);
      expect((await readFile(record, "utf8")).trim().split("\n")).toEqual([
        `pre-create|global-repository|${canonicalRepository}`,
        `pre-create|global-shared|${canonicalRepository}`,
        `post-create|global-repository|${canonicalRepository}`,
        `post-create|global-shared|${canonicalRepository}`,
        `pre-remove|global-repository|${canonicalRepository}`,
        `pre-remove|global-shared|${canonicalRepository}`,
        `post-remove|global-repository|${canonicalRepository}`,
        `post-remove|global-shared|${canonicalRepository}`,
      ]);
      const removeOutcomes = JSON.parse(removed.stdout).data.hookOutcomes.filter(
        (outcome: { hookStatus: string }) => outcome.hookStatus === "success",
      );
      expect(
        removeOutcomes.map(
          (outcome: {
            hookName: string;
            scope: string;
            sourceOwnerName: string | null;
            targetRepositoryName: string;
          }) =>
            `${outcome.hookName}:${outcome.scope}:${String(outcome.sourceOwnerName)}:${outcome.targetRepositoryName}`,
        ),
      ).toEqual([
        `pre-remove:global-repository:null:${basename(repository)}`,
        `pre-remove:global-shared:null:${basename(repository)}`,
        `post-remove:global-repository:null:${basename(repository)}`,
        `post-remove:global-shared:null:${basename(repository)}`,
      ]);
      expect(
        removeOutcomes.map(
          (outcome: { hookName: string; scope: string; sourceScriptPath: string }) =>
            outcome.sourceScriptPath === hookPaths[`${outcome.hookName}:${outcome.scope}`],
        ),
      ).toEqual([true, true, true, true]);
    },
  );
});
