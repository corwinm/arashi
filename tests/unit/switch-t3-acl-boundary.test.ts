import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const calls = vi.hoisted(
  () => [] as { command: string; args: string[]; options: { env?: NodeJS.ProcessEnv } }[],
);
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const actual = promisify(original.execFile);
  const replacement = Object.assign(original.execFile.bind(null), {
    [promisify.custom]: async (
      command: string,
      args: string[],
      options: Record<string, unknown>,
    ) => {
      if (command !== "powershell.exe") {
        return actual(command, args, options);
      }
      calls.push({ args, command, options });
      return {
        stderr: "",
        stdout: JSON.stringify({
          owner: "fixture-owner",
          currentUser: "fixture-owner",
          access: [{ identity: "fixture-owner", type: "Allow" }],
        }),
      };
    },
  });
  return { ...original, execFile: replacement };
});
import { dispatchT3Handoff } from "../../src/lib/t3-handoff.ts";
import { switchFixture } from "../helpers/switch-t3-intent.ts";
const roots: string[] = [];
const directive = process.env.ARASHI_DIRECTIVE_FILE;
beforeEach(() => {
  calls.length = 0;
  process.env.ARASHI_DIRECTIVE_FILE = "DIRECTIVE-CANARY";
});
afterEach(async () => {
  if (directive === undefined) {
    delete process.env.ARASHI_DIRECTIVE_FILE;
  } else {
    process.env.ARASHI_DIRECTIVE_FILE = directive;
  }
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});
test.each(["directory", "lock", "temporary"])(
  "A17 A25 simulated Windows actual ACL child $0 strips directive",
  async (kind) => {
    const f = await switchFixture(roots);
    delete f.input.switch;
    f.dependencies.platform = "win32";
    const result = await dispatchT3Handoff(f.input);
    expect(result.status).toBe("succeeded");
    const matching = calls
      .filter((call) =>
        Buffer.from(call.args[4]!, "base64").toString("utf16le").includes("SetOwner($identity)"),
      )
      .filter((call) =>
        kind === "lock"
          ? call.options.env?.ARASHI_T3_RECEIPT_PATH?.endsWith(".lock")
          : kind === "temporary"
            ? call.options.env?.ARASHI_T3_RECEIPT_PATH?.endsWith(".tmp")
            : !call.options.env?.ARASHI_T3_RECEIPT_PATH?.endsWith(".lock") &&
              !call.options.env?.ARASHI_T3_RECEIPT_PATH?.endsWith(".tmp"),
      );
    expect(matching.length).toBeGreaterThan(0);
    for (const call of matching) {
      expect(call.options.env).not.toHaveProperty("ARASHI_DIRECTIVE_FILE");
      expect(call.args.slice(0, 4)).toEqual([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
      ]);
      const script = Buffer.from(call.args[4]!, "base64").toString("utf16le");
      expect(script).toContain("SetAccessRuleProtection($true, $false)");
      expect(script).toContain("SetOwner($identity)");
      expect(call.args.join(" ")).not.toContain(f.input.workspacePath);
    }
  },
);
