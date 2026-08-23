/* oxlint-disable sort-imports */
import { afterEach, describe, expect, test } from "vitest";
import {
  access,
  chmod,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createChildHookWorkspace } from "../helpers/create-child-hook-workspace.ts";
import { createRepoSpecificHookInRepo } from "../helpers/hooks.ts";
import { runtime } from "../helpers/node-runtime.ts";
import { exec } from "../../src/lib/git.ts";

const CLI_ENTRY = join(import.meta.dirname, "../../src/index.ts");
type Workspace = Awaited<ReturnType<typeof createChildHookWorkspace>>;
const workspaces: Workspace[] = [];

interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

const runArashi = async (cwd: string, ...args: string[]): Promise<CommandResult> => {
  const proc = runtime.spawn([process.execPath, CLI_ENTRY, ...args], {
    cwd,
    env: { ...process.env, HOME: tmpdir(), NO_COLOR: "1" },
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

const parseSingleDocument = (stdout: string): Record<string, unknown> => {
  expect(stdout.endsWith("\n")).toBe(true);
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  expect(stdout).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
};

const configure = async (
  workspace: Workspace,
  policies: Record<string, { copy?: string[]; symlink?: string[] }>,
): Promise<void> => {
  const configPath = join(workspace.workspacePath, ".arashi", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    repos: Record<string, Record<string, unknown>>;
  };
  for (const [repository, policy] of Object.entries(policies)) {
    config.repos[repository] = { ...config.repos[repository], ...policy };
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
};

const prepareSources = async (workspace: Workspace, repository = "alpha") => {
  const source = workspace.childRepoPaths[repository]!;
  await writeFile(join(source, ".env.local"), "TOP-SECRET-CONTENT\n");
  await mkdir(join(source, "assets with spaces", "nested"), { recursive: true });
  await writeFile(join(source, "assets with spaces", "nested", "value$.txt"), "asset\n");
  await mkdir(join(source, ".shared-cache"), { recursive: true });
  await writeFile(join(source, ".shared-cache", "cache.txt"), "cache-target\n");
  return source;
};

const absent = async (path: string) => {
  await expect(access(path)).rejects.toThrow();
};

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()));
});

describe("configured create materialization lifecycle and output RED", () => {
  test("runs Git, repository pre-hook, copy, symlink, and post-hook in order with exact JSON outcomes", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
    workspaces.push(workspace);
    const source = await prepareSources(workspace);
    await configure(workspace, {
      alpha: {
        copy: [".env.local", "assets with spaces", "optional-missing.txt"],
        symlink: [".shared-cache"],
      },
    });
    const branch = "feature/materialization-order";
    const destination = workspace.getChildWorktreePath("alpha", branch);
    const order = join(workspace.workspacePath, ".arashi", "materialization-order.log");
    createRepoSpecificHookInRepo(
      workspace.hookRootPath,
      "pre-create",
      "alpha",
      `test -d "$ARASHI_WORKTREE_PATH/.git" || test -f "$ARASHI_WORKTREE_PATH/.git"
test ! -e "$ARASHI_WORKTREE_PATH/.env.local"
printf 'pre\\n' >> '${order}'`,
    );
    createRepoSpecificHookInRepo(
      workspace.hookRootPath,
      "post-create",
      "alpha",
      `test -f "$ARASHI_WORKTREE_PATH/.env.local"
test -f "$ARASHI_WORKTREE_PATH/assets with spaces/nested/value$.txt"
test -L "$ARASHI_WORKTREE_PATH/.shared-cache"
printf 'post\\n' >> '${order}'`,
    );

    const result = await runArashi(
      workspace.workspacePath,
      "create",
      branch,
      "--only",
      "alpha",
      "--no-progress",
      "--json",
    );

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");
    const envelope = parseSingleDocument(result.stdout);
    expect(envelope).toMatchObject({ command: "create", ok: true });
    const data = envelope.data as { repositoryResults: Record<string, unknown>[] };
    expect(data.repositoryResults).toHaveLength(1);
    expect(data.repositoryResults[0]?.materializationOutcomes).toEqual([
      {
        action: "copy",
        message: "Copied '.env.local'",
        path: ".env.local",
        reasonCode: "none",
        status: "copied",
      },
      {
        action: "copy",
        message: "Copied 'assets with spaces'",
        path: "assets with spaces",
        reasonCode: "none",
        status: "copied",
      },
      {
        action: "copy",
        message: "Source is missing; entry is optional",
        path: "optional-missing.txt",
        reasonCode: "source_missing",
        status: "skipped",
      },
      {
        action: "symlink",
        message: "Linked '.shared-cache'",
        path: ".shared-cache",
        reasonCode: "none",
        status: "linked",
      },
    ]);
    expect(await readFile(order, "utf8")).toBe("pre\npost\n");
    expect(await readFile(join(destination, ".env.local"), "utf8")).toBe("TOP-SECRET-CONTENT\n");
    expect(await readlink(join(destination, ".shared-cache"))).toBe(
      await import("node:fs/promises").then(({ realpath }) =>
        realpath(join(source, ".shared-cache")),
      ),
    );
    expect(result.stdout).not.toContain("TOP-SECRET-CONTENT");
  });

  test("preflights and executes the resolved base when only a stale remote-tracking target exists", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
    workspaces.push(workspace);
    const source = workspace.childRepoPaths.alpha!;
    const branch = "feature/stale-remote-materialization";
    await exec(["switch", "-c", branch], source);
    await writeFile(join(source, ".env.local"), "REMOTE-ONLY-CONTENT\n");
    await exec(["add", ".env.local"], source);
    await exec(["-c", "commit.gpgSign=false", "commit", "-m", "remote-only fixture"], source);
    const remoteOnlyOid = (await exec(["rev-parse", "HEAD"], source)).stdout.trim();
    await exec(["switch", "main"], source);
    await exec(["update-ref", `refs/remotes/origin/${branch}`, remoteOnlyOid], source);
    await exec(["branch", "-D", branch], source);
    await writeFile(join(source, ".env.local"), "PRIMARY-SOURCE-CONTENT\n");
    await configure(workspace, { alpha: { copy: [".env.local"] } });

    const result = await runArashi(
      workspace.workspacePath,
      "create",
      branch,
      "--only",
      "alpha",
      "--conflict",
      "REUSE_EXISTING",
      "--no-hooks",
      "--json",
    );

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(
      await readFile(join(workspace.getChildWorktreePath("alpha", branch), ".env.local"), "utf8"),
    ).toBe("PRIMARY-SOURCE-CONTENT\n");
    expect((await exec(["rev-parse", branch], source)).stdout.trim()).not.toBe(remoteOnlyOid);
  });

  test("preflights and executes the existing local branch when reuse is selected", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
    workspaces.push(workspace);
    const source = workspace.childRepoPaths.alpha!;
    const branch = "feature/local-reuse-materialization";
    await exec(["switch", "-c", branch], source);
    await writeFile(join(source, "branch-only.txt"), "LOCAL-BRANCH-CONTENT\n");
    await exec(["add", "branch-only.txt"], source);
    await exec(["-c", "commit.gpgSign=false", "commit", "-m", "local reuse fixture"], source);
    const localBranchOid = (await exec(["rev-parse", "HEAD"], source)).stdout.trim();
    await exec(["switch", "main"], source);
    await writeFile(join(source, ".env.local"), "PRIMARY-SOURCE-CONTENT\n");
    await configure(workspace, { alpha: { copy: [".env.local"] } });

    const result = await runArashi(
      workspace.workspacePath,
      "create",
      branch,
      "--only",
      "alpha",
      "--conflict",
      "REUSE_EXISTING",
      "--no-hooks",
      "--json",
    );

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    const destination = workspace.getChildWorktreePath("alpha", branch);
    expect((await exec(["rev-parse", "HEAD"], destination)).stdout.trim()).toBe(localBranchOid);
    expect(await readFile(join(destination, "branch-only.txt"), "utf8")).toBe(
      "LOCAL-BRANCH-CONTENT\n",
    );
    expect(await readFile(join(destination, ".env.local"), "utf8")).toBe(
      "PRIMARY-SOURCE-CONTENT\n",
    );
  });

  test("keeps the root destination authoritative when filters exclude the root and a nested meta-repo", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha", "beta"] });
    workspaces.push(workspace);
    await mkdir(join(workspace.childRepoPaths.alpha!, ".arashi"), { recursive: true });
    await writeFile(
      join(workspace.childRepoPaths.alpha!, ".arashi", "config.json"),
      `${JSON.stringify({ repos: {}, reposDir: "./repos", version: "1.0.0" }, null, 2)}\n`,
    );
    const branch = "feature/filtered-root-authority";

    const result = await runArashi(
      workspace.workspacePath,
      "create",
      branch,
      "--only",
      "beta",
      "--dry-run",
      "--no-hooks",
      "--json",
    );

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(parseSingleDocument(result.stdout)).toMatchObject({
      data: {
        dryRunOutcome: {
          plannedWorktrees: [
            {
              repositoryName: "beta",
              worktreePath: join(
                await realpath(workspace.workspacePath),
                ".arashi",
                "worktrees",
                branch,
                "repos",
                "beta",
              ),
            },
          ],
        },
      },
      ok: true,
    });
  });

  test("preserves correct copy and symlink entries in an exact reused worktree as no-ops", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
    workspaces.push(workspace);
    const source = await prepareSources(workspace);
    await writeFile(join(source, ".fresh.local"), "NEW-CONTENT\n");
    const branch = "feature/exact-reuse-materialization";
    await configure(workspace, {
      alpha: { copy: [".env.local", ".fresh.local"], symlink: [".shared-cache"] },
    });
    const destination = workspace.getChildWorktreePath("alpha", branch);
    await mkdir(dirname(destination), { recursive: true });
    await exec(["worktree", "add", "-b", branch, destination, "main"], source);
    await writeFile(join(destination, ".env.local"), "TOP-SECRET-CONTENT\n");
    await symlink(
      await realpath(join(source, ".shared-cache")),
      join(destination, ".shared-cache"),
    );
    const linkBefore = await readlink(join(destination, ".shared-cache"));

    const result = await runArashi(
      workspace.workspacePath,
      "create",
      branch,
      "--only",
      "alpha",
      "--conflict",
      "REUSE_EXISTING",
      "--no-hooks",
      "--json",
    );

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(await readFile(join(destination, ".env.local"), "utf8")).toBe("TOP-SECRET-CONTENT\n");
    expect(await readFile(join(destination, ".fresh.local"), "utf8")).toBe("NEW-CONTENT\n");
    expect(await readlink(join(destination, ".shared-cache"))).toBe(linkBefore);
    expect(parseSingleDocument(result.stdout)).toMatchObject({
      data: {
        repositoryResults: [
          {
            materializationOutcomes: [
              expect.objectContaining({ action: "copy", status: "skipped" }),
              expect.objectContaining({ action: "copy", path: ".fresh.local", status: "copied" }),
              expect.objectContaining({ action: "symlink", status: "skipped" }),
            ],
            repositoryName: "alpha",
          },
        ],
      },
      ok: true,
    });
  });

  test("refreshes reuse plans through the local branch when a tag has the same name", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
    workspaces.push(workspace);
    const source = workspace.childRepoPaths.alpha!;
    const branch = "materialization-ambiguous-ref";
    await exec(["switch", "-c", "tag-source"], source);
    await writeFile(join(source, "tag-only.txt"), "TAG-ONLY-CONTENT\n");
    await exec(["add", "tag-only.txt"], source);
    await exec(["-c", "commit.gpgSign=false", "commit", "-m", "ambiguous tag fixture"], source);
    await exec(["tag", branch], source);
    await exec(["switch", "main"], source);
    await exec(["branch", branch, "main"], source);
    await configure(workspace, { alpha: { copy: ["tag-only.txt"] } });
    createRepoSpecificHookInRepo(
      workspace.hookRootPath,
      "pre-create",
      "alpha",
      `printf 'PRIMARY-SOURCE-CONTENT\n' > '${source}/tag-only.txt'`,
    );

    const result = await runArashi(
      workspace.workspacePath,
      "create",
      branch,
      "--only",
      "alpha",
      "--conflict",
      "REUSE_EXISTING",
      "--json",
    );

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(
      await readFile(join(workspace.getChildWorktreePath("alpha", branch), "tag-only.txt"), "utf8"),
    ).toBe("PRIMARY-SOURCE-CONTENT\n");
  });

  test("resolves configured materialization policy by canonical repository path when the ID differs from the checkout basename", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
    workspaces.push(workspace);
    await prepareSources(workspace);
    const configPath = join(workspace.workspacePath, ".arashi", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      repos: Record<string, Record<string, unknown>>;
    };
    config.repos["simple-repo"] = {
      ...config.repos.alpha,
      copy: [".env.local"],
    };
    delete config.repos.alpha;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const branch = "feature/configured-id-materialization";
    const hookMarker = join(workspace.workspacePath, ".arashi", "configured-id-hook.log");
    createRepoSpecificHookInRepo(
      workspace.hookRootPath,
      "pre-create",
      "simple-repo",
      `printf 'configured-id\n' > '${hookMarker}'`,
    );
    const preview = await runArashi(
      workspace.workspacePath,
      "create",
      branch,
      "--only",
      "simple-repo",
      "--dry-run",
      "--json",
    );
    expect(preview.exitCode, preview.stdout).toBe(0);
    expect(parseSingleDocument(preview.stdout)).toMatchObject({
      data: {
        dryRunOutcome: {
          materializationPlans: [
            expect.objectContaining({
              outcomes: [expect.objectContaining({ action: "copy", status: "would-copy" })],
              repositoryId: "simple-repo",
            }),
          ],
        },
      },
    });
    await absent(workspace.getChildWorktreePath("alpha", branch));

    const result = await runArashi(
      workspace.workspacePath,
      "create",
      branch,
      "--only",
      "simple-repo",
      "--json",
    );

    expect(result.exitCode, result.stdout).toBe(0);
    expect(await readFile(hookMarker, "utf8")).toBe("configured-id\n");
    expect(
      await readFile(join(workspace.getChildWorktreePath("alpha", branch), ".env.local"), "utf8"),
    ).toBe("TOP-SECRET-CONTENT\n");
    expect(parseSingleDocument(result.stdout)).toMatchObject({
      data: {
        repositories: [
          expect.objectContaining({
            materializationOutcomes: [
              expect.objectContaining({ action: "copy", status: "copied" }),
            ],
            repositoryName: "simple-repo",
          }),
        ],
      },
    });
  });

  test("keeps materialization enabled under --no-hooks without discovering or executing hooks", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
    workspaces.push(workspace);
    await prepareSources(workspace);
    await configure(workspace, { alpha: { copy: [".env.local"], symlink: [".shared-cache"] } });
    const marker = join(workspace.workspacePath, ".arashi", "must-not-run.log");
    createRepoSpecificHookInRepo(
      workspace.hookRootPath,
      "pre-create",
      "alpha",
      `printf reached > '${marker}'; exit 93`,
    );
    createRepoSpecificHookInRepo(
      workspace.hookRootPath,
      "post-create",
      "alpha",
      `printf reached > '${marker}'; exit 94`,
    );
    const branch = "feature/materialization-no-hooks";

    const result = await runArashi(
      workspace.workspacePath,
      "create",
      branch,
      "--only",
      "alpha",
      "--no-hooks",
      "--json",
    );

    expect(result.exitCode, result.stdout).toBe(0);
    const envelope = parseSingleDocument(result.stdout);
    const data = envelope.data as {
      hookOutcomes: unknown[];
      repositoryResults: { materializationOutcomes: { status: string }[] }[];
    };
    expect(data.hookOutcomes).toEqual([]);
    expect(data.repositoryResults[0]?.materializationOutcomes.map(({ status }) => status)).toEqual([
      "copied",
      "linked",
    ]);
    await absent(marker);
    expect(
      await readFile(join(workspace.getChildWorktreePath("alpha", branch), ".env.local"), "utf8"),
    ).toBe("TOP-SECRET-CONTENT\n");
  });

  test("blocks case-only target-tree destination collisions before create mutation", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
    workspaces.push(workspace);
    const source = await prepareSources(workspace);
    await mkdir(join(source, "Config"), { recursive: true });
    await writeFile(join(source, "Config", "local.json"), "tracked\n");
    await exec(["add", "Config/local.json"], source);
    await exec(["-c", "commit.gpgSign=false", "commit", "-m", "case collision fixture"], source);
    await mkdir(join(source, "config"), { recursive: true });
    await writeFile(join(source, "config", "local.json"), "materialization source\n");
    await configure(workspace, { alpha: { copy: ["config/local.json"] } });
    const branch = "feature/case-only-tree-collision";
    const marker = join(workspace.workspacePath, ".arashi", "case-collision-hook.log");
    createRepoSpecificHookInRepo(
      workspace.hookRootPath,
      "pre-create",
      "alpha",
      `printf reached > '${marker}'`,
    );

    const result = await runArashi(
      workspace.workspacePath,
      "create",
      branch,
      "--only",
      "alpha",
      "--dry-run",
      "--json",
    );

    expect(result.exitCode).not.toBe(0);
    expect(parseSingleDocument(result.stdout)).toMatchObject({
      error: {
        code: "MATERIALIZATION_PLAN_BLOCKED",
        details: {
          dryRunOutcome: {
            materializationPlans: [
              expect.objectContaining({
                outcomes: [
                  expect.objectContaining({
                    path: "config/local.json",
                    reasonCode: "destination_exists",
                    status: "blocked",
                  }),
                ],
              }),
            ],
          },
        },
      },
    });
    await absent(marker);
    await absent(workspace.getChildWorktreePath("alpha", branch));
  });

  test("projects actionable and blocked dry-runs into exact planned-only JSON paths without mutation", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
    workspaces.push(workspace);
    await prepareSources(workspace);
    await configure(workspace, {
      alpha: { copy: [".env.local", "optional-missing.txt"], symlink: [".shared-cache"] },
    });

    const actionable = await runArashi(
      workspace.workspacePath,
      "create",
      "feature/materialization-preview",
      "--only",
      "alpha",
      "--dry-run",
      "--json",
    );
    expect(actionable.exitCode, actionable.stdout).toBe(0);
    const success = parseSingleDocument(actionable.stdout);
    expect(success).toMatchObject({
      command: "create",
      data: {
        dryRunOutcome: {
          materializationPlans: [
            {
              repositoryId: "alpha",
              outcomes: [
                expect.objectContaining({
                  action: "copy",
                  path: ".env.local",
                  status: "would-copy",
                }),
                expect.objectContaining({
                  action: "copy",
                  path: "optional-missing.txt",
                  reasonCode: "source_missing",
                  status: "skipped",
                }),
                expect.objectContaining({
                  action: "symlink",
                  path: ".shared-cache",
                  status: "would-link",
                }),
              ],
            },
          ],
        },
        repositoryResults: [],
      },
      ok: true,
    });
    await absent(workspace.getChildWorktreePath("alpha", "feature/materialization-preview"));

    await writeFile(join(workspace.childRepoPaths.alpha!, "tracked.conflict"), "tracked\n");
    const gitAdd = runtime.spawn(["git", "add", "tracked.conflict"], {
      cwd: workspace.childRepoPaths.alpha!,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(await gitAdd.exited).toBe(0);
    const gitCommit = runtime.spawn(["git", "commit", "-m", "Add tracked conflict"], {
      cwd: workspace.childRepoPaths.alpha!,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(await gitCommit.exited).toBe(0);
    await configure(workspace, { alpha: { copy: ["tracked.conflict"], symlink: [] } });

    const blocked = await runArashi(
      workspace.workspacePath,
      "create",
      "feature/materialization-blocked",
      "--only",
      "alpha",
      "--dry-run",
      "--json",
    );
    expect(blocked.exitCode).not.toBe(0);
    expect(parseSingleDocument(blocked.stdout)).toMatchObject({
      command: "create",
      error: {
        code: "MATERIALIZATION_PLAN_BLOCKED",
        details: {
          dryRunOutcome: {
            materializationPlans: [
              {
                outcomes: [
                  expect.objectContaining({
                    action: "copy",
                    path: "tracked.conflict",
                    reasonCode: "destination_exists",
                    status: "blocked",
                  }),
                ],
              },
            ],
          },
        },
      },
      ok: false,
    });
    await absent(workspace.getChildWorktreePath("alpha", "feature/materialization-blocked"));
  });

  test("preserves reused worktrees without reporting rollback residuals or retaining ignore changes", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha", "beta"] });
    workspaces.push(workspace);
    const branch = "feature/reuse-rollback-ownership";
    const alphaSource = workspace.childRepoPaths.alpha!;
    const alphaDestination = workspace.getChildWorktreePath("alpha", branch);
    const betaDestination = workspace.getChildWorktreePath("beta", branch);
    await mkdir(dirname(alphaDestination), { recursive: true });
    await exec(["worktree", "add", "-b", branch, alphaDestination, "main"], alphaSource);
    const excludePath = join(workspace.workspacePath, ".git", "info", "exclude");
    const excludeBefore = await readFile(excludePath, "utf8");
    const hookPath = join(
      workspace.workspacePath,
      ".arashi",
      "hooks",
      process.platform === "win32" ? "post-create.ps1" : "post-create.sh",
    );
    await writeFile(hookPath, process.platform === "win32" ? "exit 29\n" : "#!/bin/sh\nexit 29\n", {
      mode: 0o755,
    });

    const result = await runArashi(
      workspace.workspacePath,
      "create",
      branch,
      "--only",
      "alpha,beta",
      "--conflict",
      "REUSE_EXISTING",
      "--json",
    );

    expect(result.exitCode).not.toBe(0);
    const envelope = parseSingleDocument(result.stdout) as {
      error: {
        details: {
          errorSummary: string;
          managedIgnore: { changed: boolean; restored: boolean };
        };
      };
    };
    expect(envelope.error.details.errorSummary).not.toContain("Residual worktrees detected");
    expect(envelope.error.details.managedIgnore).toMatchObject({ changed: false, restored: true });
    await expect(access(alphaDestination)).resolves.toBeUndefined();
    await absent(betaDestination);
    expect(await readFile(excludePath, "utf8")).toBe(excludeBefore);
  });

  test.skipIf(process.platform === "win32")(
    "preserves a failed worktree path when post-create rollback cannot remove it",
    async () => {
      const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
      workspaces.push(workspace);
      await prepareSources(workspace, "alpha");
      await configure(workspace, { alpha: { copy: [".env.local"] } });
      const branch = "feature/materialization-residual-worktree";
      const worktreePath = workspace.getChildWorktreePath("alpha", branch);
      const worktreeParent = dirname(worktreePath);
      createRepoSpecificHookInRepo(
        workspace.hookRootPath,
        "post-create",
        "alpha",
        `chmod 0500 "$(dirname "$ARASHI_WORKTREE_PATH")"
exit 29`,
      );

      const result = await runArashi(
        workspace.workspacePath,
        "create",
        branch,
        "--only",
        "alpha",
        "--json",
      );
      await chmod(worktreeParent, 0o700);
      const canonicalWorktreePath = await realpath(worktreePath);

      expect(result.exitCode).not.toBe(0);
      const envelope = parseSingleDocument(result.stdout);
      expect(envelope).toMatchObject({
        error: {
          details: {
            errorSummary: expect.stringContaining(
              `Residual worktrees detected: alpha:${canonicalWorktreePath}`,
            ),
            repositoryResults: [
              expect.objectContaining({
                materializationOutcomes: [
                  expect.objectContaining({ path: ".env.local", status: "copied" }),
                ],
                status: "failed",
                worktreePath: canonicalWorktreePath,
              }),
            ],
          },
        },
      });
      await expect(access(worktreePath)).resolves.toBeUndefined();
    },
  );

  test("refreshes after pre-hook, rolls earlier repositories back, and keeps source targets safe", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha", "beta"] });
    workspaces.push(workspace);
    const alphaSource = await prepareSources(workspace, "alpha");
    const betaSource = await prepareSources(workspace, "beta");
    await configure(workspace, {
      alpha: { copy: [".env.local"], symlink: [".shared-cache"] },
      beta: { copy: [".env.local"], symlink: [".shared-cache"] },
    });
    const branch = "feature/materialization-refresh-rollback";
    createRepoSpecificHookInRepo(
      workspace.hookRootPath,
      "pre-create",
      "beta",
      `mkdir -p "$ARASHI_WORKTREE_PATH"
printf 'concurrent-object\\n' > "$ARASHI_WORKTREE_PATH/.env.local"`,
    );
    const betaPostMarker = join(workspace.workspacePath, ".arashi", "beta-post-must-not-run");
    createRepoSpecificHookInRepo(
      workspace.hookRootPath,
      "post-create",
      "beta",
      `printf reached > '${betaPostMarker}'`,
    );

    const result = await runArashi(
      workspace.workspacePath,
      "create",
      branch,
      "--only",
      "alpha,beta",
      "--json",
    );

    expect(result.exitCode).not.toBe(0);
    const envelope = parseSingleDocument(result.stdout);
    expect(envelope).toMatchObject({
      command: "create",
      error: {
        code: "CREATE_FAILED",
        details: {
          materializationRollback: {
            attempted: true,
            complete: true,
            failureCount: 0,
            failures: [],
          },
          repositoryResults: [
            expect.objectContaining({
              materializationOutcomes: [
                expect.objectContaining({ path: ".env.local", status: "rolled-back" }),
                expect.objectContaining({ path: ".shared-cache", status: "rolled-back" }),
              ],
            }),
            expect.objectContaining({
              materializationOutcomes: [
                expect.objectContaining({
                  path: ".env.local",
                  reasonCode: "destination_exists",
                  status: "failed",
                }),
              ],
            }),
          ],
        },
      },
      ok: false,
    });
    await absent(workspace.getChildWorktreePath("alpha", branch));
    await absent(workspace.getChildWorktreePath("beta", branch));
    await absent(betaPostMarker);
    expect(await readFile(join(alphaSource, ".env.local"), "utf8")).toBe("TOP-SECRET-CONTENT\n");
    expect(await readFile(join(betaSource, ".env.local"), "utf8")).toBe("TOP-SECRET-CONTENT\n");
    expect(await readFile(join(alphaSource, ".shared-cache", "cache.txt"), "utf8")).toBe(
      "cache-target\n",
    );
  });

  test("ordinary coordinated removal unlinks materialized targets without deleting canonical sources", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
    workspaces.push(workspace);
    const source = await prepareSources(workspace);
    await configure(workspace, { alpha: { copy: [".env.local"], symlink: [".shared-cache"] } });
    const branch = "feature/materialization-remove";
    const created = await runArashi(
      workspace.workspacePath,
      "create",
      branch,
      "--only",
      "alpha",
      "--no-hooks",
      "--json",
    );
    expect(created.exitCode, created.stdout).toBe(0);

    const removed = await runArashi(
      workspace.workspacePath,
      "remove",
      branch,
      "--force",
      "--keep-branches",
      "--json",
    );
    expect(removed.exitCode, `${removed.stdout}\n${removed.stderr}`).toBe(0);
    await absent(workspace.getChildWorktreePath("alpha", branch));
    expect(await readFile(join(source, ".env.local"), "utf8")).toBe("TOP-SECRET-CONTENT\n");
    expect(await readFile(join(source, ".shared-cache", "cache.txt"), "utf8")).toBe(
      "cache-target\n",
    );
  });
});

describe("doctor human and JSON materialization contract RED", () => {
  test("emits exact non-blocking finding records and keeps JSON stdout isolated", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
    workspaces.push(workspace);
    await prepareSources(workspace);
    await configure(workspace, {
      alpha: { copy: ["optional-missing.txt"], symlink: [".shared-cache"] },
    });

    const result = await runArashi(workspace.workspacePath, "doctor", "--json");

    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.stderr).toBe("");
    const envelope = parseSingleDocument(result.stdout);
    const data = envelope.data as {
      findings: Record<string, unknown>[];
      summary: Record<string, number>;
    };
    expect(data.findings).toContainEqual({
      category: "repository",
      code: "MATERIALIZATION_SOURCE_MISSING",
      details: {
        action: "copy",
        path: "optional-missing.txt",
        repositoryId: "alpha",
        worktreePath: null,
      },
      message: expect.any(String),
      scope: "materialization:alpha:copy:optional-missing.txt",
      severity: "info",
      suggestedCommands: [],
    });
    expect(data.summary.error).toBe(0);
    expect(result.stdout).not.toContain("TOP-SECRET-CONTENT");
    expect(result.stdout).not.toMatch(/Checking|Doctor found/);
  });

  test("diagnoses managed worktrees under a configured custom worktrees directory", async () => {
    const workspace = await createChildHookWorkspace({
      childRepoNames: ["alpha"],
      worktreesDir: "managed/custom-worktrees",
    });
    workspaces.push(workspace);
    await prepareSources(workspace);
    await configure(workspace, { alpha: { copy: [".env.local"] } });
    const branch = "feature/custom-doctor-root";
    const created = await runArashi(
      workspace.workspacePath,
      "create",
      branch,
      "--only",
      "alpha",
      "--no-hooks",
      "--json",
    );
    expect(created.exitCode, `${created.stdout}\n${created.stderr}`).toBe(0);
    await rm(join(workspace.getChildWorktreePath("alpha", branch), ".env.local"));

    const result = await runArashi(workspace.workspacePath, "doctor", "--json");
    const envelope = parseSingleDocument(result.stdout);
    const findings =
      (envelope.data as { findings?: Record<string, unknown>[] } | undefined)?.findings ??
      (envelope.error as { details?: { findings?: Record<string, unknown>[] } } | undefined)
        ?.details?.findings ??
      [];
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "MATERIALIZATION_COPY_DESTINATION_MISSING",
        details: expect.objectContaining({
          worktreePath: workspace.getChildWorktreePath("alpha", branch),
        }),
      }),
    );
  });

  test("reports an unavailable canonical source checkout through the materialization finding contract", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
    workspaces.push(workspace);
    await prepareSources(workspace);
    await configure(workspace, { alpha: { copy: [".env.local"] } });
    await rm(join(workspace.workspacePath, "repos", "alpha"), { force: true, recursive: true });

    const result = await runArashi(workspace.workspacePath, "doctor", "--json");
    expect(result.exitCode).not.toBe(0);
    const envelope = parseSingleDocument(result.stdout);
    const { details } = envelope.error as { details: { findings: Record<string, unknown>[] } };
    expect(details.findings).toContainEqual(
      expect.objectContaining({
        category: "repository",
        code: "MATERIALIZATION_SOURCE_CHECKOUT_UNAVAILABLE",
        scope: "materialization:alpha:source-checkout",
        suggestedCommands: [],
      }),
    );
    expect(details.findings).not.toContainEqual(
      expect.objectContaining({ code: "CONFIG_LOAD_FAILED" }),
    );
  });

  test("reports a realpath-equivalent but non-exact symlink target as misdirected", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
    workspaces.push(workspace);
    const source = await prepareSources(workspace);
    await configure(workspace, { alpha: { symlink: [".shared-cache"] } });
    const branch = "feature/materialization-doctor-exact-link";
    const destination = workspace.getChildWorktreePath("alpha", branch);
    const created = await runArashi(
      workspace.workspacePath,
      "create",
      branch,
      "--only",
      "alpha",
      "--no-hooks",
      "--json",
    );
    expect(created.exitCode, created.stdout).toBe(0);
    const link = join(destination, ".shared-cache");
    await rm(link);
    await symlink(relative(dirname(link), join(source, ".shared-cache")), link, "dir");

    const result = await runArashi(workspace.workspacePath, "doctor", "--json");
    const envelope = parseSingleDocument(result.stdout);
    const findings =
      (envelope.error as { details?: { findings?: Record<string, unknown>[] } })?.details
        ?.findings ??
      (envelope.data as { findings?: Record<string, unknown>[] })?.findings ??
      [];
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "MATERIALIZATION_SYMLINK_MISDIRECTED" }),
    );
  });

  test("human and JSON doctor report unsafe managed destinations as blocking without repair or content reads", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
    workspaces.push(workspace);
    await prepareSources(workspace);
    await configure(workspace, { alpha: { copy: ["nested/value.txt"] } });
    const branch = "feature/materialization-doctor-unsafe";
    const destination = workspace.getChildWorktreePath("alpha", branch);
    const created = await runArashi(
      workspace.workspacePath,
      "create",
      branch,
      "--only",
      "alpha",
      "--no-hooks",
      "--json",
    );
    expect(created.exitCode, created.stdout).toBe(0);
    await rm(join(destination, "nested"), { force: true, recursive: true });
    const outside = join(workspace.rootPath, "doctor-outside");
    await mkdir(outside);
    await symlink(outside, join(destination, "nested"), "dir");

    const json = await runArashi(workspace.workspacePath, "doctor", "--json");
    expect(json.exitCode).not.toBe(0);
    const envelope = parseSingleDocument(json.stdout);
    const { details } = envelope.error as { details: { findings: Record<string, unknown>[] } };
    expect(details.findings).toContainEqual({
      category: "worktree",
      code: "MATERIALIZATION_DESTINATION_ANCESTOR_UNSAFE",
      details: {
        action: "copy",
        ancestorKind: "symlink",
        path: "nested/value.txt",
        repositoryId: "alpha",
        worktreePath: destination,
      },
      message: expect.any(String),
      scope: expect.stringMatching(/^materialization:alpha:.*:copy:nested\/value\.txt$/),
      severity: "error",
      suggestedCommands: [],
    });

    const human = await runArashi(workspace.workspacePath, "doctor");
    expect(human.exitCode).not.toBe(0);
    expect(human.stdout).toContain("MATERIALIZATION_DESTINATION_ANCESTOR_UNSAFE");
    expect(human.stdout).toContain("alpha");
    expect(human.stdout).toContain("nested/value.txt");
    expect(human.stdout).not.toContain("TOP-SECRET-CONTENT");
    await absent(join(outside, "value.txt"));
  });
});
