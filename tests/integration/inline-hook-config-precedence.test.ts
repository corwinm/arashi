import { afterEach, describe, expect, test, vi } from "vitest";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import {
  readWorkspaceConfig,
  runArashi,
  runArashiWithEnv,
  writeWorkspaceConfig,
} from "../helpers/inline-hook-test-utils.ts";

import { createChildHookWorkspace } from "../helpers/create-child-hook-workspace.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";

const cleanups: (() => Promise<void>)[] = [];
const canary = "INLINE_INVALID_SECRET_d7f6f2a9_DO_NOT_DISCLOSE";

interface InvalidConfigurationResult {
  error: {
    code: "CONFIG_VALIDATION_ERROR";
    details: { errors: string[] };
    message: string;
  };
  ok: false;
}

const parseSingleDocument = (stdout: string): Record<string, unknown> => {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  expect(stdout.trim()).toBe(JSON.stringify(parsed, null, 2));
  return parsed;
};

const forbiddenForms = [
  canary,
  canary.slice(0, 12),
  Buffer.from(canary).toString("base64"),
  createHash("sha256").update(canary).digest("hex"),
];

const expectNoCanary = (...surfaces: unknown[]): void => {
  const rendered = surfaces
    .map((surface) => (typeof surface === "string" ? surface : JSON.stringify(surface)))
    .join("\n");
  for (const forbidden of forbiddenForms) {
    expect(rendered).not.toContain(forbidden);
  }
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("AC-02 invalid inline configuration precedence RED", () => {
  test("CLI emits one structured non-secret JSON document for an invalid nested snippet map", async () => {
    const workspace = await createChildHookWorkspace();
    cleanups.push(workspace.cleanup);
    const config = await readWorkspaceConfig(workspace.workspacePath);
    config.hooks = {
      scripts: {
        "pre-create": { bash: "printf safe", zsh: canary },
      },
      timeout: 1000,
    };
    await writeWorkspaceConfig(workspace.workspacePath, config);

    const result = await runArashi(workspace.workspacePath, [
      "create",
      "feature-invalid-inline-config",
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    const envelope = parseSingleDocument(result.stdout) as {
      error?: { code?: string; details?: { errors?: string[] } };
      ok?: boolean;
    };
    expect(envelope).toMatchObject({
      error: {
        code: "CONFIG_VALIDATION_ERROR",
        details: { errors: [expect.stringContaining("hooks.scripts.pre-create.zsh")] },
      },
      ok: false,
    });
    expectNoCanary(result.stdout, result.stderr, envelope);
  });

  test.each([
    ["create", ["create", "feature-invalid-order", "--json"]],
    ["remove", ["remove", "feature-invalid-order", "--force", "--json"]],
  ] as const)(
    "real %s entrypoint validates before Git, hook/interpreter process, or mutation effects",
    async (_command, args) => {
      const workspace = await createChildHookWorkspace();
      cleanups.push(workspace.cleanup);
      const config = await readWorkspaceConfig(workspace.workspacePath);
      config.hooks = {
        scripts: { "pre-create": { bash: "printf safe", zsh: canary } },
        timeout: 1000,
      };
      await writeWorkspaceConfig(workspace.workspacePath, config);

      const sentinels = join(workspace.workspacePath, ".arashi", "effect-sentinels");
      const record = join(workspace.workspacePath, ".arashi", "effect-sentinel.log");
      await mkdir(sentinels, { recursive: true });
      for (const executable of ["git", "bash"]) {
        const path = join(sentinels, executable);
        await writeFile(
          path,
          `#!/bin/sh\nprintf '${executable} %s\\n' "$*" >> '${record}'\nexit 99\n`,
        );
        await chmod(path, 0o755);
      }
      const hookPath = join(workspace.workspacePath, ".arashi", "hooks", "pre-create.sh");
      await mkdir(join(workspace.workspacePath, ".arashi", "hooks"), { recursive: true });
      await writeFile(hookPath, `#!/bin/sh\nprintf 'hook\\n' >> '${record}'\nexit 99\n`);
      await chmod(hookPath, 0o755);
      const worktreesRoot = join(workspace.workspacePath, ".arashi", "worktrees");
      const before = await readdir(worktreesRoot).catch(() => [] as string[]);

      const result = await runArashiWithEnv(workspace.workspacePath, [...args], {
        PATH: sentinels,
      });
      const envelope = parseSingleDocument(result.stdout) as unknown as InvalidConfigurationResult;
      expect(envelope).toMatchObject({
        error: {
          code: "CONFIG_VALIDATION_ERROR",
          details: { errors: [expect.stringContaining("hooks.scripts.pre-create.zsh")] },
        },
        ok: false,
      });
      await expect(readdir(worktreesRoot).catch(() => [] as string[])).resolves.toEqual(before);
      expect(await readFile(record, "utf8").catch(() => "")).toBe("");
      expectNoCanary(result.stdout, result.stderr, envelope);
    },
  );
});
