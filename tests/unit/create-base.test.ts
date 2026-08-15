import {
  CreateBaseResolutionError,
  createBaseResolver,
  resolveCreateBasePlan,
} from "../../src/lib/create-base.ts";
import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { ArashiError } from "../../src/lib/errors.ts";
import type { Repository } from "../../src/core/repository.ts";
import { exec } from "../../src/lib/git.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];

async function createRepository(name: string): Promise<Repository> {
  const root = await mkdtemp(join(tmpdir(), `arashi-create-base-${name}-`));
  roots.push(root);
  await exec(["init", "-b", "main"], root);
  await exec(["config", "user.name", "Test User"], root);
  await exec(["config", "user.email", "test@example.com"], root);
  await exec(["config", "commit.gpgsign", "false"], root);
  await exec(["commit", "--allow-empty", "-m", "initial"], root);
  return { defaultBranch: "main", hasSetupScript: false, name, path: root };
}

async function oid(repository: Repository, ref: string): Promise<string> {
  return (await exec(["rev-parse", ref], repository.path)).stdout.trim();
}

function gitFailure(args: string[], cwd: string, exitCode: number): ArashiError {
  return new ArashiError(`injected git failure (${exitCode})`, {
    args,
    cwd,
    exitCode,
    stderr: "injected git failure",
    stdout: "",
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, {
        force: true,
        maxRetries: process.platform === "win32" ? 10 : 0,
        recursive: true,
        retryDelay: 100,
      }),
    ),
  );
});

describe("resolveCreateBasePlan", () => {
  test("prefers the exact local branch and captures its immutable OID", async () => {
    const repository = await createRepository("local-first");
    await exec(["branch", "feature/base"], repository.path);
    await exec(["commit", "--allow-empty", "-m", "advance remote candidate"], repository.path);
    await exec(["update-ref", "refs/remotes/origin/feature/base", "HEAD"], repository.path);

    const plan = await resolveCreateBasePlan([repository], "feature/base", "cli");
    const entry = plan.repositories[0]!;

    expect(entry).toEqual({
      repositoryName: "local-first",
      repositoryPath: await realpath(repository.path),
      resolvedOid: await oid(repository, "refs/heads/feature/base"),
      resolvedRef: "refs/heads/feature/base",
    });
    expect(plan.byCanonicalPath.get(entry.repositoryPath)).toBe(entry);
  });

  test("falls back to the exact origin-tracking branch", async () => {
    const repository = await createRepository("origin-fallback");
    await exec(["update-ref", "refs/remotes/origin/release/base", "HEAD"], repository.path);

    const plan = await resolveCreateBasePlan([repository], "release/base", "config");

    expect(plan.repositories[0]).toMatchObject({
      resolvedOid: await oid(repository, "refs/remotes/origin/release/base"),
      resolvedRef: "refs/remotes/origin/release/base",
    });
  });

  test("normalizes at most one leading origin prefix", async () => {
    const repository = await createRepository("normalization");
    await exec(["branch", "feature/base"], repository.path);
    await exec(["branch", "origin/feature/base"], repository.path);

    const once = await resolveCreateBasePlan([repository], "origin/feature/base", "cli");
    const twice = await resolveCreateBasePlan([repository], "origin/origin/feature/base", "cli");

    expect(once.requestedBranch).toBe("feature/base");
    expect(once.repositories[0]?.resolvedRef).toBe("refs/heads/feature/base");
    expect(twice.requestedBranch).toBe("origin/feature/base");
    expect(twice.repositories[0]?.resolvedRef).toBe("refs/heads/origin/feature/base");
  });

  test.each(["bad branch", "-leading", "ends-with-dot.", "two..dots"])(
    "rejects invalid normalized Git branch %s",
    async (requestedBranch) => {
      const repository = await createRepository("invalid");
      await expect(
        resolveCreateBasePlan([repository], requestedBranch, "cli"),
      ).rejects.toMatchObject({
        name: "InvalidBranchNameError",
      });
    },
  );

  test("aggregates every missing repository in selected order with exact attempted refs", async () => {
    const first = await createRepository("first");
    const present = await createRepository("present");
    const last = await createRepository("last");
    await exec(["branch", "feature/base"], present.path);

    const failure = await resolveCreateBasePlan(
      [first, present, last],
      "origin/feature/base",
      "config",
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CreateBaseResolutionError);
    expect(failure).toMatchObject({
      code: "CREATE_BASE_RESOLUTION_FAILED",
      failures: [
        {
          attemptedRefs: ["refs/heads/feature/base", "refs/remotes/origin/feature/base"],
          repositoryName: "first",
          repositoryPath: await realpath(first.path),
        },
        {
          attemptedRefs: ["refs/heads/feature/base", "refs/remotes/origin/feature/base"],
          repositoryName: "last",
          repositoryPath: await realpath(last.path),
        },
      ],
      requestedBranch: "feature/base",
      source: "config",
    });
  });

  test("keys canonical aliases by one canonical absolute path while preserving selection order", async () => {
    const repository = await createRepository("canonical");
    await exec(["branch", "feature/base"], repository.path);
    const aliasParent = await mkdtemp(join(tmpdir(), "arashi-create-base-alias-"));
    roots.push(aliasParent);
    const alias = join(aliasParent, "nested", "..", "repo-alias");
    await mkdir(join(aliasParent, "nested"));
    await exec(["worktree", "add", alias, "feature/base"], repository.path);
    const selected = { ...repository, name: "alias", path: alias };

    const plan = await resolveCreateBasePlan([selected, repository], "feature/base", "cli");

    expect(plan.repositories.map((entry) => entry.repositoryName)).toEqual(["alias", "canonical"]);
    expect(plan.repositories[0]?.repositoryPath).toBe(await realpath(alias));
    expect([...plan.byCanonicalPath.keys()]).toEqual(
      plan.repositories.map((entry) => entry.repositoryPath),
    );
  });

  test("canonicalizes a selected symlink alias to the real repository path and map key", async () => {
    const repository = await createRepository("symlink-target");
    await exec(["branch", "feature/base"], repository.path);
    const aliasParent = await mkdtemp(join(tmpdir(), "arashi-create-base-symlink-"));
    roots.push(aliasParent);
    const alias = join(aliasParent, "repo-alias");
    await symlink(repository.path, alias, "dir");

    const plan = await resolveCreateBasePlan(
      [{ ...repository, name: "symlink-alias", path: alias }],
      "feature/base",
      "cli",
    );
    const canonicalPath = await realpath(repository.path);

    expect(plan.repositories[0]?.repositoryPath).toBe(canonicalPath);
    expect([...plan.byCanonicalPath.keys()]).toEqual([canonicalPath]);
    expect(plan.byCanonicalPath.get(canonicalPath)).toBe(plan.repositories[0]);
    expect(plan.byCanonicalPath.has(alias)).toBe(false);
  });

  test("propagates a missing selected repository path instead of reporting an absent ref", async () => {
    const valid = await createRepository("valid-before-missing");
    await exec(["branch", "feature/base"], valid.path);
    const missing = join(valid.path, "deleted-repository");

    const failure = await resolveCreateBasePlan(
      [valid, { ...valid, name: "missing", path: missing }],
      "feature/base",
      "cli",
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "ENOENT" });
    expect(failure).not.toBeInstanceOf(CreateBaseResolutionError);
  });

  test("propagates a non-repository Git failure instead of reporting an absent ref", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-create-base-non-repository-"));
    roots.push(root);
    const repository: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "non-repository",
      path: root,
    };

    const failure = await resolveCreateBasePlan([repository], "feature/base", "cli").catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ArashiError);
    expect(failure).toMatchObject({ context: { exitCode: 128 } });
    expect(failure).not.toBeInstanceOf(CreateBaseResolutionError);
  });

  test("does not classify a branch-validation operational failure as an invalid branch", async () => {
    const repository = await createRepository("validation-operation");
    const operationalFailure = gitFailure(
      ["check-ref-format", "--branch", "feature/base"],
      repository.path,
      -1,
    );

    const failure = await createBaseResolver({
      exec: async () => {
        throw operationalFailure;
      },
    })([repository], "feature/base", "cli").catch((error: unknown) => error);

    expect(failure).toBe(operationalFailure);
    expect(failure).not.toMatchObject({ name: "InvalidBranchNameError" });
  });

  test("treats only rev-parse quiet exit code 1 as an absent ref", async () => {
    const repository = await createRepository("rev-parse-operation");
    const operationalFailure = gitFailure(
      ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/feature/base^{commit}"],
      repository.path,
      128,
    );

    const failure = await createBaseResolver({
      exec: async (args, cwd) => {
        if (args[0] === "check-ref-format") {
          return { exitCode: 0, stderr: "", stdout: "" };
        }
        if (args.includes("refs/heads/feature/base^{commit}")) {
          throw gitFailure(args, cwd, 1);
        }
        throw operationalFailure;
      },
    })([repository], "feature/base", "cli").catch((error: unknown) => error);

    expect(failure).toBe(operationalFailure);
    expect(failure).not.toBeInstanceOf(CreateBaseResolutionError);
  });

  test("aggregates a genuine absent ref when both quiet rev-parse probes exit 1", async () => {
    const repository = await createRepository("rev-parse-absent");

    const failure = await createBaseResolver({
      exec: async (args, cwd) => {
        if (args[0] === "check-ref-format") {
          return { exitCode: 0, stderr: "", stdout: "" };
        }
        throw gitFailure(args, cwd, 1);
      },
    })([repository], "feature/base", "cli").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CreateBaseResolutionError);
    expect(failure).toMatchObject({
      failures: [{ repositoryName: "rev-parse-absent" }],
    });
  });
});
