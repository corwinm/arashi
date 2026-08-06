import { describe, expect, test } from "vitest";
import { filterRepositories as filterConfigRepositories } from "../../src/lib/config/filter-repos.ts";
import type { WorkspaceRepository } from "../../src/lib/config.ts";
import {
  collectRepositoryFilterValues,
  filterRepositories,
  normalizeFilterList,
} from "../../src/lib/repo-filter.ts";

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

  test("collects repeated option occurrences through the shared normalization boundary", () => {
    const first = collectRepositoryFilterValues(" repo-a, repo-b ");
    const mixed = collectRepositoryFilterValues("repo-c,repo-a,,", first);

    expect(mixed).toEqual(["repo-a", "repo-b", "repo-c"]);
    expect(collectRepositoryFilterValues(" , ")).toEqual([]);
  });
});

describe("filterRepositories", () => {
  test("distinguishes omitted filters from explicitly empty filters and fails closed", () => {
    const omitted = filterRepositories(repositories, undefined, undefined);
    expect(omitted.emptyFilters).toEqual([]);
    expect(omitted.selected).toEqual(repositories);

    for (const only of ["   ", ",", [" ", ",,"]]) {
      const result = filterRepositories(repositories, only, undefined);
      expect(result.emptyFilters).toEqual(["only"]);
      expect(result.filters).toEqual({ groups: [], only: [] });
      expect(result.selected).toEqual([]);
    }

    for (const groups of ["   ", ",", [" ", ",,"]]) {
      const result = filterRepositories(repositories, undefined, groups);
      expect(result.emptyFilters).toEqual(["group"]);
      expect(result.selected).toEqual([]);
    }
  });

  test("reports every empty filter with precedence over valid and invalid companions", () => {
    expect(filterRepositories(repositories, ",", "docs")).toMatchObject({
      emptyFilters: ["only"],
      selected: [],
      unknownGroups: [],
    });
    expect(filterRepositories(repositories, "missing-repo", ",")).toMatchObject({
      emptyFilters: ["group"],
      missing: ["missing-repo"],
      selected: [],
    });
    expect(filterRepositories(repositories, ",", " ")).toMatchObject({
      emptyFilters: ["only", "group"],
      selected: [],
    });
  });

  test("keeps blank segments beside valid values valid", () => {
    const result = filterRepositories(repositories, [",arashi,", " "], [",core,"]);
    expect(result.emptyFilters).toEqual([]);
    expect(result.filters).toEqual({ groups: ["core"], only: ["arashi"] });
    expect(result.selected.map((repo) => repo.name)).toEqual(["arashi"]);
  });

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

describe("config repository filter adapter", () => {
  const configRepos = Object.fromEntries(
    repositories.map((repo) => [repo.name, { groups: repo.groups, path: repo.path }]),
  );

  test("preserves omission and propagates explicit-empty fail-closed metadata", () => {
    const omitted = filterConfigRepositories(configRepos, undefined, undefined);
    expect(omitted.emptyFilters).toEqual([]);
    expect(omitted.repositories.map((repo) => repo.name)).toEqual(
      repositories.map((repo) => repo.name),
    );
    expect(filterConfigRepositories(configRepos, [" ", ","], "docs")).toMatchObject({
      emptyFilters: ["only"],
      filters: { groups: ["docs"], only: [] },
      repositories: [],
    });
    expect(filterConfigRepositories(configRepos, ",", ",")).toMatchObject({
      emptyFilters: ["only", "group"],
      repositories: [],
    });
    expect(filterConfigRepositories(configRepos, "arashi,", ",core,")).toMatchObject({
      emptyFilters: [],
      filters: { groups: ["core"], only: ["arashi"] },
    });
  });
});
