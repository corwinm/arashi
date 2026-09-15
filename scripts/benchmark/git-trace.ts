import { readFile } from "node:fs/promises";

export interface GitInvocationMetric {
  available: boolean;
  count?: number;
  method: "git-trace2-event-root-sessions";
  reason?: string;
}

type ReadTraceFile = (path: string, encoding: "utf8") => Promise<string>;

const method = "git-trace2-event-root-sessions" as const;

export async function readGitInvocationTrace(
  tracePath: string,
  readTraceFile: ReadTraceFile = readFile,
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
  let recognizedInstrumentation = false;
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { event?: unknown; sid?: unknown };
      if (typeof event.event !== "string") {
        return {
          available: false,
          method,
          reason: "Git trace output did not contain recognized Trace2 events.",
        };
      }
      recognizedInstrumentation = true;
      if (event.event === "start" && typeof event.sid === "string" && !event.sid.includes("/")) {
        count += 1;
      }
    } catch {
      return {
        available: false,
        method,
        reason: "Git trace output was not JSON lines.",
      };
    }
  }

  return recognizedInstrumentation
    ? { available: true, count, method }
    : {
        available: false,
        method,
        reason: "Git trace output did not contain recognized Trace2 events.",
      };
}
