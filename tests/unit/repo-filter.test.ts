import { describe, expect, test } from "bun:test";
import { filterRepositories, normalizeFilterList } from "../../src/lib/repo-filter.ts";
import type { WorkspaceRepository } from "../../src/lib/config.ts";

const repositories: WorkspaceRepository[] = [
  { groups: ["core", "agents"], name: "arashi", path: "/workspace/repos/arashi" },
  { groups: ["docs"], name: "arashi-docs", path: "/workspace/repos/arashi-docs" },
  { groups: ["extensions"], name: "arashi-vscode", path: "/workspace/repos/arashi-vscode" },
  { name: "arashi-skills", path: "/workspace/repos/arashi-skills" },
];

describe("normalizeFilterList", () => {
  test("normalizes repeated and comma-separated filter values", () => {
    expect(normalizeFilterList(["core,docs", " core ", "extensions"])).toEqual([
      "core",
      "docs",
      "extensions",
    ]);
  });
});

describe("filterRepositories", () => {
  test("selects repositories by one group", () => {
    const result = filterRepositories(repositories, undefined, "docs");

    expect(result.selected.map((repo) => repo.name)).toEqual(["arashi-docs"]);
    expect(result.filters).toEqual({ groups: ["docs"], only: [] });
    expect(result.unknownGroups).toEqual([]);
  });

  test("selects repositories by multi-group union", () => {
    const result = filterRepositories(repositories, undefined, ["docs", "extensions"]);

    expect(result.selected.map((repo) => repo.name)).toEqual(["arashi-docs", "arashi-vscode"]);
  });

  test("intersects only and group filters", () => {
    const result = filterRepositories(repositories, "arashi,arashi-docs", "docs");

    expect(result.selected.map((repo) => repo.name)).toEqual(["arashi-docs"]);
    expect(result.emptyIntersection).toBe(false);
  });

  test("reports unknown repositories and groups", () => {
    const result = filterRepositories(repositories, "missing-repo", "missing-group");

    expect(result.selected).toEqual([]);
    expect(result.missing).toEqual(["missing-repo"]);
    expect(result.unknownGroups).toEqual(["missing-group"]);
    expect(result.emptyIntersection).toBe(false);
  });

  test("reports empty intersections for valid filters", () => {
    const result = filterRepositories(repositories, "arashi-docs", "core");

    expect(result.selected).toEqual([]);
    expect(result.emptyIntersection).toBe(true);
  });
});
