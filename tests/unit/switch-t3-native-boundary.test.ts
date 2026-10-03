import { afterEach, describe, expect, test, vi } from "vitest";
import {
  readT3CliVersion,
  withT3Session,
  type T3NativeDependencies,
} from "../../src/lib/t3-native.ts";
import { nativeEnvironment } from "../helpers/t3-native.ts";

afterEach(() => vi.unstubAllEnvs());

async function nativeProcesses() {
  vi.stubEnv("ARASHI_DIRECTIVE_FILE", "/sentinel/directive-file");
  vi.stubEnv("ARASHI_392_ENV_CANARY", "preserve-this-value");
  const environment = nativeEnvironment();
  const cwd = "/selected checkout with spaces/child";
  const calls: { command: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const dependencies: T3NativeDependencies = {
    runProcess: async (command, options) => {
      calls.push({ command: [...command], cwd: options.cwd, env: { ...options.env } });
      return {
        exitCode: 0,
        stderr: "session-output-canary",
        stdout: command.includes("--version")
          ? "t3 v0.0.43"
          : command.includes("issue")
            ? JSON.stringify({ token: "token-canary", sessionId: "session-1" })
            : "revoked",
      };
    },
  };
  await readT3CliVersion(environment.cli, cwd, dependencies);
  const result = await withT3Session(environment, cwd, dependencies, async () => "completed");
  expect(result).toBe("completed");
  expect(calls).toHaveLength(3);
  return { calls, environment, cwd };
}

describe("issue392 preimplementation A17 native child boundary (partial row)", () => {
  test.each(["version", "issue", "revoke"])(
    "strips directive environment from %s",
    async (stage) => {
      const { calls } = await nativeProcesses();
      const selected = calls[["version", "issue", "revoke"].indexOf(stage)]!;
      expect(selected.env).not.toHaveProperty("ARASHI_DIRECTIVE_FILE");
      expect(process.env.ARASHI_DIRECTIVE_FILE).toBe("/sentinel/directive-file");
    },
  );

  test("preserves direct official auth argv and exact selected checkout CWD", async () => {
    const { calls, cwd, environment } = await nativeProcesses();
    expect(calls.map((call) => call.command)).toEqual([
      ["t3", "--version"],
      [
        "t3",
        "auth",
        "session",
        "issue",
        "--base-dir",
        environment.baseDir,
        "--ttl",
        "5m",
        "--label",
        "Arashi handoff",
        "--json",
      ],
      ["t3", "auth", "session", "revoke", "session-1", "--base-dir", environment.baseDir],
    ]);
    expect(calls.map((call) => call.cwd)).toEqual([cwd, cwd, cwd]);
    expect(calls.flatMap((call) => call.command)).not.toContain("token-canary");
  });

  test("preserves unrelated inherited environment and pins auth T3CODE_HOME", async () => {
    const { calls, environment } = await nativeProcesses();
    for (const call of calls) expect(call.env.ARASHI_392_ENV_CANARY).toBe("preserve-this-value");
    for (const call of calls.slice(1)) expect(call.env.T3CODE_HOME).toBe(environment.baseDir);
  });
});
