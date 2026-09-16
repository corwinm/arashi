import { readFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";

export interface GitInvocationMetric {
  available: boolean;
  count?: number;
  fetchCount?: number;
  method: "git-trace2-event-root-sessions";
  repositories?: Array<{ count: number; path: string }>;
  reason?: string;
  unattributed?: { count: number; reason: string };
}

type ReadTraceFile = (path: string, encoding: "utf8") => Promise<string>;
type CanonicalizePath = (path: string) => Promise<string>;

const method = "git-trace2-event-root-sessions" as const;
const recognizedTrace2Events = new Set([
  "alias",
  "atexit",
  "child_exit",
  "child_ready",
  "child_start",
  "cmd_ancestry",
  "cmd_mode",
  "cmd_name",
  "cmd_path",
  "counter",
  "data",
  "data_json",
  "def_param",
  "def_repo",
  "error",
  "exec",
  "exec_result",
  "exit",
  "printf",
  "region_enter",
  "region_leave",
  "signal",
  "start",
  "th_counter",
  "th_timer",
  "thread_exit",
  "thread_start",
  "timer",
  "too_many_files",
  "version",
]);

export async function readGitInvocationTrace(
  tracePath: string,
  readTraceFile: ReadTraceFile = readFile,
  canonicalizePath: CanonicalizePath = realpath,
): Promise<GitInvocationMetric> {
  let contents: string;
  try {
    contents = await readTraceFile(tracePath, "utf8");
  } catch (error) {
    return {
      available: false,
      method,
      reason: `Could not read Git trace output: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let count = 0;
  let fetchCount = 0;
  let recognizedInstrumentation = false;
  const rootSessions = new Set<string>();
  const repositoryBySession = new Map<string, string>();
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        argv?: unknown;
        event?: unknown;
        sid?: unknown;
        worktree?: unknown;
      };
      if (typeof event.event !== "string" || !recognizedTrace2Events.has(event.event)) {
        return {
          available: false,
          method,
          reason: "Git trace output did not contain recognized Trace2 events.",
        };
      }
      if (
        typeof event.sid !== "string" ||
        !event.sid ||
        (event.event === "start" &&
          (!Array.isArray(event.argv) ||
            event.argv.some((argument) => typeof argument !== "string"))) ||
        (event.event === "def_repo" && (typeof event.worktree !== "string" || !event.worktree))
      ) {
        return {
          available: false,
          method,
          reason: `Git trace output contained a malformed Trace2 event: ${event.event}.`,
        };
      }
      recognizedInstrumentation = true;
      if (event.event === "start" && !event.sid.includes("/")) {
        count += 1;
        rootSessions.add(event.sid);
        if (Array.isArray(event.argv) && event.argv[1] === "fetch") {
          fetchCount += 1;
        }
      }
      if (
        event.event === "def_repo" &&
        !event.sid.includes("/") &&
        typeof event.worktree === "string"
      ) {
        repositoryBySession.set(event.sid, event.worktree);
      }
    } catch {
      return {
        available: false,
        method,
        reason: "Git trace output was not JSON lines.",
      };
    }
  }

  if (!recognizedInstrumentation) {
    return {
      available: false,
      method,
      reason: "Git trace output did not contain recognized Trace2 events.",
    };
  }

  const counts = new Map<string, number>();
  let unattributedCount = 0;
  for (const sid of rootSessions) {
    const worktree = repositoryBySession.get(sid);
    if (!worktree) {
      unattributedCount += 1;
      continue;
    }
    try {
      const path = await canonicalizePath(worktree);
      counts.set(path, (counts.get(path) ?? 0) + 1);
    } catch {
      unattributedCount += 1;
    }
  }
  const repositories = [...counts]
    .map(([path, repositoryCount]) => ({ count: repositoryCount, path }))
    .toSorted((left, right) => left.path.localeCompare(right.path));
  return {
    available: true,
    count,
    ...(fetchCount > 0 ? { fetchCount } : {}),
    method,
    repositories,
    ...(unattributedCount > 0
      ? {
          unattributed: {
            count: unattributedCount,
            reason: "Trace2 emitted no repository identity for these root sessions.",
          },
        }
      : {}),
  };
}
