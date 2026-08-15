import { runtime } from "../helpers/node-runtime.ts";
import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const CLI_ENTRY = join(import.meta.dirname, "..", "..", "src", "index.ts");

interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

const tempDirs: string[] = [];

const makeTempDir = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "arashi-repo-groups-"));
  tempDirs.push(path);
  return path;
};

const runCommand = async (cwd: string, args: string[]): Promise<CommandResult> => {
  const proc = runtime.spawn(args, {
    cwd,
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

const runArashi = async (cwd: string, args: string[]): Promise<CommandResult> =>
  await runCommand(cwd, [
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

const initializeGitRepository = async (repoPath: string): Promise<void> => {
  await mkdir(repoPath, { recursive: true });
  await runGit(repoPath, ["init", "-b", "main"]);
  await runGit(repoPath, ["config", "user.email", "test@example.com"]);
  await runGit(repoPath, ["config", "user.name", "Test User"]);
  await writeFile(join(repoPath, "README.md"), `# ${repoPath}\n`);
  await runGit(repoPath, ["add", "."]);
  await runGit(repoPath, ["commit", "-m", "Initial commit"]);
};

const writeWorkspaceConfig = async (workspaceRoot: string): Promise<void> => {
  await mkdir(join(workspaceRoot, ".arashi"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".arashi", "config.json"),
    JSON.stringify(
      {
        repos: {
          "repo-a": { groups: ["core", "shared"], path: "./repos/repo-a" },
          "repo-b": { groups: ["docs", "shared"], path: "./repos/repo-b" },
        },
        reposDir: "./repos",
        version: "1.0.0",
      },
      null,
      2,
    ),
  );
};

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await makeTempDir();
  await initializeGitRepository(workspaceRoot);
  await initializeGitRepository(join(workspaceRoot, "repos", "repo-a"));
  await initializeGitRepository(join(workspaceRoot, "repos", "repo-b"));
  await writeWorkspaceConfig(workspaceRoot);
  await writeFile(join(workspaceRoot, ".gitignore"), "repos/\n");
  await runGit(workspaceRoot, ["add", ".arashi/config.json", ".gitignore"]);
  await runGit(workspaceRoot, ["commit", "-m", "Add Arashi config"]);

  return workspaceRoot;
};

const parseJson = (stdout: string): Record<string, unknown> => {
  expect(stdout.endsWith("\n")).toBe(true);
  return JSON.parse(stdout) as Record<string, unknown>;
};

type SelectorCommand = "create" | "exec" | "pull" | "push" | "setup" | "status" | "sync";

const selectorCommandArgs = (
  command: SelectorCommand,
  selectors: string[],
  json: boolean,
  suffix: string,
): string[] => {
  const jsonArgs = json ? ["--json"] : [];
  switch (command) {
    case "create":
      return ["create", `feature/selector-${suffix}`, ...selectors, ...jsonArgs];
    case "exec":
      return ["exec", ...selectors, ...jsonArgs, "--", "pwd"];
    case "push":
      return ["push", ...selectors, "--dry-run", ...jsonArgs];
    default:
      return [command, ...selectors, ...jsonArgs];
  }
};

const replaceChildrenWithSentinels = async (workspaceRoot: string): Promise<string[]> => {
  const sentinels = [
    join(workspaceRoot, "repos", "repo-a"),
    join(workspaceRoot, "repos", "repo-b"),
  ];
  for (const path of sentinels) {
    await rm(path, { force: true, recursive: true });
    await writeFile(path, "repository operations must not reach this sentinel\n");
  }
  return sentinels;
};

const expectSentinelsUntouched = async (sentinels: string[]): Promise<void> => {
  for (const path of sentinels) {
    await expect(readFile(path, "utf8")).resolves.toBe(
      "repository operations must not reach this sentinel\n",
    );
  }
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("repository group command integration", () => {
  test("configured selector failures are fail-closed through every consumer wrapper", async () => {
    const createWorkspaceRoot = await createWorkspace();
    const sentinelWorkspaceRoot = await createWorkspace();
    const sentinels = await replaceChildrenWithSentinels(sentinelWorkspaceRoot);
    const cases: Array<{
      command: SelectorCommand;
      expectedMessage: string;
      json: boolean;
      name: string;
      selectors: string[];
    }> = [
      {
        command: "create",
        expectedMessage: "Unknown repositories in --only filter: missing",
        json: false,
        name: "unknown-repository",
        selectors: ["--only", "missing"],
      },
      {
        command: "exec",
        expectedMessage: "Unknown repository groups in --group filter: missing",
        json: true,
        name: "unknown-group",
        selectors: ["--group", "missing"],
      },
      {
        command: "pull",
        expectedMessage: "Explicitly empty repository filter: --only",
        json: false,
        name: "explicit-empty",
        selectors: ["--only", ","],
      },
      {
        command: "push",
        expectedMessage: "No repositories matched the combined --only/--group filters",
        json: true,
        name: "empty-intersection",
        selectors: ["--only", "repo-a", "--group", "docs"],
      },
      {
        command: "setup",
        expectedMessage: "Unknown repositories in --only filter: missing",
        json: false,
        name: "unknown-repository",
        selectors: ["--only", "missing"],
      },
      {
        command: "status",
        expectedMessage: "Unknown repository groups in --group filter: missing",
        json: true,
        name: "unknown-group",
        selectors: ["--group", "missing"],
      },
      {
        command: "sync",
        expectedMessage: "No repositories matched the combined --only/--group filters",
        json: false,
        name: "empty-intersection",
        selectors: ["--only", "repo-a", "--group", "docs"],
      },
    ];

    for (const { command, expectedMessage, json, name, selectors } of cases) {
      const label = `${command}/${name}/${json ? "json" : "human"}`;
      const suffix = label.replaceAll("/", "-");
      const result = await runArashi(
        command === "create" ? createWorkspaceRoot : sentinelWorkspaceRoot,
        selectorCommandArgs(command, selectors, json, suffix),
      );
      expect(result.exitCode, `${label}: ${result.stderr}${result.stdout}`).not.toBe(0);
      if (json) {
        expect(result.stderr, label).toBe("");
        const envelope = parseJson(result.stdout);
        expect(envelope, label).toMatchObject({
          command,
          error: { message: expectedMessage },
          ok: false,
        });
        expect((envelope.error as { code: unknown }).code, label).toEqual(expect.any(String));
      } else {
        expect(result.stderr + result.stdout, label).toContain(expectedMessage);
      }
      if (command === "create") {
        for (const repositoryPath of [
          createWorkspaceRoot,
          join(createWorkspaceRoot, "repos", "repo-a"),
          join(createWorkspaceRoot, "repos", "repo-b"),
        ]) {
          expect(
            await runGit(repositoryPath, ["branch", "--list", `feature/selector-${suffix}`]),
          ).toBe("");
        }
      } else {
        await expectSentinelsUntouched(sentinels);
      }
    }
  });

  test("status narrows to the exact child intersection while retaining parent short, verbose, and JSON reporting", async () => {
    const workspaceRoot = await createWorkspace();
    await rm(join(workspaceRoot, "repos", "repo-b", ".git"), { force: true, recursive: true });

    const selectors = ["--only", "repo-a,repo-b", "--group", "core"];
    const short = await runArashi(workspaceRoot, ["status", ...selectors, "--short"]);
    expect(short.exitCode, short.stderr).toBe(0);
    expect(short.stdout).toContain(`${workspaceRoot} (main):`);
    expect(short.stdout).toContain(`${join(workspaceRoot, "repos", "repo-a")} (main):`);
    expect(short.stdout).not.toContain(join(workspaceRoot, "repos", "repo-b"));
    expect(short.stdout).toContain("Summary: 2 clean, 0 dirty");

    await writeFile(join(workspaceRoot, "repos", "repo-a", "README.md"), "dirty status detail\n");
    const verbose = await runArashi(workspaceRoot, ["status", ...selectors, "--verbose"]);
    expect(verbose.exitCode, verbose.stderr).toBe(0);
    expect(verbose.stdout).toContain("Main Repository");
    expect(verbose.stdout).toContain("repo-a");
    expect(verbose.stdout).not.toContain("repo-b");
    expect(verbose.stdout).toContain("Changes not staged for commit:");
    expect(verbose.stdout).toContain("modified:   README.md");
    expect(verbose.stdout).toContain("Summary: 1 clean, 1 dirty (2 total)");

    const json = await runArashi(workspaceRoot, ["status", ...selectors, "--json"]);
    expect(json.exitCode, json.stderr).toBe(0);
    expect(json.stderr).toBe("");
    const envelope = parseJson(json.stdout);
    expect(envelope).toMatchObject({
      command: "status",
      data: {
        filters: { groups: ["core"], only: ["repo-a", "repo-b"] },
        summary: { cleanCount: 1, dirtyCount: 1, total: 2 },
      },
      ok: true,
    });
    expect(
      (envelope.data as { repositories: { name: string }[] }).repositories.map(({ name }) => name),
    ).toEqual(["Main Repository", "repo-a"]);
  });

  test("a real command accumulates repeated comma-separated short selectors", async () => {
    const workspaceRoot = await createWorkspace();
    const result = await runArashi(workspaceRoot, [
      "status",
      "-o",
      " repo-a, repo-b, ",
      "-o",
      "repo-a",
      "-g",
      " shared, core, ",
      "--json",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseJson(result.stdout)).toMatchObject({
      command: "status",
      data: {
        filters: {
          groups: ["shared", "core"],
          only: ["repo-a", "repo-b"],
        },
      },
      ok: true,
    });
  });

  test("standalone create rejects selectors before branch mutation", async () => {
    const standaloneRoot = await makeTempDir();
    await initializeGitRepository(standaloneRoot);
    expect((await runArashi(standaloneRoot, ["init", "--zero-config"])).exitCode).toBe(0);

    const result = await runArashi(standaloneRoot, [
      "create",
      "feature/standalone-selector",
      "--only",
      "main",
      "--json",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(parseJson(result.stdout)).toMatchObject({
      command: "create",
      error: {
        message:
          "Repository selection is not meaningful in standalone mode; omit --only, --group, and --interactive.",
      },
      ok: false,
    });
    expect(await runGit(standaloneRoot, ["branch", "--list", "feature/standalone-selector"])).toBe(
      "",
    );
  });

  test("status reports its distinct standalone filter error in human and JSON modes", async () => {
    const standaloneRoot = await makeTempDir();
    await initializeGitRepository(standaloneRoot);
    expect((await runArashi(standaloneRoot, ["init", "--zero-config"])).exitCode).toBe(0);

    const human = await runArashi(standaloneRoot, ["status", "--only", "main"]);
    expect(human.exitCode).toBe(2);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain("not meaningful in standalone mode");
    expect(human.stderr).toContain("--only");

    const json = await runArashi(standaloneRoot, [
      "status",
      "--only",
      "main",
      "--group",
      "core",
      "--json",
    ]);
    expect(json.exitCode).toBe(2);
    expect(json.stderr).toBe("");
    expect(parseJson(json.stdout)).toMatchObject({
      command: "status",
      error: { code: "STANDALONE_FILTER_UNSUPPORTED" },
      ok: false,
    });
  });

  test("create --group supports dry-run planning and rejects empty intersections before mutation", async () => {
    const workspaceRoot = await createWorkspace();

    const dryRun = await runArashi(workspaceRoot, [
      "create",
      "feature/group-dry-run",
      "--group",
      "core",
      "--dry-run",
    ]);
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).toContain("Planning worktrees in 1 repository");
    expect(dryRun.stdout).toContain("repo-a: feature/group-dry-run");
    expect(dryRun.stdout).not.toContain("repo-b: feature/group-dry-run");
    expect(
      await runGit(join(workspaceRoot, "repos", "repo-a"), [
        "branch",
        "--list",
        "feature/group-dry-run",
      ]),
    ).toBe("");

    const empty = await runArashi(workspaceRoot, [
      "create",
      "feature/group-empty",
      "--only",
      "repo-b",
      "--group",
      "core",
    ]);
    expect(empty.exitCode).not.toBe(0);
    expect(empty.stderr + empty.stdout).toContain(
      "No repositories matched the combined --only/--group filters",
    );
    expect(
      await runGit(join(workspaceRoot, "repos", "repo-b"), [
        "branch",
        "--list",
        "feature/group-empty",
      ]),
    ).toBe("");
  });

  test("exec --group supports multi-group selection and --only intersections", async () => {
    const workspaceRoot = await createWorkspace();

    const multiGroup = await runArashi(workspaceRoot, [
      "exec",
      "--group",
      "core,docs",
      "--",
      "pwd",
    ]);
    expect(multiGroup.exitCode).toBe(0);
    expect(multiGroup.stdout).toContain("[repo-a] ok (0)");
    expect(multiGroup.stdout).toContain("[repo-b] ok (0)");
    expect(multiGroup.stdout).toContain("Summary: 2 passed, 0 failed, 0 skipped, 2 total");

    const intersection = await runArashi(workspaceRoot, [
      "exec",
      "--group",
      "shared",
      "--only",
      "repo-a",
      "--",
      "pwd",
    ]);
    expect(intersection.exitCode).toBe(0);
    expect(intersection.stdout).toContain("[repo-a] ok (0)");
    expect(intersection.stdout).not.toContain("[repo-b]");
  });
});
