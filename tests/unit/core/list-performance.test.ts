import { describe, expect, test, vi } from "vitest";
import {
  buildListOutput,
  gatherWorktreeData,
  parsePorcelainV2BranchStatus,
  parseWorktreePorcelain,
} from "../../../src/core/list";

const porcelain = [
  "worktree /repo/main",
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/main",
  "",
  "worktree /repo/slow",
  "HEAD 2222222222222222222222222222222222222222",
  "detached",
  "locked maintenance window",
  "",
  "worktree /repo/fast",
  "HEAD 3333333333333333333333333333333333333333",
  "branch refs/heads/feature",
  "",
  "worktree /repo/bare.git",
  "bare",
  "",
].join("\n");

const gitResult = (stdout: string) => Promise.resolve({ exitCode: 0, stderr: "", stdout });

const manyWorktreesPorcelain = (count: number): string =>
  Array.from({ length: count }, (_, index) =>
    [
      `worktree /repo/worktree-${index}`,
      `HEAD ${index.toString(16).padStart(40, "0")}`,
      `branch refs/heads/branch-${index}`,
      "",
    ].join("\n"),
  ).join("\n");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

describe("mode-aware list collection", () => {
  test("plain collection parses ordered paths without dirty-state probes", async () => {
    const probeChanges = vi.fn(async () => true);

    const output = await buildListOutput(
      "/repo",
      {},
      {
        execGit: async () => gitResult(porcelain),
        probeChanges,
      },
    );

    expect(output.worktrees.map((worktree) => worktree.path)).toEqual([
      "/repo/main",
      "/repo/slow",
      "/repo/fast",
    ]);
    expect(probeChanges).not.toHaveBeenCalled();
  });

  test("parses the complete porcelain list before starting bounded dirty probes", async () => {
    let parsingComplete = false;
    const releases = new Map([
      ["/repo/main", deferred<boolean>()],
      ["/repo/slow", deferred<boolean>()],
      ["/repo/fast", deferred<boolean>()],
    ]);
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;

    const resultPromise = gatherWorktreeData("/repo", {
      concurrency: 2,
      execGit: async () => gitResult(porcelain),
      parseWorktrees: (value) => {
        const parsed = parseWorktreePorcelain(value);
        parsingComplete = true;
        return parsed;
      },
      probeChanges: async (path) => {
        expect(parsingComplete).toBe(true);
        started.push(path);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const result = await releases.get(path)!.promise;
        active -= 1;
        return result;
      },
    });

    await vi.waitFor(() => expect(started).toEqual(["/repo/main", "/repo/slow"]));
    releases.get("/repo/slow")!.resolve(true);
    await vi.waitFor(() => expect(started).toEqual(["/repo/main", "/repo/slow", "/repo/fast"]));
    releases.get("/repo/fast")!.resolve(false);
    releases.get("/repo/main")!.resolve(false);

    const worktrees = await resultPromise;
    expect(maximumActive).toBe(2);
    expect(worktrees.map(({ hasChanges, path }) => ({ hasChanges, path }))).toEqual([
      { hasChanges: false, path: "/repo/main" },
      { hasChanges: true, path: "/repo/slow" },
      { hasChanges: false, path: "/repo/fast" },
    ]);
    expect(worktrees[1]).toMatchObject({
      branch: null,
      commit: "2222222",
      lockReason: "maintenance window",
      locked: true,
    });
  });

  test("nested discovery completion order cannot reorder verbose output", async () => {
    const releases = new Map([
      [
        "/repo/main",
        deferred<{ relativePath: string; branch: string; commit: string; hasChanges: boolean }[]>(),
      ],
      [
        "/repo/slow",
        deferred<{ relativePath: string; branch: string; commit: string; hasChanges: boolean }[]>(),
      ],
      [
        "/repo/fast",
        deferred<{ relativePath: string; branch: string; commit: string; hasChanges: boolean }[]>(),
      ],
    ]);
    const started: string[] = [];

    const outputPromise = buildListOutput(
      "/repo",
      { verbose: true },
      {
        concurrency: 2,
        discoverNestedRepositories: async (path) => {
          started.push(path);
          return releases.get(path)!.promise;
        },
        execGit: async () => gitResult(porcelain),
        probeChanges: async () => false,
      },
    );

    await vi.waitFor(() => expect(started).toEqual(["/repo/main", "/repo/slow"]));
    releases.get("/repo/slow")!.resolve([]);
    await vi.waitFor(() => expect(started).toEqual(["/repo/main", "/repo/slow", "/repo/fast"]));
    releases.get("/repo/fast")!.resolve([]);
    releases.get("/repo/main")!.resolve([]);

    const output = await outputPromise;
    expect(output.worktrees.map((worktree) => worktree.path)).toEqual([
      "/repo/main",
      "/repo/slow",
      "/repo/fast",
    ]);
  });

  test("shares one probe limit across worktrees and nested repositories", async () => {
    const worktreeCount = 8;
    const repositoryCount = 8;
    const concurrency = 8;
    const releases = new Map<string, ReturnType<typeof deferred<void>>>();
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;

    const outputPromise = buildListOutput(
      "/repo",
      { verbose: true },
      {
        concurrency,
        discoverNestedRepositories: async (worktreePath, _maxDepth, limitProbe) =>
          Promise.all(
            Array.from({ length: repositoryCount }, async (_, repositoryIndex) => {
              const relativePath = `repos/repository-${repositoryIndex}`;
              const probe = async () => {
                const key = `${worktreePath}/${relativePath}`;
                const release = deferred<void>();
                releases.set(key, release);
                started.push(key);
                active += 1;
                maximumActive = Math.max(maximumActive, active);
                await release.promise;
                active -= 1;
                return {
                  branch: `branch-${repositoryIndex}`,
                  commit: repositoryIndex.toString(16).padStart(7, "0"),
                  hasChanges: repositoryIndex % 2 === 1,
                  relativePath,
                };
              };
              return limitProbe ? limitProbe(probe) : probe();
            }),
          ),
        execGit: async () => gitResult(manyWorktreesPorcelain(worktreeCount)),
        probeChanges: async () => false,
      },
    );

    for (let completed = 0; completed < worktreeCount * repositoryCount; completed += concurrency) {
      await vi.waitFor(() => expect(started).toHaveLength(completed + concurrency));
      for (const key of started.slice(completed, completed + concurrency).toReversed()) {
        releases.get(key)!.resolve();
      }
    }

    const output = await outputPromise;
    expect(maximumActive).toBe(concurrency);
    expect(output.worktrees).toHaveLength(worktreeCount);
    expect(
      output.worktrees.map((worktree) => ({
        path: worktree.path,
        repositories: worktree.subRepositories?.map((repository) => repository.relativePath),
      })),
    ).toEqual(
      Array.from({ length: worktreeCount }, (_, worktreeIndex) => ({
        path: `/repo/worktree-${worktreeIndex}`,
        repositories: Array.from(
          { length: repositoryCount },
          (_, repositoryIndex) => `repos/repository-${repositoryIndex}`,
        ),
      })),
    );
  });
});

describe("porcelain-v2 nested repository status", () => {
  test("derives branch, commit, and dirty state from one status response", () => {
    expect(
      parsePorcelainV2BranchStatus(
        [
          "# branch.oid abcdef1234567890abcdef1234567890abcdef12",
          "# branch.head feature/topic",
          "1 .M N... 100644 100644 100644 abcdef1 abcdef1 README.md",
        ].join("\n"),
      ),
    ).toEqual({ branch: "feature/topic", commit: "abcdef1", hasChanges: true });
  });

  test("preserves detached and clean semantics", () => {
    expect(
      parsePorcelainV2BranchStatus(
        ["# branch.oid 1234567890abcdef1234567890abcdef12345678", "# branch.head (detached)"].join(
          "\n",
        ),
      ),
    ).toEqual({ branch: null, commit: "1234567", hasChanges: false });
  });

  test("rejects unborn repositories that the previous rev-parse probe skipped", () => {
    expect(() =>
      parsePorcelainV2BranchStatus("# branch.oid (initial)\n# branch.head main"),
    ).toThrow("Repository has no commit");
  });
});
