import mapWithConcurrency from "./concurrency.ts";
import { exec } from "./git.ts";
import { realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";

/** A failed proof is not a user-facing probe failure: use the serial path. */
export async function independentPullPaths(paths: readonly string[]): Promise<boolean> {
  try {
    const identities = await Promise.all(
      paths.map(async (path) => {
        const physical = await realpath(path);
        const raw = (await exec(["rev-parse", "--git-common-dir"], path)).stdout.trim();
        if (!raw) throw new Error("Unresolved Git common directory");
        const common = await realpath(resolve(path, raw));
        return { physical, common };
      }),
    );
    const overlaps = (a: string, b: string) => {
      const child = relative(a, b);
      return (
        child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
      );
    };
    for (let i = 0; i < identities.length; i++) {
      for (let j = i + 1; j < identities.length; j++) {
        const a = identities[i]!;
        const b = identities[j]!;
        if (
          a.common === b.common ||
          overlaps(a.physical, b.physical) ||
          overlaps(b.physical, a.physical) ||
          overlaps(a.physical, b.common) ||
          overlaps(b.physical, a.common)
        )
          return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Preserve started results even when the pool stops on a failed/manual pull. */
export async function executeIndependentPulls<T, R extends { status: string }>(
  items: readonly T[],
  jobs: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const outcomes: (R | undefined)[] = Array.from({ length: items.length });
  const stop = Symbol("pull stopped");
  try {
    await mapWithConcurrency(items, jobs, async (item, index) => {
      if (
        outcomes.some(
          (outcome) => outcome?.status === "failed" || outcome?.status === "manual-update",
        )
      ) {
        throw stop;
      }
      const outcome = await run(item, index);
      outcomes[index] = outcome;
      if (outcome.status === "failed" || outcome.status === "manual-update") throw stop;
      return outcome;
    });
  } catch (error) {
    if (error !== stop) throw error;
  }
  return outcomes.filter((outcome): outcome is R => outcome !== undefined);
}
