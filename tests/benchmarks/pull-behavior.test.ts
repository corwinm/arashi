import { expect, test } from "vitest";
import { validatePullOutput } from "../../scripts/benchmark/pull-behavior.ts";

test("pull assertion requires parent-first ordered updates with full configured children", () => {
  const paths = [
    "/fixture/workspace",
    "/fixture/workspace/repos/repo-01",
    "/fixture/workspace/repos/repo-02",
  ];
  const results = ["workspace", "repo-01", "repo-02"].map((repositoryId) => ({
    repositoryId,
    status: "updated",
    elapsedSeconds: 1.2,
    output: "Updating a..b",
  }));
  const envelope = { ok: true, command: "pull", data: { overallStatus: "success", results } };
  expect(validatePullOutput(JSON.stringify(envelope), paths)).toEqual({
    overallStatus: "success",
    results,
  });
  expect(() =>
    validatePullOutput(
      JSON.stringify({ ...envelope, data: { ...envelope.data, results: results.toReversed() } }),
      paths,
    ),
  ).toThrow(/order/);
  expect(() =>
    validatePullOutput(
      JSON.stringify({ ...envelope, data: { ...envelope.data, results: results.slice(0, 2) } }),
      paths,
    ),
  ).toThrow(/count/);
  expect(() =>
    validatePullOutput(
      JSON.stringify({
        ...envelope,
        data: {
          ...envelope.data,
          results: results.map((r, index) => (index === 2 ? { ...r, status: "skipped" } : r)),
        },
      }),
      paths,
    ),
  ).toThrow(/updated/);
});
