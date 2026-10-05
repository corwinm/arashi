import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Execute the real harness with only its filesystem/PTY imports injected. No native PTY is needed.
const harness = readFileSync(new URL("../windows/pty-command.mjs", import.meta.url), "utf8")
  .replace(/^import \{ writeFileSync \} from "node:fs";\n/m, "")
  .replace(/^import \* as pty from "node-pty";\n/m, "");
const reusedOutput =
  "fixture prompt __ARASHI_CONPTY_REUSE_PROMPT__ __ARASHI_CONPTY_REUSED__:arashi-terminal-reused";

function runHarness(scenario: "timeout" | "exit", failWrite: boolean, output = reusedOutput) {
  const actions: string[] = [];
  const warnings: string[] = [];
  const saved: { path: string; json: string }[] = [];
  let timeout: (() => void) | undefined;
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: { exitCode: number }) => void) | undefined;
  const exited = new Error("fixture process exit");
  let failure: unknown;
  const config = {
    command: ["fixture-command"],
    cwd: ".",
    prompt: "fixture prompt",
    response: "__NO_INPUT__",
    resultPath: "fixture-result.json",
    timeoutMs: 10,
  };
  runInNewContext(harness, {
    Buffer,
    clearTimeout: () => actions.push("clear-timer"),
    console: { error: (message: string) => warnings.push(message) },
    process: {
      argv: [
        "node",
        "pty-command.mjs",
        "--session",
        Buffer.from(JSON.stringify(config)).toString("base64"),
      ],
      env: {},
      exit: (code: number) => {
        actions.push(`exit:${code}`);
        throw exited;
      },
      stdout: { write() {} },
    },
    pty: {
      spawn: () => ({
        kill: () => actions.push("kill"),
        onData: (callback: typeof onData) => {
          onData = callback;
        },
        onExit: (callback: typeof onExit) => {
          onExit = callback;
        },
        write: () => {},
      }),
    },
    setTimeout: (callback: () => void) => {
      timeout = callback;
      return { unref() {} };
    },
    writeFileSync: (path: string, json: string) => {
      actions.push("save");
      if (failWrite) {
        throw Object.assign(new Error("private diagnostic path must not leak"), { code: "ENOSPC" });
      }
      saved.push({ json, path });
    },
  });
  try {
    if (scenario === "timeout") {
      timeout!();
    } else {
      onData!(output);
      onExit!({ exitCode: 37 });
    }
  } catch (error) {
    if (error !== exited) {
      failure = error;
    }
  }
  return { actions, failure, saved, warnings };
}

describe("Windows PTY best-effort diagnostics", () => {
  test("ENOSPC cannot prevent timeout kill or exit 124", () => {
    const result = runHarness("timeout", true);
    expect(result.failure).toBeUndefined();
    expect(result.actions).toEqual(["save", "kill", "exit:124"]);
    expect(result.warnings.join("\n")).not.toContain("private diagnostic path");
    expect(result.warnings).toContain("Could not save ConPTY session diagnostics");
  });

  test.each([
    { exit: 0, output: reusedOutput },
    { exit: 125, output: "no prompt" },
    { exit: 126, output: "fixture prompt" },
  ])("ENOSPC preserves normal-exit harness status $exit", ({ output, exit }) => {
    const result = runHarness("exit", true, output);
    expect(result.failure).toBeUndefined();
    expect(result.actions).toEqual(["clear-timer", "save", `exit:${exit}`]);
    expect(result.warnings.join("\n")).not.toContain("private diagnostic path");
    expect(result.warnings).toContain("Could not save ConPTY session diagnostics");
  });

  test.each([
    { events: ["timeout"], exitCode: 124, reused: false, scenario: "timeout" as const },
    {
      events: ["prompt", "reuse-prompt", "exit"],
      exitCode: 37,
      reused: true,
      scenario: "exit" as const,
    },
  ])(
    "successful $scenario diagnostics retain saved JSON",
    ({ scenario, exitCode, reused, events }) => {
      const result = runHarness(scenario, false);
      expect(result.failure).toBeUndefined();
      expect(result.saved).toHaveLength(1);
      expect(result.saved[0].path).toBe("fixture-result.json");
      const json = JSON.parse(result.saved[0].json);
      expect(json.exitCode).toBe(exitCode);
      expect(json.reused).toBe(reused);
      expect(json.output).toBe(scenario === "timeout" ? "" : reusedOutput);
      expect(json.events.map((event: { event: string }) => event.event)).toEqual(events);
      expect(json.started).toEqual(expect.any(Number));
      expect(json.durationMs).toBeGreaterThanOrEqual(0);
    },
  );
});
