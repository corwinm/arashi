import { runWithTimeout } from "../process/run-with-timeout.ts";

type RunWithTimeoutResult = Awaited<ReturnType<typeof runWithTimeout>>;

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

interface TimedGitOptions {
  repoPath: string;
  startTime: number;
  timeoutMs: number;
}

interface RunGitOptions extends TimedGitOptions {
  args: string[];
}

interface BranchExistsOptions extends TimedGitOptions {
  branchName: string;
}

export async function alignRepositoryBranch(options: {
  repoPath: string;
  targetBranch: string;
  timeoutMs: number;
}): Promise<SyncBranchOutcome> {
  const startTime = Date.now();
  const { repoPath, targetBranch, timeoutMs } = options;

  const currentBranchOutcome = await getCurrentBranch({ repoPath, startTime, timeoutMs });
  if (currentBranchOutcome.status === "timeout") {
    return currentBranchOutcome;
  }
  if (currentBranchOutcome.status === "failure") {
    return currentBranchOutcome;
  }

  const previousBranch = currentBranchOutcome.currentBranch;

  const existsOutcome = await branchExists({
    branchName: targetBranch,
    repoPath,
    startTime,
    timeoutMs,
  });
  if (existsOutcome.status === "timeout") {
    return existsOutcome;
  }
  if (existsOutcome.status === "failure") {
    return existsOutcome;
  }

  if (existsOutcome.exists) {
    if (previousBranch === targetBranch) {
      return {
        createdBranch: false,
        currentBranch: targetBranch,
        previousBranch,
        status: "success",
      };
    }

    const checkoutOutcome = await runGit({
      args: ["checkout", targetBranch],
      repoPath,
      startTime,
      timeoutMs,
    });

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
      createdBranch: false,
      currentBranch: targetBranch,
      previousBranch,
      status: "success",
    };
  }

  const createOutcome = await runGit({
    args: ["checkout", "-b", targetBranch],
    repoPath,
    startTime,
    timeoutMs,
  });

  if (createOutcome.result.timedOut) {
    return buildTimeoutOutcome(previousBranch);
  }

  if (createOutcome.result.exitCode !== 0) {
    return buildFailureOutcome(previousBranch, createOutcome.result, `checkout -b ${targetBranch}`);
  }

  return {
    createdBranch: true,
    currentBranch: targetBranch,
    previousBranch,
    status: "success",
  };
}

async function getCurrentBranch({
  repoPath,
  startTime,
  timeoutMs,
}: TimedGitOptions): Promise<SyncBranchOutcome> {
  const outcome = await runGit({
    args: ["rev-parse", "--abbrev-ref", "HEAD"],
    repoPath,
    startTime,
    timeoutMs,
  });

  if (outcome.result.timedOut) {
    return buildTimeoutOutcome(null);
  }

  if (outcome.result.exitCode !== 0) {
    return buildFailureOutcome(null, outcome.result, "rev-parse --abbrev-ref HEAD");
  }

  const branch = outcome.result.stdout.trim();
  const currentBranch = branch === "HEAD" ? null : branch;

  return {
    createdBranch: false,
    currentBranch,
    previousBranch: currentBranch,
    status: "success",
  };
}

async function branchExists({
  branchName,
  repoPath,
  startTime,
  timeoutMs,
}: BranchExistsOptions): Promise<SyncBranchOutcome & { exists?: boolean }> {
  const outcome = await runGit({
    args: ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`],
    repoPath,
    startTime,
    timeoutMs,
  });

  if (outcome.result.timedOut) {
    return buildTimeoutOutcome(null);
  }

  if (outcome.result.exitCode === 0) {
    return {
      createdBranch: false,
      currentBranch: null,
      exists: true,
      previousBranch: null,
      status: "success",
    };
  }

  if (isNotRepositoryError(outcome.result.stderr)) {
    return buildFailureOutcome(null, outcome.result, "rev-parse --verify");
  }

  return {
    createdBranch: false,
    currentBranch: null,
    exists: false,
    previousBranch: null,
    status: "success",
  };
}

async function runGit({
  args,
  repoPath,
  startTime,
  timeoutMs,
}: RunGitOptions): Promise<GitCommandOutcome> {
  const elapsed = Date.now() - startTime;
  const remainingMs = timeoutMs - elapsed;
  if (remainingMs <= 0) {
    return {
      remainingMs,
      result: createImmediateTimeoutResult(),
    };
  }

  const result = await runWithTimeout(["git", ...args], {
    cwd: repoPath,
    timeoutMs: remainingMs,
  });

  return { remainingMs, result };
}

function buildTimeoutOutcome(previousBranch: string | null): SyncBranchOutcome {
  return {
    createdBranch: false,
    currentBranch: previousBranch,
    errorMessage: "Repository operation timed out",
    previousBranch,
    status: "timeout",
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
    createdBranch: false,
    currentBranch: previousBranch,
    errorMessage: `git ${commandDescription} failed: ${detail}`,
    previousBranch,
    status: "failure",
  };
}

function isNotRepositoryError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return lower.includes("not a git repository");
}

function createImmediateTimeoutResult(): RunWithTimeoutResult {
  return {
    durationMs: 0,
    exitCode: -1,
    killed: false,
    signalCode: null,
    stderr: "",
    stdout: "",
    timedOut: true,
  };
}
