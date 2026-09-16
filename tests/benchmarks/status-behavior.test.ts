import { describe, expect, test } from "vitest";
import { validateCliStatusOutput } from "../../scripts/benchmark/status-behavior.ts";

const repository = (name: string, path: string) => ({
  baseBranch: null,
  branch: {
    ahead: 0,
    behind: 0,
    isDetached: false,
    localBranch: "main",
    remoteBranch: "origin/main",
  },
  defaultBranch: {
    ahead: 0,
    behind: 0,
    branch: "main",
    compareRef: "refs/remotes/origin/main",
    remote: "origin",
    remoteRef: "origin/main",
    state: "available",
  },
  error: null,
  files: [],
  freshness: { mode: "local", remoteRefsRefreshed: false },
  name,
  path,
  refreshWarning: null,
});

const output = (paths: string[]) =>
  JSON.stringify({
    data: {
      freshness: { mode: "local", remoteRefsRefreshed: false },
      repositories: paths.map((path, index) =>
        repository(index === 0 ? "workspace" : "repo-01", path),
      ),
    },
    warnings: [],
  });

describe("status benchmark behavior", () => {
  test("rejects a valid but unexpected repository path", async () => {
    await expect(
      validateCliStatusOutput(output(["/fixture/workspace", "/other/repo-01"]), {
        canonicalizePath: async (path) => path,
        environment: {},
        expectedRepositoryPaths: ["/fixture/workspace", "/fixture/workspace/repos/repo-01"],
        local: true,
        verbose: false,
      }),
    ).rejects.toThrow("repository paths");
  });
});
