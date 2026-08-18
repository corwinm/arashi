import { access, readFile } from "fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import {
  createRemoveWorkspace,
  createWorktreesForBranch,
} from "../helpers/remove-test-workspace.ts";
import {
  readWorkspaceConfig,
  runArashi,
  writeWorkspaceConfig,
} from "../helpers/inline-hook-test-utils.ts";
import { buildProgram } from "../../src/cli-program.ts";
import { createChildHookWorkspace } from "../helpers/create-child-hook-workspace.ts";
import { join } from "path";

const cleanups: (() => Promise<void>)[] = [];

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

interface CliEnvelope {
  data: {
    hookOutcomes: Record<string, unknown>[];
    hooks?: unknown;
  };
  [key: string]: unknown;
}

const parseSingleDocument = (stdout: string): CliEnvelope => {
  const parsed = JSON.parse(stdout) as CliEnvelope;
  expect(stdout.trim()).toBe(JSON.stringify(parsed, null, 2));
  return parsed;
};

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("inline hook source-neutral CLI behavior RED", () => {
  test("keeps --no-hooks create-only and --no-hook-input shared in help and schema-v8 command contract", async () => {
    const program = buildProgram({ includeHelpBanner: false });
    const create = program.commands.find((command) => command.name() === "create")!;
    const remove = program.commands.find((command) => command.name() === "remove")!;
    expect(create.helpInformation()).toContain("--no-hooks");
    expect(remove.helpInformation()).not.toContain("--no-hooks");
    expect(create.helpInformation()).toContain("--no-hook-input");
    expect(remove.helpInformation()).toContain("--no-hook-input");

    const contract = JSON.parse(
      await readFile(join(process.cwd(), "contracts/cli-commands.json"), "utf8"),
    );
    expect(contract.schemaVersion).toBe(8);
    const options = (path: string) =>
      contract.commands
        .find((command: { path: string }) => command.path === path)
        .options.map((option: { long: string }) => option.long);
    expect(options("create")).toContain("--no-hooks");
    expect(options("remove")).not.toContain("--no-hooks");
    expect(options("create")).toContain("--no-hook-input");
    expect(options("remove")).toContain("--no-hook-input");
  });

  test.runIf(process.platform !== "win32")(
    "create --no-hooks bypasses inline discovery and execution while create dry-run has no preview or fabricated outcomes",
    async () => {
      const workspace = await createChildHookWorkspace();
      cleanups.push(workspace.cleanup);
      const config = await readWorkspaceConfig(workspace.workspacePath);
      const marker = join(workspace.workspacePath, ".arashi", "inline-no-hooks-ran");
      config.hooks = {
        ...(config.hooks as object),
        scripts: { "pre-create": `touch '${marker}'` },
      };
      await writeWorkspaceConfig(workspace.workspacePath, config);

      const skipped = await runArashi(workspace.workspacePath, [
        "create",
        "feature-inline-no-hooks",
        "--no-hooks",
        "--no-progress",
        "--json",
      ]);
      expect(skipped.exitCode, `${skipped.stdout}\n${skipped.stderr}`).toBe(0);
      expect(await exists(marker)).toBe(false);
      expect(parseSingleDocument(skipped.stdout).data.hookOutcomes).toEqual([]);

      const dryRun = await runArashi(workspace.workspacePath, [
        "create",
        "feature-inline-dry-run",
        "--dry-run",
        "--no-progress",
        "--json",
      ]);
      expect(dryRun.exitCode, `${dryRun.stdout}\n${dryRun.stderr}`).toBe(0);
      const envelope = parseSingleDocument(dryRun.stdout);
      expect(envelope.data.hookOutcomes).toEqual([]);
      expect(envelope.data).not.toHaveProperty("hooks");
      expect(await exists(marker)).toBe(false);
    },
  );

  test.runIf(process.platform !== "win32")(
    "remove dry-run previews inline sources without execution while real remove records complete ordered outcomes",
    async () => {
      const workspace = await createRemoveWorkspace(["repo-a"]);
      cleanups.push(workspace.cleanup);
      const branch = "feature-inline-remove-preview";
      const worktrees = await createWorktreesForBranch(workspace, branch, false);
      const marker = join(workspace.rootPath, ".arashi", "inline-remove-ran");
      const config = await readWorkspaceConfig(workspace.rootPath);
      config.hooks = {
        scripts: {
          "post-remove": `printf post >> '${marker}'`,
          "pre-remove": `printf pre >> '${marker}'`,
        },
        timeout: 1000,
      };
      await writeWorkspaceConfig(workspace.rootPath, config);

      const preview = await runArashi(workspace.rootPath, [
        "remove",
        branch,
        "--dry-run",
        "--json",
      ]);
      expect(preview.exitCode, `${preview.stdout}\n${preview.stderr}`).toBe(0);
      const previewEnvelope = parseSingleDocument(preview.stdout);
      expect(previewEnvelope.data.hooks).toEqual([
        expect.objectContaining({
          hookName: "pre-remove",
          selectedInterpreter: "bash",
          sourceKind: "inline-config",
          sourceOwnerKind: "workspace",
          sourceOwnerName: null,
          sourceScriptPath: null,
        }),
        expect.objectContaining({
          hookName: "post-remove",
          selectedInterpreter: "bash",
          sourceKind: "inline-config",
          sourceOwnerKind: "workspace",
          sourceOwnerName: null,
          sourceScriptPath: null,
        }),
      ]);
      const humanPreview = await runArashi(workspace.rootPath, ["remove", branch, "--dry-run"]);
      expect(humanPreview.exitCode, `${humanPreview.stdout}\n${humanPreview.stderr}`).toBe(0);
      expect(humanPreview.stdout).toContain(
        "sourceKind=inline-config sourceOwnerKind=workspace sourceOwnerName=null selectedInterpreter=bash target=repo-a",
      );
      expect(await exists(marker)).toBe(false);
      expect(await exists(worktrees["repo-a"])).toBe(true);

      const removed = await runArashi(workspace.rootPath, [
        "remove",
        branch,
        "--force",
        "--no-hook-input",
        "--json",
      ]);
      expect(removed.exitCode, `${removed.stdout}\n${removed.stderr}`).toBe(0);
      const removedEnvelope = parseSingleDocument(removed.stdout);
      expect(
        removedEnvelope.data.hookOutcomes.map(
          (outcome) =>
            `${outcome.hookName}:${outcome.scope}:${outcome.sourceKind}:${outcome.hookStatus}`,
        ),
      ).toEqual([
        "pre-remove:repository:file:skipped",
        "pre-remove:workspace:inline-config:success",
        "pre-remove:global-repository:file:skipped",
        "pre-remove:global-shared:file:skipped",
        "post-remove:repository:file:skipped",
        "post-remove:workspace:inline-config:success",
        "post-remove:global-repository:file:skipped",
        "post-remove:global-shared:file:skipped",
      ]);
      expect(await readFile(marker, "utf8")).toBe("prepost");
    },
  );
});
