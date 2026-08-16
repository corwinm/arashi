import { afterEach, describe, expect, test } from "vitest";
import { readWorkspaceConfig, writeWorkspaceConfig } from "../helpers/inline-hook-test-utils.ts";
import { createChildHookWorkspace } from "../helpers/create-child-hook-workspace.ts";
import { join } from "path";
import { readFile, realpath } from "fs/promises";
import { runtime } from "../helpers/node-runtime.ts";

type Workspace = Awaited<ReturnType<typeof createChildHookWorkspace>>;
const binary = join(import.meta.dirname, "../../bin/arashi.bin");
const workspaces: Workspace[] = [];

const runBuilt = async (cwd: string, args: string[]) => {
  const proc = runtime.spawn([binary, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr, stdout };
};

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()));
});

describe.runIf(process.platform !== "win32" && process.env.ARASHI_BUILT_HOOK_ACCEPTANCE === "1")(
  "built POSIX inline-hook production adapter RED",
  () => {
    test("executes Bash once with spaces/metacharacters, fail-fast, cwd/environment, and classified failure", async () => {
      const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
      workspaces.push(workspace);
      const record = join(workspace.workspacePath, ".arashi", "inline % !&() adapter.log");
      const config = await readWorkspaceConfig(workspace.workspacePath);
      const repos = config.repos as Record<string, Record<string, unknown>>;
      config.hooks = {
        scripts: {
          "pre-create": {
            bash: `set -e; printf 'root|%s|%s|%s|%%|!|&|()\\n' "$PWD" "$ARASHI_HOOK_NAME" "$ARASHI_HOOK_INPUT" >> '${record}'; false; printf leaked >> '${record}'`,
          },
        },
        timeout: 2000,
      };
      repos.alpha = {
        ...repos.alpha,
        hooks: {
          "pre-create": {
            bash: `printf 'repo|%s|%s\\n' "$PWD" "$ARASHI_REPO_NAME" >> '${record}'`,
          },
        },
      };
      await writeWorkspaceConfig(workspace.workspacePath, config);

      const result = await runBuilt(workspace.workspacePath, [
        "create",
        "feature/inline-built-adapter",
        "--no-progress",
        "--json",
      ]);
      expect(result.exitCode).toBe(1);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.error.code).toBe("CREATE_FAILED");
      expect(envelope.error.details.hookOutcomes).toEqual([
        expect.objectContaining({
          hookName: "pre-create",
          hookStatus: "failure",
          reasonCode: "exit_non_zero",
          sourceKind: "inline-config",
        }),
      ]);
      const lines = (await readFile(record, "utf8")).trim().split("\n");
      expect(lines).toEqual([
        expect.stringMatching(/^root\|.*\|pre-create\|disabled\|%\|!\|&\|\(\)$/),
      ]);
      expect(lines[0]?.split("|")[1]).toBe(await realpath(workspace.workspacePath));
      expect(lines.join("\n")).not.toContain("leaked");
      expect(lines.filter((line) => line.startsWith("root|"))).toHaveLength(1);
    });

    test("provides immediate EOF in JSON mode and preserves exact output metadata", async () => {
      const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
      workspaces.push(workspace);
      const record = join(workspace.workspacePath, ".arashi", "inline-eof.log");
      const config = await readWorkspaceConfig(workspace.workspacePath);
      config.hooks = {
        scripts: {
          "pre-create": {
            bash: `IFS= read -r answer; status=$?; printf '%s|%s|%s\\n' "$ARASHI_HOOK_INPUT" "$status" "$answer" > '${record}'; exit 0`,
          },
        },
        timeout: 2000,
      };
      await writeWorkspaceConfig(workspace.workspacePath, config);

      const result = await runBuilt(workspace.workspacePath, [
        "create",
        "feature/inline-built-eof",
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      expect(await readFile(record, "utf8")).toBe("disabled|1|\n");
      expect(JSON.parse(result.stdout).data.hookOutcomes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            hookName: "pre-create",
            sourceKind: "inline-config",
            sourceScriptPath: null,
          }),
        ]),
      );
    });

    test("classifies a built inline Bash timeout without a second execution", async () => {
      const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
      workspaces.push(workspace);
      const record = join(workspace.workspacePath, ".arashi", "inline-timeout.log");
      const config = await readWorkspaceConfig(workspace.workspacePath);
      config.hooks = {
        scripts: {
          "pre-create": {
            bash: `printf 'once\\n' >> '${record}'; sleep 10`,
          },
        },
        timeout: 20,
      };
      await writeWorkspaceConfig(workspace.workspacePath, config);

      const result = await runBuilt(workspace.workspacePath, [
        "create",
        "feature/inline-built-timeout",
        "--json",
      ]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error.details.hookOutcomes).toEqual([
        expect.objectContaining({
          hookName: "pre-create",
          reasonCode: "timeout",
          sourceKind: "inline-config",
        }),
      ]);
      expect(await readFile(record, "utf8")).toBe("once\n");
    });
  },
);
