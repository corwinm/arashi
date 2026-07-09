import { exec as gitExec } from "./git.ts";
import type { WorkspaceRepository } from "./config.ts";
import type { PushResult } from "./push-types.ts";

const ZERO = 0;
const MILLISECONDS_PER_SECOND = 1000;

interface GitOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  message?: string;
}

export interface PushPlanOptions {
  dryRun?: boolean;
  setUpstream?: boolean;
}

export interface PushPlan {
  repository: WorkspaceRepository;
  result: PushResult;
  shouldPush: boolean;
}

const runGit = async (repoPath: string, args: string[]): Promise<GitOutcome> => {
  try {
    const result = await gitExec(args, repoPath);
    return { ok: true, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    const maybeError = error as {
      context?: { stderr?: string; stdout?: string };
      message?: string;
    };
    return {
      message: error instanceof Error ? error.message : String(error),
      ok: false,
      stderr: maybeError.context?.stderr ?? "",
      stdout: maybeError.context?.stdout ?? "",
    };
  }
};

const firstNonEmptyLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > ZERO);

const getCurrentBranch = async (repoPath: string): Promise<string | undefined> => {
  const result = await runGit(repoPath, ["branch", "--show-current"]);
  return result.ok ? firstNonEmptyLine(result.stdout) : undefined;
};

const getUpstream = async (repoPath: string): Promise<string | undefined> => {
  const result = await runGit(repoPath, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  return result.ok ? firstNonEmptyLine(result.stdout) : undefined;
};

const getRemote = async (repoPath: string): Promise<string | undefined> => {
  const result = await runGit(repoPath, ["remote"]);
  const remotes = result.ok
    ? result.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  return remotes.includes("origin") ? "origin" : remotes[ZERO];
};

const refExists = async (repoPath: string, ref: string): Promise<boolean> => {
  const result = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", ref]);
  return result.ok;
};

const getComparisonRef = async (
  repoPath: string,
  upstream: string | undefined,
  remote: string | undefined,
): Promise<string | undefined> => {
  if (upstream) {
    return upstream;
  }

  const candidates = remote
    ? [`refs/remotes/${remote}/HEAD`, `${remote}/main`, `${remote}/master`, "main", "master"]
    : ["main", "master"];
  for (const candidate of candidates) {
    if (await refExists(repoPath, candidate)) {
      return candidate;
    }
  }
  return undefined;
};

const countAhead = async (repoPath: string, comparisonRef: string | undefined): Promise<number> => {
  if (!comparisonRef) {
    return 1;
  }
  const result = await runGit(repoPath, ["rev-list", "--count", `${comparisonRef}..HEAD`]);
  if (!result.ok) {
    return 1;
  }
  const parsed = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(parsed) ? parsed : 1;
};

export const planPush = async (
  repository: WorkspaceRepository,
  options: PushPlanOptions = {},
): Promise<PushPlan> => {
  const start = Date.now();
  const elapsedSeconds = (): number => (Date.now() - start) / MILLISECONDS_PER_SECOND;
  const branch = await getCurrentBranch(repository.path);
  if (!branch) {
    return {
      repository,
      result: {
        elapsedSeconds: elapsedSeconds(),
        reason: "repository is not on a named branch",
        repositoryId: repository.name,
        status: "skipped",
      },
      shouldPush: false,
    };
  }

  const remote = await getRemote(repository.path);
  if (!remote) {
    return {
      repository,
      result: {
        branch,
        elapsedSeconds: elapsedSeconds(),
        reason: "no git remote configured",
        repositoryId: repository.name,
        status: "skipped",
      },
      shouldPush: false,
    };
  }

  const upstream = await getUpstream(repository.path);
  const comparisonRef = await getComparisonRef(repository.path, upstream, remote);
  const ahead = await countAhead(repository.path, comparisonRef);
  if (ahead === ZERO) {
    return {
      repository,
      result: {
        branch,
        elapsedSeconds: elapsedSeconds(),
        reason: "branch is already up to date or has no publishable commits",
        remote,
        repositoryId: repository.name,
        status: "skipped",
        upstream,
      },
      shouldPush: false,
    };
  }

  if (!upstream && !options.setUpstream) {
    return {
      repository,
      result: {
        branch,
        elapsedSeconds: elapsedSeconds(),
        reason: "branch has no upstream; rerun with --set-upstream to publish it",
        remote,
        repositoryId: repository.name,
        status: "skipped",
      },
      shouldPush: false,
    };
  }

  const command = upstream ? ["push"] : ["push", "--set-upstream", remote, branch];

  return {
    repository,
    result: {
      branch,
      command: ["git", ...command],
      elapsedSeconds: elapsedSeconds(),
      remote,
      repositoryId: repository.name,
      status: options.dryRun ? "planned" : "planned",
      upstream,
      upstreamSet: !upstream,
    },
    shouldPush: true,
  };
};

export const executePushPlan = async (plan: PushPlan): Promise<PushResult> => {
  const start = Date.now();
  const command = plan.result.command?.slice(1) ?? ["push"];
  const outcome = await runGit(plan.repository.path, command);
  const elapsedSeconds = (Date.now() - start) / MILLISECONDS_PER_SECOND;
  if (!outcome.ok) {
    return {
      ...plan.result,
      elapsedSeconds,
      errorMessage: outcome.message ?? (outcome.stderr.trim() || "git push failed"),
      status: "failed",
      stderr: outcome.stderr,
      stdout: outcome.stdout,
    };
  }

  return {
    ...plan.result,
    elapsedSeconds,
    stderr: outcome.stderr,
    stdout: outcome.stdout,
    status: "pushed",
  };
};
