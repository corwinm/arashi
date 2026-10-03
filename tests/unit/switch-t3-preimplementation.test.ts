import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { executeSwitch, type SwitchCommandOptions } from "../../src/commands/switch.ts";

// This guard makes an executor policy regression observable before discovery,
// without invoking a real launcher or a real T3 environment.
const guards = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock("../../src/lib/workspace-context.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/workspace-context.ts")>()),
  resolveWorkspaceContext: guards.context,
}));

const cli = resolve("src/index.ts");
const run = promisify(execFile);
const roots: string[] = [];
type ProposedOptions = SwitchCommandOptions & {
  t3?: boolean | string;
  promptFile?: string;
  permission?: string;
  t3BaseDir?: string;
  t3Cli?: string;
  t3Provider?: string;
  t3Model?: string;
  t3Effort?: string;
  t3Intent?: string;
};

beforeEach(() => {
  guards.context.mockReset();
  guards.context.mockRejectedValue(new Error("Policy unexpectedly reached discovery"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function invokeCli(args: string[]) {
  const root = await mkdtemp(join(tmpdir(), "arashi-392-policy-"));
  const home = await mkdtemp(join(tmpdir(), "arashi-392-cli-home-"));
  roots.push(root, home);
  const before = await readdir(root);
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    ({ stdout, stderr } = await run("bun", [cli, "switch", ...args], {
      cwd: root,
      timeout: 15_000,
      env: {
        ...process.env,
        HOME: home,
        T3CODE_HOME: join(root, "absent-t3-environment"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "commit.gpgsign",
        GIT_CONFIG_VALUE_0: "false",
        NO_COLOR: "1",
      },
    }));
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    if (typeof failure.code !== "number") throw error;
    exitCode = failure.code;
    stdout = failure.stdout ?? "";
    stderr = failure.stderr ?? "";
  }
  expect(await readdir(root)).toEqual(before);
  return { stdout, stderr, exitCode };
}

function captureStdout() {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return () => chunks.join("");
}

const conflicts = [
  { flag: "--cd", options: { cd: true } },
  { flag: "--launch", options: { launch: true } },
  { flag: "--no-cd", options: { legacyNoCd: true } },
  { flag: "--tab", options: { tab: true } },
  { flag: "--tmux", options: { tmux: true } },
  { flag: "--sesh", options: { sesh: true } },
  { flag: "--herdr", options: { herdr: true } },
  { flag: "--vscode", options: { vscode: true } },
  { flag: "--cursor", options: { cursor: true } },
  { flag: "--kiro", options: { kiro: true } },
] as const;
const policyCases: {
  flag: string;
  options: SwitchCommandOptions;
  json: boolean;
  boundary: string;
}[] = conflicts.flatMap((conflict) =>
  [false, true].flatMap((json) =>
    ["Commander", "executor"].map((boundary) => ({ ...conflict, json, boundary })),
  ),
);
policyCases.push(
  { flag: "--herdr --cd", options: { herdr: true, cd: true }, json: true, boundary: "Commander" },
  { flag: "--herdr --cd", options: { herdr: true, cd: true }, json: true, boundary: "executor" },
);

describe("issue392 preimplementation A06 competing action policy", () => {
  test.each(policyCases)(
    "$boundary json=$json $flag",
    async ({ flag, options, json, boundary }) => {
      if (boundary === "Commander") {
        const outcome = await invokeCli([
          "--t3",
          "policy task",
          ...flag.split(" "),
          ...(json ? ["--json"] : []),
        ]);
        expect(outcome.exitCode).toBe(2);
        if (json) {
          expect(outcome.stderr).toBe("");
          expect(JSON.parse(outcome.stdout)).toMatchObject({
            command: "switch",
            ok: false,
            schemaVersion: 1,
            error: { code: "CONFLICTING_SWITCH_OPTIONS" },
          });
        } else {
          expect(outcome.stderr).toMatch(/conflict/i);
        }
        return;
      }
      const output = captureStdout();
      const request: ProposedOptions = { ...options, t3: "policy task", json };
      if (json) {
        expect(await executeSwitch(undefined, request)).toBe(2);
        expect(JSON.parse(output())).toMatchObject({
          command: "switch",
          ok: false,
          schemaVersion: 1,
          error: { code: "CONFLICTING_SWITCH_OPTIONS" },
        });
      } else {
        await expect(executeSwitch(undefined, request)).rejects.toMatchObject({
          code: "CONFLICTING_SWITCH_OPTIONS",
        });
      }
      expect(guards.context).not.toHaveBeenCalled();
    },
  );
});

const detached = [
  { flag: "--prompt-file", value: "task.md", key: "promptFile" },
  { flag: "--permission", value: "approval-required", key: "permission" },
  { flag: "--t3-base-dir", value: "/selected-t3", key: "t3BaseDir" },
  { flag: "--t3-cli", value: "t3", key: "t3Cli" },
  { flag: "--t3-provider", value: "codex", key: "t3Provider" },
  { flag: "--t3-model", value: "catalog-default", key: "t3Model" },
  { flag: "--t3-effort", value: "medium", key: "t3Effort" },
  { flag: "--t3-intent", value: "followup-1", key: "t3Intent" },
] as const;

describe("issue392 preimplementation A09 detached T3 options (partial row)", () => {
  test.each(
    detached.flatMap((entry) =>
      ["Commander", "executor"].map((boundary) => ({ ...entry, boundary })),
    ),
  )("$boundary $flag without T3", async ({ flag, key, value, boundary }) => {
    if (boundary === "Commander") {
      const outcome = await invokeCli([flag, value]);
      expect(outcome.exitCode).toBe(2);
      expect(outcome.stderr).toMatch(/requires? --t3|only with --t3|only.*--t3/i);
    } else {
      const request: ProposedOptions = { [key]: value };
      await expect(executeSwitch(undefined, request)).rejects.toMatchObject({
        message: expect.stringMatching(/requires? --t3|only with --t3|only.*--t3/i),
      });
      expect(guards.context).not.toHaveBeenCalled();
    }
  });
});

describe("issue392 preimplementation A29 ordinary Herdr JSON precedence (partial row)", () => {
  test.each(
    [false, true].flatMap((cd) => ["Commander", "executor"].map((boundary) => ({ cd, boundary }))),
  )("$boundary herdr cd=$cd without T3", async ({ cd, boundary }) => {
    let stdout: string;
    if (boundary === "Commander") {
      const outcome = await invokeCli(["--json", "--herdr", ...(cd ? ["--cd"] : [])]);
      expect(outcome.exitCode).toBe(2);
      expect(outcome.stderr).toBe("");
      stdout = outcome.stdout;
    } else {
      const output = captureStdout();
      expect(
        await executeSwitch(undefined, { json: true, herdr: true, ...(cd ? { cd: true } : {}) }),
      ).toBe(2);
      expect(guards.context).not.toHaveBeenCalled();
      stdout = output();
    }
    expect(JSON.parse(stdout)).toEqual({
      command: "switch",
      schemaVersion: 1,
      ok: false,
      warnings: [],
      error: {
        code: "JSON_UNSUPPORTED_FOR_MODE",
        details: { mode: "launch" },
        message: "JSON output is not supported for launch.",
      },
    });
  });
});
