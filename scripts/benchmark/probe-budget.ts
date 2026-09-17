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
  const pinnedAggregate = options.fixture === "small" ? 39 + 3 * verbose : 93 + 9 * verbose;
  if (base.metric.repositories?.length !== repositoryCount) {
    reject("measured base repository attribution is incomplete");
  }
  if ((candidate.metric.unattributed?.count ?? 0) !== 0) reject("unattributed candidate sessions");
  if (!isDeepStrictEqual(paths(base), paths(candidate)))
    reject("canonical repository paths differ");
  if (!isDeepStrictEqual(base.behavior, candidate.behavior)) reject("semantic output differs");
  if (!paths(base).includes(options.mainPath)) reject("main repository missing");
  if (!(candidate.metric.count! < pinnedAggregate))
    reject("aggregate did not strictly improve over pinned baseline");
  for (const repository of candidate.metric.repositories!) {
    const pinnedNamed = (repository.path === options.mainPath ? 13 : 9) + verbose;
    if (!(repository.count < pinnedNamed))
      reject("named repository did not strictly improve over pinned baseline");
    if (repository.count > 7 + verbose) reject("clean-fixture command budget exceeded");
  }
}
