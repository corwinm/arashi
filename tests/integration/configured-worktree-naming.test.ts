import { afterEach, describe, expect, test } from "vitest";
import { mkdir, rm, symlink } from "fs/promises";
import { join } from "path";
import { exec } from "../../src/lib/git.ts";
import { runtime } from "../helpers/node-runtime.ts";
import type {
  Config,
  WorktreeNamingBranchSlashes,
  WorktreeNamingStyle,
} from "../../src/lib/config.ts";
import type { Repository } from "../../src/core/repository.ts";
import { calculateWorktreePath, calculateWorktreePathPlan } from "../../src/core/worktree.ts";

const root = join(import.meta.dirname, "..", "temp-integration-workspace", "worktree-naming");
const CLI_ENTRY = join(import.meta.dirname, "../../src/index.ts");
const styles: WorktreeNamingStyle[] = ["default", "branch", "repo-branch"];
const slashPolicies: WorktreeNamingBranchSlashes[] = ["preserve", "flatten"];

const expectedRelative = (
  style: WorktreeNamingStyle,
  slashPolicy: WorktreeNamingBranchSlashes,
  bare: boolean,
  branch: string,
): string => {
  const branchComponent = slashPolicy === "flatten" ? branch.replaceAll("/", "-") : branch;
  if (style === "repo-branch") {
    return `canonical-${branchComponent}`;
  }
  if (style === "default" && bare) {
    return join("canonical", branchComponent);
  }
  return branchComponent;
};

describe("configured worktree naming matrix", () => {
  afterEach(async () => rm(root, { force: true, recursive: true }));

  test.each(
    styles.flatMap((style) =>
      slashPolicies.flatMap((branchSlashes) =>
        [false, true].flatMap((bare) =>
          ["feature", "feature/auth"].map((branch) => ({ bare, branch, branchSlashes, style })),
        ),
      ),
    ),
  )(
    "resolves $style/$branchSlashes bare=$bare branch=$branch",
    async ({ bare, branch, branchSlashes, style }) => {
      const repositoryPath = join(root, bare ? "filesystem.git" : "filesystem");
      await mkdir(repositoryPath, { recursive: true });
      await exec(bare ? ["init", "--bare"] : ["init", "-b", "main"], repositoryPath);
      const repository: Repository = {
        defaultBranch: "main",
        hasSetupScript: false,
        name: "configured-authority",
        path: repositoryPath,
        worktreeName: "canonical",
      };
      const config: Config = {
        repos: {},
        reposDir: "./repos",
        version: "1.0.0",
        worktreeNaming: { branchSlashes, style },
      };

      const result = await calculateWorktreePath(repository, branch, config, {
        reason: "configured parent",
        type: "meta-repo",
      });

      expect(result.path).toBe(
        join(
          repositoryPath,
          ".arashi",
          "worktrees",
          expectedRelative(style, branchSlashes, bare, branch),
        ),
      );
    },
  );

  test("uses terminal .git fallback only when canonical worktreeName is unavailable", async () => {
    const repositoryPath = join(root, "filesystem-name.git");
    await mkdir(repositoryPath, { recursive: true });
    await exec(["init", "--bare"], repositoryPath);

    const result = await calculateWorktreePath(
      {
        defaultBranch: "main",
        hasSetupScript: false,
        name: "filesystem-name.git",
        path: repositoryPath,
      },
      "feature/auth",
      {
        repos: {},
        reposDir: "./repos",
        version: "1.0.0",
        worktreeNaming: { style: "repo-branch" },
      },
      { reason: "configured parent", type: "meta-repo" },
    );

    expect(result.path).toBe(
      join(repositoryPath, ".arashi", "worktrees", "filesystem-name-feature", "auth"),
    );
  });

  test("does not apply configured naming to standalone worktrees", async () => {
    const repositoryPath = join(root, "standalone");
    await mkdir(repositoryPath, { recursive: true });
    await exec(["init", "-b", "main"], repositoryPath);

    const result = await calculateWorktreePath(
      {
        defaultBranch: "main",
        hasSetupScript: false,
        name: "standalone",
        path: repositoryPath,
        worktreeName: "canonical",
      },
      "feature/auth",
      {
        repos: {},
        reposDir: "./repos",
        version: "1.0.0",
        worktreeNaming: { branchSlashes: "flatten", style: "repo-branch" },
      },
      { reason: "standalone", type: "standalone" },
    );

    expect(result.path).toBe(join(repositoryPath, ".worktrees", "feature", "auth"));
  });

  test("classifies an invalid traversal branch before configured destination planning", async () => {
    const repositoryPath = join(root, "invalid-cli-branch");
    await mkdir(join(repositoryPath, ".arashi"), { recursive: true });
    await exec(["init", "-b", "main"], repositoryPath);
    await runtime.write(
      join(repositoryPath, ".arashi", "config.json"),
      JSON.stringify({ repos: {}, reposDir: "./repos", version: "1.0.0" }),
    );

    const child = runtime.spawn(
      [process.execPath, CLI_ENTRY, "create", "../escape", "--no-progress", "--no-hooks", "--json"],
      { cwd: repositoryPath, stderr: "pipe", stdout: "pipe" },
    );
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();

    expect(await child.exited, `${stdout}\n${stderr}`).toBe(1);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      error: {
        code: "INVALID_BRANCH_NAME",
        details: { branchName: "../escape" },
      },
      ok: false,
    });
  });

  test("rejects a lexical destination escape from the configured worktree root", async () => {
    const repositoryPath = join(root, "lexical-containment");
    await mkdir(repositoryPath, { recursive: true });
    await exec(["init", "-b", "main"], repositoryPath);

    await expect(
      calculateWorktreePath(
        {
          defaultBranch: "main",
          hasSetupScript: false,
          name: "lexical-containment",
          path: repositoryPath,
        },
        "../escape",
        { repos: {}, reposDir: "./repos", version: "1.0.0" },
        { reason: "configured parent", type: "meta-repo" },
      ),
    ).rejects.toMatchObject({
      code: "WORKTREE_DESTINATION_COLLISION",
      details: {
        conflict: {
          repositoryName: "lexical-containment",
          worktreePath: join(repositoryPath, ".arashi", "escape"),
        },
      },
    });
  });

  test.skipIf(process.platform === "win32")(
    "rejects a destination that escapes through a symlink beneath the configured worktree root",
    async () => {
      const repositoryPath = join(root, "canonical-containment");
      const outsidePath = join(root, "outside");
      const worktreeRoot = join(repositoryPath, ".arashi", "worktrees");
      await mkdir(worktreeRoot, { recursive: true });
      await mkdir(outsidePath);
      await exec(["init", "-b", "main"], repositoryPath);
      await symlink(outsidePath, join(worktreeRoot, "feature"), "dir");

      await expect(
        calculateWorktreePath(
          {
            defaultBranch: "main",
            hasSetupScript: false,
            name: "canonical-containment",
            path: repositoryPath,
          },
          "feature/auth",
          { repos: {}, reposDir: "./repos", version: "1.0.0" },
          { reason: "configured parent", type: "meta-repo" },
        ),
      ).rejects.toMatchObject({
        code: "WORKTREE_DESTINATION_COLLISION",
        details: {
          conflict: {
            repositoryName: "canonical-containment",
            worktreePath: join(worktreeRoot, "feature", "auth"),
          },
        },
      });
    },
  );

  test("keeps coordinated children beneath the one configured parent destination", async () => {
    const repositoryPath = join(root, "coordinated");
    const childPath = join(repositoryPath, "repos", "child");
    await mkdir(join(repositoryPath, ".arashi"), { recursive: true });
    await mkdir(childPath, { recursive: true });
    await runtime.write(
      join(repositoryPath, ".arashi", "config.json"),
      JSON.stringify({ repos: {}, reposDir: "./repos", version: "1.0.0" }),
    );
    await exec(["init", "-b", "main"], repositoryPath);
    await exec(["init", "-b", "main"], childPath);
    const parent: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "coordinated",
      path: repositoryPath,
      worktreeName: "parent",
    };
    const child: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "child",
      path: childPath,
    };
    const config: Config = {
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
      worktreeNaming: { branchSlashes: "flatten", style: "repo-branch" },
    };

    const plan = await calculateWorktreePathPlan([parent, child], "feature/auth", config);
    const parentDestination = join(repositoryPath, ".arashi", "worktrees", "parent-feature-auth");
    expect(plan.get(parent)?.path).toBe(parentDestination);
    expect(plan.get(child)).toMatchObject({
      parentWorktreePath: parentDestination,
      path: join(parentDestination, "repos", "child"),
    });
  });

  test("preserves the full configured path for nested coordinated children", async () => {
    const repositoryPath = join(root, "nested-coordinated");
    const childPath = join(repositoryPath, "packages", "repos", "group", "child");
    await mkdir(join(repositoryPath, ".arashi"), { recursive: true });
    await mkdir(childPath, { recursive: true });
    await exec(["init", "-b", "main"], repositoryPath);
    await exec(["init", "-b", "main"], childPath);
    const parent: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "nested-coordinated",
      path: repositoryPath,
      worktreeName: "parent",
    };
    const child: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "child",
      path: childPath,
    };
    const config: Config = {
      repos: {},
      reposDir: "./packages/repos",
      version: "1.0.0",
      worktreeNaming: { branchSlashes: "flatten", style: "repo-branch" },
    };

    const plan = await calculateWorktreePathPlan([parent, child], "feature/auth", config, parent);
    const parentDestination = join(repositoryPath, ".arashi", "worktrees", "parent-feature-auth");
    expect(plan.get(child)).toMatchObject({
      parentWorktreePath: parentDestination,
      path: join(parentDestination, "packages", "repos", "group", "child"),
      repositoryType: "child",
    });
  });

  test("keeps bare coordinated children beneath the authoritative parent without a physical config file", async () => {
    const repositoryPath = join(root, "coordinated.git");
    const childPath = join(repositoryPath, "repos", "child");
    await mkdir(childPath, { recursive: true });
    await exec(["init", "--bare"], repositoryPath);
    await exec(["init", "-b", "main"], childPath);
    const parent: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "coordinated.git",
      path: repositoryPath,
    };
    const child: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "child",
      path: childPath,
    };
    const config: Config = {
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
      worktreeNaming: { branchSlashes: "flatten", style: "repo-branch" },
    };

    const plan = await calculateWorktreePathPlan([parent, child], "feature/auth", config, parent);
    const parentDestination = join(
      repositoryPath,
      ".arashi",
      "worktrees",
      "coordinated-feature-auth",
    );
    expect(plan.get(parent)?.path).toBe(parentDestination);
    expect(plan.get(child)).toMatchObject({
      parentWorktreePath: parentDestination,
      path: join(parentDestination, "repos", "child"),
      repositoryType: "child",
    });
  });

  test("keeps the Git branch exact, reports one flattened destination, and rejects its alias", async () => {
    const repositoryPath = join(root, "cli-parity");
    await mkdir(join(repositoryPath, ".arashi"), { recursive: true });
    await exec(["init", "-b", "main"], repositoryPath);
    await exec(["config", "user.name", "Test User"], repositoryPath);
    await exec(["config", "user.email", "test@example.com"], repositoryPath);
    await runtime.write(join(repositoryPath, "README.md"), "fixture\n");
    await exec(["add", "README.md"], repositoryPath);
    await exec(["commit", "-m", "fixture"], repositoryPath);
    await runtime.write(
      join(repositoryPath, ".arashi", "config.json"),
      JSON.stringify({
        repos: {},
        reposDir: "./repos",
        version: "1.0.0",
        worktreeNaming: { branchSlashes: "flatten", style: "repo-branch" },
      }),
    );
    const destination = join(repositoryPath, ".arashi", "worktrees", "cli-parity-feature-auth");
    const runCreate = async (branch: string, args: string[]) => {
      const child = runtime.spawn(
        [process.execPath, CLI_ENTRY, "create", branch, "--no-progress", "--no-hooks", ...args],
        { cwd: repositoryPath, stderr: "pipe", stdout: "pipe" },
      );
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      return { exitCode: await child.exited, stderr, stdout };
    };

    const dryRun = await runCreate("feature/auth", ["--dry-run", "--json"]);
    expect(dryRun.exitCode, `${dryRun.stdout}\n${dryRun.stderr}`).toBe(0);
    expect(JSON.parse(dryRun.stdout).data.dryRunOutcome.plannedWorktrees[0].worktreePath).toBe(
      destination,
    );

    const human = await runCreate("feature/auth", []);
    expect(human.exitCode, `${human.stdout}\n${human.stderr}`).toBe(0);
    expect(`${human.stdout}\n${human.stderr}`).toContain(destination);
    await expect(exec(["show-ref", "--verify", "refs/heads/feature/auth"], repositoryPath))
      .resolves;

    const jsonReuse = await runCreate("feature/auth", ["--conflict", "REUSE_EXISTING", "--json"]);
    expect(jsonReuse.exitCode, `${jsonReuse.stdout}\n${jsonReuse.stderr}`).toBe(0);
    expect(JSON.parse(jsonReuse.stdout).data.repositories[0].worktreePath).toBe(destination);

    const alias = await runCreate("feature-auth", ["--json"]);
    expect(alias.exitCode, `${alias.stdout}\n${alias.stderr}`).toBe(1);
    expect(JSON.parse(alias.stdout)).toMatchObject({
      error: {
        code: "WORKTREE_DESTINATION_COLLISION",
        details: { conflict: { worktreePath: destination } },
      },
      ok: false,
    });
    await expect(
      exec(["show-ref", "--verify", "refs/heads/feature-auth"], repositoryPath),
    ).rejects.toBeDefined();
  }, 20_000);
});
