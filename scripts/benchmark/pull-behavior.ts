import { basename } from "node:path";

export interface PullResultRecord {
  repositoryId: string;
  status: string;
  elapsedSeconds: number;
  output?: string;
  [key: string]: unknown;
}

export interface PullBehavior {
  overallStatus: string;
  results: PullResultRecord[];
  [key: string]: unknown;
}

export function validatePullOutput(stdout: string, paths: string[]): PullBehavior {
  const envelope = JSON.parse(stdout) as { ok?: boolean; command?: string; data?: PullBehavior };
  if (envelope.ok !== true || envelope.command !== "pull" || !envelope.data) {
    throw new Error("Pull did not return a successful JSON envelope");
  }
  const behavior = envelope.data;
  if (behavior.results?.length !== paths.length) throw new Error("Pull result count mismatch");
  for (const [index, path] of paths.entries()) {
    if (behavior.results[index]?.repositoryId !== basename(path)) {
      throw new Error(`Pull result order mismatch at ${index}`);
    }
    if (behavior.results[index]?.status !== "updated") {
      throw new Error(`Pull result ${basename(path)} was not updated`);
    }
    if (typeof behavior.results[index]?.elapsedSeconds !== "number") {
      throw new Error("Pull result has no elapsedSeconds");
    }
  }
  if (behavior.overallStatus !== "success") throw new Error("Pull overall status was not success");
  return behavior;
}
