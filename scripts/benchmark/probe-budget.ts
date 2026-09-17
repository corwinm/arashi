import { isDeepStrictEqual } from "node:util";
import type { GitInvocationMetric } from "./git-trace.ts";

interface ProbeSample {
  behavior: Record<string, unknown>;
  metric: GitInvocationMetric;
}

const reject = (reason: string): never => {
  throw new Error(`Canonical probe benchmark rejected: ${reason}`);
};
const paths = (sample: ProbeSample) =>
  (sample.metric.repositories ?? []).map((repo) => repo.path).toSorted();

/** Acceptance at the public CLI boundary; never relabel or subtract root sessions. */
export function validateProbeBudget(
  base: ProbeSample,
  candidate: ProbeSample,
  options: { fixture: "small" | "large"; mainPath: string; verbose: boolean },
): void {
  for (const sample of [base, candidate]) {
    const { metric } = sample;
    if (!metric.available || !Number.isSafeInteger(metric.count)) reject("unavailable metric");
    const repositories = metric.repositories ?? [];
    if (new Set(repositories.map((repo) => repo.path)).size !== repositories.length) {
      reject("duplicate repository attribution");
    }
    const counts = [...repositories.map((repo) => repo.count), metric.unattributed?.count ?? 0];
    if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) reject("invalid count");
    if (counts.reduce((sum, count) => sum + count, 0) !== metric.count) {
      reject("aggregate does not reconcile");
    }
  }
  const verbose = options.verbose ? 1 : 0;
  const repositoryCount = options.fixture === "small" ? 3 : 9;
  const pinned = options.fixture === "small" ? 39 + 3 * verbose : 93 + 9 * verbose;
  if (base.metric.count !== pinned || base.metric.repositories?.length !== repositoryCount) {
    reject(
      `pinned baseline changed (count=${base.metric.count ?? "unavailable"}, repositories=${JSON.stringify(base.metric.repositories ?? [])}, unattributed=${JSON.stringify(base.metric.unattributed ?? null)}, expected=${pinned}/${repositoryCount})`,
    );
  }
  if ((candidate.metric.unattributed?.count ?? 0) !== 0) reject("unattributed candidate sessions");
  if (!isDeepStrictEqual(paths(base), paths(candidate)))
    reject("canonical repository paths differ");
  if (!isDeepStrictEqual(base.behavior, candidate.behavior)) reject("semantic output differs");
  if (!paths(base).includes(options.mainPath)) reject("main repository missing");
  if (!(candidate.metric.count! < base.metric.count!)) reject("aggregate did not strictly improve");
  for (const repository of base.metric.repositories!) {
    const expected = (repository.path === options.mainPath ? 13 : 9) + verbose;
    if (repository.count !== expected) reject("pinned named-repository attribution changed");
    const next = candidate.metric.repositories!.find((repo) => repo.path === repository.path)!;
    if (!(next.count < repository.count)) reject("named repository did not strictly improve");
    if (next.count > 7 + verbose) reject("clean-fixture command budget exceeded");
  }
}
