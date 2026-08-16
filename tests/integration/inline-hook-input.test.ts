import { access, readFile } from "fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import {
  readWorkspaceConfig,
  runArashi,
  writeWorkspaceConfig,
} from "../helpers/inline-hook-test-utils.ts";
import { createChildHookWorkspace } from "../helpers/create-child-hook-workspace.ts";
import { join } from "path";
import { spawnSync } from "node:child_process";

const CLI_ENTRY = join(import.meta.dirname, "../../src/index.ts");
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("inline hook input and attribution RED", () => {
  test.runIf(process.platform !== "win32")(
    "TTY banner attributes lifecycle, inline owner, and target before an unterminated Bash prompt receives input",
    async () => {
      const workspace = await createChildHookWorkspace();
      cleanups.push(workspace.cleanup);
      const record = join(workspace.workspacePath, ".arashi", "inline-input.log");
      const config = await readWorkspaceConfig(workspace.workspacePath);
      const repos = config.repos as Record<string, Record<string, unknown>>;
      repos.alpha = {
        ...repos.alpha,
        hooks: {
          "pre-create": `printf 'inline answer: '; IFS= read -r answer; printf '%s|%s' "$ARASHI_HOOK_INPUT" "$answer" > '${record}'`,
        },
      };
      await writeWorkspaceConfig(workspace.workspacePath, config);

      const result = spawnSync(
        process.execPath,
        [
          join(import.meta.dirname, "../helpers/pty-command.mjs"),
          workspace.workspacePath,
          "inline answer:",
          "yes",
          "20",
          JSON.stringify([
            process.execPath,
            CLI_ENTRY,
            "create",
            "feature-inline-tty",
            "--no-progress",
          ]),
        ],
        {
          cwd: workspace.workspacePath,
          encoding: "utf8",
          env: { ...process.env, NO_COLOR: "1" },
        },
      );
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status, output).toBe(0);
      expect(output.indexOf("pre-create.alpha")).toBeLessThan(output.indexOf("inline answer:"));
      expect(output).toContain(
        "lifecycle=pre-create.alpha scope=repository sourceKind=inline-config sourceOwnerKind=repository sourceOwnerName=alpha targetRepository=alpha targetWorktree=",
      );
      expect(output).toMatch(/targetWorktree=.*feature.*inline.*tty.*alpha/i);
      expect(output).not.toMatch(/source(?:Path)?=.*(?:bash|INLINE_SNIPPET)/i);
      expect(await readFile(record, "utf8")).toBe("tty|yes");
    },
    30_000,
  );

  test.runIf(process.platform !== "win32")(
    "non-TTY and JSON give inline Bash immediate EOF with unavailable/disabled attribution",
    async () => {
      const workspace = await createChildHookWorkspace();
      cleanups.push(workspace.cleanup);
      const config = await readWorkspaceConfig(workspace.workspacePath);
      const record = join(workspace.workspacePath, ".arashi", "inline-eof.log");
      config.hooks = {
        ...(config.hooks as object),
        scripts: {
          "pre-create": `answer=sentinel; if IFS= read -r answer; then exit 81; fi; printf '%s|%s\\n' "$ARASHI_HOOK_INPUT" "$answer" >> '${record}'`,
        },
      };
      await writeWorkspaceConfig(workspace.workspacePath, config);

      const unavailable = await runArashi(workspace.workspacePath, [
        "create",
        "feature-inline-unavailable",
        "--no-progress",
      ]);
      const disabled = await runArashi(workspace.workspacePath, [
        "create",
        "feature-inline-disabled",
        "--no-progress",
        "--json",
      ]);
      expect(unavailable.exitCode, `${unavailable.stdout}\n${unavailable.stderr}`).toBe(0);
      expect(disabled.exitCode, `${disabled.stdout}\n${disabled.stderr}`).toBe(0);
      expect(() => JSON.parse(disabled.stdout)).not.toThrow();
      expect(await readFile(record, "utf8")).toBe("unavailable|\ndisabled|\n");
      expect(await access(record)).toBeUndefined();
    },
  );
});
