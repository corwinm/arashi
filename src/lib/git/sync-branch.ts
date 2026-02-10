import { runWithTimeout, type RunWithTimeoutResult } from "../process/run-with-timeout.ts";

export interface SyncBranchOutcome {
  status: "success" | "failure" | "timeout";
  createdBranch: boolean;
  previousBranch: string | null;
  currentBranch: string | null;
  errorMessage?: string;
}

interface GitCommandOutcome {
  result: RunWithTimeoutResult;
  remainingMs: number;
}

export async function alignRepositoryBranch(options: {
  repoPath: string;
  targetBranch: string;
  timeoutMs: number;
}): Promise<SyncBranchOutcome> {
  const startTime = Date.now();
  const { repoPath, targetBranch, timeoutMs } = options;

  const currentBranchOutcome = await getCurrentBranch(repoPath, startTime, timeoutMs);
  if (currentBranchOutcome.status === "timeout") {
    return currentBranchOutcome;
  }
  if (currentBranchOutcome.status === "failure") {
    return currentBranchOutcome;
  }

  const previousBranch = currentBranchOutcome.currentBranch;

  const existsOutcome = await branchExists(repoPath, targetBranch, startTime, timeoutMs);
  if (existsOutcome.status === "timeout") {
    return existsOutcome;
  }
  if (existsOutcome.status === "failure") {
    return existsOutcome;
  }

  if (existsOutcome.exists) {
    if (previousBranch === targetBranch) {
      return {
        status: "success",
        createdBranch: false,
        previousBranch,
        currentBranch: targetBranch,
      };
    }

    const checkoutOutcome = await runGit(
      repoPath,
      ["checkout", targetBranch],
      startTime,
      timeoutMs,
    );

    if (checkoutOutcome.result.timedOut) {
      return buildTimeoutOutcome(previousBranch);
    }

    if (checkoutOutcome.result.exitCode !== 0) {
      return buildFailureOutcome(
        previousBranch,
        checkoutOutcome.result,
        `checkout ${targetBranch}`,
      );
    }

    return {
      status: "success",
      createdBranch: false,
      previousBranch,
      currentBranch: targetBranch,
    };
  }

  const createOutcome = await runGit(
    repoPath,
    ["checkout", "-b", targetBranch],
    startTime,
    timeoutMs,
  );

  if (createOutcome.result.timedOut) {
    return buildTimeoutOutcome(previousBranch);
  }

  if (createOutcome.result.exitCode !== 0) {
    return buildFailureOutcome(previousBranch, createOutcome.result, `checkout -b ${targetBranch}`);
  }

  return {
    status: "success",
    createdBranch: true,
    previousBranch,
    currentBranch: targetBranch,
  };
}

async function getCurrentBranch(
  repoPath: string,
  startTime: number,
  timeoutMs: number,
): Promise<SyncBranchOutcome> {
  const outcome = await runGit(
    repoPath,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    startTime,
    timeoutMs,
  );

  if (outcome.result.timedOut) {
    return buildTimeoutOutcome(null);
  }

  if (outcome.result.exitCode !== 0) {
    return buildFailureOutcome(null, outcome.result, "rev-parse --abbrev-ref HEAD");
  }

  const branch = outcome.result.stdout.trim();
  const currentBranch = branch === "HEAD" ? null : branch;

  return {
    status: "success",
    createdBranch: false,
    previousBranch: currentBranch,
    currentBranch,
  };
}

async function branchExists(
  repoPath: string,
  branchName: string,
  startTime: number,
  timeoutMs: number,
): Promise<SyncBranchOutcome & { exists?: boolean }> {
  const outcome = await runGit(
    repoPath,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`],
    startTime,
    timeoutMs,
  );

  if (outcome.result.timedOut) {
    return buildTimeoutOutcome(null);
  }

  if (outcome.result.exitCode === 0) {
    return {
      status: "success",
      createdBranch: false,
      previousBranch: null,
      currentBranch: null,
      exists: true,
    };
  }

  if (isNotRepositoryError(outcome.result.stderr)) {
    return buildFailureOutcome(null, outcome.result, "rev-parse --verify");
  }

  return {
    status: "success",
    createdBranch: false,
    previousBranch: null,
    currentBranch: null,
    exists: false,
  };
}

async function runGit(
  repoPath: string,
  args: string[],
  startTime: number,
  timeoutMs: number,
): Promise<GitCommandOutcome> {
  const elapsed = Date.now() - startTime;
  const remainingMs = timeoutMs - elapsed;
  if (remainingMs <= 0) {
    return {
      result: createImmediateTimeoutResult(),
      remainingMs,
    };
  }

  const result = await runWithTimeout(["git", ...args], {
    cwd: repoPath,
    timeoutMs: remainingMs,
  });

  return { result, remainingMs };
}

function buildTimeoutOutcome(previousBranch: string | null): SyncBranchOutcome {
  return {
    status: "timeout",
    createdBranch: false,
    previousBranch,
    currentBranch: previousBranch,
    errorMessage: "Repository operation timed out",
  };
}

function buildFailureOutcome(
  previousBranch: string | null,
  result: RunWithTimeoutResult,
  commandDescription: string,
): SyncBranchOutcome {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  const detail = stderr || stdout || "Unknown error";

  return {
    status: "failure",
    createdBranch: false,
    previousBranch,
    currentBranch: previousBranch,
    errorMessage: `git ${commandDescription} failed: ${detail}`,
  };
}

function isNotRepositoryError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return lower.includes("not a git repository");
}

function createImmediateTimeoutResult(): RunWithTimeoutResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: -1,
    timedOut: true,
    durationMs: 0,
    signalCode: null,
    killed: false,
  };
}
