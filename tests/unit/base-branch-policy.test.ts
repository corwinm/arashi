import { describe, expect, test } from "vitest";
import {
  BaseBranchPolicyError,
  parseRepositoryBaseOverrides,
  resolveBaseBranchPolicy,
} from "../../src/lib/base-branch-policy.ts";
import type { Config } from "../../src/lib/config.ts";

const config = (overrides: Partial<Config> = {}): Config => ({
  baseBranch: "main",
  meta: { baseBranch: "meta/integration" },
  repos: {
    api: { baseBranch: "api/integration", path: "./repos/api" },
    web: { path: "./repos/web" },
  },
  reposDir: "./repos",
  version: "1.0.0",
  ...overrides,
});

describe("shared repository base branch policy", () => {
  test("parses repeatable overrides and rejects malformed and duplicate selectors together", () => {
    expect(parseRepositoryBaseOverrides(["@meta=meta/release", "api=api/release"])).toEqual(
      new Map([
        ["@meta", "meta/release"],
        ["api", "api/release"],
      ]),
    );

    expect(() =>
      parseRepositoryBaseOverrides(["broken", "=main", "api=", "api=one", "api=two"]),
    ).toThrowError(BaseBranchPolicyError);
    try {
      parseRepositoryBaseOverrides(["broken", "=main", "api=", "api=one", "api=two"]);
    } catch (error) {
      expect((error as BaseBranchPolicyError).issues).toHaveLength(4);
    }
  });

  test("resolves mixed create policy with exact precedence and stable sources", () => {
    expect(
      resolveBaseBranchPolicy({
        command: "create",
        config: config(),
        globalBase: "release",
        metaRepositoryName: "workspace",
        repositoryOverrides: ["@meta=meta/release", "api=api/release"],
        selectedRepositoryNames: ["workspace", "api", "web"],
      }),
    ).toEqual([
      { repositoryName: "workspace", requestedBranch: "meta/release", source: "repository-cli" },
      { repositoryName: "api", requestedBranch: "api/release", source: "repository-cli" },
      { repositoryName: "web", requestedBranch: "release", source: "cli" },
    ]);
  });

  test("keeps reserved meta identity distinct from a colliding child ID and display name", () => {
    expect(
      resolveBaseBranchPolicy({
        command: "create",
        config: config({
          meta: { baseBranch: "meta/config" },
          repos: {
            workspace: { baseBranch: "child/config", path: "./repos/workspace" },
          },
        }),
        repositoryOverrides: ["@meta=meta/cli", "workspace=child/cli"],
        selectedRepositories: [
          { identity: "@meta", kind: "meta", repositoryName: "workspace" },
          {
            configName: "workspace",
            identity: "workspace",
            kind: "child",
            repositoryName: "workspace",
          },
        ],
      }),
    ).toEqual([
      {
        repositoryIdentity: "@meta",
        repositoryName: "workspace",
        requestedBranch: "meta/cli",
        source: "repository-cli",
      },
      {
        repositoryIdentity: "workspace",
        repositoryName: "workspace",
        requestedBranch: "child/cli",
        source: "repository-cli",
      },
    ]);
  });

  test("uses repository config then workspace config and preserves omitted clone behavior", () => {
    expect(
      resolveBaseBranchPolicy({
        command: "clone",
        config: config(),
        selectedRepositoryNames: ["api", "web"],
      }),
    ).toEqual([
      { repositoryName: "api", requestedBranch: "api/integration", source: "repository-config" },
      { repositoryName: "web", requestedBranch: "main", source: "workspace-config" },
    ]);
    expect(
      resolveBaseBranchPolicy({
        command: "clone",
        config: config({ baseBranch: undefined, meta: undefined }),
        selectedRepositoryNames: ["web"],
      }),
    ).toEqual([{ repositoryName: "web", source: "legacy-omitted" }]);
  });

  test("aggregates unknown, unselected, clone-meta, and invalid branch selectors", () => {
    expect(() =>
      resolveBaseBranchPolicy({
        command: "clone",
        config: config(),
        repositoryOverrides: ["@meta=main", "missing=main", "web=bad branch", "api=main"],
        selectedRepositoryNames: ["web"],
      }),
    ).toThrowError(BaseBranchPolicyError);
    try {
      resolveBaseBranchPolicy({
        command: "clone",
        config: config(),
        repositoryOverrides: ["@meta=main", "missing=main", "web=bad branch", "api=main"],
        selectedRepositoryNames: ["web"],
      });
    } catch (error) {
      const codes = (error as BaseBranchPolicyError).issues.map((issue) => issue.code);
      expect(codes).toHaveLength(4);
      expect(codes).toEqual(
        expect.arrayContaining([
          "META_NOT_ALLOWED",
          "UNKNOWN_REPOSITORY",
          "INVALID_BRANCH",
          "UNSELECTED_REPOSITORY",
        ]),
      );
    }
  });

  test("normalizes the invocation-wide base exactly once before validation", () => {
    expect(
      resolveBaseBranchPolicy({
        command: "clone",
        config: config(),
        globalBase: "origin/origin/HEAD",
        selectedRepositoryNames: ["api"],
      }),
    ).toEqual([{ repositoryName: "api", requestedBranch: "origin/HEAD", source: "cli" }]);
  });

  test("rejects an explicitly empty invocation-wide base", () => {
    expect(() =>
      resolveBaseBranchPolicy({
        command: "clone",
        config: config(),
        globalBase: "",
        selectedRepositoryNames: ["api"],
      }),
    ).toThrowError(BaseBranchPolicyError);

    try {
      resolveBaseBranchPolicy({
        command: "clone",
        config: config(),
        globalBase: "",
        selectedRepositoryNames: ["api"],
      });
    } catch (error) {
      expect((error as BaseBranchPolicyError).issues).toEqual([
        expect.objectContaining({ code: "INVALID_BRANCH", value: "" }),
      ]);
    }
  });

  test("rejects repository overrides in standalone mode", () => {
    expect(() =>
      resolveBaseBranchPolicy({
        command: "create",
        config: config(),
        repositoryOverrides: ["api=main"],
        selectedRepositoryNames: ["workspace"],
        standalone: true,
      }),
    ).toThrow(/configured workspace/);
  });
});
