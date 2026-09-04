import { runtime } from "../helpers/node-runtime.ts";
import { afterEach, describe, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "fs/promises";
import type { RepoStatus } from "../../src/commands/status.ts";
import { join } from "path";
import {
  quoteDoctorShellArgument,
  repositoryStatusToDoctorFindings,
} from "../../src/lib/doctor.ts";
import { tmpdir } from "os";

const CLI_ENTRY = join(import.meta.dirname, "..", "..", "src", "index.ts");

interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

const tempDirs: string[] = [];

const makeTempDir = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "arashi-doctor-"));
  tempDirs.push(path);
  return path;
};

const runCommand = async (cwd: string, args: string[]): Promise<CommandResult> => {
  const proc = runtime.spawn(args, { cwd, stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr, stdout };
};

const runArashi = async (cwd: string, args: string[]): Promise<CommandResult> =>
  runCommand(cwd, [
    process.execPath,

    CLI_ENTRY,
    ...args,
  ]);

const runGit = async (cwd: string, args: string[]): Promise<string> => {
  const result = await runCommand(cwd, ["git", ...args]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Git command failed");
  }
  return result.stdout.trim();
};

const parseSingleJsonDocument = (stdout: string): Record<string, unknown> => {
  expect(stdout.endsWith("\n")).toBe(true);
  const parsed = JSON.parse(stdout);
  expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(stdout);
  return parsed as Record<string, unknown>;
};

const jsonData = (parsed: Record<string, unknown>): Record<string, unknown> => {
  if (parsed.ok === false) {
    return ((parsed.error as Record<string, unknown>).details ?? {}) as Record<string, unknown>;
  }
  return parsed.data as Record<string, unknown>;
};

const jsonFindings = (parsed: Record<string, unknown>): Record<string, unknown>[] => {
  const data = jsonData(parsed);
  expect(Array.isArray(data.findings)).toBe(true);
  return data.findings as Record<string, unknown>[];
};

const writeWorkspaceConfig = async (
  workspaceRoot: string,
  repos: Record<string, { path: string; gitUrl?: string; hooks?: Record<string, unknown> }> = {},
  hooks?: Record<string, unknown>,
): Promise<void> => {
  await mkdir(join(workspaceRoot, ".arashi"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".arashi", "config.json"),
    JSON.stringify(
      { ...(hooks === undefined ? {} : { hooks }), repos, reposDir: "./repos", version: "1.0.0" },
      null,
      2,
    ),
  );
};

const initializeGitRepository = async (repoPath: string): Promise<void> => {
  await mkdir(repoPath, { recursive: true });
  await runGit(repoPath, ["init", "-b", "main"]);
  await runGit(repoPath, ["config", "user.email", "test@example.com"]);
  await runGit(repoPath, ["config", "user.name", "Test User"]);
  await writeFile(join(repoPath, "README.md"), `# ${repoPath}\n`);
  await runGit(repoPath, ["add", "."]);
  await runGit(repoPath, ["commit", "-m", "Initial commit"]);
};

const createBareRemote = async (baseDir: string, name: string): Promise<string> => {
  const remotePath = join(baseDir, `${name}.git`);
  await runGit(baseDir, ["init", "--bare", remotePath]);
  return remotePath;
};

const seedRemote = async (baseDir: string, remotePath: string, seedName: string): Promise<void> => {
  const seedPath = join(baseDir, seedName);
  await runGit(baseDir, ["clone", remotePath, seedPath]);
  await runGit(seedPath, ["config", "user.email", "test@example.com"]);
  await runGit(seedPath, ["config", "user.name", "Test User"]);
  await writeFile(join(seedPath, "README.md"), `# ${seedName}\n`);
  await runGit(seedPath, ["add", "."]);
  await runGit(seedPath, ["commit", "-m", "Initial commit"]);
  await runGit(seedPath, ["push", "origin", "HEAD:main"]);
  await runGit(remotePath, ["symbolic-ref", "HEAD", "refs/heads/main"]);
};

const createHealthyRemoteBackedWorkspace = async (): Promise<string> => {
  const baseDir = await makeTempDir();
  const mainRemote = await createBareRemote(baseDir, "main-remote");
  const repoRemote = await createBareRemote(baseDir, "repo-a-remote");
  await seedRemote(baseDir, mainRemote, "main-seed");
  await seedRemote(baseDir, repoRemote, "repo-a-seed");

  const workspaceRoot = join(baseDir, "workspace");
  await runGit(baseDir, ["clone", mainRemote, workspaceRoot]);
  await runGit(workspaceRoot, ["checkout", "-B", "main", "origin/main"]);
  await runGit(workspaceRoot, ["config", "user.email", "test@example.com"]);
  await runGit(workspaceRoot, ["config", "user.name", "Test User"]);
  await mkdir(join(workspaceRoot, "repos"), { recursive: true });
  await runGit(join(workspaceRoot, "repos"), ["clone", repoRemote, "repo-a"]);
  await runGit(join(workspaceRoot, "repos", "repo-a"), ["checkout", "-B", "main", "origin/main"]);
  await writeWorkspaceConfig(workspaceRoot, {
    "repo-a": { gitUrl: repoRemote, path: "./repos/repo-a" },
  });
  await writeFile(join(workspaceRoot, ".gitignore"), "repos/\n.arashi/worktrees/\n");
  await runGit(workspaceRoot, ["add", ".arashi/config.json", ".gitignore"]);
  await runGit(workspaceRoot, ["commit", "-m", "Add Arashi config"]);
  await runGit(workspaceRoot, ["push", "origin", "HEAD:main"]);
  return workspaceRoot;
};

const createLocalWorkspace = async (): Promise<string> => {
  const workspaceRoot = await makeTempDir();
  await initializeGitRepository(workspaceRoot);
  await writeWorkspaceConfig(workspaceRoot, { "repo-a": { path: "./repos/repo-a" } });
  await runGit(workspaceRoot, ["add", ".arashi/config.json"]);
  await runGit(workspaceRoot, ["commit", "-m", "Add Arashi config"]);
  return workspaceRoot;
};

const createBareBackedLinkedWorkspace = async (): Promise<string> => {
  const baseDir = await makeTempDir();
  const remotePath = await createBareRemote(baseDir, "origin");
  await seedRemote(baseDir, remotePath, "seed");

  const bareWorkspace = join(baseDir, "workspace.git");
  const workspaceRoot = join(baseDir, "main");
  await runGit(baseDir, ["clone", "--bare", remotePath, bareWorkspace]);
  await runGit(bareWorkspace, ["worktree", "add", workspaceRoot, "main"]);
  await runGit(workspaceRoot, ["config", "user.email", "test@example.com"]);
  await runGit(workspaceRoot, ["config", "user.name", "Test User"]);
  await runGit(workspaceRoot, ["config", "branch.main.remote", "origin"]);
  await runGit(workspaceRoot, ["config", "branch.main.merge", "refs/heads/main"]);
  await runGit(workspaceRoot, ["update-ref", "refs/remotes/origin/main", "refs/heads/main"]);
  await writeWorkspaceConfig(workspaceRoot);
  await writeFile(join(workspaceRoot, ".gitignore"), "repos/\n.arashi/worktrees/\n");
  await runGit(workspaceRoot, ["add", ".arashi/config.json", ".gitignore"]);
  await runGit(workspaceRoot, ["commit", "-m", "Add Arashi config"]);
  return workspaceRoot;
};

const baseStatus = (): RepoStatus => ({
  branch: {
    ahead: 0,
    behind: 0,
    isDetached: false,
    localBranch: "main",
    remoteBranch: "origin/main",
  },
  defaultBranch: { ahead: 0, behind: 0, branch: "main", state: "available" },
  error: null,
  files: [],
  name: "repo-a",
  path: "/tmp/repo-a",
  refreshWarning: null,
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("arashi doctor", () => {
  test("reports a healthy workspace in human and JSON modes", async () => {
    const workspaceRoot = await createHealthyRemoteBackedWorkspace();

    const human = await runArashi(workspaceRoot, ["doctor"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("No workspace health findings");

    const json = await runArashi(workspaceRoot, ["doctor", "--json"]);
    expect(json.exitCode).toBe(0);
    const parsed = parseSingleJsonDocument(json.stdout);
    expect(parsed).toMatchObject({ command: "doctor", ok: true, schemaVersion: 1, warnings: [] });
    const data = jsonData(parsed);
    expect(data.workspaceRoot).toBe(await realpath(workspaceRoot));
    expect(data.summary).toMatchObject({ error: 0, info: 0, total: 0, warning: 0 });
    expect(data.findings).toEqual([]);
    expect(json.stdout).not.toContain("Arashi workspace doctor");
  });

  test("checks children but not work-tree status for a bare workspace root", async () => {
    const parent = await makeTempDir();
    const workspaceRoot = join(parent, "workspace.git");
    await runGit(parent, ["init", "--bare", workspaceRoot]);

    const init = await runArashi(workspaceRoot, ["init", "--no-discover", "--json"]);
    expect(init.exitCode, `${init.stdout}\n${init.stderr}`).toBe(0);

    const childPath = join(workspaceRoot, "repos", "repo-a");
    await initializeGitRepository(childPath);
    await writeFile(join(childPath, "dirty.txt"), "dirty\n");
    await writeWorkspaceConfig(workspaceRoot, { "repo-a": { path: "./repos/repo-a" } });

    const result = await runArashi(workspaceRoot, ["doctor", "--json"]);
    const findings = jsonFindings(parseSingleJsonDocument(result.stdout));

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "REPOSITORY_DIRTY", scope: "repository:repo-a" }),
    );
    expect(findings).not.toContainEqual(
      expect.objectContaining({
        code: "REPOSITORY_STATUS_FAILED",
        details: expect.objectContaining({ path: workspaceRoot }),
      }),
    );
  });

  test("preserves repository findings when root Git metadata is broken", async () => {
    const workspaceRoot = await createLocalWorkspace();
    const childPath = join(workspaceRoot, "repos", "repo-a");
    await initializeGitRepository(childPath);
    await writeFile(join(childPath, "dirty.txt"), "dirty\n");
    await rm(join(workspaceRoot, ".git"), { force: true, recursive: true });

    const result = await runArashi(workspaceRoot, ["doctor", "--json"]);
    const findings = jsonFindings(parseSingleJsonDocument(result.stdout));

    expect(result.exitCode).toBe(1);
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "REPOSITORY_STATUS_FAILED",
        details: expect.objectContaining({ path: await realpath(workspaceRoot) }),
        scope: "repository:Main Repository",
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "REPOSITORY_DIRTY", scope: "repository:repo-a" }),
    );
  });

  test("returns a blocking finding outside a workspace", async () => {
    const cwd = await makeTempDir();

    const result = await runArashi(cwd, ["doctor", "--json"]);

    expect(result.exitCode).not.toBe(0);
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toMatchObject({
      command: "doctor",
      error: { code: "DOCTOR_BLOCKING_FINDINGS" },
      ok: false,
    });
    expect(jsonFindings(parsed)).toContainEqual(
      expect.objectContaining({ code: "DOCTOR_NOT_IN_WORKSPACE", severity: "error" }),
    );
  });

  test("reports invalid configuration as blocking", async () => {
    const workspaceRoot = await makeTempDir();
    await mkdir(join(workspaceRoot, ".arashi"), { recursive: true });
    await writeFile(join(workspaceRoot, ".arashi", "config.json"), "{ not json");

    const result = await runArashi(workspaceRoot, ["doctor", "--json"]);

    expect(result.exitCode).not.toBe(0);
    expect(jsonFindings(parseSingleJsonDocument(result.stdout))).toContainEqual(
      expect.objectContaining({
        category: "configuration",
        code: "CONFIG_LOAD_FAILED",
        severity: "error",
      }),
    );
  });

  test("reports missing and dirty repositories", async () => {
    const workspaceRoot = await createLocalWorkspace();
    await mkdir(join(workspaceRoot, "repos", "repo-a"), { recursive: true });
    await initializeGitRepository(join(workspaceRoot, "repos", "repo-a"));
    await writeFile(join(workspaceRoot, "repos", "repo-a", "dirty.txt"), "dirty\n");
    await writeWorkspaceConfig(workspaceRoot, {
      "missing-repo": { path: "./repos/missing-repo" },
      "repo-a": { path: "./repos/repo-a" },
    });

    const result = await runArashi(workspaceRoot, ["doctor", "--json"]);

    expect(result.exitCode).not.toBe(0);
    const codes = jsonFindings(parseSingleJsonDocument(result.stdout)).map(
      (finding) => finding.code,
    );
    expect(codes).toContain("REPOSITORY_MISSING");
    expect(codes).toContain("REPOSITORY_DIRTY");
  });

  test("reports stale worktree metadata without pruning it", async () => {
    const workspaceRoot = await createHealthyRemoteBackedWorkspace();
    const stalePath = join(workspaceRoot, "../doctor-stale-worktree");
    await runGit(workspaceRoot, ["worktree", "add", stalePath, "-b", "feat/doctor-stale"]);
    await rm(stalePath, { force: true, recursive: true });

    const result = await runArashi(workspaceRoot, ["doctor", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(jsonFindings(parseSingleJsonDocument(result.stdout))).toContainEqual(
      expect.objectContaining({ code: "WORKTREE_STALE_METADATA", severity: "warning" }),
    );
    const listOutput = await runGit(workspaceRoot, ["worktree", "list", "--porcelain"]);
    expect(listOutput).toContain(stalePath.replaceAll("\\", "/"));
    expect(listOutput).toContain("prunable");
  });

  test("reports hook diagnostics", async () => {
    const workspaceRoot = await createHealthyRemoteBackedWorkspace();
    const hookDir = join(workspaceRoot, ".arashi", "hooks");
    await mkdir(hookDir, { recursive: true });
    const hookPath = join(
      hookDir,
      process.platform === "win32" ? "pre-create.ps1" : "pre-create.sh",
    );
    await writeFile(hookPath, process.platform === "win32" ? "exit 0\n" : "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") await chmod(hookPath, 0o644);
    await writeFile(join(hookDir, "unsupported-hook.sh"), "#!/bin/sh\nexit 0\n");

    const result = await runArashi(workspaceRoot, ["doctor", "--json"]);

    expect(result.exitCode).not.toBe(0);
    const codes = jsonFindings(parseSingleJsonDocument(result.stdout)).map(
      (finding) => finding.code,
    );
    if (process.platform !== "win32") expect(codes).toContain("HOOK_NOT_EXECUTABLE");
    expect(codes).toContain("HOOK_UNSUPPORTED_DEFINITION");
  });

  test.runIf(process.platform !== "win32")(
    "reports an unavailable interpreter for an inline create lifecycle without exposing its snippet",
    async () => {
      const workspaceRoot = await createLocalWorkspace();
      await initializeGitRepository(join(workspaceRoot, "repos", "repo-a"));
      const snippet = "echo doctor-private-payload";
      await writeWorkspaceConfig(
        workspaceRoot,
        { "repo-a": { path: "./repos/repo-a" } },
        { scripts: { "pre-create": { cmd: snippet } } },
      );

      const result = await runArashi(workspaceRoot, ["doctor", "--json"]);
      const findings = jsonFindings(parseSingleJsonDocument(result.stdout));

      expect(result.exitCode).toBe(1);
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: "HOOK_INTERPRETER_UNAVAILABLE",
          details: expect.objectContaining({
            hookName: "pre-create",
            sourceKind: "inline-config",
            sourceScriptPath: null,
          }),
          scope: "hook:workspace:workspace:pre-create",
        }),
      );
      expect(result.stdout).not.toContain(snippet);
      expect(result.stderr).not.toContain(snippet);
    },
  );

  test("composes a root repository inline remove hook with the workspace native file", async () => {
    const workspaceRoot = await createLocalWorkspace();
    const hookDir = join(workspaceRoot, ".arashi", "hooks");
    await mkdir(hookDir, { recursive: true });
    const hookPath = join(
      hookDir,
      process.platform === "win32" ? "pre-remove.ps1" : "pre-remove.sh",
    );
    await writeFile(hookPath, process.platform === "win32" ? "exit 0\n" : "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") await chmod(hookPath, 0o755);
    await writeWorkspaceConfig(workspaceRoot, {
      root: {
        hooks: {
          "pre-remove":
            process.platform === "win32" ? { powershell: "exit 0" } : { bash: "exit 0" },
        },
        path: ".",
      },
    });

    const result = await runArashi(workspaceRoot, ["doctor", "--json"]);
    const findings = jsonFindings(parseSingleJsonDocument(result.stdout));

    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "HOOK_CONFIGURED",
        details: expect.objectContaining({
          hookName: "pre-remove",
          sourceKind: "inline-config",
          sourceOwnerKind: "repository",
          sourceOwnerName: "root",
        }),
        scope: "hook:repository:root:pre-remove",
      }),
    );
    expect(findings).not.toContainEqual(
      expect.objectContaining({
        code: "HOOK_AMBIGUOUS",
        scope: "hook:repository:root:pre-remove",
      }),
    );
  });
  test("reports qualified and compatible repository remove aliases with bounded ordered paths", async () => {
    const workspaceRoot = await createLocalWorkspace();
    const repositoryPath = join(workspaceRoot, "repos", "repo-a");
    await initializeGitRepository(repositoryPath);
    await writeWorkspaceConfig(workspaceRoot, { "repo-a": { path: "./repos/repo-a" } });
    const canonical = join(
      workspaceRoot,
      ".arashi",
      "hooks",
      process.platform === "win32" ? "pre-remove.repo-a.ps1" : "pre-remove.repo-a.sh",
    );
    const compatible = join(
      repositoryPath,
      ".arashi",
      "hooks",
      process.platform === "win32" ? "pre-remove.cmd" : "pre-remove.sh",
    );
    const misplacedQualified = join(
      repositoryPath,
      ".arashi",
      "hooks",
      process.platform === "win32" ? "post-remove.repo-a.ps1" : "post-remove.repo-a.sh",
    );
    const misCasedCanonical = join(workspaceRoot, ".arashi", "hooks", "post-remove.REPO-A.sh");
    await mkdir(join(canonical, ".."), { recursive: true });
    await mkdir(join(compatible, ".."), { recursive: true });
    await writeFile(canonical, process.platform === "win32" ? "exit 0\n" : "#!/bin/sh\nexit 0\n");
    await writeFile(
      compatible,
      process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
    );
    await writeFile(
      misplacedQualified,
      process.platform === "win32" ? "exit 0\n" : "#!/bin/sh\nexit 0\n",
    );
    if (process.platform !== "win32") {
      await writeFile(misCasedCanonical, "#!/bin/sh\nexit 0\n");
    }
    if (process.platform !== "win32") {
      await chmod(canonical, 0o755);
      await chmod(compatible, 0o755);
    }

    const result = await runArashi(workspaceRoot, ["doctor", "--json"]);
    const finding = jsonFindings(parseSingleJsonDocument(result.stdout)).find(
      (candidate) =>
        candidate.code === "HOOK_AMBIGUOUS" &&
        candidate.scope === "hook:repository:repo-a:pre-remove",
    );
    expect(result.exitCode).toBe(1);
    expect(finding?.details).toEqual({
      hookName: "pre-remove",
      scope: "repository",
      sourceKinds: ["file", "file"],
      sourceOwnerKind: "repository",
      sourceOwnerName: "repo-a",
      sourceScriptPath: null,
      sourceScriptPaths: [await realpath(canonical), await realpath(compatible)],
    });
    expect(jsonFindings(parseSingleJsonDocument(result.stdout))).not.toContainEqual(
      expect.objectContaining({
        code: "HOOK_UNSUPPORTED_DEFINITION",
        details: expect.objectContaining({ hookFile: await realpath(canonical) }),
      }),
    );
    expect(jsonFindings(parseSingleJsonDocument(result.stdout))).toContainEqual(
      expect.objectContaining({
        code: "HOOK_UNSUPPORTED_DEFINITION",
        details: expect.objectContaining({ hookFile: await realpath(misplacedQualified) }),
      }),
    );
    if (process.platform !== "win32") {
      expect(jsonFindings(parseSingleJsonDocument(result.stdout))).toContainEqual(
        expect.objectContaining({
          code: "HOOK_UNSUPPORTED_DEFINITION",
          details: expect.objectContaining({ hookFile: await realpath(misCasedCanonical) }),
        }),
      );
    }
  });

  test("represents inline configuration with every native path in three-way ambiguity", async () => {
    const workspaceRoot = await createLocalWorkspace();
    const repositoryPath = join(workspaceRoot, "repos", "repo-a");
    await initializeGitRepository(repositoryPath);
    await writeWorkspaceConfig(workspaceRoot, {
      "repo-a": {
        hooks: {
          "pre-remove":
            process.platform === "win32" ? { powershell: "exit 0" } : { bash: "exit 0" },
        },
        path: "./repos/repo-a",
      },
    });
    const extensions = process.platform === "win32" ? ["ps1", "cmd", "bat"] : ["sh"];
    const canonical = extensions.map((extension) =>
      join(workspaceRoot, ".arashi", "hooks", `pre-remove.repo-a.${extension}`),
    );
    const compatible = extensions.map((extension) =>
      join(repositoryPath, ".arashi", "hooks", `pre-remove.${extension}`),
    );
    for (const path of [...canonical, ...compatible]) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, process.platform === "win32" ? "exit 0\r\n" : "#!/bin/sh\nexit 0\n");
      if (process.platform !== "win32") await chmod(path, 0o755);
    }

    const result = await runArashi(workspaceRoot, ["doctor", "--json"]);
    const finding = jsonFindings(parseSingleJsonDocument(result.stdout)).find(
      (candidate) =>
        candidate.code === "HOOK_AMBIGUOUS" &&
        candidate.scope === "hook:repository:repo-a:pre-remove",
    );
    const expectedPaths = await Promise.all(
      [...canonical, ...compatible].map((path) => realpath(path)),
    );

    expect(result.exitCode).toBe(1);
    expect(finding?.details).toEqual({
      hookName: "pre-remove",
      scope: "repository",
      sourceKinds: ["file", "inline-config"],
      sourceOwnerKind: "repository",
      sourceOwnerName: "repo-a",
      sourceScriptPath: null,
      sourceScriptPaths: expectedPaths,
    });
  });

  test("diagnoses conflicting topology after a configured-ref refresh failure", async () => {
    const workspaceRoot = await createBareBackedLinkedWorkspace();
    await runGit(workspaceRoot, [
      "config",
      "remote.origin.fetch",
      "+refs/heads/main:refs/remotes/origin/main/sub",
    ]);

    const result = await runArashi(workspaceRoot, ["doctor", "--json"]);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    const findings = jsonFindings(parseSingleJsonDocument(result.stdout));

    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "REPOSITORY_UPSTREAM_TRACKING_UNAVAILABLE",
        details: expect.objectContaining({
          conflictingFetchRefspecs: ["+refs/heads/main:refs/remotes/origin/main/sub"],
        }),
      }),
    );
  });

  test("diagnoses an unusable configured upstream in a bare-backed linked worktree", async () => {
    const workspaceRoot = await createBareBackedLinkedWorkspace();
    const canonicalRoot = await realpath(workspaceRoot);
    const before = {
      branches: await runGit(workspaceRoot, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/heads",
      ]),
      config: await runGit(workspaceRoot, ["config", "--local", "--list"]),
      worktrees: await runGit(workspaceRoot, ["worktree", "list", "--porcelain"]),
    };

    const human = await runArashi(workspaceRoot, ["doctor"]);
    expect(human.exitCode, `${human.stdout}\n${human.stderr}`).toBe(0);
    expect(human.stdout).toContain("REPOSITORY_UPSTREAM_TRACKING_UNAVAILABLE");
    expect(human.stdout).toContain("has upstream configuration");
    expect(human.stdout).toContain(
      `git -C '${canonicalRoot}' config --add 'remote.origin.fetch' '+refs/heads/main:refs/remotes/origin/main'`,
    );

    const json = await runArashi(workspaceRoot, ["doctor", "--json"]);
    expect(json.exitCode, `${json.stdout}\n${json.stderr}`).toBe(0);
    const parsed = parseSingleJsonDocument(json.stdout);
    const findings = jsonFindings(parsed);
    expect(findings).toContainEqual({
      category: "repository",
      code: "REPOSITORY_UPSTREAM_TRACKING_UNAVAILABLE",
      details: {
        branch: "main",
        conflictingFetchRefspecs: [],
        expectedRemoteTrackingRef: "refs/remotes/origin/main",
        mergeRef: "refs/heads/main",
        path: canonicalRoot,
        reason: "missing-fetch-mapping",
        remote: "origin",
        repository: "Main Repository",
      },
      message:
        "Repository 'Main Repository' branch 'main' has upstream configuration, but Git cannot use origin/main because remote 'origin' has no covering fetch mapping.",
      scope: "repository:Main Repository",
      severity: "warning",
      suggestedCommands: [
        `git -C '${canonicalRoot}' config --add 'remote.origin.fetch' '+refs/heads/main:refs/remotes/origin/main'`,
        `git -C '${canonicalRoot}' fetch -- 'origin'`,
        `git -C '${canonicalRoot}' branch '--set-upstream-to=origin/main' -- 'main'`,
      ],
    });
    expect(findings).not.toContainEqual(
      expect.objectContaining({ code: "REPOSITORY_NO_UPSTREAM" }),
    );
    expect(json.stdout).not.toContain("Arashi workspace doctor");

    await expect(runGit(workspaceRoot, ["config", "--local", "--list"])).resolves.toBe(
      before.config,
    );
    await expect(
      runGit(workspaceRoot, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]),
    ).resolves.toBe(before.branches);
    await expect(runGit(workspaceRoot, ["worktree", "list", "--porcelain"])).resolves.toBe(
      before.worktrees,
    );
  });
});

describe("repositoryStatusToDoctorFindings", () => {
  test("quotes Git-derived remediation arguments for POSIX shells", () => {
    const value = "feature/'$(touch${IFS}/tmp/arashi293)";

    expect(quoteDoctorShellArgument(value)).toBe(`'feature/'"'"'$(touch\${IFS}/tmp/arashi293)'`);
  });

  test("does not emit shell-ambiguous remediation commands on Windows", () => {
    const status = baseStatus();
    status.branch.remoteBranch = null;

    const findings = repositoryStatusToDoctorFindings(
      status,
      {
        conflictingFetchRefspecs: [],
        expectedRemoteTrackingRef: "refs/remotes/origin/main",
        kind: "missing-fetch-mapping",
        localBranch: "main",
        mergeRef: "refs/heads/main",
        remote: "origin",
        remoteBranch: "main",
      },
      "win32",
    );

    const finding = findings.find(
      (candidate) => candidate.code === "REPOSITORY_UPSTREAM_TRACKING_UNAVAILABLE",
    );
    expect(finding?.message).toContain("active Windows shell");
    expect(finding?.suggestedCommands).toEqual([]);
  });

  test("classifies branch divergence and default branch drift", () => {
    const status = baseStatus();
    status.branch.ahead = 2;
    status.branch.behind = 1;
    status.defaultBranch = { ahead: 0, behind: 3, branch: "main", state: "available" };

    const codes = repositoryStatusToDoctorFindings(status).map((finding) => finding.code);

    expect(codes).toContain("REPOSITORY_DIVERGED");
    expect(codes).toContain("REPOSITORY_DEFAULT_BRANCH_BEHIND");
  });

  test("reports configured-base drift with remote details and de-duplicates default drift", () => {
    const status = baseStatus();
    status.baseBranchSource = "repository-config";
    status.baseBranch = {
      ahead: 1,
      behind: 3,
      branch: "develop",
      compareRef: "refs/remotes/origin/develop",
      remote: "origin",
      remoteRef: "origin/develop",
      state: "available",
    };
    status.defaultBranch = { ...status.baseBranch };

    const findings = repositoryStatusToDoctorFindings(status);
    const baseFinding = findings.find(
      (finding) => finding.code === "REPOSITORY_CONFIGURED_BASE_BEHIND",
    );

    expect(baseFinding).toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          alsoDefault: true,
          remoteRef: "origin/develop",
          source: "repository-config",
        }),
        suggestedCommands: expect.arrayContaining(["arashi pull"]),
      }),
    );
    expect(findings).not.toContainEqual(
      expect.objectContaining({ code: "REPOSITORY_DEFAULT_BRANCH_BEHIND" }),
    );
  });

  test("keeps same-named configured and default drift distinct across remotes", () => {
    const status = baseStatus();
    status.baseBranch = {
      ahead: 0,
      behind: 2,
      branch: "main",
      compareRef: "refs/remotes/origin/main",
      remote: "origin",
      remoteRef: "origin/main",
      state: "available",
    };
    status.defaultBranch = {
      ahead: 0,
      behind: 4,
      branch: "main",
      compareRef: "refs/remotes/fork/main",
      remote: "fork",
      remoteRef: "fork/main",
      state: "available",
    };

    const findings = repositoryStatusToDoctorFindings(status);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "REPOSITORY_CONFIGURED_BASE_BEHIND" }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "REPOSITORY_DEFAULT_BRANCH_BEHIND" }),
    );
  });

  test("reports an unavailable configured base without falling back", () => {
    const status = baseStatus();
    status.baseBranch = {
      branch: "develop",
      compareRef: "refs/remotes/origin/develop",
      details: { error: "couldn't find remote ref refs/heads/develop" },
      message: "couldn't find remote ref refs/heads/develop",
      reason: "refresh-failed",
      remote: "origin",
      remoteRef: "origin/develop",
      state: "unavailable",
    };

    expect(repositoryStatusToDoctorFindings(status)).toContainEqual(
      expect.objectContaining({
        code: "REPOSITORY_CONFIGURED_BASE_UNAVAILABLE",
        details: expect.objectContaining({
          reason: "refresh-failed",
          failure: { error: "couldn't find remote ref refs/heads/develop" },
        }),
        severity: "warning",
      }),
    );
  });

  test("classifies detached heads and missing remote refs", () => {
    const detached = baseStatus();
    detached.branch = {
      ahead: 0,
      behind: 0,
      isDetached: true,
      localBranch: "",
      remoteBranch: null,
    };
    const missingRemote = baseStatus();
    missingRemote.refreshWarning = {
      kind: "missing-remote-ref",
      message: "couldn't find remote ref",
    };

    expect(repositoryStatusToDoctorFindings(detached).map((finding) => finding.code)).toContain(
      "REPOSITORY_DETACHED_HEAD",
    );
    expect(
      repositoryStatusToDoctorFindings(missingRemote).map((finding) => finding.code),
    ).toContain("REPOSITORY_MISSING_REMOTE_REF");
  });

  test("uses topology-aware findings only for a diagnosed missing fetch mapping", () => {
    const status = baseStatus();
    status.branch.remoteBranch = null;

    const findings = repositoryStatusToDoctorFindings(status, {
      expectedRemoteTrackingRef: "refs/remotes/origin/main",
      kind: "missing-fetch-mapping",
      localBranch: "main",
      mergeRef: "refs/heads/main",
      remote: "origin",
      remoteBranch: "main",
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "REPOSITORY_UPSTREAM_TRACKING_UNAVAILABLE",
        details: expect.objectContaining({ reason: "missing-fetch-mapping" }),
      }),
    );
    expect(findings).not.toContainEqual(
      expect.objectContaining({ code: "REPOSITORY_NO_UPSTREAM" }),
    );
  });

  test("does not reset an existing multi-merge upstream", () => {
    const status = baseStatus();
    status.branch.remoteBranch = null;

    const findings = repositoryStatusToDoctorFindings(status, {
      expectedRemoteTrackingRef: "refs/remotes/origin/main",
      hasMultipleMergeRefs: true,
      kind: "missing-fetch-mapping",
      localBranch: "main",
      mergeRef: "refs/heads/main",
      remote: "origin",
      remoteBranch: "main",
    });

    const finding = findings.find(
      (candidate) => candidate.code === "REPOSITORY_UPSTREAM_TRACKING_UNAVAILABLE",
    );
    expect(finding?.suggestedCommands).toEqual([
      `git -C '${status.path}' config --add 'remote.origin.fetch' '+refs/heads/main:refs/remotes/origin/main'`,
      `git -C '${status.path}' fetch -- 'origin'`,
    ]);
  });

  test("reports conflicting fetch destinations for manual resolution", () => {
    const status = baseStatus();
    status.branch.remoteBranch = null;

    const findings = repositoryStatusToDoctorFindings(status, {
      conflictingFetchRefspecs: [
        "+refs/heads/trunk:refs/remotes/origin/main",
        "+refs/heads/release/*:refs/remotes/origin/*",
      ],
      expectedRemoteTrackingRef: "refs/remotes/origin/main",
      kind: "missing-fetch-mapping",
      localBranch: "main",
      mergeRef: "refs/heads/main",
      remote: "origin",
      remoteBranch: "main",
    });

    const finding = findings.find(
      (candidate) => candidate.code === "REPOSITORY_UPSTREAM_TRACKING_UNAVAILABLE",
    );
    expect(finding?.message).toContain("review the conflicting fetch mappings manually");
    expect(finding?.suggestedCommands).toEqual([
      `git -C ${quoteDoctorShellArgument(status.path)} config --get-all ${quoteDoctorShellArgument("remote.origin.fetch")}`,
    ]);
  });

  test("keeps missing remote refs authoritative over topology diagnosis", () => {
    const status = baseStatus();
    status.branch.remoteBranch = null;
    status.refreshWarning = {
      kind: "missing-remote-ref",
      message: "couldn't find remote ref refs/heads/main",
    };

    const findings = repositoryStatusToDoctorFindings(status, {
      expectedRemoteTrackingRef: "refs/remotes/origin/main",
      kind: "missing-fetch-mapping",
      localBranch: "main",
      mergeRef: "refs/heads/main",
      remote: "origin",
      remoteBranch: "main",
    });

    expect(findings).toContainEqual(
      expect.objectContaining({ code: "REPOSITORY_MISSING_REMOTE_REF" }),
    );
    expect(findings).not.toContainEqual(
      expect.objectContaining({ code: "REPOSITORY_UPSTREAM_TRACKING_UNAVAILABLE" }),
    );
  });
});
