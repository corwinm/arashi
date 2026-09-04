import {
  DEFAULT_LIFECYCLE_HOOK_TIMEOUT,
  buildHookEnvironment,
  buildRemoveHookOperationData,
  discoverConfiguredRepositoryRemoveHookCandidates,
  discoverLifecycleHook,
  executeHook,
  getHookSpawnCommand,
  resolveHookInputMode,
} from "../../src/lib/hooks.ts";
import { normalizeConfig } from "../../src/lib/config.ts";
import { getInitHookTemplates } from "../../src/commands/init.ts";
import { afterEach, describe, expect, test, vi } from "vitest";
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
  test("bounds configured repository remove aliases to six candidates in location and extension order", async () => {
    const root = await tempRoot();
    const repository = join(root, "repos", "app");
    const canonicalDirectory = join(root, ".arashi", "hooks");
    const compatibleDirectory = join(repository, ".arashi", "hooks");
    await mkdir(canonicalDirectory, { recursive: true });
    await mkdir(compatibleDirectory, { recursive: true });
    const canonical = ["ps1", "cmd", "bat"].map((extension) =>
      join(canonicalDirectory, `pre-remove.app.${extension}`),
    );
    const compatible = ["ps1", "cmd", "bat"].map((extension) =>
      join(compatibleDirectory, `pre-remove.${extension}`),
    );
    await Promise.all([...canonical, ...compatible].map((path) => writeFile(path, "exit 0\n")));

    const candidates = await discoverConfiguredRepositoryRemoveHookCandidates({
      activeRepositoryPath: repository,
      configurationRoot: root,
      lifecycle: "pre-remove",
      platform: "win32",
      repositoryName: "app",
    });

    expect(candidates).toEqual([...canonical, ...compatible]);
    expect(candidates).toHaveLength(6);
    expect(Object.isFrozen(candidates)).toBe(true);
  });
  test("resolves one fail-closed command-wide hook input mode", () => {
    expect(resolveHookInputMode({ stdinIsTTY: true })).toBe("tty");
    expect(resolveHookInputMode({ hookInput: false, stdinIsTTY: true })).toBe("disabled");
    expect(resolveHookInputMode({ json: true, hookInput: true, stdinIsTTY: true })).toBe(
      "disabled",
    );
    expect(resolveHookInputMode({ stdinIsTTY: false })).toBe("unavailable");
  });

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

  test("fails closed when Linux process enumeration is unavailable", async () => {
    const source = await readFile(join(process.cwd(), "src", "lib", "hooks.ts"), "utf8");
    expect(source).toMatch(
      /try \{\s*processEntries = readdirSync\("\/proc", \{ withFileTypes: true \}\);\s*\} catch \{\s*return \[\];\s*\}/,
    );
  });

  test("validates both cmd and bat hooks through cmd.exe", async () => {
    const source = await readFile(join(process.cwd(), "src", "lib", "hooks.ts"), "utf8");
    expect(source).toContain('const interpreter = /\\.(?:cmd|bat)$/i.test(hookPath) ? "cmd.exe"');
  });

  test("routes configured remove hooks through centralized spinner ownership", async () => {
    const source = await readFile(join(process.cwd(), "src", "commands", "remove.ts"), "utf8");
    expect(source).toMatch(
      /hookInputMode: options\.hookInputMode,[\s\S]*outputSpinner: hookSpinner,/,
    );
  });

  test("stops configured and standalone hook chains after SIGINT", async () => {
    const [configuredSource, standaloneSource] = await Promise.all([
      readFile(join(process.cwd(), "src", "commands", "remove.ts"), "utf8"),
      readFile(join(process.cwd(), "src", "lib", "standalone.ts"), "utf8"),
    ]);
    expect(configuredSource).toContain(
      'if (options.stopOnFailure || result.signalCode === "SIGINT")',
    );
    expect(standaloneSource).toContain(
      'if (!result.success && (!continueOnFailure || result.signalCode === "SIGINT"))',
    );
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
      hookInputMode: "tty",
      operationData: {
        HOOK_INPUT: "forged",
        HOOK_NAME: "forged",
        HOOK_SCOPE: "forged",
        HOOK_EXECUTION_PATH: "/forged",
      },
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
      ARASHI_HOOK_INPUT: "tty",
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

  test("uses the input-capable normative native Windows interpreter argv", () => {
    expect(getHookSpawnCommand("C:\\hooks\\pre-create.PS1", "win32")).toEqual([
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",

      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\hooks\\pre-create.PS1",
    ]);
    expect(getHookSpawnCommand("C:\\hooks\\pre-remove.cmd", "win32")).toEqual([
      "C:\\hooks\\pre-remove.cmd",
    ]);
  });

  test("unavailable input is immediate EOF and authoritative in the child environment", async () => {
    if (process.platform === "win32") return;
    const root = await tempRoot();
    const script = join(root, "eof.sh");
    await writeFile(
      script,
      "#!/bin/sh\nprintf '%s:' \"$ARASHI_HOOK_INPUT\"\nif IFS= read -r answer; then printf 'read:%s' \"$answer\"; else printf 'eof'; fi\n",
    );
    await chmod(script, 0o755);

    const result = await executeHook({
      context: {
        hookInputMode: "unavailable",
        hookName: "pre-create",
        operationData: { HOOK_INPUT: "forged" },
        repoPath: root,
      },
      hookInputMode: "unavailable",
      hookName: "pre-create",
      quiet: true,
      scriptPath: script,
      timeout: 2_000,
    });

    expect(result.success).toBe(true);
    expect(result.stdout).toBe("unavailable:eof");
    expect(result.duration).toBeLessThan(2_000);
  });

  test("direct executor callers fail closed when no command-wide input mode is supplied", async () => {
    if (process.platform === "win32") return;
    const root = await tempRoot();
    const script = join(root, "direct.sh");
    await writeFile(script, "#!/bin/sh\nprintf '%s' \"$ARASHI_HOOK_INPUT\"\n");
    await chmod(script, 0o755);
    const hadOwnIsTTY = Object.hasOwn(process.stdin, "isTTY");
    const previousIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });

    try {
      const result = await executeHook({
        context: {
          hookName: "pre-create",
          operationData: {},
          repoPath: root,
        },
        hookName: "pre-create",
        quiet: true,
        scriptPath: script,
      });

      expect(result.stdout).toBe("unavailable");
    } finally {
      if (hadOwnIsTTY) {
        Object.defineProperty(process.stdin, "isTTY", {
          configurable: true,
          value: previousIsTTY,
        });
      } else {
        delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
      }
    }
  });

  test("tty hooks stream raw unterminated bytes while preserving exact per-stream capture", async () => {
    if (process.platform === "win32") return;
    const root = await tempRoot();
    const script = join(root, "raw.sh");
    await writeFile(
      script,
      "#!/bin/sh\nprintf 'prompt> '\nprintf 'error> ' >&2\nprintf '\\n\\nend\\n\\n'\nprintf '\\nerr-end\\n\\n' >&2\n",
    );
    await chmod(script, 0o755);
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"),
      );
      return true;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"),
      );
      return true;
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const result = await executeHook({
        context: {
          hookInputMode: "tty",
          hookName: "pre-create",
          hookScope: "workspace",
          operationData: {},
          repoPath: root,
          sourceScriptPath: script,
          workspaceMode: "configured",
        },
        hookInputMode: "tty",
        hookName: "pre-create",
        scriptPath: script,
      });

      expect(result.stdout).toBe("prompt> \n\nend\n\n");
      expect(result.stderr).toBe("error> \nerr-end\n\n");
      expect(stdoutChunks.join("")).toBe(result.stdout);
      expect(stderrChunks.join("")).toBe(result.stderr);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/pre-create.*workspace.*raw\.sh/));
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      log.mockRestore();
    }
  });

  test.each([
    [
      "PowerShell",
      "native.ps1",
      '$answer = Read-Host "answer"\nif ([string]::IsNullOrEmpty($answer)) { Write-Output "$env:ARASHI_HOOK_INPUT:eof" } else { exit 91 }\n',
    ],
    [
      "cmd",
      "native.cmd",
      '@echo off\nset "answer="\nset /p "answer=answer> "\nif defined answer exit /b 91\necho %ARASHI_HOOK_INPUT%:eof\n',
    ],
  ])(
    "native Windows %s hooks receive disabled mode and immediate EOF",
    async (_shell, name, body) => {
      if (process.platform !== "win32") return;
      const root = await tempRoot();
      const script = join(root, name);
      await writeFile(script, body);

      const result = await executeHook({
        context: { hookName: "pre-create", operationData: {}, repoPath: root },
        hookInputMode: "disabled",
        hookName: "pre-create",
        quiet: true,
        scriptPath: script,
        timeout: 2_000,
      });

      expect(result.success, result.stderr).toBe(true);
      expect(result.stdout).toContain("disabled:eof");
      expect(result.duration).toBeLessThan(2_000);
    },
  );

  test("init examples teach native input availability without soliciting secrets", () => {
    const posix = getInitHookTemplates("linux")
      .map((template) => template.content)
      .join("\n");
    expect(posix).toContain("ARASHI_HOOK_INPUT");
    expect(posix).toMatch(/ARASHI_HOOK_INPUT.*tty[\s\S]*printf[^\n]*>&2[\s\S]*read/);
    expect(posix).toMatch(/password[\s\S]*token[\s\S]*secret/i);

    const windows = getInitHookTemplates("win32");
    const powershell = windows.filter((template) => template.filename.endsWith(".ps1.example"));
    const cmd = windows.filter((template) => template.filename.endsWith(".cmd.example"));
    expect(powershell).toHaveLength(8);
    expect(cmd).toHaveLength(8);
    for (const lifecycle of ["pre-remove", "post-remove"]) {
      const template = powershell.find(
        ({ filename }) => filename === `${lifecycle}.REPO.ps1.example`,
      );
      expect(template?.content).toContain("ARASHI_HOOK_TARGET_REPO_PATH");
      expect(template?.content).toContain("$env:ARASHI_HOOK_TARGET_REPO_PATH");
      expect(template?.content).not.toContain("ARASHI_PARENT_REPO_PATH");
      expect(template?.content).not.toContain("ARASHI_HOOK_TARGET_WORKTREE_PATH");
    }
    const powershellContent = powershell.map((template) => template.content).join("\n");
    const cmdContent = cmd.map((template) => template.content).join("\n");
    expect(powershellContent).toMatch(
      /ARASHI_HOOK_INPUT[\s\S]*\[Console\]::Error\.Write[\s\S]*Read-Host/,
    );
    expect(cmdContent).toMatch(/ARASHI_HOOK_INPUT[\s\S]*set \/p/);
    expect(cmdContent).toMatch(/<nul set \/p[^\n]*1>&2[\s\S]*set \/p "ARASHI_HOOK_ANSWER="/);
    for (const content of [powershellContent, cmdContent]) {
      expect(content).toMatch(/tty, disabled, or unavailable/);
      expect(content).toMatch(/immediate EOF/);
      expect(content).toMatch(/--no-hook-input/);
      expect(content).toMatch(/does not skip hooks/);
      expect(content).toMatch(/--json takes precedence/);
    }
    for (const template of cmd) {
      expect(template.content).not.toMatch(/if "%ARASHI_HOOK_INPUT%"=="tty" \(/);
      expect(template.content).toMatch(
        /if not "%ARASHI_HOOK_INPUT%"=="tty" goto arashi_hook_input_done[\s\S]*set \/p[\s\S]*:arashi_hook_input_done/,
      );
    }
  });
});
