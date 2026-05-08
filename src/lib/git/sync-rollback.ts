import { exec } from "../git.ts";

export interface CreatedBranchRecord {
  repositoryName: string;
  repoPath: string;
  branchName: string;
  previousBranch: string | null;
}

export interface RollbackOperation {
  repositoryName: string;
  branchName: string;
  status: "success" | "failure";
  errorMessage?: string;
}

export interface RollbackResult {
  successCount: number;
  failureCount: number;
  operations: RollbackOperation[];
}

export interface RollbackTracker {
  createdBranches: CreatedBranchRecord[];
}

export function createRollbackTracker(): RollbackTracker {
  return { createdBranches: [] };
}

export function recordCreatedBranch(tracker: RollbackTracker, record: CreatedBranchRecord): void {
  tracker.createdBranches.push(record);
}

export async function rollbackCreatedBranches(tracker: RollbackTracker): Promise<RollbackResult> {
  const operations: RollbackOperation[] = [];

  for (const record of [...tracker.createdBranches].toReversed()) {
    const operation: RollbackOperation = {
      branchName: record.branchName,
      repositoryName: record.repositoryName,
      status: "success",
    };

    try {
      if (record.previousBranch && record.previousBranch !== record.branchName) {
        await exec(["checkout", record.previousBranch], record.repoPath);
      } else {
        await exec(["checkout", "--detach"], record.repoPath);
      }

      await exec(["branch", "-D", record.branchName], record.repoPath);
    } catch (error) {
      operation.status = "failure";
      operation.errorMessage = error instanceof Error ? error.message : String(error);
    }

    operations.push(operation);
  }

  const successCount = operations.filter((op) => op.status === "success").length;
  const failureCount = operations.length - successCount;

  return {
    failureCount,
    operations,
    successCount,
  };
}
